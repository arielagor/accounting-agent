-- 011_auditor.sql — the autonomous auditor's decision trail, access-request queue,
-- and the append-only audit log (the trust spine). The auditor auto-acts when
-- confident, escalates to the /council when in doubt, and — when it lacks data it
-- needs — files a structured access-request for a human to grant with one tap,
-- rather than guessing or silently stalling.

-- Every auditor verdict, regardless of basis. Auto-posted decisions, council
-- escalations, and access-gated deferrals all leave a row here.
CREATE TABLE IF NOT EXISTS acct_auditor_decisions (
  id            bigserial   PRIMARY KEY,
  tenant_id     text        NOT NULL DEFAULT 'ariel',
  source_txn_id text        NOT NULL,                          -- 'raw:<id>' convention
  verdict       text        NOT NULL
                CHECK (verdict IN ('auto_posted','quarantined','escalated','deferred_access','overridden')),
  account_code  text,                                          -- the chosen account (when decided)
  project_slug  text,
  business_pct  numeric(5,2),
  confidence    numeric(4,3) NOT NULL DEFAULT 0,
  basis         text        NOT NULL
                CHECK (basis IN ('rule','learned','llm','council','research','human')),
  rationale     text,
  council_ref   text,                                          -- council transcript / decision id
  access_request_id bigint,                                    -- set when deferred pending access
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auditor_txn ON acct_auditor_decisions (source_txn_id);
CREATE INDEX IF NOT EXISTS idx_auditor_verdict ON acct_auditor_decisions (verdict);

-- A research agent's request for access it doesn't have but needs. Surfaced to the
-- user as a one-tap grant. The agent NEVER self-grants; status moves only by a human
-- (or an explicit grant flow), never by the agent.
CREATE TABLE IF NOT EXISTS acct_access_requests (
  id            bigserial   PRIMARY KEY,
  tenant_id     text        NOT NULL DEFAULT 'ariel',
  resource      text        NOT NULL,                          -- e.g. 'apple_receipts_inbox', 'stripe_account', 'plaid_link:chase'
  reason        text        NOT NULL,                          -- why the agent needs it, in plain language
  how_to_grant  text        NOT NULL,                          -- exact steps the user takes to grant it
  requested_for_txn text,                                      -- the txn that triggered the need (optional)
  status        text        NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','granted','denied','expired')),
  granted_at    timestamptz,
  granted_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- One open request per (resource, txn) so a re-run doesn't spam duplicates.
  CONSTRAINT acct_access_req_uq UNIQUE (tenant_id, resource, requested_for_txn)
);
CREATE INDEX IF NOT EXISTS idx_access_status ON acct_access_requests (status);

-- Append-only audit log: every state change in the system (who/agent, what, when).
-- The trust spine — never UPDATEd or DELETEd in normal operation.
CREATE TABLE IF NOT EXISTS acct_audit_log (
  id            bigserial   PRIMARY KEY,
  tenant_id     text        NOT NULL DEFAULT 'ariel',
  actor         text        NOT NULL,                          -- 'auditor' | 'human' | 'engine' | 'council' | 'research'
  action        text        NOT NULL,                          -- e.g. 'auto_post', 'escalate', 'grant_access', 'manual_recat'
  subject       text,                                          -- the txn/entry/document the action touched
  detail_json   jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_subject ON acct_audit_log (subject);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON acct_audit_log (actor);
CREATE INDEX IF NOT EXISTS idx_audit_created ON acct_audit_log (created_at);
