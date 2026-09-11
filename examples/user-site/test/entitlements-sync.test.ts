import { describe, expect, it } from "vitest";
import {
  A,
  H,
  appAccount,
  operation,
} from "../../../offchain/app-core/test/fixtures.js";
import type { Operation } from "../../../offchain/app-core/src/contracts.js";
import type {
  Entitlement,
  LedgerSnapshot,
} from "../../../offchain/app-core/src/ledger-contracts.js";
import {
  entitlementIntent,
  entitlementOperations,
  entitlementProgress,
  entitlementRefreshInterval,
  snapshotIncludesOperation,
} from "../src/entitlements-sync.js";

const right: Entitlement = {
  id: "early",
  kind: "early-bird",
  market: A(101),
  outcomeId: null,
  listingId: null,
  units: null,
  amount: "40000",
  status: "claimable",
  reason: null,
};
const claim: Operation = {
  ...operation,
  intent: { kind: "claim-early-bird", market: A(101) },
  kind: "claim-early-bird",
  state: "confirmed",
  blockNumber: "105",
  blockHash: H(105),
  transactionHash: H(205),
  userOperationHash: H(305),
  finality: "application-confirmed",
};
const snapshot = (block = "100"): LedgerSnapshot => ({
  environment: appAccount.environment,
  deploymentId: appAccount.deploymentId,
  version: 1,
  epoch: "1",
  blockNumber: block,
  blockHash: H(Number(block)),
  timestamp: "1",
  coverageStart: "1",
  complete: true,
  status: "active",
});

describe("entitlement synchronization", () => {
  it("keeps a confirmed claim blocked until the account snapshot reaches its receipt", () => {
    expect(entitlementProgress(right, [claim], snapshot())?.phase).toBe(
      "syncing",
    );
    expect(entitlementProgress(right, [claim], snapshot("104"))?.phase).toBe(
      "syncing",
    );
    expect(entitlementProgress(right, [claim], snapshot("105"))).toBeNull();
    expect(entitlementProgress(right, [claim], snapshot("106"))).toBeNull();
  });

  it("requires receipt evidence and a matching fork at the same height", () => {
    expect(
      snapshotIncludesOperation(
        { ...snapshot("105"), blockHash: H(999) },
        claim,
      ),
    ).toBe(false);
    expect(
      snapshotIncludesOperation(snapshot("106"), {
        ...claim,
        blockNumber: null,
      }),
    ).toBe(false);
    expect(
      snapshotIncludesOperation(snapshot("106"), {
        ...claim,
        transactionHash: null,
      }),
    ).toBe(false);
    expect(
      snapshotIncludesOperation(
        { ...snapshot("106"), deploymentId: "old" },
        claim,
      ),
    ).toBe(false);
  });

  it("never releases an unresolved operation just because the indexer is ahead", () => {
    for (const state of [
      "preparing",
      "awaiting-signature",
      "submitted",
      "confirming",
      "unknown",
    ] as const)
      expect(
        entitlementProgress(right, [{ ...claim, state }], snapshot("999"))
          ?.phase,
      ).toBe("executing");
  });

  it("allows a fresh attempt after cancellation or a failed transaction", () => {
    for (const state of ["cancelled", "reverted"] as const)
      expect(
        entitlementProgress(right, [{ ...claim, state }], snapshot()),
      ).toBeNull();
  });

  it("does not block another market or another kind of payout", () => {
    expect(
      entitlementProgress({ ...right, market: A(102) }, [claim], snapshot()),
    ).toBeNull();
    expect(
      entitlementProgress({ ...right, kind: "winner" }, [claim], snapshot()),
    ).toBeNull();
  });

  it("distinguishes settling a market bond from withdrawing the aggregate balance", () => {
    const settle: Operation = {
      ...claim,
      kind: "settle-bond",
      intent: { kind: "settle-bond", market: A(101) },
    };
    const bond: Entitlement = { ...right, kind: "bond" };
    expect(entitlementProgress(bond, [settle], snapshot())?.phase).toBe(
      "syncing",
    );
    expect(
      entitlementProgress({ ...bond, market: null }, [settle], snapshot()),
    ).toBeNull();
    const withdraw: Operation = {
      ...claim,
      kind: "claim-bond",
      intent: { kind: "claim-bond" },
    };
    expect(
      entitlementProgress({ ...bond, market: null }, [withdraw], snapshot())
        ?.phase,
    ).toBe("syncing");
    // A later credit is claimable again after the earlier withdrawal is indexed.
    expect(
      entitlementProgress(
        { ...bond, market: null },
        [withdraw],
        snapshot("106"),
      ),
    ).toBeNull();
  });

  it("guards the same escrow even if market finalization changes cancel to return", () => {
    const escrow: Entitlement = {
      ...right,
      kind: "escrow",
      listingId: H(9),
      reason: "return_terminal_listing",
    };
    const cancel: Operation = {
      ...claim,
      kind: "cancel-listing",
      intent: { kind: "cancel-listing", listingId: H(9) },
    };
    expect(entitlementProgress(escrow, [cancel], snapshot())?.phase).toBe(
      "syncing",
    );
    expect(
      entitlementProgress(
        { ...escrow, listingId: H(10) },
        [cancel],
        snapshot(),
      ),
    ).toBeNull();
  });

  it("does not manufacture claimable actions from waiting or processed rows", () => {
    expect(entitlementIntent(right)).toEqual(claim.intent);
    expect(entitlementIntent({ ...right, status: "claimed" })).toBeNull();
    expect(entitlementIntent({ ...right, status: "conditional" })).toBeNull();
    expect(
      entitlementProgress(
        { ...right, status: "conditional" },
        [claim],
        snapshot(),
      )?.phase,
    ).toBe("syncing");
  });

  it("refreshes lagging PnL and cursor pages independently and keeps idle refreshes", () => {
    expect(
      entitlementRefreshInterval([claim], [snapshot("105"), snapshot("100")]),
    ).toBe(5000);
    expect(entitlementRefreshInterval([claim], [snapshot("105")])).toBe(15000);
    expect(entitlementRefreshInterval([claim], [undefined])).toBe(5000);
    expect(entitlementRefreshInterval([], [snapshot()])).toBe(15000);
  });

  it("guards immediately after registration even before the operations list refreshes", () => {
    const records = entitlementOperations(appAccount, [], claim);
    expect(entitlementProgress(right, records, snapshot())?.phase).toBe(
      "syncing",
    );
    expect(entitlementOperations(appAccount, [claim], claim)).toHaveLength(1);
  });

  it("uses newer reconciliation results instead of a stale modal confirmation", () => {
    const newer: Operation = {
      ...claim,
      state: "unknown",
      updatedAt: "2026-09-09T00:01:00.000Z",
    };
    expect(entitlementOperations(appAccount, [newer], claim)[0]?.state).toBe(
      "unknown",
    );
    expect(entitlementOperations(appAccount, [claim], newer)[0]?.state).toBe(
      "unknown",
    );
    expect(
      entitlementOperations(
        appAccount,
        [{ ...claim, state: "unknown" }],
        claim,
      )[0]?.state,
    ).toBe("unknown");
  });

  it("isolates accounts, deployments and environments including the local modal", () => {
    for (const patch of [
      { accountId: "10000000-0000-4000-8000-000000000002" },
      { account: A(50) },
      { environment: "other" },
      { deploymentId: "other" },
    ]) {
      const other = { ...claim, ...patch };
      expect(entitlementOperations(appAccount, [other], other)).toEqual([]);
    }
    expect(entitlementOperations(null, [claim], claim)).toEqual([]);
  });
});
