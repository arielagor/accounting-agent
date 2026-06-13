-- 013_allocation_rules.sql — shared-cost allocation rules + targets. Idempotent via migration tracking.

-- Netlify hosting: even split across the sites it serves.
WITH r AS (
  INSERT INTO acct_allocation_rules (name, match_account_code, match_merchant_regex, method, basis_window, note)
  VALUES ('Netlify hosting even-split', '6160', '(?i)netlify', 'even', 'prior_month', 'seed:netlify-even')
  RETURNING id
)
INSERT INTO acct_allocation_targets (rule_id, project_slug)
SELECT id, slug FROM r CROSS JOIN (VALUES ('agor_agents'),('modelstack'),('scored_tools'),('agor_me')) AS t(slug);

-- Claude Max plan: usage-weighted by claude_tokens metric (falls back to even if no usage that month).
WITH r AS (
  INSERT INTO acct_allocation_rules (name, match_account_code, match_merchant_regex, method, basis_window, note)
  VALUES ('Claude Max usage-weighted', '6150', '(?i)anthropic|claude', 'usage_weighted', 'prior_month', 'seed:claude-usage')
  RETURNING id
)
INSERT INTO acct_allocation_targets (rule_id, project_slug, usage_weight)
SELECT id, slug, w FROM r CROSS JOIN (VALUES
  ('mvat_focus', 50.0), ('agor_supervisor', 30.0), ('agor_me', 15.0), ('modelstack', 5.0)
) AS t(slug, w);

-- Firebase: split between the two apps that use it.
WITH r AS (
  INSERT INTO acct_allocation_rules (name, match_account_code, match_merchant_regex, method, basis_window, note)
  VALUES ('Firebase fixed-percent', '6160', '(?i)firebase|google\\s*cloud', 'fixed_percent', 'prior_month', 'seed:firebase-fixed')
  RETURNING id
)
INSERT INTO acct_allocation_targets (rule_id, project_slug, fixed_percent)
SELECT id, slug, p FROM r CROSS JOIN (VALUES ('mvat_focus', 70.0), ('aphor_me', 30.0)) AS t(slug, p);

-- Apple Developer membership: even across the iOS apps.
WITH r AS (
  INSERT INTO acct_allocation_rules (name, match_account_code, match_merchant_regex, method, basis_window, note)
  VALUES ('Apple Developer even-split', '6110', '(?i)apple.*developer', 'even', 'ytd', 'seed:apple-dev-even')
  RETURNING id
)
INSERT INTO acct_allocation_targets (rule_id, project_slug)
SELECT id, slug FROM r CROSS JOIN (VALUES ('mvat_focus'),('gifloop')) AS t(slug);
