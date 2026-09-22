import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertDiscoveredWorktreeAudience,
  assertEnvironmentPlacementCompatibility,
  assertLanePlacementDisjoint,
  assertLaneReferences,
  createSecurityPolicy,
  tokensMatch,
  validateBaseBranch,
  validateConcurrency,
  validateCreationOptions,
  validateGroupAudience,
  validateGroupMessagePriority,
  validateGroupMessageType,
  validateHarness,
  validateId,
  validateLaneTaskMap,
  validateModel,
  validatePlacementSpec,
  validateSetupPolicy,
  validateTaskValueMap,
  validateText,
  validateWorktreeLaneMap,
  ValidationError,
} from "./security";
import type { WorktreeLaneSpec } from "./config";

const FLAG_OFF = createSecurityPolicy({});
const FLAG_ON = createSecurityPolicy({ ORCA_DAG_ALLOW_CUSTOM_COMMANDS: "1" });

function assertThrowsWith(fn: () => unknown, code?: string): ValidationError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
    if (code) assert.equal((err as ValidationError).code, code);
    return err as ValidationError;
  }
  throw new Error("expected function to throw");
}

describe("createSecurityPolicy", () => {
  it("generates a fresh 256-bit base64url token per process", () => {
    const a = createSecurityPolicy({});
    const b = createSecurityPolicy({});
    // 32 bytes → 43 base64url chars, no +/ padding to trip headers or shells
    assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a.token, b.token);
  });

  it("gates custom commands behind ORCA_DAG_ALLOW_CUSTOM_COMMANDS=1 exactly", () => {
    assert.equal(createSecurityPolicy({}).allowCustomCommands, false);
    assert.equal(createSecurityPolicy({ ORCA_DAG_ALLOW_CUSTOM_COMMANDS: "" }).allowCustomCommands, false);
    assert.equal(createSecurityPolicy({ ORCA_DAG_ALLOW_CUSTOM_COMMANDS: "true" }).allowCustomCommands, false);
    assert.equal(createSecurityPolicy({ ORCA_DAG_ALLOW_CUSTOM_COMMANDS: "1" }).allowCustomCommands, true);
  });
});

describe("tokensMatch", () => {
  it("accepts equal tokens", () => {
    assert.equal(tokensMatch("abc", "abc"), true);
  });
  it("rejects wrong tokens of any length without throwing", () => {
    // timingSafeEqual throws on length mismatch — the hash folding must absorb it
    assert.equal(tokensMatch("abc", "ab"), false);
    assert.equal(tokensMatch("nope", FLAG_OFF.token), false);
    assert.equal(tokensMatch("", "x"), false);
  });
});

describe("validateId", () => {
  it("accepts Orca-style ids and trims them", () => {
    assert.equal(validateId(" run_ab12cd34 ", "run"), "run_ab12cd34");
    assert.equal(validateId("task_1", "task"), "task_1");
    assert.equal(validateId("ctx_0d995a2e8e19", "ctx"), "ctx_0d995a2e8e19");
    assert.equal(validateId("term:abc-1.2", "terminal"), "term:abc-1.2");
  });
  it("maps empty/absent to null so callers can require the field", () => {
    assert.equal(validateId(undefined, "run"), null);
    assert.equal(validateId(null, "run"), null);
    assert.equal(validateId("", "run"), null);
    assert.equal(validateId("   ", "run"), null);
  });
  it("rejects path segments, whitespace and shell metacharacters", () => {
    assertThrowsWith(() => validateId("../etc/passwd", "run"));
    assertThrowsWith(() => validateId("run abc", "run"));
    assertThrowsWith(() => validateId("run;rm -rf /", "run"));
    assertThrowsWith(() => validateId("-rf", "run"));
    assertThrowsWith(() => validateId("a".repeat(200), "run"));
  });
});

describe("validateText", () => {
  it("trims and passes plain prose", () => {
    assert.equal(validateText("  ship the thing  ", "objective", 100), "ship the thing");
  });
  it("rejects control characters and oversized text", () => {
    assertThrowsWith(() => validateText("bad\u0000null", "objective", 100));
    assertThrowsWith(() => validateText("x".repeat(101), "objective", 100));
    assert.equal(validateText("x".repeat(100), "objective", 100), "x".repeat(100));
  });
});

