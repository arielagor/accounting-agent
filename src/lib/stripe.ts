/**
 * Read-only Stripe payouts reader for reconciliation. Uses the bearer-token REST
 * pattern proven in the revenue-scorecard. It NEVER writes to Stripe (no refund,
 * transfer, or payout creation) — it only reads payouts and their balance
 * transactions to recognize revenue net of fees on the cash-basis books.
 *
 * Shared-account note: the Stripe account is shared across products. Per-product
 * attribution comes from metadata.app; an unmapped/mixed payout is escalated by
 * the close, never guessed.
 */
import type { StripeReader, StripePayout } from "../core/reconcile.js";

interface RawPayout {
  id: string;
  amount: number; // net transferred, in cents
  arrival_date: number; // unix seconds
  metadata?: Record<string, string> | null;
}

interface RawBalanceTxn {
  amount: number; // gross, cents (positive for charges)
  fee: number; // cents
  net: number; // cents
  type: string; // 'charge' | 'payout' | 'refund' | ...
}

/**
 * PURE: roll a payout's balance transactions into gross/fee/net + the product tag.
 * gross = sum of positive charge amounts; fee = sum of fees; net = the payout
 * amount. metadataApp comes from the payout's own metadata.app (null if absent —
 * the close escalates rather than guessing the revenue account).
 */
export function summarizePayout(payout: RawPayout, txns: RawBalanceTxn[]): StripePayout {
  let gross = 0;
  let fee = 0;
  for (const t of txns) {
    if (t.type === "charge" || t.type === "payment") {
      gross += t.amount;
      fee += t.fee;
    }
  }
  // If we could not derive gross from charges, fall back to net + summed fees.
  if (gross === 0) gross = payout.amount + fee;
  const arrivalDate = new Date(payout.arrival_date * 1000).toISOString().slice(0, 10);
  return {
    id: payout.id,
    grossCents: gross,
    feeCents: fee,
    netCents: payout.amount,
    arrivalDate,
    metadataApp: payout.metadata?.app ?? null,
  };
}

async function stripeGet(
  path: string,
  params: Record<string, string>,
  secretKey: string,
): Promise<{ data: unknown[] }> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`https://api.stripe.com/v1/${path}?${qs}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  if (!res.ok) {
    throw new Error(`Stripe GET ${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { data: unknown[] };
}

/** A real read-only StripeReader backed by the Stripe REST API. */
export function createStripeReader(secretKey: string): StripeReader {
  return {
    async listPayouts(sinceIso: string): Promise<StripePayout[]> {
      const sinceUnix = Math.floor(new Date(sinceIso).getTime() / 1000);
      const payoutsRes = await stripeGet(
        "payouts",
        { "arrival_date[gte]": String(sinceUnix), limit: "100" },
        secretKey,
      );
      const out: StripePayout[] = [];
      for (const p of payoutsRes.data as RawPayout[]) {
        const txnsRes = await stripeGet(
          "balance_transactions",
          { payout: p.id, limit: "100" },
          secretKey,
        );
        out.push(summarizePayout(p, txnsRes.data as RawBalanceTxn[]));
      }
      return out;
    },
  };
}
