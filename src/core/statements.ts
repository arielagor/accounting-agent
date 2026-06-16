/**
 * Bank/card statement importer — the path to YEARS of history (SimpleFIN only exposes
 * ~90 days). Parses OFX/QFX (standardized, unambiguous signs — preferred) and CSV
 * (best-effort column mapping) into our raw-transaction shape and ingests them under
 * provider 'statement', deduped against what SimpleFIN already pulled.
 *
 * Dedup is two-layered:
 *   1. (tenant, 'statement', dedup_key) UNIQUE → re-importing the same file is a no-op.
 *   2. cross-provider (source_account, posted_date, amount) → never double-counts a
 *      transaction SimpleFIN already has in the overlap window.
 * Money is integer cents; sign convention = negative is an outflow (matches SimpleFIN).
 */
import { createHash } from "node:crypto";
import type { Sql } from "./db.js";
import { toCents } from "./money.js";

export interface StatementTxn {
  externalId: string | null; // OFX FITID when present
  date: string; // YYYY-MM-DD
  amountCents: number; // signed: negative = outflow
  description: string;
}

// ─── OFX / QFX ──────────────────────────────────────────────────────────────────────
/** Pull the first value of an OFX field within a block (SGML: value to EOL/next tag; XML: to close tag). */
function ofxField(block: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([^<\\r\\n]+)`, "i").exec(block);
  return m ? m[1]!.trim() : null;
}

/** OFX DTPOSTED is YYYYMMDD[hhmmss[.xxx]][tz] → take the leading date. */
function ofxDate(v: string | null): string | null {
  if (!v) return null;
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(v.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Parse an OFX/QFX document (1.x SGML or 2.x XML) into statement transactions. */
export function parseOfx(text: string): StatementTxn[] {
  const out: StatementTxn[] = [];
  const blocks = text.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) ?? [];
  for (const b of blocks) {
    const date = ofxDate(ofxField(b, "DTPOSTED"));
    const amt = ofxField(b, "TRNAMT");
    if (!date || amt === null) continue;
    const name = ofxField(b, "NAME") ?? "";
    const memo = ofxField(b, "MEMO") ?? "";
    const description = [name, memo].filter(Boolean).join(" — ").trim() || "(statement)";
    out.push({ externalId: ofxField(b, "FITID"), date, amountCents: toCents(amt), description });
  }
  return out;
}

// ─── CSV ──────────────────────────────────────────────────────────────────────────────
export interface CsvMapping {
  date?: string; // header name for the date
  amount?: string; // single signed-amount column
  debit?: string; // outflow column (positive numbers)
  credit?: string; // inflow column (positive numbers)
  description?: string; // header name for the description
  /** Flip the sign of a single amount column (some banks list charges as positive). */
  flip?: boolean;
}

/** Split one CSV line, honoring double-quoted fields with embedded commas. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Normalize a header for fuzzy matching. */
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Parse a US date string (MM/DD/YYYY, M/D/YY, YYYY-MM-DD) to YYYY-MM-DD. */
function csvDate(v: string): string | null {
  const s = v.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s);
  if (m) {
    const yy = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    return `${yy}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  }
  return null;
}

/**
 * Parse a CSV bank export. Auto-detects the common columns (Date, Amount or
 * Debit/Credit, Description/Payee/Memo) unless an explicit mapping is given. Returns
 * the rows it could parse; silently skips header/blank/garbled lines.
 */
