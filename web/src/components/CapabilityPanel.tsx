import { memo, useEffect, useState } from "react";
import { fetchCapabilities } from "../api";
import { UMBRELLA_CAPABILITY_IDS, type RuntimeCapabilitiesResponse } from "../types";

/**
 * Read-only runtime capability matrix (operations epic O1, Phase 1).
 *
 * Renders the canonical Orca 1.4.206 capability table as a readable list:
 * what the runtime positively advertised is "Supported"; documented older
 * aliases say so; everything else — unknown names, absent fields, no
 * advertisement at all — reads "Not advertised" and stays gated off. The
 * panel never infers support from the runtime version.
 *
 * Fetched once per page load: capability negotiation is runtime-owned state
 * that only changes with an Orca upgrade (which restarts the viewer anyway).
 */

const STATE_META: Record<
  "supported" | "alias" | "absent",
  { label: string; cls: string }
> = {
  supported: { label: "Supported", cls: "cap__state--on" },
  alias: { label: "Via legacy alias", cls: "cap__state--alias" },
  absent: { label: "Not advertised", cls: "cap__state--off" },
};

export const CapabilityPanel = memo(function CapabilityPanel() {
  const [view, setView] = useState<RuntimeCapabilitiesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchCapabilities()
      .then((next) => {
        if (alive) setView(next);
      })
      .catch((e) => {
        if (alive) setError(String((e as Error).message ?? e));
      });
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return (
      <section className="cap">
        <h4 className="cap__title">Runtime capabilities</h4>
        <p className="cap__error">The capability read failed: {error}</p>
      </section>
    );
  }
  if (!view) {
    return (
      <section className="cap">
        <h4 className="cap__title">Runtime capabilities</h4>
        <p className="cap__error">Reading the capability projection…</p>
      </section>
    );
  }

  return (
    <section className="cap">
      <h4 className="cap__title">
        Runtime capabilities
        <span className="cap__runtime">
          {view.runtime.cli}
          {view.runtime.version ? ` · Orca ${view.runtime.version}` : ""}
        </span>
      </h4>
      {view.advertised === null && (
        <p className="cap__note">
          This runtime source does not expose a capability advertisement, so every capability below
          reads “not advertised” — the viewer treats that as unsupported, never as a guess from the
          version number.
        </p>
      )}
      <ul className="cap__list">
        {view.capabilities.map((cap) => {
          // Umbrella rows (orchestration.contract.v1 / federation.v1) are
          // INFORMATIONAL: they name a family of narrower capabilities and
          // must never read as "everything under this is on". They render
          // their own badge and never gate a control (controls gate on the
          // specific canonical id / peer capability instead).
          const umbrella = UMBRELLA_CAPABILITY_IDS.has(cap.id);
          const meta = STATE_META[cap.state] ?? STATE_META.absent;
          return (
            <li
              key={cap.id}
              className={`cap__item${umbrella ? " cap__item--umbrella" : ""}`}
              title={`${cap.id}\n${cap.explanation}${umbrella ? "\n\nUmbrella row: informational only — it does not enable the narrower capabilities under it." : ""}`}
            >
              <span className="cap__label">
                {cap.label}
                {umbrella && <span className="cap__umbrella">umbrella · informational</span>}
              </span>
              <span className={`cap__state ${meta.cls}`}>{meta.label}</span>
              <span className="cap__explain">{cap.explanation}</span>
            </li>
          );
        })}
      </ul>
      {view.unknownAdvertised.length > 0 && (
        <p className="cap__note">
          Advertised but unrecognized here (kept off): {view.unknownAdvertised.join(", ")}
        </p>
      )}
      {view.capabilities.some((c) => UMBRELLA_CAPABILITY_IDS.has(c.id)) && (
        <p className="cap__note">
          Umbrella rows summarize capability families. They are display-only: the viewer enables a
          control only on the specific capability it belongs to, never on an umbrella alone.
        </p>
      )}
    </section>
  );
});
