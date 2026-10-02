import { test, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import postgres from "postgres";
import {
  createPublicClient,
  createWalletClient,
  http,
  custom,
  decodeEventLog,
  maxUint256,
  zeroAddress,
  parseAbi,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { env, H, A } from "../../app-core/test/fixtures.js";
import { marketFactoryAbi, marketVaultAbi } from "../../sdk/src/abis.js";
import { orderbookAbi } from "../../sdk/src/orderbook.js";
import { PostgresEventStore } from "../../indexer/src/postgres-store.js";
import { normalizeLog, type CanonicalBlock } from "../../indexer/src/store.js";
import { PostgresAutomaticStore } from "../src/automatic-store.js";
import { ViemAutomationChain } from "../src/automatic-chain.js";
import { AutomaticClaimsWorker } from "../src/automatic-claims.js";
import { LedgerAutomaticSource } from "../src/automatic-source.js";
import { PostgresClaimQueue } from "../src/automatic-queue.js";
import { AutomaticClaimDiscovery } from "../src/automatic-discovery.js";
import { MatchingSource } from "../src/matching-source.js";

// Owned loopback chain and disposable PostgreSQL schema only. No public RPC or real wallet.
test.skipIf(
  !process.env.TEST_DATABASE_URL || process.env.CPREDICT_TEST_ANVIL !== "1",
)(
  "isolated signed V2 lifecycle: deploy, escrow, match, timeout, historical claims and restart",
  async () => {
    const port = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const a = s.address();
        s.close(() => resolve(typeof a === "object" && a ? a.port : 0));
      });
    });
    const processNode: ChildProcess = spawn(
      ".tools/foundry/bin/anvil",
      [
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--chain-id",
        "421614",
        "--silent",
      ],
      { stdio: "ignore" },
    );
    let contractReads = 0;
    const url = `http://127.0.0.1:${port}`;
    const transport = http(url, { retryCount: 0 })({ chain: arbitrumSepolia });
    const client = createPublicClient({
      chain: arbitrumSepolia,
      transport: custom(
        {
          request: async (input) => {
            if (input.method === "eth_call") contractReads++;
            return transport.request(input as never);
          },
        },
        { retryCount: 0 },
      ),
      cacheTime: 0,
      pollingInterval: 20,
    });
    const accounts = Array.from({ length: 5 }, () =>
      privateKeyToAccount(generatePrivateKey()),
    );
    const [governor, alice, bob, keeper, matcher] = accounts as [
      (typeof accounts)[number],
      (typeof accounts)[number],
      (typeof accounts)[number],
      (typeof accounts)[number],
      (typeof accounts)[number],
    ];
    const wallet = (a: typeof governor) =>
      createWalletClient({
        account: a,
        chain: arbitrumSepolia,
        transport: http(url, { retryCount: 0 }),
        cacheTime: 0,
      });
    let admin: ReturnType<typeof postgres> | undefined,
      sql: ReturnType<typeof postgres> | undefined,
      eventStore: PostgresEventStore | undefined;
    const schema = `v2_chain_${process.pid}_${Date.now()}`;
    const artifact = async (name: string) =>
      JSON.parse(await readFile(`out/${name}.sol/${name}.json`, "utf8")) as {
        abi: Abi;
        bytecode: { object: Hex };
      };
    const deployed: Record<string, Address> = {};
    async function deploy(name: string, args: readonly unknown[] = []) {
      const a = await artifact(name);
      const h = await wallet(governor).deployContract({
        abi: a.abi,
        bytecode: a.bytecode.object,
        args,
        gas: 28000000n,
      });
      const r = await client.waitForTransactionReceipt({ hash: h });
      expect(r.status).toBe("success");
      expect(r.contractAddress).toBeTruthy();
      deployed[name] = r.contractAddress!;
      return r.contractAddress!;
    }
    async function send(
      address: Address,
      abi: Abi,
      functionName: string,
      args: readonly unknown[] = [],
      who = governor,
    ) {
      const hash = await wallet(who).writeContract({
        address,
        abi,
        functionName,
        args,
        gas: 8000000n,
      });
      const r = await client.waitForTransactionReceipt({ hash });
      expect(r.status, `${functionName} failed`).toBe("success");
      return r;
    }
    async function method(
      name: string,
      fn: string,
      args: readonly unknown[] = [],
    ) {
      return send(deployed[name]!, (await artifact(name)).abi, fn, args);
    }
    const rpc = (method: string, params: unknown[] = []) =>
      client.request({ method, params } as never);
    try {
      let ready = false;
      for (let n = 0; n < 50; n++) {
        try {
          await client.getChainId();
          ready = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      expect(ready).toBe(true);
      for (const a of accounts)
        await rpc("anvil_setBalance", [a.address, toHex(100n * 10n ** 18n)]);
      const token = await deploy("MockUSDC");
      const config = await deploy("ProtocolConfigV1", [
        governor.address,
        token,
        governor.address,
      ]);
      const emergency = await deploy("EmergencyControllerV1", [
        governor.address,
        governor.address,
      ]);
      const guard = await deploy("LaunchExposureGuardV1", [
        governor.address,
        50000000000n,
      ]);
      const fee = await deploy("FeeVaultV1", [governor.address, token]),
        bond = await deploy("BondEscrowV1", [governor.address, token]);
      const clone = await deploy("CloneMarketVaultV1"),
        full = await deploy("FullMarketDeployerV1", [governor.address]);
      const factory = await deploy("MarketFactoryV1", [
        governor.address,
        config,
        emergency,
        guard,
        bond,
        fee,
        full,
        clone,
        86400n,
        zeroAddress,
      ]);
      const book = await deploy("OrderbookMarketplaceV2", [
        factory,
        emergency,
        fee,
        token,
        zeroAddress,
      ]);
      await deploy("TradingSessionPolicyV2", [
        factory,
        book,
        token,
        bond,
        fee,
        governor.address,
      ]);
      for (const n of [
        "LaunchExposureGuardV1",
        "FeeVaultV1",
        "BondEscrowV1",
        "FullMarketDeployerV1",
      ])
        await method(n, "setFactory", [factory]);
      await method("MarketFactoryV1", "setMarketplace", [book]);
      const fingerprint = await client.readContract({
        address: factory,
        abi: (await artifact("MarketFactoryV1")).abi,
        functionName: "dependencyFingerprint",
      });
      await method("MarketFactoryV1", "activate", [fingerprint]);
      for (const a of [governor, alice, bob]) {
        await method("MockUSDC", "mint", [a.address, 1000000000n]);
        await send(
          token,
          (await artifact("MockUSDC")).abi,
          "approve",
          [factory, maxUint256],
          a,
        );
        await send(
          token,
          (await artifact("MockUSDC")).abi,
          "approve",
          [book, maxUint256],
          a,
        );
      }
      expect(
        await client.readContract({
          address: book,
          abi: orderbookAbi,
          functionName: "defaultAllowPartialFills",
        }),
      ).toBe(false);
      expect(
        await client.readContract({
          address: book,
          abi: orderbookAbi,
          functionName: "fillPolicyVersion",
        }),
      ).toBe(1n);
      // Legacy lifecycle below deliberately exercises allowed partial fills;
      // whole-order signed execution is covered separately by quantity groups.
      const now = (await client.getBlock()).timestamp;
      const created = await send(factory, marketFactoryAbi, "createMarket", [
        {
          rulesHash: H(11),
          metadataURI: "https://example.invalid/isolated.json",
          resolutionSourceHash: H(12),
          resolutionSourceURI: "https://example.invalid/source",
          outcomeCount: 2,
          closeAt: now + 600n,
          eventStartsAt: 0n,
          outcomeDeadlineAt: now + 600n,
          creatorTreasury: governor.address,
          deploymentMode: 0,
          featureFlags: 1n,
          creatorRakeBps: 500,
          creatorC2CFeeBps: 100,
          perUserPrimaryCap: 100000000n,
          marketPrimaryCap: 100000000n,
          minimumPrimaryUnits: 10000n,
          minimumC2CUnits: 10000n,
          creatorBond: 10000000n,
        },
        H(100),
      ]);
      const market = created.logs.flatMap((log) => {
        try {
          const e = decodeEventLog({
            abi: marketFactoryAbi,
            data: log.data,
            topics: log.topics,
          });
          return e.eventName === "MarketCreated" ? [e.args.market] : [];
        } catch {
          return [];
        }
      })[0]!;
      expect(market).toBeTruthy();
      await send(
        token,
        (await artifact("MockUSDC")).abi,
        "approve",
        [market, maxUint256],
        alice,
      );
      await send(
        market,
        marketVaultAbi,
        "buy",
        [0n, 10000000n, 10000000n, 10000000n, now + 600n],
        alice,
      );
      await send(
        market,
        parseAbi(["function setApprovalForAll(address,bool)"]),
        "setApprovalForAll",
        [book, true],
        alice,
      );
      const wholeSnapshot = await rpc("evm_snapshot");
      await send(
        book,
        orderbookAbi,
        "createOrder",
        [market, 0, 1, 4000000n, 750000n, now + 200000n, true],
        alice,
      );
      await send(
        book,
        orderbookAbi,
        "createOrder",
        [market, 0, 0, 2000000n, 1000000n, now + 200000n, true],
        bob,
      );
      await send(
        book,
        orderbookAbi,
        "matchOrdersForUnits",
        [market, 0, 4000000n, 1n],
        matcher,
      );
      expect(
        (
          await client.readContract({
            address: book,
            abi: orderbookAbi,
            functionName: "orders",
            args: [1n],
          })
        )[2],
      ).toBe(4000000n);
      await expect(
        send(
          book,
          orderbookAbi,
          "fillOrder",
          [1n, 2000000n, 2000000n, 4000000n, now + 60n],
          bob,
        ),
      ).rejects.toThrow();
      await send(
        book,
        orderbookAbi,
        "createOrder",
        [market, 0, 0, 4000000n, 1000000n, now + 200000n, true],
        bob,
      );
      await send(
        book,
        orderbookAbi,
        "matchOrdersForUnits",
        [market, 0, 4000000n, 1n],
        matcher,
      );
      expect(
        await client.readContract({
          address: market,
          abi: parseAbi([
            "function balanceOf(address,uint256) view returns(uint256)",
          ]),
          functionName: "balanceOf",
          args: [bob.address, 0n],
        }),
      ).toBe(4000000n);
      expect(
        await client.readContract({
          address: book,
          abi: orderbookAbi,
          functionName: "bestOrderForUnits",
          args: [market, 0, 0, 2000000n],
        }),
      ).toBe(2n);
      await rpc("evm_revert", [wholeSnapshot]);
      await send(book, orderbookAbi, "setDefaultAllowPartialFills", [true]);
      await send(
        book,
        orderbookAbi,
        "createOrder",
        [market, 0, 1, 4000000n, 750000n, now + 200000n, true],
        alice,
      );
      await send(
        book,
        orderbookAbi,
        "createOrder",
        [market, 0, 0, 6000000n, 1000000n, now + 200000n, true],
        bob,
      );
      admin = postgres(process.env.TEST_DATABASE_URL!, {
        max: 1,
        onnotice: () => {},
      });
      await admin.unsafe(`CREATE SCHEMA ${schema}`);
      const dbUrl = new URL(process.env.TEST_DATABASE_URL!);
      dbUrl.searchParams.set("options", `-csearch_path=${schema}`);
      sql = postgres(dbUrl.toString(), { max: 6, onnotice: () => {} });
      const migration = await sql.reserve();
      try {
        for (const n of [
          "001_indexer",
          "002_settlement_evidence",
          "003_read_api_indexes",
          "004_market_metadata",
          "005_activity_catalog",
          "006_financial_facts",
          "007_legacy_deployment",
          "008_orderbook",
          "009_sparse_canonical_ranges",
          "011_ledger_fact_revision",
          "012_claim_discovery_indexes",
        ])
          await migration.unsafe(
            await readFile(`offchain/indexer/migrations/${n}.sql`, "utf8"),
          );
        for (const name of [
          "007_order_automation.sql",
          "008_automation_status_scope.sql",
          "009_automation_canonical_audit.sql",
          "010_automation_cleanup_quotas.sql",
          "011_automation_operations.sql",
          "012_automation_claim_queue.sql",
          "013_actual_automation_gas.sql",
        ])
          await migration.unsafe(
            await readFile(`offchain/app-service/migrations/${name}`, "utf8"),
          );
      } finally {
        migration.release();
      }
      const environment = {
        ...env,
        features: { ...env.features, automaticClaims: true },
        deployment: {
          ...env.deployment,
          marketplaceVersion: "orderbook-v2" as const,
          orderbookFillPolicyVersion: 1 as const,
          protocolVersion: "time-v2" as const,
          factory,
          marketplace: book,
          bondEscrow: bond,
          feeVault: fee,
          paymentToken: token,
          protocolTreasury: governor.address,
          deploymentBlock: "1",
        },
      };
      eventStore = new PostgresEventStore(dbUrl.toString(), 1, environment);
      await eventStore.ready();
      let through = 0n;
      async function index() {
        const latest = await client.getBlockNumber();
        for (let n = through + 1n; n <= latest; n++) {
          const b = await client.getBlock({ blockNumber: n });
          const logs = await client.getLogs({ fromBlock: n, toBlock: n });
          const header: CanonicalBlock = {
            chainId: 421614,
            blockNumber: n,
            blockHash: b.hash,
            parentHash: b.parentHash,
            timestamp: b.timestamp,
            confirmationStatus: "confirmed",
          };
          await eventStore!.applyBatch(
            logs.map((l) => normalizeLog(421614, l, "confirmed")),
            [header],
            header,
          );
          through = n;
        }
      }
      await index();
      const matcherStore = new PostgresAutomaticStore(
        sql,
        421614,
        environment.deployment.id,
        matcher.address,
        "matching",
      );
      let matchingClockMs = 0;
      const matching = new AutomaticClaimsWorker(
        matcherStore,
        new ViemAutomationChain(client, wallet(matcher), matcher, 1n),
        new MatchingSource(sql, client, environment, () => matchingClockMs),
        10n ** 18n,
      );
      await matching.tick();
      await rpc("evm_mine");
      await index();
      await matching.tick();
      await index();
      const bid = await client.readContract({
        address: book,
        abi: orderbookAbi,
        functionName: "orders",
        args: [2n],
      });
      expect(bid[2]).toBe(2000000n);
      expect(bid[9]).toBe(2000000n);
      expect(
        await client.readContract({
          address: market,
          abi: parseAbi([
            "function balanceOf(address,uint256) view returns(uint256)",
          ]),
          functionName: "balanceOf",
          args: [bob.address, 0n],
        }),
      ).toBe(4000000n);
      const store = new PostgresAutomaticStore(
        sql,
        421614,
        environment.deployment.id,
        keeper.address,
        "claims",
        () => {},
        true,
      );
      const source = new LedgerAutomaticSource(
          eventStore.financial!,
          client,
          store,
        ),
        chain = new ViemAutomationChain(
          client,
          wallet(keeper),
          keeper,
          1n,
          (action) => source.stillEligible(action),
        );
      const queue = new PostgresClaimQueue(
        sql,
        421614,
        environment.deployment.id,
      );
      const discovery = new AutomaticClaimDiscovery(
        queue,
        eventStore.financial!,
        source,
      );
      let worker = new AutomaticClaimsWorker(store, chain, queue, 10n ** 18n);
      for (const a of [governor, alice, bob])
        await store.setEnabled(a.address, false);
      await rpc("evm_setNextBlockTimestamp", [Number(now + 87000n)]);
      await rpc("evm_mine");
      await index();
      await discovery.tick();
      await worker.tick();
      expect(await store.pending()).toHaveLength(0);
      expect(
        await client.readContract({
          address: market,
          abi: marketVaultAbi,
          functionName: "marketState",
        }),
      ).toBe(0);
      await store.setEnabled(bob.address, true);
      await discovery.tick();
      await worker.tick();
      expect(await store.pending()).toHaveLength(1);
      worker = new AutomaticClaimsWorker(store, chain, queue, 10n ** 18n); // process restart with the same durable journal
      for (const a of [governor, alice])
        await store.setEnabled(a.address, true);
      // Terminal market state does not emit an orderbook event. Advance the
      // maintenance clock so the matcher rescans outstanding escrowed orders.
      matchingClockMs += 30000;
      for (let i = 0; i < 24; i++) {
        await rpc("evm_mine");
        await index();
        await matching.tick();
        await discovery.tick();
        await worker.tick();
      }
      await rpc("evm_mine");
      await index();
      await discovery.tick();
      await worker.tick();
      expect(
        await client.readContract({
          address: market,
          abi: marketVaultAbi,
          functionName: "marketState",
        }),
      ).toBe(2);
      expect(
        await client.readContract({
          address: book,
          abi: orderbookAbi,
          functionName: "totalLockedPayment",
        }),
      ).toBe(0n);
      for (const a of [alice, bob])
        expect(
          await client.readContract({
            address: market,
            abi: parseAbi([
              "function balanceOf(address,uint256) view returns(uint256)",
            ]),
            functionName: "balanceOf",
            args: [a.address, 0n],
          }),
        ).toBe(0n);
      const tokenAbi = (await artifact("MockUSDC")).abi;
      expect(
        await client.readContract({
          address: token,
          abi: tokenAbi,
          functionName: "balanceOf",
          args: [alice.address],
        }),
      ).toBe(1004970000n);
      expect(
        await client.readContract({
          address: token,
          abi: tokenAbi,
          functionName: "balanceOf",
          args: [bob.address],
        }),
      ).toBe(1005000000n);
      await mkdir("reports/generated/orderbook", { recursive: true });
      // Actual signed batches on an owned, automining Anvil. Historical rows are
      // synthetic database fixtures; payout balances and receipts are real contracts.
      const performanceBatches: {
        markets: number;
        owners: number;
        round: number;
        seconds: number;
        reads: number;
        transactions: number;
      }[] = [];
      for (const [marketCount, ownerCount, rounds] of [
        [38, 53, 20],
        [200, 500, 20],
        [0, 0, 1],
      ]) {
        if (marketCount === 0)
          await method("ProtocolConfigV1", "setProtocolTreasury", [
            matcher.address,
          ]);
        const recipients =
          marketCount === 0
            ? [governor, alice, bob, matcher]
            : [governor, alice, bob];
        const expectedTransactions = marketCount === 0 ? 8 : 7;
        await sql`DELETE FROM ledger_facts WHERE log_index=999`;
        const snapshot = await eventStore.financial!.snapshot();
        for (let i = 0; i < ownerCount!; i++) {
          const historicalOwner = A(10000 + i),
            historicalMarket = A(20000 + (i % marketCount!));
          const fact = {
            id: `perf:${i}`,
            kind: "primary-buy",
            blockNumber: snapshot.blockNumber,
            blockHash: snapshot.blockHash,
            transactionHash: H(10000 + i),
            transactionIndex: 0,
            logIndex: 999,
            factIndex: 0,
            timestamp: snapshot.timestamp,
            market: historicalMarket,
            owner: historicalOwner,
            counterparty: null,
            outcomeId: "0",
            listingId: null,
            units: "10",
            amount: "10",
            extra: { score: "1" },
          };
          await sql`INSERT INTO ledger_facts(chain_id,block_number,transaction_hash,transaction_index,log_index,fact_index,occurred_at,kind,market,owner,fact) VALUES(421614,${snapshot.blockNumber},${H(10000 + i)},0,999,0,${snapshot.timestamp},'primary-buy',${historicalMarket.toLowerCase()},${historicalOwner.toLowerCase()},${sql.json(fact)})`;
        }
        await queue.progress(snapshot, "1");
        await sql`UPDATE automation_discovery SET cursor_block=${snapshot.blockNumber},cursor_hash=${snapshot.blockHash},backstop_due=now()+interval '1 day'`;
        await sql`UPDATE automation_claim_scopes SET due_at=NULL`;
        for (let round = 0; round < rounds!; round++) {
          const ts = (await client.getBlock()).timestamp,
            close = ts + 600n;
          const r = await send(factory, marketFactoryAbi, "createMarket", [
            {
              rulesHash: H(11),
              metadataURI: "https://example.invalid/perf.json",
              resolutionSourceHash: H(12),
              resolutionSourceURI: "https://example.invalid/source",
              outcomeCount: 2,
              closeAt: close,
              eventStartsAt: 0n,
              outcomeDeadlineAt: close,
              creatorTreasury: governor.address,
              deploymentMode: 0,
              featureFlags: 1n,
              creatorRakeBps: 500,
              creatorC2CFeeBps: 100,
              perUserPrimaryCap: 100000000n,
              marketPrimaryCap: 100000000n,
              minimumPrimaryUnits: 10000n,
              minimumC2CUnits: 10000n,
              creatorBond: 10000000n,
            },
            H(20000 + marketCount! * 100 + round),
          ]);
          const target = r.logs.flatMap((log) => {
            try {
              const e = decodeEventLog({
                abi: marketFactoryAbi,
                data: log.data,
                topics: log.topics,
              });
              return e.eventName === "MarketCreated" ? [e.args.market] : [];
            } catch {
              return [];
            }
          })[0]!;
          for (const participant of [alice, bob]) {
            await send(
              token,
              tokenAbi,
              "approve",
              [target, maxUint256],
              participant,
            );
            await send(
              target,
              marketVaultAbi,
              "buy",
              [0n, 10000000n, 10000000n, 10000000n, close],
              participant,
            );
          }
          await index();
          await queue.progress(await eventStore.financial!.snapshot(), "1");
          // Seed only this new event range, not the database-only unrelated history.
          await sql`UPDATE automation_discovery SET cursor_block=${through.toString()},cursor_hash=${(await client.getBlock({ blockNumber: through })).hash}`;
          const before = (await Promise.all(
            recipients.map((a) =>
              client.readContract({
                address: token,
                abi: tokenAbi,
                functionName: "balanceOf",
                args: [a.address],
              }),
            ),
          )) as bigint[];
          await rpc("evm_setNextBlockTimestamp", [Number(close + 1n)]);
          const started = performance.now(),
            readsBefore = contractReads;
          await send(target, marketVaultAbi, "resolve", [0n, H(30)], governor);
          await index();
          const [initial] =
            await sql`SELECT count(*)::int AS n FROM automation_transactions WHERE signer=${keeper.address.toLowerCase()}`;
          let complete = false;
          for (let step = 0; step < 30; step++) {
            await discovery.tick();
            await worker.tick();
            await rpc("evm_mine");
            await index();
            const [n] =
              await sql`SELECT count(*)::int AS n FROM automation_transactions WHERE signer=${keeper.address.toLowerCase()} AND state='confirmed'`;
            if (
              n!.n >= initial!.n + expectedTransactions &&
              (await store.pending()).length === 0
            ) {
              complete = true;
              break;
            }
          }
          const seconds = (performance.now() - started) / 1000;
          expect(complete).toBe(true);
          expect(seconds).toBeLessThanOrEqual(30);
          const [count] =
            await sql`SELECT count(*)::int AS n FROM automation_transactions WHERE signer=${keeper.address.toLowerCase()}`;
          expect(count!.n - initial!.n).toBe(expectedTransactions);
          const after = (await Promise.all(
            recipients.map((a) =>
              client.readContract({
                address: token,
                abi: tokenAbi,
                functionName: "balanceOf",
                args: [a.address],
              }),
            ),
          )) as bigint[];
          expect(
            after.reduce((sum, value, i) => sum + value - before[i]!, 0n),
          ).toBe(30000000n);
          if (marketCount === 0)
            expect(after[3]! - before[3]!).toBeGreaterThan(0n);
          for (const a of [alice, bob])
            expect(
              await client.readContract({
                address: target,
                abi: parseAbi([
                  "function balanceOf(address,uint256) view returns(uint256)",
                ]),
                functionName: "balanceOf",
                args: [a.address, 0n],
              }),
            ).toBe(0n);
          performanceBatches.push({
            markets: marketCount!,
            owners: ownerCount!,
            round,
            seconds,
            reads: contractReads - readsBefore,
            transactions: expectedTransactions,
          });
        }
      }
      const small = performanceBatches.filter((b) => b.markets === 38),
        large = performanceBatches.filter((b) => b.markets === 200);
      expect(Math.max(...large.map((b) => b.reads))).toBeLessThanOrEqual(
        Math.max(...small.map((b) => b.reads)) * 1.5,
      );
      await writeFile(
        "reports/generated/orderbook/claims-performance.json",
        JSON.stringify(
          {
            scope:
              "owned-automining-anvil-real-postgres-synthetic-unrelated-history",
            polling:
              "explicit integration ticks; scheduler timing verified separately",
            batches: performanceBatches.filter((b) => b.markets > 0),
            distinctProtocolBeneficiary: performanceBatches.find(
              (b) => b.markets === 0,
            ),
          },
          null,
          2,
        ),
      );
      const txs =
        await sql`SELECT kind,state,tx_hash,nonce,signer FROM automation_transactions ORDER BY created_at`;
      expect(
        txs.some((t) => t.kind === "refund" && t.state === "confirmed"),
      ).toBe(true);
      expect(
        txs.some((t) => t.kind === "timeout-bonus" && t.state === "confirmed"),
      ).toBe(true);
      expect(txs.some((t) => t.state === "reverted")).toBe(false);
      expect(new Set(txs.map((t) => `${t.signer}:${t.nonce}`)).size).toBe(
        txs.length,
      );
      await mkdir("reports/generated/orderbook", { recursive: true });
      await writeFile(
        "reports/generated/orderbook/anvil-lifecycle.json",
        JSON.stringify(
          {
            scope: "isolated-loopback-anvil-no-public-deployment",
            chainId: 421614,
            contracts: { ...deployed, market },
            transactions: txs,
            through: through.toString(),
          },
          null,
          2,
        ),
      );
    } finally {
      await eventStore?.close();
      await sql?.end();
      if (admin) {
        await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      }
      processNode.kill("SIGTERM");
      await new Promise<void>((resolve) =>
        processNode.exitCode !== null
          ? resolve()
          : processNode.once("exit", () => resolve()),
      );
    }
  },
  120000,
);
