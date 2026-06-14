/**
 * One-time Google consent for the live Sheet. Opens the browser, captures the code
 * at http://localhost:8914 (the gbrain client's registered redirect), exchanges it,
 * and saves a Sheets+Drive.file token to accounting/.google-token.json. Reuses the
 * gbrain OAuth client but a SEPARATE token, so the gbrain crons are untouched.
 *
 * Usage: npm run google-consent   (then click Allow)
 */
import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { writeFileSync, chmodSync } from "node:fs";
import { URL } from "node:url";
import { loadClient, SCOPES, REDIRECT_PORT, REDIRECT_URI, TOKEN_PATH } from "../src/lib/google-auth.js";
import { log, error } from "../src/lib/log.js";

const { clientId, clientSecret } = loadClient();
const authUrl =
  `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code` +
  `&scope=${encodeURIComponent(SCOPES.join(" "))}&access_type=offline&prompt=consent`;

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
    res.end(`<h1 style="color:green">Connected!</h1><p>The accounting agent can now write your live Sheet. You can close this tab.</p>`);
  } catch (e) {
    error("token exchange failed:", e instanceof Error ? e.message : String(e));
    res.end(`<h1 style="color:red">Token exchange failed</h1><p>${e instanceof Error ? e.message : String(e)}</p>`);
  }
  server.close();
  setTimeout(() => process.exit(0), 800);
});

server.listen(REDIRECT_PORT, () => {
  log(`Opening Google consent. If the browser doesn't open, visit:\n${authUrl}\n`);
  try {
    if (process.platform === "win32") execSync(`start "" "${authUrl}"`);
    else if (process.platform === "darwin") execSync(`open "${authUrl}"`);
    else execSync(`xdg-open "${authUrl}"`);
  } catch {
    log("Could not open the browser automatically; open the URL above.");
  }
});

setTimeout(() => {
  error("Timed out waiting for consent (5 min).");
  server.close();
  process.exit(1);
}, 5 * 60 * 1000);
