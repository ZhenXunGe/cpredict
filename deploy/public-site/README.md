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
the restricted publishing connection, then prints an **UPDATE PLAN** before any
image build, service switch, backup or migration. Locked host tools are installed
when their lockfile changes; configuration validators are compiled before an
actual update. These host checks do not build or restart backend containers.

The plan compares each running component with its own deployed input fingerprint,
not the repository's last commit. Components can retain different verified source
revisions. Static/type imports, re-exports and literal lazy imports are followed
with the Babel TypeScript/JSX parser. Shared modules, consumed ABI files, relevant
Docker stages, build tooling and the installed dependency closure are included.
Unresolved aliases or non-literal dynamic imports fail planning rather than being
silently omitted. Deployment-only npm tools, documentation and tests do not
invalidate application images. Shared runtime dependencies can select multiple
consumers; the current offchain graph connects indexer and app-service.

| Change | Ordinary update actions |
| --- | --- |
| Frontend | Build `web-demo`, upload/verify assets, replace only that gateway |
| One backend | Build/replace that component and affected code consumers; retain frontend release |
| Runtime configuration | Replace only consumers, reuse their image, pin private bind inputs for rollback |
| Pending SQL | Back up affected databases, pause only their writers, run pending migration groups, resume their exact selected images |
| Documentation/tests/tools | Verify the existing deployment without rebuilding or restarting it |
| Contract source | Report a separate chain release; never broadcast from this command |
| Persisted projection or contract plus ABI changes | Stop before publication and report the required maintenance/compatibility work |

For a frontend-only release there is no database backup, SQL execution or backend
restart. For a backend-only release there is no frontend asset upload or HTML
release-marker change. A no-op does not replace the previous rollback record.
Unchanged container IDs, image IDs and start times are verified, including
PostgreSQL and the preview. Gateway reloads may still refresh upstream addresses.

Inspect the current committed checkout against the running deployment without
pulling, building, writing SQL, publishing assets or restarting services:

```sh
npm run stack:update:public -- plan
```

Install the locked npm tools first if using `plan` on a fresh checkout. Normal
`update` performs this preparation automatically, including adoption from the
previous bootstrap. Preview reports `buildServices`, `updateServices`,
`retainServices`, `stopWriters`, `backupDatabases`, `migrationServices`, notices
and blockers. An already outdated database can legitimately add pending SQL to
the plan even when the latest commit itself contains only frontend changes.

SQL selection uses the existing `public_site_migrations` registry in each
database. Applied SQL may not be removed or edited. New SQL must have its SHA-256
listed in `update-policy.json` after review for idempotence and compatibility with
the previous application version; otherwise publication stops. Migration inputs
are materialized from the committed, reviewed inventory before execution; extra
local SQL files are not executed. The indexer database has two writers (indexer
and app-service); metadata has one. The unused paymaster database has none in
this profile. Additional running writers require another update profile.

Routine migration backups retain explicit database inventories and validate
checksums and `pg_restore --list`. They do **not** run a full disposable restore
drill on every release. Keep `stack:backup:verified` / `stack:restore-drill` for
initial acceptance, backup/recovery changes and planned recovery exercises.
The restore tool reads old complete v1/v2 archives and new scoped v3 archives;
v3 requires an explicit database inventory and must not be treated as a full backup.

Runtime input snapshots and component versions are stored privately in
`runtime/public-site/updates/active.json`. Configuration rollback mounts the saved
old bytes; it does not overwrite the operator's desired input files. The next
update therefore sees those desired changes again. Snapshot digests are checked
before rollback; edited or missing snapshots stop recovery before a service switch.
The existing public `/_static-handoff/` mount remains live output, so publishing a
progress file neither selects an application update nor gets undone by rollback.
First adoption uses running
image revision labels and available Git objects, and requires private inputs to
match the previous v1 journal where one exists. Missing provenance is an error,
not a reason to silently replace everything. PostgreSQL image, provisioning and
credential changes require a separate database upgrade.

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
After replacing or restoring backends, the command validates and gracefully
reloads the existing gateway and any running preview Nginx, then waits for their
indexer and metadata routes to respond. This refreshes cached backend addresses
without recreating the preview container or altering its configuration.

Failures restore only services recorded as touched by this update, verify the
old public page and asset hashes, and restore the publisher's release marker if
the frontend changed. v1 journals retain their original recovery behavior.
This does **not** restore a database backup over new
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
dead. `rollback` explicitly restores the services affected by the latest actual
update. Repeated rollback only verifies the completed result. Ordinary updates
refuse an incomplete record. If rollback itself
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
