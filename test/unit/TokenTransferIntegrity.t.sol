// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
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
import { InexactTokenTransfer } from "../../src/libraries/ProtocolErrors.sol";

contract ToggleFeeUSDC is ERC20 {
    bool public feeEnabled;

    constructor() ERC20("Toggle Fee USDC", "tfUSDC") { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFeeEnabled(bool enabled) external {
        feeEnabled = enabled;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (feeEnabled && from != address(0) && to != address(0) && value != 0) {
            super._update(from, address(0), 1);
            super._update(from, to, value - 1);
            return;
        }
        super._update(from, to, value);
    }
}

contract TokenTransferIntegrityTest is Test {
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
    uint256 internal constant PERMIT_OWNER_KEY = 0xBEEF;

    ToggleFeeUSDC internal token;
    ISignatureTransfer internal permit2;
    ProtocolConfigV1 internal config;
    EmergencyControllerV1 internal emergency;
    LaunchExposureGuardV1 internal guard;
    FeeVaultV1 internal feeVault;
    BondEscrowV1 internal bondEscrow;
    MarketFactoryV1 internal factory;
    FixedPriceMarketplaceV1 internal marketplace;

    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant CREATOR_TREASURY = address(0xCAFE);
    address internal constant PROTOCOL_TREASURY = address(0xFEE);
    address internal constant EMERGENCY_SAFE = address(0xE911);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal permitOwner;

    function setUp() public {
        token = new ToggleFeeUSDC();
        permit2 = ISignatureTransfer(deployCode("Permit2.sol:Permit2"));
        permitOwner = vm.addr(PERMIT_OWNER_KEY);
        config = new ProtocolConfigV1(address(this), address(token), PROTOCOL_TREASURY);
        config.setPlatformC2CFeeBps(100);
        emergency = new EmergencyControllerV1(address(this), EMERGENCY_SAFE);
        guard = new LaunchExposureGuardV1(address(this), 50_000e6);
        feeVault = new FeeVaultV1(address(this), address(token));
        bondEscrow = new BondEscrowV1(address(this), address(token));
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
            1 days,
            address(permit2)
        );
        guard.setFactory(address(factory));
        feeVault.setFactory(address(factory));
        bondEscrow.setFactory(address(factory));
        fullDeployer.setFactory(address(factory));
        marketplace = new FixedPriceMarketplaceV1(
            address(factory),
            address(emergency),
            address(feeVault),
            address(token),
            address(permit2)
        );
        factory.setMarketplace(address(marketplace));
        factory.activate(factory.dependencyFingerprint());

        token.mint(CREATOR, 100e6);
        token.mint(ALICE, 100e6);
        token.mint(BOB, 100e6);
        token.mint(permitOwner, 100e6);
        vm.prank(CREATOR);
        token.approve(address(factory), type(uint256).max);
        vm.prank(permitOwner);
        token.approve(address(permit2), type(uint256).max);
    }

    function testFactoryRejectsFeeOnTransferBondAtomically() public {
        token.setFeeEnabled(true);

        vm.expectRevert(abi.encodeWithSelector(InexactTokenTransfer.selector, 10e6, 10e6 - 1));
        vm.prank(CREATOR);
        factory.createMarket(_params(), keccak256("taxed-bond"));

        assertEq(factory.creatorNonce(CREATOR), 0);
        assertEq(token.balanceOf(address(bondEscrow)), 0);
        assertEq(token.balanceOf(CREATOR), 100e6);
        assertEq(guard.totalReportedExposure(), 0);
    }

    function testPrimaryBuyRejectsFeeOnTransferPrincipalAtomically() public {
        MarketVaultCoreV1 market = _createMarket(keccak256("taxed-primary"));
        vm.prank(ALICE);
        token.approve(address(market), type(uint256).max);
        token.setFeeEnabled(true);
        uint64 closeAt = market.closeAt();

        vm.expectRevert(abi.encodeWithSelector(InexactTokenTransfer.selector, 10e6, 10e6 - 1));
        vm.prank(ALICE);
        market.buy(0, 10e6, 10e6, 10e6, closeAt);

        assertEq(market.totalPrincipal(), 0);
        assertEq(market.totalSupply(0), 0);
        assertEq(token.balanceOf(address(market)), 0);
        assertEq(token.balanceOf(ALICE), 100e6);
        assertEq(guard.reportedExposure(address(market)), 0);
        assertEq(guard.totalReportedExposure(), 0);
    }

    function testMarketplaceRejectsFeeOnTransferFeesAtomically() public {
        MarketVaultCoreV1 market = _createMarket(keccak256("taxed-c2c"));
        vm.prank(ALICE);
        token.approve(address(market), type(uint256).max);
        uint64 closeAt = market.closeAt();
        vm.prank(ALICE);
        market.buy(0, 10e6, 10e6, 10e6, closeAt);

        vm.startPrank(ALICE);
        market.setApprovalForAll(address(marketplace), true);
        bytes32 listingId = marketplace.createListing(
            address(market), 0, 10e6, 1e6, uint64(block.timestamp + 1 hours)
        );
        vm.stopPrank();
        vm.prank(BOB);
        token.approve(address(marketplace), type(uint256).max);

        uint256 aliceBalance = token.balanceOf(ALICE);
        uint256 bobBalance = token.balanceOf(BOB);
        token.setFeeEnabled(true);
        vm.expectRevert(abi.encodeWithSelector(InexactTokenTransfer.selector, 100_000, 99_999));
        vm.prank(BOB);
        marketplace.fillListing(listingId, 10e6, 10e6, 10e6, uint64(block.timestamp + 1 hours));

        (,, uint128 remainingUnits,,,, bool active) = marketplace.listings(listingId);
        assertTrue(active);
        assertEq(remainingUnits, 10e6);
        assertEq(market.balanceOf(address(marketplace), 0), 10e6);
        assertEq(market.balanceOf(BOB, 0), 0);
        assertEq(token.balanceOf(ALICE), aliceBalance);
        assertEq(token.balanceOf(BOB), bobBalance);
        assertEq(token.balanceOf(address(feeVault)), 0);
        assertEq(feeVault.creditOf(PROTOCOL_TREASURY), 0);
    }

    function testPrimaryPermit2RejectsFeeOnTransferPrincipalAtomically() public {
        MarketVaultCoreV1 market = _createMarket(keccak256("taxed-primary-permit2"));
        uint64 callDeadline = uint64(block.timestamp + 1 hours);
        ISignatureTransfer.PermitTransferFrom memory permit = _permit(10e6, 41);
        bytes32 witness = keccak256(
            abi.encode(
                BUY_WITNESS_TYPEHASH,
                permitOwner,
                address(market),
                MarketVaultCoreV1.buyWithPermit2.selector,
                0,
                10e6,
                10e6,
                10e6,
                callDeadline,
                block.chainid
            )
        );
        bytes memory signature = _signPermit(
            address(market), permit, witness, CANONICAL_BUY_WITNESS_TYPE_STRING, PERMIT_OWNER_KEY
        );
        token.setFeeEnabled(true);

        vm.expectRevert(abi.encodeWithSelector(InexactTokenTransfer.selector, 10e6, 10e6 - 1));
        market.buyWithPermit2(permitOwner, 0, 10e6, 10e6, 10e6, callDeadline, permit, signature);

        assertEq(market.totalPrincipal(), 0);
        assertEq(market.totalSupply(0), 0);
        assertEq(token.balanceOf(address(market)), 0);
        assertEq(token.balanceOf(permitOwner), 100e6);
        assertEq(guard.totalReportedExposure(), 0);
    }

    function testMarketplacePermit2RejectsFeeOnTransferGrossAtomically() public {
        MarketVaultCoreV1 market = _createMarket(keccak256("taxed-c2c-permit2"));
        vm.prank(ALICE);
        token.approve(address(market), type(uint256).max);
        uint64 closeAt = market.closeAt();
        vm.prank(ALICE);
        market.buy(0, 10e6, 10e6, 10e6, closeAt);

        vm.startPrank(ALICE);
        market.setApprovalForAll(address(marketplace), true);
        bytes32 listingId = marketplace.createListing(
            address(market), 0, 10e6, 1e6, uint64(block.timestamp + 1 hours)
        );
        vm.stopPrank();

        uint64 callDeadline = uint64(block.timestamp + 1 hours);
        ISignatureTransfer.PermitTransferFrom memory permit = _permit(10e6, 42);
        bytes32 witness = keccak256(
            abi.encode(
                FILL_WITNESS_TYPEHASH,
                permitOwner,
                address(marketplace),
                FixedPriceMarketplaceV1.fillListingWithPermit2.selector,
                listingId,
                10e6,
                10e6,
                10e6,
                callDeadline,
                block.chainid
            )
        );
        bytes memory signature = _signPermit(
            address(marketplace),
            permit,
            witness,
            CANONICAL_FILL_WITNESS_TYPE_STRING,
            PERMIT_OWNER_KEY
        );
        uint256 sellerBalance = token.balanceOf(ALICE);
        token.setFeeEnabled(true);

        vm.expectRevert(abi.encodeWithSelector(InexactTokenTransfer.selector, 10e6, 10e6 - 1));
        marketplace.fillListingWithPermit2(
            listingId, permitOwner, 10e6, 10e6, 10e6, callDeadline, permit, signature
        );

        (,, uint128 remainingUnits,,,, bool active) = marketplace.listings(listingId);
        assertTrue(active);
        assertEq(remainingUnits, 10e6);
        assertEq(market.balanceOf(address(marketplace), 0), 10e6);
        assertEq(market.balanceOf(permitOwner, 0), 0);
        assertEq(token.balanceOf(ALICE), sellerBalance);
        assertEq(token.balanceOf(permitOwner), 100e6);
        assertEq(token.balanceOf(address(marketplace)), 0);
        assertEq(token.balanceOf(address(feeVault)), 0);
    }

    function _createMarket(bytes32 salt) internal returns (MarketVaultCoreV1 market) {
        vm.prank(CREATOR);
        market = MarketVaultCoreV1(factory.createMarket(_params(), salt));
    }

    function _params() internal view returns (ProtocolTypes.CreateMarketParams memory params) {
        params = ProtocolTypes.CreateMarketParams({
            rulesHash: keccak256("rules"),
            metadataURI: "ipfs://market/{id}.json",
            resolutionSourceHash: keccak256("source"),
            resolutionSourceURI: "https://example.com/source",
            outcomeCount: 2,
            closeAt: uint64(block.timestamp + 1 days),
            earlyBirdStart: uint64(block.timestamp),
            creatorTreasury: CREATOR_TREASURY,
            deploymentMode: ProtocolTypes.DeploymentMode.FULL,
            featureFlags: ProtocolTypes.FEATURE_EARLY_BIRD | ProtocolTypes.FEATURE_PERMIT2,
            creatorRakeBps: 500,
            creatorC2CFeeBps: 0,
            perUserPrimaryCap: 100e6,
            marketPrimaryCap: 100e6,
            minimumPrimaryUnits: 10_000,
            minimumC2CUnits: 10_000,
            creatorBond: 10e6
        });
    }

    function _permit(uint256 amount, uint256 nonce)
        internal
        view
        returns (ISignatureTransfer.PermitTransferFrom memory)
    {
        return ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({
                token: address(token), amount: amount
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