describe("validateHarness", () => {
  it("lets known Orca agent ids through with zero setup", () => {
    for (const h of ["claude", "codex", "opencode", "gemini", "grok", "cursor", "droid", "kimi"]) {
      assert.equal(validateHarness(h, FLAG_OFF), h);
    }
  });
  it("rejects custom commands unless the policy allows them", () => {
    assertThrowsWith(() => validateHarness("aider --yolo", FLAG_OFF), "custom_commands_disabled");
    assertThrowsWith(() => validateHarness("zsh -c 'curl evil'", FLAG_OFF), "custom_commands_disabled");
    assert.equal(validateHarness("aider --yolo", FLAG_ON), "aider --yolo");
  });
  it("still sanity-checks custom commands when allowed", () => {
    assertThrowsWith(() => validateHarness("multi\nline", FLAG_ON));
    assertThrowsWith(() => validateHarness("-dash-first", FLAG_ON));
    assertThrowsWith(() => validateHarness("x".repeat(257), FLAG_ON));
    assertThrowsWith(() => validateHarness("", FLAG_ON));
  });
});

describe("validateModel", () => {
  it("enforces the provider/model grammar for opencode (same as enumeration)", () => {
    assert.equal(validateModel("zai-coding-plan/glm-5.3-flash", "opencode"), "zai-coding-plan/glm-5.3-flash");
    assert.equal(validateModel("openai/gpt-4o.mini_2", "opencode"), "openai/gpt-4o.mini_2");
    assertThrowsWith(() => validateModel("glm-5.3-flash", "opencode"), "invalid_model");
    assertThrowsWith(() => validateModel("zai/glm v2", "opencode"), "invalid_model");
    assertThrowsWith(() => validateModel("zai/glm;rm -rf /", "opencode"), "invalid_model");
    // interpolated into a shell line on the legacy path — metacharacters stay out
    assertThrowsWith(() => validateModel("zai/$(calc)", "opencode"), "invalid_model");
  });

  it("accepts the bounded #variant suffix for opencode, including zai-coding-plan/glm-5.3-flash#high", () => {
    assert.equal(validateModel("zai-coding-plan/glm-5.3-flash#high", "opencode"), "zai-coding-plan/glm-5.3-flash#high");
    assert.equal(validateModel("zai-coding-plan/glm-5.3-flash", "opencode"), "zai-coding-plan/glm-5.3-flash");
    assert.equal(validateModel("openai/gpt-5.1-codex#fast", "opencode"), "openai/gpt-5.1-codex#fast");
    assert.equal(validateModel("a/b#v1.2_x-y", "opencode"), "a/b#v1.2_x-y");
  });

  it("rejects malformed or shell-shaped #variant suffixes (epic A4)", () => {
    // spaces anywhere break the single-argument contract
    assertThrowsWith(() => validateModel("zai-coding-plan/glm-5.3-flash#hi gh", "opencode"), "invalid_model");
    assertThrowsWith(() => validateModel("zai-coding-plan/glm-5.3-flash #high", "opencode"), "invalid_model");
    // shell metacharacters — the value is quoted into a shell line on the legacy path
    assertThrowsWith(() => validateModel('zai-coding-plan/glm-5.3-flash#hi"gh', "opencode"), "invalid_model");
    assertThrowsWith(() => validateModel("zai-coding-plan/glm-5.3-flash#hi'gh", "opencode"), "invalid_model");
    assertThrowsWith(() => validateModel("zai-coding-plan/glm-5.3-flash#$(calc)", "opencode"), "invalid_model");
    assertThrowsWith(() => validateModel("zai-coding-plan/glm-5.3-flash#hi;gh", "opencode"), "invalid_model");
    assertThrowsWith(() => validateModel("zai-coding-plan/glm-5.3-flash#hi|gh", "opencode"), "invalid_model");
    assertThrowsWith(() => validateModel("zai-coding-plan/glm-5.3-flash#hi&gh", "opencode"), "invalid_model");
    assertThrowsWith(() => validateModel("zai-coding-plan/glm-5.3-flash#`id`", "opencode"), "invalid_model");
    assertThrowsWith(() => validateModel("zai-coding-plan/glm-5.3-flash#hi\\gh", "opencode"), "invalid_model");
    // exactly one # — never a second segment or extra path separators
    assertThrowsWith(() => validateModel("zai-coding-plan/glm-5.3-flash#high#low", "opencode"), "invalid_model");
    assertThrowsWith(() => validateModel("zai-coding-plan/glm-5.3-flash#high/x", "opencode"), "invalid_model");
    assertThrowsWith(() => validateModel("zai-coding-plan/glm-5.3-flash#", "opencode"), "invalid_model");
    assertThrowsWith(() => validateModel("zai#high", "opencode"), "invalid_model");
    // bounded length: a 65-char variant is rejected
    assertThrowsWith(() => validateModel(`zai-coding-plan/glm-5.3-flash#${"x".repeat(65)}`, "opencode"), "invalid_model");
  });

  it("keeps the #variant suffix opencode-only (plain harness grammar unchanged)", () => {
    assertThrowsWith(() => validateModel("zai-coding-plan/glm-5.3-flash#high", "claude"), "invalid_model");
    assert.equal(validateModel("gpt-5.1-codex-max", "codex"), "gpt-5.1-codex-max");
  });

  it("accepts plain free-text model names for the other harnesses only charset-bounded", () => {
    assert.equal(validateModel("opus", "claude"), "opus");
    assert.equal(validateModel("o3", "codex"), "o3");
    assert.equal(validateModel("gpt-4o", "cursor"), "gpt-4o");
    assertThrowsWith(() => validateModel("opus; rm -rf /", "claude"), "invalid_model");
    assertThrowsWith(() => validateModel("a b", "claude"), "invalid_model");
  });
});

