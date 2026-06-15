/**
 * Budgets: the spine of the realtime budget assistant. Hybrid (envelope / zero-based
 * / fixed) category budgets PLUS per-project and overall budgets. The PURE functions
 * (period math, run-rate projection, status, alert decision) hold all the arithmetic
 * and are unit-tested with no DB; the thin DB shells refresh materialized actuals and
 * fire alerts. Money is integer cents. Spend is measured debit-normal on expense/cogs.
 */
import type { Sql } from "./db.js";
import type { Cents } from "./types.js";

export type PeriodKind = "month" | "quarter" | "year";
export type BudgetScope = "category" | "project" | "overall";
export type BudgetStatus = "under" | "warn" | "over" | "projected_over";

// ─── Mutations ────────────────────────────────────────────────────────────────────
export interface UpsertBudgetInput {
  name: string;
  periodKind: PeriodKind;
  scope: BudgetScope;
  accountCode?: string | null;
  projectSlug?: string | null;
  limitCents: Cents;
  method?: "envelope" | "zero_based" | "fixed";
  rollover?: boolean;
  /** Optional alert threshold (pct of limit); creates/updates the budget's alert. */
  alertThresholdPct?: number;
}

/** Create or update a budget (keyed by tenant + period kind + scope target) + its alert. */
export async function upsertBudget(sql: Sql, tenantId: string, input: UpsertBudgetInput): Promise<number> {
  const accountCode = input.scope === "category" ? input.accountCode ?? null : null;
  const projectSlug = input.scope === "project" ? input.projectSlug ?? null : null;
  const existing = await sql<{ id: number }[]>`
    SELECT id FROM acct_budgets
    WHERE tenant_id = ${tenantId} AND period_kind = ${input.periodKind} AND scope = ${input.scope}
      AND COALESCE(account_code,'') = ${accountCode ?? ""} AND COALESCE(project_slug,'') = ${projectSlug ?? ""}`;
  let id: number;
  if (existing.length > 0) {
    id = existing[0]!.id;
    await sql`UPDATE acct_budgets SET name = ${input.name}, limit_cents = ${input.limitCents},
              method = ${input.method ?? "envelope"}, rollover = ${input.rollover ?? false},
              enabled = true, updated_at = now() WHERE id = ${id}`;
  } else {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO acct_budgets (tenant_id, name, period_kind, scope, account_code, project_slug, limit_cents, method, rollover)
      VALUES (${tenantId}, ${input.name}, ${input.periodKind}, ${input.scope}, ${accountCode}, ${projectSlug},
              ${input.limitCents}, ${input.method ?? "envelope"}, ${input.rollover ?? false})
      RETURNING id`;
    id = row!.id;
  }
  if (input.alertThresholdPct !== undefined) {
    await sql`
      INSERT INTO acct_budget_alerts (budget_id, tenant_id, threshold_pct, channel)
      VALUES (${id}, ${tenantId}, ${input.alertThresholdPct}, 'push')
      ON CONFLICT (budget_id, threshold_pct) DO UPDATE SET enabled = true`;
  }
  return id;
}

// ─── Period math (pure) ─────────────────────────────────────────────────────────
/** The period key a date falls in, per kind: 'YYYY-MM' | 'YYYY-Qn' | 'YYYY'. */
export function periodKeyFor(kind: PeriodKind, dateISO: string): string {
  const [y, m] = dateISO.split("-").map(Number) as [number, number];
  if (kind === "year") return String(y);
  if (kind === "quarter") return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
  return `${y}-${String(m).padStart(2, "0")}`;
}

/** Inclusive [start, end] ISO dates of a period key. */
export function periodDateBounds(kind: PeriodKind, key: string): { start: string; end: string } {
  if (kind === "year") {
    const y = Number(key);
    return { start: `${y}-01-01`, end: `${y}-12-31` };
  }
  if (kind === "quarter") {
    const m = /^(\d{4})-Q([1-4])$/.exec(key);
    if (!m) throw new Error(`bad quarter key: ${key}`);
    const y = Number(m[1]);
    const q = Number(m[2]);
    const startMonth = (q - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    const lastDay = new Date(Date.UTC(y, endMonth, 0)).getUTCDate();
    return {
      start: `${y}-${String(startMonth).padStart(2, "0")}-01`,
      end: `${y}-${String(endMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
    };
  }
  const mm = /^(\d{4})-(\d{2})$/.exec(key);
  if (!mm) throw new Error(`bad month key: ${key}`);
  const y = Number(mm[1]);
  const mo = Number(mm[2]);
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { start: `${y}-${mm[2]}-01`, end: `${y}-${mm[2]}-${String(lastDay).padStart(2, "0")}` };
}

/** Day-of-period count and total days, used for the run-rate projection. */
export function periodProgress(
  kind: PeriodKind,
  key: string,
  asOfISO: string,
): { dayOfPeriod: number; totalDays: number } {
  const { start, end } = periodDateBounds(kind, key);
  const dStart = Date.parse(`${start}T00:00:00Z`);
  const dEnd = Date.parse(`${end}T00:00:00Z`);
  const dAsOf = Math.min(Math.max(Date.parse(`${asOfISO}T00:00:00Z`), dStart), dEnd);
  const day = 86_400_000;
  const totalDays = Math.round((dEnd - dStart) / day) + 1;
  const dayOfPeriod = Math.round((dAsOf - dStart) / day) + 1;
  return { dayOfPeriod, totalDays };
}

/** Straight-line run-rate projection of period-end spend from spend-so-far. */
export function projectSpend(spentCents: Cents, dayOfPeriod: number, totalDays: number): Cents {
  if (dayOfPeriod <= 0) return spentCents;
  return Math.round((spentCents / dayOfPeriod) * totalDays);
}

export interface BudgetEvaluation {
  spentCents: Cents;
  limitCents: Cents;
  projectedCents: Cents;
  pct: number; // spent / limit * 100, 0 if no limit
  status: BudgetStatus;
  remainingCents: Cents; // limit - spent (may be negative)
}

/** Pure status from spend/limit/projection + the warn threshold (pct of limit). */
export function evaluateBudgetLine(
  spentCents: Cents,
  limitCents: Cents,
  projectedCents: Cents,
  warnThresholdPct = 80,
): BudgetEvaluation {
  const pct = limitCents > 0 ? (spentCents / limitCents) * 100 : 0;
  let status: BudgetStatus;
  if (spentCents > limitCents) status = "over";
  else if (projectedCents > limitCents) status = "projected_over";
  else if (pct >= warnThresholdPct) status = "warn";
  else status = "under";
  return {
    spentCents,
    limitCents,
    projectedCents,
    pct: Math.round(pct * 100) / 100,
    status,
    remainingCents: limitCents - spentCents,
  };
}

// ─── Row shape ──────────────────────────────────────────────────────────────────
export interface BudgetRow {
  id: number;
  name: string;
  periodKind: PeriodKind;
  scope: BudgetScope;
  accountCode: string | null;
  projectSlug: string | null;
  limitCents: Cents;
  method: "envelope" | "zero_based" | "fixed";
  rollover: boolean;
}

async function loadBudgets(sql: Sql, tenantId: string): Promise<BudgetRow[]> {
  const rows = await sql<
    {
      id: number;
      name: string;
      period_kind: PeriodKind;
      scope: BudgetScope;
      account_code: string | null;
      project_slug: string | null;
      limit_cents: string;
      method: "envelope" | "zero_based" | "fixed";
      rollover: boolean;
    }[]
  >`SELECT id, name, period_kind, scope, account_code, project_slug, limit_cents, method, rollover
    FROM acct_budgets WHERE tenant_id = ${tenantId} AND enabled ORDER BY scope, name`;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    periodKind: r.period_kind,
    scope: r.scope,
    accountCode: r.account_code,
    projectSlug: r.project_slug,
    limitCents: Number(r.limit_cents),
    method: r.method,
    rollover: r.rollover,
  }));
}

