import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function validateChainNodeBinding(report, expected = {}) {
  object(report, "chain endpoint binding evidence");
  equal(report.schemaVersion, 1, "chain endpoint binding schemaVersion");
  equal(
    report.lane,
    "controlled-chain-dual-endpoint-binding",
    "chain endpoint binding lane",
  );
  assert(
    new Set(["preflight", "final"]).has(report.phase),
    "chain endpoint binding phase is invalid",
  );
  validRunId(report.runId);
  if (expected.phase !== undefined)
    equal(
      report.phase,
      expected.phase,
      "chain endpoint binding expected phase",
    );
  if (expected.runId !== undefined)
    equal(
      report.runId,
      expected.runId,
      "chain endpoint binding expected runId",
    );
  object(report.local, "local chain endpoint evidence");
  object(report.shared, "shared chain endpoint evidence");
  secureOrigins(report.local.origin, report.shared.origin);
  for (const endpoint of [report.local, report.shared]) {
    assert(
      Number.isSafeInteger(endpoint.chainId) && endpoint.chainId > 0,
      "chain endpoint chainId is invalid",
    );
    blockHash(endpoint.genesisBlockHash, "chain endpoint genesis hash");
    assert(
      Number.isSafeInteger(endpoint.observedBlockNumber) &&
        endpoint.observedBlockNumber >= 0,
      "chain endpoint observed block number is invalid",
    );
    blockHash(endpoint.observedBlockHash, "chain endpoint observed block hash");
  }
  equal(report.local.chainId, report.shared.chainId, "local/shared chainId");
  equal(
    report.local.genesisBlockHash,
    report.shared.genesisBlockHash,
    "local/shared genesis block",
  );
  equal(
    report.local.observedBlockNumber,
    report.shared.observedBlockNumber,
    "local/shared observed block number",
  );
  equal(
    report.local.observedBlockHash,
    report.shared.observedBlockHash,
    "local/shared observed block hash",
  );
  if (report.phase === "preflight") {
    assert(
      report.previousPreflightSha256 === undefined &&
        report.chainReportSha256 === undefined,
      "preflight chain binding must not claim final artifacts",
    );
  } else {
    assert(
      /^[0-9a-f]{64}$/.test(report.previousPreflightSha256),
      "final preflight binding digest is invalid",
    );
    assert(
      /^[0-9a-f]{64}$/.test(report.chainReportSha256),
      "final chain report digest is invalid",
    );
    assert(
      /^0x[0-9a-f]{40}$/.test(report.market),
      "final chain market address is invalid",
    );
    assert(
      /^[0-9a-f]{64}$/.test(report.local.marketCodeSha256),
      "local market code digest is invalid",
    );
    assert(
      /^[0-9a-f]{64}$/.test(report.shared.marketCodeSha256),
      "shared market code digest is invalid",
    );
    equal(
      report.local.marketCodeSha256,
      report.shared.marketCodeSha256,
      "local/shared market code",
    );
    assert(
      report.local.marketCodeBytes > 0 &&
        report.local.marketCodeBytes === report.shared.marketCodeBytes,
      "local/shared market code size is invalid",
    );
    if (expected.preflight !== undefined) {
      validateChainNodeBinding(expected.preflight, {
        phase: "preflight",
        runId: report.runId,
      });
      equal(
        report.previousPreflightSha256,
        expected.preflightSha256,
        "final/preflight evidence binding",
      );
      equal(
        report.local.chainId,
        expected.preflight.local.chainId,
        "final/preflight chainId",
      );
      equal(
        report.local.genesisBlockHash,
        expected.preflight.local.genesisBlockHash,
        "final/preflight genesis",
      );
      assert(
        report.local.observedBlockNumber >=
          expected.preflight.local.observedBlockNumber,
        "final observed block predates preflight",
      );
    }
    if (expected.chain !== undefined) {
      equal(
        report.chainReportSha256,
        expected.chainSha256,
        "final chain report binding",
      );
      equal(report.market, expected.chain.market, "final chain market binding");
    }
  }
  return report;
}

