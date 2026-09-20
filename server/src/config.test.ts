import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "./config";

/**
 * Config sanitization coverage (plan §9.1) for the Phase 5 field. The shape
 * contract is the same as modelByTask; what is actually new is the
 * compatibility guarantee: a pre-Phase-5 file lacks `effortByTask` entirely,
 * and hydration must leave it undefined rather than inventing an empty map —
 * "config hydration remains backward compatible with files lacking the new
 * maps" is an explicit acceptance criterion.
 */

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "orca-dag-config-test-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("config: effortByTask (Phase 5)", () => {
  it("round-trips a well-formed effort map through save + load", async () => {
    await saveConfig(dir, { effortByTask: { task_a: "high", task_b: "low" } });
    const loaded = await loadConfig(dir);
    assert.deepEqual(loaded.effortByTask, { task_a: "high", task_b: "low" });
  });

  it("drops malformed entries and keeps the well-typed rest", async () => {
    await saveConfig(dir, { effortByTask: { ok: "medium", empty: "   ", not_a_string: 42 } });
    const loaded = await loadConfig(dir);
    assert.deepEqual(loaded.effortByTask, { ok: "medium" });
  });

  it("hydrates a pre-Phase-5 file without the key (backward compatible)", async () => {
    // A file written by an older viewer: no effortByTask at all, plus a
    // unknown key the allowlist sanitizer must keep dropping.
    writeFileSync(
      join(dir, ".orca-dag.config.json"),
      JSON.stringify({
        defaultHarness: "claude",
        modelByTask: { task_1: "opus" },
        someFutureKey: { nested: true },
      }),
    );
    const loaded = await loadConfig(dir);
    assert.equal(loaded.defaultHarness, "claude");
    assert.deepEqual(loaded.modelByTask, { task_1: "opus" });
    assert.equal(loaded.effortByTask, undefined, "absent stays absent — no invented empty map");
    assert.equal((loaded as Record<string, unknown>).someFutureKey, undefined);
  });

  it("ignores a non-object effortByTask instead of poisoning the config", async () => {
    writeFileSync(
      join(dir, ".orca-dag.config.json"),
      JSON.stringify({ effortByTask: ["high"], defaultHarness: "codex" }),
    );
    const loaded = await loadConfig(dir);
    assert.equal(loaded.effortByTask, undefined);
    assert.equal(loaded.defaultHarness, "codex", "the rest of the file still loads");
  });
});

/**
 * Phase 6 fields: `environmentByTask` (saved-environment selectors) and
 * `placementByTask` (exact placement specs). The compatibility guarantee is
 * the same one Phase 5 pinned: a pre-Phase-6 file lacks both keys entirely and
 * must hydrate untouched — local/current stays the zero-configuration default.
 */
describe("config: environmentByTask + placementByTask (Phase 6)", () => {
  it("round-trips an environment map and drops malformed entries", async () => {
    await saveConfig(dir, {
      environmentByTask: { task_a: "env_remote", task_b: "   ", task_c: 42 },
    });
    const loaded = await loadConfig(dir);
    assert.deepEqual(loaded.environmentByTask, { task_a: "env_remote" });
  });

  it("round-trips all three placement kinds verbatim", async () => {
    await saveConfig(dir, {
      placementByTask: {
        task_local: { kind: "current" },
        task_existing: { kind: "existing", selector: "id:repoA::/srv/ws" },
        task_new: { kind: "new-top-level", repo: "id:repoA", name: "phase6-wt" },
      },
    });
    const loaded = await loadConfig(dir);
    assert.deepEqual(loaded.placementByTask, {
      task_local: { kind: "current" },
      task_existing: { kind: "existing", selector: "id:repoA::/srv/ws" },
      task_new: { kind: "new-top-level", repo: "id:repoA", name: "phase6-wt" },
    });
  });

  it("drops placement entries it cannot parse instead of guessing a shape", async () => {
    await saveConfig(dir, {
      placementByTask: {
        bad_kind: { kind: "new-child" }, // remote-ambiguous and unpersistable
        missing_selector: { kind: "existing" },
        empty_selector: { kind: "existing", selector: "  " },
        missing_repo: { kind: "new-top-level", name: "wt" },
        missing_name: { kind: "new-top-level", repo: "id:repoA" },
        not_object: "path:/srv/ws",
        extra_keys_survive: { kind: "existing", selector: "path:/srv/ws", host: "nope" },
      },
    });
    const loaded = await loadConfig(dir);
    assert.deepEqual(loaded.placementByTask, {
      extra_keys_survive: { kind: "existing", selector: "path:/srv/ws" },
    });
  });

  it("hydrates a pre-Phase-6 file without inventing the new maps", async () => {
    writeFileSync(
      join(dir, ".orca-dag.config.json"),
      JSON.stringify({ defaultHarness: "claude", modelByTask: { task_1: "opus" } }),
    );
    const loaded = await loadConfig(dir);
    assert.equal(loaded.environmentByTask, undefined, "absent stays absent — local/current default");
    assert.equal(loaded.placementByTask, undefined);
    assert.equal(loaded.defaultHarness, "claude");
  });

  it("ignores a non-object placementByTask instead of poisoning the config", async () => {
    writeFileSync(
      join(dir, ".orca-dag.config.json"),
      JSON.stringify({ placementByTask: [{ kind: "current" }], runId: "run_1" }),
    );
    const loaded = await loadConfig(dir);
    assert.equal(loaded.placementByTask, undefined);
    assert.equal(loaded.runId, "run_1", "the rest of the file still loads");
  });
});
