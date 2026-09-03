// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ERC1155 } from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import { ERC1155Supply } from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { ISignatureTransfer } from "permit2/interfaces/ISignatureTransfer.sol";
import { IEmergencyControllerV1 } from "../interfaces/IEmergencyControllerV1.sol";
import { ILaunchExposureGuardV1 } from "../interfaces/ILaunchExposureGuardV1.sol";
import { IFeeVaultV1 } from "../interfaces/IFeeVaultV1.sol";
import { IMarketFactoryV1 } from "../interfaces/IMarketFactoryV1.sol";
import { ProtocolTypes } from "../libraries/ProtocolTypes.sol";
import {
    Unauthorized,
    ZeroAddress,
    InvalidConfiguration,
    UnsupportedFeatureFlags,
    InvalidOutcome,
    UriTooLong,
    ImmutableAfterFirstBuy,
    MarketNotOpen,
    MarketNotClosed,
    MarketTerminal,
    DeadlineExpired,
    ResolutionWindowExpired,
    TimeoutNotReached,
    PauseActive,
    ZeroAmount,
    FillBelowMinimum,
    PaymentAboveMaximum,
    NothingToClaim,
    AlreadySettled,
    InexactTokenTransfer,
    AlreadyInitialized,
    InvalidInitializer,
    Permit2Disabled,
    EscrowOwnerMustReturnListing,
    Insolvent
} from "../libraries/ProtocolErrors.sol";

