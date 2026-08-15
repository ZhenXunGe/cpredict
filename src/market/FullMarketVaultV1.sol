// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { MarketVaultCoreV1 } from "./MarketVaultCoreV1.sol";

/// @notice Fully deployed, immutable market runtime. This is the recommended mode.
contract FullMarketVaultV1 is MarketVaultCoreV1 {
    /// @dev The authorized Factory initializes this runtime in the same transaction as CREATE2.
    constructor() MarketVaultCoreV1(false) { }
}
