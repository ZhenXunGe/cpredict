// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { FullMarketVaultV1 } from "../market/FullMarketVaultV1.sol";
import { Unauthorized, ZeroAddress, AlreadyConfigured } from "../libraries/ProtocolErrors.sol";

/// @notice Isolates Full vault CREATE2 creation code from the Factory runtime.
/// @dev Only the permanently bound Factory can deploy; it initializes the returned vault
/// atomically.
contract FullMarketDeployerV1 {
    address public immutable governance;
    address public factory;

    event FactoryConfigured(address indexed factory);
    event FullMarketRuntimeDeployed(address indexed market, bytes32 indexed salt);

    constructor(address governance_) {
        if (governance_ == address(0)) revert ZeroAddress();
        governance = governance_;
    }

    function setFactory(address factory_) external {
        if (msg.sender != governance) revert Unauthorized(msg.sender);
        if (factory_ == address(0)) revert ZeroAddress();
        if (factory != address(0)) revert AlreadyConfigured();
        factory = factory_;
        emit FactoryConfigured(factory_);
    }

    function deploy(bytes32 salt) external returns (address market) {
        if (msg.sender != factory) revert Unauthorized(msg.sender);
        market = address(new FullMarketVaultV1{ salt: salt }());
        emit FullMarketRuntimeDeployed(market, salt);
    }
}

