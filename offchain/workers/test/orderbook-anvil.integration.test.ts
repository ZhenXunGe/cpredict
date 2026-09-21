import { test, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import postgres from "postgres";
import {
  createPublicClient,
  createWalletClient,
  http,
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
import { env, H } from "../../app-core/test/fixtures.js";
import { marketFactoryAbi, marketVaultAbi } from "../../sdk/src/abis.js";
import { orderbookAbi } from "../../sdk/src/orderbook.js";
import { PostgresEventStore } from "../../indexer/src/postgres-store.js";
import { normalizeLog, type CanonicalBlock } from "../../indexer/src/store.js";
import { PostgresAutomaticStore } from "../src/automatic-store.js";
import { ViemAutomationChain } from "../src/automatic-chain.js";
import { AutomaticClaimsWorker } from "../src/automatic-claims.js";
import { LedgerAutomaticSource } from "../src/automatic-source.js";
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
    const url = `http://127.0.0.1:${port}`,
      client = createPublicClient({
        chain: arbitrumSepolia,
        transport: http(url, { retryCount: 0 }),
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
        ])
          await migration.unsafe(
            await readFile(`offchain/indexer/migrations/${n}.sql`, "utf8"),
          );
        for (const name of [
          "007_order_automation.sql",
          "008_automation_status_scope.sql",
          "009_automation_canonical_audit.sql",
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
      const matching = new AutomaticClaimsWorker(
        matcherStore,
        new ViemAutomationChain(client, wallet(matcher), matcher, 1n),
        new MatchingSource(sql, client, environment),
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
      let worker = new AutomaticClaimsWorker(store, chain, source, 10n ** 18n);
      for (const a of [governor, alice, bob])
        await store.setEnabled(a.address, false);
      await rpc("evm_setNextBlockTimestamp", [Number(now + 87000n)]);
      await rpc("evm_mine");
      await index();
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
      await worker.tick();
      expect(await store.pending()).toHaveLength(1);
      worker = new AutomaticClaimsWorker(store, chain, source, 10n ** 18n); // process restart with the same durable journal
      for (const a of [governor, alice])
        await store.setEnabled(a.address, true);
      for (let i = 0; i < 24; i++) {
        await rpc("evm_mine");
        await index();
        await matching.tick();
        await worker.tick();
      }
      await rpc("evm_mine");
      await index();
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
