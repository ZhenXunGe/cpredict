// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";
import { IEntryPoint } from "@account-abstraction/interfaces/IEntryPoint.sol";
import { IPaymaster } from "@account-abstraction/interfaces/IPaymaster.sol";
import { PackedUserOperation } from "@account-abstraction/interfaces/PackedUserOperation.sol";
import { EmergencyControllerV1 } from "../../src/core/EmergencyControllerV1.sol";
import { SponsorshipPaymasterV1 } from "../../src/paymaster/SponsorshipPaymasterV1.sol";
import { ProtocolTypes } from "../../src/libraries/ProtocolTypes.sol";

contract SponsorshipPaymasterTest is Test {
    uint256 internal constant SPONSOR_KEY = 0x51A7;
    address internal constant ENTRY_POINT = address(0x4337);
    address internal constant EMERGENCY_SAFE = address(0xE911);
    address internal constant USER = address(0xA11CE);
    uint128 internal constant PAYMASTER_VERIFICATION_GAS = 150_000;
    uint128 internal constant PAYMASTER_POST_OP_GAS = 100_000;

    EmergencyControllerV1 internal emergency;
    SponsorshipPaymasterV1 internal paymaster;

    function setUp() public {
        emergency = new EmergencyControllerV1(address(this), EMERGENCY_SAFE);
        paymaster = new SponsorshipPaymasterV1(
            address(this),
            address(emergency),
            IEntryPoint(ENTRY_POINT),
            vm.addr(SPONSOR_KEY),
            0.01 ether,
            0.05 ether,
            1 ether
        );
    }

    function testValidSponsorshipReservesAndSettlesBudget() public {
        uint48 validAfter = uint48(block.timestamp - 1);
        uint48 validUntil = uint48(block.timestamp + 1 hours);
        uint256 maxCost = 0.005 ether;
        PackedUserOperation memory userOp = _baseUserOp();
        userOp = _signAndAttach(userOp, validAfter, validUntil, maxCost, SPONSOR_KEY);

        vm.prank(ENTRY_POINT);
        (bytes memory context, uint256 validationData) =
            paymaster.validatePaymasterUserOp(userOp, bytes32(0), maxCost);
        assertEq(validationData & type(uint160).max, 0);
        uint256 day = block.timestamp / 1 days;
        assertEq(paymaster.reservedUserByDay(day, USER), maxCost);
        assertEq(paymaster.reservedGlobalByDay(day), maxCost);

        vm.prank(ENTRY_POINT);
        paymaster.postOp(IPaymaster.PostOpMode.opSucceeded, context, 0.003 ether, 1 gwei);
        assertEq(paymaster.reservedUserByDay(day, USER), 0);
        assertEq(paymaster.spentUserByDay(day, USER), maxCost);
        assertEq(paymaster.spentGlobalByDay(day), maxCost);
    }

    function testInvalidSignatureReturnsSigFailureWithoutReservation() public {
        PackedUserOperation memory userOp = _signAndAttach(
            _baseUserOp(),
            uint48(block.timestamp - 1),
            uint48(block.timestamp + 1 hours),
            0.005 ether,
            0xBAD
        );
        vm.prank(ENTRY_POINT);
        (, uint256 validationData) =
            paymaster.validatePaymasterUserOp(userOp, bytes32(0), 0.005 ether);
        assertEq(validationData & type(uint160).max, 1);
        assertEq(paymaster.reservedGlobalByDay(block.timestamp / 1 days), 0);
    }

    function testSponsorshipCannotReplay() public {
        PackedUserOperation memory userOp = _signAndAttach(
            _baseUserOp(),
            uint48(block.timestamp - 1),
            uint48(block.timestamp + 1 hours),
            0.005 ether,
            SPONSOR_KEY
        );
        vm.prank(ENTRY_POINT);
        paymaster.validatePaymasterUserOp(userOp, bytes32(0), 0.005 ether);
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        paymaster.validatePaymasterUserOp(userOp, bytes32(0), 0.005 ether);
    }

    function testSignedPaymasterGasHeaderCannotBeMutated() public {
        PackedUserOperation memory verificationMutation = _signAndAttach(
            _baseUserOp(),
            uint48(block.timestamp - 1),
            uint48(block.timestamp + 1 hours),
            0.005 ether,
            SPONSOR_KEY
        );
        verificationMutation.paymasterAndData[35] =
            bytes1(uint8(verificationMutation.paymasterAndData[35]) ^ 1);
        vm.prank(ENTRY_POINT);
        (, uint256 verificationValidationData) =
            paymaster.validatePaymasterUserOp(verificationMutation, bytes32(0), 0.005 ether);
        assertEq(verificationValidationData & type(uint160).max, 1);

        PackedUserOperation memory postOpMutation = _baseUserOp();
        postOpMutation.nonce = 8;
        postOpMutation = _signAndAttach(
            postOpMutation,
            uint48(block.timestamp - 1),
            uint48(block.timestamp + 1 hours),
            0.005 ether,
            SPONSOR_KEY
        );
        postOpMutation.paymasterAndData[51] = bytes1(uint8(postOpMutation.paymasterAndData[51]) ^ 1);
        vm.prank(ENTRY_POINT);
        (, uint256 postOpValidationData) =
            paymaster.validatePaymasterUserOp(postOpMutation, bytes32(0), 0.005 ether);
        assertEq(postOpValidationData & type(uint160).max, 1);
    }

    function testEmergencyPauseStopsPaymasterValidation() public {
        PackedUserOperation memory userOp = _signAndAttach(
            _baseUserOp(),
            uint48(block.timestamp - 1),
            uint48(block.timestamp + 1 hours),
            0.005 ether,
            SPONSOR_KEY
        );
        vm.prank(EMERGENCY_SAFE);
        emergency.pause(ProtocolTypes.PAUSE_PAYMASTER, 1 days);
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        paymaster.validatePaymasterUserOp(userOp, bytes32(0), 0.005 ether);
    }

    function testBudgetAndEntryPointAuthorizationAreEnforced() public {
        PackedUserOperation memory userOp = _signAndAttach(
            _baseUserOp(),
            uint48(block.timestamp - 1),
            uint48(block.timestamp + 1 hours),
            0.02 ether,
            SPONSOR_KEY
        );
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        paymaster.validatePaymasterUserOp(userOp, bytes32(0), 0.02 ether);

        vm.expectRevert();
        paymaster.validatePaymasterUserOp(userOp, bytes32(0), 0.005 ether);
    }

    function testSettledSpendContinuesToConsumeDailyBudget() public {
        uint48 validAfter = uint48(block.timestamp - 1);
        uint48 validUntil = uint48(block.timestamp + 1 hours);
        uint256 maxCost = 0.01 ether;

        for (uint256 i; i < 5; ++i) {
            PackedUserOperation memory userOp = _baseUserOp();
            userOp.nonce = i;
            userOp = _signAndAttach(userOp, validAfter, validUntil, maxCost, SPONSOR_KEY);
            vm.prank(ENTRY_POINT);
            (bytes memory context,) = paymaster.validatePaymasterUserOp(userOp, bytes32(0), maxCost);
            vm.prank(ENTRY_POINT);
            paymaster.postOp(IPaymaster.PostOpMode.opSucceeded, context, maxCost, 1 gwei);
        }

        PackedUserOperation memory overBudget = _baseUserOp();
        overBudget.nonce = 99;
        overBudget = _signAndAttach(overBudget, validAfter, validUntil, maxCost, SPONSOR_KEY);
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        paymaster.validatePaymasterUserOp(overBudget, bytes32(0), maxCost);
    }

    function _baseUserOp() internal pure returns (PackedUserOperation memory userOp) {
        userOp.sender = USER;
        userOp.nonce = 7;
        userOp.initCode = "";
        userOp.callData =
            abi.encodeWithSignature("execute(address,uint256,bytes)", address(1), 0, "");
        userOp.accountGasLimits = bytes32((uint256(500_000) << 128) | uint256(500_000));
        userOp.preVerificationGas = 100_000;
        userOp.gasFees = bytes32((uint256(1 gwei) << 128) | uint256(2 gwei));
        userOp.signature = hex"1234";
    }

    function _signAndAttach(
        PackedUserOperation memory userOp,
        uint48 validAfter,
        uint48 validUntil,
        uint256 maxCost,
        uint256 signerKey
    ) internal view returns (PackedUserOperation memory) {
        bytes32 digest = paymaster.sponsorshipDigest(
            userOp,
            PAYMASTER_VERIFICATION_GAS,
            PAYMASTER_POST_OP_GAS,
            validAfter,
            validUntil,
            maxCost,
            paymaster.policyVersion()
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        bytes memory signature = abi.encodePacked(r, s, v);
        userOp.paymasterAndData = abi.encodePacked(
            address(paymaster),
            PAYMASTER_VERIFICATION_GAS,
            PAYMASTER_POST_OP_GAS,
            validAfter,
            validUntil,
            maxCost,
            paymaster.policyVersion(),
            signature
        );
        return userOp;
    }
}
