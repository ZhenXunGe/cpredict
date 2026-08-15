// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { ProtocolTestBase } from "../helpers/ProtocolTestBase.sol";
import { Unauthorized } from "../../src/libraries/ProtocolErrors.sol";

/// @notice Direct public-entry and modifier failure checks that make the coverage evidence
/// explicit.
contract CoverageCompletenessTest is ProtocolTestBase {
    function testDependencyFingerprintForDirectPublicEntry() public view {
        assertEq(
            factory.dependencyFingerprintFor(address(marketplace)), factory.dependencyFingerprint()
        );
    }

    function testFactoryGovernanceModifierLowLevelFailure() public {
        vm.prank(ALICE);
        (bool ok, bytes memory revertData) =
            address(factory).call(abi.encodeCall(factory.setDeprecated, (true)));

        assertFalse(ok);
        assertEq(
            keccak256(revertData), keccak256(abi.encodeWithSelector(Unauthorized.selector, ALICE))
        );
        assertFalse(factory.deprecated());
    }

    function testConfigGovernanceModifierLowLevelFailure() public {
        vm.prank(ALICE);
        (bool ok, bytes memory revertData) =
            address(config).call(abi.encodeCall(config.setCreationFee, (uint128(1))));

        assertFalse(ok);
        assertEq(
            keccak256(revertData), keccak256(abi.encodeWithSelector(Unauthorized.selector, ALICE))
        );
        assertEq(config.creationFee(), 0);
    }
}
