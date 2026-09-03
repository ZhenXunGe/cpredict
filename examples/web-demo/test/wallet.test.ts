import { describe, expect, it } from "vitest";
import {
  arbitrumSepolia,
  createProtocolPublicClient,
  PROTOCOL_RPC_BATCH,
} from "../src/wallet.js";

describe("Arbitrum Sepolia chain configuration", () => {
  it("uses viem's canonical Multicall3 deployment", () => {
    expect(arbitrumSepolia.id).toBe(421_614);
    expect(arbitrumSepolia.contracts.multicall3).toEqual({
      address: "0xca11bde05977b3631167028862be2a173976ca11",
      blockCreated: 81_930,
    });
  });

  it("batches proxied RPC verification reads within a bounded window", () => {
    const client = createProtocolPublicClient({
      chain: {
        id: 421_614,
        name: "Arbitrum Sepolia",
        rpcPath: "/rpc",
        explorerOrigin: "https://sepolia.arbiscan.io",
      },
    } as Parameters<typeof createProtocolPublicClient>[0]);

    expect(PROTOCOL_RPC_BATCH).toEqual({ batchSize: 32, wait: 20 });
    expect(client.transport.timeout).toBe(15_000);
  });
});
