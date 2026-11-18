import { useEffect, useId, useRef, useState } from "react";
import { Command, Diamond, HelpCircle, Search, X } from "lucide-react";
import { useT } from "../i18n";
import type { DagNode, Gate } from "../types";
import { StatusGlyph } from "./statusUi";

function useNativeModal(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const handleClose = () => {
      dialog.returnValue = "";
      onClose();
    };
    dialog.addEventListener("close", handleClose);

    let cleanupLightDismiss: (() => void) | undefined;
    if (!("closedBy" in HTMLDialogElement.prototype)) {
      let pressedOutside = false;
      const isOutside = (e: PointerEvent) => {
        const r = dialog.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      };
      const onDown = (e: PointerEvent) => {
        pressedOutside = isOutside(e);
      };
      const onUp = (e: PointerEvent) => {
        if (pressedOutside && isOutside(e)) dialog.close();
      };
      dialog.addEventListener("pointerdown", onDown);
      dialog.addEventListener("pointerup", onUp);
      cleanupLightDismiss = () => {
        dialog.removeEventListener("pointerdown", onDown);
        dialog.removeEventListener("pointerup", onUp);
      };
    }

    return () => {
      dialog.removeEventListener("close", handleClose);
      cleanupLightDismiss?.();
    };
  }, [onClose]);

  return ref;
}

export type IdeStageView = "canvas" | "board" | "runs" | "resources" | "settings";

export function CommandPalette({
  open,
  onClose,
  tasks,
  gates,
  onSelectTask,
  onSelectGate,
  onSwitchView,
  onRelayout,
  onFitView,
  onToggleLayout,
  onToggleDock,
  onToggleTheme,
  onToggleLang,
}: {
  open: boolean;
  onClose: () => void;
  tasks: DagNode[];
  gates: Gate[];
  onSelectTask: (taskId: string) => void;
  onSelectGate: (gateId: string) => void;
  onSwitchView: (view: IdeStageView) => void;
  onRelayout: () => void;
  onFitView: () => void;
  onToggleLayout: () => void;
  onToggleDock: () => void;
  onToggleTheme: () => void;
  onToggleLang: () => void;
}) {
  const t = useT();
  const dialogRef = useNativeModal(open, onClose);
  const [query, setQuery] = useState("");
  const titleId = useId();

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const items = [
    ...tasks.map((task) => ({
      id: `task:${task.id}`,
      label: `${task.label} (${task.id})`,
      group: t("ide.cmd.groupTasks"),
      icon: <StatusGlyph status={task.status} size={13} />,
      run: () => onSelectTask(task.id),
    })),
    ...gates.map((gate) => ({
      id: `gate:${gate.id}`,
      label: `${gate.question || gate.id} (${gate.id})`,
      group: t("ide.cmd.groupGates"),
      icon: <Diamond size={13} style={{ color: "var(--st-blocked)" }} aria-hidden="true" />,
      run: () => onSelectGate(gate.id),
    })),
    {
      id: "view:canvas",
      label: t("ide.nav.canvas"),
      group: t("ide.cmd.groupViews"),
      icon: <Command size={13} aria-hidden="true" />,
      run: () => onSwitchView("canvas"),
    },
    {
      id: "view:board",
      label: t("ide.nav.board"),
      group: t("ide.cmd.groupViews"),
      icon: <Command size={13} aria-hidden="true" />,
      run: () => onSwitchView("board"),
    },
    {
      id: "view:runs",
      label: t("ide.nav.runs"),
      group: t("ide.cmd.groupViews"),
      icon: <Command size={13} aria-hidden="true" />,
      run: () => onSwitchView("runs"),
    },
    {
      id: "view:resources",
      label: t("ide.nav.resources"),
      group: t("ide.cmd.groupViews"),
      icon: <Command size={13} aria-hidden="true" />,
      run: () => onSwitchView("resources"),
    },
    {
      id: "view:settings",
      label: t("ide.nav.settings"),
      group: t("ide.cmd.groupViews"),
      icon: <Command size={13} aria-hidden="true" />,
      run: () => onSwitchView("settings"),
    },
    {
      id: "act:fit",
      label: t("ide.cmd.fitView"),
      group: t("ide.cmd.groupActions"),
      icon: <Command size={13} aria-hidden="true" />,
      run: onFitView,
    },
    {
      id: "act:layout",
      label: t("ide.cmd.toggleLayout"),
      group: t("ide.cmd.groupActions"),
      icon: <Command size={13} aria-hidden="true" />,
      run: onToggleLayout,
    },
    {
      id: "act:relayout",
      label: t("ide.cmd.relayout"),
      group: t("ide.cmd.groupActions"),
      icon: <Command size={13} aria-hidden="true" />,
      run: onRelayout,
    },
    {
      id: "act:dock",
      label: t("ide.cmd.toggleDock"),
      group: t("ide.cmd.groupActions"),
      icon: <Command size={13} aria-hidden="true" />,
      run: onToggleDock,
    },
    {
      id: "act:theme",
      label: t("ide.cmd.toggleTheme"),
      group: t("ide.cmd.groupActions"),
      icon: <Command size={13} aria-hidden="true" />,
      run: onToggleTheme,
    },
    {
      id: "act:lang",
      label: t("ide.cmd.toggleLang"),
      group: t("ide.cmd.groupActions"),
      icon: <Command size={13} aria-hidden="true" />,
      run: onToggleLang,
    },
  ].filter((it) => it.label.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <dialog
      ref={dialogRef}
      className="odag-dialog"
      aria-labelledby={titleId}
      {...({ closedby: "any" } as Record<string, string>)}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 14px",
          borderBlockEnd: "1px solid var(--border-hairline)",
        }}
      >
        <Search size={15} style={{ color: "var(--fg-tertiary)" }} aria-hidden="true" />
        <h2
          id={titleId}
          style={{
            position: "absolute",
            inlineSize: 1,
            blockSize: 1,
            overflow: "hidden",
            clip: "rect(0 0 0 0)",
          }}
        >
          {t("ide.cmd.title")}
        </h2>
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("ide.cmd.placeholder")}
          style={{
            flex: 1,
            border: 0,
            background: "transparent",
            outline: "none",
            fontSize: "var(--text-base)",
          }}
        />
        <kbd className="odag-kbd">Esc</kbd>
      </div>

      <div className="odag-scroll" style={{ maxBlockSize: 340, overflowY: "auto", padding: 6 }}>
        {items.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: "var(--fg-tertiary)", fontSize: "var(--text-sm)" }}>
            {t("ide.cmd.empty")}
          </div>
        ) : (
          items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                item.run();
                onClose();
              }}
              className="odag-nav-item"
              style={{ inlineSize: "100%" }}
            >
              {item.icon}
              <span className="truncate" style={{ flex: 1 }}>
                {item.label}
              </span>
              <span className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--fg-tertiary)" }}>
                {item.group}
              </span>
            </button>
          ))
        )}
      </div>
    </dialog>
  );
}

