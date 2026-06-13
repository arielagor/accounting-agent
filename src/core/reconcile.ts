/**
 * Reconciliation. Raw bank/card transactions are matched against each other and
 * against Stripe's own payout records so the close knows which money movements
 * are which: a card payment (checking outflow paired with a card-balance inflow)
 * is an internal transfer, NOT two expenses; a deposit on the Stripe payout
 * account is revenue net of fees, anchored to the actual payout id.
 *
 * The matching logic is extracted into PURE functions (no DB, no network) so the
 * direction-sensitive, money-bearing decisions are testable in isolation. The DB
 * wrapper `reconcile` is thin: it loads, calls the pure matchers, and writes the
 * decision overlay to acct_recon — raw transactions stay immutable.
 *
 * Sign convention (matches ingestion): negative = outflow, positive = inflow.
 */
import type { Sql } from "./db.js";
import type { ReconResult, ReconMatchType, ReconStatus } from "./types.js";
import { periodBounds } from "./ledger.js";
import { log } from "../lib/log.js";

// ─── Stripe payout reader (injectable) ──────────────────────────────────────────
/**
 * A single Stripe payout: gross charged, processor fee withheld, and the net that
 * actually lands in the bank. `metadataApp` tags which product/app a payout
 * belongs to when set (shared-account fan-out — see the Stripe webhook lesson).
 */
export interface StripePayout {
  id: string;
  grossCents: number;
  feeCents: number;
  netCents: number;
  arrivalDate: string; // YYYY-MM-DD
  metadataApp: string | null;
}

/**
 * Read-only Stripe access, injected so `reconcile` is testable with a mock and so
 * close.ts can supply a real client later. By construction there is no payout/pay
 * verb — this only LISTS payouts, never moves money.
 */
export interface StripeReader {
  listPayouts(sinceIso: string): Promise<StripePayout[]>;
}

// ─── Raw transaction projection ─────────────────────────────────────────────────
/**
 * The slice of a raw transaction the matchers need, joined with its source
 * account's type and Stripe-destination flag. `accountType` is the provider type
 * ("depository" | "credit" | ...); the matchers only care about depository vs
 * credit for transfer pairing.
 */
export interface RawTxnLite {
  id: number;
  sourceAccountId: number;
  accountType: "depository" | "credit" | string;
  amountCents: number; // signed: negative = outflow, positive = inflow
  postedDate: string | null; // YYYY-MM-DD
  description: string;
  isStripePayoutDest: boolean;
}

/** Description shapes that mark a credit-card payment / inter-account transfer. */
const PAYMENT_DESC = /PAYMENT|AUTOPAY|THANK ?YOU|ONLINE PMT/i;

/** Whole days between two YYYY-MM-DD dates (absolute). Null date => Infinity (never within tolerance). */
function dayGap(a: string | null, b: string | null): number {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return Number.POSITIVE_INFINITY;
  return Math.abs(ta - tb) / 86_400_000;
}

// ─── Pure matcher: card-payment / internal transfers ─────────────────────────────
/**
 * Pair a depository OUTFLOW (amount < 0 — money leaves checking) with a
 * credit-account INFLOW (amount > 0 — a payment REDUCES the card balance, which on
 * a liability account reads as a positive/inflow movement) of EQUAL absolute amount
 * within `toleranceDays`, where at least one leg carries a payment-like description.
 * These two legs net to zero across the books, so they are an internal transfer,
 * not two independent expenses.
 *
 * A half-match (only one leg present) is NEVER returned as a pair — the caller
 * flags those for review instead. Each raw txn is used in at most one pair, and the
 * closest-dated candidate wins so a month of repeated equal-amount payments pairs
 * deterministically.
 */
