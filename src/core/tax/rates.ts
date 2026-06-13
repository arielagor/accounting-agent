/**
 * Tax rate loading + the PURE tax-math primitives. Rates are NEVER literals in
 * code (persona red line: positions must be defensible against the live tables),
 * so every parameter is read from `acct_tax_rates` for the requested tax year and
 * handed to the strategies as a `TaxRateSet`. The math below operates on integer
 * cents and returns integer cents — no float drift in a number a CPA will sign.
 *
 * Bracket convention (matches the seed): an array of `[lowerBoundCents, marginalRate]`
 * pairs, ascending by lower bound. The marginal rate applies to income ABOVE that
 * bound up to the next bound (progressive), exactly like the IRS/CA schedules.
 */
import type { Sql } from "../db.js";
import type { TaxRateSet } from "../types.js";

// ─── Parameter shapes (the JSON stored per `kind` in acct_tax_rates) ───────────
/** federal `se_tax` params: Social-Security + Medicare self-employment tax. */
export interface SeTaxParams {
  ss_rate: number;
  medicare_rate: number;
  ss_wage_base_cents: number;
  net_se_factor: number;
  addl_medicare_rate: number;
  addl_medicare_threshold_cents: number;
}

/** A progressive bracket schedule: ascending `[lowerBoundCents, marginalRate]`. */
export type BracketSchedule = [number, number][];

/** A per-filing-status map (single/mfj/...) used by std_deduction + income_bracket. */
export type ByFilingStatus<T> = Record<string, T | undefined>;

/** federal `qbi` params. */
export interface QbiParams {
  rate: number;
}

/** federal/CA `corp_rate` params (`min_franchise_cents` only present for CA). */
export interface CorpRateParams {
  rate: number;
  min_franchise_cents?: number;
}

/** CA `llc_fee` params: a flat annual tax plus a gross-receipts fee tier table. */
export interface LlcFeeParams {
  annual_tax_cents: number;
  /** Ascending `[grossUpperBoundCents, feeCents]`; the first tier whose bound the
   *  gross receipts do NOT exceed sets the fee (a step function, not interpolated). */
  fee_tiers: [number, number][];
}

// ─── Loading ───────────────────────────────────────────────────────────────────
interface RateRow {
  jurisdiction: string;
  kind: string;
  param_json: Record<string, unknown>;
}

/**
 * Read every rate row for `taxYear` into a `TaxRateSet`, grouped by jurisdiction:
 *   { federal: { se_tax: {...}, income_bracket: {...}, ... },
 *     state:   { income_bracket: {...}, llc_fee: {...}, ... } }
 * "state" collects every non-federal jurisdiction (Phase 1 is CA-only, but the
 * grouping is jurisdiction-agnostic so a second state needs no code change here).
 * The strategies index this map by `kind`; a missing kind surfaces as a clear
 * lookup error at compute time rather than a silent zero.
 */
export async function loadRates(sql: Sql, taxYear: number): Promise<TaxRateSet> {
  const rows = await sql<RateRow[]>`
    SELECT jurisdiction, kind, param_json
    FROM acct_tax_rates
    WHERE tax_year = ${taxYear}
  `;
  const federal: Record<string, unknown> = {};
  const state: Record<string, unknown> = {};
  for (const r of rows) {
    if (r.jurisdiction === "federal") {
      federal[r.kind] = r.param_json;
    } else {
      // Every non-federal jurisdiction (CA today) lands in `state`.
      state[r.kind] = r.param_json;
    }
  }
  return { taxYear, federal, state };
}

// ─── Pure math primitives ───────────────────────────────────────────────────────
/**
 * Self-employment tax on net SE profit (already net-SE-factored? no — we apply the
 * factor here, exactly as Schedule SE does). Returns integer cents of SE tax:
 *   base   = round(netSeProfit * net_se_factor)   (the 92.35% adjustment)
 *   SS     = min(base, ss_wage_base) * ss_rate     (Social Security, capped)
 *   medi   = base * medicare_rate                  (Medicare, uncapped)
 *   addl   = max(0, base - addl_threshold) * addl_medicare_rate (Additional Medicare)
 * Non-positive profit yields zero (no negative SE tax).
 */
export function computeSeTax(netSeProfitCents: number, seParams: SeTaxParams): number {
  if (netSeProfitCents <= 0) return 0;
  const base = Math.round(netSeProfitCents * seParams.net_se_factor);
  const ssBaseCents = Math.min(base, seParams.ss_wage_base_cents);
  const ss = Math.round(ssBaseCents * seParams.ss_rate);
  const medicare = Math.round(base * seParams.medicare_rate);
  const overThreshold = Math.max(0, base - seParams.addl_medicare_threshold_cents);
  const addl = Math.round(overThreshold * seParams.addl_medicare_rate);
  return ss + medicare + addl;
}

/**
 * Progressive income tax on `taxableCents` against an ascending bracket schedule.
 * For each bracket the marginal rate applies to the slice of income between this
 * bracket's lower bound and the next bracket's lower bound (or the top of income).
 * Negative/zero taxable income yields zero. Result is integer cents (rounded once
 * at the end so the per-slice arithmetic stays exact).
 */
