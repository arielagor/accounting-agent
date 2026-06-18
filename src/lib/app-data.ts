/**
 * Read helpers for the web app's feature tabs (budgets, advisor, receipts, review,
 * SMB, transactions, net worth). Pure-ish DB reads that shape rows for the UI; all
 * the WRITE/compute logic lives in the core engine modules these import from. Kept
 * separate from bin/dashboard.ts so the HTTP layer stays thin.
 */
import type { Sql } from "../core/db.js";
import { refreshActuals, type BudgetActual } from "../core/budgets.js";
import { aging, vendors1099Due, type AgingBucket } from "../core/smb.js";

const D = (c: number | string): number => Number(c);

// ─── Net worth / overview ────────────────────────────────────────────────────────
export interface NetWorthPoint {
  month: string;
  assetsCents: number;
  liabilitiesCents: number;
  netWorthCents: number;
}

/** Monthly net-worth trend across a year: cumulative assets - liabilities through each month. */
export async function netWorthSeries(sql: Sql, tenant: string, year: string): Promise<NetWorthPoint[]> {
  const rows = await sql<{ mo: string; assets: string; liabilities: string }[]>`
    WITH months AS (
      SELECT to_char(generate_series(${`${year}-01-01`}::date, ${`${year}-12-01`}::date, '1 month'), 'YYYY-MM') AS mo
    )
    SELECT m.mo,
      COALESCE(SUM(CASE WHEN c.type='asset' THEN l.debit_cents - l.credit_cents ELSE 0 END),0) assets,
      COALESCE(SUM(CASE WHEN c.type='liability' THEN l.credit_cents - l.debit_cents ELSE 0 END),0) liabilities
    FROM months m
    LEFT JOIN acct_journal_entries e ON e.tenant_id=${tenant} AND e.status='posted'
      AND to_char(e.entry_date,'YYYY-MM') <= m.mo
    LEFT JOIN acct_journal_lines l ON l.entry_id=e.id
    LEFT JOIN acct_chart c ON c.id=l.account_id
    GROUP BY m.mo ORDER BY m.mo`;
  return rows.map((r) => {
    const assets = D(r.assets);
    const liabilities = D(r.liabilities);
    return { month: r.mo, assetsCents: assets, liabilitiesCents: liabilities, netWorthCents: assets - liabilities };
  });
}

// ─── Transactions register ───────────────────────────────────────────────────────
export interface TxnRow {
  sourceTxnId: string;
  date: string | null;
  merchant: string;
  amountCents: number;
  account: string | null; // the posted expense/revenue account code (if posted)
  status: "posted" | "review" | "unposted";
  businessPct: number | null;
}

/** The transaction register for a period: each raw txn with its posting status + category. */
export async function transactions(sql: Sql, tenant: string, period: string): Promise<TxnRow[]> {
  const rows = await sql<
    {
      source_txn_id: string;
      d: string | null;
      merchant: string | null;
      desc: string | null;
      amount_cents: string;
      acct: string | null;
      pct: string | null;
      in_review: boolean;
    }[]
  >`
    SELECT ('raw:'||r.id) source_txn_id, to_char(r.posted_date,'YYYY-MM-DD') d,
           r.merchant_name merchant, r.description_raw desc, r.amount_cents,
           (SELECT c.code FROM acct_journal_entries e JOIN acct_journal_lines l ON l.entry_id=e.id
              JOIN acct_chart c ON c.id=l.account_id
            WHERE e.tenant_id=${tenant} AND e.source_txn_id=('raw:'||r.id) AND e.status='posted'
              AND c.type IN ('expense','cogs','revenue') ORDER BY l.debit_cents+l.credit_cents DESC LIMIT 1) acct,
           (SELECT l.business_pct FROM acct_journal_entries e JOIN acct_journal_lines l ON l.entry_id=e.id
            WHERE e.tenant_id=${tenant} AND e.source_txn_id=('raw:'||r.id) AND e.status='posted' LIMIT 1) pct,
           EXISTS(SELECT 1 FROM acct_review_queue rq WHERE rq.source_txn_id=('raw:'||r.id) AND rq.status='open') in_review
    FROM acct_transactions_raw r
    WHERE r.tenant_id=${tenant} AND to_char(r.posted_date,'YYYY-MM')=${period}
    ORDER BY r.posted_date DESC, r.id DESC`;
  return rows.map((r) => ({
    sourceTxnId: r.source_txn_id,
    date: r.d,
    merchant: r.merchant ?? r.desc ?? r.source_txn_id,
    amountCents: D(r.amount_cents),
    account: r.acct,
    status: r.acct ? "posted" : r.in_review ? "review" : "unposted",
    businessPct: r.pct === null ? null : D(r.pct),
  }));
}

