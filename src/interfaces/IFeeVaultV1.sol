// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

interface IFeeVaultV1 {
    function governance() external view returns (address);
    function paymentToken() external view returns (address);
    function factory() external view returns (address);
    function authorizedAccruer(address account) external view returns (bool);
    function registerAccruer(address account) external;
    function accrue(address beneficiary, uint256 amount, bytes32 feeKind, bytes32 feeReference)
        external;
}
