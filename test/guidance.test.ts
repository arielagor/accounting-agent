/**
 * Realtime guidance tests. Pure decision cases run anywhere; the DB-backed case
 * proves the lookup resolves the most specific budget and grounds the impact in the
 * materialized actual. Skips if no DB.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { openSql, type Sql } from "../src/core/db.js";
import { loadEnv } from "../src/lib/env.js";
import { postEntry } from "../src/core/ledger.js";
import { refreshActuals } from "../src/core/budgets.js";
import { guidanceFor, guideTransaction } from "../src/core/guidance.js";

// ─── Pure ──────────────────────────────────────────────────────────────────────
test("guidanceFor returns ok when well under budget", () => {
  const g = guidanceFor(1000, 2000, 10000, "Software");
  assert.equal(g.decision, "ok");
});

test("guidanceFor returns caution when the charge crosses 80%", () => {
  const g = guidanceFor(1000, 7500, 10000, "Software");
  assert.equal(g.decision, "caution");
});

test("guidanceFor returns over_budget when the charge exceeds the limit", () => {
  const g = guidanceFor(3000, 8000, 10000, "Software");
  assert.equal(g.decision, "over_budget");
  assert.equal(g.remainingAfterCents, -1000);
});

test("guidanceFor returns no_budget when there is no limit", () => {
  const g = guidanceFor(3000, 0, 0, "Uncapped");
  assert.equal(g.decision, "no_budget");
  assert.equal(g.after, null);
});

// ─── DB-backed ─────────────────────────────────────────────────────────────────
const env = loadEnv(join(process.cwd(), ".env"));
const url = env.ACCT_DB_URL ?? "postgresql://postgres:local-dev-password@localhost:5433/accounting";
const TENANT = "test_guidance";
const AS_OF = "2026-04-20";

let sql: Sql;
let dbUp = false;

async function clean(): Promise<void> {
  await sql`DELETE FROM acct_budget_actuals WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_budgets WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_journal_entries WHERE tenant_id = ${TENANT}`;
}

async function seed(): Promise<void> {
  await sql`INSERT INTO acct_budgets (tenant_id, name, period_kind, scope, account_code, limit_cents, method)
            VALUES (${TENANT}, 'Software', 'month', 'category', '6160', 10000, 'envelope')`;
  await postEntry(sql, TENANT, {
    entryDate: "2026-04-05",
    description: "software spend",
    source: "manual",
    idempotencyKey: `${TENANT}:soft1`,
    lines: [
      { accountCode: "6160", debitCents: 7000, creditCents: 0 },
      { accountCode: "2010", debitCents: 0, creditCents: 7000 },
    ],
  });
  await refreshActuals(sql, TENANT, AS_OF);
}

before(async () => {
  sql = openSql(url);
  try {
    await sql`SELECT 1`;
    dbUp = true;
    await clean();
    await seed();
  } catch {
    dbUp = false;
  }
});

after(async () => {
  if (dbUp) await clean();
  await sql.end({ timeout: 5 });
});

test("guideTransaction grounds the impact in the current budget actual", async (t) => {
  if (!dbUp) return t.skip("no database");
  // $70 already spent of a $100 software budget; a $40 charge would put it over.
  const g = await guideTransaction(sql, TENANT, { amountCents: -4000, accountCode: "6160", asOfISO: AS_OF });
  assert.equal(g.decision, "over_budget");
  assert.equal(g.remainingAfterCents, -1000);

  // A $10 charge keeps it at 80% (caution).
  const g2 = await guideTransaction(sql, TENANT, { amountCents: -1000, accountCode: "6160", asOfISO: AS_OF });
  assert.equal(g2.decision, "caution");
});

test("guideTransaction reports no_budget for an uncovered charge", async (t) => {
  if (!dbUp) return t.skip("no database");
  const g = await guideTransaction(sql, TENANT, { amountCents: -5000, accountCode: "6900", asOfISO: AS_OF });
  assert.equal(g.decision, "no_budget");
});
