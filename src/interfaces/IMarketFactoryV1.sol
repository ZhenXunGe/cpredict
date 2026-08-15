// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { ProtocolTypes } from "../libraries/ProtocolTypes.sol";

interface IMarketFactoryV1 {
    function marketplace() external view returns (address);
    function isMarket(address market) external view returns (bool);
    function deploymentModeOf(address market) external view returns (ProtocolTypes.DeploymentMode);
}
