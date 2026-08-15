// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @notice Shared V1 protocol data types. Values are ABI-stable within V1.
library ProtocolTypes {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant SHARE_SCALE = 1_000_000;
    uint256 internal constant FEATURE_EARLY_BIRD = 1 << 0;
    uint256 internal constant FEATURE_PERMIT2 = 1 << 1;

    uint256 internal constant PAUSE_MARKET_CREATION = 1 << 0;
    uint256 internal constant PAUSE_PRIMARY_BUY = 1 << 1;
    uint256 internal constant PAUSE_LISTING_CREATE = 1 << 2;
    uint256 internal constant PAUSE_LISTING_FILL = 1 << 3;
    uint256 internal constant PAUSE_PERMIT2 = 1 << 4;
    uint256 internal constant PAUSE_PAYMASTER = 1 << 5;
    uint256 internal constant ALL_PAUSE_FLAGS = (1 << 6) - 1;

    enum DeploymentMode {
        FULL,
        CLONE
    }

    enum MarketState {
        OPEN,
        RESOLVED,
        VOIDED_CREATOR,
        VOIDED_TIMEOUT
    }

    struct CreateMarketParams {
        bytes32 rulesHash;
        string metadataURI;
        bytes32 resolutionSourceHash;
        string resolutionSourceURI;
        uint8 outcomeCount;
        uint64 closeAt;
        uint64 earlyBirdStart;
        address creatorTreasury;
        DeploymentMode deploymentMode;
        uint256 featureFlags;
        uint16 creatorRakeBps;
        uint16 creatorC2CFeeBps;
        uint128 perUserPrimaryCap;
        uint128 marketPrimaryCap;
        uint128 minimumPrimaryUnits;
        uint128 minimumC2CUnits;
        uint128 creatorBond;
    }

    struct EconomicSnapshot {
        uint16 creatorRakeBps;
        uint16 protocolShareBps;
        uint16 earlyBirdShareBps;
        uint16 platformC2CFeeBps;
        uint16 creatorC2CFeeBps;
        address protocolTreasury;
    }

    struct MarketInitParams {
        address factory;
        address paymentToken;
        address config;
        address emergencyController;
        address exposureGuard;
        address bondEscrow;
        address feeVault;
        address permit2;
        address creator;
        bytes32 rulesHash;
        string metadataURI;
        bytes32 resolutionSourceHash;
        string resolutionSourceURI;
        uint8 outcomeCount;
        uint64 createdAt;
        uint64 closeAt;
        uint64 earlyBirdStart;
        address creatorTreasury;
        DeploymentMode deploymentMode;
        uint256 featureFlags;
        uint128 perUserPrimaryCap;
        uint128 marketPrimaryCap;
        uint128 minimumPrimaryUnits;
        uint128 minimumC2CUnits;
        uint128 creatorBond;
        EconomicSnapshot economics;
    }

    struct PayoutBreakdown {
        uint256 totalPrincipal;
        uint256 totalRake;
        uint256 protocolFee;
        uint256 earlyBirdPool;
        uint256 creatorFee;
        uint256 winnerPool;
    }
}

