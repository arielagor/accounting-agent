/**
 * Regression tests for the silent-staleness bug: a cursor that advanced to "now" after
 * every sync narrowed the request window to ~24h, so any institution that posts with a
 * settlement lag (Amex/BofA/Wells Fargo backdate by days; Citi posts same-day) had its
 * transactions fall outside the window permanently. The feed stayed `status = 'active'`
 * with no error while going months stale.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cursorToStartSeconds, parseSimpleFinAccounts } from "../src/providers/simplefin.js";

const DAY = 24 * 60 * 60;
const NOW = 1_784_800_000;
const NINETY_DAY_FLOOR = NOW - 90 * DAY;

test("a fresh cursor never narrows the window below the 90-day floor", () => {
  // This is the exact shape of the bug: yesterday's sync stamped the cursor to its "now".
  const yesterdaysCursor = String(NOW - DAY);
  assert.equal(cursorToStartSeconds(yesterdaysCursor, NOW), NINETY_DAY_FLOOR);
});

test("a cursor stamped seconds ago still yields the full 90-day window", () => {
  assert.equal(cursorToStartSeconds(String(NOW - 5), NOW), NINETY_DAY_FLOOR);
});

test("a null cursor yields the 90-day window", () => {
  assert.equal(cursorToStartSeconds(null, NOW), NINETY_DAY_FLOOR);
});

test("a garbled cursor fails soft to the 90-day window rather than throwing", () => {
  assert.equal(cursorToStartSeconds("not-a-number", NOW), NINETY_DAY_FLOOR);
});

test("an explicit older cursor (--since backfill) still WIDENS the window", () => {
  const since = NOW - 200 * DAY;
  assert.equal(cursorToStartSeconds(String(since), NOW), since);
});

test("parseSimpleFinAccounts surfaces the bridge's errors[] as warnings", () => {
  const { warnings, transactions } = parseSimpleFinAccounts({
    errors: ["Connection to Marcus BY GOLDMAN SACHS may need attention. Auth required"],
    accounts: [
      {
        id: "acct-1",
        name: "Healthy Card",
        currency: "USD",
        transactions: [{ id: "t1", posted: NOW, amount: "-12.34", description: "Coffee" }],
      },
    ],
  });
  // The healthy institution's data still comes through — which is precisely why the
  // warning has to be surfaced separately instead of inferred from an empty result.
  assert.equal(transactions.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /Auth required/);
});

test("parseSimpleFinAccounts returns no warnings when errors[] is absent or malformed", () => {
  assert.deepEqual(parseSimpleFinAccounts({ accounts: [] }).warnings, []);
  assert.deepEqual(parseSimpleFinAccounts({ errors: "nope", accounts: [] }).warnings, []);
  assert.deepEqual(parseSimpleFinAccounts({ errors: [1, "real"], accounts: [] }).warnings, ["real"]);
});
