// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ProtocolTestBase } from "../helpers/ProtocolTestBase.sol";
import { ProtocolConfigV1 } from "../../src/core/ProtocolConfigV1.sol";
import { EmergencyControllerV1 } from "../../src/core/EmergencyControllerV1.sol";
import { LaunchExposureGuardV1 } from "../../src/core/LaunchExposureGuardV1.sol";
import { FeeVaultV1 } from "../../src/core/FeeVaultV1.sol";
import { BondEscrowV1 } from "../../src/core/BondEscrowV1.sol";
import { FullMarketDeployerV1 } from "../../src/core/FullMarketDeployerV1.sol";
import { ProtocolTypes } from "../../src/libraries/ProtocolTypes.sol";
import {
    Unauthorized,
    ZeroAddress,
    AlreadyConfigured,
    InvalidConfiguration,
    ValueOutOfRange,
    EmergencyEpochAlreadyUsed,
    EmergencyPauseStillActive,
    MarketNotRegistered,
    MarketAlreadyRegistered,
    ExposureCapExceeded,
    ExposureCapCannotDecrease,
    AccruerNotAuthorized,
    Insolvent,
    NothingToClaim,
    BondNotLocked,
    BondStateMismatch
} from "../../src/libraries/ProtocolErrors.sol";

contract WrongDecimalsToken is ERC20 {
    constructor() ERC20("Wrong", "WRONG") { }

    function decimals() public pure override returns (uint8) {
        return 18;
    }
}

contract ExposureSource {
    uint256 public guardExposure;

    function setExposure(uint256 exposure) external {
        guardExposure = exposure;
    }
}

contract BondMarketMock {
    ProtocolTypes.MarketState public marketState;
    uint256 public totalPrincipal;
    uint256 public funded;

    function setState(ProtocolTypes.MarketState state) external {
        marketState = state;
    }

    function setTotalPrincipal(uint256 principal) external {
        totalPrincipal = principal;
    }

    function fundTimeoutBonus(uint256 amount) external {
        funded += amount;
    }
}

contract ProtocolConfigControlsTest is ProtocolTestBase {
    function testConfigGovernanceSettersAndSnapshot() public {
        config.setProtocolTreasury(ALICE);
        config.setCreationFee(100e6);
        config.setProtocolShareBps(5000);
        config.setEarlyBirdShareBps(4000);
        config.setPlatformC2CFeeBps(200);
        config.setMarketCapLimits(4000e6, 400e6);
        config.setMaxPerUserPrimaryCap(80e6);
        config.setCreatorFeeLimits(900, 150);

        assertEq(config.protocolTreasury(), ALICE);
        assertEq(config.creationFee(), 100e6);
        assertEq(config.protocolShareBps(), 5000);
        assertEq(config.earlyBirdShareBps(), 4000);
        assertEq(config.platformC2CFeeBps(), 200);
        assertEq(config.maxFullMarketCap(), 4000e6);
        assertEq(config.maxCloneMarketCap(), 400e6);
        assertEq(config.maxPerUserPrimaryCap(), 80e6);
        assertEq(config.maxCreatorRakeBps(), 900);
        assertEq(config.maxCreatorC2CFeeBps(), 150);

        ProtocolTypes.EconomicSnapshot memory snapshot = config.snapshot(900, 150);
        assertEq(snapshot.creatorRakeBps, 900);
        assertEq(snapshot.protocolShareBps, 5000);
        assertEq(snapshot.earlyBirdShareBps, 4000);
        assertEq(snapshot.platformC2CFeeBps, 200);
        assertEq(snapshot.creatorC2CFeeBps, 150);
        assertEq(snapshot.protocolTreasury, ALICE);
    }

    function testConfigRejectsUnauthorizedAndInvalidValues() public {
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, ALICE));
        config.setCreationFee(1);

        vm.expectRevert(ZeroAddress.selector);
        config.setProtocolTreasury(address(0));
        vm.expectPartialRevert(ValueOutOfRange.selector);
        config.setCreationFee(100e6 + 1);
        vm.expectPartialRevert(ValueOutOfRange.selector);
        config.setProtocolShareBps(5001);
        vm.expectPartialRevert(ValueOutOfRange.selector);
        config.setEarlyBirdShareBps(5001);
        vm.expectPartialRevert(ValueOutOfRange.selector);
        config.setPlatformC2CFeeBps(201);
        vm.expectPartialRevert(ValueOutOfRange.selector);
        config.setMarketCapLimits(5000e6 + 1, 500e6);
        vm.expectPartialRevert(ValueOutOfRange.selector);
        config.setMarketCapLimits(5000e6, 500e6 + 1);
        vm.expectPartialRevert(ValueOutOfRange.selector);
        config.setMaxPerUserPrimaryCap(100e6 + 1);
        vm.expectPartialRevert(ValueOutOfRange.selector);
        config.setCreatorFeeLimits(1001, 0);
        vm.expectPartialRevert(ValueOutOfRange.selector);
        config.setCreatorFeeLimits(1000, 201);
        vm.expectPartialRevert(ValueOutOfRange.selector);
        config.snapshot(1001, 0);
        vm.expectPartialRevert(ValueOutOfRange.selector);
        config.snapshot(1000, 201);
    }

    function testConfigConstructorRejectsZeroAddressesAndWrongDecimals() public {
        vm.expectRevert(ZeroAddress.selector);
        new ProtocolConfigV1(address(0), address(usdc), PROTOCOL_TREASURY);
        vm.expectRevert(ZeroAddress.selector);
        new ProtocolConfigV1(address(this), address(0), PROTOCOL_TREASURY);
        vm.expectRevert(ZeroAddress.selector);
        new ProtocolConfigV1(address(this), address(usdc), address(0));

        WrongDecimalsToken token = new WrongDecimalsToken();
        vm.expectPartialRevert(InvalidConfiguration.selector);
        new ProtocolConfigV1(address(this), address(token), PROTOCOL_TREASURY);
    }
}

