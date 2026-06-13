/**
 * Shared-cost allocation across projects. A shared cost (Netlify, the Claude Max
 * plan, Apple Developer membership, ...) is first booked against the `shared`
 * project; this module reallocates it onto the products that actually consumed it.
 *
 * The reallocation is a single BALANCED journal entry that nets to ZERO on the
 * expense account: it CREDITS the account back under `shared` for the full shared
 * total, and DEBITS the same account under each target project for that project's
 * split. The account's total balance is unchanged — only the per-project
 * attribution moves — so the books stay balanced and the trial balance never shifts.
 *
 * Money is integer cents throughout. Splits are computed with the EXACT
 * largest-remainder allocators from money.ts so the parts sum to the cent.
 */

import type { Sql } from "./db.js";
import type { AllocationMethod } from "./types.js";
import { allocateCents, evenSplit, sumCents } from "./money.js";
import { postEntry, periodBounds } from "./ledger.js";
import { warn } from "../lib/log.js";

/** The project (cost center) that holds shared costs before reallocation. */
const SHARED_PROJECT = "shared";

/** One target of an allocation: a project and the weight it carries. */
export interface AllocationWeightTarget {
  projectSlug: string;
  weight: number;
}

/** One project's resolved slice of an allocated total. */
export interface AllocationSplit {
  projectSlug: string;
  cents: number;
}

/** A summary of one rule's reallocation, returned to the close orchestrator. */
export interface AllocationSummary {
  ruleName: string;
  account: string;
  totalCents: number;
  splits: AllocationSplit[];
  idempotencyKey: string;
}

/**
 * Compute how `totalCents` divides across `targets` for a given `method`. PURE:
 * no DB, no clock — the splitting logic lives here so it is unit-testable on its
 * own. The result ALWAYS sums to exactly `totalCents` (largest-remainder split).
 *
 *   - even:                  equal weights regardless of provided weight.
 *   - fixed_percent
 *     | usage_weighted
 *     | revenue_weighted:    use the provided per-target weights as-is.
 *   - direct:                the first target carries 100%; the rest get 0.
 *
 * Edge cases: no targets -> empty; a single target -> the full total; all-zero
 * weights for a weighted method -> even split (allocateCents handles this).
 */
export function computeAllocation(
  totalCents: number,
  method: AllocationMethod,
  targets: Array<{ projectSlug: string; weight: number }>,
): Array<{ projectSlug: string; cents: number }> {
  const n = targets.length;
  if (n === 0) return [];

  let parts: number[];
  if (method === "direct") {
    // Direct: the first listed target absorbs the whole cost; others get nothing.
    parts = new Array<number>(n).fill(0);
    parts[0] = totalCents;
  } else if (method === "even") {
    // Even: ignore any provided weights and split equally to the cent.
    parts = evenSplit(totalCents, n);
  } else {
    // Weighted methods (fixed_percent | usage_weighted | revenue_weighted): use
    // the provided weights. allocateCents falls back to even when they sum to <= 0.
    parts = allocateCents(
      totalCents,
      targets.map((t) => t.weight),
    );
  }

  return targets.map((t, i) => ({ projectSlug: t.projectSlug, cents: parts[i] ?? 0 }));
}

// ─── DB rows (raw shapes from postgres) ───────────────────────────────────────

interface RuleRow {
  id: number;
  name: string;
  match_account_code: string | null;
  match_merchant_regex: string | null;
  method: AllocationMethod;
  basis_window: string;
}

interface TargetRow {
  project_slug: string;
  fixed_percent: string | null;
  usage_weight: string | null;
}

/**
 * Reallocate every enabled rule's shared cost for `period` onto its targets.
 *
 * For each enabled `acct_allocation_rules` row:
 *   1. Sum the period's POSTED net (debit - credit) on `match_account_code`
 *      attributed to the `shared` project. Skip if the shared total is 0.
 *   2. Resolve per-target weights by method:
 *        even             -> weight 1 each
 *        fixed_percent    -> the target's fixed_percent
 *        usage_weighted   -> acct_usage_metrics for the PRIOR period; even fallback
 *        revenue_weighted -> per-project revenue for the PRIOR period; even fallback
 *   3. computeAllocation(total, method, targets) for the exact split.
 *   4. Build ONE balanced reallocation entry: credit the account back under
 *      `shared` for the full total, debit the account under each target project
 *      for its split. idempotencyKey = `alloc:${ruleName}:${period}`,
 *      is_allocation = true, source = "allocation".
 *   5. postEntry (idempotent — re-running a close re-posts nothing).
 *
 * Returns one summary per rule that produced a (non-zero) reallocation.
 */
