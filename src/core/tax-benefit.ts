/**
 * Tax-benefit ranking — the policy that lets the auditor, when GENUINELY UNSURE about
 * an otherwise-safe transaction, pick the category with the best tax outcome FOR THE
 * USER instead of leaving it for a human (Ariel, 2026-06-17). It is a PURE function:
 * given the council's defensible candidate accounts and the chart's tax treatment, it
 * returns the single most beneficial *reasonable* account, or null when none qualifies.
 *
 * "Most beneficial" = the largest CURRENT-YEAR deduction for a defensible category:
 *   ordinary (100% deductible now)  >  meals_50 (50%)  >  capital (deducted over years)
 *   >  personal / nondeductible (no benefit).
 * Two hard guardrails keep this from drifting into aggressive territory:
 *   1. Audit-sensitive accounts (home office, vehicle/mileage) are NEVER picked here —
 *      those stay human-gated regardless, matching Ariel's standing rule that aggressive
 *      deductions are always human-in-the-loop. The optimizer only ever chooses a
 *      "reasonable account that makes the most sense" (his words).
 *   2. Only real expense/COGS categories are eligible; a balance-sheet code is never
 *      auto-booked as an expense for tax benefit.
 * The candidate set itself comes from the council, which lists ONLY accounts it has
 * vouched as defensible — so the optimizer's job is purely to rank, never to invent a
 * category. Every pick is recorded, reversible, and re-learns from any human override.
 */
import type { AccountCandidate, AccountType, TaxTreatment } from "./types.js";

/** The chart facts the ranker needs about one account. */
export interface AccountTaxInfo {
  code: string;
  name: string;
  type: AccountType;
  taxTreatment: TaxTreatment;
  isBusiness: boolean;
  isActive: boolean;
}

export interface TaxOptimalPick {
  accountCode: string;
  businessPct: number;
  treatment: TaxTreatment;
  /** 0..100 current-year benefit score the pick won on. */
  benefit: number;
  /** Human-readable why-this-one (carried into the audit trail). */
  reasoning: string;
}

/**
 * Current-year deduction benefit of a tax treatment, 0..100. Higher = more immediately
 * beneficial. A non-business account scores 0 (no deduction). mileage/home_office get a
 * notional score for completeness but are excluded from selection by the sensitive set,
 * so they never actually win here.
 */
export function taxBenefitScore(treatment: TaxTreatment, isBusiness: boolean): number {
  if (!isBusiness) return 0;
  switch (treatment) {
    case "ordinary":
      return 100; // fully deductible this year
    case "mileage":
      return 60; // (sensitive — excluded from auto-pick)
    case "home_office":
      return 55; // (sensitive — excluded from auto-pick)
    case "meals_50":
      return 50; // half deductible
    case "capital":
      return 30; // real, but spread over future years (depreciation/§179 election)
    case "personal":
    case "nondeductible":
      return 0;
    default:
      return 0;
  }
}

/** Clamp a business-use percentage to a sane integer 0..100 (defaults to 100). */
function clampPct(p: number | undefined): number {
  if (p === undefined || !Number.isFinite(p)) return 100;
  return Math.max(0, Math.min(100, Math.round(p)));
}

/**
 * Pick the most tax-beneficial defensible account among `candidates`.
 *
 * @param candidates  defensible options from the council, best-first (the first is the
 *                    council's primary pick and wins ties to keep the choice stable).
 * @param chart       tax facts for every account, keyed however the caller likes; passed
 *                    as a Map<code, info> for O(1) lookup.
 * @param sensitiveCodes  account codes that are aggressive-deduction territory and must
 *                    stay human-gated — never auto-picked.
 * @returns the winning pick, or null when no candidate is a reasonable, eligible expense.
 */
export function pickTaxOptimal(
  candidates: AccountCandidate[],
  chart: Map<string, AccountTaxInfo>,
  sensitiveCodes: Set<string>,
): TaxOptimalPick | null {
  const seen = new Set<string>();
  const scored: { cand: AccountCandidate; info: AccountTaxInfo; score: number; order: number }[] = [];
  let order = 0;
  for (const cand of candidates) {
    const code = (cand.accountCode ?? "").trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const info = chart.get(code);
    if (!info || !info.isActive) continue; // unknown/inactive → not a real option
    if (sensitiveCodes.has(code)) continue; // aggressive — must stay human-gated
    if (info.type !== "expense" && info.type !== "cogs") continue; // only expense categories
    scored.push({ cand, info, score: taxBenefitScore(info.taxTreatment, info.isBusiness), order: order++ });
  }
  if (scored.length === 0) return null;

  // Highest current-year benefit wins; tie → higher business %; tie → council's order.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const pa = clampPct(a.cand.businessPct);
    const pb = clampPct(b.cand.businessPct);
    if (pb !== pa) return pb - pa;
    return a.order - b.order;
  });

  const best = scored[0]!;
  const alt = scored.length > 1 ? scored[1]! : null;
  const reasoning =
    `tax-optimal among ${scored.length} defensible account(s): chose ${best.info.code} ` +
    `${best.info.name} (${best.info.taxTreatment}, benefit ${best.score}/100)` +
    (alt ? ` over ${alt.info.code} ${alt.info.name} (${alt.info.taxTreatment}, ${alt.score}/100)` : "");

  return {
    accountCode: best.info.code,
    businessPct: clampPct(best.cand.businessPct),
    treatment: best.info.taxTreatment,
    benefit: best.score,
    reasoning,
  };
}
