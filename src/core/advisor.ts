/**
 * The financial advisor. INFORMATIONAL analytics layered on top of the locked
 * ledger: runway, burn, month-over-month movers, per-project ROI, "zombie"
 * subscriptions, and the persona's legal-optimization playbook surfaced for the
 * current profit level.
 *
 * This module is deliberately DISCLAIMED. It computes facts from the books and
 * surfaces recognized planning STRATEGIES, but every prescriptive item (anything
 * the user could act on) carries a "not financial advice" note, and any tax
 * strategy additionally carries the PERSONA.disclaimer. The advisor describes the
 * playing field and names the plays; it never files, elects, or moves money.
 *
 * Money is integer cents throughout (see money.ts). The PURE functions below hold
 * all the arithmetic and are unit-tested with no DB and no network; the
 * `buildAdvisorReport` wrapper is the thin DB shell that feeds them.
 */
import type { Sql } from "./db.js";
import type { Cents } from "./types.js";
import { PERSONA, applicableStrategies, type PlaybookItem } from "./persona.js";
import { periodBounds } from "./ledger.js";
import { sumCents } from "./money.js";

// ─── Constants ──────────────────────────────────────────────────────────────
/** Cash accounts whose debit-normal balances make up "liquid" funds. */
export const CASH_ACCOUNT_CODES = ["1010", "1020", "1090"] as const;

/** The standing informational disclaimer on every advisor report. */
export const INFORMATIONAL_DISCLAIMER =
  "Not financial advice; informational only. Discuss prescriptive moves with a licensed professional.";

// ─── Runway ──────────────────────────────────────────────────────────────────
/**
 * Months of runway = liquid cash / trailing monthly burn. Pure ratio in months.
 * If burn is zero or negative (the business is cash-flow neutral or generating
 * cash), runway is Infinity — there is no depletion horizon to report.
 */
export function computeRunwayMonths(liquidCents: number, trailingMonthlyBurnCents: number): number {
  if (trailingMonthlyBurnCents <= 0) return Infinity;
  return liquidCents / trailingMonthlyBurnCents;
}

// ─── Zombie subscriptions ──────────────────────────────────────────────────────
/** A recurring SaaS/subscription charge attributed (or not) to a project. */
export interface SubCharge {
  merchant: string;
  monthlyCents: Cents;
  /** The project this subscription is allocated to; null = unattributed/shared. */
  projectSlug: string | null;
  /** Last "YYYY-MM" the charge was seen — recency for the surfaced report. */
  lastSeenMonth: string;
}

/**
 * Detect "zombie" subscriptions: recurring charges whose project produced ZERO
 * revenue AND ZERO usage — i.e. we are paying for a tool tied to a product that
 * is neither earning nor being used. These are cancel candidates.
 *
 * A sub whose project has ANY revenue or ANY usage is kept (it is pulling weight,
 * or at least being exercised). An unattributed sub (projectSlug === null) cannot
 * be tied to a dead project, so it is never auto-flagged here — it has no project
 * whose revenue/usage we can prove is zero.
 */
export function detectZombieSubs(
  subs: SubCharge[],
  revenueByProject: Record<string, number>,
  usageByProject: Record<string, number>,
): SubCharge[] {
  return subs.filter((s) => {
    if (s.projectSlug === null) return false; // no project to prove dead
    const revenue = revenueByProject[s.projectSlug] ?? 0;
    const usage = usageByProject[s.projectSlug] ?? 0;
    return revenue === 0 && usage === 0;
  });
}

// ─── Month-over-month movers ───────────────────────────────────────────────────
/** A spend/earn signal per account: how much it moved vs the prior month. */
export interface AccountActivity {
  accountCode: string;
  /** Net activity for the account in the period, in cents (debit - credit). */
  netCents: Cents;
}

/**
 * Top movers by absolute month-over-month delta. Joins the current and prior
 * period activity by account, computes (current - prior), and returns the `limit`
 * accounts with the largest absolute swing — the things that changed most.
 * Pure: callers pass already-aggregated per-account activity.
 */
