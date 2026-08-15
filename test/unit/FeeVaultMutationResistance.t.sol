// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";
import { Vm } from "forge-std/Vm.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { FeeVaultV1 } from "../../src/core/FeeVaultV1.sol";

contract ReentrantObservationUSDC is ERC20 {
    address public callbackTarget;
    bool public callbackArmed;
    bool public callbackSucceeded;
    bytes4 public callbackError;

    constructor() ERC20("Reentrant Observation USDC", "roUSDC") { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target) external {
        callbackTarget = target;
        callbackArmed = true;
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (callbackArmed && from == callbackTarget && to != address(0)) {
            callbackArmed = false;
            bytes memory result;
            (callbackSucceeded, result) =
                callbackTarget.call(abi.encodeCall(FeeVaultV1.claimFor, (to)));
            if (result.length >= 4) {
                callbackError = bytes4(result);
            }
        }
        super._update(from, to, amount);
    }
}

contract FeeVaultMutationResistanceTest is Test {
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    bytes32 internal constant FEE_KIND = keccak256("PROTOCOL_RAKE");
    bytes32 internal constant FEE_REFERENCE = keccak256("market-1");

    event FactoryConfigured(address indexed factory);
    event AccruerRegistered(address indexed account);
    event FeeAccrued(
        address indexed beneficiary,
        address indexed source,
        bytes32 indexed feeKind,
        bytes32 feeReference,
        uint256 amount
    );
    event FeeClaimed(address indexed beneficiary, address indexed caller, uint256 amount);

    function testFeeLifecycleEmitsIndexerCriticalEvents() public {
        ReentrantObservationUSDC token = new ReentrantObservationUSDC();
        FeeVaultV1 vault = new FeeVaultV1(address(this), address(token));

        vm.expectEmit(true, false, false, true, address(vault));
        emit FactoryConfigured(address(this));
        vm.expectEmit(true, false, false, true, address(vault));
        emit AccruerRegistered(address(this));
        vault.setFactory(address(this));

        vm.expectEmit(true, false, false, true, address(vault));
        emit AccruerRegistered(ALICE);
        vault.registerAccruer(ALICE);

        token.mint(address(vault), 10);
        vm.expectEmit(true, true, true, true, address(vault));
        emit FeeAccrued(BOB, ALICE, FEE_KIND, FEE_REFERENCE, 10);
        vm.prank(ALICE);
        vault.accrue(BOB, 10, FEE_KIND, FEE_REFERENCE);

        vm.expectEmit(true, true, false, true, address(vault));
        emit FeeClaimed(BOB, ALICE, 10);
        vm.prank(ALICE);
        vault.claimFor(BOB);
    }

    function testClaimRejectsTokenCallbackReentrancyBeforeTransferCompletes() public {
        ReentrantObservationUSDC token = new ReentrantObservationUSDC();
        FeeVaultV1 vault = new FeeVaultV1(address(this), address(token));
        vault.setFactory(address(this));
        token.mint(address(vault), 10);
        vault.accrue(ALICE, 10, FEE_KIND, FEE_REFERENCE);
        token.arm(address(vault));

        vault.claimFor(ALICE);

        assertFalse(token.callbackSucceeded());
        assertEq(
            token.callbackError(),
            bytes4(keccak256("ReentrancyGuardReentrantCall()")),
            "callback must be rejected by the guard"
        );
        assertEq(token.balanceOf(ALICE), 10);
        assertEq(vault.totalCredits(), 0);
    }

    function testRepeatedAccrualAddsInsteadOfReplacingOrBitwiseCombining() public {
        ReentrantObservationUSDC token = new ReentrantObservationUSDC();
        FeeVaultV1 vault = new FeeVaultV1(address(this), address(token));
        vault.setFactory(address(this));

        token.mint(address(vault), 16);
        vault.accrue(ALICE, 10, FEE_KIND, FEE_REFERENCE);
        vault.accrue(ALICE, 6, FEE_KIND, FEE_REFERENCE);

        assertEq(vault.creditOf(ALICE), 16);
        assertEq(vault.totalCredits(), 16);
    }

    function testPartialClaimSubtractsOnlyClaimedCreditFromAggregate() public {
        ReentrantObservationUSDC token = new ReentrantObservationUSDC();
        FeeVaultV1 vault = new FeeVaultV1(address(this), address(token));
        vault.setFactory(address(this));

        token.mint(address(vault), 20);
        vault.accrue(ALICE, 6, FEE_KIND, FEE_REFERENCE);
        vault.accrue(BOB, 14, FEE_KIND, FEE_REFERENCE);
        vault.claimFor(ALICE);

        assertEq(vault.creditOf(ALICE), 0);
        assertEq(vault.creditOf(BOB), 14);
        assertEq(vault.totalCredits(), 14);
        assertEq(token.balanceOf(ALICE), 6);
        assertEq(token.balanceOf(address(vault)), 14);
    }

    function testZeroAccrualIsAStateAndEventNoOp() public {
        ReentrantObservationUSDC token = new ReentrantObservationUSDC();
        FeeVaultV1 vault = new FeeVaultV1(address(this), address(token));
        vault.setFactory(address(this));

        vm.recordLogs();
        vault.accrue(ALICE, 0, FEE_KIND, FEE_REFERENCE);
        Vm.Log[] memory entries = vm.getRecordedLogs();

        assertEq(entries.length, 0);
        assertEq(vault.creditOf(ALICE), 0);
        assertEq(vault.totalCredits(), 0);
    }
}
