import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import standaloneCode from "ajv/dist/standalone/index.js";

const root = resolve(import.meta.dirname, "..");
const runtimeSchemaPath = resolve(root, "examples/web-demo/src/runtime-config.schema.json");
const manifestSchemaPath = resolve(root, "deployments/arbitrum-sepolia/final-manifest.schema.json");
const outputPath = resolve(root, "examples/web-demo/src/generated-validators.js");

const [runtimeSchema, manifestSchema] = await Promise.all([
  readJson(runtimeSchemaPath),
  readJson(manifestSchemaPath),
]);
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  allowUnionTypes: true,
  code: { source: true, esm: true, optimize: true },
});
addFormats(ajv, ["date-time"]);
ajv.addSchema(runtimeSchema, "runtime");
ajv.addSchema(manifestSchema, "manifest");
let generated = `${standaloneCode(ajv, {
  validateRuntime: "runtime",
  validateManifest: "manifest",
})}\n`;
generated = generated
  .replace(
    /const (\w+) = require\("ajv\/dist\/runtime\/ucs2length"\)\.default;/,
    "const $1 = (value) => Array.from(value).length;",
  )
  .replace(
    /const (\w+) = require\("ajv-formats\/dist\/formats"\)\.fullFormats\["date-time"\];/,
    "const $1 = {validate:(value)=>/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$/.test(value)&&Number.isFinite(Date.parse(value))};",
  )
  .replace(
    /const (\w+) = require\("ajv\/dist\/runtime\/equal"\)\.default;/,
    "const $1 = (a,b) => {if(a===b)return true;if(a===null||b===null||typeof a!==\"object\"||typeof b!==\"object\"||Array.isArray(a)!==Array.isArray(b))return false;const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every((key)=>Object.prototype.hasOwnProperty.call(b,key)&&$1(a[key],b[key]));};",
  );
if (generated.includes("require(") || generated.includes("new Function")) {
  throw new Error("standalone validator contains a CSP-incompatible runtime dependency");
}

if (process.argv.includes("--check")) {
  let existing = "";
  try { existing = await readFile(outputPath, "utf8"); } catch { /* fail below */ }
  if (existing !== generated) {
    throw new Error("web demo standalone validators are stale; run npm run demo:validators");
  }
} else {
  await writeFile(outputPath, generated, "utf8");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
