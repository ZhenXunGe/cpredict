import { type Address, type Log, type PublicClient } from "viem";
import { deriveMutations } from "./derived.js";
import { normalizeLog } from "./store.js";
import type { ProtocolVersion } from "../../sdk/src/legacy-protocol.js";

/** A range RPC may expose Factory logs before the new vault's logs. Never commit a partial creation. */
export async function completeMarketCreationLogs(
  client: PublicClient,
  logs: readonly Log[],
  factory: Address,
  chainId: number,
  protocol: ProtocolVersion = "time-v2",
): Promise<readonly Log[]> {
  const result = [...logs];
  const creations = logs.filter(
    (log) =>
      log.address.toLowerCase() === factory.toLowerCase() &&
      deriveMutations(normalizeLog(chainId, log, "confirmed"), protocol).some(
        (m) => m.kind === "market-created",
      ),
  );
  for (const creation of creations) {
    const mutation = deriveMutations(
      normalizeLog(chainId, creation, "confirmed"),
      protocol,
    ).find((m) => m.kind === "market-created");
    if (mutation?.kind !== "market-created") continue;
    const market = mutation.market.toLowerCase();
    const complete = () => {
      const kinds = new Set(
        result
          .filter(
            (log) =>
              log.address.toLowerCase() === market &&
              log.transactionHash === creation.transactionHash &&
              log.blockHash === creation.blockHash &&
              log.blockNumber === creation.blockNumber,
          )
          .flatMap((log) =>
            deriveMutations(normalizeLog(chainId, log, "confirmed"), protocol),
          )
          .filter((m) => "market" in m && m.market.toLowerCase() === market)
          .map((m) => m.kind),
      );
      return kinds.has("market-initialized") && kinds.has("market-metadata");
    };
    if (complete()) continue;
    const receipt = await client.getTransactionReceipt({
      hash: creation.transactionHash!,
    });
    if (
      receipt.status !== "success" ||
      receipt.transactionHash !== creation.transactionHash ||
      receipt.blockHash !== creation.blockHash ||
      receipt.blockNumber !== creation.blockNumber ||
      !receipt.logs.some(
        (log) =>
          log.address.toLowerCase() === factory.toLowerCase() &&
          log.logIndex === creation.logIndex &&
          log.data === creation.data &&
          JSON.stringify(log.topics) === JSON.stringify(creation.topics),
      )
    )
      throw new Error("creation receipt does not match discovered event");
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== market) continue;
      if (
        log.removed ||
        log.blockHash !== receipt.blockHash ||
        log.blockNumber !== receipt.blockNumber ||
        log.transactionHash !== receipt.transactionHash
      )
        throw new Error("creation receipt contains inconsistent vault logs");
      result.push(log);
    }
    if (!complete())
      throw new Error("creation receipt is missing initialization or metadata");
  }
  return result;
}
