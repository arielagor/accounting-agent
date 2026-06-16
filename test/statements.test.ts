/**
 * Statement parser tests (pure, no DB). OFX/QFX (signed TRNAMT) + CSV (single-amount,
 * debit/credit columns, sign flip, date formats).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOfx, parseCsv, looksLikeOfx } from "../src/core/statements.js";

const OFX = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240115120000[-5:EST]<TRNAMT>-19.99<FITID>A1<NAME>NETFLIX<MEMO>SUBSCRIPTION</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20240116<TRNAMT>1500.00<FITID>A2<NAME>PAYROLL</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

test("parseOfx extracts signed transactions with dates + ids", () => {
  const t = parseOfx(OFX);
  assert.equal(t.length, 2);
  assert.equal(t[0]!.date, "2024-01-15");
  assert.equal(t[0]!.amountCents, -1999);
  assert.equal(t[0]!.externalId, "A1");
  assert.match(t[0]!.description, /NETFLIX/);
  assert.equal(t[1]!.amountCents, 150000);
});

test("looksLikeOfx detects OFX vs CSV", () => {
  assert.equal(looksLikeOfx(OFX), true);
  assert.equal(looksLikeOfx("Date,Description,Amount\n01/15/2024,Coffee,-5.00"), false);
});

test("parseCsv handles a single signed Amount column + MM/DD/YYYY dates", () => {
  const csv = `Transaction Date,Description,Amount
01/15/2024,"NETFLIX, INC",-19.99
01/16/2024,Payroll Deposit,1500.00`;
  const t = parseCsv(csv);
  assert.equal(t.length, 2);
  assert.equal(t[0]!.date, "2024-01-15");
  assert.equal(t[0]!.amountCents, -1999);
  assert.equal(t[0]!.description, "NETFLIX, INC");
  assert.equal(t[1]!.amountCents, 150000);
});

test("parseCsv handles Debit/Credit columns (debit = outflow)", () => {
  const csv = `Date,Description,Debit,Credit
2024-02-01,Grocery,45.20,
2024-02-02,Refund,,12.00`;
  const t = parseCsv(csv);
  assert.equal(t[0]!.amountCents, -4520);
  assert.equal(t[1]!.amountCents, 1200);
});

test("parseCsv flip inverts a positive-charge Amount column", () => {
  const csv = `Date,Description,Amount
03/01/2024,Charge,19.99`;
  const t = parseCsv(csv, { flip: true });
  assert.equal(t[0]!.amountCents, -1999);
});
