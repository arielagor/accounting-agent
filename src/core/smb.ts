/**
 * The small-business layer: AR (customers/invoices), AP (vendors/bills), payroll,
 * 1099 contractor tracking, and sales tax. Each monetary lifecycle event posts a real
 * double-entry journal entry through the centralized posting builders + ledger.post()
 * — these functions hold the business documents and their LINK to the posted entry,
 * never a parallel ledger. The agent RECORDS obligations; it never moves money.
 * Money is integer cents.
 */
import type { Sql } from "./db.js";
import type { Cents } from "./types.js";
import { postEntry } from "./ledger.js";
import {
  buildInvoiceEntry,
  buildBillEntry,
  buildTransferEntry,
  buildPayrollEntry,
  type InvoiceRevenueLine,
} from "./posting.js";
import { logAudit } from "./audit.js";

const THRESHOLD_1099_CENTS = 60_000; // $600 — the 1099-NEC reporting bar

// ─── Parties ──────────────────────────────────────────────────────────────────
export async function upsertCustomer(
  sql: Sql,
  tenantId: string,
  name: string,
  opts: { email?: string; projectSlug?: string; termsDays?: number } = {},
): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO acct_customers (tenant_id, name, email, project_slug, terms_days)
    VALUES (${tenantId}, ${name}, ${opts.email ?? null}, ${opts.projectSlug ?? null}, ${opts.termsDays ?? 30})
    ON CONFLICT (tenant_id, name) DO UPDATE SET
      email = COALESCE(EXCLUDED.email, acct_customers.email),
      project_slug = COALESCE(EXCLUDED.project_slug, acct_customers.project_slug)
    RETURNING id`;
  return row!.id;
}

export async function upsertVendor(
  sql: Sql,
  tenantId: string,
  name: string,
  opts: { email?: string; taxId?: string; is1099?: boolean; w9OnFile?: boolean; defaultAccountCode?: string } = {},
): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO acct_vendors (tenant_id, name, email, tax_id, is_1099, w9_on_file, default_account_code)
    VALUES (${tenantId}, ${name}, ${opts.email ?? null}, ${opts.taxId ?? null},
            ${opts.is1099 ?? false}, ${opts.w9OnFile ?? false}, ${opts.defaultAccountCode ?? null})
    ON CONFLICT (tenant_id, name) DO UPDATE SET
      is_1099 = EXCLUDED.is_1099, w9_on_file = EXCLUDED.w9_on_file,
      tax_id = COALESCE(EXCLUDED.tax_id, acct_vendors.tax_id),
      default_account_code = COALESCE(EXCLUDED.default_account_code, acct_vendors.default_account_code)
    RETURNING id`;
  return row!.id;
}

// ─── AR: invoices ────────────────────────────────────────────────────────────────
export interface InvoiceLineInput {
  description: string;
  qty?: number;
  unitPriceCents: Cents;
  revenueAccountCode?: string; // default 4900? no — default to a revenue account; caller usually sets
  taxable?: boolean;
}
export interface CreateInvoiceInput {
  customerId: number;
  invoiceNo: string;
  issueDate: string;
  dueDate: string;
  projectSlug?: string | null;
  lines: InvoiceLineInput[];
  /** Sales tax rate applied to taxable lines, as a percent (e.g. 9.5). */
  taxRatePct?: number;
  jurisdiction?: string;
}

