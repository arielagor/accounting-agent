/**
 * Human reply-verb parsing → acct_resolution rows.
 *
 * A close run that hits an undecidable transaction (low-confidence categorize, a
 * needed split, an AJE awaiting approval, an ambiguous match) escalates it to a
 * human. The human answers IN PLAIN TEXT — an email reply or a dashboard line —
 * using a tiny verb grammar. This module turns those lines into structured
 * `acct_resolution` rows; the NEXT close run consumes them and applies the human's
 * decisions deterministically.
 *
 * The parser is PURE and forgiving: any line that does not match a known verb is
 * dropped (returns null), so signatures, quoted text, and chatter in a reply body
 * are ignored rather than blowing up the run. The DB wrappers are thin.
 *
 * Grammar (verb is case-insensitive; the rest is taken verbatim):
 *   CATEGORIZE <txnId> <accountCode>          → payload { accountCode }
 *   ALLOCATE   <txnId> proj=pct proj=pct ...   → payload { splits: { proj: pct } }
 *   SPLIT      <txnId> acct=pct acct=pct ...    → payload { splits: { acct: pct } }
 *   APPROVE AJE <id>  /  APPROVE_AJE <id>       → sourceTxnId=null, payload { ajeId }
 *   DEFER   AJE <id>  /  DEFER_AJE   <id>       → sourceTxnId=null, payload { ajeId }
 *   MATCH      <txnIdA> <txnIdB>                 → payload { a, b }
 */
import type { Sql } from "../core/db.js";

/** A resolution verb. Mirrors the acct_resolution.verb CHECK domain. */
export type ResolutionVerb =
  | "CATEGORIZE"
  | "ALLOCATE"
  | "APPROVE_AJE"
  | "DEFER_AJE"
  | "MATCH"
  | "SPLIT";

/** A parsed human decision, ready to persist as one acct_resolution row. */
export interface Resolution {
  verb: ResolutionVerb;
  /** The transaction the decision is about, or null for AJE-scoped verbs. */
  sourceTxnId: string | null;
  /** Verb-specific structured arguments (stored as jsonb). */
  payload: Record<string, unknown>;
}

/** Split whitespace, drop empties — the shared tokenizer for every verb. */
function tokenize(line: string): string[] {
  return line.trim().split(/\s+/).filter((t) => t.length > 0);
}

/**
 * Parse `proj=pct proj=pct ...` tokens into a `{ key: number }` map. A token must
 * be exactly `key=number` with a non-empty key and a finite numeric percent;
 * malformed tokens are skipped. Returns null when nothing valid parsed, so an
 * ALLOCATE/SPLIT line with no usable splits is treated as noise.
 */
function parseSplits(tokens: string[]): Record<string, number> | null {
  const splits: Record<string, number> = {};
  let found = false;
  for (const tok of tokens) {
    const eq = tok.indexOf("=");
    if (eq <= 0 || eq === tok.length - 1) continue; // need a key and a value
    const key = tok.slice(0, eq);
    const pct = Number(tok.slice(eq + 1));
    if (!Number.isFinite(pct)) continue;
    splits[key] = pct;
    found = true;
  }
  return found ? splits : null;
}

/**
 * Parse ONE line into a Resolution, or null if it does not match the grammar.
 * Pure: no DB, no clock, no I/O. The verb is matched case-insensitively; the
 * APPROVE/DEFER verbs accept both the two-word form ("APPROVE AJE 12") and the
 * underscore form ("APPROVE_AJE 12").
 */
