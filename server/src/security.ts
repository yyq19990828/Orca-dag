import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  // The placement grammar constants live in config.ts, next to the stored
  // shape they describe — one grammar, consumed by the strict HTTP validators
  // below and by the tolerant config sanitizer. They cannot drift apart.
  BASE_BRANCH_PATTERN,
  COMMENT_MAX,
  DISPLAY_NAME_MAX,
  PLACEMENT_NAME_PATTERN,
  SETUP_POLICIES,
} from "./config";
import type { CreationOptions, PlacementSpec, SetupPolicy, WorktreeLaneSpec } from "./config";

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

/**
 * The same `provider/model` grammar `listModels()` in orca.ts enumerates,
 * extended with ONE optional bounded `#variant` suffix (Orca 1.4.206 epic A4:
 * the variant is part of the OpenCode model identity, e.g.
 * `zai-coding-plan/glm-5.3-flash#high`). The suffix is deliberately narrow:
 *  - exactly one `#`, never two (`zai/glm#high#low` is rejected);
 *  - the variant charset is the same safe token class as the rest —
 *    letters/digits/._- — so no spaces, quotes, `$`, backticks, shell
 *    operators or additional path separators can ride in with it;
 *  - the whole value still ends up as ONE argv element, quoted as a single
 *    argument on the legacy shell path (see `startOpencodeWorker`).
 */
export const OPENCODE_MODEL_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:#[A-Za-z0-9._-]{1,64})?$/;
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
 * grammar exactly — with an optional bounded `#variant` suffix (e.g.
 * `zai-coding-plan/glm-5.3-flash#high`). Other harnesses take plain model names through
 * `worker-start --model` argv — still charset-bound for defense in depth.
 */
