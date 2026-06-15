/**
 * Realtime budget guidance: "should I make this purchase?" Given a prospective charge
 * against a category or project, it reports the budget impact grounded in the actual
 * ledger — what's spent, what's left, where this charge lands. The PURE decision is
 * unit-tested with no DB; the shell looks up the relevant materialized actual. It
 * NEVER invents numbers and always defers to a professional for prescriptive advice.
 */
import type { Sql } from "./db.js";
import type { Cents } from "./types.js";
import {
  evaluateBudgetLine,
  periodKeyFor,
  type PeriodKind,
  type BudgetEvaluation,
} from "./budgets.js";

export type GuidanceDecision = "ok" | "caution" | "over_budget" | "no_budget";

export interface Guidance {
  decision: GuidanceDecision;
  message: string;
  prospectiveCents: Cents;
  /** The budget line AFTER the prospective charge is applied (null if no budget). */
  after: BudgetEvaluation | null;
  remainingAfterCents: Cents | null;
}

/** Pure: fold a prospective charge into a budget and classify the result. */
export function guidanceFor(
  prospectiveCents: Cents,
  spentCents: Cents,
  limitCents: Cents,
  label: string,
): Guidance {
  const charge = Math.abs(prospectiveCents);
  if (limitCents <= 0) {
    return {
      decision: "no_budget",
      message: `No budget set for ${label}; tracking only.`,
      prospectiveCents: charge,
      after: null,
      remainingAfterCents: null,
    };
  }
  const after = evaluateBudgetLine(spentCents + charge, limitCents, spentCents + charge);
  const remainingAfter = limitCents - (spentCents + charge);
  let decision: GuidanceDecision;
  let message: string;
  const dollars = (c: number): string => `$${(Math.abs(c) / 100).toFixed(0)}`;
  if (after.status === "over") {
    decision = "over_budget";
    message = `This ${dollars(charge)} would put ${label} ${dollars(remainingAfter)} OVER its ${dollars(limitCents)} budget.`;
  } else if (after.pct >= 80) {
    decision = "caution";
    message = `This ${dollars(charge)} brings ${label} to ${after.pct.toFixed(0)}% of its ${dollars(limitCents)} budget (${dollars(remainingAfter)} left).`;
  } else {
    decision = "ok";
    message = `OK — ${label} would be at ${after.pct.toFixed(0)}% of budget with ${dollars(remainingAfter)} left.`;
  }
  return { decision, message, prospectiveCents: charge, after, remainingAfterCents: remainingAfter };
}

export interface GuideQuery {
  amountCents: Cents;
  accountCode?: string | null;
  projectSlug?: string | null;
  asOfISO: string;
}

/**
 * Guide a prospective charge against its most specific applicable budget. Prefers a
 * category budget on the account, then a project budget, then the overall budget.
 * Reads the current period's materialized actual (refreshActuals keeps it warm).
 */
export async function guideTransaction(
  sql: Sql,
  tenantId: string,
  q: GuideQuery,
): Promise<Guidance> {
  // Resolve the most specific enabled budget that covers this charge.
  const candidates = await sql<
    {
      id: number;
      name: string;
      period_kind: PeriodKind;
      scope: string;
      limit_cents: string;
    }[]
  >`
    SELECT id, name, period_kind, scope, limit_cents
    FROM acct_budgets
    WHERE tenant_id = ${tenantId} AND enabled
      AND (
        (scope = 'category' AND account_code = ${q.accountCode ?? null}) OR
        (scope = 'project'  AND project_slug = ${q.projectSlug ?? null}) OR
        (scope = 'overall')
      )
    ORDER BY CASE scope WHEN 'category' THEN 0 WHEN 'project' THEN 1 ELSE 2 END
    LIMIT 1`;

  if (candidates.length === 0) {
    return {
      decision: "no_budget",
      message: "No budget covers this charge; it will be tracked but not gated.",
      prospectiveCents: Math.abs(q.amountCents),
      after: null,
      remainingAfterCents: null,
    };
  }
  const b = candidates[0]!;
  const period = periodKeyFor(b.period_kind, q.asOfISO);
  const actual = await sql<{ spent_cents: string }[]>`
    SELECT spent_cents FROM acct_budget_actuals WHERE budget_id = ${b.id} AND period = ${period}`;
  const spent = Number(actual[0]?.spent_cents ?? 0);
  return guidanceFor(q.amountCents, spent, Number(b.limit_cents), b.name);
}
