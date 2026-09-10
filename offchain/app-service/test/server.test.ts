import { randomUUID } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import type { PublicClient } from "viem";
import { AppError } from "../../app-core/src/contracts.js";
import {
  A,
  H,
  env,
  appAccount,
  operation,
} from "../../app-core/test/fixtures.js";
import { appRuntimeSchema } from "../src/config.js";
import { OperationService } from "../src/operations.js";
import { AuthenticatedAAGateway } from "../src/gateway.js";
import { OperationRecovery } from "../src/recovery.js";
import { createApplicationServer } from "../src/server.js";
import { MemoryApplicationStore } from "./memory-store.js";
import type { AdmissionReader } from "../../app-core/src/calls.js";
import type { ReportingStore } from "../src/reports.js";
async function setup(trusted = false) {
  const store = new MemoryApplicationStore();
  store.accountRows.set(appAccount.id, appAccount);
  store.bindings.set("did:privy:owner", new Set([appAccount.id]));
  store.records.set(operation.id, {
    operation,
    subject: "did:privy:owner",
    idempotencyKey: randomUUID(),
    requestHash: H(1),
  });
  const client = { getCode: async () => undefined } as unknown as PublicClient,
    transport = { request: vi.fn(async () => null) };
  const service = new OperationService(
    appRuntimeSchema.parse({
      environment: env,
      sponsor: null,
      allowedOrigins: ["http://127.0.0.1:4198"],
      adminSubjects: ["did:privy:admin"],
      trustedProxies: trusted ? ["127.0.0.1"] : [],
    }),
    store,
    client,
    {} as AdmissionReader,
  );
  const reports = {
    report: vi.fn(async () => {
      throw new AppError("fixture_report_reached", 503);
    }),
    telemetry: vi.fn(async () => {}),
    feedback: vi.fn(async () => {}),
    serviceEvent: vi.fn(async () => {}),
  } satisfies ReportingStore;
  const server = await createApplicationServer({
    operations: service,
    auth: {
      verify: async (token) => ({
        subject: `did:privy:${token}`,
        controllers: [
          {
            address: token === "owner" ? appAccount.controller : A(90),
            kind: "external",
          },
        ],
      }),
    },
    gateway: new AuthenticatedAAGateway(service, transport, transport),
    recovery: new OperationRecovery(store, client, transport, 2),
    chainRpc: transport,
    reports,
  });
  return { server, reports, transport };
}
describe("private application routes and public telemetry boundaries", () => {
  it("only accepts forwarded client addresses from configured proxy peers", async () => {
    for (const trusted of [false, true]) {
      const { server } = await setup(trusted);
      server.get("/fixture/ip", (request) => ({ ip: request.ip }));
      try {
        const local = await server.inject({
          url: "/fixture/ip",
          remoteAddress: "127.0.0.1",
          headers: { "x-forwarded-for": "198.51.100.8" },
        });
        expect(local.json().ip).toBe(trusted ? "198.51.100.8" : "127.0.0.1");
        const foreign = await server.inject({
          url: "/fixture/ip",
          remoteAddress: "192.0.2.1",
          headers: { "x-forwarded-for": "198.51.100.8" },
        });
        expect(foreign.json().ip).toBe("192.0.2.1");
      } finally {
        await server.close();
      }
    }
  });
  it("rejects unauthenticated and non-admin reports before any report query", async () => {
    const { server, reports } = await setup();
    try {
      expect((await server.inject("/v1/ops/reports")).statusCode).toBe(401);
      expect(
        (
          await server.inject({
            url: "/v1/ops/reports",
            headers: { authorization: "Bearer owner" },
          })
        ).statusCode,
      ).toBe(403);
      expect(reports.report).not.toHaveBeenCalled();
      expect(
        (
          await server.inject({
            url: "/v1/ops/reports?start=2026-09-08T16:00:00.000Z&end=2026-09-09T16:00:00.000Z",
            headers: { authorization: "Bearer admin" },
          })
        ).json().error.code,
      ).toBe("fixture_report_reached");
      expect(reports.report).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });
  it("requires verified control for operation history and rejects a different environment", async () => {
    const { server } = await setup();
    try {
      expect(
        (
          await server.inject({
            url: `/v1/operations/${operation.id}`,
            headers: { authorization: "Bearer stranger" },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await server.inject({
            url: `/v1/operations?accountId=${appAccount.id}`,
            headers: {
              authorization: "Bearer owner",
              "x-cpredict-environment": "usdc-test",
              "x-cpredict-deployment": env.deployment.id,
            },
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await server.inject({
            url: `/v1/operations/${operation.id}`,
            headers: { authorization: "Bearer owner" },
          })
        ).json().operation.id,
      ).toBe(operation.id);
    } finally {
      await server.close();
    }
  });
  it("accepts anonymous visits but never lets them claim login or account readiness", async () => {
    const { server, reports } = await setup();
    try {
      const payload = {
        id: randomUUID(),
        sessionId: randomUUID(),
        event: "visit",
        occurredAt: new Date().toISOString(),
      };
      expect(
        (await server.inject({ method: "POST", url: "/v1/telemetry", payload }))
          .statusCode,
      ).toBe(200);
      expect(
        (
          await server.inject({
            method: "POST",
            url: "/v1/telemetry",
            payload: {
              ...payload,
              id: randomUUID(),
              event: "account-ready",
              accountId: appAccount.id,
            },
          })
        ).statusCode,
      ).toBe(401);
      expect(reports.telemetry).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });
  it("rejects feedback containing executable signatures and arbitrary RPC writes", async () => {
    const { server, reports, transport } = await setup();
    try {
      expect(
        (
          await server.inject({
            method: "POST",
            url: "/v1/feedback",
            headers: { authorization: "Bearer owner" },
            payload: {
              id: randomUUID(),
              message: `Signature: 0x${"ab".repeat(65)}`,
            },
          })
        ).statusCode,
      ).toBe(400);
      expect(reports.feedback).not.toHaveBeenCalled();
      const reply = await server.inject({
        method: "POST",
        url: "/v1/rpc",
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "eth_sendRawTransaction",
          params: ["0x1234"],
        },
      });
      expect(reply.statusCode).toBeGreaterThanOrEqual(400);
      expect(transport.request).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
