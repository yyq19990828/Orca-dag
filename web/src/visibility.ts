import { useEffect, useState } from "react";

/**
 * Whether this viewer tab can actually be seen.
 *
 * Orca's embedded browser disables background-tab timer throttling
 * (IntensiveWakeUpThrottling is off in its launch flags), so a hidden tab
 * keeps firing its 2s polls at full speed and re-rasterizing feTurbulence
 * regions nobody is watching — one of the heaviest costs this page has.
 * Every periodic viewer-API caller in the app reads this flag and gates its
 * interval on it:
 *
 *  - while hidden the effect returns early: the interval never arms, so no
 *    periodic request is issued (in-flight work still settles on its own);
 *  - flipping back to visible re-runs the effect, which performs exactly one
 *    immediate refresh per active poller and then re-arms the interval.
 *
 * Extracted here so App, RunPicker, RunHealthBadge and the Operations panels
 * all share one visibility source of truth. Component-local dirty-flag logic
 * (ActivityPanel's hidden-markers) composes with this rather than replacing
 * it — that logic decides whether a *missed* update needs replaying, while
 * this flag decides whether to poll at all.
 */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}
