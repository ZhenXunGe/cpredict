// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { PackedUserOperation } from "@account-abstraction/interfaces/PackedUserOperation.sol";

interface ISessionFactory {
    function isMarket(address market) external view returns (bool);
}

interface ISessionMarketplace {
    function orders(uint256 id)
        external
        view
        returns (address, address, uint128, uint128, uint64, uint8, uint8, bool, bool, uint256);
}

interface ISessionBond {
    function bondOf(address market) external view returns (address, uint128, bool);
}

/// @notice Kernel 0.3.1 permission policy and paired execution hook.
/// @dev Validation uses only account-associated storage. Dynamic registry/listing reads
/// run in the hook, outside ERC-4337 validation storage restrictions.
contract TradingSessionPolicyV2 {
    error InvalidSession();
    error ForbiddenCall();
    error BudgetExceeded();

    struct SessionState {
        uint128 perOperation;
        uint128 total;
        uint128 spent;
        uint48 validAfter;
        uint48 validUntil;
        bool installed;
        bool revoked;
    }

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }
    mapping(bytes32 => mapping(address => SessionState)) public sessionState;
    address public immutable factory;
    address public immutable marketplace;
    address public immutable paymentToken;
    address public immutable bondEscrow;
    address public immutable feeVault;
    address public immutable paymaster;
    bytes4 private constant EXECUTE = bytes4(keccak256("execute(bytes32,bytes)"));
    bytes4 private constant EXECUTE_USER_OP = bytes4(
        keccak256(
            "executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)"
        )
    );
    bytes4 private constant APPROVE = bytes4(keccak256("approve(address,uint256)"));
    bytes4 private constant SHARE_APPROVE = bytes4(keccak256("setApprovalForAll(address,bool)"));
    bytes4 private constant BUY = bytes4(keccak256("buy(uint256,uint256,uint256,uint256,uint64)"));
    bytes4 private constant FILL =
        bytes4(keccak256("fillOrder(uint256,uint128,uint128,uint256,uint64)"));
    bytes4 private constant CREATE =
        bytes4(keccak256("createOrder(address,uint8,uint8,uint128,uint128,uint64,bool)"));
    bytes4 private constant CLAIM = bytes4(keccak256("claimFor(address)"));
    bytes4 private constant SETTLE = bytes4(keccak256("settleBond(address)"));
    event SessionInstalled(
        bytes32 indexed id, address indexed account, uint128 total, uint48 validUntil
    );
    event SessionRevoked(bytes32 indexed id, address indexed account);
    event SessionBudgetUsed(
        bytes32 indexed id, address indexed account, uint128 amount, uint128 spent
    );

    constructor(
        address factory_,
        address marketplace_,
        address token_,
        address bond_,
        address fee_,
        address paymaster_
    ) {
        if (
            factory_ == address(0) || marketplace_ == address(0) || token_ == address(0)
                || bond_ == address(0) || fee_ == address(0) || paymaster_ == address(0)
        ) revert InvalidSession();
        factory = factory_;
        marketplace = marketplace_;
        paymentToken = token_;
        bondEscrow = bond_;
        feeVault = fee_;
        paymaster = paymaster_;
    }

    // The paired hook has no independent configuration; policy installation is per permission ID.
    function isInitialized(address) external pure returns (bool) {
        return true;
    }

    function isModuleType(uint256 moduleType) external pure returns (bool) {
        return moduleType == 4 || moduleType == 5;
    }

    function onInstall(bytes calldata data) external payable {
        if (data.length == 0) return; // Paired hook installation.
        if (data.length != 160) revert InvalidSession();
        bytes32 id = bytes32(data[:32]);
        (uint128 perOperation, uint128 total, uint48 validAfter, uint48 validUntil) =
            abi.decode(data[32:], (uint128, uint128, uint48, uint48));
        if (
            perOperation == 0 || total < perOperation || validUntil <= validAfter
                || validUntil - validAfter > 86_400
        ) {
            revert InvalidSession();
        }
        SessionState storage s = sessionState[id][msg.sender];
        if (s.revoked || s.installed) revert InvalidSession();
        s.perOperation = perOperation;
        s.total = total;
        s.validAfter = validAfter;
        s.validUntil = validUntil;
        s.installed = true;
        emit SessionInstalled(id, msg.sender, total, validUntil);
    }

    function onUninstall(bytes calldata data) external payable {
        if (data.length == 0) return;
        if (data.length < 32) revert InvalidSession();
        _revoke(bytes32(data[:32]));
    }

    function revoke(bytes32 id) external {
        _revoke(id);
    }

    function _revoke(bytes32 id) private {
        // Tombstones also revoke authorizations that have not yet been installed.
        sessionState[id][msg.sender].revoked = true;
        emit SessionRevoked(id, msg.sender);
    }

    function checkSignaturePolicy(bytes32, address, bytes32, bytes calldata)
        external
        pure
        returns (uint256)
    {
        revert ForbiddenCall();
    }

    function checkUserOpPolicy(bytes32 id, PackedUserOperation calldata op)
        external
        payable
        returns (uint256)
    {
        SessionState storage s = sessionState[id][msg.sender];
        if (op.sender != msg.sender || !s.installed || s.revoked) revert InvalidSession();
        if (
            op.paymasterAndData.length < 52
                || address(bytes20(op.paymasterAndData[:20])) != paymaster
        ) {
            revert ForbiddenCall();
        }
        if (op.callData.length < 8 || bytes4(op.callData[:4]) != EXECUTE_USER_OP) {
            revert ForbiddenCall();
        }
        uint256 amount = _check(_decode(op.callData[4:]), msg.sender, false);
        if (amount > s.perOperation || uint256(s.spent) + amount > s.total) {
            revert BudgetExceeded();
        }
        s.spent += uint128(amount);
        if (amount != 0) emit SessionBudgetUsed(id, msg.sender, uint128(amount), s.spent);
        // Do not read TIMESTAMP in validation. EntryPoint checks these bounds.
        return (uint256(s.validUntil) << 160) | (uint256(s.validAfter) << 208);
    }

    function preCheck(address, uint256 value, bytes calldata data)
        external
        view
        returns (bytes memory)
    {
        if (value != 0) revert ForbiddenCall();
        _check(_decode(data), msg.sender, true);
        return "";
    }
    function postCheck(bytes calldata) external pure { }

    function _decode(bytes calldata data) private pure returns (Call[] memory calls) {
        if (data.length < 4 || bytes4(data[:4]) != EXECUTE) revert ForbiddenCall();
        (bytes32 mode, bytes memory payload) = abi.decode(data[4:], (bytes32, bytes));
        if (keccak256(data) != keccak256(abi.encodeWithSelector(EXECUTE, mode, payload))) {
            revert ForbiddenCall();
        }
        if (mode == bytes32(0)) {
            if (payload.length < 52) revert ForbiddenCall();
            address target;
            uint256 value;
            assembly {
                target := shr(96, mload(add(payload, 32)))
                value := mload(add(payload, 52))
            }
            bytes memory inner = new bytes(payload.length - 52);
            for (uint256 i; i < inner.length; ++i) {
                inner[i] = payload[i + 52];
            }
            calls = new Call[](1);
            calls[0] = Call(target, value, inner);
        } else if (mode == bytes32(uint256(1) << 248)) {
            calls = abi.decode(payload, (Call[]));
            if (
                calls.length < 2 || calls.length > 4
                    || keccak256(payload) != keccak256(abi.encode(calls))
            ) revert ForbiddenCall();
        } else {
            revert ForbiddenCall();
        }
        for (uint256 i; i < calls.length; ++i) {
            if (calls[i].value != 0) revert ForbiddenCall();
        }
    }

    function _check(Call[] memory c, address account, bool dynamicChecks)
        private
        view
        returns (uint256 amount)
    {
        if (c.length == 4) {
            bytes4 selector = _selector(c[2].data);

            address spender = c[2].target;
            if (selector == BUY) {
                if (c[2].data.length != 164) revert ForbiddenCall();
                amount = _word(c[2].data, 3);
                if (dynamicChecks) _market(spender);
            } else if (selector == FILL && spender == marketplace) {
                if (c[2].data.length != 164) revert ForbiddenCall();
                amount = _word(c[2].data, 3);
                if (dynamicChecks) {
                    (,, uint8 side) = _order(_word(c[2].data, 0), account, false);
                    if (side != 1) revert ForbiddenCall();
                }
            } else if (selector == CREATE && spender == marketplace) {
                if (c[2].data.length != 228 || _word(c[2].data, 2) != 0) revert ForbiddenCall();
                uint256 units = _word(c[2].data, 3);
                uint256 price = _word(c[2].data, 4);
                if (units > type(uint128).max || price > 1000e6) revert ForbiddenCall();
                amount = (units * price + 999_999) / 1e6;
                if (dynamicChecks) _market(_address(c[2].data, 0));
            } else {
                revert ForbiddenCall();
            }
            if (amount == 0) revert ForbiddenCall();
            _approval(c[0], spender, 0);
            _approval(c[1], spender, amount);
            _approval(c[3], spender, 0);
        } else if (c.length == 3) {
            if (c[1].target != marketplace) revert ForbiddenCall();
            bytes4 selector = _selector(c[1].data);
            address market = c[0].target;
            if (selector == CREATE) {
                if (
                    c[1].data.length != 228 || _word(c[1].data, 2) != 1
                        || _address(c[1].data, 0) != market || _word(c[1].data, 3) == 0
                        || _word(c[1].data, 4) == 0
                ) revert ForbiddenCall();
            } else if (selector == FILL) {
                if (c[1].data.length != 164) revert ForbiddenCall();
                if (dynamicChecks) {
                    (address vault,, uint8 side) = _order(_word(c[1].data, 0), account, false);
                    if (vault != market || side != 0) revert ForbiddenCall();
                }
            } else {
                revert ForbiddenCall();
            }
            if (dynamicChecks) _market(market);
            if (
                c[0].target != market || c[2].target != market
                    || keccak256(c[0].data)
                        != keccak256(abi.encodeWithSelector(SHARE_APPROVE, marketplace, true))
                    || keccak256(c[2].data)
                        != keccak256(abi.encodeWithSelector(SHARE_APPROVE, marketplace, false))
            ) revert ForbiddenCall();
        } else if (c.length == 2) {
            _bond(c[0], account, dynamicChecks);
            if (
                c[1].target != bondEscrow
                    || keccak256(c[1].data) != keccak256(abi.encodeWithSelector(CLAIM, account))
            ) revert ForbiddenCall();
        } else if (c.length == 1) {
            Call memory a = c[0];
            bytes4 selector = _selector(a.data);
            if (
                a.target == marketplace
                    && (selector == bytes4(keccak256("cancelOrder(uint256)"))
                        || selector == bytes4(keccak256("releaseOrder(uint256)")))
            ) {
                if (a.data.length != 36) revert ForbiddenCall();
                if (dynamicChecks) _order(_word(a.data, 0), account, true);
            } else if (a.target == bondEscrow && selector == SETTLE) {
                _bond(a, account, dynamicChecks);
            } else if ((a.target == bondEscrow || a.target == feeVault) && selector == CLAIM) {
                if (keccak256(a.data) != keccak256(abi.encodeWithSelector(CLAIM, account))) {
                    revert ForbiddenCall();
                }
            } else {
                if (
                    a.data.length != 36 || _address(a.data, 0) != account
                        || (selector != bytes4(keccak256("claimWinningsFor(address)"))
                            && selector != bytes4(keccak256("claimEarlyBirdFor(address)"))
                            && selector != bytes4(keccak256("refundFor(address)"))
                            && selector != bytes4(keccak256("claimTimeoutBonusFor(address)")))
                ) revert ForbiddenCall();
                if (dynamicChecks) _market(a.target);
            }
        } else {
            revert ForbiddenCall();
        }
    }

    function _market(address market) private view {
        if (!ISessionFactory(factory).isMarket(market)) revert ForbiddenCall();
    }

    function _order(uint256 id, address account, bool ownerOnly)
        private
        view
        returns (address market, address owner, uint8 side)
    {
        bool active;
        (market, owner,,,,, side,, active,) = ISessionMarketplace(marketplace).orders(id);
        _market(market);
        if (!active || (ownerOnly ? owner != account : owner == account)) revert ForbiddenCall();
    }

    function _bond(Call memory a, address account, bool dynamicChecks) private view {
        if (a.target != bondEscrow || a.data.length != 36 || _selector(a.data) != SETTLE) {
            revert ForbiddenCall();
        }
        address market = _address(a.data, 0);
        if (dynamicChecks) {
            _market(market);
            (address creator,,) = ISessionBond(bondEscrow).bondOf(market);
            if (creator != account) revert ForbiddenCall();
        }
    }

    function _approval(Call memory a, address spender, uint256 amount) private view {
        if (
            a.target != paymentToken
                || keccak256(a.data) != keccak256(abi.encodeWithSelector(APPROVE, spender, amount))
        ) revert ForbiddenCall();
    }

    function _selector(bytes memory data) private pure returns (bytes4 value) {
        if (data.length < 4) revert ForbiddenCall();
        assembly { value := mload(add(data, 32)) }
    }

    function _word(bytes memory data, uint256 index) private pure returns (uint256 value) {
        if (data.length < 36 + index * 32) revert ForbiddenCall();
        assembly { value := mload(add(add(data, 36), mul(index, 32))) }
    }

    function _address(bytes memory data, uint256 index) private pure returns (address) {
        uint256 value = _word(data, index);
        if (value > type(uint160).max) revert ForbiddenCall();
        return address(uint160(value));
    }
}