export function validateModel(raw: unknown, harness: string): string {
  const v = String(raw ?? "").trim();
  if (!v) throw new ValidationError("model value must not be empty");
  if (harness === "opencode") {
    if (!OPENCODE_MODEL_PATTERN.test(v)) {
      throw new ValidationError(
        `opencode model "${v.slice(0, 64)}" must be a provider/model pair with an optional single ` +
          `#variant suffix (e.g. zai-coding-plan/glm-5.3-flash or zai-coding-plan/glm-5.3-flash#high)`,
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

/**
 * Explicit worktree names (`--name`): a short single token, not a path.
 * The pattern itself lives in config.ts (shared with the tolerant sanitizer).
 */
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
 * True when a creation-only field is PRESENT on a raw placement object.
 * Absent means the key is missing, null, undefined, or an explicit empty
 * string — the same "empty is absent" rule every task-value map applies, so
 * a UI that round-trips `name: ""` for "no name" is not a conflict.
 */
function creationFieldPresent(r: Record<string, unknown>, key: string): boolean {
  const v = r[key];
  return v !== undefined && v !== null && v !== "";
}

/**
 * The creation-only field names, used to refuse them where they do not
 * belong (current/existing placements — Orca's own CLI refuses the flags
 * there too, but refusing here fails before any Orca call) and to name them
 * in error messages.
 */
const CREATION_FIELDS = ["repo", "name", "baseBranch", "displayName", "comment", "setup"] as const;

/** One strict setup-policy value (`worker-start --setup run|skip|inherit`). */
export function validateSetupPolicy(raw: unknown, field = "setup"): SetupPolicy {
  const v = String(raw ?? "").trim();
  if (!v) throw new ValidationError(`${field} must not be empty`, "invalid_setup");
  if (!SETUP_POLICIES.has(v)) {
    throw new ValidationError(
      `${field} "${v.slice(0, 32)}" is not a setup policy (run, skip or inherit)`,
      "invalid_setup",
    );
  }
  return v as SetupPolicy;
}

/**
 * One base branch/ref (`--base-branch`). Charset-bounded by
 * `BASE_BRANCH_PATTERN` plus the ref-shaped exclusions git itself refuses:
 * no `..` climb, no trailing `/` or `.`.
 */
export function validateBaseBranch(raw: unknown, field = "baseBranch"): string {
  const v = String(raw ?? "").trim();
  if (!v) throw new ValidationError(`${field} must not be empty`, "invalid_base_branch");
  if (
    v.length > 128 ||
    !BASE_BRANCH_PATTERN.test(v) ||
    v.includes("..") ||
    v.endsWith("/") ||
    v.endsWith(".")
  ) {
    throw new ValidationError(
      `${field} ${JSON.stringify(v.slice(0, 64))} is not a usable git ref ` +
        `(letters, digits, . _ / -; no "..", no trailing "/" or ".")`,
      "invalid_base_branch",
    );
  }
  return v;
}

/**
 * The creation-only fields of one new-worktree placement, validated STRICTLY
 * (the HTTP boundary) with the same normalization the tolerant config
 * sanitizer applies: an absent `setup` becomes Orca's default `"run"`, so
 * every in-memory creation spec carries an explicit policy. Fields left out
 * of the request stay out of the result — except `setup`, which is never
 * optional in memory.
 */
export function validateCreationOptions(raw: unknown, field: string): CreationOptions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError(`${field} must be an object of creation fields`, "invalid_placement");
  }
  const r = raw as Record<string, unknown>;
  const out: CreationOptions = {
    setup: creationFieldPresent(r, "setup") ? validateSetupPolicy(r.setup, `${field}.setup`) : "run",
  };
  if (creationFieldPresent(r, "name")) out.name = validatePlacementName(r.name, `${field}.name`);
  if (creationFieldPresent(r, "baseBranch")) {
    out.baseBranch = validateBaseBranch(r.baseBranch, `${field}.baseBranch`);
  }
  if (creationFieldPresent(r, "displayName")) {
    const dn = validateText(r.displayName, `${field}.displayName`, DISPLAY_NAME_MAX);
    if (dn !== null) out.displayName = dn;
  }
  if (creationFieldPresent(r, "comment")) {
    const comment = validateText(r.comment, `${field}.comment`, COMMENT_MAX);
    if (comment !== null) out.comment = comment;
  }
  return out;
}

/**
 * Lift validated creation options onto a concrete placement shape. Plain
 * spreads (no casts): `setup` is always present on `creation`, the optional
 * fields ride along only when the request carried them.
 */
function childPlacement(creation: CreationOptions): PlacementSpec {
  return { kind: "new-child", ...creation };
}

function topLevelPlacement(repo: string, creation: CreationOptions): PlacementSpec {
  return { kind: "new-top-level", repo, ...creation };
}

/**
 * One placement spec from a request body, covering the FULL local matrix —
 * `current`, exact `existing`, `new-child`, `new-top-level` with creation
 * metadata — plus the remote restriction via `opts.remote`:
 *
 *  - `current` and `new-child` are meaningless on another server (remote =
 *    a saved environment): refused HERE with a 400, and the adapter refuses
 *    the same combination again as the last gate before Orca runs;
 *  - remote `new-top-level` requires an explicit `name` — the execution
 *    host cannot guess one, and derivation is a LOCAL convenience;
 *  - creation fields on current/existing are refused outright (conflicting
 *    fields), and `repo` on `new-child` is refused (a child anchors on the
 *    current workspace's own repo — it cannot select another).
 *
 * Returns the shared `PlacementSpec` union so a validated map is directly
 * assignable to the coordinator's StartOpts — no widening, no casts.
 */
export function validatePlacementSpec(
  raw: unknown,
  field: string,
  opts: { remote?: boolean } = {},
): PlacementSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError(
      `${field} must be an object like {"kind":"existing","selector":"…"}, ` +
        `{"kind":"new-child","name":"…"}, or {"kind":"new-top-level","repo":"…","name":"…"}`,
      "invalid_placement",
    );
  }
  const r = raw as Record<string, unknown>;
  const kind = typeof r.kind === "string" ? r.kind : "";
  if (kind === "current") {
    const conflicting = CREATION_FIELDS.filter((f) => creationFieldPresent(r, f));
    if (conflicting.length > 0) {
      throw new ValidationError(
        `${field} (current) rejects creation fields (${conflicting.join(", ")}) — ` +
          "the current workspace is never created and never reruns setup",
        "invalid_placement",
      );
    }
    if (opts.remote) {
      throw new ValidationError(
        `${field}: remote placement "current" is ambiguous across servers — ` +
          `choose an exact existing workspace selector discovered on the target environment, ` +
          `or new-top-level with an explicit repo and name.`,
        "invalid_placement",
      );
    }
    return { kind: "current" };
  }
  if (kind === "existing") {
    const selector = validateSelector(r.selector, `${field}.selector`);
    const conflicting = CREATION_FIELDS.filter((f) => creationFieldPresent(r, f));
    if (conflicting.length > 0) {
      throw new ValidationError(
        `${field} (existing) rejects creation fields (${conflicting.join(", ")}) — ` +
          "an exact existing workspace is never created and never reruns setup",
        "invalid_placement",
      );
    }
    return { kind: "existing", selector };
  }
  if (kind === "new-child") {
    if (opts.remote) {
      throw new ValidationError(
        `${field}: remote placement "new-child" is invalid — a stacked child would anchor on ` +
          `the wrong server. Use an exact existing workspace selector or new-top-level.`,
        "invalid_placement",
      );
    }
    if (creationFieldPresent(r, "repo")) {
      throw new ValidationError(
        `${field} (new-child) rejects "repo" — a stacked child anchors on the current ` +
          `workspace's own repo; use new-top-level to select one`,
        "invalid_placement",
      );
    }
    const creation = validateCreationOptions(r, field);
    return childPlacement(creation);
  }
  if (kind === "new-top-level") {
    const repo = validateSelector(r.repo, `${field}.repo`);
    const creation = validateCreationOptions(r, field);
    if (opts.remote && !creation.name) {
      throw new ValidationError(
        `${field}: remote new-top-level requires an explicit name — the execution ` +
          `host cannot derive one`,
        "invalid_placement",
      );
    }
    return topLevelPlacement(repo, creation);
  }
  throw new ValidationError(
    `${field}.kind must be "current", "existing", "new-child", or "new-top-level" — ` +
      `"${String(r.kind).slice(0, 32)}" is not a supported placement`,
    "invalid_placement",
  );
}

