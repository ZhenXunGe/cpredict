import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ALLOWED_STATUSES,
  checkRequirements,
  renderRequirementMarkdownRow,
} from "./check-requirements.mjs";

test("accepts a locked atomic manifest and ignores non-path descriptive text", async (t) => {
  const fixture = await createFixture(t);
  const result = await checkRequirements({
    root: fixture.root,
    sourcePath: fixture.sourcePath,
  });

  assert.equal(result.total, 1);
  assert.equal(result.markdownIds, 1);
  assert.equal(result.markdownLinks, 1);
  assert.equal(result.repositoryPaths, 2);
  assert.equal(result.sourceLines, 2);
});

test("fails closed when the authoritative source no longer matches size or SHA", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(
    fixture.sourcePath,
    "# Product\nMust do one changed thing.\n",
    "utf8",
  );

  await assert.rejects(
    checkRequirements({ root: fixture.root, sourcePath: fixture.sourcePath }),
    /authoritative source byte size mismatch|authoritative source SHA-256 mismatch/,
  );
});

test("fails closed on a malformed requirements lock", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(fixture.lockPath, "product-source | incomplete\n", "utf8");

  await assert.rejects(
    checkRequirements({ root: fixture.root, sourcePath: fixture.sourcePath }),
    /requirements\.lock record has invalid format/,
  );
});

test("rejects duplicate stable IDs", async (t) => {
  const fixture = await createFixture(t);
  await fixture.mutateManifest((manifest) => {
    manifest.requirements.push(structuredClone(manifest.requirements[0]));
  });

  await assert.rejects(
    checkRequirements({ root: fixture.root, sourcePath: fixture.sourcePath }),
    /duplicate requirement ID PF-ARCH-001/,
  );
});

test("rejects unknown status and phase values", async (t) => {
  const statusFixture = await createFixture(t);
  await statusFixture.mutateManifest((manifest) => {
    manifest.requirements[0].status = "looks_done";
  });
  await assert.rejects(
    checkRequirements({
      root: statusFixture.root,
      sourcePath: statusFixture.sourcePath,
    }),
    /unknown status/,
  );

  const phaseFixture = await createFixture(t);
  await phaseFixture.mutateManifest((manifest) => {
    manifest.requirements[0].phase = "Phase someday";
  });
  await assert.rejects(
    checkRequirements({
      root: phaseFixture.root,
      sourcePath: phaseFixture.sourcePath,
    }),
    /unknown phase/,
  );
});

test("rejects out-of-range and blank-only source citations", async (t) => {
  const rangeFixture = await createFixture(t);
  await rangeFixture.mutateManifest((manifest) => {
    manifest.requirements[0].source_lines.end = 3;
  });
  await assert.rejects(
    checkRequirements({
      root: rangeFixture.root,
      sourcePath: rangeFixture.sourcePath,
    }),
    /source line range is invalid/,
  );

  const blankFixture = await createFixture(t, { source: "# Product\n\n" });
  await blankFixture.mutateManifest((manifest) => {
    manifest.requirements[0].source_lines = { start: 2, end: 2 };
  });
  await assert.rejects(
    checkRequirements({
      root: blankFixture.root,
      sourcePath: blankFixture.sourcePath,
    }),
    /cites only blank source lines/,
  );
});

test("rejects missing and escaping artifact or evidence paths", async (t) => {
  const missingFixture = await createFixture(t);
  await missingFixture.mutateManifest((manifest) => {
    manifest.requirements[0].tests_evidence = "reports/missing-evidence.md";
  });
  await assert.rejects(
    checkRequirements({
      root: missingFixture.root,
      sourcePath: missingFixture.sourcePath,
    }),
    /missing artifact\/evidence path reports\/missing-evidence\.md/,
  );

  const escapingFixture = await createFixture(t);
  await escapingFixture.mutateManifest((manifest) => {
    manifest.requirements[0].implementation = "docs/../../outside.md";
  });
  await assert.rejects(
    checkRequirements({
      root: escapingFixture.root,
      sourcePath: escapingFixture.sourcePath,
    }),
    /artifact\/evidence path escapes repository/,
  );
});

