// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";
import { VmSafe } from "forge-std/Vm.sol";
import { ISignatureTransfer } from "permit2/interfaces/ISignatureTransfer.sol";
import { ProtocolConfigV1 } from "../../src/core/ProtocolConfigV1.sol";
import { EmergencyControllerV1 } from "../../src/core/EmergencyControllerV1.sol";
import { LaunchExposureGuardV1 } from "../../src/core/LaunchExposureGuardV1.sol";
import { FeeVaultV1 } from "../../src/core/FeeVaultV1.sol";
import { BondEscrowV1 } from "../../src/core/BondEscrowV1.sol";
import { FullMarketDeployerV1 } from "../../src/core/FullMarketDeployerV1.sol";
import { MarketFactoryV1 } from "../../src/core/MarketFactoryV1.sol";
import { CloneMarketVaultV1 } from "../../src/market/CloneMarketVaultV1.sol";
import { MarketVaultCoreV1 } from "../../src/market/MarketVaultCoreV1.sol";
import { FixedPriceMarketplaceV1 } from "../../src/marketplace/FixedPriceMarketplaceV1.sol";
import { ProtocolTypes } from "../../src/libraries/ProtocolTypes.sol";
import { InvalidConfiguration, PauseActive } from "../../src/libraries/ProtocolErrors.sol";
import { MockUSDC } from "../mocks/MockUSDC.sol";

