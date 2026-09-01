// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";
import { Vm } from "forge-std/Vm.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { BondEscrowV1 } from "../../src/core/BondEscrowV1.sol";
import { ProtocolTypes } from "../../src/libraries/ProtocolTypes.sol";
import { BondStateMismatch, Insolvent } from "../../src/libraries/ProtocolErrors.sol";

contract BondReentrantObservationUSDC is ERC20 {
    address public callbackTarget;
    bool public callbackArmed;
    bool public callbackSucceeded;
    bytes4 public callbackError;

    constructor() ERC20("Bond Reentrant Observation USDC", "broUSDC") { }

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
                callbackTarget.call(abi.encodeCall(BondEscrowV1.claimFor, (to)));
            if (result.length >= 4) {
                callbackError = bytes4(result);
            }
        }
        super._update(from, to, amount);
    }
}

contract BondMutationMarketMock {
    ProtocolTypes.MarketState public marketState;
    uint256 public totalPrincipal;
    uint256 public funded;

    function setState(ProtocolTypes.MarketState state) external {
        marketState = state;
    }

    function fundTimeoutBonus(uint256 amount) external {
        funded += amount;
    }
}

contract BondEscrowMutationResistanceTest is Test {
    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant OTHER_CREATOR = address(0xB0B);

    event FactoryConfigured(address indexed factory);
    event BondLocked(address indexed market, address indexed creator, uint256 amount);
    event BondCredited(address indexed market, address indexed creator, uint256 amount);
    event BondClaimed(address indexed creator, address indexed caller, uint256 amount);

    function testBondLifecycleEmitsIndexerCriticalEvents() public {
        BondReentrantObservationUSDC token = new BondReentrantObservationUSDC();
        BondEscrowV1 escrow = new BondEscrowV1(address(this), address(token));
        BondMutationMarketMock market = new BondMutationMarketMock();

        vm.expectEmit(true, false, false, true, address(escrow));
        emit FactoryConfigured(address(this));
        escrow.setFactory(address(this));

        token.mint(address(escrow), 10);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit BondLocked(address(market), CREATOR, 10);
        escrow.lockBond(address(market), CREATOR, 10);

        market.setState(ProtocolTypes.MarketState.VOIDED_CREATOR);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit BondCredited(address(market), CREATOR, 10);
        vm.recordLogs();
        escrow.settleBond(address(market));
        Vm.Log[] memory settlementLogs = vm.getRecordedLogs();
        assertEq(settlementLogs.length, 1, "non-timeout settlement must emit one event");
        assertEq(
            settlementLogs[0].topics[0],
            keccak256("BondCredited(address,address,uint256)"),
            "non-timeout settlement must not emit the timeout-credit event"
        );

        vm.expectEmit(true, true, false, true, address(escrow));
        emit BondClaimed(CREATOR, address(this), 10);
        escrow.claimFor(CREATOR);
    }

    function testClaimRejectsTokenCallbackReentrancyBeforeTransferCompletes() public {
        BondReentrantObservationUSDC token = new BondReentrantObservationUSDC();
        BondEscrowV1 escrow = new BondEscrowV1(address(this), address(token));
        BondMutationMarketMock market = new BondMutationMarketMock();
        escrow.setFactory(address(this));
        token.mint(address(escrow), 10);
        escrow.lockBond(address(market), CREATOR, 10);
        market.setState(ProtocolTypes.MarketState.VOIDED_CREATOR);
        escrow.settleBond(address(market));
        token.arm(address(escrow));

        escrow.claimFor(CREATOR);

        assertFalse(token.callbackSucceeded());
        assertEq(
            token.callbackError(),
            bytes4(keccak256("ReentrancyGuardReentrantCall()")),
            "callback must be rejected by the guard"
        );
        assertEq(token.balanceOf(CREATOR), 10);
        assertEq(escrow.totalCredits(), 0);
    }

    function testAggregateAccountingAcrossBondsCreatorsAndPartialClaim() public {
        BondReentrantObservationUSDC token = new BondReentrantObservationUSDC();
        BondEscrowV1 escrow = new BondEscrowV1(address(this), address(token));
        BondMutationMarketMock first = new BondMutationMarketMock();
        BondMutationMarketMock second = new BondMutationMarketMock();
        BondMutationMarketMock third = new BondMutationMarketMock();
        BondMutationMarketMock fourth = new BondMutationMarketMock();
        escrow.setFactory(address(this));

        token.mint(address(escrow), 25);
        escrow.lockBond(address(first), CREATOR, 7);
        escrow.lockBond(address(second), CREATOR, 13);
        escrow.lockBond(address(third), OTHER_CREATOR, 5);
        assertEq(escrow.totalLocked(), 25);
        assertEq(escrow.totalCredits(), 0);

        first.setState(ProtocolTypes.MarketState.VOIDED_CREATOR);
        escrow.settleBond(address(first));
        assertEq(escrow.totalLocked(), 18);
        assertEq(escrow.creditOf(CREATOR), 7);
        assertEq(escrow.totalCredits(), 7);

        vm.expectRevert(abi.encodeWithSelector(Insolvent.selector, 25, 33));
        escrow.lockBond(address(fourth), CREATOR, 8);

        token.mint(address(escrow), 8);
        escrow.lockBond(address(fourth), CREATOR, 8);
        assertEq(escrow.totalLocked(), 26);
        assertEq(escrow.totalCredits(), 7);

        second.setState(ProtocolTypes.MarketState.VOIDED_CREATOR);
        escrow.settleBond(address(second));
        assertEq(escrow.totalLocked(), 13);
        assertEq(escrow.creditOf(CREATOR), 20);
        assertEq(escrow.totalCredits(), 20);

        third.setState(ProtocolTypes.MarketState.VOIDED_CREATOR);
        escrow.settleBond(address(third));
        assertEq(escrow.totalLocked(), 8);
        assertEq(escrow.creditOf(OTHER_CREATOR), 5);
        assertEq(escrow.totalCredits(), 25);

        escrow.claimFor(OTHER_CREATOR);
        assertEq(escrow.creditOf(OTHER_CREATOR), 0);
        assertEq(escrow.totalCredits(), 20);
        assertEq(escrow.totalLocked(), 8);
        assertEq(token.balanceOf(address(escrow)), 28);
    }

    function testLockBondAcceptsUint128MaximumAndRejectsNextValue() public {
        BondReentrantObservationUSDC token = new BondReentrantObservationUSDC();
        BondEscrowV1 escrow = new BondEscrowV1(address(this), address(token));
        BondMutationMarketMock maximumMarket = new BondMutationMarketMock();
        BondMutationMarketMock overflowMarket = new BondMutationMarketMock();
        escrow.setFactory(address(this));

        uint256 maximumAmount = type(uint128).max;
        token.mint(address(escrow), maximumAmount);
        escrow.lockBond(address(maximumMarket), CREATOR, maximumAmount);
        (, uint128 storedAmount, bool settled) = escrow.bondOf(address(maximumMarket));
        assertEq(storedAmount, type(uint128).max);
        assertFalse(settled);

        vm.expectRevert(abi.encodeWithSelector(BondStateMismatch.selector, address(overflowMarket)));
        escrow.lockBond(address(overflowMarket), CREATOR, maximumAmount + 1);
    }
}