describe("validateTaskValueMap", () => {
  it("maps absent to null, skips empty values, validates the rest", () => {
    assert.equal(validateTaskValueMap(undefined, "m", { maxKeys: 5, valueKind: "model" }, (v) => String(v)), null);
    assert.deepEqual(
      validateTaskValueMap({ task_1: "claude", task_2: "" }, "m", { maxKeys: 5, valueKind: "harness" }, (v) =>
        String(v),
      ),
      { task_1: "claude" },
    );
  });
  it("rejects non-objects, arrays, bad keys, oversized maps", () => {
    const opts = { maxKeys: 2, valueKind: "harness" };
    assertThrowsWith(() => validateTaskValueMap("nope", "m", opts, (v) => String(v)));
    assertThrowsWith(() => validateTaskValueMap(["claude"], "m", opts, (v) => String(v)));
    assertThrowsWith(() => validateTaskValueMap({ "../x": "claude" }, "m", opts, (v) => String(v)));
    assertThrowsWith(() =>
      validateTaskValueMap({ a: "1", b: "2", c: "3" }, "m", opts, (v) => String(v)),
    );
  });
  it("hands the task id to the value validator (effective-harness model checks)", () => {
    const seen: string[] = [];
    validateTaskValueMap({ task_9: "opus" }, "m", { maxKeys: 5, valueKind: "model" }, (v, key) => {
      seen.push(key);
      return String(v);
    });
    assert.deepEqual(seen, ["task_9"]);
  });
});

describe("validateConcurrency", () => {
  it("defaults when absent, clamps nothing (strict integers only)", () => {
    assert.equal(validateConcurrency(undefined), 4);
    assert.equal(validateConcurrency(""), 4);
    assert.equal(validateConcurrency(3), 3);
    assert.equal(validateConcurrency("2"), 2);
    assert.equal(validateConcurrency(16), 16);
    assert.equal(validateConcurrency(1), 1);
    assertThrowsWith(() => validateConcurrency(0));
    assertThrowsWith(() => validateConcurrency(17));
    assertThrowsWith(() => validateConcurrency(2.5));
    assertThrowsWith(() => validateConcurrency("abc"));
  });
});

// --- Phase 6 (safe group messaging) ------------------------------------------
//
// The audience allowlist is the boundary that keeps group mail deliberate:
// recipients are chosen from Orca's supported group grammar only, and a
// worktree audience additionally has to name a workspace Orca itself
// discovered. Everything a client could invent — handles, run:/dispatch:
// targets, lifecycle pseudo-groups — must fail here, before any Orca call.

