-- 014_tax_rates_2026.sql — year-scoped rate parameters (cents). PLANNING ESTIMATES.
-- These are reviewed by a CPA before filing; the tax engine never hard-codes a rate.
-- Brackets: array of [lower_bound_cents, marginal_rate], ascending.

INSERT INTO acct_tax_rates (tax_year, jurisdiction, kind, param_json) VALUES
  (2026, 'federal', 'se_tax', '{
    "ss_rate": 0.124, "medicare_rate": 0.029,
    "ss_wage_base_cents": 18200000,
    "net_se_factor": 0.9235,
    "addl_medicare_rate": 0.009, "addl_medicare_threshold_cents": 20000000
  }'::jsonb),
  (2026, 'federal', 'std_deduction', '{
    "single": 1550000, "mfj": 3100000, "mfs": 1550000, "hoh": 2330000
  }'::jsonb),
  (2026, 'federal', 'income_bracket', '{
    "single": [[0,0.10],[1192500,0.12],[4847500,0.22],[10335000,0.24],[19730000,0.32],[25052500,0.35],[62635000,0.37]],
    "mfj":    [[0,0.10],[2385000,0.12],[9695000,0.22],[20670000,0.24],[39460000,0.32],[50105000,0.35],[75160000,0.37]]
  }'::jsonb),
  (2026, 'federal', 'qbi', '{"rate": 0.20}'::jsonb),
  (2026, 'federal', 'corp_rate', '{"rate": 0.21}'::jsonb),
  (2026, 'federal', 'mileage', '{"rate_cents_per_mile": 70}'::jsonb),
  (2026, 'federal', 'home_office_simplified', '{"rate_cents_per_sqft": 500, "max_sqft": 300}'::jsonb),
  (2026, 'federal', 'section_179', '{"max_cents": 125000000}'::jsonb),
  (2026, 'CA', 'income_bracket', '{
    "single": [[0,0.01],[1075600,0.02],[2549900,0.04],[4024500,0.06],[5586600,0.08],[7060600,0.093],[36065900,0.103],[43278700,0.113],[72131400,0.123]],
    "mfj":    [[0,0.01],[2151200,0.02],[5099800,0.04],[8049000,0.06],[11173200,0.08],[14121200,0.093],[72131800,0.103],[86557400,0.113],[144262800,0.123]]
  }'::jsonb),
  (2026, 'CA', 'std_deduction', '{"single": 560000, "mfj": 1120000, "mfs": 560000, "hoh": 1120000}'::jsonb),
  (2026, 'CA', 'corp_rate', '{"rate": 0.0884, "min_franchise_cents": 80000}'::jsonb),
  (2026, 'CA', 'llc_fee', '{
    "annual_tax_cents": 80000,
    "fee_tiers": [[25000000,0],[50000000,90000],[100000000,250000],[500000000,600000],[999999999900,1179000]]
  }'::jsonb)
ON CONFLICT (tax_year, jurisdiction, kind) DO NOTHING;