/** Spend (debit-normal expense/cogs) for one budget's scope within [start,end]. */
async function spentForBudget(
  sql: Sql,
  tenantId: string,
  b: BudgetRow,
  start: string,
  end: string,
): Promise<Cents> {
  if (b.scope === "category") {
    const rows = await sql<{ s: string }[]>`
      SELECT COALESCE(SUM(l.debit_cents - l.credit_cents),0) s
      FROM acct_journal_lines l JOIN acct_journal_entries e ON e.id = l.entry_id
      JOIN acct_chart c ON c.id = l.account_id
      WHERE e.tenant_id = ${tenantId} AND e.status = 'posted'
        AND e.entry_date BETWEEN ${start} AND ${end}
        AND c.code = ${b.accountCode}`;
    return Number(rows[0]?.s ?? 0);
  }
  if (b.scope === "project") {
    const rows = await sql<{ s: string }[]>`
      SELECT COALESCE(SUM(l.debit_cents - l.credit_cents),0) s
      FROM acct_journal_lines l JOIN acct_journal_entries e ON e.id = l.entry_id
      JOIN acct_chart c ON c.id = l.account_id JOIN acct_projects p ON p.id = l.project_id
      WHERE e.tenant_id = ${tenantId} AND e.status = 'posted'
        AND e.entry_date BETWEEN ${start} AND ${end}
        AND c.type IN ('expense','cogs') AND p.slug = ${b.projectSlug}`;
    return Number(rows[0]?.s ?? 0);
  }
  const rows = await sql<{ s: string }[]>`
    SELECT COALESCE(SUM(l.debit_cents - l.credit_cents),0) s
    FROM acct_journal_lines l JOIN acct_journal_entries e ON e.id = l.entry_id
    JOIN acct_chart c ON c.id = l.account_id
    WHERE e.tenant_id = ${tenantId} AND e.status = 'posted'
      AND e.entry_date BETWEEN ${start} AND ${end}
      AND c.type IN ('expense','cogs')`;
  return Number(rows[0]?.s ?? 0);
}

