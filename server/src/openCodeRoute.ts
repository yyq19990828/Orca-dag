import type { OpenCodeUi, PlacementSpec } from "./config";

export type OpenCodeRoute = "native-default" | "native-model" | "api-mini" | "api-tui" | "cli-run" | "unsupported";
export const MIN_OPENCODE_API_TUI_VERSION = "1.4.222";

export interface OpenCodeRouteInput {
  ui: OpenCodeUi;
  model: string | null;
  effort: string | null;
  environment: string | null;
  lane: boolean;
  placement: PlacementSpec;
  reuseTerminal: string | null;
  platform: string;
  runtimeVersion: string | null;
  nativeDefaultVersion: string;
  nativeModelVersion: string;
  capabilities: string[];
  tuiOptIn: boolean;
}

export interface OpenCodeRouteDecision {
  route: OpenCodeRoute;
  reason: string;
  reasonCode: string;
  limitations: string[];
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** One routing rule shared by read-only preview and the actual worker start. */
export function resolveOpenCodeRoute(input: OpenCodeRouteInput): OpenCodeRouteDecision {
  const { ui, model, effort, environment, lane, placement, reuseTerminal, platform, runtimeVersion, capabilities } = input;
  const versionKnown = typeof runtimeVersion === "string" && /^\d+\.\d+\.\d+$/.test(runtimeVersion);
  const versionAtLeast = (required: string) => versionKnown && compareVersions(runtimeVersion!, required) >= 0;
  const explicitUi = ui !== "auto";
  const apiRequested = explicitUi || (!!model && input.tuiOptIn);
  const apiCompatible = versionAtLeast(MIN_OPENCODE_API_TUI_VERSION);
  const apiPlacement = !environment && !lane && !reuseTerminal &&
    (explicitUi ? platform === "linux" : platform !== "win32") &&
    (placement.kind === "current" || placement.kind === "existing");
  if (apiRequested) {
    if (!apiPlacement || !apiCompatible) {
      const placementUnsupported = !apiPlacement;
      return {
        route: "unsupported",
        reason: placementUnsupported
          ? explicitUi
            ? "Explicit OpenCode UI supports only local Linux current/existing non-lane placements without terminal reuse."
            : "OpenCode API TUI supports only local POSIX current/existing non-lane placements without terminal reuse."
          : `OpenCode API TUI requires running Orca >= ${MIN_OPENCODE_API_TUI_VERSION}.`,
        reasonCode: placementUnsupported ? "apiUnsupportedPlacement" : "apiRuntimeTooOld",
        limitations: ["noFallback"],
      };
    }
    return {
      route: ui === "mini" ? "api-mini" : "api-tui",
      reason: explicitUi ? "Explicit OpenCode UI uses the viewer-managed API TUI." : "OpenCode TUI opt-in uses the viewer-managed API TUI.",
      reasonCode: "apiTui",
      limitations: ["apiNeedsPreparedRuntime"],
    };
  }
  const nativeModelEligible = !!model && !model.includes("#") && !effort && !environment && !lane &&
    !reuseTerminal && platform !== "win32" && (placement.kind === "current" || placement.kind === "existing");
  if (!model && versionAtLeast(input.nativeDefaultVersion)) {
    return { route: "native-default", reason: "Default OpenCode uses Orca's opencode2 native launcher.", reasonCode: "nativeDefault", limitations: [] };
  }
  if (nativeModelEligible && versionAtLeast(input.nativeModelVersion) &&
      capabilities.includes("orchestration.worker-launch-preferences.v1")) {
    return { route: "native-model", reason: "Explicit model is eligible for Orca's native OpenCode launcher.", reasonCode: "nativeModel", limitations: [] };
  }
  let reason = "OpenCode uses the CLI run compatibility path.";
  let reasonCode = "cliCompatibility";
  if (!versionKnown) {
    reason = "Runtime version is unknown; OpenCode uses CLI run compatibility.";
    reasonCode = "runtimeUnknown";
  } else if (!versionAtLeast(input.nativeDefaultVersion)) {
    reason = "Runtime is older than native OpenCode support; using CLI run compatibility.";
    reasonCode = "runtimeOld";
  } else if (model?.includes("#")) {
    reason = "Model variant cannot be passed to the native launcher; exact variant is preserved through CLI run.";
    reasonCode = "variantCli";
  } else if (effort) {
    reason = "Effort requires the CLI run compatibility path.";
    reasonCode = "effortCli";
  } else if (nativeModelEligible && versionAtLeast(input.nativeModelVersion)) {
    reason = "Runtime lacks worker-launch-preferences.v1; explicit model uses CLI run compatibility.";
    reasonCode = "capabilityMissing";
  }
  if (environment || lane || placement.kind !== "current") {
    return {
      route: "unsupported",
      reason: "The CLI run compatibility launcher cannot honor the selected worker placement.",
      reasonCode: "placementUnsupported",
      limitations: ["noFallback"],
    };
  }
  return {
    route: "cli-run", reason, reasonCode,
    limitations: ["cliNoFleetHooks", "providerEvidenceSeparate"],
  };
}