/** Create an invoice in 'draft' (no posting yet). Computes subtotal + tax + total. */
export async function createInvoice(sql: Sql, tenantId: string, input: CreateInvoiceInput): Promise<number> {
  const rate = input.taxRatePct ?? 0;
  let subtotal = 0;
  let taxable = 0;
  const lines = input.lines.map((l, i) => {
    const amount = Math.round((l.qty ?? 1) * Math.abs(l.unitPriceCents));
    subtotal += amount;
    if (l.taxable) taxable += amount;
    return { ...l, amount, lineNo: i + 1 };
  });
  const tax = Math.round((taxable * rate) / 100);
  const total = subtotal + tax;

  const [inv] = await sql<{ id: number }[]>`
    INSERT INTO acct_invoices
      (tenant_id, customer_id, invoice_no, issue_date, due_date, project_slug,
       subtotal_cents, tax_cents, total_cents, status)
    VALUES (${tenantId}, ${input.customerId}, ${input.invoiceNo}, ${input.issueDate}, ${input.dueDate},
            ${input.projectSlug ?? null}, ${subtotal}, ${tax}, ${total}, 'draft')
    RETURNING id`;
  const invoiceId = inv!.id;
  for (const l of lines) {
    await sql`
      INSERT INTO acct_invoice_lines
        (invoice_id, tenant_id, line_no, description, qty, unit_price_cents, amount_cents, revenue_account_code, taxable)
      VALUES (${invoiceId}, ${tenantId}, ${l.lineNo}, ${l.description}, ${l.qty ?? 1},
              ${Math.abs(l.unitPriceCents)}, ${l.amount}, ${l.revenueAccountCode ?? "4090"}, ${l.taxable ?? false})`;
  }
  await logAudit(sql, tenantId, "engine", "create_invoice", `invoice:${invoiceId}`, { invoiceNo: input.invoiceNo, total });
  return invoiceId;
}

/** Issue a draft invoice: post the AR recognition entry, accrue sales tax, mark 'sent'. */
export async function issueInvoice(sql: Sql, tenantId: string, invoiceId: number): Promise<{ entryId: number }> {
  const inv = await sql<
    { invoice_no: string; issue_date: string; project_slug: string | null; tax_cents: string; status: string; total_cents: string }[]
  >`SELECT invoice_no, issue_date, project_slug, tax_cents, status, total_cents FROM acct_invoices WHERE id = ${invoiceId} AND tenant_id = ${tenantId}`;
  if (inv.length === 0) throw new Error(`invoice ${invoiceId} not found`);
  if (inv[0]!.status !== "draft") throw new Error(`invoice ${invoiceId} already ${inv[0]!.status}`);

  const lineRows = await sql<{ amount_cents: string; revenue_account_code: string }[]>`
    SELECT amount_cents, revenue_account_code FROM acct_invoice_lines WHERE invoice_id = ${invoiceId} ORDER BY line_no`;
  const revenueLines: InvoiceRevenueLine[] = lineRows.map((r) => ({
    revenueAccountCode: r.revenue_account_code,
    amountCents: Number(r.amount_cents),
    projectSlug: inv[0]!.project_slug,
  }));
  const tax = Number(inv[0]!.tax_cents);

  const entry = buildInvoiceEntry({
    entryDate: inv[0]!.issue_date,
    idempotencyKey: `invoice:${invoiceId}:issue`,
    sourceTxnId: `invoice:${invoiceId}`,
    revenueLines,
    taxCents: tax,
    memo: `Invoice ${inv[0]!.invoice_no}`,
  });
  const posted = await postEntry(sql, tenantId, entry);
  await sql`UPDATE acct_invoices SET status = 'sent', issue_entry_id = ${posted.id}, updated_at = now() WHERE id = ${invoiceId}`;
  await logAudit(sql, tenantId, "engine", "issue_invoice", `invoice:${invoiceId}`, { entryId: posted.id, taxCents: tax });
  return { entryId: posted.id };
}

/** Record a payment against an invoice: Dr cash / Cr AR; update paid + status. */
export async function recordInvoicePayment(
  sql: Sql,
  tenantId: string,
  invoiceId: number,
  amountCents: Cents,
  date: string,
  depositAccountCode = "1010",
): Promise<{ entryId: number }> {
  const inv = await sql<{ total_cents: string; amount_paid_cents: string; invoice_no: string }[]>`
    SELECT total_cents, amount_paid_cents, invoice_no FROM acct_invoices WHERE id = ${invoiceId} AND tenant_id = ${tenantId}`;
  if (inv.length === 0) throw new Error(`invoice ${invoiceId} not found`);
  const amt = Math.abs(amountCents);
  const entry = buildTransferEntry({
    entryDate: date,
    idempotencyKey: `invoice:${invoiceId}:pay:${date}:${amt}`,
    sourceTxnId: `invoice:${invoiceId}`,
    amountCents: amt,
    toAccountCode: depositAccountCode, // Dr cash
    fromAccountCode: "1200", // Cr AR
    memo: `Payment for invoice ${inv[0]!.invoice_no}`,
  });
  const posted = await postEntry(sql, tenantId, entry);
  const paid = Number(inv[0]!.amount_paid_cents) + amt;
  const total = Number(inv[0]!.total_cents);
  const status = paid >= total ? "paid" : "partial";
  await sql`UPDATE acct_invoices SET amount_paid_cents = ${paid}, status = ${status}, paid_entry_id = ${posted.id}, updated_at = now() WHERE id = ${invoiceId}`;
  return { entryId: posted.id };
}