export function computeBracketTax(taxableCents: number, brackets: BracketSchedule): number {
  if (taxableCents <= 0 || brackets.length === 0) return 0;
  let tax = 0;
  for (let i = 0; i < brackets.length; i += 1) {
    const bracket = brackets[i]!;
    const lower = bracket[0];
    const rate = bracket[1];
    if (taxableCents <= lower) break; // income never reaches this bracket
    const next = brackets[i + 1];
    const upper = next ? next[0] : Infinity;
    const sliceTop = Math.min(taxableCents, upper);
    const slice = sliceTop - lower;
    if (slice > 0) tax += slice * rate;
  }
  return Math.round(tax);
}

/**
 * Section 199A QBI deduction: `rate` (e.g. 0.20) times qualified business income.
 * Floored at zero — a loss produces no deduction. Integer cents. (Phase 1 ignores
 * the taxable-income limit and the SSTB phase-out; those are CPA-reviewed and
 * surfaced as an aggressive-position note, never silently applied.)
 */
export function qbiDeduction(netCents: number, rate: number): number {
  if (netCents <= 0) return 0;
  return Math.round(netCents * rate);
}

/**
 * The CA LLC obligation for the year: a flat `annual_tax_cents` ($800) plus the
 * gross-receipts fee from the first tier whose upper bound the receipts do not
 * exceed (a step function — receipts under the smallest tier owe $0 fee). The
 * combined number is what an LLC actually writes to the FTB. Integer cents.
 */
export function caLlcFee(grossReceiptsCents: number, params: LlcFeeParams): number {
  const gross = Math.max(0, grossReceiptsCents);
  let fee = 0;
  for (const tier of params.fee_tiers) {
    const upper = tier[0];
    const tierFee = tier[1];
    if (gross <= upper) {
      fee = tierFee;
      break;
    }
    // Above every listed tier: the last (largest) tier's fee applies.
    fee = tierFee;
  }
  return params.annual_tax_cents + fee;
}

// ─── Typed accessors over the loaded TaxRateSet ─────────────────────────────────
// These pull a `kind` out of the federal/state map and assert the expected shape,
// failing loudly on a missing parameter rather than computing against `undefined`.
function requireKind(
  bag: Record<string, unknown>,
  kind: string,
  jurisdiction: "federal" | "state",
): Record<string, unknown> {
  const v = bag[kind];
  if (v === undefined || v === null || typeof v !== "object") {
    throw new Error(`tax rate missing: ${jurisdiction}.${kind}`);
  }
  return v as Record<string, unknown>;
}

/** federal self-employment tax parameters. */
export function federalSeParams(rates: TaxRateSet): SeTaxParams {
  return requireKind(rates.federal, "se_tax", "federal") as unknown as SeTaxParams;
}

/** federal standard deduction (cents) for a filing status. */
export function federalStdDeduction(rates: TaxRateSet, filingStatus: string): number {
  const map = requireKind(rates.federal, "std_deduction", "federal") as ByFilingStatus<number>;
  return map[filingStatus] ?? map["single"] ?? 0;
}

/** federal progressive income brackets for a filing status (falls back to single). */
export function federalBrackets(rates: TaxRateSet, filingStatus: string): BracketSchedule {
  const map = requireKind(rates.federal, "income_bracket", "federal") as ByFilingStatus<BracketSchedule>;
  return map[filingStatus] ?? map["single"] ?? [];
}

/** federal QBI rate (e.g. 0.20). */
export function federalQbiRate(rates: TaxRateSet): number {
  return (requireKind(rates.federal, "qbi", "federal") as unknown as QbiParams).rate;
}

/** federal corporate rate (e.g. 0.21). */
export function federalCorpRate(rates: TaxRateSet): CorpRateParams {
  return requireKind(rates.federal, "corp_rate", "federal") as unknown as CorpRateParams;
}

/** CA standard deduction (cents) for a filing status. */
export function stateStdDeduction(rates: TaxRateSet, filingStatus: string): number {
  const map = requireKind(rates.state, "std_deduction", "state") as ByFilingStatus<number>;
  return map[filingStatus] ?? map["single"] ?? 0;
}

/** CA progressive income brackets for a filing status (falls back to single). */
export function stateBrackets(rates: TaxRateSet, filingStatus: string): BracketSchedule {
  const map = requireKind(rates.state, "income_bracket", "state") as ByFilingStatus<BracketSchedule>;
  return map[filingStatus] ?? map["single"] ?? [];
}

/** CA corporate rate + minimum franchise tax. */
export function stateCorpRate(rates: TaxRateSet): CorpRateParams {
  return requireKind(rates.state, "corp_rate", "state") as unknown as CorpRateParams;
}

/** CA LLC fee parameters (annual tax + gross-receipts fee tiers). */
export function stateLlcFeeParams(rates: TaxRateSet): LlcFeeParams {
  return requireKind(rates.state, "llc_fee", "state") as unknown as LlcFeeParams;
}
