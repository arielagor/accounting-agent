-- 003_rules.sql — categorization: deterministic rules, learned overrides, LLM audit, review queue.

-- Tier (a): deterministic regex rules, evaluated by priority (low number first).
CREATE TABLE IF NOT EXISTS acct_categorization_rules (
  id              serial PRIMARY KEY,
  priority        int    NOT NULL DEFAULT 100,
  match_field     text   NOT NULL DEFAULT 'merchant' CHECK (match_field IN ('merchant','memo','source')),
  match_regex     text   NOT NULL,
  amount_min_cents bigint,
  amount_max_cents bigint,
  account_code    text   NOT NULL,
  project_slug    text,
  business_pct    numeric(5,2) NOT NULL DEFAULT 100.00,
  needs_split     boolean NOT NULL DEFAULT false,
  confidence      numeric(4,3) NOT NULL DEFAULT 1.000,
  enabled         boolean NOT NULL DEFAULT true,
  note            text
);
CREATE INDEX IF NOT EXISTS idx_catrules_priority ON acct_categorization_rules (priority) WHERE enabled;

-- Tier (b): learned overrides. Once a merchant is categorized, remember it.
CREATE TABLE IF NOT EXISTS acct_merchant_rules (
  id               serial PRIMARY KEY,
  merchant_key     text   UNIQUE NOT NULL,    -- normalized merchant
  account_code     text   NOT NULL,
  project_slug     text,
  business_pct     numeric(5,2) NOT NULL DEFAULT 100.00,
  needs_split      boolean NOT NULL DEFAULT false,
  times_seen       int    NOT NULL DEFAULT 1,
  last_confirmed_at timestamptz NOT NULL DEFAULT now(),
  learned_from     text   NOT NULL DEFAULT 'human' CHECK (learned_from IN ('human','llm_accepted'))
);

-- Tier (c): LLM proposals — audit trail + learning source.
CREATE TABLE IF NOT EXISTS acct_llm_decisions (
  id                   bigserial PRIMARY KEY,
  source_txn_id        text,
  merchant             text,
  amount_cents         bigint,
  memo                 text,
  proposed_account_code text,
  proposed_project_slug text,
  proposed_business_pct numeric(5,2),
  confidence           numeric(4,3),
  rationale            text,
  outcome              text NOT NULL DEFAULT 'pending'
                       CHECK (outcome IN ('pending','auto_posted','escalated','human_confirmed','human_overridden')),
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- Items needing a human decision. Surfaced in the digest; never block the close.
CREATE TABLE IF NOT EXISTS acct_review_queue (
  id            bigserial PRIMARY KEY,
  source_txn_id text   NOT NULL,
  reason        text   NOT NULL CHECK (reason IN ('low_confidence','needs_split','new_merchant','amount_anomaly')),
  proposed_json jsonb,
  status        text   NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  UNIQUE (source_txn_id)
);
CREATE INDEX IF NOT EXISTS idx_review_open ON acct_review_queue (status) WHERE status = 'open';
