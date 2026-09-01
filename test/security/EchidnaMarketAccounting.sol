// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ERC1155Holder } from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
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
import { MockUSDC } from "../mocks/MockUSDC.sol";

/// @dev A bounded actor. Echidna/Medusa target only the harness, so actor calls must originate
/// from the harness and cannot be forged by fuzz senders.
contract SecurityActor is ERC1155Holder {
    address internal immutable harness;
    MockUSDC internal immutable usdc;
    MarketVaultCoreV1 internal immutable market;

    constructor(address harness_, MockUSDC usdc_, MarketVaultCoreV1 market_) {
        harness = harness_;
        usdc = usdc_;
        market = market_;
        IERC20(address(usdc_)).approve(address(market_), type(uint256).max);
    }

    modifier onlyHarness() {
        require(msg.sender == harness);
        _;
    }

    function buy(uint256 outcome, uint256 amount) external onlyHarness {
        market.buy(outcome, amount, amount, amount, uint64(block.timestamp + 1 days));
    }

    function transferTo(SecurityActor recipient, uint256 outcome, uint256 amount)
        external
        onlyHarness
    {
        market.safeTransferFrom(address(this), address(recipient), outcome, amount, "");
    }

    function refund() external onlyHarness {
        market.refundFor(address(this));
    }

    function claimWinner() external onlyHarness {
        market.claimWinningsFor(address(this));
    }

    function claimEarlyBird() external onlyHarness {
        market.claimEarlyBirdFor(address(this));
    }

    function claimTimeoutBonus() external onlyHarness {
        market.claimTimeoutBonusFor(address(this));
    }

    function burnLosing(uint256 outcome) external onlyHarness {
        market.burnLosingPosition(outcome);
    }
}

