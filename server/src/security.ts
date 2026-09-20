import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { PlacementSpec } from "./config";

/**
 * Local control-plane security (Phase 1 of the hardening plan).
 *
 * The viewer is a single-user, single-machine tool: it drives orchestration
 * mutations (`dispatch`, `gate-resolve`, `worker-start`, …) that fence real
 * agent terminals. It therefore listens on 127.0.0.1 only, ships no CORS, and
 * requires a per-process token on every mutation. Reads stay token-free so the
 * SPA, `curl` health checks and package smoke tests keep working unchanged.
 *
 * Threat model, honestly scoped: this is not multi-tenant hardening. It stops
 * the *accidental* attackers — any web page open in the browser (cross-origin
 * `fetch` used to work because of the unrestricted `cors()`), other users on a
 * shared host (the default Node listen binds every interface), and scripts that
 * find the port. A local process could still read `/api/session` — on a
 * single-user machine that is the same user.
 */

export interface SecurityPolicy {
  /** 256-bit per-process token; mutations must present it as `X-Orca-Dag-Token`. */
  token: string;
  /**
   * Custom harness commands are arbitrary shell lines handed to
   * `orca terminal create --command` — i.e. opt-in code execution. They are
   * rejected unless the operator sets `ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1`.
   * Known Orca agent ids (`claude`, `opencode`, …) stay zero-setup.
   */
  allowCustomCommands: boolean;
}

/** Build the process-scoped policy. Call once at startup (see index.ts). */
export function createSecurityPolicy(env: NodeJS.ProcessEnv = process.env): SecurityPolicy {
  return {
    // 32 random bytes → 256 bits, base64url so it survives HTTP headers and
    // shell copy-paste without escaping. Fresh every process start: nothing to
    // persist, nothing to leak from an old install.
    token: randomBytes(32).toString("base64url"),
    allowCustomCommands: env.ORCA_DAG_ALLOW_CUSTOM_COMMANDS === "1",
  };
}

/**
 * Constant-time token comparison.
 *
 * `timingSafeEqual` throws when the buffers differ in length, and byte length
 * is itself a timing leak — so both sides are hashed to a fixed 32-byte
 * digest first. SHA-256 collision resistance makes the folding harmless.
 */
export function tokensMatch(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Express middleware guarding one mutation route. 403 for a missing, malformed
 * or wrong token — before the handler validates any action-specific input, so
 * an unauthenticated caller can't use validation responses as an oracle.
 */
export function requireToken(policy: SecurityPolicy): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const presented = req.header("X-Orca-Dag-Token");
    if (typeof presented !== "string" || !tokensMatch(presented, policy.token)) {
      res.status(403).json({
        error:
          "Mutation rejected: missing or invalid X-Orca-Dag-Token. " +
          "Fetch it from GET /api/session (same origin only — the server sets no CORS).",
        code: "invalid_token",
      });
      return;
    }
    next();
  };
}

// --- Input validation -------------------------------------------------------
//
// Every request field is validated here instead of trusting TypeScript casts.
// Values end up in Orca CLI argv (spawned without a shell, so injection is not
// the failure mode) and in shell lines Orca itself runs inside worker
// terminals — the validators keep anything that isn't plainly an id, a model
// name, or an explicitly-opted-in command out of those paths.

/** A defensive error a route turns into HTTP 400 + a machine-readable code. */
export class ValidationError extends Error {
  readonly code: string;
  constructor(message: string, code = "invalid_input") {
    super(message);
    this.name = "ValidationError";
    this.code = code;
  }
}

/**
 * Orca ids (`run_*`, `task_*`, `gate_*`, `ctx_*`, terminal handles): short,
 * single token, no path separators or shell metacharacters. Anything else is
 * rejected before it reaches the CLI.
 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * The harness ids this viewer treats as "known Orca agents" — passed to
 * `worker-start --agent`, whose launcher Orca owns. Keep in sync with
 * `HARNESSES` in web/src/types.ts (the UI's picker list). Anything else is a
 * custom command and goes through the `allowCustomCommands` gate.
 */