export function parseCsv(text: string, mapping: CsvMapping = {}): StatementTxn[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]!);
  const idx = (names: string[], explicit?: string): number => {
    if (explicit) { const e = header.findIndex((h) => norm(h) === norm(explicit)); if (e >= 0) return e; }
    for (const n of names) { const i = header.findIndex((h) => norm(h) === norm(n) || norm(h).includes(norm(n))); if (i >= 0) return i; }
    return -1;
  };
  const di = idx(["date", "transactiondate", "postingdate", "posteddate", "transdate"], mapping.date);
  const ai = idx(["amount", "transactionamount"], mapping.amount);
  const dbi = idx(["debit", "withdrawal", "withdrawalamount"], mapping.debit);
  const ci = idx(["credit", "deposit", "depositamount"], mapping.credit);
  const desci = idx(["description", "payee", "merchant", "memo", "name", "details"], mapping.description);
  if (di < 0) return [];

  const out: StatementTxn[] = [];
  for (let r = 1; r < lines.length; r++) {
    const f = splitCsvLine(lines[r]!);
    const date = csvDate(f[di] ?? "");
    if (!date) continue;
    let cents: number | null = null;
    if (ai >= 0 && f[ai]) {
      cents = toCents(f[ai]!);
      if (mapping.flip) cents = -cents;
    } else if (dbi >= 0 || ci >= 0) {
      const debit = dbi >= 0 && f[dbi] ? Math.abs(toCents(f[dbi]!)) : 0;
      const credit = ci >= 0 && f[ci] ? Math.abs(toCents(f[ci]!)) : 0;
      cents = credit - debit; // outflow negative
    }
    if (cents === null || !Number.isFinite(cents)) continue;
    out.push({ externalId: null, date, amountCents: cents, description: (desci >= 0 ? f[desci] : "") || "(statement)" });
  }
  return out;
}

// ─── Ingest ─────────────────────────────────────────────────────────────────────────────
export interface ImportResult {
  parsed: number;
  added: number;
  duplicateInFile: number; // already imported from a prior statement run
  overlapWithSync: number; // SimpleFIN (or another source) already had it
  dateRange: { from: string; to: string } | null;
}

/** Stable dedup key for a CSV row (no FITID): hash of account+date+amount+description. */
function synthKey(accountId: number, t: StatementTxn): string {
  return createHash("sha1").update(`${accountId}|${t.date}|${t.amountCents}|${t.description}`).digest("hex").slice(0, 24);
}

/**
 * Ingest parsed statement transactions for one source account, deduping against both
 * prior statement imports and the existing (SimpleFIN) data in the overlap window.
 */
export async function importStatement(
  sql: Sql,
  tenantId: string,
  sourceAccountId: number,
  txns: StatementTxn[],
): Promise<ImportResult> {
  const res: ImportResult = { parsed: txns.length, added: 0, duplicateInFile: 0, overlapWithSync: 0, dateRange: null };
  let minD = "9999-99-99", maxD = "0000-00-00";
  for (const t of txns) {
    if (t.date < minD) minD = t.date;
    if (t.date > maxD) maxD = t.date;
    const dedupKey = t.externalId ?? synthKey(sourceAccountId, t);

    // 1) Same statement row already imported?
    const dup = await sql<{ id: number }[]>`
      SELECT id FROM acct_transactions_raw
      WHERE tenant_id = ${tenantId} AND provider = 'statement' AND dedup_key = ${dedupKey}`;
    if (dup.length > 0) { res.duplicateInFile += 1; continue; }

    // 2) Already present from SimpleFIN (or any provider) for this account+date+amount?
    const overlap = await sql<{ id: number }[]>`
      SELECT id FROM acct_transactions_raw
      WHERE tenant_id = ${tenantId} AND source_account_id = ${sourceAccountId}
        AND posted_date = ${t.date} AND amount_cents = ${t.amountCents} LIMIT 1`;
    if (overlap.length > 0) { res.overlapWithSync += 1; continue; }

    await sql`
      INSERT INTO acct_transactions_raw
        (source_account_id, tenant_id, provider, provider_txn_id, dedup_key, amount_cents,
         currency, posted_date, pending, description_raw, merchant_name, raw_json)
      VALUES (${sourceAccountId}, ${tenantId}, 'statement', ${dedupKey}, ${dedupKey}, ${t.amountCents},
              'usd', ${t.date}, false, ${t.description}, ${t.description}, ${sql.json({ source: "statement", date: t.date } as Parameters<typeof sql.json>[0])})`;
    res.added += 1;
  }
  res.dateRange = txns.length ? { from: minD, to: maxD } : null;
  return res;
}

/** Sniff whether pasted/loaded text is OFX/QFX (vs CSV). */
export function looksLikeOfx(text: string): boolean {
  return /<OFX>/i.test(text) || /<STMTTRN>/i.test(text) || /OFXHEADER/i.test(text);
}