// ─── Budgets ───────────────────────────────────────────────────────────────────────
/** Budgets with their current-period materialized actuals (refreshes first). */
export async function budgetsWithActuals(sql: Sql, tenant: string, asOfISO: string): Promise<BudgetActual[]> {
  return refreshActuals(sql, tenant, asOfISO);
}

// ─── Advisor / recommendations ─────────────────────────────────────────────────────
export interface RecoRow {
  id: number;
  kind: string;
  title: string;
  body: string;
  estImpactCents: number;
  confidence: number;
  status: string;
  createdAt: string;
}

export async function recommendations(sql: Sql, tenant: string, includeDismissed = false): Promise<RecoRow[]> {
  const rows = await sql<
    { id: number; kind: string; title: string; body: string; est_impact_cents: string; confidence: string; status: string; created_at: string }[]
  >`
    SELECT id, kind, title, body, est_impact_cents, confidence, status, to_char(created_at,'YYYY-MM-DD') created_at
    FROM acct_recommendations
    WHERE tenant_id = ${tenant} ${includeDismissed ? sql`` : sql`AND status <> 'dismissed'`}
    ORDER BY (status='new') DESC, est_impact_cents DESC LIMIT 100`;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    estImpactCents: D(r.est_impact_cents),
    confidence: D(r.confidence),
    status: r.status,
    createdAt: r.created_at,
  }));
}

// ─── Receipts / documents ────────────────────────────────────────────────────────
export interface DocRow {
  id: number;
  sourceKind: string;
  vendorGuess: string | null;
  docDate: string | null;
  totalCents: number | null;
  status: string;
  lines: number;
  createdAt: string;
}

export async function documents(sql: Sql, tenant: string): Promise<DocRow[]> {
  const rows = await sql<
    { id: number; source_kind: string; vendor_guess: string | null; doc_date: string | null; total_cents: string | null; status: string; n: string; created_at: string }[]
  >`
    SELECT d.id, d.source_kind, d.vendor_guess, to_char(d.doc_date,'YYYY-MM-DD') doc_date,
           d.total_cents, d.status, (SELECT count(*) FROM acct_document_lines dl WHERE dl.document_id=d.id) n,
           to_char(d.created_at,'YYYY-MM-DD') created_at
    FROM acct_documents d WHERE d.tenant_id=${tenant} ORDER BY d.created_at DESC LIMIT 100`;
  return rows.map((r) => ({
    id: r.id,
    sourceKind: r.source_kind,
    vendorGuess: r.vendor_guess,
    docDate: r.doc_date,
    totalCents: r.total_cents === null ? null : D(r.total_cents),
    status: r.status,
    lines: D(r.n),
    createdAt: r.created_at,
  }));
}

// ─── Review queue + access requests + auditor decisions ────────────────────────────
export interface AccessReqRow {
  id: number;
  resource: string;
  reason: string;
  howToGrant: string;
  requestedForTxn: string | null;
  status: string;
}

export async function accessRequests(sql: Sql, tenant: string, openOnly = true): Promise<AccessReqRow[]> {
  const rows = await sql<
    { id: number; resource: string; reason: string; how_to_grant: string; requested_for_txn: string | null; status: string }[]
  >`
    SELECT id, resource, reason, how_to_grant, requested_for_txn, status
    FROM acct_access_requests WHERE tenant_id=${tenant} ${openOnly ? sql`AND status='open'` : sql``}
    ORDER BY created_at DESC LIMIT 100`;
  return rows.map((r) => ({
    id: r.id,
    resource: r.resource,
    reason: r.reason,
    howToGrant: r.how_to_grant,
    requestedForTxn: r.requested_for_txn,
    status: r.status,
  }));
}

