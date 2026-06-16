-- 018_smb_accounts.sql — chart accounts the SMB layer (AR/AP/payroll) posts to.
-- Additive + idempotent. AR is debit-normal asset; AP and payroll liabilities are
-- credit-normal; wages/employer-tax are Schedule C expense lines.
INSERT INTO acct_chart (code, name, type, normal_side, schedule_c_line, tax_treatment, is_business) VALUES
  ('1200','Accounts Receivable','asset','debit',NULL,'ordinary',true),
  ('2080','Accounts Payable','liability','credit',NULL,'ordinary',true),
  ('2110','Payroll Withholdings Payable','liability','credit',NULL,'ordinary',true),
  ('2120','Employer Payroll Taxes Payable','liability','credit',NULL,'ordinary',true),
  ('6210','Wages & Salaries','expense','debit','26','ordinary',true),
  ('6220','Employer Payroll Taxes','expense','debit','23','ordinary',true)
ON CONFLICT (code) DO NOTHING;
