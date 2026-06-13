/**
 * One-time interactive account linking (SimpleFIN). The access URL (which embeds
 * read-only credentials) is encrypted at rest in acct_connections.access_token_enc
 * — it never lands on disk in plaintext, in the repo, or in a log.
 *
 * Ariel runs this with his OWN SimpleFIN setup token (a one-way door — his creds):
 *   1. Create a SimpleFIN bridge connection at https://bridge.simplefin.org and
 *      copy the one-time SETUP TOKEN.
 *   2. node --import tsx bin/link.ts --setup-token <token> [--institution "Chase"]
 *   3. Map each account to a ledger account:
 *      node --import tsx bin/link.ts --map <providerAccountId>=<ledgerCode> ...
 *   Re-auth an expired connection:
 *      node --import tsx bin/link.ts --reconnect <connId> --setup-token <newToken>
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/lib/env.js";
import { openSql } from "../src/core/db.js";
import { encryptSecret } from "../src/lib/token-store.js";
import { getProvider } from "../src/providers/index.js";
import { log, warn, error } from "../src/lib/log.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function args(flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === flag && process.argv[i + 1]) out.push(process.argv[i + 1]!);
  }
  return out;
}

/** Claim a SimpleFIN setup token -> the long-lived access URL. */
async function claimSetupToken(setupToken: string): Promise<string> {
  const claimUrl = Buffer.from(setupToken, "base64").toString("utf8").trim();
  if (!/^https?:\/\//.test(claimUrl)) {
    throw new Error("setup token did not decode to a claim URL");
  }
  const res = await fetch(claimUrl, { method: "POST" });
  if (!res.ok) throw new Error(`claim failed: ${res.status} ${await res.text()}`);
  const accessUrl = (await res.text()).trim();
  if (!/^https?:\/\//.test(accessUrl)) throw new Error("claim did not return an access URL");
  return accessUrl;
}

async function main(): Promise<void> {
  const env = loadEnv(join(root, ".env"));
  const url = arg("--url") ?? env.ACCT_DB_URL;
  if (!url) {
    error("ACCT_DB_URL not set");
    process.exit(1);
  }
  const tenant = env.TENANT_ID ?? "ariel";
  const sql = openSql(url);

  const mapPairs = args("--map");
  const setupToken = arg("--setup-token");
  const reconnect = arg("--reconnect");

  try {
    // --map: set ledger_account_code on existing source accounts.
    if (mapPairs.length > 0) {
      for (const pair of mapPairs) {
        const [pid, code] = pair.split("=");
        if (!pid || !code) {
          warn(`bad --map "${pair}" (want providerAccountId=ledgerCode)`);
          continue;
        }
        const updated = await sql`
          UPDATE acct_source_accounts SET ledger_account_code = ${code}
          WHERE tenant_id = ${tenant} AND provider_account_id = ${pid}`;
        log(`mapped ${pid} -> ${code} (${updated.count} row)`);
      }
      return;
    }

    if (!setupToken) {
      log("No --setup-token given. To link an institution:");
      log("  1) Create a connection at https://bridge.simplefin.org and copy the setup token");
      log("  2) node --import tsx bin/link.ts --setup-token <token> --institution <name>");
      log("  3) node --import tsx bin/link.ts --map <providerAccountId>=<ledgerCode> ...");
      log("Current connections:");
      const conns = await sql<{ id: number; institution_name: string | null; status: string }[]>`
        SELECT id, institution_name, status FROM acct_connections WHERE tenant_id = ${tenant} ORDER BY id`;
      for (const c of conns) log(`  #${c.id} ${c.institution_name ?? "(unnamed)"} [${c.status}]`);
      return;
    }

    const accessUrl = await claimSetupToken(setupToken);
    const enc = encryptSecret(accessUrl);

    let connId: number;
    if (reconnect) {
      connId = Number(reconnect);
      await sql`
        UPDATE acct_connections SET access_token_enc = ${enc}, status = 'active',
          consecutive_failures = 0 WHERE id = ${connId} AND tenant_id = ${tenant}`;
      log(`reconnected connection #${connId}`);
    } else {
      const [row] = await sql<{ id: number }[]>`
        INSERT INTO acct_connections (tenant_id, provider, institution_name, access_token_enc, status)
        VALUES (${tenant}, 'simplefin', ${arg("--institution") ?? "SimpleFIN"}, ${enc}, 'active')
        RETURNING id`;
      connId = row!.id;
      log(`created connection #${connId}`);
    }

    // List + persist the accounts so they can be ledger-mapped.
    const provider = getProvider("simplefin");
    const accounts = await provider.listAccounts(accessUrl);
    for (const a of accounts) {
      await sql`
        INSERT INTO acct_source_accounts
          (connection_id, tenant_id, provider_account_id, name, mask, type, subtype, currency)
        VALUES (${connId}, ${tenant}, ${a.providerAccountId}, ${a.name}, ${a.mask ?? null},
                ${a.type ?? null}, ${a.subtype ?? null}, ${a.currency})
        ON CONFLICT (connection_id, provider_account_id) DO UPDATE SET name = EXCLUDED.name`;
      log(`  account: ${a.providerAccountId}  ${a.name}  (map it: --map ${a.providerAccountId}=<ledgerCode>)`);
    }
    log("Linked. Next: map each account to a ledger code (1010 checking, 2010 a card, etc.).");
  } catch (e) {
    error("link failed:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  error("link fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
