// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";
import { DeployArbitrumSepolia } from "../../script/DeployArbitrumSepolia.s.sol";
import { FinalizeBootstrap } from "../../script/FinalizeBootstrap.s.sol";
import { LaunchExposureGuardV1 } from "../../src/core/LaunchExposureGuardV1.sol";
import { FeeVaultV1 } from "../../src/core/FeeVaultV1.sol";
import { BondEscrowV1 } from "../../src/core/BondEscrowV1.sol";
import { FullMarketDeployerV1 } from "../../src/core/FullMarketDeployerV1.sol";
import { MarketFactoryV1 } from "../../src/core/MarketFactoryV1.sol";

contract DeployArbitrumSepoliaBehaviorTest is Test {
    uint256 internal constant ARBITRUM_SEPOLIA_CHAIN_ID = 421_614;
    uint256 internal constant TIMELOCK_DELAY = 1 hours;
    uint256 internal constant DEPLOYER_KEY = 0xA11CE;
    bytes32 internal constant BOOTSTRAP_SALT = keccak256("CPREDICT_V1_BOOTSTRAP");
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant ENTRY_POINT = 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108;

    address internal governanceSafe = makeAddr("governanceSafe");
    address internal emergencySafe = makeAddr("emergencySafe");
    address internal treasury = makeAddr("treasury");
    address internal sponsorSigner = makeAddr("sponsorSigner");

    DeployArbitrumSepolia internal deploymentScript;

    function setUp() public {
        deploymentScript = new DeployArbitrumSepolia();
        vm.chainId(ARBITRUM_SEPOLIA_CHAIN_ID);
        vm.etch(PERMIT2, hex"00");
        vm.etch(ENTRY_POINT, hex"00");
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(DEPLOYER_KEY));
        vm.setEnv("GOVERNANCE_SAFE", vm.toString(governanceSafe));
        vm.setEnv("EMERGENCY_SAFE", vm.toString(emergencySafe));
        vm.setEnv("PROTOCOL_TREASURY", vm.toString(treasury));
        vm.setEnv("SPONSOR_SIGNER", vm.toString(sponsorSigner));
        vm.setEnv("CPREDICT_SANDBOX_TOKEN_ENABLED", "true");
        vm.setEnv("CPREDICT_DEPLOYMENT_PROFILE", "sandbox");
        vm.setEnv("MARKET_RESOLUTION_WINDOW_SECONDS", "900");
    }

    function testRejectsWrongChainBeforeReadingDeploymentInputs() public {
        vm.chainId(1);
        vm.expectRevert(bytes("wrong chain"));
        deploymentScript.run();
    }

    function testRejectsMissingPermit2BeforeBroadcast() public {
        vm.etch(PERMIT2, bytes(""));
        vm.expectRevert(bytes("Permit2 code missing"));
        deploymentScript.run();
    }

    function testPreviewDeploysWiringWithoutSchedulingBootstrap() public {
        _configureSandbox();
        vm.setEnv("DEPLOYMENT_PREVIEW_ONLY", "true");

        DeployArbitrumSepolia.Deployment memory deployed = deploymentScript.run();
        bytes32 fingerprint =
            deployed.factory.dependencyFingerprintFor(address(deployed.marketplace));
        bytes32 operationId = _bootstrapOperationId(deployed, fingerprint);

        assertGt(address(deployed.factory).code.length, 0);
        assertEq(deployed.config.paymentToken(), address(deployed.sandboxToken));
        assertEq(deployed.config.protocolTreasury(), treasury);
        assertEq(deployed.emergency.emergencySafe(), emergencySafe);
        assertEq(deployed.paymaster.sponsorSigner(), sponsorSigner);
        assertEq(deployed.factory.resolutionWindow(), 15 minutes);
        assertFalse(deployed.factory.active());
        assertFalse(deployed.timelock.isOperation(operationId));
    }

    function testSandboxSchedulesExactBootstrapBatchWithoutDelay() public {
        _configureSandbox();
        vm.warp(1_000_000);
        vm.setEnv("DEPLOYMENT_PREVIEW_ONLY", "true");
        uint256 snapshot = vm.snapshotState();
        DeployArbitrumSepolia.Deployment memory preview = deploymentScript.run();
        bytes32 fingerprint = preview.factory.dependencyFingerprintFor(address(preview.marketplace));
        assertTrue(vm.revertToState(snapshot));

        vm.setEnv("DEPLOYMENT_PREVIEW_ONLY", "false");
        vm.setEnv("EXPECTED_FACTORY_DEPENDENCY_FINGERPRINT", vm.toString(fingerprint));
        assertEq(vm.envBytes32("EXPECTED_FACTORY_DEPENDENCY_FINGERPRINT"), fingerprint);
        DeployArbitrumSepolia.Deployment memory deployed = deploymentScript.run();
        bytes32 operationId = _bootstrapOperationId(deployed, fingerprint);

        assertTrue(deployed.timelock.isOperationReady(operationId));
        assertEq(deployed.timelock.getTimestamp(operationId), block.timestamp);
        assertFalse(deployed.factory.active());
    }

    function _configureSandbox() internal {
        vm.setEnv("CPREDICT_SANDBOX_TOKEN_ENABLED", "true");
        vm.setEnv("CPREDICT_DEPLOYMENT_PROFILE", "sandbox");
    }

    function _bootstrapOperationId(
        DeployArbitrumSepolia.Deployment memory deployed,
        bytes32 fingerprint
    ) internal view returns (bytes32) {
        address[] memory targets = new address[](6);
        uint256[] memory values = new uint256[](6);
        bytes[] memory payloads = new bytes[](6);
        targets[0] = address(deployed.guard);
        payloads[0] = abi.encodeCall(LaunchExposureGuardV1.setFactory, (address(deployed.factory)));
        targets[1] = address(deployed.feeVault);
        payloads[1] = abi.encodeCall(FeeVaultV1.setFactory, (address(deployed.factory)));
        targets[2] = address(deployed.bondEscrow);
        payloads[2] = abi.encodeCall(BondEscrowV1.setFactory, (address(deployed.factory)));
        targets[3] = address(deployed.fullDeployer);
        payloads[3] = abi.encodeCall(FullMarketDeployerV1.setFactory, (address(deployed.factory)));
        targets[4] = address(deployed.factory);
        payloads[4] =
            abi.encodeCall(MarketFactoryV1.setMarketplace, (address(deployed.marketplace)));
        targets[5] = address(deployed.factory);
        payloads[5] = abi.encodeCall(MarketFactoryV1.activate, (fingerprint));
        return
            deployed.timelock
                .hashOperationBatch(targets, values, payloads, bytes32(0), BOOTSTRAP_SALT);
    }
}

contract FinalizeBootstrapRolePolicyTest is Test {
    FinalizeBootstrap internal finalizeScript = new FinalizeBootstrap();

    function testPreservesGovernanceRolesWhenGovernanceSafeIsDeployer() public view {
        address governanceSafe = address(0xA11CE);
        assertFalse(finalizeScript.shouldRenounceGovernanceRoles(governanceSafe, governanceSafe));
    }

    function testRevokesGovernanceRolesWhenDeployerIsDistinct() public view {
        assertTrue(finalizeScript.shouldRenounceGovernanceRoles(address(0xA11CE), address(0xB0B)));
    }
}
