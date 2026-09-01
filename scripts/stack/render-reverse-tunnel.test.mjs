import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseReverseTunnelArgs,
  renderReverseTunnelPackage,
  validateReverseTunnelInput,
} from "./render-reverse-tunnel.mjs";

const fingerprint = `SHA256:${"A".repeat(43)}`;

test("reverse-tunnel input is explicit, public and host-key pinned", () => {
  assert.deepEqual(
    validateReverseTunnelInput({
      host: "1.1.1.1",
      mode: "ip",
      email: "ops@example.com",
      hostKeySha256: fingerprint,
    }),
    {
      host: "1.1.1.1",
      mode: "ip",
      email: "ops@example.com",
      sshHost: "1.1.1.1",
      sshPort: 22,
      hostKeySha256: fingerprint,
    },
  );
  assert.equal(
    validateReverseTunnelInput({
      host: "preview.example.com",
      mode: "domain",
      email: "ops@example.com",
      sshHost: "ssh.example.com",
      sshPort: "2222",
      hostKeySha256: fingerprint,
    }).sshPort,
    2222,
  );
  assert.throws(
    () =>
      validateReverseTunnelInput({
        host: "1.1.1.1",
        mode: "ip",
        email: "ops@example.com",
        sshHost: "127.0.0.1",
        hostKeySha256: fingerprint,
      }),
    /routable/,
  );
  assert.throws(
    () =>
      validateReverseTunnelInput({
        host: "1.1.1.1",
        mode: "ip",
        email: "ops@example.com",
        sshPort: "0",
        hostKeySha256: fingerprint,
      }),
    /1 to 65535/,
  );
  assert.throws(
    () =>
      validateReverseTunnelInput({
        host: "1.1.1.1",
        mode: "ip",
        email: "ops@example.com",
        hostKeySha256: "SHA256:bad",
      }),
    /fingerprint/,
  );
});

test("argument parser rejects implicit, duplicate and unknown configuration", () => {
  assert.equal(
    parseReverseTunnelArgs([
      "--host",
      "1.1.1.1",
      "--mode",
      "ip",
      "--email",
      "ops@example.com",
      "--host-key-sha256",
      fingerprint,
    ]).host,
    "1.1.1.1",
  );
  assert.throws(
    () => parseReverseTunnelArgs(["--host", "1.1.1.1"]),
    /--mode is required/,
  );
  assert.throws(
    () => parseReverseTunnelArgs(["--host", "1.1.1.1", "--host", "8.8.8.8"]),
    /duplicate/,
  );
  assert.throws(() => parseReverseTunnelArgs(["--wat", "x"]), /unknown option/);
});

