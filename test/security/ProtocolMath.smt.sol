// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @notice Standalone SMTChecker harness for protocol conservation and terminal remainder math.
/// @dev It deliberately avoids imports so the exact solc binary can prove it reproducibly.
contract ProtocolMathSmt {
    uint256 internal constant BPS = 10_000;

    function check_RakeConservation(
        uint128 principal,
        uint16 creatorRakeBps,
        uint16 protocolShareBps,
        uint16 earlyBirdShareBps,
        bool earlyBirdEnabled
    ) external pure {
        require(creatorRakeBps <= BPS);
        require(protocolShareBps <= BPS);
        require(earlyBirdShareBps <= BPS);

        uint256 rake = uint256(principal) * creatorRakeBps / BPS;
        uint256 protocolFee = rake * protocolShareBps / BPS;
        uint256 creatorNet = rake - protocolFee;
        uint256 earlyBirdPool = earlyBirdEnabled ? creatorNet * earlyBirdShareBps / BPS : 0;
        uint256 creatorFee = creatorNet - earlyBirdPool;
        uint256 winnerPool = uint256(principal) - rake;

        assert(protocolFee + creatorFee + earlyBirdPool == rake);
        assert(winnerPool + rake == principal);
        assert(protocolFee <= rake);
        assert(earlyBirdPool <= creatorNet);
    }

    function check_RemainingPoolStep(
        uint128 remainingPool,
        uint128 remainingUnits,
        uint128 claimUnits
    ) external pure {
        require(remainingUnits > 0);
        require(claimUnits > 0 && claimUnits <= remainingUnits);

        uint256 payout = claimUnits == remainingUnits
            ? remainingPool
            : uint256(claimUnits) * remainingPool / remainingUnits;
        uint256 nextPool = uint256(remainingPool) - payout;
        uint256 nextUnits = uint256(remainingUnits) - claimUnits;

        assert(payout <= remainingPool);
        assert(nextPool + payout == remainingPool);
        assert(nextUnits + claimUnits == remainingUnits);
        if (nextUnits == 0) assert(nextPool == 0);
    }

    function check_C2CConservation(
        uint128 fillUnits,
        uint128 unitPrice,
        uint16 platformFeeBps,
        uint16 creatorFeeBps
    ) external pure {
        require(platformFeeBps <= BPS);
        require(creatorFeeBps <= BPS);
        require(uint256(platformFeeBps) + creatorFeeBps <= BPS);

        uint256 gross = uint256(fillUnits) * unitPrice / 1_000_000;
        uint256 platformFee = gross * platformFeeBps / BPS;
        uint256 creatorFee = gross * creatorFeeBps / BPS;
        uint256 sellerProceeds = gross - platformFee - creatorFee;

        assert(sellerProceeds + platformFee + creatorFee == gross);
        assert(sellerProceeds <= gross);
    }
}
