import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import {
  createManifest,
  escapeCompose,
  fetchBytes,
  refreshProxyUpstreams,
  rollbackCompose,
  sha256,
  sshArgs,
  validateUpdateConfig,
  verifyAssets,
  verifySite,
} from "./public-update-core.mjs";

const config = {
  version: 1,
  publicOrigin: "https://example.org",
  localOrigin: "http://127.0.0.1:4177",
  ssh: {
    host: "example.org",
    user: "cpredict-publish",
    port: 22,
    identityFile: "private/key",
    knownHostsFile: "private/hosts",
  },
  composeOverrides: [],
};
test("public downloads verify the complete delayed body and identify body timeouts", async () => {
  const body = Buffer.from("complete public asset");
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "application/javascript",
      "content-length": body.length,
    });
    res.flushHeaders();
    setTimeout(() => res.end(body), 60);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const complete = await fetchBytes(origin, "/assets/delayed.js");
    assert.equal(complete.status, 200);
    assert.equal(complete.bytes, body.length);
    assert.equal(complete.sha256, sha256(body));
    await assert.rejects(
      fetchBytes(origin, "/assets/delayed.js", { timeoutMs: 10 }),
      (error) => {
        assert.match(
          error.message,
          /Public read failed: \/assets\/delayed.js \(TimeoutError\)/,
        );
        assert.equal(error.cause.name, "TimeoutError");
        return true;
      },
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
test("publisher enforces archive, immutability, command and rollback boundaries", () => {
  execFileSync(
    "python3",
    ["-B", resolve(import.meta.dirname, "cloud-publisher_test.py")],
    { stdio: "pipe" },
  );
});
test("publishing uses pinned host keys, an explicit identity, no shell or forwarding", () => {
  const parsed = validateUpdateConfig(config, "/repository");
  const args = sshArgs(parsed, "status");
  for (const option of [
    "StrictHostKeyChecking=yes",
    "BatchMode=yes",
    "ForwardAgent=no",
    "ClearAllForwardings=yes",
    "IdentitiesOnly=yes",
  ])
    assert.ok(args.includes(option));
  assert.equal(args.at(-1), "status");
  assert.equal(parsed.ssh.identityFile, "/repository/private/key");
  for (const change of [
    { publicOrigin: "http://example.org" },
    { publicOrigin: "https://user:pass@example.org" },
    { localOrigin: "http://example.org" },
    { ssh: { ...config.ssh, host: "-oProxyCommand=bad" } },
    { ssh: { ...config.ssh, user: "root" } },
  ])
    assert.throws(() =>
      validateUpdateConfig({ ...config, ...change }, "/repository"),
    );
});
test("raw Docker snapshot values are escaped once without modifying keys or other types", () => {
  const value = {
    environment: ["PASSWORD=a$word${literal}$$", "PLAIN=x"],
    n: 5,
    enabled: false,
    command: ["echo", "$HOME"],
  };
  assert.deepEqual(escapeCompose(value), {
    environment: ["PASSWORD=a$$word$${literal}$$$$", "PLAIN=x"],
    n: 5,
    enabled: false,
    command: ["echo", "$$HOME"],
  });
  assert.equal(value.environment[0], "PASSWORD=a$word${literal}$$");
});
test("rollback comes from running image IDs, preserves runtime isolation, never includes postgres", () => {
  const names = ["indexer", "metadata", "app-service", "web-demo"];
  const containers = names.map((name, i) => ({
    Id: `${i}`.repeat(64),
    Name: `/cpredict-${name}-1`,
    Image: `sha256:${i}`,
    Config: {
      Labels: { "com.docker.compose.service": name },
      Env: ["SECRET=literal$"],
      User: "10001",
      WorkingDir: "/app",
      Healthcheck: {
        Test: ["CMD", "node", "health.js"],
        Interval: 1e10,
        Timeout: 5e9,
        Retries: 12,
      },
    },
    State: { Running: true, Health: { Status: "healthy" } },
    HostConfig: {
      RestartPolicy: { Name: "unless-stopped" },
      ReadonlyRootfs: true,
      Memory: 536870912,
      NanoCpus: 1e9,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      LogConfig: { Type: "json-file", Config: { "max-size": "10m" } },
      Tmpfs: { "/tmp": "rw,noexec" },
      PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "4177" }] },
    },
    Mounts: [
      {
        Type: "bind",
        Source: "/private/runtime.json",
        Destination: "/run/application.json",
        RW: false,
      },
    ],
    NetworkSettings: {
      Networks: {
        cpredict_app: {
          Aliases: [name],
          IPAddress: `172.25.0.${i + 2}`,
          GlobalIPv6Address: `2001:db8::${i + 2}`,
          IPAMConfig:
            name === "web-demo"
              ? {
                  IPv4Address: "172.25.0.5",
                  IPv6Address: "2001:db8::5",
                  LinkLocalIPs: ["169.254.2.5"],
                }
              : null,
        },
      },
    },
  }));
  const snapshot = rollbackCompose(containers);
  assert.deepEqual(Object.keys(snapshot.services), names);
  assert.equal(snapshot.services["web-demo"].image, "sha256:3");
  assert.equal(snapshot.services["web-demo"].ports[0].host_ip, "127.0.0.1");
  assert.equal(snapshot.networks.cpredict_app.external, true);
  assert.deepEqual(snapshot.services["web-demo"].networks.cpredict_app, {
    aliases: ["web-demo"],
    ipv4_address: "172.25.0.5",
    ipv6_address: "2001:db8::5",
    link_local_ips: ["169.254.2.5"],
  });
  assert.deepEqual(snapshot.services.indexer.networks.cpredict_app, {
    aliases: ["indexer"],
  });
  assert.equal(snapshot.services.indexer.healthcheck.interval, "10000000000ns");
  containers[0].State.Health.Status = "unhealthy";
  assert.throws(() => rollbackCompose(containers), /not healthy/);
});
const proxyContainer = (service, digit, running = true) => ({
  Id: digit.repeat(64),
  Config: { Labels: { "com.docker.compose.service": service } },
  State: { Running: running },
});
test("proxy refresh retries stale upstreams after one reload without recreating containers", async () => {
  const gateway = proxyContainer("web-demo", "a");
  const preview = proxyContainer("public-site-preview", "b");
  const calls = [];
  const pauses = [];
  let stalePreview = true;
  const checks = await refreshProxyUpstreams(
    [gateway, preview, proxyContainer("indexer", "c")],
    async (args) => {
      calls.push(args);
      assert.equal(args[0], "exec");
      if (args[2] === "wget") {
        if (args[1] === preview.Id && stalePreview) {
          stalePreview = false;
          throw new Error("Old Nginx worker returned 502");
        }
        return '{"status":"ok"}';
      }
      return "";
    },
    { pause: async (ms) => pauses.push(ms) },
  );
  assert.deepEqual(
    checks.map(({ service, ready }) => ({ service, ready })),
    [
      { service: "web-demo", ready: true },
      { service: "public-site-preview", ready: true },
    ],
  );
  assert.deepEqual(pauses, [1000]);
  for (const proxy of [gateway, preview]) {
    const proxyCalls = calls.filter((args) => args[1] === proxy.Id);
    assert.deepEqual(proxyCalls[0], ["exec", proxy.Id, "nginx", "-t"]);
    assert.deepEqual(proxyCalls[1], [
      "exec",
      proxy.Id,
      "nginx",
      "-s",
      "reload",
    ]);
    assert.equal(
      proxyCalls.filter((args) => args.includes("reload")).length,
      1,
    );
    assert.ok(
      proxyCalls.some(
        (args) =>
          args.at(-1) === "http://127.0.0.1:8080/ctusd/metadata/healthz",
      ),
    );
  }
  assert.ok(calls.every((args) => [gateway.Id, preview.Id].includes(args[1])));
});
test("proxy refresh leaves stopped previews alone and rejects unhealthy responses", async () => {
  const gateway = proxyContainer("web-demo", "a");
  const calls = [];
  await assert.rejects(
    refreshProxyUpstreams(
      [gateway, proxyContainer("public-site-preview", "b", false)],
      async (args) => {
        calls.push(args);
        return args[2] === "wget" ? '{"status":"error"}' : "";
      },
      { pause: async () => {} },
    ),
    /web-demo upstreams did not become ready/,
  );
  assert.equal(calls.filter((args) => args.includes("reload")).length, 1);
  assert.equal(calls.filter((args) => args[2] === "wget").length, 10);
  assert.ok(calls.every((args) => args[1] === gateway.Id));
});
test("invalid proxy configuration prevents reload and a stopped gateway prevents any command", async () => {
  const calls = [];
  const docker = async (args) => {
    calls.push(args);
    throw new Error("nginx configuration is invalid");
  };
  await assert.rejects(
    refreshProxyUpstreams([proxyContainer("web-demo", "a")], docker),
    /configuration is invalid/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].at(-1), "-t");
  calls.length = 0;
  await assert.rejects(
    refreshProxyUpstreams(
      [
        proxyContainer("web-demo", "a", false),
        proxyContainer("public-site-preview", "b"),
      ],
      docker,
    ),
    /gateway is not running/,
  );
  assert.deepEqual(calls, []);
});
test("asset manifest binds every file and HTML reference to the source revision", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "cpredict-manifest-"));
  try {
    await mkdir(resolve(dir, "assets"));
    await writeFile(resolve(dir, "assets/site-abc.js"), "export default 1;");
    const html = '<script src="/assets/site-abc.js"></script>';
    await writeFile(resolve(dir, "index.html"), html);
    const manifest = await createManifest(dir, "a".repeat(40));
    assert.equal(manifest.htmlSha256, sha256(html));
    assert.equal(manifest.files[0].sha256, sha256("export default 1;"));
    await writeFile(
      resolve(dir, "index.html"),
      '<script src="/assets/missing.js"></script>',
    );
    await assert.rejects(createManifest(dir, "a".repeat(40)), /missing assets/);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("public verification rejects stale HTML, changed config and a broken market API despite HTTP health", async () => {
  const html = "<html>current release</html>";
  const site = JSON.stringify({
    defaultEnvironment: "test",
    environments: [
      {
        id: "test",
        asset: "ctUSD",
        services: { indexer: "/ctusd/indexer/public" },
        deployment: { id: "d1", chainId: 421614 },
      },
    ],
  });
  let broken = "";
  const server = createServer((request, response) => {
    const path = request.url.split("?")[0];
    if (["/", "/markets", "/help", "/create"].includes(path))
      return response.end(broken === "html" ? "old HTML" : html);
    if (path === "/site-config.json")
      return response.end(broken === "config" ? "{}" : site);
    if (path === "/healthz") return response.end("{}");
    if (["/demo", "/demo/"].includes(path)) {
      response.writeHead(308, { location: "/" });
      return response.end();
    }
    if (path.startsWith("/ctusd/app/v1/")) {
      response.statusCode = 401;
      return response.end("{}");
    }
    if (path === "/ctusd/indexer/public/v2/markets") {
      response.statusCode = broken === "api" ? 503 : 200;
      return response.end(JSON.stringify({ items: [], snapshot: {} }));
    }
    if (path === "/assets/site.js")
      return response.end(broken === "asset" ? "old js" : "new js");
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(
      (await verifySite(origin, sha256(html), sha256(site))).length,
      16,
    );
    for (const [fault, message] of [
      ["html", /HTML mismatch/],
      ["config", /configuration changed/],
      ["api", /market query failed/],
    ]) {
      broken = fault;
      await assert.rejects(
        verifySite(origin, sha256(html), sha256(site)),
        message,
      );
    }
    broken = "";
    const manifest = {
      files: [{ path: "assets/site.js", bytes: 6, sha256: sha256("new js") }],
    };
    assert.equal((await verifyAssets(origin, manifest)).length, 1);
    broken = "asset";
    await assert.rejects(
      verifyAssets(origin, manifest),
      /asset verification failed/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
