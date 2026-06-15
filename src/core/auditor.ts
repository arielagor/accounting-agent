/**
 * The autonomous auditor. It resolves the doubt that the 3-tier categorizer parked in
 * the review queue: for each open item it convenes the /council, then acts on the
 * verdict with strict, recorded discipline:
 *
 *   council resolves confidently        → POST it (basis 'council'), learn the merchant
 *   council needs data it can't see      → file a human-grantable access-request, DEFER
 *   council flags a hard human-gate       → ESCALATE (never auto-act); a human decides
 *   council can't resolve / low confidence → leave QUARANTINED for a human
 *
 * Deterministic guards run REGARDLESS of the council: a sensitive account
 * (aggressive deduction territory) or a large amount forces a human gate even if the
 * council was confident. Every outcome writes acct_auditor_decisions + acct_audit_log
 * — the trust spine. The auditor NEVER guesses into a post and NEVER self-grants access.
 */
import type { Sql } from "./db.js";
import type {
  AuditorBasis,
  AuditorDecision,
  CategorizationInput,
  CouncilEscalator,
  CouncilVerdict,
  AccountType,
} from "./types.js";
import { applyManualCategorization } from "./resolve.js";
import { logAudit, requestAccess } from "./audit.js";
import { log } from "../lib/log.js";

export interface AuditorConfig {
  /** Below this the council's resolution is treated as not confident enough to post. */
  confidenceThreshold: number;
  /** Accounts whose use is aggressive-deduction territory; auto-post is never allowed. */
  sensitiveAccountCodes?: Set<string>;
  /** Charges at/above this always require a human (large-amount gate). 0 disables. */
  humanGateAmountCents?: number;
}

const DEFAULT_SENSITIVE = new Set<string>([
  "6300", // Home office (8829) — % is a classic audit flag
  "6310", // Vehicle / mileage — 100% business is rarely defensible
  "6900", // Meals — already 50%, but large entertainment claims escalate
]);

interface RawTxn {
  rawId: number;
  amountCents: number;
  postedDate: string | null;
  merchant: string;
  memo: string;
  isOutflow: boolean;
  ledgerCode: string | null;
}

async function loadRawTxn(sql: Sql, tenantId: string, sourceTxnId: string): Promise<RawTxn | null> {
  const m = /^raw:(\d+)$/.exec(sourceTxnId);
  if (!m) return null;
  const rawId = Number(m[1]);
  const rows = await sql<
    {
      amount_cents: string;
      posted_date: string | null;
      description_raw: string | null;
      merchant_name: string | null;
      ledger_code: string | null;
    }[]
  >`
    SELECT r.amount_cents, r.posted_date, r.description_raw, r.merchant_name,
           sa.ledger_account_code AS ledger_code
    FROM acct_transactions_raw r JOIN acct_source_accounts sa ON sa.id = r.source_account_id
    WHERE r.id = ${rawId} AND r.tenant_id = ${tenantId}`;
  if (rows.length === 0) return null;
  const t = rows[0]!;
  const amt = Number(t.amount_cents);
  return {
    rawId,
    amountCents: amt,
    postedDate: t.posted_date,
    merchant: t.merchant_name ?? t.description_raw ?? "",
    memo: t.description_raw ?? "",
    isOutflow: amt < 0,
    ledgerCode: t.ledger_code,
  };
}

async function recordDecision(
  sql: Sql,
  tenantId: string,
  d: AuditorDecision,
  basisProject: string | null,
  businessPct: number | null,
  councilRef: string | null,
): Promise<void> {
  await sql`
    INSERT INTO acct_auditor_decisions
      (tenant_id, source_txn_id, verdict, account_code, project_slug, business_pct,
       confidence, basis, rationale, council_ref, access_request_id)
    VALUES (${tenantId}, ${d.sourceTxnId}, ${d.verdict}, ${d.accountCode}, ${basisProject},
            ${businessPct}, ${d.confidence}, ${d.basis}, ${d.rationale}, ${councilRef},
            ${d.accessRequestId ?? null})`;
}

