-- 019_ap_code_fix.sql — move Accounts Payable to 2080 (additive, idempotent).
-- Real account-linking assigned code 2050 to a Citi Costco card, colliding with the
-- SMB layer's original AP default (2050). AP now lives at 2080 (free liability code);
-- 018 was edited to match for fresh DBs, and this file adds 2080 to already-migrated
-- DBs (where 018 had already run and could not re-insert). The SMB posting builders
-- default to 2080. Leaves any pre-existing 2050 mapping (the card) untouched.
INSERT INTO acct_chart (code, name, type, normal_side, schedule_c_line, tax_treatment, is_business) VALUES
  ('2080','Accounts Payable','liability','credit',NULL,'ordinary',true)
ON CONFLICT (code) DO NOTHING;
