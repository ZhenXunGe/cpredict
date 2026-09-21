import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { getAddress } from "viem";
import { appRuntimeSchema } from "../../app-service/src/config.js";
import { parseIndexerServiceConfig } from "./config.js";
import { createIndexerClient } from "./rpc-client.js";
import { PostgresEventStore } from "./postgres-store.js";
import { normalizeLog } from "./store.js";
import { deriveMutations } from "./derived.js";
import { completeMarketCreationLogs } from "./creation-logs.js";
import { refreshPublicMetadata } from "./public-catalog.js";

/** Explicit operator tool: dry-run by default, same private runtime environment as the indexer. */
export async function repairCreation(args: readonly string[]): Promise<void> {
  const [target, ...flags] = args;
  const apply = flags[0] === "--apply";
  const backupPath = apply ? flags[1] : undefined;
  if (
    !target ||
    (flags.length > 0 && (!apply || flags.length !== 2 || !backupPath))
  )
    throw new Error("usage: repair-creation MARKET [--apply BACKUP_FILE]");
  const market = getAddress(target);
  const config = parseIndexerServiceConfig(process.env);
  if (!config.publicConfigFile || !config.metadataUrl)
    throw new Error("public indexer configuration is required");
  const { environment } = appRuntimeSchema.parse(
    JSON.parse(await readFile(config.publicConfigFile, "utf8")),
  );
  const client = await createIndexerClient(config);
  if (
    config.chainId !== environment.deployment.chainId ||
    config.factoryAddress.toLowerCase() !==
      environment.deployment.factory.toLowerCase() ||
    (await client.getChainId()) !== config.chainId
  )
    throw new Error("repair runtime does not match the deployment");
  const store = new PostgresEventStore(config.databaseUrl, 1, environment);
  try {
    await store.ready();
    const before = await store.market(config.chainId, market);
    if (
      !before ||
      before.rulesHash !== null ||
      before.outcomeCount !== null ||
      before.updatedBlock !== before.createdBlock ||
      before.state !== 0
    )
      throw new Error("market is not an untouched incomplete creation");
    const sql = store.financial!.sql;
    const registration = await sql<{ transaction_hash: `0x${string}` }[]>`
      SELECT transaction_hash FROM registered_markets WHERE chain_id=${config.chainId} AND market=${market}`;
    const hash = registration[0]?.transaction_hash;
    if (!hash) throw new Error("market registration is missing");
    const receipt = await client.getTransactionReceipt({ hash });
    const stored = await store.canonicalBlock(
      config.chainId,
      before.createdBlock,
    );
    const live = await client.getBlock({ blockNumber: before.createdBlock });
    if (
      live.hash === null ||
      live.hash !== receipt.blockHash ||
      receipt.blockNumber !== before.createdBlock ||
      receipt.status !== "success"
    )
      throw new Error("creation receipt does not match canonical history");
    if (stored !== undefined && stored.blockHash !== live.hash)
      throw new Error("creation receipt does not match canonical history");
    const block = stored ?? {
      chainId: config.chainId,
      blockNumber: live.number,
      blockHash: live.hash,
      parentHash: live.parentHash,
      timestamp: live.timestamp,
      confirmationStatus: "confirmed" as const,
    };
    const creation = receipt.logs.find(
      (log) =>
        log.address.toLowerCase() === config.factoryAddress.toLowerCase() &&
        deriveMutations(
          normalizeLog(config.chainId, log, block.confirmationStatus),
          before.protocolVersion,
        ).some(
          (mutation) =>
            mutation.kind === "market-created" && mutation.market === market,
        ),
    );
    if (!creation) throw new Error("Factory creation event is missing");
    const completed = await completeMarketCreationLogs(
      client,
      [creation],
      config.factoryAddress,
      config.chainId,
      before.protocolVersion,
    );
    const events = completed
      .filter((log) => log.address.toLowerCase() === market.toLowerCase())
      .map((log) => normalizeLog(config.chainId, log, block.confirmationStatus))
      .sort((a, b) => a.logIndex - b.logIndex);
    const raw =
      await sql`SELECT * FROM chain_events WHERE chain_id=${config.chainId} AND transaction_hash=${hash} ORDER BY log_index`;
    const existing = await sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM chain_events WHERE chain_id=${config.chainId} AND contract_address=${market}`;
    if (existing[0]?.n !== 0)
      throw new Error(
        "target already has vault events; broader replay review required",
      );
    const checkpoint = await store.checkpoint(config.chainId);
    const json = (value: unknown) =>
      JSON.stringify(
        value,
        (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
        2,
      );
    if (apply && backupPath) {
      await writeFile(
        backupPath,
        json({ market, before, checkpoint, raw, receipt }),
        { flag: "wx", mode: 0o600 },
      );
      await store.repairMarketCreation(market, events, block);
      await refreshPublicMetadata(store.financial!, config.metadataUrl);
      const after = await store.market(config.chainId, market);
      if (
        !after?.rulesHash ||
        after.outcomeCount === null ||
        after.closeAt === null
      )
        throw new Error("repair verification failed");
      console.log(
        json({
          status: "repaired",
          market,
          outcomeCount: after.outcomeCount,
          rulesHash: after.rulesHash,
        }),
      );
    } else {
      console.log(
        json({
          status: "dry-run",
          market,
          creationBlock: block.blockNumber,
          missingVaultLogs: events.length,
          databaseChanged: false,
        }),
      );
    }
  } finally {
    await store.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  repairCreation(process.argv.slice(2)).catch(() => {
    // Provider and database errors may contain credentials; never print them.
    console.error(
      "Creation repair failed; verify arguments, runtime configuration, canonical history and market scope. If apply was requested, inspect the backup and database before retrying.",
    );
    process.exitCode = 1;
  });
}
