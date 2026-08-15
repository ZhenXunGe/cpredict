// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

interface IFullMarketDeployerV1 {
    function governance() external view returns (address);
    function factory() external view returns (address);
    function deploy(bytes32 salt) external returns (address market);
}
