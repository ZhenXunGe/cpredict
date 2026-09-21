import postgres from "postgres";
import type { Address } from "viem";
import { PostgresAutomaticStore } from "../../workers/src/automatic-store.js";
export interface AutomaticClaimsSettings {
  enabled(owner: Address): Promise<boolean>;
  setEnabled(owner: Address, enabled: boolean): Promise<void>;
  publicStatus(owner: Address): Promise<unknown>;
}
export function automaticClaimsSettings(
  url: string,
  chainId: number,
  deploymentId: string,
) {
  const sql = postgres(url, {
    max: 2,
    connect_timeout: 5,
    onnotice: () => undefined,
  });
  // Settings never use the transaction sender methods or a signing key.
  const store = new PostgresAutomaticStore(
    sql,
    chainId,
    deploymentId,
    "0x0000000000000000000000000000000000000000",
  );
  return { store, close: () => sql.end({ timeout: 5 }) };
}
