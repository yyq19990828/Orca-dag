import { useCallback, useEffect, useRef, useState } from "react";
import { fetchRunHealth } from "./api";
import type { RunHealthView } from "./types";
import { usePageVisible } from "./visibility";

const POLL_MS = 5_000;

/**
 * Single shared, visibility-gated `/api/run-health` poller for a Run.
 * Lifted to App / SidebarApp so Topbar badge, Coordinator card, Canvas hub,
 * Settings mode overview, and RunsView share ONE request stream instead of
 * duplicating five-CLI fan-out reads.
 */
export function useRunHealth(
  runId: string,
  enabled = true,
): { health: RunHealthView | null; refresh: () => Promise<void> } {
  const [health, setHealth] = useState<RunHealthView | null>(null);
  const visible = usePageVisible();
  const seqRef = useRef(0);
  const runIdRef = useRef(runId);
  runIdRef.current = runId;

  const refresh = useCallback(async () => {
    const targetRun = runIdRef.current;
    if (!targetRun) {
      setHealth(null);
      return;
    }
    const seq = ++seqRef.current;
    try {
      const next = await fetchRunHealth(targetRun);
      if (seq === seqRef.current && runIdRef.current === targetRun) {
        setHealth(next);
      }
    } catch {
      // Transient polling noise preserves the last known health; never invent a verdict.
    }
  }, []);

  useEffect(() => {
    seqRef.current += 1;
    setHealth(null);
  }, [runId]);

  useEffect(() => {
    if (!enabled || !runId || !visible) {
      if (!runId) setHealth(null);
      return;
    }
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [enabled, runId, visible, refresh]);

  return { health: health?.runId === runId ? health : null, refresh };
}
