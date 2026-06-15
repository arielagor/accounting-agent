/**
 * Posting builders — the one place double-entry DEBIT/CREDIT DIRECTION lives.
 * Getting direction wrong is catastrophic and subtle, so it is centralized,
 * commented, and tested rather than scattered across the engine.
 *
 * Sign conventions (provider amounts): negative = outflow, positive = inflow.
 * Builders take ABSOLUTE cent amounts and a clear semantic; callers decide which
 * builder to use based on the reconciliation match type.
 */

import type { NewJournalEntry, NewJournalLine, JournalSource, Cents } from "./types.js";
import { allocateCents } from "./money.js";

export interface ExpenseArgs {
  entryDate: string;
  idempotencyKey: string;
  sourceTxnId?: string | null;
  amountCents: Cents; // absolute, > 0
  expenseAccountCode: string;
  /** The ledger account of the card/bank that paid (liability or asset). */
  paidFromAccountCode: string;
  projectSlug?: string | null;
  /** 0..100; the business-use fraction. The rest posts to personal (9500). */
  businessPct?: number;
  memo?: string;
  source?: JournalSource;
}

/**
 * An expense paid from a card or bank account.
 *   Dr expense (business portion) [+ Dr 9500 Personal (personal portion)]
 *   Cr paid-from account (full amount)
 * Whether paid-from is a liability (card) or asset (checking), CREDIT decreases
 * the asset / increases the liability — both correct for "money went out".
 */
export function buildExpenseEntry(args: ExpenseArgs): NewJournalEntry {
  const amount = Math.abs(args.amountCents);
  const pct = clampPct(args.businessPct ?? 100);
  const [businessCents, personalCents] = allocateCents(amount, [pct, 100 - pct]);
  const lines: NewJournalLine[] = [];
  if (businessCents! > 0) {
    lines.push({
      accountCode: args.expenseAccountCode,
      projectSlug: args.projectSlug ?? null,
      debitCents: businessCents!,
      creditCents: 0,
      businessPct: pct,
      memo: args.memo,
    });
  }
  if (personalCents! > 0) {
    lines.push({
      accountCode: "9500", // Personal — non-deductible
      projectSlug: "personal",
      debitCents: personalCents!,
      creditCents: 0,
      businessPct: 0,
      memo: args.memo ? `${args.memo} (personal portion)` : "personal portion",
    });
  }
  lines.push({
    accountCode: args.paidFromAccountCode,
    debitCents: 0,
    creditCents: amount,
    memo: args.memo,
  });
  return {
    entryDate: args.entryDate,
    description: args.memo ?? `Expense ${args.expenseAccountCode}`,
    source: args.source ?? "bank",
    sourceTxnId: args.sourceTxnId ?? null,
    idempotencyKey: args.idempotencyKey,
    lines,
  };
}

export interface RevenueArgs {
  entryDate: string;
  idempotencyKey: string;
  sourceTxnId?: string | null;
  amountCents: Cents; // absolute, > 0
  revenueAccountCode: string;
  /** The asset account the money landed in. */
  depositedToAccountCode: string;
  projectSlug?: string | null;
  memo?: string;
  source?: JournalSource;
}

/**
 * Revenue received directly into an account (no processor fee).
 *   Dr deposited-to (asset increases)
 *   Cr revenue (revenue increases)
 */
export function buildRevenueEntry(args: RevenueArgs): NewJournalEntry {
  const amount = Math.abs(args.amountCents);
  return {
    entryDate: args.entryDate,
    description: args.memo ?? `Revenue ${args.revenueAccountCode}`,
    source: args.source ?? "bank",
    sourceTxnId: args.sourceTxnId ?? null,
    idempotencyKey: args.idempotencyKey,
    lines: [
      {
        accountCode: args.depositedToAccountCode,
        debitCents: amount,
        creditCents: 0,
        memo: args.memo,
      },
      {
        accountCode: args.revenueAccountCode,
        projectSlug: args.projectSlug ?? null,
        debitCents: 0,
        creditCents: amount,
        memo: args.memo,
      },
    ],
  };
}

export interface TransferArgs {
  entryDate: string;
  idempotencyKey: string;
  sourceTxnId?: string | null;
  amountCents: Cents; // absolute, > 0
  /** Account money moved OUT of (credited). */
  fromAccountCode: string;
  /** Account money moved INTO (debited). For a card payment this is the card liability. */
  toAccountCode: string;
  memo?: string;
}

/**
 * A transfer between the owner's own accounts (e.g. paying a credit card from
 * checking). This is NOT an expense — the expenses were the individual card
 * charges. It must net to zero across the books.
 *   Dr to-account (card liability decreases / destination asset increases)
 *   Cr from-account (source asset decreases)
 */
export function buildTransferEntry(args: TransferArgs): NewJournalEntry {
  const amount = Math.abs(args.amountCents);
  return {
    entryDate: args.entryDate,
    description: args.memo ?? "Transfer",
    source: "bank",
    sourceTxnId: args.sourceTxnId ?? null,
    idempotencyKey: args.idempotencyKey,
    lines: [
      { accountCode: args.toAccountCode, debitCents: amount, creditCents: 0, memo: args.memo },
      { accountCode: args.fromAccountCode, debitCents: 0, creditCents: amount, memo: args.memo },
    ],
  };
}