export const KNOWN_HARNESSES: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "opencode",
  "gemini",
  "grok",
  "cursor",
  "droid",
  "kimi",
]);

const KNOWN_HARNESS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

/** The same `provider/model` grammar `listModels()` in orca.ts enumerates. */
export const OPENCODE_MODEL_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** claude/codex/cursor take free-text model names via `worker-start --model`. */
const PLAIN_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,127}$/;

/** Trim + validate an Orca id (run, task, gate). Empty → null so callers can require it. */
export function validateId(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null) return null;
  const v = String(raw).trim();
  if (!v) return null;
  if (!ID_PATTERN.test(v)) {
    throw new ValidationError(`${field} must look like an Orca id (got ${JSON.stringify(v.slice(0, 32))})`);
  }
  return v;
}

/** A non-empty, control-char-free free-text field (Run objective, gate resolution). */
export function validateText(raw: unknown, field: string, maxLen: number): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const v = String(raw).trim();
  if (!v) return null;
  if (v.length > maxLen) {
    throw new ValidationError(`${field} is too long (max ${maxLen} characters)`);
  }
  // eslint-disable-next-line no-control-regex — exactly what we are screening for
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v)) {
    throw new ValidationError(`${field} contains control characters`);
  }
  return v;
}

/**
 * One harness value from a request.
 *  - known Orca agent id → passes (zero-setup);
 *  - anything else is a custom shell command → only with the explicit opt-in
 *    env flag, and then still sanity-checked (single line, bounded length,
 *    no control characters — it becomes a terminal launch command).
 */
export function validateHarness(raw: unknown, policy: SecurityPolicy): string {
  const v = String(raw ?? "").trim();
  if (!v) throw new ValidationError("harness value must not be empty");
  if (KNOWN_HARNESSES.has(v)) return v;
  if (!policy.allowCustomCommands) {
    throw new ValidationError(
      `"${v.slice(0, 64)}" is not a known Orca agent id, so it runs as a custom shell command. ` +
        "Custom commands are disabled by default; set ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1 to allow them.",
      "custom_commands_disabled",
    );
  }
  if (v.length > 256) throw new ValidationError("custom harness command is too long (max 256 characters)");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) {
    throw new ValidationError("custom harness command must be a single line without control characters");
  }
  // `--command` is consumed as a value, but a leading dash would read as a
  // flag to `orca terminal create` — reject the ambiguity outright.
  if (v.startsWith("-")) throw new ValidationError("custom harness command must not start with '-'");
  return v;
}

/**
 * One model override. opencode models are interpolated into a shell line on
 * the legacy worker path, so they must match the enumerated `provider/model`
 * grammar exactly; other harnesses take plain model names through
 * `worker-start --model` argv — still charset-bound for defense in depth.
 */
export function validateModel(raw: unknown, harness: string): string {
  const v = String(raw ?? "").trim();
  if (!v) throw new ValidationError("model value must not be empty");
  if (harness === "opencode") {
    if (!OPENCODE_MODEL_PATTERN.test(v)) {
      throw new ValidationError(
        `opencode model "${v.slice(0, 64)}" must be a provider/model pair (e.g. zai/glm-5.3-flash)`,
        "invalid_model",
      );
    }
    return v;
  }
  if (!PLAIN_MODEL_PATTERN.test(v)) {
    throw new ValidationError(`model "${v.slice(0, 64)}" contains unsupported characters`, "invalid_model");
  }
  return v;
}

/**
 * One reasoning-effort level (Phase 5). `worker-start --effort` takes a plain
 * level word (Orca owns which levels exist); charset-bound here so nothing
 * argv-shaped can ride into the CLI inside a "level".
 */
export const EFFORT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

