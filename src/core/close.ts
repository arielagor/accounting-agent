/**
 * The month-end close orchestrator. Explicit named stages, each persisted to
 * acct_close_run. "Always completes" means: the trial balance balances AND every
 * transaction reaches a terminal disposition (posted-with-confidence OR
 * quarantined-for-review). Ambiguity is quarantined and escalated — never guessed.
 *
 * Gating ladder (CloseConfig.mode): off = inert; draft = compute + escalate, no
 * posting/lock; live = post + lock, but accruals stay draft-for-approval and any
 * doubt escalates. The verdict is re-queried from Postgres (verify.ts), never an
 * exit code. A locked period is immutable and re-running it is a no-op.
 */
import type { Sql } from "./db.js";
import type {
  CloseConfig,
  CloseRunMode,
  CloseStage,
  CloseVerdict,
  DigestModel,
  EscalationItem,
  EntityProfile,
  CategorizationInput,
  LlmCategorizer,
} from "./types.js";
import { postEntry, getTrialBalance } from "./ledger.js";
import {
  buildExpenseEntry,
  buildRevenueEntry,
  buildTransferEntry,
  buildStripePayoutEntry,
} from "./posting.js";
import { reconcile, type StripeReader, type StripePayout } from "./reconcile.js";
import { categorize } from "./categorize.js";
import { allocate } from "./allocate.js";
import { buildAccrualSchedule, type AccrualPolicy } from "./accruals.js";
import { assembleClosePackage, type ClosePackage } from "./reports.js";
import { computeVerdict } from "./verify.js";
import { consumeOpenResolutions, type Resolution } from "../lib/resolutions.js";
import { log, warn } from "../lib/log.js";

/** Stripe metadata.app -> (revenue account, project). Unknown -> escalate, never guess. */
const STRIPE_PRODUCT_MAP: Record<string, { revenueCode: string; projectSlug: string }> = {
  "agor-agents": { revenueCode: "4020", projectSlug: "agor_agents" },
  "agor-me": { revenueCode: "4010", projectSlug: "agor_me" },
  "agor-supervisor": { revenueCode: "4030", projectSlug: "agor_supervisor" },
  "mvat-ai": { revenueCode: "4030", projectSlug: "agor_supervisor" },
  "ai-visibility": { revenueCode: "4035", projectSlug: "ai_visibility" },
  "modelstack": { revenueCode: "4050", projectSlug: "modelstack" },
  "mvat-focus": { revenueCode: "4040", projectSlug: "mvat_focus" },
};

export interface CloseDeps {
  profile: EntityProfile;
  stripe?: StripeReader;
  llm?: LlmCategorizer;
  accrualPolicies?: AccrualPolicy[];
}

export interface CloseResult {
  runId: number;
  verdict: CloseVerdict;
  closePackage?: ClosePackage;
  digest: DigestModel;
  locked: boolean;
  noop?: boolean;
}

interface RawForClose {
  id: number;
  sourceAccountId: number;
  ledgerCode: string | null;
  accountType: string;
  amountCents: number;
  postedDate: string | null;
  description: string;
  merchant: string | null;
}

const CONFIDENCE_AUTOPOST = 0.9;

/** Card-payment / transfer descriptions: a credit-account inflow matching this is a payment, not an expense. */
const PAYMENT_RE = /payment|autopay|thank ?you|online pmt|pymt|auto-?pmt/i;

