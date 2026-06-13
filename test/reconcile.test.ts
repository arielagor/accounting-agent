/**
 * Reconciliation unit tests — PURE matchers only (no DB, no network). These guard
 * the money-bearing decisions: which legs net to zero (a transfer, not two
 * expenses) and which Stripe deposit is which payout (exact vs near-miss).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchTransfers,
  matchStripePayouts,
  type RawTxnLite,
  type StripePayout,
} from "../src/core/reconcile.js";

/** Build a RawTxnLite with sensible defaults so each test states only what matters. */
function txn(over: Partial<RawTxnLite> & Pick<RawTxnLite, "id" | "accountType" | "amountCents">): RawTxnLite {
  return {
    sourceAccountId: 1,
    postedDate: "2026-05-10",
    description: "",
    isStripePayoutDest: false,
    ...over,
  };
}

test("matchTransfers pairs a checking outflow with the card payment inflow", () => {
  const txns: RawTxnLite[] = [
    txn({ id: 1, accountType: "depository", amountCents: -50000, postedDate: "2026-05-10", description: "ONLINE PMT TO CARD" }),
    txn({ id: 2, accountType: "credit", amountCents: 50000, postedDate: "2026-05-11", description: "PAYMENT THANK YOU" }),
  ];
  const { pairs } = matchTransfers(txns);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0], { debitTxnId: 1, creditTxnId: 2 });
});

test("matchTransfers refuses a half-match (only the outflow leg present)", () => {
  const txns: RawTxnLite[] = [
    txn({ id: 1, accountType: "depository", amountCents: -50000, description: "AUTOPAY CARD" }),
    // No counterpart credit-account inflow of equal amount.
    txn({ id: 9, accountType: "credit", amountCents: 1299, description: "COFFEE" }),
  ];
  const { pairs } = matchTransfers(txns);
  assert.equal(pairs.length, 0);
});

test("matchTransfers does not pair when no leg has a payment-like description", () => {
  const txns: RawTxnLite[] = [
    txn({ id: 1, accountType: "depository", amountCents: -50000, description: "WIRE OUT" }),
    txn({ id: 2, accountType: "credit", amountCents: 50000, description: "REFUND" }),
  ];
  const { pairs } = matchTransfers(txns);
  assert.equal(pairs.length, 0);
});

test("matchTransfers respects the tolerance window and uses the closest date", () => {
  const txns: RawTxnLite[] = [
    txn({ id: 1, accountType: "depository", amountCents: -50000, postedDate: "2026-05-10", description: "ONLINE PMT" }),
    // 5 days out — outside the default 3-day tolerance.
    txn({ id: 2, accountType: "credit", amountCents: 50000, postedDate: "2026-05-15", description: "PAYMENT" }),
    // 1 day out — within tolerance and the closest candidate.
    txn({ id: 3, accountType: "credit", amountCents: 50000, postedDate: "2026-05-11", description: "PAYMENT" }),
  ];
  const { pairs } = matchTransfers(txns);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0], { debitTxnId: 1, creditTxnId: 3 });
});

test("matchStripePayouts matches a deposit to its payout net within tolerance", () => {
  const deposits: RawTxnLite[] = [
    txn({ id: 100, accountType: "depository", amountCents: 29003, postedDate: "2026-05-20", isStripePayoutDest: true }),
  ];
  const payouts: StripePayout[] = [
    { id: "po_1", grossCents: 29900, feeCents: 897, netCents: 29003, arrivalDate: "2026-05-20", metadataApp: "ai_visibility" },
  ];
  const matches = matchStripePayouts(deposits, payouts, 50);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.depositTxnId, 100);
  assert.equal(matches[0]!.payoutId, "po_1");
  assert.equal(matches[0]!.exact, true);
});

test("matchStripePayouts flags a within-tolerance but not-exact deposit as exact:false", () => {
  const deposits: RawTxnLite[] = [
    // 10c off the payout net — within a 50c tolerance, but not penny-perfect.
    txn({ id: 101, accountType: "depository", amountCents: 28993, postedDate: "2026-05-21", isStripePayoutDest: true }),
  ];
  const payouts: StripePayout[] = [
    { id: "po_2", grossCents: 29900, feeCents: 897, netCents: 29003, arrivalDate: "2026-05-20", metadataApp: null },
  ];
  const matches = matchStripePayouts(deposits, payouts, 50);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.payoutId, "po_2");
  assert.equal(matches[0]!.exact, false);
});

test("matchStripePayouts ignores deposits beyond the +/-2 day arrival window", () => {
  const deposits: RawTxnLite[] = [
    txn({ id: 102, accountType: "depository", amountCents: 29003, postedDate: "2026-05-25", isStripePayoutDest: true }),
  ];
  const payouts: StripePayout[] = [
    { id: "po_3", grossCents: 29900, feeCents: 897, netCents: 29003, arrivalDate: "2026-05-20", metadataApp: null },
  ];
  const matches = matchStripePayouts(deposits, payouts, 50);
  assert.equal(matches.length, 0);
});

test("matchStripePayouts ignores deposits not on a Stripe payout destination", () => {
  const deposits: RawTxnLite[] = [
    txn({ id: 103, accountType: "depository", amountCents: 29003, postedDate: "2026-05-20", isStripePayoutDest: false }),
  ];
  const payouts: StripePayout[] = [
    { id: "po_4", grossCents: 29900, feeCents: 897, netCents: 29003, arrivalDate: "2026-05-20", metadataApp: null },
  ];
  const matches = matchStripePayouts(deposits, payouts, 50);
  assert.equal(matches.length, 0);
});

test("matchStripePayouts prefers an exact match over a near-miss for the same deposit", () => {
  const deposits: RawTxnLite[] = [
    txn({ id: 104, accountType: "depository", amountCents: 29003, postedDate: "2026-05-20", isStripePayoutDest: true }),
  ];
  const payouts: StripePayout[] = [
    { id: "near", grossCents: 29950, feeCents: 940, netCents: 29010, arrivalDate: "2026-05-20", metadataApp: null },
    { id: "exact", grossCents: 29900, feeCents: 897, netCents: 29003, arrivalDate: "2026-05-21", metadataApp: null },
  ];
  const matches = matchStripePayouts(deposits, payouts, 50);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.payoutId, "exact");
  assert.equal(matches[0]!.exact, true);
});
