// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC1155 } from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import { ERC1155Holder } from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IMarketFactoryV1 } from "../interfaces/IMarketFactoryV1.sol";
import { IMarketVaultV1 } from "../interfaces/IMarketVaultV1.sol";
import { IEmergencyControllerV1 } from "../interfaces/IEmergencyControllerV1.sol";
import { IFeeVaultV1 } from "../interfaces/IFeeVaultV1.sol";
import { ProtocolTypes } from "../libraries/ProtocolTypes.sol";

/// @notice Funded bids and escrowed asks. Deploy with a NEW factory; V1 markets are unchanged.
/// @dev Each (vault, outcome, side) automatic book is a price/time min-heap. No holder scans.
contract OrderbookMarketplaceV2 is ReentrancyGuard, ERC1155Holder {
    using SafeERC20 for IERC20;
    enum Side {
        Bid,
        Ask
    }
    enum ReleaseReason {
        Cancelled,
        Expired,
        Terminal,
        Dust,
        SelfCross,
        UnfillableReceiver
    }

    struct Order {
        address vault;
        address owner;
        uint128 remainingUnits;
        uint128 unitPrice;
        uint64 expiresAt;
        uint8 outcomeId;
        Side side;
        bool autoMatch;
        bool active;
        uint256 lockedPayment;
    }

    struct Fees {
        uint256 platform;
        uint256 creator;
    }
    uint256 public constant MAX_UNIT_PRICE = 1000e6;
    uint256 public constant MAX_MATCH_STEPS = 20;
    uint256 public constant RECEIVER_TRANSFER_GAS_LIMIT = 300_000;
    IMarketFactoryV1 public immutable factory;
    IEmergencyControllerV1 public immutable emergencyController;
    IFeeVaultV1 public immutable feeVault;
    IERC20 public immutable paymentToken;
    // Required by the factory's dependency wiring check. V2 uses explicit scoped approvals.
    address public immutable permit2;
    uint256 public nextOrderId = 1;
    uint256 public totalLockedPayment;
    mapping(uint256 => Order) public orders;
    // Shares whose owner rejected a safe return stay in escrow until that owner
    // chooses a receiver. They are never treated as returned or claimable shares.
    mapping(uint256 => uint256) public pendingShares;
    mapping(bytes32 => uint256[]) private books;
    mapping(uint256 => uint256) private positions; // one-based heap offsets
    bytes32 private expectedReceipt;

    error InvalidOrder();
    error NotOwner();
    error InvalidMarket();
    error InactiveOrder();
    error PriceLimit();
    error FillMinimum();
    error Expired();
    error Paused();
    error UnexpectedTransfer();
    error InexactTransfer();

    event OrderCreated(
        uint256 indexed orderId,
        address indexed vault,
        address indexed owner,
        uint8 outcomeId,
        Side side,
        uint256 units,
        uint256 unitPrice,
        uint64 expiresAt,
        bool autoMatch,
        uint256 lockedPayment
    );
    event OrderReleased(
        uint256 indexed orderId,
        address indexed owner,
        ReleaseReason reason,
        uint256 returnedUnits,
        uint256 returnedPayment
    );
    event OrderFilled(
        uint256 indexed orderId,
        address indexed buyer,
        address indexed seller,
        uint256 units,
        uint256 unitPrice,
        uint256 gross,
        uint256 platformFee,
        uint256 creatorFee,
        uint256 remainingUnits,
        uint256 lockedPayment
    );
    event TradeExecuted(
        uint256 indexed orderId,
        address indexed vault,
        address indexed buyer,
        address seller,
        uint8 outcomeId,
        uint256 units,
        uint256 unitPrice,
        uint256 gross,
        uint256 platformFee,
        uint256 creatorFee,
        bool escrowed,
        uint256 remainingAskUnits
    );
    event OrdersMatched(
        uint256 indexed bidId,
        uint256 indexed askId,
        uint256 indexed makerId,
        uint256 units,
        uint256 unitPrice
    );
    event BidExcessReturned(uint256 indexed orderId, address indexed owner, uint256 amount);
    event OrderSharesDeferred(uint256 indexed orderId, address indexed owner, uint256 units);
    event OrderSharesWithdrawn(
        uint256 indexed orderId, address indexed owner, address indexed recipient, uint256 units
    );

    constructor(
        address factory_,
        address emergency_,
        address fees_,
        address token_,
        address permit2_
    ) {
        if (
            factory_ == address(0) || emergency_ == address(0) || fees_ == address(0)
                || token_ == address(0)
        ) revert InvalidOrder();
        factory = IMarketFactoryV1(factory_);
        emergencyController = IEmergencyControllerV1(emergency_);
        feeVault = IFeeVaultV1(fees_);
        paymentToken = IERC20(token_);
        permit2 = permit2_;
    }

    function createOrder(
        address vault,
        uint8 outcomeId,
        Side side,
        uint128 units,
        uint128 unitPrice,
        uint64 expiresAt,
        bool autoMatch
    ) external nonReentrant returns (uint256 id) {
        _unpaused(ProtocolTypes.PAUSE_LISTING_CREATE);
        if (!factory.isMarket(vault)) revert InvalidMarket();
        IMarketVaultV1 market = IMarketVaultV1(vault);
        if (
            market.factory() != address(factory) || market.paymentToken() != address(paymentToken)
                || market.isTerminal()
        ) revert InvalidMarket();
        if (
            outcomeId >= market.outcomeCount() || units < market.minimumC2CUnits() || units == 0
                || unitPrice == 0 || unitPrice > MAX_UNIT_PRICE || expiresAt <= block.timestamp
                || Math.mulDiv(units, unitPrice, ProtocolTypes.SHARE_SCALE) == 0
                || (autoMatch
                    && Math.mulDiv(market.minimumC2CUnits(), unitPrice, ProtocolTypes.SHARE_SCALE)
                        == 0)
        ) revert InvalidOrder();
        id = nextOrderId++;
        uint256 locked = side == Side.Bid ? _reserve(units, unitPrice) : 0;
        orders[id] = Order(
            vault, msg.sender, units, unitPrice, expiresAt, outcomeId, side, autoMatch, true, locked
        );
        if (autoMatch) _insert(id);
        if (side == Side.Bid) {
            totalLockedPayment += locked;
            _pull(msg.sender, locked);
        } else {
            expectedReceipt = keccak256(abi.encode(vault, msg.sender, outcomeId, units, id));
            IERC1155(vault)
                .safeTransferFrom(msg.sender, address(this), outcomeId, units, abi.encode(id));
            expectedReceipt = bytes32(0);
        }
        emit OrderCreated(
            id, vault, msg.sender, outcomeId, side, units, unitPrice, expiresAt, autoMatch, locked
        );
    }

    /// @param paymentLimit For buying an ask: maximum gross; for selling to a bid: minimum net
    /// proceeds.
    function fillOrder(
        uint256 id,
        uint128 desiredUnits,
        uint128 minUnits,
        uint256 paymentLimit,
        uint64 deadline
    ) external nonReentrant returns (uint256 units, uint256 gross) {
        _unpaused(ProtocolTypes.PAUSE_LISTING_FILL);
        if (block.timestamp > deadline) revert Expired();
        Order storage o = orders[id];
        _live(o);
        if (msg.sender == o.owner) revert InvalidOrder();
        units = Math.min(desiredUnits, o.remainingUnits);
        if (
            units == 0 || units < minUnits
                || (units < IMarketVaultV1(o.vault).minimumC2CUnits() && units != o.remainingUnits)
        ) revert FillMinimum();
        gross = Math.mulDiv(units, o.unitPrice, ProtocolTypes.SHARE_SCALE);
        if (gross == 0) revert PriceLimit();
        Fees memory fees = _fees(o.vault, gross);
        if (o.side == Side.Ask
                ? gross > paymentLimit
                : gross - fees.platform - fees.creator < paymentLimit) revert PriceLimit();
        address buyer = o.side == Side.Bid ? o.owner : msg.sender;
        address seller = o.side == Side.Ask ? o.owner : msg.sender;
        o.remainingUnits -= uint128(units);
        if (o.side == Side.Bid) _spendBid(o, gross);
        else _pull(buyer, gross);
        _pay(o.vault, seller, gross, fees, bytes32(id));
        IERC1155(o.vault)
            .safeTransferFrom(
                o.side == Side.Ask ? address(this) : seller, buyer, o.outcomeId, units, ""
            );
        _finish(id);
        emit TradeExecuted(
            id,
            o.vault,
            buyer,
            seller,
            o.outcomeId,
            units,
            o.unitPrice,
            gross,
            fees.platform,
            fees.creator,
            o.side == Side.Ask,
            o.side == Side.Ask ? o.remainingUnits : 0
        );
        emit OrderFilled(
            id,
            buyer,
            seller,
            units,
            o.unitPrice,
            gross,
            fees.platform,
            fees.creator,
            o.remainingUnits,
            o.lockedPayment
        );
    }

    /// @notice Permissionless bounded matching; price/FIFO and maker price are enforced here.
    function matchOrders(address vault, uint8 outcomeId, uint256 maxSteps)
        external
        nonReentrant
        returns (uint256 fills)
    {
        _unpaused(ProtocolTypes.PAUSE_LISTING_FILL);
        if (maxSteps == 0 || maxSteps > MAX_MATCH_STEPS) revert InvalidOrder();
        for (uint256 step; step < maxSteps; ++step) {
            uint256 bidId = bestOrder(vault, outcomeId, Side.Bid);
            uint256 askId = bestOrder(vault, outcomeId, Side.Ask);
            if (bidId != 0 && _stale(bidId)) {
                _releaseStale(bidId);
                continue;
            }
            if (askId != 0 && _stale(askId)) {
                _releaseStale(askId);
                continue;
            }
            if (bidId == 0 || askId == 0) break;
            Order storage bid = orders[bidId];
            Order storage ask = orders[askId];
            if (bid.unitPrice < ask.unitPrice) break;
            if (bid.owner == ask.owner) {
                _release(bidId > askId ? bidId : askId, ReleaseReason.SelfCross);
                continue;
            }
            uint256 makerId = bidId < askId ? bidId : askId;
            uint256 price = orders[makerId].unitPrice;
            uint256 units = Math.min(bid.remainingUnits, ask.remainingUnits);
            uint256 gross = Math.mulDiv(units, price, ProtocolTypes.SHARE_SCALE);
            if (gross == 0) break;
            Fees memory fees = _fees(vault, gross);
            // A rejecting best bidder must not hold the price queue hostage. The
            // isolated call rolls the share transfer back before the bid is released.
            if (IERC1155(vault).balanceOf(address(this), outcomeId) < units) {
                revert InexactTransfer();
            }
            try this.transferEscrowedShares{gas: RECEIVER_TRANSFER_GAS_LIMIT}(
                vault, bid.owner, outcomeId, units
            ) {}
            catch {
                _release(bidId, ReleaseReason.UnfillableReceiver);
                continue;
            }
            bid.remainingUnits -= uint128(units);
            ask.remainingUnits -= uint128(units);
            _spendBid(bid, gross);
            _pay(vault, ask.owner, gross, fees, bytes32(makerId));
            _finish(bidId);
            _finish(askId);
            emit OrderFilled(
                bidId,
                bid.owner,
                ask.owner,
                units,
                price,
                gross,
                fees.platform,
                fees.creator,
                bid.remainingUnits,
                bid.lockedPayment
            );
            emit OrderFilled(
                askId,
                bid.owner,
                ask.owner,
                units,
                price,
                gross,
                fees.platform,
                fees.creator,
                ask.remainingUnits,
                ask.lockedPayment
            );
            emit TradeExecuted(
                askId,
                vault,
                bid.owner,
                ask.owner,
                outcomeId,
                units,
                price,
                gross,
                fees.platform,
                fees.creator,
                true,
                ask.remainingUnits
            );
            emit OrdersMatched(bidId, askId, makerId, units, price);
            ++fills;
        }
    }

    function cancelOrder(uint256 id) external nonReentrant {
        if (orders[id].owner != msg.sender) revert NotOwner();
        _release(id, ReleaseReason.Cancelled);
    }

    function releaseOrder(uint256 id) external nonReentrant {
        if (!_stale(id)) revert InvalidOrder();
        _releaseStale(id);
    }

    /// @notice Recover an ask's shares after its owner's receiver rejected the
    /// automatic return. Only the original order owner chooses the recipient.
    function withdrawOrderShares(uint256 id, address recipient) external nonReentrant {
        Order storage o = orders[id];
        if (o.owner != msg.sender) revert NotOwner();
        uint256 units = pendingShares[id];
        if (units == 0 || recipient == address(0) || recipient == address(this)) {
            revert InvalidOrder();
        }
        pendingShares[id] = 0;
        IERC1155(o.vault).safeTransferFrom(address(this), recipient, o.outcomeId, units, "");
        emit OrderSharesWithdrawn(id, o.owner, recipient, units);
    }

    /// @dev try/catch can isolate a receiver callback only across an external call.
    /// This entry point cannot be used by anyone outside this contract.
    function transferEscrowedShares(address vault, address recipient, uint8 outcomeId, uint256 units)
        external
    {
        if (msg.sender != address(this)) revert InvalidOrder();
        IERC1155(vault).safeTransferFrom(address(this), recipient, outcomeId, units, "");
    }

    function bestOrder(address vault, uint8 outcomeId, Side side) public view returns (uint256) {
        uint256[] storage heap = books[keccak256(abi.encode(vault, outcomeId, side))];
        return heap.length == 0 ? 0 : heap[0];
    }

    function bookSize(address vault, uint8 outcomeId, Side side) external view returns (uint256) {
        return books[keccak256(abi.encode(vault, outcomeId, side))].length;
    }

    function receiverRecoveryVersion() external pure returns (uint256) {
        return 1;
    }

    function _key(Order storage o) private view returns (bytes32) {
        return keccak256(abi.encode(o.vault, o.outcomeId, o.side));
    }

    function _reserve(uint256 units, uint256 price) private pure returns (uint256) {
        return Math.mulDiv(units, price, ProtocolTypes.SHARE_SCALE, Math.Rounding.Ceil);
    }

    function _live(Order storage o) private view {
        if (!o.active) revert InactiveOrder();
        if (block.timestamp >= o.expiresAt) revert Expired();
        if (IMarketVaultV1(o.vault).isTerminal()) revert InvalidMarket();
    }

    function _unpaused(uint256 bit) private view {
        if (emergencyController.isPaused(bit)) revert Paused();
    }

    function _stale(uint256 id) private view returns (bool) {
        Order storage o = orders[id];
        return o.active && (block.timestamp >= o.expiresAt || IMarketVaultV1(o.vault).isTerminal());
    }

    function _releaseStale(uint256 id) private {
        _release(
            id,
            IMarketVaultV1(orders[id].vault).isTerminal()
                ? ReleaseReason.Terminal
                : ReleaseReason.Expired
        );
    }

    function _spendBid(Order storage bid, uint256 gross) private {
        bid.lockedPayment -= gross;
        totalLockedPayment -= gross;
    }

    function _finish(uint256 id) private {
        Order storage o = orders[id];
        if (
            o.remainingUnits < IMarketVaultV1(o.vault).minimumC2CUnits()
                || Math.mulDiv(o.remainingUnits, o.unitPrice, ProtocolTypes.SHARE_SCALE) == 0
        ) {
            _release(id, ReleaseReason.Dust);
        } else if (o.side == Side.Bid) {
            uint256 needed = _reserve(o.remainingUnits, o.unitPrice);
            uint256 excess = o.lockedPayment - needed;
            o.lockedPayment = needed;
            totalLockedPayment -= excess;
            if (excess != 0) {
                paymentToken.safeTransfer(o.owner, excess);
                emit BidExcessReturned(id, o.owner, excess);
            }
        }
    }

    function _release(uint256 id, ReleaseReason reason) private {
        Order storage o = orders[id];
        if (!o.active) revert InactiveOrder();
        uint256 units = o.remainingUnits;
        uint256 payment = o.lockedPayment;
        o.active = false;
        o.remainingUnits = 0;
        o.lockedPayment = 0;
        _remove(id);
        if (o.side == Side.Bid) {
            totalLockedPayment -= payment;
            if (payment != 0) paymentToken.safeTransfer(o.owner, payment);
        } else if (units != 0) {
            if (IERC1155(o.vault).balanceOf(address(this), o.outcomeId) < units) {
                revert InexactTransfer();
            }
            try this.transferEscrowedShares{gas: RECEIVER_TRANSFER_GAS_LIMIT}(
                o.vault, o.owner, o.outcomeId, units
            ) {}
            catch {
                pendingShares[id] = units;
                emit OrderSharesDeferred(id, o.owner, units);
                units = 0;
            }
        }
        emit OrderReleased(id, o.owner, reason, o.side == Side.Ask ? units : 0, payment);
    }

    function _pull(address from, uint256 amount) private {
        uint256 beforeBalance = paymentToken.balanceOf(address(this));
        paymentToken.safeTransferFrom(from, address(this), amount);
        if (paymentToken.balanceOf(address(this)) - beforeBalance != amount) {
            revert InexactTransfer();
        }
    }

    function _fees(address vault, uint256 gross) private view returns (Fees memory f) {
        IMarketVaultV1 market = IMarketVaultV1(vault);
        f.platform = Math.mulDiv(gross, market.platformC2CFeeBps(), ProtocolTypes.BPS);
        f.creator = Math.mulDiv(gross, market.creatorC2CFeeBps(), ProtocolTypes.BPS);
    }

    function _pay(address vault, address seller, uint256 gross, Fees memory f, bytes32 ref)
        private
    {
        paymentToken.safeTransfer(seller, gross - f.platform - f.creator);
        if (f.platform + f.creator != 0) {
            paymentToken.safeTransfer(address(feeVault), f.platform + f.creator);
            IMarketVaultV1 market = IMarketVaultV1(vault);
            feeVault.accrue(market.protocolTreasury(), f.platform, keccak256("PLATFORM_C2C"), ref);
            feeVault.accrue(market.creatorTreasury(), f.creator, keccak256("CREATOR_C2C"), ref);
        }
    }

    // Heap comparison: price priority, then monotonically increasing creation id (FIFO).
    function _better(uint256 a, uint256 b) private view returns (bool) {
        Order storage x = orders[a];
        Order storage y = orders[b];
        if (x.unitPrice == y.unitPrice) return a < b;
        return x.side == Side.Bid ? x.unitPrice > y.unitPrice : x.unitPrice < y.unitPrice;
    }

    function _swap(uint256[] storage heap, uint256 a, uint256 b) private {
        (heap[a], heap[b]) = (heap[b], heap[a]);
        positions[heap[a]] = a + 1;
        positions[heap[b]] = b + 1;
    }

    function _insert(uint256 id) private {
        uint256[] storage heap = books[_key(orders[id])];
        heap.push(id);
        uint256 i = heap.length - 1;
        positions[id] = i + 1;
        while (i != 0 && _better(heap[i], heap[(i - 1) / 2])) {
            uint256 p = (i - 1) / 2;
            _swap(heap, i, p);
            i = p;
        }
    }

    function _remove(uint256 id) private {
        uint256 pos = positions[id];
        if (pos == 0) return;
        uint256[] storage heap = books[_key(orders[id])];
        uint256 i = pos - 1;
        uint256 last = heap.length - 1;
        if (i != last) _swap(heap, i, last);
        heap.pop();
        delete positions[id];
        if (i >= heap.length) return;
        if (i != 0 && _better(heap[i], heap[(i - 1) / 2])) {
            while (i != 0 && _better(heap[i], heap[(i - 1) / 2])) {
                uint256 p = (i - 1) / 2;
                _swap(heap, i, p);
                i = p;
            }
        } else {
            while (2 * i + 1 < heap.length) {
                uint256 child = 2 * i + 1;
                if (child + 1 < heap.length && _better(heap[child + 1], heap[child])) ++child;
                if (!_better(heap[child], heap[i])) break;
                _swap(heap, i, child);
                i = child;
            }
        }
    }

    function onERC1155Received(
        address operator,
        address from,
        uint256 id,
        uint256 value,
        bytes memory data
    ) public view override returns (bytes4) {
        if (
            operator != address(this) || data.length != 32 || expectedReceipt == bytes32(0)
                || expectedReceipt
                    != keccak256(
                        abi.encode(msg.sender, from, id, value, abi.decode(data, (uint256)))
                    )
        ) revert UnexpectedTransfer();
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] memory,
        uint256[] memory,
        bytes memory
    ) public pure override returns (bytes4) {
        revert UnexpectedTransfer();
    }
}