export interface BudgetActual extends BudgetEvaluation {
  budgetId: number;
  name: string;
  scope: BudgetScope;
  accountCode: string | null;
  projectSlug: string | null;
  period: string;
}

/**
 * Refresh materialized actuals for every enabled budget as of `asOfISO`, and return
 * the evaluated lines (for the UI). Idempotent: upserts one row per (budget, period).
 */
export async function refreshActuals(
  sql: Sql,
  tenantId: string,
  asOfISO: string,
): Promise<BudgetActual[]> {
  const budgets = await loadBudgets(sql, tenantId);
  const out: BudgetActual[] = [];
  for (const b of budgets) {
    const period = periodKeyFor(b.periodKind, asOfISO);
    const { start, end } = periodDateBounds(b.periodKind, period);
    const spent = await spentForBudget(sql, tenantId, b, start, end);
    const { dayOfPeriod, totalDays } = periodProgress(b.periodKind, period, asOfISO);
    const projected = projectSpend(spent, dayOfPeriod, totalDays);
    const evalLine = evaluateBudgetLine(spent, b.limitCents, projected);
    await sql`
      INSERT INTO acct_budget_actuals (budget_id, tenant_id, period, spent_cents, limit_cents, projected_cents, pct, computed_at)
      VALUES (${b.id}, ${tenantId}, ${period}, ${spent}, ${b.limitCents}, ${projected}, ${evalLine.pct}, now())
      ON CONFLICT (budget_id, period) DO UPDATE SET
        spent_cents = EXCLUDED.spent_cents, limit_cents = EXCLUDED.limit_cents,
        projected_cents = EXCLUDED.projected_cents, pct = EXCLUDED.pct, computed_at = now()`;
    out.push({
      budgetId: b.id,
      name: b.name,
      scope: b.scope,
      accountCode: b.accountCode,
      projectSlug: b.projectSlug,
      period,
      ...evalLine,
    });
  }
  return out;
}

