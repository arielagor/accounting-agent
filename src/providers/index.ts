/**
 * Provider factory + re-exports. One place to resolve a provider name to a live
 * AggregationProvider, so the sync pipeline never imports a concrete class.
 * Every provider is read-only by construction (no money-movement method exists).
 */
import type { AggregationProvider, ProviderAccount, ProviderTransaction } from "../core/types.js";
import { FixtureProvider } from "./fixture.js";
import { SimpleFinProvider } from "./simplefin.js";
import { PlaidProvider, type PlaidConfig } from "./plaid.js";

export {
  FixtureProvider,
  SimpleFinProvider,
  PlaidProvider,
  type PlaidConfig,
};
export { parseSimpleFinAccounts } from "./simplefin.js";
export { mapPlaidSync, mapPlaidAccounts } from "./plaid.js";

export type ProviderName = "simplefin" | "plaid" | "fixture";

/** Config accepted by the fixture provider (its replay data). */
export interface FixtureConfig {
  accounts?: ProviderAccount[];
  transactions?: ProviderTransaction[];
}

/**
 * Resolve a provider name to a constructed AggregationProvider.
 *   - "fixture"   → FixtureProvider(config.accounts, config.transactions)
 *   - "simplefin" → SimpleFinProvider (no config; the access URL is the token)
 *   - "plaid"     → PlaidProvider(config: { clientId, secret, baseUrl })
 * `config` is `any` so callers needn't discriminate the union at the call site;
 * each branch reads only the fields it needs.
 */
export function getProvider(name: ProviderName, config?: any): AggregationProvider {
  switch (name) {
    case "fixture": {
      const cfg = (config ?? {}) as FixtureConfig;
      return new FixtureProvider(cfg.accounts ?? [], cfg.transactions ?? []);
    }
    case "simplefin":
      return new SimpleFinProvider();
    case "plaid": {
      const cfg = (config ?? {}) as PlaidConfig;
      if (!cfg.clientId || !cfg.secret || !cfg.baseUrl) {
        throw new Error("plaid provider needs { clientId, secret, baseUrl }");
      }
      return new PlaidProvider(cfg);
    }
    default: {
      // Exhaustiveness guard: a new ProviderName must add a branch above.
      const exhaustive: never = name;
      throw new Error(`unknown provider: ${String(exhaustive)}`);
    }
  }
}