// ─── AP: bills ───────────────────────────────────────────────────────────────────
export interface BillLineInput {
  description: string;
  amountCents: Cents;
  expenseAccountCode: string;
  projectSlug?: string | null;
  businessPct?: number;
}
export interface CreateBillInput {
  vendorId: number;
  billNo?: string;
  issueDate: string;
  dueDate: string;
  projectSlug?: string | null;
  lines: BillLineInput[];
}

/** Record a vendor bill and post the AP accrual (Dr expense / Cr AP) immediately. */
export async function createBill(sql: Sql, tenantId: string, input: CreateBillInput): Promise<{ billId: number; entryId: number }> {
  const total = input.lines.reduce((a, l) => a + Math.abs(l.amountCents), 0);
  const [bill] = await sql<{ id: number }[]>`
    INSERT INTO acct_bills (tenant_id, vendor_id, bill_no, issue_date, due_date, project_slug, total_cents, status)
    VALUES (${tenantId}, ${input.vendorId}, ${input.billNo ?? null}, ${input.issueDate}, ${input.dueDate},
            ${input.projectSlug ?? null}, ${total}, 'open')
    RETURNING id`;
  const billId = bill!.id;
  let lineNo = 1;
  for (const l of input.lines) {
    await sql`
      INSERT INTO acct_bill_lines (bill_id, tenant_id, line_no, description, amount_cents, expense_account_code, project_slug, business_pct)
      VALUES (${billId}, ${tenantId}, ${lineNo}, ${l.description}, ${Math.abs(l.amountCents)},
              ${l.expenseAccountCode}, ${l.projectSlug ?? null}, ${l.businessPct ?? 100})`;
    lineNo += 1;
  }
  const entry = buildBillEntry({
    entryDate: input.issueDate,
    idempotencyKey: `bill:${billId}:accrue`,
    sourceTxnId: `bill:${billId}`,
    expenseLines: input.lines.map((l) => ({
      expenseAccountCode: l.expenseAccountCode,
      amountCents: Math.abs(l.amountCents),
      projectSlug: l.projectSlug ?? null,
      businessPct: l.businessPct ?? 100,
      memo: l.description,
    })),
    memo: input.billNo ? `Bill ${input.billNo}` : "Vendor bill",
  });
  const posted = await postEntry(sql, tenantId, entry);
  await sql`UPDATE acct_bills SET issue_entry_id = ${posted.id}, updated_at = now() WHERE id = ${billId}`;
  await logAudit(sql, tenantId, "engine", "create_bill", `bill:${billId}`, { total, entryId: posted.id });
  return { billId, entryId: posted.id };
}

/** Record a payment against a bill: Dr AP / Cr cash; accrue 1099 YTD; update status. */
export async function recordBillPayment(
  sql: Sql,
  tenantId: string,
  billId: number,
  amountCents: Cents,
  date: string,
  fromAccountCode = "1010",
): Promise<{ entryId: number }> {
  const bill = await sql<{ total_cents: string; amount_paid_cents: string; vendor_id: number }[]>`
    SELECT total_cents, amount_paid_cents, vendor_id FROM acct_bills WHERE id = ${billId} AND tenant_id = ${tenantId}`;
  if (bill.length === 0) throw new Error(`bill ${billId} not found`);
  const amt = Math.abs(amountCents);
  const entry = buildTransferEntry({
    entryDate: date,
    idempotencyKey: `bill:${billId}:pay:${date}:${amt}`,
    sourceTxnId: `bill:${billId}`,
    amountCents: amt,
    toAccountCode: "2080", // Dr AP (liability decreases)
    fromAccountCode, // Cr cash
    memo: `Payment for bill ${billId}`,
  });
  const posted = await postEntry(sql, tenantId, entry);
  const paid = Number(bill[0]!.amount_paid_cents) + amt;
  const total = Number(bill[0]!.total_cents);
  const status = paid >= total ? "paid" : "partial";
  await sql`UPDATE acct_bills SET amount_paid_cents = ${paid}, status = ${status}, paid_entry_id = ${posted.id}, updated_at = now() WHERE id = ${billId}`;
  await accrue1099Payment(sql, tenantId, bill[0]!.vendor_id, Number(date.slice(0, 4)), amt);
  return { entryId: posted.id };
}

