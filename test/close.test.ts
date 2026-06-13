/**
 * Month-end close integration test — the headline proof of "always completes".
 * Runs the full pipeline against the real `accounting` DB with a dedicated tenant.
 * Skips gracefully if no DB is reachable.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { openSql, type Sql } from "../src/core/db.js";
import { loadEnv } from "../src/lib/env.js";
import { runClose } from "../src/core/close.js";
import { computeVerdict } from "../src/core/verify.js";
import { normalizeMerchant } from "../src/core/categorize.js";
import type { CloseConfig, EntityProfile } from "../src/core/types.js";

const env = loadEnv(join(process.cwd(), ".env"));
const url = env.ACCT_DB_URL ?? "postgresql://postgres:local-dev-password@localhost:5433/accounting";
const TENANT = "test_close";
const PERIOD = "2026-04";

const CONFIG: CloseConfig = {
  mode: "live",
  ajeAutoThresholdCents: 25_000,
  largeTxnReviewCents: 100_000,
  confidenceThreshold: 0.85,
  reconToleranceCents: 0,
  reconEscalateDeltaCents: 5_000,
};
const PROFILE: EntityProfile = {
  taxYear: 2026,
  entityType: "sole_prop",
  filingStatus: "single",
  state: "CA",
  homeOfficeSqft: null,
  homeTotalSqft: null,
  reasonableSalaryCents: null,
};

let sql: Sql;
let dbUp = false;

async function clean(): Promise<void> {
  await sql`DELETE FROM acct_journal_entries WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_review_queue WHERE source_txn_id LIKE 'raw:%' AND source_txn_id IN (
    SELECT 'raw:' || id FROM acct_transactions_raw WHERE tenant_id = ${TENANT})`;
  await sql`DELETE FROM acct_recon WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_transactions_raw WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_source_accounts WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_connections WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_close WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_close_run WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_resolution WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_merchant_rules WHERE merchant_key = ${normalizeMerchant("TEST DEPOSIT")}`;
}

async function seedScenario(): Promise<void> {
  const [conn] = await sql<{ id: number }[]>`
    INSERT INTO acct_connections (tenant_id, provider, institution_name, access_token_enc, status)
    VALUES (${TENANT}, 'fixture', 'Test Bank', 'x', 'active') RETURNING id`;
  const [checking] = await sql<{ id: number }[]>`
    INSERT INTO acct_source_accounts (connection_id, tenant_id, provider_account_id, name, type, subtype, ledger_account_code)
    VALUES (${conn!.id}, ${TENANT}, 'chk1', 'Checking', 'depository', 'checking', '1010') RETURNING id`;
  const [card] = await sql<{ id: number }[]>`
    INSERT INTO acct_source_accounts (connection_id, tenant_id, provider_account_id, name, type, subtype, ledger_account_code)
    VALUES (${conn!.id}, ${TENANT}, 'card1', 'Card', 'credit', 'credit card', '2010') RETURNING id`;

  // A learned merchant rule so a deposit categorizes as revenue (tier b).
  await sql`
    INSERT INTO acct_merchant_rules (merchant_key, account_code, project_slug, business_pct)
    VALUES (${normalizeMerchant("TEST DEPOSIT")}, '4010', 'agor_me', 100)
    ON CONFLICT (merchant_key) DO NOTHING`;

  const txns: Array<[number, number, string, string]> = [
    // [source, amountCents(signed), merchant, providerTxnId]
    [card!.id, -1900, "NETLIFY", "t-netlify"],
    [card!.id, -10000, "ANTHROPIC", "t-anthropic"],
    [card!.id, -2500, "APPLE.COM/BILL", "t-apple"], // needs_split -> quarantine
    [checking!.id, 50000, "TEST DEPOSIT", "t-deposit"], // learned rule -> revenue
  ];
  for (const [acctId, amt, merchant, ptid] of txns) {
    await sql`
      INSERT INTO acct_transactions_raw
        (source_account_id, tenant_id, provider, provider_txn_id, dedup_key, amount_cents,
         posted_date, pending, description_raw, merchant_name)
      VALUES (${acctId}, ${TENANT}, 'fixture', ${ptid}, ${ptid}, ${amt},
              '2026-04-15', false, ${merchant}, ${merchant})`;
  }
}

before(async () => {
  sql = openSql(url);
  try {
    await sql`SELECT 1`;
    dbUp = true;
    await clean();
    await seedScenario();
  } catch {
    dbUp = false;
  }
});

after(async () => {
  if (dbUp) await clean();
  await sql.end({ timeout: 5 });
});

test("close completes balanced, auto-posts confident txns, quarantines the ambiguous", async (t) => {
  if (!dbUp) return t.skip("no database");
  const result = await runClose(sql, TENANT, PERIOD, CONFIG, "close", { profile: PROFILE });

  assert.equal(result.verdict.balanced, true, "trial balance must balance");
  assert.equal(result.verdict.debitsCents, result.verdict.creditsCents);
  assert.equal(result.verdict.status, "CLEAN_WITH_EXCEPTIONS", "APPLE.COM/BILL should quarantine");
  assert.ok(result.verdict.quarantineCount >= 1, "at least one quarantined");
  assert.equal(result.locked, true, "live close locks the period");

  // 3 of 4 source txns posted (NETLIFY, ANTHROPIC, TEST DEPOSIT); APPLE quarantined.
  const posted = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM acct_journal_entries
    WHERE tenant_id = ${TENANT} AND status = 'posted' AND is_allocation = false`;
  assert.equal(Number(posted[0]!.n), 3, "3 source transactions posted");

  // Integrity: after allocation, the shared project nets to ZERO on every reallocated
  // account (a shared cost on 6160/6150 must not be double-allocated).
  const sharedNet = await sql<{ net: string }[]>`
    SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS net
    FROM acct_journal_lines l
    JOIN acct_journal_entries e ON e.id = l.entry_id
    JOIN acct_chart c ON c.id = l.account_id
    JOIN acct_projects p ON p.id = l.project_id
    WHERE e.tenant_id = ${TENANT} AND e.status = 'posted'
      AND p.slug = 'shared' AND c.code IN ('6160','6150')`;
  assert.equal(Number(sharedNet[0]!.net), 0, "shared nets to zero after allocation");
});

test("re-running a locked period is a no-op (idempotent, no double-post)", async (t) => {
  if (!dbUp) return t.skip("no database");
  const before = Number(
    (await sql<{ n: string }[]>`SELECT count(*) AS n FROM acct_journal_lines l
      JOIN acct_journal_entries e ON e.id = l.entry_id WHERE e.tenant_id = ${TENANT}`)[0]!.n,
  );
  const result = await runClose(sql, TENANT, PERIOD, CONFIG, "close", { profile: PROFILE });
  assert.equal(result.noop, true);
  assert.equal(result.locked, true);
  const after = Number(
    (await sql<{ n: string }[]>`SELECT count(*) AS n FROM acct_journal_lines l
      JOIN acct_journal_entries e ON e.id = l.entry_id WHERE e.tenant_id = ${TENANT}`)[0]!.n,
  );
  assert.equal(before, after, "no lines added on re-run");
});

test("verify flags an undisposed transaction as FAILED (undisposed detection)", async (t) => {
  if (!dbUp) return t.skip("no database");
  // Insert a brand-new in-period txn that the (locked) close has not processed.
  const [acct] = await sql<{ id: number }[]>`
    SELECT id FROM acct_source_accounts WHERE tenant_id = ${TENANT} LIMIT 1`;
  await sql`
    INSERT INTO acct_transactions_raw
      (source_account_id, tenant_id, provider, provider_txn_id, dedup_key, amount_cents, posted_date, pending, description_raw, merchant_name)
    VALUES (${acct!.id}, ${TENANT}, 'fixture', 't-late', 't-late', -777, '2026-04-20', false, 'LATE UNPROCESSED', 'LATE')`;
  const verdict = await computeVerdict(sql, TENANT, PERIOD);
  assert.equal(verdict.status, "FAILED");
  assert.match(verdict.failureReason ?? "", /undisposed/);
});
