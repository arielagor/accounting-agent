-- 002_ledger.sql — double-entry chart of accounts, projects, journal, balances.

-- Chart of accounts. `code` is the 4-digit account number; type drives normal side.
CREATE TABLE IF NOT EXISTS acct_chart (
  id             serial PRIMARY KEY,
  code           text    UNIQUE NOT NULL,
  name           text    NOT NULL,
  type           text    NOT NULL CHECK (type IN ('asset','liability','equity','revenue','cogs','expense','other')),
  normal_side    text    NOT NULL CHECK (normal_side IN ('debit','credit')),
  schedule_c_line text,
  tax_treatment  text    NOT NULL DEFAULT 'ordinary'
                 CHECK (tax_treatment IN ('ordinary','meals_50','capital','personal','nondeductible','mileage','home_office')),
  is_business    boolean NOT NULL DEFAULT true,
  is_active      boolean NOT NULL DEFAULT true,
  parent_code    text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Projects = cost centers. One revenue account per product; expenses allocate to projects.
CREATE TABLE IF NOT EXISTS acct_projects (
  id        serial PRIMARY KEY,
  slug      text   UNIQUE NOT NULL,           -- 'mvat_focus', 'agor_me', 'shared'
  name      text   NOT NULL,
  status    text   NOT NULL DEFAULT 'active' CHECK (status IN ('active','parked','retired')),
  is_shared boolean NOT NULL DEFAULT false
);

-- Journal entries. idempotency_key is the dedupe anchor: re-posting is a no-op.
CREATE TABLE IF NOT EXISTS acct_journal_entries (
  id              bigserial PRIMARY KEY,
  tenant_id       text        NOT NULL DEFAULT 'ariel',
  entry_date      date        NOT NULL,
  description     text,
  source          text        NOT NULL,       -- stripe | bank | manual | allocation | tax_accrual | adjustment
  source_txn_id   text,
  idempotency_key text        NOT NULL,
  status          text        NOT NULL DEFAULT 'posted'
                  CHECK (status IN ('posted','draft','void','needs_review')),
  is_allocation   boolean     NOT NULL DEFAULT false,
  created_by      text        NOT NULL DEFAULT 'engine'
                  CHECK (created_by IN ('engine','rule','llm','human')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT acct_entry_idem UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_entry_date ON acct_journal_entries (entry_date);
CREATE INDEX IF NOT EXISTS idx_entry_status ON acct_journal_entries (status);

-- Journal lines. Exactly one of debit/credit > 0. business_pct is the mixed-use split.
CREATE TABLE IF NOT EXISTS acct_journal_lines (
  id           bigserial PRIMARY KEY,
  entry_id     bigint  NOT NULL REFERENCES acct_journal_entries(id) ON DELETE CASCADE,
  account_id   int     NOT NULL REFERENCES acct_chart(id),
  project_id   int     REFERENCES acct_projects(id),
  debit_cents  bigint  NOT NULL DEFAULT 0,
  credit_cents bigint  NOT NULL DEFAULT 0,
  business_pct numeric(5,2) NOT NULL DEFAULT 100.00,
  memo         text,
  CHECK (debit_cents >= 0 AND credit_cents >= 0),
  CHECK (NOT (debit_cents > 0 AND credit_cents > 0))
);
CREATE INDEX IF NOT EXISTS idx_line_entry ON acct_journal_lines (entry_id);
CREATE INDEX IF NOT EXISTS idx_line_account ON acct_journal_lines (account_id);
CREATE INDEX IF NOT EXISTS idx_line_project ON acct_journal_lines (project_id);

-- DEFERRED balanced-entry enforcement: checked at COMMIT, so multi-line inserts
-- inside one transaction are fine; an entry that does not balance to the cent fails.
CREATE OR REPLACE FUNCTION acct_assert_entry_balanced() RETURNS trigger AS $$
DECLARE
  eid bigint;
  d   bigint;
  c   bigint;
BEGIN
  eid := COALESCE(NEW.entry_id, OLD.entry_id);
  SELECT COALESCE(SUM(debit_cents), 0), COALESCE(SUM(credit_cents), 0)
    INTO d, c
    FROM acct_journal_lines
   WHERE entry_id = eid;
  IF d <> c THEN
    RAISE EXCEPTION 'journal entry % is unbalanced: debits=% credits=%', eid, d, c
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS acct_journal_lines_balanced ON acct_journal_lines;
CREATE CONSTRAINT TRIGGER acct_journal_lines_balanced
  AFTER INSERT OR UPDATE OR DELETE ON acct_journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION acct_assert_entry_balanced();

-- Materialized monthly balance rollup. project_id NULL = balance-sheet line.
CREATE TABLE IF NOT EXISTS acct_balances (
  account_id   int    NOT NULL REFERENCES acct_chart(id),
  project_id   int    REFERENCES acct_projects(id),
  fiscal_year  int    NOT NULL,
  fiscal_month int    NOT NULL,
  balance_cents bigint NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_balances
  ON acct_balances (account_id, COALESCE(project_id, -1), fiscal_year, fiscal_month);
