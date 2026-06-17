/**
 * Tax-benefit ranking tests (pure, no DB/LLM). Verifies the auditor's "when unsure,
 * pick the most tax-beneficial defensible account" policy: ordinary > meals_50 > capital
 * > personal, audit-sensitive accounts are never chosen, only expense/COGS are eligible,
 * the council's order breaks ties, and an empty/ineligible pool returns null.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { taxBenefitScore, pickTaxOptimal, type AccountTaxInfo } from "../src/core/tax-benefit.js";
import type { AccountCandidate, TaxTreatment } from "../src/core/types.js";

function acct(
  code: string,
  name: string,
  taxTreatment: TaxTreatment,
  isBusiness = true,
  type: AccountTaxInfo["type"] = "expense",
): AccountTaxInfo {
  return { code, name, type, taxTreatment, isBusiness, isActive: true };
}

// A small chart mirroring the live one (sql/seed/010_chart_of_accounts.sql).
const CHART = new Map<string, AccountTaxInfo>(
  [
    acct("6070", "Office Expense", "ordinary"),
    acct("6100", "Supplies", "ordinary"),
    acct("6130", "Meals", "meals_50"),
    acct("6040", "Depreciation & Section 179", "capital"),
    acct("6150", "Software & SaaS", "ordinary"),
    acct("6900", "Business Use of Car (mileage)", "mileage"),
    acct("6950", "Home Office (Form 8829)", "home_office"),
    acct("8000", "Owner Draw (personal)", "personal", false, "expense"),
    acct("1500", "Equipment (asset)", "capital", true, "asset"),
  ].map((a) => [a.code, a]),
);
const SENSITIVE = new Set(["6900", "6950"]);

const cands = (...codes: string[]): AccountCandidate[] => codes.map((c) => ({ accountCode: c }));

test("taxBenefitScore ranks current-year benefit ordinary > meals > capital > personal", () => {
  assert.equal(taxBenefitScore("ordinary", true), 100);
  assert.equal(taxBenefitScore("meals_50", true), 50);
  assert.equal(taxBenefitScore("capital", true), 30);
  assert.equal(taxBenefitScore("personal", true), 0);
  assert.equal(taxBenefitScore("nondeductible", true), 0);
  // A non-business account never carries a deduction benefit.
  assert.equal(taxBenefitScore("ordinary", false), 0);
});

test("pickTaxOptimal prefers a fully-deductible ordinary account over a 50% meal", () => {
  const pick = pickTaxOptimal(cands("6130", "6070"), CHART, SENSITIVE);
  assert.ok(pick);
  assert.equal(pick!.accountCode, "6070");
  assert.equal(pick!.treatment, "ordinary");
  assert.equal(pick!.benefit, 100);
  assert.match(pick!.reasoning, /6070/);
});

test("pickTaxOptimal prefers ordinary over capital (immediate beats depreciated)", () => {
  const pick = pickTaxOptimal(cands("6040", "6150"), CHART, SENSITIVE);
  assert.equal(pick!.accountCode, "6150");
});

test("pickTaxOptimal NEVER chooses an audit-sensitive account (home office / vehicle)", () => {
  // Even though home office would 'score', it is excluded; the ordinary option wins.
  const pick = pickTaxOptimal(cands("6950", "6900", "6100"), CHART, SENSITIVE);
  assert.ok(pick);
  assert.equal(pick!.accountCode, "6100");
});

test("pickTaxOptimal excludes sensitive even when it is the ONLY candidate (null)", () => {
  const pick = pickTaxOptimal(cands("6950"), CHART, SENSITIVE);
  assert.equal(pick, null);
});

test("pickTaxOptimal ignores non-expense (balance-sheet) candidates", () => {
  const pick = pickTaxOptimal(cands("1500", "6070"), CHART, SENSITIVE);
  assert.equal(pick!.accountCode, "6070");
});

test("pickTaxOptimal falls to a personal account only when nothing better is defensible", () => {
  const pick = pickTaxOptimal(cands("8000"), CHART, SENSITIVE);
  assert.ok(pick, "a non-deductible personal account is still a real categorization");
  assert.equal(pick!.accountCode, "8000");
  assert.equal(pick!.benefit, 0);
});

test("pickTaxOptimal breaks a benefit tie by the council's order (first wins)", () => {
  // Two ordinary accounts tie at 100; the first listed (council's primary) is kept.
  const pick = pickTaxOptimal(cands("6150", "6070"), CHART, SENSITIVE);
  assert.equal(pick!.accountCode, "6150");
  const pick2 = pickTaxOptimal(cands("6070", "6150"), CHART, SENSITIVE);
  assert.equal(pick2!.accountCode, "6070");
});

test("pickTaxOptimal breaks a tie on business % when scores are equal", () => {
  const pick = pickTaxOptimal(
    [
      { accountCode: "6150", businessPct: 60 },
      { accountCode: "6070", businessPct: 100 },
    ],
    CHART,
    SENSITIVE,
  );
  assert.equal(pick!.accountCode, "6070", "higher business % wins the tie");
});

test("pickTaxOptimal returns null on an empty or unknown-code pool", () => {
  assert.equal(pickTaxOptimal([], CHART, SENSITIVE), null);
  assert.equal(pickTaxOptimal(cands("9999"), CHART, SENSITIVE), null);
});

test("pickTaxOptimal dedupes repeated candidate codes", () => {
  const pick = pickTaxOptimal(cands("6130", "6130", "6070"), CHART, SENSITIVE);
  assert.equal(pick!.accountCode, "6070");
});