// ─── SMB summary ─────────────────────────────────────────────────────────────────────
export interface SmbSummary {
  arAging: AgingBucket;
  apAging: AgingBucket;
  contractors1099: { vendorId: number; name: string; ytdPaidCents: number; w9OnFile: boolean }[];
  salesTax: { jurisdiction: string; period: string; collectedCents: number; remittedCents: number; status: string }[];
}

// ─── Apple purchase catalog ────────────────────────────────────────────────────────
export interface AppleCatalogItem {
  id: number;
  item: string;
  vendor: string | null;
  period: string | null;
  amountCents: number;
  date: string;
  accountCode?: string | null;
}
export interface AppleCatalog {
  summary: { bucket: string; n: number; cents: number }[];
  review: AppleCatalogItem[];
  /** Toss-ups the reviewer LEANED to business — surfaced so they can be confirmed/flipped. */
  leaned: AppleCatalogItem[];
}

export async function appleCatalog(sql: Sql, tenant: string): Promise<AppleCatalog> {
  const summary = (
    await sql<{ bucket: string; n: string; cents: string }[]>`
      SELECT bucket, count(*) n, COALESCE(SUM(amount_cents),0) cents
      FROM acct_apple_purchases WHERE tenant_id = ${tenant} GROUP BY bucket ORDER BY count(*) DESC`
  ).map((r) => ({ bucket: r.bucket, n: D(r.n), cents: D(r.cents) }));
  const review = (
    await sql<{ id: number; item: string; vendor: string | null; period: string | null; amount_cents: string; d: string }[]>`
      SELECT id, item, vendor, period, amount_cents, to_char(order_date,'YYYY-MM-DD') d
      FROM acct_apple_purchases WHERE tenant_id = ${tenant} AND bucket = 'review' AND amount_cents > 0
      ORDER BY amount_cents DESC LIMIT 200`
  ).map((r) => ({ id: r.id, item: r.item, vendor: r.vendor, period: r.period, amountCents: D(r.amount_cents), date: r.d }));
  const leaned = (
    await sql<{ id: number; item: string; vendor: string | null; period: string | null; amount_cents: string; account_code: string | null; d: string }[]>`
      SELECT id, item, vendor, period, amount_cents, account_code, to_char(order_date,'YYYY-MM-DD') d
      FROM acct_apple_purchases WHERE tenant_id = ${tenant} AND auto_leaned = true
      ORDER BY amount_cents DESC LIMIT 200`
  ).map((r) => ({ id: r.id, item: r.item, vendor: r.vendor, period: r.period, amountCents: D(r.amount_cents), date: r.d, accountCode: r.account_code }));
  return { summary, review, leaned };
}

export async function smbSummary(sql: Sql, tenant: string, asOfISO: string): Promise<SmbSummary> {
  const taxYear = Number(asOfISO.slice(0, 4));
  const [arAging, apAging, contractors1099, stax] = await Promise.all([
    aging(sql, tenant, "ar", asOfISO),
    aging(sql, tenant, "ap", asOfISO),
    vendors1099Due(sql, tenant, taxYear),
    sql<{ jurisdiction: string; period: string; collected_cents: string; remitted_cents: string; status: string }[]>`
      SELECT jurisdiction, period, collected_cents, remitted_cents, status
      FROM acct_sales_tax WHERE tenant_id=${tenant} ORDER BY period DESC, jurisdiction LIMIT 50`,
  ]);
  return {
    arAging,
    apAging,
    contractors1099,
    salesTax: stax.map((s) => ({
      jurisdiction: s.jurisdiction,
      period: s.period,
      collectedCents: D(s.collected_cents),
      remittedCents: D(s.remitted_cents),
      status: s.status,
    })),
  };
}
