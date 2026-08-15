// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";
import { VmSafe } from "forge-std/Vm.sol";
import { IEntryPoint } from "@account-abstraction/interfaces/IEntryPoint.sol";
import { IPaymaster } from "@account-abstraction/interfaces/IPaymaster.sol";
import { PackedUserOperation } from "@account-abstraction/interfaces/PackedUserOperation.sol";
import { EmergencyControllerV1 } from "../../src/core/EmergencyControllerV1.sol";
import { SponsorshipPaymasterV1 } from "../../src/paymaster/SponsorshipPaymasterV1.sol";
import {
    Unauthorized,
    ZeroAddress,
    InvalidConfiguration,
    SponsorshipExpired,
    UnsupportedUserOperation,
    SponsorshipBudgetExceeded
} from "../../src/libraries/ProtocolErrors.sol";

contract MockEntryPointAccounting {
    mapping(address => uint256) public deposits;
    mapping(address => uint256) public stakes;
    mapping(address => bool) public stakeUnlocked;
    uint32 public lastUnstakeDelay;

    function depositTo(address account) external payable {
        deposits[account] += msg.value;
    }

    function withdrawTo(address payable recipient, uint256 amount) external {
        deposits[msg.sender] -= amount;
        (bool sent,) = recipient.call{ value: amount }("");
        require(sent, "withdraw failed");
    }

    function addStake(uint32 unstakeDelaySec) external payable {
        stakes[msg.sender] += msg.value;
        lastUnstakeDelay = unstakeDelaySec;
    }

    function unlockStake() external {
        stakeUnlocked[msg.sender] = true;
    }

    function withdrawStake(address payable recipient) external {
        require(stakeUnlocked[msg.sender], "stake locked");
        uint256 amount = stakes[msg.sender];
        stakes[msg.sender] = 0;
        (bool sent,) = recipient.call{ value: amount }("");
        require(sent, "stake withdraw failed");
    }

    function balanceOf(address account) external view returns (uint256) {
        return deposits[account];
    }

    function executeSponsored(
        SponsorshipPaymasterV1 paymaster,
        PackedUserOperation calldata userOp,
        uint256 maxCost,
        uint256 prePostOpGasCost,
        uint256 finalActualCost,
        uint256 actualUserOpFeePerGas
    ) external {
        require(finalActualCost <= maxCost, "actual cost above prefund");
        deposits[address(paymaster)] -= maxCost;
        (bytes memory context, uint256 validationData) =
            paymaster.validatePaymasterUserOp(userOp, bytes32(0), maxCost);
        require(validationData & type(uint160).max == 0, "invalid sponsorship");
        paymaster.postOp(
            IPaymaster.PostOpMode.opSucceeded, context, prePostOpGasCost, actualUserOpFeePerGas
        );
        deposits[address(paymaster)] += maxCost - finalActualCost;
    }
}

