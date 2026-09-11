import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { resolve, dirname } from "node:path";

export const SERVICES = ["indexer", "metadata", "app-service", "web-demo"];
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export function ensure(value, message) {
  if (!value) throw new Error(message);
}
export async function privateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}
export async function restrictedFile(path) {
  const info = await lstat(path);
  ensure(
    info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0,
    "Update input must be a private regular file (0600)",
  );
  return path;
}
export function validateUpdateConfig(value, root) {
  ensure(value?.version === 1, "Unsupported update configuration");
  const origin = new URL(value.publicOrigin);
  ensure(
    origin.protocol === "https:" &&
      origin.href === origin.origin + "/" &&
      !origin.username &&
      !origin.password,
    "Public origin must use HTTPS without credentials or a path",
  );
  const local = new URL(value.localOrigin);
  ensure(
    local.protocol === "http:" &&
      ["127.0.0.1", "[::1]"].includes(local.hostname) &&
      local.href === local.origin + "/",
    "Local origin must be loopback HTTP",
  );
  const ssh = value.ssh;
  ensure(
    ssh &&
      /^[A-Za-z0-9.-]+$/.test(ssh.host) &&
      !ssh.host.startsWith("-") &&
      ssh.user === "cpredict-publish",
    "Invalid restricted publishing host/user",
  );
  ensure(
    Number.isInteger(ssh.port) && ssh.port > 0 && ssh.port < 65536,
    "Invalid SSH port",
  );
  ensure(
    typeof ssh.identityFile === "string" &&
      typeof ssh.knownHostsFile === "string",
    "Publishing identity and pinned host keys are required",
  );
  ensure(
    Array.isArray(value.composeOverrides) &&
      value.composeOverrides.every((p) => typeof p === "string"),
    "Explicit Compose overrides are required",
  );
  return {
    ...value,
    publicOrigin: origin.origin,
    localOrigin: local.origin,
    stateDirectory: resolve(root, "runtime/public-site/updates"),
    composeOverrides: value.composeOverrides.map((p) => resolve(root, p)),
    ssh: {
      ...ssh,
      identityFile: resolve(root, ssh.identityFile),
      knownHostsFile: resolve(root, ssh.knownHostsFile),
    },
  };
}
export function sshArgs(config, command) {
  const s = config.ssh;
  return [
    "-F",
    "/dev/null",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    `UserKnownHostsFile=${s.knownHostsFile}`,
    "-i",
    s.identityFile,
    "-p",
    String(s.port),
    `${s.user}@${s.host}`,
    command,
  ];
}
/** Capture all subprocess output privately. In particular, never echo SSH arguments or Compose secrets. */
export async function run(
  command,
  args,
  { cwd, env = process.env, input, timeout = 120000, label = command } = {},
) {
  return await new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out = [],
      err = [];
    let bytes = 0,
      overflow = false;
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    const collect = (target) => (data) => {
      bytes += data.length;
      if (bytes > 64 * 1024 * 1024) {
        overflow = true;
        child.kill("SIGTERM");
      } else target.push(data);
    };
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));
    child.stdin.on("error", () => {});
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error(`${label} could not start`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || overflow)
        reject(
          new Error(
            `${label} failed (${code ?? "interrupted"}); no credentials were printed`,
          ),
        );
      else accept(Buffer.concat(out).toString("utf8"));
    });
    child.stdin.end(input);
  });
}
export async function publisher(config, command, input) {
  return JSON.parse(
    await run("ssh", sshArgs(config, command), {
      input,
      timeout: 660000,
      label: "Restricted cloud publisher",
    }),
  );
}
// Raw Docker inspect values need escaping before they become Compose input.
export function escapeCompose(value) {
  if (typeof value === "string") return value.replaceAll("$", () => "$$");
  if (Array.isArray(value)) return value.map(escapeCompose);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, escapeCompose(v)]),
    );
  return value;
}
/** Recover the *running* configuration, including when its historical Compose file no longer exists. */
export function rollbackCompose(containers) {
  const result = { name: "cpredict", services: {}, networks: {}, volumes: {} };
  for (const c of containers) {
    const service = c.Config.Labels?.["com.docker.compose.service"];
    if (!SERVICES.includes(service)) continue;
    const h = c.HostConfig,
      cfg = c.Config;
    ensure(
      c.State.Running && c.State.Health?.Status === "healthy",
      `Existing ${service} is not healthy`,
    );
    const networks = {};
    for (const [name, network] of Object.entries(c.NetworkSettings.Networks)) {
      result.networks[name] = { external: true, name };
      networks[name] = {
        aliases: (network.Aliases ?? []).filter(
          (a) => a !== c.Id.slice(0, 12) && a !== c.Name.slice(1),
        ),
      };
      // Preserve explicitly requested addresses, not Docker's current dynamic
      // assignment. The gateway's trusted-proxy configuration relies on this.
      const ipam = network.IPAMConfig;
      if (ipam?.IPv4Address) networks[name].ipv4_address = ipam.IPv4Address;
      if (ipam?.IPv6Address) networks[name].ipv6_address = ipam.IPv6Address;
      if (ipam?.LinkLocalIPs?.length)
        networks[name].link_local_ips = [...ipam.LinkLocalIPs];
    }
    const volumes = c.Mounts.filter((m) => m.Type !== "tmpfs").map((m) => {
      ensure(
        ["volume", "bind"].includes(m.Type),
        "Unsupported existing mount type",
      );
      if (m.Type === "volume")
        result.volumes[m.Name] = { external: true, name: m.Name };
      return {
        type: m.Type,
        source: m.Type === "volume" ? m.Name : m.Source,
        target: m.Destination,
        read_only: !m.RW,
      };
    });
    const ports = Object.entries(h.PortBindings ?? {}).flatMap(
      ([key, bindings]) =>
        (bindings ?? []).map((b) => {
          const [target, protocol] = key.split("/");
          return {
            target: Number(target),
            protocol,
            published: b.HostPort,
            host_ip: b.HostIp,
          };
        }),
    );
    const s = {
      image: c.Image,
      environment: cfg.Env,
      entrypoint: cfg.Entrypoint ?? [],
      command: cfg.Cmd ?? [],
      user: cfg.User,
      working_dir: cfg.WorkingDir,
      restart: h.RestartPolicy.Name,
      read_only: h.ReadonlyRootfs,
      cap_drop: h.CapDrop ?? [],
      cap_add: h.CapAdd ?? [],
      security_opt: h.SecurityOpt ?? [],
      volumes,
      ports,
      networks,
      tmpfs: Object.entries(h.Tmpfs ?? {}).map(
        ([path, options]) => `${path}:${options}`,
      ),
      logging: { driver: h.LogConfig.Type, options: h.LogConfig.Config ?? {} },
    };
    if (h.Memory) s.mem_limit = h.Memory;
    if (h.NanoCpus) s.cpus = h.NanoCpus / 1e9;
    if (cfg.StopTimeout) s.stop_grace_period = `${cfg.StopTimeout}s`;
    if (cfg.Healthcheck) {
      const health = cfg.Healthcheck;
      s.healthcheck = { test: health.Test };
      for (const [from, to] of [
        ["Interval", "interval"],
        ["Timeout", "timeout"],
        ["StartPeriod", "start_period"],
      ])
        if (health[from]) s.healthcheck[to] = `${health[from]}ns`;
      if (health.Retries) s.healthcheck.retries = health.Retries;
    }
    result.services[service] = s;
  }
  ensure(
    SERVICES.every((s) => result.services[s]),
    "Existing ctUSD services are incomplete",
  );
  return result;
}
/** Existing Nginx workers may still hold addresses of replaced backend containers. */
export async function refreshProxyUpstreams(
  containers,
  docker,
  { pause = (ms) => new Promise((done) => setTimeout(done, ms)) } = {},
) {
  const proxies = containers.filter(
    (c) =>
      c.State.Running &&
      ["web-demo", "public-site-preview"].includes(
        c.Config.Labels?.["com.docker.compose.service"],
      ),
  );
  ensure(
    proxies.some(
      (c) => c.Config.Labels["com.docker.compose.service"] === "web-demo",
    ),
    "The public gateway is not running",
  );
  const checks = [];
  for (const proxy of proxies) {
    const service = proxy.Config.Labels["com.docker.compose.service"];
    ensure(/^[0-9a-f]{64}$/.test(proxy.Id), "Invalid running proxy identity");
    await docker(["exec", proxy.Id, "nginx", "-t"], {
      label: `Validate ${service} proxy configuration`,
    });
    await docker(["exec", proxy.Id, "nginx", "-s", "reload"], {
      label: `Refresh ${service} upstream addresses`,
    });
    const paths = ["/ctusd/indexer/healthz", "/ctusd/metadata/healthz"];
    const deadline = Date.now() + 45000;
    let ready = false;
    // A successful reload signal does not mean the new workers are ready yet.
    for (let attempt = 0; attempt < 10 && Date.now() < deadline; attempt++) {
      try {
        for (const path of paths) {
          const body = await docker(
            [
              "exec",
              proxy.Id,
              "wget",
              "-q",
              "-T",
              "5",
              "-O",
              "-",
              `http://127.0.0.1:8080${path}`,
            ],
            { timeout: 10000, label: `Verify ${service} upstream readiness` },
          );
          ensure(
            JSON.parse(body).status === "ok",
            "Proxy upstream is not ready",
          );
        }
        ready = true;
        break;
      } catch {
        if (attempt < 9 && Date.now() < deadline) await pause(1000);
      }
    }
    ensure(ready, `${service} upstreams did not become ready after reload`);
    checks.push({ service, paths, ready });
  }
  return checks;
}
export async function createManifest(directory, sourceCommit) {
  ensure(/^[0-9a-f]{40}$/.test(sourceCommit), "Invalid image revision");
  const html = await readFile(resolve(directory, "index.html"));
  const files = [];
  async function walk(path) {
    for (const item of await readdir(resolve(directory, path), {
      withFileTypes: true,
    })) {
      const name = `${path}/${item.name}`;
      if (item.isDirectory()) await walk(name);
      else {
        ensure(
          item.isFile() &&
            /^assets\/[A-Za-z0-9_@+./-]+$/.test(name) &&
            !name.endsWith(".map"),
          "Unexpected build asset",
        );
        if (name.endsWith(".gz")) continue;
        const data = await readFile(resolve(directory, name));
        files.push({ path: name, bytes: data.length, sha256: sha256(data) });
      }
    }
  }
  await walk("assets");
  const htmlAssets = [
    ...html.toString().matchAll(/(?:src|href)="\/(assets\/[^"?#]+)"/g),
  ].map((m) => m[1]);
  ensure(
    htmlAssets.length > 0 &&
      htmlAssets.every((p) => files.some((f) => f.path === p)),
    "HTML references missing assets",
  );
  return {
    version: 1,
    sourceCommit,
    htmlSha256: sha256(html),
    htmlAssets,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
}
export async function fetchBytes(origin, path, { timeoutMs = 120000 } = {}) {
  try {
    const r = await fetch(origin + path, {
      redirect: "manual",
      headers: { "cache-control": "no-cache" },
      // Include the complete response body: larger wallet chunks can take more
      // than 35 seconds over the public connection during release verification.
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = Buffer.from(await r.arrayBuffer());
    return {
      status: r.status,
      sha256: sha256(data),
      bytes: data.length,
      location: r.headers.get("location"),
      data,
    };
  } catch (error) {
    // An unadorned DOMException code 23 hid which public download had failed.
    // Paths here are public verification targets; never expose connection data.
    throw new Error(
      `Public read failed: ${path} (${error.name ?? "request error"})`,
      { cause: error },
    );
  }
}
export async function verifyAssets(origin, manifest) {
  let next = 0;
  const rows = [];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < manifest.files.length) {
        const file = manifest.files[next++],
          r = await fetchBytes(origin, "/" + file.path);
        ensure(
          r.status === 200 &&
            r.sha256 === file.sha256 &&
            r.bytes === file.bytes,
          `Public asset verification failed: ${file.path}`,
        );
        rows.push({ path: file.path, sha256: r.sha256, bytes: r.bytes });
      }
    }),
  );
  return rows;
}
export async function verifySite(origin, htmlSha256, configSha256) {
  const rows = [];
  let site;
  for (const path of ["/", "/markets", "/help", "/create"]) {
    const r = await fetchBytes(origin, path);
    ensure(
      r.status === 200 && r.sha256 === htmlSha256,
      `Public HTML mismatch: ${path}`,
    );
    rows.push({ path, status: r.status, sha256: r.sha256 });
  }
  for (const [path, status] of [
    ["/healthz", 200],
    ["/site-config.json", 200],
    ["/demo", 308],
    ["/demo/", 308],
    ["/demo/assets/retired.js", 404],
    ["/readyz", 404],
    ["/ctusd/app/metrics", 404],
    ["/.env", 404],
    ["/.git/config", 404],
    ["/ctusd/app/v1/me/accounts", 401],
    ["/ctusd/app/v1/ops/reports", 401],
  ]) {
    const r = await fetchBytes(origin, path);
    ensure(r.status === status, `Public route status mismatch: ${path}`);
    if (status === 308)
      ensure(
        new URL(r.location, origin).href === origin + "/",
        "Retired Demo redirect mismatch",
      );
    if (path === "/site-config.json") {
      ensure(r.sha256 === configSha256, "Public configuration changed");
      site = JSON.parse(r.data);
    }
    rows.push({ path, status, sha256: r.sha256 });
  }
  const environment = site.environments.find(
    (e) => e.id === site.defaultEnvironment,
  );
  ensure(
    environment?.asset === "ctUSD" &&
      environment.services.indexer === "/ctusd/indexer/public",
    "Unexpected public ctUSD environment",
  );
  const query = new URLSearchParams({
    environment: environment.id,
    deploymentId: environment.deployment.id,
    chainId: String(environment.deployment.chainId),
    limit: "1",
  });
  const path = "/ctusd/indexer/public/v2/markets?" + query;
  const markets = await fetchBytes(origin, path);
  ensure(
    markets.status === 200 && Array.isArray(JSON.parse(markets.data).items),
    "Public market query failed",
  );
  rows.push({ path, status: markets.status });
  return rows;
}
