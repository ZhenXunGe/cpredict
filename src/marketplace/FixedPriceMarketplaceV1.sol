// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC1155 } from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import { IERC1155Receiver } from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { ISignatureTransfer } from "permit2/interfaces/ISignatureTransfer.sol";
import { IMarketFactoryV1 } from "../interfaces/IMarketFactoryV1.sol";
import { IMarketVaultV1 } from "../interfaces/IMarketVaultV1.sol";
import { IEmergencyControllerV1 } from "../interfaces/IEmergencyControllerV1.sol";
import { IFeeVaultV1 } from "../interfaces/IFeeVaultV1.sol";
import { ProtocolTypes } from "../libraries/ProtocolTypes.sol";
import {
    Unauthorized,
    ZeroAddress,
    InvalidOutcome,
    MarketNotRegistered,
    MarketTerminal,
    DeadlineExpired,
    PauseActive,
    ZeroAmount,
    FillBelowMinimum,
    PaymentAboveMaximum,
    InexactTokenTransfer,
    ListingNotActive,
    ListingExpired,
    InvalidListingExpiry,
    InvalidPrice,
    UnexpectedERC1155Transfer,
    Permit2Disabled,
    MarketNotClosedForReturn,
    InvalidConfiguration
} from "../libraries/ProtocolErrors.sol";

