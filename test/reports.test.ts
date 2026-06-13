/**
 * Reports tenant-isolation regression test. A bug had the tenant filter in a LEFT
 * JOIN ON clause, so one tenant's lines on a SHARED project/account leaked into
 * another tenant's per-project P&L and cash position (and broke the close tie-out).
 * This seeds two tenants on the same shared project and asserts no leakage.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { openSql, type Sql } from "../src/core/db.js";
import { loadEnv } from "../src/lib/env.js";
import { postEntry } from "../src/core/ledger.js";
import { buildExpenseEntry, buildRevenueEntry } from "../src/core/posting.js";
import { buildPerProjectPnl, buildPortfolioPnl, buildCashPosition } from "../src/core/reports.js";

const env = loadEnv(join(process.cwd(), ".env"));
const url = env.ACCT_DB_URL ?? "postgresql://postgres:local-dev-password@localhost:5433/accounting";
const A = "rpt_a";
const B = "rpt_b";
const PERIOD = "2026-02";

let sql: Sql;
let dbUp = false;

async function cleanBoth(): Promise<void> {
  await sql`DELETE FROM acct_journal_entries WHERE tenant_id IN (${A}, ${B})`;
}

before(async () => {
  sql = openSql(url);
  try {
    await sql`SELECT 1`;
    dbUp = true;
    await cleanBoth();
    // Tenant A: $100 shared hosting expense + $300 revenue.
    await postEntry(sql, A, buildExpenseEntry({ entryDate: "2026-02-10", idempotencyKey: "a-exp", amountCents: 10000, expenseAccountCode: "6160", paidFromAccountCode: "2010", projectSlug: "shared" }));
    await postEntry(sql, A, buildRevenueEntry({ entryDate: "2026-02-12", idempotencyKey: "a-rev", amountCents: 30000, revenueAccountCode: "4010", depositedToAccountCode: "1010", projectSlug: "agor_me" }));
    // Tenant B: a DIFFERENT amount on the SAME shared project + same cash account.
    await postEntry(sql, B, buildExpenseEntry({ entryDate: "2026-02-11", idempotencyKey: "b-exp", amountCents: 77700, expenseAccountCode: "6160", paidFromAccountCode: "2010", projectSlug: "shared" }));
    await postEntry(sql, B, buildRevenueEntry({ entryDate: "2026-02-13", idempotencyKey: "b-rev", amountCents: 55500, revenueAccountCode: "4010", depositedToAccountCode: "1010", projectSlug: "agor_me" }));
  } catch {
    dbUp = false;
  }
});

after(async () => {
  if (dbUp) await cleanBoth();
  await sql.end({ timeout: 5 });
});

test("per-project P&L does not leak another tenant's shared-project lines", async (t) => {
  if (!dbUp) return t.skip("no database");
  const a = await buildPerProjectPnl(sql, A, PERIOD);
  const shared = a.find((p) => p.projectSlug === "shared");
  assert.equal(shared?.expenseCents, 10000, "tenant A shared expense must be only A's $100");
});

test("portfolio P&L equals the sum of per-project (tie-out holds per tenant)", async (t) => {
  if (!dbUp) return t.skip("no database");
  const a = await buildPerProjectPnl(sql, A, PERIOD);
  const portfolio = await buildPortfolioPnl(sql, A, PERIOD);
  const sumNet = a.reduce((acc, p) => acc + p.netCents, 0);
  assert.equal(sumNet, portfolio.netCents, "tie-out must hold");
  assert.equal(portfolio.revenueCents, 30000);
  assert.equal(portfolio.expenseCents, 10000);
});

test("cash position does not leak another tenant's lines on the same account", async (t) => {
  if (!dbUp) return t.skip("no database");
  const cash = await buildCashPosition(sql, A, PERIOD);
  const checking = cash.byAccount.find((x) => x.code === "1010");
  assert.equal(checking?.balanceCents, 30000, "tenant A checking is only A's $300 deposit");
});