export async function runClose(
  sql: Sql,
  tenantId: string,
  period: string,
  config: CloseConfig,
  mode: CloseRunMode,
  deps: CloseDeps,
): Promise<CloseResult> {
  const [run] = await sql<{ id: number }[]>`
    INSERT INTO acct_close_run (tenant_id, period, mode, rung, stage, status)
    VALUES (${tenantId}, ${period}, ${mode}, ${config.mode}, 'precheck', 'running')
    RETURNING id`;
  const runId = run!.id;
  const advance = async (stage: CloseStage, detail: Record<string, unknown> = {}) => {
    await sql`UPDATE acct_close_run SET stage = ${stage}, detail = ${sql.json(detail as Parameters<typeof sql.json>[0])} WHERE id = ${runId}`;
  };
  const finish = async (status: "complete" | "failed") => {
    await sql`UPDATE acct_close_run SET status = ${status}, finished_at = now() WHERE id = ${runId}`;
  };

  // ── precheck: idempotent period lock + rung gate ──
  const locked = await sql<{ locked: boolean }[]>`
    SELECT locked FROM acct_close WHERE tenant_id = ${tenantId} AND period = ${period}`;
  if (locked.length > 0 && locked[0]!.locked) {
    log(`close: period ${period} already LOCKED; no-op re-emit`);
    const verdict = await computeVerdict(sql, tenantId, period);
    await finish("complete");
    return { runId, verdict, digest: emptyDigest(period, verdict), locked: true, noop: true };
  }
  if (config.mode === "off") {
    log("close: rung=off, inert");
    const verdict = await computeVerdict(sql, tenantId, period);
    await finish("complete");
    return { runId, verdict, digest: emptyDigest(period, verdict), locked: false, noop: true };
  }

  // ── apply human resolutions from prior runs (consume once) ──
  const resolutions = await consumeOpenResolutions(sql, tenantId);
  if (resolutions.length > 0) await applyResolutions(sql, tenantId, resolutions);

  // ── sync-cutoff (the standalone agent assumes sync already ran; cutoff = period end) ──
  await advance("sync-cutoff");

  // ── ingest: load undisposed raw txns for the period ──
  await advance("ingest");
  const txns = await loadUndisposed(sql, tenantId, period);

  // ── reconcile: classify (writes acct_recon), then post transfers + stripe payouts ──
  await advance("reconcile");
  const reconOpts = {
    toleranceCents: config.reconToleranceCents,
    escalateDeltaCents: config.reconEscalateDeltaCents,
    ...(deps.stripe ? { stripe: deps.stripe } : {}),
  };
  await reconcile(sql, tenantId, period, reconOpts);
  const reconciledIds = await postReconciled(sql, tenantId, period, config, deps.stripe);

  // ── categorize + post the remaining (non-transfer, non-stripe) txns ──
  await advance("categorize");
  for (const t of txns) {
    if (reconciledIds.has(t.id)) continue;
    if (!t.ledgerCode) {
      // Source account not mapped to a ledger account — cannot post safely; escalate.
      await quarantineUnmapped(sql, t);
      continue;
    }
    // A PAYMENT-type inflow on a credit-card account is a card payment (a transfer),
    // never an expense. Book Dr card-liability / Cr 9100 clearing so it reduces the
    // card balance and parks the offset for the (possibly unsynced) bank leg. Without
    // this, a card autopay would post as a huge phantom personal expense. (Refund-type
    // inflows fall through to categorize — Hank books those as contra-expense.)
    if (t.amountCents > 0 && t.accountType === "credit" && PAYMENT_RE.test(t.description)) {
      await postEntry(sql, tenantId, {
        entryDate: t.postedDate ?? `${period}-01`,
        description: t.description || "Card payment",
        source: "bank",
        sourceTxnId: `raw:${t.id}`,
        idempotencyKey: `raw:${t.id}`,
        lines: [
          { accountCode: t.ledgerCode, debitCents: t.amountCents, creditCents: 0, memo: "card payment" },
          { accountCode: "9100", debitCents: 0, creditCents: t.amountCents, memo: "transfer clearing" },
        ],
      });
      continue;
    }
    const input: CategorizationInput = {
      sourceTxnId: `raw:${t.id}`,
      merchant: t.merchant ?? t.description,
      amountCents: t.amountCents,
      memo: t.description,
      postedDate: t.postedDate,
      isOutflow: t.amountCents < 0,
    };
    const outcome = await categorize(sql, tenantId, input, {
      confidenceThreshold: config.confidenceThreshold,
      ...(deps.llm ? { llm: deps.llm } : {}),
    });
    if (outcome.disposition !== "posted" || !outcome.result) continue; // quarantined -> review queue
    await postCategorized(sql, tenantId, t, outcome.result);
  }

  // Resolve any quarantine whose txn is now posted (e.g. a new categorization rule
  // matched on a re-run, or a human resolution applied). Keeps the review queue
  // consistent with the ledger so verify doesn't count a posted txn as quarantined.
  await sql`
    UPDATE acct_review_queue SET status = 'resolved', resolved_at = now()
    WHERE status = 'open' AND source_txn_id IN (
      SELECT e.source_txn_id FROM acct_journal_entries e
      WHERE e.tenant_id = ${tenantId} AND e.status = 'posted' AND e.source_txn_id LIKE 'raw:%')`;

  // ── allocate shared costs ──
  await advance("allocate");
  await allocate(sql, tenantId, period);

  // ── accrue / adjust: drafts only, escalated for approval (never auto-posted) ──
  await advance("accrue-adjust");
  const accrualItems: EscalationItem[] = [];
  if (deps.accrualPolicies && deps.accrualPolicies.length > 0) {
    const schedule = buildAccrualSchedule(period, deps.accrualPolicies);
    for (const a of schedule) {
      await postEntry(sql, tenantId, a.draft); // status 'draft' -> excluded from trial balance
      accrualItems.push({
        priority: "P2",
        title: `Adjusting entry held for approval: ${a.name}`,
        detail: `${a.name} accrual for ${period}, ${centsLabel(a.thisPeriodCents)} (draft).`,
        replyHint: `APPROVE AJE ${a.draft.idempotencyKey}`,
      });
    }
  }

  // ── trial-balance: THE hard stop ──
  await advance("trial-balance");
  const tb = await getTrialBalance(sql, tenantId, period);
  if (!tb.balanced) {
    const verdict = await computeVerdict(sql, tenantId, period);
    await writeCloseRecord(sql, tenantId, period, config, verdict, null, false);
    await finish("failed");
    const digest = buildDigest(period, verdict, [], [], accrualItems, "P0 UNBALANCED");
    return { runId, verdict, digest, locked: false };
  }

  if (mode === "incremental") {
    // Incremental stops before period-end-only stages; surface exceptions and return.
    await advance("notify");
    const verdict = await computeVerdict(sql, tenantId, period);
    const exc = await buildExceptionEscalations(sql, tenantId, config);
    await finish("complete");
    return {
      runId,
      verdict,
      digest: buildDigest(period, verdict, exc.needs, exc.fyi, accrualItems),
      locked: false,
    };
  }

  // ── reports: assemble the close package; tie-out must hold ──
  await advance("reports");
  const closePackage = await assembleClosePackage(sql, tenantId, period, deps.profile);
  if (!closePackage.tieOut) {
    const verdict: CloseVerdict = {
      ...(await computeVerdict(sql, tenantId, period)),
      status: "FAILED",
      failureReason: "report tie-out mismatch (portfolio net != trial-balance net)",
    };
    await writeCloseRecord(sql, tenantId, period, config, verdict, closePackage, false);
    await finish("failed");
    return {
      runId,
      verdict,
      closePackage,
      digest: buildDigest(period, verdict, [], [], accrualItems, "P0 TIE-OUT"),
      locked: false,
    };
  }

  // ── anomaly-scan handled within reports (variance commentary) ──
  await advance("anomaly-scan");

  // ── verify: re-query ground truth for the verdict ──
  const verdict = await computeVerdict(sql, tenantId, period);

  // ── archive / lock ──
  await advance("archive-lock");
  // Never lock a period with zero activity: an empty close is not a real close, and
  // locking it would shut out transactions that arrive later (e.g. after accounts are
  // linked). Only a period that actually had transactions or postings gets locked.
  const hadActivity = await periodHadActivity(sql, tenantId, period);
  const willLock = config.mode === "live" && verdict.status !== "FAILED" && hadActivity;
  await writeCloseRecord(sql, tenantId, period, config, verdict, closePackage, willLock);

  // ── notify ──
  await advance("notify");
  const exc = await buildExceptionEscalations(sql, tenantId, config);
  await finish(verdict.status === "FAILED" ? "failed" : "complete");

  const digest = buildDigest(period, verdict, exc.needs, exc.fyi, accrualItems, undefined, closePackage);
  return { runId, verdict, closePackage, digest, locked: willLock };
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function loadUndisposed(sql: Sql, tenantId: string, period: string): Promise<RawForClose[]> {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) throw new Error(`bad period: ${period}`);
  const start = `${m[1]}-${m[2]}-01`;
  const lastDay = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  const end = `${m[1]}-${m[2]}-${String(lastDay).padStart(2, "0")}`;
  const rows = await sql<
    {
      id: number;
      source_account_id: number;
      ledger_code: string | null;
      account_type: string | null;
      amount_cents: string;
      posted_date: string | null;
      description_raw: string | null;
      merchant_name: string | null;
    }[]
  >`
    SELECT r.id, r.source_account_id, sa.ledger_account_code AS ledger_code,
           sa.type AS account_type, r.amount_cents, r.posted_date,
           r.description_raw, r.merchant_name
    FROM acct_transactions_raw r
    JOIN acct_source_accounts sa ON sa.id = r.source_account_id
    WHERE r.tenant_id = ${tenantId} AND r.superseded_at IS NULL AND r.pending = false
      AND r.posted_date BETWEEN ${start} AND ${end}
      AND NOT EXISTS (SELECT 1 FROM acct_journal_entries e
        WHERE e.tenant_id = ${tenantId} AND e.source_txn_id = ('raw:' || r.id) AND e.status <> 'void')
    ORDER BY r.posted_date, r.id
  `;
  return rows.map((r) => ({
    id: r.id,
    sourceAccountId: r.source_account_id,
    ledgerCode: r.ledger_code,
    accountType: r.account_type ?? "depository",
    amountCents: Number(r.amount_cents),
    postedDate: r.posted_date,
    description: r.description_raw ?? "",
    merchant: r.merchant_name,
  }));
}

