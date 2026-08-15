// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";
import { ProtocolConfigV1 } from "../../src/core/ProtocolConfigV1.sol";
import { EmergencyControllerV1 } from "../../src/core/EmergencyControllerV1.sol";
import { LaunchExposureGuardV1 } from "../../src/core/LaunchExposureGuardV1.sol";
import { FeeVaultV1 } from "../../src/core/FeeVaultV1.sol";
import { BondEscrowV1 } from "../../src/core/BondEscrowV1.sol";
import { FullMarketDeployerV1 } from "../../src/core/FullMarketDeployerV1.sol";
import { MarketFactoryV1 } from "../../src/core/MarketFactoryV1.sol";
import { CloneMarketVaultV1 } from "../../src/market/CloneMarketVaultV1.sol";
import { MarketVaultCoreV1 } from "../../src/market/MarketVaultCoreV1.sol";
import { FixedPriceMarketplaceV1 } from "../../src/marketplace/FixedPriceMarketplaceV1.sol";
import { ProtocolTypes } from "../../src/libraries/ProtocolTypes.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";

abstract contract ProtocolTestBase is Test {
    MockUSDC internal usdc;
    ProtocolConfigV1 internal config;
    EmergencyControllerV1 internal emergency;
    LaunchExposureGuardV1 internal guard;
    FeeVaultV1 internal feeVault;
    BondEscrowV1 internal bondEscrow;
    CloneMarketVaultV1 internal cloneImplementation;
    FullMarketDeployerV1 internal fullDeployer;
    MarketFactoryV1 internal factory;
    FixedPriceMarketplaceV1 internal marketplace;

    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant CREATOR_TREASURY = address(0xCAFE);
    address internal constant PROTOCOL_TREASURY = address(0xFEE);
    address internal constant EMERGENCY_SAFE = address(0xE911);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant CAROL = address(0xCA401);

    function setUp() public virtual {
        usdc = new MockUSDC();
        config = new ProtocolConfigV1(address(this), address(usdc), PROTOCOL_TREASURY);
        emergency = new EmergencyControllerV1(address(this), EMERGENCY_SAFE);
        guard = new LaunchExposureGuardV1(address(this), 50_000e6);
        feeVault = new FeeVaultV1(address(this), address(usdc));
        bondEscrow = new BondEscrowV1(address(this), address(usdc));
        cloneImplementation = new CloneMarketVaultV1();
        fullDeployer = new FullMarketDeployerV1(address(this));
        factory = new MarketFactoryV1(
            address(this),
            address(config),
            address(emergency),
            address(guard),
            address(bondEscrow),
            address(feeVault),
            address(fullDeployer),
            address(cloneImplementation),
            address(0)
        );
        guard.setFactory(address(factory));
        feeVault.setFactory(address(factory));
        bondEscrow.setFactory(address(factory));
        fullDeployer.setFactory(address(factory));
        marketplace = new FixedPriceMarketplaceV1(
            address(factory), address(emergency), address(feeVault), address(usdc), address(0)
        );
        factory.setMarketplace(address(marketplace));
        factory.activate(factory.dependencyFingerprint());

        address[4] memory funded = [CREATOR, ALICE, BOB, CAROL];
        for (uint256 i; i < funded.length; ++i) {
            usdc.mint(funded[i], 20_000e6);
        }
        vm.prank(CREATOR);
        usdc.approve(address(factory), type(uint256).max);
        vm.prank(ALICE);
        usdc.approve(address(marketplace), type(uint256).max);
        vm.prank(BOB);
        usdc.approve(address(marketplace), type(uint256).max);
        vm.prank(CAROL);
        usdc.approve(address(marketplace), type(uint256).max);
    }

    function _defaultParams(ProtocolTypes.DeploymentMode mode)
        internal
        view
        returns (ProtocolTypes.CreateMarketParams memory params)
    {
        params = ProtocolTypes.CreateMarketParams({
            rulesHash: keccak256("rules"),
            metadataURI: "ipfs://market/{id}.json",
            resolutionSourceHash: keccak256("source"),
            resolutionSourceURI: "https://example.com/source",
            outcomeCount: 2,
            closeAt: uint64(block.timestamp + 1 days),
            earlyBirdStart: uint64(block.timestamp),
            creatorTreasury: CREATOR_TREASURY,
            deploymentMode: mode,
            featureFlags: ProtocolTypes.FEATURE_EARLY_BIRD,
            creatorRakeBps: 500,
            creatorC2CFeeBps: 0,
            perUserPrimaryCap: 100e6,
            marketPrimaryCap: 100e6,
            minimumPrimaryUnits: 10_000,
            minimumC2CUnits: 10_000,
            creatorBond: 10e6
        });
    }

    function _create(ProtocolTypes.CreateMarketParams memory params, bytes32 salt)
        internal
        returns (MarketVaultCoreV1 market)
    {
        vm.prank(CREATOR);
        market = MarketVaultCoreV1(factory.createMarket(params, salt));
    }

    function _createDefault() internal returns (MarketVaultCoreV1 market) {
        return _create(_defaultParams(ProtocolTypes.DeploymentMode.FULL), keccak256("default"));
    }

    function _approveMarket(address user, MarketVaultCoreV1 market) internal {
        vm.prank(user);
        usdc.approve(address(market), type(uint256).max);
    }

    function _buy(MarketVaultCoreV1 market, address buyer, uint256 outcomeId, uint256 amount)
        internal
    {
        _approveMarket(buyer, market);
        uint64 deadline = market.closeAt();
        vm.prank(buyer);
        market.buy(outcomeId, amount, amount, amount, deadline);
    }
}
