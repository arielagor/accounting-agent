/**
 * Accrual schedule (period-end adjusting entries). Methodology from the
 * month-end-closer `accrual-schedule` skill: per accrual, period_portion =
 * basis × (days_in_period ÷ days_in_basis); this_period = period_portion −
 * already_booked; draft `Dr expense / Cr accrued liability`.
 *
 * CRITICAL: accruals are DRAFT entries staged for sign-off, NOT auto-posted.
 * Even in live mode the close escalates them for approval (the most judgment-laden
 * entries get a human gate). Depreciation is modeled the same way (Dr 6040 / Cr 1610).
 */
import type { NewJournalEntry, Cents } from "./types.js";
import { periodBounds } from "./ledger.js";
import { allocateCents } from "./money.js";

export interface AccrualPolicy {
  name: string;
  expenseAccountCode: string;
  /** The contra/liability account credited (e.g. 2250 accrued liabilities, 1610 accum. depreciation). */
  creditAccountCode: string;
  /** Full-period (or full-basis) amount the accrual is computed from. */
  basisCents: Cents;
  /** Number of days the basis covers (e.g. 365 for an annual fee, 60 for a 2-month basis). */
  basisDays: number;
  projectSlug?: string | null;
  autoReverse?: boolean;
  supportReference?: string;
}

export interface AccrualEntry {
  name: string;
  periodPortionCents: Cents;
  alreadyBookedCents: Cents;
  thisPeriodCents: Cents;
  autoReverse: boolean;
  /** A DRAFT journal entry (status 'draft'); never auto-posted above threshold. */
  draft: NewJournalEntry;
}

function daysInPeriod(period: string): number {
  const { start, end } = periodBounds(period);
  const s = new Date(start + "T00:00:00Z").getTime();
  const e = new Date(end + "T00:00:00Z").getTime();
  return Math.round((e - s) / 86_400_000) + 1;
}

/**
 * Build the accrual schedule for a period. `alreadyBookedByName` is the sum of
 * prior accruals + actual invoices already posted this period for each item.
 * Returns one AccrualEntry per policy with a non-zero this-period accrual.
 */
export function buildAccrualSchedule(
  period: string,
  policies: AccrualPolicy[],
  alreadyBookedByName: Record<string, Cents> = {},
): AccrualEntry[] {
  const pDays = daysInPeriod(period);
  const { end } = periodBounds(period);
  const out: AccrualEntry[] = [];

  for (const policy of policies) {
    if (policy.basisDays <= 0) continue;
    // period_portion = basis × (days_in_period ÷ days_in_basis), computed in cents exactly.
    const periodPortion = allocateCents(policy.basisCents, [pDays, Math.max(0, policy.basisDays - pDays)])[0]!;
    const alreadyBooked = alreadyBookedByName[policy.name] ?? 0;
    const thisPeriod = periodPortion - alreadyBooked;
    if (thisPeriod <= 0) continue;

    const support = policy.supportReference ? ` per ${policy.supportReference}` : "";
    const reverseNote = policy.autoReverse ? " (reverses on day 1 of next period)" : "";
    const draft: NewJournalEntry = {
      entryDate: end,
      description: `${policy.name} ${period} accrual${support}${reverseNote}`,
      source: "tax_accrual",
      idempotencyKey: `accrual:${policy.name}:${period}`,
      status: "draft",
      createdBy: "engine",
      lines: [
        {
          accountCode: policy.expenseAccountCode,
          projectSlug: policy.projectSlug ?? null,
          debitCents: thisPeriod,
          creditCents: 0,
          memo: `${policy.name} accrual`,
        },
        {
          accountCode: policy.creditAccountCode,
          debitCents: 0,
          creditCents: thisPeriod,
          memo: `${policy.name} accrued`,
        },
      ],
    };
    out.push({
      name: policy.name,
      periodPortionCents: periodPortion,
      alreadyBookedCents: alreadyBooked,
      thisPeriodCents: thisPeriod,
      autoReverse: policy.autoReverse ?? false,
      draft,
    });
  }
  return out;
}