export function ShortcutsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const dialogRef = useNativeModal(open, onClose);
  const titleId = useId();

  return (
    <dialog
      ref={dialogRef}
      className="odag-dialog"
      aria-labelledby={titleId}
      {...({ closedby: "any" } as Record<string, string>)}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          borderBlockEnd: "1px solid var(--border-hairline)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <HelpCircle size={16} style={{ color: "var(--accent)" }} aria-hidden="true" />
          <h2 id={titleId} style={{ margin: 0, fontSize: "var(--text-lg)" }}>
            {t("ide.shortcuts.title")}
          </h2>
        </div>
        <form method="dialog">
          <button value="close" className="odag-btn odag-btn--ghost odag-btn--icon" aria-label={t("ide.inspector.close")}>
            <X size={15} />
          </button>
        </form>
      </header>

      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10, fontSize: "var(--text-base)" }}>
        {[
          ["⌘ / Ctrl + K", t("ide.shortcuts.palette")],
          ["[  /  ]", t("ide.shortcuts.cycle")],
          ["F  /  0", t("ide.shortcuts.fit")],
          ["L", t("ide.shortcuts.layout")],
          ["?", t("ide.shortcuts.help")],
        ].map(([k, desc]) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ color: "var(--fg-secondary)" }}>{desc}</span>
            <kbd className="odag-kbd">{k}</kbd>
          </div>
        ))}
      </div>
    </dialog>
  );
}
