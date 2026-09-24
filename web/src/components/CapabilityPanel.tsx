import { memo, useEffect, useState } from "react";
import { fetchCapabilities } from "../api";
import { useT, type TranslationKey } from "../i18n";
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
  { labelKey: TranslationKey; cls: string }
> = {
  supported: { labelKey: "capability.state.supported", cls: "cap__state--on" },
  alias: { labelKey: "capability.state.alias", cls: "cap__state--alias" },
  absent: { labelKey: "capability.state.absent", cls: "cap__state--off" },
};

export const CapabilityPanel = memo(function CapabilityPanel() {
  const t = useT();
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
        <h4 className="cap__title">{t("capability.title")}</h4>
        <p className="cap__error">{t("capability.error", { error })}</p>
      </section>
    );
  }
  if (!view) {
    return (
      <section className="cap">
        <h4 className="cap__title">{t("capability.title")}</h4>
        <p className="cap__error">{t("capability.loading")}</p>
      </section>
    );
  }

  return (
    <section className="cap">
      <h4 className="cap__title">
        {t("capability.title")}
        <span className="cap__runtime">
          {view.runtime.cli}
          {view.runtime.version ? ` · Orca ${view.runtime.version}` : ""}
        </span>
      </h4>
      {view.advertised === null && (
        <p className="cap__note">{t("capability.noAdvertisement")}</p>
      )}
      {view.advertised !== null && (
        <p className="cap__note">{t("capability.localAdvertisement")}</p>
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
              title={`${cap.id}\n${cap.explanation}${umbrella ? `\n\n${t("capability.umbrellaTitle")}` : ""}`}
            >
              <span className="cap__label">
                {cap.label}
                {umbrella && <span className="cap__umbrella">{t("capability.umbrellaBadge")}</span>}
              </span>
              <span className={`cap__state ${meta.cls}`}>{t(meta.labelKey)}</span>
              <span className="cap__explain">{cap.explanation}</span>
            </li>
          );
        })}
      </ul>
      {view.unknownAdvertised.length > 0 && (
        <p className="cap__note">{t("capability.unknownAdvertised")} {view.unknownAdvertised.join(", ")}</p>
      )}
      {view.capabilities.some((c) => UMBRELLA_CAPABILITY_IDS.has(c.id)) && (
        <p className="cap__note">{t("capability.umbrellaNote")}</p>
      )}
    </section>
  );
});
