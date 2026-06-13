/**
 * C-corp strategy. A C corporation is its own taxpayer: it pays a flat federal
 * corporate rate (21%) on net income and the CA corporate franchise tax (8.84%,
 * minimum $800) — and that is the corporate-level liability. There is NO self-
 * employment tax (the owner is an employee/shareholder, not self-employed) and NO
 * QBI deduction (199A is a pass-through provision). The estimate here is the
 * entity-level tax only; shareholder-level tax on dividends/salary is separate and
 * out of scope for the corporate quarterly (Form 1120-W).
 */
import type {
  EntityType,
  EstimateArgs,
  EstimatedTax,
  ScheduleLineRollup,
  TaxStrategy,
} from "../types.js";
import { PERSONA } from "../persona.js";
import { federalCorpRate, stateCorpRate } from "./rates.js";

/** C-corp: flat federal corporate rate + CA franchise tax. No SE/QBI. */
export class CCorpStrategy implements TaxStrategy {
  readonly entityType: EntityType = "c_corp";

  scheduleRollup(rollup: ScheduleLineRollup[]): ScheduleLineRollup[] {
    // C-corp income/expense maps onto Form 1120; the schedule-line keys carry over.
    return rollup;
  }

  estimatedQuarterly(args: EstimateArgs): EstimatedTax {
    const { netProfitCents, rates, taxYear } = args;
    const net = Math.max(0, netProfitCents);

    // Federal corporate income tax: flat rate on net income.
    const fed = federalCorpRate(rates);
    const federalIncomeTax = Math.round(net * fed.rate);

    // CA corporate franchise tax: rate on net income, with a minimum.
    const ca = stateCorpRate(rates);
    const minFranchise = ca.min_franchise_cents ?? 80000;
    const stateIncomeTax = Math.max(minFranchise, Math.round(net * ca.rate));

    const totalAnnual = federalIncomeTax + stateIncomeTax;
    const quarterly = Math.round(totalAnnual / 4);

    return {
      taxYear,
      netSeProfitCents: netProfitCents,
      seTaxCents: 0, // a C-corp owner is not self-employed — no SE tax at the entity.
      federalIncomeTaxCents: federalIncomeTax,
      stateIncomeTaxCents: stateIncomeTax,
      entityFeeCents: stateIncomeTax, // the CA franchise tax IS the state entity fee.
      quarterlySetAsideCents: quarterly,
      disclaimers: this.disclaimers(),
    };
  }

  entitySpecificForms(): string[] {
    return ["Form 1120", "Form 1120-W (Estimated Tax)", "CA Form 100"];
  }

  disclaimers(): string[] {
    return [
      PERSONA.disclaimer,
      "C-corp pays a flat 21% federal corporate tax plus the CA franchise tax (8.84%, minimum $800) " +
        "at the entity level — there is no self-employment tax and no QBI deduction.",
      "Profits distributed as dividends are taxed AGAIN at the shareholder level (double taxation). " +
        "The shareholder-level tax is separate from this corporate quarterly estimate.",
    ];
  }
}