describe("validateGroupAudience (Phase 6)", () => {
  it("accepts the Run-wide groups exactly", () => {
    assert.equal(validateGroupAudience("@all"), "@all");
    assert.equal(validateGroupAudience(" @idle "), "@idle");
  });

  it("accepts known harness groups and nothing harness-shaped beyond the allowlist", () => {
    for (const harness of ["claude", "codex", "opencode", "gemini", "grok", "cursor", "droid", "kimi"]) {
      assert.equal(validateGroupAudience(`@${harness}`), `@${harness}`);
    }
    // Not a harness, not a Run group: an invented group can never pass.
    assertThrowsWith(() => validateGroupAudience("@kernel"), "invalid_audience");
    assertThrowsWith(() => validateGroupAudience("@worker_done"), "invalid_audience");
    assertThrowsWith(() => validateGroupAudience("@heartbeat"), "invalid_audience");
  });

  it("accepts well-formed @worktree:<id> grammar (membership is a separate gate)", () => {
    assert.equal(
      validateGroupAudience("@worktree:901352a2-e6c4-4140-9c44-24d49beaea72::/home/me/project"),
      "@worktree:901352a2-e6c4-4140-9c44-24d49beaea72::/home/me/project",
    );
    assertThrowsWith(() => validateGroupAudience("@worktree:"), "invalid_audience");
  });

  it("rejects arbitrary, cross-Run and lifecycle recipient shapes outright", () => {
    assertThrowsWith(() => validateGroupAudience("dispatch:ctx_0d995a2e8e19"), "invalid_audience");
    assertThrowsWith(() => validateGroupAudience("run:run_25f6"), "invalid_audience");
    assertThrowsWith(() => validateGroupAudience("term_d08b78b5"), "invalid_audience");
    assertThrowsWith(() => validateGroupAudience("workers@example.com"), "invalid_audience");
    assertThrowsWith(() => validateGroupAudience("all"), "invalid_audience");
    assertThrowsWith(() => validateGroupAudience(""), "invalid_audience");
    assertThrowsWith(() => validateGroupAudience(undefined), "invalid_audience");
    assertThrowsWith(() => validateGroupAudience(`@${"x".repeat(300)}`), "invalid_audience");
  });
});

describe("assertDiscoveredWorktreeAudience (Phase 6)", () => {
  const discovered = async () => new Set(["wt-id-1", "901352a2::/repo"]);

  it("accepts an exact discovered worktree identity", async () => {
    await assertDiscoveredWorktreeAudience("@worktree:wt-id-1", discovered);
    await assertDiscoveredWorktreeAudience("@worktree:901352a2::/repo", discovered);
  });

  it("refuses a well-formed but undiscovered workspace with unknown_audience", async () => {
    await assert.rejects(
      () => assertDiscoveredWorktreeAudience("@worktree:not-discovered", discovered),
      (err: unknown) => err instanceof ValidationError && err.code === "unknown_audience",
    );
  });

  it("returns before discovery for every non-worktree shape", async () => {
    let called = false;
    await assertDiscoveredWorktreeAudience("@all", async () => {
      called = true;
      return new Set<string>();
    });
    await assertDiscoveredWorktreeAudience("@codex", async () => {
      called = true;
      return new Set<string>();
    });
    assert.equal(called, false, "non-worktree audiences must not spend a discovery read");
  });
});

describe("group message type + priority (Phase 6)", () => {
  it("allows only status and question, defaulting to status", () => {
    assert.equal(validateGroupMessageType(undefined), "status");
    assert.equal(validateGroupMessageType(null), "status");
    assert.equal(validateGroupMessageType("Status"), "status");
    assert.equal(validateGroupMessageType("question"), "question");
    // An explicit empty value is a malformed request, not a default.
    assertThrowsWith(() => validateGroupMessageType(""), "invalid_message_type");
  });

  it("forbids lifecycle group signals with a dedicated code", () => {
    assertThrowsWith(() => validateGroupMessageType("worker_done"), "forbidden_group_type");
    assertThrowsWith(() => validateGroupMessageType("heartbeat"), "forbidden_group_type");
    assertThrowsWith(() => validateGroupMessageType("escalation"), "invalid_message_type");
    assertThrowsWith(() => validateGroupMessageType("dispatch"), "invalid_message_type");
  });

  it("restricts priority to Orca's levels and defaults to none", () => {
    assert.equal(validateGroupMessagePriority(undefined), null);
    assert.equal(validateGroupMessagePriority(""), null);
    assert.equal(validateGroupMessagePriority("HIGH"), "high");
    assert.equal(validateGroupMessagePriority("urgent"), "urgent");
    assert.equal(validateGroupMessagePriority("low"), "low");
    assert.equal(validateGroupMessagePriority("normal"), "normal");
    assertThrowsWith(() => validateGroupMessagePriority("asap"), "invalid_priority");
    assertThrowsWith(() => validateGroupMessagePriority("normal; rm -rf /"), "invalid_priority");
  });
});

