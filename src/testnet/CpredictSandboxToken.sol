// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Publicly mintable payment token for the Cpredict Arbitrum Sepolia demo only.
/// @dev This contract cannot be deployed on another chain and must never be presented as USDC.
contract CpredictSandboxToken is ERC20 {
    uint256 public constant ARBITRUM_SEPOLIA_CHAIN_ID = 421_614;
    bool public constant IS_CPREDICT_SANDBOX_TOKEN = true;

    error SandboxChainOnly(uint256 actualChainId);
    error ZeroRecipient();
    error ZeroAmount();

    constructor() ERC20("Cpredict Test USD", "ctUSD") {
        if (block.chainid != ARBITRUM_SEPOLIA_CHAIN_ID) {
            revert SandboxChainOnly(block.chainid);
        }
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint arbitrary test balance. There is intentionally no owner or supply cap.
    function mint(address to, uint256 amount) external {
        if (to == address(0)) revert ZeroRecipient();
        if (amount == 0) revert ZeroAmount();
        _mint(to, amount);
    }
}
