// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { MarketVaultCoreV1 } from "../../src/market/MarketVaultCoreV1.sol";
import { ProtocolTypes } from "../../src/libraries/ProtocolTypes.sol";
import { NothingToClaim, Insolvent } from "../../src/libraries/ProtocolErrors.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";

/// @dev A test-only harness for defensive internal branches that valid public state transitions
/// cannot make reachable. Assertions here check the actual fail-closed behavior, not just coverage.
contract MarketVaultInternalHarness is MarketVaultCoreV1 {
    constructor() MarketVaultCoreV1(false) { }

    function configureWeight(bool enabled, uint64 start, uint64 close) external {
        featureFlags = enabled ? ProtocolTypes.FEATURE_EARLY_BIRD : 0;
        earlyBirdStart = start;
        closeAt = close;
    }

    function exposedEarlyBirdWeight(uint256 timestamp) external view returns (uint8) {
        return _earlyBirdWeight(timestamp);
    }

    function exposedConsume(uint256 units, uint256 remainingUnits, uint256 remainingPool)
        external
        returns (uint256)
    {
        return _consumeRemainingPool(
            units, remainingUnits, remainingPool, keccak256("HARNESS_POOL"), msg.sender
        );
    }

    function configureCoverage(
        IERC20 token,
        ProtocolTypes.MarketState state,
        uint256 principal,
        uint256 winnerPool,
        uint256 earlyPool,
        uint256 refundPrincipal,
        uint256 bonusPool
    ) external {
        _paymentToken = token;
        marketState = state;
        _packedMarketAccountingForHarness(principal);
        remainingWinnerPool = winnerPool;
        remainingEarlyBirdPool = earlyPool;
        remainingRefundPrincipal = refundPrincipal;
        remainingTimeoutBonusPool = bonusPool;
    }

    function exposedAssertCoverage() external view {
        _assertCoverage();
    }

    function configurePackedMarketAccounting(uint256 principal, uint256 earlyScore) external {
        _setMarketAccounting(principal, earlyScore);
    }

    function exposedPackUint128Pair(uint256 low, uint256 high) external pure returns (uint256) {
        return _packUint128Pair(low, high);
    }

    function _packedMarketAccountingForHarness(uint256 principal) internal {
        // The harness exercises coverage branches with no early-bird liability.
        _setMarketAccounting(principal, 0);
    }
}

contract MarketVaultInternalHarnessTest is Test {
    MockUSDC internal token;
    MarketVaultInternalHarness internal harness;

    function setUp() public {
        token = new MockUSDC();
        harness = new MarketVaultInternalHarness();
        token.mint(address(harness), 1000);
    }

    function testEarlyBirdWeightDefensiveClosedBoundaryAndDisabledMode() public {
        harness.configureWeight(false, 100, 400);
        assertEq(harness.exposedEarlyBirdWeight(50), 0);
        harness.configureWeight(true, 100, 400);
        assertEq(harness.exposedEarlyBirdWeight(99), 3);
        assertEq(harness.exposedEarlyBirdWeight(100), 3);
        assertEq(harness.exposedEarlyBirdWeight(201), 2);
        assertEq(harness.exposedEarlyBirdWeight(301), 1);
        assertEq(harness.exposedEarlyBirdWeight(400), 0);
    }

    function testRemainingPoolRejectsCorruptUnitsAndAssignsRemainderExactly() public {
        vm.expectRevert(NothingToClaim.selector);
        harness.exposedConsume(0, 10, 100);
        vm.expectRevert(NothingToClaim.selector);
        harness.exposedConsume(1, 0, 100);
        vm.expectRevert(NothingToClaim.selector);
        harness.exposedConsume(11, 10, 100);
        assertEq(harness.exposedConsume(4, 10, 101), 40);
        assertEq(harness.exposedConsume(10, 10, 101), 101);
    }

    function testRemainingPoolRedistributesRoundingAcrossTheClaimSequence() public {
        uint256 remainingUnits = 6;
        uint256 remainingPool = 10;
        uint256[6] memory expected = [uint256(1), 1, 2, 2, 2, 2];
        uint256 distributed;

        for (uint256 index = 0; index < expected.length; index++) {
            uint256 payout = harness.exposedConsume(1, remainingUnits, remainingPool);
            assertEq(payout, expected[index]);
            remainingUnits -= 1;
            remainingPool -= payout;
            distributed += payout;
        }

        assertEq(distributed, 10);
        assertEq(remainingUnits, 0);
        assertEq(remainingPool, 0);
    }

    function testCoverageAssertionHandlesEveryStateAndFailsClosed() public {
        harness.configureCoverage(token, ProtocolTypes.MarketState.OPEN, 100, 0, 0, 0, 0);
        harness.exposedAssertCoverage();
        assertEq(harness.guardExposure(), 100);

        harness.configureCoverage(token, ProtocolTypes.MarketState.RESOLVED, 0, 400, 100, 0, 0);
        harness.exposedAssertCoverage();
        assertEq(harness.guardExposure(), 500);

        harness.configureCoverage(
            token, ProtocolTypes.MarketState.VOIDED, 0, 0, 0, 600, 100
        );
        harness.exposedAssertCoverage();
        assertEq(harness.guardExposure(), 700);

        harness.configureCoverage(
            token, ProtocolTypes.MarketState.VOIDED, 0, 0, 0, 600, 500
        );
        vm.expectPartialRevert(Insolvent.selector);
        harness.exposedAssertCoverage();
    }

    function testPackedAccountingPreservesBothUint128FieldsAndRejectsTruncation() public {
        assertFalse(harness.firstBuyOccurred());
        harness.configurePackedMarketAccounting(type(uint128).max, type(uint128).max);
        assertTrue(harness.firstBuyOccurred());
        assertEq(harness.totalPrincipal(), type(uint128).max);
        assertEq(harness.totalEarlyBirdScore(), type(uint128).max);
        assertEq(
            harness.exposedPackUint128Pair(type(uint128).max, type(uint128).max), type(uint256).max
        );

        vm.expectRevert();
        harness.exposedPackUint128Pair(uint256(type(uint128).max) + 1, 0);
        vm.expectRevert();
        harness.exposedPackUint128Pair(0, uint256(type(uint128).max) + 1);
    }
}
