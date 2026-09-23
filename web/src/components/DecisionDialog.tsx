import {
  createContext,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";

type DialogTone = "default" | "danger";

interface DialogCopy {
  title: string;
  message: string;
  confirmLabel?: string;
  tone?: DialogTone;
}

interface ConfirmOptions extends DialogCopy {
  cancelLabel?: string;
}

interface PromptOptions extends DialogCopy {
  cancelLabel?: string;
  fieldLabel: string;
  placeholder?: string;
  initialValue?: string;
  required?: boolean;
}

interface DecisionDialogApi {
  alert: (options: DialogCopy) => Promise<void>;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
}

type DialogRequest =
  | ({ kind: "alert" } & DialogCopy & { resolve: (value: void) => void })
  | ({ kind: "confirm" } & ConfirmOptions & { resolve: (value: boolean) => void })
  | ({ kind: "prompt" } & PromptOptions & { resolve: (value: string | null) => void });

const DecisionDialogContext = createContext<DecisionDialogApi | null>(null);

/**
 * Application-owned replacement for blocking browser alert/confirm/prompt.
 * Requests are queued so two async failures never overwrite each other's
 * resolver. The overlay is portalled to body because several viewer panels
 * establish clipping and stacking contexts of their own.
 */
export function DecisionDialogProvider({ children }: { children: ReactNode }) {
  // Fallback button labels are translated here; callers may still override
  // them per dialog (they pass their own localized copy).
  const t = useT();
  const [active, setActive] = useState<DialogRequest | null>(null);
  const [input, setInput] = useState("");
  const queue = useRef<DialogRequest[]>([]);
  const activeRef = useRef<DialogRequest | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const safeButtonRef = useRef<HTMLButtonElement | null>(null);

  const enqueue = useCallback((request: DialogRequest) => {
    // Do not enqueue from a React state updater: StrictMode may deliberately
    // invoke an updater twice in development, which would duplicate dialogs.
    if (activeRef.current) {
      queue.current.push(request);
      return;
    }
    activeRef.current = request;
    setActive(request);
  }, []);

  const api: DecisionDialogApi = {
    alert: useCallback(
      (options) => new Promise<void>((resolve) => enqueue({ kind: "alert", ...options, resolve })),
      [enqueue],
    ),
    confirm: useCallback(
      (options) => new Promise<boolean>((resolve) => enqueue({ kind: "confirm", ...options, resolve })),
      [enqueue],
    ),
    prompt: useCallback(
      (options) => new Promise<string | null>((resolve) => enqueue({ kind: "prompt", ...options, resolve })),
      [enqueue],
    ),
  };

  useEffect(() => {
    if (!active) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setInput(active.kind === "prompt" ? active.initialValue ?? "" : "");
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => {
      if (active.kind === "prompt") inputRef.current?.focus();
      else safeButtonRef.current?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
    };
  }, [active]);

  const settle = useCallback((value: boolean | string | null | void) => {
    const current = activeRef.current;
    if (!current) return;
    const next = queue.current.shift() ?? null;
    activeRef.current = next;
    setActive(next);
    if (current.kind === "alert") current.resolve();
    else if (current.kind === "confirm") current.resolve(Boolean(value));
    else current.resolve(typeof value === "string" ? value : null);
    window.requestAnimationFrame(() => returnFocus.current?.focus());
  }, []);

  function cancel() {
    settle(active?.kind === "confirm" ? false : null);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!active) return;
    if (active.kind === "prompt") {
      const value = input.trim();
      if (active.required && !value) return;
      settle(value);
      return;
    }
    settle(true);
  }

  function trapKeys(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
      return;
    }
    if (event.key !== "Tab" || !cardRef.current) return;
    const focusable = [...cardRef.current.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
    )];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <DecisionDialogContext.Provider value={api}>
      {children}
      {active && createPortal(
        <div
          className="decision-dialog__backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) cancel();
          }}
        >
          <section
            ref={cardRef}
            className={`decision-dialog decision-dialog--${active.tone ?? "default"}`}
            role={active.kind === "alert" ? "alertdialog" : "dialog"}
            aria-modal="true"
            aria-labelledby="decision-dialog-title"
            aria-describedby="decision-dialog-message"
            onKeyDown={trapKeys}
          >
            <span className="decision-dialog__tape" aria-hidden="true" />
            <form onSubmit={submit}>
              <header className="decision-dialog__header">
                <span className="decision-dialog__mark" aria-hidden="true">
                  {active.tone === "danger" ? "!" : active.kind === "prompt" ? "+" : "?"}
                </span>
                <h2 id="decision-dialog-title">{active.title}</h2>
              </header>
              <p id="decision-dialog-message" className="decision-dialog__message">{active.message}</p>
              {active.kind === "prompt" && (
                <label className="decision-dialog__field">
                  <span>{active.fieldLabel}</span>
                  <input
                    ref={inputRef}
                    value={input}
                    placeholder={active.placeholder}
                    required={active.required}
                    onChange={(event) => setInput(event.target.value)}
                  />
                </label>
              )}
              <footer className="decision-dialog__actions">
                {active.kind !== "alert" && (
                  <button
                    ref={safeButtonRef}
                    type="button"
                    className="btn btn--ghost"
                    onClick={cancel}
                  >
                    {active.cancelLabel ?? t("dialog.cancel")}
                  </button>
                )}
                <button
                  ref={active.kind === "alert" ? safeButtonRef : undefined}
                  type="submit"
                  className={`btn ${active.tone === "danger" ? "btn--danger" : "btn--ok"}`}
                  disabled={active.kind === "prompt" && Boolean(active.required && !input.trim())}
                >
                  {active.confirmLabel ?? t(active.kind === "alert" ? "dialog.close" : "dialog.continue")}
                </button>
              </footer>
            </form>
          </section>
        </div>,
        document.body,
      )}
    </DecisionDialogContext.Provider>
  );
}

export function useDecisionDialog(): DecisionDialogApi {
  const value = useContext(DecisionDialogContext);
  if (!value) throw new Error("useDecisionDialog must be used inside DecisionDialogProvider");
  return value;
}