/**
 * A `{ taskId: PlacementSpec }` map. Strict like every task-value map: the
 * request is rejected on the first malformed entry rather than silently
 * degraded — a half-understood placement must never reach Orca. The optional
 * placement options (remote matrix) are passed through to every entry.
 */
export function validatePlacementTaskMap(
  raw: unknown,
  field: string,
  opts: { remote?: boolean } = {},
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
    out[key] = validatePlacementSpec(value, `${field}.${key}`, opts);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * A `{ laneId: WorktreeLaneSpec }` map (`worktreeLanes`). A lane's seed
 * placement may be exact existing, `new-child`, or `new-top-level` — never
 * `current`, which would quietly re-create the "serial chain on the
 * coordinator workspace" ambiguity lanes exist to remove.
 */
export function validateWorktreeLaneMap(
  raw: unknown,
  field: string,
): Record<string, WorktreeLaneSpec> | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError(`${field} must be an object of { laneId: { placement } }`);
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 200) {
    throw new ValidationError(`${field} has too many entries (max 200)`);
  }
  const out: Record<string, WorktreeLaneSpec> = {};
  for (const [laneId, value] of entries) {
    const id = laneId.trim();
    if (!ID_PATTERN.test(id)) {
      throw new ValidationError(`${field} has an invalid lane id key: ${JSON.stringify(laneId.slice(0, 64))}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ValidationError(`${field}.${id} must be an object with a "placement"`);
    }
    const placement = validatePlacementSpec(
      (value as Record<string, unknown>).placement,
      `${field}.${id}.placement`,
    );
    if (placement.kind === "current") {
      throw new ValidationError(
        `${field}.${id}.placement must not be "current" — a lane seeds from an exact ` +
          `existing workspace or a new worktree`,
        "invalid_placement",
      );
    }
    out[id] = { placement: placement as WorktreeLaneSpec["placement"] };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * A `{ taskId: laneId }` map (`laneByTask`). Both sides are Orca-style ids;
 * whether every lane id names a real `worktreeLanes` entry is checked by
 * `assertLaneReferences` at the same boundary.
 */
export function validateLaneTaskMap(raw: unknown, field: string): Record<string, string> | null {
  return validateTaskValueMap(raw, field, { maxKeys: 500, valueKind: "lane id" }, (v, key) => {
    const laneId = validateId(v, `${field}.${key}`);
    if (!laneId) throw new ValidationError(`${field}.${key} must not be empty`, "invalid_lane");
    return laneId;
  });
}

/**
 * Every lane id a task references must name a declared lane in the SAME
 * request — a dangling membership would start a worker with no placement at
 * all (or silently on `current`, which is worse because it looks intended).
 */
export function assertLaneReferences(
  laneByTask: Record<string, string> | null,
  worktreeLanes: Record<string, WorktreeLaneSpec> | null,
): void {
  if (!laneByTask) return;
  for (const [taskId, laneId] of Object.entries(laneByTask)) {
    if (!worktreeLanes?.[laneId]) {
      throw new ValidationError(
        `laneByTask.${taskId} references lane "${laneId}", which has no worktreeLanes entry`,
        "unknown_lane",
      );
    }
  }
}

/**
 * The task-level placement conflict: a task carries EITHER a direct
 * `placementByTask` entry OR a `laneByTask` membership, never both. A task in
 * a lane takes the lane's seed placement; a direct entry alongside it would
 * make "where does this worker run" depend on map iteration order.
 */
export function assertLanePlacementDisjoint(
  placementByTask: Record<string, PlacementSpec> | null,
  laneByTask: Record<string, string> | null,
): void {
  if (!placementByTask || !laneByTask) return;
  for (const taskId of Object.keys(placementByTask)) {
    if (laneByTask[taskId]) {
      throw new ValidationError(
        `task ${taskId} has both a placementByTask entry and a laneByTask membership ` +
          `("${laneByTask[taskId]}") — a task is placed directly OR by its lane, never both`,
        "conflicting_placement",
      );
    }
  }
}

/**
 * The task-level local/remote matrix: a task with a saved environment runs on
 * another server, where only exact-existing and new-top-level placement have
 * meaning. `current`/`new-child` (and a nameless remote new-top-level) are
 * refused here so the request fails at the boundary instead of at the
 * adapter's last gate.
 */
export function assertEnvironmentPlacementCompatibility(
  environmentByTask: Record<string, string> | null,
  placementByTask: Record<string, PlacementSpec> | null,
): void {
  if (!environmentByTask || !placementByTask) return;
  for (const taskId of Object.keys(environmentByTask)) {
    const placement = placementByTask[taskId];
    if (!placement) continue;
    // Re-run the remote rules through the same validator (never a hand copy):
    // the placement is already well-formed, so this only re-checks the matrix.
    validatePlacementSpec(placement, `placementByTask.${taskId}`, { remote: true });
  }
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

// --- Phase 6 (safe group messaging): audience, type and priority ------------
//
// Group mail is the one surface where the request would choose its own
// recipients, so the client-facing audience string is an allowlist, not a
// pattern: Orca's group grammar (`@all`, `@idle`, `@<harness>`,
// `@worktree:<id>`) is accepted only in those exact shapes, and a worktree
// audience must additionally name a workspace this viewer DISCOVERED from
// Orca itself. A client-supplied `run:<id>` / `dispatch:<id>` / bare handle
// is refused outright — recipient selection never crosses this boundary.

/** The Run-wide groups every Run supports (Orca-scoped to the sender's Run). */
export const RUN_GROUP_AUDIENCES: ReadonlySet<string> = new Set(["@all", "@idle"]);

/** `@worktree:<id>` — the id part must be a discovered Orca worktree identity. */
export const WORKTREE_AUDIENCE_PREFIX = "@worktree:";

/**
 * One group audience from a request body — GRAMMAR only. Orca's group grammar
 * (`@all`, `@idle`, `@<known harness>`, `@worktree:<id>`) is accepted in those
 * exact shapes; everything else — arbitrary addresses, `run:`/`dispatch:`
 * cross-Run targets, bare handles, pseudo-groups like `@worker_done` — is
 * rejected here before the route spends any Orca call. Worktree membership
 * (the id must be one Orca itself discovered) is a second gate:
 * `assertDiscoveredWorktreeAudience`.
 */
export function validateGroupAudience(raw: unknown): string {
  const v = String(raw ?? "").trim();
  if (!v) throw new ValidationError("audience must not be empty", "invalid_audience");
  if (v.length > 200) {
    throw new ValidationError("audience is too long (max 200 characters)", "invalid_audience");
  }
  if (!v.startsWith("@")) {
    throw new ValidationError(
      `audience must be an Orca group address starting with "@" (got ${JSON.stringify(v.slice(0, 64))})`,
      "invalid_audience",
    );
  }
  if (RUN_GROUP_AUDIENCES.has(v)) return v;
  if (v.startsWith(WORKTREE_AUDIENCE_PREFIX)) {
    const id = v.slice(WORKTREE_AUDIENCE_PREFIX.length);
    if (!id) {
      throw new ValidationError(
        "worktree audience must name a discovered worktree id (@worktree:<id>)",
        "invalid_audience",
      );
    }
    return v;
  }
  if (KNOWN_HARNESSES.has(v.slice(1))) return v;
  throw new ValidationError(
    `audience ${JSON.stringify(v.slice(0, 64))} is not a supported group ` +
      `(@all, @idle, a known harness group, or @worktree:<discovered id>)`,
    "invalid_audience",
  );
}

/**
 * The exactness gate for `@worktree:<id>` audiences: the id must be one of
 * the identities a FRESH Orca discovery returned (the callback re-reads
 * `worktree list` per send — the route never trusts a client-echoed list).
 * Discovery is awaited ONLY for worktree addresses — the other shapes return
 * before the route spends a CLI call. A well-formed but undiscovered
 * workspace is refused with `unknown_audience` so free-text workspace names
 * can never become recipients.
 */
export async function assertDiscoveredWorktreeAudience(
  audience: string,
  discoverWorktreeIds: () => Promise<ReadonlySet<string>>,
): Promise<void> {
  if (!audience.startsWith(WORKTREE_AUDIENCE_PREFIX)) return;
  const id = audience.slice(WORKTREE_AUDIENCE_PREFIX.length);
  if (!(await discoverWorktreeIds()).has(id)) {
    throw new ValidationError(
      `worktree audience ${JSON.stringify(audience.slice(0, 80))} is not one of this Run's discovered ` +
        "worktree identities; pick an audience from the composer's discovered list",
      "unknown_audience",
    );
  }
}

