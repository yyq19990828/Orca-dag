import { randomInt, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, rmdirSync, unlinkSync, type BigIntStats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const WAIT_MS = 5_000;
const OWNER = /^([1-9]\d{0,9})\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function info(path: string): BigIntStats | undefined {
  try { return lstatSync(path, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function realDirectory(path: string, found = info(path)): BigIntStats {
  if (!found?.isDirectory()) throw new Error(`${path} must be a real directory; left untouched`);
  return found;
}

function assertSameDirectory(path: string, expected: BigIntStats): void {
  const current = realDirectory(path);
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(`Session journal lock directory changed: ${path}`);
  }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

function removeIfPresent(remove: (path: string) => void, path: string): void {
  try { remove(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

interface JournalLock {
  temporary: string;
  assertHeld: () => void;
}

/**
 * A publisher keeps its unique marker from before the scan until after its
 * transaction. Of any two overlapping publishers, the later one's scan sees
 * the earlier one's marker until it releases. On any live conflict a publisher
 * drops its own marker and retries; it cannot promote itself over the holder.
 * This relies on local directory visibility and co-resident viewer processes
 * (one PID namespace). A stopped or reused PID is treated as live, never as
 * an expired lease. Different owners never reuse a marker, so simultaneous
 * reapers may remove only the dead owner's own lock and staging file.
 */
export async function withSessionJournalLock<T>(path: string, operation: (lock: JournalLock) => Promise<T>): Promise<T> {
  const directory = dirname(path);
  const initial = realDirectory(directory);
  const prefix = `${basename(path)}.lock.`;
  const assertDirectory = () => assertSameDirectory(directory, initial);
  const deadline = performance.now() + WAIT_MS;
  do {
    const name = `${prefix}${process.pid}.${randomUUID()}`;
    const claim = join(directory, name);
    assertDirectory();
    mkdirSync(claim, { mode: 0o700 });
    const identity = realDirectory(claim);
    const assertHeld = () => {
      assertDirectory();
      assertSameDirectory(claim, identity);
    };
    try {
      let occupied = false;
      for (const entry of readdirSync(directory)) {
        if (entry === name || !entry.startsWith(prefix)) continue;
        const owner = OWNER.exec(entry.slice(prefix.length));
        if (!owner) continue;
        assertDirectory();
        const other = join(directory, entry);
        const found = info(other);
        if (!found) continue; // another publisher released after our scan
        realDirectory(other, found);
        const pid = Number(owner[1]);
        if (pid > 0x7fffffff) throw new Error(`Invalid session journal lock owner: ${entry}`);
        if (isAlive(pid)) { occupied = true; break; }
        const staged = `${other}.tmp`;
        const temporary = info(staged);
        if (temporary && !temporary.isFile()) throw new Error(`${staged} must be a regular file; left untouched`);
        assertDirectory();
        if (temporary) removeIfPresent(unlinkSync, staged);
        removeIfPresent(rmdirSync, other); // rmdir never follows links or removes arbitrary contents
      }
      if (!occupied) {
        assertHeld();
        return await operation({ temporary: `${claim}.tmp`, assertHeld });
      }
    } finally {
      assertHeld();
      rmdirSync(claim);
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await delay(Math.min(randomInt(15, 40), remaining));
  } while (performance.now() < deadline);
  throw new Error("Timed out acquiring the session journal write lock; another viewer may still be writing");
}
