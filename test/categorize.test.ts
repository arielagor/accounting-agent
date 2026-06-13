/**
 * Pure-function unit tests for the categorizer: normalizeMerchant() and the
 * tier-priority decision decide(). No DB, no network — the DB wrapper is thin and
 * covered by the close integration path; the policy logic lives here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMerchant,
  decide,
  type MerchantRuleRow,
  type RegexRuleRow,
} from "../src/core/categorize.js";
import type { CategorizationInput, LlmProposal } from "../src/core/types.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────
function input(over: Partial<CategorizationInput> = {}): CategorizationInput {
  return {
    sourceTxnId: "txn-1",
    merchant: "Blue Bottle",
    amountCents: -1999,
    memo: "",
    postedDate: "2026-05-10",
    isOutflow: true,
    ...over,
  };
}

function regex(over: Partial<RegexRuleRow> = {}): RegexRuleRow {
  return {
    priority: 100,
    matchField: "merchant",
    matchRegex: "(?i)blue bottle",
    amountMinCents: null,
    amountMaxCents: null,
    accountCode: "6200",
    projectSlug: "shared",
    businessPct: 100,
    needsSplit: false,
    confidence: 0.95,
    ...over,
  };
}

function llm(over: Partial<LlmProposal> = {}): LlmProposal {
  return {
    accountCode: "6200",
    projectSlug: "shared",
    businessPct: 100,
    confidence: 0.9,
    needsSplit: false,
    rationale: "coffee, likely meals/business",
    ...over,
  };
}

// ─── normalizeMerchant ────────────────────────────────────────────────────────
test("normalizeMerchant strips SQ * card-noise prefix and lowercases", () => {
  assert.equal(normalizeMerchant("SQ *BLUE BOTTLE"), "blue bottle");
});

test("normalizeMerchant strips store numbers, single-word-city + state location", () => {
  assert.equal(normalizeMerchant("SQ *BLUE BOTTLE #1234 OAKLAND CA"), "blue bottle");
  assert.equal(normalizeMerchant("STARBUCKS STORE 00099 SEATTLE WA"), "starbucks");
  assert.equal(normalizeMerchant("Whole Foods Market Encino CA"), "whole foods market");
});

test("normalizeMerchant keeps internal punctuation/number tokens as spaced words", () => {
  assert.equal(normalizeMerchant("TST* The Coffee Bar - 4471"), "the coffee bar 4471");
});

test("normalizeMerchant collapses attached domains and whitespace", () => {
  // Conservative location strip removes only the state + one city word, so a
  // two-word city ("San Francisco") leaves a stable residual token.
  assert.equal(normalizeMerchant("PAYPAL *NETLIFY  SAN FRANCISCO CA"), "netlify san");
});

test("normalizeMerchant is stable and idempotent", () => {
  const once = normalizeMerchant("PAYPAL *NETLIFY  SAN FRANCISCO CA");
  assert.equal(once, normalizeMerchant(once.toUpperCase()));
  assert.ok(once.length > 0);
});

test("normalizeMerchant handles empty / whitespace input", () => {
  assert.equal(normalizeMerchant(""), "");
  assert.equal(normalizeMerchant("   "), "");
});

// ─── decide: learned merchant rule ──────────────────────────────────────────
test("learned merchant rule wins outright at confidence 0.99", () => {
  const rule: MerchantRuleRow = {
    accountCode: "6150",
    projectSlug: "agor_me",
    businessPct: 100,
    needsSplit: false,
  };
  const out = decide(input(), rule, [regex()], llm(), 0.85);
  assert.equal(out.disposition, "posted");
  assert.equal(out.result?.source, "merchant_rule");
  assert.equal(out.result?.accountCode, "6150");
  assert.equal(out.result?.confidence, 0.99);
});

test("learned merchant rule with needs_split quarantines (needs_split), overriding regex", () => {
  const rule: MerchantRuleRow = {
    accountCode: "9000",
    projectSlug: null,
    businessPct: 100,
    needsSplit: true,
  };
  const out = decide(input(), rule, [regex()], llm(), 0.85);
  assert.equal(out.disposition, "quarantined");
  assert.equal(out.reason, "needs_split");
  assert.equal(out.result, undefined);
});

// ─── decide: regex tier ───────────────────────────────────────────────────────
test("regex rule auto-posts at confidence >= 0.90", () => {
  const out = decide(input(), null, [regex({ confidence: 0.95 })], null, 0.85);
  assert.equal(out.disposition, "posted");
  assert.equal(out.result?.source, "regex_rule");
  assert.equal(out.result?.accountCode, "6200");
});

test("first matching regex rule by ascending priority is chosen", () => {
  const lowPri = regex({ priority: 10, accountCode: "6160", confidence: 0.98 });
  const highPri = regex({ priority: 90, accountCode: "6999", confidence: 0.98 });
  // Passed out of order to prove decide() sorts by priority ascending.
  const out = decide(input(), null, [highPri, lowPri], null, 0.85);
  assert.equal(out.disposition, "posted");
  assert.equal(out.result?.accountCode, "6160");
});

test("regex needs_split quarantines (needs_split)", () => {
  const out = decide(
    input({ merchant: "AMAZON" }),
    null,
    [regex({ matchRegex: "(?i)amazon", accountCode: "9000", needsSplit: true, confidence: 0.45 })],
    null,
    0.85,
  );
  assert.equal(out.disposition, "quarantined");
  assert.equal(out.reason, "needs_split");
});

test("regex match below 0.90 (and no LLM) quarantines low_confidence, never guesses a post", () => {
  const out = decide(input(), null, [regex({ confidence: 0.5 })], null, 0.85);
  assert.equal(out.disposition, "quarantined");
  assert.equal(out.reason, "low_confidence");
});

test("regex amount band gates the match", () => {
  // Band [9800,10200] should NOT match a -$19.99 charge (abs 1999 cents).
  const banded = regex({ amountMinCents: 9800, amountMaxCents: 10200, confidence: 0.95 });
  const out = decide(input({ amountCents: -1999 }), null, [banded], null, 0.85);
  assert.equal(out.disposition, "quarantined");
  assert.equal(out.reason, "new_merchant");

  // A -$100.00 charge (abs 10000 cents) IS inside the band → posts.
  const inBand = decide(input({ amountCents: -10000 }), null, [banded], null, 0.85);
  assert.equal(inBand.disposition, "posted");
  assert.equal(inBand.result?.source, "regex_rule");
});

// ─── decide: LLM tier ──────────────────────────────────────────────────────────
test("llm proposal accepted at the threshold posts as source llm", () => {
  const out = decide(input(), null, [], llm({ confidence: 0.9 }), 0.85);
  assert.equal(out.disposition, "posted");
  assert.equal(out.result?.source, "llm");
  assert.equal(out.result?.rationale, "coffee, likely meals/business");
});

test("llm proposal at exactly max(0.85, threshold) posts", () => {
  // threshold 0.88 raises the floor above 0.85; a 0.88 proposal still clears it.
  const out = decide(input(), null, [], llm({ confidence: 0.88 }), 0.88);
  assert.equal(out.disposition, "posted");
  assert.equal(out.result?.source, "llm");
});

test("llm proposal below the floor quarantines low_confidence", () => {
  const out = decide(input(), null, [], llm({ confidence: 0.8 }), 0.85);
  assert.equal(out.disposition, "quarantined");
  assert.equal(out.reason, "low_confidence");
});

test("llm floor never drops below 0.85 even when config threshold is looser", () => {
  // Config threshold 0.50, but an 0.80 LLM read still quarantines (hard floor 0.85).
  const out = decide(input(), null, [], llm({ confidence: 0.8 }), 0.5);
  assert.equal(out.disposition, "quarantined");
  assert.equal(out.reason, "low_confidence");
});

test("llm proposal with needs_split quarantines needs_split, not posted", () => {
  const out = decide(input(), null, [], llm({ confidence: 0.99, needsSplit: true }), 0.85);
  assert.equal(out.disposition, "quarantined");
  assert.equal(out.reason, "needs_split");
});

// ─── decide: no match ────────────────────────────────────────────────────────
test("no rule and no llm proposal quarantines new_merchant", () => {
  const out = decide(input({ merchant: "Totally Unknown Vendor LLC" }), null, [], null, 0.85);
  assert.equal(out.disposition, "quarantined");
  assert.equal(out.reason, "new_merchant");
});

test("non-matching regex (different merchant) with no llm quarantines new_merchant", () => {
  const out = decide(
    input({ merchant: "Peets Coffee" }),
    null,
    [regex({ matchRegex: "(?i)starbucks" })],
    null,
    0.85,
  );
  assert.equal(out.disposition, "quarantined");
  assert.equal(out.reason, "new_merchant");
});
