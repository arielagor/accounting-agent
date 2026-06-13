/**
 * The double-entry ledger. Posting is idempotent (re-posting the same
 * idempotencyKey is a no-op) and transactional (entry + all lines in one tx, so
 * the DEFERRED balanced-entry trigger validates at COMMIT). Money is integer cents.
 */
import { createHash } from "node:crypto";
import type { Sql } from "./db.js";
import type {
  NewJournalEntry,
  PostedEntry,
  TrialBalance,
  TrialBalanceRow,
  Cents,
} from "./types.js";
import { sumCents } from "./money.js";

/** First and last calendar day of a "YYYY-MM" period. */
export function periodBounds(period: string): { start: string; end: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) throw new Error(`bad period: ${period} (want YYYY-MM)`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`bad month in period: ${period}`);
  const start = `${m[1]}-${m[2]}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const end = `${m[1]}-${m[2]}-${String(lastDay).padStart(2, "0")}`;
  return { start, end };
}

/** Validate a NewJournalEntry balances in JS (clear error before the DB trigger). */
export function assertBalanced(entry: NewJournalEntry): void {
  const debits = sumCents(entry.lines.map((l) => l.debitCents));
  const credits = sumCents(entry.lines.map((l) => l.creditCents));
  if (debits !== credits) {
    throw new Error(
      `entry "${entry.idempotencyKey}" unbalanced: debits=${debits} credits=${credits}`,
    );
  }
  if (entry.lines.length < 2) {
    throw new Error(`entry "${entry.idempotencyKey}" needs at least 2 lines`);
  }
}

async function accountIdByCode(sql: Sql, code: string): Promise<number> {
  const rows = await sql<{ id: number }[]>`SELECT id FROM acct_chart WHERE code = ${code}`;
  if (rows.length === 0) throw new Error(`unknown account code: ${code}`);
  return rows[0]!.id;
}

async function projectIdBySlug(sql: Sql, slug: string | null | undefined): Promise<number | null> {
  if (!slug) return null;
  const rows = await sql<{ id: number }[]>`SELECT id FROM acct_projects WHERE slug = ${slug}`;
  if (rows.length === 0) throw new Error(`unknown project slug: ${slug}`);
  return rows[0]!.id;
}

/**
 * Post an entry. Idempotent by (tenantId, idempotencyKey): if it already exists,
 * returns alreadyExisted=true and posts nothing. Otherwise inserts the entry and
 * all lines in one transaction.
 */
export async function postEntry(
  sql: Sql,
  tenantId: string,
  entry: NewJournalEntry,
): Promise<PostedEntry> {
  assertBalanced(entry);

  const existing = await sql<{ id: number }[]>`
    SELECT id FROM acct_journal_entries
    WHERE tenant_id = ${tenantId} AND idempotency_key = ${entry.idempotencyKey}
  `;
  if (existing.length > 0) {
    return { id: existing[0]!.id, idempotencyKey: entry.idempotencyKey, alreadyExisted: true };
  }

  // Resolve codes/slugs to ids up front (clear errors outside the tx).
  const resolved = await Promise.all(
    entry.lines.map(async (l) => ({
      accountId: await accountIdByCode(sql, l.accountCode),
      projectId: await projectIdBySlug(sql, l.projectSlug),
      line: l,
    })),
  );

  const id = await sql.begin(async (tx) => {
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO acct_journal_entries
        (tenant_id, entry_date, description, source, source_txn_id, idempotency_key, status, is_allocation, created_by)
      VALUES (
        ${tenantId}, ${entry.entryDate}, ${entry.description ?? null}, ${entry.source},
        ${entry.sourceTxnId ?? null}, ${entry.idempotencyKey},
        ${entry.status ?? "posted"}, ${entry.isAllocation ?? false}, ${entry.createdBy ?? "engine"}
      )
      RETURNING id
    `;
    const entryId = row!.id;
    for (const r of resolved) {
      await tx`
        INSERT INTO acct_journal_lines
          (entry_id, account_id, project_id, debit_cents, credit_cents, business_pct, memo)
        VALUES (
          ${entryId}, ${r.accountId}, ${r.projectId},
          ${r.line.debitCents}, ${r.line.creditCents},
          ${r.line.businessPct ?? 100}, ${r.line.memo ?? null}
        )
      `;
    }
    return entryId;
  });

  return { id, idempotencyKey: entry.idempotencyKey, alreadyExisted: false };
}

