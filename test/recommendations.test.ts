/**
 * Advisory-engine persistence tests. Proves the engine turns grounded analytics +
 * budget overruns into de-duplicated acct_recommendations, records an advisor_run,
 * and refreshes (not duplicates) on a second pass. DB-backed; skips if no DB.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { openSql, type Sql } from "../src/core/db.js";
import { loadEnv } from "../src/lib/env.js";
import { postEntry } from "../src/core/ledger.js";
import { generateRecommendations } from "../src/core/recommendations.js";

const env = loadEnv(join(process.cwd(), ".env"));
const url = env.ACCT_DB_URL ?? "postgresql://postgres:local-dev-password@localhost:5433/accounting";
const TENANT = "test_reco";
const PERIOD = "2026-04";
const AS_OF = "2026-04-20";

let sql: Sql;
let dbUp = false;

async function clean(): Promise<void> {
  await sql`DELETE FROM acct_recommendations WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_advisor_runs WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_budget_actuals WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_budgets WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_journal_entries WHERE tenant_id = ${TENANT}`;
}

async function seed(): Promise<void> {
  // An over-budget category: $150 spent against a $100 software budget.
  await sql`INSERT INTO acct_budgets (tenant_id, name, period_kind, scope, account_code, limit_cents, method)
            VALUES (${TENANT}, 'Software', 'month', 'category', '6160', 10000, 'envelope')`;
  await postEntry(sql, TENANT, {
    entryDate: "2026-04-05",
    description: "software overspend",
    source: "manual",
    idempotencyKey: `${TENANT}:soft1`,
    lines: [
      { accountCode: "6160", debitCents: 15000, creditCents: 0 },
      { accountCode: "2010", debitCents: 0, creditCents: 15000 },
    ],
  });
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

test("generateRecommendations produces grounded, de-duplicated recommendations", async (t) => {
  if (!dbUp) return t.skip("no database");
  // Net profit positive -> a tax set-aside reco; over-budget -> a savings reco.
  const r1 = await generateRecommendations(sql, TENANT, PERIOD, 500_000, AS_OF);
  assert.ok(r1.generated >= 2, "at least the over-budget + tax set-aside recos");

  const kinds = await sql<{ kind: string }[]>`
    SELECT kind FROM acct_recommendations WHERE tenant_id = ${TENANT}`;
  const kindSet = new Set(kinds.map((k) => k.kind));
  assert.ok(kindSet.has("savings"), "over-budget savings reco present");
  assert.ok(kindSet.has("tax"), "tax set-aside reco present");

  // The over-budget reco is grounded with real numbers.
  const savings = await sql<{ rationale_json: { spentCents: number; limitCents: number } }[]>`
    SELECT rationale_json FROM acct_recommendations WHERE tenant_id = ${TENANT} AND kind = 'savings' LIMIT 1`;
  assert.equal(savings[0]!.rationale_json.spentCents, 15000);
  assert.equal(savings[0]!.rationale_json.limitCents, 10000);

  // Re-run refreshes rather than duplicating (dedupe key).
  const before = Number(
    (await sql<{ n: string }[]>`SELECT count(*) n FROM acct_recommendations WHERE tenant_id = ${TENANT}`)[0]!.n,
  );
  await generateRecommendations(sql, TENANT, PERIOD, 500_000, AS_OF);
  const after = Number(
    (await sql<{ n: string }[]>`SELECT count(*) n FROM acct_recommendations WHERE tenant_id = ${TENANT}`)[0]!.n,
  );
  assert.equal(before, after, "no duplicate recommendations on re-run");

  // Two advisor runs recorded.
  const runs = Number(
    (await sql<{ n: string }[]>`SELECT count(*) n FROM acct_advisor_runs WHERE tenant_id = ${TENANT}`)[0]!.n,
  );
  assert.equal(runs, 2);
});