/**
 * Message types a GROUP send may carry. Orca itself refuses lifecycle group
 * traffic (`worker_done` and heartbeat are exact-Dispatch signals), and the
 * viewer refuses earlier and louder: a worker_done sent to a group would be
 * either a lifecycle forgery or a silent no-op, and both are worse than a
 * clear 400. Task-attempt guidance stays on the one-to-one route.
 */
export const GROUP_MESSAGE_TYPES: ReadonlySet<string> = new Set(["status", "question"]);

const LIFECYCLE_GROUP_TYPES: ReadonlySet<string> = new Set(["worker_done", "heartbeat"]);

export function validateGroupMessageType(raw: unknown): string {
  const v = String(raw ?? "status").trim().toLowerCase();
  if (GROUP_MESSAGE_TYPES.has(v)) return v;
  if (LIFECYCLE_GROUP_TYPES.has(v)) {
    throw new ValidationError(
      `"${v}" is a per-Dispatch lifecycle signal and can never be sent to a group`,
      "forbidden_group_type",
    );
  }
  throw new ValidationError(
    `group message type "${v.slice(0, 32)}" is not supported (status or question only)`,
    "invalid_message_type",
  );
}

/** Priorities the composer may attach to a group send (Orca's own levels). */
const GROUP_PRIORITIES: ReadonlySet<string> = new Set(["low", "normal", "high", "urgent"]);

export function validateGroupMessagePriority(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const v = String(raw).trim().toLowerCase();
  if (GROUP_PRIORITIES.has(v)) return v;
  throw new ValidationError(
    `priority "${String(raw).slice(0, 32)}" is not supported (low, normal, high or urgent)`,
    "invalid_priority",
  );
}
