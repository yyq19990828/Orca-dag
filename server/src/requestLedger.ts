// Durable mutation-request ledger (Phase 5: recovery and output audit).
//
// Every viewer-originated mutation that carries a durable `--retry-request`
// id (worker-start / worker-release / worker-retain / worker-stop) is
// recorded HERE, before the CLI call, with the ids needed to later ask Orca
// `request-show --request <id>` what happened — including after a response
// loss or a viewer restart, which is exactly when the coordinator's
// in-memory attempt projection no longer exists.
//
// Hard limits, by design:
//   * The ledger is NOT a second lifecycle authority. It stores identities
//     and viewer-observed notes only; the recorded state of a mutation is
//     always re-read live from Orca (`request-show`). `absent` there never
//     proves a mutation did not happen, and nothing in this file ever
//     overrides a fleet row.
//   * Bounded: ids are charset-clamped, notes are sliced, the file rotates
//     like the activity journal, and loads cap the returned rows. No
//     credentials and no transcript bodies ever belong here.
//   * Atomic: append-only JSONL behind a serialized write chain — the same
//     durability expectations as ActivityJournal (a torn final line is
//     skipped, not fatal; rotation keeps the file small; updates are new
//     lines, and the LAST line for a request id wins on read).

import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const REQUESTS_FILE = ".orca-dag.requests.jsonl";

/** The only mutations this viewer runs under a durable retry-request id. */
export type RequestOperation = "worker-start" | "worker-release" | "worker-retain" | "worker-stop";

/**
 * Bounded metadata for one viewer-originated mutation request. Ids only —
 * never receipts, payloads, or transcript bodies (those stay in Orca; the
 * audit surface reads them back live via `request-show`).
 */
export interface MutationRequestMeta {
  /** The `--retry-request` id the mutation ran (or will run) under. */
  requestId: string;
  operation: RequestOperation;
  /**
   * Run scope, when the recorded operation positively supplies one. Null
   * means "scope unknown" — the record stays inspectable under any Run,
   * labeled as unscoped, rather than being dropped or mis-scoped.
   */
  runId: string | null;
  /** Task/Dispatch linkage, when known at record time (start learns it late). */
  taskId: string | null;
  dispatchId: string | null;
  /** Bounded, viewer-observed note (≤300 chars). Null = nothing observed yet. */
  note?: string | null;
  /**
   * True only when THIS viewer observed a definitive outcome during the
   * original call. It is a presentation hint, never authority — the live
   * `request-show` probe decides what the audit view reports.
   */
  settledLocally?: boolean;
}

interface PersistedRequestRecord {
  recordType: "mutation_request";
  requestId: string;
  operation: string;
  runId: string | null;
  taskId: string | null;
  dispatchId: string | null;
  note: string | null;
  settledLocally: boolean | null;
  /** First time this request id was minted. */
  createdAt: string;
  /** Last time this viewer appended an observation about it. */
  updatedAt: string;
}

/** A deduplicated ledger row as the audit surface receives it. */
export type RequestLedgerRecord = PersistedRequestRecord;

/** Rotation thresholds — identical policy to the activity journal. */
const JOURNAL_MAX_BYTES = 5 * 1024 * 1024;
const JOURNAL_KEEP_BYTES = 2 * 1024 * 1024;
/** Rows returned per load, newest first. Bounded even before rotation kicks in. */
const MAX_RECORDS = 200;
const MAX_NOTE = 300;
const MAX_ID = 128;

/** Clamp an id-shaped field to what the security boundary already allows. */
function clampId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return v ? v.slice(0, MAX_ID) : null;
}

/** Clamp a free-text note: single line budget, no unbounded receipts. */
function clampNote(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const v = value.replace(/\s+/g, " ").trim();
  if (!v) return null;
  return v.length > MAX_NOTE ? `${v.slice(0, MAX_NOTE - 3)}...` : v;
}

export class RequestLedger {
  readonly path: string;
  /** Serialize append+rotation so concurrent mutations cannot race a rotate. */
  private appendChain: Promise<void> = Promise.resolve();

  constructor(workspaceDir: string) {
    this.path = join(workspaceDir, REQUESTS_FILE);
  }

  /**
   * Append one observation for a request id. Appending the SAME id again is
   * the update mechanism: the first line fixes `createdAt`, the last line
   * wins for everything else. Never throws out of the caller's mutation path
   * — callers still wrap this best-effort, but a ledger failure must not be
   * what turns a live mutation ambiguous.
   */
  async record(meta: MutationRequestMeta): Promise<void> {
    const requestId = clampId(meta.requestId);
    if (!requestId) return; // nothing inspectable to persist — skip silently
    const now = new Date().toISOString();
    const record: PersistedRequestRecord = {
      recordType: "mutation_request",
      requestId,
      operation: clampId(meta.operation) ?? "unknown",
      runId: clampId(meta.runId),
      taskId: clampId(meta.taskId),
      dispatchId: clampId(meta.dispatchId),
      note: clampNote(meta.note),
      settledLocally:
        typeof meta.settledLocally === "boolean" ? meta.settledLocally : null,
      createdAt: now,
      updatedAt: now,
    };
    const write = this.appendChain.then(async () => {
      await this.rotateIfNeeded();
      await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
    });
    // Keep the queue usable after one failed write; the caller still sees the
    // original failure and treats the ledger as best-effort audit state.
    this.appendChain = write.catch(() => {});
    await write;
  }

  /**
   * Deduplicated rows, newest request first: the FIRST occurrence of an id
   * fixes `createdAt`, the LAST wins for every other field. A torn final
   * line (crash mid-append) is skipped, exactly like the activity journal.
   */
  async list(): Promise<RequestLedgerRecord[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const byId = new Map<string, RequestLedgerRecord>();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Partial<PersistedRequestRecord>;
        if (!parsed || parsed.recordType !== "mutation_request") continue;
        const requestId = clampId(parsed.requestId);
        if (!requestId) continue;
        const existing = byId.get(requestId);
        const record: RequestLedgerRecord = {
          recordType: "mutation_request",
          requestId,
          operation: clampId(parsed.operation) ?? existing?.operation ?? "unknown",
          runId: clampId(parsed.runId) ?? existing?.runId ?? null,
          taskId: clampId(parsed.taskId) ?? existing?.taskId ?? null,
          dispatchId: clampId(parsed.dispatchId) ?? existing?.dispatchId ?? null,
          note: clampNote(parsed.note) ?? existing?.note ?? null,
          settledLocally:
            typeof parsed.settledLocally === "boolean"
              ? parsed.settledLocally
              : (existing?.settledLocally ?? null),
          createdAt: existing?.createdAt ?? (typeof parsed.createdAt === "string" ? parsed.createdAt : ""),
          updatedAt:
            typeof parsed.updatedAt === "string" && parsed.updatedAt
              ? parsed.updatedAt
              : (existing?.updatedAt ?? ""),
        };
        byId.set(requestId, record);
      } catch {
        // A torn final append must not make the whole ledger unreadable.
      }
    }
    return [...byId.values()]
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      .slice(0, MAX_RECORDS);
  }

  private async rotateIfNeeded(): Promise<void> {
    let size = 0;
    try {
      size = (await stat(this.path)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (size < JOURNAL_MAX_BYTES) return;
    const data = await readFile(this.path);
    const start = Math.max(0, data.length - JOURNAL_KEEP_BYTES);
    const firstNewline = data.indexOf(0x0a, start);
    const kept = firstNewline >= 0 ? data.subarray(firstNewline + 1) : data.subarray(start);
    await writeFile(this.path, kept);
  }
}
