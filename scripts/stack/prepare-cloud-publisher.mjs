#!/usr/bin/env node
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import {
  ensure,
  restrictedFile,
  run,
  sha256,
  validateUpdateConfig,
} from "./public-update-core.mjs";

// This optional one-time handoff contains only the reviewed endpoint/installer and a PUBLIC key.
// It is useful when the administrator console is available but administrator SSH is not.
const root = resolve(import.meta.dirname, "../..");
let stage;
try {
  const config = validateUpdateConfig(
    JSON.parse(
      await readFile(
        await restrictedFile(resolve(root, "runtime/public-site/update.json")),
        "utf8",
      ),
    ),
    root,
  );
  await restrictedFile(config.ssh.identityFile);
  const key = (
    await run("ssh-keygen", ["-y", "-f", config.ssh.identityFile], {
      label: "Derive publishing PUBLIC key",
    })
  ).trim();
  ensure(
    /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [A-Za-z0-9@._-]+)?$/.test(key),
    "Expected an Ed25519 publishing identity",
  );
  const revision = (
    await run("git", ["rev-parse", "HEAD"], { cwd: root })
  ).trim();
  ensure(/^[0-9a-f]{40}$/.test(revision), "Invalid source revision");
  ensure(
    !(
      await run("git", ["status", "--porcelain", "--untracked-files=no"], {
        cwd: root,
      })
    ).trim(),
    "Commit reviewed installer code before preparing the handoff",
  );
  const parent = resolve(root, "runtime/public-site/publisher-installation");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  stage = await mkdtemp(resolve(parent, "build-"));
  for (const name of ["cloud-publisher.py", "install-cloud-publisher.py"])
    await cp(resolve(root, "scripts/stack", name), resolve(stage, name));
  await writeFile(resolve(stage, "publisher.pub"), key + "\n", { mode: 0o644 });
  await writeFile(
    resolve(stage, "__main__.py"),
    `import sys, tempfile, zipfile, runpy
from pathlib import Path
with tempfile.TemporaryDirectory(prefix='cpredict-publisher-') as directory:
    root = Path(directory)
    with zipfile.ZipFile(sys.argv[0]) as archive:
        for name in ['cloud-publisher.py', 'install-cloud-publisher.py', 'publisher.pub']:
            (root/name).write_bytes(archive.read(name))
    sys.argv = [str(root/'install-cloud-publisher.py'), '--publisher', str(root/'cloud-publisher.py'), '--public-key', str(root/'publisher.pub')]
    runpy.run_path(str(root/'install-cloud-publisher.py'), run_name='__main__')
`,
  );
  const handoff = resolve(root, "runtime/public-site/static-handoff");
  await mkdir(handoff, { recursive: true, mode: 0o755 });
  await chmod(handoff, 0o755);
  const name = `publisher-install-${revision}.pyz`,
    output = resolve(handoff, name);
  await run("python3", [
    "-B",
    "-c",
    "import sys,zipfile,pathlib; root=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(sys.argv[2],'w',compression=zipfile.ZIP_DEFLATED); [z.write(root/name,name) for name in ['__main__.py','cloud-publisher.py','install-cloud-publisher.py','publisher.pub']]; z.close()",
    stage,
    output,
  ]);
  await chmod(output, 0o644);
  const digest = sha256(await readFile(output));
  const url = `${config.publicOrigin}/_static-handoff/${name}`;
  const python = `import urllib.request,hashlib,tempfile,pathlib,subprocess; b=urllib.request.urlopen(${JSON.stringify(url)},timeout=60).read(); assert hashlib.sha256(b).hexdigest()==${JSON.stringify(digest)},'package digest mismatch'; p=pathlib.Path(tempfile.mkdtemp(prefix='cpredict-publish-'))/'install.pyz'; p.write_bytes(b); subprocess.run(['sudo','python3',str(p)],check=True)`;
  const command = "python3 -c '" + python.replaceAll("'", "'\\''") + "'";
  const fingerprint = (
    await run("ssh-keygen", ["-lf", resolve(stage, "publisher.pub")])
  )
    .trim()
    .split(/\s+/)[1];
  const report = {
    version: 1,
    sourceCommit: revision,
    url,
    sha256: digest,
    publicKeyFingerprint: fingerprint,
    command,
  };
  await writeFile(
    resolve(handoff, "publisher-install.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o644 },
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    error.code
      ? `Publisher preparation failed (${error.code}); private paths withheld`
      : error.message,
  );
  process.exitCode = 1;
} finally {
  if (stage) await rm(stage, { recursive: true });
}
