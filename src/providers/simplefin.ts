/**
 * SimpleFinProvider — read-only aggregation against a SimpleFIN bridge.
 *
 * SimpleFIN's auth model: the access TOKEN here IS a SimpleFIN "access URL", which
 * may embed HTTP basic-auth credentials (https://user:pass@bridge.example/...).
 * We GET `${accessUrl}/accounts?start-date=<sec>&pending=1` and the bridge returns
 * the accounts plus their transactions. By construction this provider only READS —
 * there is no money-movement method anywhere on the interface.
 *
 * SimpleFIN amount/date conventions (per the SimpleFIN protocol):
 *   - `amount` is a DECIMAL DOLLAR STRING, already signed (negative = outflow).
 *     We convert with toCents — our signed-cents convention matches it directly.
 *   - `posted` is unix seconds → we format the posted date as YYYY-MM-DD (UTC).
 *
 * The pure mapping lives in `parseSimpleFinAccounts` (unit-tested with a JSON
 * literal, no network); the class is a thin fetch wrapper over it.
 */
import type {
  AggregationProvider,
  ProviderAccount,
  ProviderTransaction,
  ProviderSyncPage,
} from "../core/types.js";
import { toCents } from "../core/money.js";

/** ~90 days of seconds — the default lookback when there is no cursor yet. */
const NINETY_DAYS_SECONDS = 90 * 24 * 60 * 60;

/** Shape of the SimpleFIN /accounts response we consume (only the fields we use). */
interface SimpleFinTxnJson {
  id: string;
  posted: number; // unix seconds (0/absent until the txn clears)
  transacted_at?: number; // unix seconds — when it occurred (present even while pending)
  amount: string; // signed decimal dollar string
  description?: string;
  pending?: boolean;
  payee?: string;
  category?: string;
}

/** Best transaction date in unix seconds: `posted` when set, else `transacted_at`. */
function bestTxnSeconds(t: SimpleFinTxnJson): number | null {
  if (Number.isFinite(t.posted) && t.posted > 0) return t.posted;
  if (Number.isFinite(t.transacted_at) && (t.transacted_at as number) > 0) return t.transacted_at as number;
  return null;
}

interface SimpleFinAccountJson {
  id: string;
  name?: string;
  currency?: string;
  balance?: string;
  org?: { name?: string; domain?: string } | null;
  transactions?: SimpleFinTxnJson[];
}

interface SimpleFinResponseJson {
  accounts?: SimpleFinAccountJson[];
  /** Non-fatal per-institution warnings ("... may need attention. Auth required"). */
  errors?: string[];
}