export interface BudgetAlertPayload {
  budgetId: number;
  name: string;
  period: string;
  pct: number;
  spentCents: Cents;
  limitCents: Cents;
  projectedCents: Cents;
  reason: "threshold" | "projected_over";
  message: string;
}

/** Injectable notifier (the Web Push transport is wired by the web app; default no-op). */
export interface BudgetNotifier {
  notify(tenantId: string, alert: BudgetAlertPayload): Promise<void>;
}

/**
 * Evaluate alerts and fire the ones that crossed this period (once per crossing).
 * Reads materialized actuals (call refreshActuals first), compares to each alert's
 * threshold and projected-over flag, updates last_fired, and dispatches via the
 * optional notifier. Returns the alerts fired this run.
 */
export async function checkAlerts(
  sql: Sql,
  tenantId: string,
  asOfISO: string,
  notifier?: BudgetNotifier,
): Promise<BudgetAlertPayload[]> {
  const rows = await sql<
    {
      alert_id: number;
      budget_id: number;
      name: string;
      period_kind: PeriodKind;
      threshold_pct: string;
      also_on_projected: boolean;
      last_fired_period: string | null;
      spent_cents: string | null;
      limit_cents: string | null;
      projected_cents: string | null;
      pct: string | null;
    }[]
  >`
    SELECT al.id alert_id, b.id budget_id, b.name, b.period_kind,
           al.threshold_pct, al.also_on_projected, al.last_fired_period,
           ba.spent_cents, ba.limit_cents, ba.projected_cents, ba.pct
    FROM acct_budget_alerts al
    JOIN acct_budgets b ON b.id = al.budget_id AND b.enabled
    LEFT JOIN acct_budget_actuals ba ON ba.budget_id = b.id
      AND ba.period = (
        CASE b.period_kind
          WHEN 'year' THEN to_char(${asOfISO}::date,'YYYY')
          WHEN 'quarter' THEN to_char(${asOfISO}::date,'YYYY') || '-Q' || to_char(EXTRACT(QUARTER FROM ${asOfISO}::date),'FM9')
          ELSE to_char(${asOfISO}::date,'YYYY-MM')
        END)
    WHERE al.tenant_id = ${tenantId} AND al.enabled`;

  const fired: BudgetAlertPayload[] = [];
  for (const r of rows) {
    if (r.spent_cents === null || r.limit_cents === null) continue;
    const period = periodKeyFor(r.period_kind, asOfISO);
    if (r.last_fired_period === period) continue; // already fired this period
    const pct = Number(r.pct ?? 0);
    const spent = Number(r.spent_cents);
    const limit = Number(r.limit_cents);
    const projected = Number(r.projected_cents ?? 0);
    const threshold = Number(r.threshold_pct);
    const hitThreshold = pct >= threshold;
    const hitProjected = r.also_on_projected && projected > limit && limit > 0;
    if (!hitThreshold && !hitProjected) continue;
    const reason: BudgetAlertPayload["reason"] = hitThreshold ? "threshold" : "projected_over";
    const payload: BudgetAlertPayload = {
      budgetId: r.budget_id,
      name: r.name,
      period,
      pct,
      spentCents: spent,
      limitCents: limit,
      projectedCents: projected,
      reason,
      message:
        reason === "threshold"
          ? `${r.name} is at ${pct.toFixed(0)}% of its ${period} budget ($${(spent / 100).toFixed(0)} of $${(limit / 100).toFixed(0)}).`
          : `${r.name} is on pace to exceed its ${period} budget (projected $${(projected / 100).toFixed(0)} vs $${(limit / 100).toFixed(0)}).`,
    };
    await sql`UPDATE acct_budget_alerts SET last_fired_period = ${period}, last_fired_at = now() WHERE id = ${r.alert_id}`;
    if (notifier) await notifier.notify(tenantId, payload);
    fired.push(payload);
  }
  return fired;
}
