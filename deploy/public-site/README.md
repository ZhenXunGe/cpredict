# Existing Mac stack and cloud static publisher

This profile updates the existing ctUSD deployment. The Mac continues to run
PostgreSQL, indexer, metadata, app-service and the `web-demo` gateway. The cloud
edge terminates HTTPS, proxies HTML/configuration/APIs through the existing
reverse tunnel, and serves hashed `/assets/` files locally. Application source,
database contents and provider credentials are never uploaded to the edge.

## Routine deployment

Run in the deployment machine's existing `main` checkout:

```sh
npm run stack:update:public
```

The command obtains an exclusive lock, refuses tracked local edits/divergence,
fetches `origin/main`, fast-forwards and loads the newly pulled runner. It checks
the restricted publishing connection before installing locked dependencies or
building candidate images. Existing ignored runtime inputs remain in place.

It exports only candidate public assets plus a digest manifest, verifies the
archive on the cloud, and performs full public GET/digest checks for every file
before switching HTML. It then stops the three database writers, uses the existing
three-database backup and disposable restore verification, applies the existing
incremental SQL, and updates the four application services with exact image IDs.
PostgreSQL is not recreated. Runtime input digests, the PostgreSQL container and
volume, service health, public HTML, redirects, protected paths and auth responses
are checked before recording success. A repeated successful revision verifies
the current public state without restarting services.

Candidate Compose files preserve the already escaped output of `docker compose
config --format json`. Raw Docker inspect snapshots used for rollback are escaped
once separately. These inputs must not share a second escaping pass: Compose
[already escapes dollar signs when rendering configuration](https://github.com/docker/compose/blob/v2.32.4/cmd/compose/config.go#L154-L156).
Validate both paths against Docker Engine using literal `$`, `${...}`, repeated
dollar signs, quotes and newlines; a successful Compose syntax check alone does
not prove that the container environment retains its original values.
Rollback also retains explicit IPv4/IPv6 and link-local addresses from each
container's `IPAMConfig`, including the gateway address used by trusted-proxy
settings. Dynamically assigned container addresses remain dynamic.

Failures after stopping writers restore their previous running image IDs and
configuration, verify the old public page and asset hashes, and restore the
publisher's release marker. This does **not** restore a database backup over new
operations, delete uploaded hashes, or replay financial operations. Migrations
must remain compatible with the previous application version; incompatible
schema, PostgreSQL image or additional writer/topology changes require their own
reviewed upgrade. Such work must not be reported as a routine update passing.

```sh
npm run stack:update:public -- check
npm run stack:update:public -- recover
npm run stack:update:public -- rollback
```

`check` verifies the active release without switching it. `recover` reconciles an
interrupted run using its durable record and restores the previous services if
they were touched; it can reclaim a lock only when its same-host owner process is
dead. `rollback` explicitly restores the immediately preceding verified service
configuration. Ordinary updates refuse an incomplete record. If rollback itself
cannot be verified, the record stays `recovery-required` and the command fails.

Evidence and exact private rollback Compose files are saved below
`runtime/public-site/updates/` with private permissions. Keep the backup and old
images until a subsequent version is accepted. Use existing backup retention
tools; this command never prunes database volumes or old static assets.

## One-time machine preparation

1. Use a dedicated Ed25519 publishing identity on the deployment Mac. Keep its
   private file local and restricted; do not reuse the reverse tunnel identity.
   Pin the cloud host key after verifying its fingerprint through the existing
   administrator channel. Never use `StrictHostKeyChecking=no` or trust an
   unverified `ssh-keyscan` result.
2. Copy `deploy/public-site/update.example.json` to
   `runtime/public-site/update.json`, fill the existing identity and verified
   known-hosts references locally, and set mode 0600. Do not paste that private
   configuration into a task or commit it. `publicOrigin` is the actual HTTPS
   origin; `localOrigin` is the gateway's existing loopback endpoint.
3. Put only permanent deployment differences in
   `runtime/public-site/update.override.json` (0600). It supplements the current
   `compose.yaml` and `compose.public-site.yaml`. Do not pin old `image` or `build`
   values, reference a retired Compose file, alter private credentials, or change
   feature flags merely to make an update pass. An empty override is
   `{"services":{}}`. The command reconstructs rollback from the actual running
   containers, so deleted historical Compose files are not a dependency.
4. On the cloud, use the existing administrator connection once to copy and
   review the two Python scripts from this exact source revision and the Mac's
   **public** key. Run:

   ```sh
   sudo python3 install-cloud-publisher.py --publisher cloud-publisher.py --public-key publisher.pub
   ```

   The installer creates `cpredict-publish`, installs a root-owned fixed-command
   endpoint, disables forwarding/PTY/password access, verifies effective SSH
   settings and nginx configuration, and reloads SSH. It copies existing static
   hashes before repointing `/var/www/cpredict-edge/current` to the shared asset
   directory. Existing HTTPS, reverse tunnel and backend services are preserved.
   The original static target is recorded in a root-only installation record.
   It refuses conflicting existing SSH restrictions rather than weakening them.

If only the authenticated cloud web terminal is usable, run
`npm run stack:publisher:prepare` on the deployment machine. It prepares a
temporary public zipapp containing exactly the two reviewed Python files, a
loader, and the publishing **public** key, then prints one installation command
for that terminal. The command validates the package digest over HTTPS before
running it. The existing gateway must serve its `static-handoff` mount; verify
the generated URL before forwarding the command. No private identity or runtime
configuration enters the package. After successful installation and deployment,
remove the generated `publisher-install-<commit>.pyz` and `publisher-install.json`
from that public handoff directory. Routine updates do not use this bridge.

Only `status`, bounded `upload <sha256> <bytes>` and compare-and-swap
`activate <sha256> <previous-sha256-or-none>` are accepted. Uploaded archives cannot
contain scripts for execution, symlinks, traversal, source maps or client-supplied
gzip alternatives. Hashed filename collisions are rejected. Old assets remain
available for open browser tabs and rollback. SSH restrictions follow the
[OpenSSH authorized-key](https://man.openbsd.org/sshd.8) and
[server configuration](https://man.openbsd.org/sshd_config) documentation.

## Acceptance boundary

`npm run test:stack-tools` includes the publication protocol's archive, integrity,
idempotency, command-denial and rollback-retention tests, plus update configuration,
Compose literal-value and running-image snapshot tests. These are local evidence.
Mark deployment acceptance complete only after the dedicated identity succeeds
from the real deployment machine, forbidden commands fail, an update and a repeat
check succeed against real HTTPS, and service rollback is verified. A build or
local test never proves that the cloud account has been installed.

The existing PC real-wallet/zero-ETH ctUSD acceptance remains separate. This
deployment tool does not establish USDC or physical mobile-wallet acceptance.
