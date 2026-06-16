/**
 * SMB layer tests: AR invoices, AP bills, payroll, 1099 tracking, sales tax, aging.
 * Pure posting-builder cases run anywhere; the pipeline runs against the real
 * `accounting` DB on a dedicated tenant and skips if no DB. Every posting balances
 * (the builders + the DB trigger guarantee it); we also assert tenant debits==credits.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { openSql, type Sql } from "../src/core/db.js";
import { loadEnv } from "../src/lib/env.js";
import { assertBalanced } from "../src/core/ledger.js";
import { buildInvoiceEntry, buildBillEntry, buildPayrollEntry } from "../src/core/posting.js";
import {
  upsertCustomer,
  upsertVendor,
  createInvoice,
  issueInvoice,
  recordInvoicePayment,
  createBill,
  recordBillPayment,
  vendors1099Due,
  postPayrollRun,
  accrueSalesTax,
  aging,
} from "../src/core/smb.js";

// ─── Pure builders ───────────────────────────────────────────────────────────────
test("buildInvoiceEntry balances AR = revenue + sales tax", () => {
  const e = buildInvoiceEntry({
    entryDate: "2026-04-01",
    idempotencyKey: "inv:1",
    revenueLines: [{ revenueAccountCode: "4010", amountCents: 100000 }],
    taxCents: 9500,
  });
  assertBalanced(e);
  const ar = e.lines.find((l) => l.accountCode === "1200");
  assert.equal(ar?.debitCents, 109500);
});

test("buildBillEntry splits a mixed-use line and credits AP for the total", () => {
  const e = buildBillEntry({
    entryDate: "2026-04-01",
    idempotencyKey: "bill:1",
    expenseLines: [{ expenseAccountCode: "6060", amountCents: 10000, businessPct: 80 }],
  });
  assertBalanced(e);
  assert.equal(e.lines.find((l) => l.accountCode === "2080")?.creditCents, 10000);
  assert.equal(e.lines.find((l) => l.accountCode === "6060")?.debitCents, 8000);
  assert.equal(e.lines.find((l) => l.accountCode === "9500")?.debitCents, 2000);
});

test("buildPayrollEntry balances gross+employerTax against withholding+employerTax+net", () => {
  const e = buildPayrollEntry({
    entryDate: "2026-04-15",
    idempotencyKey: "pay:1",
    grossCents: 500000,
    employeeWithholdingCents: 125000,
    employerTaxCents: 40000,
  });
  assertBalanced(e);
  assert.equal(e.lines.find((l) => l.accountCode === "1010")?.creditCents, 375000); // net
  assert.equal(e.lines.find((l) => l.accountCode === "6210")?.debitCents, 500000); // gross
});

test("buildPayrollEntry throws when withholding exceeds gross", () => {
  assert.throws(() =>
    buildPayrollEntry({ entryDate: "2026-04-15", idempotencyKey: "pay:2", grossCents: 1000, employeeWithholdingCents: 2000, employerTaxCents: 0 }),
  );
});

// ─── DB pipeline ───────────────────────────────────────────────────────────────────
const env = loadEnv(join(process.cwd(), ".env"));
const url = env.ACCT_DB_URL ?? "postgresql://postgres:local-dev-password@localhost:5433/accounting";
const TENANT = "test_smb";

let sql: Sql;
let dbUp = false;

async function clean(): Promise<void> {
  await sql`DELETE FROM acct_journal_entries WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_invoice_lines WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_invoices WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_bill_lines WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_bills WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_payroll_lines WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_payroll_runs WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_1099_tracking WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_sales_tax WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_customers WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_vendors WHERE tenant_id = ${TENANT}`;
  await sql`DELETE FROM acct_audit_log WHERE tenant_id = ${TENANT}`;
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

async function tenantBalanced(): Promise<boolean> {
  const r = await sql<{ d: string; c: string }[]>`
    SELECT COALESCE(SUM(l.debit_cents),0) d, COALESCE(SUM(l.credit_cents),0) c
    FROM acct_journal_lines l JOIN acct_journal_entries e ON e.id = l.entry_id
    WHERE e.tenant_id = ${TENANT} AND e.status = 'posted'`;
  return Number(r[0]!.d) === Number(r[0]!.c);
}

test("AR: create -> issue -> pay moves AR through the ledger and balances", async (t) => {
  if (!dbUp) return t.skip("no database");
  const customerId = await upsertCustomer(sql, TENANT, "Acme Co", { projectSlug: "agor_me" });
  const invoiceId = await createInvoice(sql, TENANT, {
    customerId,
    invoiceNo: "INV-1001",
    issueDate: "2026-04-01",
    dueDate: "2026-05-01",
    projectSlug: "agor_me",
    lines: [{ description: "Consulting", unitPriceCents: 100000, revenueAccountCode: "4010", taxable: true }],
    taxRatePct: 9.5,
    jurisdiction: "CA",
  });
  const { entryId } = await issueInvoice(sql, TENANT, invoiceId);
  assert.ok(entryId);

  // AR debited 109,500 (100k + 9.5% tax).
  const ar = await sql<{ s: string }[]>`
    SELECT COALESCE(SUM(l.debit_cents - l.credit_cents),0) s
    FROM acct_journal_lines l JOIN acct_journal_entries e ON e.id = l.entry_id JOIN acct_chart c ON c.id = l.account_id
    WHERE e.tenant_id = ${TENANT} AND c.code = '1200'`;
  assert.equal(Number(ar[0]!.s), 109500);
  await accrueSalesTax(sql, TENANT, "CA", "2026-04", 100000, 9500);

  await recordInvoicePayment(sql, TENANT, invoiceId, 109500, "2026-04-20");
  const inv = await sql<{ status: string }[]>`SELECT status FROM acct_invoices WHERE id = ${invoiceId}`;
  assert.equal(inv[0]!.status, "paid");
  // AR back to zero after payment.
  const arAfter = await sql<{ s: string }[]>`
    SELECT COALESCE(SUM(l.debit_cents - l.credit_cents),0) s
    FROM acct_journal_lines l JOIN acct_journal_entries e ON e.id = l.entry_id JOIN acct_chart c ON c.id = l.account_id
    WHERE e.tenant_id = ${TENANT} AND c.code = '1200'`;
  assert.equal(Number(arAfter[0]!.s), 0);
  assert.equal(await tenantBalanced(), true);

  const stax = await sql<{ collected_cents: string }[]>`
    SELECT collected_cents FROM acct_sales_tax WHERE tenant_id = ${TENANT} AND jurisdiction = 'CA' AND period = '2026-04'`;
  assert.equal(Number(stax[0]!.collected_cents), 9500);
});

test("AP: bill a 1099 contractor and pay over the $600 bar flags requires_1099", async (t) => {
  if (!dbUp) return t.skip("no database");
  const vendorId = await upsertVendor(sql, TENANT, "Jane Contractor", { is1099: true, w9OnFile: true, defaultAccountCode: "6020" });
  const { billId } = await createBill(sql, TENANT, {
    vendorId,
    billNo: "B-1",
    issueDate: "2026-04-02",
    dueDate: "2026-04-30",
    lines: [{ description: "Design work", amountCents: 90000, expenseAccountCode: "6020" }],
  });
  await recordBillPayment(sql, TENANT, billId, 90000, "2026-04-25");

  const bill = await sql<{ status: string }[]>`SELECT status FROM acct_bills WHERE id = ${billId}`;
  assert.equal(bill[0]!.status, "paid");
  assert.equal(await tenantBalanced(), true);

  const due = await vendors1099Due(sql, TENANT, 2026);
  assert.equal(due.length, 1);
  assert.equal(due[0]!.name, "Jane Contractor");
  assert.equal(due[0]!.ytdPaidCents, 90000);
  assert.equal(due[0]!.w9OnFile, true);
});

test("payroll run posts a balanced consolidated JE", async (t) => {
  if (!dbUp) return t.skip("no database");
  const { runId } = await postPayrollRun(sql, TENANT, {
    payDate: "2026-04-15",
    lines: [
      { employeeName: "Emp A", grossCents: 500000, withholdingCents: 125000, employerTaxCents: 40000 },
      { employeeName: "Emp B", grossCents: 300000, withholdingCents: 70000, employerTaxCents: 24000 },
    ],
  });
  const run = await sql<{ status: string; gross_cents: string; net_cents: string }[]>`
    SELECT status, gross_cents, net_cents FROM acct_payroll_runs WHERE id = ${runId}`;
  assert.equal(run[0]!.status, "posted");
  assert.equal(Number(run[0]!.gross_cents), 800000);
  assert.equal(Number(run[0]!.net_cents), 605000); // 800k - 195k withholding
  assert.equal(await tenantBalanced(), true);
});

test("aging buckets the open AR balance by days past due", async (t) => {
  if (!dbUp) return t.skip("no database");
  // Issue an invoice due 2026-04-01; as of 2026-06-15 it is ~75 days past due.
  const customerId = await upsertCustomer(sql, TENANT, "Slow Payer");
  const id = await createInvoice(sql, TENANT, {
    customerId,
    invoiceNo: "INV-2001",
    issueDate: "2026-03-01",
    dueDate: "2026-04-01",
    lines: [{ description: "Old job", unitPriceCents: 50000, revenueAccountCode: "4090" }],
  });
  await issueInvoice(sql, TENANT, id);
  const ar = await aging(sql, TENANT, "ar", "2026-06-15");
  assert.equal(ar.d61_90, 50000, "75 days past due lands in the 61-90 bucket");
});
