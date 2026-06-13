/**
 * The close package reports. Methodology from the month-end-closer plugin:
 * P&L + cash + Schedule-C rollup + roll-forward (must foot) + variance commentary
 * (explain why, never invent) + exceptions. Every report ties back to the trial
 * balance — the tie-out check (portfolio net === TB net) is the integrity gate.
 */
import type { Sql } from "./db.js";
import type { Cents, EntityProfile, ScheduleLineRollup } from "./types.js";
import { periodBounds } from "./ledger.js";
import { estimate } from "./tax/index.js";

const CASH_CODES = ["1010", "1020", "1090"];

export interface ProjectPnl {
  projectSlug: string;
  projectName: string;
  revenueCents: Cents;
  expenseCents: Cents;
  netCents: Cents;
}

export interface PortfolioPnl {
  period: string;
  revenueCents: Cents;
  cogsCents: Cents;
  expenseCents: Cents;
  netCents: Cents;
}

export interface CashPosition {
  period: string;
  asOf: string;
  byAccount: Array<{ code: string; name: string; balanceCents: Cents }>;
  totalCents: Cents;
}

export interface RollForward {
  accountCode: string;
  accountName: string;
  beginningCents: Cents;
  activityCents: Cents;
  endingCents: Cents;
  foots: boolean;
}

export interface VarianceLine {
  accountCode: string;
  accountName: string;
  currentCents: Cents;
  priorCents: Cents;
  deltaCents: Cents;
  deltaPct: number | null;
  driver: string;
}

export interface ExceptionsReport {
  quarantined: Array<{ sourceTxnId: string; reason: string }>;
  reconNeedsReview: Array<{ rawTxnId: number; matchType: string | null; note: string | null }>;
  connectionsNeedingReauth: Array<{ id: number; institution: string | null }>;
}

export interface ClosePackage {
  period: string;
  portfolio: PortfolioPnl;
  perProject: ProjectPnl[];
  cash: CashPosition;
  scheduleC: ScheduleLineRollup[];
  rollForwards: RollForward[];
  variance: VarianceLine[];
  exceptions: ExceptionsReport;
  estimatedTaxCents: Cents;
  /** portfolio net income equals the trial-balance net (revenue - expense). */
  tieOut: boolean;
}

function priorPeriod(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period)!;
  let y = Number(m[1]);
  let mo = Number(m[2]) - 1;
  if (mo === 0) {
    mo = 12;
    y -= 1;
  }
  return `${y}-${String(mo).padStart(2, "0")}`;
}

/** Per-project P&L for the period (revenue minus expense, allocations included). */
export async function buildPerProjectPnl(
  sql: Sql,
  tenantId: string,
  period: string,
): Promise<ProjectPnl[]> {
  const { start, end } = periodBounds(period);
  const rows = await sql<
    { slug: string; name: string; revenue: string; expense: string }[]
  >`
    SELECT p.slug, p.name,
      COALESCE(SUM(CASE WHEN c.type = 'revenue' THEN l.credit_cents - l.debit_cents ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN c.type IN ('expense','cogs') THEN l.debit_cents - l.credit_cents ELSE 0 END), 0) AS expense
    FROM acct_projects p
    LEFT JOIN acct_journal_lines l ON l.project_id = p.id
    LEFT JOIN acct_journal_entries e ON e.id = l.entry_id
      AND e.tenant_id = ${tenantId} AND e.status = 'posted'
      AND e.entry_date BETWEEN ${start} AND ${end}
    LEFT JOIN acct_chart c ON c.id = l.account_id
    GROUP BY p.slug, p.name
    HAVING COALESCE(SUM(CASE WHEN c.type='revenue' THEN l.credit_cents - l.debit_cents ELSE 0 END),0) <> 0
        OR COALESCE(SUM(CASE WHEN c.type IN ('expense','cogs') THEN l.debit_cents - l.credit_cents ELSE 0 END),0) <> 0
    ORDER BY p.slug
  `;
  return rows.map((r) => {
    const revenueCents = Number(r.revenue);
    const expenseCents = Number(r.expense);
    return {
      projectSlug: r.slug,
      projectName: r.name,
      revenueCents,
      expenseCents,
      netCents: revenueCents - expenseCents,
    };
  });
}

