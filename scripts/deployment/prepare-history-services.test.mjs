import test from "node:test";
import assert from "node:assert/strict";
import { historicalRuntime } from "./prepare-history-services.mjs";
import { env } from "../../dist/offchain/app-core/test/fixtures.js";
import {
  environmentKey,
  environmentSchema,
} from "../../dist/offchain/app-core/src/contracts.js";

test("historical access keeps wallet, deployment and quotas on authenticated edge namespaces", () => {
  const original = {
    environment: env,
    sponsor: {
      projectId: "same-project",
      weekly: { projectWei: "2000000000000000000" },
    },
  };
  const before = structuredClone(original),
    history = historicalRuntime(original);
  assert.deepEqual(original, before);
  assert.equal(
    environmentKey(history.environment),
    environmentKey(original.environment),
  );
  assert.deepEqual(history.environment.account, original.environment.account);
  assert.deepEqual(history.sponsor, original.sponsor);
  assert.equal(environmentSchema.safeParse(history.environment).success, true);
  assert.match(history.environment.services.app, /^\/ctusd\/app\//);
  assert.match(history.environment.services.indexer, /^\/ctusd\/indexer\//);
  assert.match(history.environment.services.metadata, /^\/ctusd\/metadata\//);
  assert.equal(history.environment.features.newExposure, false);
  assert.equal(history.environment.features.faucet, false);
});
