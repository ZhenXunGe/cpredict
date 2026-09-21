// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;
import { OrderbookTestBase } from "../helpers/OrderbookTestBase.sol";
import { OrderbookMarketplaceV2 as Book } from "../../src/marketplace/OrderbookMarketplaceV2.sol";
import { MarketVaultCoreV1 } from "../../src/market/MarketVaultCoreV1.sol";

contract OrderbookInvariantTest is OrderbookTestBase {
    MarketVaultCoreV1 internal market;

    function setUp() public override {
        super.setUp();
        market = _createDefault();
        _buy(market, ALICE, 0, 40e6);
        _buy(market, BOB, 0, 40e6);
        vm.prank(ALICE);
        market.setApprovalForAll(address(marketplace), true);
        vm.prank(BOB);
        market.setApprovalForAll(address(marketplace), true);
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = this.step.selector;
        targetSelector(FuzzSelector({ addr: address(this), selectors: selectors }));
        targetContract(address(this));
    }

    function step(uint256 seed, uint128 amountSeed, uint128 priceSeed) external {
        address actor = seed % 2 == 0 ? ALICE : BOB;
        uint128 units = uint128(bound(amountSeed, 10_000, 5e6));
        uint128 price = uint128(bound(priceSeed, 100, 2e6));
        uint256 mode = seed % 4;
        if (mode == 0) {
            vm.prank(actor);
            try marketplace.createOrder(
                address(market),
                0,
                seed % 8 < 4 ? Book.Side.Bid : Book.Side.Ask,
                units,
                price,
                uint64(block.timestamp + 1 days),
                seed % 3 != 0
            ) { }
                catch { }
        } else if (mode == 1 && marketplace.nextOrderId() > 1) {
            uint256 id = 1 + seed % (marketplace.nextOrderId() - 1);
            (, address owner,,,,,,,,) = marketplace.orders(id);
            vm.prank(owner);
            try marketplace.cancelOrder(id) { } catch { }
        } else if (mode == 2) {
            try marketplace.matchOrders(address(market), 0, 3) { } catch { }
        } else if (marketplace.nextOrderId() > 1) {
            uint256 id = 1 + seed % (marketplace.nextOrderId() - 1);
            (,,,,,, Book.Side side,,,) = marketplace.orders(id);
            vm.prank(actor);
            try marketplace.fillOrder(
                id, units, 0, side == Book.Side.Ask ? type(uint256).max : 0, uint64(block.timestamp)
            ) { }
                catch { }
        }
    }

    function invariantEscrowAndQueuesConserveAssets() public view {
        uint256 cash;
        uint256 shares;
        uint256 bestBid;
        uint256 bestAsk;
        uint128 bidPrice;
        uint128 askPrice = type(uint128).max;
        for (uint256 id = 1; id < marketplace.nextOrderId(); id++) {
            (
                ,,
                uint128 remaining,
                uint128 price,,,
                Book.Side side,
                bool autoMatch,
                bool active,
                uint256 locked
            ) = marketplace.orders(id);
            if (!active) {
                assertEq(remaining, 0);
                assertEq(locked, 0);
                continue;
            }
            if (side == Book.Side.Bid) {
                cash += locked;
                assertGe(locked, (uint256(remaining) * price + 999_999) / 1e6);
            } else {
                shares += remaining;
                assertEq(locked, 0);
            }
            if (autoMatch) {
                if (side == Book.Side.Bid && (bestBid == 0 || price > bidPrice)) {
                    bestBid = id;
                    bidPrice = price;
                }
                if (side == Book.Side.Ask && (bestAsk == 0 || price < askPrice)) {
                    bestAsk = id;
                    askPrice = price;
                }
            }
        }
        assertEq(cash, marketplace.totalLockedPayment());
        assertEq(cash, usdc.balanceOf(address(marketplace)));
        assertEq(shares, market.balanceOf(address(marketplace), 0));
        assertEq(marketplace.bestOrder(address(market), 0, Book.Side.Bid), bestBid);
        assertEq(marketplace.bestOrder(address(market), 0, Book.Side.Ask), bestAsk);
        assertEq(market.totalPrincipal(), 80e6);
    }
}