// ─── 1099 tracking ───────────────────────────────────────────────────────────────
/** Accrue a payment into a vendor's YTD 1099 tracker and re-flag the $600 bar. */
export async function accrue1099Payment(
  sql: Sql,
  tenantId: string,
  vendorId: number,
  taxYear: number,
  amountCents: Cents,
): Promise<void> {
  const v = await sql<{ is_1099: boolean; w9_on_file: boolean }[]>`
    SELECT is_1099, w9_on_file FROM acct_vendors WHERE id = ${vendorId} AND tenant_id = ${tenantId}`;
  if (v.length === 0) return;
  await sql`
    INSERT INTO acct_1099_tracking (tenant_id, vendor_id, tax_year, ytd_paid_cents, requires_1099, w9_on_file, updated_at)
    VALUES (${tenantId}, ${vendorId}, ${taxYear}, ${Math.abs(amountCents)},
            ${v[0]!.is_1099 && Math.abs(amountCents) >= THRESHOLD_1099_CENTS}, ${v[0]!.w9_on_file}, now())
    ON CONFLICT (tenant_id, vendor_id, tax_year) DO UPDATE SET
      ytd_paid_cents = acct_1099_tracking.ytd_paid_cents + EXCLUDED.ytd_paid_cents,
      requires_1099 = (${v[0]!.is_1099} AND (acct_1099_tracking.ytd_paid_cents + EXCLUDED.ytd_paid_cents) >= ${THRESHOLD_1099_CENTS}),
      w9_on_file = ${v[0]!.w9_on_file},
      updated_at = now()`;
}

/** Vendors that crossed the $600 1099-NEC bar this tax year (with W-9 status). */
export async function vendors1099Due(
  sql: Sql,
  tenantId: string,
  taxYear: number,
): Promise<{ vendorId: number; name: string; ytdPaidCents: Cents; w9OnFile: boolean }[]> {
  const rows = await sql<{ vendor_id: number; name: string; ytd_paid_cents: string; w9_on_file: boolean }[]>`
    SELECT t.vendor_id, v.name, t.ytd_paid_cents, t.w9_on_file
    FROM acct_1099_tracking t JOIN acct_vendors v ON v.id = t.vendor_id
    WHERE t.tenant_id = ${tenantId} AND t.tax_year = ${taxYear} AND t.requires_1099
    ORDER BY t.ytd_paid_cents DESC`;
  return rows.map((r) => ({ vendorId: r.vendor_id, name: r.name, ytdPaidCents: Number(r.ytd_paid_cents), w9OnFile: r.w9_on_file }));
}

// ─── Payroll ─────────────────────────────────────────────────────────────────────
export interface PayrollLineInput {
  employeeName: string;
  grossCents: Cents;
  withholdingCents: Cents;
  employerTaxCents: Cents;
}
export interface PayrollRunInput {
  payDate: string;
  periodStart?: string;
  periodEnd?: string;
  lines: PayrollLineInput[];
}

