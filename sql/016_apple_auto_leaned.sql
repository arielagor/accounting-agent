-- 016_apple_auto_leaned.sql
-- The Apple catalog reviewer can now, when GENUINELY UNSURE about a toss-up item, lean
-- it toward BUSINESS (deductible) instead of leaving it in 'review' (Ariel 2026-06-17),
-- matching the transaction auditor's tax-optimize behavior. Mark such auto-leaned rows so
-- they are easy to find + review; a human reclassification clears the flag. Additive +
-- idempotent.

ALTER TABLE acct_apple_purchases
  ADD COLUMN IF NOT EXISTS auto_leaned boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_apple_auto_leaned ON acct_apple_purchases (auto_leaned) WHERE auto_leaned;
