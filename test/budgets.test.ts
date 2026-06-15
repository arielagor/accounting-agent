/**
 * Budget tests. Pure period math + status classification run anywhere; the actuals
 * refresh + alert-fire cases run against the real `accounting` DB on a dedicated
 * tenant and skip if no DB. Headline: an alert fires once when spend crosses the
 * threshold and does NOT re-fire the same period.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { openSql, type Sql } from "../src/core/db.js";
import { loadEnv } from "../src/lib/env.js";
import { postEntry } from "../src/core/ledger.js";
import {
  periodKeyFor,
  periodDateBounds,
  periodProgress,
  projectSpend,
  evaluateBudgetLine,
  refreshActuals,
  checkAlerts,
} from "../src/core/budgets.js";

// ─── Pure ────────────────────────────────────────────────────────────────────
test("periodKeyFor maps a date to month/quarter/year keys", () => {
  assert.equal(periodKeyFor("month", "2026-04-20"), "2026-04");
  assert.equal(periodKeyFor("quarter", "2026-04-20"), "2026-Q2");
  assert.equal(periodKeyFor("quarter", "2026-01-15"), "2026-Q1");
  assert.equal(periodKeyFor("year", "2026-04-20"), "2026");
});

test("periodDateBounds returns inclusive bounds for each kind", () => {
  assert.deepEqual(periodDateBounds("month", "2026-04"), { start: "2026-04-01", end: "2026-04-30" });
  assert.deepEqual(periodDateBounds("month", "2026-02"), { start: "2026-02-01", end: "2026-02-28" });
  assert.deepEqual(periodDateBounds("quarter", "2026-Q2"), { start: "2026-04-01", end: "2026-06-30" });
  assert.deepEqual(periodDateBounds("year", "2026"), { start: "2026-01-01", end: "2026-12-31" });
});

test("periodProgress counts day-of-period and total days", () => {
  const p = periodProgress("month", "2026-04", "2026-04-15");
  assert.equal(p.totalDays, 30);
  assert.equal(p.dayOfPeriod, 15);
});

test("projectSpend run-rates spend to period end", () => {
  // $300 spent by day 15 of a 30-day month projects to $600.
  assert.equal(projectSpend(30000, 15, 30), 60000);
  assert.equal(projectSpend(0, 1, 30), 0);
});

test("evaluateBudgetLine classifies under / warn / over / projected_over", () => {
  assert.equal(evaluateBudgetLine(1000, 10000, 1000).status, "under");
  assert.equal(evaluateBudgetLine(8500, 10000, 8500).status, "warn");
  assert.equal(evaluateBudgetLine(12000, 10000, 12000).status, "over");
  assert.equal(evaluateBudgetLine(5000, 10000, 11000).status, "projected_over");
  assert.equal(evaluateBudgetLine(12000, 10000, 12000).remainingCents, -2000);
});

// ─── DB-backed ─────────────────────────────────────────────────────────────────
const env = loadEnv(join(process.cwd(), ".env"));
const url = env.ACCT_DB_URL ?? "postgresql://postgres:local-dev-password@localhost:5433/accounting";
const TENANT = "test_budgets";
// Month-end as-of so the run-rate projection equals spend-so-far — isolates the
// threshold case (90% of budget = 'warn') from the projected-overrun case.
const AS_OF = "2026-04-30";

let sql: Sql;
let dbUp = false;
let budgetId = 0;

async function clean(): Promise<void> {
  await sql`DELETE FROM acct_budget_alerts WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_budget_actuals WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_budgets WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_journal_entries WHERE tenant_id = ${TENANT}`;
}

async function seed(): Promise<void> {
  const [b] = await sql<{ id: number }[]>`
    INSERT INTO acct_budgets (tenant_id, name, period_kind, scope, account_code, limit_cents, method)
    VALUES (${TENANT}, 'Software', 'month', 'category', '6160', 10000, 'envelope') RETURNING id`;
  budgetId = b!.id;
  await sql`INSERT INTO acct_budget_alerts (budget_id, tenant_id, threshold_pct, channel)
            VALUES (${budgetId}, ${TENANT}, 80, 'push')`;
  // Post $90 of software spend in April (90% of the $100 budget) -> crosses 80%.
  await postEntry(sql, TENANT, {
    entryDate: "2026-04-10",
    description: "software spend",
    source: "manual",
    idempotencyKey: `${TENANT}:soft1`,
    lines: [
      { accountCode: "6160", debitCents: 9000, creditCents: 0 },
      { accountCode: "2010", debitCents: 0, creditCents: 9000 },
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

test("refreshActuals materializes spend vs limit for the period", async (t) => {
  if (!dbUp) return t.skip("no database");
  const lines = await refreshActuals(sql, TENANT, AS_OF);
  const soft = lines.find((l) => l.budgetId === budgetId);
  assert.ok(soft, "software budget evaluated");
  assert.equal(soft!.spentCents, 9000);
  assert.equal(soft!.limitCents, 10000);
  assert.equal(soft!.pct, 90);
  assert.equal(soft!.status, "warn");

  const row = await sql<{ spent_cents: string }[]>`
    SELECT spent_cents FROM acct_budget_actuals WHERE budget_id = ${budgetId} AND period = '2026-04'`;
  assert.equal(Number(row[0]!.spent_cents), 9000, "actual persisted");
});

test("checkAlerts fires once at the threshold and not again the same period", async (t) => {
  if (!dbUp) return t.skip("no database");
  await refreshActuals(sql, TENANT, AS_OF);
  const first = await checkAlerts(sql, TENANT, AS_OF);
  assert.equal(first.length, 1, "alert fires");
  assert.equal(first[0]!.reason, "threshold");
  assert.equal(first[0]!.budgetId, budgetId);

  const second = await checkAlerts(sql, TENANT, AS_OF);
  assert.equal(second.length, 0, "does not re-fire the same period");
});
