/**
 * .env loader. The Windows Task Scheduler launcher spawns node detached and
 * injects NO environment, so every runtime reads its config from a .env file
 * parsed here (then falls back to process.env). Same pattern as the proven
 * claude-reference-line email-agent.
 */
import { readFileSync } from "node:fs";

export type Env = Record<string, string>;

/** Parse a KEY=VALUE .env file into a plain object. Missing file → {} (fail-soft). */
export function parseEnvFile(path: string): Env {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // Fail-soft: a missing .env yields an empty map; callers fall back to process.env.
    return {};
  }
  const out: Env = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eq = trimmed.indexOf("=");
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** Merge a .env file over process.env (file wins where present). */
export function loadEnv(path: string): Env {
  const fromFile = parseEnvFile(path);
  const merged: Env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") merged[k] = v;
  }
  for (const [k, v] of Object.entries(fromFile)) merged[k] = v;
  return merged;
}

/** Read a required key or throw a clear error. */
export function required(env: Env, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required env: ${key}`);
  return v;
}
