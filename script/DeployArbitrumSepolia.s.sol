// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Script, console2 } from "forge-std/Script.sol";
import { VmSafe } from "forge-std/Vm.sol";
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";
import { IEntryPoint } from "@account-abstraction/interfaces/IEntryPoint.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
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
import { CpredictSandboxToken } from "../src/testnet/CpredictSandboxToken.sol";

/// @notice Deploys V1 and schedules the one-time factory wiring through the Timelock.
/// @dev Sandbox and debug deployments use a zero delay; formal retains the 1-hour delay.
contract DeployArbitrumSepolia is Script {
    uint256 internal constant ARBITRUM_SEPOLIA_CHAIN_ID = 421_614;
    uint256 internal constant TIMELOCK_DELAY = 1 hours;
    uint256 internal constant INITIAL_EXPOSURE_CAP = 50_000e6;
    address internal constant ARBITRUM_SEPOLIA_USDC = 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d;
    address internal constant CANONICAL_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant ENTRY_POINT_V08 = 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108;
    bytes32 internal constant BOOTSTRAP_SALT = keccak256("CPREDICT_V1_BOOTSTRAP");

    struct Deployment {
        CpredictSandboxToken sandboxToken;
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

    struct DeploymentInputs {
        address deployer;
        address governanceSafe;
        address emergencySafe;
        address treasury;
        address sponsorSigner;
        bool sandboxTokenEnabled;
        uint64 resolutionWindow;
    }

    function run() external returns (Deployment memory deployed) {
        require(block.chainid == ARBITRUM_SEPOLIA_CHAIN_ID, "wrong chain");
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        DeploymentInputs memory inputs = _loadDeploymentInputs(deployerKey);
        _validateExternalDependencies(inputs.sandboxTokenEnabled);

        vm.startBroadcast(deployerKey);
        deployed = _deployContracts(inputs);

        bytes32 actualFactoryFingerprint = _factoryFingerprint(deployed);
        console2.log("CPREDICT_FACTORY_DEPENDENCY_FINGERPRINT");
        console2.logBytes32(actualFactoryFingerprint);

        // The orchestrator uses one non-broadcast preview to derive the address-bound
        // dependency fingerprint. A preview must never schedule the bootstrap or write
        // deployment evidence that could be mistaken for a broadcast result.
        if (vm.envOr("DEPLOYMENT_PREVIEW_ONLY", false)) {
            require(
                !vm.isContext(VmSafe.ForgeContext.ScriptBroadcast), "preview mode cannot broadcast"
            );
            vm.stopBroadcast();
            console2.log("Preview complete; no transaction was broadcast or scheduled");
            return deployed;
        }

        _scheduleBootstrap(deployed, actualFactoryFingerprint);
        vm.stopBroadcast();

        // A dry-run must never leave an address file that could be mistaken for broadcast evidence.
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            _writePendingManifest(deployed, inputs);
        }
        console2.log("Timelock", address(deployed.timelock));
        console2.log("Factory", address(deployed.factory));
        console2.log("Bootstrap execute after", block.timestamp + _timelockDelay());
    }

    function _loadDeploymentInputs(uint256 deployerKey)
        internal
        view
        returns (DeploymentInputs memory inputs)
    {
        inputs.deployer = vm.addr(deployerKey);
        inputs.governanceSafe = vm.envAddress("GOVERNANCE_SAFE");
        inputs.emergencySafe = vm.envAddress("EMERGENCY_SAFE");
        inputs.treasury = vm.envAddress("PROTOCOL_TREASURY");
        inputs.sponsorSigner = vm.envAddress("SPONSOR_SIGNER");
        inputs.sandboxTokenEnabled = vm.envOr("CPREDICT_SANDBOX_TOKEN_ENABLED", false);
        uint256 resolutionWindow = vm.envOr("MARKET_RESOLUTION_WINDOW_SECONDS", uint256(24 hours));
        require(resolutionWindow <= type(uint64).max, "resolution window overflow");
        inputs.resolutionWindow = uint64(resolutionWindow);
    }

    function _validateExternalDependencies(bool sandboxTokenEnabled) internal view {
        require(CANONICAL_PERMIT2.code.length != 0, "Permit2 code missing");
        require(ENTRY_POINT_V08.code.length != 0, "EntryPoint code missing");
        if (!sandboxTokenEnabled) {
            require(ARBITRUM_SEPOLIA_USDC.code.length != 0, "USDC code missing");
            require(IERC20Metadata(ARBITRUM_SEPOLIA_USDC).decimals() == 6, "USDC decimals mismatch");
        }
    }

    function _deployContracts(DeploymentInputs memory inputs)
        internal
        returns (Deployment memory deployed)
    {
        address[] memory proposers = new address[](2);
        proposers[0] = inputs.governanceSafe;
        proposers[1] = inputs.deployer;
        address[] memory executors = new address[](1);
        executors[0] = address(0);

        address paymentToken = ARBITRUM_SEPOLIA_USDC;
        if (inputs.sandboxTokenEnabled) {
            deployed.sandboxToken = new CpredictSandboxToken();
            paymentToken = address(deployed.sandboxToken);
        }
        deployed.timelock =
            new TimelockController(_timelockDelay(), proposers, executors, inputs.deployer);
        address governance = address(deployed.timelock);
        deployed.config = new ProtocolConfigV1(governance, paymentToken, inputs.treasury);
        deployed.emergency = new EmergencyControllerV1(governance, inputs.emergencySafe);
        deployed.guard = new LaunchExposureGuardV1(governance, INITIAL_EXPOSURE_CAP);
        deployed.feeVault = new FeeVaultV1(governance, paymentToken);
        deployed.bondEscrow = new BondEscrowV1(governance, paymentToken);
        deployed.cloneImplementation = new CloneMarketVaultV1();
        deployed.fullDeployer = new FullMarketDeployerV1(governance);
        deployed.factory =
            _deployFactory(deployed, governance, inputs.resolutionWindow, CANONICAL_PERMIT2);
        deployed.marketplace = new FixedPriceMarketplaceV1(
            address(deployed.factory),
            address(deployed.emergency),
            address(deployed.feeVault),
            paymentToken,
            CANONICAL_PERMIT2
        );
        deployed.paymaster = new SponsorshipPaymasterV1(
            governance,
            address(deployed.emergency),
            IEntryPoint(ENTRY_POINT_V08),
            inputs.sponsorSigner,
            vm.envOr("PAYMASTER_MAX_COST_PER_OP", uint256(0.002 ether)),
            vm.envOr("PAYMASTER_MAX_COST_PER_USER_DAY", uint256(0.02 ether)),
            vm.envOr("PAYMASTER_MAX_COST_GLOBAL_DAY", uint256(0.5 ether))
        );
    }

    function _factoryFingerprint(Deployment memory deployed) internal view returns (bytes32) {
        return deployed.factory.dependencyFingerprintFor(address(deployed.marketplace));
    }

    function _scheduleBootstrap(Deployment memory deployed, bytes32 actualFactoryFingerprint)
        internal
    {
        bytes32 expectedFactoryFingerprint =
            vm.envBytes32("EXPECTED_FACTORY_DEPENDENCY_FINGERPRINT");
        require(
            actualFactoryFingerprint == expectedFactoryFingerprint,
            "factory dependency fingerprint mismatch"
        );
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) =
            _bootstrapBatch(deployed, expectedFactoryFingerprint);
        deployed.timelock.scheduleBatch(
            targets, values, payloads, bytes32(0), BOOTSTRAP_SALT, _timelockDelay()
        );
    }

    function _timelockDelay() internal view returns (uint256) {
        return vm.envOr("CPREDICT_TIMELOCK_DELAY_SECONDS", TIMELOCK_DELAY);
    }

    /// @dev Isolated only to keep the deployment script compilable in Foundry's unoptimized,
    /// non-viaIR coverage build. Deployment order and constructor arguments remain unchanged.
    function _deployFactory(
        Deployment memory deployed,
        address governance,
        uint64 resolutionWindow,
        address permit2
    ) internal returns (MarketFactoryV1) {
        return new MarketFactoryV1(
            governance,
            address(deployed.config),
            address(deployed.emergency),
            address(deployed.guard),
            address(deployed.bondEscrow),
            address(deployed.feeVault),
            address(deployed.fullDeployer),
            address(deployed.cloneImplementation),
            resolutionWindow,
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

    function _writePendingManifest(Deployment memory deployed, DeploymentInputs memory inputs)
        internal
    {
        address paymentToken =
            inputs.sandboxTokenEnabled ? address(deployed.sandboxToken) : ARBITRUM_SEPOLIA_USDC;
        string memory root = "cpredict-v1-arbitrum-sepolia";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeString(root, "status", "BOOTSTRAP_SCHEDULED_NOT_FINAL");
        vm.serializeString(
            root,
            "paymentTokenKind",
            inputs.sandboxTokenEnabled ? "sandbox-test-token" : "canonical-usdc"
        );
        vm.serializeAddress(root, "temporaryAdmin", inputs.deployer);
        vm.serializeAddress(root, "governanceSafe", inputs.governanceSafe);
        vm.serializeAddress(root, "emergencySafe", inputs.emergencySafe);
        vm.serializeAddress(root, "protocolTreasury", deployed.config.protocolTreasury());
        vm.serializeAddress(root, "sponsorSigner", deployed.paymaster.sponsorSigner());
        vm.serializeUint(root, "paymasterPolicyVersion", deployed.paymaster.policyVersion());
        vm.serializeUint(root, "marketResolutionWindowSeconds", inputs.resolutionWindow);
        vm.serializeString(
            root,
            "paymasterMaxCostPerOperation",
            vm.toString(deployed.paymaster.maxCostPerOperation())
        );
        vm.serializeString(
            root,
            "paymasterMaxCostPerUserDay",
            vm.toString(deployed.paymaster.maxCostPerUserPerDay())
        );
        vm.serializeString(
            root, "paymasterMaxCostGlobalDay", vm.toString(deployed.paymaster.maxCostGlobalPerDay())
        );
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
        vm.serializeAddress(root, "usdc", paymentToken);
        vm.serializeAddress(root, "permit2", CANONICAL_PERMIT2);
        string memory json = vm.serializeAddress(root, "entryPoint", ENTRY_POINT_V08);
        vm.writeJson(json, "deployments/arbitrum-sepolia/pending.json");
    }
}
