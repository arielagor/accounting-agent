/**
 * Push the books to the LIVE Google Sheet (same Sheet, stable URL, refreshed each
 * run). Thin wrapper over syncLiveSheet — the close calls the same function so the
 * Sheet stays current automatically; this bin is for an on-demand refresh.
 *
 * Usage: npm run push-gsheet [--year 2026]   (after `npm run google-consent`)
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/lib/env.js";
import { openSql } from "../src/core/db.js";
import { hasToken } from "../src/lib/google-auth.js";
import { syncLiveSheet } from "../src/lib/gsheet-sync.js";
import { log, warn, error } from "../src/lib/log.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(f: string): string | undefined {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const env = loadEnv(join(root, ".env"));
  const url = env.ACCT_DB_URL;
  if (!url) {
    error("ACCT_DB_URL not set");
    process.exit(1);
  }
  if (!hasToken()) {
    warn("No Google token yet. Run `npm run google-consent` once (click Allow), then this command.");
    process.exit(2);
  }
  const tenant = env.TENANT_ID ?? "ariel";
  const year = arg("--year") ?? String(new Date().getUTCFullYear());
  const sql = openSql(url);
  try {
    const sheetUrl = await syncLiveSheet(sql, tenant, year);
    if (sheetUrl) {
      log(`live Sheet updated: ${sheetUrl}`);
      process.stdout.write(sheetUrl + "\n");
    } else {
      warn("Google not connected; run `npm run google-consent`.");
    }
  } catch (e) {
    error("push-gsheet failed:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  error("push-gsheet fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