export function topMovers(
  current: AccountActivity[],
  prior: AccountActivity[],
  limit = 5,
): Array<{ account: string; deltaCents: Cents }> {
  const priorByCode = new Map<string, number>();
  for (const a of prior) priorByCode.set(a.accountCode, a.netCents);
  const currentByCode = new Map<string, number>();
  for (const a of current) currentByCode.set(a.accountCode, a.netCents);

  // Union of accounts that appear in either month.
  const codes = new Set<string>([...currentByCode.keys(), ...priorByCode.keys()]);
  const deltas = [...codes].map((code) => ({
    account: code,
    deltaCents: (currentByCode.get(code) ?? 0) - (priorByCode.get(code) ?? 0),
  }));
  // Largest absolute swing first; tie-break on code for deterministic order.
  deltas.sort((a, b) => Math.abs(b.deltaCents) - Math.abs(a.deltaCents) || a.account.localeCompare(b.account));
  return deltas.filter((d) => d.deltaCents !== 0).slice(0, limit);
}

// ─── Per-project ROI ────────────────────────────────────────────────────────────
/** Revenue and allocated cost for one project, with the net of the two. */
export interface ProjectRoi {
  projectSlug: string;
  revenueCents: Cents;
  allocatedCostCents: Cents;
  net: Cents;
}

/**
 * Per-project ROI = revenue - allocated cost. Pure: callers pass revenue and cost
 * keyed by project slug; this joins them on the union of slugs so a project that
 * only had cost (no revenue yet) still appears (with a negative net).
 */
export function perProjectRoi(
  revenueByProject: Record<string, Cents>,
  costByProject: Record<string, Cents>,
): ProjectRoi[] {
  const slugs = new Set<string>([...Object.keys(revenueByProject), ...Object.keys(costByProject)]);
  const rows: ProjectRoi[] = [...slugs].map((slug) => {
    const revenueCents = revenueByProject[slug] ?? 0;
    const allocatedCostCents = costByProject[slug] ?? 0;
    return { projectSlug: slug, revenueCents, allocatedCostCents, net: revenueCents - allocatedCostCents };
  });
  // Most-profitable first, then by slug for a stable order.
  rows.sort((a, b) => b.net - a.net || a.projectSlug.localeCompare(b.projectSlug));
  return rows;
}

// ─── Report ──────────────────────────────────────────────────────────────────────
export interface AdvisorReport {
  period: string;
  runwayMonths: number;
  monthlyBurnCents: Cents;
  topMovers: Array<{ account: string; deltaCents: Cents }>;
  zombieSubs: SubCharge[];
  perProjectRoi: Array<{ projectSlug: string; revenueCents: Cents; allocatedCostCents: Cents; net: Cents }>;
  strategies: Array<{ id: string; name: string; benefit: string; aggressive: boolean }>;
  disclaimers: string[];
}

/** Project a persona playbook item down to the report's strategy shape. */
function toStrategy(item: PlaybookItem): { id: string; name: string; benefit: string; aggressive: boolean } {
  return { id: item.id, name: item.name, benefit: item.benefit, aggressive: item.aggressive };
}

/** "YYYY-MM" of the month `n` months before the given period (n >= 0). */
function shiftPeriod(period: string, n: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) throw new Error(`bad period: ${period} (want YYYY-MM)`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  // Month is 1-based; build a 0-based index, subtract, and re-derive.
  const idx = year * 12 + (month - 1) - n;
  const y = Math.floor(idx / 12);
  const mo = (idx % 12) + 1;
  return `${y}-${String(mo).padStart(2, "0")}`;
}

/** The 3 trailing periods ending at (and including) `period`, oldest-first. */
function trailingThreePeriods(period: string): string[] {
  return [shiftPeriod(period, 2), shiftPeriod(period, 1), period];
}

// ─── DB shell ──────────────────────────────────────────────────────────────────
/** Sum debit-normal cash balances (1010/1020/1090) as of the end of `period`. */
async function queryLiquidCents(sql: Sql, tenantId: string, period: string): Promise<Cents> {
  const { end } = periodBounds(period);
  const rows = await sql<{ liquid: string }[]>`
    SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS liquid
    FROM acct_journal_lines l
    JOIN acct_journal_entries e ON e.id = l.entry_id
    JOIN acct_chart c ON c.id = l.account_id
    WHERE e.tenant_id = ${tenantId}
      AND e.status = 'posted'
      AND e.entry_date <= ${end}
      AND c.code IN ('1010', '1020', '1090')
  `;
  return Number(rows[0]?.liquid ?? 0);
}

