/**
 * Generate a VAPID keypair for Web Push, once. Prints the three .env lines to paste.
 * The private key is a secret — it goes in .env (gitignored), never committed.
 *
 * Usage: npm run vapid-keys   (then paste the output into .env and restart the dashboard)
 */
import webpush from "web-push";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
process.stdout.write(
  [
    "# Web Push VAPID keys (paste into .env — keep VAPID_PRIVATE_KEY secret)",
    `VAPID_PUBLIC_KEY=${publicKey}`,
    `VAPID_PRIVATE_KEY=${privateKey}`,
    "VAPID_SUBJECT=mailto:ariel@agor.me",
    "",
  ].join("\n"),
);