export function matchTransfers(
  txns: RawTxnLite[],
  toleranceDays = 3,
): { pairs: Array<{ debitTxnId: number; creditTxnId: number }> } {
  // Debit leg = the depository outflow (money out of checking).
  const debitLegs = txns.filter((t) => t.accountType === "depository" && t.amountCents < 0);
  // Credit leg = the credit-account inflow (a payment landing against the card).
  const creditLegs = txns.filter((t) => t.accountType === "credit" && t.amountCents > 0);

  const pairs: Array<{ debitTxnId: number; creditTxnId: number }> = [];
  const usedCredit = new Set<number>();

  // Stable order: by date then id so pairing is deterministic across runs.
  const orderedDebits = [...debitLegs].sort(byDateThenId);

  for (const debit of orderedDebits) {
    const wantAbs = Math.abs(debit.amountCents);
    let best: RawTxnLite | null = null;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const credit of creditLegs) {
      if (usedCredit.has(credit.id)) continue;
      if (Math.abs(credit.amountCents) !== wantAbs) continue;
      // A payment-like description on EITHER leg qualifies the pair.
      if (!PAYMENT_DESC.test(debit.description) && !PAYMENT_DESC.test(credit.description)) continue;
      const gap = dayGap(debit.postedDate, credit.postedDate);
      if (gap > toleranceDays) continue;
      if (gap < bestGap) {
        bestGap = gap;
        best = credit;
      }
    }
    if (best) {
      usedCredit.add(best.id);
      pairs.push({ debitTxnId: debit.id, creditTxnId: best.id });
    }
  }
  return { pairs };
}

function byDateThenId(a: RawTxnLite, b: RawTxnLite): number {
  const da = a.postedDate ?? "";
  const db = b.postedDate ?? "";
  return da.localeCompare(db) || a.id - b.id;
}

// ─── Pure matcher: Stripe payouts ────────────────────────────────────────────────
/** A deposit matched to a Stripe payout. `exact` distinguishes an exact-net hit from a near-miss. */
export interface StripeMatch {
  depositTxnId: number;
  payoutId: string;
  exact: boolean;
}

/**
 * Match deposits that landed on a Stripe-payout-destination account to the Stripe
 * payouts that produced them. A deposit matches a payout when its absolute amount
 * equals `payout.netCents` within `toleranceCents` AND the payout `arrivalDate` is
 * within +/-2 days of the deposit `postedDate`.
 *
 * `exact` is true only when the amount is a penny-perfect net match; an
 * amount-within-tolerance hit (rounding/timing drift, or a fee re-estimate) is
 * returned with `exact: false` so the caller can route it to review rather than
 * silently posting a non-exact number.
 *
 * Each deposit pairs with at most one payout, and each payout with at most one
 * deposit; exact candidates are preferred over near-misses, then the closest date.
 */
export function matchStripePayouts(
  deposits: RawTxnLite[],
  payouts: StripePayout[],
  toleranceCents: number,
): StripeMatch[] {
  const tol = Math.abs(toleranceCents);
  const out: StripeMatch[] = [];
  const usedPayout = new Set<string>();

  // Only deposits (inflows) on a Stripe payout destination account are candidates.
  const candidates = deposits
    .filter((d) => d.isStripePayoutDest && d.amountCents > 0)
    .sort(byDateThenId);

  for (const dep of candidates) {
    const depAbs = Math.abs(dep.amountCents);
    let best: { payout: StripePayout; exact: boolean; gap: number } | null = null;
    for (const payout of payouts) {
      if (usedPayout.has(payout.id)) continue;
      const delta = Math.abs(depAbs - Math.abs(payout.netCents));
      if (delta > tol) continue;
      const gap = dayGap(dep.postedDate, payout.arrivalDate);
      if (gap > 2) continue;
      const exact = delta === 0;
      // Prefer exact over near-miss, then the closest arrival date.
      if (
        best === null ||
        (exact && !best.exact) ||
        (exact === best.exact && gap < best.gap)
      ) {
        best = { payout, exact, gap };
      }
    }
    if (best) {
      usedPayout.add(best.payout.id);
      out.push({ depositTxnId: dep.id, payoutId: best.payout.id, exact: best.exact });
    }
  }
  return out;
}

// ─── DB wrapper ──────────────────────────────────────────────────────────────────
interface ReconcileOpts {
  toleranceCents: number;
  escalateDeltaCents: number;
  stripe?: StripeReader;
}

