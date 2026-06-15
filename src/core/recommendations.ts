/**
 * The advisory engine's persistence layer: turn the advisor's grounded analytics and
 * the budget evaluation into actionable, de-duplicated acct_recommendations the user
 * sees and can ack/dismiss/do. Every recommendation cites real numbers from the books
 * (rationale_json) — never invented figures — and an acct_advisor_runs row records the
 * grounded snapshot for the anti-hallucination audit. Bookkeeping/advisory only: each
 * item carries the standing "not financial advice" disclaimer via the advisor report.
 */
import type { Sql } from "./db.js";
import type { Cents } from "./types.js";
import { buildAdvisorReport } from "./advisor.js";
import { refreshActuals } from "./budgets.js";

/** Heuristic federal+state+SE set-aside fraction of net profit (clearly labeled, not advice). */
const TAX_SETASIDE_FRACTION = 0.3;
/** Warn when runway dips below this many months. */
const RUNWAY_WARN_MONTHS = 6;

export interface RecommendationSeed {
  kind: "savings" | "tax" | "cashflow" | "subscription" | "pricing" | "runway" | "anomaly";
  title: string;
  body: string;
  rationale: Record<string, unknown>;
  estImpactCents: Cents;
  confidence: number;
  dedupeKey: string;
}

/** Upsert one recommendation by dedupe key (refresh an existing non-dismissed one, else insert). */
async function upsertRecommendation(
  sql: Sql,
  tenantId: string,
  runId: number,
  seed: RecommendationSeed,
): Promise<void> {
  const existing = await sql<{ id: number }[]>`
    SELECT id FROM acct_recommendations
    WHERE tenant_id = ${tenantId} AND dedupe_key = ${seed.dedupeKey} AND status <> 'dismissed'
    ORDER BY id DESC LIMIT 1`;
  const rationale = sql.json(seed.rationale as Parameters<typeof sql.json>[0]);
  if (existing.length > 0) {
    await sql`
      UPDATE acct_recommendations
      SET title = ${seed.title}, body = ${seed.body}, rationale_json = ${rationale},
          est_impact_cents = ${seed.estImpactCents}, confidence = ${seed.confidence},
          run_id = ${runId}, updated_at = now()
      WHERE id = ${existing[0]!.id}`;
    return;
  }
  await sql`
    INSERT INTO acct_recommendations
      (tenant_id, kind, title, body, rationale_json, est_impact_cents, confidence, generated_by, dedupe_key, run_id)
    VALUES (${tenantId}, ${seed.kind}, ${seed.title}, ${seed.body}, ${rationale},
            ${seed.estImpactCents}, ${seed.confidence}, 'engine', ${seed.dedupeKey}, ${runId})`;
}

export interface GenerateResult {
  runId: number;
  generated: number;
  seeds: RecommendationSeed[];
}

/**
 * Generate recommendations for a period. Sources, all grounded in the locked books:
 *   - zombie subscriptions (cancel candidates)        → kind 'subscription'
 *   - over / projected-over budgets                    → kind 'savings'
 *   - low runway                                       → kind 'runway'
 *   - tax set-aside when net profit is positive        → kind 'tax' (heuristic, disclaimed)
 * De-duplicated by stable keys so re-running refreshes rather than spams.
 */
