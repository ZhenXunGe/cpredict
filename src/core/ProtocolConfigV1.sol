// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { ProtocolTypes } from "../libraries/ProtocolTypes.sol";
import {
    Unauthorized,
    ZeroAddress,
    ValueOutOfRange,
    InvalidConfiguration
} from "../libraries/ProtocolErrors.sol";

/// @notice Timelocked protocol defaults and V1 hard economic bounds.
/// @dev Changes affect new markets only unless the field is explicitly protocol-level.
contract ProtocolConfigV1 {
    uint16 public constant HARD_MAX_CREATOR_RAKE_BPS = 1000;
    uint16 public constant HARD_MAX_PROTOCOL_SHARE_BPS = 5000;
    uint16 public constant HARD_MAX_EARLY_BIRD_SHARE_BPS = 5000;
    uint16 public constant HARD_MAX_C2C_FEE_BPS = 200;
    uint128 public constant HARD_MAX_FULL_MARKET_CAP = 5000e6;
    uint128 public constant HARD_MAX_CLONE_MARKET_CAP = 500e6;
    uint128 public constant HARD_MAX_PER_USER_PRIMARY_CAP = 100e6;
    uint128 public constant HARD_MAX_CREATION_FEE = 100e6;

    address public immutable governance;
    address public immutable paymentToken;

    address public protocolTreasury;
    uint128 public creationFee;
    uint16 public protocolShareBps;
    uint16 public earlyBirdShareBps;
    uint16 public platformC2CFeeBps;

    uint128 public maxFullMarketCap = HARD_MAX_FULL_MARKET_CAP;
    uint128 public maxCloneMarketCap = HARD_MAX_CLONE_MARKET_CAP;
    uint128 public maxPerUserPrimaryCap = HARD_MAX_PER_USER_PRIMARY_CAP;
    uint16 public maxCreatorRakeBps = HARD_MAX_CREATOR_RAKE_BPS;
    uint16 public maxCreatorC2CFeeBps = HARD_MAX_C2C_FEE_BPS;

    event ProtocolTreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event CreationFeeUpdated(uint256 previousFee, uint256 newFee);
    event ProtocolShareUpdated(uint16 previousBps, uint16 newBps);
    event EarlyBirdShareUpdated(uint16 previousBps, uint16 newBps);
    event PlatformC2CFeeUpdated(uint16 previousBps, uint16 newBps);
    event MarketCapLimitsUpdated(uint128 fullMarketCap, uint128 cloneMarketCap);
    event PerUserPrimaryCapLimitUpdated(uint128 previousCap, uint128 newCap);
    event CreatorFeeLimitsUpdated(uint16 creatorRakeBps, uint16 creatorC2CFeeBps);

    constructor(address governance_, address paymentToken_, address treasury_) {
        if (governance_ == address(0) || paymentToken_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        if (IERC20Metadata(paymentToken_).decimals() != 6) {
            revert InvalidConfiguration("paymentToken.decimals");
        }
        governance = governance_;
        paymentToken = paymentToken_;
        protocolTreasury = treasury_;
        earlyBirdShareBps = 2000;
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert Unauthorized(msg.sender);
        _;
    }

    function setProtocolTreasury(address newTreasury) external onlyGovernance {
        if (newTreasury == address(0)) revert ZeroAddress();
        address previous = protocolTreasury;
        protocolTreasury = newTreasury;
        emit ProtocolTreasuryUpdated(previous, newTreasury);
    }

    function setCreationFee(uint128 newFee) external onlyGovernance {
        if (newFee > HARD_MAX_CREATION_FEE) {
            revert ValueOutOfRange("creationFee", newFee, 0, HARD_MAX_CREATION_FEE);
        }
        uint128 previous = creationFee;
        creationFee = newFee;
        emit CreationFeeUpdated(previous, newFee);
    }

    function setProtocolShareBps(uint16 newBps) external onlyGovernance {
        if (newBps > HARD_MAX_PROTOCOL_SHARE_BPS) {
            revert ValueOutOfRange("protocolShareBps", newBps, 0, HARD_MAX_PROTOCOL_SHARE_BPS);
        }
        uint16 previous = protocolShareBps;
        protocolShareBps = newBps;
        emit ProtocolShareUpdated(previous, newBps);
    }

    function setEarlyBirdShareBps(uint16 newBps) external onlyGovernance {
        if (newBps > HARD_MAX_EARLY_BIRD_SHARE_BPS) {
            revert ValueOutOfRange("earlyBirdShareBps", newBps, 0, HARD_MAX_EARLY_BIRD_SHARE_BPS);
        }
        uint16 previous = earlyBirdShareBps;
        earlyBirdShareBps = newBps;
        emit EarlyBirdShareUpdated(previous, newBps);
    }

    function setPlatformC2CFeeBps(uint16 newBps) external onlyGovernance {
        if (newBps > HARD_MAX_C2C_FEE_BPS) {
            revert ValueOutOfRange("platformC2CFeeBps", newBps, 0, HARD_MAX_C2C_FEE_BPS);
        }
        uint16 previous = platformC2CFeeBps;
        platformC2CFeeBps = newBps;
        emit PlatformC2CFeeUpdated(previous, newBps);
    }

    /// @notice Sets limits applied only when subsequently creating a market.
    function setMarketCapLimits(uint128 fullCap, uint128 cloneCap) external onlyGovernance {
        if (fullCap > HARD_MAX_FULL_MARKET_CAP) {
            revert ValueOutOfRange("maxFullMarketCap", fullCap, 0, HARD_MAX_FULL_MARKET_CAP);
        }
        if (cloneCap > HARD_MAX_CLONE_MARKET_CAP) {
            revert ValueOutOfRange("maxCloneMarketCap", cloneCap, 0, HARD_MAX_CLONE_MARKET_CAP);
        }
        maxFullMarketCap = fullCap;
        maxCloneMarketCap = cloneCap;
        emit MarketCapLimitsUpdated(fullCap, cloneCap);
    }

    /// @notice Sets the per-user limit applied only when subsequently creating a market.
    function setMaxPerUserPrimaryCap(uint128 newCap) external onlyGovernance {
        if (newCap > HARD_MAX_PER_USER_PRIMARY_CAP) {
            revert ValueOutOfRange("maxPerUserPrimaryCap", newCap, 0, HARD_MAX_PER_USER_PRIMARY_CAP);
        }
        uint128 previous = maxPerUserPrimaryCap;
        maxPerUserPrimaryCap = newCap;
        emit PerUserPrimaryCapLimitUpdated(previous, newCap);
    }

    /// @notice Sets creator fee limits applied only when subsequently creating a market.
    function setCreatorFeeLimits(uint16 rakeBps, uint16 c2cFeeBps) external onlyGovernance {
        if (rakeBps > HARD_MAX_CREATOR_RAKE_BPS) {
            revert ValueOutOfRange("maxCreatorRakeBps", rakeBps, 0, HARD_MAX_CREATOR_RAKE_BPS);
        }
        if (c2cFeeBps > HARD_MAX_C2C_FEE_BPS) {
            revert ValueOutOfRange("maxCreatorC2CFeeBps", c2cFeeBps, 0, HARD_MAX_C2C_FEE_BPS);
        }
        maxCreatorRakeBps = rakeBps;
        maxCreatorC2CFeeBps = c2cFeeBps;
        emit CreatorFeeLimitsUpdated(rakeBps, c2cFeeBps);
    }

    function snapshot(uint16 creatorRakeBps, uint16 creatorC2CFeeBps)
        external
        view
        returns (ProtocolTypes.EconomicSnapshot memory result)
    {
        if (creatorRakeBps > maxCreatorRakeBps) {
            revert ValueOutOfRange("creatorRakeBps", creatorRakeBps, 0, maxCreatorRakeBps);
        }
        if (creatorC2CFeeBps > maxCreatorC2CFeeBps) {
            revert ValueOutOfRange("creatorC2CFeeBps", creatorC2CFeeBps, 0, maxCreatorC2CFeeBps);
        }
        result = ProtocolTypes.EconomicSnapshot({
            creatorRakeBps: creatorRakeBps,
            protocolShareBps: protocolShareBps,
            earlyBirdShareBps: earlyBirdShareBps,
            platformC2CFeeBps: platformC2CFeeBps,
            creatorC2CFeeBps: creatorC2CFeeBps,
            protocolTreasury: protocolTreasury
        });
    }
}