/**
 * Trial balance for a period (activity of entries dated within the month). Because
 * every posted entry balances, the period activity balances by construction — the
 * `balanced` flag is the integrity check. Excludes void/draft entries.
 */
export async function getTrialBalance(
  sql: Sql,
  tenantId: string,
  period: string,
): Promise<TrialBalance> {
  const { start, end } = periodBounds(period);
  const rows = await sql<
    { account_code: string; account_name: string; debit_cents: string; credit_cents: string }[]
  >`
    SELECT c.code AS account_code, c.name AS account_name,
           COALESCE(SUM(l.debit_cents), 0)  AS debit_cents,
           COALESCE(SUM(l.credit_cents), 0) AS credit_cents
    FROM acct_journal_lines l
    JOIN acct_journal_entries e ON e.id = l.entry_id
    JOIN acct_chart c ON c.id = l.account_id
    WHERE e.tenant_id = ${tenantId}
      AND e.status = 'posted'
      AND e.entry_date BETWEEN ${start} AND ${end}
    GROUP BY c.code, c.name
    HAVING COALESCE(SUM(l.debit_cents),0) <> 0 OR COALESCE(SUM(l.credit_cents),0) <> 0
    ORDER BY c.code
  `;

  const tbRows: TrialBalanceRow[] = rows.map((r) => ({
    accountCode: r.account_code,
    accountName: r.account_name,
    debitCents: Number(r.debit_cents),
    creditCents: Number(r.credit_cents),
  }));

  const debitsCents = sumCents(tbRows.map((r) => r.debitCents));
  const creditsCents = sumCents(tbRows.map((r) => r.creditCents));
  const balanced = debitsCents === creditsCents;
  const snapshotHash = hashTrialBalance(period, tbRows, debitsCents, creditsCents);

  return { period, balanced, debitsCents, creditsCents, rows: tbRows, snapshotHash };
}

function hashTrialBalance(
  period: string,
  rows: TrialBalanceRow[],
  debits: Cents,
  credits: Cents,
): string {
  const canonical = JSON.stringify({
    period,
    debits,
    credits,
    rows: rows
      .map((r) => [r.accountCode, r.debitCents, r.creditCents])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Refresh acct_balances for a period from posted activity, per (account, project).
 * Idempotent: deletes the period's rows and re-inserts.
 */
export async function rebuildBalances(
  sql: Sql,
  tenantId: string,
  period: string,
): Promise<void> {
  const { start, end } = periodBounds(period);
  const m = /^(\d{4})-(\d{2})$/.exec(period)!;
  const fy = Number(m[1]);
  const fm = Number(m[2]);
  await sql.begin(async (tx) => {
    await tx`DELETE FROM acct_balances WHERE fiscal_year = ${fy} AND fiscal_month = ${fm}`;
    await tx`
      INSERT INTO acct_balances (account_id, project_id, fiscal_year, fiscal_month, balance_cents)
      SELECT l.account_id, l.project_id, ${fy}, ${fm},
             COALESCE(SUM(l.debit_cents - l.credit_cents), 0)
      FROM acct_journal_lines l
      JOIN acct_journal_entries e ON e.id = l.entry_id
      WHERE e.tenant_id = ${tenantId}
        AND e.status = 'posted'
        AND e.entry_date BETWEEN ${start} AND ${end}
      GROUP BY l.account_id, l.project_id
    `;
  });
}
