// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";
import { IEntryPoint } from "@account-abstraction/interfaces/IEntryPoint.sol";
import { PackedUserOperation } from "@account-abstraction/interfaces/PackedUserOperation.sol";
import { EmergencyControllerV1 } from "../../src/core/EmergencyControllerV1.sol";
import { SponsorshipPaymasterV1 } from "../../src/paymaster/SponsorshipPaymasterV1.sol";

/// @dev The canonical flat EIP-712 encoding intentionally requires viaIR because the message has
/// fifteen static fields. Production code supports both compiler pipelines; this reference-vector
/// test is isolated so the legacy-codegen differential suite can exclude only the test helper.
contract SponsorshipDigestTest is Test {
    address internal constant ENTRY_POINT = address(0x4337);
    address internal constant USER = address(0xA11CE);
    uint128 internal constant PAYMASTER_VERIFICATION_GAS = 150_000;
    uint128 internal constant PAYMASTER_POST_OP_GAS = 100_000;
    bytes32 internal constant CANONICAL_SPONSORSHIP_TYPEHASH = keccak256(
        "Sponsorship(address sender,uint256 nonce,bytes32 initCodeHash,bytes32 callDataHash,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,uint128 paymasterVerificationGasLimit,uint128 paymasterPostOpGasLimit,uint48 validAfter,uint48 validUntil,uint256 maxCost,uint32 policyVersion,uint256 chainId,address entryPoint,address paymaster)"
    );

    SponsorshipPaymasterV1 internal paymaster;

    function setUp() public {
        EmergencyControllerV1 emergency = new EmergencyControllerV1(address(this), address(0xE911));
        paymaster = new SponsorshipPaymasterV1(
            address(this),
            address(emergency),
            IEntryPoint(ENTRY_POINT),
            address(0x51A7),
            0.01 ether,
            0.05 ether,
            1 ether
        );
    }

    function testSponsorshipDigestMatchesCanonicalFlatEip712Encoding() public view {
        PackedUserOperation memory userOp;
        userOp.sender = USER;
        userOp.nonce = 7;
        userOp.callData =
            abi.encodeWithSignature("execute(address,uint256,bytes)", address(1), 0, "");
        userOp.accountGasLimits = bytes32((uint256(500_000) << 128) | uint256(500_000));
        userOp.preVerificationGas = 100_000;
        userOp.gasFees = bytes32((uint256(1 gwei) << 128) | uint256(2 gwei));

        uint48 validAfter = uint48(block.timestamp - 1);
        uint48 validUntil = uint48(block.timestamp + 1 hours);
        uint256 maxCost = 0.005 ether;
        uint32 requestedPolicyVersion = paymaster.policyVersion();
        bytes memory structHead = abi.encode(
            CANONICAL_SPONSORSHIP_TYPEHASH,
            userOp.sender,
            userOp.nonce,
            keccak256(userOp.initCode),
            keccak256(userOp.callData),
            userOp.accountGasLimits
        );
        bytes memory structGasAndTime = abi.encode(
            userOp.preVerificationGas,
            userOp.gasFees,
            PAYMASTER_VERIFICATION_GAS,
            PAYMASTER_POST_OP_GAS,
            validAfter,
            validUntil
        );
        bytes memory structPolicyAndDomain = abi.encode(
            maxCost, requestedPolicyVersion, block.chainid, ENTRY_POINT, address(paymaster)
        );
        bytes32 structHash =
            keccak256(bytes.concat(structHead, structGasAndTime, structPolicyAndDomain));
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("Cpredict Sponsorship Paymaster")),
                keccak256(bytes("1")),
                block.chainid,
                address(paymaster)
            )
        );
        bytes32 expected = keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));
        assertEq(paymaster.SPONSORSHIP_TYPEHASH(), CANONICAL_SPONSORSHIP_TYPEHASH);
        assertEq(
            paymaster.sponsorshipDigest(
                userOp,
                PAYMASTER_VERIFICATION_GAS,
                PAYMASTER_POST_OP_GAS,
                validAfter,
                validUntil,
                maxCost,
                requestedPolicyVersion
            ),
            expected
        );
    }
}
