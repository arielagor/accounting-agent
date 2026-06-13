import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadEnv, parseEnvFile } from "../src/lib/env.js";

test("loadEnv hydrates process.env so libs reading process.env directly see .env values", () => {
  const p = join(tmpdir(), `acct-env-${process.pid}.env`);
  writeFileSync(p, "ACCT_TEST_HYDRATE=xyz123\n");
  try {
    delete process.env.ACCT_TEST_HYDRATE;
    const env = loadEnv(p);
    assert.equal(env.ACCT_TEST_HYDRATE, "xyz123");
    assert.equal(process.env.ACCT_TEST_HYDRATE, "xyz123", "process.env must be hydrated (token-store reads it)");
  } finally {
    rmSync(p, { force: true });
    delete process.env.ACCT_TEST_HYDRATE;
  }
});

test("parseEnvFile ignores comments and blanks and trims", () => {
  const p = join(tmpdir(), `acct-env2-${process.pid}.env`);
  writeFileSync(p, "# comment\n\nA=1\nB = two \n");
  try {
    const e = parseEnvFile(p);
    assert.equal(e.A, "1");
    assert.equal(e.B, "two");
    assert.equal(e["# comment"], undefined);
  } finally {
    rmSync(p, { force: true });
  }
});
