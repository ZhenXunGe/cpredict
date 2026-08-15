// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { ProtocolTypes } from "../libraries/ProtocolTypes.sol";
import {
    Unauthorized,
    ZeroAddress,
    ValueOutOfRange,
    InvalidConfiguration,
    EmergencyEpochAlreadyUsed,
    EmergencyPauseStillActive
} from "../libraries/ProtocolErrors.sol";

/// @notice A bounded, non-custodial emergency brake that only stops new risk.
contract EmergencyControllerV1 {
    uint64 public constant MAX_PAUSE_DURATION = 7 days;

    address public immutable governance;
    address public emergencySafe;
    uint64 public epoch = 1;
    uint64 public pauseExpiresAt;
    uint256 public pausedFlags;
    mapping(uint64 => bool) public epochUsed;

    event EmergencySafeUpdated(address indexed previousSafe, address indexed newSafe);
    event EmergencyPauseActivated(
        uint64 indexed epoch, uint256 indexed flags, uint64 expiresAt, address indexed caller
    );
    event EmergencyEpochReset(uint64 indexed previousEpoch, uint64 indexed newEpoch);

    constructor(address governance_, address emergencySafe_) {
        if (governance_ == address(0) || emergencySafe_ == address(0)) revert ZeroAddress();
        governance = governance_;
        emergencySafe = emergencySafe_;
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert Unauthorized(msg.sender);
        _;
    }

    function isPaused(uint256 flag) external view returns (bool) {
        return block.timestamp < pauseExpiresAt && (pausedFlags & flag) != 0;
    }

    function pause(uint256 flags, uint64 duration) external {
        if (msg.sender != emergencySafe) revert Unauthorized(msg.sender);
        if (flags == 0 || (flags & ~ProtocolTypes.ALL_PAUSE_FLAGS) != 0) {
            revert InvalidConfiguration("pause.flags");
        }
        if (duration == 0 || duration > MAX_PAUSE_DURATION) {
            revert ValueOutOfRange("pause.duration", duration, 1, MAX_PAUSE_DURATION);
        }
        if (epochUsed[epoch]) revert EmergencyEpochAlreadyUsed(epoch);

        epochUsed[epoch] = true;
        pausedFlags = flags;
        pauseExpiresAt = uint64(block.timestamp) + duration;
        emit EmergencyPauseActivated(epoch, flags, pauseExpiresAt, msg.sender);
    }

    function resetEpoch() external onlyGovernance {
        if (block.timestamp < pauseExpiresAt) revert EmergencyPauseStillActive(pauseExpiresAt);
        uint64 previous = epoch;
        epoch = previous + 1;
        pausedFlags = 0;
        pauseExpiresAt = 0;
        emit EmergencyEpochReset(previous, epoch);
    }

    function setEmergencySafe(address newSafe) external onlyGovernance {
        if (newSafe == address(0)) revert ZeroAddress();
        address previous = emergencySafe;
        emergencySafe = newSafe;
        emit EmergencySafeUpdated(previous, newSafe);
    }
}

