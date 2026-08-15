// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { ProtocolTestBase } from "../helpers/ProtocolTestBase.sol";
import { MarketFactoryV1 } from "../../src/core/MarketFactoryV1.sol";
import { EmergencyControllerV1 } from "../../src/core/EmergencyControllerV1.sol";
import { LaunchExposureGuardV1 } from "../../src/core/LaunchExposureGuardV1.sol";
import { FeeVaultV1 } from "../../src/core/FeeVaultV1.sol";
import { BondEscrowV1 } from "../../src/core/BondEscrowV1.sol";
import { FullMarketDeployerV1 } from "../../src/core/FullMarketDeployerV1.sol";
import { CloneMarketVaultV1 } from "../../src/market/CloneMarketVaultV1.sol";
import { MarketVaultCoreV1 } from "../../src/market/MarketVaultCoreV1.sol";
import { FixedPriceMarketplaceV1 } from "../../src/marketplace/FixedPriceMarketplaceV1.sol";
import { IFullMarketDeployerV1 } from "../../src/interfaces/IFullMarketDeployerV1.sol";
import { ProtocolTypes } from "../../src/libraries/ProtocolTypes.sol";
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
    FactoryNotActive,
    DependencyCodeMissing,
    DependencyFingerprintMismatch,
    DependencyWiringMismatch
} from "../../src/libraries/ProtocolErrors.sol";

contract DuplicateMarketRuntime {
    uint256 public initializationCount;

    function initialize(ProtocolTypes.MarketInitParams calldata) external {
        ++initializationCount;
    }
}

contract DuplicateMarketDeployer is IFullMarketDeployerV1 {
    address public immutable governance;
    address public factory;
    address public immutable market;

    constructor(address governance_, address market_) {
        governance = governance_;
        market = market_;
    }

    function setFactory(address factory_) external {
        if (msg.sender != governance) revert Unauthorized(msg.sender);
        if (factory != address(0)) revert AlreadyConfigured();
        factory = factory_;
    }

    function deploy(bytes32) external view returns (address) {
        if (msg.sender != factory) revert Unauthorized(msg.sender);
        return market;
    }
}