/** Total expense+cogs spend (debit-normal) for one "YYYY-MM" period, in cents. */
async function queryPeriodSpendCents(sql: Sql, tenantId: string, period: string): Promise<Cents> {
  const { start, end } = periodBounds(period);
  const rows = await sql<{ spend: string }[]>`
    SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS spend
    FROM acct_journal_lines l
    JOIN acct_journal_entries e ON e.id = l.entry_id
    JOIN acct_chart c ON c.id = l.account_id
    WHERE e.tenant_id = ${tenantId}
      AND e.status = 'posted'
      AND e.entry_date BETWEEN ${start} AND ${end}
      AND c.type IN ('expense', 'cogs')
  `;
  return Number(rows[0]?.spend ?? 0);
}

/** Per-account net activity (debit - credit) for one period, for MoM movers. */
async function queryAccountActivity(
  sql: Sql,
  tenantId: string,
  period: string,
): Promise<AccountActivity[]> {
  const { start, end } = periodBounds(period);
  const rows = await sql<{ account_code: string; net: string }[]>`
    SELECT c.code AS account_code,
           COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS net
    FROM acct_journal_lines l
    JOIN acct_journal_entries e ON e.id = l.entry_id
    JOIN acct_chart c ON c.id = l.account_id
    WHERE e.tenant_id = ${tenantId}
      AND e.status = 'posted'
      AND e.entry_date BETWEEN ${start} AND ${end}
    GROUP BY c.code
  `;
  return rows.map((r) => ({ accountCode: r.account_code, netCents: Number(r.net) }));
}

/** Revenue (credit-normal) recognized per project for one period, in cents. */
async function queryRevenueByProject(
  sql: Sql,
  tenantId: string,
  period: string,
): Promise<Record<string, Cents>> {
  const { start, end } = periodBounds(period);
  const rows = await sql<{ slug: string; revenue: string }[]>`
    SELECT p.slug AS slug,
           COALESCE(SUM(l.credit_cents - l.debit_cents), 0) AS revenue
    FROM acct_journal_lines l
    JOIN acct_journal_entries e ON e.id = l.entry_id
    JOIN acct_chart c ON c.id = l.account_id
    JOIN acct_projects p ON p.id = l.project_id
    WHERE e.tenant_id = ${tenantId}
      AND e.status = 'posted'
      AND e.entry_date BETWEEN ${start} AND ${end}
      AND c.type = 'revenue'
    GROUP BY p.slug
  `;
  const out: Record<string, Cents> = {};
  for (const r of rows) out[r.slug] = Number(r.revenue);
  return out;
}

/** Cost (expense+cogs, debit-normal) allocated per project for a period, in cents. */
async function queryCostByProject(
  sql: Sql,
  tenantId: string,
  period: string,
): Promise<Record<string, Cents>> {
  const { start, end } = periodBounds(period);
  const rows = await sql<{ slug: string; cost: string }[]>`
    SELECT p.slug AS slug,
           COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS cost
    FROM acct_journal_lines l
    JOIN acct_journal_entries e ON e.id = l.entry_id
    JOIN acct_chart c ON c.id = l.account_id
    JOIN acct_projects p ON p.id = l.project_id
    WHERE e.tenant_id = ${tenantId}
      AND e.status = 'posted'
      AND e.entry_date BETWEEN ${start} AND ${end}
      AND c.type IN ('expense', 'cogs')
    GROUP BY p.slug
  `;
  const out: Record<string, Cents> = {};
  for (const r of rows) out[r.slug] = Number(r.cost);
  return out;
}

/** Usage totals per project across the period's months (drives zombie detection). */
async function queryUsageByProject(
  sql: Sql,
  period: string,
): Promise<Record<string, number>> {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) throw new Error(`bad period: ${period} (want YYYY-MM)`);
  const fy = Number(m[1]);
  const fm = Number(m[2]);
  const rows = await sql<{ slug: string; usage: string }[]>`
    SELECT project_slug AS slug, COALESCE(SUM(value), 0) AS usage
    FROM acct_usage_metrics
    WHERE fiscal_year = ${fy} AND fiscal_month = ${fm}
    GROUP BY project_slug
  `;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.slug] = Number(r.usage);
  return out;
}

