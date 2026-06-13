-- 015_accrued_liabilities.sql — accounts the accrual engine posts against. Idempotent.

INSERT INTO acct_chart (code, name, type, normal_side, schedule_c_line, tax_treatment, is_business) VALUES
  ('2250','Accrued Liabilities','liability','credit',NULL,'ordinary',true),
  ('2260','Prepaid Expenses (asset)','asset','debit',NULL,'ordinary',true)
ON CONFLICT (code) DO NOTHING;
