/**
 * AES-256-GCM secret encryption at rest. Ported from the agor-agents token-store
 * (same format: base64(iv).base64(tag).base64(ciphertext)) so the multi-tenant
 * Phase-2 SKU and this single-tenant Phase-1 agent share one encryption scheme.
 *
 * SimpleFIN/Plaid access tokens are stored ENCRYPTED in acct_connections.access_token_enc.
 * The plaintext token never lands on disk, in the repo, or in a log.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { warn } from "./log.js";

let warnedDevKey = false;

function encryptionKey(): Buffer {
  const env = process.env.INTEGRATION_ENC_KEY;
  if (env) {
    const buf = env.length === 64 ? Buffer.from(env, "hex") : Buffer.from(env, "base64");
    if (buf.length === 32) return buf;
  }
  if (!warnedDevKey) {
    warnedDevKey = true;
    warn(
      "INTEGRATION_ENC_KEY not set or invalid — using a DEV key. Set a 32-byte key (hex/base64) in production.",
    );
  }
  // Deterministic dev fallback — NOT for production. Encrypted blobs are still
  // unreadable without this exact key, but it is well-known, so set a real key.
  return scryptSync("accounting-agent-dev-key", "accounting-agent-dev-salt", 32);
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ct].map((b) => b.toString("base64")).join(".");
}

export function decryptSecret(blob: string): string {
  const parts = blob.split(".");
  if (parts.length !== 3) throw new Error("decryptSecret: malformed blob");
  const [ivb, tagb, ctb] = parts.map((s) => Buffer.from(s, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), ivb!);
  decipher.setAuthTag(tagb!);
  return Buffer.concat([decipher.update(ctb!), decipher.final()]).toString("utf8");
}

/** True when a real (non-dev) encryption key is configured. */
export function hasRealEncryptionKey(): boolean {
  const env = process.env.INTEGRATION_ENC_KEY;
  if (!env) return false;
  const buf = env.length === 64 ? Buffer.from(env, "hex") : Buffer.from(env, "base64");
  return buf.length === 32;
}
