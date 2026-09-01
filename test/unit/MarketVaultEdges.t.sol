// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { ProtocolTestBase } from "../helpers/ProtocolTestBase.sol";
import { ISignatureTransfer } from "permit2/interfaces/ISignatureTransfer.sol";
import { FullMarketVaultV1 } from "../../src/market/FullMarketVaultV1.sol";
import { MarketVaultCoreV1 } from "../../src/market/MarketVaultCoreV1.sol";
import { ProtocolTypes } from "../../src/libraries/ProtocolTypes.sol";
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
    WinningOutcomeHasNoSupply,
    NothingToClaim,
    AlreadySettled,
    AlreadyInitialized,
    InvalidInitializer,
    Insolvent,
    Permit2Disabled
} from "../../src/libraries/ProtocolErrors.sol";

contract MarketVaultInitializationTest is ProtocolTestBase {
    function testDirectFullVaultInitializationAndReadInterfaces() public {
        FullMarketVaultV1 fresh = new FullMarketVaultV1();
        ProtocolTypes.MarketInitParams memory init = _validInit();
        fresh.initialize(init);
        assertEq(fresh.factory(), address(this));
        assertEq(fresh.paymentToken(), address(usdc));
        assertEq(fresh.creator(), CREATOR);
        assertEq(fresh.outcomeCount(), 2);
        assertEq(fresh.resolutionWindow(), init.resolutionWindow);
        assertEq(fresh.uri(0), "ipfs://direct/{id}.json");
        ProtocolTypes.EconomicSnapshot memory economics = fresh.economics();
        assertEq(economics.creatorRakeBps, 500);
        assertTrue(fresh.earlyBirdEnabled());
        assertFalse(fresh.permit2Enabled());
        assertFalse(fresh.isTerminal());
        assertEq(fresh.resolutionDeadline(), init.closeAt + init.resolutionWindow);

        vm.expectRevert(AlreadyInitialized.selector);
        fresh.initialize(init);
    }

    function testInitializerRejectsCallerZeroDependenciesAndRanges() public {
        ProtocolTypes.MarketInitParams memory init = _validInit();
        init.factory = ALICE;
        FullMarketVaultV1 wrongCaller = new FullMarketVaultV1();
        vm.expectPartialRevert(InvalidInitializer.selector);
        wrongCaller.initialize(init);

        init = _validInit();
        init.paymentToken = address(0);
        _expectInitRevert(init, ZeroAddress.selector);
        init = _validInit();
        init.outcomeCount = 1;
        _expectInitRevert(init, InvalidConfiguration.selector);
        init = _validInit();
        init.outcomeCount = 33;
        _expectInitRevert(init, InvalidConfiguration.selector);
        init = _validInit();
        init.rulesHash = bytes32(0);
        _expectInitRevert(init, InvalidConfiguration.selector);
        init = _validInit();
        init.metadataURI = string(new bytes(513));
        _expectInitRevert(init, UriTooLong.selector);
        init = _validInit();
        init.resolutionSourceURI = string(new bytes(513));
        _expectInitRevert(init, UriTooLong.selector);
        init = _validInit();
        init.featureFlags = 1 << 200;
        _expectInitRevert(init, UnsupportedFeatureFlags.selector);
        init = _validInit();
        init.resolutionWindow = 15 minutes - 1;
        _expectInitRevert(init, InvalidConfiguration.selector);
        init = _validInit();
        init.resolutionWindow = 30 days + 1;
        _expectInitRevert(init, InvalidConfiguration.selector);
        init = _validInit();
        init.closeAt = init.createdAt + 5 minutes - 1;
        _expectInitRevert(init, InvalidConfiguration.selector);
        init = _validInit();
        init.closeAt = init.createdAt + 90 days + 1;
        _expectInitRevert(init, InvalidConfiguration.selector);
        init = _validInit();
        init.earlyBirdStart = init.createdAt - 1;
        _expectInitRevert(init, InvalidConfiguration.selector);
        init = _validInit();
        init.earlyBirdStart = init.closeAt;
        _expectInitRevert(init, InvalidConfiguration.selector);
    }

    function _validInit() internal view returns (ProtocolTypes.MarketInitParams memory init) {
        init = ProtocolTypes.MarketInitParams({
            factory: address(this),
            paymentToken: address(usdc),
            config: address(config),
            emergencyController: address(emergency),
            exposureGuard: address(guard),
            bondEscrow: address(bondEscrow),
            feeVault: address(feeVault),
            permit2: address(0),
            creator: CREATOR,
            rulesHash: keccak256("direct-rules"),
            metadataURI: "ipfs://direct/{id}.json",
            resolutionSourceHash: keccak256("direct-source"),
            resolutionSourceURI: "https://example.com/direct",
            outcomeCount: 2,
            createdAt: uint64(block.timestamp),
            closeAt: uint64(block.timestamp + 1 days),
            earlyBirdStart: uint64(block.timestamp),
            resolutionWindow: uint64(1 days),
            creatorTreasury: CREATOR_TREASURY,
            deploymentMode: ProtocolTypes.DeploymentMode.FULL,
            featureFlags: ProtocolTypes.FEATURE_EARLY_BIRD,
            perUserPrimaryCap: 100e6,
            marketPrimaryCap: 100e6,
            minimumPrimaryUnits: 10_000,
            minimumC2CUnits: 10_000,
            creatorBond: 10e6,
            economics: ProtocolTypes.EconomicSnapshot({
                creatorRakeBps: 500,
                protocolShareBps: 0,
                earlyBirdShareBps: 2000,
                platformC2CFeeBps: 0,
                creatorC2CFeeBps: 0,
                protocolTreasury: PROTOCOL_TREASURY
            })
        });
    }

    function _expectInitRevert(ProtocolTypes.MarketInitParams memory init, bytes4 selector)
        internal
    {
        FullMarketVaultV1 fresh = new FullMarketVaultV1();
        vm.expectPartialRevert(selector);
        fresh.initialize(init);
    }
}