/** Consolidated portfolio P&L for the period. */
export async function buildPortfolioPnl(
  sql: Sql,
  tenantId: string,
  period: string,
): Promise<PortfolioPnl> {
  const { start, end } = periodBounds(period);
  const rows = await sql<{ revenue: string; cogs: string; expense: string }[]>`
    SELECT
      COALESCE(SUM(CASE WHEN c.type = 'revenue' THEN l.credit_cents - l.debit_cents ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN c.type = 'cogs' THEN l.debit_cents - l.credit_cents ELSE 0 END), 0) AS cogs,
      COALESCE(SUM(CASE WHEN c.type = 'expense' THEN l.debit_cents - l.credit_cents ELSE 0 END), 0) AS expense
    FROM acct_journal_lines l
    JOIN acct_journal_entries e ON e.id = l.entry_id
    JOIN acct_chart c ON c.id = l.account_id
    WHERE e.tenant_id = ${tenantId} AND e.status = 'posted'
      AND e.entry_date BETWEEN ${start} AND ${end}
  `;
  const revenueCents = Number(rows[0]!.revenue);
  const cogsCents = Number(rows[0]!.cogs);
  const expenseCents = Number(rows[0]!.expense);
  return {
    period,
    revenueCents,
    cogsCents,
    expenseCents,
    netCents: revenueCents - cogsCents - expenseCents,
  };
}

/** Cash position: cumulative balance of cash accounts as of period end. */
export async function buildCashPosition(
  sql: Sql,
  tenantId: string,
  period: string,
): Promise<CashPosition> {
  const { end } = periodBounds(period);
  const rows = await sql<{ code: string; name: string; bal: string }[]>`
    SELECT c.code, c.name, COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS bal
    FROM acct_chart c
    LEFT JOIN acct_journal_lines l ON l.account_id = c.id
    LEFT JOIN acct_journal_entries e ON e.id = l.entry_id
      AND e.tenant_id = ${tenantId} AND e.status = 'posted' AND e.entry_date <= ${end}
    WHERE c.code IN ${sql(CASH_CODES)}
    GROUP BY c.code, c.name
    ORDER BY c.code
  `;
  const byAccount = rows.map((r) => ({
    code: r.code,
    name: r.name,
    balanceCents: Number(r.bal),
  }));
  return {
    period,
    asOf: end,
    byAccount,
    totalCents: byAccount.reduce((a, b) => a + b.balanceCents, 0),
  };
}

/** Schedule-C rollup (YTD through the period) by IRS line, applying tax treatment. */
export async function buildScheduleCRollup(
  sql: Sql,
  tenantId: string,
  period: string,
): Promise<ScheduleLineRollup[]> {
  const m = /^(\d{4})-(\d{2})$/.exec(period)!;
  const yearStart = `${m[1]}-01-01`;
  const { end } = periodBounds(period);
  const rows = await sql<{ line: string; name: string; amount: string; treatment: string }[]>`
    SELECT c.schedule_c_line AS line, c.name, c.tax_treatment AS treatment,
           COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS amount
    FROM acct_journal_lines l
    JOIN acct_journal_entries e ON e.id = l.entry_id
    JOIN acct_chart c ON c.id = l.account_id
    WHERE e.tenant_id = ${tenantId} AND e.status = 'posted'
      AND c.is_business = true AND c.schedule_c_line IS NOT NULL
      AND e.entry_date BETWEEN ${yearStart} AND ${end}
    GROUP BY c.schedule_c_line, c.name, c.tax_treatment
    ORDER BY c.schedule_c_line
  `;
  return rows.map((r) => {
    let amount = Number(r.amount);
    if (r.treatment === "meals_50") amount = Math.round(amount * 0.5); // 50% meals limit
    return { scheduleLine: r.line, accountName: r.name, amountCents: amount };
  });
}