export function validateEffort(raw: unknown): string {
  const v = String(raw ?? "").trim();
  if (!v) throw new ValidationError("effort value must not be empty");
  if (!EFFORT_PATTERN.test(v)) {
    throw new ValidationError(`effort "${v.slice(0, 64)}" contains unsupported characters`, "invalid_effort");
  }
  return v;
}

export interface MapLimits {
  maxKeys: number;
  /** Describes the values in error messages, e.g. "harness". */
  valueKind: string;
}

/**
 * A `{ taskId: value }` map from a request body: must be a plain object with
 * safe id keys and per-value validation. Strict — the whole request is
 * rejected on the first bad entry, so a typo can't silently become a shell
 * command half-way through a run.
 */
export function validateTaskValueMap(
  raw: unknown,
  field: string,
  limits: MapLimits,
  validateValue: (value: unknown, key: string) => string,
): Record<string, string> | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError(`${field} must be an object of { taskId: ${limits.valueKind} }`);
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > limits.maxKeys) {
    throw new ValidationError(`${field} has too many entries (max ${limits.maxKeys})`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!ID_PATTERN.test(key)) {
      throw new ValidationError(`${field} has an invalid task id key: ${JSON.stringify(key.slice(0, 64))}`);
    }
    if (value === undefined || value === null || value === "") continue;
    out[key] = validateValue(value, key);
  }
  return out;
}

/** Concurrency: absent → default; present → a real integer in [1, 16]. */
export function validateConcurrency(raw: unknown, fallback = 4): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1 || n > 16) {
    throw new ValidationError("maxConcurrency must be an integer between 1 and 16");
  }
  return n;
}

/**
 * A `{ taskId: boolean }` map (currently `retainByTask`). Same key discipline
 * as `validateTaskValueMap`, but values must be real booleans — a string
 * "false" would silently behave as truthy downstream.
 */
export function validateBooleanTaskMap(raw: unknown, field: string): Record<string, boolean> | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError(`${field} must be an object of { taskId: boolean }`);
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 500) {
    throw new ValidationError(`${field} has too many entries (max 500)`);
  }
  const out: Record<string, boolean> = {};
  for (const [key, value] of entries) {
    if (!ID_PATTERN.test(key)) {
      throw new ValidationError(`${field} has an invalid task id key: ${JSON.stringify(key.slice(0, 64))}`);
    }
    if (typeof value !== "boolean") {
      throw new ValidationError(`${field}.${key} must be a boolean`);
    }
    if (value) out[key] = true;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// --- Phase 6: saved environments + exact placement ---------------------------
//
// Environment selectors and placement specs end up as `worker-start --on` /
// `--worktree` / `--repo` / `--name` argv. The charset rules below are the
// HTTP-boundary half of the contract; the adapter's `assertValidWorkerStart`
// is the last gate and refuses remote `current`/`new-child` even if a caller
// bypassed this layer.

/** Saved-environment selectors (`environment list` ids/names): single token. */
export function validateEnvironmentSelector(raw: unknown, field = "environment"): string {
  const v = String(raw ?? "").trim();
  if (!v) throw new ValidationError(`${field} selector must not be empty`, "invalid_environment");
  if (!ID_PATTERN.test(v)) {
    throw new ValidationError(
      `${field} selector must be a plain saved-environment id or name (got ${JSON.stringify(v.slice(0, 64))})`,
      "invalid_environment",
    );
  }
  return v;
}

/**
 * Worktree/repo selectors (`id:<repoId>::<path>`, `path:<dir>`, `name:<x>`,
 * `branch:<ref>`): allow the separator characters real selectors contain —
 * but still no whitespace, quotes, control characters, or shell metacharacters.
 */
const SELECTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/\\-]{0,255}$/;