// --- Placement foundation: the full local matrix -----------------------------
//
// Local tasks may select any of the four placement kinds; creation metadata
// rides only on the two new-worktree kinds. Everything malformed, conflicting,
// remote-invalid, or shell-shaped must fail HERE — before any Orca mutation —
// with a machine-readable code.

describe("validatePlacementSpec: local four-kind matrix (placement foundation)", () => {
  it("accepts current and exact-existing with no creation fields", () => {
    assert.deepEqual(validatePlacementSpec({ kind: "current" }, "p"), { kind: "current" });
    assert.deepEqual(validatePlacementSpec({ kind: "existing", selector: " path:/srv/ws " }, "p"), {
      kind: "existing",
      selector: "path:/srv/ws",
    });
  });

  it("accepts new-child with bounded creation metadata", () => {
    assert.deepEqual(
      validatePlacementSpec(
        { kind: "new-child", name: "kid-wt", setup: "inherit", baseBranch: "feature/x", displayName: "Kid", comment: "lane" },
        "p",
      ),
      {
        kind: "new-child",
        name: "kid-wt",
        setup: "inherit",
        baseBranch: "feature/x",
        displayName: "Kid",
        comment: "lane",
      },
    );
  });

  it("accepts new-top-level with an exact repo selector and optional name", () => {
    assert.deepEqual(
      validatePlacementSpec({ kind: "new-top-level", repo: "id:repoA", name: "wt", setup: "skip" }, "p"),
      { kind: "new-top-level", repo: "id:repoA", name: "wt", setup: "skip" },
    );
    // Name is optional locally — the server derives a deterministic one.
    assert.deepEqual(validatePlacementSpec({ kind: "new-top-level", repo: "id:repoA" }, "p"), {
      kind: "new-top-level",
      repo: "id:repoA",
      setup: "run",
    });
  });

  it("normalizes an absent setup policy to Orca's default run", () => {
    const spec = validatePlacementSpec({ kind: "new-child", name: "kid" }, "p");
    assert.equal((spec as { setup: string }).setup, "run");
    assert.equal(validateCreationOptions({ name: "kid" }, "p").setup, "run");
  });

  it("rejects creation fields on current and existing placements (conflicting)", () => {
    for (const kind of [{ kind: "current" }, { kind: "existing", selector: "path:/srv/ws" }]) {
      for (const field of ["repo", "name", "baseBranch", "displayName", "comment", "setup"]) {
        assertThrowsWith(
          () => validatePlacementSpec({ ...kind, [field]: "x" }, "p"),
          "invalid_placement",
        );
      }
    }
  });

  it("rejects repo on new-child (a child anchors on the current workspace's repo)", () => {
    assertThrowsWith(
      () => validatePlacementSpec({ kind: "new-child", repo: "id:repoA" }, "p"),
      "invalid_placement",
    );
  });

  it("rejects shell-shaped or unbounded creation metadata", () => {
    assertThrowsWith(() => validatePlacementSpec({ kind: "new-child", name: "bad name" }, "p"), "invalid_placement");
    assertThrowsWith(() => validatePlacementSpec({ kind: "new-child", name: "-rf" }, "p"), "invalid_placement");
    assertThrowsWith(
      () => validatePlacementSpec({ kind: "new-child", baseBranch: "../escape" }, "p"),
      "invalid_base_branch",
    );
    assertThrowsWith(
      () => validatePlacementSpec({ kind: "new-child", baseBranch: "a b" }, "p"),
      "invalid_base_branch",
    );
    assertThrowsWith(
      () => validatePlacementSpec({ kind: "new-child", baseBranch: "feature/x; rm -rf /" }, "p"),
      "invalid_base_branch",
    );
    assertThrowsWith(() => validatePlacementSpec({ kind: "new-child", setup: "yolo" }, "p"), "invalid_setup");
    assertThrowsWith(
      () => validatePlacementSpec({ kind: "new-child", comment: "x".repeat(501) }, "p"),
      undefined,
    );
    assertThrowsWith(
      () => validatePlacementSpec({ kind: "new-top-level", repo: "id:repoA", displayName: "bad\u0000null" }, "p"),
      undefined,
    );
  });

  it("rejects unknown kinds and structurally invalid specs", () => {
    assertThrowsWith(() => validatePlacementSpec({ kind: "new-sibling" }, "p"), "invalid_placement");
    assertThrowsWith(() => validatePlacementSpec({ kind: "existing" }, "p"), "invalid_selector");
    assertThrowsWith(() => validatePlacementSpec({ kind: "new-top-level", name: "wt" }, "p"), "invalid_selector");
    assertThrowsWith(() => validatePlacementSpec("path:/srv/ws", "p"), "invalid_placement");
  });
});