export async function generateRecommendations(
  sql: Sql,
  tenantId: string,
  period: string,
  netProfitCents: Cents,
  asOfISO: string,
): Promise<GenerateResult> {
  const report = await buildAdvisorReport(sql, tenantId, period, netProfitCents);
  const budgetLines = await refreshActuals(sql, tenantId, asOfISO);

  const [run] = await sql<{ id: number }[]>`
    INSERT INTO acct_advisor_runs (tenant_id, as_of_date, inputs_json, generated_by)
    VALUES (${tenantId}, ${asOfISO},
            ${sql.json({ period, netProfitCents, runwayMonths: isFinite(report.runwayMonths) ? report.runwayMonths : null, monthlyBurnCents: report.monthlyBurnCents } as Parameters<typeof sql.json>[0])},
            'engine')
    RETURNING id`;
  const runId = run!.id;

  const seeds: RecommendationSeed[] = [];

  // Zombie subscriptions — recurring spend on a no-revenue, no-usage project.
  for (const z of report.zombieSubs) {
    seeds.push({
      kind: "subscription",
      title: `Cancel candidate: ${z.merchant}`,
      body: `${z.merchant} costs ~$${(z.monthlyCents / 100).toFixed(0)}/mo and is tied to ${z.projectSlug ?? "an unattributed project"} which has no revenue or usage this period.`,
      rationale: { merchant: z.merchant, monthlyCents: z.monthlyCents, projectSlug: z.projectSlug, lastSeenMonth: z.lastSeenMonth },
      estImpactCents: z.monthlyCents * 12,
      confidence: 0.7,
      dedupeKey: `zombie:${z.merchant}:${z.projectSlug ?? "none"}`,
    });
  }

  // Over / projected-over budgets — rein-in candidates.
  for (const b of budgetLines) {
    if (b.status === "over" || b.status === "projected_over") {
      const over = b.status === "over";
      seeds.push({
        kind: "savings",
        title: `${over ? "Over budget" : "On pace to exceed"}: ${b.name}`,
        body: over
          ? `${b.name} is $${((b.spentCents - b.limitCents) / 100).toFixed(0)} over its $${(b.limitCents / 100).toFixed(0)} budget for ${b.period}.`
          : `${b.name} is projected to hit $${(b.projectedCents / 100).toFixed(0)} vs a $${(b.limitCents / 100).toFixed(0)} budget for ${b.period}.`,
        rationale: { budgetId: b.budgetId, scope: b.scope, spentCents: b.spentCents, limitCents: b.limitCents, projectedCents: b.projectedCents, pct: b.pct },
        estImpactCents: over ? b.spentCents - b.limitCents : Math.max(0, b.projectedCents - b.limitCents),
        confidence: over ? 0.95 : 0.75,
        dedupeKey: `budget:${b.budgetId}:${b.period}`,
      });
    }
  }

  // Runway warning.
  if (isFinite(report.runwayMonths) && report.runwayMonths < RUNWAY_WARN_MONTHS) {
    seeds.push({
      kind: "runway",
      title: `Runway is ${report.runwayMonths.toFixed(1)} months`,
      body: `At the trailing burn of ~$${(report.monthlyBurnCents / 100).toFixed(0)}/mo, current liquid funds last ~${report.runwayMonths.toFixed(1)} months. Consider trimming spend or accelerating revenue.`,
      rationale: { runwayMonths: report.runwayMonths, monthlyBurnCents: report.monthlyBurnCents },
      estImpactCents: 0,
      confidence: 0.85,
      dedupeKey: `runway:${period}`,
    });
  }

  // Tax set-aside (heuristic, clearly labeled — defer to a professional for the real number).
  if (netProfitCents > 0) {
    const setAside = Math.round(netProfitCents * TAX_SETASIDE_FRACTION);
    seeds.push({
      kind: "tax",
      title: `Set aside ~$${(setAside / 100).toFixed(0)} for taxes`,
      body: `Net profit this period is ~$${(netProfitCents / 100).toFixed(0)}. A rough ${(TAX_SETASIDE_FRACTION * 100).toFixed(0)}% set-aside is ~$${(setAside / 100).toFixed(0)}. This is a heuristic, not a calculated estimate — confirm with a professional.`,
      rationale: { netProfitCents, fraction: TAX_SETASIDE_FRACTION, setAsideCents: setAside, note: "heuristic, not the entity-specific estimate" },
      estImpactCents: setAside,
      confidence: 0.6,
      dedupeKey: `tax_setaside:${period}`,
    });
  }

  for (const s of seeds) await upsertRecommendation(sql, tenantId, runId, s);
  await sql`UPDATE acct_advisor_runs SET recommendation_count = ${seeds.length} WHERE id = ${runId}`;

  return { runId, generated: seeds.length, seeds };
}