/** Post a payroll run: insert run + per-employee lines, post the consolidated JE. */
export async function postPayrollRun(sql: Sql, tenantId: string, input: PayrollRunInput): Promise<{ runId: number; entryId: number }> {
  const gross = input.lines.reduce((a, l) => a + Math.abs(l.grossCents), 0);
  const withholding = input.lines.reduce((a, l) => a + Math.abs(l.withholdingCents), 0);
  const employerTax = input.lines.reduce((a, l) => a + Math.abs(l.employerTaxCents), 0);
  const net = gross - withholding;

  const [run] = await sql<{ id: number }[]>`
    INSERT INTO acct_payroll_runs
      (tenant_id, pay_date, period_start, period_end, gross_cents, employee_withholding_cents, employer_tax_cents, net_cents, status)
    VALUES (${tenantId}, ${input.payDate}, ${input.periodStart ?? null}, ${input.periodEnd ?? null},
            ${gross}, ${withholding}, ${employerTax}, ${net}, 'draft')
    RETURNING id`;
  const runId = run!.id;
  for (const l of input.lines) {
    await sql`
      INSERT INTO acct_payroll_lines (run_id, tenant_id, employee_name, gross_cents, withholding_cents, employer_tax_cents, net_cents)
      VALUES (${runId}, ${tenantId}, ${l.employeeName}, ${Math.abs(l.grossCents)}, ${Math.abs(l.withholdingCents)},
              ${Math.abs(l.employerTaxCents)}, ${Math.abs(l.grossCents) - Math.abs(l.withholdingCents)})`;
  }
  const entry = buildPayrollEntry({
    entryDate: input.payDate,
    idempotencyKey: `payroll:${runId}`,
    grossCents: gross,
    employeeWithholdingCents: withholding,
    employerTaxCents: employerTax,
    memo: `Payroll ${input.payDate}`,
  });
  const posted = await postEntry(sql, tenantId, entry);
  await sql`UPDATE acct_payroll_runs SET status = 'posted', entry_id = ${posted.id} WHERE id = ${runId}`;
  await logAudit(sql, tenantId, "engine", "post_payroll", `payroll:${runId}`, { gross, net, entryId: posted.id });
  return { runId, entryId: posted.id };
}

// ─── Sales tax ─────────────────────────────────────────────────────────────────────
/** Accrue collected sales tax into the jurisdiction/period accumulator. */
export async function accrueSalesTax(
  sql: Sql,
  tenantId: string,
  jurisdiction: string,
  period: string,
  taxableSalesCents: Cents,
  collectedCents: Cents,
  dueDate?: string,
): Promise<void> {
  await sql`
    INSERT INTO acct_sales_tax (tenant_id, jurisdiction, period, taxable_sales_cents, collected_cents, due_date, status, updated_at)
    VALUES (${tenantId}, ${jurisdiction}, ${period}, ${Math.abs(taxableSalesCents)}, ${Math.abs(collectedCents)}, ${dueDate ?? null}, 'accruing', now())
    ON CONFLICT (tenant_id, jurisdiction, period) DO UPDATE SET
      taxable_sales_cents = acct_sales_tax.taxable_sales_cents + EXCLUDED.taxable_sales_cents,
      collected_cents = acct_sales_tax.collected_cents + EXCLUDED.collected_cents,
      updated_at = now()`;
}

// ─── Aging reports (for the UI) ──────────────────────────────────────────────────
export interface AgingBucket {
  current: Cents;
  d1_30: Cents;
  d31_60: Cents;
  d61_90: Cents;
  d90plus: Cents;
}

/** AR or AP aging as of a date, bucketed by days past due on the open balance. */
export async function aging(
  sql: Sql,
  tenantId: string,
  kind: "ar" | "ap",
  asOfISO: string,
): Promise<AgingBucket> {
  const rows =
    kind === "ar"
      ? await sql<{ due_date: string; bal: string }[]>`
          SELECT to_char(due_date,'YYYY-MM-DD') AS due_date, (total_cents - amount_paid_cents) AS bal
          FROM acct_invoices
          WHERE tenant_id = ${tenantId} AND status IN ('sent','partial','overdue')
            AND (total_cents - amount_paid_cents) > 0`
      : await sql<{ due_date: string; bal: string }[]>`
          SELECT to_char(due_date,'YYYY-MM-DD') AS due_date, (total_cents - amount_paid_cents) AS bal
          FROM acct_bills
          WHERE tenant_id = ${tenantId} AND status IN ('open','partial','overdue')
            AND (total_cents - amount_paid_cents) > 0`;

  const bucket: AgingBucket = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
  const asOf = Date.parse(`${asOfISO}T00:00:00Z`);
  const day = 86_400_000;
  for (const r of rows) {
    const bal = Number(r.bal);
    const daysPast = Math.floor((asOf - Date.parse(`${r.due_date}T00:00:00Z`)) / day);
    if (daysPast <= 0) bucket.current += bal;
    else if (daysPast <= 30) bucket.d1_30 += bal;
    else if (daysPast <= 60) bucket.d31_60 += bal;
    else if (daysPast <= 90) bucket.d61_90 += bal;
    else bucket.d90plus += bal;
  }
  return bucket;
}
