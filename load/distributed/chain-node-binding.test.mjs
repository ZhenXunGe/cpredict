import assert from "node:assert/strict";
import test from "node:test";
import { validateChainNodeBinding } from "./chain-node-binding.mjs";

test("chain endpoint binding rejects a different shared node and final report drift", () => {
  const preflight = binding("preflight", 100, "a");
  assert.doesNotThrow(() =>
    validateChainNodeBinding(preflight, {
      phase: "preflight",
      runId: "fixture",
    }),
  );

  preflight.shared.genesisBlockHash = hash("b");
  assert.throws(() => validateChainNodeBinding(preflight), /genesis block/);
  preflight.shared.genesisBlockHash = hash("a");

  const final = {
    ...binding("final", 700, "a"),
    previousPreflightSha256: "1".repeat(64),
    chainReportSha256: "2".repeat(64),
    market: "0x0000000000000000000000000000000000000001",
  };
  final.local.marketCodeSha256 = "3".repeat(64);
  final.shared.marketCodeSha256 = "3".repeat(64);
  final.local.marketCodeBytes = 1_000;
  final.shared.marketCodeBytes = 1_000;
  assert.doesNotThrow(() =>
    validateChainNodeBinding(final, {
      phase: "final",
      runId: "fixture",
      preflight,
      preflightSha256: "1".repeat(64),
      chain: { market: final.market },
      chainSha256: "2".repeat(64),
    }),
  );

  final.shared.observedBlockHash = hash("f");
  assert.throws(() => validateChainNodeBinding(final), /observed block hash/);
});

function binding(phase, blockNumber, genesis) {
  return {
    schemaVersion: 1,
    lane: "controlled-chain-dual-endpoint-binding",
    phase,
    runId: "fixture",
    observedAt: new Date().toISOString(),
    local: {
      origin: "http://127.0.0.1:18545",
      chainId: 31_337,
      genesisBlockHash: hash(genesis),
      observedBlockNumber: blockNumber,
      observedBlockHash: hash("c"),
    },
    shared: {
      origin: "https://chain.example.invalid",
      chainId: 31_337,
      genesisBlockHash: hash(genesis),
      observedBlockNumber: blockNumber,
      observedBlockHash: hash("c"),
    },
  };
}

function hash(character) {
  return `0x${character.repeat(64)}`;
}
