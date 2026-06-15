-- 009_advisory.sql — the financial-advisor engine's persisted output.
-- Recommendations are grounded, dismissible advice (savings, tax set-aside, zombie
-- subscriptions, cashflow, pricing/ROI). Goals track targets. advisor_runs is the
-- audit trail proving every recommendation cites real numbers, never invented ones.
-- Bookkeeping/advisory only — every surfaced item defers to a licensed professional.

CREATE TABLE IF NOT EXISTS acct_recommendations (
  id            bigserial   PRIMARY KEY,
  tenant_id     text        NOT NULL DEFAULT 'ariel',
  kind          text        NOT NULL
                CHECK (kind IN ('savings','tax','cashflow','subscription','pricing','runway','anomaly')),
  title         text        NOT NULL,
  body          text        NOT NULL,
  rationale_json jsonb,                                         -- the grounding numbers behind the advice
  est_impact_cents bigint   NOT NULL DEFAULT 0,                -- estimated $ impact (savings or risk)
  confidence    numeric(4,3) NOT NULL DEFAULT 0.800,
  status        text        NOT NULL DEFAULT 'new'
                CHECK (status IN ('new','ack','dismissed','done','snoozed')),
  generated_by  text        NOT NULL DEFAULT 'engine'
                CHECK (generated_by IN ('engine','llm','human')),
  dedupe_key    text,                                          -- stable key so the same advice isn't re-spammed
  snoozed_until date,
  run_id        bigint,                                        -- the advisor_run that produced it
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reco_dedupe ON acct_recommendations
  (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status <> 'dismissed';
CREATE INDEX IF NOT EXISTS idx_reco_status ON acct_recommendations (status);

-- Financial goals: a runway floor, a savings target, a tax set-aside target, etc.
CREATE TABLE IF NOT EXISTS acct_goals (
  id            bigserial   PRIMARY KEY,
  tenant_id     text        NOT NULL DEFAULT 'ariel',
  name          text        NOT NULL,
  kind          text        NOT NULL CHECK (kind IN ('savings','runway_months','tax_setaside','debt_paydown','revenue')),
  target_cents  bigint,                                        -- monetary target (null for runway_months)
  target_months numeric(6,2),                                  -- months target (runway)
  target_date   date,
  current_cents bigint      NOT NULL DEFAULT 0,                -- last computed progress
  status        text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','met','paused','abandoned')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One row per advisor generation pass — observability + anti-hallucination audit.
CREATE TABLE IF NOT EXISTS acct_advisor_runs (
  id            bigserial   PRIMARY KEY,
  tenant_id     text        NOT NULL DEFAULT 'ariel',
  as_of_date    date        NOT NULL,
  inputs_json   jsonb,                                          -- the grounded snapshot fed to the advisor
  recommendation_count int  NOT NULL DEFAULT 0,
  generated_by  text        NOT NULL DEFAULT 'engine',
  created_at    timestamptz NOT NULL DEFAULT now()
);
