// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";
import { TradingSessionPolicyV1 as Policy } from "../../src/core/TradingSessionPolicyV1.sol";
import { PackedUserOperation } from "@account-abstraction/interfaces/PackedUserOperation.sol";

contract SessionRegistryFixture {
    mapping(address => bool) public isMarket;
    address public marketplace;
    function initializeMarket(address market,bytes calldata data) external {
        isMarket[market]=true;
        (bool success,bytes memory result)=market.call(data);
        if(!success)assembly {revert(add(result,32),mload(result))}
    }

    function register(address market) external {
        isMarket[market] = true;
    }
}

contract SessionListingFixture {
    struct Listing {
        address market;
        address seller;
        uint128 units;
        uint128 price;
        uint64 expires;
        uint8 outcome;
        bool active;
    }
    mapping(bytes32 => Listing) public listings;

    function add(bytes32 id, address market, address seller) external {
        listings[id] = Listing(market, seller, 100, 1, type(uint64).max, 0, true);
    }
}

contract TradingSessionPolicyTest is Test {
    Policy policy;
    SessionRegistryFixture registry;
    SessionListingFixture listings;
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
        registry = new SessionRegistryFixture();
        listings = new SessionListingFixture();
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
        c[1] =
            Policy.Call(
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

    function testBothMarketVersionsAndExactBudget() public {
        uint256 validationData = validate(buy(market, 100));
        hook(buy(market, 100));
        assertEq(uint48(validationData >> 160), end);
        assertEq(uint48(validationData >> 208), start);
        validate(buy(legacy, 100));
        hook(buy(legacy, 100));
        assertEq(spent(account), 200);
        vm.expectRevert(Policy.BudgetExceeded.selector);
        validate(buy(market, 1));
        // Claims do not replenish the budget.
        validate(one(market, abi.encodeWithSignature("refundFor(address)", account)));
        assertEq(spent(account), 200);
    }

    function testPerOperationAndAccountIsolation() public {
        vm.expectRevert(Policy.BudgetExceeded.selector);
        validate(buy(market, 101));
        install(other, id, 100, 200);
        validate(buy(market, 50));
        assertEq(spent(other), 0);
    }

    function testExecutionFailureRetainsValidationBudget() public {
        Policy.Call[] memory c = buy(other, 75);
        validate(c);
        vm.expectRevert(Policy.ForbiddenCall.selector);
        hook(c);
        assertEq(spent(account), 75);
    }

    function testRevocationAndDuplicateInstallationCannotReset() public {
        validate(buy(market, 50));
        vm.expectRevert(Policy.InvalidSession.selector);
        install(account, id, 100, 200);
        vm.prank(account);
        policy.revoke(id);
        vm.expectRevert(Policy.InvalidSession.selector);
        validate(buy(market, 1));
        vm.expectRevert(Policy.InvalidSession.selector);
        install(account, id, 100, 200);
        assertEq(spent(account), 50);
        bytes32 unused = bytes32(bytes4(0x99999999));
        vm.prank(account);
        policy.revoke(unused);
        vm.expectRevert(Policy.InvalidSession.selector);
        install(account, unused, 100, 200);
    }

    function testRejectsPaymasterAndGenericSignatures() public {
        PackedUserOperation memory u = op(buy(market, 1));
        u.paymasterAndData = "";
        vm.expectRevert(Policy.ForbiddenCall.selector);
        vm.prank(account);
        policy.checkUserOpPolicy(id, u);
        u.paymasterAndData = abi.encodePacked(other, uint128(1), uint128(1));
        vm.expectRevert(Policy.ForbiddenCall.selector);
        vm.prank(account);
        policy.checkUserOpPolicy(id, u);
        vm.expectRevert(Policy.ForbiddenCall.selector);
        policy.checkSignaturePolicy(id, account, bytes32(0), "");
    }

    function testRejectsIncompleteApprovalsExtraCallsTransfersAndDelegatecall() public {
        Policy.Call[] memory c = buy(market, 10);
        c[3] = c[1];
        vm.expectRevert(Policy.ForbiddenCall.selector);
        validate(c);
        vm.expectRevert(Policy.ForbiddenCall.selector);
        validate(one(token, c[1].data));
        vm.expectRevert(Policy.ForbiddenCall.selector);
        validate(one(token, abi.encodeWithSignature("transfer(address,uint256)", other, 10)));
        c = new Policy.Call[](5);
        vm.expectRevert(Policy.ForbiddenCall.selector);
        validate(c);
        PackedUserOperation memory u = op(buy(market, 1));
        u.callData = abi.encodePacked(
            bytes4(u.callData),
            abi.encodeWithSignature(
                "execute(bytes32,bytes)",
                bytes32(uint256(255) << 248),
                abi.encodePacked(other, uint256(0), "")
            )
        );
        vm.expectRevert(Policy.ForbiddenCall.selector);
        vm.prank(account);
        policy.checkUserOpPolicy(id, u);
    }

    function testClaimsAndRecipients() public {
        string[4] memory signatures = [
            "claimWinningsFor(address)",
            "claimEarlyBirdFor(address)",
            "refundFor(address)",
            "claimTimeoutBonusFor(address)"
        ];
        for (uint256 i; i < 4; i++) {
            Policy.Call[] memory c = one(market, abi.encodeWithSignature(signatures[i], account));
            validate(c);
            hook(c);
            vm.expectRevert(Policy.ForbiddenCall.selector);
            validate(one(market, abi.encodeWithSignature(signatures[i], other)));
        }
        hook(one(fee, abi.encodeWithSignature("claimFor(address)", account)));
        hook(one(bond, abi.encodeWithSignature("claimFor(address)", account)));
    }

    function testListingBatchesAndOwnership() public {
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
                "createListing(address,uint256,uint256,uint256,uint64)", market, 0, 10, 1, end
            )
        );
        c[2] = Policy.Call(
            market,
            0,
            abi.encodeWithSignature("setApprovalForAll(address,bool)", address(listings), false)
        );
        validate(c);
        hook(c);
        c[2] = c[0];
        vm.expectRevert(Policy.ForbiddenCall.selector);
        validate(c);
        listings.add(id, market, account);
        hook(one(address(listings), abi.encodeWithSignature("cancelListing(bytes32)", id)));
        hook(one(address(listings), abi.encodeWithSignature("returnTerminalListing(bytes32)", id)));
        listings.add(id, market, other);
        vm.expectRevert(Policy.ForbiddenCall.selector);
        hook(one(address(listings), abi.encodeWithSignature("cancelListing(bytes32)", id)));
        c = buy(address(listings), 30);
        c[2].data = abi.encodeWithSignature(
            "fillListing(bytes32,uint256,uint256,uint256,uint64)", id, 10, 1, 30, end
        );
        validate(c);
        hook(c);
        listings.add(id, other, other);
        vm.expectRevert(Policy.ForbiddenCall.selector);
        hook(c);
    }

    function testBondSettlementChecksCreatorAndClaimRecipient() public {
        vm.mockCall(
            bond,
            abi.encodeWithSignature("bondOf(address)", market),
            abi.encode(account, uint128(10), false)
        );
        Policy.Call[] memory c = new Policy.Call[](2);
        c[0] = Policy.Call(bond, 0, abi.encodeWithSignature("settleBond(address)", market));
        c[1] = Policy.Call(bond, 0, abi.encodeWithSignature("claimFor(address)", account));
        validate(c);
        hook(c);
        vm.mockCall(
            bond,
            abi.encodeWithSignature("bondOf(address)", market),
            abi.encode(other, uint128(10), false)
        );
        vm.expectRevert(Policy.ForbiddenCall.selector);
        hook(c);
        c[1].data = abi.encodeWithSignature("claimFor(address)", other);
        vm.expectRevert(Policy.ForbiddenCall.selector);
        validate(c);
    }

    function testRejectsNativeValueUpgradeAndMalformedBatch() public {
        Policy.Call[] memory c = buy(market, 1);
        c[0].value = 1;
        vm.expectRevert(Policy.ForbiddenCall.selector);
        validate(c);
        vm.expectRevert(Policy.ForbiddenCall.selector);
        validate(one(account, abi.encodeWithSignature("upgradeTo(address)", other)));
        PackedUserOperation memory u = op(buy(market, 1));
        u.callData = abi.encodePacked(u.callData, bytes32(0));
        vm.expectRevert(Policy.ForbiddenCall.selector);
        vm.prank(account);
        policy.checkUserOpPolicy(id, u);
    }

    function testInvalidDuration() public {
        end++;
        vm.expectRevert(Policy.InvalidSession.selector);
        install(other, id, 100, 200);
    }
}
