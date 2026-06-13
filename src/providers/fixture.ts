/**
 * FixtureProvider — a deterministic, in-memory AggregationProvider for tests and
 * local dev. No network, no DB: it replays a fixed account list and transaction
 * list. Being a pure function of its constructor inputs, it makes the ingestion
 * pipeline fully testable without touching a bank API.
 *
 * Cursor protocol (mirrors the real sync contract):
 *   - cursor === null  → "first sync": return ALL txns as `added`, nextCursor="done".
 *   - cursor !== null  → "incremental": nothing new, return empty `added`.
 * There is NO money-movement method by design — read-only, like every provider.
 */
import type {
  AggregationProvider,
  ProviderAccount,
  ProviderTransaction,
  ProviderSyncPage,
} from "../core/types.js";

/** Sentinel cursor returned after the one and only fixture page. */
const DONE_CURSOR = "done";

export class FixtureProvider implements AggregationProvider {
  readonly name = "fixture";

  private readonly accounts: ProviderAccount[];
  private readonly txns: ProviderTransaction[];

  constructor(accounts: ProviderAccount[], txns: ProviderTransaction[]) {
    // Copy so external mutation of the caller's arrays can't change replay output.
    this.accounts = [...accounts];
    this.txns = [...txns];
  }

  /** Return the fixed account list. Deterministic, copied to keep replay stable. */
  async listAccounts(_accessToken: string): Promise<ProviderAccount[]> {
    return [...this.accounts];
  }

  /**
   * First sync (cursor null) emits every fixture txn as `added` and advances the
   * cursor to DONE. Any later sync (cursor non-null) is a no-op page: empty added,
   * hasMore=false. Always deterministic and order-stable.
   */
  async syncTransactions(
    _accessToken: string,
    cursor: string | null,
  ): Promise<ProviderSyncPage> {
    if (cursor === null) {
      return {
        added: [...this.txns],
        modified: [],
        removed: [],
        nextCursor: DONE_CURSOR,
        hasMore: false,
      };
    }
    return {
      added: [],
      modified: [],
      removed: [],
      nextCursor: cursor,
      hasMore: false,
    };
  }
}