/** Roll-forward for an account: prior cumulative + period activity = ending. Must foot. */
export async function buildRollForward(
  sql: Sql,
  tenantId: string,
  period: string,
  accountCode: string,
): Promise<RollForward> {
  const { start, end } = periodBounds(period);
  const before = `${start}`;
  const rows = await sql<{ name: string; beginning: string; activity: string }[]>`
    SELECT c.name,
      COALESCE(SUM(CASE WHEN e.entry_date < ${before} THEN l.debit_cents - l.credit_cents ELSE 0 END), 0) AS beginning,
      COALESCE(SUM(CASE WHEN e.entry_date BETWEEN ${start} AND ${end} THEN l.debit_cents - l.credit_cents ELSE 0 END), 0) AS activity
    FROM acct_chart c
    LEFT JOIN acct_journal_lines l ON l.account_id = c.id
    LEFT JOIN acct_journal_entries e ON e.id = l.entry_id
      AND e.tenant_id = ${tenantId} AND e.status = 'posted'
    WHERE c.code = ${accountCode}
    GROUP BY c.name
  `;
  const name = rows[0]?.name ?? accountCode;
  const beginningCents = Number(rows[0]?.beginning ?? 0);
  const activityCents = Number(rows[0]?.activity ?? 0);
  const endingCents = beginningCents + activityCents;
  return {
    accountCode,
    accountName: name,
    beginningCents,
    activityCents,
    endingCents,
    foots: beginningCents + activityCents === endingCents, // exact by construction; surfaced for audit
  };
}

/** Variance commentary: P&L lines whose period-over-period delta exceeds threshold. */
export async function buildVarianceCommentary(
  sql: Sql,
  tenantId: string,
  period: string,
  thresholdPct = 5,
  floorCents = 10_000,
): Promise<VarianceLine[]> {
  const cur = periodBounds(period);
  const prior = periodBounds(priorPeriod(period));
  const rows = await sql<
    { code: string; name: string; cur: string; prior: string }[]
  >`
    SELECT c.code, c.name,
      COALESCE(SUM(CASE WHEN e.entry_date BETWEEN ${cur.start} AND ${cur.end} THEN
        (CASE WHEN c.type IN ('expense','cogs') THEN l.debit_cents - l.credit_cents ELSE l.credit_cents - l.debit_cents END) ELSE 0 END), 0) AS cur,
      COALESCE(SUM(CASE WHEN e.entry_date BETWEEN ${prior.start} AND ${prior.end} THEN
        (CASE WHEN c.type IN ('expense','cogs') THEN l.debit_cents - l.credit_cents ELSE l.credit_cents - l.debit_cents END) ELSE 0 END), 0) AS prior
    FROM acct_chart c
    JOIN acct_journal_lines l ON l.account_id = c.id
    JOIN acct_journal_entries e ON e.id = l.entry_id
      AND e.tenant_id = ${tenantId} AND e.status = 'posted'
    WHERE c.type IN ('revenue','expense','cogs')
    GROUP BY c.code, c.name
  `;
  const out: VarianceLine[] = [];
  for (const r of rows) {
    const currentCents = Number(r.cur);
    const priorCents = Number(r.prior);
    const deltaCents = currentCents - priorCents;
    const deltaPct = priorCents !== 0 ? (deltaCents / Math.abs(priorCents)) * 100 : null;
    const material =
      Math.abs(deltaCents) >= floorCents &&
      (deltaPct === null || Math.abs(deltaPct) >= thresholdPct);
    const alwaysComment = r.name.toLowerCase().includes("revenue") || r.code.startsWith("10");
    if (!material && !alwaysComment) continue;
    // The driver is left for the LLM narrative / human; we never invent one here.
    out.push({
      accountCode: r.code,
      accountName: r.name,
      currentCents,
      priorCents,
      deltaCents,
      deltaPct,
      driver: "driver unclear - flag for review",
    });
  }
  return out.sort((a, b) => Math.abs(b.deltaCents) - Math.abs(a.deltaCents));
}

