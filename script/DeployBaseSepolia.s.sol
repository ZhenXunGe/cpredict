// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Script, console2 } from "forge-std/Script.sol";
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";
import { IEntryPoint } from "@account-abstraction/interfaces/IEntryPoint.sol";
import { ProtocolConfigV1 } from "../src/core/ProtocolConfigV1.sol";
import { EmergencyControllerV1 } from "../src/core/EmergencyControllerV1.sol";
import { LaunchExposureGuardV1 } from "../src/core/LaunchExposureGuardV1.sol";
import { FeeVaultV1 } from "../src/core/FeeVaultV1.sol";
import { BondEscrowV1 } from "../src/core/BondEscrowV1.sol";
import { FullMarketDeployerV1 } from "../src/core/FullMarketDeployerV1.sol";
import { MarketFactoryV1 } from "../src/core/MarketFactoryV1.sol";
import { CloneMarketVaultV1 } from "../src/market/CloneMarketVaultV1.sol";
import { FixedPriceMarketplaceV1 } from "../src/marketplace/FixedPriceMarketplaceV1.sol";
import { SponsorshipPaymasterV1 } from "../src/paymaster/SponsorshipPaymasterV1.sol";

/// @notice Deploys V1 and schedules the one-time factory wiring through the 1-hour timelock.
/// @dev Run only on Base Sepolia (84532). Finalize with FinalizeBootstrap after the delay.
contract DeployBaseSepolia is Script {
    uint256 internal constant BASE_SEPOLIA_CHAIN_ID = 84_532;
    uint256 internal constant TIMELOCK_DELAY = 1 hours;
    uint256 internal constant INITIAL_EXPOSURE_CAP = 50_000e6;
    address internal constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address internal constant CANONICAL_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant ENTRY_POINT_V08 = 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108;
    bytes32 internal constant BOOTSTRAP_SALT = keccak256("CPREDICT_V1_BOOTSTRAP");

    struct Deployment {
        TimelockController timelock;
        ProtocolConfigV1 config;
        EmergencyControllerV1 emergency;
        LaunchExposureGuardV1 guard;
        FeeVaultV1 feeVault;
        BondEscrowV1 bondEscrow;
        CloneMarketVaultV1 cloneImplementation;
        FullMarketDeployerV1 fullDeployer;
        MarketFactoryV1 factory;
        FixedPriceMarketplaceV1 marketplace;
        SponsorshipPaymasterV1 paymaster;
    }

    function run() external returns (Deployment memory deployed) {
        require(block.chainid == BASE_SEPOLIA_CHAIN_ID, "wrong chain");
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address governanceSafe = vm.envAddress("GOVERNANCE_SAFE");
        address emergencySafe = vm.envAddress("EMERGENCY_SAFE");
        address treasury = vm.envAddress("PROTOCOL_TREASURY");
        address sponsorSigner = vm.envAddress("SPONSOR_SIGNER");
        address usdc = vm.envOr("USDC_ADDRESS", BASE_SEPOLIA_USDC);
        address permit2 = vm.envOr("PERMIT2_ADDRESS", CANONICAL_PERMIT2);
        address entryPoint = vm.envOr("ENTRYPOINT_ADDRESS", ENTRY_POINT_V08);
        require(usdc.code.length != 0, "USDC code missing");
        require(permit2.code.length != 0, "Permit2 code missing");
        require(entryPoint.code.length != 0, "EntryPoint code missing");

        address[] memory proposers = new address[](2);
        proposers[0] = governanceSafe;
        proposers[1] = deployer;
        address[] memory executors = new address[](1);
        executors[0] = address(0);

        vm.startBroadcast(deployerKey);
        deployed.timelock = new TimelockController(TIMELOCK_DELAY, proposers, executors, deployer);
        address governance = address(deployed.timelock);
        deployed.config = new ProtocolConfigV1(governance, usdc, treasury);
        deployed.emergency = new EmergencyControllerV1(governance, emergencySafe);
        deployed.guard = new LaunchExposureGuardV1(governance, INITIAL_EXPOSURE_CAP);
        deployed.feeVault = new FeeVaultV1(governance, usdc);
        deployed.bondEscrow = new BondEscrowV1(governance, usdc);
        deployed.cloneImplementation = new CloneMarketVaultV1();
        deployed.fullDeployer = new FullMarketDeployerV1(governance);
        deployed.factory = _deployFactory(deployed, governance, permit2);
        deployed.marketplace = new FixedPriceMarketplaceV1(
            address(deployed.factory),
            address(deployed.emergency),
            address(deployed.feeVault),
            usdc,
            permit2
        );
        deployed.paymaster = new SponsorshipPaymasterV1(
            governance,
            address(deployed.emergency),
            IEntryPoint(entryPoint),
            sponsorSigner,
            vm.envOr("PAYMASTER_MAX_COST_PER_OP", uint256(0.002 ether)),
            vm.envOr("PAYMASTER_MAX_COST_PER_USER_DAY", uint256(0.02 ether)),
            vm.envOr("PAYMASTER_MAX_COST_GLOBAL_DAY", uint256(0.5 ether))
        );

        _scheduleBootstrap(deployed);
        vm.stopBroadcast();

        _writePendingManifest(
            deployed, governanceSafe, emergencySafe, deployer, usdc, permit2, entryPoint
        );
        console2.log("Timelock", address(deployed.timelock));
        console2.log("Factory", address(deployed.factory));
        console2.log("Bootstrap execute after", block.timestamp + TIMELOCK_DELAY);
    }

    function _scheduleBootstrap(Deployment memory deployed) internal {
        bytes32 expectedFactoryFingerprint =
            vm.envBytes32("EXPECTED_FACTORY_DEPENDENCY_FINGERPRINT");
        bytes32 actualFactoryFingerprint =
            deployed.factory.dependencyFingerprintFor(address(deployed.marketplace));
        // The first non-broadcast preview intentionally uses a non-matching expected value and
        // reads this value from the trace. An independently reviewed manifest must supply it for
        // the subsequent nonce-identical simulation and broadcast.
        console2.log("Factory dependency fingerprint (review before broadcast)");
        console2.logBytes32(actualFactoryFingerprint);
        require(
            actualFactoryFingerprint == expectedFactoryFingerprint,
            "factory dependency fingerprint mismatch"
        );
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) =
            _bootstrapBatch(deployed, expectedFactoryFingerprint);
        deployed.timelock
            .scheduleBatch(targets, values, payloads, bytes32(0), BOOTSTRAP_SALT, TIMELOCK_DELAY);
    }

    /// @dev Isolated only to keep the deployment script compilable in Foundry's unoptimized,
    /// non-viaIR coverage build. Deployment order and constructor arguments remain unchanged.
    function _deployFactory(Deployment memory deployed, address governance, address permit2)
        internal
        returns (MarketFactoryV1)
    {
        return new MarketFactoryV1(
            governance,
            address(deployed.config),
            address(deployed.emergency),
            address(deployed.guard),
            address(deployed.bondEscrow),
            address(deployed.feeVault),
            address(deployed.fullDeployer),
            address(deployed.cloneImplementation),
            permit2
        );
    }

    function _bootstrapBatch(Deployment memory deployed, bytes32 expectedFactoryFingerprint)
        internal
        pure
        returns (address[] memory targets, uint256[] memory values, bytes[] memory payloads)
    {
        targets = new address[](6);
        values = new uint256[](6);
        payloads = new bytes[](6);
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
        payloads[5] = abi.encodeCall(MarketFactoryV1.activate, (expectedFactoryFingerprint));
    }

    function _writePendingManifest(
        Deployment memory deployed,
        address governanceSafe,
        address emergencySafe,
        address deployer,
        address usdc,
        address permit2,
        address entryPoint
    ) internal {
        string memory root = "cpredict-v1-base-sepolia";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeString(root, "status", "BOOTSTRAP_SCHEDULED_NOT_FINAL");
        vm.serializeAddress(root, "temporaryAdmin", deployer);
        vm.serializeAddress(root, "governanceSafe", governanceSafe);
        vm.serializeAddress(root, "emergencySafe", emergencySafe);
        vm.serializeAddress(root, "timelock", address(deployed.timelock));
        vm.serializeAddress(root, "config", address(deployed.config));
        vm.serializeAddress(root, "emergencyController", address(deployed.emergency));
        vm.serializeAddress(root, "exposureGuard", address(deployed.guard));
        vm.serializeAddress(root, "feeVault", address(deployed.feeVault));
        vm.serializeAddress(root, "bondEscrow", address(deployed.bondEscrow));
        vm.serializeAddress(root, "cloneImplementation", address(deployed.cloneImplementation));
        vm.serializeAddress(root, "fullMarketDeployer", address(deployed.fullDeployer));
        vm.serializeAddress(root, "factory", address(deployed.factory));
        vm.serializeAddress(root, "marketplace", address(deployed.marketplace));
        vm.serializeBytes32(
            root,
            "factoryActivationFingerprint",
            deployed.factory.dependencyFingerprintFor(address(deployed.marketplace))
        );
        vm.serializeAddress(root, "paymaster", address(deployed.paymaster));
        vm.serializeAddress(root, "usdc", usdc);
        vm.serializeAddress(root, "permit2", permit2);
        string memory json = vm.serializeAddress(root, "entryPoint", entryPoint);
        vm.writeJson(json, "deployments/base-sepolia/pending.json");
    }
}
