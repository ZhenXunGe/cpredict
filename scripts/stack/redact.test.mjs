import assert from "node:assert/strict";
import test from "node:test";
import { redactStackLogs } from "./redact.mjs";

test("stack logs redact exact and URL-encoded server secrets", () => {
  const secret = "rpc key/with spaces";
  const output = redactStackLogs(
    `plain=${secret} encoded=${encodeURIComponent(secret)} public=421614`,
    { ARBITRUM_SEPOLIA_RPC_URL: secret },
  );
  assert.doesNotMatch(output, /rpc key|rpc%20key/);
  assert.match(output, /public=421614/);
});
