-- 008_budgets.sql — hybrid (envelope/zero-based) + per-project budgets and alerts.
-- Budgets are the spine of the realtime budget assistant: a scope (an expense
-- category, a project, or the whole portfolio) gets a per-period limit; actuals are
-- materialized for fast reads; alerts fire when spend crosses a threshold or the
-- run-rate projects an overrun. Money is integer cents.

CREATE TABLE IF NOT EXISTS acct_budgets (
  id            bigserial   PRIMARY KEY,
  tenant_id     text        NOT NULL DEFAULT 'ariel',
  name          text        NOT NULL,
  period_kind   text        NOT NULL DEFAULT 'month'
                CHECK (period_kind IN ('month','quarter','year')),
  scope         text        NOT NULL CHECK (scope IN ('category','project','overall')),
  account_code  text,                                          -- set when scope='category' (acct_chart.code)
  project_slug  text,                                          -- set when scope='project'
  limit_cents   bigint      NOT NULL CHECK (limit_cents >= 0),
  method        text        NOT NULL DEFAULT 'envelope'
                CHECK (method IN ('envelope','zero_based','fixed')),
  rollover      boolean     NOT NULL DEFAULT false,            -- unspent carries to next period
  enabled       boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- One active budget per (scope target, period kind). Partial unique handles the
  -- three scope shapes without colliding NULLs across different scopes.
  CONSTRAINT acct_budget_scope_chk CHECK (
    (scope = 'category' AND account_code IS NOT NULL AND project_slug IS NULL) OR
    (scope = 'project'  AND project_slug IS NOT NULL AND account_code IS NULL) OR
    (scope = 'overall'  AND account_code IS NULL AND project_slug IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_budget_target ON acct_budgets
  (tenant_id, period_kind, scope, COALESCE(account_code,''), COALESCE(project_slug,'')) WHERE enabled;

-- Materialized spend-vs-budget per period, refreshed by budgets.ts. Lets the web app
-- and push-watcher read budget status without re-aggregating the whole ledger.
CREATE TABLE IF NOT EXISTS acct_budget_actuals (
  id            bigserial   PRIMARY KEY,
  budget_id     bigint      NOT NULL REFERENCES acct_budgets(id) ON DELETE CASCADE,
  tenant_id     text        NOT NULL DEFAULT 'ariel',
  period        text        NOT NULL,                          -- 'YYYY-MM' | 'YYYY-Qn' | 'YYYY'
  spent_cents   bigint      NOT NULL DEFAULT 0,
  limit_cents   bigint      NOT NULL DEFAULT 0,                -- snapshot of the limit at refresh time
  projected_cents bigint    NOT NULL DEFAULT 0,                -- run-rate projection to period end
  pct           numeric(6,2) NOT NULL DEFAULT 0,               -- spent / limit * 100
  computed_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (budget_id, period)
);
CREATE INDEX IF NOT EXISTS idx_budget_actuals_period ON acct_budget_actuals (period);

-- Alert thresholds per budget and when they last fired (so we notify once per crossing).
CREATE TABLE IF NOT EXISTS acct_budget_alerts (
  id            bigserial   PRIMARY KEY,
  budget_id     bigint      NOT NULL REFERENCES acct_budgets(id) ON DELETE CASCADE,
  tenant_id     text        NOT NULL DEFAULT 'ariel',
  threshold_pct numeric(6,2) NOT NULL DEFAULT 80,              -- fire at >= this pct of limit
  also_on_projected boolean NOT NULL DEFAULT true,             -- also fire if projection > limit
  channel       text        NOT NULL DEFAULT 'push' CHECK (channel IN ('push','email','both')),
  last_fired_period text,                                      -- the period for which we last fired
  last_fired_at timestamptz,
  enabled       boolean     NOT NULL DEFAULT true,
  UNIQUE (budget_id, threshold_pct)
);
