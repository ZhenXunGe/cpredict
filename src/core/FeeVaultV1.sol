// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {
    Unauthorized,
    ZeroAddress,
    AlreadyConfigured,
    AccruerNotAuthorized,
    Insolvent,
    NothingToClaim
} from "../libraries/ProtocolErrors.sol";

/// @notice Per-version pull-payment vault for fees only; never holds user principal by design.
contract FeeVaultV1 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable paymentToken;
    address public immutable governance;
    address public factory;
    uint256 public totalCredits;

    mapping(address => bool) public authorizedAccruer;
    mapping(address => uint256) public creditOf;

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

    constructor(address governance_, address paymentToken_) {
        if (governance_ == address(0) || paymentToken_ == address(0)) revert ZeroAddress();
        governance = governance_;
        paymentToken = IERC20(paymentToken_);
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert Unauthorized(msg.sender);
        _;
    }

    function setFactory(address factory_) external onlyGovernance {
        if (factory_ == address(0)) revert ZeroAddress();
        if (factory != address(0)) revert AlreadyConfigured();
        factory = factory_;
        authorizedAccruer[factory_] = true;
        emit FactoryConfigured(factory_);
        emit AccruerRegistered(factory_);
    }

    function registerAccruer(address account) external {
        if (msg.sender != factory) revert Unauthorized(msg.sender);
        if (account == address(0)) revert ZeroAddress();
        authorizedAccruer[account] = true;
        emit AccruerRegistered(account);
    }

    function accrue(address beneficiary, uint256 amount, bytes32 feeKind, bytes32 feeReference)
        external
    {
        if (!authorizedAccruer[msg.sender]) revert AccruerNotAuthorized(msg.sender);
        if (beneficiary == address(0)) revert ZeroAddress();
        if (amount == 0) return;
        uint256 nextCredits = totalCredits + amount;
        uint256 balance = paymentToken.balanceOf(address(this));
        if (balance < nextCredits) revert Insolvent(balance, nextCredits);
        totalCredits = nextCredits;
        creditOf[beneficiary] += amount;
        emit FeeAccrued(beneficiary, msg.sender, feeKind, feeReference, amount);
    }

    function claim() external returns (uint256 amount) {
        return _claim(msg.sender, msg.sender);
    }

    function claimFor(address beneficiary) external returns (uint256 amount) {
        return _claim(beneficiary, msg.sender);
    }

    function _claim(address beneficiary, address caller)
        internal
        nonReentrant
        returns (uint256 amount)
    {
        amount = creditOf[beneficiary];
        if (amount == 0) revert NothingToClaim();
        creditOf[beneficiary] = 0;
        totalCredits -= amount;
        paymentToken.safeTransfer(beneficiary, amount);
        emit FeeClaimed(beneficiary, caller, amount);
    }
}
