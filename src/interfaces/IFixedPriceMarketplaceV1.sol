// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @notice Immutable dependency identity surface used by the Factory activation gate.
interface IFixedPriceMarketplaceV1 {
    function factory() external view returns (address);
    function emergencyController() external view returns (address);
    function feeVault() external view returns (address);
    function paymentToken() external view returns (address);
    function permit2() external view returns (address);
}