contract FactoryValidationTest is ProtocolTestBase {
    function testClonePredictionCreationFeeBondAndEconomicSnapshot() public {
        config.setCreationFee(2e6);
        config.setProtocolShareBps(2500);
        ProtocolTypes.CreateMarketParams memory params =
            _defaultParams(ProtocolTypes.DeploymentMode.CLONE);
        params.creatorRakeBps = 900;
        params.creatorC2CFeeBps = 100;
        bytes32 userSalt = keccak256("predicted-clone");
        address predicted = factory.predictCloneAddress(
            CREATOR, 0, userSalt, params.rulesHash, params.closeAt, params.marketPrimaryCap
        );

        uint256 creatorBefore = usdc.balanceOf(CREATOR);
        MarketVaultCoreV1 market = _create(params, userSalt);
        assertEq(address(market), predicted);
        assertEq(factory.creatorNonce(CREATOR), 1);
        assertTrue(factory.isMarket(address(market)));
        assertEq(
            uint8(factory.deploymentModeOf(address(market))),
            uint8(ProtocolTypes.DeploymentMode.CLONE)
        );
        assertEq(usdc.balanceOf(CREATOR), creatorBefore - 12e6);
        assertEq(feeVault.creditOf(PROTOCOL_TREASURY), 2e6);
        (address bondCreator, uint128 bondAmount, bool settled) = bondEscrow.bondOf(address(market));
        assertEq(bondCreator, CREATOR);
        assertEq(bondAmount, 10e6);
        assertFalse(settled);
        ProtocolTypes.EconomicSnapshot memory economics = market.economics();
        assertEq(economics.creatorRakeBps, 900);
        assertEq(economics.protocolShareBps, 2500);
        assertEq(economics.creatorC2CFeeBps, 100);
    }

    function testFactoryDeprecationPauseAndMarketplaceControls() public {
        assertTrue(factory.active());
        assertEq(factory.activationFingerprint(), factory.dependencyFingerprint());
        bytes32 activeFingerprint = factory.dependencyFingerprint();
        vm.expectRevert(AlreadyConfigured.selector);
        factory.activate(activeFingerprint);

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, ALICE));
        factory.setDeprecated(true);
        factory.setDeprecated(true);
        assertTrue(factory.deprecated());
        vm.prank(CREATOR);
        vm.expectPartialRevert(InvalidConfiguration.selector);
        factory.createMarket(
            _defaultParams(ProtocolTypes.DeploymentMode.FULL), keccak256("deprecated")
        );
        factory.setDeprecated(false);

        vm.prank(EMERGENCY_SAFE);
        emergency.pause(ProtocolTypes.PAUSE_MARKET_CREATION, 1 hours);
        vm.prank(CREATOR);
        vm.expectRevert(
            abi.encodeWithSelector(PauseActive.selector, ProtocolTypes.PAUSE_MARKET_CREATION)
        );
        factory.createMarket(_defaultParams(ProtocolTypes.DeploymentMode.FULL), keccak256("paused"));

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, ALICE));
        factory.setMarketplace(ALICE);
        vm.expectRevert(ZeroAddress.selector);
        factory.setMarketplace(address(0));
        vm.expectRevert(AlreadyConfigured.selector);
        factory.setMarketplace(ALICE);
    }

    function testRequiredBondUsesMinimumAndCeiling() public view {
        assertEq(factory.requiredBond(1), 10e6);
        assertEq(factory.requiredBond(500_000_000), 10e6);
        assertEq(factory.requiredBond(500_000_001), 10_000_001);
        assertEq(factory.requiredBond(5000e6), 100e6);
    }

    function testFactoryRejectsCoreIdentityAndUriValidationFailures() public {
        ProtocolTypes.CreateMarketParams memory params =
            _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.rulesHash = bytes32(0);
        _expectCreateRevert(params, InvalidConfiguration.selector, "rules-zero");

        params = _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.creatorTreasury = address(0);
        _expectCreateRevert(params, ZeroAddress.selector, "treasury-zero");

        params = _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.metadataURI = string(new bytes(513));
        _expectCreateRevert(params, UriTooLong.selector, "metadata-long");

        params = _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.resolutionSourceURI = string(new bytes(513));
        _expectCreateRevert(params, UriTooLong.selector, "source-long");

        params = _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.outcomeCount = 1;
        _expectCreateRevert(params, ValueOutOfRange.selector, "outcome-low");

        params = _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.outcomeCount = 33;
        _expectCreateRevert(params, ValueOutOfRange.selector, "outcome-high");

        params = _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.featureFlags = 1 << 200;
        _expectCreateRevert(params, UnsupportedFeatureFlags.selector, "feature-unsupported");

        params = _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.featureFlags = ProtocolTypes.FEATURE_PERMIT2;
        _expectCreateRevert(params, InvalidConfiguration.selector, "permit2-unconfigured");
    }

    function testFactoryRejectsAllMarketTimeFailures() public {
        ProtocolTypes.CreateMarketParams memory params =
            _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.closeAt = uint64(block.timestamp + 5 minutes - 1);
        _expectCreateRevert(params, InvalidConfiguration.selector, "close-too-soon");

        params = _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.closeAt = uint64(block.timestamp + 90 days + 1);
        _expectCreateRevert(params, InvalidConfiguration.selector, "close-too-far");

        params = _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        vm.warp(block.timestamp + 1);
        _expectCreateRevert(params, InvalidConfiguration.selector, "early-before-create");

        params = _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.earlyBirdStart = params.closeAt;
        _expectCreateRevert(params, InvalidConfiguration.selector, "early-at-close");
    }

    function testFactoryRejectsModeMarketAndUserCapFailures() public {
        ProtocolTypes.CreateMarketParams memory params =
            _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.marketPrimaryCap = 0;
        _expectCreateRevert(params, ValueOutOfRange.selector, "market-cap-zero");

        params = _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.marketPrimaryCap = 5000e6 + 1;
        _expectCreateRevert(params, ValueOutOfRange.selector, "full-cap-high");

        params = _defaultParams(ProtocolTypes.DeploymentMode.CLONE);
        params.marketPrimaryCap = 500e6 + 1;
        _expectCreateRevert(params, ValueOutOfRange.selector, "clone-cap-high");

        params = _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.perUserPrimaryCap = 0;
        _expectCreateRevert(params, ValueOutOfRange.selector, "user-cap-zero");

        params = _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.marketPrimaryCap = 101e6;
        params.perUserPrimaryCap = 100e6 + 1;
        _expectCreateRevert(params, ValueOutOfRange.selector, "user-cap-limit");

        params = _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.marketPrimaryCap = 50e6;
        params.perUserPrimaryCap = 50e6 + 1;
        _expectCreateRevert(params, ValueOutOfRange.selector, "user-over-market");
    }

    function testFactoryRejectsMinimumUnitAndBondFailures() public {
        ProtocolTypes.CreateMarketParams memory params =
            _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.minimumPrimaryUnits = 9999;
        _expectCreateRevert(params, ValueOutOfRange.selector, "primary-min-low");

        params = _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.minimumPrimaryUnits = 5e6 + 1;
        _expectCreateRevert(params, ValueOutOfRange.selector, "primary-min-high");

        params = _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.marketPrimaryCap = 10_000;
        params.perUserPrimaryCap = 10_000;
        params.minimumPrimaryUnits = 10_001;
        _expectCreateRevert(params, ValueOutOfRange.selector, "primary-min-over-cap");

        params = _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.minimumC2CUnits = 9999;
        _expectCreateRevert(params, ValueOutOfRange.selector, "c2c-min-low");

        params = _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.minimumC2CUnits = 5e6 + 1;
        _expectCreateRevert(params, ValueOutOfRange.selector, "c2c-min-high");

        params = _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.creatorBond = 10e6 - 1;
        _expectCreateRevert(params, ValueOutOfRange.selector, "bond-low");

        params = _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.creatorBond = 1000e6 + 1;
        _expectCreateRevert(params, ValueOutOfRange.selector, "bond-high");

        params = _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.creatorRakeBps = 1001;
        _expectCreateRevert(params, ValueOutOfRange.selector, "rake-high");

        params = _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.creatorC2CFeeBps = 201;
        _expectCreateRevert(params, ValueOutOfRange.selector, "creator-c2c-high");
    }

    function testFactoryConstructorRejectsRequiredZeroDependencies() public {
        vm.expectRevert(ZeroAddress.selector);
        new MarketFactoryV1(
            address(0),
            address(config),
            address(emergency),
            address(guard),
            address(bondEscrow),
            address(feeVault),
            address(fullDeployer),
            address(cloneImplementation),
            address(0)
        );
        vm.expectRevert(ZeroAddress.selector);
        new MarketFactoryV1(
            address(this),
            address(config),
            address(emergency),
            address(guard),
            address(bondEscrow),
            address(feeVault),
            address(fullDeployer),
            address(0),
            address(0)
        );
    }

    function testFactoryRejectsDeployerReturningAnAlreadyRegisteredMarketAtomically() public {
        DuplicateMarketRuntime duplicateMarket = new DuplicateMarketRuntime();
        DuplicateMarketDeployer duplicateDeployer =
            new DuplicateMarketDeployer(address(this), address(duplicateMarket));
        LaunchExposureGuardV1 localGuard = new LaunchExposureGuardV1(address(this), 50_000e6);
        FeeVaultV1 localFeeVault = new FeeVaultV1(address(this), address(usdc));
        BondEscrowV1 localBondEscrow = new BondEscrowV1(address(this), address(usdc));
        CloneMarketVaultV1 localClone = new CloneMarketVaultV1();
        MarketFactoryV1 localFactory = new MarketFactoryV1(
            address(this),
            address(config),
            address(emergency),
            address(localGuard),
            address(localBondEscrow),
            address(localFeeVault),
            address(duplicateDeployer),
            address(localClone),
            address(0)
        );
        localGuard.setFactory(address(localFactory));
        localFeeVault.setFactory(address(localFactory));
        localBondEscrow.setFactory(address(localFactory));
        duplicateDeployer.setFactory(address(localFactory));
        FixedPriceMarketplaceV1 localMarketplace = new FixedPriceMarketplaceV1(
            address(localFactory),
            address(emergency),
            address(localFeeVault),
            address(usdc),
            address(0)
        );
        localFactory.setMarketplace(address(localMarketplace));
        localFactory.activate(localFactory.dependencyFingerprint());
        vm.prank(CREATOR);
        usdc.approve(address(localFactory), type(uint256).max);

        ProtocolTypes.CreateMarketParams memory params =
            _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        vm.prank(CREATOR);
        address first = localFactory.createMarket(params, keccak256("first-duplicate"));
        assertEq(first, address(duplicateMarket));
        assertEq(duplicateMarket.initializationCount(), 1);
        assertEq(localFactory.creatorNonce(CREATOR), 1);

        uint256 creatorBalance = usdc.balanceOf(CREATOR);
        vm.expectRevert(
            abi.encodeWithSelector(MarketAlreadyRegistered.selector, address(duplicateMarket))
        );
        vm.prank(CREATOR);
        localFactory.createMarket(params, keccak256("second-duplicate"));

        assertEq(duplicateMarket.initializationCount(), 1);
        assertEq(localFactory.creatorNonce(CREATOR), 1);
        assertEq(usdc.balanceOf(CREATOR), creatorBalance);
        assertEq(usdc.balanceOf(address(localBondEscrow)), 10e6);
        assertEq(localBondEscrow.totalLocked(), 10e6);
    }

    function testFactoryFailsClosedBeforeActivationAndOnFingerprintMismatch() public {
        (
            MarketFactoryV1 localFactory,
            LaunchExposureGuardV1 localGuard,
            FeeVaultV1 localFeeVault,
            BondEscrowV1 localBondEscrow,
            FullMarketDeployerV1 localDeployer
        ) = _newFactory(address(emergency), address(0));

        vm.prank(CREATOR);
        vm.expectRevert(FactoryNotActive.selector);
        localFactory.createMarket(
            _defaultParams(ProtocolTypes.DeploymentMode.FULL), keccak256("inactive")
        );

        localGuard.setFactory(address(localFactory));
        localFeeVault.setFactory(address(localFactory));
        localBondEscrow.setFactory(address(localFactory));
        localDeployer.setFactory(address(localFactory));
        FixedPriceMarketplaceV1 localMarketplace = new FixedPriceMarketplaceV1(
            address(localFactory),
            address(emergency),
            address(localFeeVault),
            address(usdc),
            address(0)
        );
        localFactory.setMarketplace(address(localMarketplace));
        bytes32 actual = localFactory.dependencyFingerprint();
        vm.expectRevert(
            abi.encodeWithSelector(
                DependencyFingerprintMismatch.selector, bytes32(uint256(1)), actual
            )
        );
        localFactory.activate(bytes32(uint256(1)));
        assertFalse(localFactory.active());
        localFactory.activate(actual);
        assertTrue(localFactory.active());
    }

    function testFactoryActivationRejectsMissingMarketplaceCodeAndWrongWiring() public {
        (
            MarketFactoryV1 missingCodeFactory,
            LaunchExposureGuardV1 missingCodeGuard,
            FeeVaultV1 missingCodeFeeVault,
            BondEscrowV1 missingCodeBondEscrow,
            FullMarketDeployerV1 missingCodeDeployer
        ) = _newFactory(address(emergency), address(0));
        missingCodeGuard.setFactory(address(missingCodeFactory));
        missingCodeFeeVault.setFactory(address(missingCodeFactory));
        missingCodeBondEscrow.setFactory(address(missingCodeFactory));
        missingCodeDeployer.setFactory(address(missingCodeFactory));
        missingCodeFactory.setMarketplace(ALICE);
        bytes32 missingCodeFingerprint = missingCodeFactory.dependencyFingerprint();
        vm.expectRevert(
            abi.encodeWithSelector(DependencyCodeMissing.selector, bytes32("marketplace"), ALICE)
        );
        missingCodeFactory.activate(missingCodeFingerprint);

        EmergencyControllerV1 wrongEmergency =
            new EmergencyControllerV1(address(this), EMERGENCY_SAFE);
        (
            MarketFactoryV1 wrongWiringFactory,
            LaunchExposureGuardV1 wrongWiringGuard,
            FeeVaultV1 wrongWiringFeeVault,
            BondEscrowV1 wrongWiringBondEscrow,
            FullMarketDeployerV1 wrongWiringDeployer
        ) = _newFactory(address(emergency), address(0));
        wrongWiringGuard.setFactory(address(wrongWiringFactory));
        wrongWiringFeeVault.setFactory(address(wrongWiringFactory));
        wrongWiringBondEscrow.setFactory(address(wrongWiringFactory));
        wrongWiringDeployer.setFactory(address(wrongWiringFactory));
        FixedPriceMarketplaceV1 wrongMarketplace = new FixedPriceMarketplaceV1(
            address(wrongWiringFactory),
            address(wrongEmergency),
            address(wrongWiringFeeVault),
            address(usdc),
            address(0)
        );
        wrongWiringFactory.setMarketplace(address(wrongMarketplace));
        bytes32 wrongWiringFingerprint = wrongWiringFactory.dependencyFingerprint();
        vm.expectRevert(
            abi.encodeWithSelector(
                DependencyWiringMismatch.selector,
                bytes32("marketplace.emergency"),
                address(emergency),
                address(wrongEmergency)
            )
        );
        wrongWiringFactory.activate(wrongWiringFingerprint);
    }

    function testFactoryActivationRejectsMissingFeeAccruerAuthorizations() public {
        (
            MarketFactoryV1 localFactory,
            LaunchExposureGuardV1 localGuard,
            FeeVaultV1 localFeeVault,
            BondEscrowV1 localBondEscrow,
            FullMarketDeployerV1 localDeployer
        ) = _newFactory(address(emergency), address(0));
        localGuard.setFactory(address(localFactory));
        localFeeVault.setFactory(address(localFactory));
        localBondEscrow.setFactory(address(localFactory));
        localDeployer.setFactory(address(localFactory));
        FixedPriceMarketplaceV1 localMarketplace = new FixedPriceMarketplaceV1(
            address(localFactory),
            address(emergency),
            address(localFeeVault),
            address(usdc),
            address(0)
        );
        localFactory.setMarketplace(address(localMarketplace));
        bytes32 fingerprint = localFactory.dependencyFingerprint();

        _setAccruerAuthorization(localFeeVault, address(localFactory), false);
        vm.expectRevert(
            abi.encodeWithSelector(
                InvalidConfiguration.selector, bytes32("feeVault.factoryAccruer")
            )
        );
        localFactory.activate(fingerprint);

        _setAccruerAuthorization(localFeeVault, address(localFactory), true);
        _setAccruerAuthorization(localFeeVault, address(localMarketplace), false);
        vm.expectRevert(
            abi.encodeWithSelector(
                InvalidConfiguration.selector, bytes32("feeVault.marketplaceAccruer")
            )
        );
        localFactory.activate(fingerprint);
    }

    function _setAccruerAuthorization(FeeVaultV1 vault, address account, bool authorized) internal {
        bytes32 mappingSlot = keccak256(abi.encode(account, uint256(2)));
        vm.store(address(vault), mappingSlot, bytes32(uint256(authorized ? 1 : 0)));
        assertEq(vault.authorizedAccruer(account), authorized);
    }

    function _newFactory(address emergency_, address permit2_)
        internal
        returns (
            MarketFactoryV1 localFactory,
            LaunchExposureGuardV1 localGuard,
            FeeVaultV1 localFeeVault,
            BondEscrowV1 localBondEscrow,
            FullMarketDeployerV1 localDeployer
        )
    {
        localGuard = new LaunchExposureGuardV1(address(this), 50_000e6);
        localFeeVault = new FeeVaultV1(address(this), address(usdc));
        localBondEscrow = new BondEscrowV1(address(this), address(usdc));
        localDeployer = new FullMarketDeployerV1(address(this));
        localFactory = new MarketFactoryV1(
            address(this),
            address(config),
            emergency_,
            address(localGuard),
            address(localBondEscrow),
            address(localFeeVault),
            address(localDeployer),
            address(new CloneMarketVaultV1()),
            permit2_
        );
    }

    function _expectCreateRevert(
        ProtocolTypes.CreateMarketParams memory params,
        bytes4 selector,
        string memory saltLabel
    ) internal {
        vm.prank(CREATOR);
        vm.expectPartialRevert(selector);
        factory.createMarket(params, keccak256(bytes(saltLabel)));
    }
}
