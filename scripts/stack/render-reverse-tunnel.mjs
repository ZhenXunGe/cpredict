#!/usr/bin/env node
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderPublicProxy,
  validateProxyInput,
} from "./render-public-proxy.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUTPUT_BOUNDARY = resolve(ROOT, "runtime/reverse-tunnel");
const TEMPLATE_ROOT = resolve(ROOT, "deploy/host/reverse-tunnel");
const TUNNEL_USER = "cpredict-tunnel";
const LOCAL_PORT = 4177;
const REMOTE_PORT = 4177;
const HOST_KEY = /^SHA256:[A-Za-z0-9+/]{43}$/;

export function parseReverseTunnelArgs(argv) {
  const output = {};
  const keys = {
    "--host": "host",
    "--mode": "mode",
    "--email": "email",
    "--ssh-host": "sshHost",
    "--ssh-port": "sshPort",
    "--host-key-sha256": "hostKeySha256",
    "--output": "output",
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${flag}: missing value`);
    const key = keys[flag];
    if (key === undefined) throw new Error(`unknown option ${flag}`);
    if (Object.hasOwn(output, key)) throw new Error(`duplicate option ${flag}`);
    output[key] = value;
  }
  for (const key of ["host", "mode", "email", "hostKeySha256"])
    if (!Object.hasOwn(output, key))
      throw new Error(`--${toKebab(key)} is required`);
  return output;
}

export function validateReverseTunnelInput(input) {
  const publicProxy = validateProxyInput(input);
  const sshHost = (input.sshHost ?? publicProxy.host).toLowerCase();
  const sshMode = isIP(sshHost) === 4 ? "ip" : "domain";
  validateProxyInput({ host: sshHost, mode: sshMode, email: input.email });
  const sshPortText = input.sshPort ?? "22";
  if (!/^[1-9][0-9]{0,4}$/.test(sshPortText))
    throw new Error("--ssh-port must be an integer from 1 to 65535");
  const sshPort = Number(sshPortText);
  if (sshPort > 65535)
    throw new Error("--ssh-port must be an integer from 1 to 65535");
  if (!HOST_KEY.test(input.hostKeySha256))
    throw new Error(
      "--host-key-sha256 must be one OpenSSH SHA256 Ed25519 fingerprint",
    );
  return {
    ...publicProxy,
    sshHost,
    sshPort,
    hostKeySha256: input.hostKeySha256,
  };
}

export async function renderReverseTunnelPackage(
  input,
  { outputBoundary = OUTPUT_BOUNDARY } = {},
) {
  const value = validateReverseTunnelInput(input);
  const target = resolve(
    ROOT,
    input.output ?? relative(ROOT, resolve(outputBoundary, value.host)),
  );
  assertWithin(target, outputBoundary);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(
    join(dirname(target), ".cpredict-reverse-tunnel-"),
  );
  try {
    try {
      await lstat(target);
      throw new Error(`output already exists: ${target}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const cloudDir = join(staging, "cloud");
    const macDir = join(staging, "macos");
    await mkdir(cloudDir, { recursive: true, mode: 0o700 });
    await mkdir(macDir, { recursive: true, mode: 0o700 });
    await renderPublicProxy(
      { ...value, output: join(cloudDir, "proxy") },
      { outputBoundary: staging },
    );

    const replacements = {
      "@@PUBLIC_HOST@@": value.host,
      "@@SSH_HOST@@": value.sshHost,
      "@@SSH_PORT@@": String(value.sshPort),
      "@@HOST_KEY_SHA256@@": value.hostKeySha256,
      "@@TUNNEL_USER@@": TUNNEL_USER,
      "@@LOCAL_PORT@@": String(LOCAL_PORT),
      "@@REMOTE_PORT@@": String(REMOTE_PORT),
    };
    const renderedFiles = [
      [
        "sshd.conf.template",
        join(cloudDir, "sshd-cpredict-tunnel.conf"),
        0o600,
      ],
      ["cloud-cli.sh.template", join(cloudDir, "cpredict-tunnel-cloud"), 0o700],
      ["macos-cli.sh.template", join(macDir, "cpredict-tunnel"), 0o700],
      [
        "macos-worker.sh.template",
        join(macDir, "cpredict-tunnel-worker"),
        0o700,
      ],
      [
        "launchd.plist.template",
        join(macDir, "com.cpredict.reverse-tunnel.plist.template"),
        0o600,
      ],
      ["README.md.template", join(staging, "README.md"), 0o600],
      ["verify-package.sh.template", join(staging, "verify-package.sh"), 0o700],
    ];
    for (const [template, output, mode] of renderedFiles) {
      const contents = replaceAll(
        await readFile(join(TEMPLATE_ROOT, template), "utf8"),
        replacements,
      );
      await writeFile(output, contents, { mode, flag: "wx" });
    }

    const paths = await collectFiles(staging);
    const checksums = [];
    for (const path of paths.sort()) {
      const contents = await readFile(join(staging, path));
      checksums.push(
        `${createHash("sha256").update(contents).digest("hex")}  ${path}`,
      );
    }
    await writeFile(join(staging, "SHA256SUMS"), `${checksums.join("\n")}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(staging, target);
    return {
      output: target,
      files: [...paths, "SHA256SUMS"].sort(),
      ...value,
      tunnelUser: TUNNEL_USER,
      localPort: LOCAL_PORT,
      remotePort: REMOTE_PORT,
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function collectFiles(root, directory = root) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await collectFiles(root, path)));
    else if (entry.isFile()) output.push(relative(root, path));
    else
      throw new Error(
        `generated package contains a non-regular entry: ${path}`,
      );
  }
  return output;
}

function replaceAll(source, replacements) {
  let output = source;
  for (const [token, value] of Object.entries(replacements))
    output = output.replaceAll(token, value);
  if (/@@[A-Z_]+@@/.test(output))
    throw new Error("unresolved reverse-tunnel template token");
  return output;
}

function assertWithin(path, parent) {
  const child = relative(parent, path);
  if (
    child === "" ||
    child === "." ||
    child.startsWith("..") ||
    child.startsWith("/")
  )
    throw new Error(
      "reverse-tunnel output must be a child of runtime/reverse-tunnel",
    );
}

function toKebab(value) {
  return value.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  renderReverseTunnelPackage(parseReverseTunnelArgs(process.argv.slice(2)))
    .then((result) =>
      process.stdout.write(`REVERSE TUNNEL PACKAGE ${result.output}\n`),
    )
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