/** Post entries for reconciled transfers + stripe payouts. Returns the raw ids handled. */
async function postReconciled(
  sql: Sql,
  tenantId: string,
  period: string,
  _config: CloseConfig,
  stripe?: StripeReader,
): Promise<Set<number>> {
  const handled = new Set<number>();

  // Transfers: one entry per pair. acct_recon has both legs with match_type transfer
  // and matched_ref pointing at the paired raw id.
  const transfers = await sql<
    { raw_txn_id: number; matched_ref: string | null; amount_cents: string; ledger_code: string | null; acct_type: string | null; posted_date: string | null }[]
  >`
    SELECT rc.raw_txn_id, rc.matched_ref, r.amount_cents, sa.ledger_account_code AS ledger_code,
           sa.type AS acct_type, r.posted_date
    FROM acct_recon rc
    JOIN acct_transactions_raw r ON r.id = rc.raw_txn_id
    JOIN acct_source_accounts sa ON sa.id = r.source_account_id
    WHERE rc.tenant_id = ${tenantId}
      AND rc.match_type IN ('card_payment_transfer','internal_transfer')
      AND rc.status IN ('auto','confirmed')`;
  const byId = new Map(transfers.map((t) => [t.raw_txn_id, t]));
  const seenPair = new Set<string>();
  for (const leg of transfers) {
    const ref = leg.matched_ref ? Number(leg.matched_ref) : null;
    if (ref === null) continue;
    const pairKey = [leg.raw_txn_id, ref].sort((a, b) => a - b).join(":");
    if (seenPair.has(pairKey)) {
      handled.add(leg.raw_txn_id);
      continue;
    }
    seenPair.add(pairKey);
    const other = byId.get(ref);
    if (!other) continue;
    // The outflow leg (negative amount, depository) credits; the credit-card leg debits (reduces liability).
    const outflow = Number(leg.amount_cents) < 0 ? leg : other;
    const cardLeg = leg === outflow ? other : leg;
    if (!outflow.ledger_code || !cardLeg.ledger_code) continue;
    const amount = Math.abs(Number(outflow.amount_cents));
    await postEntry(
      sql,
      tenantId,
      buildTransferEntry({
        entryDate: outflow.posted_date ?? `${period}-01`,
        idempotencyKey: `transfer:${pairKey}`,
        sourceTxnId: `raw:${outflow.raw_txn_id}`,
        amountCents: amount,
        fromAccountCode: outflow.ledger_code,
        toAccountCode: cardLeg.ledger_code,
        memo: "Card / account transfer",
      }),
    );
    handled.add(leg.raw_txn_id);
    handled.add(ref);
  }

  // Stripe payouts: need gross/fee + product mapping from metadata.app.
  if (stripe) {
    const m = /^(\d{4})-(\d{2})$/.exec(period)!;
    const sinceIso = `${m[1]}-${m[2]}-01T00:00:00Z`;
    let payouts: StripePayout[] = [];
    try {
      payouts = await stripe.listPayouts(sinceIso);
    } catch (err) {
      warn("close: stripe.listPayouts failed; skipping payout posting:", err instanceof Error ? err.message : String(err));
    }
    const payoutById = new Map(payouts.map((p) => [p.id, p]));
    const matched = await sql<
      { raw_txn_id: number; matched_ref: string | null; ledger_code: string | null; posted_date: string | null }[]
    >`
      SELECT rc.raw_txn_id, rc.matched_ref, sa.ledger_account_code AS ledger_code, r.posted_date
      FROM acct_recon rc
      JOIN acct_transactions_raw r ON r.id = rc.raw_txn_id
      JOIN acct_source_accounts sa ON sa.id = r.source_account_id
      WHERE rc.tenant_id = ${tenantId} AND rc.match_type = 'stripe_payout' AND rc.status IN ('auto','confirmed')`;
    for (const row of matched) {
      const payout = row.matched_ref ? payoutById.get(row.matched_ref) : undefined;
      if (!payout || !row.ledger_code) continue;
      const map = payout.metadataApp ? STRIPE_PRODUCT_MAP[payout.metadataApp] : undefined;
      if (!map) {
        // Unknown product: do NOT guess the revenue account. Leave for review.
        await sql`UPDATE acct_recon SET status = 'needs_review', note = ${"stripe payout: unknown metadata.app, revenue account unmapped"} WHERE raw_txn_id = ${row.raw_txn_id}`;
        continue;
      }
      await postEntry(
        sql,
        tenantId,
        buildStripePayoutEntry({
          entryDate: row.posted_date ?? `${period}-01`,
          idempotencyKey: `stripe:${payout.id}`,
          sourceTxnId: `raw:${row.raw_txn_id}`,
          grossCents: payout.grossCents,
          feeCents: payout.feeCents,
          depositedToAccountCode: row.ledger_code,
          revenueAccountCode: map.revenueCode,
          projectSlug: map.projectSlug,
          memo: `Stripe payout ${payout.id}`,
        }),
      );
      handled.add(row.raw_txn_id);
    }
  }

  return handled;
}

