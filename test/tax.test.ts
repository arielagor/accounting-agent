/**
 * Tax engine unit tests — PURE. No DB, no network: a `TaxRateSet` literal is built
 * from the 2026 seed (sql/seed/014_tax_rates_2026.sql) and the strategies are run
 * against it directly. The headline assertion is the TOGGLE: the SAME $120,000 net
 * produces a strictly smaller SE/payroll number under s_corp than under sole_prop —
 * proof that flipping the entity type actually changes the math.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { EntityProfile, EntityType, TaxRateSet } from "../src/core/types.js";
import { selectStrategy } from "../src/core/tax/index.js";
import { computeBracketTax, computeSeTax } from "../src/core/tax/rates.js";

// ─── 2026 seed values, transcribed as a literal (mirrors 014_tax_rates_2026.sql) ──
const RATES_2026: TaxRateSet = {
  taxYear: 2026,
  federal: {
    se_tax: {
      ss_rate: 0.124,
      medicare_rate: 0.029,
      ss_wage_base_cents: 18200000,
      net_se_factor: 0.9235,
      addl_medicare_rate: 0.009,
      addl_medicare_threshold_cents: 20000000,
    },
    std_deduction: { single: 1550000, mfj: 3100000, mfs: 1550000, hoh: 2330000 },
    income_bracket: {
      single: [
        [0, 0.1],
        [1192500, 0.12],
        [4847500, 0.22],
        [10335000, 0.24],
        [19730000, 0.32],
        [25052500, 0.35],
        [62635000, 0.37],
      ],
      mfj: [
        [0, 0.1],
        [2385000, 0.12],
        [9695000, 0.22],
        [20670000, 0.24],
        [39460000, 0.32],
        [50105000, 0.35],
        [75160000, 0.37],
      ],
    },
    qbi: { rate: 0.2 },
    corp_rate: { rate: 0.21 },
  },
  state: {
    income_bracket: {
      single: [
        [0, 0.01],
        [1075600, 0.02],
        [2549900, 0.04],
        [4024500, 0.06],
        [5586600, 0.08],
        [7060600, 0.093],
        [36065900, 0.103],
        [43278700, 0.113],
        [72131400, 0.123],
      ],
      mfj: [
        [0, 0.01],
        [2151200, 0.02],
        [5099800, 0.04],
        [8049000, 0.06],
        [11173200, 0.08],
        [14121200, 0.093],
        [72131800, 0.103],
        [86557400, 0.113],
        [144262800, 0.123],
      ],
    },
    std_deduction: { single: 560000, mfj: 1120000, mfs: 560000, hoh: 1120000 },
    corp_rate: { rate: 0.0884, min_franchise_cents: 80000 },
    llc_fee: {
      annual_tax_cents: 80000,
      fee_tiers: [
        [25000000, 0],
        [50000000, 90000],
        [100000000, 250000],
        [500000000, 600000],
        [999999999900, 1179000],
      ],
    },
  },
};

const NET_120K = 12_000_000; // $120,000 in cents
const GROSS_150K = 15_000_000; // $150,000 in cents

function profile(entityType: EntityType): EntityProfile {
  return {
    taxYear: 2026,
    entityType,
    filingStatus: "single",
    state: "CA",
    homeOfficeSqft: null,
    homeTotalSqft: null,
    reasonableSalaryCents: null,
  };
}

function estimateFor(entityType: EntityType, net = NET_120K, gross = GROSS_150K) {
  return selectStrategy(entityType).estimatedQuarterly({
    taxYear: 2026,
    netProfitCents: net,
    grossReceiptsCents: gross,
    profile: profile(entityType),
    rates: RATES_2026,
  });
}

// ─── Primitive exactness ────────────────────────────────────────────────────────
test("computeSeTax is exact on a known $50,000 net", () => {
  // base = round(5,000,000 * 0.9235) = 4,617,500
  //   SS  = round(4,617,500 * 0.124) = 572,570
  //   Med = round(4,617,500 * 0.029) = 133,908  → total 706,478
  assert.equal(computeSeTax(5_000_000, RATES_2026.federal.se_tax as never), 706478);
});

test("computeSeTax caps Social Security at the wage base", () => {
  // Net well above the base: SS is computed on min(base, ss_wage_base).
  const huge = computeSeTax(50_000_000, RATES_2026.federal.se_tax as never);
  // base = round(50,000,000 * 0.9235) = 46,175,000
  //   SS  = round(18,200,000 * 0.124) = 2,256,800 (capped)
  //   Med = round(46,175,000 * 0.029) = 1,339,075
  //   addl= round((46,175,000-20,000,000) * 0.009) = round(235,575) = 235,575
  assert.equal(huge, 2256800 + 1339075 + 235575);
});

test("computeBracketTax is exact and progressive on a known input", () => {
  const fedBrackets = (RATES_2026.federal.income_bracket as Record<string, [number, number][]>)
    .single!;
  // taxable 2,000,000: 1,192,500 @ 10% = 119,250 ; 807,500 @ 12% = 96,900 → 216,150
  assert.equal(computeBracketTax(2_000_000, fedBrackets), 216150);
  assert.equal(computeBracketTax(0, fedBrackets), 0);
  assert.equal(computeBracketTax(-1, fedBrackets), 0);
});

// ─── Sole-prop: positive components and quarterly = total / 4 ─────────────────────
test("sole_prop on $120,000 net produces positive SE + federal + CA, quarterly = total/4", () => {
  const e = estimateFor("sole_prop");
  assert.equal(e.taxYear, 2026);
  assert.ok(e.seTaxCents > 0, "SE tax positive");
  assert.ok(e.federalIncomeTaxCents > 0, "federal income tax positive");
  assert.ok(e.stateIncomeTaxCents > 0, "CA income tax positive");
  assert.equal(e.entityFeeCents, 0, "bare sole-prop has no entity fee");

  // Exact values pinned against the hand-computed worksheet.
  assert.equal(e.seTaxCents, 1695546);
  assert.equal(e.federalIncomeTaxCents, 1075890);
  assert.equal(e.stateIncomeTaxCents, 718156);

  const total =
    e.federalIncomeTaxCents + e.seTaxCents + e.stateIncomeTaxCents + e.entityFeeCents;
  assert.equal(e.quarterlySetAsideCents, Math.round(total / 4));
});

// ─── The toggle: s_corp lowers SE/payroll on the SAME inputs ──────────────────────
test("switching the toggle to s_corp LOWERS the SE/payroll burden on the same inputs", () => {
  const soleProp = estimateFor("sole_prop");
  const sCorp = estimateFor("s_corp");

  // Same net flows in; the salary/distribution split shields the distribution from
  // SE/payroll tax, so the SE-tax slot must be strictly smaller under s_corp.
  assert.equal(soleProp.netSeProfitCents, sCorp.netSeProfitCents);
  assert.ok(
    sCorp.seTaxCents < soleProp.seTaxCents,
    `expected s_corp payroll (${sCorp.seTaxCents}) < sole_prop SE (${soleProp.seTaxCents})`,
  );

  // Default salary = 60% of net = $72,000 → payroll = SS + Medicare (no addl).
  // SS = round(7,200,000*0.124)=892,800 ; Med = round(7,200,000*0.029)=208,800 → 1,101,600
  assert.equal(sCorp.seTaxCents, 1101600);
});

// ─── Single / multi LLC: pass-through plus the CA $800 + fee ───────────────────────
test("single_llc and multi_llc add the CA LLC obligation as the entity fee", () => {
  // Gross $150,000 ($15,000,000 cents) is under the first tier bound ($250,000),
  // so the fee is $0 and the obligation is just the $800 annual tax.
  const single = estimateFor("single_llc");
  const multi = estimateFor("multi_llc");
  assert.equal(single.entityFeeCents, 80000);
  assert.equal(multi.entityFeeCents, 80000);

  // A higher gross crosses into the next tier: $400,000 ($40,000,000 cents) exceeds
  // $250,000 but not $500,000 → $800 annual tax + $900 fee = $1,700.
  const highGross = estimateFor("single_llc", NET_120K, 40_000_000);
  assert.equal(highGross.entityFeeCents, 80000 + 90000);

  // The fee is folded into the quarterly set-aside alongside income/SE tax.
  const total =
    single.federalIncomeTaxCents +
    single.seTaxCents +
    single.stateIncomeTaxCents +
    single.entityFeeCents;
  assert.equal(single.quarterlySetAsideCents, Math.round(total / 4));

  // A single-member LLC is disregarded federally → identical SE tax to a sole-prop.
  assert.equal(single.seTaxCents, estimateFor("sole_prop").seTaxCents);
});

// ─── C-corp: flat rate, no SE/QBI ─────────────────────────────────────────────────
test("c_corp applies the flat federal + CA franchise rate with no SE tax", () => {
  const e = estimateFor("c_corp");
  assert.equal(e.seTaxCents, 0, "no self-employment tax for a C-corp");
  assert.equal(e.federalIncomeTaxCents, Math.round(NET_120K * 0.21));
  // CA 8.84% of $120,000 = $10,608 > $800 minimum.
  assert.equal(e.stateIncomeTaxCents, Math.round(NET_120K * 0.0884));
});

// ─── Organize-only: all zeros + the skip disclaimer ───────────────────────────────
test("organize_only returns an all-zero estimate with the skip disclaimer", () => {
  const e = estimateFor("organize_only");
  assert.equal(e.netSeProfitCents, 0);
  assert.equal(e.seTaxCents, 0);
  assert.equal(e.federalIncomeTaxCents, 0);
  assert.equal(e.stateIncomeTaxCents, 0);
  assert.equal(e.entityFeeCents, 0);
  assert.equal(e.quarterlySetAsideCents, 0);
  assert.ok(
    e.disclaimers.includes("Tax computation skipped by configuration; books organized for your CPA."),
  );
});

// ─── Every strategy carries the persona disclaimer + entity forms ─────────────────
test("every strategy exposes its forms and includes the persona disclaimer", () => {
  const types: EntityType[] = [
    "sole_prop",
    "single_llc",
    "multi_llc",
    "s_corp",
    "c_corp",
    "organize_only",
  ];
  for (const t of types) {
    const s = selectStrategy(t);
    assert.equal(s.entityType, t);
    assert.ok(Array.isArray(s.entitySpecificForms()));
    assert.ok(s.disclaimers().length > 0, `${t} has disclaimers`);
    // organize_only intentionally lists no forms; the rest list at least one.
    if (t !== "organize_only") assert.ok(s.entitySpecificForms().length > 0, `${t} forms`);
  }
});