contract EmergencyControlsTest is ProtocolTestBase {
    function testEmergencyPauseEpochExpiryAndSafeRotation() public {
        assertFalse(emergency.isPaused(ProtocolTypes.PAUSE_PRIMARY_BUY));
        vm.prank(EMERGENCY_SAFE);
        emergency.pause(ProtocolTypes.PAUSE_PRIMARY_BUY | ProtocolTypes.PAUSE_LISTING_FILL, 2 hours);
        assertTrue(emergency.isPaused(ProtocolTypes.PAUSE_PRIMARY_BUY));
        assertFalse(emergency.isPaused(ProtocolTypes.PAUSE_MARKET_CREATION));

        vm.prank(EMERGENCY_SAFE);
        vm.expectRevert(abi.encodeWithSelector(EmergencyEpochAlreadyUsed.selector, uint64(1)));
        emergency.pause(ProtocolTypes.PAUSE_PRIMARY_BUY, 1 hours);
        vm.expectPartialRevert(EmergencyPauseStillActive.selector);
        emergency.resetEpoch();

        vm.warp(block.timestamp + 2 hours);
        assertFalse(emergency.isPaused(ProtocolTypes.PAUSE_PRIMARY_BUY));
        emergency.resetEpoch();
        assertEq(emergency.epoch(), 2);
        assertEq(emergency.pausedFlags(), 0);
        assertEq(emergency.pauseExpiresAt(), 0);

        emergency.setEmergencySafe(ALICE);
        assertEq(emergency.emergencySafe(), ALICE);
        vm.prank(EMERGENCY_SAFE);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, EMERGENCY_SAFE));
        emergency.pause(ProtocolTypes.PAUSE_PRIMARY_BUY, 1 hours);
        vm.prank(ALICE);
        emergency.pause(ProtocolTypes.PAUSE_PRIMARY_BUY, 1 hours);
    }

    function testEmergencyRejectsUnauthorizedFlagsDurationsAndInvalidSafe() public {
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, ALICE));
        emergency.pause(ProtocolTypes.PAUSE_PRIMARY_BUY, 1 hours);
        vm.prank(EMERGENCY_SAFE);
        vm.expectPartialRevert(InvalidConfiguration.selector);
        emergency.pause(0, 1 hours);
        vm.prank(EMERGENCY_SAFE);
        vm.expectPartialRevert(InvalidConfiguration.selector);
        emergency.pause(ProtocolTypes.ALL_PAUSE_FLAGS + 1, 1 hours);
        vm.prank(EMERGENCY_SAFE);
        vm.expectPartialRevert(ValueOutOfRange.selector);
        emergency.pause(ProtocolTypes.PAUSE_PRIMARY_BUY, 0);
        vm.prank(EMERGENCY_SAFE);
        vm.expectPartialRevert(ValueOutOfRange.selector);
        emergency.pause(ProtocolTypes.PAUSE_PRIMARY_BUY, 7 days + 1);

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, ALICE));
        emergency.resetEpoch();
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, ALICE));
        emergency.setEmergencySafe(BOB);
        vm.expectRevert(ZeroAddress.selector);
        emergency.setEmergencySafe(address(0));
    }

    function testEmergencyConstructorRejectsZeroAddresses() public {
        vm.expectRevert(ZeroAddress.selector);
        new EmergencyControllerV1(address(0), EMERGENCY_SAFE);
        vm.expectRevert(ZeroAddress.selector);
        new EmergencyControllerV1(address(this), address(0));
    }
}