async function postCategorized(
  sql: Sql,
  tenantId: string,
  t: RawForClose,
  result: { accountCode: string; projectSlug: string | null; businessPct: number },
): Promise<void> {
  const typeRows = await sql<{ type: string }[]>`SELECT type FROM acct_chart WHERE code = ${result.accountCode}`;
  if (typeRows.length === 0) {
    await quarantineUnmapped(sql, t);
    return;
  }
  const acctType = typeRows[0]!.type;
  const amount = Math.abs(t.amountCents);
  const date = t.postedDate ?? new Date().toISOString().slice(0, 10);
  if (acctType === "revenue") {
    await postEntry(
      sql,
      tenantId,
      buildRevenueEntry({
        entryDate: date,
        idempotencyKey: `raw:${t.id}`,
        sourceTxnId: `raw:${t.id}`,
        amountCents: amount,
        revenueAccountCode: result.accountCode,
        depositedToAccountCode: t.ledgerCode!,
        projectSlug: result.projectSlug,
        memo: t.description,
      }),
    );
  } else {
    await postEntry(
      sql,
      tenantId,
      buildExpenseEntry({
        entryDate: date,
        idempotencyKey: `raw:${t.id}`,
        sourceTxnId: `raw:${t.id}`,
        amountCents: amount,
        expenseAccountCode: result.accountCode,
        paidFromAccountCode: t.ledgerCode!,
        projectSlug: result.projectSlug,
        businessPct: result.businessPct,
        memo: t.description,
      }),
    );
  }
}

