import { createHash, randomUUID } from "node:crypto";
import { getAddress, parseAbi, type Address, type PublicClient } from "viem";
import { z } from "zod";
import {
  AppError,
  address,
  type Environment,
} from "../../app-core/src/contracts.js";
import {
  ledgerFactSchema,
  snapshotSchema,
  type LedgerFact,
} from "../../app-core/src/ledger-contracts.js";
import { financialOrder } from "../../app-core/src/pnl.js";
import type { PostgresFinancialLedger } from "./financial-store.js";

type Check = {
  contract: Address;
  signature: string;
  args: (Address | bigint)[];
  expected: string;
  comparison: "equal" | "at-least";
};
/** Independent conservation projection: physical balances and unpaid liabilities, not PnL. */
export function reconciliationChecks(
  env: Environment,
  facts: readonly LedgerFact[],
  accounts: readonly Address[],
) {
  const values = new Map<
    string,
    {
      contract: Address;
      signature: string;
      args: (Address | bigint)[];
      value: bigint;
    }
  >();
  const key = (
    contract: Address,
    signature: string,
    args: readonly (Address | bigint)[],
  ) => [contract.toLowerCase(), signature, ...args.map(String)].join(":");
  const add = (
    contract: Address,
    signature: string,
    args: (Address | bigint)[],
    delta: bigint,
    set = false,
  ) => {
    const k = key(contract, signature, args),
      old = values.get(k);
    values.set(k, {
      contract,
      signature,
      args,
      value: (set ? 0n : (old?.value ?? 0n)) + delta,
    });
  };
  const get = (
    contract: Address,
    signature: string,
    args: (Address | bigint)[] = [],
  ) => values.get(key(contract, signature, args))?.value ?? 0n;
  const scalar = (market: Address, name: string, delta: bigint, set = false) =>
    add(market, `function ${name}() view returns(uint256)`, [], delta, set);
  const shares = (
    market: Address,
    owner: Address | null,
    outcome: string,
    delta: bigint,
  ) => {
    if (owner)
      add(
        market,
        "function balanceOf(address,uint256) view returns(uint256)",
        [owner, BigInt(outcome)],
        delta,
      );
  };
  const supply = (market: Address, outcome: string, delta: bigint) =>
    add(
      market,
      "function totalSupply(uint256) view returns(uint256)",
      [BigInt(outcome)],
      delta,
    );
  const early = (market: Address, owner: Address, delta: bigint, set = false) =>
    add(
      market,
      "function earlyBirdScore(address) view returns(uint256)",
      [owner],
      delta,
      set,
    );
  const credit = (contract: Address, owner: Address, delta: bigint) => {
    add(
      contract,
      "function creditOf(address) view returns(uint256)",
      [owner],
      delta,
    );
    scalar(contract, "totalCredits", delta);
  };
  const bonds = new Map<
      string,
      { creator: Address; amount: bigint; settled: boolean }
    >(),
    markets = new Set<Address>(),
    tracked = new Set(accounts.map((a) => a.toLowerCase()));
  const number = (f: LedgerFact, name: string) => {
    const v = f.extra[name];
    if (typeof v !== "string" || !/^\d+$/.test(v))
      throw new AppError("reconciliation_fact_incomplete", 409);
    return BigInt(v);
  };
  for (const a of accounts)
    add(
      env.deployment.paymentToken,
      "function balanceOf(address) view returns(uint256)",
      [a],
      0n,
    );
  for (const contract of [env.deployment.feeVault, env.deployment.bondEscrow])
    scalar(contract, "totalCredits", 0n);
  scalar(env.deployment.bondEscrow, "totalLocked", 0n);
  for (const f of [...facts].sort(financialOrder)) {
    if (f.kind === "coverage-gap")
      throw new AppError("reconciliation_coverage_gap", 409);
    const m = f.market,
      o = f.owner,
      u = BigInt(f.units ?? "0"),
      a = BigInt(f.amount ?? "0");
    if (m) markets.add(m);
    if (f.kind === "market-initialized" && m) {
      for (const n of [
        "totalPrincipal",
        "remainingWinnerPool",
        "remainingEarlyBirdPool",
        "remainingEarlyBirdScore",
        "remainingRefundPrincipal",
        "remainingTimeoutBonusPool",
        "remainingTimeoutBonusUnits",
      ])
        scalar(m, n, 0n);
      scalar(m, "marketState", 0n);
      const count = Number(f.extra.outcomeCount);
      if (!Number.isInteger(count) || count < 2 || count > 32)
        throw new AppError("reconciliation_fact_incomplete");
      for (let i = 0; i < count; i++) supply(m, String(i), 0n);
    }
    if (f.kind === "primary-buy" && m && o && f.outcomeId !== null) {
      shares(m, o, f.outcomeId, u);
      supply(m, f.outcomeId, u);
      scalar(m, "totalPrincipal", a);
      add(
        m,
        "function principalByOutcome(uint256) view returns(uint256)",
        [BigInt(f.outcomeId)],
        a,
      );
      const score = number(f, "score");
      early(m, o, score);
      scalar(m, "totalEarlyBirdScore", score);
    }
    if (f.kind === "share-transfer" && m && f.outcomeId !== null) {
      shares(m, o, f.outcomeId, -u);
      shares(m, f.counterparty, f.outcomeId, u);
      if (!o) supply(m, f.outcomeId, u);
      if (!f.counterparty) supply(m, f.outcomeId, -u);
    }
    if (f.kind === "listing-created" && m && o && f.outcomeId !== null) {
      shares(m, o, f.outcomeId, -u);
      shares(m, env.deployment.marketplace, f.outcomeId, u);
    }
    if (
      ["listing-filled", "listing-cancelled", "listing-returned"].includes(
        f.kind,
      ) &&
      m &&
      o &&
      f.outcomeId !== null
    ) {
      shares(m, env.deployment.marketplace, f.outcomeId, -u);
      shares(m, o, f.outcomeId, u);
    }
    if (
      ["winner-claimed", "refunded", "losing-burned"].includes(f.kind) &&
      m &&
      o
    ) {
      const parts = z
        .array(
          z.object({
            outcomeId: z.string().regex(/^\d+$/),
            units: z.string().regex(/^\d+$/),
          }),
        )
        .parse(f.extra.consumed);
      for (const p of parts) {
        shares(m, o, p.outcomeId, -BigInt(p.units));
        supply(m, p.outcomeId, -BigInt(p.units));
      }
      if (f.kind === "winner-claimed") scalar(m, "remainingWinnerPool", -a);
      if (f.kind === "refunded") {
        scalar(m, "remainingRefundPrincipal", -a);
        if (f.extra.timeoutEligibilityRecorded === true)
          add(
            m,
            "function timeoutBonusUnits(address) view returns(uint256)",
            [o],
            u,
          );
      }
    }
    if (f.kind === "market-resolved" && m) {
      scalar(m, "marketState", 1n, true);
      scalar(m, "remainingWinnerPool", number(f, "winnerPool"), true);
      scalar(m, "remainingEarlyBirdPool", number(f, "earlyBirdPool"), true);
      scalar(
        m,
        "remainingEarlyBirdScore",
        get(m, "function totalEarlyBirdScore() view returns(uint256)"),
        true,
      );
    }
    if (f.kind === "market-voided" && m) {
      scalar(m, "marketState", 2n, true);
      scalar(m, "remainingRefundPrincipal", number(f, "refundPrincipal"), true);
    }
    if (f.kind === "early-bird-claimed" && m && o) {
      early(m, o, 0n, true);
      scalar(m, "remainingEarlyBirdPool", -a);
      scalar(m, "remainingEarlyBirdScore", -number(f, "score"));
    }
    if (f.kind === "timeout-funded" && m) {
      scalar(m, "remainingTimeoutBonusPool", a, true);
      scalar(m, "remainingTimeoutBonusUnits", number(f, "eligibleUnits"), true);
    }
    if (f.kind === "timeout-claimed" && m && o) {
      scalar(m, "remainingTimeoutBonusPool", -a);
      scalar(m, "remainingTimeoutBonusUnits", -u);
      add(
        m,
        "function timeoutBonusUnits(address) view returns(uint256)",
        [o],
        0n,
        true,
      );
    }
    if (f.kind === "fee-accrued" && o) credit(env.deployment.feeVault, o, a);
    if (f.kind === "fee-claimed" && o) credit(env.deployment.feeVault, o, -a);
    if (f.kind === "bond-locked" && m && o) {
      bonds.set(m.toLowerCase(), { creator: o, amount: a, settled: false });
      scalar(env.deployment.bondEscrow, "totalLocked", a);
    }
    if (["bond-credited", "bond-timeout-funded"].includes(f.kind) && m) {
      const bond = bonds.get(m.toLowerCase());
      if (!bond || bond.settled)
        throw new AppError("reconciliation_bond_history_missing", 409);
      bond.settled = true;
      scalar(env.deployment.bondEscrow, "totalLocked", -bond.amount);
      if (f.kind === "bond-credited")
        credit(env.deployment.bondEscrow, bond.creator, a);
    }
    if (f.kind === "bond-claimed" && o)
      credit(env.deployment.bondEscrow, o, -a);
    if (f.kind === "payment-transfer") {
      if (o && tracked.has(o.toLowerCase()))
        add(
          env.deployment.paymentToken,
          "function balanceOf(address) view returns(uint256)",
          [o],
          -a,
        );
      if (f.counterparty && tracked.has(f.counterparty.toLowerCase()))
        add(
          env.deployment.paymentToken,
          "function balanceOf(address) view returns(uint256)",
          [f.counterparty],
          a,
        );
    }
  }
  const checks: Check[] = [...values.values()].map((v) => ({
    ...v,
    expected: v.value.toString(),
    comparison: "equal",
  }));
  for (const m of markets) {
    const state = get(m, "function marketState() view returns(uint256)"),
      liability =
        state === 0n
          ? get(m, "function totalPrincipal() view returns(uint256)")
          : state === 1n
            ? get(m, "function remainingWinnerPool() view returns(uint256)") +
              get(m, "function remainingEarlyBirdPool() view returns(uint256)")
            : get(
                m,
                "function remainingRefundPrincipal() view returns(uint256)",
              ) +
              get(
                m,
                "function remainingTimeoutBonusPool() view returns(uint256)",
              );
    checks.push({
      contract: env.deployment.paymentToken,
      signature: "function balanceOf(address) view returns(uint256)",
      args: [m],
      expected: liability.toString(),
      comparison: "at-least",
    });
  }
  for (const c of [env.deployment.feeVault, env.deployment.bondEscrow])
    checks.push({
      contract: env.deployment.paymentToken,
      signature: "function balanceOf(address) view returns(uint256)",
      args: [c],
      expected: (
        get(c, "function totalCredits() view returns(uint256)") +
        get(c, "function totalLocked() view returns(uint256)")
      ).toString(),
      comparison: "at-least",
    });
  if (checks.length > 20000)
    throw new AppError("reconciliation_capacity_exceeded", 503);
  return checks;
}