contract MarketVaultMetadataAndBuyEdgesTest is ProtocolTestBase {
    event TransferBatch(
        address indexed operator,
        address indexed from,
        address indexed to,
        uint256[] ids,
        uint256[] values
    );

    function testCreatorCanUpdateAllMutableMetadataBeforeFirstBuy() public {
        MarketVaultCoreV1 market = _createDefault();
        uint64 newClose = uint64(block.timestamp + 2 days);
        uint64 newEarly = uint64(block.timestamp + 1 hours);
        vm.prank(CREATOR);
        market.updateBeforeFirstBuy(
            keccak256("new-rules"),
            "ipfs://new/{id}.json",
            keccak256("new-source"),
            "https://example.com/new",
            newClose,
            newEarly,
            ALICE,
            ProtocolTypes.FEATURE_PERMIT2
        );
        assertEq(market.rulesHash(), keccak256("new-rules"));
        assertEq(market.uri(0), "ipfs://new/{id}.json");
        assertEq(market.resolutionSourceHash(), keccak256("new-source"));
        assertEq(market.resolutionSourceURI(), "https://example.com/new");
        assertEq(market.closeAt(), newClose);
        assertEq(market.earlyBirdStart(), newEarly);
        assertEq(market.creatorTreasury(), ALICE);
        assertFalse(market.earlyBirdEnabled());
        assertTrue(market.permit2Enabled());
    }

    function testMetadataUpdateRejectsAuthorizationStateAndInvalidFields() public {
        MarketVaultCoreV1 market = _createDefault();
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, ALICE));
        _update(market, keccak256("rules"), "ipfs://ok", "", CREATOR_TREASURY, 0);

        vm.prank(CREATOR);
        vm.expectPartialRevert(InvalidConfiguration.selector);
        _update(market, bytes32(0), "ipfs://ok", "", CREATOR_TREASURY, 0);
        vm.prank(CREATOR);
        vm.expectRevert(ZeroAddress.selector);
        _update(market, keccak256("rules"), "ipfs://ok", "", address(0), 0);
        vm.prank(CREATOR);
        vm.expectPartialRevert(UriTooLong.selector);
        _update(market, keccak256("rules"), string(new bytes(513)), "", CREATOR_TREASURY, 0);
        vm.prank(CREATOR);
        vm.expectPartialRevert(UriTooLong.selector);
        _update(
            market, keccak256("rules"), "ipfs://ok", string(new bytes(513)), CREATOR_TREASURY, 0
        );
        vm.prank(CREATOR);
        vm.expectPartialRevert(UnsupportedFeatureFlags.selector);
        _update(market, keccak256("rules"), "ipfs://ok", "", CREATOR_TREASURY, 1 << 200);

        uint64 created = market.createdAt();
        vm.prank(CREATOR);
        vm.expectPartialRevert(InvalidConfiguration.selector);
        market.updateBeforeFirstBuy(
            keccak256("rules"),
            "ipfs://ok",
            bytes32(0),
            "",
            uint64(created + 5 minutes - 1),
            created,
            CREATOR_TREASURY,
            0
        );

        _buy(market, ALICE, 0, 10e6);
        vm.prank(CREATOR);
        vm.expectRevert(ImmutableAfterFirstBuy.selector);
        _update(market, keccak256("rules2"), "ipfs://ok", "", CREATOR_TREASURY, 0);

        MarketVaultCoreV1 terminal = _create(
            _defaultParams(ProtocolTypes.DeploymentMode.FULL), keccak256("terminal-update")
        );
        vm.prank(CREATOR);
        terminal.creatorVoid(bytes32(0));
        vm.prank(CREATOR);
        vm.expectRevert(MarketTerminal.selector);
        _update(terminal, keccak256("rules2"), "ipfs://ok", "", CREATOR_TREASURY, 0);
    }

    function testMetadataUpdateRejectsOtherwiseValidPastClose() public {
        MarketVaultCoreV1 market = _createDefault();
        uint64 created = market.createdAt();
        vm.warp(created + 1 days);
        vm.prank(CREATOR);
        vm.expectRevert(MarketNotOpen.selector);
        market.updateBeforeFirstBuy(
            keccak256("rules"),
            "ipfs://ok",
            bytes32(0),
            "",
            created + 5 minutes,
            created,
            CREATOR_TREASURY,
            0
        );
    }

    function testBuyValidationRejectsEveryExternalBoundary() public {
        MarketVaultCoreV1 market = _createDefault();
        _approveMarket(ALICE, market);

        ISignatureTransfer.PermitTransferFrom memory permit;
        vm.expectRevert(Permit2Disabled.selector);
        market.buyWithPermit2(
            ALICE, 0, 10e6, 10e6, 10e6, uint64(block.timestamp + 1 hours), permit, ""
        );

        vm.prank(address(0));
        vm.expectRevert(ZeroAddress.selector);
        market.buy(0, 10e6, 10e6, 10e6, uint64(block.timestamp + 1 hours));
        vm.prank(ALICE);
        vm.expectPartialRevert(DeadlineExpired.selector);
        market.buy(0, 10e6, 10e6, 10e6, uint64(block.timestamp - 1));
        vm.prank(ALICE);
        vm.expectPartialRevert(InvalidOutcome.selector);
        market.buy(2, 10e6, 10e6, 10e6, uint64(block.timestamp + 1 hours));
        vm.prank(ALICE);
        vm.expectRevert(ZeroAmount.selector);
        market.buy(0, 0, 0, 0, uint64(block.timestamp + 1 hours));
        vm.prank(ALICE);
        vm.expectPartialRevert(FillBelowMinimum.selector);
        market.buy(0, 9999, 0, 9999, uint64(block.timestamp + 1 hours));
        vm.prank(ALICE);
        vm.expectPartialRevert(PaymentAboveMaximum.selector);
        market.buy(0, 10e6, 10e6, 10e6 - 1, uint64(block.timestamp + 1 hours));

        vm.prank(EMERGENCY_SAFE);
        emergency.pause(ProtocolTypes.PAUSE_PRIMARY_BUY, 1 hours);
        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(PauseActive.selector, ProtocolTypes.PAUSE_PRIMARY_BUY)
        );
        market.buy(0, 10e6, 10e6, 10e6, uint64(block.timestamp + 1 hours));

        vm.warp(block.timestamp + 1 hours);
        emergency.resetEpoch();
        vm.warp(market.closeAt());
        vm.prank(ALICE);
        vm.expectRevert(MarketNotOpen.selector);
        market.buy(0, 10e6, 10e6, 10e6, uint64(block.timestamp + 1 hours));
    }

    function testEarlyBirdWeightsCoverBeforeAndAllThreeSegments() public {
        ProtocolTypes.CreateMarketParams memory params =
            _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.closeAt = uint64(block.timestamp + 4 hours);
        params.earlyBirdStart = uint64(block.timestamp + 1 hours);
        MarketVaultCoreV1 market = _create(params, keccak256("weights"));

        _buy(market, ALICE, 0, 10e6);
        assertEq(market.earlyBirdScore(ALICE), 30e6);
        vm.warp(params.earlyBirdStart + 10 minutes);
        _buy(market, BOB, 0, 10e6);
        assertEq(market.earlyBirdScore(BOB), 30e6);
        vm.warp(params.earlyBirdStart + 70 minutes);
        _buy(market, CAROL, 1, 10e6);
        assertEq(market.earlyBirdScore(CAROL), 20e6);
        vm.warp(params.earlyBirdStart + 130 minutes);
        usdc.mint(address(0xD0D), 10e6);
        _buy(market, address(0xD0D), 1, 10e6);
        assertEq(market.earlyBirdScore(address(0xD0D)), 10e6);
    }

    function testDisabledEarlyBirdNeverCreatesScore() public {
        ProtocolTypes.CreateMarketParams memory params =
            _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.featureFlags = 0;
        MarketVaultCoreV1 market = _create(params, keccak256("no-early"));
        _buy(market, ALICE, 0, 10e6);
        assertEq(market.earlyBirdScore(ALICE), 0);
        assertEq(market.totalEarlyBirdScore(), 0);
    }

    function testErc1155BatchTransferEmitsStandardEventAndPreservesSupply() public {
        MarketVaultCoreV1 market = _createDefault();
        _buy(market, ALICE, 0, 20e6);
        _buy(market, ALICE, 1, 30e6);
        uint256[] memory ids = new uint256[](2);
        ids[0] = 0;
        ids[1] = 1;
        uint256[] memory values = new uint256[](2);
        values[0] = 5e6;
        values[1] = 7e6;

        vm.expectEmit(true, true, true, true, address(market));
        emit TransferBatch(ALICE, ALICE, BOB, ids, values);
        vm.prank(ALICE);
        market.safeBatchTransferFrom(ALICE, BOB, ids, values, "");

        assertEq(market.balanceOf(BOB, 0), 5e6);
        assertEq(market.balanceOf(BOB, 1), 7e6);
        assertEq(market.totalSupply(0), 20e6);
        assertEq(market.totalSupply(1), 30e6);
    }

    function _update(
        MarketVaultCoreV1 market,
        bytes32 newRules,
        string memory metadata,
        string memory resolutionURI,
        address treasury,
        uint256 flags
    ) internal {
        market.updateBeforeFirstBuy(
            newRules,
            metadata,
            keccak256("source"),
            resolutionURI,
            uint64(block.timestamp + 2 days),
            uint64(block.timestamp),
            treasury,
            flags
        );
    }
}

