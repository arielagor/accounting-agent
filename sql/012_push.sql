-- 012_push.sql — Web Push subscriptions for the PWA (realtime budget/auditor alerts).
-- One row per browser/device push subscription, per tenant. The VAPID keypair lives
-- in env (never in the DB). Money is unrelated here; this is purely delivery plumbing.
CREATE TABLE IF NOT EXISTS acct_push_subscriptions (
  id          bigserial   PRIMARY KEY,
  tenant_id   text        NOT NULL DEFAULT 'ariel',
  endpoint    text        NOT NULL,
  p256dh      text        NOT NULL,
  auth        text        NOT NULL,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_ok_at  timestamptz,
  CONSTRAINT acct_push_uq UNIQUE (tenant_id, endpoint)
);
