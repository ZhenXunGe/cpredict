// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

// Authorization
error Unauthorized(address caller);
error ZeroAddress();
error AlreadyConfigured();

// Configuration and ranges
error InvalidConfiguration(bytes32 field);
error ValueOutOfRange(bytes32 field, uint256 value, uint256 minimum, uint256 maximum);
error UnsupportedFeatureFlags(uint256 flags);
error InvalidDeploymentMode();
error InvalidOutcome(uint256 outcomeId, uint256 outcomeCount);
error UriTooLong(uint256 supplied, uint256 maximum);
error ImmutableAfterFirstBuy();

// Time and state
error InvalidMarketState(uint8 expected, uint8 actual);
error MarketNotOpen();
error MarketNotClosed();
error MarketTerminal();
error DeadlineExpired(uint256 deadline, uint256 currentTime);
error ResolutionWindowExpired();
error TimeoutNotReached();
error PauseActive(uint256 flag);
error EmergencyEpochAlreadyUsed(uint64 epoch);
error EmergencyPauseStillActive(uint64 expiresAt);

// Capacity and accounting
error ZeroAmount();
error FillBelowMinimum(uint256 filled, uint256 minimum);
error PaymentAboveMaximum(uint256 payment, uint256 maximum);
error ExposureCapExceeded(uint256 requested, uint256 available);
error Insolvent(uint256 balance, uint256 liabilities);
error InexactTokenTransfer(uint256 expected, uint256 received);
error WinningOutcomeHasNoSupply(uint256 outcomeId);
error NothingToClaim();
error AlreadySettled();
error InvariantViolation(bytes32 invariantId);

// Factory and clone
error MarketNotRegistered(address market);
error MarketAlreadyRegistered(address market);
error FactoryNotActive();
error DependencyCodeMissing(bytes32 dependency, address target);
error DependencyFingerprintMismatch(bytes32 expected, bytes32 actual);
error DependencyWiringMismatch(bytes32 dependency, address expected, address actual);
error CloneImplementationLocked();
error AlreadyInitialized();
error InvalidInitializer(address caller);
error DeploymentFailed();

// Listings and payments
error ListingNotActive(bytes32 listingId);
error ListingExpired(bytes32 listingId);
error MarketNotClosedForReturn();
error InvalidListingExpiry();
error InvalidPrice(uint256 unitPrice);
error UnexpectedERC1155Transfer();
error EscrowOwnerMustReturnListing(address marketplace);
error WrongEscrowToken(address token);
error Permit2Disabled();

// Bond, fees, and guard
error BondNotLocked(address market);
error BondStateMismatch(address market);
error AccruerNotAuthorized(address caller);
error ExposureGuardRetired();
error ExposureCapCannotDecrease(uint256 currentCap, uint256 proposedCap);

// Paymaster
error SponsorshipExpired();
error InvalidSponsorSignature();
error UnsupportedUserOperation();
error SponsorshipBudgetExceeded();
