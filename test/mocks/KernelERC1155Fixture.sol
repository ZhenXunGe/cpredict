// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { ERC1155 } from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

/// @dev Local-fork fixture only. Never part of a protocol deployment.
contract KernelERC1155Fixture is ERC1155 {
    constructor() ERC1155("https://example.invalid/kernel-fixture/{id}.json") { }

    function mint(address to, uint256 id, uint256 amount) external {
        _mint(to, id, amount, "");
    }

    function mintBatch(address to, uint256[] calldata ids, uint256[] calldata amounts) external {
        _mintBatch(to, ids, amounts, "");
    }
}
