// Non-signing browser fixture. No private keys or executable authorizations.
import type { ConnectedWallet } from "@privy-io/react-auth";
import {
  environmentSchema,
  depositSchema,
  type AppAccount,
} from "../../../../offchain/app-core/src/contracts.js";
import { USDC_ADDRESS } from "../../../../offchain/app-core/src/usdc.js";
import { A, H, env } from "../../../../offchain/app-core/test/fixtures.js";
export const depositEnvironment = environmentSchema.parse({
  ...env,
  id: "usdc-test",
  asset: "USDC",
  label: "USDC 浏览器夹具",
  deployment: { ...env.deployment, paymentToken: USDC_ADDRESS },
  account: { ...env.account, index: "1002" },
  features: { ...env.features, faucet: false, gaslessDeposit: true },
});
export const depositDomain = {
  name: "USD Coin",
  version: "2",
  chainId: 421614,
  verifyingContract: USDC_ADDRESS,
} as const;
export function fixtureDeposit(
  account: AppAccount,
  source = A(30),
  amount = "1000000",
) {
  const now = Date.now();
  return depositSchema.parse({
    id: "40000000-0000-4000-8000-000000000001",
    environment: account.environment,
    deploymentId: account.deploymentId,
    accountId: account.id,
    account: account.address,
    domain: depositDomain,
    authorization: {
      from: source,
      to: account.address,
      value: amount,
      validAfter: "0",
      validBefore: String(Math.floor(now / 1000) + 600),
      nonce: H(300),
    },
    state: "awaiting-authorization",
    operationId: null,
    userOperationHash: null,
    transactionHash: null,
    blockNumber: null,
    blockHash: null,
    actualGasCost: null,
    finality: "pending",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 600000).toISOString(),
    reason: null,
  });
}
export const fundingState = {
  reject: false,
  disconnected: false,
  signatures: 0,
};
const listeners = new Map<string, Set<(v: unknown) => void>>();
export function disconnectFunding() {
  fundingState.disconnected = true;
  for (const callback of listeners.get("accountsChanged") ?? []) callback([]);
}
export function fixtureWallet(
  address: string,
  walletClientType: string,
): ConnectedWallet {
  return {
    address,
    walletClientType,
    switchChain: async () => {},
    getEthereumProvider: async () => ({
      on: (event: string, callback: (v: unknown) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(callback);
      },
      removeListener: (event: string, callback: (v: unknown) => void) =>
        listeners.get(event)?.delete(callback),
      request: async ({ method }: { method: string }) => {
        if (method === "eth_accounts")
          return fundingState.disconnected ? [] : [address];
        if (method === "eth_chainId") return "0x66eee";
        if (method === "eth_signTypedData_v4") {
          fundingState.signatures++;
          if (fundingState.reject)
            throw Object.assign(new Error("Fixture rejection"), { code: 4001 });
          return `0x${"11".repeat(64)}1b`; // Intentionally invalid signer; used only to advance UI to its controller boundary.
        }
        throw new Error("Fixture never sends transactions");
      },
    }),
  } as unknown as ConnectedWallet;
}
