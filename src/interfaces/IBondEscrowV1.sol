// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

interface IBondEscrowV1 {
    function governance() external view returns (address);
    function paymentToken() external view returns (address);
    function factory() external view returns (address);
    function lockBond(address market, address creator, uint256 amount) external;
}
