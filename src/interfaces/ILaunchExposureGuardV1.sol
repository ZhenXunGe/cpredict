// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

interface ILaunchExposureGuardV1 {
    function governance() external view returns (address);
    function factory() external view returns (address);
    function registerMarket(address market) external;
    function reserve(uint256 amount) external;
    function sync(address market)
        external
        returns (uint256 previousExposure, uint256 currentExposure);
}
