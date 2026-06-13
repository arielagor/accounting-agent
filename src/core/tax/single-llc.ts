/**
 * Single-member LLC strategy. For federal tax a single-member LLC is a disregarded
 * entity — it files exactly like a sole proprietor (Schedule C, SE tax, QBI). The
 * difference is at the state line: California charges every LLC an $800 annual tax
 * plus a gross-receipts fee tier. So this strategy IS the pass-through computation
 * with the CA LLC obligation folded into the entity fee (and the quarterly set-aside).
 */
import type {
  EntityType,
  EstimateArgs,
  EstimatedTax,
  ScheduleLineRollup,
  TaxStrategy,
} from "../types.js";
import { PERSONA } from "../persona.js";
import { caLlcFee, stateLlcFeeParams } from "./rates.js";
import { passThroughEstimate, passThroughRollup } from "./schedule-c.js";

/** Single-member LLC: disregarded for federal (Schedule C) + CA LLC tax/fee. */
export class SingleLlcStrategy implements TaxStrategy {
  readonly entityType: EntityType = "single_llc";

  scheduleRollup(rollup: ScheduleLineRollup[]): ScheduleLineRollup[] {
    return passThroughRollup(rollup);
  }

  estimatedQuarterly(args: EstimateArgs): EstimatedTax {
    const fee = caLlcFee(args.grossReceiptsCents, stateLlcFeeParams(args.rates));
    const est = passThroughEstimate(args, fee);
    est.disclaimers = this.disclaimers();
    return est;
  }

  entitySpecificForms(): string[] {
    return [
      "Schedule C (Form 1040)",
      "Schedule SE (Form 1040)",
      "CA Form 568 (LLC Return of Income)",
      "Form 1040-ES",
    ];
  }

  disclaimers(): string[] {
    return [
      PERSONA.disclaimer,
      "Single-member LLC is a disregarded entity for federal tax: it files on Schedule C and " +
        "bears self-employment tax exactly like a sole proprietorship.",
      "California assesses every LLC an $800 annual tax plus a gross-receipts fee tier (Form 568), " +
        "reserved in the quarterly set-aside above.",
    ];
  }
}
