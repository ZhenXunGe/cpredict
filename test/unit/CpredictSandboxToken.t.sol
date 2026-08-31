// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";
import { CpredictSandboxToken } from "../../src/testnet/CpredictSandboxToken.sol";

contract CpredictSandboxTokenTest is Test {
    CpredictSandboxToken internal token;

    function setUp() external {
        vm.chainId(421_614);
        token = new CpredictSandboxToken();
    }

    function testMetadataAndSandboxMarkerAreExplicit() external view {
        assertEq(token.name(), "Cpredict Test USD");
        assertEq(token.symbol(), "ctUSD");
        assertEq(token.decimals(), 6);
        assertTrue(token.IS_CPREDICT_SANDBOX_TOKEN());
    }

    function testAnyAccountCanMintArbitraryTestBalance() external {
        address recipient = makeAddr("recipient");
        vm.prank(makeAddr("faucet-user"));
        token.mint(recipient, 12_345e6);
        assertEq(token.balanceOf(recipient), 12_345e6);
    }

    function testRejectsZeroRecipientAndAmount() external {
        vm.expectRevert(CpredictSandboxToken.ZeroRecipient.selector);
        token.mint(address(0), 1);
        vm.expectRevert(CpredictSandboxToken.ZeroAmount.selector);
        token.mint(address(this), 0);
    }

    function testCannotDeployOutsideArbitrumSepolia() external {
        vm.chainId(1);
        vm.expectRevert(
            abi.encodeWithSelector(CpredictSandboxToken.SandboxChainOnly.selector, uint256(1))
        );
        new CpredictSandboxToken();
    }
}