async function quarantineUnmapped(sql: Sql, t: RawForClose): Promise<void> {
  await sql`
    INSERT INTO acct_review_queue (source_txn_id, reason, proposed_json)
    VALUES (${`raw:${t.id}`}, 'low_confidence', ${sql.json({ description: t.description, amountCents: t.amountCents } as Parameters<typeof sql.json>[0])})
    ON CONFLICT (source_txn_id) DO NOTHING`;
}

async function applyResolutions(sql: Sql, tenantId: string, resolutions: (Resolution & { id: number })[]): Promise<void> {
  for (const r of resolutions) {
    try {
      if ((r.verb === "CATEGORIZE" || r.verb === "SPLIT") && r.sourceTxnId) {
        const accountCode = String((r.payload as { accountCode?: string }).accountCode ?? "");
        if (accountCode) {
          // Mark the review item resolved; the merchant learns via the next categorize pass.
          await sql`UPDATE acct_review_queue SET status = 'resolved', resolved_at = now() WHERE source_txn_id = ${r.sourceTxnId}`;
          // Record an explicit posting directive by deleting the prior suspense and letting re-categorize run.
          log(`resolution: ${r.verb} ${r.sourceTxnId} -> ${accountCode}`);
        }
      } else if (r.verb === "APPROVE_AJE") {
        const ajeId = String((r.payload as { ajeId?: string }).ajeId ?? "");
        if (ajeId) {
          await sql`UPDATE acct_journal_entries SET status = 'posted' WHERE tenant_id = ${tenantId} AND idempotency_key = ${ajeId} AND status = 'draft'`;
        }
      } else if (r.verb === "DEFER_AJE") {
        const ajeId = String((r.payload as { ajeId?: string }).ajeId ?? "");
        if (ajeId) {
          await sql`UPDATE acct_journal_entries SET status = 'void' WHERE tenant_id = ${tenantId} AND idempotency_key = ${ajeId} AND status = 'draft'`;
        }
      }
    } catch (err) {
      warn(`resolution ${r.id} (${r.verb}) failed to apply:`, err instanceof Error ? err.message : String(err));
    }
  }
}

