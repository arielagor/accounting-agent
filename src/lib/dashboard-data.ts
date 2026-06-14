/**
 * Shared data layer for every display surface (local dashboard, XLSX/Sheet, email
 * digest). All three render THIS, so they can never disagree. Reuses reports.ts as
 * the source of truth and adds the human-facing quarantine queue + chart for the UI.
 */
import type { Sql } from "../core/db.js";
import type { EntityProfile, EntityType, FilingStatus } from "../core/types.js";
import { assembleClosePackage, type ClosePackage } from "../core/reports.js";
import { periodBounds } from "../core/ledger.js";

export interface QuarantineItem {
  sourceTxnId: string;
  merchant: string;
  amountCents: number;
  date: string | null;
  reason: string;
  account: string | null;
}

export interface DashboardData {
  period: string;
  generatedAt: string;
  closePackage: ClosePackage;
  quarantine: QuarantineItem[];
  chart: { code: string; name: string; type: string }[];
  closeStatus: string | null;
  locked: boolean;
}

async function loadProfile(sql: Sql, tenant: string, taxYear: number): Promise<EntityProfile> {
  const rows = await sql<
    { entity_type: string; filing_status: string; state: string }[]
  >`SELECT entity_type, filing_status, state FROM acct_entity_profile WHERE tenant_id = ${tenant} AND tax_year = ${taxYear}`;
  const r = rows[0];
  return {
    taxYear,
    entityType: (r?.entity_type ?? "sole_prop") as EntityType,
    filingStatus: (r?.filing_status ?? "single") as FilingStatus,
    state: r?.state ?? "CA",
    homeOfficeSqft: null,
    homeTotalSqft: null,
    reasonableSalaryCents: null,
  };
}

/** Build everything a display surface needs for one period. */
export async function getDashboardData(
  sql: Sql,
  tenant: string,
  period: string,
  generatedAt: string,
): Promise<DashboardData> {
  const taxYear = Number(period.slice(0, 4));
  const { start: periodStart, end: periodEnd } = periodBounds(period);
  const profile = await loadProfile(sql, tenant, taxYear);
  const closePackage = await assembleClosePackage(sql, tenant, period, profile);

  const qRows = await sql<
    {
      source_txn_id: string;
      reason: string;
      merchant: string | null;
      description_raw: string | null;
      amount_cents: string | null;
      posted_date: string | null;
      account: string | null;
    }[]
  >`
    SELECT rq.source_txn_id, rq.reason, r.merchant_name AS merchant, r.description_raw,
           r.amount_cents, to_char(r.posted_date, 'YYYY-MM-DD') AS posted_date, sa.ledger_account_code AS account
    FROM acct_review_queue rq
    LEFT JOIN acct_transactions_raw r ON ('raw:' || r.id) = rq.source_txn_id
    LEFT JOIN acct_source_accounts sa ON sa.id = r.source_account_id
    WHERE rq.status = 'open'
      AND (r.tenant_id = ${tenant} OR r.tenant_id IS NULL)
      AND (r.posted_date IS NULL OR r.posted_date BETWEEN ${periodStart} AND ${periodEnd})
    ORDER BY ABS(COALESCE(r.amount_cents, 0)) DESC`;

  const quarantine: QuarantineItem[] = qRows.map((q) => ({
    sourceTxnId: q.source_txn_id,
    merchant: q.merchant ?? q.description_raw ?? q.source_txn_id,
    amountCents: Number(q.amount_cents ?? 0),
    date: q.posted_date,
    reason: q.reason,
    account: q.account,
  }));

  const chart = (
    await sql<{ code: string; name: string; type: string }[]>`
      SELECT code, name, type FROM acct_chart WHERE is_active ORDER BY code`
  ).map((c) => ({ code: c.code, name: c.name, type: c.type }));

  const closeRow = await sql<{ status: string; locked: boolean }[]>`
    SELECT status, locked FROM acct_close WHERE tenant_id = ${tenant} AND period = ${period}`;

  return {
    period,
    generatedAt,
    closePackage,
    quarantine,
    chart,
    closeStatus: closeRow[0]?.status ?? null,
    locked: closeRow[0]?.locked ?? false,
  };
}
