// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IEntryPoint } from "@account-abstraction/interfaces/IEntryPoint.sol";
import { IPaymaster } from "@account-abstraction/interfaces/IPaymaster.sol";
import { PackedUserOperation } from "@account-abstraction/interfaces/PackedUserOperation.sol";
import { IEmergencyControllerV1 } from "../interfaces/IEmergencyControllerV1.sol";
import { ProtocolTypes } from "../libraries/ProtocolTypes.sol";
import {
    Unauthorized,
    ZeroAddress,
    InvalidConfiguration,
    PauseActive,
    SponsorshipExpired,
    InvalidSponsorSignature,
    UnsupportedUserOperation,
    SponsorshipBudgetExceeded
} from "../libraries/ProtocolErrors.sol";

/// @notice EIP-4337 v0.8 free-sponsorship Paymaster with signed policy and bounded loss.
/// @dev Stateful budget reservation requires a bundler that supports staked/stateful paymasters.
contract SponsorshipPaymasterV1 is IPaymaster, EIP712 {
    /// @dev Static tuple matching `SPONSORSHIP_TYPEHASH`; encoding this struct is byte-for-byte
    /// equivalent to encoding each field individually and avoids legacy codegen stack pressure.
    struct SponsorshipMessage {
        bytes32 typeHash;
        address sender;
        uint256 nonce;
        bytes32 initCodeHash;
        bytes32 callDataHash;
        bytes32 accountGasLimits;
        uint256 preVerificationGas;
        bytes32 gasFees;
        uint128 paymasterVerificationGasLimit;
        uint128 paymasterPostOpGasLimit;
        uint48 validAfter;
        uint48 validUntil;
        uint256 maxCost;
        uint32 requestedPolicyVersion;
        uint256 chainId;
        address entryPointAddress;
        address paymasterAddress;
    }

    struct AuthorizationFields {
        uint128 paymasterVerificationGasLimit;
        uint128 paymasterPostOpGasLimit;
        uint48 validAfter;
        uint48 validUntil;
        uint256 maxCost;
        uint32 policyVersion;
    }

    struct AuthorizationValidation {
        bytes32 sponsorshipHash;
        uint32 policyVersion;
        uint256 validationData;
        bool signatureValid;
    }

    uint256 public constant PAYMASTER_VERIFICATION_GAS_OFFSET = 20;
    uint256 public constant PAYMASTER_POST_OP_GAS_OFFSET = 36;
    uint256 public constant PAYMASTER_DATA_OFFSET = 52;
    uint256 public constant SPONSOR_DATA_LENGTH = 113;
    uint128 public constant MIN_PAYMASTER_VERIFICATION_GAS_LIMIT = 150_000;
    uint128 public constant MAX_PAYMASTER_VERIFICATION_GAS_LIMIT = 500_000;
    uint128 public constant MIN_PAYMASTER_POST_OP_GAS_LIMIT = 100_000;
    uint128 public constant MAX_PAYMASTER_POST_OP_GAS_LIMIT = 300_000;
    bytes32 public constant SPONSORSHIP_TYPEHASH = keccak256(
        "Sponsorship(address sender,uint256 nonce,bytes32 initCodeHash,bytes32 callDataHash,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,uint128 paymasterVerificationGasLimit,uint128 paymasterPostOpGasLimit,uint48 validAfter,uint48 validUntil,uint256 maxCost,uint32 policyVersion,uint256 chainId,address entryPoint,address paymaster)"
    );

    IEntryPoint public immutable entryPoint;
    IEmergencyControllerV1 public immutable emergencyController;
    address public immutable governance;

    address public sponsorSigner;
    uint32 public policyVersion = 1;
    uint256 public maxCostPerOperation;
    uint256 public maxCostPerUserPerDay;
    uint256 public maxCostGlobalPerDay;

    mapping(uint256 day => uint256 amount) public reservedGlobalByDay;
    mapping(uint256 day => uint256 amount) public spentGlobalByDay;
    mapping(uint256 day => mapping(address sender => uint256 amount)) public reservedUserByDay;
    mapping(uint256 day => mapping(address sender => uint256 amount)) public spentUserByDay;
    mapping(bytes32 sponsorshipHash => bool consumed) public consumedSponsorship;

    event SponsorSignerUpdated(
        address indexed previousSigner, address indexed newSigner, uint32 policyVersion
    );
    event SponsorshipBudgetsUpdated(
        uint256 maxCostPerOperation, uint256 maxCostPerUserPerDay, uint256 maxCostGlobalPerDay
    );
    event SponsorshipReserved(
        bytes32 indexed sponsorshipHash,
        address indexed sender,
        uint256 indexed day,
        uint256 maxCost,
        uint32 policyVersion
    );
    event SponsorshipSettled(
        address indexed sender,
        uint256 indexed day,
        PostOpMode mode,
        uint256 reservedCost,
        uint256 actualGasCost,
        uint256 actualUserOpFeePerGas,
        uint256 budgetCharge
    );
    event EntryPointDepositAdded(address indexed caller, uint256 amount);
    event EntryPointDepositWithdrawn(address indexed recipient, uint256 amount);
    event EntryPointStakeAdded(uint32 unstakeDelaySec, uint256 amount);
    event EntryPointStakeUnlocked();
    event EntryPointStakeWithdrawn(address indexed recipient);

    constructor(
        address governance_,
        address emergencyController_,
        IEntryPoint entryPoint_,
        address sponsorSigner_,
        uint256 maxCostPerOperation_,
        uint256 maxCostPerUserPerDay_,
        uint256 maxCostGlobalPerDay_
    ) EIP712("Cpredict Sponsorship Paymaster", "1") {
        if (
            governance_ == address(0) || emergencyController_ == address(0)
                || address(entryPoint_) == address(0) || sponsorSigner_ == address(0)
        ) revert ZeroAddress();
        governance = governance_;
        emergencyController = IEmergencyControllerV1(emergencyController_);
        entryPoint = entryPoint_;
        sponsorSigner = sponsorSigner_;
        _setBudgets(maxCostPerOperation_, maxCostPerUserPerDay_, maxCostGlobalPerDay_);
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert Unauthorized(msg.sender);
        _;
    }

    modifier onlyEntryPoint() {
        if (msg.sender != address(entryPoint)) revert Unauthorized(msg.sender);
        _;
    }

    receive() external payable {
        deposit();
    }

    function validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, uint256 maxCost)
        external
        onlyEntryPoint
        returns (bytes memory context, uint256 validationData)
    {
        if (emergencyController.isPaused(ProtocolTypes.PAUSE_PAYMASTER)) {
            revert PauseActive(ProtocolTypes.PAUSE_PAYMASTER);
        }
        AuthorizationValidation memory authorization = _validateAuthorization(userOp, maxCost);
        validationData = authorization.validationData;
        if (!authorization.signatureValid) return ("", validationData);

        context = _reserveSponsorship(
            authorization.sponsorshipHash, userOp.sender, maxCost, authorization.policyVersion
        );
    }

    function _validateAuthorization(PackedUserOperation calldata userOp, uint256 maxCost)
        internal
        view
        returns (AuthorizationValidation memory result)
    {
        if (userOp.paymasterAndData.length != PAYMASTER_DATA_OFFSET + SPONSOR_DATA_LENGTH) {
            revert UnsupportedUserOperation();
        }

        if (
            address(bytes20(userOp.paymasterAndData[:PAYMASTER_VERIFICATION_GAS_OFFSET]))
                != address(this)
        ) revert UnsupportedUserOperation();
        AuthorizationFields memory authorization = AuthorizationFields({
            paymasterVerificationGasLimit: 0,
            paymasterPostOpGasLimit: 0,
            validAfter: 0,
            validUntil: 0,
            maxCost: 0,
            policyVersion: 0
        });
        (authorization.paymasterVerificationGasLimit, authorization.paymasterPostOpGasLimit) =
            _validatedPaymasterGasLimits(userOp.paymasterAndData);
        bytes calldata data = userOp.paymasterAndData[PAYMASTER_DATA_OFFSET:];
        authorization.validAfter = uint48(bytes6(data[0:6]));
        authorization.validUntil = uint48(bytes6(data[6:12]));
        authorization.maxCost = uint256(bytes32(data[12:44]));
        authorization.policyVersion = uint32(bytes4(data[44:48]));
        if (authorization.validUntil == 0 || authorization.validUntil <= authorization.validAfter) {
            revert SponsorshipExpired();
        }
        if (authorization.policyVersion != policyVersion) revert UnsupportedUserOperation();
        if (maxCost > authorization.maxCost || maxCost > maxCostPerOperation) {
            revert SponsorshipBudgetExceeded();
        }

        result.sponsorshipHash = _sponsorshipHash(userOp, authorization);
        if (consumedSponsorship[result.sponsorshipHash]) revert UnsupportedUserOperation();
        result.policyVersion = authorization.policyVersion;
        result.signatureValid = _isSponsorSignatureValid(result.sponsorshipHash, data[48:113]);
        result.validationData = _packValidationData(
            !result.signatureValid, authorization.validUntil, authorization.validAfter
        );
    }

    function _reserveSponsorship(
        bytes32 sponsorshipHash,
        address sender,
        uint256 maxCost,
        uint32 signedPolicyVersion
    ) internal returns (bytes memory context) {
        uint256 day = block.timestamp / 1 days;
        uint256 nextUserReserved = reservedUserByDay[day][sender] + maxCost;
        uint256 nextGlobalReserved = reservedGlobalByDay[day] + maxCost;
        if (
            Math.saturatingAdd(spentUserByDay[day][sender], nextUserReserved) > maxCostPerUserPerDay
                || Math.saturatingAdd(spentGlobalByDay[day], nextGlobalReserved)
                    > maxCostGlobalPerDay
        ) revert SponsorshipBudgetExceeded();

        consumedSponsorship[sponsorshipHash] = true;
        reservedUserByDay[day][sender] = nextUserReserved;
        reservedGlobalByDay[day] = nextGlobalReserved;
        context = abi.encode(sender, day, maxCost);
        emit SponsorshipReserved(sponsorshipHash, sender, day, maxCost, signedPolicyVersion);
    }

    function postOp(
        PostOpMode mode,
        bytes calldata context,
        uint256 actualGasCost,
        uint256 actualUserOpFeePerGas
    ) external onlyEntryPoint {
        (address sender, uint256 day, uint256 reservedCost) =
            abi.decode(context, (address, uint256, uint256));
        reservedUserByDay[day][sender] -= reservedCost;
        reservedGlobalByDay[day] -= reservedCost;
        // EntryPoint's actualGasCost excludes this postOp call and its unused-gas penalty. Charging
        // the full prefund reservation is the only local rule that remains a hard loss bound.
        spentUserByDay[day][sender] += reservedCost;
        spentGlobalByDay[day] += reservedCost;
        emit SponsorshipSettled(
            sender, day, mode, reservedCost, actualGasCost, actualUserOpFeePerGas, reservedCost
        );
    }

    function setSponsorSigner(address newSigner) external onlyGovernance {
        if (newSigner == address(0)) revert ZeroAddress();
        address previous = sponsorSigner;
        sponsorSigner = newSigner;
        policyVersion += 1;
        emit SponsorSignerUpdated(previous, newSigner, policyVersion);
    }

    function setBudgets(
        uint256 maxCostPerOperation_,
        uint256 maxCostPerUserPerDay_,
        uint256 maxCostGlobalPerDay_
    ) external onlyGovernance {
        _setBudgets(maxCostPerOperation_, maxCostPerUserPerDay_, maxCostGlobalPerDay_);
    }

    function deposit() public payable {
        entryPoint.depositTo{ value: msg.value }(address(this));
        emit EntryPointDepositAdded(msg.sender, msg.value);
    }

    function withdrawDepositTo(address payable recipient, uint256 amount) external onlyGovernance {
        if (recipient == address(0)) revert ZeroAddress();
        entryPoint.withdrawTo(recipient, amount);
        emit EntryPointDepositWithdrawn(recipient, amount);
    }

    function addStake(uint32 unstakeDelaySec) external payable onlyGovernance {
        entryPoint.addStake{ value: msg.value }(unstakeDelaySec);
        emit EntryPointStakeAdded(unstakeDelaySec, msg.value);
    }

    function unlockStake() external onlyGovernance {
        entryPoint.unlockStake();
        emit EntryPointStakeUnlocked();
    }

    function withdrawStake(address payable recipient) external onlyGovernance {
        if (recipient == address(0)) revert ZeroAddress();
        entryPoint.withdrawStake(recipient);
        emit EntryPointStakeWithdrawn(recipient);
    }

    function getDeposit() external view returns (uint256) {
        return entryPoint.balanceOf(address(this));
    }

    function sponsorshipDigest(
        PackedUserOperation calldata userOp,
        uint128 paymasterVerificationGasLimit,
        uint128 paymasterPostOpGasLimit,
        uint48 validAfter,
        uint48 validUntil,
        uint256 maxCost,
        uint32 requestedPolicyVersion
    ) external view returns (bytes32) {
        _validatePaymasterGasLimits(paymasterVerificationGasLimit, paymasterPostOpGasLimit);
        AuthorizationFields memory authorization = AuthorizationFields({
            paymasterVerificationGasLimit: paymasterVerificationGasLimit,
            paymasterPostOpGasLimit: paymasterPostOpGasLimit,
            validAfter: validAfter,
            validUntil: validUntil,
            maxCost: maxCost,
            policyVersion: requestedPolicyVersion
        });
        return _sponsorshipHash(userOp, authorization);
    }

    function _sponsorshipHash(
        PackedUserOperation calldata userOp,
        AuthorizationFields memory authorization
    ) internal view returns (bytes32) {
        SponsorshipMessage memory message =
            SponsorshipMessage({
                typeHash: SPONSORSHIP_TYPEHASH,
                sender: userOp.sender,
                nonce: userOp.nonce,
                initCodeHash: keccak256(userOp.initCode),
                callDataHash: keccak256(userOp.callData),
                accountGasLimits: userOp.accountGasLimits,
                preVerificationGas: userOp.preVerificationGas,
                gasFees: userOp.gasFees,
                paymasterVerificationGasLimit: authorization.paymasterVerificationGasLimit,
                paymasterPostOpGasLimit: authorization.paymasterPostOpGasLimit,
                validAfter: authorization.validAfter,
                validUntil: authorization.validUntil,
                maxCost: authorization.maxCost,
                requestedPolicyVersion: authorization.policyVersion,
                chainId: block.chainid,
                entryPointAddress: address(entryPoint),
                paymasterAddress: address(this)
            });
        return _hashTypedDataV4(keccak256(abi.encode(message)));
    }

    function _isSponsorSignatureValid(bytes32 sponsorshipHash, bytes calldata signature)
        internal
        view
        returns (bool)
    {
        (address recovered, ECDSA.RecoverError recoverError, bytes32 errorArgument) =
            ECDSA.tryRecover(sponsorshipHash, signature);
        return recoverError == ECDSA.RecoverError.NoError && errorArgument == bytes32(0)
            && recovered == sponsorSigner;
    }

    function _validatedPaymasterGasLimits(bytes calldata paymasterAndData)
        internal
        pure
        returns (uint128 verificationGasLimit, uint128 postOpGasLimit)
    {
        verificationGasLimit = uint128(
            bytes16(
                paymasterAndData[PAYMASTER_VERIFICATION_GAS_OFFSET:PAYMASTER_POST_OP_GAS_OFFSET]
            )
        );
        postOpGasLimit =
            uint128(bytes16(paymasterAndData[PAYMASTER_POST_OP_GAS_OFFSET:PAYMASTER_DATA_OFFSET]));
        _validatePaymasterGasLimits(verificationGasLimit, postOpGasLimit);
    }

    function _validatePaymasterGasLimits(uint128 verificationGasLimit, uint128 postOpGasLimit)
        internal
        pure
    {
        if (
            verificationGasLimit < MIN_PAYMASTER_VERIFICATION_GAS_LIMIT
                || verificationGasLimit > MAX_PAYMASTER_VERIFICATION_GAS_LIMIT
        ) revert InvalidConfiguration("paymaster.verificationGasLimit");
        if (
            postOpGasLimit < MIN_PAYMASTER_POST_OP_GAS_LIMIT
                || postOpGasLimit > MAX_PAYMASTER_POST_OP_GAS_LIMIT
        ) revert InvalidConfiguration("paymaster.postOpGasLimit");
    }

    function _setBudgets(
        uint256 maxCostPerOperation_,
        uint256 maxCostPerUserPerDay_,
        uint256 maxCostGlobalPerDay_
    ) internal {
        if (
            maxCostPerOperation_ == 0 || maxCostPerUserPerDay_ < maxCostPerOperation_
                || maxCostGlobalPerDay_ < maxCostPerUserPerDay_
        ) revert InvalidConfiguration("paymaster.budgets");
        maxCostPerOperation = maxCostPerOperation_;
        maxCostPerUserPerDay = maxCostPerUserPerDay_;
        maxCostGlobalPerDay = maxCostGlobalPerDay_;
        emit SponsorshipBudgetsUpdated(
            maxCostPerOperation_, maxCostPerUserPerDay_, maxCostGlobalPerDay_
        );
    }

    function _packValidationData(bool sigFailed, uint48 validUntil, uint48 validAfter)
        internal
        pure
        returns (uint256)
    {
        return uint256(sigFailed ? 1 : 0) | (uint256(validUntil) << 160)
            | (uint256(validAfter) << 208);
    }
}
