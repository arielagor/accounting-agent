/**
 * PlaidProvider — read-only aggregation against Plaid's /transactions/sync.
 *
 * This is the Phase-2 path: it is REAL code (calls /accounts/get and
 * /transactions/sync over fetch), but is exercised live later. By construction it
 * only READS — no money-movement method exists on the interface.
 *
 * Plaid sign convention vs ours (the one subtle part, centralized + tested):
 *   - Plaid `amount` is in DOLLARS and POSITIVE means money LEAVING the account
 *     (an outflow / debit), negative means money coming in.
 *   - OUR convention (ProviderTransaction.amountCents) is the OPPOSITE sign:
 *     negative = outflow, positive = inflow.
 *   So we toCents the dollar amount and NEGATE it: outflow becomes negative.
 *
 * The pure mapping lives in `mapPlaidSync` (unit-tested with a JSON literal); the
 * class is a thin fetch wrapper that posts the standard Plaid request body.
 */
import type {
  AggregationProvider,
  ProviderAccount,
  ProviderTransaction,
  ProviderSyncPage,
} from "../core/types.js";
import { toCents } from "../core/money.js";

export interface PlaidConfig {
  clientId: string;
  secret: string;
  /** e.g. https://sandbox.plaid.com or https://production.plaid.com */
  baseUrl: string;
}

/** Shape of a Plaid transaction object (only the fields we map). */
interface PlaidTxnJson {
  transaction_id: string;
  account_id: string;
  amount: number; // dollars; POSITIVE = outflow (Plaid convention)
  iso_currency_code?: string | null;
  unofficial_currency_code?: string | null;
  date?: string | null; // YYYY-MM-DD (posted)
  authorized_date?: string | null; // YYYY-MM-DD
  pending?: boolean;
  name?: string | null;
  merchant_name?: string | null;
  personal_finance_category?: { primary?: string } | null;
  category?: string[] | null;
}

interface PlaidSyncJson {
  added?: PlaidTxnJson[];
  modified?: PlaidTxnJson[];
  removed?: { transaction_id: string }[];
  next_cursor?: string | null;
  has_more?: boolean;
}

interface PlaidAccountJson {
  account_id: string;
  name?: string | null;
  official_name?: string | null;
  mask?: string | null;
  type?: string | null;
  subtype?: string | null;
  balances?: { iso_currency_code?: string | null } | null;
}

interface PlaidAccountsJson {
  accounts?: PlaidAccountJson[];
}

/** Best-effort provider category from Plaid's two category shapes. */
function plaidCategory(t: PlaidTxnJson): string | null {
  const pfc = t.personal_finance_category?.primary;
  if (pfc) return pfc;
  if (Array.isArray(t.category) && t.category.length > 0) return t.category[0] ?? null;
  return null;
}

/** Map one Plaid txn to our ProviderTransaction (sign-flipped to our convention). */
function mapPlaidTxn(t: PlaidTxnJson): ProviderTransaction {
  const currency = (t.iso_currency_code ?? t.unofficial_currency_code ?? "usd").toLowerCase();
  // toCents the dollar amount, then NEGATE: Plaid positive=outflow → our negative=outflow.
  const signedCents = -toCents(t.amount);
  return {
    providerTxnId: t.transaction_id,
    amountCents: signedCents,
    currency,
    postedDate: t.date ?? null,
    authorizedDate: t.authorized_date ?? null,
    pending: t.pending === true,
    description: t.name ?? "",
    merchantName: t.merchant_name ?? null,
    categoryProvider: plaidCategory(t),
    raw: t as unknown as Record<string, unknown>,
    providerAccountId: t.account_id,
  };
}

/**
 * PURE mapper: a parsed /transactions/sync response → a ProviderSyncPage. Handles
 * added/modified/removed and passes through next_cursor + has_more. Deterministic
 * given its input (no network, no clock). The sign flip is applied per-txn.
 */
export function mapPlaidSync(json: unknown): ProviderSyncPage {
  const root = (json ?? {}) as PlaidSyncJson;
  const added = (Array.isArray(root.added) ? root.added : []).map(mapPlaidTxn);
  const modified = (Array.isArray(root.modified) ? root.modified : []).map(mapPlaidTxn);
  const removed = (Array.isArray(root.removed) ? root.removed : [])
    .map((r) => r.transaction_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return {
    added,
    modified,
    removed,
    nextCursor: root.next_cursor ?? null,
    hasMore: root.has_more === true,
  };
}

/** PURE mapper: a parsed /accounts/get response → our ProviderAccount list. */
export function mapPlaidAccounts(json: unknown): ProviderAccount[] {
  const root = (json ?? {}) as PlaidAccountsJson;
  const accountsJson = Array.isArray(root.accounts) ? root.accounts : [];
  return accountsJson.map((a) => ({
    providerAccountId: a.account_id,
    name: a.name ?? a.official_name ?? a.account_id,
    mask: a.mask ?? undefined,
    type: a.type ?? undefined,
    subtype: a.subtype ?? undefined,
    currency: (a.balances?.iso_currency_code ?? "usd").toLowerCase(),
  }));
}

export class PlaidProvider implements AggregationProvider {
  readonly name = "plaid";

  private readonly clientId: string;
  private readonly secret: string;
  private readonly baseUrl: string;

  constructor(config: PlaidConfig) {
    this.clientId = config.clientId;
    this.secret = config.secret;
    this.baseUrl = config.baseUrl.endsWith("/") ? config.baseUrl.slice(0, -1) : config.baseUrl;
  }

  async listAccounts(accessToken: string): Promise<ProviderAccount[]> {
    const json = await this.post("/accounts/get", { access_token: accessToken });
    return mapPlaidAccounts(json);
  }

  /**
   * Plaid /transactions/sync is itself cursor-paged; we make ONE request and pass
   * the cursor straight through (null on first sync → Plaid treats it as "from the
   * beginning"). The caller loops on hasMore using our returned nextCursor.
   */
  async syncTransactions(
    accessToken: string,
    cursor: string | null,
  ): Promise<ProviderSyncPage> {
    const body: Record<string, unknown> = { access_token: accessToken };
    // Plaid wants the cursor OMITTED on the first call, not sent as null.
    if (cursor !== null) body.cursor = cursor;
    const json = await this.post("/transactions/sync", body);
    return mapPlaidSync(json);
  }

  /** Thin POST wrapper — injects client_id/secret into every Plaid request body. */
  private async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const payload = { client_id: this.clientId, secret: this.secret, ...body };
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`Plaid ${path} HTTP ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as unknown;
  }
}
