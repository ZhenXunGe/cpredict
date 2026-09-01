// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";
import { StdInvariant } from "forge-std/StdInvariant.sol";
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

contract MarketAccountingHandler is Test {
    MarketVaultCoreV1 public immutable market;
    LaunchExposureGuardV1 public immutable guard;
    MockUSDC public immutable usdc;
    address public immutable creator;
    address[] internal _actors;

    constructor(
        MarketVaultCoreV1 market_,
        LaunchExposureGuardV1 guard_,
        MockUSDC usdc_,
        address creator_,
        address[] memory actors_
    ) {
        market = market_;
        guard = guard_;
        usdc = usdc_;
        creator = creator_;
        _actors = actors_;
    }

    function buy(uint256 actorSeed, uint256 outcomeSeed, uint256 amountSeed) external {
        if (market.isTerminal() || block.timestamp >= market.closeAt()) return;
        address actor = _actors[actorSeed % _actors.length];
        uint256 marketAvailable = market.marketPrimaryCap() - market.totalPrincipal();
        uint256 userAvailable = market.perUserPrimaryCap() - market.cumulativePrimaryBought(actor);
        uint256 available = marketAvailable < userAvailable ? marketAvailable : userAvailable;
        if (available < market.minimumPrimaryUnits()) return;
        uint256 amount = bound(amountSeed, market.minimumPrimaryUnits(), available);
        uint256 outcome = outcomeSeed % market.outcomeCount();
        vm.prank(actor);
        market.buy(outcome, amount, amount, amount, uint64(block.timestamp + 1 hours));
    }

    function transfer(uint256 fromSeed, uint256 toSeed, uint256 outcomeSeed, uint256 amountSeed)
        external
    {
        address from = _actors[fromSeed % _actors.length];
        address to = _actors[toSeed % _actors.length];
        if (from == to) return;
        uint256 outcome = outcomeSeed % market.outcomeCount();
        uint256 balance = market.balanceOf(from, outcome);
        if (balance == 0) return;
        uint256 amount = bound(amountSeed, 1, balance);
        vm.prank(from);
        market.safeTransferFrom(from, to, outcome, amount, "");
    }

    function creatorVoid() external {
        if (market.isTerminal()) return;
        vm.prank(creator);
        market.creatorVoid(bytes32(0));
    }

    function refund(uint256 actorSeed) external {
        ProtocolTypes.MarketState state = market.marketState();
        if (
            state != ProtocolTypes.MarketState.VOIDED_CREATOR
                && state != ProtocolTypes.MarketState.VOIDED_TIMEOUT
        ) return;
        address actor = _actors[actorSeed % _actors.length];
        uint256 balance;
        for (uint256 outcome = 0; outcome < market.outcomeCount(); ++outcome) {
            balance += market.balanceOf(actor, outcome);
        }
        if (balance == 0) return;
        market.refundFor(actor);
    }

    function syncGuard() external {
        guard.sync(address(market));
    }
}

