/**
 * Google OAuth for the live Sheet. Reuses the gbrain desktop OAuth client
 * (~/.gbrain/google-oauth.json, redirect http://localhost:8914) but mints a
 * SEPARATE token (accounting/.google-token.json, gitignored) scoped only for
 * Sheets + Drive.file — so it never touches the gbrain token the crons depend on.
 *
 * Run `npm run google-consent` once (Ariel clicks Allow) to create the token.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const TOKEN_PATH = join(projectRoot, ".google-token.json");
export const REDIRECT_PORT = 8914;
export const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;
/** Minimal scopes for the live Sheet: create + read/write our own spreadsheets. */
export const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
];

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

export function loadClient(): GoogleClient {
  const cfg = JSON.parse(readFileSync(join(HOME, ".gbrain", "google-oauth.json"), "utf8")) as {
    client_id: string;
    client_secret: string;
  };
  return { clientId: cfg.client_id, clientSecret: cfg.client_secret };
}

export function hasToken(): boolean {
  try {
    const t = JSON.parse(readFileSync(TOKEN_PATH, "utf8")) as { refresh_token?: string };
    return Boolean(t.refresh_token);
  } catch {
    return false;
  }
}

/** Exchange the stored refresh token for a fresh access token. */
export async function getAccessToken(): Promise<string> {
  if (!existsSync(TOKEN_PATH)) {
    throw new Error("No Google token. Run: npm run google-consent  (one-time Allow in the browser).");
  }
  const tok = JSON.parse(readFileSync(TOKEN_PATH, "utf8")) as { refresh_token?: string };
  if (!tok.refresh_token) throw new Error("Stored Google token has no refresh_token; re-run npm run google-consent.");
  const { clientId, clientSecret } = loadClient();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tok.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const j = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!j.access_token) {
    throw new Error(`Google token refresh failed: ${j.error ?? "unknown"} ${j.error_description ?? ""}`.trim());
  }
  return j.access_token;
}
