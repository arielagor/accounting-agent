/**
 * Organize-only strategy. A deliberate no-tax mode: the engine keeps the books in
 * order but computes NO tax estimate, because the client's CPA owns the tax math.
 * Selected by the entity-type toggle when the owner wants the agent to organize
 * records for hand-off rather than estimate liability. Every figure is zero and the
 * disclaimers make explicit that tax was skipped by configuration, not by error.
 */
import type {
  EntityType,
  EstimateArgs,
  EstimatedTax,
  ScheduleLineRollup,
  TaxStrategy,
} from "../types.js";
import { PERSONA } from "../persona.js";

/** Organize-only: books organized, tax computation intentionally skipped. */
export class OrganizeOnlyStrategy implements TaxStrategy {
  readonly entityType: EntityType = "organize_only";

  scheduleRollup(rollup: ScheduleLineRollup[]): ScheduleLineRollup[] {
    // Still roll the schedule lines up — organizing the books is the whole job here.
    return rollup;
  }

  estimatedQuarterly(args: EstimateArgs): EstimatedTax {
    return {
      taxYear: args.taxYear,
      netSeProfitCents: 0,
      seTaxCents: 0,
      federalIncomeTaxCents: 0,
      stateIncomeTaxCents: 0,
      entityFeeCents: 0,
      quarterlySetAsideCents: 0,
      disclaimers: this.disclaimers(),
    };
  }

  entitySpecificForms(): string[] {
    return [];
  }

  disclaimers(): string[] {
    return [
      "Tax computation skipped by configuration; books organized for your CPA.",
      PERSONA.disclaimer,
    ];
  }
}
