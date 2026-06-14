/**
 * Sync the books to the live Google Sheet (same Sheet, stable URL). Shared by the
 * push-gsheet bin AND the close orchestrator, so every close refreshes the Sheet in
 * place. Returns the Sheet URL, or null if Google isn't connected yet (no token) —
 * callers treat null as "not configured", never an error.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Sql } from "../core/db.js";
import { getAccessToken, hasToken } from "./google-auth.js";
import { createSpreadsheet, writeTabs, spreadsheetUrl, type Cell } from "./gsheets.js";

const CONFIG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".gsheet.json");
const D = (c: number | string): number => Math.round(Number(c)) / 100;

async function buildTabs(sql: Sql, tenant: string, year: string): Promise<{ name: string; rows: Cell[][] }[]> {
  const ys = `${year}-01-01`;
  const ye = `${year}-12-31`;

  const months = await sql<{ mo: string; revenue: string; expense: string; n: string }[]>`
    SELECT to_char(e.entry_date,'YYYY-MM') mo,
      COALESCE(SUM(CASE WHEN c.type='revenue' THEN l.credit_cents-l.debit_cents ELSE 0 END),0) revenue,
      COALESCE(SUM(CASE WHEN c.type IN ('expense','cogs') THEN l.debit_cents-l.credit_cents ELSE 0 END),0) expense,
      COUNT(DISTINCT e.id) n
    FROM acct_journal_entries e JOIN acct_journal_lines l ON l.entry_id=e.id JOIN acct_chart c ON c.id=l.account_id
    WHERE e.tenant_id=${tenant} AND e.status='posted' AND e.is_allocation=false AND e.entry_date BETWEEN ${ys} AND ${ye}
    GROUP BY mo ORDER BY mo`;
  const summary: Cell[][] = [["Month", "Revenue", "Expense", "Net", "Entries"]];
  let tr = 0, te = 0;
  for (const m of months) {
    const rev = D(m.revenue), exp = D(m.expense);
    tr += rev; te += exp;
    summary.push([m.mo, rev, exp, rev - exp, Number(m.n)]);
  }
  summary.push([`${year} YTD`, tr, te, tr - te, ""]);
  summary.push([]);
  summary.push([`Updated ${new Date().toISOString()} · bookkeeping, not tax advice`]);

  const beRows = await sql<{ code: string; name: string; sc: string | null; net: string }[]>`
    SELECT c.code, c.name, c.schedule_c_line sc, SUM(l.debit_cents-l.credit_cents) net
    FROM acct_journal_lines l JOIN acct_journal_entries e ON e.id=l.entry_id JOIN acct_chart c ON c.id=l.account_id
    WHERE e.tenant_id=${tenant} AND e.status='posted' AND e.is_allocation=false AND c.type IN ('expense','cogs') AND c.is_business
      AND e.entry_date BETWEEN ${ys} AND ${ye}
    GROUP BY c.code,c.name,c.schedule_c_line HAVING SUM(l.debit_cents-l.credit_cents)<>0 ORDER BY SUM(l.debit_cents-l.credit_cents) DESC`;
  const business: Cell[][] = [["Account", "Category", "Schedule C", "Amount"]];
  let bt = 0;
  for (const a of beRows) { const v = D(a.net); bt += v; business.push([a.code, a.name, a.sc ?? "", v]); }
  business.push(["", "TOTAL", "", bt]);

  const pp = await sql<{ slug: string; revenue: string; expense: string }[]>`
    SELECT p.slug,
      COALESCE(SUM(CASE WHEN c.type='revenue' THEN l.credit_cents-l.debit_cents ELSE 0 END),0) revenue,
      COALESCE(SUM(CASE WHEN c.type IN ('expense','cogs') THEN l.debit_cents-l.credit_cents ELSE 0 END),0) expense
    FROM acct_projects p JOIN acct_journal_lines l ON l.project_id=p.id
    JOIN acct_journal_entries e ON e.id=l.entry_id AND e.tenant_id=${tenant} AND e.status='posted' AND e.entry_date BETWEEN ${ys} AND ${ye}
    JOIN acct_chart c ON c.id=l.account_id
    GROUP BY p.slug HAVING COALESCE(SUM(l.debit_cents-l.credit_cents),0)<>0 ORDER BY p.slug`;
  const project: Cell[][] = [["Project", "Revenue", "Expense", "Net"]];
  for (const x of pp) { const rev = D(x.revenue), exp = D(x.expense); project.push([x.slug, rev, exp, rev - exp]); }

  const qq = await sql<{ d: string | null; m: string | null; desc: string | null; amt: string; reason: string }[]>`
    SELECT to_char(r.posted_date,'YYYY-MM-DD') d, r.merchant_name m, r.description_raw desc, r.amount_cents amt, rq.reason
    FROM acct_review_queue rq JOIN acct_transactions_raw r ON ('raw:'||r.id)=rq.source_txn_id
    WHERE rq.status='open' AND r.tenant_id=${tenant} AND r.posted_date BETWEEN ${ys} AND ${ye} ORDER BY r.posted_date`;
  const review: Cell[][] = [["Date", "Merchant", "Amount", "Reason", "Your category"]];
  for (const x of qq) review.push([x.d ?? "", x.m ?? x.desc ?? "", D(x.amt), x.reason, ""]);

  return [
    { name: "YTD Summary", rows: summary },
    { name: "Business Expenses YTD", rows: business },
    { name: "Per-Project YTD", rows: project },
    { name: "To Review", rows: review },
  ];
}

/** Create (first run) or refresh the live Sheet. Returns the URL, or null if not connected. */
export async function syncLiveSheet(sql: Sql, tenant: string, year: string, title?: string): Promise<string | null> {
  if (!hasToken()) return null;
  const token = await getAccessToken();
  let cfg: { spreadsheetId?: string } = {};
  if (existsSync(CONFIG)) cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
  if (!cfg.spreadsheetId) {
    const created = await createSpreadsheet(token, title ?? `Accounting — ${tenant} (live)`);
    cfg.spreadsheetId = created.spreadsheetId;
    writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
  }
  const tabs = await buildTabs(sql, tenant, year);
  await writeTabs(token, cfg.spreadsheetId, tabs);
  return spreadsheetUrl(cfg.spreadsheetId);
}
