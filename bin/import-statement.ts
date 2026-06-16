/**
 * Import a bank/card statement export (OFX/QFX or CSV) for one account — the way to
 * load YEARS of history past SimpleFIN's ~90-day window. Deduped against existing data.
 *
 * Usage:
 *   npm run import-statement -- --file <path> --account <id|ledgerCode|mask|name>
 *                               [--format ofx|csv] [--flip] [--map date=Date,amount=Amount,desc=Payee]
 * --account matches a source account by id, its ledger code (e.g. 2050), last-4 mask,
 * or a name substring. --flip inverts a CSV amount column whose charges are positive.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/lib/env.js";
import { openSql } from "../src/core/db.js";
import { parseOfx, parseCsv, importStatement, looksLikeOfx, type CsvMapping } from "../src/core/statements.js";
import { log, error } from "../src/lib/log.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (f: string): string | undefined => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main(): Promise<void> {
  const env = loadEnv(join(root, ".env"));
  const url = env.ACCT_DB_URL;
  if (!url) { error("ACCT_DB_URL not set"); process.exit(1); }
  const file = arg("--file");
  const acctSel = arg("--account");
  if (!file || !acctSel) { error("usage: --file <path> --account <id|ledgerCode|mask|name>"); process.exit(1); }
  const tenant = env.TENANT_ID ?? "ariel";
  const sql = openSql(url);
  try {
    const accts = await sql<{ id: number; name: string | null; mask: string | null; ledger_account_code: string | null }[]>`
      SELECT id, name, mask, ledger_account_code FROM acct_source_accounts WHERE tenant_id = ${tenant} ORDER BY id`;
    const sel = acctSel.toLowerCase();
    const match = accts.filter(
      (a) =>
        String(a.id) === acctSel ||
        (a.ledger_account_code ?? "").toLowerCase() === sel ||
        (a.mask ?? "").toLowerCase() === sel ||
        (a.name ?? "").toLowerCase().includes(sel),
    );
    if (match.length !== 1) {
      error(match.length === 0 ? "no account matched; choose one:" : "ambiguous --account; be specific:");
      for (const a of accts) log(`  id=${a.id}  ledger=${a.ledger_account_code ?? "-"}  ${a.name ?? ""}`);
      process.exit(2);
    }
    const accountId = match[0]!.id;

    const text = readFileSync(file, "utf8");
    const fmt = arg("--format") ?? (looksLikeOfx(text) ? "ofx" : "csv");
    let mapping: CsvMapping = {};
    const mapArg = arg("--map");
    if (mapArg) {
      mapping = Object.fromEntries(mapArg.split(",").map((p) => p.split("=").map((s) => s.trim()))) as CsvMapping;
    }
    if (process.argv.includes("--flip")) mapping.flip = true;
    const txns = fmt === "ofx" ? parseOfx(text) : parseCsv(text, mapping);
    if (txns.length === 0) {
      error(`parsed 0 transactions from ${file} as ${fmt}. For CSV pass --map date=..,amount=..,desc=..`);
      process.exit(3);
    }
    const r = await importStatement(sql, tenant, accountId, txns);
    log(
      `imported ${file} (${fmt}) -> account ${accountId} (${match[0]!.name ?? ""}): ` +
        `+${r.added} added, ${r.overlapWithSync} already-synced, ${r.duplicateInFile} re-import, ` +
        `range ${r.dateRange?.from}…${r.dateRange?.to}`,
    );
  } catch (e) {
    error("import-statement failed:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => { error("import-statement fatal:", e instanceof Error ? e.message : String(e)); process.exit(1); });
