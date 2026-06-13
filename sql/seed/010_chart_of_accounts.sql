-- 010_chart_of_accounts.sql — solo-founder multi-product chart. Idempotent.
-- code | name | type | normal_side | schedule_c_line | tax_treatment | is_business

INSERT INTO acct_chart (code, name, type, normal_side, schedule_c_line, tax_treatment, is_business) VALUES
  -- ASSETS (1000–1999) — normal side debit
  ('1010','Business Checking','asset','debit',NULL,'ordinary',true),
  ('1020','Business Savings','asset','debit',NULL,'ordinary',true),
  ('1090','Stripe Balance (in transit)','asset','debit',NULL,'ordinary',true),
  ('1100','Undeposited Funds','asset','debit',NULL,'ordinary',true),
  ('1600','Computer & Equipment','asset','debit',NULL,'capital',true),
  ('1610','Accumulated Depreciation','asset','credit',NULL,'capital',true),
  ('1900','Owner Personal Checking (mixed)','asset','debit',NULL,'personal',false),
  -- LIABILITIES (2000–2999) — normal side credit; one account per card
  ('2010','Credit Card — Primary','liability','credit',NULL,'ordinary',true),
  ('2020','Credit Card — Secondary','liability','credit',NULL,'ordinary',true),
  ('2030','Credit Card — Amex','liability','credit',NULL,'ordinary',true),
  ('2100','Sales Tax Payable','liability','credit',NULL,'ordinary',true),
  ('2200','Contractor Payables','liability','credit',NULL,'ordinary',true),
  ('2300','Estimated Tax Payable — Federal','liability','credit',NULL,'nondeductible',false),
  ('2310','Estimated Tax Payable — CA','liability','credit',NULL,'nondeductible',false),
  -- EQUITY (3000–3999) — normal side credit
  ('3000','Owner''s Equity','equity','credit',NULL,'ordinary',false),
  ('3100','Owner''s Draw','equity','debit',NULL,'personal',false),
  ('3200','Owner''s Contribution','equity','credit',NULL,'ordinary',false),
  ('3900','Retained Earnings','equity','credit',NULL,'ordinary',false),
  -- REVENUE (4000–4999) — one per product; normal side credit; Schedule C Part I line 1
  ('4010','Revenue — agor.me consulting','revenue','credit','1','ordinary',true),
  ('4015','Revenue — agor.me voice','revenue','credit','1','ordinary',true),
  ('4020','Revenue — Agor Agents (app.agor.me)','revenue','credit','1','ordinary',true),
  ('4030','Revenue — Agor Supervisor (app.mvat.ai)','revenue','credit','1','ordinary',true),
  ('4035','Revenue — AI Visibility Audit','revenue','credit','1','ordinary',true),
  ('4040','Revenue — MVAT Focus IAP','revenue','credit','1','ordinary',true),
  ('4050','Revenue — modelstack.digital','revenue','credit','1','ordinary',true),
  ('4060','Revenue — scored.tools affiliate','revenue','credit','1','ordinary',true),
  ('4070','Revenue — gifloop','revenue','credit','1','ordinary',true),
  ('4090','Revenue — other / uncategorized','revenue','credit','1','ordinary',true),
  ('4900','Sales Returns & Refunds','revenue','debit','2','ordinary',true),
  -- COGS (5000–5999) — normal side debit
  ('5010','Payment Processing Fees','cogs','debit','10','ordinary',true),
  ('5020','IAP Platform Fee (Apple/Google)','cogs','debit','10','ordinary',true),
  ('5030','Direct API / Inference Cost','cogs','debit','38','ordinary',true),
  -- OPERATING EXPENSES (6000–7999) — normal side debit; each maps to a Schedule C line
  ('6010','Advertising & Marketing','expense','debit','8','ordinary',true),
  ('6020','Contract Labor (1099)','expense','debit','11','ordinary',true),
  ('6030','Commissions & Fees','expense','debit','10','ordinary',true),
  ('6040','Depreciation & Section 179','expense','debit','13','capital',true),
  ('6050','Insurance (business)','expense','debit','15','ordinary',true),
  ('6060','Legal & Professional','expense','debit','17','ordinary',true),
  ('6070','Office Expense','expense','debit','18','ordinary',true),
  ('6080','Rent/Lease — Equipment','expense','debit','20a','ordinary',true),
  ('6090','Repairs & Maintenance','expense','debit','21','ordinary',true),
  ('6100','Supplies','expense','debit','22','ordinary',true),
  ('6110','Taxes & Licenses','expense','debit','23','ordinary',true),
  ('6120','Travel','expense','debit','24a','ordinary',true),
  ('6130','Meals','expense','debit','24b','meals_50',true),
  ('6140','Utilities','expense','debit','25','ordinary',true),
  ('6150','Software & SaaS Subscriptions','expense','debit','27a','ordinary',true),
  ('6160','Hosting & Cloud','expense','debit','27a','ordinary',true),
  ('6170','Domains & DNS','expense','debit','27a','ordinary',true),
  ('6180','Dues & Memberships','expense','debit','27a','ordinary',true),
  ('6190','Bank & Merchant Charges','expense','debit','27a','ordinary',true),
  ('6200','Education & Training','expense','debit','27a','ordinary',true),
  ('6900','Business Use of Car (mileage)','expense','debit','9','mileage',true),
  ('6950','Home Office (Form 8829)','expense','debit','30','home_office',true),
  -- OTHER (8000–8999)
  ('8010','Interest Income','other','credit',NULL,'ordinary',false),
  ('8020','Interest Expense','other','debit','16b','ordinary',true),
  ('8090','Gain/Loss on Disposal','other','credit',NULL,'capital',true),
  -- TAX / CLEARING / SUSPENSE (9000–9999)
  ('9000','Suspense — Unreviewed','expense','debit',NULL,'nondeductible',false),
  ('9100','Inter-account Transfer Clearing','asset','debit',NULL,'ordinary',false),
  ('9500','Personal — Non-deductible','expense','debit',NULL,'personal',false),
  ('9900','Opening Balance Equity','equity','credit',NULL,'ordinary',false)
ON CONFLICT (code) DO NOTHING;
