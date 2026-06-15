-- 010_smb.sql — full small-business layer: AR (customers/invoices), AP (vendors/bills),
-- payroll, 1099 contractor tracking, and sales tax. Every monetary lifecycle event
-- posts a real double-entry journal entry through ledger.post() — these tables hold
-- the business documents and their LINK to the posted entry, never a parallel ledger.
-- The agent RECORDS obligations; it never moves money (no transfer/pay verb exists).

-- ─── Parties ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS acct_customers (
  id            bigserial   PRIMARY KEY,
  tenant_id     text        NOT NULL DEFAULT 'ariel',
  name          text        NOT NULL,
  email         text,
  project_slug  text,                                          -- which product this customer relates to
  terms_days    int         NOT NULL DEFAULT 30,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS acct_vendors (
  id            bigserial   PRIMARY KEY,
  tenant_id     text        NOT NULL DEFAULT 'ariel',
  name          text        NOT NULL,
  email         text,
  tax_id        text,                                          -- EIN/SSN for 1099 (store carefully)
  is_1099       boolean     NOT NULL DEFAULT false,            -- contractor subject to 1099-NEC
  w9_on_file    boolean     NOT NULL DEFAULT false,
  default_account_code text,                                   -- usual expense category
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

-- ─── Accounts receivable (invoicing) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS acct_invoices (
  id            bigserial   PRIMARY KEY,
  tenant_id     text        NOT NULL DEFAULT 'ariel',
  customer_id   bigint      NOT NULL REFERENCES acct_customers(id) ON DELETE RESTRICT,
  invoice_no    text        NOT NULL,
  issue_date    date        NOT NULL,
  due_date      date        NOT NULL,
  project_slug  text,
  subtotal_cents bigint     NOT NULL DEFAULT 0,
  tax_cents     bigint      NOT NULL DEFAULT 0,
  total_cents   bigint      NOT NULL DEFAULT 0,
  amount_paid_cents bigint  NOT NULL DEFAULT 0,
  status        text        NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','sent','partial','paid','void','overdue')),
  issue_entry_id bigint     REFERENCES acct_journal_entries(id) ON DELETE SET NULL,  -- Dr AR / Cr revenue (+ Cr sales tax payable)
  paid_entry_id bigint      REFERENCES acct_journal_entries(id) ON DELETE SET NULL,  -- Dr cash / Cr AR
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, invoice_no)
);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON acct_invoices (status);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON acct_invoices (customer_id);

CREATE TABLE IF NOT EXISTS acct_invoice_lines (
  id            bigserial   PRIMARY KEY,
  invoice_id    bigint      NOT NULL REFERENCES acct_invoices(id) ON DELETE CASCADE,
  tenant_id     text        NOT NULL DEFAULT 'ariel',
  line_no       int         NOT NULL,
  description   text        NOT NULL,
  qty           numeric(12,3) NOT NULL DEFAULT 1,
  unit_price_cents bigint   NOT NULL DEFAULT 0,
  amount_cents  bigint      NOT NULL DEFAULT 0,
  revenue_account_code text NOT NULL DEFAULT '4900',           -- which revenue account this line credits
  taxable       boolean     NOT NULL DEFAULT false,
  UNIQUE (invoice_id, line_no)
);

-- ─── Accounts payable (bills) ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS acct_bills (
  id            bigserial   PRIMARY KEY,
  tenant_id     text        NOT NULL DEFAULT 'ariel',
  vendor_id     bigint      NOT NULL REFERENCES acct_vendors(id) ON DELETE RESTRICT,
  bill_no       text,
  issue_date    date        NOT NULL,
  due_date      date        NOT NULL,
  project_slug  text,
  total_cents   bigint      NOT NULL DEFAULT 0,
  amount_paid_cents bigint  NOT NULL DEFAULT 0,
  status        text        NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','partial','paid','void','overdue')),
  issue_entry_id bigint     REFERENCES acct_journal_entries(id) ON DELETE SET NULL,  -- Dr expense / Cr AP
  paid_entry_id bigint      REFERENCES acct_journal_entries(id) ON DELETE SET NULL,  -- Dr AP / Cr cash
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bills_status ON acct_bills (status);
CREATE INDEX IF NOT EXISTS idx_bills_vendor ON acct_bills (vendor_id);

CREATE TABLE IF NOT EXISTS acct_bill_lines (
  id            bigserial   PRIMARY KEY,
  bill_id       bigint      NOT NULL REFERENCES acct_bills(id) ON DELETE CASCADE,
  tenant_id     text        NOT NULL DEFAULT 'ariel',
  line_no       int         NOT NULL,
  description   text        NOT NULL,
  amount_cents  bigint      NOT NULL DEFAULT 0,
  expense_account_code text NOT NULL,
  project_slug  text,
  business_pct  numeric(5,2) NOT NULL DEFAULT 100.00,
  UNIQUE (bill_id, line_no)
);

-- ─── Payroll ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS acct_payroll_runs (
  id            bigserial   PRIMARY KEY,
  tenant_id     text        NOT NULL DEFAULT 'ariel',
  pay_date      date        NOT NULL,
  period_start  date,
  period_end    date,
  gross_cents   bigint      NOT NULL DEFAULT 0,
  employee_withholding_cents bigint NOT NULL DEFAULT 0,        -- income tax + employee FICA withheld
  employer_tax_cents bigint NOT NULL DEFAULT 0,                -- employer FICA/FUTA/SUTA
  net_cents     bigint      NOT NULL DEFAULT 0,                -- gross - employee withholding
  status        text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','void')),
  entry_id      bigint      REFERENCES acct_journal_entries(id) ON DELETE SET NULL,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS acct_payroll_lines (
  id            bigserial   PRIMARY KEY,
  run_id        bigint      NOT NULL REFERENCES acct_payroll_runs(id) ON DELETE CASCADE,
  tenant_id     text        NOT NULL DEFAULT 'ariel',
  employee_name text        NOT NULL,
  gross_cents   bigint      NOT NULL DEFAULT 0,
  withholding_cents bigint  NOT NULL DEFAULT 0,
  employer_tax_cents bigint NOT NULL DEFAULT 0,
  net_cents     bigint      NOT NULL DEFAULT 0
);

-- ─── 1099 contractor tracking ────────────────────────────────────────────────────
-- A YTD payment accumulator per vendor per tax year; flags the >= $600 1099-NEC bar.
CREATE TABLE IF NOT EXISTS acct_1099_tracking (
  id            bigserial   PRIMARY KEY,
  tenant_id     text        NOT NULL DEFAULT 'ariel',
  vendor_id     bigint      NOT NULL REFERENCES acct_vendors(id) ON DELETE CASCADE,
  tax_year      int         NOT NULL,
  ytd_paid_cents bigint     NOT NULL DEFAULT 0,
  requires_1099 boolean     NOT NULL DEFAULT false,            -- ytd >= threshold AND vendor.is_1099
  w9_on_file    boolean     NOT NULL DEFAULT false,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, vendor_id, tax_year)
);

-- ─── Sales tax ───────────────────────────────────────────────────────────────────
-- Collected-vs-remitted per jurisdiction per period. Rate is sourced from
-- acct_tax_rates (kind='sales_tax') — never a literal in code, same as income tax.
CREATE TABLE IF NOT EXISTS acct_sales_tax (
  id            bigserial   PRIMARY KEY,
  tenant_id     text        NOT NULL DEFAULT 'ariel',
  jurisdiction  text        NOT NULL,                          -- e.g. 'CA', 'CA-LA', 'TX'
  period        text        NOT NULL,                          -- 'YYYY-MM' or 'YYYY-Qn'
  taxable_sales_cents bigint NOT NULL DEFAULT 0,
  collected_cents bigint    NOT NULL DEFAULT 0,
  remitted_cents bigint     NOT NULL DEFAULT 0,
  has_nexus     boolean     NOT NULL DEFAULT true,
  due_date      date,
  status        text        NOT NULL DEFAULT 'accruing'
                CHECK (status IN ('accruing','due','remitted')),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, jurisdiction, period)
);
