import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";

// Read-only provider preflight. Never prints URLs, headers, credentials, user
// records, provider error text or executable payloads; never requests sponsorship.
const { values } = parseArgs({
  options: {
    "env-file": { type: "string" },
    output: { type: "string" },
  },
});
if (!values["env-file"]) throw new Error("--env-file is required");
const vars = parseEnv(await readFile(resolve(values["env-file"]), "utf8"));
const runtime = JSON.parse(
  await readFile(vars.CPREDICT_APP_CONFIG_FILE, "utf8"),
);
const appId = runtime.environment.privyAppId;
const projectId = runtime.sponsor?.projectId;
if (
  !/^c[a-z0-9]{8,127}$/.test(appId) ||
  !/^[\da-f-]{36}$/.test(projectId ?? "")
)
  throw new Error("explicit provider IDs are required");
if (!vars.CPREDICT_APP_PRIVY_SECRET)
  throw new Error("Privy secret is required");
const chainId = runtime.environment.deployment.chainId;
if (chainId !== 421614) throw new Error("only Arbitrum Sepolia is allowed");
const endpoints = [
  "CPREDICT_APP_ZERODEV_BUNDLER_URL",
  "CPREDICT_APP_ZERODEV_PAYMASTER_URL",
].map((key) => {
  const url = new URL(vars[key]);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "rpc.zerodev.app" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    url.pathname !== `/api/v3/${projectId}/chain/${chainId}`
  )
    throw new Error(
      "provider endpoint does not match this environment's project and chain",
    );
  return url;
});
async function check(url, options, parse) {
  try {
    const response = await fetch(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok || !parse) {
      await response.body?.cancel();
      return { status: response.status, ok: response.ok };
    }
    const body = await response.json();
    return { status: response.status, ...parse(body) };
  } catch {
    return { ok: false, error: "transport_or_response_failure" };
  }
}
async function rpc(url, method, valid, params = []) {
  return check(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    },
    (body) => ({
      ok: !body.error && valid(body.result),
      rpcErrorCode: Number.isInteger(body.error?.code) ? body.error.code : null,
    }),
  );
}
const checks = await Promise.allSettled([
  rpc(endpoints[0], "eth_chainId", (value) => value === "0x66eee"),
  rpc(
    endpoints[0],
    "eth_supportedEntryPoints",
    (value) =>
      Array.isArray(value) &&
      value.some(
        (v) =>
          typeof v === "string" &&
          v.toLowerCase() === "0x0000000071727de22e5e9d8baf0edac6f37da032",
      ),
  ),
  rpc(endpoints[1], "eth_chainId", (value) => value === "0x66eee"),
  check(`https://api.privy.io/v1/apps/${appId}/allowlist`, {
    method: "GET",
    headers: {
      Authorization: `Basic ${Buffer.from(`${appId}:${vars.CPREDICT_APP_PRIVY_SECRET}`).toString("base64")}`,
      "privy-app-id": appId,
    },
  }),
  check(
    `https://api.privy.io/v1/apps/${appId}/jwks.json`,
    { method: "GET" },
    (body) => ({ ok: Array.isArray(body.keys) && body.keys.length > 0 }),
  ),
]);
const names = [
  "bundlerChain",
  "entryPoint07",
  "paymasterEndpointChain",
  "privyServerAuthentication",
  "privySigningKeys",
];
// The AA endpoint is not proof of a full chain RPC. A pinned storage read is
// needed for historical reconciliation and catches block-parameter routing bugs.
const chainUrl = new URL(vars.CPREDICT_APP_RPC_URL);
if (
  chainUrl.protocol !== "https:" ||
  chainUrl.username ||
  chainUrl.password ||
  chainUrl.hash
)
  throw new Error("an explicit HTTPS chain read RPC is required");
const chainCheck = await rpc(
  chainUrl,
  "eth_chainId",
  (value) => value === "0x66eee",
);
const blockCheck = await check(
  chainUrl,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBlockByNumber",
      params: ["latest", false],
    }),
  },
  (body) => {
    const valid =
      !body.error &&
      /^0x[\da-f]+$/i.test(body.result?.number ?? "") &&
      /^0x[\da-f]{64}$/i.test(body.result?.hash ?? "");
    return {
      ok: valid,
      ...(valid
        ? { blockNumber: body.result.number, blockHash: body.result.hash }
        : {}),
    };
  },
);
const entryPoint = "0x0000000071727de22e5e9d8baf0edac6f37da032";
const pinnedStorage =
  chainCheck.ok && blockCheck.ok
    ? await rpc(
        chainUrl,
        "eth_getStorageAt",
        (value) => typeof value === "string" && /^0x[\da-f]{64}$/i.test(value),
        [entryPoint, "0x0", blockCheck.blockNumber],
      )
    : { ok: false, error: "chain_head_not_verified" };
const pinnedEntryPoint =
  chainCheck.ok && blockCheck.ok
    ? await rpc(
        chainUrl,
        "eth_getCode",
        (value) =>
          typeof value === "string" && /^0x(?:[\da-f]{2})+$/i.test(value),
        [entryPoint, blockCheck.blockNumber],
      )
    : { ok: false, error: "chain_head_not_verified" };
const report = {
  generatedAt: new Date().toISOString(),
  environment: runtime.environment.id,
  asset: runtime.environment.asset,
  chainId,
  mode: "read-only-no-sponsorship-no-broadcast",
  checks: {
    ...Object.fromEntries(
      checks.map((r, i) => [
        names[i],
        r.status === "fulfilled"
          ? r.value
          : { ok: false, error: "check_failed" },
      ]),
    ),
    chainRpcChain: chainCheck,
    chainRpcHead: blockCheck,
    chainRpcPinnedStorage: pinnedStorage,
    chainRpcPinnedEntryPoint: pinnedEntryPoint,
  },
  providerGasPoliciesVerified: false,
  walletLoginVerified: false,
  gaslessTransactionVerified: false,
};
if (values.output)
  await writeFile(
    resolve(values.output),
    JSON.stringify(report, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
console.log(JSON.stringify(report, null, 2));
if (Object.values(report.checks).some((v) => !v.ok)) process.exitCode = 1;
