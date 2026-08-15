// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

interface IEmergencyControllerV1 {
    function governance() external view returns (address);
    function isPaused(uint256 flag) external view returns (bool);
}
