// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;
import { PackedUserOperation } from "@account-abstraction/interfaces/PackedUserOperation.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Disposable fork-only Paymaster; never deploy outside the owned Anvil runner.
contract TradingSessionPaymasterFixture {
    function validatePaymasterUserOp(PackedUserOperation calldata, bytes32, uint256)
        external
        pure
        returns (bytes memory, uint256)
    {
        return ("", 0);
    }
    function postOp(uint8, bytes calldata, uint256, uint256) external pure { }
}

contract TradingSessionMarketFixture {
    IERC20 public immutable token;
    uint256 public purchases;

    constructor(address token_) {
        token = IERC20(token_);
    }

    function buy(uint256, uint256, uint256, uint256 maxPayment, uint64) external {
        require(token.transferFrom(msg.sender, address(this), maxPayment));
        purchases++;
    }
    function refundFor(address) external pure { }
}

contract TradingSessionMarketDependenciesFixture {
    function isPaused(uint256) external pure returns(bool) { return false; }
    function reserve(uint256) external pure {}
    function sync(address) external pure returns(uint256,uint256) {return (0,0);}
}