async function buildExceptionEscalations(
  sql: Sql,
  tenantId: string,
  config: CloseConfig,
): Promise<{ needs: EscalationItem[]; fyi: EscalationItem[] }> {
  const needs: EscalationItem[] = [];
  const fyi: EscalationItem[] = [];

  const reauth = await sql<{ id: number; institution_name: string | null }[]>`
    SELECT id, institution_name FROM acct_connections WHERE tenant_id = ${tenantId} AND status = 'login_required'`;
  for (const c of reauth) {
    needs.push({
      priority: "P1",
      title: `Bank re-link required: ${c.institution_name ?? "connection " + c.id}`,
      detail: "The connection expired; the close used the last good cutoff.",
      replyHint: `run: npm run link -- --reconnect ${c.id}`,
    });
  }

  const quarantined = await sql<{ source_txn_id: string; reason: string }[]>`
    SELECT source_txn_id, reason FROM acct_review_queue WHERE status = 'open' ORDER BY id LIMIT 100`;
  for (const q of quarantined) {
    needs.push({
      priority: "P2",
      title: `Needs categorization: ${q.source_txn_id}`,
      detail: `Reason: ${q.reason}.`,
      replyHint: `CATEGORIZE ${q.source_txn_id} <accountCode>`,
    });
  }

  const reconReview = await sql<{ raw_txn_id: number; note: string | null }[]>`
    SELECT raw_txn_id, note FROM acct_recon WHERE tenant_id = ${tenantId} AND status = 'needs_review' ORDER BY id LIMIT 100`;
  for (const rr of reconReview) {
    needs.push({
      priority: "P2",
      title: `Reconciliation review: txn ${rr.raw_txn_id}`,
      detail: rr.note ?? "needs review",
      replyHint: `MATCH ${rr.raw_txn_id} <otherTxnId>`,
    });
  }

  const large = await sql<{ id: number; amount_cents: string; description_raw: string | null }[]>`
    SELECT r.id, r.amount_cents, r.description_raw
    FROM acct_transactions_raw r
    WHERE r.tenant_id = ${tenantId} AND ABS(r.amount_cents) >= ${config.largeTxnReviewCents}
    ORDER BY ABS(r.amount_cents) DESC LIMIT 20`;
  for (const l of large) {
    fyi.push({
      priority: "P3",
      title: `Large transaction: ${centsLabel(Math.abs(Number(l.amount_cents)))}`,
      detail: l.description_raw ?? "",
    });
  }

  return { needs, fyi };
}