export function parseResolutionLine(line: string): Resolution | null {
  const tokens = tokenize(line);
  if (tokens.length === 0) return null;
  const verb = tokens[0]!.toUpperCase();

  switch (verb) {
    case "CATEGORIZE": {
      // CATEGORIZE <txnId> <accountCode>
      const txnId = tokens[1];
      const accountCode = tokens[2];
      if (!txnId || !accountCode) return null;
      return { verb: "CATEGORIZE", sourceTxnId: txnId, payload: { accountCode } };
    }

    case "ALLOCATE": {
      // ALLOCATE <txnId> proj=pct proj=pct ...
      const txnId = tokens[1];
      if (!txnId) return null;
      const splits = parseSplits(tokens.slice(2));
      if (!splits) return null;
      return { verb: "ALLOCATE", sourceTxnId: txnId, payload: { splits } };
    }

    case "SPLIT": {
      // SPLIT <txnId> acct=pct acct=pct ...
      const txnId = tokens[1];
      if (!txnId) return null;
      const splits = parseSplits(tokens.slice(2));
      if (!splits) return null;
      return { verb: "SPLIT", sourceTxnId: txnId, payload: { splits } };
    }

    case "APPROVE_AJE": {
      // APPROVE_AJE <id>
      const ajeId = tokens[1];
      if (!ajeId) return null;
      return { verb: "APPROVE_AJE", sourceTxnId: null, payload: { ajeId } };
    }

    case "DEFER_AJE": {
      // DEFER_AJE <id>
      const ajeId = tokens[1];
      if (!ajeId) return null;
      return { verb: "DEFER_AJE", sourceTxnId: null, payload: { ajeId } };
    }

    case "APPROVE": {
      // APPROVE AJE <id> — two-word form. Anything but AJE in slot 2 is noise.
      if (!tokens[1] || tokens[1].toUpperCase() !== "AJE") return null;
      const ajeId = tokens[2];
      if (!ajeId) return null;
      return { verb: "APPROVE_AJE", sourceTxnId: null, payload: { ajeId } };
    }

    case "DEFER": {
      // DEFER AJE <id> — two-word form.
      if (!tokens[1] || tokens[1].toUpperCase() !== "AJE") return null;
      const ajeId = tokens[2];
      if (!ajeId) return null;
      return { verb: "DEFER_AJE", sourceTxnId: null, payload: { ajeId } };
    }

    case "MATCH": {
      // MATCH <txnIdA> <txnIdB>
      const a = tokens[1];
      const b = tokens[2];
      if (!a || !b) return null;
      return { verb: "MATCH", sourceTxnId: a, payload: { a, b } };
    }

    default:
      return null;
  }
}

/**
 * Parse a whole reply body: split on newlines, parse each line, drop the nulls.
 * Order is preserved so the consuming run applies decisions in the order written.
 */
export function parseResolutions(body: string): Resolution[] {
  const out: Resolution[] = [];
  for (const line of body.split(/\r?\n/)) {
    const r = parseResolutionLine(line);
    if (r) out.push(r);
  }
  return out;
}

/**
 * Persist resolutions as `open` acct_resolution rows. Merge-on-save: an identical
 * already-open row (same verb + source_txn_id + payload) is skipped rather than
 * duplicated, so re-processing the same reply twice never double-applies a
 * decision. Returns the number of rows actually inserted.
 */
export async function saveResolutions(
  sql: Sql,
  tenantId: string,
  res: Resolution[],
): Promise<number> {
  let saved = 0;
  for (const r of res) {
    // An identical open row already pending? Skip it (idempotent merge-on-save).
    const dup = await sql<{ id: number }[]>`
      SELECT id FROM acct_resolution
      WHERE tenant_id = ${tenantId}
        AND status = 'open'
        AND verb = ${r.verb}
        AND source_txn_id IS NOT DISTINCT FROM ${r.sourceTxnId}
        AND payload = ${sql.json(r.payload as Parameters<typeof sql.json>[0])}
      LIMIT 1
    `;
    if (dup.length > 0) continue;
    await sql`
      INSERT INTO acct_resolution (tenant_id, source_txn_id, verb, payload, status)
      VALUES (${tenantId}, ${r.sourceTxnId}, ${r.verb}, ${sql.json(r.payload as Parameters<typeof sql.json>[0])}, 'open')
    `;
    saved += 1;
  }
  return saved;
}

/**
 * Atomically claim every `open` resolution for a tenant: flip it to `consumed`
 * (stamping consumed_at) and return the claimed rows for the close run to apply.
 * The UPDATE ... RETURNING is the claim — a concurrent run cannot re-consume the
 * same rows because they are no longer `open` after this statement commits.
 */
export async function consumeOpenResolutions(
  sql: Sql,
  tenantId: string,
): Promise<Array<Resolution & { id: number }>> {
  const rows = await sql<
    { id: number; verb: string; source_txn_id: string | null; payload: Record<string, unknown> }[]
  >`
    UPDATE acct_resolution
    SET status = 'consumed', consumed_at = now()
    WHERE tenant_id = ${tenantId} AND status = 'open'
    RETURNING id, verb, source_txn_id, payload
  `;
  return rows.map((row) => ({
    id: row.id,
    verb: row.verb as ResolutionVerb,
    sourceTxnId: row.source_txn_id,
    // jsonb decodes to an object; guard against a NULL/non-object payload.
    payload: (row.payload ?? {}) as Record<string, unknown>,
  }));
}
