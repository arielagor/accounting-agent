/**
 * Year workbook — a single .xlsx covering all of 2026 (or --year YYYY): a YTD
 * Summary, Business Expenses YTD (your deductions), Per-Project YTD, and a single
 * To-Review tab of every open item across the year. Feeds the live Google Sheet.
 *
 * Usage: node --import tsx bin/export-year.ts [--year 2026]
 */
import ExcelJS from "exceljs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { loadEnv } from "../src/lib/env.js";
import { openSql, type Sql } from "../src/core/db.js";
import { log, error } from "../src/lib/log.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function arg(f: string): string | undefined {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const D = (c: number | string): number => Math.round(Number(c)) / 100;
const MONEY = '#,##0.00;[Red]-#,##0.00';

async function main(): Promise<void> {
  const env = loadEnv(join(root, ".env"));
  const url = env.ACCT_DB_URL;
  if (!url) { error("ACCT_DB_URL not set"); process.exit(1); }
  const tenant = env.TENANT_ID ?? "ariel";
  const year = arg("--year") ?? String(new Date().getUTCFullYear());
  const ys = `${year}-01-01`;
  const ye = `${year}-12-31`;
  const sql = openSql(url);

  try {
    const wb = new ExcelJS.Workbook();
    wb.creator = "Accounting Agent (Hank Calloway, CPA)";

    // YTD Summary — one row per month with activity.
    const months = await sql<{ mo: string; revenue: string; expense: string; posted: string }[]>`
      SELECT to_char(e.entry_date,'YYYY-MM') AS mo,
        COALESCE(SUM(CASE WHEN c.type='revenue' THEN l.credit_cents-l.debit_cents ELSE 0 END),0) AS revenue,
        COALESCE(SUM(CASE WHEN c.type IN ('expense','cogs') THEN l.debit_cents-l.credit_cents ELSE 0 END),0) AS expense,
        COUNT(DISTINCT e.id) AS posted
      FROM acct_journal_entries e JOIN acct_journal_lines l ON l.entry_id=e.id JOIN acct_chart c ON c.id=l.account_id
      WHERE e.tenant_id=${tenant} AND e.status='posted' AND e.is_allocation=false AND e.entry_date BETWEEN ${ys} AND ${ye}
      GROUP BY mo ORDER BY mo`;
    const s = wb.addWorksheet("YTD Summary");
    s.columns = [{ header: "Month", width: 12 }, { header: "Revenue", width: 14 }, { header: "Expense", width: 14 }, { header: "Net", width: 14 }, { header: "Entries", width: 10 }];
    s.getRow(1).font = { bold: true };
    let tRev = 0, tExp = 0;
    for (const m of months) {
      const rev = D(m.revenue), exp = D(m.expense);
      tRev += rev; tExp += exp;
      const r = s.addRow([m.mo, rev, exp, rev - exp, Number(m.posted)]);
      [2, 3, 4].forEach((i) => (r.getCell(i).numFmt = MONEY));
    }
    const tot = s.addRow([`${year} YTD`, tRev, tExp, tRev - tExp, ""]);
    tot.font = { bold: true };
    [2, 3, 4].forEach((i) => (tot.getCell(i).numFmt = MONEY));

    // Business Expenses YTD (the deductions) by account.
    await tab(sql, wb, "Business Expenses YTD", tenant, ys, ye, true);
    // All operating + COGS (incl. non-business split) for completeness.
    await tab(sql, wb, "All Expenses YTD", tenant, ys, ye, false);

    // Per-project YTD.
    const pp = await sql<{ slug: string; revenue: string; expense: string }[]>`
      SELECT p.slug,
        COALESCE(SUM(CASE WHEN c.type='revenue' THEN l.credit_cents-l.debit_cents ELSE 0 END),0) AS revenue,
        COALESCE(SUM(CASE WHEN c.type IN ('expense','cogs') THEN l.debit_cents-l.credit_cents ELSE 0 END),0) AS expense
      FROM acct_projects p JOIN acct_journal_lines l ON l.project_id=p.id
      JOIN acct_journal_entries e ON e.id=l.entry_id AND e.tenant_id=${tenant} AND e.status='posted' AND e.entry_date BETWEEN ${ys} AND ${ye}
      JOIN acct_chart c ON c.id=l.account_id
      GROUP BY p.slug HAVING COALESCE(SUM(l.debit_cents-l.credit_cents),0)<>0 ORDER BY p.slug`;
    const pw = wb.addWorksheet("Per-Project YTD");
    pw.columns = [{ header: "Project", width: 22 }, { header: "Revenue", width: 14 }, { header: "Expense", width: 14 }, { header: "Net", width: 14 }];
    pw.getRow(1).font = { bold: true };
    for (const x of pp) {
      const rev = D(x.revenue), exp = D(x.expense);
      const r = pw.addRow([x.slug, rev, exp, rev - exp]);
      [2, 3, 4].forEach((i) => (r.getCell(i).numFmt = MONEY));
    }

    // To Review — every open item across the year.
    const q = await sql<{ d: string | null; m: string | null; desc: string | null; amt: string; reason: string }[]>`
      SELECT to_char(r.posted_date,'YYYY-MM-DD') AS d, r.merchant_name AS m, r.description_raw AS desc, r.amount_cents AS amt, rq.reason
      FROM acct_review_queue rq JOIN acct_transactions_raw r ON ('raw:'||r.id)=rq.source_txn_id
      WHERE rq.status='open' AND r.tenant_id=${tenant} AND r.posted_date BETWEEN ${ys} AND ${ye}
      ORDER BY r.posted_date`;
    const tr = wb.addWorksheet("To Review");
    tr.columns = [{ header: "Date", width: 12 }, { header: "Merchant", width: 40 }, { header: "Amount", width: 14 }, { header: "Reason", width: 16 }, { header: "Your category", width: 24 }];
    tr.getRow(1).font = { bold: true };
    for (const x of q) {
      const r = tr.addRow([x.d ?? "", x.m ?? x.desc ?? "", D(x.amt), x.reason, ""]);
      r.getCell(3).numFmt = MONEY;
    }

    const dir = join(root, "exports");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `books-${year}-YTD.xlsx`);
    await wb.xlsx.writeFile(path);
    log(`wrote ${path} (${wb.worksheets.length} tabs, ${q.length} to review)`);
    process.stdout.write(path + "\n");
  } catch (e) {
    error("export-year failed:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function tab(sql: Sql, wb: ExcelJS.Workbook, title: string, tenant: string, ys: string, ye: string, businessOnly: boolean): Promise<void> {
  const rows = await sql<{ code: string; name: string; sc: string | null; net: string }[]>`
    SELECT c.code, c.name, c.schedule_c_line AS sc, SUM(l.debit_cents-l.credit_cents) AS net
    FROM acct_journal_lines l JOIN acct_journal_entries e ON e.id=l.entry_id JOIN acct_chart c ON c.id=l.account_id
    WHERE e.tenant_id=${tenant} AND e.status='posted' AND e.is_allocation=false AND c.type IN ('expense','cogs')
      ${businessOnly ? sql`AND c.is_business = true` : sql``}
      AND e.entry_date BETWEEN ${ys} AND ${ye}
    GROUP BY c.code, c.name, c.schedule_c_line HAVING SUM(l.debit_cents-l.credit_cents)<>0
    ORDER BY SUM(l.debit_cents-l.credit_cents) DESC`;
  const ws = wb.addWorksheet(title);
  ws.columns = [{ header: "Account", width: 8 }, { header: "Category", width: 34 }, { header: "Schedule C", width: 12 }, { header: "Amount", width: 14 }];
  ws.getRow(1).font = { bold: true };
  let total = 0;
  for (const a of rows) {
    const amt = D(a.net); total += amt;
    const r = ws.addRow([a.code, a.name, a.sc ?? "", amt]);
    r.getCell(4).numFmt = MONEY;
  }
  const t = ws.addRow(["", "TOTAL", "", total]);
  t.font = { bold: true };
  t.getCell(4).numFmt = MONEY;
}

main().catch((e) => { error("export-year fatal:", e instanceof Error ? e.message : String(e)); process.exit(1); });
