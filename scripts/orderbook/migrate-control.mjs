// Dedicated control database only. Existing deployment data migrations use the established runner.
import postgres from "postgres";
import { readFile } from "node:fs/promises";
const url = process.env.CPREDICT_AUTOMATION_CONTROL_DATABASE_URL;
if (!url) throw Error("CPREDICT_AUTOMATION_CONTROL_DATABASE_URL required");
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  await sql.unsafe(
    await readFile(
      new URL(
        "../../offchain/app-service/migrations/007_order_automation.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  console.log("Automation control schema ready; no business data changed.");
} finally {
  await sql.end({ timeout: 5 });
}