export async function allocate(
  sql: Sql,
  tenantId: string,
  period: string,
  // Reserved for future close-time options (e.g. a dry-run flag); unused today.
  _opts: {} = {},
): Promise<AllocationSummary[]> {
  const { start, end } = periodBounds(period);
  const { start: priorStart, end: priorEnd } = priorPeriodBounds(period);

  const rules = await sql<RuleRow[]>`
    SELECT id, name, match_account_code, match_merchant_regex, method, basis_window
    FROM acct_allocation_rules
    WHERE enabled = true
    ORDER BY id
  `;

  const summaries: AllocationSummary[] = [];

  for (const rule of rules) {
    const account = rule.match_account_code;
    if (!account) {
      // A rule with no account code can't be matched to a ledger line; skip it.
      warn(`allocate: rule "${rule.name}" has no match_account_code; skipped`);
      continue;
    }

    // 1) Shared total for the period on this account (net of any credits),
    //    narrowed by the rule's merchant regex so two rules on the SAME account
    //    (e.g. Netlify and Firebase both on 6160 Hosting) each claim only their own
    //    cost and a shared line is never allocated twice. Postgres ~* is already
    //    case-insensitive, so strip a leading (?i) inline flag from the seed regex.
    const merchantRegex = rule.match_merchant_regex
      ? rule.match_merchant_regex.replace(/^\(\?i\)/, "")
      : null;
    const total = await sharedTotalForAccount(sql, tenantId, account, start, end, merchantRegex);
    if (total === 0) {
      // Nothing booked to shared on this account this month — nothing to move.
      continue;
    }

    // 2) Targets + weights.
    const targetRows = await sql<TargetRow[]>`
      SELECT project_slug, fixed_percent, usage_weight
      FROM acct_allocation_targets
      WHERE rule_id = ${rule.id}
      ORDER BY id
    `;
    if (targetRows.length === 0) {
      warn(`allocate: rule "${rule.name}" has no targets; skipped`);
      continue;
    }

    const targets = await resolveWeights(
      sql,
      tenantId,
      rule.method,
      targetRows,
      priorStart,
      priorEnd,
    );

    // 3) Exact split.
    const splits = computeAllocation(total, rule.method, targets);

    // 4) Build the one balanced reallocation entry.
    const idempotencyKey = `alloc:${rule.name}:${period}`;
    const lines = [
      // Credit the account back under `shared` for the full total (back out the
      // shared attribution). Sign matches the original debit so this nets to zero.
      {
        accountCode: account,
        projectSlug: SHARED_PROJECT,
        debitCents: 0,
        creditCents: total,
        memo: `Reallocate ${rule.name} out of shared`,
      },
      // Debit the SAME account under each target for that project's slice.
      ...splits
        .filter((s) => s.cents !== 0)
        .map((s) => ({
          accountCode: account,
          projectSlug: s.projectSlug,
          debitCents: s.cents,
          creditCents: 0,
          memo: `Reallocate ${rule.name} -> ${s.projectSlug}`,
        })),
    ];

    // 5) Post idempotently. The entry balances by construction (credit total ===
    // sum of debit splits === total), so postEntry's assertBalanced passes.
    await postEntry(sql, tenantId, {
      entryDate: end, // dated to the last day of the period being closed.
      description: `Allocation: ${rule.name} (${period})`,
      source: "allocation",
      idempotencyKey,
      isAllocation: true,
      createdBy: "rule",
      lines,
    });

    summaries.push({ ruleName: rule.name, account, totalCents: total, splits, idempotencyKey });
  }

  return summaries;
}

/**
 * Net (debit - credit) on one account attributed to the `shared` project for the
 * period, restricted to POSTED entries. A shared expense is debit-normal, so a
 * positive result is the amount to reallocate. Existing allocation entries
 * (is_allocation = true) are EXCLUDED so a re-run doesn't double-count the credit
 * it already posted back to shared.
 */
async function sharedTotalForAccount(
  sql: Sql,
  tenantId: string,
  accountCode: string,
  start: string,
  end: string,
  merchantRegex: string | null = null,
): Promise<number> {
  const rows = await sql<{ net: string }[]>`
    SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS net
    FROM acct_journal_lines l
    JOIN acct_journal_entries e ON e.id = l.entry_id
    JOIN acct_chart c ON c.id = l.account_id
    JOIN acct_projects p ON p.id = l.project_id
    WHERE e.tenant_id = ${tenantId}
      AND e.status = 'posted'
      AND e.is_allocation = false
      AND e.entry_date BETWEEN ${start} AND ${end}
      AND c.code = ${accountCode}
      AND p.slug = ${SHARED_PROJECT}
      ${merchantRegex ? sql`AND e.description ~* ${merchantRegex}` : sql``}
  `;
  return Number(rows[0]?.net ?? 0);
}

