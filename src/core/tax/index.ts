/**
 * The modular tax engine's front door. One strategy per entity type, selected by
 * the `entity_type` toggle on the entity profile — flip the toggle and the whole
 * tax computation changes (sole-prop SE tax → S-corp salary/distribution split →
 * C-corp flat rate → organize-only zeros). The orchestrator's close stage calls
 * `selectStrategy` (or the `estimate` convenience) and never knows which entity
 * math ran; that is the point of the toggle.
 *
 * Re-exports the strategy classes and the pure rate primitives so the rest of the
 * engine imports the tax surface from one module.
 */
import type {
  EntityProfile,
  EntityType,
  EstimatedTax,
  TaxStrategy,
} from "../types.js";
import type { Sql } from "../db.js";
import { loadRates } from "./rates.js";
import { ScheduleCStrategy } from "./schedule-c.js";
import { SingleLlcStrategy } from "./single-llc.js";
import { MultiLlcStrategy } from "./multi-llc.js";
import { SCorpStrategy } from "./s-corp.js";
import { CCorpStrategy } from "./c-corp.js";
import { OrganizeOnlyStrategy } from "./organize-only.js";

export * from "./rates.js";
export { ScheduleCStrategy } from "./schedule-c.js";
export { SingleLlcStrategy } from "./single-llc.js";
export { MultiLlcStrategy } from "./multi-llc.js";
export { SCorpStrategy } from "./s-corp.js";
export { CCorpStrategy } from "./c-corp.js";
export { OrganizeOnlyStrategy } from "./organize-only.js";

/**
 * Map an `EntityType` to its strategy. Exhaustive over all six — the
 * `noFallthroughCasesInSwitch` + the `never` default make a forgotten entity a
 * COMPILE error, not a silent wrong-tax-at-runtime.
 */
export function selectStrategy(entityType: EntityType): TaxStrategy {
  switch (entityType) {
    case "sole_prop":
      return new ScheduleCStrategy();
    case "single_llc":
      return new SingleLlcStrategy();
    case "multi_llc":
      return new MultiLlcStrategy();
    case "s_corp":
      return new SCorpStrategy();
    case "c_corp":
      return new CCorpStrategy();
    case "organize_only":
      return new OrganizeOnlyStrategy();
    default: {
      // Exhaustiveness guard: a new EntityType must add a case above.
      const _exhaustive: never = entityType;
      throw new Error(`no tax strategy for entity type: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Convenience estimate: load the year's rates, select the profile's strategy, and
 * compute the quarterly estimate in one call. The async wrapper is thin — the rate
 * read is the only IO; the math is the pure strategy. Used by the close stage and
 * the advisor where a DB handle is already in scope.
 */
export async function estimate(
  sql: Sql,
  profile: EntityProfile,
  netProfitCents: number,
  grossReceiptsCents: number,
): Promise<EstimatedTax> {
  const rates = await loadRates(sql, profile.taxYear);
  const strategy = selectStrategy(profile.entityType);
  return strategy.estimatedQuarterly({
    taxYear: profile.taxYear,
    netProfitCents,
    grossReceiptsCents,
    profile,
    rates,
  });
}
