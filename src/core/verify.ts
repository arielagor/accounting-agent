/**
 * The close VERDICT, computed by RE-QUERYING Postgres for ground truth — never by
 * trusting the orchestrator's in-memory state or an exit code. This is the
 * verify-before-claiming-success gate: a close is reported CLEAN only if the
 * trial balance balances and EVERY transaction in the period reached a terminal
 * disposition (posted-with-confidence OR quarantined-for-review).
 *
 * Disposition convention (used everywhere): a raw transaction's journal/review
 * linkage is keyed by sourceTxnId = `raw:<acct_transactions_raw.id>`.
 */
import type { Sql } from "./db.js";
import type { CloseVerdict, CloseVerdictStatus } from "./types.js";
import { getTrialBalance, periodBounds } from "./ledger.js";

export async function computeVerdict(
  sql: Sql,
  tenantId: string,
  period: string,
): Promise<CloseVerdict> {
  const tb = await getTrialBalance(sql, tenantId, period);
  const { start, end } = periodBounds(period);

  const postedRows = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM acct_journal_entries
    WHERE tenant_id = ${tenantId} AND status = 'posted'
      AND entry_date BETWEEN ${start} AND ${end}`;
  const postedCount = Number(postedRows[0]!.n);

  const qRows = await sql<{ n: string; v: string }[]>`
    SELECT count(*) AS n, COALESCE(SUM(ABS(r.amount_cents)), 0) AS v
    FROM acct_review_queue rq
    JOIN acct_transactions_raw r ON ('raw:' || r.id) = rq.source_txn_id
    WHERE rq.status = 'open'
      AND r.tenant_id = ${tenantId}
      AND r.posted_date BETWEEN ${start} AND ${end}`;
  const quarantineCount = Number(qRows[0]!.n);
  const quarantineValueCents = Number(qRows[0]!.v);

  // Undisposed = a raw txn in the period that is neither posted, nor quarantined,
  // nor a leg of a reconciled transfer (transfers post one entry for the pair).
  const uRows = await sql<{ n: string }[]>`
    SELECT count(*) AS n
    FROM acct_transactions_raw r
    WHERE r.tenant_id = ${tenantId}
      AND r.superseded_at IS NULL
      AND r.pending = false
      AND r.posted_date BETWEEN ${start} AND ${end}
      AND NOT EXISTS (
        SELECT 1 FROM acct_journal_entries e
        WHERE e.tenant_id = ${tenantId} AND e.source_txn_id = ('raw:' || r.id))
      AND NOT EXISTS (
        SELECT 1 FROM acct_review_queue rq
        WHERE rq.source_txn_id = ('raw:' || r.id) AND rq.status = 'open')
      AND NOT EXISTS (
        SELECT 1 FROM acct_recon rc
        WHERE rc.raw_txn_id = r.id
          AND rc.match_type IN ('card_payment_transfer', 'internal_transfer'))`;
  const undisposed = Number(uRows[0]!.n);

  const warnings: string[] = [];
  let status: CloseVerdictStatus;
  let failureReason: string | undefined;

  if (!tb.balanced) {
    status = "FAILED";
    failureReason = `trial balance unbalanced: debits=${tb.debitsCents} credits=${tb.creditsCents}`;
  } else if (undisposed > 0) {
    status = "FAILED";
    failureReason = `${undisposed} transaction(s) undisposed (neither posted nor quarantined)`;
  } else if (quarantineCount > 0) {
    status = "CLEAN_WITH_EXCEPTIONS";
    warnings.push(`${quarantineCount} transaction(s) quarantined for review`);
  } else {
    status = "CLEAN";
  }

  return {
    period,
    status,
    balanced: tb.balanced,
    debitsCents: tb.debitsCents,
    creditsCents: tb.creditsCents,
    postedCount,
    quarantineCount,
    quarantineValueCents,
    warnings,
    ...(failureReason ? { failureReason } : {}),
  };
}

/** A close is a "success" (clean) iff it balanced and nothing is undisposed. */
export function isSuccessfulClose(v: CloseVerdict): boolean {
  return v.status === "CLEAN" || v.status === "CLEAN_WITH_EXCEPTIONS";
}
