/**
 * Sole-proprietor (Schedule C) strategy — the base pass-through. Net profit flows
 * to the owner's 1040: it bears self-employment tax (the owner is both employer
 * and employee), and the same profit is taxed as ordinary income after the
 * above-the-line half-SE deduction, the QBI deduction, and the standard deduction.
 *
 * The order of operations mirrors a real 1040 worksheet:
 *   1. SE tax on net SE profit (Schedule SE).
 *   2. Half of SE tax is an above-the-line deduction.
 *   3. QBI = 20% of net business income (§199A).
 *   4. Federal taxable = net - half_SE - QBI - std_deduction, taxed via brackets.
 *   5. CA taxable     = net - CA std_deduction, taxed via CA brackets (no SE/QBI).
 * The quarterly set-aside is (federal + SE + state + entityFee) / 4 — what to wire
 * to each of the four estimated-payment vouchers.
 *
 * The single-LLC and multi-LLC strategies are this same computation PLUS the CA
 * LLC obligation, so the core is exported here and reused (one place owns the math).
 */
import type {
  EntityType,
  EstimateArgs,
  EstimatedTax,
  ScheduleLineRollup,
  TaxRateSet,
  TaxStrategy,
} from "../types.js";
import { PERSONA } from "../persona.js";
import {
  computeBracketTax,
  computeSeTax,
  qbiDeduction,
  federalSeParams,
  federalStdDeduction,
  federalBrackets,
  federalQbiRate,
  stateStdDeduction,
  stateBrackets,
} from "./rates.js";

/**
 * The shared pass-through estimate. `entityFeeCents` is the entity-level obligation
 * (0 for a bare sole-prop; the CA LLC fee for an LLC) — folded into the total and
 * the quarterly set-aside so an LLC's $800+fee is reserved alongside income/SE tax.
 */
export function passThroughEstimate(args: EstimateArgs, entityFeeCents: number): EstimatedTax {
  const { netProfitCents, profile, rates, taxYear } = args;
  const filing = profile.filingStatus;

  // 1. Self-employment tax (Schedule SE) on net SE profit.
  const seTax = computeSeTax(netProfitCents, federalSeParams(rates));

  // 2. Half the SE tax is an above-the-line deduction against income.
  const halfSe = Math.round(seTax / 2);

  // 3. QBI deduction: 20% of qualified business income (§199A).
  const qbi = qbiDeduction(netProfitCents, federalQbiRate(rates));

  // 4. Federal ordinary income tax on the reduced taxable base (never below zero).
  const fedStd = federalStdDeduction(rates, filing);
  const fedTaxable = Math.max(0, netProfitCents - halfSe - qbi - fedStd);
  const federalIncomeTax = computeBracketTax(fedTaxable, federalBrackets(rates, filing));

  // 5. CA income tax: CA does not follow SE or QBI; apply its own standard deduction.
  const caStd = stateStdDeduction(rates, filing);
  const caTaxable = Math.max(0, netProfitCents - caStd);
  const stateIncomeTax = computeBracketTax(caTaxable, stateBrackets(rates, filing));

  const totalAnnual = federalIncomeTax + seTax + stateIncomeTax + entityFeeCents;
  const quarterly = Math.round(totalAnnual / 4);

  return {
    taxYear,
    netSeProfitCents: netProfitCents,
    seTaxCents: seTax,
    federalIncomeTaxCents: federalIncomeTax,
    stateIncomeTaxCents: stateIncomeTax,
    entityFeeCents,
    quarterlySetAsideCents: quarterly,
    disclaimers: [],
  };
}

/**
 * The pass-through rollup is a pass-through: Schedule C maps account schedule-lines
 * straight onto the form. The categorizer already stamped each account's
 * `scheduleCLine`, so the rollup arrives line-keyed; nothing to re-map here.
 */
export function passThroughRollup(rollup: ScheduleLineRollup[]): ScheduleLineRollup[] {
  return rollup;
}

/** The sole-proprietor strategy. Net profit on Schedule C; SE + income tax; no entity fee. */
export class ScheduleCStrategy implements TaxStrategy {
  readonly entityType: EntityType = "sole_prop";

  scheduleRollup(rollup: ScheduleLineRollup[]): ScheduleLineRollup[] {
    return passThroughRollup(rollup);
  }

  estimatedQuarterly(args: EstimateArgs): EstimatedTax {
    const est = passThroughEstimate(args, 0);
    est.disclaimers = this.disclaimers();
    return est;
  }

  entitySpecificForms(): string[] {
    return ["Schedule C (Form 1040)", "Schedule SE (Form 1040)", "Form 1040-ES"];
  }

  disclaimers(): string[] {
    return [
      PERSONA.disclaimer,
      "Sole proprietorship: net profit flows to your 1040 and bears 15.3% self-employment tax.",
      "Once net profit comfortably exceeds a reasonable salary, an S-corp election can shelter " +
        "distributions from SE tax — flagged for CPA review, never auto-applied.",
    ];
  }
}

/** Exported convenience for callers that just need a TaxRateSet-driven estimate. */
export function scheduleCEstimate(
  taxYear: number,
  netProfitCents: number,
  grossReceiptsCents: number,
  rates: TaxRateSet,
  profile: EstimateArgs["profile"],
): EstimatedTax {
  return new ScheduleCStrategy().estimatedQuarterly({
    taxYear,
    netProfitCents,
    grossReceiptsCents,
    profile,
    rates,
  });
}