interface RawTxnRow {
  id: string;
  source_account_id: string;
  account_type: string | null;
  amount_cents: string;
  posted_date: string | null;
  description_raw: string | null;
  is_stripe_payout_dest: boolean;
}

/**
 * Confidence levels written to acct_recon.confidence (numeric(4,3), so 0..1).
 * Exact, deterministic matches are high; near-misses that need a human eye are low.
 */
const CONFIDENCE = {
  exactStripe: 0.99,
  nearStripe: 0.6,
  transfer: 0.95,
  halfTransfer: 0.4,
} as const;

/**
 * Reconcile a period. Loads the period's raw transactions (joined with their
 * source account for type + Stripe-destination flag), runs the pure matchers,
 * writes the resulting decisions to acct_recon, and returns the ReconResult list.
 *
 * Statuses: confident matches post `auto`; half-matched transfer legs and
 * near-miss Stripe deposits post `needs_review`. Re-running a period is safe — the
 * period's prior acct_recon rows are cleared first, so this is idempotent.
 */
export async function reconcile(
  sql: Sql,
  tenantId: string,
  period: string,
  opts: ReconcileOpts,
): Promise<ReconResult[]> {
  const { start, end } = periodBounds(period);

  const rows = await sql<RawTxnRow[]>`
    SELECT r.id,
           r.source_account_id,
           a.type                  AS account_type,
           r.amount_cents,
           r.posted_date,
           r.description_raw,
           a.is_stripe_payout_dest
    FROM acct_transactions_raw r
    JOIN acct_source_accounts a ON a.id = r.source_account_id
    WHERE r.tenant_id = ${tenantId}
      AND r.superseded_at IS NULL
      AND r.posted_date BETWEEN ${start} AND ${end}
    ORDER BY r.posted_date, r.id
  `;

  const txns: RawTxnLite[] = rows.map((r) => ({
    id: Number(r.id),
    sourceAccountId: Number(r.source_account_id),
    accountType: r.account_type ?? "unknown",
    amountCents: Number(r.amount_cents),
    postedDate: r.posted_date,
    description: r.description_raw ?? "",
    isStripePayoutDest: r.is_stripe_payout_dest,
  }));

  const results = buildReconResults(txns, opts.escalateDeltaCents, await loadPayouts(opts, start, txns));

  // Persist: clear this period's overlay, then re-insert. Raw stays immutable.
  await sql.begin(async (tx) => {
    await tx`
      DELETE FROM acct_recon
      WHERE tenant_id = ${tenantId}
        AND raw_txn_id IN (
          SELECT id FROM acct_transactions_raw
          WHERE tenant_id = ${tenantId}
            AND posted_date BETWEEN ${start} AND ${end}
        )
    `;
    for (const res of results) {
      await tx`
        INSERT INTO acct_recon (raw_txn_id, tenant_id, match_type, matched_ref, confidence, status, note)
        VALUES (
          ${res.rawTxnId}, ${tenantId}, ${res.matchType}, ${res.matchedRef},
          ${res.confidence}, ${res.status}, ${res.note ?? null}
        )
      `;
    }
  });

  log(`reconcile ${period}: ${results.length} txns,`,
    `${results.filter((r) => r.status === "needs_review").length} need review`);
  return results;
}

/** Fetch Stripe payouts for the period (since the period start), tolerating no reader. */
async function loadPayouts(
  opts: ReconcileOpts,
  start: string,
  txns: RawTxnLite[],
): Promise<StripePayout[]> {
  // Only bother calling Stripe if there is at least one payout-destination deposit.
  const hasStripeDest = txns.some((t) => t.isStripePayoutDest && t.amountCents > 0);
  if (!opts.stripe || !hasStripeDest) return [];
  try {
    return await opts.stripe.listPayouts(`${start}T00:00:00Z`);
  } catch (err) {
    // Fail-soft: a Stripe read failure leaves those deposits unmatched for review,
    // it must never abort the whole reconciliation.
    log(`reconcile: Stripe payout fetch failed, leaving deposits unmatched: ${String(err)}`);
    return [];
  }
}

