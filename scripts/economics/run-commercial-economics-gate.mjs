import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateCommercialEconomics } from "./commercial-economics.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

export async function runCommercialEconomicsGate(options = {}) {
  const inputPath = resolve(
    options.inputPath ??
      fileURLToPath(
        new URL("./inputs/commercial-input.template.json", import.meta.url),
      ),
  );
  const policyPath = resolve(
    options.policyPath ??
      fileURLToPath(
        new URL("./inputs/commercial-policy.template.json", import.meta.url),
      ),
  );
  const outputJsonPath = resolve(
    options.outputJsonPath ??
      fileURLToPath(
        new URL(
          "../../reports/economics/commercial-economics-gate.json",
          import.meta.url,
        ),
      ),
  );
  const outputMarkdownPath = resolve(
    options.outputMarkdownPath ??
      fileURLToPath(
        new URL(
          "../../reports/economics/commercial-economics-gate.md",
          import.meta.url,
        ),
      ),
  );
  const [input, policy] = await Promise.all([
    readJson(inputPath),
    readJson(policyPath),
  ]);
  const result = evaluateCommercialEconomics(input, policy);
  await Promise.all([
    mkdir(dirname(outputJsonPath), { recursive: true }),
    mkdir(dirname(outputMarkdownPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(outputJsonPath, `${JSON.stringify(result, null, 2)}\n`),
    writeFile(
      outputMarkdownPath,
      renderCommercialEconomicsMarkdown(result, { inputPath, policyPath }),
    ),
  ]);
  return { result, inputPath, policyPath, outputJsonPath, outputMarkdownPath };
}

export function renderCommercialEconomicsMarkdown(result, paths = {}) {
  const rows = result.gates
    .map(
      (gate) =>
        `| ${gate.id} | ${gate.status} | ${gate.reasons.length ? gate.reasons.join("; ") : "approved threshold met"} |`,
    )
    .join("\n");
  const unresolved = result.gates
    .filter((gate) => gate.status !== "PASS")
    .map(
      (gate) =>
        `- ${gate.id}: ${gate.status} — ${gate.reasons.join("; ") || "threshold failed"}`,
    )
    .join("\n");
  const relativePath = (path) => {
    if (!path) return "not recorded";
    const candidate = relative(repositoryRoot, resolve(path));
    if (candidate === ".." || candidate.startsWith("../"))
      return "outside repository";
    return candidate;
  };
  return `# 商业经济参数验收

## 正式状态

**${result.overallStatus}**。该状态由七项 fail-closed 门禁聚合；任何缺失的真实 Base receipt、业务数据或批准阈值都只能得到 \`NOT_VERIFIED\`，估算值不能得到 \`PASS\`。

| 门禁 | 状态 | 原因 |
|---|---|---|
${rows}

## 未关闭项

${unresolved || "- 无；七项均满足已批准阈值。"}

## 输入与可复现性

- Evidence input: \`${relativePath(paths.inputPath)}\`
- Approved policy: \`${relativePath(paths.policyPath)}\`
- Input SHA-256: \`${result.inputSha256}\`
- Policy SHA-256: \`${result.policySha256}\`
- Assessment window: \`${result.assessmentTime}\` through \`${result.validUntil}\`
- 生成器：\`node scripts/economics/run-commercial-economics-gate.mjs --input <evidence.json> --policy <approved-policy.json>\`

## 七项判断

1. Bond：分别按 Full/Clone 的 \`max(10 USDC, ceil(cap×2%))\`，与经批准覆盖倍数下的 P95 恶意收益和响应成本比较。
2. 微池：用真实 Base claim、L1 data fee、Paymaster receipt 及外部供应商收费的 P95 每 claimant 成本，向上取整后与获批准资金范围（协议分成、早鸟后 creator 净额或总 rake）中已明确承诺的比例比较；不会默认整笔 gross rake 都可用于赞助。
3. Cap：同时检查 Full 5,000 USDC 与 Clone 500 USDC 的风险预算、P95 利用率、cap 拒单率和未追回损失。
4. 早鸟：检查疑似 Sybil 钱包占比、奖励占比以及奖励相对本金的放大倍数。
5. C2C：用匹配的零费率/候选费率 cohort 检查 fill-rate 损失、保留率和成交时延变化。
6. LaunchGuard：只有观察期、市场数、账务/绕过/未恢复事故、拒单率和 exposure 利用率全部达标才具备退休资格。
7. 极端 gas：用实际退出 receipt 的 gas/L1 fee percentile 和实际 gas-price percentile 做经批准的压力倍数计算。

## 舍入和证明边界

- 收入向下取整；成本、所需覆盖和不利比率向上取整；百分位使用 nearest-rank；全程 JavaScript \`BigInt\`。
- 微池结果显式绑定 \`fundingScope\` 与 \`committedFundingShareBps\`，防止把属于 creator、protocol 或 early-bird 的金额重复视为 Paymaster 预算。
- receipt 的非合成、RPC 已验证和数据集 provenance 会被 fail-closed 检查，但本地工具不会联网复查交易包含性。
- 极端 gas 的 \`PASS\` 只表示批准压力向量下的经济可行性，不保证 sequencer、RPC、bundler 或 USDC 可用性。
- LaunchGuard 的 \`PASS\` 只表示可以提交治理决策，不会调用不可逆的 \`retireForever\`。
- 本工具不修改 V1 Solidity 经济规则。
`;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function parseArguments(argv) {
  const result = {};
  const mappings = {
    "--input": "inputPath",
    "--policy": "policyPath",
    "--output-json": "outputJsonPath",
    "--output-md": "outputMarkdownPath",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = mappings[argv[index]];
    if (!key || index + 1 >= argv.length)
      throw new Error(
        `usage: --input <json> --policy <json> [--output-json <json>] [--output-md <md>]`,
      );
    result[key] = argv[index + 1];
    index += 1;
  }
  return result;
}

async function main() {
  try {
    const { result, outputJsonPath, outputMarkdownPath } =
      await runCommercialEconomicsGate(parseArguments(process.argv.slice(2)));
    process.stdout.write(
      `${result.overallStatus}\n${outputJsonPath}\n${outputMarkdownPath}\n`,
    );
    process.exitCode =
      result.overallStatus === "PASS"
        ? 0
        : result.overallStatus === "FAIL"
          ? 1
          : 2;
  } catch (error) {
    process.stderr.write(
      `commercial economics gate invalid: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 64;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
