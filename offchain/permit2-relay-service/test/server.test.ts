import type { FastifyInstance } from "fastify";
import { getAddress, type Address, type Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { permit2RelayIntentId } from "../../sdk/src/permit2-relay.js";
import { createPermit2RelayServer } from "../src/server.js";
import type {
  Permit2RelayChain,
  Permit2RelayIntentStore,
  Permit2RelaySender,
  RelayIntentReservation,
  RelayTransactionRequest,
} from "../src/types.js";

const SENDER = getAddress("0x1111111111111111111111111111111111111111");
const FACTORY = getAddress("0x2222222222222222222222222222222222222222");
const PERMIT2 = getAddress("0x3333333333333333333333333333333333333333");
const VAULT = getAddress("0x4444444444444444444444444444444444444444");
const OWNER = getAddress("0x5555555555555555555555555555555555555555");
const TOKEN = getAddress("0x6666666666666666666666666666666666666666");
const TRANSACTION_HASH = `0x${"77".repeat(32)}` as Hex;
const REQUEST: RelayTransactionRequest = {
  chainId: 421_614,
  to: VAULT,
  data: "0x1234",
  gas: 300_000n,
  maxFeePerGas: 1_000_000n,
  maxPriorityFeePerGas: 100_000n,
};

class TestChain implements Permit2RelayChain {
  readyFailure = false;
  prepares = 0;

  async ready(): Promise<void> {
    if (this.readyFailure) throw new Error("chain unavailable");
  }

  async prepare(): Promise<RelayTransactionRequest> {
    this.prepares += 1;
    return REQUEST;
  }
}

class TestSender implements Permit2RelaySender {
  readyFailure = false;
  sendFailure = false;
  sends = 0;

  async ready(): Promise<void> {
    if (this.readyFailure) throw new Error("KMS unavailable");
  }

  async address(): Promise<Address> {
    return SENDER;
  }

  async sendTransaction(request: RelayTransactionRequest): Promise<Hex> {
    expect(request).toEqual(REQUEST);
    this.sends += 1;
    if (this.sendFailure) throw new Error("provider outcome hidden");
    return TRANSACTION_HASH;
  }
}

class TestIntentStore implements Permit2RelayIntentStore {
  readyFailure = false;
  state: "empty" | "pending" | "submitted" = "empty";
  hash: Hex | null = null;
  commits = 0;

  async ready(): Promise<void> {
    if (this.readyFailure) throw new Error("database unavailable");
  }

  async reserve(): Promise<RelayIntentReservation> {
    if (this.state === "pending") return { kind: "pending" };
    if (this.state === "submitted" && this.hash !== null) {
      return { kind: "submitted", hash: this.hash };
    }
    this.state = "pending";
    return {
      kind: "acquired",
      markSubmitted: async (hash) => {
        this.commits += 1;
        this.state = "submitted";
        this.hash = hash;
      },
    };
  }

  async find(): Promise<
    { state: "pending" } | { state: "submitted"; hash: Hex } | null
  > {
    if (this.state === "empty") return null;
    if (this.state === "pending") return { state: "pending" };
    if (this.hash === null) throw new Error("missing hash");
    return { state: "submitted", hash: this.hash };
  }
}

function requestBody() {
  const deadline = BigInt(Math.floor(Date.now() / 1_000) + 300);
  return {
    chainId: "421614",
    factory: FACTORY,
    permit2: PERMIT2,
    vault: VAULT,
    owner: OWNER,
    outcomeId: "1",
    desiredUnits: "2000000",
    minimumUnits: "2000000",
    maximumPayment: "2000000",
    deadline: deadline.toString(),
    permit: {
      permitted: { token: TOKEN, amount: "2000000" },
      nonce: "7",
      deadline: deadline.toString(),
    },
    signature: `0x${"88".repeat(65)}` as Hex,
  };
}

describe("Permit2 relay service", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function setup() {
    const chain = new TestChain();
    const sender = new TestSender();
    const intentStore = new TestIntentStore();
    const app = await createPermit2RelayServer({
      chain,
      sender,
      intentStore,
      config: { expectedSender: SENDER, logLevel: "silent" },
    });
    apps.push(app);
    return { app, chain, sender, intentStore };
  }

  it("separates liveness from dependency readiness", async () => {
    const { app, intentStore } = await setup();
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    intentStore.readyFailure = true;
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(503);
  });

  it("submits once and returns the same hash for an idempotent replay", async () => {
    const { app, chain, sender, intentStore } = await setup();
    const body = requestBody();
    const first = await app.inject({ method: "POST", url: "/v1/permit2-buys", payload: body });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({
      intentId: permit2RelayIntentId({
        ...body,
        chainId: 421_614n,
        outcomeId: 1n,
        desiredUnits: 2_000_000n,
        minimumUnits: 2_000_000n,
        maximumPayment: 2_000_000n,
        deadline: BigInt(body.deadline),
        permit: {
          ...body.permit,
          permitted: { ...body.permit.permitted, amount: 2_000_000n },
          nonce: 7n,
          deadline: BigInt(body.permit.deadline),
        },
      }),
      transactionHash: TRANSACTION_HASH,
      idempotent: false,
    });
    const second = await app.inject({ method: "POST", url: "/v1/permit2-buys", payload: body });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toMatchObject({
      transactionHash: TRANSACTION_HASH,
      idempotent: true,
    });
    expect(sender.sends).toBe(1);
    expect(chain.prepares).toBe(1);
    expect(intentStore.commits).toBe(1);
  });

  it("retains a pending reservation when submission outcome is unknown", async () => {
    const { app, sender, intentStore } = await setup();
    sender.sendFailure = true;
    const first = await app.inject({ method: "POST", url: "/v1/permit2-buys", payload: requestBody() });
    expect(first.statusCode).toBe(503);
    expect(first.body).toBe('{"error":"relay outcome unknown"}');
    expect(intentStore.state).toBe("pending");
    const second = await app.inject({ method: "POST", url: "/v1/permit2-buys", payload: requestBody() });
    expect(second.statusCode).toBe(409);
    expect(sender.sends).toBe(1);
  });

  it("rejects malformed numeric fields before chain access", async () => {
    const { app, chain } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/v1/permit2-buys",
      payload: { ...requestBody(), maximumPayment: "2e6" },
    });
    expect(response.statusCode).toBe(400);
    expect(chain.prepares).toBe(0);
  });
});
