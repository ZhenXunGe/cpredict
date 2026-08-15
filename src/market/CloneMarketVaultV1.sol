// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { MarketVaultCoreV1 } from "./MarketVaultCoreV1.sol";

/// @notice Fixed EIP-1167 implementation. The implementation instance is permanently
/// uninitializable.
contract CloneMarketVaultV1 is MarketVaultCoreV1 {
    constructor() MarketVaultCoreV1(true) { }
}