export function validateSelector(raw: unknown, field: string): string {
  const v = String(raw ?? "").trim();
  if (!v) throw new ValidationError(`${field} must not be empty`, "invalid_selector");
  if (!SELECTOR_PATTERN.test(v)) {
    throw new ValidationError(
      `${field} must look like an Orca selector (got ${JSON.stringify(v.slice(0, 64))})`,
      "invalid_selector",
    );
  }
  return v;
}

/** Explicit worktree names (`--name`): a short single token, not a path. */
const PLACEMENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function validatePlacementName(raw: unknown, field: string): string {
  const v = String(raw ?? "").trim();
  if (!v) throw new ValidationError(`${field} must not be empty`, "invalid_placement");
  if (!PLACEMENT_NAME_PATTERN.test(v)) {
    throw new ValidationError(
      `${field} must be a short name (letters, digits, . _ - — got ${JSON.stringify(v.slice(0, 64))})`,
      "invalid_placement",
    );
  }
  return v;
}

/** One validated placement choice — the same discriminated union the config store keeps. */
export type ValidatedPlacement = PlacementSpec;

/**
 * One placement spec from a request body. Remote-ambiguous shapes are
 * rejected HERE with a 400 — `new-child` is not a supported kind at all, and
 * `current` never combines with an environment (the coordinator refuses that
 * combination again at start time; belt and suspenders on purpose). Returns
 * the shared `PlacementSpec` union so a validated map is directly assignable
 * to the coordinator's StartOpts — no widening, no casts.
 */
export function validatePlacementSpec(raw: unknown, field: string): PlacementSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError(`${field} must be an object like {"kind":"existing","selector":"…"} or {"kind":"new-top-level","repo":"…","name":"…"}`, "invalid_placement");
  }
  const r = raw as Record<string, unknown>;
  const kind = typeof r.kind === "string" ? r.kind : "";
  if (kind === "current") return { kind: "current" };
  if (kind === "existing") {
    const selector = validateSelector(r.selector, `${field}.selector`);
    return { kind: "existing", selector };
  }
  if (kind === "new-top-level") {
    const repo = validateSelector(r.repo, `${field}.repo`);
    const name = validatePlacementName(r.name, `${field}.name`);
    return { kind: "new-top-level", repo, name };
  }
  throw new ValidationError(
    `${field}.kind must be "current", "existing", or "new-top-level" — ` +
      `"${String(r.kind).slice(0, 32)}" is not a supported placement` +
      (kind === "new-child" ? " (new-child is remote-ambiguous and unsupported)" : ""),
    "invalid_placement",
  );
}

/**
 * A `{ taskId: PlacementSpec }` map. Strict like every task-value map: the
 * request is rejected on the first malformed entry rather than silently
 * degraded — a half-understood placement must never reach Orca.
 */
export function validatePlacementTaskMap(
  raw: unknown,
  field: string,
): Record<string, PlacementSpec> | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError(`${field} must be an object of { taskId: placementSpec }`);
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 500) {
    throw new ValidationError(`${field} has too many entries (max 500)`);
  }
  const out: Record<string, ValidatedPlacement> = {};
  for (const [key, value] of entries) {
    if (!ID_PATTERN.test(key)) {
      throw new ValidationError(`${field} has an invalid task id key: ${JSON.stringify(key.slice(0, 64))}`);
    }
    if (value === undefined || value === null) continue;
    out[key] = validatePlacementSpec(value, `${field}.${key}`);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * A `{ taskId: environmentSelector }` map (which saved environment runs the
 * node). Shape-level only: whether a selector names a REAL environment is
 * checked at start time (`environment_unknown` start failure) so the HTTP
 * layer never needs a CLI round-trip.
 */
export function validateEnvironmentTaskMap(
  raw: unknown,
  field: string,
): Record<string, string> | null {
  return validateTaskValueMap(raw, field, { maxKeys: 500, valueKind: "environment selector" }, (v) =>
    validateEnvironmentSelector(v, field),
  );
}
