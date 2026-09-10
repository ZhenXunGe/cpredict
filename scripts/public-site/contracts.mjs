import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import * as core from "../../dist/offchain/app-core/src/contracts.js";
import * as ledger from "../../dist/offchain/app-core/src/ledger-contracts.js";
import * as reports from "../../dist/offchain/app-core/src/report-contracts.js";
import * as catalog from "../../dist/offchain/app-core/src/catalog-contracts.js";
import { appRuntimeSchema } from "../../dist/offchain/app-service/src/config.js";
const schemas = {
  SiteConfig: core.siteConfigSchema,
  Environment: core.environmentSchema,
  AppRuntime: appRuntimeSchema,
  Account: core.accountSchema,
  RegisterOperation: core.registerOperationSchema,
  PreparedOperation: core.preparedOperationSchema,
  Operation: core.operationSchema,
  LedgerSnapshot: ledger.snapshotSchema,
  ActivityPage: ledger.factsPageSchema,
  Pnl: ledger.pnlResponseSchema,
  PnlFact: ledger.pnlFactResponseSchema,
  Entitlements: ledger.entitlementsResponseSchema,
  Leaderboard: reports.leaderboardPageSchema,
  LeaderboardPeriod: reports.leaderboardPeriodSchema,
  OpsReport: reports.opsReportSchema,
  Telemetry: reports.telemetrySchema,
  Feedback: reports.feedbackSchema,
  Market: catalog.marketSchema,
  Listing: catalog.listingSchema,
};
const out = Object.fromEntries(
  Object.entries(schemas).map(([name, schema]) => [
    name,
    z.toJSONSchema(schema, { io: "input", target: "draft-2020-12" }),
  ]),
);
const output = resolve("generated/public-site/contracts.json"),
  text =
    JSON.stringify(
      {
        schemaVersion: 1,
        note: "Generated from Zod. Cross-field, cryptographic, ownership and admission refinements are also enforced by runtime code.",
        schemas: out,
      },
      null,
      2,
    ) + "\n";
if (process.argv.includes("--check")) {
  if ((await readFile(output, "utf8")) !== text)
    throw new Error(
      "Public-site contract schemas are stale. Build offchain and run site:contracts.",
    );
  console.log("Public-site contract schemas match Zod sources.");
} else {
  await mkdir(resolve("generated/public-site"), { recursive: true });
  await writeFile(output, text);
  console.log("Generated public-site contract schemas.");
}
