/**
 * Spreadsheet export (surface 2 of 3). Builds a multi-tab .xlsx of the close —
 * Summary, Business Expenses, Per-Project P&L, Cash, Schedule-C, To-Review — that
 * opens natively in Google Sheets (tabs intact). Writes to exports/books-<period>.xlsx.
 *
 * Usage: node --import tsx bin/export-sheet.ts [--period YYYY-MM]
 */
import ExcelJS from "exceljs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { loadEnv } from "../src/lib/env.js";
import { openSql } from "../src/core/db.js";
import { getDashboardData } from "../src/lib/dashboard-data.js";
import { log, error } from "../src/lib/log.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const D = (cents: number): number => Math.round(cents) / 100;
const MONEY = '#,##0.00;[Red]-#,##0.00';

async function main(): Promise<void> {
  const env = loadEnv(join(root, ".env"));
  const url = env.ACCT_DB_URL;
  if (!url) {
    error("ACCT_DB_URL not set");
    process.exit(1);
  }
  const tenant = env.TENANT_ID ?? "ariel";
  const period = arg("--period") ?? new Date().toISOString().slice(0, 7);
  const sql = openSql(url);

  try {
    const d = await getDashboardData(sql, tenant, period, new Date().toISOString());
    const v = d.closePackage;

    // Business expense breakdown by account (the deductions).
    const m = /^(\d{4})-(\d{2})$/.exec(period)!;
    const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
    const byAcct = await sql<{ code: string; name: string; schedule_c_line: string | null; net: string }[]>`
      SELECT c.code, c.name, c.schedule_c_line, SUM(l.debit_cents - l.credit_cents) AS net
      FROM acct_journal_lines l JOIN acct_journal_entries e ON e.id = l.entry_id JOIN acct_chart c ON c.id = l.account_id
      WHERE e.tenant_id = ${tenant} AND e.status='posted' AND e.is_allocation=false
        AND c.type IN ('expense','cogs') AND c.is_business = true
        AND e.entry_date BETWEEN ${period + "-01"} AND ${`${m[1]}-${m[2]}-${String(last).padStart(2, "0")}`}
      GROUP BY c.code, c.name, c.schedule_c_line HAVING SUM(l.debit_cents - l.credit_cents) <> 0
      ORDER BY SUM(l.debit_cents - l.credit_cents) DESC`;

    const wb = new ExcelJS.Workbook();
    wb.creator = "Accounting Agent (Hank Calloway, CPA)";
    wb.created = new Date(d.generatedAt);

    // ── Summary ──
    const s = wb.addWorksheet("Summary");
    s.columns = [{ width: 34 }, { width: 16 }];
    s.addRow([`Month-End Close — ${period}`]);
    s.getCell("A1").font = { bold: true, size: 14 };
    s.addRow([`Status`, d.closeStatus ?? "DRAFT"]);
    s.addRow([`Tie-out (per-project == portfolio)`, v.tieOut ? "OK" : "MISMATCH"]);
    s.addRow([]);
    s.addRow(["Portfolio P&L", ""]);
    s.getCell("A5").font = { bold: true };
    const sm: [string, number][] = [
      ["Revenue", D(v.portfolio.revenueCents)],
      ["COGS", -D(v.portfolio.cogsCents)],
      ["Operating expense", -D(v.portfolio.expenseCents)],
      ["Net income", D(v.portfolio.netCents)],
      ["Estimated quarterly tax set-aside", D(v.estimatedTaxCents)],
      ["Cash on hand", D(v.cash.totalCents)],
    ];
    for (const [k, val] of sm) {
      const r = s.addRow([k, val]);
      r.getCell(2).numFmt = MONEY;
    }
    s.addRow([]);
    s.addRow([`Generated ${new Date(d.generatedAt).toLocaleString()} · bookkeeping, not tax advice · review with a CPA`]);

    // ── Business Expenses (deductions) ──
    const be = wb.addWorksheet("Business Expenses");
    be.columns = [
      { header: "Account", key: "code", width: 8 },
      { header: "Category", key: "name", width: 34 },
      { header: "Schedule C", key: "sc", width: 12 },
      { header: "Amount", key: "amt", width: 14 },
    ];
    be.getRow(1).font = { bold: true };
    for (const a of byAcct) {
      const r = be.addRow({ code: a.code, name: a.name, sc: a.schedule_c_line ?? "", amt: D(Number(a.net)) });
      r.getCell("amt").numFmt = MONEY;
    }

    // ── Per-Project P&L ──
    const pp = wb.addWorksheet("Per-Project P&L");
    pp.columns = [
      { header: "Project", key: "p", width: 22 },
      { header: "Revenue", key: "rev", width: 14 },
      { header: "Expense", key: "exp", width: 14 },
      { header: "Net", key: "net", width: 14 },
    ];
    pp.getRow(1).font = { bold: true };
    for (const x of v.perProject) {
      const r = pp.addRow({ p: x.projectSlug, rev: D(x.revenueCents), exp: D(x.expenseCents), net: D(x.netCents) });
      ["rev", "exp", "net"].forEach((k) => (r.getCell(k).numFmt = MONEY));
    }

    // ── Cash ──
    const cash = wb.addWorksheet("Cash");
    cash.columns = [{ header: "Account", key: "a", width: 10 }, { header: "Name", key: "n", width: 30 }, { header: "Balance", key: "b", width: 14 }];
    cash.getRow(1).font = { bold: true };
    for (const a of v.cash.byAccount) {
      const r = cash.addRow({ a: a.code, n: a.name, b: D(a.balanceCents) });
      r.getCell("b").numFmt = MONEY;
    }

    // ── Schedule-C ──
    const sc = wb.addWorksheet("Schedule-C");
    sc.columns = [{ header: "Line", key: "l", width: 8 }, { header: "Category", key: "n", width: 34 }, { header: "Amount (YTD)", key: "a", width: 16 }];
    sc.getRow(1).font = { bold: true };
    for (const x of v.scheduleC) {
      const r = sc.addRow({ l: x.scheduleLine, n: x.accountName, a: D(x.amountCents) });
      r.getCell("a").numFmt = MONEY;
    }

    // ── To Review (set the Category column, then run the agent to apply) ──
    const tr = wb.addWorksheet("To Review");
    tr.columns = [
      { header: "Date", key: "d", width: 12 },
      { header: "Merchant", key: "m", width: 38 },
      { header: "Amount", key: "amt", width: 14 },
      { header: "Reason", key: "r", width: 16 },
      { header: "Your category (account code)", key: "c", width: 26 },
    ];
    tr.getRow(1).font = { bold: true };
    for (const q of d.quarantine) {
      const r = tr.addRow({ d: q.date ?? "", m: q.merchant, amt: D(q.amountCents), r: q.reason, c: "" });
      r.getCell("amt").numFmt = MONEY;
    }

    const dir = join(root, "exports");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `books-${period}.xlsx`);
    await wb.xlsx.writeFile(path);
    log(`wrote ${path} (${wb.worksheets.length} tabs, ${d.quarantine.length} to review)`);
    // Print the path on its own line for the caller to capture.
    process.stdout.write(path + "\n");
  } catch (e) {
    error("export-sheet failed:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  error("export-sheet fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
