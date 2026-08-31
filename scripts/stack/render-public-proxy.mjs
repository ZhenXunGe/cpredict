#!/usr/bin/env node
import { isIP } from "node:net";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUTPUT_BOUNDARY = resolve(ROOT, "runtime/host-proxy");
const DOMAIN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const EMAIL = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

export function parseProxyArgs(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${flag}: missing value`);
    const key = {
      "--host": "host",
      "--mode": "mode",
      "--email": "email",
      "--output": "output",
    }[flag];
    if (key === undefined) throw new Error(`unknown option ${flag}`);
    if (Object.hasOwn(output, key)) throw new Error(`duplicate option ${flag}`);
    output[key] = value;
  }
  for (const key of ["host", "mode", "email"])
    if (!Object.hasOwn(output, key)) throw new Error(`--${key} is required`);
  return output;
}

export function validateProxyInput({ host, mode, email }) {
  const normalizedHost = host.toLowerCase();
  if (!EMAIL.test(email))
    throw new Error("--email must be a valid ACME contact address");
  if (mode === "ip") {
    if (isIP(normalizedHost) !== 4 || !isPublicIpv4(normalizedHost))
      throw new Error("IP mode requires one routable public IPv4 address");
  } else if (mode === "domain") {
    if (!DOMAIN.test(normalizedHost))
      throw new Error("domain mode requires one lowercase public DNS name");
  } else throw new Error("--mode must be domain or ip");
  return { host: normalizedHost, mode, email };
}

export async function renderPublicProxy(
  input,
  { outputBoundary = OUTPUT_BOUNDARY } = {},
) {
  const value = validateProxyInput(input);
  const output = resolve(
    ROOT,
    input.output ?? relative(ROOT, resolve(outputBoundary, value.host)),
  );
  assertWithin(output, outputBoundary);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const replacements = {
    "@@PUBLIC_HOST@@": value.host,
    "@@CERT_NAME@@": value.host,
  };
  const bootstrap = replaceAll(
    await readFile(
      resolve(ROOT, "deploy/host/nginx/bootstrap.conf.template"),
      "utf8",
    ),
    replacements,
  );
  const proxy = replaceAll(
    await readFile(
      resolve(ROOT, "deploy/host/nginx/cpredict.conf.template"),
      "utf8",
    ),
    replacements,
  );
  const files = {
    "bootstrap.conf": bootstrap,
    "cpredict.conf": proxy,
    "issue-certificate.sh": issueScript(value),
    "renewal-hook.sh": renewalHook(),
  };
  for (const [name, contents] of Object.entries(files))
    await atomicWrite(
      resolve(output, name),
      contents,
      name.endsWith(".sh") ? 0o700 : 0o600,
    );
  return { output, files: Object.keys(files), ...value };
}

function issueScript({ host, mode, email }) {
  const certificateArgs =
    mode === "ip"
      ? `--preferred-profile shortlived --ip-address ${host}`
      : `--domain ${host}`;
  const versionCheck =
    mode === "ip"
      ? `
certbot_version="$(certbot --version 2>&1 | sed -E 's/[^0-9]*([0-9]+\\.[0-9]+).*/\\1/')"
if ! printf '%s\\n%s\\n' "5.4" "$certbot_version" | sort -VC; then
  echo "IP certificates require Certbot 5.4 or newer; found $certbot_version" >&2
  exit 1
fi
`
      : "";
  return `#!/usr/bin/env bash
set -Eeuo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin

if [[ $EUID -ne 0 ]]; then
  echo "run this installer as root" >&2
  exit 1
fi
for command in nginx certbot htpasswd systemctl install curl grep sed sort stat dirname; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done
if [[ -e /etc/nginx/sites-enabled/default ]]; then
  echo "disable the default nginx site after reviewing it; refusing to change it automatically" >&2
  exit 1
fi
if [[ ! -s /etc/nginx/cpredict.htpasswd ]]; then
  echo "create /etc/nginx/cpredict.htpasswd with: htpasswd -c /etc/nginx/cpredict.htpasswd <user>" >&2
  exit 1
fi
if [[ $(stat -c '%a' /etc/nginx/cpredict.htpasswd) != 640 && $(stat -c '%a' /etc/nginx/cpredict.htpasswd) != 600 ]]; then
  echo "/etc/nginx/cpredict.htpasswd must use mode 0600 or 0640" >&2
  exit 1
fi
${versionCheck}
script_dir="$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" && pwd)"
install -d -m 0755 /var/www/cpredict-acme
install -m 0644 "$script_dir/bootstrap.conf" /etc/nginx/conf.d/cpredict.conf
nginx -t
systemctl enable --now nginx
systemctl reload nginx
certbot certonly --non-interactive --agree-tos --no-eff-email \
  --email ${shellQuote(email)} --cert-name ${host} --webroot --webroot-path /var/www/cpredict-acme \
  ${certificateArgs}
install -m 0644 "$script_dir/cpredict.conf" /etc/nginx/conf.d/cpredict.conf
install -m 0755 "$script_dir/renewal-hook.sh" /etc/letsencrypt/renewal-hooks/deploy/reload-cpredict-nginx
nginx -t
systemctl reload nginx
timer_units="$(systemctl list-unit-files --type=timer --no-legend 2>/dev/null)"
if grep -q '^certbot[.]timer' <<< "$timer_units"; then
  systemctl enable --now certbot.timer
elif grep -q '^snap[.]certbot[.]renew[.]timer' <<< "$timer_units"; then
  systemctl start snap.certbot.renew.timer
else
  echo "no Certbot renewal timer found; refusing an installation that will silently expire" >&2
  exit 1
fi
status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --connect-to '${host}:443:127.0.0.1:443' "https://${host}/readyz")"
if [[ "$status" != 401 ]]; then
  echo "expected authenticated edge to return 401 without credentials; got $status" >&2
  exit 1
fi
echo "Cpredict public proxy installed for https://${host}"
`;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isPublicIpv4(value) {
  const [a, b, c] = value.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || (b === 0 && [0, 2].includes(c)))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function renewalHook() {
  return `#!/usr/bin/env bash
# Managed by the Cpredict public proxy.
set -Eeuo pipefail
/usr/sbin/nginx -t
/usr/bin/systemctl reload nginx
`;
}

function replaceAll(source, replacements) {
  let output = source;
  for (const [token, value] of Object.entries(replacements))
    output = output.replaceAll(token, value);
  if (/@@[A-Z_]+@@/.test(output))
    throw new Error("unresolved proxy template token");
  return output;
}

function assertWithin(path, parent) {
  const child = relative(parent, path);
  if (child === "" || child === ".") return;
  if (child.startsWith("..") || child.startsWith("/"))
    throw new Error("proxy output must stay under runtime/host-proxy");
}

async function atomicWrite(path, contents, mode) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode });
  await rename(temporary, path);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  renderPublicProxy(parseProxyArgs(process.argv.slice(2)))
    .then((result) =>
      process.stdout.write(`PUBLIC PROXY MATERIAL ${result.output}\n`),
    )
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
