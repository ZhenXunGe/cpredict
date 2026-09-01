// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { IERC1155 } from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import { ProtocolTypes } from "../libraries/ProtocolTypes.sol";

interface IMarketVaultV1 is IERC1155 {
    function initialize(ProtocolTypes.MarketInitParams calldata params) external;
    function factory() external view returns (address);
    function creator() external view returns (address);
    function creatorTreasury() external view returns (address);
    function protocolTreasury() external view returns (address);
    function paymentToken() external view returns (address);
    function outcomeCount() external view returns (uint8);
    function resolutionWindow() external view returns (uint64);
    function minimumC2CUnits() external view returns (uint128);
    function marketState() external view returns (ProtocolTypes.MarketState);
    function isTerminal() external view returns (bool);
    function permit2Enabled() external view returns (bool);
    function totalPrincipal() external view returns (uint256);
    function guardExposure() external view returns (uint256);
    function creatorC2CFeeBps() external view returns (uint16);
    function platformC2CFeeBps() external view returns (uint16);

    /// @notice Resolves the market with an optional event-only evidence commitment.
    /// @dev The evidence hash is not validated or stored and zero means no commitment was provided.
    function resolve(uint256 outcomeId, bytes32 evidenceHash) external;

    /// @notice Voids the market by creator action with an optional event-only evidence commitment.
    /// @dev The evidence hash is not validated or stored and zero means no commitment was provided.
    function creatorVoid(bytes32 evidenceHash) external;

    /// @notice Permissionlessly voids the market after its deadline and emits a zero evidence hash.
    function voidAfterDeadline() external;

    function fundTimeoutBonus(uint256 amount) external;
}
