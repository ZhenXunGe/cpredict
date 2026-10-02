import { describe, it, expect, vi } from "vitest";
import { keccak256, type PublicClient } from "viem";
import {
  AutomationRecovery,
  RecoveryQuorum,
  type RecoveryChain,
  type RecoveryStore,
} from "../src/automatic-recovery.js";
import type { AutomationRecord } from "../src/automatic-claims.js";
const owner = "0x1111111111111111111111111111111111111111" as const;
const raw = "0x1234" as const,
  replacementRaw = "0x5678" as const;
const tx: AutomationRecord = {
  id: "task",
  state: "unknown",
  key: "refund",
  kind: "refund",
  owner,
  target: owner,
  data: "0x1234",
  requiresClaimPreference: true,
  raw,
  hash: keccak256(raw),
  nonce: 5n,
  maximumCost: 10n,
};
function node() {
  return {
    name: "node",
    client: {
      getChainId: vi.fn(async () => 421614),
      getBlockNumber: vi.fn(async () => 100n),
      getTransactionCount: vi.fn(async () => 5),
      request: vi.fn(async () => null),
      getBlock: vi.fn(async () => ({ number: 98n, hash: keccak256(raw) })),
    } as unknown as PublicClient,
  };
}
function fixture() {
  const nodes = [node(), node(), node()];
  const quorum = new RecoveryQuorum(nodes, 421614, owner);
  const replacement = {
    raw: replacementRaw,
    hash: keccak256(replacementRaw),
    nonce: 5n,
    maximumCost: 20n,
  };
  let saved = false,
    started = false;
  const store: RecoveryStore = {
    enabled: vi.fn(async () => true),
    spentToday: vi.fn(async () => 0n),
    saveRecovery: vi.fn(async (t, p, mode) => {
      if (saved) throw new Error("already_attempted");
      saved = true;
      return {
        ...p,
        id: "recovery",
        transactionId: t.id,
        originalHash: t.hash,
        mode,
        state: "prepared",
      };
    }),
    startRecovery: vi.fn(async () => {
      if (started) return false;
      started = true;
      return true;
    }),
    recoverySubmitted: vi.fn(async () => {}),
    recoveryCheck: vi.fn(async () => {}),
  };
  const chain: RecoveryChain = {
    eligible: vi.fn(async () => true),
    balance: vi.fn(async () => 100n),
    prepare: vi.fn(async () => replacement),
    prepareRecovery: vi.fn(async () => replacement),
    validate: vi.fn(async () => {}),
    send: vi.fn(async () => {
      expect(saved && started).toBe(true);
      return replacement.hash;
    }),
    receipt: vi.fn(async () => null),
    canonicalFinal: vi.fn(async () => true),
    submissionReady: vi.fn(async () => true),
  };
  return {
    nodes,
    store,
    chain,
    quorum,
    replacement,
    recovery: new AutomationRecovery(store, chain, quorum, 100n, 100n),
  };
}
describe("bounded keeper recovery", () => {
  it("persists signed replacement before one broadcast and never allocates a fresh nonce", async () => {
    const f = fixture();
    await f.recovery.automatic(tx);
    expect(f.chain.send).toHaveBeenCalledOnce();
    expect(f.chain.prepare).not.toHaveBeenCalled();
    expect(f.store.saveRecovery).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ nonce: 5n }),
      "automatic",
      undefined,
    );
    await f.recovery.automatic(tx);
    expect(f.chain.send).toHaveBeenCalledOnce();
  });
  it("broadcast timeout remains unknown without a second send", async () => {
    const f = fixture();
    vi.mocked(f.chain.send).mockRejectedValue(
      new Error("secret RPC timed out"),
    );
    await f.recovery.automatic(tx);
    expect(f.store.recoverySubmitted).toHaveBeenCalledWith(
      expect.anything(),
      "writer-unknown",
      { reason: "timeout" },
    );
    await f.recovery.automatic(tx);
    expect(f.chain.send).toHaveBeenCalledOnce();
  });
  it("unavailable nodes never count as absence votes", async () => {
    const f = fixture();
    vi.mocked(f.nodes[0]!.client.getChainId).mockRejectedValue(
      new Error("offline"),
    );
    await f.recovery.automatic(tx);
    expect(f.chain.send).not.toHaveBeenCalled();
    expect(f.store.recoveryCheck).toHaveBeenCalledWith(tx, {
      reason: "rpc_unavailable",
    });
  });
  it("rejects a conflicting common anchor", async () => {
    const f = fixture();
    vi.mocked(f.nodes[1]!.client.getBlock).mockResolvedValue({
      number: 98n,
      hash: keccak256(replacementRaw),
    } as never);
    await f.recovery.automatic(tx);
    expect(f.chain.send).not.toHaveBeenCalled();
    expect(f.store.recoveryCheck).toHaveBeenCalledWith(tx, {
      reason: "evidence_conflict",
    });
  });
  it("rejects a pending original, an advanced nonce, wrong chain and stale heads", async () => {
    for (const reason of [
      "transaction_present",
      "nonce_changed",
      "evidence_conflict",
      "stale",
    ] as const) {
      const f = fixture();
      const c = f.nodes[0]!.client;
      if (reason === "transaction_present")
        vi.mocked(c.request).mockResolvedValue({} as never);
      else if (reason === "nonce_changed")
        vi.mocked(c.getTransactionCount).mockResolvedValue(6);
      else if (reason === "stale")
        vi.mocked(c.getBlockNumber).mockResolvedValue(250n);
      else vi.mocked(c.getChainId).mockResolvedValue(1);
      await f.recovery.automatic(tx);
      expect(f.chain.send).not.toHaveBeenCalled();
      expect(f.store.recoveryCheck).toHaveBeenCalledWith(tx, {
        reason: reason === "stale" ? "evidence_conflict" : reason,
      });
    }
  });
  it("rechecks opt-out and budget after final validation", async () => {
    for (const condition of ["optout", "budget"] as const) {
      const f = fixture();
      let validations = 0;
      vi.mocked(f.chain.validate).mockImplementation(async () => {
        if (++validations === 2) {
          if (condition === "optout")
            vi.mocked(f.store.enabled).mockResolvedValue(false);
          else vi.mocked(f.store.spentToday).mockResolvedValue(90n);
        }
      });
      await f.recovery.automatic(tx);
      expect(f.chain.send).not.toHaveBeenCalled();
    }
  });
  it("no rights or oversized replacement costs do not create a recovery", async () => {
    const f = fixture();
    vi.mocked(f.chain.eligible).mockResolvedValue(false);
    await f.recovery.automatic(tx);
    expect(f.store.saveRecovery).not.toHaveBeenCalled();
    const g = fixture();
    vi.mocked(g.chain.prepareRecovery).mockResolvedValue({
      ...g.replacement,
      maximumCost: 101n,
    });
    await g.recovery.automatic(tx);
    expect(g.store.saveRecovery).not.toHaveBeenCalled();
  });
  it("CAS failure prevents broadcast and prepared records cannot be blindly repeated", async () => {
    const f = fixture();
    vi.mocked(f.store.startRecovery).mockResolvedValue(false);
    await f.recovery.automatic(tx);
    expect(f.chain.send).not.toHaveBeenCalled();
    await f.recovery.automatic(tx);
    expect(f.chain.send).not.toHaveBeenCalled();
  });
});