test("rejects missing Markdown IDs and incorrect declared totals", async (t) => {
  const missingFixture = await createFixture(t);
  const withoutRow = (
    await readFile(missingFixture.markdownPath, "utf8")
  ).replace(/^\| PF-ARCH-001 .*\n/m, "");
  await writeFile(missingFixture.markdownPath, withoutRow, "utf8");
  await assert.rejects(
    checkRequirements({
      root: missingFixture.root,
      sourcePath: missingFixture.sourcePath,
    }),
    /Markdown requirement table count does not match JSON/,
  );

  const countFixture = await createFixture(t);
  const wrongTotal = (
    await readFile(countFixture.markdownPath, "utf8")
  ).replace("**1 项稳定 ID**", "**2 项稳定 ID**");
  await writeFile(countFixture.markdownPath, wrongTotal, "utf8");
  await assert.rejects(
    checkRequirements({
      root: countFixture.root,
      sourcePath: countFixture.sourcePath,
    }),
    /Markdown declared stable-ID total does not match JSON/,
  );
});

test("rejects Markdown phase/status/scope count drift and broken local links", async (t) => {
  const summaryFixture = await createFixture(t);
  const wrongSummary = (
    await readFile(summaryFixture.markdownPath, "utf8")
  ).replace("| phase | MVP | 1 |", "| phase | MVP | 2 |");
  await writeFile(summaryFixture.markdownPath, wrongSummary, "utf8");
  await assert.rejects(
    checkRequirements({
      root: summaryFixture.root,
      sourcePath: summaryFixture.sourcePath,
    }),
    /Markdown phase counts mismatch for MVP/,
  );

  const linkFixture = await createFixture(t);
  const brokenLink = (await readFile(linkFixture.markdownPath, "utf8")).replace(
    "../../manifests/requirements-traceability.json",
    "../../reports/missing.md",
  );
  await writeFile(linkFixture.markdownPath, brokenLink, "utf8");
  await assert.rejects(
    checkRequirements({
      root: linkFixture.root,
      sourcePath: linkFixture.sourcePath,
    }),
    /missing Markdown link target/,
  );
});

test("rejects per-row Markdown status, requirement, implementation, evidence and owner drift", async (t) => {
  for (const [label, mutate] of [
    [
      "status",
      (row) => row.replace(" | implemented_static | ", " | partial | "),
    ],
    [
      "requirement",
      (row) =>
        row.replace(
          "Implement one atomic behavior.",
          "Changed requirement text.",
        ),
    ],
    [
      "implementation",
      (row) => row.replace("docs/evidence.md", "docs/changed.md"),
    ],
    [
      "evidence",
      (row) => row.replace("test/example.test.js", "test/changed.test.js"),
    ],
    [
      "owner",
      (row) =>
        row.replace(
          "Protocol engineering Decision:",
          "Unknown owner Decision:",
        ),
    ],
  ]) {
    const fixture = await createFixture(t);
    const markdown = await readFile(fixture.markdownPath, "utf8");
    const changed = markdown
      .split("\n")
      .map((row) => (row.startsWith("| PF-ARCH-001 |") ? mutate(row) : row))
      .join("\n");
    assert.notEqual(
      changed,
      markdown,
      `${label} mutation must change the fixture`,
    );
    await writeFile(fixture.markdownPath, changed, "utf8");
    await assert.rejects(
      checkRequirements({ root: fixture.root, sourcePath: fixture.sourcePath }),
      /Markdown requirement row drift for PF-ARCH-001/,
    );
  }
});

