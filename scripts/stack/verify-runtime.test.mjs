import assert from "node:assert/strict";
import test from "node:test";
import {
  parseComposePs,
  verifyComposeState,
  verifyHostConfig,
  verifyHttpRuntime,
} from "./verify-runtime.mjs";

function row(Service, overrides = {}) {
  return {
    Service,
    ID: `${Service}-id`,
    State: "running",
    Health: "healthy",
    ExitCode: 0,
    Publishers: [],
    ...overrides,
  };
}

test("runtime verifier accepts healthy services, completed migration and loopback publishing", () => {
  const rows = [
    row("postgres"),
    row("bootstrap-databases", { State: "exited", Health: "", ExitCode: 0 }),
    row("migrate-indexer", { State: "exited", Health: "", ExitCode: 0 }),
    row("migrate-metadata", { State: "exited", Health: "", ExitCode: 0 }),
    row("indexer", { Publishers: [{ URL: "127.0.0.1", PublishedPort: 8787 }] }),
    row("metadata", { Publishers: [{ URL: "127.0.0.1", PublishedPort: 8793 }] }),
    row("web-demo", {
      Publishers: [{ URL: "127.0.0.1", PublishedPort: 4177 }],
    }),
  ];
  const checks = verifyComposeState(rows);
  assert.equal(
    checks.some((check) => check.status === "FAIL"),
    false,
  );
  assert.equal(
    parseComposePs(rows.map((value) => JSON.stringify(value)).join("\n"))
      .length,
    7,
  );
  assert.equal(parseComposePs(JSON.stringify(rows)).length, 7);
});

test("runtime verifier fails on wildcard publishing, unhealthy services or skipped migration", () => {
  const checks = verifyComposeState([
    row("postgres", { Health: "unhealthy" }),
    row("bootstrap-databases", { State: "exited", Health: "", ExitCode: 1 }),
    row("migrate-indexer", { State: "exited", Health: "", ExitCode: 1 }),
    row("migrate-metadata", { State: "exited", Health: "", ExitCode: 1 }),
    row("indexer", { Publishers: [{ URL: "0.0.0.0", PublishedPort: 8787 }] }),
    row("metadata", { Health: "unhealthy", Publishers: [{ URL: "0.0.0.0", PublishedPort: 8793 }] }),
    row("web-demo", {
      Publishers: [{ URL: "127.0.0.1", PublishedPort: 4177 }],
    }),
  ]);
  assert.deepEqual(
    checks
      .filter((check) => check.status === "FAIL")
      .map((check) => check.name),
    [
      "postgres container",
      "metadata container",
      "bootstrap-databases migration",
      "migrate-indexer migration",
      "migrate-metadata migration",
      "indexer host binding",
      "metadata host binding",
    ],
  );
});

test("runtime verifier proves resource and least-privilege settings were applied by Docker", () => {
  const checks = verifyHostConfig("indexer", {
    Memory: 1024,
    NanoCpus: 1_000_000_000,
    ReadonlyRootfs: true,
    Privileged: false,
    RestartPolicy: { Name: "unless-stopped" },
    SecurityOpt: ["no-new-privileges:true"],
    CapDrop: ["ALL"],
  });
  assert.equal(
    checks.some((check) => check.status === "FAIL"),
    false,
  );
  assert.equal(
    verifyHostConfig("indexer", {
      Memory: 0,
      NanoCpus: 0,
      ReadonlyRootfs: false,
      Privileged: true,
      RestartPolicy: { Name: "no" },
      SecurityOpt: [],
      CapDrop: [],
    }).filter((check) => check.status === "FAIL").length,
    7,
  );
});

test("runtime HTTP verification binds readiness, headers, config, RPC chain and method denial", async () => {
  const headers = new Headers({
    "content-security-policy": "default-src 'self'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=()",
  });
  const fetchFn = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === "/rpc" && options.method === "POST")
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x66eee" }),
        { status: 200 },
      );
    if (path === "/rpc") return new Response("forbidden", { status: 403 });
    if (path === "/runtime-config.json")
      return new Response(
        JSON.stringify({
          chain: { id: 421614, rpcPath: "/rpc" },
          indexer: { basePath: "/indexer" },
        }),
        { status: 200 },
      );
    if (path === "/") return new Response("ok", { status: 200, headers });
    return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
  };
  const checks = await verifyHttpRuntime({
    baseUrl: "http://127.0.0.1:4177",
    fetchFn,
  });
  assert.equal(
    checks.some((check) => check.status === "FAIL"),
    false,
  );
});
