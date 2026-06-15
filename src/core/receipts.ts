/**
 * Universal receipt/document ingest + auto-split. A document (PDF / photo / CSV /
 * forwarded email) flows through four stages, each a separate, idempotent function:
 *
 *   ingestDocument  → stage the bytes' metadata + sha256 (dedupe), status 'pending'
 *   extractDocument → LLM/parse into structured line items, status 'extracted'
 *   matchDocument   → find the aggregate raw charge it explains, status 'matched'
 *   splitCharge     → post a BALANCED multi-line split that nets to the charge,
 *                     resolve any quarantine on the aggregate, status 'split'
 *
 * The canonical case: one APPLE.COM/BILL charge (which the seed rules quarantine as
 * needs_split) gets a forwarded Apple receipt; we split it into its component apps/
 * subscriptions and post one entry that ties to the cent. Nothing is ever guessed:
 * an unmatched or out-of-tolerance document goes to 'unmatched' and files an
 * access-request rather than fabricating a split. Money is integer cents.
 */
import { createHash } from "node:crypto";
import type { Sql } from "./db.js";
import type {
  DocumentExtractor,
  DocumentExtractInput,
  DocumentSourceKind,
  ExtractedDocument,
  ExtractedLine,
  LlmCategorizeContext,
  AccountType,
} from "./types.js";
import { postEntry } from "./ledger.js";
import { buildSplitChargeEntry, type SplitLineInput } from "./posting.js";
import { normalizeMerchant } from "./categorize.js";
import { logAudit, requestAccess } from "./audit.js";

/** Default tolerance: a receipt whose total is within this of the charge can auto-split. */
const DEFAULT_TOLERANCE_CENTS = 200; // $2.00 absorbs tax/rounding noise; residual → suspense

export interface IngestInput {
  sourceKind: DocumentSourceKind;
  bytesOrText: string; // the raw content used for sha256 + (for text/csv) extraction
  origin?: string | null; // forwarding address, filename, sender
  contentType?: string | null;
  storageRef?: string | null;
}

export interface IngestResult {
  id: number;
  alreadyExisted: boolean;
}

/** Stage a document. Dedupe by sha256 of the content so the same forward twice = one row. */
export async function ingestDocument(
  sql: Sql,
  tenantId: string,
  input: IngestInput,
): Promise<IngestResult> {
  const sha = createHash("sha256").update(input.bytesOrText).digest("hex");
  const existing = await sql<{ id: number }[]>`
    SELECT id FROM acct_documents WHERE tenant_id = ${tenantId} AND sha256 = ${sha}
  `;
  if (existing.length > 0) return { id: existing[0]!.id, alreadyExisted: true };

  const [row] = await sql<{ id: number }[]>`
    INSERT INTO acct_documents (tenant_id, source_kind, origin, storage_ref, content_type, sha256, status)
    VALUES (${tenantId}, ${input.sourceKind}, ${input.origin ?? null}, ${input.storageRef ?? null},
            ${input.contentType ?? null}, ${sha}, 'pending')
    RETURNING id
  `;
  await logAudit(sql, tenantId, "receipts", "ingest_document", `doc:${row!.id}`, {
    sourceKind: input.sourceKind,
    origin: input.origin ?? null,
  });
  return { id: row!.id, alreadyExisted: false };
}

/** Load the active chart + projects as extractor context (so it proposes valid codes). */
async function loadContext(sql: Sql): Promise<LlmCategorizeContext> {
  const [chart, projects] = await Promise.all([
    sql<{ code: string; name: string; type: string }[]>`
      SELECT code, name, type FROM acct_chart WHERE is_active ORDER BY code`,
    sql<{ slug: string; name: string }[]>`
      SELECT slug, name FROM acct_projects WHERE status = 'active' ORDER BY slug`,
  ]);
  return {
    chart: chart.map((c) => ({ code: c.code, name: c.name, type: c.type as AccountType })),
    projects: projects.map((p) => ({ slug: p.slug, name: p.name })),
  };
}

/**
 * Extract structured line items from a staged document via the injected extractor.
 * Persists extracted_json + per-line rows and advances status to 'extracted' (or
 * 'error' on a failed extraction — never throws into a batch).
 */