contract Permit2FlowsTest is Test {
    bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH =
        keccak256("TokenPermissions(address token,uint256 amount)");
    string internal constant PERMIT_WITNESS_STUB =
        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,";
    bytes32 internal constant BUY_WITNESS_TYPEHASH = keccak256(
        "BuyWitness(address owner,address vault,bytes4 selector,uint256 outcomeId,uint256 desiredUnits,uint256 minUnits,uint256 maxPayment,uint64 callDeadline,uint256 chainId)"
    );
    bytes32 internal constant FILL_WITNESS_TYPEHASH = keccak256(
        "FillWitness(address buyer,address marketplace,bytes4 selector,bytes32 listingId,uint256 desiredUnits,uint256 minUnits,uint256 maxGross,uint64 callDeadline,uint256 chainId)"
    );
    string internal constant CANONICAL_BUY_WITNESS_TYPE_STRING =
        "BuyWitness witness)BuyWitness(address owner,address vault,bytes4 selector,uint256 outcomeId,uint256 desiredUnits,uint256 minUnits,uint256 maxPayment,uint64 callDeadline,uint256 chainId)TokenPermissions(address token,uint256 amount)";
    string internal constant CANONICAL_FILL_WITNESS_TYPE_STRING =
        "FillWitness witness)FillWitness(address buyer,address marketplace,bytes4 selector,bytes32 listingId,uint256 desiredUnits,uint256 minUnits,uint256 maxGross,uint64 callDeadline,uint256 chainId)TokenPermissions(address token,uint256 amount)";
    bytes32 internal constant CANONICAL_BUY_PERMIT_TYPEHASH =
        0xc9dbc824623fb8300107b3010680a602ae790a6529d3c09cc41d33bc64921d39;
    bytes32 internal constant CANONICAL_FILL_PERMIT_TYPEHASH =
        0xefb50c03a4f1029c0dddcad5df235e18f1e8bfa9bdeea012e382fbbe9096be19;

    uint256 internal constant ALICE_KEY = 0xA11CE;
    uint256 internal constant BOB_KEY = 0xB0B;
    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant CREATOR_TREASURY = address(0xCAFE);
    address internal constant PROTOCOL_TREASURY = address(0xFEE);
    address internal constant EMERGENCY_SAFE = address(0xE911);

    MockUSDC internal usdc;
    ISignatureTransfer internal permit2;
    EmergencyControllerV1 internal emergency;
    FeeVaultV1 internal feeVault;
    MarketFactoryV1 internal factory;
    FixedPriceMarketplaceV1 internal marketplace;
    MarketVaultCoreV1 internal market;
    address internal alice;
    address internal bob;

    function setUp() public {
        alice = vm.addr(ALICE_KEY);
        bob = vm.addr(BOB_KEY);
        usdc = new MockUSDC();
        permit2 = ISignatureTransfer(deployCode("Permit2.sol:Permit2"));
        ProtocolConfigV1 config =
            new ProtocolConfigV1(address(this), address(usdc), PROTOCOL_TREASURY);
        config.setPlatformC2CFeeBps(100);
        emergency = new EmergencyControllerV1(address(this), EMERGENCY_SAFE);
        LaunchExposureGuardV1 guard = new LaunchExposureGuardV1(address(this), 50_000e6);
        feeVault = new FeeVaultV1(address(this), address(usdc));
        BondEscrowV1 bondEscrow = new BondEscrowV1(address(this), address(usdc));
        CloneMarketVaultV1 cloneImplementation = new CloneMarketVaultV1();
        FullMarketDeployerV1 fullDeployer = new FullMarketDeployerV1(address(this));
        factory = new MarketFactoryV1(
            address(this),
            address(config),
            address(emergency),
            address(guard),
            address(bondEscrow),
            address(feeVault),
            address(fullDeployer),
            address(cloneImplementation),
            address(permit2)
        );
        guard.setFactory(address(factory));
        feeVault.setFactory(address(factory));
        bondEscrow.setFactory(address(factory));
        fullDeployer.setFactory(address(factory));
        marketplace = new FixedPriceMarketplaceV1(
            address(factory), address(emergency), address(feeVault), address(usdc), address(permit2)
        );
        factory.setMarketplace(address(marketplace));
        factory.activate(factory.dependencyFingerprint());

        usdc.mint(CREATOR, 100e6);
        usdc.mint(alice, 100e6);
        usdc.mint(bob, 100e6);
        vm.prank(CREATOR);
        usdc.approve(address(factory), type(uint256).max);
        vm.prank(alice);
        usdc.approve(address(permit2), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(permit2), type(uint256).max);

        ProtocolTypes.CreateMarketParams memory params = ProtocolTypes.CreateMarketParams({
            rulesHash: keccak256("permit2-rules"),
            metadataURI: "ipfs://permit2/{id}.json",
            resolutionSourceHash: bytes32(0),
            resolutionSourceURI: "",
            outcomeCount: 2,
            closeAt: uint64(block.timestamp + 1 days),
            earlyBirdStart: uint64(block.timestamp),
            creatorTreasury: CREATOR_TREASURY,
            deploymentMode: ProtocolTypes.DeploymentMode.FULL,
            featureFlags: ProtocolTypes.FEATURE_EARLY_BIRD | ProtocolTypes.FEATURE_PERMIT2,
            creatorRakeBps: 500,
            creatorC2CFeeBps: 100,
            perUserPrimaryCap: 100e6,
            marketPrimaryCap: 100e6,
            minimumPrimaryUnits: 10_000,
            minimumC2CUnits: 10_000,
            creatorBond: 10e6
        });
        vm.prank(CREATOR);
        market = MarketVaultCoreV1(factory.createMarket(params, bytes32("permit2")));
    }

    function testPrimaryBuyWithWitnessPermitAndReplayProtection() public {
        uint64 callDeadline = uint64(block.timestamp + 1 hours);
        ISignatureTransfer.PermitTransferFrom memory permit = _permit(20e6, 11);
        bytes32 witness = keccak256(
            abi.encode(
                BUY_WITNESS_TYPEHASH,
                alice,
                address(market),
                MarketVaultCoreV1.buyWithPermit2.selector,
                0,
                20e6,
                20e6,
                20e6,
                callDeadline,
                block.chainid
            )
        );
        bytes memory signature = _signPermit(
            address(market), permit, witness, CANONICAL_BUY_WITNESS_TYPE_STRING, ALICE_KEY
        );

        market.buyWithPermit2(alice, 0, 20e6, 20e6, 20e6, callDeadline, permit, signature);
        assertEq(market.balanceOf(alice, 0), 20e6);
        assertEq(usdc.balanceOf(address(market)), 20e6);

        vm.expectRevert();
        market.buyWithPermit2(alice, 0, 20e6, 20e6, 20e6, callDeadline, permit, signature);
    }

    function testGasGatePrimaryPermit2BuyUnder370k() public {
        uint64 callDeadline = uint64(block.timestamp + 1 hours);
        ISignatureTransfer.PermitTransferFrom memory permit = _permit(20e6, 101);
        bytes32 witness = keccak256(
            abi.encode(
                BUY_WITNESS_TYPEHASH,
                alice,
                address(market),
                MarketVaultCoreV1.buyWithPermit2.selector,
                0,
                20e6,
                20e6,
                20e6,
                callDeadline,
                block.chainid
            )
        );
        bytes memory signature = _signPermit(
            address(market), permit, witness, CANONICAL_BUY_WITNESS_TYPE_STRING, ALICE_KEY
        );
        _coolPermit2Path();
        bytes memory callData = abi.encodeCall(
            market.buyWithPermit2, (alice, 0, 20e6, 20e6, 20e6, callDeadline, permit, signature)
        );

        uint256 gasBefore = gasleft();
        market.buyWithPermit2(alice, 0, 20e6, 20e6, 20e6, callDeadline, permit, signature);
        uint256 gasUsed = _transactionGas(gasBefore - gasleft(), callData);

        emit log_named_uint("Permit2 primary buy transaction gas", gasUsed);
        _assertProductionGasLimit(gasUsed, 370_000);
    }

    function testPrimaryWitnessCannotBeReusedWithChangedOutcome() public {
        uint64 callDeadline = uint64(block.timestamp + 1 hours);
        ISignatureTransfer.PermitTransferFrom memory permit = _permit(20e6, 12);
        bytes32 witness = keccak256(
            abi.encode(
                BUY_WITNESS_TYPEHASH,
                alice,
                address(market),
                MarketVaultCoreV1.buyWithPermit2.selector,
                0,
                20e6,
                20e6,
                20e6,
                callDeadline,
                block.chainid
            )
        );
        bytes memory signature = _signPermit(
            address(market), permit, witness, CANONICAL_BUY_WITNESS_TYPE_STRING, ALICE_KEY
        );
        vm.expectRevert();
        market.buyWithPermit2(alice, 1, 20e6, 20e6, 20e6, callDeadline, permit, signature);
    }

    function testMarketplaceFillWithWitnessPermit() public {
        _standardBuyAlice(20e6);
        vm.prank(alice);
        market.setApprovalForAll(address(marketplace), true);
        vm.prank(alice);
        bytes32 listingId = marketplace.createListing(
            address(market), 0, 10e6, 900_000, uint64(block.timestamp + 1 days)
        );

        uint64 callDeadline = uint64(block.timestamp + 1 hours);
        ISignatureTransfer.PermitTransferFrom memory permit = _permit(9e6, 21);
        bytes32 witness = keccak256(
            abi.encode(
                FILL_WITNESS_TYPEHASH,
                bob,
                address(marketplace),
                FixedPriceMarketplaceV1.fillListingWithPermit2.selector,
                listingId,
                10e6,
                10e6,
                9e6,
                callDeadline,
                block.chainid
            )
        );
        bytes memory signature = _signPermit(
            address(marketplace), permit, witness, CANONICAL_FILL_WITNESS_TYPE_STRING, BOB_KEY
        );
        marketplace.fillListingWithPermit2(
            listingId, bob, 10e6, 10e6, 9e6, callDeadline, permit, signature
        );
        assertEq(market.balanceOf(bob, 0), 10e6);
        assertEq(usdc.balanceOf(address(marketplace)), 0);
        assertEq(feeVault.creditOf(PROTOCOL_TREASURY), 90_000);
    }

    function testGasGateMarketplacePermit2FillUnder430k() public {
        _standardBuyAlice(20e6);
        vm.prank(alice);
        market.setApprovalForAll(address(marketplace), true);
        vm.prank(alice);
        bytes32 listingId = marketplace.createListing(
            address(market), 0, 10e6, 900_000, uint64(block.timestamp + 1 days)
        );

        uint64 callDeadline = uint64(block.timestamp + 1 hours);
        ISignatureTransfer.PermitTransferFrom memory permit = _permit(9e6, 102);
        bytes32 witness = keccak256(
            abi.encode(
                FILL_WITNESS_TYPEHASH,
                bob,
                address(marketplace),
                FixedPriceMarketplaceV1.fillListingWithPermit2.selector,
                listingId,
                10e6,
                10e6,
                9e6,
                callDeadline,
                block.chainid
            )
        );
        bytes memory signature = _signPermit(
            address(marketplace), permit, witness, CANONICAL_FILL_WITNESS_TYPE_STRING, BOB_KEY
        );
        _coolPermit2Path();
        bytes memory callData = abi.encodeCall(
            marketplace.fillListingWithPermit2,
            (listingId, bob, 10e6, 10e6, 9e6, callDeadline, permit, signature)
        );

        uint256 gasBefore = gasleft();
        marketplace.fillListingWithPermit2(
            listingId, bob, 10e6, 10e6, 9e6, callDeadline, permit, signature
        );
        uint256 gasUsed = _transactionGas(gasBefore - gasleft(), callData);

        emit log_named_uint("Permit2 listing fill transaction gas", gasUsed);
        _assertProductionGasLimit(gasUsed, 430_000);
    }

    function _coolPermit2Path() internal {
        vm.cool(address(market));
        vm.cool(address(marketplace));
        vm.cool(address(permit2));
        vm.cool(address(usdc));
        vm.cool(address(factory));
        vm.cool(address(emergency));
        vm.cool(address(feeVault));
    }

    /// @dev Coverage uses minimum optimization; production-viaIR gas gates own these thresholds.
    function _assertProductionGasLimit(uint256 gasUsed, uint256 limit) internal view {
        if (!vm.isContext(VmSafe.ForgeContext.Coverage)) assertLt(gasUsed, limit);
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

    function testCanonicalWitnessReferenceVectorsAndContractExposure() public view {
        assertEq(
            keccak256(abi.encodePacked(PERMIT_WITNESS_STUB, CANONICAL_BUY_WITNESS_TYPE_STRING)),
            CANONICAL_BUY_PERMIT_TYPEHASH
        );
        assertEq(
            keccak256(abi.encodePacked(PERMIT_WITNESS_STUB, CANONICAL_FILL_WITNESS_TYPE_STRING)),
            CANONICAL_FILL_PERMIT_TYPEHASH
        );
        assertEq(market.BUY_WITNESS_TYPEHASH(), BUY_WITNESS_TYPEHASH);
        assertEq(marketplace.FILL_WITNESS_TYPEHASH(), FILL_WITNESS_TYPEHASH);
        assertEq(
            keccak256(bytes(market.BUY_WITNESS_TYPE_STRING())),
            keccak256(bytes(CANONICAL_BUY_WITNESS_TYPE_STRING))
        );
        assertEq(
            keccak256(bytes(marketplace.FILL_WITNESS_TYPE_STRING())),
            keccak256(bytes(CANONICAL_FILL_WITNESS_TYPE_STRING))
        );
    }

    function testPrimaryPermit2PauseAndPermissionChecksFailBeforeSignatureUse() public {
        ISignatureTransfer.PermitTransferFrom memory permit = _permit(20e6, 31);
        vm.prank(EMERGENCY_SAFE);
        emergency.pause(ProtocolTypes.PAUSE_PERMIT2, 1 hours);
        vm.expectRevert(abi.encodeWithSelector(PauseActive.selector, ProtocolTypes.PAUSE_PERMIT2));
        market.buyWithPermit2(
            alice, 0, 20e6, 20e6, 20e6, uint64(block.timestamp + 1 hours), permit, ""
        );
    }

    function testPrimaryPermit2RejectsWrongTokenAndInsufficientPermission() public {
        ISignatureTransfer.PermitTransferFrom memory wrongToken = _permit(20e6, 32);
        wrongToken.permitted.token = address(0);
        vm.expectPartialRevert(InvalidConfiguration.selector);
        market.buyWithPermit2(
            alice, 0, 20e6, 20e6, 20e6, uint64(block.timestamp + 1 hours), wrongToken, ""
        );

        ISignatureTransfer.PermitTransferFrom memory insufficient = _permit(20e6 - 1, 33);
        vm.expectPartialRevert(InvalidConfiguration.selector);
        market.buyWithPermit2(
            alice, 0, 20e6, 20e6, 20e6, uint64(block.timestamp + 1 hours), insufficient, ""
        );
    }

    function testMarketplacePermit2PauseAndPermissionChecksFailBeforeSignatureUse() public {
        _standardBuyAlice(20e6);
        vm.prank(alice);
        market.setApprovalForAll(address(marketplace), true);
        vm.prank(alice);
        bytes32 listingId = marketplace.createListing(
            address(market), 0, 10e6, 900_000, uint64(block.timestamp + 1 days)
        );

        ISignatureTransfer.PermitTransferFrom memory wrongToken = _permit(9e6, 34);
        wrongToken.permitted.token = address(0);
        vm.expectPartialRevert(InvalidConfiguration.selector);
        marketplace.fillListingWithPermit2(
            listingId, bob, 10e6, 10e6, 9e6, uint64(block.timestamp + 1 hours), wrongToken, ""
        );

        ISignatureTransfer.PermitTransferFrom memory insufficient = _permit(9e6 - 1, 35);
        vm.expectPartialRevert(InvalidConfiguration.selector);
        marketplace.fillListingWithPermit2(
            listingId, bob, 10e6, 10e6, 9e6, uint64(block.timestamp + 1 hours), insufficient, ""
        );

        vm.prank(EMERGENCY_SAFE);
        emergency.pause(ProtocolTypes.PAUSE_PERMIT2, 1 hours);
        ISignatureTransfer.PermitTransferFrom memory permit = _permit(9e6, 36);
        vm.expectRevert(abi.encodeWithSelector(PauseActive.selector, ProtocolTypes.PAUSE_PERMIT2));
        marketplace.fillListingWithPermit2(
            listingId, bob, 10e6, 10e6, 9e6, uint64(block.timestamp + 1 hours), permit, ""
        );
    }

    function testMarketplacePermit2RespectsMarketFeatureFlag() public {
        vm.prank(CREATOR);
        market.updateBeforeFirstBuy(
            keccak256("permit2-rules"),
            "ipfs://permit2/{id}.json",
            bytes32(0),
            "",
            uint64(block.timestamp + 1 days),
            uint64(block.timestamp),
            CREATOR_TREASURY,
            ProtocolTypes.FEATURE_EARLY_BIRD
        );
        _standardBuyAlice(20e6);
        vm.prank(alice);
        market.setApprovalForAll(address(marketplace), true);
        vm.prank(alice);
        bytes32 listingId = marketplace.createListing(
            address(market), 0, 10e6, 900_000, uint64(block.timestamp + 1 days)
        );

        ISignatureTransfer.PermitTransferFrom memory permit = _permit(9e6, 22);
        vm.expectRevert();
        marketplace.fillListingWithPermit2(
            listingId, bob, 10e6, 10e6, 9e6, uint64(block.timestamp + 1 hours), permit, hex""
        );
    }

    function _standardBuyAlice(uint256 amount) internal {
        vm.prank(alice);
        usdc.approve(address(market), type(uint256).max);
        vm.prank(alice);
        market.buy(0, amount, amount, amount, uint64(block.timestamp + 1 hours));
    }

    function _permit(uint256 amount, uint256 nonce)
        internal
        view
        returns (ISignatureTransfer.PermitTransferFrom memory)
    {
        return ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({
                token: address(usdc), amount: amount
            }),
            nonce: nonce,
            deadline: block.timestamp + 1 hours
        });
    }

    function _signPermit(
        address spender,
        ISignatureTransfer.PermitTransferFrom memory permit,
        bytes32 witness,
        string memory witnessTypeString,
        uint256 privateKey
    ) internal view returns (bytes memory signature) {
        bytes32 witnessPermitTypehash =
            keccak256(abi.encodePacked(PERMIT_WITNESS_STUB, witnessTypeString));
        bytes32 tokenPermissionsHash = keccak256(
            abi.encode(TOKEN_PERMISSIONS_TYPEHASH, permit.permitted.token, permit.permitted.amount)
        );
        bytes32 dataHash = keccak256(
            abi.encode(
                witnessPermitTypehash,
                tokenPermissionsHash,
                spender,
                permit.nonce,
                permit.deadline,
                witness
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", permit2.DOMAIN_SEPARATOR(), dataHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
