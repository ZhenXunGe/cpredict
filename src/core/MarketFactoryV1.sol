// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { IMarketVaultV1 } from "../interfaces/IMarketVaultV1.sol";
import { IFullMarketDeployerV1 } from "../interfaces/IFullMarketDeployerV1.sol";
import { IProtocolConfigV1 } from "../interfaces/IProtocolConfigV1.sol";
import { IEmergencyControllerV1 } from "../interfaces/IEmergencyControllerV1.sol";
import { ILaunchExposureGuardV1 } from "../interfaces/ILaunchExposureGuardV1.sol";
import { IFeeVaultV1 } from "../interfaces/IFeeVaultV1.sol";
import { IBondEscrowV1 } from "../interfaces/IBondEscrowV1.sol";
import { IFixedPriceMarketplaceV1 } from "../interfaces/IFixedPriceMarketplaceV1.sol";
import { ProtocolTypes } from "../libraries/ProtocolTypes.sol";
import {
    Unauthorized,
    ZeroAddress,
    AlreadyConfigured,
    InvalidConfiguration,
    ValueOutOfRange,
    UnsupportedFeatureFlags,
    UriTooLong,
    PauseActive,
    MarketAlreadyRegistered,
    InexactTokenTransfer,
    FactoryNotActive,
    DependencyCodeMissing,
    DependencyFingerprintMismatch,
    DependencyWiringMismatch
} from "../libraries/ProtocolErrors.sol";