contract ExposureGuardControlsTest is Test {
    address internal constant ALICE = address(0xA11CE);

    function testGuardRegistrationReserveSyncCapAndRetirement() public {
        LaunchExposureGuardV1 localGuard = new LaunchExposureGuardV1(address(this), 100);
        ExposureSource source = new ExposureSource();
        localGuard.setFactory(address(this));
        localGuard.registerMarket(address(source));
        assertTrue(localGuard.registeredMarket(address(source)));

        vm.prank(address(source));
        localGuard.reserve(40);
        assertEq(localGuard.reportedExposure(address(source)), 40);
        assertEq(localGuard.totalReportedExposure(), 40);

        source.setExposure(25);
        (uint256 previous, uint256 current) = localGuard.sync(address(source));
        assertEq(previous, 40);
        assertEq(current, 25);
        assertEq(localGuard.totalReportedExposure(), 25);

        localGuard.raiseCap(150);
        assertEq(localGuard.exposureCap(), 150);
        localGuard.retireForever();
        assertTrue(localGuard.retired());
        vm.prank(address(source));
        localGuard.reserve(type(uint256).max);
        source.setExposure(99);
        (previous, current) = localGuard.sync(address(source));
        assertEq(previous, 25);
        assertEq(current, 25);
    }

    function testGuardRejectsInvalidConfigurationAndCapacity() public {
        vm.expectRevert(ZeroAddress.selector);
        new LaunchExposureGuardV1(address(0), 1);
        vm.expectPartialRevert(ExposureCapExceeded.selector);
        new LaunchExposureGuardV1(address(this), 0);

        LaunchExposureGuardV1 localGuard = new LaunchExposureGuardV1(address(this), 100);
        ExposureSource source = new ExposureSource();
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, ALICE));
        localGuard.setFactory(address(this));
        vm.expectRevert(ZeroAddress.selector);
        localGuard.setFactory(address(0));
        localGuard.setFactory(address(this));
        vm.expectRevert(AlreadyConfigured.selector);
        localGuard.setFactory(address(this));

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, ALICE));
        localGuard.registerMarket(address(source));
        vm.expectRevert(ZeroAddress.selector);
        localGuard.registerMarket(address(0));
        localGuard.registerMarket(address(source));
        vm.expectRevert(abi.encodeWithSelector(MarketAlreadyRegistered.selector, address(source)));
        localGuard.registerMarket(address(source));

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(MarketNotRegistered.selector, ALICE));
        localGuard.reserve(1);
        vm.expectRevert(abi.encodeWithSelector(MarketNotRegistered.selector, ALICE));
        localGuard.sync(ALICE);
        vm.prank(address(source));
        vm.expectRevert(abi.encodeWithSelector(ExposureCapExceeded.selector, 101, 100));
        localGuard.reserve(101);

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, ALICE));
        localGuard.raiseCap(101);
        vm.expectPartialRevert(ExposureCapCannotDecrease.selector);
        localGuard.raiseCap(99);
        vm.prank(address(source));
        localGuard.reserve(80);
        vm.expectPartialRevert(ExposureCapCannotDecrease.selector);
        localGuard.raiseCap(79);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, ALICE));
        localGuard.retireForever();
        localGuard.retireForever();
        vm.expectRevert(AlreadyConfigured.selector);
        localGuard.retireForever();
    }
}

