import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("host Node bootstrap is explicit, version/checksum pinned and overwrite-safe", async () => {
  const script = await readFile(
    new URL("deploy/host/bootstrap-node.sh", root),
    "utf8",
  );
  assert.match(script, /NODE_VERSION="22\.22\.2"/);
  assert.match(
    script,
    /88fd1ce767091fd8d4a99fdb2356e98c819f93f3b1f8663853a2dee9b438068a/,
  );
  assert.match(script, /\$\{1:-\} != "--apply"/);
  assert.match(script, /refusing to overwrite/);
  assert.match(script, /--proto '=https' --tlsv1\.2/);
  assert.doesNotMatch(script, /\.bashrc|\.zshrc|\/etc\/profile/);
});

test("backup timer requires verified backup before bounded retention and uses service hardening", async () => {
  const service = await readFile(
    new URL("deploy/host/systemd/cpredict-backup.service.template", root),
    "utf8",
  );
  const timer = await readFile(
    new URL("deploy/host/systemd/cpredict-backup.timer", root),
    "utf8",
  );
  assert.ok(
    service.indexOf("stack:backup:verified") <
      service.indexOf("stack:backup:prune"),
  );
  assert.match(service, /--keep 14 --minimum-age-days 7 --apply/);
  assert.match(service, /NoNewPrivileges=true/);
  assert.match(service, /ProtectSystem=strict/);
  assert.match(service, /ReadWritePaths=@@REPO_ROOT@@\/runtime/);
  assert.match(timer, /Persistent=true/);
  assert.match(timer, /RandomizedDelaySec=30m/);
});

test("single-host runbook retains every fail-closed handoff gate", async () => {
  const runbook = await readFile(
    new URL("docs/zh/14-single-host-deployment-runbook.md", root),
    "utf8",
  );
  for (const pattern of [
    /stack:preflight -- runtime --network/,
    /stack:verify/,
    /stack:backup:verified/,
    /stack:checkpoint/,
    /certbot renew --dry-run/,
    /BROADCAST_FAILED_REQUIRES_INSPECTION/,
    /未认证 `401`/,
    /实际重启/,
  ])
    assert.match(runbook, pattern);
  assert.doesNotMatch(runbook, /--broadcast broadcast\/DeployArbitrumSepolia/);
});

test("reverse-tunnel runbook keeps identity, loopback and recovery gates explicit", async () => {
  const runbook = await readFile(
    new URL("docs/zh/15-reverse-tunnel-deployment-runbook.md", root),
    "utf8",
  );
  for (const pattern of [
    /stack:tunnel:render/,
    /host-key-sha256/,
    /--defer-start/,
    /deploy-cloud/,
    /SCP 上传/,
    /CPREDICT REVERSE TUNNEL DEPLOY PASS/,
    /127\.0\.0\.1:4177/,
    /cpredict-tunnel-cloud verify/,
    /本机重启/,
    /云机重启/,
    /断网/,
    /uninstall --delete-key/,
  ])
    assert.match(runbook, pattern);
  assert.match(runbook, /不得.*4177|4177.*不得/);
});
