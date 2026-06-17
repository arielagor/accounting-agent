-- 015_auditor_tax_optimized.sql
-- The auditor can now, when GENUINELY UNSURE about an otherwise-safe transaction,
-- pick the most tax-beneficial *defensible* account instead of parking it for a human.
-- Such a decision is recorded with basis 'tax_optimized'. Widen the basis CHECK to
-- allow it. Additive + idempotent; the hard human-gates (aggressive deductions,
-- large amounts, needs-access) are unchanged and still escalate.

ALTER TABLE acct_auditor_decisions
  DROP CONSTRAINT IF EXISTS acct_auditor_decisions_basis_check;

ALTER TABLE acct_auditor_decisions
  ADD CONSTRAINT acct_auditor_decisions_basis_check
  CHECK (basis IN ('rule','learned','llm','council','research','human','tax_optimized'));
