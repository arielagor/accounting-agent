/**
 * S-corp strategy — the classic optimization the persona reaches for once profit
 * comfortably exceeds a reasonable salary. The owner is paid a "reasonable salary"
 * (W-2 wages) that bears full payroll tax (employer + employee SS + Medicare); the
 * REMAINDER of the profit is taken as a distribution that escapes SE/payroll tax
 * entirely. That distribution-side payroll-tax saving is the whole point.
 *
 * Computation:
 *   salary       = profile.reasonableSalaryCents, or 60% of net if not set.
 *   distribution = net - salary (floored at zero).
 *   payroll tax  = (SS on salary capped at the wage base) + Medicare on salary
 *                  + Additional Medicare on salary above the threshold.
 *                  (Salary is W-2 wages — no 92.35% net-SE factor; it is applied
 *                  to the wage directly. We map "se tax" in the result to this
 *                  payroll tax so the toggle is comparable to the pass-through.)
 *   federal income tax on (salary + distribution - QBI - std_deduction).
 *   CA: 1.5% franchise tax on net S-corp income, minimum $800.
 */
import type {
  EntityType,
  EstimateArgs,
  EstimatedTax,
  ScheduleLineRollup,
  TaxStrategy,
} from "../types.js";
import { PERSONA } from "../persona.js";
import {
  computeBracketTax,
  qbiDeduction,
  federalSeParams,
  federalStdDeduction,
  federalBrackets,
  federalQbiRate,
} from "./rates.js";

/** CA S-corp franchise: 1.5% of net income, with an $800 minimum (cents). */
const CA_SCORP_RATE = 0.015;

/**
 * Payroll tax on a W-2 salary: SS (capped at the wage base) + Medicare (uncapped)
 * + Additional Medicare above the threshold. Unlike Schedule SE there is no 92.35%
 * net-SE factor — the rate applies to the wage directly. Integer cents.
 */
export function payrollTaxOnSalary(
  salaryCents: number,
  seParams: ReturnType<typeof federalSeParams>,
): number {
  if (salaryCents <= 0) return 0;
  const ssBase = Math.min(salaryCents, seParams.ss_wage_base_cents);
  const ss = Math.round(ssBase * seParams.ss_rate);
  const medicare = Math.round(salaryCents * seParams.medicare_rate);
  const overThreshold = Math.max(0, salaryCents - seParams.addl_medicare_threshold_cents);
  const addl = Math.round(overThreshold * seParams.addl_medicare_rate);
  return ss + medicare + addl;
}

/** The reasonable salary: explicit profile value, else 60% of net profit. */
export function reasonableSalary(netProfitCents: number, profileSalaryCents: number | null): number {
  if (profileSalaryCents != null && profileSalaryCents > 0) {
    // Never pay a "salary" larger than the profit available to pay it.
    return Math.min(profileSalaryCents, Math.max(0, netProfitCents));
  }
  return Math.max(0, Math.round(netProfitCents * 0.6));
}

/** S-corp: reasonable W-2 salary (payroll tax) + distribution (no SE tax). */
export class SCorpStrategy implements TaxStrategy {
  readonly entityType: EntityType = "s_corp";

  scheduleRollup(rollup: ScheduleLineRollup[]): ScheduleLineRollup[] {
    // S-corp income/expense maps onto Form 1120-S; the schedule-line keys carry over.
    return rollup;
  }

  estimatedQuarterly(args: EstimateArgs): EstimatedTax {
    const { netProfitCents, profile, rates, taxYear } = args;
    const filing = profile.filingStatus;

    const salary = reasonableSalary(netProfitCents, profile.reasonableSalaryCents);
    const distribution = Math.max(0, netProfitCents - salary);

    // Payroll tax on the salary only — the distribution escapes SE/payroll tax.
    const payrollTax = payrollTaxOnSalary(salary, federalSeParams(rates));

    // QBI applies to the S-corp's qualified business income (net of reasonable comp).
    const qbi = qbiDeduction(distribution, federalQbiRate(rates));

    // Federal income tax on salary + distribution, less QBI and the standard deduction.
    const fedStd = federalStdDeduction(rates, filing);
    const fedTaxable = Math.max(0, salary + distribution - qbi - fedStd);
    const federalIncomeTax = computeBracketTax(fedTaxable, federalBrackets(rates, filing));

    // CA: 1.5% franchise tax on net income, $800 minimum.
    const caFranchise = Math.max(80000, Math.round(Math.max(0, netProfitCents) * CA_SCORP_RATE));

    const totalAnnual = federalIncomeTax + payrollTax + caFranchise;
    const quarterly = Math.round(totalAnnual / 4);

    return {
      taxYear,
      netSeProfitCents: netProfitCents,
      // Map payroll tax into the SE-tax slot so the toggle is directly comparable to
      // the pass-through strategies — the same field, a strictly smaller number.
      seTaxCents: payrollTax,
      federalIncomeTaxCents: federalIncomeTax,
      stateIncomeTaxCents: caFranchise,
      entityFeeCents: caFranchise,
      quarterlySetAsideCents: quarterly,
      disclaimers: this.disclaimers(),
    };
  }

  entitySpecificForms(): string[] {
    return ["Form 1120-S", "Schedule K-1 (Form 1120-S)", "Form W-2", "Form 1040-ES"];
  }

  disclaimers(): string[] {
    return [
      PERSONA.disclaimer,
      "S-corp split: a reasonable W-2 salary bears payroll tax; the remaining profit taken as a " +
        "distribution escapes the 15.3% SE/payroll tax — that saving is the whole reason to elect.",
      "The salary MUST be reasonable for the work performed (IRS scrutinizes a too-low salary). " +
        "Confirm the figure with your CPA; an unreasonably low salary is an audit risk.",
      "California taxes an S-corp at 1.5% of net income (minimum $800 franchise tax).",
    ];
  }
}
