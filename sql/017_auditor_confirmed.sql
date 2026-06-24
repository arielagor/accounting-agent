-- 017_auditor_confirmed.sql
-- The aggregate "what the agent did on your behalf" review (Ariel 2026-06-23): the owner
-- reviews every position the agent took (tax-optimized posts) before filing and CONFIRMS
-- the set. Record the confirmation so a position drops off the "needs your eyes" list once
-- you've signed off on it. Additive + idempotent.

ALTER TABLE acct_auditor_decisions
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_auditor_unconfirmed
  ON acct_auditor_decisions (tenant_id, basis)
  WHERE confirmed_at IS NULL;
