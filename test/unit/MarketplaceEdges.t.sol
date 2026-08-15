// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { IERC1155Receiver } from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { ISignatureTransfer } from "permit2/interfaces/ISignatureTransfer.sol";
import { ProtocolTestBase } from "../helpers/ProtocolTestBase.sol";
import { MarketVaultCoreV1 } from "../../src/market/MarketVaultCoreV1.sol";
import { FixedPriceMarketplaceV1 } from "../../src/marketplace/FixedPriceMarketplaceV1.sol";
import { ProtocolTypes } from "../../src/libraries/ProtocolTypes.sol";
import {
    ZeroAddress,
    InvalidOutcome,
    MarketNotRegistered,
    MarketTerminal,
    DeadlineExpired,
    PauseActive,
    ZeroAmount,
    FillBelowMinimum,
    PaymentAboveMaximum,
    ListingNotActive,
    ListingExpired,
    InvalidListingExpiry,
    InvalidPrice,
    UnexpectedERC1155Transfer,
    Permit2Disabled,
    MarketNotClosedForReturn
} from "../../src/libraries/ProtocolErrors.sol";

contract MarketplaceEdgesTest is ProtocolTestBase {
    function testConstructorAndInterfaceSurface() public {
        vm.expectRevert(ZeroAddress.selector);
        new FixedPriceMarketplaceV1(
            address(0), address(emergency), address(feeVault), address(usdc), address(0)
        );
        vm.expectRevert(ZeroAddress.selector);
        new FixedPriceMarketplaceV1(
            address(factory), address(emergency), address(feeVault), address(0), address(0)
        );
        assertTrue(marketplace.supportsInterface(type(IERC1155Receiver).interfaceId));
        assertTrue(marketplace.supportsInterface(type(IERC165).interfaceId));
        assertFalse(marketplace.supportsInterface(bytes4(0xffffffff)));

        uint256[] memory ids = new uint256[](1);
        uint256[] memory values = new uint256[](1);
        vm.expectRevert(UnexpectedERC1155Transfer.selector);
        marketplace.onERC1155BatchReceived(address(this), ALICE, ids, values, "");
    }

    function testCreateListingRejectsPauseRegistrationStateAndAllRanges() public {
        MarketVaultCoreV1 market = _createDefault();
        _buy(market, ALICE, 0, 20e6);
        vm.prank(ALICE);
        market.setApprovalForAll(address(marketplace), true);

        vm.prank(ALICE);
        vm.expectPartialRevert(MarketNotRegistered.selector);
        marketplace.createListing(address(usdc), 0, 10e6, 1e6, uint64(block.timestamp + 1 days));
        vm.prank(ALICE);
        vm.expectPartialRevert(InvalidOutcome.selector);
        marketplace.createListing(address(market), 2, 10e6, 1e6, uint64(block.timestamp + 1 days));
        vm.prank(ALICE);
        vm.expectPartialRevert(FillBelowMinimum.selector);
        marketplace.createListing(address(market), 0, 9999, 1e6, uint64(block.timestamp + 1 days));
        vm.prank(ALICE);
        vm.expectPartialRevert(InvalidPrice.selector);
        marketplace.createListing(address(market), 0, 10e6, 0, uint64(block.timestamp + 1 days));
        vm.prank(ALICE);
        vm.expectPartialRevert(InvalidPrice.selector);
        marketplace.createListing(
            address(market), 0, 10e6, 1000e6 + 1, uint64(block.timestamp + 1 days)
        );
        vm.prank(ALICE);
        vm.expectRevert(InvalidListingExpiry.selector);
        marketplace.createListing(address(market), 0, 10e6, 1e6, uint64(block.timestamp));

        vm.prank(EMERGENCY_SAFE);
        emergency.pause(ProtocolTypes.PAUSE_LISTING_CREATE, 1 hours);
        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(PauseActive.selector, ProtocolTypes.PAUSE_LISTING_CREATE)
        );
        marketplace.createListing(address(market), 0, 10e6, 1e6, uint64(block.timestamp + 1 days));

        vm.warp(block.timestamp + 1 hours);
        emergency.resetEpoch();
        vm.prank(CREATOR);
        market.creatorVoid(bytes32(0));
        vm.prank(ALICE);
        vm.expectRevert(MarketTerminal.selector);
        marketplace.createListing(address(market), 0, 10e6, 1e6, uint64(block.timestamp + 1 days));
    }

    function testMarketplaceRejectsDirectSingleAndBatchEscrowTransfers() public {
        MarketVaultCoreV1 market = _createDefault();
        _buy(market, ALICE, 0, 20e6);

        vm.prank(ALICE);
        vm.expectRevert(UnexpectedERC1155Transfer.selector);
        market.safeTransferFrom(
            ALICE, address(marketplace), 0, 10e6, abi.encode(bytes32("not-a-listing"))
        );

        uint256[] memory ids = new uint256[](1);
        ids[0] = 0;
        uint256[] memory values = new uint256[](1);
        values[0] = 10e6;
        vm.prank(ALICE);
        vm.expectRevert(UnexpectedERC1155Transfer.selector);
        market.safeBatchTransferFrom(ALICE, address(marketplace), ids, values, "");
        assertEq(market.balanceOf(ALICE, 0), 20e6);
    }

    function testFillValidationRejectsInactiveDeadlineZeroMinimumDustGrossAndMax() public {
        MarketVaultCoreV1 market = _createDefault();
        _buy(market, ALICE, 0, 20e6);
        bytes32 listingId = _list(market, 20_000, 1e6, uint64(block.timestamp + 1 days));

        vm.prank(BOB);
        vm.expectPartialRevert(DeadlineExpired.selector);
        marketplace.fillListing(listingId, 10_000, 10_000, 10_000, uint64(block.timestamp - 1));
        vm.prank(BOB);
        vm.expectRevert(ZeroAmount.selector);
        marketplace.fillListing(listingId, 0, 0, 0, uint64(block.timestamp + 1 hours));
        vm.prank(BOB);
        vm.expectPartialRevert(FillBelowMinimum.selector);
        marketplace.fillListing(
            listingId, 10_000, 10_001, 10_000, uint64(block.timestamp + 1 hours)
        );
        vm.prank(BOB);
        vm.expectPartialRevert(FillBelowMinimum.selector);
        marketplace.fillListing(
            listingId, 15_000, 15_000, 15_000, uint64(block.timestamp + 1 hours)
        );

        bytes32 subminimumFill = _list(market, 30_000, 1e6, uint64(block.timestamp + 1 days));
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(FillBelowMinimum.selector, 9999, 10_000));
        marketplace.fillListing(subminimumFill, 9999, 1, 9999, uint64(block.timestamp + 1 hours));

        bytes32 zeroGross = _list(market, 10_000, 1, uint64(block.timestamp + 1 days));
        vm.prank(BOB);
        vm.expectRevert(ZeroAmount.selector);
        marketplace.fillListing(zeroGross, 10_000, 10_000, 1, uint64(block.timestamp + 1 hours));

        bytes32 expensive = _list(market, 1e6, 1e6, uint64(block.timestamp + 1 days));
        vm.prank(BOB);
        vm.expectPartialRevert(PaymentAboveMaximum.selector);
        marketplace.fillListing(expensive, 1e6, 1e6, 1e6 - 1, uint64(block.timestamp + 1 hours));

        vm.prank(BOB);
        vm.expectPartialRevert(ListingNotActive.selector);
        marketplace.fillListing(
            bytes32("missing"), 1e6, 1e6, 1e6, uint64(block.timestamp + 1 hours)
        );
    }

    function testFillRejectsExpiryTerminalPauseAndPermit2Disabled() public {
        MarketVaultCoreV1 market = _createDefault();
        _buy(market, ALICE, 0, 30e6);
        bytes32 expiring = _list(market, 10e6, 1e6, uint64(block.timestamp + 1 hours));
        vm.warp(block.timestamp + 1 hours);
        vm.prank(BOB);
        vm.expectPartialRevert(ListingExpired.selector);
        marketplace.fillListing(expiring, 10e6, 10e6, 10e6, uint64(block.timestamp + 1 hours));

        bytes32 terminal = _list(market, 10e6, 1e6, uint64(block.timestamp + 1 days));
        vm.prank(CREATOR);
        market.creatorVoid(bytes32(0));
        vm.prank(BOB);
        vm.expectRevert(MarketTerminal.selector);
        marketplace.fillListing(terminal, 10e6, 10e6, 10e6, uint64(block.timestamp + 1 hours));

        MarketVaultCoreV1 active =
            _create(_defaultParams(ProtocolTypes.DeploymentMode.FULL), keccak256("fill-pause"));
        _buy(active, ALICE, 0, 20e6);
        bytes32 pausedListing = _list(active, 10e6, 1e6, uint64(block.timestamp + 1 days));
        emergency.resetEpoch();
        vm.prank(EMERGENCY_SAFE);
        emergency.pause(ProtocolTypes.PAUSE_LISTING_FILL, 1 hours);
        vm.prank(BOB);
        vm.expectRevert(
            abi.encodeWithSelector(PauseActive.selector, ProtocolTypes.PAUSE_LISTING_FILL)
        );
        marketplace.fillListing(pausedListing, 10e6, 10e6, 10e6, uint64(block.timestamp + 1 hours));

        ISignatureTransfer.PermitTransferFrom memory permit;
        vm.expectRevert(Permit2Disabled.selector);
        marketplace.fillListingWithPermit2(
            pausedListing, BOB, 10e6, 10e6, 10e6, uint64(block.timestamp + 1 hours), permit, ""
        );
    }

    function testFullFillWithNoFeesPaysSellerAndClosesListing() public {
        MarketVaultCoreV1 market = _createDefault();
        _buy(market, ALICE, 0, 20e6);
        bytes32 listingId = _list(market, 10e6, 900_000, uint64(block.timestamp + 1 days));
        uint256 sellerBefore = usdc.balanceOf(ALICE);
        vm.prank(BOB);
        (uint256 units, uint256 gross) =
            marketplace.fillListing(listingId, 20e6, 10e6, 9e6, uint64(block.timestamp + 1 hours));
        assertEq(units, 10e6);
        assertEq(gross, 9e6);
        assertEq(usdc.balanceOf(ALICE) - sellerBefore, 9e6);
        assertEq(market.balanceOf(BOB, 0), 10e6);
        (,, uint128 remaining,,,, bool active) = marketplace.listings(listingId);
        assertEq(remaining, 0);
        assertFalse(active);
    }

    function testPlatformAndCreatorFeesBothAccrueOnFill() public {
        config.setPlatformC2CFeeBps(100);
        ProtocolTypes.CreateMarketParams memory params =
            _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.creatorC2CFeeBps = 100;
        MarketVaultCoreV1 market = _create(params, keccak256("dual-fees"));
        _buy(market, ALICE, 0, 20e6);
        bytes32 listingId = _list(market, 10e6, 1e6, uint64(block.timestamp + 1 days));
        uint256 sellerBefore = usdc.balanceOf(ALICE);
        vm.prank(BOB);
        marketplace.fillListing(listingId, 10e6, 10e6, 10e6, uint64(block.timestamp + 1 hours));
        assertEq(usdc.balanceOf(ALICE) - sellerBefore, 9_800_000);
        assertEq(feeVault.creditOf(PROTOCOL_TREASURY), 100_000);
        assertEq(feeVault.creditOf(CREATOR_TREASURY), 100_000);
    }

    function testCancelAuthorizationAndPermissionlessTerminalReturn() public {
        MarketVaultCoreV1 market = _createDefault();
        _buy(market, ALICE, 0, 20e6);
        bytes32 cancelId = _list(market, 5e6, 1e6, uint64(block.timestamp + 1 days));
        vm.prank(BOB);
        vm.expectPartialRevert(ListingNotActive.selector);
        marketplace.cancelListing(cancelId);
        vm.prank(ALICE);
        marketplace.cancelListing(cancelId);
        vm.prank(ALICE);
        vm.expectPartialRevert(ListingNotActive.selector);
        marketplace.cancelListing(cancelId);

        bytes32 terminalId = _list(market, 5e6, 1e6, uint64(block.timestamp + 1 days));
        vm.expectRevert(MarketNotClosedForReturn.selector);
        marketplace.returnTerminalListing(terminalId);
        vm.prank(CREATOR);
        market.creatorVoid(bytes32(0));
        vm.prank(CAROL);
        marketplace.returnTerminalListing(terminalId);
        assertEq(market.balanceOf(ALICE, 0), 20e6);
        vm.expectPartialRevert(ListingNotActive.selector);
        marketplace.returnTerminalListing(terminalId);
    }

    function _list(MarketVaultCoreV1 market, uint256 amount, uint256 price, uint64 expiry)
        internal
        returns (bytes32 listingId)
    {
        vm.prank(ALICE);
        market.setApprovalForAll(address(marketplace), true);
        vm.prank(ALICE);
        listingId = marketplace.createListing(address(market), 0, amount, price, expiry);
    }
}