/** Format unix SECONDS as a UTC YYYY-MM-DD date string. */
function unixSecondsToYmd(sec: number): string {
  const d = new Date(sec * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * PURE mapper: turn a parsed SimpleFIN /accounts JSON object into our account and
 * transaction shapes. No network, no clock — deterministic given its input.
 * Amounts pass through toCents (SimpleFIN's sign already matches our convention:
 * negative = outflow). Each txn is tagged with its owning provider account id.
 */
export function parseSimpleFinAccounts(json: unknown): {
  accounts: ProviderAccount[];
  transactions: ProviderTransaction[];
  warnings: string[];
} {
  const root = (json ?? {}) as SimpleFinResponseJson;
  const accountsJson = Array.isArray(root.accounts) ? root.accounts : [];
  // SimpleFIN reports a per-institution re-auth prompt here while STILL returning
  // HTTP 200 and the healthy institutions' data. Dropping it makes a partially dead
  // feed indistinguishable from a working one.
  const warnings = Array.isArray(root.errors) ? root.errors.filter((e) => typeof e === "string") : [];

  const accounts: ProviderAccount[] = [];
  const transactions: ProviderTransaction[] = [];

  for (const acct of accountsJson) {
    const currency = (acct.currency ?? "usd").toLowerCase();
    accounts.push({
      providerAccountId: acct.id,
      name: acct.name ?? acct.id,
      type: acct.org?.name ?? undefined,
      currency,
    });

    const txns = Array.isArray(acct.transactions) ? acct.transactions : [];
    for (const t of txns) {
      const pending = t.pending === true;
      const sec = bestTxnSeconds(t);
      transactions.push({
        providerTxnId: t.id,
        amountCents: toCents(t.amount), // signed: negative = outflow
        currency,
        postedDate: sec !== null ? unixSecondsToYmd(sec) : null,
        authorizedDate: null, // SimpleFIN exposes only `posted`
        pending,
        description: t.description ?? "",
        merchantName: t.payee ?? null,
        categoryProvider: t.category ?? null,
        raw: t as unknown as Record<string, unknown>,
        providerAccountId: acct.id,
      });
    }
  }

  return { accounts, transactions, warnings };
}

/**
 * Map a sync cursor to a start-date in unix SECONDS.
 *
 * The cursor may only ever WIDEN the window, never narrow it — it is clamped to at
 * most `now - 90 days`. This is not an optimization, it is a correctness fix:
 *
 * SimpleFIN filters `start-date` on a transaction's POSTED date, and institutions
 * post with a settlement lag (Amex/BofA/Wells Fargo backdate by several days; Citi
 * posts same-day). `syncTransactions` advances the cursor to "now" after every run,
 * so a nightly sync used to request only the last ~24h — and any transaction that
 * landed with a posted date older than that fell outside the window permanently,
 * because the cursor had already stepped past it. Fast-posting institutions synced
 * fine while slow-posting ones went silently stale with `status = 'active'` and no
 * error. (Observed live: the bridge held Amex transactions through 2026-07-23 while
 * the ledger stopped at 2026-06-06.)
 *
 * Re-requesting the full window is safe and cheap: SimpleFIN caps history at ~90 days
 * regardless of what we ask for, and ingestion is idempotent by `dedup_key`, so the
 * overlap collapses to zero writes. An explicit older cursor (`--since`) still widens.
 */
export function cursorToStartSeconds(cursor: string | null, nowSeconds: number): number {
  const ninetyDayFloor = nowSeconds - NINETY_DAYS_SECONDS;
  if (cursor === null) return ninetyDayFloor;
  const parsed = Number(cursor);
  // A non-numeric/garbled cursor fails soft to the 90-day window rather than throwing.
  if (!Number.isFinite(parsed)) return ninetyDayFloor;
  return Math.min(Math.trunc(parsed), ninetyDayFloor);
}

/**
 * PURE: build the credential-safe SimpleFIN /accounts request. SimpleFIN access
 * URLs embed HTTP basic-auth (https://user:pass@host/...), but Node's fetch REJECTS
 * a URL that includes credentials — so we strip them into an Authorization header.
 * Returns the credential-free URL and headers; the secret never appears in the URL
 * (and so never in a fetch error or a log).
 */
export function buildSimpleFinRequest(
  accessUrl: string,
  startSec: number,
): { url: string; headers: Record<string, string> } {
  const trimmed = accessUrl.endsWith("/") ? accessUrl.slice(0, -1) : accessUrl;
  const u = new URL(trimmed);
  const headers: Record<string, string> = {};
  if (u.username || u.password) {
    const creds = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
    headers.Authorization = `Basic ${Buffer.from(creds).toString("base64")}`;
    u.username = "";
    u.password = "";
  }
  const cleanBase = u.toString().replace(/\/$/, "");
  return { url: `${cleanBase}/accounts?start-date=${startSec}&pending=1`, headers };
}

export class SimpleFinProvider implements AggregationProvider {
  readonly name = "simplefin";

  async listAccounts(accessToken: string): Promise<ProviderAccount[]> {
    const json = await this.fetchAccounts(accessToken, null);
    return parseSimpleFinAccounts(json).accounts;
  }

  /**
   * Fetch the window since the cursor's start-date and return every parsed txn as
   * `added`. SimpleFIN has no incremental removed/modified feed, so removed=[] and
   * the next cursor is "now in seconds" — the next sync starts where this one ended.
   */
  async syncTransactions(
    accessToken: string,
    cursor: string | null,
  ): Promise<ProviderSyncPage> {
    const json = await this.fetchAccounts(accessToken, cursor);
    const { transactions, warnings } = parseSimpleFinAccounts(json);
    const nowSeconds = Math.floor(Date.now() / 1000);
    return {
      added: transactions,
      modified: [],
      removed: [],
      nextCursor: String(nowSeconds),
      hasMore: false,
      warnings,
    };
  }

  /** Thin GET wrapper. Credentials ride an Authorization header, never the URL. READ-ONLY. */
  private async fetchAccounts(accessUrl: string, cursor: string | null): Promise<unknown> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const startSec = cursorToStartSeconds(cursor, nowSeconds);
    const { url, headers } = buildSimpleFinRequest(accessUrl, startSec);
    const res = await fetch(url, { method: "GET", headers });
    if (!res.ok) {
      throw new Error(`SimpleFIN /accounts HTTP ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as unknown;
  }
}
