import { getAddress, type PublicClient, type Transport } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { Permit2RelayBuyInput } from "../../sdk/src/permit2-relay.js";
import type { Permit2RelayServiceConfig } from "../src/config.js";
import { ViemPermit2RelayChain } from "../src/policy.js";
import { Permit2RelayPolicyDeniedError } from "../src/types.js";

const FACTORY = getAddress("0x1111111111111111111111111111111111111111");
const TOKEN = getAddress("0x2222222222222222222222222222222222222222");
const PERMIT2 = getAddress("0x3333333333333333333333333333333333333333");
const VAULT = getAddress("0x4444444444444444444444444444444444444444");
const OWNER = getAddress("0x5555555555555555555555555555555555555555");
const SENDER = getAddress("0x6666666666666666666666666666666666666666");

const config: Permit2RelayServiceConfig = {
  host: "127.0.0.1",
  containerMode: false,
  port: 8792,
  logLevel: "silent",
  adapterModule: "file:///tmp/relay-adapter.mjs",
  databaseUrl: "postgresql://user:password@127.0.0.1/cpredict",
  rpcUrl: "https://rpc.example.invalid",
  chainId: 421_614,
  factory: FACTORY,
  paymentToken: TOKEN,
  permit2: PERMIT2,
  expectedSender: SENDER,
  maxDeadlineSeconds: 900,
  maxGas: 370_000n,
  maxTransactionFee: 10_000_000_000_000_000n,
};

function input(): Permit2RelayBuyInput {
  const deadline = BigInt(Math.floor(Date.now() / 1_000) + 300);
  return {
    chainId: 421_614n,
    factory: FACTORY,
    permit2: PERMIT2,
    vault: VAULT,
    owner: OWNER,
    outcomeId: 1n,
    desiredUnits: 2_000_000n,
    minimumUnits: 2_000_000n,
    maximumPayment: 2_000_000n,
    deadline,
    permit: {
      permitted: { token: TOKEN, amount: 2_000_000n },
      nonce: 7n,
      deadline,
    },
    signature: `0x${"77".repeat(65)}`,
  };
}

function client(overrides: {
  registered?: boolean;
  gas?: bigint;
  permit2Enabled?: boolean;
} = {}) {
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === "isMarket") return overrides.registered ?? true;
    if (functionName === "factory") return FACTORY;
    if (functionName === "paymentToken") return TOKEN;
    if (functionName === "permit2") return PERMIT2;
    if (functionName === "permit2Enabled") return overrides.permit2Enabled ?? true;
    throw new Error("unexpected read");
  });
  const value = {
    getChainId: vi.fn(async () => 421_614),
    readContract,
    call: vi.fn(async () => ({ data: "0x" })),
    estimateGas: vi.fn(async () => overrides.gas ?? 250_000n),
    estimateFeesPerGas: vi.fn(async () => ({
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 10_000_000n,
    })),
  };
  return value as unknown as PublicClient<Transport>;
}

describe("Permit2 relay on-chain policy", () => {
  it("accepts only a registered, correctly wired vault and returns bounded fees", async () => {
    const chain = new ViemPermit2RelayChain(config, client());
    await expect(chain.ready()).resolves.toBeUndefined();
    await expect(chain.prepare(input(), SENDER)).resolves.toMatchObject({
      chainId: 421_614,
      to: VAULT,
      gas: 300_000n,
    });
  });

  it("rejects broader Permit2 spend and untrusted vault wiring", async () => {
    const chain = new ViemPermit2RelayChain(config, client());
    const broader = input();
    broader.permit.permitted.amount += 1n;
    await expect(chain.prepare(broader, SENDER)).rejects.toBeInstanceOf(
      Permit2RelayPolicyDeniedError,
    );
    await expect(
      new ViemPermit2RelayChain(config, client({ registered: false })).prepare(
        input(),
        SENDER,
      ),
    ).rejects.toBeInstanceOf(Permit2RelayPolicyDeniedError);
  });

  it("rejects gas estimates above the reviewed transaction ceiling", async () => {
    await expect(
      new ViemPermit2RelayChain(config, client({ gas: 370_000n })).prepare(
        input(),
        SENDER,
      ),
    ).rejects.toBeInstanceOf(Permit2RelayPolicyDeniedError);
  });
});
