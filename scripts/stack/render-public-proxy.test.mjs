import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseProxyArgs,
  renderPublicProxy,
  validateProxyInput,
} from "./render-public-proxy.mjs";

test("proxy input accepts one explicit domain or public IPv4-shaped identifier", () => {
  assert.deepEqual(
    validateProxyInput({
      host: "Preview.Example.com",
      mode: "domain",
      email: "ops@example.com",
    }),
    {
      host: "preview.example.com",
      mode: "domain",
      email: "ops@example.com",
    },
  );
  assert.equal(
    validateProxyInput({
      host: "1.1.1.1",
      mode: "ip",
      email: "ops@example.com",
    }).host,
    "1.1.1.1",
  );
  assert.throws(
    () =>
      validateProxyInput({
        host: "127.0.0.1",
        mode: "ip",
        email: "ops@example.com",
      }),
    /routable/,
  );
  assert.throws(
    () =>
      validateProxyInput({
        host: "127.0.0.1",
        mode: "domain",
        email: "ops@example.com",
      }),
    /DNS name/,
  );
  assert.throws(
    () =>
      validateProxyInput({
        host: "x; include /tmp/x",
        mode: "domain",
        email: "ops@example.com",
      }),
    /DNS name/,
  );
  assert.throws(
    () =>
      validateProxyInput({ host: "example.com", mode: "domain", email: "bad" }),
    /email/,
  );
  assert.throws(
    () =>
      validateProxyInput({
        host: "example.com",
        mode: "domain",
        email: "ops`id`@example.com",
      }),
    /email/,
  );
});

test("rendered proxy requires TLS/auth, strips credentials and bounds public routes", async () => {
  const boundary = await mkdtemp(join(tmpdir(), "cpredict-proxy-"));
  const result = await renderPublicProxy(
    {
      host: "preview.example.com",
      mode: "domain",
      email: "ops@example.com",
      output: join(boundary, "preview.example.com"),
    },
    { outputBoundary: boundary },
  );
  const config = await readFile(join(result.output, "cpredict.conf"), "utf8");
  assert.match(config, /listen 443 ssl http2/);
  assert.match(config, /auth_basic_user_file \/etc\/nginx\/cpredict\.htpasswd/);
  assert.match(config, /proxy_set_header Authorization ""/);
  assert.match(config, /location = \/rpc[\s\S]*limit_except POST/);
  assert.match(config, /location = \/indexer\/metrics[\s\S]*deny all/);
  assert.match(config, /location \/indexer\/[\s\S]*limit_except GET HEAD/);
  const metadataStart = config.indexOf("  location /metadata/ {");
  const metadataEnd = config.indexOf("\n  location /deployment/", metadataStart);
  assert.notEqual(metadataStart, -1);
  assert.notEqual(metadataEnd, -1);
  const metadataLocation = config.slice(metadataStart, metadataEnd);
  assert.match(metadataLocation, /limit_except GET HEAD POST/);
  assert.match(metadataLocation, /client_max_body_size 32k/);
  assert.match(metadataLocation, /limit_req zone=cpredict_read_api/);
  assert.match(metadataLocation, /proxy_pass http:\/\/127\.0\.0\.1:4177/);
  assert.match(config, /proxy_pass http:\/\/127\.0\.0\.1:4177/);
  assert.doesNotMatch(config, /unsafe-inline|unsafe-eval/);
  assert.match(config, /Strict-Transport-Security "max-age=86400"/);
  const issue = await readFile(
    join(result.output, "issue-certificate.sh"),
    "utf8",
  );
  assert.match(issue, /--domain preview\.example\.com/);
  assert.match(issue, /--email 'ops@example\.com'/);
  assert.match(issue, /systemctl enable --now nginx/);
  assert.match(issue, /certbot\.timer/);
  assert.match(issue, /snap\[\.\]certbot\[\.\]renew\[\.\]timer/);
  assert.match(issue, /silently expire/);
  assert.match(issue, /timer_units=/);
  assert.match(
    issue,
    /--connect-to 'preview\.example\.com:443:127\.0\.0\.1:443'/,
  );
  assert.doesNotMatch(issue, /preferred-profile shortlived/);
  const hook = await readFile(join(result.output, "renewal-hook.sh"), "utf8");
  assert.match(
    hook,
    /^#!\/usr\/bin\/env bash\n# Managed by the Cpredict public proxy\./,
  );
});

test("IP proxy material requests a short-lived public certificate and cannot escape runtime", async () => {
  const boundary = await mkdtemp(join(tmpdir(), "cpredict-proxy-"));
  const result = await renderPublicProxy(
    {
      host: "1.1.1.1",
      mode: "ip",
      email: "ops@example.com",
      output: join(boundary, "1.1.1.1"),
    },
    { outputBoundary: boundary },
  );
  const issue = await readFile(
    join(result.output, "issue-certificate.sh"),
    "utf8",
  );
  assert.match(issue, /--preferred-profile shortlived --ip-address 1\.1\.1\.1/);
  assert.match(issue, /Certbot 5\.4 or newer/);
  assert.match(issue, /--connect-to '1\.1\.1\.1:443:127\.0\.0\.1:443'/);
  await assert.rejects(
    renderPublicProxy(
      {
        host: "1.1.1.1",
        mode: "ip",
        email: "ops@example.com",
        output: join(boundary, "..", "escape"),
      },
      { outputBoundary: boundary },
    ),
    /must stay under/,
  );
});

test("proxy argument parser rejects missing, duplicate and unknown inputs", () => {
  assert.deepEqual(
    parseProxyArgs([
      "--host",
      "example.com",
      "--mode",
      "domain",
      "--email",
      "ops@example.com",
    ]),
    {
      host: "example.com",
      mode: "domain",
      email: "ops@example.com",
    },
  );
  assert.throws(
    () => parseProxyArgs(["--host", "example.com"]),
    /--mode is required/,
  );
  assert.throws(() => parseProxyArgs(["--wat", "x"]), /unknown option/);
  assert.throws(
    () => parseProxyArgs(["--host", "a.com", "--host", "b.com"]),
    /duplicate/,
  );
});
