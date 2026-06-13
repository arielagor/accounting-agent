-- 006_close.sql — month-end close orchestration state, locks, verdict, resolutions, reports.

-- One row per close run; stage advances are persisted (pollable, like a job record).
CREATE TABLE IF NOT EXISTS acct_close_run (
  id          bigserial PRIMARY KEY,
  tenant_id   text NOT NULL DEFAULT 'ariel',
  period      text NOT NULL,                 -- 'YYYY-MM'
  mode        text NOT NULL CHECK (mode IN ('incremental','close')),
  rung        text NOT NULL CHECK (rung IN ('off','draft','live')),
  stage       text NOT NULL DEFAULT 'precheck',
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running','complete','failed')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_close_run_period ON acct_close_run (tenant_id, period);

-- Immutable close record. A locked period is the trustworthy system of record.
CREATE TABLE IF NOT EXISTS acct_close (
  tenant_id             text NOT NULL DEFAULT 'ariel',
  period                text NOT NULL,
  rung                  text NOT NULL,
  status                text NOT NULL CHECK (status IN ('CLEAN','CLEAN_WITH_EXCEPTIONS','FAILED','DRAFT')),
  verdict               jsonb NOT NULL,
  tb_hash               text,
  balanced              boolean NOT NULL DEFAULT false,
  debits_cents          bigint NOT NULL DEFAULT 0,
  credits_cents         bigint NOT NULL DEFAULT 0,
  posted_count          int    NOT NULL DEFAULT 0,
  quarantine_count      int    NOT NULL DEFAULT 0,
  quarantine_value_cents bigint NOT NULL DEFAULT 0,
  artifacts             jsonb NOT NULL DEFAULT '{}'::jsonb,
  locked                boolean NOT NULL DEFAULT false,
  locked_at             timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, period)
);

-- Trial-balance snapshot per close (anchored by hash into acct_close).
CREATE TABLE IF NOT EXISTS acct_trial_balance (
  id           bigserial PRIMARY KEY,
  tenant_id    text NOT NULL DEFAULT 'ariel',
  period       text NOT NULL,
  account_code text NOT NULL,
  debit_cents  bigint NOT NULL DEFAULT 0,
  credit_cents bigint NOT NULL DEFAULT 0,
  snapshot_hash text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tb_period ON acct_trial_balance (tenant_id, period);

-- Human resolutions (from email reply verbs / dashboard clicks), consumed by the next run.
CREATE TABLE IF NOT EXISTS acct_resolution (
  id            bigserial PRIMARY KEY,
  tenant_id     text NOT NULL DEFAULT 'ariel',
  source_txn_id text,
  verb          text NOT NULL,            -- CATEGORIZE | ALLOCATE | APPROVE_AJE | DEFER_AJE | MATCH
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','consumed','invalid')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  consumed_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_resolution_open ON acct_resolution (status) WHERE status = 'open';

-- Archived report artifacts per close.
CREATE TABLE IF NOT EXISTS acct_report (
  id         bigserial PRIMARY KEY,
  tenant_id  text NOT NULL DEFAULT 'ariel',
  period     text NOT NULL,
  kind       text NOT NULL,    -- per_project_pnl | portfolio_pnl | cash_position | schedule_c | est_tax | exceptions
  format     text NOT NULL,    -- json | csv | pdf
  content    jsonb,
  path       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_report_period ON acct_report (tenant_id, period);

-- Migration bookkeeping.
CREATE TABLE IF NOT EXISTS acct_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
