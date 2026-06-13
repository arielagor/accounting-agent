/**
 * Multi-member LLC strategy. A multi-member LLC defaults to partnership taxation:
 * it files Form 1065 and issues each member a K-1; the member's distributive share
 * of ordinary business income is then self-employment income on that member's 1040.
 *
 * Phase 1 is single-owner books, so the engine estimates as if the full net profit
 * is the owner's distributive share — i.e. the same pass-through math as Schedule C
 * (SE tax, half-SE, QBI, brackets) PLUS the CA $800 + gross-receipts fee. When the
 * partnership has real co-members, the per-member split is a CPA allocation we
 * surface rather than guess (see disclaimers).
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

/** Multi-member LLC: partnership pass-through (1065/K-1) + CA LLC tax/fee. */
export class MultiLlcStrategy implements TaxStrategy {
  readonly entityType: EntityType = "multi_llc";

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
      "Form 1065 (Partnership Return)",
      "Schedule K-1 (Form 1065)",
      "Schedule SE (Form 1040)",
      "CA Form 568 (LLC Return of Income)",
      "Form 1040-ES",
    ];
  }

  disclaimers(): string[] {
    return [
      PERSONA.disclaimer,
      "Multi-member LLC defaults to partnership taxation (Form 1065 + K-1); each member's " +
        "distributive share of ordinary income is self-employment income on their 1040.",
      "This estimate treats the full net profit as the owner's distributive share. Where real " +
        "co-members exist, the per-member allocation and guaranteed payments are a CPA determination.",
      "California assesses every LLC an $800 annual tax plus a gross-receipts fee tier (Form 568), " +
        "reserved in the quarterly set-aside above.",
    ];
  }
}
