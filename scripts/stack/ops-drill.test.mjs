import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateLocalDrillResult } from "./ops-drill.mjs";

test("local drill result binds non-empty artifact under its evidence root", async () => {
  const root = await mkdtemp(join(tmpdir(), "cpredict-drill-"));
  const path = join(root, "rpc.json");
  const content = "{}\n";
  await writeFile(path, content);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const result = await validateLocalDrillResult({
    id: "rpc.failover", status: "PASS", startedAt: "2026-08-21T00:00:00Z",
    completedAt: "2026-08-21T00:00:01Z", observedOutcome: "backup RPC selected",
    artifacts: [{ kind: "RPC_RESPONSE", path, sha256 }],
  }, "rpc.failover", root);
  assert.equal(result.artifacts[0].path, "rpc.json");
  await assert.rejects(validateLocalDrillResult({
    id: "rpc.failover", status: "PASS", observedOutcome: "x",
    artifacts: [{ kind: "RPC_RESPONSE", path: "/tmp/outside", sha256 }],
  }, "rpc.failover", root), /escapes/);
});