contract MarketAccountingInvariantTest is StdInvariant, Test {
    MockUSDC internal usdc;
    LaunchExposureGuardV1 internal guard;
    FeeVaultV1 internal feeVault;
    BondEscrowV1 internal bondEscrow;
    MarketVaultCoreV1 internal market;
    MarketAccountingHandler internal handler;

    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant CREATOR_TREASURY = address(0xCAFE);
    address internal constant PROTOCOL_TREASURY = address(0xFEE);

    function setUp() public {
        usdc = new MockUSDC();
        ProtocolConfigV1 config =
            new ProtocolConfigV1(address(this), address(usdc), PROTOCOL_TREASURY);
        EmergencyControllerV1 emergency = new EmergencyControllerV1(address(this), address(0xE911));
        guard = new LaunchExposureGuardV1(address(this), 50_000e6);
        feeVault = new FeeVaultV1(address(this), address(usdc));
        bondEscrow = new BondEscrowV1(address(this), address(usdc));
        CloneMarketVaultV1 cloneImplementation = new CloneMarketVaultV1();
        FullMarketDeployerV1 fullDeployer = new FullMarketDeployerV1(address(this));
        MarketFactoryV1 factory = new MarketFactoryV1(
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
        FixedPriceMarketplaceV1 marketplace = new FixedPriceMarketplaceV1(
            address(factory), address(emergency), address(feeVault), address(usdc), address(0)
        );
        factory.setMarketplace(address(marketplace));
        factory.activate(factory.dependencyFingerprint());

        usdc.mint(CREATOR, 100e6);
        vm.prank(CREATOR);
        usdc.approve(address(factory), type(uint256).max);
        ProtocolTypes.CreateMarketParams memory params = ProtocolTypes.CreateMarketParams({
            rulesHash: keccak256("invariant-rules"),
            metadataURI: "ipfs://invariant/{id}.json",
            resolutionSourceHash: bytes32(0),
            resolutionSourceURI: "",
            outcomeCount: 3,
            closeAt: uint64(block.timestamp + 30 days),
            earlyBirdStart: uint64(block.timestamp),
            creatorTreasury: CREATOR_TREASURY,
            deploymentMode: ProtocolTypes.DeploymentMode.FULL,
            featureFlags: ProtocolTypes.FEATURE_EARLY_BIRD,
            creatorRakeBps: 500,
            creatorC2CFeeBps: 0,
            perUserPrimaryCap: 100e6,
            marketPrimaryCap: 500e6,
            minimumPrimaryUnits: 10_000,
            minimumC2CUnits: 10_000,
            creatorBond: 10e6
        });
        vm.prank(CREATOR);
        market = MarketVaultCoreV1(factory.createMarket(params, bytes32("invariant")));

        address[] memory actors = new address[](4);
        actors[0] = address(0xA11CE);
        actors[1] = address(0xB0B);
        actors[2] = address(0xC01);
        actors[3] = address(0xD01);
        for (uint256 i = 0; i < actors.length; ++i) {
            usdc.mint(actors[i], 1000e6);
            vm.prank(actors[i]);
            usdc.approve(address(market), type(uint256).max);
        }
        handler = new MarketAccountingHandler(market, guard, usdc, CREATOR, actors);
        targetContract(address(handler));
    }

    function invariantVaultAssetsCoverAllLiveLiabilities() public view {
        uint256 liabilities;
        ProtocolTypes.MarketState state = market.marketState();
        if (state == ProtocolTypes.MarketState.OPEN) {
            liabilities = market.totalPrincipal();
        } else if (state == ProtocolTypes.MarketState.RESOLVED) {
            liabilities = market.remainingWinnerPool() + market.remainingEarlyBirdPool();
        } else {
            liabilities = market.remainingRefundPrincipal() + market.remainingTimeoutBonusPool();
        }
        assertGe(usdc.balanceOf(address(market)), liabilities);
    }

    function invariantSupplyAccountingIsInternallyConsistent() public view {
        uint256 summedSupply;
        for (uint256 outcome = 0; outcome < market.outcomeCount(); ++outcome) {
            summedSupply += market.totalSupply(outcome);
        }
        assertEq(summedSupply, market.totalSupply());
        assertLe(summedSupply, market.totalPrincipal());
    }

    function invariantGuardNeverUnderReportsMarketExposure() public view {
        uint256 actual = market.marketState() == ProtocolTypes.MarketState.OPEN
            ? market.totalPrincipal()
            : market.remainingRefundPrincipal();
        assertGe(guard.reportedExposure(address(market)), actual);
        assertGe(guard.totalReportedExposure(), guard.reportedExposure(address(market)));
    }

    function invariantSegregatedVaultsRemainSolvent() public view {
        assertGe(usdc.balanceOf(address(feeVault)), feeVault.totalCredits());
        assertGe(
            usdc.balanceOf(address(bondEscrow)),
            bondEscrow.totalLocked() + bondEscrow.totalCredits()
        );
    }
}
