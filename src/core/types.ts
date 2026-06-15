/**
 * The shared contract for the entire accounting engine. Every module imports its
 * interfaces from here so the fan-out stays coherent: change a shape once, here.
 *
 * Money is integer `Cents` (see money.ts) everywhere. Periods are "YYYY-MM".
 */

import type { Cents } from "./money.js";

export type { Cents };

// ─── Tenancy ────────────────────────────────────────────────────────────────
/** Single-tenant Phase 1 uses 'ariel'; Phase 2 sets a real tenant id. */
export type TenantId = string;

// ─── Chart of accounts ───────────────────────────────────────────────────────
export type AccountType =
  | "asset"
  | "liability"
  | "equity"
  | "revenue"
  | "cogs"
  | "expense"
  | "other";

export type NormalSide = "debit" | "credit";

export type TaxTreatment =
  | "ordinary"
  | "meals_50"
  | "capital"
  | "personal"
  | "nondeductible"
  | "mileage"
  | "home_office";

export interface ChartAccount {
  id: number;
  code: string;
  name: string;
  type: AccountType;
  normalSide: NormalSide;
  scheduleCLine: string | null;
  taxTreatment: TaxTreatment;
  isBusiness: boolean;
  isActive: boolean;
  parentCode: string | null;
}

export interface Project {
  id: number;
  slug: string;
  name: string;
  status: "active" | "parked" | "retired";
  isShared: boolean;
}

// ─── Double-entry ledger ──────────────────────────────────────────────────────
export type JournalSource =
  | "stripe"
  | "bank"
  | "manual"
  | "allocation"
  | "tax_accrual"
  | "adjustment";

export type EntryStatus = "posted" | "draft" | "void" | "needs_review";

export type CreatedBy = "engine" | "rule" | "llm" | "human";

/** A line to be posted. Exactly one of debit/credit is > 0. */
export interface NewJournalLine {
  accountCode: string;
  projectSlug?: string | null;
  debitCents: Cents;
  creditCents: Cents;
  /** Business-use fraction 0..100 (mixed personal/business). Default 100. */
  businessPct?: number;
  memo?: string;
}

/** An entry to post. Lines MUST balance (sum debit === sum credit). */
export interface NewJournalEntry {
  entryDate: string; // YYYY-MM-DD
  description: string;
  source: JournalSource;
  /** Source transaction id for reference; the idempotency anchor is idempotencyKey. */
  sourceTxnId?: string | null;
  /** Deterministic dedupe key: re-posting the same key is a no-op, never a double. */
  idempotencyKey: string;
  isAllocation?: boolean;
  createdBy?: CreatedBy;
  status?: EntryStatus;
  lines: NewJournalLine[];
}

export interface PostedEntry {
  id: number;
  idempotencyKey: string;
  alreadyExisted: boolean;
}

export interface TrialBalanceRow {
  accountCode: string;
  accountName: string;
  debitCents: Cents;
  creditCents: Cents;
}

export interface TrialBalance {
  period: string; // YYYY-MM
  balanced: boolean;
  debitsCents: Cents;
  creditsCents: Cents;
  rows: TrialBalanceRow[];
  /** Stable hash of the snapshot, anchored into the locked close record. */
  snapshotHash: string;
}

// ─── Ingestion / providers ────────────────────────────────────────────────────
/**
 * A read-only aggregation provider. By construction there is NO money-movement
 * method — no transfer/pay/move verb exists, so no code path can move money.
 */
export interface AggregationProvider {
  readonly name: string;
  listAccounts(accessToken: string): Promise<ProviderAccount[]>;
  syncTransactions(
    accessToken: string,
    cursor: string | null,
  ): Promise<ProviderSyncPage>;
}

export interface ProviderAccount {
  providerAccountId: string;
  name: string;
  mask?: string;
  type?: string;
  subtype?: string;
  currency: string;
}

export interface ProviderTransaction {
  providerTxnId: string;
  amountCents: Cents; // signed: negative = outflow, positive = inflow
  currency: string;
  postedDate: string | null; // YYYY-MM-DD
  authorizedDate: string | null;
  pending: boolean;
  description: string;
  merchantName: string | null;
  categoryProvider: string | null;
  raw: Record<string, unknown>;
  /** Which provider account this txn belongs to. */
  providerAccountId: string;
}

export interface ProviderSyncPage {
  added: ProviderTransaction[];
  modified: ProviderTransaction[];
  removed: string[]; // provider txn ids retracted
  nextCursor: string | null;
  hasMore: boolean;
}