export async function captureBinding({
  phase,
  runId,
  localUrl,
  sharedUrl,
  outputPath,
  preflightPath,
  chainReportPath,
}) {
  validRunId(runId);
  const localOrigin = normalizedOrigin(localUrl, true);
  const sharedOrigin = normalizedOrigin(sharedUrl, false);
  const [localIdentity, sharedIdentity] = await Promise.all([
    chainIdentity(localUrl),
    chainIdentity(sharedUrl),
  ]);
  equal(localIdentity.chainId, sharedIdentity.chainId, "local/shared chainId");
  equal(
    localIdentity.genesisBlockHash,
    sharedIdentity.genesisBlockHash,
    "local/shared genesis block",
  );
  let localTip = await rpc(localUrl, "eth_getBlockByNumber", ["latest", false]);
  block(localTip, "local observed block");
  let sharedTip;
  try {
    sharedTip = await waitForBlock(
      sharedUrl,
      localTip.number,
      localTip.hash,
      1_500,
    );
  } catch (error) {
    // A public/gateway RPC may lag an idle controlled node until another block is published. Mine
    // one no-op block locally and retry; the stable evidence remains the matching height+hash.
    await rpc(localUrl, "evm_mine", []);
    localTip = await rpc(localUrl, "eth_getBlockByNumber", ["latest", false]);
    block(localTip, "local observed block after visibility mine");
    try {
      sharedTip = await waitForBlock(
        sharedUrl,
        localTip.number,
        localTip.hash,
        30_000,
      );
    } catch {
      throw error;
    }
  }
  const base = {
    schemaVersion: 1,
    lane: "controlled-chain-dual-endpoint-binding",
    phase,
    runId,
    observedAt: new Date().toISOString(),
    local: endpoint(localOrigin, localIdentity, localTip),
    shared: endpoint(sharedOrigin, sharedIdentity, sharedTip),
  };
  let report = base;
  let expected = { phase, runId };
  if (phase === "final") {
    if (preflightPath === undefined || chainReportPath === undefined)
      throw new Error("final binding requires preflight and chain reports");
    const preflightBody = await readFile(preflightPath);
    const chainBody = await readFile(chainReportPath);
    const preflight = JSON.parse(preflightBody);
    const chain = JSON.parse(chainBody);
    validateChainNodeBinding(preflight, { phase: "preflight", runId });
    assert(
      /^0x[0-9a-fA-F]{40}$/.test(chain.market),
      "chain report market address is invalid",
    );
    const market = chain.market.toLowerCase();
    const [localCode, sharedCode] = await Promise.all([
      rpc(localUrl, "eth_getCode", [market, "latest"]),
      rpc(sharedUrl, "eth_getCode", [market, "latest"]),
    ]);
    const localCodeEvidence = codeEvidence(localCode);
    const sharedCodeEvidence = codeEvidence(sharedCode);
    report = {
      ...base,
      previousPreflightSha256: sha256(preflightBody),
      chainReportSha256: sha256(chainBody),
      market,
      local: { ...base.local, ...localCodeEvidence },
      shared: { ...base.shared, ...sharedCodeEvidence },
    };
    expected = {
      ...expected,
      preflight,
      preflightSha256: sha256(preflightBody),
      chain,
      chainSha256: sha256(chainBody),
    };
  }
  validateChainNodeBinding(report, expected);
  await atomicWrite(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function chainIdentity(url) {
  const [chainIdHex, genesis] = await Promise.all([
    rpc(url, "eth_chainId", []),
    rpc(url, "eth_getBlockByNumber", ["0x0", false]),
  ]);
  const chainId = Number(BigInt(chainIdHex));
  assert(
    Number.isSafeInteger(chainId) && chainId > 0,
    "chain endpoint chainId is invalid",
  );
  block(genesis, "chain genesis block");
  equal(Number(BigInt(genesis.number)), 0, "chain genesis block number");
  return { chainId, genesisBlockHash: genesis.hash.toLowerCase() };
}

async function waitForBlock(url, number, expectedHash, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await rpc(url, "eth_getBlockByNumber", [number, false]);
    if (
      value !== null &&
      typeof value.hash === "string" &&
      value.hash.toLowerCase() === expectedHash.toLowerCase()
    )
      return value;
    if (Date.now() >= deadline)
      throw new Error(
        `shared chain endpoint did not observe the local canonical block within ${timeoutMs} ms`,
      );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
}

async function rpc(url, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok)
    throw new Error(`${method} returned HTTP ${response.status}`);
  const body = await response.json();
  if (body.error !== undefined)
    throw new Error(`${method}: ${body.error.message ?? "RPC error"}`);
  if (!("result" in body)) throw new Error(`${method} RPC result is missing`);
  return body.result;
}

function endpoint(origin, identity, observed) {
  block(observed, "chain observed block");
  return {
    origin,
    chainId: identity.chainId,
    genesisBlockHash: identity.genesisBlockHash,
    observedBlockNumber: Number(BigInt(observed.number)),
    observedBlockHash: observed.hash.toLowerCase(),
  };
}

function codeEvidence(value) {
  assert(
    typeof value === "string" &&
      /^0x(?:[0-9a-fA-F]{2})+$/.test(value) &&
      value !== "0x",
    "market code is missing from a chain endpoint",
  );
  const normalized = value.toLowerCase();
  return {
    marketCodeBytes: (normalized.length - 2) / 2,
    marketCodeSha256: sha256(Buffer.from(normalized.slice(2), "hex")),
  };
}

function block(value, label) {
  object(value, label);
  assert(
    typeof value.number === "string" && /^0x[0-9a-fA-F]+$/.test(value.number),
    `${label} number is invalid`,
  );
  blockHash(value.hash?.toLowerCase(), `${label} hash`);
}

function blockHash(value, label) {
  assert(
    typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value),
    `${label} is invalid`,
  );
}