export async function reconcileLedger(
  ledger: PostgresFinancialLedger,
  client: PublicClient,
  codeDigest: string,
) {
  const frozen = await ledger.sql.begin(
    "isolation level repeatable read read only",
    async (db) => {
      const snapshot = await ledger.snapshot(db);
      if (!snapshot.complete)
        throw new AppError("history_coverage_incomplete", 409);
      const rows = await db<
        { address: Address; through_block: string | null }[]
      >`SELECT a.address,t.through_block FROM app_accounts a LEFT JOIN ledger_tracked_accounts t ON t.address=lower(a.address)`;
      if (
        rows.some(
          (r) =>
            r.through_block === null ||
            BigInt(r.through_block) < BigInt(snapshot.blockNumber),
        )
      )
        throw new AppError("account_backfill_pending", 409);
      const facts = (
        await db<
          { fact: unknown }[]
        >`SELECT fact FROM ledger_facts WHERE block_number<=${snapshot.blockNumber} ORDER BY block_number,transaction_index,log_index,fact_index LIMIT 200001`
      ).map((r) => ledgerFactSchema.parse(r.fact));
      if (facts.length > 200000)
        throw new AppError("reconciliation_capacity_exceeded", 503);
      return {
        snapshot,
        facts,
        accounts: rows.map((r) => getAddress(r.address)),
      };
    },
  );
  const checks = reconciliationChecks(
      ledger.environment,
      frozen.facts,
      frozen.accounts,
    ),
    results = [];
  for (let offset = 0; offset < checks.length; offset += 4) {
    results.push(
      ...(await Promise.all(
        checks.slice(offset, offset + 4).map(async (check) => {
          try {
            const abi = parseAbi([check.signature]),
              method = check.signature.match(/^function (\w+)\(/)![1]!,
              actual = BigInt(
                String(
                  await client.readContract({
                    address: check.contract,
                    abi,
                    functionName: method,
                    args: check.args,
                    blockNumber: BigInt(frozen.snapshot.blockNumber),
                  }),
                ),
              );
            return {
              ...check,
              args: check.args.map(String),
              actual: actual.toString(),
              passed:
                BigInt(check.expected) >= 0n &&
                (check.comparison === "equal"
                  ? actual === BigInt(check.expected)
                  : actual >= BigInt(check.expected)),
              error: null,
            };
          } catch {
            return {
              ...check,
              args: check.args.map(String),
              actual: null,
              passed: false,
              error: "chain_read_unavailable",
            };
          }
        }),
      )),
    );
  }
  await ledger.assertSnapshot(frozen.snapshot);
  if (
    (
      await client.getBlock({
        blockNumber: BigInt(frozen.snapshot.blockNumber),
      })
    ).hash.toLowerCase() !== frozen.snapshot.blockHash.toLowerCase()
  )
    throw new AppError("snapshot_invalidated", 409);
  const report = {
    id: randomUUID(),
    snapshot: frozen.snapshot,
    codeDigest,
    createdAt: new Date().toISOString(),
    factCount: frozen.facts.length,
    accountCount: frozen.accounts.length,
    passed: results.every((r) => r.passed),
    results,
  };
  await ledger.sql`INSERT INTO ledger_reconciliations(id,report,passed,epoch,block_number,block_hash,code_digest) VALUES(${report.id},${ledger.sql.json(report)},${report.passed},${report.snapshot.epoch},${report.snapshot.blockNumber},${report.snapshot.blockHash},${codeDigest})`;
  return report;
}
export async function activateLedger(
  ledger: PostgresFinancialLedger,
  id: string,
  codeDigest: string,
) {
  await ledger.sql.begin(async (db) => {
    await db`SELECT * FROM ledger_environment WHERE singleton FOR UPDATE`;
    const row = (
      await db<
        { report: unknown; passed: boolean; code_digest: string }[]
      >`SELECT report,passed,code_digest FROM ledger_reconciliations WHERE id=${z.string().uuid().parse(id)}`
    )[0];
    if (!row?.passed || row.code_digest !== codeDigest)
      throw new AppError("reconciliation_required", 409);
    const report = z.object({ snapshot: snapshotSchema }).parse(row.report),
      current = await ledger.snapshot(db);
    if (
      current.epoch !== report.snapshot.epoch ||
      current.blockHash !== report.snapshot.blockHash
    )
      throw new AppError("reconciliation_snapshot_changed", 409);
    await ledger.assertSnapshot(report.snapshot, db);
    await db`UPDATE ledger_environment SET status='active' WHERE singleton`;
    await db`UPDATE ledger_reconciliations SET activated_at=now() WHERE id=${id}`;
  });
}
export const digestCode = (sources: readonly string[]) =>
  createHash("sha256").update(sources.join("\n")).digest("hex");
