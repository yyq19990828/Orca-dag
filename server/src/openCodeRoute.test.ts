import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveOpenCodeRoute } from "./openCodeRoute";
import type { OpenCodeRouteInput } from "./openCodeRoute";

function route(overrides: Partial<OpenCodeRouteInput> = {}) {
  return resolveOpenCodeRoute({
    ui: "auto", model: null, effort: null, environment: null, lane: false,
    placement: { kind: "current" }, reuseTerminal: null, platform: "linux",
    runtimeVersion: "1.4.241", nativeDefaultVersion: "1.4.220", nativeModelVersion: "1.4.241",
    capabilities: ["orchestration.worker-launch-preferences.v1"],
    tuiOptIn: false, ...overrides,
  });
}

describe("OpenCode route decision", () => {
  it("selects native default and native explicit model only behind their runtime gates", () => {
    assert.equal(route().route, "native-default");
    assert.equal(route({ model: "openai/gpt-6.1-sol" }).route, "native-model");
    assert.equal(route({ model: "openai/gpt-6.1-sol", capabilities: [] }).route, "cli-run");
    assert.equal(route({ model: "openai/gpt-6.1-sol", runtimeVersion: "1.4.240" }).route, "cli-run");
  });

  it("preserves model variants through CLI run rather than dropping the suffix", () => {
    const decision = route({ model: "openai/gpt-6.1-sol#xhigh" });
    assert.equal(decision.route, "cli-run");
    assert.equal(decision.reasonCode, "variantCli");
    assert.deepEqual(decision.limitations, ["cliNoFleetHooks", "providerEvidenceSeparate"]);
  });

  it("keeps explicit Mini/TUI strict without requiring an explicit model", () => {
    assert.equal(route({ ui: "mini" }).route, "api-mini");
    assert.equal(route({ ui: "tui" }).route, "api-tui");
    assert.equal(route({ ui: "mini", runtimeVersion: "1.4.221" }).route, "unsupported");
    assert.equal(route({ ui: "tui", environment: "remote" }).route, "unsupported");
  });

  it("keeps explicit UI Linux-only while preserving the POSIX full-TUI opt-in", () => {
    assert.equal(route({ ui: "mini", platform: "darwin" }).route, "unsupported");
    assert.equal(route({ ui: "tui", platform: "win32" }).route, "unsupported");
    assert.equal(route({ model: "openai/gpt-6.1-sol#xhigh", tuiOptIn: true, platform: "darwin" }).route, "api-tui");
  });

  it("uses compatibility for unknown runtimes but refuses placements that path cannot honor", () => {
    assert.equal(route({ runtimeVersion: null }).route, "cli-run");
    assert.equal(route({ model: "openai/gpt-6.1-sol#xhigh", placement: { kind: "existing", selector: "id:repo::/work" } }).route, "unsupported");
    assert.equal(route({ model: "openai/gpt-6.1-sol", effort: "xhigh" }).route, "cli-run");
  });

  it("requires explicit TUI opt-in to choose the API TUI for a model override", () => {
    assert.equal(route({ model: "openai/gpt-6.1-sol", tuiOptIn: true }).route, "api-tui");
  });
});
