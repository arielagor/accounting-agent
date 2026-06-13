/**
 * Minimal logger. Writes ISO-stamped lines to stdout/stderr and, when a log
 * directory is configured, appends to a dated file — mirrors the cron logging
 * pattern used across the portfolio. Library code logs through here rather than
 * raw console so output is consistent and file-capturable.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

let logDir: string | null = null;

export function configureLogDir(dir: string): void {
  logDir = dir;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Non-fatal: if the dir can't be made we still log to stdout.
    logDir = null;
  }
}

function emit(stream: NodeJS.WriteStream, level: string, parts: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${level} ${parts
    .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
    .join(" ")}`;
  stream.write(line + "\n");
  if (logDir) {
    const day = new Date().toISOString().slice(0, 10);
    try {
      appendFileSync(join(logDir, `accounting-${day}.log`), line + "\n");
    } catch {
      // Non-fatal: a log-file write failure must never break the run.
    }
  }
}

export function log(...parts: unknown[]): void {
  emit(process.stdout, "INFO", parts);
}

export function warn(...parts: unknown[]): void {
  emit(process.stderr, "WARN", parts);
}

export function error(...parts: unknown[]): void {
  emit(process.stderr, "ERROR", parts);
}