/// @notice Stateful accounting campaign shared by Echidna and Medusa.
/// @dev All actions are bounded and expected reverts are swallowed to keep campaigns exploring.
contract EchidnaMarketAccounting {
    // Keep target references in storage: Echidna 2.3.3 cannot associate this
    // constructor-patched runtime with its ABI when these fields are immutable,
    // leaving the transaction target set empty before the first fuzz call.
    MockUSDC public usdc;
    LaunchExposureGuardV1 public guard;
    FeeVaultV1 public feeVault;
    BondEscrowV1 public bondEscrow;
    MarketVaultCoreV1 public market;

    SecurityActor[4] internal actors;

    constructor() {
        usdc = new MockUSDC();
        ProtocolConfigV1 config = new ProtocolConfigV1(address(this), address(usdc), address(0xFEE));
        EmergencyControllerV1 emergency = new EmergencyControllerV1(address(this), address(0xE911));
        guard = new LaunchExposureGuardV1(address(this), 50_000e6);
        feeVault = new FeeVaultV1(address(this), address(usdc));
        bondEscrow = new BondEscrowV1(address(this), address(usdc));
        CloneMarketVaultV1 cloneImplementation = new CloneMarketVaultV1();
        FullMarketDeployerV1 fullDeployer = new FullMarketDeployerV1(address(this));
        MarketFactoryV1 factory = new MarketFactoryV1(
            address(this),
            address(config),
            address(emergency),
            address(guard),
            address(bondEscrow),
            address(feeVault),
            address(fullDeployer),
            address(cloneImplementation),
            1 days,
            address(0)
        );
        guard.setFactory(address(factory));
        feeVault.setFactory(address(factory));
        bondEscrow.setFactory(address(factory));
        fullDeployer.setFactory(address(factory));
        FixedPriceMarketplaceV1 marketplace = new FixedPriceMarketplaceV1(
            address(factory), address(emergency), address(feeVault), address(usdc), address(0)
        );
        factory.setMarketplace(address(marketplace));
        factory.activate(factory.dependencyFingerprint());

        usdc.mint(address(this), 100e6);
        usdc.approve(address(factory), type(uint256).max);
        ProtocolTypes.CreateMarketParams memory params = ProtocolTypes.CreateMarketParams({
            rulesHash: keccak256("security-campaign-rules"),
            metadataURI: "ipfs://security/{id}.json",
            resolutionSourceHash: bytes32(0),
            resolutionSourceURI: "",
            outcomeCount: 3,
            closeAt: uint64(block.timestamp + 5 minutes),
            earlyBirdStart: uint64(block.timestamp),
            creatorTreasury: address(this),
            deploymentMode: ProtocolTypes.DeploymentMode.CLONE,
            featureFlags: ProtocolTypes.FEATURE_EARLY_BIRD,
            creatorRakeBps: 500,
            creatorC2CFeeBps: 0,
            perUserPrimaryCap: 100e6,
            marketPrimaryCap: 500e6,
            minimumPrimaryUnits: 10_000,
            minimumC2CUnits: 10_000,
            creatorBond: 10e6
        });
        market = MarketVaultCoreV1(factory.createMarket(params, bytes32("security-campaign")));

        for (uint256 i = 0; i < actors.length; ++i) {
            actors[i] = new SecurityActor(address(this), usdc, market);
            usdc.mint(address(actors[i]), 1000e6);
        }
    }

    function buy(uint256 actorSeed, uint256 outcomeSeed, uint256 amountSeed) external {
        if (market.isTerminal() || block.timestamp >= market.closeAt()) return;
        SecurityActor actor = actors[actorSeed % actors.length];
        uint256 marketAvailable = market.marketPrimaryCap() - market.totalPrincipal();
        uint256 userAvailable =
            market.perUserPrimaryCap() - market.cumulativePrimaryBought(address(actor));
        uint256 available = marketAvailable < userAvailable ? marketAvailable : userAvailable;
        uint256 minimum = market.minimumPrimaryUnits();
        if (available < minimum) return;
        uint256 amount = minimum + (amountSeed % (available - minimum + 1));
        try actor.buy(outcomeSeed % market.outcomeCount(), amount) { } catch { }
    }

    function transfer(uint256 fromSeed, uint256 toSeed, uint256 outcomeSeed, uint256 amountSeed)
        external
    {
        uint256 fromIndex = fromSeed % actors.length;
        uint256 toIndex = toSeed % actors.length;
        if (fromIndex == toIndex) return;
        uint256 outcome = outcomeSeed % market.outcomeCount();
        uint256 balance = market.balanceOf(address(actors[fromIndex]), outcome);
        if (balance == 0) return;
        uint256 amount = 1 + (amountSeed % balance);
        try actors[fromIndex].transferTo(actors[toIndex], outcome, amount) { } catch { }
    }

    function creatorResolve(uint256 outcomeSeed) external {
        if (market.isTerminal()) return;
        if (block.timestamp < market.closeAt() || block.timestamp >= market.resolutionDeadline()) {
            return;
        }
        uint256 outcome = outcomeSeed % market.outcomeCount();
        if (market.totalSupply(outcome) == 0) return;
        try market.resolve(outcome, bytes32(0)) { } catch { }
    }

    function creatorVoid() external {
        if (market.isTerminal()) return;
        try market.creatorVoid(bytes32(0)) { } catch { }
    }

    function timeoutVoid() external {
        if (market.isTerminal() || block.timestamp < market.resolutionDeadline()) return;
        try market.voidAfterDeadline() { } catch { }
    }

    function settleBond() external {
        if (!market.isTerminal()) return;
        try bondEscrow.settleBond(address(market)) { } catch { }
    }

    function refund(uint256 actorSeed) external {
        SecurityActor actor = actors[actorSeed % actors.length];
        try actor.refund() { } catch { }
    }

    function claimWinner(uint256 actorSeed) external {
        SecurityActor actor = actors[actorSeed % actors.length];
        try actor.claimWinner() { } catch { }
    }

    function claimEarlyBird(uint256 actorSeed) external {
        SecurityActor actor = actors[actorSeed % actors.length];
        try actor.claimEarlyBird() { } catch { }
    }

    function claimTimeoutBonus(uint256 actorSeed) external {
        SecurityActor actor = actors[actorSeed % actors.length];
        try actor.claimTimeoutBonus() { } catch { }
    }

    function burnLosing(uint256 actorSeed, uint256 outcomeSeed) external {
        SecurityActor actor = actors[actorSeed % actors.length];
        try actor.burnLosing(outcomeSeed % market.outcomeCount()) { } catch { }
    }

    function syncGuard() external {
        try guard.sync(address(market)) { } catch { }
    }

    function claimCreatorBond() external {
        try bondEscrow.claimFor(address(this)) { } catch { }
    }

    function claimCreatorFee() external {
        try feeVault.claimFor(address(this)) { } catch { }
    }

    function _vaultSolvent() internal view returns (bool) {
        uint256 liabilities;
        ProtocolTypes.MarketState state = market.marketState();
        if (state == ProtocolTypes.MarketState.OPEN) {
            liabilities = market.totalPrincipal();
        } else if (state == ProtocolTypes.MarketState.RESOLVED) {
            liabilities = market.remainingWinnerPool() + market.remainingEarlyBirdPool();
        } else {
            liabilities = market.remainingRefundPrincipal() + market.remainingTimeoutBonusPool();
        }
        return usdc.balanceOf(address(market)) >= liabilities;
    }

    function _supplyConsistent() internal view returns (bool) {
        uint256 summedSupply;
        for (uint256 outcome = 0; outcome < market.outcomeCount(); ++outcome) {
            summedSupply += market.totalSupply(outcome);
        }
        return summedSupply == market.totalSupply() && summedSupply <= market.totalPrincipal();
    }

    function _guardConservative() internal view returns (bool) {
        return guard.reportedExposure(address(market)) >= market.guardExposure()
            && guard.totalReportedExposure() >= guard.reportedExposure(address(market));
    }

    function _segregatedVaultsSolvent() internal view returns (bool) {
        return usdc.balanceOf(address(feeVault)) >= feeVault.totalCredits()
            && usdc.balanceOf(address(bondEscrow))
                >= bondEscrow.totalLocked() + bondEscrow.totalCredits();
    }

    function echidna_vault_assets_cover_liabilities() external view returns (bool) {
        return _vaultSolvent();
    }

    function echidna_supply_is_conserved() external view returns (bool) {
        return _supplyConsistent();
    }

    function echidna_guard_is_conservative() external view returns (bool) {
        return _guardConservative();
    }

    function echidna_fee_and_bond_vaults_are_solvent() external view returns (bool) {
        return _segregatedVaultsSolvent();
    }

    function property_vault_assets_cover_liabilities() external view returns (bool) {
        return _vaultSolvent();
    }

    function property_supply_is_conserved() external view returns (bool) {
        return _supplyConsistent();
    }

    function property_guard_is_conservative() external view returns (bool) {
        return _guardConservative();
    }

    function property_fee_and_bond_vaults_are_solvent() external view returns (bool) {
        return _segregatedVaultsSolvent();
    }
}
