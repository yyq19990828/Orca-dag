import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createSecurityPolicy,
  tokensMatch,
  validateConcurrency,
  validateHarness,
  validateId,
  validateModel,
  validateTaskValueMap,
  validateText,
  ValidationError,
} from "./security";

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