/**
 * Audit ONE ambiguous transaction. Convenes the council, applies the deterministic
 * human-gates, then posts / defers / escalates / quarantines and records the trail.
 */
export async function auditOne(
  sql: Sql,
  tenantId: string,
  sourceTxnId: string,
  council: CouncilEscalator,
  config: AuditorConfig,
): Promise<AuditorDecision> {
  const txn = await loadRawTxn(sql, tenantId, sourceTxnId);
  if (!txn) {
    const d: AuditorDecision = {
      sourceTxnId,
      verdict: "quarantined",
      basis: "human",
      accountCode: null,
      confidence: 0,
      rationale: "transaction not found",
    };
    return d;
  }

  const input: CategorizationInput = {
    sourceTxnId,
    merchant: txn.merchant,
    amountCents: txn.amountCents,
    memo: txn.memo,
    postedDate: txn.postedDate,
    isOutflow: txn.isOutflow,
  };

  const [chart, projects] = await Promise.all([
    sql<{ code: string; name: string; type: string }[]>`
      SELECT code, name, type FROM acct_chart WHERE is_active ORDER BY code`,
    sql<{ slug: string; name: string }[]>`
      SELECT slug, name FROM acct_projects WHERE status = 'active' ORDER BY slug`,
  ]);
  const validCodes = new Set(chart.map((c) => c.code));

  let verdict: CouncilVerdict;
  try {
    verdict = await council.deliberate(input, {
      chart: chart.map((c) => ({ code: c.code, name: c.name, type: c.type as AccountType })),
      projects: projects.map((p) => ({ slug: p.slug, name: p.name })),
    });
  } catch (e) {
    // Council failure must never crash a batch — leave the item for a human.
    const d: AuditorDecision = {
      sourceTxnId,
      verdict: "quarantined",
      basis: "council",
      accountCode: null,
      confidence: 0,
      rationale: `council failed: ${e instanceof Error ? e.message : String(e)}`,
    };
    await recordDecision(sql, tenantId, d, null, null, null);
    await logAudit(sql, tenantId, "auditor", "council_failed", sourceTxnId, { error: d.rationale });
    return d;
  }

  // 1) Hard human-gate from the council → escalate, never auto-act.
  if (verdict.humanGate) {
    const d: AuditorDecision = {
      sourceTxnId,
      verdict: "escalated",
      basis: "council",
      accountCode: verdict.accountCode ?? null,
      confidence: verdict.confidence,
      rationale: `human-gate: ${verdict.humanGate}`,
    };
    await recordDecision(sql, tenantId, d, verdict.projectSlug ?? null, verdict.businessPct ?? null, verdict.rationale);
    await logAudit(sql, tenantId, "auditor", "escalate_human_gate", sourceTxnId, { gate: verdict.humanGate });
    return d;
  }

  // 2) Council needs data → file a human-grantable access-request and defer.
  if (verdict.needsAccess) {
    const req = await requestAccess(
      sql,
      tenantId,
      {
        resource: verdict.needsAccess.resource,
        reason: verdict.needsAccess.reason,
        howToGrant: verdict.needsAccess.howToGrant,
        requestedForTxn: sourceTxnId,
      },
      "research",
    );
    const d: AuditorDecision = {
      sourceTxnId,
      verdict: "deferred_access",
      basis: "research",
      accountCode: null,
      confidence: verdict.confidence,
      rationale: verdict.needsAccess.reason,
      accessRequestId: req.id,
    };
    await recordDecision(sql, tenantId, d, null, null, verdict.rationale);
    await logAudit(sql, tenantId, "auditor", "defer_access", sourceTxnId, {
      resource: verdict.needsAccess.resource,
      accessRequestId: req.id,
    });
    return d;
  }

  // 3) Deterministic guards: a sensitive account or a large charge always needs a human.
  const sensitive = config.sensitiveAccountCodes ?? DEFAULT_SENSITIVE;
  const gateAmount = config.humanGateAmountCents ?? 0;
  const chosen = verdict.accountCode ?? null;
  const tooSensitive = chosen !== null && sensitive.has(chosen);
  const tooLarge = gateAmount > 0 && Math.abs(txn.amountCents) >= gateAmount;

  const canPost =
    verdict.resolved &&
    chosen !== null &&
    validCodes.has(chosen) &&
    verdict.confidence >= config.confidenceThreshold &&
    !tooSensitive &&
    !tooLarge;

  if (!canPost) {
    const reason = !verdict.resolved
      ? "council unresolved"
      : chosen === null || !validCodes.has(chosen)
        ? "no valid account from council"
        : tooSensitive
          ? `sensitive account ${chosen} requires a human`
          : tooLarge
            ? "large charge requires a human"
            : "below confidence threshold";
    const escalated = tooSensitive || tooLarge;
    const d: AuditorDecision = {
      sourceTxnId,
      verdict: escalated ? "escalated" : "quarantined",
      basis: "council",
      accountCode: chosen,
      confidence: verdict.confidence,
      rationale: reason,
    };
    await recordDecision(sql, tenantId, d, verdict.projectSlug ?? null, verdict.businessPct ?? null, verdict.rationale);
    await logAudit(sql, tenantId, "auditor", escalated ? "escalate_guard" : "leave_quarantined", sourceTxnId, { reason });
    return d;
  }

  // 4) Confident, safe → POST it (as 'llm' provenance in the ledger; finer basis recorded here).
  const businessPct = clampPct(verdict.businessPct ?? 100);
  const posted = await applyManualCategorization(
    sql,
    tenantId,
    sourceTxnId,
    chosen!,
    businessPct,
    true,
    "llm",
  );
  const basis: AuditorBasis = "council";
  const d: AuditorDecision = {
    sourceTxnId,
    verdict: posted.alreadyPosted ? "overridden" : "auto_posted",
    basis,
    accountCode: chosen,
    confidence: verdict.confidence,
    rationale: verdict.rationale,
  };
  await recordDecision(sql, tenantId, d, verdict.projectSlug ?? null, businessPct, verdict.rationale);
  await logAudit(sql, tenantId, "auditor", "auto_post", sourceTxnId, {
    accountCode: chosen,
    businessPct,
    confidence: verdict.confidence,
  });
  log("auditor: auto-posted", sourceTxnId, "->", chosen, `(conf ${verdict.confidence})`);
  return d;
}

