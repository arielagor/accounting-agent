/**
 * Single-instance node lock. The Windows Task Scheduler launcher spawns node
 * detached, so the scheduler's IgnoreNew guards only the launcher, not the long
 * node process — two overlapping runs could race shared state. This pid+ts
 * lockfile makes the NODE process single-instance. Fail-open: a lock error must
 * never block the agent. Ported from the proven claude-reference-line email-agent.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export interface Lock {
  acquired: boolean;
  release(): void;
}

/**
 * Try to acquire the lock at `lockFile`. `staleMs` is the age past which a lock
 * is presumed dead (set to longer than the longest expected run). Returns a Lock
 * whose `.acquired` is false if a live, fresh instance already holds it.
 */
export function acquireLock(lockFile: string, staleMs: number): Lock {
  const noop: Lock = { acquired: false, release: () => {} };
  try {
    if (existsSync(lockFile)) {
      const prev = JSON.parse(readFileSync(lockFile, "utf8")) as { pid?: number; ts?: number };
      const fresh = Date.now() - (prev.ts ?? 0) < staleMs;
      if (fresh && prev.pid && pidAlive(prev.pid)) return noop; // a live instance holds it
    }
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  } catch {
    // Fail-open: if we can't read/write the lock, proceed rather than block.
    return { acquired: true, release: () => {} };
  }
  return {
    acquired: true,
    release: () => {
      try {
        const cur = JSON.parse(readFileSync(lockFile, "utf8")) as { pid?: number };
        if (cur.pid === process.pid) unlinkSync(lockFile);
      } catch {
        // Already gone or unreadable — nothing to release.
      }
    },
  };
}
