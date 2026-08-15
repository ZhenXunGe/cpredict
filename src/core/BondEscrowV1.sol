// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { IMarketVaultV1 } from "../interfaces/IMarketVaultV1.sol";
import { ProtocolTypes } from "../libraries/ProtocolTypes.sol";
import {
    Unauthorized,
    ZeroAddress,
    AlreadyConfigured,
    MarketAlreadyRegistered,
    BondNotLocked,
    BondStateMismatch,
    NothingToClaim,
    Insolvent
} from "../libraries/ProtocolErrors.sol";

/// @notice Per-version creator bond escrow with no administrative withdrawal path.
contract BondEscrowV1 is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    struct Bond {
        address creator;
        uint128 amount;
        bool settled;
    }

    IERC20 public immutable paymentToken;
    address public immutable governance;
    address public factory;
    uint256 public totalLocked;
    uint256 public totalCredits;

    mapping(address => Bond) public bondOf;
    mapping(address => uint256) public creditOf;

    event FactoryConfigured(address indexed factory);
    event BondLocked(address indexed market, address indexed creator, uint256 amount);
    event BondCredited(address indexed market, address indexed creator, uint256 amount);
    event EmptyTimeoutBondCredited(address indexed market, address indexed creator, uint256 amount);
    event BondFundedToTimeoutMarket(address indexed market, uint256 amount);
    event BondClaimed(address indexed creator, address indexed caller, uint256 amount);

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
        emit FactoryConfigured(factory_);
    }

    function lockBond(address market, address creator, uint256 amount) external {
        if (msg.sender != factory) revert Unauthorized(msg.sender);
        if (market == address(0) || creator == address(0)) revert ZeroAddress();
        if (bondOf[market].creator != address(0)) revert MarketAlreadyRegistered(market);
        if (amount == 0 || amount > type(uint128).max) revert BondStateMismatch(market);
        uint256 nextLocked = totalLocked + amount;
        uint256 liabilities = nextLocked + totalCredits;
        uint256 balance = paymentToken.balanceOf(address(this));
        if (balance < liabilities) revert Insolvent(balance, liabilities);
        bondOf[market] = Bond({ creator: creator, amount: amount.toUint128(), settled: false });
        totalLocked = nextLocked;
        emit BondLocked(market, creator, amount);
    }

    /// @notice Permissionlessly releases or slashes a bond after terminal state.
    /// @dev Timeout funding can fail without affecting the market's already-active principal
    /// refunds.
    function settleBond(address market) external nonReentrant returns (uint256 amount) {
        Bond storage bond = bondOf[market];
        if (bond.creator == address(0)) revert BondNotLocked(market);
        if (bond.settled) revert BondStateMismatch(market);

        ProtocolTypes.MarketState state = IMarketVaultV1(market).marketState();
        if (state == ProtocolTypes.MarketState.OPEN) revert BondStateMismatch(market);

        amount = bond.amount;
        bond.settled = true;
        totalLocked -= amount;

        if (
            state == ProtocolTypes.MarketState.VOIDED_TIMEOUT
                && IMarketVaultV1(market).totalPrincipal() != 0
        ) {
            paymentToken.safeTransfer(market, amount);
            IMarketVaultV1(market).fundTimeoutBonus(amount);
            emit BondFundedToTimeoutMarket(market, amount);
        } else {
            creditOf[bond.creator] += amount;
            totalCredits += amount;
            if (state == ProtocolTypes.MarketState.VOIDED_TIMEOUT) {
                emit EmptyTimeoutBondCredited(market, bond.creator, amount);
            }
            emit BondCredited(market, bond.creator, amount);
        }
    }

    function claim() external returns (uint256 amount) {
        return _claim(msg.sender, msg.sender);
    }

    function claimFor(address creator) external returns (uint256 amount) {
        return _claim(creator, msg.sender);
    }

    function _claim(address creator, address caller)
        internal
        nonReentrant
        returns (uint256 amount)
    {
        amount = creditOf[creator];
        if (amount == 0) revert NothingToClaim();
        creditOf[creator] = 0;
        totalCredits -= amount;
        paymentToken.safeTransfer(creator, amount);
        emit BondClaimed(creator, caller, amount);
    }
}
