-- 013_apple_history.sql — catalog of parsed Apple purchase-history line items.
-- Apple's "Report a Problem" / purchase-history export is bulk + regular (date /
-- order-id / Total / item groups). We parse it DETERMINISTICALLY (no LLM) into one
-- row per item so the advisor can spot subscriptions, and recent paid orders can be
-- matched + split against the aggregate APPLE.COM/BILL charges in the bank feed.
CREATE TABLE IF NOT EXISTS acct_apple_purchases (
  id            bigserial   PRIMARY KEY,
  tenant_id     text        NOT NULL DEFAULT 'ariel',
  order_id      text        NOT NULL,                 -- Apple order id (R..., MT..., MHK...)
  order_date    date        NOT NULL,
  line_no       int         NOT NULL,
  item          text        NOT NULL,                 -- the product/subscription name
  vendor        text,                                 -- the publisher/developer
  period        text,                                 -- "Renews ...", "Expires: ...", date range, etc.
  amount_cents  bigint      NOT NULL DEFAULT 0,        -- this line's price (0 = free)
  order_total_cents bigint  NOT NULL DEFAULT 0,        -- the order's grand total
  bucket        text        NOT NULL DEFAULT 'review'  -- business | personal | review | free
                CHECK (bucket IN ('business','personal','review','free')),
  account_code  text,                                 -- the classified chart code (when confident)
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT acct_apple_uq UNIQUE (tenant_id, order_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_apple_date ON acct_apple_purchases (order_date);
CREATE INDEX IF NOT EXISTS idx_apple_vendor ON acct_apple_purchases (vendor);
CREATE INDEX IF NOT EXISTS idx_apple_bucket ON acct_apple_purchases (bucket);