/// @notice Shared accounting and state machine for Full and EIP-1167 Clone market vaults.
/// @dev The Full/Clone observable behavior must remain differential-test equivalent.
abstract contract MarketVaultCoreV1 is ERC1155Supply, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint64 public constant MIN_RESOLUTION_WINDOW = 15 minutes;
    uint64 public constant MAX_RESOLUTION_WINDOW = 30 days;
    uint256 public constant MAX_URI_LENGTH = 512;
    uint256 public constant SUPPORTED_FEATURE_FLAGS =
        ProtocolTypes.FEATURE_EARLY_BIRD | ProtocolTypes.FEATURE_PERMIT2;

    bytes32 public constant FEE_KIND_PROTOCOL_RAKE = keccak256("PROTOCOL_RAKE");
    bytes32 public constant FEE_KIND_CREATOR_RAKE = keccak256("CREATOR_RAKE");
    bytes32 public constant BUY_WITNESS_TYPEHASH = keccak256(
        "BuyWitness(address owner,address vault,bytes4 selector,uint256 outcomeId,uint256 desiredUnits,uint256 minUnits,uint256 maxPayment,uint64 callDeadline,uint256 chainId)"
    );
    string public constant BUY_WITNESS_TYPE_STRING =
        "BuyWitness witness)BuyWitness(address owner,address vault,bytes4 selector,uint256 outcomeId,uint256 desiredUnits,uint256 minUnits,uint256 maxPayment,uint64 callDeadline,uint256 chainId)TokenPermissions(address token,uint256 amount)";

    bool private _initialized;

    address public factory;
    IERC20 internal _paymentToken;
    address public config;
    IEmergencyControllerV1 public emergencyController;
    ILaunchExposureGuardV1 public exposureGuard;
    address public bondEscrow;
    IFeeVaultV1 public feeVault;
    ISignatureTransfer public permit2;

    address public creator;
    address public creatorTreasury;
    bytes32 public rulesHash;
    bytes32 public resolutionSourceHash;
    string public resolutionSourceURI;
    uint8 public outcomeCount;
    uint64 public createdAt;
    uint64 public closeAt;
    uint64 public earlyBirdStart;
    uint64 public resolutionWindow;
    ProtocolTypes.DeploymentMode public deploymentMode;
    ProtocolTypes.MarketState public marketState;
    ProtocolTypes.VoidReason public voidReason;
    uint256 public featureFlags;

    uint128 public perUserPrimaryCap;
    uint128 public marketPrimaryCap;
    uint128 public minimumPrimaryUnits;
    uint128 public minimumC2CUnits;
    uint128 public creatorBond;

    ProtocolTypes.EconomicSnapshot internal _economics;
    ProtocolTypes.PayoutBreakdown public payoutBreakdown;

    uint8 public winningOutcome;
    // Low 128 bits: principal; high 128 bits: total early-bird score. Both are bounded by the
    // immutable market cap (the score is at most 3x principal), so one slot is sufficient.
    uint256 private _packedMarketAccounting;
    uint256 public remainingWinningUnits;
    uint256 public remainingWinnerPool;
    uint256 public remainingEarlyBirdScore;
    uint256 public remainingEarlyBirdPool;
    uint256 public remainingRefundPrincipal;
    uint256 public remainingTimeoutBonusUnits;
    uint256 public remainingTimeoutBonusPool;
    bool public timeoutBonusFunded;

    mapping(uint256 outcomeId => uint256 principal) public principalByOutcome;
    // Low 128 bits: cumulative primary units; high 128 bits: non-transferable early-bird score.
    mapping(address user => uint256 accounting) private _packedBuyerAccounting;
    mapping(address user => uint256 units) public timeoutBonusUnits;

    event MarketInitialized(
        address indexed market,
        address indexed creator,
        ProtocolTypes.DeploymentMode indexed mode,
        uint8 outcomeCount,
        uint64 closeAt,
        uint64 resolutionWindow,
        uint128 marketPrimaryCap,
        uint128 creatorBond
    );
    event MarketMetadataUpdated(
        bytes32 indexed rulesHash,
        string metadataURI,
        bytes32 indexed resolutionSourceHash,
        string resolutionSourceURI,
        uint64 closeAt,
        uint64 earlyBirdStart,
        address indexed creatorTreasury,
        uint256 featureFlags
    );
    event EconomicSnapshotCreated(
        uint16 creatorRakeBps,
        uint16 protocolShareBps,
        uint16 earlyBirdShareBps,
        uint16 platformC2CFeeBps,
        uint16 creatorC2CFeeBps,
        address indexed protocolTreasury
    );
    event PrimaryPurchased(
        address indexed buyer,
        uint256 indexed outcomeId,
        uint256 desiredUnits,
        uint256 filledUnits,
        uint256 payment,
        uint8 earlyBirdWeight,
        uint256 cumulativeUserPrimary,
        uint256 totalPrincipal
    );
    event MarketResolved(
        uint256 indexed winningOutcome,
        uint256 totalPrincipal,
        uint256 totalRake,
        uint256 protocolFee,
        uint256 creatorFee,
        uint256 earlyBirdPool,
        uint256 winnerPool,
        bytes32 indexed evidenceHash
    );
    event MarketVoided(
        ProtocolTypes.VoidReason indexed reason,
        address indexed caller,
        uint256 refundPrincipal,
        bytes32 indexed evidenceHash
    );
    event WinnerClaimed(
        address indexed owner, address indexed caller, uint256 burnedUnits, uint256 payout
    );
    event EarlyBirdClaimed(
        address indexed owner, address indexed caller, uint256 score, uint256 reward
    );
    event PrincipalRefunded(
        address indexed owner,
        address indexed caller,
        uint256 burnedUnits,
        uint256 refund,
        bool timeoutEligibilityRecorded
    );
    event TimeoutBonusFunded(
        uint256 amount,
        uint256 eligibleUnits,
        uint256 previousGuardExposure,
        uint256 currentGuardExposure
    );
    event TimeoutBonusClaimed(
        address indexed owner, address indexed caller, uint256 units, uint256 reward
    );
    event LosingPositionBurned(address indexed owner, uint256 indexed outcomeId, uint256 units);
    event FinalRemainderAssigned(bytes32 indexed pool, address indexed owner, uint256 amount);

    /// @param lockImplementation True only for the standalone Clone implementation.
    constructor(bool lockImplementation) ERC1155("") {
        if (lockImplementation) _initialized = true;
    }

    modifier onlyCreator() {
        if (msg.sender != creator) revert Unauthorized(msg.sender);
        _;
    }

    function paymentToken() external view returns (address) {
        return address(_paymentToken);
    }

    function economics() external view returns (ProtocolTypes.EconomicSnapshot memory) {
        return _economics;
    }

    function creatorC2CFeeBps() external view returns (uint16) {
        return _economics.creatorC2CFeeBps;
    }

    function protocolTreasury() external view returns (address) {
        return _economics.protocolTreasury;
    }

    function platformC2CFeeBps() external view returns (uint16) {
        return _economics.platformC2CFeeBps;
    }

    function firstBuyOccurred() public view returns (bool) {
        return totalPrincipal() != 0;
    }

    function totalPrincipal() public view returns (uint256) {
        return _packedMarketAccounting & type(uint128).max;
    }

    function totalEarlyBirdScore() public view returns (uint256) {
        return _packedMarketAccounting >> 128;
    }

    function cumulativePrimaryBought(address user) public view returns (uint256) {
        return _packedBuyerAccounting[user] & type(uint128).max;
    }

    function earlyBirdScore(address user) public view returns (uint256) {
        return _packedBuyerAccounting[user] >> 128;
    }

    function isTerminal() public view returns (bool) {
        return marketState != ProtocolTypes.MarketState.OPEN;
    }

    function resolutionDeadline() public view returns (uint256) {
        return uint256(closeAt) + resolutionWindow;
    }

    function earlyBirdEnabled() public view returns (bool) {
        return (featureFlags & ProtocolTypes.FEATURE_EARLY_BIRD) != 0;
    }

    function permit2Enabled() public view returns (bool) {
        return (featureFlags & ProtocolTypes.FEATURE_PERMIT2) != 0;
    }

    /// @notice Conservative exposure used only by the launch guard.
    function guardExposure() external view returns (uint256) {
        ProtocolTypes.MarketState state = marketState;
        if (state == ProtocolTypes.MarketState.OPEN) return totalPrincipal();
        if (state == ProtocolTypes.MarketState.RESOLVED) {
            return remainingWinnerPool + remainingEarlyBirdPool;
        }
        return remainingRefundPrincipal + remainingTimeoutBonusPool;
    }

    function initialize(ProtocolTypes.MarketInitParams calldata params) external virtual {
        _initialize(params);
    }

    function _initialize(ProtocolTypes.MarketInitParams memory params) internal {
        if (_initialized) revert AlreadyInitialized();
        if (msg.sender != params.factory) revert InvalidInitializer(msg.sender);
        if (
            params.factory == address(0) || params.paymentToken == address(0)
                || params.config == address(0) || params.emergencyController == address(0)
                || params.exposureGuard == address(0) || params.bondEscrow == address(0)
                || params.feeVault == address(0) || params.creator == address(0)
                || params.creatorTreasury == address(0)
                || params.economics.protocolTreasury == address(0)
        ) revert ZeroAddress();
        if (params.outcomeCount < 2 || params.outcomeCount > 32) {
            revert InvalidConfiguration("outcomeCount");
        }
        if (params.rulesHash == bytes32(0)) revert InvalidConfiguration("rulesHash");
        if (bytes(params.metadataURI).length > MAX_URI_LENGTH) {
            revert UriTooLong(bytes(params.metadataURI).length, MAX_URI_LENGTH);
        }
        if (bytes(params.resolutionSourceURI).length > MAX_URI_LENGTH) {
            revert UriTooLong(bytes(params.resolutionSourceURI).length, MAX_URI_LENGTH);
        }
        if ((params.featureFlags & ~SUPPORTED_FEATURE_FLAGS) != 0) {
            revert UnsupportedFeatureFlags(params.featureFlags);
        }
        if (
            params.resolutionWindow < MIN_RESOLUTION_WINDOW
                || params.resolutionWindow > MAX_RESOLUTION_WINDOW
        ) revert InvalidConfiguration("resolutionWindow");
        _validateTimes(params.createdAt, params.closeAt, params.earlyBirdStart);

        _initialized = true;
        factory = params.factory;
        _paymentToken = IERC20(params.paymentToken);
        config = params.config;
        emergencyController = IEmergencyControllerV1(params.emergencyController);
        exposureGuard = ILaunchExposureGuardV1(params.exposureGuard);
        bondEscrow = params.bondEscrow;
        feeVault = IFeeVaultV1(params.feeVault);
        permit2 = ISignatureTransfer(params.permit2);
        creator = params.creator;
        creatorTreasury = params.creatorTreasury;
        rulesHash = params.rulesHash;
        resolutionSourceHash = params.resolutionSourceHash;
        resolutionSourceURI = params.resolutionSourceURI;
        outcomeCount = params.outcomeCount;
        createdAt = params.createdAt;
        closeAt = params.closeAt;
        earlyBirdStart = params.earlyBirdStart;
        resolutionWindow = params.resolutionWindow;
        deploymentMode = params.deploymentMode;
        featureFlags = params.featureFlags;
        perUserPrimaryCap = params.perUserPrimaryCap;
        marketPrimaryCap = params.marketPrimaryCap;
        minimumPrimaryUnits = params.minimumPrimaryUnits;
        minimumC2CUnits = params.minimumC2CUnits;
        creatorBond = params.creatorBond;
        _economics = params.economics;
        _setURI(params.metadataURI);

        emit MarketInitialized(
            address(this),
            params.creator,
            params.deploymentMode,
            params.outcomeCount,
            params.closeAt,
            params.resolutionWindow,
            params.marketPrimaryCap,
            params.creatorBond
        );
        emit MarketMetadataUpdated(
            params.rulesHash,
            params.metadataURI,
            params.resolutionSourceHash,
            params.resolutionSourceURI,
            params.closeAt,
            params.earlyBirdStart,
            params.creatorTreasury,
            params.featureFlags
        );
        emit EconomicSnapshotCreated(
            params.economics.creatorRakeBps,
            params.economics.protocolShareBps,
            params.economics.earlyBirdShareBps,
            params.economics.platformC2CFeeBps,
            params.economics.creatorC2CFeeBps,
            params.economics.protocolTreasury
        );
    }

    /// @notice Updates non-economic market metadata before the first primary purchase.
    function updateBeforeFirstBuy(
        bytes32 newRulesHash,
        string calldata newMetadataURI,
        bytes32 newResolutionSourceHash,
        string calldata newResolutionSourceURI,
        uint64 newCloseAt,
        uint64 newEarlyBirdStart,
        address newCreatorTreasury,
        uint256 newFeatureFlags
    ) external onlyCreator {
        if (firstBuyOccurred()) revert ImmutableAfterFirstBuy();
        if (marketState != ProtocolTypes.MarketState.OPEN) revert MarketTerminal();
        if (newRulesHash == bytes32(0)) revert InvalidConfiguration("rulesHash");
        if (newCreatorTreasury == address(0)) revert ZeroAddress();
        if (bytes(newMetadataURI).length > MAX_URI_LENGTH) {
            revert UriTooLong(bytes(newMetadataURI).length, MAX_URI_LENGTH);
        }
        if (bytes(newResolutionSourceURI).length > MAX_URI_LENGTH) {
            revert UriTooLong(bytes(newResolutionSourceURI).length, MAX_URI_LENGTH);
        }
        if ((newFeatureFlags & ~SUPPORTED_FEATURE_FLAGS) != 0) {
            revert UnsupportedFeatureFlags(newFeatureFlags);
        }
        _validateTimes(createdAt, newCloseAt, newEarlyBirdStart);
        if (newCloseAt <= block.timestamp) revert MarketNotOpen();

        rulesHash = newRulesHash;
        resolutionSourceHash = newResolutionSourceHash;
        resolutionSourceURI = newResolutionSourceURI;
        closeAt = newCloseAt;
        earlyBirdStart = newEarlyBirdStart;
        creatorTreasury = newCreatorTreasury;
        featureFlags = newFeatureFlags;
        _setURI(newMetadataURI);
        emit MarketMetadataUpdated(
            newRulesHash,
            newMetadataURI,
            newResolutionSourceHash,
            newResolutionSourceURI,
            newCloseAt,
            newEarlyBirdStart,
            newCreatorTreasury,
            newFeatureFlags
        );
    }

    function buy(
        uint256 outcomeId,
        uint256 desiredUnits,
        uint256 minUnits,
        uint256 maxPayment,
        uint64 deadline
    ) external nonReentrant returns (uint256 filledUnits) {
        filledUnits = _prepareBuy(
            msg.sender, outcomeId, desiredUnits, minUnits, maxPayment, deadline
        );
        _pullExact(msg.sender, filledUnits);
        _completeBuy(msg.sender, outcomeId, desiredUnits, filledUnits);
    }

    function buyWithPermit2(
        address owner,
        uint256 outcomeId,
        uint256 desiredUnits,
        uint256 minUnits,
        uint256 maxPayment,
        uint64 callDeadline,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        bytes calldata signature
    ) external nonReentrant returns (uint256 filledUnits) {
        if (!permit2Enabled() || address(permit2) == address(0)) {
            revert Permit2Disabled();
        }
        if (emergencyController.isPaused(ProtocolTypes.PAUSE_PERMIT2)) {
            revert PauseActive(ProtocolTypes.PAUSE_PERMIT2);
        }
        filledUnits =
            _prepareBuy(owner, outcomeId, desiredUnits, minUnits, maxPayment, callDeadline);
        if (
            permit.permitted.token != address(_paymentToken)
                || permit.permitted.amount < filledUnits
        ) {
            revert InvalidConfiguration("permit2.permissions");
        }

        bytes32 witness = keccak256(
            abi.encode(
                BUY_WITNESS_TYPEHASH,
                owner,
                address(this),
                this.buyWithPermit2.selector,
                outcomeId,
                desiredUnits,
                minUnits,
                maxPayment,
                callDeadline,
                block.chainid
            )
        );
        _pullWithPermit2(owner, filledUnits, permit, witness, signature);
        _completeBuy(owner, outcomeId, desiredUnits, filledUnits);
    }

    function _pullWithPermit2(
        address owner,
        uint256 amount,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        bytes32 witness,
        bytes calldata signature
    ) internal {
        uint256 beforeBalance = _paymentToken.balanceOf(address(this));
        ISignatureTransfer.SignatureTransferDetails memory details =
            ISignatureTransfer.SignatureTransferDetails({
                to: address(this), requestedAmount: amount
            });
        permit2.permitWitnessTransferFrom(
            permit, details, owner, witness, BUY_WITNESS_TYPE_STRING, signature
        );
        uint256 received = _paymentToken.balanceOf(address(this)) - beforeBalance;
        if (received != amount) revert InexactTokenTransfer(amount, received);
    }

    function _prepareBuy(
        address buyer,
        uint256 outcomeId,
        uint256 desiredUnits,
        uint256 minUnits,
        uint256 maxPayment,
        uint64 deadline
    ) internal view returns (uint256 filledUnits) {
        if (buyer == address(0)) revert ZeroAddress();
        if (marketState != ProtocolTypes.MarketState.OPEN || block.timestamp >= closeAt) {
            revert MarketNotOpen();
        }
        if (emergencyController.isPaused(ProtocolTypes.PAUSE_PRIMARY_BUY)) {
            revert PauseActive(ProtocolTypes.PAUSE_PRIMARY_BUY);
        }
        if (block.timestamp > deadline) revert DeadlineExpired(deadline, block.timestamp);
        if (outcomeId >= outcomeCount) revert InvalidOutcome(outcomeId, outcomeCount);
        if (desiredUnits == 0) revert ZeroAmount();

        uint256 marketAvailable = uint256(marketPrimaryCap) - totalPrincipal();
        uint256 userAvailable = uint256(perUserPrimaryCap) - cumulativePrimaryBought(buyer);
        filledUnits = Math.min(desiredUnits, Math.min(marketAvailable, userAvailable));
        if (filledUnits < minUnits || filledUnits < minimumPrimaryUnits) {
            revert FillBelowMinimum(filledUnits, Math.max(minUnits, minimumPrimaryUnits));
        }
        if (filledUnits > maxPayment) revert PaymentAboveMaximum(filledUnits, maxPayment);
    }

    function _completeBuy(
        address buyer,
        uint256 outcomeId,
        uint256 desiredUnits,
        uint256 filledUnits
    ) internal {
        exposureGuard.reserve(filledUnits);
        uint256 nextPrincipal = totalPrincipal() + filledUnits;
        uint256 nextTotalScore = totalEarlyBirdScore();
        uint256 packedBuyer = _packedBuyerAccounting[buyer];
        uint256 nextCumulative = (packedBuyer & type(uint128).max) + filledUnits;
        uint256 nextBuyerScore = packedBuyer >> 128;
        uint8 weight = _earlyBirdWeight(block.timestamp);
        if (weight != 0) {
            uint256 score = filledUnits * weight;
            nextBuyerScore += score;
            nextTotalScore += score;
        }

        _setMarketAccounting(nextPrincipal, nextTotalScore);
        _packedBuyerAccounting[buyer] = _packUint128Pair(nextCumulative, nextBuyerScore);
        principalByOutcome[outcomeId] += filledUnits;

        _mint(buyer, outcomeId, filledUnits, "");
        emit PrimaryPurchased(
            buyer,
            outcomeId,
            desiredUnits,
            filledUnits,
            filledUnits,
            weight,
            nextCumulative,
            nextPrincipal
        );
    }

    function _pullExact(address from, uint256 amount) internal {
        uint256 beforeBalance = _paymentToken.balanceOf(address(this));
        _paymentToken.safeTransferFrom(from, address(this), amount);
        uint256 received = _paymentToken.balanceOf(address(this)) - beforeBalance;
        if (received != amount) revert InexactTokenTransfer(amount, received);
    }

    function _earlyBirdWeight(uint256 timestamp) internal view returns (uint8) {
        if (!earlyBirdEnabled()) return 0;
        if (timestamp < earlyBirdStart) return 3;
        if (timestamp >= closeAt) return 0;
        uint256 duration = uint256(closeAt) - earlyBirdStart;
        uint256 offset = timestamp - earlyBirdStart;
        if (offset * 3 < duration) return 3;
        if (offset * 3 < duration * 2) return 2;
        return 1;
    }

    /// @notice Resolves the market and commits any creator-supplied evidence in the terminal event.
    /// @dev Opaque event-only hash; it never affects auth, state, or payouts. Zero means absent.
    /// @param outcomeId The selected outcome; zero supply voids without rake or bond slash.
    /// @param evidenceHash Hash commitment to offchain resolution evidence; zero if absent.
    function resolve(uint256 outcomeId, bytes32 evidenceHash) external onlyCreator nonReentrant {
        if (marketState != ProtocolTypes.MarketState.OPEN) revert MarketTerminal();
        if (block.timestamp < closeAt) revert MarketNotClosed();
        if (block.timestamp >= resolutionDeadline()) revert ResolutionWindowExpired();
        if (outcomeId >= outcomeCount) revert InvalidOutcome(outcomeId, outcomeCount);
        uint256 winningSupply = totalSupply(outcomeId);
        if (winningSupply == 0) {
            _void(ProtocolTypes.VoidReason.NO_WINNING_SUPPLY, evidenceHash);
            return;
        }

        ProtocolTypes.PayoutBreakdown memory breakdown = _calculatePayouts();
        marketState = ProtocolTypes.MarketState.RESOLVED;
        winningOutcome = outcomeId.toUint8();
        payoutBreakdown = breakdown;
        remainingWinningUnits = winningSupply;
        remainingWinnerPool = breakdown.winnerPool;
        remainingEarlyBirdScore = totalEarlyBirdScore();
        remainingEarlyBirdPool = breakdown.earlyBirdPool;

        uint256 fees = breakdown.protocolFee + breakdown.creatorFee;
        if (fees != 0) {
            _paymentToken.safeTransfer(address(feeVault), fees);
            feeVault.accrue(
                _economics.protocolTreasury,
                breakdown.protocolFee,
                FEE_KIND_PROTOCOL_RAKE,
                bytes32(uint256(uint160(address(this))))
            );
            feeVault.accrue(
                creatorTreasury,
                breakdown.creatorFee,
                FEE_KIND_CREATOR_RAKE,
                bytes32(uint256(uint160(address(this))))
            );
        }
        _assertCoverage();
        emit MarketResolved(
            outcomeId,
            breakdown.totalPrincipal,
            breakdown.totalRake,
            breakdown.protocolFee,
            breakdown.creatorFee,
            breakdown.earlyBirdPool,
            breakdown.winnerPool,
            evidenceHash
        );
    }

    /// @notice Voids the market by creator action and commits any supplied evidence in the event.
    /// @dev `evidenceHash` is opaque, event-only, and has no effect on authorization, refunds, or
    ///      state transitions. Zero means that no evidence commitment was provided.
    /// @param evidenceHash Optional hash commitment to offchain void evidence; zero if absent.
    function creatorVoid(bytes32 evidenceHash) external onlyCreator {
        if (marketState != ProtocolTypes.MarketState.OPEN) revert MarketTerminal();
        if (block.timestamp >= resolutionDeadline()) revert ResolutionWindowExpired();
        _void(ProtocolTypes.VoidReason.CREATOR, evidenceHash);
    }

    /// @notice Permissionlessly voids a market after the resolution deadline.
    /// @dev The deadline proves this transition, so its evidence hash is always zero.
    function voidAfterDeadline() external {
        if (marketState != ProtocolTypes.MarketState.OPEN) revert MarketTerminal();
        if (block.timestamp < resolutionDeadline()) revert TimeoutNotReached();
        _void(ProtocolTypes.VoidReason.TIMEOUT, bytes32(0));
    }

    function _void(ProtocolTypes.VoidReason reason, bytes32 evidenceHash) internal {
        marketState = ProtocolTypes.MarketState.VOIDED;
        voidReason = reason;
        uint256 principal = totalPrincipal();
        remainingRefundPrincipal = principal;
        emit MarketVoided(reason, msg.sender, principal, evidenceHash);
    }

    function claimWinnings() external returns (uint256 payout) {
        return claimWinningsFor(msg.sender);
    }

    function claimWinningsFor(address owner) public nonReentrant returns (uint256 payout) {
        if (marketState != ProtocolTypes.MarketState.RESOLVED) revert MarketNotClosed();
        _rejectProtocolMarketplaceOwner(owner);
        uint256 units = balanceOf(owner, winningOutcome);
        if (units == 0) revert NothingToClaim();
        payout = _consumeRemainingPool(
            units, remainingWinningUnits, remainingWinnerPool, keccak256("WINNER_POOL"), owner
        );
        remainingWinningUnits -= units;
        remainingWinnerPool -= payout;
        _burn(owner, winningOutcome, units);
        _paymentToken.safeTransfer(owner, payout);
        emit WinnerClaimed(owner, msg.sender, units, payout);
    }

    function claimEarlyBird() external returns (uint256 reward) {
        return claimEarlyBirdFor(msg.sender);
    }

    function claimEarlyBirdFor(address owner) public nonReentrant returns (uint256 reward) {
        if (marketState != ProtocolTypes.MarketState.RESOLVED) revert MarketNotClosed();
        uint256 packedBuyer = _packedBuyerAccounting[owner];
        uint256 score = packedBuyer >> 128;
        if (score == 0 || remainingEarlyBirdPool == 0) revert NothingToClaim();
        reward = _consumeRemainingPool(
            score,
            remainingEarlyBirdScore,
            remainingEarlyBirdPool,
            keccak256("EARLY_BIRD_POOL"),
            owner
        );
        _packedBuyerAccounting[owner] = packedBuyer & type(uint128).max;
        remainingEarlyBirdScore -= score;
        remainingEarlyBirdPool -= reward;
        _paymentToken.safeTransfer(owner, reward);
        emit EarlyBirdClaimed(owner, msg.sender, score, reward);
    }

    function refund() external returns (uint256 amount) {
        return refundFor(msg.sender);
    }

    function refundFor(address owner) public nonReentrant returns (uint256 amount) {
        if (marketState != ProtocolTypes.MarketState.VOIDED) revert MarketNotClosed();
        _rejectProtocolMarketplaceOwner(owner);

        for (uint256 outcomeId = 0; outcomeId < outcomeCount; ++outcomeId) {
            amount += balanceOf(owner, outcomeId);
        }
        if (amount == 0) revert NothingToClaim();
        remainingRefundPrincipal -= amount;
        if (voidReason == ProtocolTypes.VoidReason.TIMEOUT) {
            timeoutBonusUnits[owner] += amount;
        }
        for (uint256 outcomeId = 0; outcomeId < outcomeCount; ++outcomeId) {
            uint256 units = balanceOf(owner, outcomeId);
            if (units != 0) _burn(owner, outcomeId, units);
        }
        _paymentToken.safeTransfer(owner, amount);
        emit PrincipalRefunded(
            owner, msg.sender, amount, amount, voidReason == ProtocolTypes.VoidReason.TIMEOUT
        );
    }

    function fundTimeoutBonus(uint256 amount) external nonReentrant {
        if (msg.sender != bondEscrow) revert Unauthorized(msg.sender);
        if (
            marketState != ProtocolTypes.MarketState.VOIDED
                || voidReason != ProtocolTypes.VoidReason.TIMEOUT
        ) revert MarketNotClosed();
        if (timeoutBonusFunded) revert AlreadySettled();
        if (amount == 0) revert ZeroAmount();
        timeoutBonusFunded = true;
        uint256 principal = totalPrincipal();
        remainingTimeoutBonusUnits = principal;
        remainingTimeoutBonusPool = amount;
        // Bonus funding can increase terminal user liabilities above the last principal-only
        // report. Synchronize immediately; later claims may leave the report conservatively high.
        (uint256 previousGuardExposure, uint256 currentGuardExposure) =
            exposureGuard.sync(address(this));
        _assertCoverage();
        emit TimeoutBonusFunded(amount, principal, previousGuardExposure, currentGuardExposure);
    }

    function claimTimeoutBonus() external returns (uint256 reward) {
        return claimTimeoutBonusFor(msg.sender);
    }

    function claimTimeoutBonusFor(address owner) public nonReentrant returns (uint256 reward) {
        if (!timeoutBonusFunded) revert NothingToClaim();
        uint256 units = timeoutBonusUnits[owner];
        if (units == 0) revert NothingToClaim();
        reward = _consumeRemainingPool(
            units,
            remainingTimeoutBonusUnits,
            remainingTimeoutBonusPool,
            keccak256("TIMEOUT_BONUS_POOL"),
            owner
        );
        timeoutBonusUnits[owner] = 0;
        remainingTimeoutBonusUnits -= units;
        remainingTimeoutBonusPool -= reward;
        _paymentToken.safeTransfer(owner, reward);
        emit TimeoutBonusClaimed(owner, msg.sender, units, reward);
    }

    function _rejectProtocolMarketplaceOwner(address owner) internal view {
        address protocolMarketplace = IMarketFactoryV1(factory).marketplace();
        if (protocolMarketplace != address(0) && owner == protocolMarketplace) {
            revert EscrowOwnerMustReturnListing(protocolMarketplace);
        }
    }

    function burnLosingPosition(uint256 outcomeId) external {
        if (marketState != ProtocolTypes.MarketState.RESOLVED) revert MarketNotClosed();
        if (outcomeId >= outcomeCount || outcomeId == winningOutcome) {
            revert InvalidOutcome(outcomeId, outcomeCount);
        }
        uint256 units = balanceOf(msg.sender, outcomeId);
        if (units == 0) revert NothingToClaim();
        _burn(msg.sender, outcomeId, units);
        emit LosingPositionBurned(msg.sender, outcomeId, units);
    }

    function _calculatePayouts()
        internal
        view
        returns (ProtocolTypes.PayoutBreakdown memory result)
    {
        uint256 principal = totalPrincipal();
        uint256 rake = Math.mulDiv(principal, _economics.creatorRakeBps, ProtocolTypes.BPS);
        uint256 protocolFee = Math.mulDiv(rake, _economics.protocolShareBps, ProtocolTypes.BPS);
        uint256 creatorNetRake = rake - protocolFee;
        uint256 earlyScore = totalEarlyBirdScore();
        uint256 earlyPool = earlyBirdEnabled() && earlyScore != 0
            ? Math.mulDiv(creatorNetRake, _economics.earlyBirdShareBps, ProtocolTypes.BPS)
            : 0;
        result = ProtocolTypes.PayoutBreakdown({
            totalPrincipal: principal,
            totalRake: rake,
            protocolFee: protocolFee,
            earlyBirdPool: earlyPool,
            creatorFee: creatorNetRake - earlyPool,
            winnerPool: principal - rake
        });
    }

    function _consumeRemainingPool(
        uint256 units,
        uint256 remainingUnits,
        uint256 remainingPool,
        bytes32 poolId,
        address owner
    ) internal returns (uint256 amount) {
        if (units == 0 || remainingUnits == 0 || units > remainingUnits) {
            revert NothingToClaim();
        }
        if (units == remainingUnits) {
            amount = remainingPool;
            emit FinalRemainderAssigned(poolId, owner, amount);
        } else {
            amount = Math.mulDiv(units, remainingPool, remainingUnits);
        }
    }

    function _assertCoverage() internal view {
        uint256 liabilities;
        if (marketState == ProtocolTypes.MarketState.RESOLVED) {
            liabilities = remainingWinnerPool + remainingEarlyBirdPool;
        } else if (marketState == ProtocolTypes.MarketState.VOIDED) {
            liabilities = remainingRefundPrincipal + remainingTimeoutBonusPool;
        } else {
            liabilities = totalPrincipal();
        }
        uint256 balance = _paymentToken.balanceOf(address(this));
        if (balance < liabilities) revert Insolvent(balance, liabilities);
    }

    function _validateTimes(uint64 creationTime, uint64 marketClose, uint64 earlyStart)
        internal
        pure
    {
        if (
            marketClose < creationTime + 5 minutes || marketClose > creationTime + 90 days
                || earlyStart < creationTime || earlyStart >= marketClose
        ) revert InvalidConfiguration("market.times");
    }

    /// @dev Reverts instead of truncating if a future protocol version raises caps beyond the
    /// V1 accounting proof. `low` occupies bits [0,127], `high` bits [128,255].
    function _packUint128Pair(uint256 low, uint256 high) internal pure returns (uint256) {
        return uint256(low.toUint128()) | (uint256(high.toUint128()) << 128);
    }

    function _setMarketAccounting(uint256 principal, uint256 earlyScore) internal {
        _packedMarketAccounting = _packUint128Pair(principal, earlyScore);
    }
}
