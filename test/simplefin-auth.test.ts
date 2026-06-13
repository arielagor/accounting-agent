import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSimpleFinRequest } from "../src/providers/simplefin.js";

test("buildSimpleFinRequest moves basic-auth creds from the URL to an Authorization header", () => {
  const r = buildSimpleFinRequest("https://USER123:PASS456@bridge.simplefin.org/simplefin", 1700000000);
  assert.ok(!r.url.includes("USER123"), "url must not contain the username");
  assert.ok(!r.url.includes("PASS456"), "url must not contain the password");
  assert.equal(r.url, "https://bridge.simplefin.org/simplefin/accounts?start-date=1700000000&pending=1");
  assert.equal(r.headers.Authorization, "Basic " + Buffer.from("USER123:PASS456").toString("base64"));
});

test("buildSimpleFinRequest with no creds sets no Authorization header and strips a trailing slash", () => {
  const r = buildSimpleFinRequest("https://bridge.simplefin.org/simplefin/", 123);
  assert.equal(r.headers.Authorization, undefined);
  assert.equal(r.url, "https://bridge.simplefin.org/simplefin/accounts?start-date=123&pending=1");
});
