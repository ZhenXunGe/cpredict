// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;
import { OrderbookTestBase } from "../helpers/OrderbookTestBase.sol";
import { OrderbookMarketplaceV2 as Book } from "../../src/marketplace/OrderbookMarketplaceV2.sol";
import { MarketVaultCoreV1 } from "../../src/market/MarketVaultCoreV1.sol";
import { ProtocolTypes } from "../../src/libraries/ProtocolTypes.sol";
import { ERC1155Holder } from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";

contract RejectingBuyer is ERC1155Holder {
    bool public reject;
    Book public book;

    function place(Book b, address token, address vault) external {
        book = b;
        (bool ok,) = token.call(
            abi.encodeWithSignature("approve(address,uint256)", address(b), type(uint256).max)
        );
        require(ok);
        b.createOrder(vault, 0, Book.Side.Bid, 1e6, 1e6, uint64(block.timestamp + 1 days), true);
        reject = true;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes memory)
        public
        view
        override
        returns (bytes4)
    {
        require(!reject, "reject");
        return this.onERC1155Received.selector;
    }
}

contract OrderbookMarketplaceV2Test is OrderbookTestBase {
    MarketVaultCoreV1 internal market;

    function setUp() public override {
        super.setUp();
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

    function testMakerPriceAndImmediateBidImprovementRefund() public {
        uint256 ask = place(ALICE, Book.Side.Ask, 5e6, 800_000, true);
        uint256 before = usdc.balanceOf(BOB);
        uint256 bid = place(BOB, Book.Side.Bid, 10e6, 1e6, true);
        assertEq(marketplace.matchOrders(address(market), 0, 20), 1);
        assertEq(market.balanceOf(BOB, 0), 5e6);
        assertEq(before - usdc.balanceOf(BOB), 9e6); // 4 spent, 5 still locked
        assertEq(marketplace.totalLockedPayment(), 5e6);
        assertEq(usdc.balanceOf(address(marketplace)), 5e6);
        (,, uint128 remaining,,,,,, bool active,) = marketplace.orders(ask);
        assertEq(remaining, 0);
        assertFalse(active);
        vm.prank(BOB);
        marketplace.cancelOrder(bid);
        assertEq(before - usdc.balanceOf(BOB), 4e6);
    }

    function testOlderBidSetsPriceAndFeesRemainSellerPaid() public {
        uint256 bid = place(BOB, Book.Side.Bid, 2e6, 900_000, true);
        place(ALICE, Book.Side.Ask, 2e6, 700_000, true);
        uint256 before = usdc.balanceOf(ALICE);
        marketplace.matchOrders(address(market), 0, 1);
        assertEq(usdc.balanceOf(ALICE) - before, 1_800_000);
        (,,,,,,,,, uint256 locked) = marketplace.orders(bid);
        assertEq(locked, 0);
    }

    function testPriceThenFIFOAndManualOnlyExcluded() public {
        place(ALICE, Book.Side.Ask, 1e6, 100_000, false);
        uint256 a = place(ALICE, Book.Side.Ask, 1e6, 800_000, true);
        uint256 b = place(CAROL, Book.Side.Ask, 1e6, 700_000, true);
        uint256 c = place(ALICE, Book.Side.Ask, 1e6, 700_000, true);
        assertEq(marketplace.bestOrder(address(market), 0, Book.Side.Ask), b);
        place(BOB, Book.Side.Bid, 1e6, 900_000, true);
        marketplace.matchOrders(address(market), 0, 1);
        assertEq(marketplace.bestOrder(address(market), 0, Book.Side.Ask), c);
        vm.prank(ALICE);
        marketplace.cancelOrder(c);
        assertEq(marketplace.bestOrder(address(market), 0, Book.Side.Ask), a);
    }

    function testManualSellAndBuyAndDustReturn() public {
        uint256 bid = place(BOB, Book.Side.Bid, 25_000, 1e6, false);
        uint256 before = usdc.balanceOf(ALICE);
        vm.prank(ALICE);
        marketplace.fillOrder(bid, 20_000, 20_000, 20_000, uint64(block.timestamp));
        assertEq(usdc.balanceOf(ALICE) - before, 20_000);
        assertEq(marketplace.totalLockedPayment(), 0);
        uint256 ask = place(ALICE, Book.Side.Ask, 25_000, 1e6, false);
        uint256 shares = market.balanceOf(ALICE, 0);
        vm.prank(BOB);
        marketplace.fillOrder(ask, 20_000, 20_000, 20_000, uint64(block.timestamp));
        assertEq(market.balanceOf(ALICE, 0), shares + 5000);
        assertEq(market.balanceOf(address(marketplace), 0), 0);
    }

    function testZeroValueMinimumLotCannotEnterAutomaticBook() public {
        vm.prank(ALICE);
        vm.expectRevert(Book.InvalidOrder.selector);
        marketplace.createOrder(
            address(market), 0, Book.Side.Ask, 30_000, 60, uint64(block.timestamp + 1 days), true
        );
        vm.prank(BOB);
        vm.expectRevert(Book.InvalidOrder.selector);
        marketplace.createOrder(
            address(market), 0, Book.Side.Bid, 30_000, 60, uint64(block.timestamp + 1 days), true
        );
        assertEq(marketplace.bookSize(address(market), 0, Book.Side.Ask), 0);
        assertEq(marketplace.bookSize(address(market), 0, Book.Side.Bid), 0);
    }

    function testZeroValueManualTailIsReleasedAfterPartialFill() public {
        uint256 aliceShares = market.balanceOf(ALICE, 0);
        uint256 ask = place(ALICE, Book.Side.Ask, 30_000, 60, false);
        vm.prank(BOB);
        marketplace.fillOrder(ask, 20_000, 20_000, 1, uint64(block.timestamp));
        (,, uint128 askRemaining,,,,,, bool askActive,) = marketplace.orders(ask);
        assertFalse(askActive);
        assertEq(askRemaining, 0);
        assertEq(market.balanceOf(ALICE, 0), aliceShares - 20_000);

        uint256 bobPayment = usdc.balanceOf(BOB);
        uint256 bid = place(BOB, Book.Side.Bid, 30_000, 60, false);
        vm.prank(CAROL);
        marketplace.fillOrder(bid, 20_000, 20_000, 1, uint64(block.timestamp));
        (,, uint128 bidRemaining,,,,,, bool bidActive, uint256 locked) = marketplace.orders(bid);
        assertFalse(bidActive);
        assertEq(bidRemaining, 0);
        assertEq(locked, 0);
        assertEq(marketplace.totalLockedPayment(), 0);
        assertEq(usdc.balanceOf(BOB), bobPayment - 1);
    }

    function testPauseStillAllowsCancelAndExpiryRelease() public {
        uint256 bid = place(BOB, Book.Side.Bid, 1e6, 1e6, true);
        uint256 ask = place(ALICE, Book.Side.Ask, 1e6, 1e6, true);
        vm.prank(EMERGENCY_SAFE);
        emergency.pause(ProtocolTypes.PAUSE_LISTING_FILL, 1 hours);
        vm.expectRevert(Book.Paused.selector);
        marketplace.matchOrders(address(market), 0, 1);
        vm.prank(BOB);
        marketplace.cancelOrder(bid);
        vm.warp(block.timestamp + 1 days);
        marketplace.releaseOrder(ask);
        assertEq(market.balanceOf(address(marketplace), 0), 0);
        assertEq(marketplace.totalLockedPayment(), 0);
    }

    function testTerminalPermissionlessReturnAndNoCrossMarketFill() public {
        uint256 bid = place(BOB, Book.Side.Bid, 1e6, 1e6, true);
        uint256 ask = place(ALICE, Book.Side.Ask, 1e6, 1e6, true);
        assertEq(marketplace.matchOrders(address(market), 1, 1), 0);
        vm.prank(CREATOR);
        market.creatorVoid(bytes32(0));
        marketplace.releaseOrder(bid);
        marketplace.releaseOrder(ask);
        vm.prank(ALICE);
        market.refund();
        assertEq(marketplace.totalLockedPayment(), 0);
    }

    function testFeesAreSellerPaidAndSeparateMarketEscrowCannotCross() public {
        ProtocolTypes.CreateMarketParams memory p =
            _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        p.creatorC2CFeeBps = 100;
        MarketVaultCoreV1 other = _create(p, keccak256("fee-market"));
        _buy(other, ALICE, 0, 5e6);
        vm.prank(ALICE);
        other.setApprovalForAll(address(marketplace), true);
        vm.prank(ALICE);
        marketplace.createOrder(
            address(other), 0, Book.Side.Ask, 1e6, 1e6, uint64(block.timestamp + 1 days), true
        );
        place(BOB, Book.Side.Bid, 1e6, 1e6, true);
        assertEq(marketplace.matchOrders(address(market), 0, 1), 0);
        assertEq(marketplace.matchOrders(address(other), 0, 1), 0);
        vm.prank(BOB);
        marketplace.createOrder(
            address(other), 0, Book.Side.Bid, 1e6, 1e6, uint64(block.timestamp + 1 days), true
        );
        uint256 before = usdc.balanceOf(ALICE);
        marketplace.matchOrders(address(other), 0, 1);
        assertEq(usdc.balanceOf(ALICE) - before, 990_000);
        assertEq(feeVault.creditOf(CREATOR_TREASURY), 10_000);
        assertEq(other.totalPrincipal(), 5e6);
        assertEq(market.totalPrincipal(), 60e6);
    }

    function testSelfCrossCancelsNewerOnly() public {
        uint256 ask = place(ALICE, Book.Side.Ask, 1e6, 1e6, true);
        uint256 bid = place(ALICE, Book.Side.Bid, 1e6, 1e6, true);
        assertEq(marketplace.matchOrders(address(market), 0, 1), 0);
        (,,,,,,,, bool active,) = marketplace.orders(bid);
        assertFalse(active);
        assertEq(marketplace.bestOrder(address(market), 0, Book.Side.Ask), ask);
        assertEq(marketplace.totalLockedPayment(), 0);
    }

    function testReceiverRejectionIsAtomic() public {
        RejectingBuyer buyer = new RejectingBuyer();
        usdc.mint(address(buyer), 1e6);
        place(ALICE, Book.Side.Ask, 1e6, 1e6, true);
        buyer.place(marketplace, address(usdc), address(market));
        uint256 before = usdc.balanceOf(ALICE);
        vm.expectRevert();
        marketplace.matchOrders(address(market), 0, 1);
        assertEq(usdc.balanceOf(ALICE), before);
        assertEq(marketplace.totalLockedPayment(), 1e6);
        assertEq(market.balanceOf(address(marketplace), 0), 1e6);
    }

    function testFuzzPartialFillConservesFunds(
        uint128 unitsSeed,
        uint128 priceSeed,
        uint128 fillSeed
    ) public {
        uint128 units = uint128(bound(unitsSeed, 20_000, 10e6));
        uint128 price = uint128(bound(priceSeed, 100, 1000e6));
        uint128 fill = uint128(bound(fillSeed, 10_000, units));
        uint256 initial = usdc.balanceOf(BOB) + usdc.balanceOf(ALICE);
        uint256 id = place(BOB, Book.Side.Bid, units, price, false);
        vm.prank(ALICE);
        marketplace.fillOrder(id, fill, fill, 0, uint64(block.timestamp));
        assertEq(usdc.balanceOf(address(marketplace)), marketplace.totalLockedPayment());
        assertEq(
            usdc.balanceOf(BOB) + usdc.balanceOf(ALICE) + marketplace.totalLockedPayment(), initial
        );
        (,,,,,,,, bool active,) = marketplace.orders(id);
        if (active) {
            vm.prank(BOB);
            marketplace.cancelOrder(id);
        }
        assertEq(usdc.balanceOf(BOB) + usdc.balanceOf(ALICE), initial);
        assertEq(marketplace.totalLockedPayment(), 0);
    }
}
