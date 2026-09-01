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
import { ExposureCapExceeded } from "../../src/libraries/ProtocolErrors.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";

contract ProtocolFlowsTest is Test {
    uint256 internal syntheticExposure;
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

    function setUp() public {
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
            1 days,
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

        usdc.mint(CREATOR, 10_000e6);
        usdc.mint(ALICE, 10_000e6);
        usdc.mint(BOB, 10_000e6);
        vm.prank(CREATOR);
        usdc.approve(address(factory), type(uint256).max);
        vm.prank(ALICE);
        usdc.approve(address(marketplace), type(uint256).max);
        vm.prank(BOB);
        usdc.approve(address(marketplace), type(uint256).max);
    }

    function testResolvedPayoutsEarlyBirdFeesAndBondConserveValue() public {
        MarketVaultCoreV1 market = _create(ProtocolTypes.DeploymentMode.FULL, 100e6, 0);
        _approveMarket(ALICE, market);
        _approveMarket(BOB, market);

        vm.prank(ALICE);
        market.buy(0, 60e6, 60e6, 60e6, uint64(block.timestamp + 1 hours));
        vm.prank(BOB);
        market.buy(1, 40e6, 40e6, 40e6, uint64(block.timestamp + 1 hours));
        assertEq(market.totalPrincipal(), 100e6);
        assertEq(market.earlyBirdScore(ALICE), 180e6);
        assertEq(market.earlyBirdScore(BOB), 120e6);

        vm.warp(market.closeAt());
        vm.prank(CREATOR);
        market.resolve(0, bytes32(0));

        (
            uint256 principal,
            uint256 rake,
            uint256 protocolFee,
            uint256 earlyPool,
            uint256 creatorFee,
            uint256 winnerPool
        ) = market.payoutBreakdown();
        assertEq(principal, 100e6);
        assertEq(rake, 5e6);
        assertEq(protocolFee, 0);
        assertEq(earlyPool, 1e6);
        assertEq(creatorFee, 4e6);
        assertEq(winnerPool, 95e6);

        uint256 aliceBefore = usdc.balanceOf(ALICE);
        market.claimWinningsFor(ALICE);
        market.claimEarlyBirdFor(ALICE);
        market.claimEarlyBirdFor(BOB);
        assertEq(usdc.balanceOf(ALICE) - aliceBefore, 95_600_000);
        assertEq(feeVault.creditOf(CREATOR_TREASURY), 4e6);
        assertEq(usdc.balanceOf(address(market)), 0);

        bondEscrow.settleBond(address(market));
        assertEq(bondEscrow.creditOf(CREATOR), 10e6);
        bondEscrow.claimFor(CREATOR);
    }

    function testCreatorVoidRefundsCurrentHolders() public {
        MarketVaultCoreV1 market = _create(ProtocolTypes.DeploymentMode.FULL, 100e6, 0);
        _approveMarket(ALICE, market);
        vm.prank(ALICE);
        market.buy(0, 20e6, 20e6, 20e6, uint64(block.timestamp + 1 hours));
        vm.prank(ALICE);
        market.safeTransferFrom(ALICE, BOB, 0, 7e6, "");

        vm.prank(CREATOR);
        market.creatorVoid(bytes32(0));
        uint256 aliceBefore = usdc.balanceOf(ALICE);
        uint256 bobBefore = usdc.balanceOf(BOB);
        market.refundFor(ALICE);
        market.refundFor(BOB);
        assertEq(usdc.balanceOf(ALICE) - aliceBefore, 13e6);
        assertEq(usdc.balanceOf(BOB) - bobBefore, 7e6);
        assertEq(market.remainingRefundPrincipal(), 0);
    }

    function testTimeoutPrincipalDoesNotDependOnBondAndBonusArrivesLater() public {
        MarketVaultCoreV1 market = _create(ProtocolTypes.DeploymentMode.CLONE, 100e6, 0);
        _approveMarket(ALICE, market);
        vm.prank(ALICE);
        market.buy(1, 20e6, 20e6, 20e6, uint64(block.timestamp + 1 hours));

        vm.warp(market.resolutionDeadline());
        market.voidAfterDeadline();
        uint256 beforeRefund = usdc.balanceOf(ALICE);
        market.refundFor(ALICE);
        assertEq(usdc.balanceOf(ALICE) - beforeRefund, 20e6);
        assertEq(market.timeoutBonusUnits(ALICE), 20e6);
        assertFalse(market.timeoutBonusFunded());

        bondEscrow.settleBond(address(market));
        assertTrue(market.timeoutBonusFunded());
        assertEq(guard.reportedExposure(address(market)), 10e6);
        uint256 beforeBonus = usdc.balanceOf(ALICE);
        market.claimTimeoutBonusFor(ALICE);
        assertEq(usdc.balanceOf(ALICE) - beforeBonus, 10e6);
        assertEq(market.remainingTimeoutBonusPool(), 0);
        guard.sync(address(market));
        assertEq(guard.reportedExposure(address(market)), 0);
    }

    function testEmptyTimeoutCreditsBondBackToCreatorWithoutFundingUnclaimableBonus() public {
        MarketVaultCoreV1 market = _create(ProtocolTypes.DeploymentMode.FULL, 100e6, 0);
        vm.warp(market.resolutionDeadline());
        market.voidAfterDeadline();

        bondEscrow.settleBond(address(market));

        assertEq(bondEscrow.creditOf(CREATOR), 10e6);
        assertFalse(market.timeoutBonusFunded());
        assertEq(market.remainingTimeoutBonusPool(), 0);
        assertEq(usdc.balanceOf(address(market)), 0);
    }

    function testMarketplacePartialFillCancelAndFeeAccounting() public {
        config.setPlatformC2CFeeBps(100);
        MarketVaultCoreV1 market = _create(ProtocolTypes.DeploymentMode.FULL, 100e6, 0);
        _approveMarket(ALICE, market);
        vm.prank(ALICE);
        market.buy(0, 20e6, 20e6, 20e6, uint64(block.timestamp + 1 hours));
        vm.prank(ALICE);
        market.setApprovalForAll(address(marketplace), true);

        vm.prank(ALICE);
        bytes32 listingId = marketplace.createListing(
            address(market), 0, 10e6, 900_000, uint64(block.timestamp + 1 days)
        );
        uint256 sellerBefore = usdc.balanceOf(ALICE);
        vm.prank(BOB);
        (uint256 units, uint256 gross) =
            marketplace.fillListing(listingId, 4e6, 4e6, 4e6, uint64(block.timestamp + 1 hours));
        assertEq(units, 4e6);
        assertEq(gross, 3_600_000);
        assertEq(market.balanceOf(BOB, 0), 4e6);
        assertEq(usdc.balanceOf(ALICE) - sellerBefore, 3_564_000);
        assertEq(feeVault.creditOf(PROTOCOL_TREASURY), 36_000);

        vm.prank(ALICE);
        marketplace.cancelListing(listingId);
        assertEq(market.balanceOf(ALICE, 0), 16e6);
        (,, uint128 remaining,,,, bool active) = marketplace.listings(listingId);
        assertEq(remaining, 0);
        assertFalse(active);
    }

    function testTerminalEscrowMustReturnBeforeHolderRefund() public {
        MarketVaultCoreV1 market = _create(ProtocolTypes.DeploymentMode.FULL, 100e6, 0);
        _approveMarket(ALICE, market);
        vm.prank(ALICE);
        market.buy(0, 20e6, 20e6, 20e6, uint64(block.timestamp + 1 hours));
        vm.prank(ALICE);
        market.setApprovalForAll(address(marketplace), true);
        vm.prank(ALICE);
        bytes32 listingId = marketplace.createListing(
            address(market), 0, 10e6, 900_000, uint64(block.timestamp + 1 days)
        );

        vm.prank(CREATOR);
        market.creatorVoid(bytes32(0));
        vm.expectRevert();
        market.refundFor(address(marketplace));
        assertEq(market.balanceOf(address(marketplace), 0), 10e6);

        vm.prank(BOB);
        marketplace.returnTerminalListing(listingId);
        assertEq(market.balanceOf(address(marketplace), 0), 0);
        assertEq(market.balanceOf(ALICE, 0), 20e6);

        uint256 aliceBefore = usdc.balanceOf(ALICE);
        market.refundFor(ALICE);
        assertEq(usdc.balanceOf(ALICE) - aliceBefore, 20e6);
        assertEq(usdc.balanceOf(address(marketplace)), 0);
    }

    function testResolvedEscrowMustReturnBeforeWinnerClaim() public {
        MarketVaultCoreV1 market = _create(ProtocolTypes.DeploymentMode.FULL, 100e6, 0);
        _approveMarket(ALICE, market);
        vm.prank(ALICE);
        market.buy(0, 20e6, 20e6, 20e6, uint64(block.timestamp + 1 hours));
        vm.prank(ALICE);
        market.setApprovalForAll(address(marketplace), true);
        vm.prank(ALICE);
        bytes32 listingId = marketplace.createListing(
            address(market), 0, 10e6, 900_000, uint64(block.timestamp + 1 days)
        );

        vm.warp(market.closeAt());
        vm.prank(CREATOR);
        market.resolve(0, bytes32(0));
        vm.expectRevert();
        market.claimWinningsFor(address(marketplace));
        assertEq(market.balanceOf(address(marketplace), 0), 10e6);

        vm.prank(BOB);
        marketplace.returnTerminalListing(listingId);
        assertEq(market.balanceOf(address(marketplace), 0), 0);
        assertEq(market.balanceOf(ALICE, 0), 20e6);

        uint256 aliceBefore = usdc.balanceOf(ALICE);
        market.claimWinningsFor(ALICE);
        assertEq(usdc.balanceOf(ALICE) - aliceBefore, 19e6);
        assertEq(usdc.balanceOf(address(marketplace)), 0);
    }

    function testEmergencyPauseStopsNewRiskButNotCancelOrRefund() public {
        MarketVaultCoreV1 market = _create(ProtocolTypes.DeploymentMode.FULL, 100e6, 0);
        _approveMarket(ALICE, market);
        vm.prank(ALICE);
        market.buy(0, 20e6, 20e6, 20e6, uint64(block.timestamp + 1 hours));
        vm.prank(ALICE);
        market.setApprovalForAll(address(marketplace), true);
        vm.prank(ALICE);
        bytes32 listingId = marketplace.createListing(
            address(market), 0, 10e6, 900_000, uint64(block.timestamp + 1 days)
        );

        vm.prank(EMERGENCY_SAFE);
        emergency.pause(
            ProtocolTypes.PAUSE_PRIMARY_BUY | ProtocolTypes.PAUSE_LISTING_CREATE
                | ProtocolTypes.PAUSE_LISTING_FILL,
            1 days
        );
        vm.prank(ALICE);
        vm.expectRevert();
        market.buy(0, 10e6, 10e6, 10e6, uint64(block.timestamp + 1 hours));
        vm.prank(ALICE);
        marketplace.cancelListing(listingId);

        vm.prank(CREATOR);
        market.creatorVoid(bytes32(0));
        market.refundFor(ALICE);
        assertEq(market.remainingRefundPrincipal(), 0);
    }

    function testFullAndCloneStateDifferential() public {
        MarketVaultCoreV1 full = _create(ProtocolTypes.DeploymentMode.FULL, 100e6, 0);
        MarketVaultCoreV1 clone = _create(ProtocolTypes.DeploymentMode.CLONE, 100e6, 0);
        _approveMarket(ALICE, full);
        _approveMarket(ALICE, clone);
        _approveMarket(BOB, full);
        _approveMarket(BOB, clone);

        _buyPair(full, clone, ALICE, 0, 33e6);
        _buyPair(full, clone, BOB, 1, 27e6);
        assertEq(full.totalPrincipal(), clone.totalPrincipal());
        assertEq(full.totalSupply(0), clone.totalSupply(0));
        assertEq(full.totalSupply(1), clone.totalSupply(1));
        assertEq(full.earlyBirdScore(ALICE), clone.earlyBirdScore(ALICE));

        vm.warp(full.closeAt());
        vm.prank(CREATOR);
        full.resolve(0, bytes32(0));
        vm.prank(CREATOR);
        clone.resolve(0, bytes32(0));
        assertEq(uint8(full.marketState()), uint8(clone.marketState()));
        assertEq(full.remainingWinnerPool(), clone.remainingWinnerPool());
        assertEq(full.remainingEarlyBirdPool(), clone.remainingEarlyBirdPool());

        full.claimWinningsFor(ALICE);
        clone.claimWinningsFor(ALICE);
        assertEq(full.remainingWinnerPool(), clone.remainingWinnerPool());
    }

    function testPrimaryPartialFillUsesCumulativePerUserCap() public {
        MarketVaultCoreV1 market = _create(ProtocolTypes.DeploymentMode.FULL, 150e6, 0);
        _approveMarket(ALICE, market);
        vm.prank(ALICE);
        uint256 filled = market.buy(0, 120e6, 90e6, 100e6, uint64(block.timestamp + 1 hours));
        assertEq(filled, 100e6);
        vm.prank(ALICE);
        vm.expectRevert();
        market.buy(0, 10e6, 1, 10e6, uint64(block.timestamp + 1 hours));
    }

    function testCloneImplementationCannotBeInitialized() public {
        ProtocolTypes.MarketInitParams memory empty;
        vm.expectRevert();
        cloneImplementation.initialize(empty);
    }

    function testGuardFailsClosedWithCustomErrorWhenSyncedExposureExceedsCap() public {
        LaunchExposureGuardV1 isolatedGuard = new LaunchExposureGuardV1(address(this), 20e6);
        isolatedGuard.setFactory(address(this));
        isolatedGuard.registerMarket(address(this));
        isolatedGuard.reserve(20e6);
        syntheticExposure = 25e6;
        isolatedGuard.sync(address(this));

        vm.expectRevert(abi.encodeWithSelector(ExposureCapExceeded.selector, 1, 0));
        isolatedGuard.reserve(1);
    }

    function guardExposure() external view returns (uint256) {
        return syntheticExposure;
    }

    function _create(ProtocolTypes.DeploymentMode mode, uint128 marketCap, uint16 creatorC2CFeeBps)
        internal
        returns (MarketVaultCoreV1 market)
    {
        ProtocolTypes.CreateMarketParams memory params = ProtocolTypes.CreateMarketParams({
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
            creatorC2CFeeBps: creatorC2CFeeBps,
            perUserPrimaryCap: 100e6,
            marketPrimaryCap: marketCap,
            minimumPrimaryUnits: 10_000,
            minimumC2CUnits: 10_000,
            creatorBond: 10e6
        });
        vm.prank(CREATOR);
        market = MarketVaultCoreV1(
            factory.createMarket(params, keccak256(abi.encode(mode, marketCap, block.number)))
        );
    }

    function _approveMarket(address user, MarketVaultCoreV1 market) internal {
        vm.prank(user);
        usdc.approve(address(market), type(uint256).max);
    }

    function _buyPair(
        MarketVaultCoreV1 full,
        MarketVaultCoreV1 clone,
        address buyer,
        uint256 outcome,
        uint256 amount
    ) internal {
        vm.prank(buyer);
        full.buy(outcome, amount, amount, amount, uint64(block.timestamp + 1 hours));
        vm.prank(buyer);
        clone.buy(outcome, amount, amount, amount, uint64(block.timestamp + 1 hours));
    }
}