describe("validatePlacementSpec: the remote matrix is preserved (foundation)", () => {
  const remote = { remote: true } as const;

  it("still refuses remote current and new-child", () => {
    assertThrowsWith(() => validatePlacementSpec({ kind: "current" }, "p", remote), "invalid_placement");
    assertThrowsWith(
      () => validatePlacementSpec({ kind: "new-child", name: "kid" }, "p", remote),
      "invalid_placement",
    );
  });

  it("still accepts remote exact-existing and name-complete new-top-level", () => {
    assert.deepEqual(
      validatePlacementSpec({ kind: "existing", selector: "id:repoA::/srv/ws" }, "p", remote),
      { kind: "existing", selector: "id:repoA::/srv/ws" },
    );
    assert.deepEqual(
      validatePlacementSpec(
        { kind: "new-top-level", repo: "id:repoA", name: "wt", setup: "skip" },
        "p",
        remote,
      ),
      { kind: "new-top-level", repo: "id:repoA", name: "wt", setup: "skip" },
    );
  });

  it("requires an explicit name for remote new-top-level (the host cannot derive one)", () => {
    assertThrowsWith(
      () => validatePlacementSpec({ kind: "new-top-level", repo: "id:repoA" }, "p", remote),
      "invalid_placement",
    );
  });
});

describe("placement creation field validators (foundation)", () => {
  it("validateSetupPolicy accepts exactly run/skip/inherit", () => {
    assert.equal(validateSetupPolicy("run"), "run");
    assert.equal(validateSetupPolicy(" skip "), "skip");
    assert.equal(validateSetupPolicy("inherit"), "inherit");
    assertThrowsWith(() => validateSetupPolicy("always"), "invalid_setup");
    assertThrowsWith(() => validateSetupPolicy(""), "invalid_setup");
  });

  it("validateBaseBranch accepts ref-shaped tokens and refuses traversal and flags", () => {
    assert.equal(validateBaseBranch("main"), "main");
    assert.equal(validateBaseBranch(" feature/x "), "feature/x");
    assert.equal(validateBaseBranch("release/v1.2.3"), "release/v1.2.3");
    assertThrowsWith(() => validateBaseBranch("../escape"), "invalid_base_branch");
    assertThrowsWith(() => validateBaseBranch("a..b"), "invalid_base_branch");
    assertThrowsWith(() => validateBaseBranch("-rf"), "invalid_base_branch");
    assertThrowsWith(() => validateBaseBranch("feature/"), "invalid_base_branch");
    assertThrowsWith(() => validateBaseBranch("main."), "invalid_base_branch");
    assertThrowsWith(() => validateBaseBranch("a b"), "invalid_base_branch");
    assertThrowsWith(() => validateBaseBranch(""), "invalid_base_branch");
  });

  it("validateCreationOptions keeps absent fields absent and validates present ones", () => {
    assert.deepEqual(validateCreationOptions({}, "p"), { setup: "run" });
    assert.deepEqual(validateCreationOptions({ name: undefined, setup: null }, "p"), { setup: "run" });
    assert.deepEqual(validateCreationOptions({ name: "wt", setup: "skip" }, "p"), {
      name: "wt",
      setup: "skip",
    });
    assertThrowsWith(() => validateCreationOptions({ name: "wt extra" }, "p"));
  });
});