/** Connection status; auth-class failures escalate with zero retry. */
export type ConnectionStatus = "active" | "login_required" | "error" | "revoked";

// ─── Reconciliation ────────────────────────────────────────────────────────────
export type ReconMatchType =
  | "stripe_payout"
  | "card_payment_transfer"
  | "internal_transfer"
  | "expense"
  | "revenue"
  | "unmatched";

export type ReconStatus = "auto" | "needs_review" | "confirmed" | "rejected";

export interface ReconResult {
  rawTxnId: number;
  matchType: ReconMatchType;
  matchedRef: string | null;
  confidence: number;
  status: ReconStatus;
  note?: string;
}

// ─── Categorization ─────────────────────────────────────────────────────────────
/** What the categorizer is given about one staged transaction. */
export interface CategorizationInput {
  sourceTxnId: string;
  merchant: string;
  amountCents: Cents;
  memo: string;
  postedDate: string | null;
  /** true when the txn is an outflow (expense candidate). */
  isOutflow: boolean;
}

/** A categorization decision (from any tier). */
export interface CategorizationResult {
  accountCode: string;
  projectSlug: string | null;
  businessPct: number;
  confidence: number;
  needsSplit: boolean;
  source: "merchant_rule" | "regex_rule" | "llm" | "fallback";
  rationale?: string;
}

/** Pluggable LLM categorizer (Tier c). Injected so it's testable with a mock. */
export interface LlmCategorizer {
  categorize(input: CategorizationInput, context: LlmCategorizeContext): Promise<LlmProposal>;
}

export interface LlmCategorizeContext {
  chart: Pick<ChartAccount, "code" | "name" | "type">[];
  projects: Pick<Project, "slug" | "name">[];
}

export interface LlmProposal {
  accountCode: string;
  projectSlug: string | null;
  businessPct: number;
  confidence: number;
  needsSplit: boolean;
  rationale: string;
}

export type CategorizeDisposition = "posted" | "quarantined";

export interface CategorizeOutcome {
  sourceTxnId: string;
  disposition: CategorizeDisposition;
  result?: CategorizationResult;
  reason?: "low_confidence" | "needs_split" | "new_merchant" | "amount_anomaly";
}

// ─── Allocation ──────────────────────────────────────────────────────────────────
export type AllocationMethod =
  | "direct"
  | "even"
  | "revenue_weighted"
  | "usage_weighted"
  | "fixed_percent";

export interface AllocationTarget {
  projectSlug: string;
  fixedPercent?: number;
  usageWeight?: number;
}

export interface AllocationRule {
  id: number;
  name: string;
  matchAccountCode: string | null;
  matchMerchantRegex: string | null;
  method: AllocationMethod;
  basisWindow: string;
  enabled: boolean;
  targets: AllocationTarget[];
}

// ─── Tax (modular entity strategies) ───────────────────────────────────────────
export type EntityType =
  | "sole_prop"
  | "single_llc"
  | "multi_llc"
  | "s_corp"
  | "c_corp"
  | "organize_only";

export type FilingStatus = "single" | "mfj" | "mfs" | "hoh";

export interface EntityProfile {
  taxYear: number;
  entityType: EntityType;
  filingStatus: FilingStatus;
  state: string;
  homeOfficeSqft: number | null;
  homeTotalSqft: number | null;
  reasonableSalaryCents: Cents | null;
}

export interface ScheduleLineRollup {
  scheduleLine: string;
  accountName: string;
  amountCents: Cents;
}

export interface EstimatedTax {
  taxYear: number;
  netSeProfitCents: Cents;
  seTaxCents: Cents;
  federalIncomeTaxCents: Cents;
  stateIncomeTaxCents: Cents;
  entityFeeCents: Cents;
  quarterlySetAsideCents: Cents;
  disclaimers: string[];
}

/** Common interface every entity strategy implements. Selected by EntityType. */
export interface TaxStrategy {
  readonly entityType: EntityType;
  scheduleRollup(rollup: ScheduleLineRollup[]): ScheduleLineRollup[];
  estimatedQuarterly(args: EstimateArgs): EstimatedTax;
  entitySpecificForms(): string[];
  disclaimers(): string[];
}

export interface EstimateArgs {
  taxYear: number;
  netProfitCents: Cents;
  grossReceiptsCents: Cents;
  profile: EntityProfile;
  rates: TaxRateSet;
}

/** Year-scoped rate set, loaded from acct_tax_rates (never literals in code). */
export interface TaxRateSet {
  taxYear: number;
  federal: Record<string, unknown>;
  state: Record<string, unknown>;
}