/**
 * Recurring software/SaaS charges in the period, treated as subscriptions. Pulls
 * the per-merchant monthly spend posted to the subscription/hosting/cloud expense
 * accounts (6150/6160/6170/6180), attributed to the line's project. Each row is
 * one (merchant, project) bucket so a sub split across projects surfaces per slug.
 */
async function querySubCharges(sql: Sql, tenantId: string, period: string): Promise<SubCharge[]> {
  const { start, end } = periodBounds(period);
  const rows = await sql<{ merchant: string; monthly: string; slug: string | null }[]>`
    SELECT COALESCE(e.description, 'unknown') AS merchant,
           COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS monthly,
           p.slug AS slug
    FROM acct_journal_lines l
    JOIN acct_journal_entries e ON e.id = l.entry_id
    JOIN acct_chart c ON c.id = l.account_id
    LEFT JOIN acct_projects p ON p.id = l.project_id
    WHERE e.tenant_id = ${tenantId}
      AND e.status = 'posted'
      AND e.entry_date BETWEEN ${start} AND ${end}
      AND c.code IN ('6150', '6160', '6170', '6180')
    GROUP BY e.description, p.slug
    HAVING COALESCE(SUM(l.debit_cents - l.credit_cents), 0) > 0
  `;
  return rows.map((r) => ({
    merchant: r.merchant,
    monthlyCents: Number(r.monthly),
    projectSlug: r.slug,
    lastSeenMonth: period,
  }));
}

/**
 * Build the full advisor report for a period. Thin shell: each statistic is
 * queried from the locked books, then handed to the PURE functions above for the
 * arithmetic. `netProfitCents` is supplied by the orchestrator (it already
 * computed the P&L) so the strategy surfacing is consistent with the close.
 */
export async function buildAdvisorReport(
  sql: Sql,
  tenantId: string,
  period: string,
  netProfitCents: Cents,
): Promise<AdvisorReport> {
  // Liquid funds as of period end.
  const liquidCents = await queryLiquidCents(sql, tenantId, period);

  // Trailing-3m burn = average monthly expense+cogs over the 3 trailing periods.
  const trailing = trailingThreePeriods(period);
  const spends = await Promise.all(trailing.map((p) => queryPeriodSpendCents(sql, tenantId, p)));
  // Largest-remainder is not needed for an average; integer-truncate the mean cent.
  const monthlyBurnCents = Math.trunc(sumCents(spends) / trailing.length);

  const runwayMonths = computeRunwayMonths(liquidCents, monthlyBurnCents);

  // Month-over-month movers: current period vs the immediately prior month.
  const [currentActivity, priorActivity] = await Promise.all([
    queryAccountActivity(sql, tenantId, period),
    queryAccountActivity(sql, tenantId, shiftPeriod(period, 1)),
  ]);
  const movers = topMovers(currentActivity, priorActivity);

  // Per-project revenue vs allocated cost.
  const [revenueByProject, costByProject, usageByProject] = await Promise.all([
    queryRevenueByProject(sql, tenantId, period),
    queryCostByProject(sql, tenantId, period),
    queryUsageByProject(sql, period),
  ]);
  const roi = perProjectRoi(revenueByProject, costByProject);

  // Zombie subscriptions: recurring charges tied to a no-revenue, no-usage project.
  const subs = await querySubCharges(sql, tenantId, period);
  const zombieSubs = detectZombieSubs(subs, revenueByProject, usageByProject);

  // Persona playbook strategies applicable at this profit level.
  const playbook = applicableStrategies({ netProfitCents });
  const strategies = playbook.map(toStrategy);

  // Disclaimers: the standing informational note always; the PERSONA tax
  // disclaimer additionally whenever any tax-strategy item is surfaced.
  const disclaimers: string[] = [INFORMATIONAL_DISCLAIMER];
  if (strategies.length > 0) disclaimers.push(PERSONA.disclaimer);

  return {
    period,
    runwayMonths,
    monthlyBurnCents,
    topMovers: movers,
    zombieSubs,
    perProjectRoi: roi,
    strategies,
    disclaimers,
  };
}