describe("worktree lane request maps (foundation)", () => {
  it("validateWorktreeLaneMap accepts non-current seeds and drops nothing silently", () => {
    assert.deepEqual(
      validateWorktreeLaneMap(
        {
          lane_1: { placement: { kind: "new-child", name: "kid", setup: "run" } },
          lane_2: { placement: { kind: "existing", selector: "path:/srv/ws" } },
        },
        "lanes",
      ),
      {
        lane_1: { placement: { kind: "new-child", name: "kid", setup: "run" } },
        lane_2: { placement: { kind: "existing", selector: "path:/srv/ws" } },
      },
    );
  });

  it("refuses a lane seeded by current and malformed lane shapes", () => {
    assertThrowsWith(
      () => validateWorktreeLaneMap({ lane_1: { placement: { kind: "current" } } }, "lanes"),
      "invalid_placement",
    );
    assertThrowsWith(() => validateWorktreeLaneMap({ lane_1: { nope: true } }, "lanes"));
    assertThrowsWith(() => validateWorktreeLaneMap({ "bad lane": { placement: { kind: "new-child" } } }, "lanes"));
    assertThrowsWith(() => validateWorktreeLaneMap(["lane"], "lanes"));
  });

  it("validateLaneTaskMap validates both sides as ids", () => {
    assert.deepEqual(validateLaneTaskMap({ task_1: "lane_1" }, "laneByTask"), { task_1: "lane_1" });
    assertThrowsWith(() => validateLaneTaskMap({ task_1: "bad lane" }, "laneByTask"));
    assertThrowsWith(() => validateLaneTaskMap({ "bad task": "lane_1" }, "laneByTask"));
  });

  it("assertLaneReferences refuses a membership without a declared lane", () => {
    const lanes = {
      lane_1: { placement: { kind: "new-child", setup: "run" } },
    } satisfies Record<string, WorktreeLaneSpec>;
    assert.doesNotThrow(() => assertLaneReferences({ task_1: "lane_1" }, lanes));
    assert.throws(() => assertLaneReferences({ task_1: "lane_missing" }, lanes), ValidationError);
    assert.doesNotThrow(() => assertLaneReferences(null, null), "nothing to check");
  });

  it("assertLanePlacementDisjoint refuses a task placed directly AND by a lane", () => {
    assert.doesNotThrow(() =>
      assertLanePlacementDisjoint({ task_a: { kind: "current" } }, { task_b: "lane_1" }),
    );
    assert.throws(
      () => assertLanePlacementDisjoint({ task_a: { kind: "current" } }, { task_a: "lane_1" }),
      (err: unknown) => err instanceof ValidationError && err.code === "conflicting_placement",
    );
  });

  it("assertEnvironmentPlacementCompatibility enforces the remote matrix per task", () => {
    // Remote task on exact-existing: fine.
    assert.doesNotThrow(() =>
      assertEnvironmentPlacementCompatibility(
        { task_r: "env_remote" },
        { task_r: { kind: "existing", selector: "id:repoA::/srv/ws" } },
      ),
    );
    // Remote task on current/new-child: refused.
    assert.throws(
      () =>
        assertEnvironmentPlacementCompatibility({ task_r: "env_remote" }, { task_r: { kind: "current" } }),
      ValidationError,
    );
    assert.throws(
      () =>
        assertEnvironmentPlacementCompatibility(
          { task_r: "env_remote" },
          { task_r: { kind: "new-child", name: "kid", setup: "run" } },
        ),
      ValidationError,
    );
    // Remote nameless new-top-level: refused.
    assert.throws(
      () =>
        assertEnvironmentPlacementCompatibility(
          { task_r: "env_remote" },
          { task_r: { kind: "new-top-level", repo: "id:repoA", setup: "run" } },
        ),
      ValidationError,
    );
    // Local tasks are untouched by the remote matrix.
    assert.doesNotThrow(() =>
      assertEnvironmentPlacementCompatibility(null, { task_l: { kind: "new-child", setup: "run" } }),
    );
  });
});