test("rendered package constrains SSH, pins the host, persists launchd and verifies checksums", async (t) => {
  const boundary = await mkdtemp(join(tmpdir(), "cpredict-reverse-tunnel-"));
  t.after(async () => rm(boundary, { recursive: true, force: true }));
  const output = join(boundary, "1.1.1.1");
  const result = await renderReverseTunnelPackage(
    {
      host: "1.1.1.1",
      mode: "ip",
      email: "ops@example.com",
      sshPort: "2222",
      hostKeySha256: fingerprint,
      output,
    },
    { outputBoundary: boundary },
  );
  assert.equal(result.files.length, 12);

  const sshd = await readFile(
    join(output, "cloud/sshd-cpredict-tunnel.conf"),
    "utf8",
  );
  assert.match(sshd, /GatewayPorts no/);
  assert.match(sshd, /AllowTcpForwarding remote/);
  assert.match(sshd, /PermitListen 127\.0\.0\.1:4177/);
  assert.match(sshd, /MaxSessions 0/);
  assert.match(sshd, /Match all/);
  assert.doesNotMatch(sshd, /GatewayPorts yes|AllowTcpForwarding yes/);

  const cloud = await readFile(
    join(output, "cloud/cpredict-tunnel-cloud"),
    "utf8",
  );
  assert.match(cloud, /restrict,port-forwarding,permitlisten=/);
  assert.match(cloud, /effective sshd policy is missing/);
  assert.match(cloud, /managed path must not be a symlink/);
  assert.match(cloud, /--public-key-file and --basic-auth-user/);
  assert.match(cloud, /Ubuntu 24\.04 only/);
  assert.match(cloud, /unbounded uninstall/);
  assert.match(cloud, /userdel --remove "\$tunnel_user"/);
  assert.doesNotMatch(cloud, /rm -rf|PasswordAuthentication yes/);

  const mac = await readFile(join(output, "macos/cpredict-tunnel"), "utf8");
  const worker = await readFile(
    join(output, "macos/cpredict-tunnel-worker"),
    "utf8",
  );
  const plist = await readFile(
    join(output, "macos/com.cpredict.reverse-tunnel.plist.template"),
    "utf8",
  );
  assert.match(mac, new RegExp(fingerprint));
  assert.match(mac, /Strict|verify_host_key/);
  assert.match(mac, /--install-autossh/);
  assert.match(
    mac,
    /deploy-cloud requires --admin-user, --admin-key and --basic-auth-user/,
  );
  assert.match(mac, /\/usr\/bin\/scp/);
  assert.match(mac, /StrictHostKeyChecking=yes/);
  assert.match(mac, /remote package checksum verification failed/);
  assert.match(mac, /start and verify Compose before upload/);
  assert.match(mac, /CPREDICT REVERSE TUNNEL DEPLOY PASS/);
  assert.match(mac, /uninstall --delete-key/);
  assert.match(mac, /managed path must not be a symlink/);
  assert.match(worker, /\/usr\/bin\/caffeinate -s -w/);
  assert.match(worker, /ServerAliveInterval=30/);
  assert.match(worker, /StrictHostKeyChecking=yes/);
  assert.match(worker, /-R 127\.0\.0\.1:4177:127\.0\.0\.1:4177/);
  assert.match(worker, /tunnel_user="cpredict-tunnel"/);
  assert.match(worker, /ssh_host="1\.1\.1\.1"/);
  assert.match(worker, /tunnel_target="\$\{tunnel_user\}@\$\{ssh_host\}"/);
  assert.match(worker, /\n  "\$tunnel_target"\n/);
  assert.match(plist, /<key>KeepAlive<\/key>[\s\S]*<true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>[\s\S]*<true\/>/);

  for (const script of [
    "cloud/cpredict-tunnel-cloud",
    "cloud/proxy/issue-certificate.sh",
    "cloud/proxy/renewal-hook.sh",
    "macos/cpredict-tunnel",
    "macos/cpredict-tunnel-worker",
    "verify-package.sh",
  ])
    execFileSync("bash", ["-n", join(output, script)]);
  execFileSync("bash", [join(output, "verify-package.sh")]);
  assert.equal(
    (await stat(join(output, "macos/cpredict-tunnel"))).mode & 0o777,
    0o700,
  );
  assert.equal((await stat(join(output, "SHA256SUMS"))).mode & 0o777, 0o600);
});

test("renderer refuses overwrite and output escape", async (t) => {
  const boundary = await mkdtemp(join(tmpdir(), "cpredict-reverse-tunnel-"));
  t.after(async () => rm(boundary, { recursive: true, force: true }));
  const input = {
    host: "1.1.1.1",
    mode: "ip",
    email: "ops@example.com",
    hostKeySha256: fingerprint,
    output: join(boundary, "package"),
  };
  await renderReverseTunnelPackage(input, { outputBoundary: boundary });
  await assert.rejects(
    renderReverseTunnelPackage(input, { outputBoundary: boundary }),
    /already exists/,
  );
  await assert.rejects(
    renderReverseTunnelPackage(
      { ...input, output: join(boundary, "..", "escape") },
      {
        outputBoundary: boundary,
      },
    ),
    /must be a child/,
  );
});
