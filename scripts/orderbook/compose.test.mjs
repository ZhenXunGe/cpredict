import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("automation lanes have separate private environments and signer mounts with no public ports", async () => {
  const compose = JSON.parse(await readFile("compose.automation.yaml", "utf8"));
  const claims = compose.services["automatic-claims"],
    matching = compose.services["automatic-matching"];
  for (const [lane, service] of [
    ["claims", claims],
    ["matching", matching],
  ]) {
    assert.equal(service.environment.CPREDICT_AUTOMATION_LANE, lane);
    assert.deepEqual(service.profiles, ["automation"]);
    assert.equal(service.ports, undefined);
    assert.equal(service.read_only, true);
    assert.equal(service.user, "1000:1000");
    assert.equal(service.env_file.length, 1);
    assert.match(service.env_file[0], new RegExp(lane.toUpperCase()));
    assert.match(service.volumes[1], new RegExp(lane.toUpperCase()));
    assert.ok(service.volumes.every((v) => v.endsWith(":ro")));
    assert.ok(
      service.healthcheck.test.at(-1).includes("127.0.0.1:8815/readyz"),
    );
  }
  assert.notDeepEqual(claims.env_file, matching.env_file);
  const image = await readFile("deploy/compose/Dockerfile.offchain", "utf8");
  assert.match(image, /COPY[^\n]*dist\/offchain\/workers/);
  assert.match(image, /FROM indexer AS automation/);
});
