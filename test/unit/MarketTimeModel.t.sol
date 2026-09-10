// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { ProtocolTestBase } from "../helpers/ProtocolTestBase.sol";
import { MarketVaultCoreV1 } from "../../src/market/MarketVaultCoreV1.sol";
import { ProtocolTypes } from "../../src/libraries/ProtocolTypes.sol";
import {
    InvalidConfiguration,
    ImmutableAfterFirstBuy,
    ResolutionWindowExpired,
    TimeoutNotReached
} from "../../src/libraries/ProtocolErrors.sol";

contract MarketTimeModelTest is ProtocolTestBase {
    function testOutcomeDeadlineAnchorsTimeoutAndAllowsEarlyResolutionFullAndClone() public {
        for (uint256 mode; mode < 2; ++mode) {
            ProtocolTypes.CreateMarketParams memory params =
                _defaultParams(ProtocolTypes.DeploymentMode(mode));
            params.eventStartsAt = params.closeAt + 1;
            params.outcomeDeadlineAt = params.closeAt + 3 days;
            MarketVaultCoreV1 market = _create(params, bytes32(mode));
            _buy(market, ALICE, 0, 1e6);
            assertEq(market.eventStartsAt(), params.eventStartsAt);
            assertEq(market.outcomeDeadlineAt(), params.outcomeDeadlineAt);
            assertEq(
                market.resolutionDeadline(),
                uint256(params.outcomeDeadlineAt) + market.resolutionWindow()
            );
            vm.warp(params.closeAt);
            vm.prank(CREATOR);
            market.resolve(0, bytes32(0));
            assertEq(uint256(market.marketState()), uint256(ProtocolTypes.MarketState.RESOLVED));
        }
    }

    function testOldCloseAnchoredTimeoutCannotVoidStillValidMarket() public {
        ProtocolTypes.CreateMarketParams memory params =
            _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.outcomeDeadlineAt = params.closeAt + 3 days;
        MarketVaultCoreV1 market = _create(params, bytes32("late-result"));
        vm.warp(uint256(params.closeAt) + market.resolutionWindow());
        vm.expectRevert(TimeoutNotReached.selector);
        market.voidAfterDeadline();
        _assertOpen(market);
    }

    function testTimeoutBoundaryHalfOpenFullAndClone() public {
        for (uint256 mode; mode < 2; ++mode) {
            ProtocolTypes.CreateMarketParams memory params =
                _defaultParams(ProtocolTypes.DeploymentMode(mode));
            params.outcomeDeadlineAt = params.closeAt + 1 days;
            MarketVaultCoreV1 market = _create(params, bytes32(mode));
            uint256 deadline = market.resolutionDeadline();
            vm.warp(deadline - 1);
            vm.expectRevert(TimeoutNotReached.selector);
            market.voidAfterDeadline();
            vm.warp(deadline);
            vm.prank(CREATOR);
            vm.expectRevert(ResolutionWindowExpired.selector);
            market.resolve(0, bytes32(0));
            vm.prank(CREATOR);
            vm.expectRevert(ResolutionWindowExpired.selector);
            market.creatorVoid(bytes32(0));
            vm.prank(BOB);
            market.voidAfterDeadline();
            assertEq(uint256(market.voidReason()), uint256(ProtocolTypes.VoidReason.TIMEOUT));
        }
    }

    function testUnknownStartAndExactEventEndAreAllowed() public {
        ProtocolTypes.CreateMarketParams memory params =
            _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        MarketVaultCoreV1 unknown = _create(params, bytes32("unknown"));
        assertEq(unknown.eventStartsAt(), 0);
        assertEq(unknown.outcomeDeadlineAt(), params.closeAt);
        params.eventStartsAt = params.closeAt + 1;
        params.outcomeDeadlineAt = params.eventStartsAt;
        MarketVaultCoreV1 known = _create(params, bytes32("known"));
        assertEq(known.eventStartsAt(), known.outcomeDeadlineAt());
    }

    function testFactoryRejectsInvalidTimeOrdering() public {
        ProtocolTypes.CreateMarketParams memory params =
            _defaultParams(ProtocolTypes.DeploymentMode.FULL);
        params.outcomeDeadlineAt = params.closeAt - 1;
        _expectInvalid(params);
        params.outcomeDeadlineAt = params.closeAt + 10;
        params.eventStartsAt = params.closeAt;
        _expectInvalid(params);
        params.eventStartsAt = params.outcomeDeadlineAt + 1;
        _expectInvalid(params);
    }

    function testUpdateRetainsCreationClockAndWindowThenFreezesAllTimes() public {
        MarketVaultCoreV1 market = _createDefault();
        uint64 created = market.createdAt();
        uint64 window = market.resolutionWindow();
        uint64 close = market.closeAt() + 1 hours;
        vm.prank(CREATOR);
        market.updateBeforeFirstBuy(
            ProtocolTypes.MarketTerms({
                rulesHash: keccak256("changed"),
                metadataURI: "ipfs://changed",
                resolutionSourceHash: bytes32(0),
                resolutionSourceURI: "",
                closeAt: close,
                eventStartsAt: close + 1,
                outcomeDeadlineAt: close + 1 days,
                creatorTreasury: CREATOR_TREASURY,
                featureFlags: 1
            })
        );
        assertEq(market.createdAt(), created);
        assertEq(market.resolutionWindow(), window);
        assertEq(market.resolutionDeadline(), uint256(close) + 1 days + window);
        vm.prank(CREATOR);
        vm.expectRevert(
            abi.encodeWithSelector(InvalidConfiguration.selector, bytes32("market.eventTimes"))
        );
        market.updateBeforeFirstBuy(
            ProtocolTypes.MarketTerms({
                rulesHash: keccak256("invalid"),
                metadataURI: "",
                resolutionSourceHash: bytes32(0),
                resolutionSourceURI: "",
                closeAt: close,
                eventStartsAt: close,
                outcomeDeadlineAt: close,
                creatorTreasury: CREATOR_TREASURY,
                featureFlags: 1
            })
        );
        _buy(market, ALICE, 0, 1e6);
        vm.prank(CREATOR);
        vm.expectRevert(ImmutableAfterFirstBuy.selector);
        market.updateBeforeFirstBuy(
            ProtocolTypes.MarketTerms({
                rulesHash: keccak256("frozen"),
                metadataURI: "",
                resolutionSourceHash: bytes32(0),
                resolutionSourceURI: "",
                closeAt: close,
                eventStartsAt: 0,
                outcomeDeadlineAt: close,
                creatorTreasury: CREATOR_TREASURY,
                featureFlags: 1
            })
        );
    }

    function _expectInvalid(ProtocolTypes.CreateMarketParams memory params) private {
        vm.expectRevert(
            abi.encodeWithSelector(InvalidConfiguration.selector, bytes32("market.eventTimes"))
        );
        _create(params, bytes32(0));
    }

    function _assertOpen(MarketVaultCoreV1 market) private view {
        assertEq(uint256(market.marketState()), uint256(ProtocolTypes.MarketState.OPEN));
    }
}
