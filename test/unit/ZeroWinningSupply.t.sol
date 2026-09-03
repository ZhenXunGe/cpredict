// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { ProtocolTestBase } from "../helpers/ProtocolTestBase.sol";
import { MarketVaultCoreV1 } from "../../src/market/MarketVaultCoreV1.sol";
import { ProtocolTypes } from "../../src/libraries/ProtocolTypes.sol";
import { MarketTerminal, MarketNotClosed, NothingToClaim } from "../../src/libraries/ProtocolErrors.sol";

contract ZeroWinningSupplyTest is ProtocolTestBase {
    event MarketVoided(
        ProtocolTypes.VoidReason indexed reason,
        address indexed caller,
        uint256 refundPrincipal,
        bytes32 indexed evidenceHash
    );

    function testZeroWinnerFullRefundsCurrentHoldersWithoutRakeOrSlash() public {
        _assertZeroWinner(ProtocolTypes.DeploymentMode.FULL);
    }

    function testZeroWinnerCloneRefundsCurrentHoldersWithoutRakeOrSlash() public {
        _assertZeroWinner(ProtocolTypes.DeploymentMode.CLONE);
    }

    function _assertZeroWinner(ProtocolTypes.DeploymentMode mode) internal {
        ProtocolTypes.CreateMarketParams memory params = _defaultParams(mode);
        params.outcomeCount = 3;
        MarketVaultCoreV1 market = _create(params, keccak256("zero-winner"));
        assertEq(uint8(market.voidReason()), uint8(ProtocolTypes.VoidReason.NONE));
        _buy(market, ALICE, 0, 20e6);
        _buy(market, BOB, 1, 10e6);
        vm.prank(ALICE);
        market.setApprovalForAll(address(marketplace), true);
        vm.prank(ALICE);
        bytes32 listing = marketplace.createListing(
            address(market), 0, 12e6, 900_000, uint64(market.resolutionDeadline())
        );
        vm.prank(CAROL);
        marketplace.fillListing(listing, 7e6, 7e6, 7e6, uint64(market.closeAt()));

        vm.warp(market.closeAt());
        bytes32 evidence = keccak256("creator-selected-empty-outcome");
        vm.expectEmit(true, true, true, true, address(market));
        emit MarketVoided(ProtocolTypes.VoidReason.NO_WINNING_SUPPLY, CREATOR, 30e6, evidence);
        vm.prank(CREATOR);
        market.resolve(2, evidence);
        assertEq(uint8(market.marketState()), uint8(ProtocolTypes.MarketState.VOIDED));
        assertEq(uint8(market.voidReason()), uint8(ProtocolTypes.VoidReason.NO_WINNING_SUPPLY));
        assertEq(market.remainingRefundPrincipal(), 30e6);
        assertEq(market.remainingWinnerPool(), 0);
        assertEq(market.remainingEarlyBirdPool(), 0);
        assertEq(usdc.balanceOf(address(feeVault)), 0);
        assertEq(feeVault.creditOf(CREATOR_TREASURY), 0);

        uint256 aliceBefore = usdc.balanceOf(ALICE);
        uint256 bobBefore = usdc.balanceOf(BOB);
        uint256 carolBefore = usdc.balanceOf(CAROL);
        // Wallet-held principal is claimable before escrow return and before bond settlement.
        market.refundFor(ALICE);
        assertEq(usdc.balanceOf(ALICE) - aliceBefore, 8e6);
        marketplace.returnTerminalListing(listing);
        market.refundFor(ALICE);
        market.refundFor(BOB);
        market.refundFor(CAROL);
        assertEq(usdc.balanceOf(ALICE) - aliceBefore, 13e6);
        assertEq(usdc.balanceOf(BOB) - bobBefore, 10e6);
        assertEq(usdc.balanceOf(CAROL) - carolBefore, 7e6);
        assertEq(market.remainingRefundPrincipal(), 0);
        assertEq(usdc.balanceOf(address(market)), 0);
        assertEq(market.timeoutBonusUnits(ALICE), 0);

        bondEscrow.settleBond(address(market));
        assertEq(bondEscrow.creditOf(CREATOR), params.creatorBond);
        assertFalse(market.timeoutBonusFunded());
        vm.expectRevert(MarketNotClosed.selector);
        market.claimEarlyBirdFor(ALICE);
        vm.expectRevert(NothingToClaim.selector);
        market.refundFor(ALICE);
        vm.prank(CREATOR);
        vm.expectRevert(MarketTerminal.selector);
        market.resolve(0, bytes32(0));
        vm.expectRevert(MarketTerminal.selector);
        market.voidAfterDeadline();
    }

    function testEmptyMarketSelectedOutcomeReturnsBondWithoutUnclaimableBonus() public {
        MarketVaultCoreV1 market = _createDefault();
        vm.warp(market.closeAt());
        vm.prank(CREATOR);
        market.resolve(1, bytes32(0));
        bondEscrow.settleBond(address(market));
        assertEq(uint8(market.voidReason()), uint8(ProtocolTypes.VoidReason.NO_WINNING_SUPPLY));
        assertEq(market.remainingRefundPrincipal(), 0);
        assertEq(bondEscrow.creditOf(CREATOR), market.creatorBond());
        assertFalse(market.timeoutBonusFunded());
    }
}