// ─── Documents / receipts (universal ingest + auto-split) ──────────────────────
export type DocumentSourceKind = "email" | "upload" | "photo" | "csv" | "pdf";

export type DocumentStatus =
  | "pending"
  | "extracted"
  | "matched"
  | "split"
  | "filed"
  | "unmatched"
  | "error";

/** A line item the extractor pulled out of a receipt/invoice/statement. */
export interface ExtractedLine {
  description: string;
  amountCents: Cents;
  qty?: number;
  /** The extractor's best-guess chart code (validated against the chart before use). */
  candidateAccountCode?: string | null;
  candidateProjectSlug?: string | null;
  businessPct?: number;
}

/** The structured result of parsing one document. */
export interface ExtractedDocument {
  vendorGuess: string | null;
  docDate: string | null; // YYYY-MM-DD
  totalCents: Cents | null;
  currency: string;
  lines: ExtractedLine[];
}

/** What the extractor is given (one or more available representations of the doc). */
export interface DocumentExtractInput {
  ocrText?: string;
  csv?: string;
  filename?: string;
  contentType?: string;
}

/**
 * Pluggable document extractor (the receipt analogue of LlmCategorizer). Injected so
 * receipts.ts is testable with a deterministic mock — no subprocess, no network.
 */
export interface DocumentExtractor {
  extract(input: DocumentExtractInput, context: LlmCategorizeContext): Promise<ExtractedDocument>;
}

// ─── Autonomous auditor ─────────────────────────────────────────────────────────
/**
 * A council deliberation result for one ambiguous transaction. The council either
 * resolves it (a confident account choice), surfaces a hard human-gate (aggressive
 * deduction / entity change / money movement — never auto-acted on), or asks for
 * access to data it needs (a research agent's structured request). It can also come
 * back unresolved, in which case the txn stays quarantined for a human.
 */
export interface CouncilVerdict {
  resolved: boolean;
  accountCode?: string | null;
  projectSlug?: string | null;
  businessPct?: number;
  confidence: number;
  rationale: string;
  /** A research-agent access ask: the auditor files it and defers, never guesses. */
  needsAccess?: { resource: string; reason: string; howToGrant: string } | null;
  /** A hard human-in-the-loop gate (e.g. "aggressive home-office %"); never auto-acted. */
  humanGate?: string | null;
}

/** Pluggable council escalator (injected so the auditor is testable with a mock). */
export interface CouncilEscalator {
  deliberate(input: CategorizationInput, context: LlmCategorizeContext): Promise<CouncilVerdict>;
}

export type AuditorVerdict =
  | "auto_posted"
  | "quarantined"
  | "escalated"
  | "deferred_access"
  | "overridden";

export type AuditorBasis = "rule" | "learned" | "llm" | "council" | "research" | "human";

export interface AuditorDecision {
  sourceTxnId: string;
  verdict: AuditorVerdict;
  basis: AuditorBasis;
  accountCode: string | null;
  confidence: number;
  rationale: string;
  accessRequestId?: number;
}

// ─── Month-end close ──────────────────────────────────────────────────────────
export type CloseMode = "off" | "draft" | "live";

export type CloseStage =
  | "precheck"
  | "sync-cutoff"
  | "ingest"
  | "categorize"
  | "allocate"
  | "reconcile"
  | "accrue-adjust"
  | "trial-balance"
  | "anomaly-scan"
  | "reports"
  | "archive-lock"
  | "notify";

export type CloseVerdictStatus = "CLEAN" | "CLEAN_WITH_EXCEPTIONS" | "FAILED";

export interface CloseVerdict {
  period: string;
  status: CloseVerdictStatus;
  balanced: boolean;
  debitsCents: Cents;
  creditsCents: Cents;
  postedCount: number;
  quarantineCount: number;
  quarantineValueCents: Cents;
  warnings: string[];
  failureReason?: string;
}

export interface CloseConfig {
  mode: CloseMode;
  ajeAutoThresholdCents: Cents;
  largeTxnReviewCents: Cents;
  confidenceThreshold: number;
  reconToleranceCents: Cents;
  reconEscalateDeltaCents: Cents;
}

export type CloseRunMode = "incremental" | "close";

// ─── Escalation digest ──────────────────────────────────────────────────────────
export type EscalationPriority = "P0" | "P1" | "P2" | "P3";

export interface EscalationItem {
  priority: EscalationPriority;
  title: string;
  detail: string;
  replyHint?: string;
}

export interface DigestModel {
  period: string;
  verdict: CloseVerdict;
  needsDecision: EscalationItem[];
  fyi: EscalationItem[];
  reportRefs: string[];
  narrative?: string;
}
