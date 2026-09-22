import { describe, it, expect, vi } from "vitest";
import { keccak256, zeroAddress, type Address, type Hex } from "viem";
import {
  AutomaticClaimsWorker,
  automationEffect,
  type AutomationStore,
  type AutomationChain,
  type AutomationRecord,
  type AutomaticAction,
} from "../src/automatic-claims.js";
const owner = "0x1111111111111111111111111111111111111111" as Address;
const action: AutomaticAction = {
  key: "winner:market:owner",
  owner,
  kind: "winner",
  target: owner,
  data: "0x1234",
  requiresClaimPreference: true,
};
const raw = "0x123456" as Hex,
  hash = keccak256(raw);
function fixture() {
  let enabled = true;
  let locked = false;
  const rows: AutomationRecord[] = [];
  const store: AutomationStore = {
    async exclusive(fn) {
      if (locked) return;
      locked = true;
      try {
        return await fn();
      } finally {
        locked = false;
      }
    },
    enabled: vi.fn(async () => enabled),
    pending: vi.fn(async () =>
      rows.filter((r) =>
        ["prepared", "broadcasting", "unknown"].includes(r.state),
      ),
    ),
    save: vi.fn(async (a, p) => {
      const r: AutomationRecord = {
        ...a,
        ...p,
        id: String(rows.length),
        state: "prepared",
      };
      rows.push(r);
      return r;
    }),
    markBroadcasting: vi.fn(async (id) => {
      const r = rows.find((r) => r.id === id)!;
      if (r.state !== "prepared") return false;
      r.state = "broadcasting";
      return true;
    }),
    unknown: vi.fn(async (id) => {
      rows.find((r) => r.id === id)!.state = "unknown";
    }),
    finish: vi.fn(async (id, r) => {
      rows.find((r) => r.id === id)!.state =
        r.status === "success" ? "confirmed" : "reverted";
    }),
    cancelPrepared: vi.fn(async (id) => {
      rows.splice(
        rows.findIndex((r) => r.id === id),
        1,
      );
    }),
    spentToday: vi.fn(async () => 0n),
    status: vi.fn(async () => {}),
    auditCanonical: vi.fn(async () => []),
  };
  const chain: AutomationChain = {
    eligible: vi.fn(async () => true),
    prepare: vi.fn(async () => ({ raw, hash, nonce: 0n, maximumCost: 10n })),
    send: vi.fn(async () => {
      expect(rows[0]?.state).toBe("broadcasting");
      return hash;
    }),
    receipt: vi.fn(async () => null),
    canonicalFinal: vi.fn(async () => true),
    balance: vi.fn(async () => 100n),
  };
  const source = {
    async *candidates() {
      yield action;
    },
  };
  return {
    store,
    chain,
    rows,
    source,
    disable: () => {
      enabled = false;
    },
    worker: new AutomaticClaimsWorker(store, chain, source, 100n),
  };
}
describe("durable automatic claims", () => {
  it("classifies payout, asset return and market maintenance effects", () => {
    expect(automationEffect("winner")).toBe("payout");
    expect(automationEffect("return-listing:1")).toBe("asset-return");
    expect(automationEffect("settle-bond:0x1")).toBe("market-maintenance");
    expect(automationEffect("void-timeout")).toBe("market-maintenance");
    expect(automationEffect("match-orders")).toBe("matching");
    expect(automationEffect("future-kind")).toBe("unknown");
  });
  it("persists before broadcast; crash/unknown never resends", async () => {
    const f = fixture();
    vi.mocked(f.chain.send).mockRejectedValue(new Error("network timeout"));
    await f.worker.tick();
    expect(f.rows[0]?.state).toBe("unknown");
    await new AutomaticClaimsWorker(f.store, f.chain, f.source, 100n).tick();
    expect(f.chain.send).toHaveBeenCalledTimes(1);
    expect(f.chain.prepare).toHaveBeenCalledTimes(1);
  });
  it("concurrent ticks share one nonce lane", async () => {
    const f = fixture();
    await Promise.all([f.worker.tick(), f.worker.tick()]);
    expect(f.chain.send).toHaveBeenCalledTimes(1);
  });
  it("opt-out prevents new work, but does not forget an already sent transaction", async () => {
    const f = fixture();
    await f.worker.tick();
    f.disable();
    await f.worker.tick();
    expect(f.chain.receipt).toHaveBeenCalledWith(hash);
    expect(f.chain.send).toHaveBeenCalledTimes(1);
    const g = fixture();
    g.disable();
    await g.worker.tick();
    expect(g.chain.prepare).not.toHaveBeenCalled();
  });
  it("cancel a prepared but never broadcast transaction after opt-out", async () => {
    const f = fixture();
    f.rows.push({
      ...action,
      raw,
      hash,
      nonce: 0n,
      maximumCost: 10n,
      id: "a",
      state: "prepared",
    });
    f.disable();
    await f.worker.tick();
    expect(f.store.cancelPrepared).toHaveBeenCalledWith("a");
    expect(f.chain.send).not.toHaveBeenCalled();
  });
  it("reconciles final canonical receipts and then discovers future fee credits", async () => {
    const f = fixture();
    await f.worker.tick();
    vi.mocked(f.chain.receipt).mockResolvedValue({
      status: "success",
      blockNumber: 10n,
      blockHash: hash,
    });
    vi.mocked(f.chain.eligible).mockResolvedValue(false);
    await f.worker.tick();
    expect(f.store.finish).toHaveBeenCalledOnce();
    expect(f.store.status).toHaveBeenCalledWith(owner, "received");
    expect(f.chain.send).toHaveBeenCalledTimes(1);
    vi.mocked(f.chain.eligible).mockResolvedValue(true);
    await f.worker.tick();
    expect(f.chain.send).toHaveBeenCalledTimes(2);
  });
  it("never attributes market maintenance completion to its triggering holder", async () => {
    const f = fixture();
    f.source.candidates = async function* () {
      yield {
        ...action,
        kind: "settle-bond:0x1111111111111111111111111111111111111111",
      };
    };
    f.worker = new AutomaticClaimsWorker(f.store, f.chain, f.source, 100n);
    await f.worker.tick();
    vi.mocked(f.chain.receipt).mockResolvedValue({
      status: "success",
      blockNumber: 10n,
      blockHash: hash,
    });
    await f.worker.tick();
    expect(f.store.status).toHaveBeenCalledWith(
      zeroAddress,
      "market_state_updated",
    );
    expect(f.store.status).not.toHaveBeenCalledWith(owner, "received");
  });
  it("describes returned listing assets separately from a payout", async () => {
    const f = fixture();
    f.source.candidates = async function* () {
      yield { ...action, kind: "return-listing:1" };
    };
    f.worker = new AutomaticClaimsWorker(f.store, f.chain, f.source, 100n);
    await f.worker.tick();
    vi.mocked(f.chain.receipt).mockResolvedValue({
      status: "success",
      blockNumber: 10n,
      blockHash: hash,
    });
    await f.worker.tick();
    expect(f.store.status).toHaveBeenCalledWith(owner, "assets_returned");
    expect(f.store.status).not.toHaveBeenCalledWith(owner, "received");
  });
  it("a noncanonical or insufficiently confirmed receipt cannot unlock another send", async () => {
    const f = fixture();
    await f.worker.tick();
    vi.mocked(f.chain.receipt).mockResolvedValue({
      status: "success",
      blockNumber: 10n,
      blockHash: hash,
    });
    vi.mocked(f.chain.canonicalFinal).mockResolvedValue(false);
    await f.worker.tick();
    expect(f.store.finish).not.toHaveBeenCalled();
    expect(f.chain.prepare).toHaveBeenCalledTimes(1);
  });
  it("withdraws received status when the canonical indexer orphans a finalized transaction", async () => {
    const f = fixture();
    vi.mocked(f.store.auditCanonical!).mockResolvedValueOnce([
      { ...action, kind: "winner" },
    ]);
    vi.mocked(f.chain.eligible).mockResolvedValue(false);
    await f.worker.tick();
    expect(f.store.status).toHaveBeenCalledWith(
      owner,
      "rechecking_after_reorg",
    );
    expect(f.chain.send).not.toHaveBeenCalled();
  });
  it("budget and gas shortages queue without broadcasting", async () => {
    const f = fixture();
    vi.mocked(f.store.spentToday).mockResolvedValue(95n);
    await f.worker.tick();
    expect(f.chain.send).not.toHaveBeenCalled();
    expect(f.store.status).toHaveBeenCalledWith(
      owner,
      "daily_gas_budget_exhausted",
    );
    vi.mocked(f.store.spentToday).mockResolvedValue(0n);
    vi.mocked(f.chain.balance).mockResolvedValue(5n);
    await f.worker.tick();
    expect(f.store.status).toHaveBeenCalledWith(
      owner,
      "gas_balance_insufficient",
    );
    expect(f.chain.send).not.toHaveBeenCalled();
  });
  it("manual claims winning the race or zero entitlement skip sending", async () => {
    const f = fixture();
    vi.mocked(f.chain.eligible).mockResolvedValue(false);
    await f.worker.tick();
    expect(f.store.save).not.toHaveBeenCalled();
  });
  it("does not broadcast if durable persistence fails", async () => {
    const f = fixture();
    vi.mocked(f.store.save).mockRejectedValue(new Error("db unavailable"));
    await f.worker.tick();
    expect(f.chain.send).not.toHaveBeenCalled();
  });
});

describe("submission admission", () => {
  it("does not sign or broadcast when the selected writer is unavailable", async () => {
    const f = fixture();
    f.chain.submissionReady = async () => false;
    await f.worker.tick();
    expect(f.chain.prepare).not.toHaveBeenCalled();
    expect(f.chain.send).not.toHaveBeenCalled();
    expect(f.rows).toHaveLength(0);
    expect(f.store.status).toHaveBeenCalledWith(
      owner,
      "submission_rpc_unavailable",
    );
    f.chain.submissionReady = async () => true;
    await f.worker.tick();
    expect(f.chain.send).toHaveBeenCalledTimes(1);
  });
  it("never re-sends unknown transactions when writer availability changes", async () => {
    const f = fixture();
    await f.worker.tick();
    f.chain.submissionReady = vi.fn(async () => true);
    await f.worker.tick();
    await f.worker.tick();
    expect(f.chain.send).toHaveBeenCalledTimes(1);
    expect(f.chain.submissionReady).not.toHaveBeenCalled();
  });
});