export async function extractDocument(
  sql: Sql,
  tenantId: string,
  documentId: number,
  extractor: DocumentExtractor,
  raw: DocumentExtractInput,
): Promise<ExtractedDocument | null> {
  const ctx = await loadContext(sql);
  let result: ExtractedDocument;
  try {
    result = await extractor.extract(raw, ctx);
  } catch (e) {
    await sql`UPDATE acct_documents SET status = 'error', error = ${String(
      e instanceof Error ? e.message : e,
    )}, updated_at = now() WHERE id = ${documentId} AND tenant_id = ${tenantId}`;
    return null;
  }

  const total =
    result.totalCents ?? result.lines.reduce((a, l) => a + Math.abs(l.amountCents), 0);

  await sql.begin(async (tx) => {
    await tx`
      UPDATE acct_documents
      SET status = 'extracted', vendor_guess = ${result.vendorGuess},
          doc_date = ${result.docDate}, total_cents = ${total}, currency = ${result.currency},
          ocr_text = ${raw.ocrText ?? raw.csv ?? null},
          extracted_json = ${tx.json(result as unknown as Parameters<typeof tx.json>[0])},
          updated_at = now()
      WHERE id = ${documentId} AND tenant_id = ${tenantId}`;
    await tx`DELETE FROM acct_document_lines WHERE document_id = ${documentId}`;
    let lineNo = 1;
    for (const l of result.lines) {
      await tx`
        INSERT INTO acct_document_lines
          (document_id, tenant_id, line_no, description, qty, amount_cents,
           candidate_account_code, candidate_project_slug, business_pct)
        VALUES (${documentId}, ${tenantId}, ${lineNo}, ${l.description}, ${l.qty ?? 1},
                ${Math.abs(l.amountCents)}, ${l.candidateAccountCode ?? null},
                ${l.candidateProjectSlug ?? null}, ${l.businessPct ?? 100})`;
      lineNo += 1;
    }
  });
  await logAudit(sql, tenantId, "receipts", "extract_document", `doc:${documentId}`, {
    lines: result.lines.length,
    totalCents: total,
  });
  return result;
}

export interface MatchOptions {
  /** ± window in days around the document date to search for the charge. */
  dateWindowDays?: number;
  /** Max |docTotal - charge| to still call it a match. */
  toleranceCents?: number;
}

export interface MatchResult {
  matched: boolean;
  rawTxnId?: number;
  deltaCents?: number;
  confidence?: number;
}

/**
 * Find the aggregate raw charge this document explains: an OUTFLOW whose absolute
 * amount is closest to the document total, within tolerance, dated within the window,
 * and (when the vendor is known) sharing a normalized-merchant token. Writes an
 * acct_document_matches row and advances status to 'matched', or 'unmatched' +
 * an access-request when nothing ties.
 */
