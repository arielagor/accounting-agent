/**
 * One-time Google consent for the live Sheet. Two modes:
 *
 *  - DEFAULT (browser ON THIS PC): starts a localhost:8914 server, opens the consent
 *    page, captures the redirect, exchanges the code, saves the token.
 *  - --code "<pasted url or code>": exchanges a code you copied from the redirect URL
 *    (use this when you clicked Allow on a PHONE — the redirect to localhost fails on
 *    the phone, but the address bar holds `?code=...`; paste that here). No server needed.
 *
 * Saves a Sheets+Drive.file token to accounting/.google-token.json (reuses the gbrain
 * OAuth client; separate token, so the gbrain crons are untouched).
 *
 * Usage: npm run google-consent            (PC browser)
 *        npm run google-consent -- --code "http://localhost:8914/?code=4/0A...&scope=..."
 */
import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { writeFileSync, chmodSync } from "node:fs";
import { URL } from "node:url";
import { loadClient, SCOPES, REDIRECT_PORT, REDIRECT_URI, TOKEN_PATH } from "../src/lib/google-auth.js";
import { log, error } from "../src/lib/log.js";

const { clientId, clientSecret } = loadClient();

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const authUrl =
  `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code` +
  `&scope=${encodeURIComponent(SCOPES.join(" "))}&access_type=offline&prompt=consent`;

/** Extract the bare auth code from a pasted full redirect URL or a raw code string. */
function extractCode(input: string): string {
  const s = input.trim();
  if (s.includes("code=")) {
    try {
      const u = new URL(s.includes("://") ? s : `http://localhost:${REDIRECT_PORT}${s.startsWith("/") ? s : "/" + s}`);
      const c = u.searchParams.get("code");
      if (c) return c;
    } catch {
      // fall through to regex
    }
    const m = /[?&]code=([^&\s]+)/.exec(s);
    if (m) return decodeURIComponent(m[1]!);
  }
  return s; // assume the input IS the raw code
}

async function exchangeAndSave(code: string): Promise<void> {
  const tr = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  const t = (await tr.json()) as {
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (t.error || !t.refresh_token) {
    throw new Error(`${t.error ?? "no refresh_token"} ${t.error_description ?? ""}`.trim());
  }
  writeFileSync(
    TOKEN_PATH,
    JSON.stringify(
      {
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        token_type: t.token_type,
        expiry_date: Date.now() + (t.expires_in ?? 3600) * 1000,
        scope: t.scope,
        obtained_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  try {
    chmodSync(TOKEN_PATH, 0o600);
  } catch {
    // Windows: chmod is a no-op; the file is in the gitignored project root.
  }
  log(`Google token saved to ${TOKEN_PATH}. Scopes: ${t.scope}`);
}

async function main(): Promise<void> {
  const pasted = arg("--code");
  if (pasted) {
    // Phone path: exchange the pasted code directly, no server.
    await exchangeAndSave(extractCode(pasted));
    log("Done — the live Sheet is now authorized.");
    return;
  }

  // PC path: run the local redirect server.
  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", REDIRECT_URI);
    const code = u.searchParams.get("code");
    const err = u.searchParams.get("error");
    if (err) {
      res.end(`<h1>Authorization failed</h1><p>${err}</p>`);
      error(`consent error: ${err}`);
      server.close();
      process.exit(1);
    }
    if (!code) {
      res.end("<h1>Waiting for authorization…</h1>");
      return;
    }
    try {
      await exchangeAndSave(code);
      res.end(`<h1 style="color:green">Connected!</h1><p>The accounting agent can now write your live Sheet. You can close this tab.</p>`);
    } catch (e) {
      error("token exchange failed:", e instanceof Error ? e.message : String(e));
      res.end(`<h1 style="color:red">Token exchange failed</h1><p>${e instanceof Error ? e.message : String(e)}</p>`);
    }
    server.close();
    setTimeout(() => process.exit(0), 800);
  });

  server.listen(REDIRECT_PORT, () => {
    log(`Open this on THIS computer (not your phone) — localhost only works on the machine running the agent:\n${authUrl}\n`);
    try {
      if (process.platform === "win32") execSync(`start "" "${authUrl}"`);
      else if (process.platform === "darwin") execSync(`open "${authUrl}"`);
      else execSync(`xdg-open "${authUrl}"`);
    } catch {
      log("Could not open the browser automatically; open the URL above on this PC.");
    }
  });

  setTimeout(() => {
    error("Timed out waiting for consent (60 min).");
    server.close();
    process.exit(1);
  }, 60 * 60 * 1000);
}

main().catch((e) => {
  error("consent fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