function normalizedOrigin(value, loopback) {
  const url = new URL(value);
  const isLoopback = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(
    url.hostname,
  );
  if (loopback)
    assert(
      url.protocol === "http:" && isLoopback,
      "local chain endpoint must be loopback HTTP",
    );
  else
    assert(
      url.protocol === "https:" && !isLoopback && url.hostname !== "0.0.0.0",
      "shared chain endpoint must be non-loopback HTTPS",
    );
  assert(
    url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "",
    "chain endpoint must be a credential-free normalized origin",
  );
  return url.origin;
}

function secureOrigins(local, shared) {
  normalizedOrigin(local, true);
  normalizedOrigin(shared, false);
}

async function atomicWrite(path, body) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, body, "utf8");
  await rename(temporary, path);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validRunId(value) {
  assert(
    typeof value === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value),
    "runId is invalid",
  );
}

function object(value, label) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
}

function equal(actual, expected, label) {
  assert(
    actual === expected,
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isEntrypoint) {
  const [
    phase,
    runId,
    localUrl,
    sharedUrl,
    outputPath,
    preflightPath,
    chainReportPath,
  ] = process.argv.slice(2);
  try {
    if (phase === "preflight") {
      if (
        [runId, localUrl, sharedUrl, outputPath].some(
          (value) => value === undefined,
        ) ||
        preflightPath !== undefined
      ) {
        throw new Error("preflight expects RUN_ID local-url shared-url output");
      }
      await captureBinding({ phase, runId, localUrl, sharedUrl, outputPath });
    } else if (phase === "final") {
      if (
        [
          runId,
          localUrl,
          sharedUrl,
          outputPath,
          preflightPath,
          chainReportPath,
        ].some((value) => value === undefined)
      ) {
        throw new Error(
          "final expects RUN_ID local-url shared-url output preflight chain-report",
        );
      }
      await captureBinding({
        phase,
        runId,
        localUrl,
        sharedUrl,
        outputPath,
        preflightPath,
        chainReportPath,
      });
    } else {
      throw new Error("chain endpoint binding mode must be preflight or final");
    }
    process.stdout.write(`captured ${phase} dual-endpoint chain binding\n`);
  } catch (error) {
    process.stderr.write(`chain endpoint binding failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