export async function matchDocument(
  sql: Sql,
  tenantId: string,
  documentId: number,
  opts: MatchOptions = {},
): Promise<MatchResult> {
  const windowDays = opts.dateWindowDays ?? 5;
  const tolerance = opts.toleranceCents ?? DEFAULT_TOLERANCE_CENTS;

  const docRows = await sql<
    { total_cents: string | null; doc_date: string | null; vendor_guess: string | null }[]
  >`SELECT total_cents, doc_date, vendor_guess FROM acct_documents WHERE id = ${documentId} AND tenant_id = ${tenantId}`;
  if (docRows.length === 0) return { matched: false };
  const doc = docRows[0]!;
  if (doc.total_cents === null || doc.doc_date === null) {
    await markUnmatched(sql, tenantId, documentId, "document has no total or date to match on");
    return { matched: false };
  }
  const total = Math.abs(Number(doc.total_cents));
  const vendorKey = doc.vendor_guess ? normalizeMerchant(doc.vendor_guess) : "";

  // Candidate outflows within the date window, ranked by amount closeness.
  const candidates = await sql<
    { id: number; amount_cents: string; merchant_name: string | null; description_raw: string | null }[]
  >`
    SELECT id, amount_cents, merchant_name, description_raw
    FROM acct_transactions_raw
    WHERE tenant_id = ${tenantId} AND amount_cents < 0
      AND posted_date BETWEEN (${doc.doc_date}::date - ${windowDays}::int)
                          AND (${doc.doc_date}::date + ${windowDays}::int)
    ORDER BY abs(abs(amount_cents) - ${total}) ASC
    LIMIT 10
  `;

  let best: { id: number; delta: number; vendorHit: boolean } | null = null;
  for (const c of candidates) {
    const charge = Math.abs(Number(c.amount_cents));
    const delta = Math.abs(charge - total);
    if (delta > tolerance) continue;
    const merchKey = normalizeMerchant(c.merchant_name ?? c.description_raw ?? "");
    const vendorHit = vendorKey.length > 0 && (merchKey.includes(vendorKey) || vendorKey.includes(merchKey));
    // Prefer a vendor-name hit, then the smallest amount delta.
    if (
      best === null ||
      (vendorHit && !best.vendorHit) ||
      (vendorHit === best.vendorHit && delta < best.delta)
    ) {
      best = { id: c.id, delta, vendorHit };
    }
  }

  if (best === null) {
    await markUnmatched(
      sql,
      tenantId,
      documentId,
      `no charge within ${tolerance}c and ${windowDays}d of the document`,
    );
    return { matched: false };
  }

  const confidence = best.vendorHit ? (best.delta === 0 ? 1.0 : 0.9) : best.delta === 0 ? 0.8 : 0.6;
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO acct_document_matches (document_id, tenant_id, raw_txn_id, match_kind, delta_cents, confidence)
      VALUES (${documentId}, ${tenantId}, ${best!.id}, 'split', ${best!.delta}, ${confidence})`;
    await tx`UPDATE acct_documents SET status = 'matched', updated_at = now()
             WHERE id = ${documentId} AND tenant_id = ${tenantId}`;
  });
  await logAudit(sql, tenantId, "receipts", "match_document", `doc:${documentId}`, {
    rawTxnId: best.id,
    deltaCents: best.delta,
    confidence,
  });
  return { matched: true, rawTxnId: best.id, deltaCents: best.delta, confidence };
}

async function markUnmatched(
  sql: Sql,
  tenantId: string,
  documentId: number,
  reason: string,
): Promise<void> {
  await sql`UPDATE acct_documents SET status = 'unmatched', error = ${reason}, updated_at = now()
           WHERE id = ${documentId} AND tenant_id = ${tenantId}`;
  await requestAccess(
    sql,
    tenantId,
    {
      resource: `receipt_match:doc:${documentId}`,
      reason: `Could not auto-match this receipt to a bank/card charge: ${reason}`,
      howToGrant:
        "Open the Receipts screen and either pick the matching charge manually, or confirm the receipt has no corresponding charge yet.",
      requestedForTxn: `doc:${documentId}`,
    },
    "receipts",
  );
}

export interface SplitOptions {
  toleranceCents?: number;
  suspenseAccountCode?: string;
}

export interface SplitResult {
  posted: boolean;
  entryId?: number;
  reason?: string;
}

/**
 * Post the balanced split for a matched document. Voids any prior single-line posting
 * of the aggregate charge (e.g. a coarse auto-categorization), posts one entry whose
 * component debits + residual tie exactly to the charge credit, resolves the
 * aggregate's review-queue quarantine, and advances the document to 'split'. Refuses
 * (no post) when the document total is outside tolerance of the charge — that needs
 * a human, not a fabricated split.
 */
export async function splitCharge(
  sql: Sql,
  tenantId: string,
  documentId: number,
  opts: SplitOptions = {},
): Promise<SplitResult> {
  const tolerance = opts.toleranceCents ?? DEFAULT_TOLERANCE_CENTS;

  const m = await sql<{ raw_txn_id: number | null; delta_cents: string }[]>`
    SELECT raw_txn_id, delta_cents FROM acct_document_matches
    WHERE document_id = ${documentId} AND tenant_id = ${tenantId}
    ORDER BY id DESC LIMIT 1`;
  if (m.length === 0 || m[0]!.raw_txn_id === null) {
    return { posted: false, reason: "no matched charge; run matchDocument first" };
  }
  if (Math.abs(Number(m[0]!.delta_cents)) > tolerance) {
    return { posted: false, reason: "document total outside tolerance of the charge" };
  }
  const rawId = m[0]!.raw_txn_id!;

  // The charge + the card/bank it was paid from.
  const chargeRows = await sql<
    { amount_cents: string; posted_date: string | null; merchant_name: string | null; ledger_code: string | null }[]
  >`
    SELECT r.amount_cents, r.posted_date, r.merchant_name, sa.ledger_account_code AS ledger_code
    FROM acct_transactions_raw r JOIN acct_source_accounts sa ON sa.id = r.source_account_id
    WHERE r.id = ${rawId} AND r.tenant_id = ${tenantId}`;
  if (chargeRows.length === 0) return { posted: false, reason: "matched charge not found" };
  const charge = chargeRows[0]!;
  if (!charge.ledger_code) return { posted: false, reason: "charge source account unmapped" };
  const chargeCents = Math.abs(Number(charge.amount_cents));
  const sourceTxnId = `raw:${rawId}`;

  // The component lines. Unknown candidate codes fall back to 9000 suspense (flagged),
  // never guessed into a real category.
  const lineRows = await sql<
    { description: string; amount_cents: string; candidate_account_code: string | null; candidate_project_slug: string | null; business_pct: string }[]
  >`SELECT description, amount_cents, candidate_account_code, candidate_project_slug, business_pct
    FROM acct_document_lines WHERE document_id = ${documentId} ORDER BY line_no`;
  if (lineRows.length === 0) return { posted: false, reason: "no extracted lines to split" };

  const validCodes = new Set(
    (await sql<{ code: string }[]>`SELECT code FROM acct_chart WHERE is_active`).map((r) => r.code),
  );
  const splitLines: SplitLineInput[] = lineRows.map((l) => {
    const code =
      l.candidate_account_code && validCodes.has(l.candidate_account_code)
        ? l.candidate_account_code
        : "9000";
    return {
      expenseAccountCode: code,
      projectSlug: l.candidate_project_slug,
      amountCents: Math.abs(Number(l.amount_cents)),
      businessPct: Number(l.business_pct),
      memo: l.description,
    };
  });

  const componentsTotal = splitLines.reduce((a, l) => a + Math.abs(l.amountCents), 0);
  if (componentsTotal > chargeCents) {
    return { posted: false, reason: "extracted components exceed the charge" };
  }

  const entry = buildSplitChargeEntry({
    entryDate: charge.posted_date ?? new Date().toISOString().slice(0, 10),
    idempotencyKey: `${sourceTxnId}:split`,
    sourceTxnId,
    chargeCents,
    paidFromAccountCode: charge.ledger_code,
    lines: splitLines,
    suspenseAccountCode: opts.suspenseAccountCode ?? "9000",
    memo: `${charge.merchant_name ?? "charge"} (receipt split, doc ${documentId})`,
  });
  entry.createdBy = "engine";

  // Sequential, idempotent steps (postEntry manages its own transaction, so it can't
  // be nested inside an outer begin — same pattern as resolve.ts). Each step is safe
  // to re-run: the void is conditional, postEntry dedupes by idempotency key, and the
  // updates are set-to-final-state.
  // Void any prior non-void posting of the aggregate so we don't double-count.
  await sql`UPDATE acct_journal_entries SET status = 'void'
           WHERE tenant_id = ${tenantId} AND source_txn_id = ${sourceTxnId}
             AND idempotency_key <> ${entry.idempotencyKey} AND status <> 'void'`;
  const posted = await postEntry(sql, tenantId, entry);
  // Resolve the aggregate's quarantine (the APPLE.COM/BILL needs_split row).
  await sql`UPDATE acct_review_queue SET status = 'resolved', resolved_at = now()
           WHERE source_txn_id = ${sourceTxnId} AND status = 'open'`;
  await sql`UPDATE acct_document_lines SET matched = true WHERE document_id = ${documentId}`;
  await sql`UPDATE acct_document_matches SET entry_id = ${posted.id}
           WHERE document_id = ${documentId} AND raw_txn_id = ${rawId}`;
  await sql`UPDATE acct_documents SET status = 'split', updated_at = now()
           WHERE id = ${documentId} AND tenant_id = ${tenantId}`;
  const entryId = posted.id;

  await logAudit(sql, tenantId, "receipts", "split_charge", sourceTxnId, {
    documentId,
    entryId,
    components: splitLines.length,
    chargeCents,
  });
  return { posted: true, entryId };
}

/** Convenience: run extract → match → split for one document, stopping at the first refusal. */
export async function processDocument(
  sql: Sql,
  tenantId: string,
  documentId: number,
  extractor: DocumentExtractor,
  raw: DocumentExtractInput,
  opts: MatchOptions & SplitOptions = {},
): Promise<{ stage: string; result: ExtractedDocument | MatchResult | SplitResult | null }> {
  const extracted = await extractDocument(sql, tenantId, documentId, extractor, raw);
  if (!extracted) return { stage: "extract", result: null };
  const match = await matchDocument(sql, tenantId, documentId, opts);
  if (!match.matched) return { stage: "match", result: match };
  const split = await splitCharge(sql, tenantId, documentId, opts);
  return { stage: "split", result: split };
}

/** Re-export so callers building extractors can shape lines without importing types deeply. */
export type { ExtractedLine };