contract MarketVaultSettlementEdgesTest is ProtocolTestBase {
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
        ProtocolTypes.MarketState indexed terminalState,
        address indexed caller,
        uint256 refundPrincipal,
        bytes32 indexed evidenceHash
    );

    function testTerminalEventsCommitCreatorEvidenceAndTimeoutUsesZero() public {
        bytes32 resolutionEvidence = keccak256("resolution-evidence");
        MarketVaultCoreV1 resolved = _create(
            _defaultParams(ProtocolTypes.DeploymentMode.FULL), keccak256("resolved-evidence")
        );
        _buy(resolved, ALICE, 0, 20e6);
        vm.warp(resolved.closeAt());
        vm.expectEmit(true, true, false, false, address(resolved));
        emit MarketResolved(0, 0, 0, 0, 0, 0, 0, resolutionEvidence);
        vm.prank(CREATOR);
        resolved.resolve(0, resolutionEvidence);

        bytes32 voidEvidence = keccak256("creator-void-evidence");
        MarketVaultCoreV1 creatorVoided = _create(
            _defaultParams(ProtocolTypes.DeploymentMode.FULL), keccak256("voided-evidence")
        );
        _buy(creatorVoided, ALICE, 0, 20e6);
        vm.expectEmit(true, true, true, true, address(creatorVoided));
        emit MarketVoided(ProtocolTypes.MarketState.VOIDED_CREATOR, CREATOR, 20e6, voidEvidence);
        vm.prank(CREATOR);
        creatorVoided.creatorVoid(voidEvidence);

        MarketVaultCoreV1 timeoutVoided = _create(
            _defaultParams(ProtocolTypes.DeploymentMode.FULL), keccak256("timeout-zero-evidence")
        );
        vm.warp(timeoutVoided.resolutionDeadline());
        vm.expectEmit(true, true, true, true, address(timeoutVoided));
        emit MarketVoided(ProtocolTypes.MarketState.VOIDED_TIMEOUT, ALICE, 0, bytes32(0));
        vm.prank(ALICE);
        timeoutVoided.voidAfterDeadline();
    }

    function testResolveAuthorizationTimeOutcomeAndTerminalBoundaries() public {
        MarketVaultCoreV1 market = _createDefault();
        _buy(market, ALICE, 0, 20e6);
        vm.expectRevert(MarketNotClosed.selector);
        market.claimWinningsFor(ALICE);
        vm.expectRevert(MarketNotClosed.selector);
        market.claimEarlyBirdFor(ALICE);
        vm.expectRevert(NothingToClaim.selector);
        market.claimTimeoutBonusFor(ALICE);
        vm.prank(ALICE);
        vm.expectRevert(MarketNotClosed.selector);
        market.burnLosingPosition(1);
        vm.prank(CREATOR);
        vm.expectRevert(MarketNotClosed.selector);
        market.resolve(0, bytes32(0));
        vm.warp(market.closeAt());
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, ALICE));
        market.resolve(0, bytes32(0));
        vm.prank(CREATOR);
        vm.expectPartialRevert(InvalidOutcome.selector);
        market.resolve(2, bytes32(0));
        vm.prank(CREATOR);
        vm.expectPartialRevert(WinningOutcomeHasNoSupply.selector);
        market.resolve(1, bytes32(0));
        vm.prank(CREATOR);
        market.resolve(0, bytes32(0));
        assertTrue(market.isTerminal());
        vm.prank(CREATOR);
        vm.expectRevert(MarketTerminal.selector);
        market.resolve(0, bytes32(0));
        vm.prank(CREATOR);
        vm.expectRevert(MarketTerminal.selector);
        market.creatorVoid(bytes32(0));
        vm.expectRevert(MarketTerminal.selector);
        market.voidAfterDeadline();
    }

    function testResolveWindowAndTimeoutBoundariesAreExact() public {
        MarketVaultCoreV1 market = _createDefault();
        _buy(market, ALICE, 0, 20e6);
        vm.warp(market.resolutionDeadline() - 1);
        vm.expectRevert(TimeoutNotReached.selector);
        market.voidAfterDeadline();
        vm.warp(market.resolutionDeadline());
        vm.prank(CREATOR);
        vm.expectRevert(ResolutionWindowExpired.selector);
        market.resolve(0, bytes32(0));
        market.voidAfterDeadline();
        assertEq(uint8(market.marketState()), uint8(ProtocolTypes.MarketState.VOIDED_TIMEOUT));
    }

    function testCreatorVoidExpiresAtDeadlineAndCannotRacePermissionlessTimeout() public {
        MarketVaultCoreV1 beforeDeadline = _create(
            _defaultParams(ProtocolTypes.DeploymentMode.FULL), keccak256("void-before-deadline")
        );
        vm.warp(beforeDeadline.resolutionDeadline() - 1);
        vm.prank(CREATOR);
        beforeDeadline.creatorVoid(bytes32(0));
        assertEq(
            uint8(beforeDeadline.marketState()), uint8(ProtocolTypes.MarketState.VOIDED_CREATOR)
        );

        MarketVaultCoreV1 atDeadline = _create(
            _defaultParams(ProtocolTypes.DeploymentMode.FULL), keccak256("void-at-deadline")
        );
        vm.warp(atDeadline.resolutionDeadline());
        vm.prank(CREATOR);
        vm.expectRevert(ResolutionWindowExpired.selector);
        atDeadline.creatorVoid(bytes32(0));
        vm.prank(ALICE);
        atDeadline.voidAfterDeadline();
        assertEq(uint8(atDeadline.marketState()), uint8(ProtocolTypes.MarketState.VOIDED_TIMEOUT));
        vm.prank(CREATOR);
        vm.expectRevert(MarketTerminal.selector);
        atDeadline.creatorVoid(bytes32(0));

        MarketVaultCoreV1 afterDeadline = _create(
            _defaultParams(ProtocolTypes.DeploymentMode.FULL), keccak256("void-after-deadline")
        );
        vm.warp(afterDeadline.resolutionDeadline() + 1);
        vm.prank(CREATOR);
        vm.expectRevert(ResolutionWindowExpired.selector);
        afterDeadline.creatorVoid(bytes32(0));
        afterDeadline.voidAfterDeadline();
    }

    function testConvenienceWinnerEarlyBirdAndLosingBurnPaths() public {
        config.setProtocolShareBps(5000);
        MarketVaultCoreV1 market = _createDefault();
        _buy(market, ALICE, 0, 60e6);
        _buy(market, BOB, 1, 40e6);
        vm.warp(market.closeAt());
        vm.prank(CREATOR);
        market.resolve(0, bytes32(0));

        uint256 aliceBefore = usdc.balanceOf(ALICE);
        vm.prank(ALICE);
        uint256 winnerPayout = market.claimWinnings();
        vm.prank(ALICE);
        uint256 earlyReward = market.claimEarlyBird();
        assertEq(usdc.balanceOf(ALICE) - aliceBefore, winnerPayout + earlyReward);
        vm.prank(ALICE);
        vm.expectRevert(NothingToClaim.selector);
        market.claimWinnings();
        vm.prank(ALICE);
        vm.expectRevert(NothingToClaim.selector);
        market.claimEarlyBird();

        vm.prank(BOB);
        vm.expectPartialRevert(InvalidOutcome.selector);
        market.burnLosingPosition(0);
        vm.prank(BOB);
        vm.expectPartialRevert(InvalidOutcome.selector);
        market.burnLosingPosition(2);
        vm.prank(BOB);
        market.burnLosingPosition(1);
        assertEq(market.balanceOf(BOB, 1), 0);
        vm.prank(BOB);
        vm.expectRevert(NothingToClaim.selector);
        market.burnLosingPosition(1);
    }

    function testRefundAndTimeoutBonusConvenienceClaimsConservePools() public {
        MarketVaultCoreV1 creatorVoided = _createDefault();
        _buy(creatorVoided, ALICE, 0, 20e6);
        vm.prank(ALICE);
        vm.expectRevert(MarketNotClosed.selector);
        creatorVoided.refund();
        vm.prank(CREATOR);
        creatorVoided.creatorVoid(bytes32(0));
        uint256 aliceBefore = usdc.balanceOf(ALICE);
        vm.prank(ALICE);
        assertEq(creatorVoided.refund(), 20e6);
        assertEq(usdc.balanceOf(ALICE) - aliceBefore, 20e6);
        vm.prank(ALICE);
        vm.expectRevert(NothingToClaim.selector);
        creatorVoided.refund();

        MarketVaultCoreV1 timeout = _create(
            _defaultParams(ProtocolTypes.DeploymentMode.FULL), keccak256("timeout-convenience")
        );
        _buy(timeout, ALICE, 0, 30e6);
        _buy(timeout, BOB, 1, 20e6);
        vm.warp(timeout.resolutionDeadline());
        timeout.voidAfterDeadline();
        vm.prank(ALICE);
        timeout.refund();
        timeout.refundFor(BOB);
        bondEscrow.settleBond(address(timeout));

        uint256 beforeAliceBonus = usdc.balanceOf(ALICE);
        vm.prank(ALICE);
        uint256 first = timeout.claimTimeoutBonus();
        uint256 beforeBobBonus = usdc.balanceOf(BOB);
        uint256 second = timeout.claimTimeoutBonusFor(BOB);
        assertEq(first + second, 10e6);
        assertEq(usdc.balanceOf(ALICE) - beforeAliceBonus, first);
        assertEq(usdc.balanceOf(BOB) - beforeBobBonus, second);
        vm.prank(ALICE);
        vm.expectRevert(NothingToClaim.selector);
        timeout.claimTimeoutBonus();
    }

    function testFundTimeoutBonusAuthorizationStateZeroAndDuplicate() public {
        MarketVaultCoreV1 market = _createDefault();
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, ALICE));
        market.fundTimeoutBonus(10e6);
        vm.prank(address(bondEscrow));
        vm.expectRevert(MarketNotClosed.selector);
        market.fundTimeoutBonus(10e6);

        _buy(market, ALICE, 0, 20e6);
        vm.warp(market.resolutionDeadline());
        market.voidAfterDeadline();
        vm.prank(address(bondEscrow));
        vm.expectRevert(ZeroAmount.selector);
        market.fundTimeoutBonus(0);
        usdc.mint(address(market), 10e6);
        vm.prank(address(bondEscrow));
        market.fundTimeoutBonus(10e6);
        assertTrue(market.timeoutBonusFunded());
        vm.prank(address(bondEscrow));
        vm.expectRevert(AlreadySettled.selector);
        market.fundTimeoutBonus(1);
    }

    function testResolveFailsClosedIfPaymentTokenBalanceIsConfiscated() public {
        ProtocolTypes.CreateMarketParams memory params =
            _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.creatorRakeBps = 0;
        MarketVaultCoreV1 market = _create(params, keccak256("insolvent-resolve"));
        _buy(market, ALICE, 0, 20e6);
        deal(address(usdc), address(market), 0);
        vm.warp(market.closeAt());
        vm.prank(CREATOR);
        vm.expectPartialRevert(Insolvent.selector);
        market.resolve(0, bytes32(0));
        assertEq(uint8(market.marketState()), uint8(ProtocolTypes.MarketState.OPEN));
    }

    function testRoundingRemainderIsAssignedWithoutCreatingValue() public {
        ProtocolTypes.CreateMarketParams memory params =
            _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.minimumPrimaryUnits = 10_000;
        MarketVaultCoreV1 market = _create(params, keccak256("rounding"));
        _buy(market, ALICE, 0, 10_001);
        _buy(market, BOB, 0, 10_002);
        _buy(market, CAROL, 1, 10_003);
        vm.warp(market.closeAt());
        vm.prank(CREATOR);
        market.resolve(0, bytes32(0));

        uint256 pool = market.remainingWinnerPool();
        uint256 first = market.claimWinningsFor(ALICE);
        uint256 second = market.claimWinningsFor(BOB);
        assertEq(first + second, pool);
        assertEq(market.remainingWinnerPool(), 0);
        assertEq(market.remainingWinningUnits(), 0);
    }
}
