-- 004_allocation.sql — shared-cost allocation across projects.

CREATE TABLE IF NOT EXISTS acct_allocation_rules (
  id                  serial PRIMARY KEY,
  name                text   NOT NULL,
  match_account_code  text,
  match_merchant_regex text,
  method              text   NOT NULL CHECK (method IN ('direct','even','revenue_weighted','usage_weighted','fixed_percent')),
  basis_window        text   NOT NULL DEFAULT 'trailing_3m',  -- trailing_3m | prior_month | ytd
  enabled             boolean NOT NULL DEFAULT true,
  note                text
);

CREATE TABLE IF NOT EXISTS acct_allocation_targets (
  id            serial PRIMARY KEY,
  rule_id       int    NOT NULL REFERENCES acct_allocation_rules(id) ON DELETE CASCADE,
  project_slug  text   NOT NULL,
  fixed_percent numeric(6,3),     -- method = fixed_percent
  usage_weight  numeric(10,3)     -- method = usage_weighted (static weight; or use metrics)
);

-- Usage metrics that drive usage_weighted allocation (token share, bandwidth, etc.).
CREATE TABLE IF NOT EXISTS acct_usage_metrics (
  project_slug  text   NOT NULL,
  metric        text   NOT NULL,        -- 'claude_tokens', 'netlify_bandwidth_gb', ...
  fiscal_year   int    NOT NULL,
  fiscal_month  int    NOT NULL,
  value         numeric(14,3) NOT NULL DEFAULT 0,
  PRIMARY KEY (project_slug, metric, fiscal_year, fiscal_month)
);
