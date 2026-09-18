import type { createSessionKernel } from "../../../offchain/app-core/src/trading-session-kernel.js";
import { z } from "zod";
import { type Hex } from "viem";
import {
  AppError,
  environmentKey,
  type Environment,
} from "../../../offchain/app-core/src/contracts.js";
import {
  tradingSessionSchema,
  type TradingSession,
} from "../../../offchain/app-core/src/trading-session-contracts.js";
import { SiteApi } from "./api.js";

export type BrowserTradingSession = {
  session: TradingSession;
  privateKey: Hex;
  enableSignature: Hex;
  assertCurrent?: () => void;
  kernel?: () => ReturnType<typeof createSessionKernel>;
};
type StoredSession = {
  id: string;
  identity: string;
  scope: string;
  environment: Environment;
  sessionId: string;
  createdAt: string;
  key: CryptoKey;
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
};
const secretSchema = z.object({
  session: tradingSessionSchema,
  privateKey: z.string().regex(/^0x[\da-f]{64}$/i),
  enableSignature: z.string().regex(/^0x(?:[\da-f]{130})?$/i),
});
const database = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("cpredict-trading-sessions", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("sessions", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new AppError("trading_session_storage_unavailable", 409));
  });
async function transaction<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction("sessions", mode),
        request = action(tx.objectStore("sessions"));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () =>
        reject(new AppError("trading_session_storage_unavailable", 409));
    });
  } finally {
    db.close();
  }
}
export const tradingSessionScope = (
  identity: string,
  api: SiteApi,
  accountId: string,
) => JSON.stringify([identity, api.key, accountId]);
export function tradingSessionEpoch(identity: string) {
  try {
    return localStorage.getItem(`cpredict-session-epoch:${identity}`) ?? "";
  } catch {
    return "";
  }
}
export function notifyTradingSessions(scope?: string) {
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel("cpredict-trading-sessions");
    channel.postMessage({ scope });
    channel.close();
  }
  window.dispatchEvent(new Event("cpredict-trading-sessions"));
}
export async function saveTradingSession(
  identity: string,
  api: SiteApi,
  value: BrowserTradingSession,
) {
  const scope = tradingSessionScope(identity, api, value.session.accountId);
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  try {
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(scope) },
      key,
      plaintext,
    );
    await transaction("readwrite", (store) =>
      store.put({
        id: value.session.id,
        identity,
        scope,
        environment: api.environment,
        sessionId: value.session.id,
        createdAt: value.session.createdAt,
        key,
        iv,
        ciphertext,
      } satisfies StoredSession),
    );
    // A successful structured clone and decrypt are required before telling the user it is saved.
    await loadTradingSession(
      identity,
      api,
      value.session.accountId,
      value.session.id,
    );
    notifyTradingSessions(scope);
  } finally {
    plaintext.fill(0);
  }
}
export async function loadTradingSession(
  identity: string,
  api: SiteApi,
  accountId: string,
  id?: string,
): Promise<BrowserTradingSession | null> {
  const scope = tradingSessionScope(identity, api, accountId);
  const rows = (await transaction("readonly", (store) =>
    store.getAll(),
  )) as StoredSession[];
  const candidates = rows
    .filter((r) => r.scope === scope && (!id || r.id === id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const row of candidates) {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: new Uint8Array(row.iv),
        additionalData: new TextEncoder().encode(scope),
      },
      row.key,
      row.ciphertext,
    );
    try {
      const parsed = secretSchema.parse(
        JSON.parse(new TextDecoder().decode(plaintext)),
      );
      if (
        parsed.session.id !== row.id ||
        parsed.session.accountId !== accountId ||
        parsed.session.environment !== api.environment.id ||
        parsed.session.deploymentId !== api.environment.deployment.id
      )
        throw new AppError("trading_session_account_changed", 409);
      const { privateKeyToAccount } = await import("./signing-keys.js");
      if (
        privateKeyToAccount(parsed.privateKey as Hex).address.toLowerCase() !==
        parsed.session.publicKey.toLowerCase()
      )
        throw new AppError("trading_session_key_invalid", 409);
      return parsed as BrowserTradingSession;
    } finally {
      new Uint8Array(plaintext).fill(0);
    }
  }
  return null;
}
export async function removeTradingSession(id: string) {
  await transaction("readwrite", (store) => store.delete(id));
  notifyTradingSessions();
}
export async function clearUserTradingSessions(identity: string, api: SiteApi) {
  try {
    localStorage.setItem(
      `cpredict-session-epoch:${identity}`,
      crypto.randomUUID(),
    );
  } catch {
    /* unavailable storage cannot hold an active credential */
  }
  notifyTradingSessions();
  let rows: StoredSession[] = [];
  try {
    rows = (
      (await transaction("readonly", (store) =>
        store.getAll(),
      )) as StoredSession[]
    ).filter((r) => r.identity === identity);
  } catch {
    /* Storage may be unavailable; still disable server records below. */
  }
  if (!rows.length && !api.environment.quickTrading) return;
  // Disable all of this user's public records in each known environment, including credentials already removed locally.
  const environments = new Map([
    [api.key, api.environment],
    ...rows.map((r) => [environmentKey(r.environment), r.environment] as const),
  ]);
  const results = await Promise.allSettled(
    [...environments.values()].map((environment) =>
      (environmentKey(environment) === api.key
        ? api
        : new SiteApi(environment, api.getToken)
      ).request(
        "/v1/trading-sessions/disable-all",
        z.object({ disabled: z.boolean() }),
        { auth: true, body: {} },
      ),
    ),
  );
  await Promise.all(rows.map((row) => removeTradingSession(row.id)));
  notifyTradingSessions();
  if (results.some((r) => r.status === "rejected"))
    throw new AppError("trading_session_logout_incomplete", 503);
}