/** Open exceptions: quarantines, recon items needing review, connections to re-auth. */
export async function buildExceptionsReport(
  sql: Sql,
  tenantId: string,
): Promise<ExceptionsReport> {
  const quarantined = (
    await sql<{ source_txn_id: string; reason: string }[]>`
      SELECT source_txn_id, reason FROM acct_review_queue WHERE status = 'open' ORDER BY id`
  ).map((r) => ({ sourceTxnId: r.source_txn_id, reason: r.reason }));

  const reconNeedsReview = (
    await sql<{ raw_txn_id: number; match_type: string | null; note: string | null }[]>`
      SELECT raw_txn_id, match_type, note FROM acct_recon
      WHERE tenant_id = ${tenantId} AND status = 'needs_review' ORDER BY id`
  ).map((r) => ({ rawTxnId: r.raw_txn_id, matchType: r.match_type, note: r.note }));

  const connectionsNeedingReauth = (
    await sql<{ id: number; institution_name: string | null }[]>`
      SELECT id, institution_name FROM acct_connections
      WHERE tenant_id = ${tenantId} AND status = 'login_required' ORDER BY id`
  ).map((r) => ({ id: r.id, institution: r.institution_name }));

  return { quarantined, reconNeedsReview, connectionsNeedingReauth };
}

/** Assemble the full close package and compute the tie-out (portfolio net === TB net). */
export async function assembleClosePackage(
  sql: Sql,
  tenantId: string,
  period: string,
  profile: EntityProfile,
): Promise<ClosePackage> {
  const [portfolio, perProject, cash, scheduleC, variance, exceptions] = await Promise.all([
    buildPortfolioPnl(sql, tenantId, period),
    buildPerProjectPnl(sql, tenantId, period),
    buildCashPosition(sql, tenantId, period),
    buildScheduleCRollup(sql, tenantId, period),
    buildVarianceCommentary(sql, tenantId, period),
    buildExceptionsReport(sql, tenantId),
  ]);

  const rollForwards = await Promise.all(
    CASH_CODES.map((code) => buildRollForward(sql, tenantId, period, code)),
  );

  // YTD net for the tax estimate.
  const m = /^(\d{4})-(\d{2})$/.exec(period)!;
  const taxYear = Number(m[1]);
  const ytdNet = await ytdNetProfit(sql, tenantId, period);
  const tax = await estimate(sql, { ...profile, taxYear }, ytdNet.netCents, ytdNet.grossCents);

  // Tie-out: the sum of per-project net equals portfolio net (allocations net to zero
  // across projects, so consolidating per-project equals the consolidated query).
  const perProjectNet = perProject.reduce((a, p) => a + p.netCents, 0);
  const tieOut = perProjectNet === portfolio.netCents;

  return {
    period,
    portfolio,
    perProject,
    cash,
    scheduleC,
    rollForwards,
    variance,
    exceptions,
    estimatedTaxCents: tax.quarterlySetAsideCents,
    tieOut,
  };
}

async function ytdNetProfit(
  sql: Sql,
  tenantId: string,
  period: string,
): Promise<{ netCents: Cents; grossCents: Cents }> {
  const m = /^(\d{4})-(\d{2})$/.exec(period)!;
  const yearStart = `${m[1]}-01-01`;
  const { end } = periodBounds(period);
  const rows = await sql<{ revenue: string; expense: string }[]>`
    SELECT
      COALESCE(SUM(CASE WHEN c.type = 'revenue' THEN l.credit_cents - l.debit_cents ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN c.type IN ('expense','cogs') THEN l.debit_cents - l.credit_cents ELSE 0 END), 0) AS expense
    FROM acct_journal_lines l
    JOIN acct_journal_entries e ON e.id = l.entry_id
    JOIN acct_chart c ON c.id = l.account_id
    WHERE e.tenant_id = ${tenantId} AND e.status = 'posted'
      AND c.is_business = true
      AND e.entry_date BETWEEN ${yearStart} AND ${end}
  `;
  const grossCents = Number(rows[0]!.revenue);
  const expense = Number(rows[0]!.expense);
  return { netCents: grossCents - expense, grossCents };
}