/// @notice Escrowed fixed-price, sell-only ERC-1155 marketplace for registered V1 markets.
contract FixedPriceMarketplaceV1 is IERC1155Receiver, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint256 public constant MIN_UNIT_PRICE = 1;
    uint256 public constant MAX_UNIT_PRICE = 1000e6;
    bytes32 public constant FEE_KIND_PLATFORM_C2C = keccak256("PLATFORM_C2C");
    bytes32 public constant FEE_KIND_CREATOR_C2C = keccak256("CREATOR_C2C");
    bytes32 public constant FILL_WITNESS_TYPEHASH = keccak256(
        "FillWitness(address buyer,address marketplace,bytes4 selector,bytes32 listingId,uint256 desiredUnits,uint256 minUnits,uint256 maxGross,uint64 callDeadline,uint256 chainId)"
    );
    string public constant FILL_WITNESS_TYPE_STRING =
        "FillWitness witness)FillWitness(address buyer,address marketplace,bytes4 selector,bytes32 listingId,uint256 desiredUnits,uint256 minUnits,uint256 maxGross,uint64 callDeadline,uint256 chainId)TokenPermissions(address token,uint256 amount)";

    struct Listing {
        address vault;
        address seller;
        uint128 remainingUnits;
        uint128 unitPrice;
        uint64 expiresAt;
        uint8 outcomeId;
        bool active;
    }

    struct FillAmounts {
        uint256 units;
        uint256 gross;
        uint256 platformFee;
        uint256 creatorFee;
        uint256 sellerProceeds;
    }

    IMarketFactoryV1 public immutable factory;
    IEmergencyControllerV1 public immutable emergencyController;
    IFeeVaultV1 public immutable feeVault;
    IERC20 public immutable paymentToken;
    ISignatureTransfer public immutable permit2;

    mapping(address seller => uint256 nonce) public sellerNonce;
    mapping(bytes32 listingId => Listing listing) public listings;
    bytes32 private _expectedReceipt;

    event ListingCreated(
        bytes32 indexed listingId,
        address indexed vault,
        address indexed seller,
        uint256 outcomeId,
        uint256 amount,
        uint256 unitPrice,
        uint64 expiresAt,
        uint256 sellerNonce
    );
    event ListingFilled(
        bytes32 indexed listingId,
        address indexed buyer,
        address indexed seller,
        uint256 desiredUnits,
        uint256 filledUnits,
        uint256 gross,
        uint256 sellerProceeds,
        uint256 platformFee,
        uint256 creatorFee,
        uint256 remainingUnits
    );
    event ListingCancelled(
        bytes32 indexed listingId, address indexed seller, uint256 returnedUnits
    );
    event TerminalListingReturned(
        bytes32 indexed listingId,
        address indexed caller,
        address indexed seller,
        uint256 returnedUnits
    );

    constructor(
        address factory_,
        address emergencyController_,
        address feeVault_,
        address paymentToken_,
        address permit2_
    ) {
        if (
            factory_ == address(0) || emergencyController_ == address(0) || feeVault_ == address(0)
                || paymentToken_ == address(0)
        ) revert ZeroAddress();
        factory = IMarketFactoryV1(factory_);
        emergencyController = IEmergencyControllerV1(emergencyController_);
        feeVault = IFeeVaultV1(feeVault_);
        paymentToken = IERC20(paymentToken_);
        permit2 = ISignatureTransfer(permit2_);
    }

    function createListing(
        address vault,
        uint256 outcomeId,
        uint256 amount,
        uint256 unitPrice,
        uint64 expiresAt
    ) external nonReentrant returns (bytes32 listingId) {
        if (emergencyController.isPaused(ProtocolTypes.PAUSE_LISTING_CREATE)) {
            revert PauseActive(ProtocolTypes.PAUSE_LISTING_CREATE);
        }
        if (!factory.isMarket(vault)) revert MarketNotRegistered(vault);
        IMarketVaultV1 market = IMarketVaultV1(vault);
        if (market.isTerminal()) revert MarketTerminal();
        if (outcomeId >= market.outcomeCount()) {
            revert InvalidOutcome(outcomeId, market.outcomeCount());
        }
        if (amount < market.minimumC2CUnits() || amount > type(uint128).max) {
            revert FillBelowMinimum(amount, market.minimumC2CUnits());
        }
        if (unitPrice < MIN_UNIT_PRICE || unitPrice > MAX_UNIT_PRICE) {
            revert InvalidPrice(unitPrice);
        }
        if (expiresAt <= block.timestamp) revert InvalidListingExpiry();

        uint256 nonce = sellerNonce[msg.sender];
        sellerNonce[msg.sender] = nonce + 1;
        listingId = keccak256(abi.encode(block.chainid, address(this), vault, msg.sender, nonce));
        listings[listingId] = Listing({
            vault: vault,
            seller: msg.sender,
            remainingUnits: amount.toUint128(),
            unitPrice: unitPrice.toUint128(),
            expiresAt: expiresAt,
            outcomeId: outcomeId.toUint8(),
            active: true
        });

        _expectedReceipt = keccak256(abi.encode(vault, msg.sender, outcomeId, amount, listingId));
        IERC1155(vault)
            .safeTransferFrom(msg.sender, address(this), outcomeId, amount, abi.encode(listingId));
        _expectedReceipt = bytes32(0);
        emit ListingCreated(
            listingId, vault, msg.sender, outcomeId, amount, unitPrice, expiresAt, nonce
        );
    }

    function fillListing(
        bytes32 listingId,
        uint256 desiredUnits,
        uint256 minUnits,
        uint256 maxGross,
        uint64 deadline
    ) external nonReentrant returns (uint256 filledUnits, uint256 gross) {
        (Listing memory listing, FillAmounts memory amounts) =
            _prepareFill(listingId, desiredUnits, minUnits, maxGross, deadline);
        _payFrom(msg.sender, listing, listingId, amounts);
        IERC1155(listing.vault)
            .safeTransferFrom(address(this), msg.sender, listing.outcomeId, amounts.units, "");
        _emitFill(listingId, msg.sender, listing, desiredUnits, amounts);
        return (amounts.units, amounts.gross);
    }

    function fillListingWithPermit2(
        bytes32 listingId,
        address buyer,
        uint256 desiredUnits,
        uint256 minUnits,
        uint256 maxGross,
        uint64 callDeadline,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        bytes calldata signature
    ) external nonReentrant returns (uint256 filledUnits, uint256 gross) {
        if (address(permit2) == address(0)) revert Permit2Disabled();
        if (emergencyController.isPaused(ProtocolTypes.PAUSE_PERMIT2)) {
            revert PauseActive(ProtocolTypes.PAUSE_PERMIT2);
        }
        (Listing memory listing, FillAmounts memory amounts) =
            _prepareFill(listingId, desiredUnits, minUnits, maxGross, callDeadline);
        if (!IMarketVaultV1(listing.vault).permit2Enabled()) revert Permit2Disabled();
        if (
            permit.permitted.token != address(paymentToken)
                || permit.permitted.amount < amounts.gross
        ) {
            revert InvalidConfiguration("permit2.permissions");
        }

        bytes32 witness =
            _fillWitness(buyer, listingId, desiredUnits, minUnits, maxGross, callDeadline);
        _pullWithPermit2(buyer, amounts.gross, permit, witness, signature);

        _payHeld(listing, listingId, amounts);
        IERC1155(listing.vault)
            .safeTransferFrom(address(this), buyer, listing.outcomeId, amounts.units, "");
        _emitFill(listingId, buyer, listing, desiredUnits, amounts);
        return (amounts.units, amounts.gross);
    }

    function _fillWitness(
        address buyer,
        bytes32 listingId,
        uint256 desiredUnits,
        uint256 minUnits,
        uint256 maxGross,
        uint64 callDeadline
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                FILL_WITNESS_TYPEHASH,
                buyer,
                address(this),
                this.fillListingWithPermit2.selector,
                listingId,
                desiredUnits,
                minUnits,
                maxGross,
                callDeadline,
                block.chainid
            )
        );
    }

    function _pullWithPermit2(
        address buyer,
        uint256 amount,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        bytes32 witness,
        bytes calldata signature
    ) internal {
        uint256 beforeBalance = paymentToken.balanceOf(address(this));
        ISignatureTransfer.SignatureTransferDetails memory details =
            ISignatureTransfer.SignatureTransferDetails({
                to: address(this), requestedAmount: amount
            });
        permit2.permitWitnessTransferFrom(
            permit, details, buyer, witness, FILL_WITNESS_TYPE_STRING, signature
        );
        uint256 received = paymentToken.balanceOf(address(this)) - beforeBalance;
        if (received != amount) revert InexactTokenTransfer(amount, received);
    }

    function cancelListing(bytes32 listingId) external nonReentrant {
        Listing storage listing = listings[listingId];
        if (!listing.active || listing.seller != msg.sender) revert ListingNotActive(listingId);
        uint256 returned = listing.remainingUnits;
        listing.active = false;
        listing.remainingUnits = 0;
        IERC1155(listing.vault)
            .safeTransferFrom(address(this), listing.seller, listing.outcomeId, returned, "");
        emit ListingCancelled(listingId, listing.seller, returned);
    }

    function returnTerminalListing(bytes32 listingId) external nonReentrant {
        Listing storage listing = listings[listingId];
        if (!listing.active) revert ListingNotActive(listingId);
        if (!IMarketVaultV1(listing.vault).isTerminal()) revert MarketNotClosedForReturn();
        uint256 returned = listing.remainingUnits;
        address seller = listing.seller;
        listing.active = false;
        listing.remainingUnits = 0;
        IERC1155(listing.vault)
            .safeTransferFrom(address(this), seller, listing.outcomeId, returned, "");
        emit TerminalListingReturned(listingId, msg.sender, seller, returned);
    }

    function _prepareFill(
        bytes32 listingId,
        uint256 desiredUnits,
        uint256 minUnits,
        uint256 maxGross,
        uint64 deadline
    ) internal returns (Listing memory listing, FillAmounts memory amounts) {
        if (emergencyController.isPaused(ProtocolTypes.PAUSE_LISTING_FILL)) {
            revert PauseActive(ProtocolTypes.PAUSE_LISTING_FILL);
        }
        if (block.timestamp > deadline) revert DeadlineExpired(deadline, block.timestamp);
        Listing storage stored = listings[listingId];
        if (!stored.active) revert ListingNotActive(listingId);
        if (block.timestamp >= stored.expiresAt) revert ListingExpired(listingId);
        if (IMarketVaultV1(stored.vault).isTerminal()) revert MarketTerminal();
        if (desiredUnits == 0) revert ZeroAmount();

        uint256 units = Math.min(desiredUnits, stored.remainingUnits);
        if (units < minUnits) revert FillBelowMinimum(units, minUnits);
        uint256 marketMinimum = IMarketVaultV1(stored.vault).minimumC2CUnits();
        // A partial fill must itself be economically meaningful. The complete-remainder
        // exception preserves the escape hatch for any legacy listing whose remainder is dust.
        if (units < marketMinimum && units != stored.remainingUnits) {
            revert FillBelowMinimum(units, marketMinimum);
        }
        uint256 remaining = uint256(stored.remainingUnits) - units;
        if (remaining != 0 && remaining < marketMinimum) {
            revert FillBelowMinimum(remaining, marketMinimum);
        }

        uint256 gross = Math.mulDiv(units, stored.unitPrice, ProtocolTypes.SHARE_SCALE);
        if (gross == 0) revert ZeroAmount();
        if (gross > maxGross) revert PaymentAboveMaximum(gross, maxGross);
        uint256 platformFee = Math.mulDiv(
            gross, IMarketVaultV1(stored.vault).platformC2CFeeBps(), ProtocolTypes.BPS
        );
        uint256 creatorFee = Math.mulDiv(
            gross, IMarketVaultV1(stored.vault).creatorC2CFeeBps(), ProtocolTypes.BPS
        );

        listing = stored;
        stored.remainingUnits = remaining.toUint128();
        if (remaining == 0) stored.active = false;
        amounts = FillAmounts({
            units: units,
            gross: gross,
            platformFee: platformFee,
            creatorFee: creatorFee,
            sellerProceeds: gross - platformFee - creatorFee
        });
    }

    function _payFrom(
        address buyer,
        Listing memory listing,
        bytes32 listingId,
        FillAmounts memory amounts
    ) internal {
        if (amounts.sellerProceeds != 0) {
            paymentToken.safeTransferFrom(buyer, listing.seller, amounts.sellerProceeds);
        }
        uint256 fees = amounts.platformFee + amounts.creatorFee;
        if (fees != 0) {
            uint256 beforeBalance = paymentToken.balanceOf(address(feeVault));
            paymentToken.safeTransferFrom(buyer, address(feeVault), fees);
            uint256 received = paymentToken.balanceOf(address(feeVault)) - beforeBalance;
            if (received != fees) revert InexactTokenTransfer(fees, received);
            _accrueFees(listing, listingId, amounts);
        }
    }

    function _payHeld(Listing memory listing, bytes32 listingId, FillAmounts memory amounts)
        internal
    {
        if (amounts.sellerProceeds != 0) {
            paymentToken.safeTransfer(listing.seller, amounts.sellerProceeds);
        }
        uint256 fees = amounts.platformFee + amounts.creatorFee;
        if (fees != 0) {
            paymentToken.safeTransfer(address(feeVault), fees);
            _accrueFees(listing, listingId, amounts);
        }
    }

    function _accrueFees(Listing memory listing, bytes32 listingId, FillAmounts memory amounts)
        internal
    {
        IMarketVaultV1 market = IMarketVaultV1(listing.vault);
        feeVault.accrue(
            market.protocolTreasury(), amounts.platformFee, FEE_KIND_PLATFORM_C2C, listingId
        );
        feeVault.accrue(
            market.creatorTreasury(), amounts.creatorFee, FEE_KIND_CREATOR_C2C, listingId
        );
    }

    function _emitFill(
        bytes32 listingId,
        address buyer,
        Listing memory listing,
        uint256 desiredUnits,
        FillAmounts memory amounts
    ) internal {
        uint256 remainingUnits = listings[listingId].remainingUnits;
        emit ListingFilled(
            listingId,
            buyer,
            listing.seller,
            desiredUnits,
            amounts.units,
            amounts.gross,
            amounts.sellerProceeds,
            amounts.platformFee,
            amounts.creatorFee,
            remainingUnits
        );
    }

    function onERC1155Received(
        address,
        address from,
        uint256 id,
        uint256 value,
        bytes calldata data
    ) external view returns (bytes4) {
        bytes32 listingId = abi.decode(data, (bytes32));
        if (_expectedReceipt != keccak256(abi.encode(msg.sender, from, id, value, listingId))) {
            revert UnexpectedERC1155Transfer();
        }
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        revert UnexpectedERC1155Transfer();
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId
            || interfaceId == type(IERC165).interfaceId;
    }
}
