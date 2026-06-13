/**
 * Re-key stored connection secrets to the current INTEGRATION_ENC_KEY.
 *
 * For each connection: if the blob already decrypts under the current key, leave it.
 * Otherwise try the deterministic DEV key (the fallback used when no key was set) and,
 * if that works, re-encrypt under the current key. Idempotent and safe to re-run; also
 * the tool to use after a key rotation (set old key aside, set new key, run this).
 *
 * Reads the .env FILE directly (does NOT hydrate process.env) so it can toggle the key
 * between decrypt attempts. Usage: node --import tsx bin/rekey.ts
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "../src/lib/env.js";
import { openSql } from "../src/core/db.js";
import { encryptSecret, decryptSecret } from "../src/lib/token-store.js";
import { log, warn, error } from "../src/lib/log.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function tryDecrypt(blob: string): string | null {
  try {
    return decryptSecret(blob);
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const fileEnv = parseEnvFile(join(root, ".env"));
  const realKey = fileEnv.INTEGRATION_ENC_KEY;
  const url = fileEnv.ACCT_DB_URL ?? process.env.ACCT_DB_URL;
  if (!realKey) {
    error("INTEGRATION_ENC_KEY not set in .env — nothing to re-key to.");
    process.exit(1);
  }
  if (!url) {
    error("ACCT_DB_URL not set");
    process.exit(1);
  }
  const sql = openSql(url);
  try {
    const conns = await sql<{ id: number; access_token_enc: string }[]>`
      SELECT id, access_token_enc FROM acct_connections ORDER BY id`;
    let rekeyed = 0;
    let ok = 0;
    let stuck = 0;
    for (const c of conns) {
      // Already under the real key?
      process.env.INTEGRATION_ENC_KEY = realKey;
      if (tryDecrypt(c.access_token_enc) !== null) {
        ok += 1;
        continue;
      }
      // Try the deterministic dev key (no key set).
      delete process.env.INTEGRATION_ENC_KEY;
      const plain = tryDecrypt(c.access_token_enc);
      if (plain === null) {
        warn(`connection ${c.id}: cannot decrypt under current OR dev key — left untouched`);
        stuck += 1;
        continue;
      }
      process.env.INTEGRATION_ENC_KEY = realKey;
      const reblob = encryptSecret(plain);
      await sql`UPDATE acct_connections SET access_token_enc = ${reblob} WHERE id = ${c.id}`;
      log(`connection ${c.id}: re-keyed dev -> current`);
      rekeyed += 1;
    }
    log(`rekey done: ${rekeyed} re-keyed, ${ok} already current, ${stuck} unrecoverable`);
  } catch (e) {
    error("rekey failed:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  error("rekey fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
