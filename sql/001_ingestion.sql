-- 001_ingestion.sql — read-only bank/card ingestion staging.
-- Money is ALWAYS integer cents (BIGINT). No floats anywhere in the ledger.

-- One row per linked institution login (a SimpleFIN/Plaid "connection").
CREATE TABLE IF NOT EXISTS acct_connections (
  id                    bigserial PRIMARY KEY,
  tenant_id             text        NOT NULL DEFAULT 'ariel',
  provider              text        NOT NULL,                 -- 'simplefin' | 'plaid'
  institution_name      text,
  external_item_id      text,                                 -- Plaid item_id (null for SimpleFIN)
  access_token_enc      text        NOT NULL,                 -- AES-256-GCM blob (token-store format)
  sync_cursor           text,                                 -- provider incremental cursor
  status                text        NOT NULL DEFAULT 'active', -- active | login_required | error | revoked
  consecutive_failures  int         NOT NULL DEFAULT 0,
  last_synced_at        timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- One row per account inside a connection (checking, savings, a specific card).
CREATE TABLE IF NOT EXISTS acct_source_accounts (
  id                    bigserial PRIMARY KEY,
  connection_id         bigint      NOT NULL REFERENCES acct_connections(id) ON DELETE CASCADE,
  tenant_id             text        NOT NULL DEFAULT 'ariel',
  provider_account_id   text        NOT NULL,                 -- provider's stable account id
  name                  text,
  mask                  text,                                 -- last 4
  type                  text,                                 -- depository | credit | ...
  subtype               text,                                 -- checking | savings | credit card
  currency              text        NOT NULL DEFAULT 'usd',
  is_stripe_payout_dest boolean     NOT NULL DEFAULT false,   -- Stripe deposits land here
  ledger_account_code   text,                                 -- maps to acct_chart.code (asset/liability)
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, provider_account_id)
);

-- RAW staging. Append-mostly, dedup-keyed. The immutable source of truth for ingestion.
CREATE TABLE IF NOT EXISTS acct_transactions_raw (
  id                    bigserial PRIMARY KEY,
  source_account_id     bigint      NOT NULL REFERENCES acct_source_accounts(id) ON DELETE CASCADE,
  tenant_id             text        NOT NULL DEFAULT 'ariel',
  provider              text        NOT NULL,
  provider_txn_id       text        NOT NULL,                 -- provider's stable txn id
  dedup_key             text        NOT NULL,                 -- stable across re-runs + pending->posted
  amount_cents          bigint      NOT NULL,                 -- signed; sign convention normalized in adapter
  currency              text        NOT NULL DEFAULT 'usd',
  posted_date           date,
  authorized_date       date,
  pending               boolean     NOT NULL DEFAULT false,
  description_raw       text,
  merchant_name         text,
  category_provider     text,
  raw_json              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ingested_at           timestamptz NOT NULL DEFAULT now(),
  superseded_at         timestamptz,
  CONSTRAINT acct_txn_dedup UNIQUE (tenant_id, provider, dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_raw_account_date ON acct_transactions_raw (source_account_id, posted_date);
CREATE INDEX IF NOT EXISTS idx_raw_pending ON acct_transactions_raw (pending) WHERE pending;
CREATE INDEX IF NOT EXISTS idx_raw_posted_date ON acct_transactions_raw (posted_date);

-- Reconciliation overlay: decisions live here; raw stays immutable.
CREATE TABLE IF NOT EXISTS acct_recon (
  id                    bigserial PRIMARY KEY,
  raw_txn_id            bigint      NOT NULL REFERENCES acct_transactions_raw(id) ON DELETE CASCADE,
  tenant_id             text        NOT NULL DEFAULT 'ariel',
  match_type            text,                                 -- stripe_payout | card_payment_transfer | internal_transfer | expense | revenue | unmatched
  matched_ref           text,                                 -- Stripe payout id, or paired raw_txn_id for transfers
  confidence            numeric(4,3),
  status                text        NOT NULL DEFAULT 'auto',  -- auto | needs_review | confirmed | rejected
  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recon_raw ON acct_recon (raw_txn_id);
CREATE INDEX IF NOT EXISTS idx_recon_status ON acct_recon (status);

-- Sync run log (observability + audit trail).
CREATE TABLE IF NOT EXISTS acct_sync_runs (
  id            bigserial PRIMARY KEY,
  tenant_id     text        NOT NULL DEFAULT 'ariel',
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  added         int         NOT NULL DEFAULT 0,
  modified      int         NOT NULL DEFAULT 0,
  removed       int         NOT NULL DEFAULT 0,
  escalations   int         NOT NULL DEFAULT 0,
  error         text
);