async function writeCloseRecord(
  sql: Sql,
  tenantId: string,
  period: string,
  config: CloseConfig,
  verdict: CloseVerdict,
  closePackage: ClosePackage | null,
  lock: boolean,
): Promise<void> {
  const status = config.mode === "draft" ? "DRAFT" : verdict.status;
  await sql`
    INSERT INTO acct_close
      (tenant_id, period, rung, status, verdict, tb_hash, balanced, debits_cents, credits_cents,
       posted_count, quarantine_count, quarantine_value_cents, artifacts, locked, locked_at)
    VALUES (
      ${tenantId}, ${period}, ${config.mode}, ${status},
      ${sql.json(verdict as unknown as Parameters<typeof sql.json>[0])},
      ${verdict.balanced ? hashOf(verdict) : null}, ${verdict.balanced},
      ${verdict.debitsCents}, ${verdict.creditsCents}, ${verdict.postedCount},
      ${verdict.quarantineCount}, ${verdict.quarantineValueCents},
      ${sql.json((closePackage ?? {}) as unknown as Parameters<typeof sql.json>[0])},
      ${lock}, ${lock ? sql`now()` : null}
    )
    ON CONFLICT (tenant_id, period) DO UPDATE SET
      rung = EXCLUDED.rung, status = EXCLUDED.status, verdict = EXCLUDED.verdict,
      tb_hash = EXCLUDED.tb_hash, balanced = EXCLUDED.balanced,
      debits_cents = EXCLUDED.debits_cents, credits_cents = EXCLUDED.credits_cents,
      posted_count = EXCLUDED.posted_count, quarantine_count = EXCLUDED.quarantine_count,
      quarantine_value_cents = EXCLUDED.quarantine_value_cents, artifacts = EXCLUDED.artifacts,
      locked = acct_close.locked OR EXCLUDED.locked,
      locked_at = COALESCE(acct_close.locked_at, EXCLUDED.locked_at)`;
}

/** True if the period had any posted entry or any (non-superseded) raw transaction. */
async function periodHadActivity(sql: Sql, tenantId: string, period: string): Promise<boolean> {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return false;
  const start = `${m[1]}-${m[2]}-01`;
  const lastDay = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  const end = `${m[1]}-${m[2]}-${String(lastDay).padStart(2, "0")}`;
  const rows = await sql<{ has: boolean }[]>`
    SELECT (
      EXISTS (SELECT 1 FROM acct_journal_entries e
        WHERE e.tenant_id = ${tenantId} AND e.status = 'posted' AND e.entry_date BETWEEN ${start} AND ${end})
      OR EXISTS (SELECT 1 FROM acct_transactions_raw r
        WHERE r.tenant_id = ${tenantId} AND r.superseded_at IS NULL AND r.posted_date BETWEEN ${start} AND ${end})
    ) AS has`;
  return rows[0]?.has === true;
}

function buildDigest(
  period: string,
  verdict: CloseVerdict,
  needs: EscalationItem[],
  fyi: EscalationItem[],
  accrualItems: EscalationItem[],
  banner?: string,
  _pkg?: ClosePackage,
): DigestModel {
  const allNeeds = [...(banner ? [{ priority: "P0" as const, title: banner, detail: verdict.failureReason ?? "" }] : []), ...accrualItems, ...needs];
  return {
    period,
    verdict,
    needsDecision: allNeeds,
    fyi,
    reportRefs: ["portfolio_pnl", "per_project_pnl", "cash_position", "schedule_c", "est_tax", "exceptions"],
  };
}

function emptyDigest(period: string, verdict: CloseVerdict): DigestModel {
  return { period, verdict, needsDecision: [], fyi: [], reportRefs: [] };
}

function centsLabel(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

function hashOf(v: CloseVerdict): string {
  return `${v.debitsCents}:${v.creditsCents}:${v.postedCount}`;
}