/**
 * Resolve the weight for each target according to the rule's method. The shapes
 * computeAllocation consumes are `{projectSlug, weight}`; this is where the DB
 * meets that pure contract.
 */
async function resolveWeights(
  sql: Sql,
  tenantId: string,
  method: AllocationMethod,
  targetRows: TargetRow[],
  priorStart: string,
  priorEnd: string,
): Promise<AllocationWeightTarget[]> {
  if (method === "even" || method === "direct") {
    // even ignores weights anyway; direct uses position, not weight. Weight 1.
    return targetRows.map((t) => ({ projectSlug: t.project_slug, weight: 1 }));
  }

  if (method === "fixed_percent") {
    return targetRows.map((t) => ({
      projectSlug: t.project_slug,
      weight: t.fixed_percent != null ? Number(t.fixed_percent) : 0,
    }));
  }

  if (method === "usage_weighted") {
    const weights = await Promise.all(
      targetRows.map((t) => usageWeightForProject(sql, t.project_slug, priorStart, priorEnd)),
    );
    return withEvenFallback(targetRows, weights);
  }

  // revenue_weighted: per-project revenue (credit-normal) in the prior period.
  const weights = await Promise.all(
    targetRows.map((t) => revenueWeightForProject(sql, tenantId, t.project_slug, priorStart, priorEnd)),
  );
  return withEvenFallback(targetRows, weights);
}

/**
 * If the measured weights are all zero (no usage / no revenue recorded for the
 * prior period), fall back to an EVEN allocation (weight 1 each) so a missing
 * metric never silently drops the reallocation or starves a real cost center.
 */
function withEvenFallback(
  targetRows: TargetRow[],
  weights: number[],
): AllocationWeightTarget[] {
  const totalWeight = sumNonNegative(weights);
  if (totalWeight <= 0) {
    return targetRows.map((t) => ({ projectSlug: t.project_slug, weight: 1 }));
  }
  return targetRows.map((t, i) => ({ projectSlug: t.project_slug, weight: weights[i] ?? 0 }));
}

/** Sum of all usage-metric values for a project in the prior period. */
async function usageWeightForProject(
  sql: Sql,
  projectSlug: string,
  priorStart: string,
  priorEnd: string,
): Promise<number> {
  const { year, month } = ymOf(priorStart, priorEnd);
  const rows = await sql<{ total: string }[]>`
    SELECT COALESCE(SUM(value), 0) AS total
    FROM acct_usage_metrics
    WHERE project_slug = ${projectSlug}
      AND fiscal_year = ${year}
      AND fiscal_month = ${month}
  `;
  return Number(rows[0]?.total ?? 0);
}

/**
 * Prior-period revenue for a project = sum of (credit - debit) on revenue-type
 * accounts attributed to that project (revenue is credit-normal). Clamped to
 * non-negative so a refund-heavy month never produces a negative weight.
 */
async function revenueWeightForProject(
  sql: Sql,
  tenantId: string,
  projectSlug: string,
  priorStart: string,
  priorEnd: string,
): Promise<number> {
  const rows = await sql<{ rev: string }[]>`
    SELECT COALESCE(SUM(l.credit_cents - l.debit_cents), 0) AS rev
    FROM acct_journal_lines l
    JOIN acct_journal_entries e ON e.id = l.entry_id
    JOIN acct_chart c ON c.id = l.account_id
    JOIN acct_projects p ON p.id = l.project_id
    WHERE e.tenant_id = ${tenantId}
      AND e.status = 'posted'
      AND e.entry_date BETWEEN ${priorStart} AND ${priorEnd}
      AND c.type = 'revenue'
      AND p.slug = ${projectSlug}
  `;
  const rev = Number(rows[0]?.rev ?? 0);
  return rev > 0 ? rev : 0;
}

/** Sum only the non-negative weights (a negative metric must not cancel a real one). */
function sumNonNegative(weights: number[]): number {
  return sumCents(weights.map((w) => (w > 0 ? w : 0)));
}

/** First/last day of the calendar month BEFORE `period` (for prior-period basis). */
function priorPeriodBounds(period: string): { start: string; end: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) throw new Error(`bad period: ${period} (want YYYY-MM)`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  // month is 1..12; the prior month is (month-1), rolling back the year at January.
  const priorYear = month === 1 ? year - 1 : year;
  const priorMonth = month === 1 ? 12 : month - 1;
  const prior = `${priorYear}-${String(priorMonth).padStart(2, "0")}`;
  return periodBounds(prior);
}

/** Extract {year, month} from a period's start/end bounds (both share the month). */
function ymOf(start: string, _end: string): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(start);
  if (!m) throw new Error(`bad bound: ${start}`);
  return { year: Number(m[1]), month: Number(m[2]) };
}