contract VaultControlComponentsTest is ProtocolTestBase {
    event EmptyTimeoutBondCredited(address indexed market, address indexed creator, uint256 amount);
    event BondFundedToTimeoutMarket(address indexed market, uint256 amount);

    function testFeeVaultAuthorizationAccrualAndBothClaimPaths() public {
        FeeVaultV1 localVault = new FeeVaultV1(address(this), address(usdc));
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, ALICE));
        localVault.setFactory(address(this));
        vm.expectRevert(ZeroAddress.selector);
        localVault.setFactory(address(0));
        localVault.setFactory(address(this));
        vm.expectRevert(AlreadyConfigured.selector);
        localVault.setFactory(address(this));

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, ALICE));
        localVault.registerAccruer(BOB);
        vm.expectRevert(ZeroAddress.selector);
        localVault.registerAccruer(address(0));
        localVault.registerAccruer(BOB);

        vm.prank(CAROL);
        vm.expectRevert(abi.encodeWithSelector(AccruerNotAuthorized.selector, CAROL));
        localVault.accrue(ALICE, 1, bytes32("kind"), bytes32("ref"));
        vm.expectRevert(ZeroAddress.selector);
        localVault.accrue(address(0), 1, bytes32("kind"), bytes32("ref"));
        localVault.accrue(ALICE, 0, bytes32("kind"), bytes32("ref"));
        vm.expectRevert(abi.encodeWithSelector(Insolvent.selector, 0, 10));
        localVault.accrue(ALICE, 10, bytes32("kind"), bytes32("ref"));

        usdc.mint(address(localVault), 30);
        localVault.accrue(ALICE, 10, bytes32("kind"), bytes32("a"));
        vm.prank(BOB);
        localVault.accrue(BOB, 20, bytes32("kind"), bytes32("b"));
        uint256 aliceBefore = usdc.balanceOf(ALICE);
        localVault.claimFor(ALICE);
        assertEq(usdc.balanceOf(ALICE) - aliceBefore, 10);
        vm.prank(BOB);
        localVault.claim();
        assertEq(usdc.balanceOf(BOB), 20_000e6 + 20);
        assertEq(localVault.totalCredits(), 0);
        vm.expectRevert(NothingToClaim.selector);
        localVault.claimFor(ALICE);
    }

    function testFeeVaultConstructorsRejectZeroAddresses() public {
        vm.expectRevert(ZeroAddress.selector);
        new FeeVaultV1(address(0), address(usdc));
        vm.expectRevert(ZeroAddress.selector);
        new FeeVaultV1(address(this), address(0));
    }

    function testBondEscrowValidationSettlementAndClaims() public {
        BondEscrowV1 localEscrow = new BondEscrowV1(address(this), address(usdc));
        BondMarketMock market = new BondMarketMock();
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, ALICE));
        localEscrow.setFactory(address(this));
        vm.expectRevert(ZeroAddress.selector);
        localEscrow.setFactory(address(0));
        localEscrow.setFactory(address(this));
        vm.expectRevert(AlreadyConfigured.selector);
        localEscrow.setFactory(address(this));

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, ALICE));
        localEscrow.lockBond(address(market), CREATOR, 10);
        vm.expectRevert(ZeroAddress.selector);
        localEscrow.lockBond(address(0), CREATOR, 10);
        vm.expectRevert(ZeroAddress.selector);
        localEscrow.lockBond(address(market), address(0), 10);
        vm.expectPartialRevert(BondStateMismatch.selector);
        localEscrow.lockBond(address(market), CREATOR, 0);
        vm.expectRevert(abi.encodeWithSelector(Insolvent.selector, 0, 10));
        localEscrow.lockBond(address(market), CREATOR, 10);

        usdc.mint(address(localEscrow), 10);
        localEscrow.lockBond(address(market), CREATOR, 10);
        vm.expectRevert(abi.encodeWithSelector(MarketAlreadyRegistered.selector, address(market)));
        localEscrow.lockBond(address(market), CREATOR, 10);
        vm.expectPartialRevert(BondStateMismatch.selector);
        localEscrow.settleBond(address(market));
        vm.expectRevert(abi.encodeWithSelector(BondNotLocked.selector, ALICE));
        localEscrow.settleBond(ALICE);

        market.setState(ProtocolTypes.MarketState.VOIDED_CREATOR);
        localEscrow.settleBond(address(market));
        assertEq(localEscrow.creditOf(CREATOR), 10);
        vm.expectPartialRevert(BondStateMismatch.selector);
        localEscrow.settleBond(address(market));
        uint256 creatorBefore = usdc.balanceOf(CREATOR);
        vm.prank(CREATOR);
        localEscrow.claim();
        assertEq(usdc.balanceOf(CREATOR) - creatorBefore, 10);
        assertEq(localEscrow.totalCredits(), 0);
        vm.expectRevert(NothingToClaim.selector);
        localEscrow.claimFor(CREATOR);
    }

    function testBondEscrowTimeoutSettlementFundsMarket() public {
        BondEscrowV1 localEscrow = new BondEscrowV1(address(this), address(usdc));
        BondMarketMock market = new BondMarketMock();
        localEscrow.setFactory(address(this));
        usdc.mint(address(localEscrow), 12);
        localEscrow.lockBond(address(market), CREATOR, 12);
        market.setTotalPrincipal(1);
        market.setState(ProtocolTypes.MarketState.VOIDED_TIMEOUT);

        vm.expectEmit(true, false, false, true, address(localEscrow));
        emit BondFundedToTimeoutMarket(address(market), 12);
        localEscrow.settleBond(address(market));

        assertEq(market.funded(), 12);
        assertEq(usdc.balanceOf(address(market)), 12);
        assertEq(localEscrow.totalLocked(), 0);
    }

    function testBondEscrowEmptyTimeoutCreditsCreatorInsteadOfLockingBond() public {
        BondEscrowV1 localEscrow = new BondEscrowV1(address(this), address(usdc));
        BondMarketMock market = new BondMarketMock();
        localEscrow.setFactory(address(this));
        usdc.mint(address(localEscrow), 12);
        localEscrow.lockBond(address(market), CREATOR, 12);
        market.setState(ProtocolTypes.MarketState.VOIDED_TIMEOUT);

        vm.expectEmit(true, true, false, true, address(localEscrow));
        emit EmptyTimeoutBondCredited(address(market), CREATOR, 12);
        localEscrow.settleBond(address(market));

        assertEq(market.funded(), 0);
        assertEq(usdc.balanceOf(address(market)), 0);
        assertEq(localEscrow.creditOf(CREATOR), 12);
        assertEq(localEscrow.totalLocked(), 0);
        assertEq(localEscrow.totalCredits(), 12);
    }

    function testBondEscrowConstructorsRejectZeroAddresses() public {
        vm.expectRevert(ZeroAddress.selector);
        new BondEscrowV1(address(0), address(usdc));
        vm.expectRevert(ZeroAddress.selector);
        new BondEscrowV1(address(this), address(0));
    }

    function testFullDeployerControlsAndCreate2Deployment() public {
        vm.expectRevert(ZeroAddress.selector);
        new FullMarketDeployerV1(address(0));
        FullMarketDeployerV1 deployer = new FullMarketDeployerV1(address(this));
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, ALICE));
        deployer.setFactory(address(this));
        vm.expectRevert(ZeroAddress.selector);
        deployer.setFactory(address(0));
        deployer.setFactory(address(this));
        vm.expectRevert(AlreadyConfigured.selector);
        deployer.setFactory(address(this));

        bytes32 salt = keccak256("full-deployer-test");
        address deployed = deployer.deploy(salt);
        assertGt(deployed.code.length, 0);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, ALICE));
        deployer.deploy(keccak256("unauthorized"));
    }
}
