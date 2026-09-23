// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";
import { TradingSessionPolicyV2 as Policy } from "../../src/core/TradingSessionPolicyV2.sol";
import { PackedUserOperation } from "@account-abstraction/interfaces/PackedUserOperation.sol";

contract OrderSessionRegistryFixture {
    mapping(address => bool) public isMarket;
    address public marketplace;

    function initializeMarket(address market, bytes calldata data) external {
        isMarket[market] = true;
        (bool success, bytes memory result) = market.call(data);
        if (!success) assembly { revert(add(result, 32), mload(result)) }
    }

    function register(address market) external {
        isMarket[market] = true;
    }
}

contract OrderSessionFixture {
    struct Order {
        address market;
        address owner;
        uint128 units;
        uint128 price;
        uint64 expires;
        uint8 outcome;
        uint8 side;
        bool autoMatch;
        bool active;
        uint256 locked;
    }
    mapping(uint256 => Order) public orders;

    function add(uint256 id, address market, address owner, uint8 side) external {
        orders[id] = Order(market, owner, 100, 1, type(uint64).max, 0, side, true, true, 100);
    }
}

contract TradingSessionPolicyV2Test is Test {
    Policy policy;
    OrderSessionRegistryFixture registry;
    OrderSessionFixture listings;
    address account = address(0xA11CE);
    address other = address(0xB0B);
    address market = address(0x100);
    address legacy = address(0x101);
    address token = address(0x200);
    address bond = address(0x300);
    address fee = address(0x400);
    address paymaster = address(0x500);
    bytes32 id = bytes32(bytes4(0x12345678));
    uint48 start = 1000;
    uint48 end = 87_400;

    function setUp() public {
        registry = new OrderSessionRegistryFixture();
        listings = new OrderSessionFixture();
        registry.register(market);
        registry.register(legacy);
        policy = new Policy(address(registry), address(listings), token, bond, fee, paymaster);
        install(account, id, 100, 200);
    }

    function install(address a, bytes32 key, uint128 per, uint128 total) internal {
        vm.prank(a);
        policy.onInstall(abi.encodePacked(key, abi.encode(per, total, start, end)));
    }

    function encoded(Policy.Call[] memory c) internal pure returns (bytes memory) {
        bytes memory payload =
            c.length == 1 ? abi.encodePacked(c[0].target, c[0].value, c[0].data) : abi.encode(c);
        bytes32 mode = c.length == 1 ? bytes32(0) : bytes32(uint256(1) << 248);
        return abi.encodeWithSignature("execute(bytes32,bytes)", mode, payload);
    }

    function op(Policy.Call[] memory c) internal view returns (PackedUserOperation memory u) {
        u.sender = account;
        u.paymasterAndData = abi.encodePacked(paymaster, uint128(100_000), uint128(100_000));
        u.callData = abi.encodePacked(
            bytes4(
                keccak256(
                    "executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)"
                )
            ),
            encoded(c)
        );
    }

    function buy(address target, uint256 amount) internal view returns (Policy.Call[] memory c) {
        c = new Policy.Call[](4);
        c[0] = Policy.Call(token, 0, abi.encodeWithSignature("approve(address,uint256)", target, 0));
        c[1] = Policy.Call(
            token, 0, abi.encodeWithSignature("approve(address,uint256)", target, amount)
        );
        c[2] = Policy.Call(
            target,
            0,
            abi.encodeWithSignature(
                "buy(uint256,uint256,uint256,uint256,uint64)", 0, 10, 1, amount, type(uint64).max
            )
        );
        c[3] = c[0];
    }

    function validate(Policy.Call[] memory c) internal returns (uint256) {
        vm.prank(account);
        return policy.checkUserOpPolicy(id, op(c));
    }

    function hook(Policy.Call[] memory c) internal {
        vm.prank(account);
        policy.preCheck(address(this), 0, encoded(c));
    }

    function spent(address a) internal view returns (uint128 n) {
        (,, n,,,,) = policy.sessionState(id, a);
    }

    function one(address target, bytes memory data) internal pure returns (Policy.Call[] memory c) {
        c = new Policy.Call[](1);
        c[0] = Policy.Call(target, 0, data);
    }

    function bid(uint256 units, uint256 price) internal view returns (Policy.Call[] memory c) {
        uint256 reserved = (units * price + 999_999) / 1e6;
        c = buy(address(listings), reserved);
        c[2].data = abi.encodeWithSignature(
            "createOrder(address,uint8,uint8,uint128,uint128,uint64,bool)",
            market,
            0,
            0,
            units,
            price,
            type(uint64).max,
            true
        );
    }

    function testBidBudgetRoundsUpAndRevokesTokenApproval() public {
        Policy.Call[] memory c = bid(101, 500_000);
        validate(c);
        hook(c);
        assertEq(spent(account), 51);
        c[3].data = abi.encodeWithSignature("approve(address,uint256)", address(listings), 1);
        vm.expectRevert(Policy.ForbiddenCall.selector);
        validate(c);
    }

    function testAskOnlyApprovesItsRegisteredMarket() public {
        Policy.Call[] memory c = new Policy.Call[](3);
        c[0] = Policy.Call(
            market,
            0,
            abi.encodeWithSignature("setApprovalForAll(address,bool)", address(listings), true)
        );
        c[1] = Policy.Call(
            address(listings),
            0,
            abi.encodeWithSignature(
                "createOrder(address,uint8,uint8,uint128,uint128,uint64,bool)",
                market,
                0,
                1,
                100,
                1e6,
                type(uint64).max,
                true
            )
        );
        c[2] = Policy.Call(
            market,
            0,
            abi.encodeWithSignature("setApprovalForAll(address,bool)", address(listings), false)
        );
        validate(c);
        hook(c);
        assertEq(spent(account), 0);
        c[0].target = other;
        vm.expectRevert(Policy.ForbiddenCall.selector);
        hook(c);
    }

    function testBuyingBidCannotUsePaymentOnlyShape() public {
        listings.add(1, market, other, 0);
        Policy.Call[] memory c = buy(address(listings), 100);
        c[2].data = abi.encodeWithSignature(
            "fillOrder(uint256,uint128,uint128,uint256,uint64)", 1, 100, 100, 100, type(uint64).max
        );
        vm.expectRevert(Policy.ForbiddenCall.selector);
        hook(c);
        listings.add(1, market, other, 1);
        hook(c);
        validate(c);
        assertEq(spent(account), 100);
    }

    function testSellingToBidRequiresCorrectMarketApprovalAndChargesNoSpend() public {
        listings.add(1, market, other, 0);
        Policy.Call[] memory c = new Policy.Call[](3);
        c[0] = Policy.Call(
            market,
            0,
            abi.encodeWithSignature("setApprovalForAll(address,bool)", address(listings), true)
        );
        c[1] = Policy.Call(
            address(listings),
            0,
            abi.encodeWithSignature(
                "fillOrder(uint256,uint128,uint128,uint256,uint64)",
                1,
                100,
                100,
                100,
                type(uint64).max
            )
        );
        c[2] = Policy.Call(
            market,
            0,
            abi.encodeWithSignature("setApprovalForAll(address,bool)", address(listings), false)
        );
        hook(c);
        validate(c);
        assertEq(spent(account), 0);
        listings.add(1, market, account, 0);
        vm.expectRevert(Policy.ForbiddenCall.selector);
        hook(c);
    }

    function testCancelOnlyOwnedOrdersAndClaimsOnlyToSelf() public {
        listings.add(1, market, other, 0);
        vm.expectRevert(Policy.ForbiddenCall.selector);
        hook(one(address(listings), abi.encodeWithSignature("cancelOrder(uint256)", 1)));
        listings.add(1, market, account, 0);
        hook(one(address(listings), abi.encodeWithSignature("cancelOrder(uint256)", 1)));
        vm.expectRevert(Policy.ForbiddenCall.selector);
        hook(one(market, abi.encodeWithSignature("claimWinningsFor(address)", other)));
    }

    function testCumulativeBudgetCannotBeResetByRepeatedValidation() public {
        Policy.Call[] memory c = buy(market, 100);
        uint256 window = validate(c);
        assertEq(window, (uint256(end) << 160) | (uint256(start) << 208));
        assertEq(spent(account), 100);
        validate(c);
        assertEq(spent(account), 200);
        vm.expectRevert(Policy.BudgetExceeded.selector);
        validate(c);
        assertEq(spent(account), 200);
    }

    function testRevocationIsAccountScopedAndCannotBeReinstalled() public {
        Policy.Call[] memory c = buy(market, 100);
        vm.prank(other);
        policy.revoke(id);
        vm.expectRevert(Policy.InvalidSession.selector);
        install(other, id, 100, 200);
        validate(c);
        assertEq(spent(account), 100);

        vm.prank(account);
        policy.revoke(id);
        vm.expectRevert(Policy.InvalidSession.selector);
        validate(c);
        vm.expectRevert(Policy.InvalidSession.selector);
        install(account, id, 100, 200);
    }
}
