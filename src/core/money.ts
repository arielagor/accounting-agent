/**
 * Money is ALWAYS integer cents. Never floats in the ledger — float arithmetic
 * silently loses pennies and a double-entry system that does not balance to the
 * cent is worthless. All amounts crossing module boundaries are `Cents`.
 */

/** A signed integer number of cents. Positive = debit-normal inflow per context. */
export type Cents = number;

/** Parse a dollars string/number ("19.99", 19.99) to integer cents, rounding half-up. */
export function toCents(dollars: number | string): Cents {
  const n = typeof dollars === "string" ? Number(dollars.replace(/[$,\s]/g, "")) : dollars;
  if (!Number.isFinite(n)) throw new Error(`toCents: not a finite number: ${dollars}`);
  // Round at the cent to avoid binary-float drift (e.g. 19.99 * 100 = 1998.9999...).
  return Math.round(n * 100);
}

/** Format integer cents as a fixed-2 dollars string (no currency symbol). */
export function fromCents(cents: Cents): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  return `${sign}${dollars}.${String(rem).padStart(2, "0")}`;
}

/** Format integer cents as a display string with $ and thousands separators. */
export function formatUsd(cents: Cents): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  const grouped = dollars.toLocaleString("en-US");
  return `${sign}$${grouped}.${String(rem).padStart(2, "0")}`;
}

/** Sum a list of cents exactly. */
export function sumCents(values: Cents[]): Cents {
  return values.reduce((a, b) => a + Math.trunc(b), 0);
}

/**
 * Split `total` cents across `weights`, distributing to the largest-weight
 * targets first and giving the remainder to the last target so the parts sum
 * EXACTLY to `total` (no lost or invented pennies). Returns one Cents per weight.
 * The "largest remainder" allocation: deterministic, order-stable.
 */
export function allocateCents(total: Cents, weights: number[]): Cents[] {
  const n = weights.length;
  if (n === 0) return [];
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight <= 0) {
    // Degenerate: even split.
    return evenSplit(total, n);
  }
  const exact = weights.map((w) => (total * w) / totalWeight);
  const floors = exact.map((x) => Math.floor(x));
  let distributed = floors.reduce((a, b) => a + b, 0);
  let remainder = total - distributed;
  // Order indices by largest fractional part, then by original order for stability.
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const result = [...floors];
  let k = 0;
  const step = remainder >= 0 ? 1 : -1;
  remainder = Math.abs(remainder);
  while (remainder > 0 && n > 0) {
    const idx = order[k % n]!.i;
    result[idx] = result[idx]! + step;
    remainder -= 1;
    k += 1;
  }
  return result;
}

/** Even split with the remainder going to the earliest targets, summing exactly. */
export function evenSplit(total: Cents, n: number): Cents[] {
  if (n <= 0) return [];
  const base = Math.trunc(total / n);
  let rem = total - base * n;
  const out = new Array<number>(n).fill(base);
  const step = rem >= 0 ? 1 : -1;
  rem = Math.abs(rem);
  let i = 0;
  while (rem > 0) {
    out[i % n] = out[i % n]! + step;
    rem -= 1;
    i += 1;
  }
  return out;
}
