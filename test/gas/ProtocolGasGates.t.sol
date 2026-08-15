// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { VmSafe } from "forge-std/Vm.sol";
import { ProtocolTestBase } from "../helpers/ProtocolTestBase.sol";
import { IMarketVaultV1 } from "../../src/interfaces/IMarketVaultV1.sol";
import { MarketVaultCoreV1 } from "../../src/market/MarketVaultCoreV1.sol";
import { ProtocolTypes } from "../../src/libraries/ProtocolTypes.sol";

contract CloneDeploymentGasHarness {
    function deployAndInitialize(
        address implementation,
        bytes32 salt,
        ProtocolTypes.MarketInitParams memory params
    ) external returns (address market) {
        market = Clones.cloneDeterministic(implementation, salt);
        params.factory = address(this);
        IMarketVaultV1(market).initialize(params);
    }
}

contract ProtocolGasGatesTest is ProtocolTestBase {
    uint256 internal constant FULL_DEPLOYMENT_GAS_LIMIT = 8_000_000;
    uint256 internal constant CLONE_DEPLOYMENT_AND_INIT_GAS_LIMIT = 600_000;
    uint256 internal constant ALLOWANCE_BUY_GAS_LIMIT = 300_000;
    uint256 internal constant LISTING_CREATE_GAS_LIMIT = 230_000;
    uint256 internal constant ALLOWANCE_FILL_GAS_LIMIT = 350_000;
    uint256 internal constant CLAIM_OR_REFUND_GAS_LIMIT = 250_000;
    uint256 internal constant FULL_RUNTIME_SIZE_LIMIT = 23 * 1024;
    uint256 internal constant EIP170_RUNTIME_SIZE_LIMIT = 24_576;

    function testGasGateFullCreate2Deployment() public {
        ProtocolTypes.CreateMarketParams memory params =
            _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        bytes32 salt = keccak256("gas-full");
        bytes memory callData = abi.encodeCall(factory.createMarket, (params, salt));
        vm.prank(CREATOR);
        uint256 gasBefore = gasleft();
        address market = factory.createMarket(params, salt);
        uint256 gasUsed = _transactionGas(gasBefore - gasleft(), callData);

        emit log_named_uint("full CREATE2 deployment transaction gas", gasUsed);
        _assertProductionGasLimit(gasUsed, FULL_DEPLOYMENT_GAS_LIMIT);
        _assertProductionRuntimeSize(market.code.length, FULL_RUNTIME_SIZE_LIMIT);
        _assertProductionRuntimeSize(address(fullDeployer).code.length, EIP170_RUNTIME_SIZE_LIMIT);
    }

    function testGasGateCloneDeploymentAndInitialization() public {
        CloneDeploymentGasHarness harness = new CloneDeploymentGasHarness();
        ProtocolTypes.MarketInitParams memory params = _cloneInitParams(address(harness));

        uint256 gasBefore = gasleft();
        address market = harness.deployAndInitialize(
            address(cloneImplementation), keccak256("gas-clone"), params
        );
        uint256 gasUsed = gasBefore - gasleft();

        emit log_named_uint("clone deployment and initialization gas", gasUsed);
        _assertProductionGasLimit(gasUsed, CLONE_DEPLOYMENT_AND_INIT_GAS_LIMIT);
        assertEq(market.code.length, 45);
    }

    function testGasGateAllowanceBuy() public {
        MarketVaultCoreV1 market = _createDefault();
        _approveMarket(ALICE, market);
        _coolProtocol(address(market));
        bytes memory callData =
            abi.encodeCall(market.buy, (0, 20e6, 20e6, 20e6, uint64(block.timestamp + 1 hours)));

        vm.prank(ALICE);
        uint256 gasBefore = gasleft();
        market.buy(0, 20e6, 20e6, 20e6, uint64(block.timestamp + 1 hours));
        uint256 gasUsed = _transactionGas(gasBefore - gasleft(), callData);

        emit log_named_uint("allowance primary buy transaction gas", gasUsed);
        _assertProductionGasLimit(gasUsed, ALLOWANCE_BUY_GAS_LIMIT);
    }

    function testGasGateListingCreate() public {
        MarketVaultCoreV1 market = _createDefault();
        _buy(market, ALICE, 0, 20e6);
        vm.prank(ALICE);
        market.setApprovalForAll(address(marketplace), true);
        _coolProtocol(address(market));
        bytes memory callData = abi.encodeCall(
            marketplace.createListing,
            (address(market), 0, 10e6, 900_000, uint64(block.timestamp + 1 days))
        );

        vm.prank(ALICE);
        uint256 gasBefore = gasleft();
        marketplace.createListing(
            address(market), 0, 10e6, 900_000, uint64(block.timestamp + 1 days)
        );
        uint256 gasUsed = _transactionGas(gasBefore - gasleft(), callData);

        emit log_named_uint("listing create transaction gas", gasUsed);
        _assertProductionGasLimit(gasUsed, LISTING_CREATE_GAS_LIMIT);
    }

    function testGasGateAllowanceFill() public {
        config.setPlatformC2CFeeBps(100);
        ProtocolTypes.CreateMarketParams memory params =
            _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.creatorC2CFeeBps = 100;
        MarketVaultCoreV1 market = _create(params, keccak256("gas-fill"));
        _buy(market, ALICE, 0, 20e6);
        vm.prank(ALICE);
        market.setApprovalForAll(address(marketplace), true);
        vm.prank(ALICE);
        bytes32 listingId = marketplace.createListing(
            address(market), 0, 10e6, 900_000, uint64(block.timestamp + 1 days)
        );
        _coolProtocol(address(market));
        bytes memory callData = abi.encodeCall(
            marketplace.fillListing, (listingId, 10e6, 10e6, 9e6, uint64(block.timestamp + 1 hours))
        );

        vm.prank(BOB);
        uint256 gasBefore = gasleft();
        marketplace.fillListing(listingId, 10e6, 10e6, 9e6, uint64(block.timestamp + 1 hours));
        uint256 gasUsed = _transactionGas(gasBefore - gasleft(), callData);

        emit log_named_uint("allowance listing fill transaction gas", gasUsed);
        _assertProductionGasLimit(gasUsed, ALLOWANCE_FILL_GAS_LIMIT);
    }

    function testGasGateWinnerClaim() public {
        MarketVaultCoreV1 market = _createDefault();
        _buy(market, ALICE, 0, 20e6);
        vm.warp(market.closeAt());
        vm.prank(CREATOR);
        market.resolve(0, keccak256("gas-resolution-evidence"));
        _coolProtocol(address(market));
        bytes memory callData = abi.encodeCall(market.claimWinnings, ());

        vm.prank(ALICE);
        uint256 gasBefore = gasleft();
        market.claimWinnings();
        uint256 gasUsed = _transactionGas(gasBefore - gasleft(), callData);

        emit log_named_uint("winner claim transaction gas", gasUsed);
        _assertProductionGasLimit(gasUsed, CLAIM_OR_REFUND_GAS_LIMIT);
    }

    function testGasGatePrincipalRefund() public {
        MarketVaultCoreV1 market = _createDefault();
        _buy(market, ALICE, 0, 20e6);
        vm.prank(CREATOR);
        market.creatorVoid(keccak256("gas-void-evidence"));
        _coolProtocol(address(market));
        bytes memory callData = abi.encodeCall(market.refund, ());

        vm.prank(ALICE);
        uint256 gasBefore = gasleft();
        market.refund();
        uint256 gasUsed = _transactionGas(gasBefore - gasleft(), callData);

        emit log_named_uint("principal refund transaction gas", gasUsed);
        _assertProductionGasLimit(gasUsed, CLAIM_OR_REFUND_GAS_LIMIT);
    }

    function _coolProtocol(address market) internal {
        vm.cool(market);
        vm.cool(address(usdc));
        vm.cool(address(factory));
        vm.cool(address(marketplace));
        vm.cool(address(config));
        vm.cool(address(emergency));
        vm.cool(address(guard));
        vm.cool(address(feeVault));
        vm.cool(address(bondEscrow));
    }

    function _transactionGas(uint256 executionGas, bytes memory callData)
        internal
        pure
        returns (uint256 total)
    {
        total = executionGas + 21_000;
        for (uint256 i; i < callData.length; ++i) {
            total += callData[i] == bytes1(0) ? 4 : 16;
        }
    }

    /// @dev Coverage deliberately recompiles with minimum optimization. The operation above still
    /// executes and is recorded, while the optimizer-sensitive threshold remains enforced by the
    /// production-viaIR gas gate.
    function _assertProductionGasLimit(uint256 gasUsed, uint256 limit) internal view {
        if (!vm.isContext(VmSafe.ForgeContext.Coverage)) assertLt(gasUsed, limit);
    }

    function _assertProductionRuntimeSize(uint256 runtimeSize, uint256 limit) internal view {
        if (!vm.isContext(VmSafe.ForgeContext.Coverage)) assertLt(runtimeSize, limit);
    }

    function _cloneInitParams(address initializer)
        internal
        view
        returns (ProtocolTypes.MarketInitParams memory)
    {
        return ProtocolTypes.MarketInitParams({
            factory: initializer,
            paymentToken: address(usdc),
            config: address(config),
            emergencyController: address(emergency),
            exposureGuard: address(guard),
            bondEscrow: address(bondEscrow),
            feeVault: address(feeVault),
            permit2: address(0),
            creator: CREATOR,
            rulesHash: keccak256("gas-clone-rules"),
            metadataURI: "ipfs://gas-clone/{id}.json",
            resolutionSourceHash: keccak256("gas-clone-source"),
            resolutionSourceURI: "https://example.com/gas-clone-source",
            outcomeCount: 2,
            createdAt: uint64(block.timestamp),
            closeAt: uint64(block.timestamp + 1 days),
            earlyBirdStart: uint64(block.timestamp),
            creatorTreasury: CREATOR_TREASURY,
            deploymentMode: ProtocolTypes.DeploymentMode.CLONE,
            featureFlags: ProtocolTypes.FEATURE_EARLY_BIRD,
            perUserPrimaryCap: 100e6,
            marketPrimaryCap: 100e6,
            minimumPrimaryUnits: 10_000,
            minimumC2CUnits: 10_000,
            creatorBond: 10e6,
            economics: ProtocolTypes.EconomicSnapshot({
                creatorRakeBps: 500,
                protocolShareBps: 2000,
                earlyBirdShareBps: 2000,
                platformC2CFeeBps: 0,
                creatorC2CFeeBps: 0,
                protocolTreasury: PROTOCOL_TREASURY
            })
        });
    }
}
