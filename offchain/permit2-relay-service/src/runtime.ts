import type { Permit2RelayServiceConfig } from "./config.js";
import { PostgresPermit2RelayIntentStore } from "./postgres-intent-store.js";
import { ViemPermit2RelayChain } from "./policy.js";
import { createPermit2RelayServer } from "./server.js";
import type { Permit2RelaySender } from "./types.js";

export interface Permit2RelayRuntimeAdapterModule {
  createPermit2RelaySender(
    config: Permit2RelayServiceConfig,
  ): Promise<Permit2RelaySender>;
}

function isAdapterModule(
  value: unknown,
): value is Permit2RelayRuntimeAdapterModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "createPermit2RelaySender" in value &&
    typeof value.createPermit2RelaySender === "function"
  );
}

export async function loadPermit2RelaySender(
  moduleUrl: string,
  config: Permit2RelayServiceConfig,
): Promise<Permit2RelaySender> {
  const loaded: unknown = await import(moduleUrl);
  if (!isAdapterModule(loaded)) {
    throw new TypeError("relay adapter module has no supported factory");
  }
  return loaded.createPermit2RelaySender(config);
}

export async function createPermit2RelayRuntime(
  config: Permit2RelayServiceConfig,
  sender: Permit2RelaySender,
) {
  const chain = new ViemPermit2RelayChain(config);
  const intentStore = new PostgresPermit2RelayIntentStore(config.databaseUrl);
  return createPermit2RelayServer({
    chain,
    sender,
    intentStore,
    config,
  });
}
