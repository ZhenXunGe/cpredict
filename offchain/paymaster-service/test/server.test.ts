import { afterEach, describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import type { FastifyInstance } from "fastify";
import { CREATE_LISTING_SELECTOR, SponsorPolicy } from "../src/policy.js";
import { createSponsorServer } from "../src/server.js";
import type {
  SponsorAccountAdapter,
  SponsorAuthorizer,
  SponsorBudgetLease,
  SponsorBudgetRequest,
  SponsorBudgetStore,
  SponsorSigner,
} from "../src/types.js";

const SIGNER = getAddress("0x3333333333333333333333333333333333333333");
const SENDER = getAddress("0x4444444444444444444444444444444444444444");
const TARGET = getAddress("0x5555555555555555555555555555555555555555");
const SELECTOR = CREATE_LISTING_SELECTOR;
const CREATE_LISTING_CALL_DATA = encodeFunctionData({
  abi: [
    {
      type: "function",
      name: "createListing",
      stateMutability: "nonpayable",
      inputs: [
        { name: "vault", type: "address" },
        { name: "outcomeId", type: "uint256" },
        { name: "amount", type: "uint256" },
        { name: "unitPrice", type: "uint256" },
        { name: "expiresAt", type: "uint64" },
      ],
      outputs: [{ name: "listingId", type: "bytes32" }],
    },
  ],
  functionName: "createListing",
  args: [TARGET, 0n, 1_000_000n, 1_000_000n, 1_900_000_000n],
});

class TestSigner implements SponsorSigner {
  fail = false;
  readyFailure = false;

  async ready(): Promise<void> {
    if (this.readyFailure) throw new Error("not ready");
  }

  async address(): Promise<Address> {
    return SIGNER;
  }

  async signDigest(): Promise<Hex> {
    if (this.fail) throw new Error("provider secret details must not escape");
    return `0x${"11".repeat(65)}`;
  }
}

class TestAuthorizer implements SponsorAuthorizer {
  async ready(): Promise<void> {}

  async authorize(header: string | undefined) {
    return header === "Bearer valid" ? { subject: "test-user" } : null;
  }
}

class TestLease implements SponsorBudgetLease {
  committed = false;
  released = false;

  constructor(private readonly commitFailure: boolean) {}

  async commit(): Promise<void> {
    if (this.commitFailure)
      throw new Error("budget store internal details must not escape");
    this.committed = true;
  }

  async release(): Promise<void> {
    this.released = true;
  }
}

class TestBudgetStore implements SponsorBudgetStore {
  readyFailure = false;
  commitFailure = false;
  requests: SponsorBudgetRequest[] = [];
  leases: TestLease[] = [];

  async ready(): Promise<void> {
    if (this.readyFailure) throw new Error("not ready");
  }

  async reserve(request: SponsorBudgetRequest): Promise<SponsorBudgetLease> {
    this.requests.push(request);
    const lease = new TestLease(this.commitFailure);
    this.leases.push(lease);
    return lease;
  }
}

function requestBody() {
  return {
    chainId: 421_614,
    userOperation: {
      sender: SENDER,
      nonce: "1",
      initCode: "0x",
      callData: SELECTOR,
      accountGasLimits: `0x${"00".repeat(32)}`,
      preVerificationGas: "100000",
      gasFees: `0x${"00".repeat(32)}`,
      signature: "0x1234",
    },
    requestedMaxCost: "5000",
  };
}

describe("paymaster service endpoints", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function setup() {
    const signer = new TestSigner();
    const authorizer = new TestAuthorizer();
    const budgetStore = new TestBudgetStore();
    const accountAdapter: SponsorAccountAdapter = {
      ready: async () => undefined,
      decode: async () => [
        { target: TARGET, value: 0n, data: CREATE_LISTING_CALL_DATA },
      ],
    };
    const policy = new SponsorPolicy({
      decoder: accountAdapter,
      allowedTargets: new Map([
        [TARGET, new Map([[SELECTOR, "createListing" as const]])],
      ]),
      maxCostPerRequest: 10_000n,
      maxInitCodeBytes: 1_024,
      maxCallDataBytes: 16_384,
      minSponsoredListingUnits: 1_000_000n,
    });
    const app = await createSponsorServer({
      policy,
      signer,
      authorizer,
      budgetStore,
      config: {
        chainId: 421_614,
        entryPoint: getAddress("0x1111111111111111111111111111111111111111"),
        paymaster: getAddress("0x2222222222222222222222222222222222222222"),
        verificationGasLimit: 150_000n,
        postOpGasLimit: 100_000n,
        validitySeconds: 300,
        policyVersion: 7,
      },
      expectedSigner: SIGNER,
      budgetLimits: {
        maxCostPerUserDay: 20_000n,
        maxCostGlobalDay: 50_000n,
        createListingPerUserDay: 20,
        cancelListingPerUserDay: 40,
      },
      logLevel: "silent",
    });
    apps.push(app);
    return { app, signer, budgetStore };
  }

  it("separates liveness from dependency readiness", async () => {
    const { app, budgetStore } = await setup();
    expect(
      (await app.inject({ method: "GET", url: "/healthz" })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/readyz" })).statusCode,
    ).toBe(200);
    budgetStore.readyFailure = true;
    expect(
      (await app.inject({ method: "GET", url: "/readyz" })).statusCode,
    ).toBe(503);
  });

  it("requires auth and commits a durable budget reservation before returning a signature", async () => {
    const { app, budgetStore } = await setup();
    const unauthorized = await app.inject({
      method: "POST",
      url: "/v1/sponsorship",
      payload: requestBody(),
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(budgetStore.requests).toHaveLength(0);

    const issued = await app.inject({
      method: "POST",
      url: "/v1/sponsorship",
      headers: { authorization: "Bearer valid" },
      payload: requestBody(),
    });
    expect(issued.statusCode).toBe(200);
    expect(issued.json<{ paymasterAndData: Hex }>().paymasterAndData).toMatch(
      /^0x[0-9a-f]+$/,
    );
    expect(budgetStore.requests).toHaveLength(1);
    expect(budgetStore.requests[0]?.subject).toBe("test-user");
    expect(budgetStore.requests[0]?.operationCounts).toEqual({
      createListing: 1,
      cancelListing: 0,
    });
    expect(budgetStore.requests[0]?.limits).toEqual({
      maxCostPerUserDay: 20_000n,
      maxCostGlobalDay: 50_000n,
      createListingPerUserDay: 20,
      cancelListingPerUserDay: 40,
    });
    expect(budgetStore.requests[0]?.policyDay).toBe(
      Math.floor(Date.now() / 1_000 / 86_400),
    );
    expect(budgetStore.leases[0]?.committed).toBe(true);
    expect(budgetStore.leases[0]?.released).toBe(false);
  });

  it("releases a reservation when signing fails without exposing provider errors", async () => {
    const { app, signer, budgetStore } = await setup();
    signer.fail = true;
    const response = await app.inject({
      method: "POST",
      url: "/v1/sponsorship",
      headers: { authorization: "Bearer valid" },
      payload: requestBody(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).toBe('{"error":"sponsorship unavailable"}');
    expect(response.body).not.toContain("provider secret");
    expect(budgetStore.leases[0]?.released).toBe(true);
  });

  it("retains a reservation when durable commit becomes uncertain after signing", async () => {
    const { app, budgetStore } = await setup();
    budgetStore.commitFailure = true;
    const response = await app.inject({
      method: "POST",
      url: "/v1/sponsorship",
      headers: { authorization: "Bearer valid" },
      payload: requestBody(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).toBe('{"error":"sponsorship unavailable"}');
    expect(response.body).not.toContain("budget store internal");
    expect(budgetStore.leases[0]?.committed).toBe(false);
    expect(budgetStore.leases[0]?.released).toBe(false);
  });
});