test("rejects unknown schema keys and invalid stable ID namespaces", async (t) => {
  const schemaFixture = await createFixture(t);
  await schemaFixture.mutateManifest((manifest) => {
    manifest.unreviewed = true;
  });
  await assert.rejects(
    checkRequirements({
      root: schemaFixture.root,
      sourcePath: schemaFixture.sourcePath,
    }),
    /requirements manifest has unknown or missing keys/,
  );

  const idFixture = await createFixture(t);
  await idFixture.mutateManifest((manifest) => {
    manifest.requirements[0].id = "PF-OTHER-001";
  });
  await assert.rejects(
    checkRequirements({
      root: idFixture.root,
      sourcePath: idFixture.sourcePath,
    }),
    /invalid stable requirement ID/,
  );
});

async function createFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "cpredict-requirements-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  for (const directory of ["manifests", "docs/zh", "test", "reports"]) {
    await mkdir(join(root, directory), { recursive: true });
  }

  const sourcePath = join(root, "product-framework.md");
  const source = options.source ?? "# Product\nMust do one thing.\n";
  const sourceBytes = Buffer.from(source, "utf8");
  const sourceSha = createHash("sha256").update(sourceBytes).digest("hex");
  const sourceLines =
    (source.match(/\n/g) ?? []).length + (source.endsWith("\n") ? 0 : 1);
  const lockPath = join(root, "manifests/requirements.lock");
  const manifestPath = join(root, "manifests/requirements-traceability.json");
  const markdownPath = join(root, "docs/zh/02-requirements-traceability.md");

  await writeFile(sourcePath, sourceBytes);
  await writeFile(
    lockPath,
    `product-source | product-framework.md | v0.21 (2026-08-04) | bytes:${sourceBytes.length} | sha256:${sourceSha}\n`,
    "utf8",
  );
  await writeFile(join(root, "docs/evidence.md"), "evidence\n", "utf8");
  await writeFile(join(root, "test/example.test.js"), "// evidence\n", "utf8");

  const manifest = {
    schema_version: "1.0.0",
    generated_at: "2026-08-08",
    source: {
      name: "product-framework.md",
      version: "v0.21",
      date: "2026-08-04",
      path: sourcePath,
      line_count: sourceLines,
      bytes: sourceBytes.length,
      sha256: sourceSha,
      lock_file: "manifests/requirements.lock",
    },
    extraction_policy: {
      unit: "One independently verifiable requirement.",
      included: "All normative requirements.",
      excluded: "Explanatory prose without a constraint.",
    },
    status_definitions: Object.fromEntries(
      ALLOWED_STATUSES.map((status) => [status, `Definition for ${status}.`]),
    ),
    requirements: [
      {
        id: "PF-ARCH-001",
        source_lines: { start: 2, end: 2 },
        phase: "MVP",
        scope: "protocol-contracts",
        requirement: "Implement one atomic behavior.",
        status: "implemented_static",
        implementation:
          "docs/evidence.md; descriptive MarketVault v1.2 behavior is not a path.",
        tests_evidence: "test/example.test.js; local evidence only.",
        owner: "Protocol engineering",
        decision: "None.",
      },
    ],
  };
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  const requirementRow = renderRequirementMarkdownRow(manifest.requirements[0]);
  await writeFile(
    markdownPath,
    `# Atomic requirements\n\n[manifest](../../manifests/requirements-traceability.json)\n\n**1 项稳定 ID**\n\n| 维度 | 值 | 原子项数 |\n|---|---|---:|\n| phase | MVP | 1 |\n| scope | protocol-contracts | 1 |\n| status | implemented_static | 1 |\n\n| ID | 来源 | 阶段 / 范围 | 状态 | 原子要求 | 实现与测试证据 | Owner / 决策 |\n|---|---|---|---|---|---|---|\n${requirementRow}\n`,
    "utf8",
  );

  return {
    root,
    sourcePath,
    lockPath,
    manifestPath,
    markdownPath,
    async mutateManifest(mutator) {
      const current = JSON.parse(await readFile(manifestPath, "utf8"));
      mutator(current);
      await writeFile(
        manifestPath,
        `${JSON.stringify(current, null, 2)}\n`,
        "utf8",
      );
    },
  };
}
