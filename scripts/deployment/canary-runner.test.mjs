import assert from "node:assert/strict";
import test from "node:test";
import { REQUIRED_CANARY_STEPS } from "./evidence-lib.mjs";
import {
  validateFinishReadiness,
  validateInspection,
  validateResumeIdentity,
  validateStartResult,
} from "./canary-runner.mjs";

const identity = {
  factory: "0x1111111111111111111111111111111111111111",
  factoryActivationFingerprint: `0x${"2".repeat(64)}`,
  bootstrapFinalizeTx: `0x${"3".repeat(64)}`,
  sourceCommit: "4".repeat(40),
};
const manifest = {
  contracts: { factory: { address: identity.factory } },
  bootstrap: {
    factoryActivationFingerprint: identity.factoryActivationFingerprint,
  },
  transactions: { bootstrapFinalize: { txHash: identity.bootstrapFinalizeTx } },
  source: { commit: identity.sourceCommit },
};

test("canary inspection binds chain, three accounts, adapter and deployment", () => {
  assert.doesNotThrow(() =>
    validateInspection(
      {
        chainId: 421614,
        environment: "ARBITRUM_SEPOLIA_RUNTIME",
        chainTimestamp: 1_900_000_000,
        accounts: [
          "0x5555555555555555555555555555555555555555",
          "0x6666666666666666666666666666666666666666",
          "0x7777777777777777777777777777777777777777",
        ],
        adapterSha256: "8".repeat(64),
        balances: [1, 2, 3].map(() => ({ nativeWei: "1", usdcUnits: "1" })),
        externalDependenciesVerified: true,
        deploymentIdentity: identity,
        paymasterReady: true,
      },
      manifest,
    ),
  );
  assert.throws(
    () => validateInspection({ chainId: 1 }, manifest),
    /Arbitrum Sepolia/,
  );
});

test("start result requires exact pre-timeout inventory and outcome-anchored frozen windows", () => {
  const result = {
    steps: REQUIRED_CANARY_STEPS.filter(
      (id) => id !== "timeout.deadlineCreatorVoidRejected",
    ).map((id) => ({ id })),
    timeoutSeed: {
      market: "0x8888888888888888888888888888888888888888",
      closeAt: 100,
      outcomeDeadlineAt: 200,
      resolutionWindow: 900,
      deadline: 1_100,
    },
    zeroParticipantTimeoutSeed: {
      market: "0x9999999999999999999999999999999999999999",
      closeAt: 200,
      outcomeDeadlineAt: 200,
      resolutionWindow: 86_400,
      deadline: 86_600,
    },
  };
  assert.doesNotThrow(() => validateStartResult(result));
  result.timeoutSeed.deadline -= 1;
  assert.throws(() => validateStartResult(result), /outcomeDeadlineAt/);
  result.timeoutSeed.deadline =
    result.timeoutSeed.closeAt + result.timeoutSeed.resolutionWindow;
  assert.throws(() => validateStartResult(result), /outcomeDeadlineAt/);
});

test("receipt-driven resume rejects account, adapter and deployment drift", () => {
  const inspection = {
    accounts: [
      "0x5555555555555555555555555555555555555555",
      "0x6666666666666666666666666666666666666666",
      "0x7777777777777777777777777777777777777777",
    ],
    adapterSha256: "8".repeat(64),
  };
  const state = {
    manifestSha256: "9".repeat(64),
    sourceManifestSha256: "a".repeat(64),
    adapterSha256: inspection.adapterSha256,
    accounts: inspection.accounts,
    deploymentIdentity: identity,
  };
  const completeManifest = {
    ...manifest,
    source: { ...manifest.source, sourceManifestSha256: "a".repeat(64) },
  };
  assert.doesNotThrow(() =>
    validateResumeIdentity(
      state,
      completeManifest,
      state.manifestSha256,
      inspection,
    ),
  );
  assert.throws(
    () =>
      validateResumeIdentity(state, completeManifest, state.manifestSha256, {
        ...inspection,
        accounts: [
          ...inspection.accounts.slice(0, 2),
          "0x8888888888888888888888888888888888888888",
        ],
      }),
    /accounts changed/,
  );
  assert.throws(
    () =>
      validateResumeIdentity(state, completeManifest, state.manifestSha256, {
        ...inspection,
        adapterSha256: "b".repeat(64),
      }),
    /adapter changed/,
  );
});

test("finish readiness uses chain time and preserves resumable FINISHING state", () => {
  const state = { phase: "STARTED", earliestFinishAt: 1_000 };
  assert.throws(
    () => validateFinishReadiness(state, { chainTimestamp: 999 }),
    /too early/,
  );
  assert.doesNotThrow(() =>
    validateFinishReadiness(state, { chainTimestamp: 1_000 }),
  );
  assert.doesNotThrow(() =>
    validateFinishReadiness(
      { ...state, phase: "FINISHING" },
      { chainTimestamp: 1_001 },
    ),
  );
  assert.throws(
    () =>
      validateFinishReadiness(
        { ...state, phase: "BLOCKED" },
        { chainTimestamp: 1_001 },
      ),
    /cannot finish/,
  );
});
