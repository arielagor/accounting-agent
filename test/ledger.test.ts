/**
 * Ledger integration test — runs against the real `accounting` Postgres using a
 * dedicated tenant_id ('test') that is cleaned before and after. Skips gracefully
 * if no database is reachable so the pure unit tests still run anywhere.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openSql, type Sql } from "../src/core/db.js";
import { loadEnv } from "../src/lib/env.js";
import { postEntry, getTrialBalance, assertBalanced } from "../src/core/ledger.js";
import { buildExpenseEntry, buildStripePayoutEntry } from "../src/core/posting.js";
import { join } from "node:path";

const env = loadEnv(join(process.cwd(), ".env"));
const url = env.ACCT_DB_URL ?? "postgresql://postgres:local-dev-password@localhost:5433/accounting";
const TENANT = "test";

let sql: Sql;
let dbUp = false;

async function clean(): Promise<void> {
  await sql`DELETE FROM acct_journal_entries WHERE tenant_id = ${TENANT}`;
}

before(async () => {
  sql = openSql(url);
  try {
    await sql`SELECT 1`;
    dbUp = true;
    await clean();
  } catch {
    dbUp = false;
  }
});

after(async () => {
  if (dbUp) await clean();
  await sql.end({ timeout: 5 });
});

test("assertBalanced throws on an unbalanced entry", () => {
  assert.throws(() =>
    assertBalanced({
      entryDate: "2026-05-01",
      description: "bad",
      source: "manual",
      idempotencyKey: "x",
      lines: [
        { accountCode: "6160", debitCents: 100, creditCents: 0 },
        { accountCode: "2010", debitCents: 0, creditCents: 99 },
      ],
    }),
  );
});

test("postEntry posts a balanced expense and is idempotent", async (t) => {
  if (!dbUp) return t.skip("no database");
  const entry = buildExpenseEntry({
    entryDate: "2026-05-15",
    idempotencyKey: "test-exp-1",
    amountCents: 1999,
    expenseAccountCode: "6160",
    paidFromAccountCode: "2010",
    projectSlug: "shared",
  });
  const first = await postEntry(sql, TENANT, entry);
  assert.equal(first.alreadyExisted, false);
  const second = await postEntry(sql, TENANT, entry);
  assert.equal(second.alreadyExisted, true);
  assert.equal(first.id, second.id);

  const count = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM acct_journal_entries
    WHERE tenant_id = ${TENANT} AND idempotency_key = 'test-exp-1'`;
  assert.equal(Number(count[0]!.n), 1); // not doubled
});

test("trial balance balances after posting", async (t) => {
  if (!dbUp) return t.skip("no database");
  await postEntry(
    sql,
    TENANT,
    buildStripePayoutEntry({
      entryDate: "2026-05-20",
      idempotencyKey: "test-payout-1",
      grossCents: 29900,
      feeCents: 897,
      depositedToAccountCode: "1010",
      revenueAccountCode: "4035",
      projectSlug: "ai_visibility",
    }),
  );
  const tb = await getTrialBalance(sql, TENANT, "2026-05");
  assert.equal(tb.balanced, true);
  assert.equal(tb.debitsCents, tb.creditsCents);
  assert.ok(tb.snapshotHash.length === 64);
});

test("the DB trigger rejects a forced-unbalanced posting", async (t) => {
  if (!dbUp) return t.skip("no database");
  await assert.rejects(async () => {
    await sql.begin(async (tx) => {
      const [e] = await tx<{ id: number }[]>`
        INSERT INTO acct_journal_entries (tenant_id, entry_date, source, idempotency_key)
        VALUES (${TENANT}, '2026-05-01', 'manual', 'test-forced-unbal') RETURNING id`;
      const cid = (await tx<{ id: number }[]>`SELECT id FROM acct_chart WHERE code='1010'`)[0]!.id;
      const did = (await tx<{ id: number }[]>`SELECT id FROM acct_chart WHERE code='3000'`)[0]!.id;
      await tx`INSERT INTO acct_journal_lines (entry_id, account_id, debit_cents, credit_cents) VALUES (${e!.id}, ${cid}, 1000, 0)`;
      await tx`INSERT INTO acct_journal_lines (entry_id, account_id, debit_cents, credit_cents) VALUES (${e!.id}, ${did}, 0, 999)`;
    });
  });
});