export interface StripePayoutArgs {
  entryDate: string;
  idempotencyKey: string;
  sourceTxnId?: string | null;
  grossCents: Cents; // > 0
  feeCents: Cents; // >= 0
  depositedToAccountCode: string;
  revenueAccountCode: string;
  projectSlug?: string | null;
  memo?: string;
}

/**
 * A Stripe payout recognized as revenue net of fees (cash-basis recognition).
 *   Dr bank (net = gross - fee)
 *   Dr 5010 Payment Processing Fees (fee)
 *   Cr revenue (gross)
 */
export function buildStripePayoutEntry(args: StripePayoutArgs): NewJournalEntry {
  const gross = Math.abs(args.grossCents);
  const fee = Math.abs(args.feeCents);
  const net = gross - fee;
  const lines: NewJournalLine[] = [
    { accountCode: args.depositedToAccountCode, debitCents: net, creditCents: 0, memo: args.memo },
  ];
  if (fee > 0) {
    lines.push({
      accountCode: "5010",
      projectSlug: args.projectSlug ?? null,
      debitCents: fee,
      creditCents: 0,
      memo: "Stripe processing fee",
    });
  }
  lines.push({
    accountCode: args.revenueAccountCode,
    projectSlug: args.projectSlug ?? null,
    debitCents: 0,
    creditCents: gross,
    memo: args.memo,
  });
  return {
    entryDate: args.entryDate,
    description: args.memo ?? "Stripe payout",
    source: "stripe",
    sourceTxnId: args.sourceTxnId ?? null,
    idempotencyKey: args.idempotencyKey,
    lines,
  };
}

export interface SplitLineInput {
  expenseAccountCode: string;
  projectSlug?: string | null;
  amountCents: Cents; // absolute, > 0
  businessPct?: number;
  memo?: string;
}

export interface SplitChargeArgs {
  entryDate: string;
  idempotencyKey: string;
  sourceTxnId?: string | null;
  /** The absolute amount that actually hit the card/bank (the aggregate charge). */
  chargeCents: Cents;
  /** The card/bank ledger account that was charged (credited for the full amount). */
  paidFromAccountCode: string;
  lines: SplitLineInput[];
  /** Where an unexplained residual (chargeCents - sum(lines)) is parked. Default 9000. */
  suspenseAccountCode?: string;
  memo?: string;
  source?: JournalSource;
}

/**
 * Split one aggregate charge (e.g. APPLE.COM/BILL) into its component expense lines.
 *   For each component:  Dr expense (business portion) [+ Dr 9500 Personal (rest)]
 *   Any residual that doesn't tie to the components:  Dr 9000 Suspense (residual)
 *   Cr paid-from account (the FULL charge amount)
 * Balances by construction: total debits = sum(component amounts) + residual =
 * chargeCents = the single credit. The residual line makes a not-quite-tying receipt
 * post honestly (flagged in suspense) rather than silently fudging the numbers.
 * Throws if the components exceed the charge (caller must guard with a tolerance).
 */
export function buildSplitChargeEntry(args: SplitChargeArgs): NewJournalEntry {
  const charge = Math.abs(args.chargeCents);
  const lines: NewJournalLine[] = [];
  let componentsTotal = 0;
  for (const c of args.lines) {
    const amount = Math.abs(c.amountCents);
    if (amount === 0) continue;
    componentsTotal += amount;
    const pct = clampPct(c.businessPct ?? 100);
    const [businessCents, personalCents] = allocateCents(amount, [pct, 100 - pct]);
    if (businessCents! > 0) {
      lines.push({
        accountCode: c.expenseAccountCode,
        projectSlug: c.projectSlug ?? null,
        debitCents: businessCents!,
        creditCents: 0,
        businessPct: pct,
        memo: c.memo,
      });
    }
    if (personalCents! > 0) {
      lines.push({
        accountCode: "9500",
        projectSlug: "personal",
        debitCents: personalCents!,
        creditCents: 0,
        businessPct: 0,
        memo: c.memo ? `${c.memo} (personal portion)` : "personal portion",
      });
    }
  }
  const residual = charge - componentsTotal;
  if (residual < 0) {
    throw new Error(
      `split components (${componentsTotal}) exceed charge (${charge}); caller must guard with a tolerance`,
    );
  }
  if (residual > 0) {
    lines.push({
      accountCode: args.suspenseAccountCode ?? "9000",
      debitCents: residual,
      creditCents: 0,
      memo: "unexplained residual from receipt split",
    });
  }
  lines.push({
    accountCode: args.paidFromAccountCode,
    debitCents: 0,
    creditCents: charge,
    memo: args.memo ?? "aggregate charge",
  });
  return {
    entryDate: args.entryDate,
    description: args.memo ?? "Receipt split",
    source: args.source ?? "bank",
    sourceTxnId: args.sourceTxnId ?? null,
    idempotencyKey: args.idempotencyKey,
    lines,
  };
}

function clampPct(p: number): number {
  if (!Number.isFinite(p)) return 100;
  return Math.max(0, Math.min(100, p));
}
