/**
 * Apply a manual categorization (from the dashboard or an email reply verb): post
 * the transaction to the chosen account, resolve its quarantine, and LEARN the
 * merchant so the same vendor auto-posts next time. Shared by the dashboard's
 * /api/resolve endpoint and the close's resolution consumer, so a human decision
 * always (a) lands in the ledger and (b) compounds into the rule set.
 */
import type { Sql } from "./db.js";
import { postEntry } from "./ledger.js";
import { buildExpenseEntry, buildRevenueEntry } from "./posting.js";
import { normalizeMerchant } from "./categorize.js";

export interface ManualResult {
  posted: boolean;
  alreadyPosted: boolean;
  reason?: string;
}

/**
 * Categorize one quarantined raw transaction to `accountCode` (optionally a
 * business-use percentage). Idempotent: if the txn is already posted, just resolves
 * the review row. `learn` (default true) upserts a merchant rule for future runs.
 */
export async function applyManualCategorization(
  sql: Sql,
  tenantId: string,
  sourceTxnId: string,
  accountCode: string,
  businessPct = 100,
  learn = true,
): Promise<ManualResult> {
  const m = /^raw:(\d+)$/.exec(sourceTxnId);
  if (!m) return { posted: false, alreadyPosted: false, reason: "bad source txn id" };
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
    FROM acct_transactions_raw r
    JOIN acct_source_accounts sa ON sa.id = r.source_account_id
    WHERE r.id = ${rawId} AND r.tenant_id = ${tenantId}`;
  if (rows.length === 0) return { posted: false, alreadyPosted: false, reason: "txn not found" };
  const t = rows[0]!;
  if (!t.ledger_code) return { posted: false, alreadyPosted: false, reason: "source account unmapped" };

  const acct = await sql<{ type: string }[]>`SELECT type FROM acct_chart WHERE code = ${accountCode}`;
  if (acct.length === 0) return { posted: false, alreadyPosted: false, reason: `unknown account ${accountCode}` };

  // Already posted? Just clear the quarantine.
  const existing = await sql<{ id: number }[]>`
    SELECT id FROM acct_journal_entries
    WHERE tenant_id = ${tenantId} AND source_txn_id = ${sourceTxnId} AND status <> 'void'`;
  if (existing.length > 0) {
    await resolveReview(sql, sourceTxnId);
    return { posted: false, alreadyPosted: true };
  }

  const amount = Math.abs(Number(t.amount_cents));
  const date = t.posted_date ?? new Date().toISOString().slice(0, 10);
  const memo = t.description_raw ?? t.merchant_name ?? "";

  const entry =
    acct[0]!.type === "revenue"
      ? buildRevenueEntry({
          entryDate: date,
          idempotencyKey: sourceTxnId,
          sourceTxnId,
          amountCents: amount,
          revenueAccountCode: accountCode,
          depositedToAccountCode: t.ledger_code,
          memo,
        })
      : buildExpenseEntry({
          entryDate: date,
          idempotencyKey: sourceTxnId,
          sourceTxnId,
          amountCents: amount,
          expenseAccountCode: accountCode,
          paidFromAccountCode: t.ledger_code,
          businessPct,
          memo,
        });
  entry.createdBy = "human";
  await postEntry(sql, tenantId, entry);
  await resolveReview(sql, sourceTxnId);

  if (learn && t.merchant_name) {
    const key = normalizeMerchant(t.merchant_name);
    await sql`
      INSERT INTO acct_merchant_rules (merchant_key, account_code, business_pct, learned_from)
      VALUES (${key}, ${accountCode}, ${businessPct}, 'human')
      ON CONFLICT (merchant_key) DO UPDATE SET
        account_code = EXCLUDED.account_code, business_pct = EXCLUDED.business_pct,
        learned_from = 'human', last_confirmed_at = now(), times_seen = acct_merchant_rules.times_seen + 1`;
  }

  return { posted: true, alreadyPosted: false };
}

async function resolveReview(sql: Sql, sourceTxnId: string): Promise<void> {
  await sql`UPDATE acct_review_queue SET status = 'resolved', resolved_at = now() WHERE source_txn_id = ${sourceTxnId} AND status = 'open'`;
}
