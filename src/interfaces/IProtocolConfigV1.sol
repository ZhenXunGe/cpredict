// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { ProtocolTypes } from "../libraries/ProtocolTypes.sol";

interface IProtocolConfigV1 {
    function governance() external view returns (address);
    function paymentToken() external view returns (address);
    function protocolTreasury() external view returns (address);
    function creationFee() external view returns (uint128);
    function protocolShareBps() external view returns (uint16);
    function earlyBirdShareBps() external view returns (uint16);
    function platformC2CFeeBps() external view returns (uint16);
    function maxFullMarketCap() external view returns (uint128);
    function maxCloneMarketCap() external view returns (uint128);
    function maxPerUserPrimaryCap() external view returns (uint128);
    function maxCreatorRakeBps() external view returns (uint16);
    function maxCreatorC2CFeeBps() external view returns (uint16);
    function snapshot(uint16 creatorRakeBps, uint16 creatorC2CFeeBps)
        external
        view
        returns (ProtocolTypes.EconomicSnapshot memory);
}