export interface AuditBatchResult {
  processed: number;
  autoPosted: number;
  escalated: number;
  deferred: number;
  quarantined: number;
  decisions: AuditorDecision[];
}

/**
 * Audit the whole open review queue (the close's quarantined items). Processes each
 * item independently; one failure never aborts the batch. Returns a tallied summary.
 */
export async function auditReviewQueue(
  sql: Sql,
  tenantId: string,
  council: CouncilEscalator,
  config: AuditorConfig,
  limit = 200,
): Promise<AuditBatchResult> {
  const items = await sql<{ source_txn_id: string }[]>`
    SELECT rq.source_txn_id
    FROM acct_review_queue rq
    WHERE rq.status = 'open' AND rq.source_txn_id LIKE 'raw:%'
      AND EXISTS (
        SELECT 1 FROM acct_transactions_raw r
        WHERE ('raw:' || r.id) = rq.source_txn_id AND r.tenant_id = ${tenantId})
    ORDER BY rq.created_at
    LIMIT ${limit}`;

  const result: AuditBatchResult = {
    processed: 0,
    autoPosted: 0,
    escalated: 0,
    deferred: 0,
    quarantined: 0,
    decisions: [],
  };
  for (const it of items) {
    const d = await auditOne(sql, tenantId, it.source_txn_id, council, config);
    result.processed += 1;
    result.decisions.push(d);
    if (d.verdict === "auto_posted" || d.verdict === "overridden") result.autoPosted += 1;
    else if (d.verdict === "escalated") result.escalated += 1;
    else if (d.verdict === "deferred_access") result.deferred += 1;
    else result.quarantined += 1;
  }
  return result;
}

function clampPct(p: number): number {
  if (!Number.isFinite(p)) return 100;
  return Math.max(0, Math.min(100, Math.round(p)));
}