/// @notice Permissionless deterministic factory for immutable Full and fixed-implementation Clone
/// vaults.
contract MarketFactoryV1 is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint256 public constant MAX_URI_LENGTH = 512;
    uint256 public constant MAX_CREATOR_BOND = 1000e6;
    uint256 public constant MIN_CREATOR_BOND = 10e6;
    uint256 public constant BOND_RATE_BPS = 200;
    uint256 public constant MIN_CONFIGURED_UNITS = 10_000;
    uint256 public constant MAX_CONFIGURED_UNITS = 5e6;
    uint64 public constant MIN_RESOLUTION_WINDOW = 15 minutes;
    uint64 public constant MAX_RESOLUTION_WINDOW = 30 days;
    uint256 public constant SUPPORTED_FEATURE_FLAGS =
        ProtocolTypes.FEATURE_EARLY_BIRD | ProtocolTypes.FEATURE_PERMIT2;
    bytes32 public constant FEE_KIND_CREATION = keccak256("MARKET_CREATION");

    address public immutable governance;
    IERC20 public immutable paymentToken;
    IProtocolConfigV1 public immutable config;
    IEmergencyControllerV1 public immutable emergencyController;
    ILaunchExposureGuardV1 public immutable exposureGuard;
    IBondEscrowV1 public immutable bondEscrow;
    IFeeVaultV1 public immutable feeVault;
    IFullMarketDeployerV1 public immutable fullMarketDeployer;
    address public immutable cloneImplementation;
    address public immutable permit2;
    uint64 public immutable resolutionWindow;

    address public marketplace;
    bool public active;
    bool public deprecated;
    bytes32 public activationFingerprint;

    mapping(address creator => uint256 nonce) public creatorNonce;
    mapping(address market => bool registered) public isMarket;
    mapping(address market => ProtocolTypes.DeploymentMode mode) public deploymentModeOf;
    mapping(address market => bytes32 salt) public deploymentSaltOf;

    event MarketCreated(
        address indexed market,
        address indexed creator,
        ProtocolTypes.DeploymentMode indexed deploymentMode,
        address implementation,
        bytes32 salt,
        bytes32 runtimeCodeHash,
        uint256 creatorNonce,
        uint256 creationFee,
        uint256 creatorBond
    );
    event MarketplaceConfigured(address indexed marketplace);
    event FactoryActivated(bytes32 indexed dependencyFingerprint);
    event FactoryDeprecationUpdated(bool deprecated);

    constructor(
        address governance_,
        address config_,
        address emergencyController_,
        address exposureGuard_,
        address bondEscrow_,
        address feeVault_,
        address fullMarketDeployer_,
        address cloneImplementation_,
        uint64 resolutionWindow_,
        address permit2_
    ) {
        if (
            governance_ == address(0) || config_ == address(0) || emergencyController_ == address(0)
                || exposureGuard_ == address(0) || bondEscrow_ == address(0)
                || feeVault_ == address(0) || fullMarketDeployer_ == address(0)
                || cloneImplementation_ == address(0)
        ) revert ZeroAddress();
        governance = governance_;
        config = IProtocolConfigV1(config_);
        paymentToken = IERC20(IProtocolConfigV1(config_).paymentToken());
        emergencyController = IEmergencyControllerV1(emergencyController_);
        exposureGuard = ILaunchExposureGuardV1(exposureGuard_);
        bondEscrow = IBondEscrowV1(bondEscrow_);
        feeVault = IFeeVaultV1(feeVault_);
        fullMarketDeployer = IFullMarketDeployerV1(fullMarketDeployer_);
        cloneImplementation = cloneImplementation_;
        if (resolutionWindow_ < MIN_RESOLUTION_WINDOW || resolutionWindow_ > MAX_RESOLUTION_WINDOW)
        {
            revert ValueOutOfRange(
                "resolutionWindow", resolutionWindow_, MIN_RESOLUTION_WINDOW, MAX_RESOLUTION_WINDOW
            );
        }
        resolutionWindow = resolutionWindow_;
        permit2 = permit2_;
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert Unauthorized(msg.sender);
        _;
    }

    function createMarket(ProtocolTypes.CreateMarketParams calldata params, bytes32 userSalt)
        external
        nonReentrant
        returns (address market)
    {
        if (!active) revert FactoryNotActive();
        if (deprecated) revert InvalidConfiguration("factory.deprecated");
        if (emergencyController.isPaused(ProtocolTypes.PAUSE_MARKET_CREATION)) {
            revert PauseActive(ProtocolTypes.PAUSE_MARKET_CREATION);
        }
        ProtocolTypes.EconomicSnapshot memory economics = _validate(params);

        uint256 nonce = creatorNonce[msg.sender];
        creatorNonce[msg.sender] = nonce + 1;
        bytes32 salt = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                msg.sender,
                nonce,
                userSalt,
                params.rulesHash,
                params.closeAt,
                params.marketPrimaryCap,
                params.deploymentMode
            )
        );
        ProtocolTypes.MarketInitParams memory init = _buildInit(params, msg.sender, economics);

        if (params.deploymentMode == ProtocolTypes.DeploymentMode.FULL) {
            market = fullMarketDeployer.deploy(salt);
            IMarketVaultV1(market).initialize(init);
        } else {
            market = Clones.cloneDeterministic(cloneImplementation, salt);
            IMarketVaultV1(market).initialize(init);
        }

        if (isMarket[market]) revert MarketAlreadyRegistered(market);
        isMarket[market] = true;
        deploymentModeOf[market] = params.deploymentMode;
        deploymentSaltOf[market] = salt;
        exposureGuard.registerMarket(market);
        feeVault.registerAccruer(market);

        uint256 creationFee_ = config.creationFee();
        if (creationFee_ != 0) {
            _transferExact(msg.sender, address(feeVault), creationFee_);
            feeVault.accrue(
                config.protocolTreasury(),
                creationFee_,
                FEE_KIND_CREATION,
                bytes32(uint256(uint160(market)))
            );
        }
        _transferExact(msg.sender, address(bondEscrow), params.creatorBond);
        bondEscrow.lockBond(market, msg.sender, params.creatorBond);

        _emitMarketCreated(market, msg.sender, params, salt, nonce, creationFee_);
    }

    function _emitMarketCreated(
        address market,
        address creator_,
        ProtocolTypes.CreateMarketParams calldata params,
        bytes32 salt,
        uint256 nonce,
        uint256 creationFee_
    ) internal {
        address implementation = params.deploymentMode == ProtocolTypes.DeploymentMode.CLONE
            ? cloneImplementation
            : address(0);
        emit MarketCreated(
            market,
            creator_,
            params.deploymentMode,
            implementation,
            salt,
            market.codehash,
            nonce,
            creationFee_,
            params.creatorBond
        );
    }

    function setMarketplace(address marketplace_) external onlyGovernance {
        if (marketplace_ == address(0)) revert ZeroAddress();
        if (marketplace != address(0)) revert AlreadyConfigured();
        marketplace = marketplace_;
        feeVault.registerAccruer(marketplace_);
        emit MarketplaceConfigured(marketplace_);
    }

    /// @notice Irreversibly activates market creation after verifying the complete V1 wiring.
    /// @dev `expectedFingerprint` must be independently sourced from the reviewed deployment
    /// manifest. It binds this chain, this Factory, every dependency address, and every current
    /// runtime code hash.
    function activate(bytes32 expectedFingerprint) external onlyGovernance {
        if (active) revert AlreadyConfigured();
        _validateDependencyCode();
        _validateDependencyWiring();
        bytes32 actualFingerprint = dependencyFingerprint();
        if (actualFingerprint != expectedFingerprint) {
            revert DependencyFingerprintMismatch(expectedFingerprint, actualFingerprint);
        }
        active = true;
        activationFingerprint = actualFingerprint;
        emit FactoryActivated(actualFingerprint);
    }

    /// @notice Deployment-specific commitment used by the activation and source manifests.
    function dependencyFingerprint() public view returns (bytes32) {
        return dependencyFingerprintFor(marketplace);
    }

    /// @notice Computes the activation commitment before the one-time marketplace wiring call.
    function dependencyFingerprintFor(address marketplace_) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                block.chainid,
                address(this),
                _codeIdentity(address(config)),
                _codeIdentity(address(emergencyController)),
                _codeIdentity(address(exposureGuard)),
                _codeIdentity(address(bondEscrow)),
                _codeIdentity(address(feeVault)),
                _codeIdentity(address(fullMarketDeployer)),
                _codeIdentity(cloneImplementation),
                _codeIdentity(address(paymentToken)),
                _codeIdentity(permit2),
                _codeIdentity(marketplace_)
            )
        );
    }

    function setDeprecated(bool deprecated_) external onlyGovernance {
        deprecated = deprecated_;
        emit FactoryDeprecationUpdated(deprecated_);
    }

    function predictCloneAddress(
        address creator_,
        uint256 nonce,
        bytes32 userSalt,
        bytes32 rulesHash_,
        uint64 closeAt_,
        uint128 marketCap_
    ) external view returns (address predicted) {
        bytes32 salt = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                creator_,
                nonce,
                userSalt,
                rulesHash_,
                closeAt_,
                marketCap_,
                ProtocolTypes.DeploymentMode.CLONE
            )
        );
        return Clones.predictDeterministicAddress(cloneImplementation, salt, address(this));
    }

    function requiredBond(uint128 marketPrimaryCap) public pure returns (uint256) {
        return Math.max(
            MIN_CREATOR_BOND,
            Math.mulDiv(marketPrimaryCap, BOND_RATE_BPS, ProtocolTypes.BPS, Math.Rounding.Ceil)
        );
    }

    function _buildInit(
        ProtocolTypes.CreateMarketParams calldata params,
        address creator_,
        ProtocolTypes.EconomicSnapshot memory economics
    ) internal view returns (ProtocolTypes.MarketInitParams memory init) {
        init = ProtocolTypes.MarketInitParams({
            factory: address(this),
            paymentToken: address(paymentToken),
            config: address(config),
            emergencyController: address(emergencyController),
            exposureGuard: address(exposureGuard),
            bondEscrow: address(bondEscrow),
            feeVault: address(feeVault),
            permit2: permit2,
            creator: creator_,
            rulesHash: params.rulesHash,
            metadataURI: params.metadataURI,
            resolutionSourceHash: params.resolutionSourceHash,
            resolutionSourceURI: params.resolutionSourceURI,
            outcomeCount: params.outcomeCount,
            createdAt: block.timestamp.toUint64(),
            closeAt: params.closeAt,
            eventStartsAt: params.eventStartsAt,
            outcomeDeadlineAt: params.outcomeDeadlineAt,
            resolutionWindow: resolutionWindow,
            creatorTreasury: params.creatorTreasury,
            deploymentMode: params.deploymentMode,
            featureFlags: params.featureFlags,
            perUserPrimaryCap: params.perUserPrimaryCap,
            marketPrimaryCap: params.marketPrimaryCap,
            minimumPrimaryUnits: params.minimumPrimaryUnits,
            minimumC2CUnits: params.minimumC2CUnits,
            creatorBond: params.creatorBond,
            economics: economics
        });
    }

    function _validate(ProtocolTypes.CreateMarketParams calldata params)
        internal
        view
        returns (ProtocolTypes.EconomicSnapshot memory economics)
    {
        if (params.rulesHash == bytes32(0)) revert InvalidConfiguration("rulesHash");
        if (params.creatorTreasury == address(0)) revert ZeroAddress();
        if (bytes(params.metadataURI).length > MAX_URI_LENGTH) {
            revert UriTooLong(bytes(params.metadataURI).length, MAX_URI_LENGTH);
        }
        if (bytes(params.resolutionSourceURI).length > MAX_URI_LENGTH) {
            revert UriTooLong(bytes(params.resolutionSourceURI).length, MAX_URI_LENGTH);
        }
        if (params.outcomeCount < 2 || params.outcomeCount > 32) {
            revert ValueOutOfRange("outcomeCount", params.outcomeCount, 2, 32);
        }
        if (
            params.closeAt < block.timestamp + 5 minutes
                || params.closeAt > block.timestamp + 90 days
        ) revert InvalidConfiguration("market.times");
        if (
            params.outcomeDeadlineAt < params.closeAt
                || (params.eventStartsAt != 0
                    && (params.eventStartsAt <= params.closeAt
                        || params.eventStartsAt > params.outcomeDeadlineAt))
        ) revert InvalidConfiguration("market.eventTimes");
        if ((params.featureFlags & ~SUPPORTED_FEATURE_FLAGS) != 0) {
            revert UnsupportedFeatureFlags(params.featureFlags);
        }
        if ((params.featureFlags & ProtocolTypes.FEATURE_PERMIT2) != 0 && permit2 == address(0)) {
            revert InvalidConfiguration("permit2");
        }

        uint256 modeCap = params.deploymentMode == ProtocolTypes.DeploymentMode.FULL
            ? config.maxFullMarketCap()
            : config.maxCloneMarketCap();
        if (params.marketPrimaryCap == 0 || params.marketPrimaryCap > modeCap) {
            revert ValueOutOfRange("marketPrimaryCap", params.marketPrimaryCap, 1, modeCap);
        }
        if (
            params.perUserPrimaryCap == 0
                || params.perUserPrimaryCap > config.maxPerUserPrimaryCap()
                || params.perUserPrimaryCap > params.marketPrimaryCap
        ) {
            revert ValueOutOfRange(
                "perUserPrimaryCap", params.perUserPrimaryCap, 1, config.maxPerUserPrimaryCap()
            );
        }
        _validateMinimum(
            "minimumPrimaryUnits", params.minimumPrimaryUnits, params.perUserPrimaryCap
        );
        _validateMinimum("minimumC2CUnits", params.minimumC2CUnits, params.marketPrimaryCap);

        uint256 minimumBond = requiredBond(params.marketPrimaryCap);
        if (params.creatorBond < minimumBond || params.creatorBond > MAX_CREATOR_BOND) {
            revert ValueOutOfRange("creatorBond", params.creatorBond, minimumBond, MAX_CREATOR_BOND);
        }
        economics = config.snapshot(params.creatorRakeBps, params.creatorC2CFeeBps);
    }

    function _validateMinimum(bytes32 field, uint128 value, uint128 cap) internal pure {
        if (value < MIN_CONFIGURED_UNITS || value > MAX_CONFIGURED_UNITS || value > cap) {
            revert ValueOutOfRange(
                field, value, MIN_CONFIGURED_UNITS, Math.min(MAX_CONFIGURED_UNITS, cap)
            );
        }
    }

    function _transferExact(address from, address to, uint256 amount) internal {
        uint256 beforeBalance = paymentToken.balanceOf(to);
        paymentToken.safeTransferFrom(from, to, amount);
        uint256 received = paymentToken.balanceOf(to) - beforeBalance;
        if (received != amount) revert InexactTokenTransfer(amount, received);
    }

    function _validateDependencyCode() internal view {
        _requireCode("config", address(config));
        _requireCode("emergencyController", address(emergencyController));
        _requireCode("exposureGuard", address(exposureGuard));
        _requireCode("bondEscrow", address(bondEscrow));
        _requireCode("feeVault", address(feeVault));
        _requireCode("fullMarketDeployer", address(fullMarketDeployer));
        _requireCode("cloneImplementation", cloneImplementation);
        _requireCode("paymentToken", address(paymentToken));
        if (permit2 != address(0)) _requireCode("permit2", permit2);
        _requireCode("marketplace", marketplace);
    }

    function _validateDependencyWiring() internal view {
        _requireWiring("config.governance", governance, config.governance());
        _requireWiring("config.paymentToken", address(paymentToken), config.paymentToken());
        _requireWiring("emergency.governance", governance, emergencyController.governance());
        _requireWiring("guard.governance", governance, exposureGuard.governance());
        _requireWiring("guard.factory", address(this), exposureGuard.factory());
        _requireWiring("bond.governance", governance, bondEscrow.governance());
        _requireWiring("bond.paymentToken", address(paymentToken), bondEscrow.paymentToken());
        _requireWiring("bond.factory", address(this), bondEscrow.factory());
        _requireWiring("fee.governance", governance, feeVault.governance());
        _requireWiring("fee.paymentToken", address(paymentToken), feeVault.paymentToken());
        _requireWiring("fee.factory", address(this), feeVault.factory());
        _requireWiring("deployer.governance", governance, fullMarketDeployer.governance());
        _requireWiring("deployer.factory", address(this), fullMarketDeployer.factory());

        // The standalone Clone implementation is constructor-locked and must remain pristine.
        _requireWiring("clone.factory", address(0), IMarketVaultV1(cloneImplementation).factory());
        _requireWiring(
            "clone.paymentToken", address(0), IMarketVaultV1(cloneImplementation).paymentToken()
        );
        _requireWiring("clone.creator", address(0), IMarketVaultV1(cloneImplementation).creator());

        IFixedPriceMarketplaceV1 market = IFixedPriceMarketplaceV1(marketplace);
        _requireWiring("marketplace.factory", address(this), market.factory());
        _requireWiring(
            "marketplace.emergency", address(emergencyController), market.emergencyController()
        );
        _requireWiring("marketplace.feeVault", address(feeVault), market.feeVault());
        _requireWiring("marketplace.paymentToken", address(paymentToken), market.paymentToken());
        _requireWiring("marketplace.permit2", permit2, market.permit2());
        if (!feeVault.authorizedAccruer(address(this))) {
            revert InvalidConfiguration("feeVault.factoryAccruer");
        }
        if (!feeVault.authorizedAccruer(marketplace)) {
            revert InvalidConfiguration("feeVault.marketplaceAccruer");
        }
    }

    function _requireCode(bytes32 dependency, address target) internal view {
        if (target == address(0) || target.code.length == 0) {
            revert DependencyCodeMissing(dependency, target);
        }
    }

    function _requireWiring(bytes32 dependency, address expected, address actual) internal pure {
        if (actual != expected) revert DependencyWiringMismatch(dependency, expected, actual);
    }

    function _codeIdentity(address target) internal view returns (bytes32) {
        return keccak256(abi.encode(target, target.codehash));
    }
}