contract PaymasterEdgesTest is Test {
    uint256 internal constant SPONSOR_KEY = 0x51A7;
    uint256 internal constant NEW_SPONSOR_KEY = 0xBEEF;
    address internal constant EMERGENCY_SAFE = address(0xE911);
    address internal constant USER = address(0xA11CE);
    address internal constant OTHER_USER = address(0xB0B);
    uint128 internal constant PAYMASTER_VERIFICATION_GAS = 150_000;
    uint128 internal constant PAYMASTER_POST_OP_GAS = 100_000;

    EmergencyControllerV1 internal emergency;
    MockEntryPointAccounting internal mockEntryPoint;
    SponsorshipPaymasterV1 internal paymaster;

    function setUp() public {
        emergency = new EmergencyControllerV1(address(this), EMERGENCY_SAFE);
        mockEntryPoint = new MockEntryPointAccounting();
        paymaster = _deploy(0.01 ether, 0.02 ether, 0.05 ether);
        vm.deal(address(this), 10 ether);
    }

    function testConstructorRejectsZeroDependenciesAndInvalidBudgetHierarchy() public {
        vm.expectRevert(ZeroAddress.selector);
        new SponsorshipPaymasterV1(
            address(0),
            address(emergency),
            IEntryPoint(address(mockEntryPoint)),
            vm.addr(SPONSOR_KEY),
            1,
            1,
            1
        );
        vm.expectRevert(ZeroAddress.selector);
        new SponsorshipPaymasterV1(
            address(this),
            address(emergency),
            IEntryPoint(address(0)),
            vm.addr(SPONSOR_KEY),
            1,
            1,
            1
        );
        vm.expectRevert(ZeroAddress.selector);
        new SponsorshipPaymasterV1(
            address(this),
            address(emergency),
            IEntryPoint(address(mockEntryPoint)),
            address(0),
            1,
            1,
            1
        );
        vm.expectPartialRevert(InvalidConfiguration.selector);
        _deploy(0, 1, 1);
        vm.expectPartialRevert(InvalidConfiguration.selector);
        _deploy(2, 1, 2);
        vm.expectPartialRevert(InvalidConfiguration.selector);
        _deploy(1, 2, 1);
    }

    function testGovernanceRotatesSignerAndBudgetsWithHardValidation() public {
        vm.prank(USER);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, USER));
        paymaster.setSponsorSigner(vm.addr(NEW_SPONSOR_KEY));
        vm.expectRevert(ZeroAddress.selector);
        paymaster.setSponsorSigner(address(0));
        paymaster.setSponsorSigner(vm.addr(NEW_SPONSOR_KEY));
        assertEq(paymaster.sponsorSigner(), vm.addr(NEW_SPONSOR_KEY));
        assertEq(paymaster.policyVersion(), 2);

        vm.prank(USER);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, USER));
        paymaster.setBudgets(1, 1, 1);
        vm.expectPartialRevert(InvalidConfiguration.selector);
        paymaster.setBudgets(0, 1, 1);
        vm.expectPartialRevert(InvalidConfiguration.selector);
        paymaster.setBudgets(2, 1, 2);
        vm.expectPartialRevert(InvalidConfiguration.selector);
        paymaster.setBudgets(1, 2, 1);
        paymaster.setBudgets(2, 3, 4);
        assertEq(paymaster.maxCostPerOperation(), 2);
        assertEq(paymaster.maxCostPerUserPerDay(), 3);
        assertEq(paymaster.maxCostGlobalPerDay(), 4);
    }

    function testDepositReceiveWithdrawAndStakeLifecycle() public {
        paymaster.deposit{ value: 1 ether }();
        assertEq(paymaster.getDeposit(), 1 ether);
        (bool sent,) = address(paymaster).call{ value: 0.5 ether }("");
        assertTrue(sent);
        assertEq(paymaster.getDeposit(), 1.5 ether);

        vm.prank(USER);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, USER));
        paymaster.withdrawDepositTo(payable(USER), 0.1 ether);
        vm.expectRevert(ZeroAddress.selector);
        paymaster.withdrawDepositTo(payable(address(0)), 0.1 ether);
        uint256 userBefore = USER.balance;
        paymaster.withdrawDepositTo(payable(USER), 0.4 ether);
        assertEq(USER.balance - userBefore, 0.4 ether);
        assertEq(paymaster.getDeposit(), 1.1 ether);

        vm.prank(USER);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, USER));
        paymaster.addStake{ value: 0.1 ether }(1 days);
        paymaster.addStake{ value: 0.7 ether }(2 days);
        assertEq(mockEntryPoint.stakes(address(paymaster)), 0.7 ether);
        assertEq(mockEntryPoint.lastUnstakeDelay(), 2 days);
        vm.prank(USER);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, USER));
        paymaster.unlockStake();
        paymaster.unlockStake();
        assertTrue(mockEntryPoint.stakeUnlocked(address(paymaster)));
        vm.expectRevert(ZeroAddress.selector);
        paymaster.withdrawStake(payable(address(0)));
        vm.prank(USER);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, USER));
        paymaster.withdrawStake(payable(USER));
        userBefore = USER.balance;
        paymaster.withdrawStake(payable(USER));
        assertEq(USER.balance - userBefore, 0.7 ether);
    }

    function testMalformedTimePolicyAndCostAuthorizationsFailClosed() public {
        PackedUserOperation memory userOp = _baseUserOp(USER, 1);
        vm.prank(address(mockEntryPoint));
        vm.expectRevert(UnsupportedUserOperation.selector);
        paymaster.validatePaymasterUserOp(userOp, bytes32(0), 1);

        userOp.paymasterAndData = _rawPaymasterData(10, 0, 1, paymaster.policyVersion());
        vm.prank(address(mockEntryPoint));
        vm.expectRevert(SponsorshipExpired.selector);
        paymaster.validatePaymasterUserOp(userOp, bytes32(0), 1);

        userOp.paymasterAndData = _rawPaymasterData(10, 10, 1, paymaster.policyVersion());
        vm.prank(address(mockEntryPoint));
        vm.expectRevert(SponsorshipExpired.selector);
        paymaster.validatePaymasterUserOp(userOp, bytes32(0), 1);

        userOp.paymasterAndData =
            _rawPaymasterData(0, type(uint48).max, 1, paymaster.policyVersion() + 1);
        vm.prank(address(mockEntryPoint));
        vm.expectRevert(UnsupportedUserOperation.selector);
        paymaster.validatePaymasterUserOp(userOp, bytes32(0), 1);

        userOp.paymasterAndData =
            _rawPaymasterData(0, type(uint48).max, 1, paymaster.policyVersion());
        vm.prank(address(mockEntryPoint));
        vm.expectRevert(SponsorshipBudgetExceeded.selector);
        paymaster.validatePaymasterUserOp(userOp, bytes32(0), 2);

        userOp.paymasterAndData =
            _rawPaymasterData(0, type(uint48).max, 0.02 ether, paymaster.policyVersion());
        vm.prank(address(mockEntryPoint));
        vm.expectRevert(SponsorshipBudgetExceeded.selector);
        paymaster.validatePaymasterUserOp(userOp, bytes32(0), 0.02 ether);

        userOp.paymasterAndData = _rawPaymasterDataWithGas(
            paymaster.MIN_PAYMASTER_VERIFICATION_GAS_LIMIT() - 1,
            PAYMASTER_POST_OP_GAS,
            0,
            type(uint48).max,
            1,
            paymaster.policyVersion()
        );
        vm.prank(address(mockEntryPoint));
        vm.expectPartialRevert(InvalidConfiguration.selector);
        paymaster.validatePaymasterUserOp(userOp, bytes32(0), 1);

        userOp.paymasterAndData = _rawPaymasterDataWithGas(
            paymaster.MAX_PAYMASTER_VERIFICATION_GAS_LIMIT() + 1,
            PAYMASTER_POST_OP_GAS,
            0,
            type(uint48).max,
            1,
            paymaster.policyVersion()
        );
        vm.prank(address(mockEntryPoint));
        vm.expectPartialRevert(InvalidConfiguration.selector);
        paymaster.validatePaymasterUserOp(userOp, bytes32(0), 1);

        userOp.paymasterAndData = _rawPaymasterDataWithGas(
            PAYMASTER_VERIFICATION_GAS,
            paymaster.MIN_PAYMASTER_POST_OP_GAS_LIMIT() - 1,
            0,
            type(uint48).max,
            1,
            paymaster.policyVersion()
        );
        vm.prank(address(mockEntryPoint));
        vm.expectPartialRevert(InvalidConfiguration.selector);
        paymaster.validatePaymasterUserOp(userOp, bytes32(0), 1);

        userOp.paymasterAndData = _rawPaymasterDataWithGas(
            PAYMASTER_VERIFICATION_GAS,
            paymaster.MAX_PAYMASTER_POST_OP_GAS_LIMIT() + 1,
            0,
            type(uint48).max,
            1,
            paymaster.policyVersion()
        );
        vm.prank(address(mockEntryPoint));
        vm.expectPartialRevert(InvalidConfiguration.selector);
        paymaster.validatePaymasterUserOp(userOp, bytes32(0), 1);
    }

    function testPackedHeaderRejectsDifferentPaymasterAddress() public {
        PackedUserOperation memory userOp = _baseUserOp(USER, 1);
        userOp.paymasterAndData =
            _rawPaymasterData(0, type(uint48).max, 1, paymaster.policyVersion());
        userOp.paymasterAndData[0] = bytes1(uint8(userOp.paymasterAndData[0]) ^ 1);

        vm.prank(address(mockEntryPoint));
        vm.expectRevert(UnsupportedUserOperation.selector);
        paymaster.validatePaymasterUserOp(userOp, bytes32(0), 1);
    }

    function testReservedUserAndGlobalBudgetsIncludeConcurrentOperations() public {
        SponsorshipPaymasterV1 tight = _deploy(10, 10, 15);
        PackedUserOperation memory first = _signedUserOp(tight, USER, 1, 10);
        vm.prank(address(mockEntryPoint));
        tight.validatePaymasterUserOp(first, bytes32(0), 10);

        PackedUserOperation memory sameUser = _signedUserOp(tight, USER, 2, 1);
        vm.prank(address(mockEntryPoint));
        vm.expectRevert(SponsorshipBudgetExceeded.selector);
        tight.validatePaymasterUserOp(sameUser, bytes32(0), 1);

        PackedUserOperation memory otherUser = _signedUserOp(tight, OTHER_USER, 3, 10);
        vm.prank(address(mockEntryPoint));
        vm.expectRevert(SponsorshipBudgetExceeded.selector);
        tight.validatePaymasterUserOp(otherUser, bytes32(0), 10);
        assertEq(tight.reservedGlobalByDay(block.timestamp / 1 days), 10);
    }

    function testPostOpAuthorizationAndChargeAreCappedAtReservation() public {
        PackedUserOperation memory userOp = _signedUserOp(paymaster, USER, 7, 0.005 ether);
        vm.prank(address(mockEntryPoint));
        (bytes memory context,) = paymaster.validatePaymasterUserOp(userOp, bytes32(0), 0.005 ether);
        vm.prank(USER);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, USER));
        paymaster.postOp(IPaymaster.PostOpMode.opReverted, context, 1 ether, 1 gwei);

        vm.prank(address(mockEntryPoint));
        paymaster.postOp(IPaymaster.PostOpMode.postOpReverted, context, 1 ether, type(uint256).max);
        uint256 day = block.timestamp / 1 days;
        assertEq(paymaster.reservedUserByDay(day, USER), 0);
        assertEq(paymaster.reservedGlobalByDay(day), 0);
        assertEq(paymaster.spentUserByDay(day, USER), 0.005 ether);
        assertEq(paymaster.spentGlobalByDay(day), 0.005 ether);
    }

    function testEntryPointRefundCannotMakeBudgetLossBoundOptimistic() public {
        paymaster.deposit{ value: 0.05 ether }();
        uint256 depositBefore = paymaster.getDeposit();

        for (uint256 nonce; nonce < 2; ++nonce) {
            PackedUserOperation memory userOp =
                _signedUserOp(paymaster, USER, nonce + 100, 0.01 ether);
            mockEntryPoint.executeSponsored(
                paymaster, userOp, 0.01 ether, 0.004 ether, 0.006 ether, 1 gwei
            );
        }

        uint256 day = block.timestamp / 1 days;
        assertEq(paymaster.spentUserByDay(day, USER), 0.02 ether);
        assertEq(paymaster.spentGlobalByDay(day), 0.02 ether);
        assertEq(depositBefore - paymaster.getDeposit(), 0.012 ether);

        PackedUserOperation memory overBudget = _signedUserOp(paymaster, USER, 999, 1);
        vm.prank(address(mockEntryPoint));
        vm.expectRevert(SponsorshipBudgetExceeded.selector);
        paymaster.validatePaymasterUserOp(overBudget, bytes32(0), 1);
    }

    function testGasGatePaymasterValidationAndPostOpUnder150k() public {
        paymaster.deposit{ value: 0.05 ether }();
        PackedUserOperation memory userOp = _signedUserOp(paymaster, USER, 700, 0.01 ether);

        uint256 gasBefore = gasleft();
        mockEntryPoint.executeSponsored(
            paymaster, userOp, 0.01 ether, 0.004 ether, 0.006 ether, 1 gwei
        );
        uint256 gasUsed = gasBefore - gasleft();

        emit log_named_uint("Paymaster validation and postOp gas", gasUsed);
        // Coverage recompiles with minimum optimization. The sponsored operation still executes,
        // while the production-viaIR gas runner remains the authoritative threshold gate.
        if (!vm.isContext(VmSafe.ForgeContext.Coverage)) assertLt(gasUsed, 150_000);
    }

    function _deploy(uint256 operation, uint256 userDaily, uint256 globalDaily)
        internal
        returns (SponsorshipPaymasterV1 deployed)
    {
        deployed = new SponsorshipPaymasterV1(
            address(this),
            address(emergency),
            IEntryPoint(address(mockEntryPoint)),
            vm.addr(SPONSOR_KEY),
            operation,
            userDaily,
            globalDaily
        );
    }

    function _baseUserOp(address sender, uint256 nonce)
        internal
        pure
        returns (PackedUserOperation memory userOp)
    {
        userOp.sender = sender;
        userOp.nonce = nonce;
        userOp.initCode = "";
        userOp.callData =
            abi.encodeWithSignature("execute(address,uint256,bytes)", address(1), 0, "");
        userOp.accountGasLimits = bytes32((uint256(500_000) << 128) | uint256(500_000));
        userOp.preVerificationGas = 100_000;
        userOp.gasFees = bytes32((uint256(1 gwei) << 128) | uint256(2 gwei));
        userOp.signature = hex"1234";
    }

    function _signedUserOp(
        SponsorshipPaymasterV1 target,
        address sender,
        uint256 nonce,
        uint256 maxCost
    ) internal view returns (PackedUserOperation memory userOp) {
        userOp = _baseUserOp(sender, nonce);
        uint48 validAfter = uint48(block.timestamp - 1);
        uint48 validUntil = uint48(block.timestamp + 1 hours);
        uint32 policy = target.policyVersion();
        bytes32 digest = target.sponsorshipDigest(
            userOp,
            PAYMASTER_VERIFICATION_GAS,
            PAYMASTER_POST_OP_GAS,
            validAfter,
            validUntil,
            maxCost,
            policy
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SPONSOR_KEY, digest);
        bytes memory header =
            abi.encodePacked(address(target), PAYMASTER_VERIFICATION_GAS, PAYMASTER_POST_OP_GAS);
        bytes memory authorization =
            abi.encodePacked(validAfter, validUntil, maxCost, policy, r, s, v);
        userOp.paymasterAndData = bytes.concat(header, authorization);
    }

    function _rawPaymasterData(uint48 validAfter, uint48 validUntil, uint256 maxCost, uint32 policy)
        internal
        view
        returns (bytes memory)
    {
        return _rawPaymasterDataWithGas(
            PAYMASTER_VERIFICATION_GAS,
            PAYMASTER_POST_OP_GAS,
            validAfter,
            validUntil,
            maxCost,
            policy
        );
    }

    function _rawPaymasterDataWithGas(
        uint128 verificationGasLimit,
        uint128 postOpGasLimit,
        uint48 validAfter,
        uint48 validUntil,
        uint256 maxCost,
        uint32 policy
    ) internal view returns (bytes memory) {
        bytes memory header =
            abi.encodePacked(address(paymaster), verificationGasLimit, postOpGasLimit);
        bytes memory authorization = abi.encodePacked(
            validAfter, validUntil, maxCost, policy, bytes32(0), bytes32(0), uint8(0)
        );
        return bytes.concat(header, authorization);
    }
}
