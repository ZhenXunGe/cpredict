// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Script } from "forge-std/Script.sol";
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";
import { LaunchExposureGuardV1 } from "../src/core/LaunchExposureGuardV1.sol";
import { FeeVaultV1 } from "../src/core/FeeVaultV1.sol";
import { BondEscrowV1 } from "../src/core/BondEscrowV1.sol";
import { FullMarketDeployerV1 } from "../src/core/FullMarketDeployerV1.sol";
import { MarketFactoryV1 } from "../src/core/MarketFactoryV1.sol";

/// @notice Executes the scheduled bootstrap batch and removes every temporary deployer role.
contract FinalizeBootstrap is Script {
    uint256 internal constant ARBITRUM_SEPOLIA_CHAIN_ID = 421_614;
    bytes32 internal constant BOOTSTRAP_SALT = keccak256("CPREDICT_V1_BOOTSTRAP");

    function run() external {
        require(block.chainid == ARBITRUM_SEPOLIA_CHAIN_ID, "wrong chain");
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        TimelockController timelock = TimelockController(payable(vm.envAddress("TIMELOCK_ADDRESS")));
        address factory = vm.envAddress("FACTORY_ADDRESS");
        address marketplace = vm.envAddress("MARKETPLACE_ADDRESS");
        bytes32 expectedFactoryFingerprint =
            vm.envBytes32("EXPECTED_FACTORY_DEPENDENCY_FINGERPRINT");
        address[] memory targets = new address[](6);
        uint256[] memory values = new uint256[](6);
        bytes[] memory payloads = new bytes[](6);
        targets[0] = vm.envAddress("EXPOSURE_GUARD_ADDRESS");
        payloads[0] = abi.encodeCall(LaunchExposureGuardV1.setFactory, (factory));
        targets[1] = vm.envAddress("FEE_VAULT_ADDRESS");
        payloads[1] = abi.encodeCall(FeeVaultV1.setFactory, (factory));
        targets[2] = vm.envAddress("BOND_ESCROW_ADDRESS");
        payloads[2] = abi.encodeCall(BondEscrowV1.setFactory, (factory));
        targets[3] = vm.envAddress("FULL_DEPLOYER_ADDRESS");
        payloads[3] = abi.encodeCall(FullMarketDeployerV1.setFactory, (factory));
        targets[4] = factory;
        payloads[4] = abi.encodeCall(MarketFactoryV1.setMarketplace, (marketplace));
        targets[5] = factory;
        payloads[5] = abi.encodeCall(MarketFactoryV1.activate, (expectedFactoryFingerprint));

        vm.startBroadcast(deployerKey);
        timelock.executeBatch(targets, values, payloads, bytes32(0), BOOTSTRAP_SALT);
        require(MarketFactoryV1(factory).active(), "factory activation failed");
        require(
            MarketFactoryV1(factory).activationFingerprint() == expectedFactoryFingerprint,
            "factory activation fingerprint mismatch"
        );
        timelock.renounceRole(timelock.PROPOSER_ROLE(), deployer);
        timelock.renounceRole(timelock.CANCELLER_ROLE(), deployer);
        timelock.renounceRole(timelock.DEFAULT_ADMIN_ROLE(), deployer);
        vm.stopBroadcast();
    }
}
