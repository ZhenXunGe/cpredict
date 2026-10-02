// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;
import { OrderbookTestBase } from "../helpers/OrderbookTestBase.sol";
import { RejectingBuyer, ReenteringBuyer } from "./OrderbookMarketplaceV2.t.sol";
import { MarketVaultCoreV1 } from "../../src/market/MarketVaultCoreV1.sol";
import { OrderbookMarketplaceV2 as Book } from "../../src/marketplace/OrderbookMarketplaceV2.sol";

contract WholeOrderMarketplaceV2Test is OrderbookTestBase {
    MarketVaultCoreV1 internal market;

    function setUp() public override {
        super.setUp();
        marketplace.setDefaultAllowPartialFills(false);
        market = _createDefault();
        _buy(market, ALICE, 0, 40e6);
        _buy(market, CAROL, 0, 20e6);
        vm.prank(ALICE);
        market.setApprovalForAll(address(marketplace), true);
        vm.prank(CAROL);
        market.setApprovalForAll(address(marketplace), true);
    }

    function place(address owner, Book.Side side, uint128 units, uint128 price, bool autoMatch)
        internal
        returns (uint256)
    {
        vm.prank(owner);
        return marketplace.createOrder(
            address(market), 0, side, units, price, uint64(block.timestamp + 1 days), autoMatch
        );
    }

    function testDeploymentDefaultsWholeAndGovernanceOnly() public {
        Book fresh = new Book(
            address(factory), address(emergency), address(feeVault), address(usdc), address(0)
        );
        assertFalse(fresh.defaultAllowPartialFills());
        assertEq(fresh.fillPolicyVersion(), 1);
        vm.prank(ALICE);
        vm.expectRevert(Book.Unauthorized.selector);
        fresh.setDefaultAllowPartialFills(true);
        fresh.setDefaultAllowPartialFills(true);
        assertTrue(fresh.defaultAllowPartialFills());
    }

    function testTenVsFiveDoesNotFillButTenVsTenDoes() public {
        uint256 ask = place(ALICE, Book.Side.Ask, 10e6, 800_000, true);
        uint256 small = place(BOB, Book.Side.Bid, 5e6, 1e6, true);
        assertEq(marketplace.matchOrdersForUnits(address(market), 0, 5e6, 20), 0);
        assertEq(marketplace.matchOrdersForUnits(address(market), 0, 10e6, 20), 0);
        assertEq(marketplace.matchOrders(address(market), 0, 20), 0);
        uint256 bid = place(BOB, Book.Side.Bid, 10e6, 900_000, true);
        assertEq(marketplace.matchOrdersForUnits(address(market), 0, 10e6, 20), 1);
        assertEq(market.balanceOf(BOB, 0), 10e6);
        assertEq(marketplace.bestOrderForUnits(address(market), 0, Book.Side.Bid, 5e6), small);
        assertEq(marketplace.bestOrderForUnits(address(market), 0, Book.Side.Ask, 10e6), 0);
        (,, uint128 remaining,,,,,, bool active,) = marketplace.orders(ask);
        assertEq(remaining, 0);
        assertFalse(active);
        (,,,,,,,, active,) = marketplace.orders(bid);
        assertFalse(active);
        assertEq(usdc.balanceOf(address(marketplace)), marketplace.totalLockedPayment());
    }

    function testManualPartialAndWrongMinimumRevert() public {
        uint256 ask = place(ALICE, Book.Side.Ask, 10e6, 800_000, false);
        vm.startPrank(BOB);
        vm.expectRevert(Book.WholeOrderRequired.selector);
        marketplace.fillOrder(ask, 5e6, 5e6, 10e6, uint64(block.timestamp + 60));
        vm.expectRevert(Book.WholeOrderRequired.selector);
        marketplace.fillOrder(ask, 10e6, 5e6, 10e6, uint64(block.timestamp + 60));
        marketplace.fillOrder(ask, 10e6, 10e6, 10e6, uint64(block.timestamp + 60));
        vm.stopPrank();
        assertEq(market.balanceOf(BOB, 0), 10e6);
    }

    function testSnapshotMixedModesAndReindexAfterPartialFill() public {
        uint256 whole = place(ALICE, Book.Side.Ask, 10e6, 900_000, true);
        marketplace.setDefaultAllowPartialFills(true);
        uint256 partialAsk = place(ALICE, Book.Side.Ask, 10e6, 1e6, true);
        uint256 bid = place(BOB, Book.Side.Bid, 5e6, 1e6, true);
        assertFalse(marketplace.orderAllowsPartialFills(whole));
        assertTrue(marketplace.orderAllowsPartialFills(partialAsk));
        assertEq(marketplace.matchOrders(address(market), 0, 1), 1);
        assertEq(marketplace.bestOrderForUnits(address(market), 0, Book.Side.Ask, 5e6), partialAsk);
        assertEq(marketplace.bestOrderForUnits(address(market), 0, Book.Side.Ask, 10e6), whole);
        marketplace.setDefaultAllowPartialFills(false);
        uint256 wholeBid = place(BOB, Book.Side.Bid, 5e6, 1e6, true);
        assertEq(marketplace.matchOrdersForUnits(address(market), 0, 5e6, 1), 1);
        assertEq(marketplace.bestPartialOrder(address(market), 0, Book.Side.Ask), 0);
        (,,,,,,,, bool active,) = marketplace.orders(bid);
        assertFalse(active);
        (,,,,,,,, active,) = marketplace.orders(wholeBid);
        assertFalse(active);
    }

    function testQuantityPriceFifoAndCancelRemovesEveryIndex() public {
        uint256 first = place(ALICE, Book.Side.Ask, 5e6, 900_000, true);
        uint256 second = place(CAROL, Book.Side.Ask, 5e6, 900_000, true);
        uint256 cheaper = place(ALICE, Book.Side.Ask, 5e6, 800_000, true);
        place(BOB, Book.Side.Bid, 5e6, 1e6, true);
        assertEq(marketplace.bestOrderForUnits(address(market), 0, Book.Side.Ask, 5e6), cheaper);
        marketplace.matchOrdersForUnits(address(market), 0, 5e6, 1);
        assertEq(marketplace.bestOrderForUnits(address(market), 0, Book.Side.Ask, 5e6), first);
        vm.prank(ALICE);
        marketplace.cancelOrder(first);
        assertEq(marketplace.bestOrderForUnits(address(market), 0, Book.Side.Ask, 5e6), second);
        vm.warp(block.timestamp + 1 days);
        marketplace.releaseOrder(second);
        assertEq(marketplace.bestOrderForUnits(address(market), 0, Book.Side.Ask, 5e6), 0);
        assertEq(marketplace.bookSize(address(market), 0, Book.Side.Ask), 0);
    }

    function testWholeRejectingReceiverDoesNotBlockQuantityQueue() public {
        RejectingBuyer rejector = new RejectingBuyer();
        usdc.mint(address(rejector), 1e6);
        rejector.place(marketplace, address(usdc), address(market));
        uint256 bid = place(BOB, Book.Side.Bid, 1e6, 1e6, true);
        place(ALICE, Book.Side.Ask, 1e6, 1e6, true);
        assertEq(marketplace.matchOrdersForUnits(address(market), 0, 1e6, 2), 1);
        assertEq(marketplace.bestOrderForUnits(address(market), 0, Book.Side.Bid, 1e6), 0);
        (,,,,,,,, bool active,) = marketplace.orders(bid);
        assertFalse(active);
        assertEq(usdc.balanceOf(address(rejector)), 1e6);
    }

    function testWholeCallbackCannotReenterLegacyMatcher() public {
        ReenteringBuyer receiver = new ReenteringBuyer();
        usdc.mint(address(receiver), 1e6);
        receiver.place(marketplace, address(usdc), address(market));
        place(ALICE, Book.Side.Ask, 1e6, 1e6, true);
        assertEq(marketplace.matchOrdersForUnits(address(market), 0, 1e6, 1), 1);
        assertTrue(receiver.attempted());
        assertFalse(receiver.reentered());
    }

    function testFuzzWholeFillConservesEscrow(uint128 quantity, uint128 price) public {
        quantity = uint128(bound(quantity, 10_000, 20e6));
        price = uint128(bound(price, 500_000, 1e6));
        uint256 before = usdc.balanceOf(BOB);
        place(ALICE, Book.Side.Ask, quantity, price, true);
        place(BOB, Book.Side.Bid, quantity, 1e6, true);
        assertEq(marketplace.matchOrdersForUnits(address(market), 0, quantity, 1), 1);
        assertEq(market.balanceOf(BOB, 0), quantity);
        assertEq(before - usdc.balanceOf(BOB), uint256(quantity) * price / 1e6);
        assertEq(marketplace.totalLockedPayment(), 0);
        assertEq(usdc.balanceOf(address(marketplace)), 0);
        assertEq(marketplace.bookSize(address(market), 0, Book.Side.Ask), 0);
        assertEq(marketplace.bookSize(address(market), 0, Book.Side.Bid), 0);
    }
}
