import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSourceRevision,
  readSourceRevision,
} from "./source-revision.mjs";

const REVISION = "0fb5a1962d17bda07ed627035c21ffb9765af68a";

test("source revision parser accepts only an exact lowercase Git SHA", () => {
  assert.equal(parseSourceRevision(` ${REVISION}\n`), REVISION);
  for (const value of [
    "",
    REVISION.slice(0, 12),
    REVISION.toUpperCase(),
    `${REVISION}dirty`,
    "g".repeat(40),
  ])
    assert.throws(() => parseSourceRevision(value), /exact lowercase/);
});

test("source revision reader resolves HEAD and fails closed on Git errors", () => {
  const calls = [];
  assert.equal(
    readSourceRevision({
      root: "/repo",
      run(command, args, cwd) {
        calls.push({ command, args, cwd });
        return { code: 0, stdout: `${REVISION}\n`, stderr: "" };
      },
    }),
    REVISION,
  );
  assert.deepEqual(calls, [
    {
      command: "git",
      args: ["rev-parse", "--verify", "HEAD^{commit}"],
      cwd: "/repo",
    },
  ]);
  assert.throws(
    () =>
      readSourceRevision({
        run: () => ({ code: 128, stdout: "", stderr: "not a repository" }),
      }),
    /unable to resolve/,
  );
});