/**
 * Pure assembly of ReconResult[] from raw txns + Stripe payouts. Runs both
 * matchers, then classifies every transaction: a matched leg gets its match type;
 * a Stripe-destination deposit with no exact payout match becomes a near-miss
 * needing review; everything else is left `unmatched` (the categorizer handles it).
 *
 * Exported for unit testing the end-to-end classification without a DB.
 */
export function buildReconResults(
  txns: RawTxnLite[],
  escalateDeltaCents: number,
  payouts: StripePayout[],
): ReconResult[] {
  // toleranceCents for the Stripe matcher: anything within the escalate delta is a
  // candidate; exact vs near-miss is decided inside the matcher.
  const tol = Math.abs(escalateDeltaCents);
  const stripeMatches = matchStripePayouts(txns, payouts, tol);
  const { pairs } = matchTransfers(txns);

  const result = new Map<number, ReconResult>();

  // 1) Stripe payout matches (exact -> auto, near-miss -> needs_review).
  const stripeMatchedDeposits = new Set<number>();
  for (const m of stripeMatches) {
    stripeMatchedDeposits.add(m.depositTxnId);
    result.set(m.depositTxnId, {
      rawTxnId: m.depositTxnId,
      matchType: "stripe_payout",
      matchedRef: m.payoutId,
      confidence: m.exact ? CONFIDENCE.exactStripe : CONFIDENCE.nearStripe,
      status: m.exact ? "auto" : "needs_review",
      note: m.exact ? undefined : `Stripe net within ${tol}c of deposit but not exact`,
    });
  }

  // 2) Transfer pairs (both legs auto, referencing each other).
  const pairedTxns = new Set<number>();
  for (const p of pairs) {
    pairedTxns.add(p.debitTxnId);
    pairedTxns.add(p.creditTxnId);
    result.set(p.debitTxnId, {
      rawTxnId: p.debitTxnId,
      matchType: "card_payment_transfer",
      matchedRef: String(p.creditTxnId),
      confidence: CONFIDENCE.transfer,
      status: "auto",
    });
    result.set(p.creditTxnId, {
      rawTxnId: p.creditTxnId,
      matchType: "card_payment_transfer",
      matchedRef: String(p.debitTxnId),
      confidence: CONFIDENCE.transfer,
      status: "auto",
    });
  }

  // 3) Half-matched transfers: a payment-like leg that found no counterpart.
  for (const t of txns) {
    if (result.has(t.id)) continue;
    const isTransferLeg =
      (t.accountType === "depository" && t.amountCents < 0) ||
      (t.accountType === "credit" && t.amountCents > 0);
    if (isTransferLeg && PAYMENT_DESC.test(t.description) && !pairedTxns.has(t.id)) {
      result.set(t.id, {
        rawTxnId: t.id,
        matchType: "card_payment_transfer",
        matchedRef: null,
        confidence: CONFIDENCE.halfTransfer,
        status: "needs_review",
        note: "payment-like transfer leg with no matching counterpart",
      });
    }
  }

  // 4) Stripe-destination deposits that did NOT match any payout (a near-miss the
  //    matcher could not pair, or a missing payout record) -> review.
  for (const t of txns) {
    if (result.has(t.id)) continue;
    if (t.isStripePayoutDest && t.amountCents > 0 && !stripeMatchedDeposits.has(t.id)) {
      result.set(t.id, {
        rawTxnId: t.id,
        matchType: "stripe_payout",
        matchedRef: null,
        confidence: 0,
        status: "needs_review",
        note: "deposit on Stripe payout account with no matching payout",
      });
    }
  }

  // 5) Everything else is unmatched (left for the categorizer).
  for (const t of txns) {
    if (result.has(t.id)) continue;
    result.set(t.id, {
      rawTxnId: t.id,
      matchType: "unmatched" as ReconMatchType,
      matchedRef: null,
      confidence: 0,
      status: "auto" as ReconStatus,
    });
  }

  // Preserve input order for stable, predictable output. Every txn has a result.
  return txns.map((t) => result.get(t.id)!);
}
