-- 007_documents.sql — universal receipt/document ingest + line-item splitting.
-- A document (PDF / photo / CSV / forwarded email) is parsed into line items, then
-- matched to an aggregate raw charge (e.g. the single APPLE.COM/BILL charge) and
-- split into a balanced multi-line journal entry that nets to the original amount.
-- Money is ALWAYS integer cents (BIGINT). Documents are evidence, not the ledger:
-- they drive postings via the existing ledger.post() path, never around it.

CREATE TABLE IF NOT EXISTS acct_documents (
  id            bigserial   PRIMARY KEY,
  tenant_id     text        NOT NULL DEFAULT 'ariel',
  source_kind   text        NOT NULL CHECK (source_kind IN ('email','upload','photo','csv','pdf')),
  origin        text,                                          -- forwarding address, filename, or sender
  storage_ref   text,                                          -- path/blob ref; the bytes live outside Postgres
  content_type  text,                                          -- mime type as received
  sha256        text        NOT NULL,                          -- dedupe: same bytes ingested twice = one row
  vendor_guess  text,                                          -- merchant the extractor believes issued it
  doc_date      date,                                          -- date on the receipt/invoice
  total_cents   bigint,                                        -- document grand total (signed positive)
  currency      text        NOT NULL DEFAULT 'usd',
  ocr_text      text,                                          -- raw extracted text (audit + re-extract)
  extracted_json jsonb,                                        -- structured extraction (lines, taxes, fees)
  status        text        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','extracted','matched','split','filed','unmatched','error')),
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT acct_documents_sha UNIQUE (tenant_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_documents_status ON acct_documents (status);
CREATE INDEX IF NOT EXISTS idx_documents_vendor ON acct_documents (vendor_guess);

-- One extracted line item from a document. candidate_account_code is the extractor's
-- best guess; matched flips true once the line is folded into a posted split.
CREATE TABLE IF NOT EXISTS acct_document_lines (
  id                    bigserial PRIMARY KEY,
  document_id           bigint    NOT NULL REFERENCES acct_documents(id) ON DELETE CASCADE,
  tenant_id             text      NOT NULL DEFAULT 'ariel',
  line_no               int       NOT NULL,
  description           text      NOT NULL,
  qty                   numeric(12,3) NOT NULL DEFAULT 1,
  amount_cents          bigint    NOT NULL,                    -- this line's total (signed positive)
  candidate_account_code text,                                 -- extractor's category guess (acct_chart.code)
  candidate_project_slug text,
  business_pct          numeric(5,2) NOT NULL DEFAULT 100.00,
  matched               boolean   NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_doclines_document ON acct_document_lines (document_id);

-- Links a document (and optionally a specific line) to the raw charge it explains
-- and the journal entry that posted the split. The Apple.com/Bill case: one row per
-- document pointing at the aggregate raw_txn_id, plus the split entry_id once posted.
CREATE TABLE IF NOT EXISTS acct_document_matches (
  id            bigserial   PRIMARY KEY,
  document_id   bigint      NOT NULL REFERENCES acct_documents(id) ON DELETE CASCADE,
  tenant_id     text        NOT NULL DEFAULT 'ariel',
  raw_txn_id    bigint      REFERENCES acct_transactions_raw(id) ON DELETE SET NULL,
  entry_id      bigint      REFERENCES acct_journal_entries(id) ON DELETE SET NULL,
  match_kind    text        NOT NULL DEFAULT 'split'
                CHECK (match_kind IN ('split','one_to_one','partial','manual')),
  delta_cents   bigint      NOT NULL DEFAULT 0,                -- doc total minus matched charge (0 = exact)
  confidence    numeric(4,3) NOT NULL DEFAULT 1.000,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_docmatch_document ON acct_document_matches (document_id);
CREATE INDEX IF NOT EXISTS idx_docmatch_raw ON acct_document_matches (raw_txn_id);
