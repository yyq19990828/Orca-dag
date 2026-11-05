import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";
import { Dialog } from "radix-ui";
import { useT } from "../i18n";

type DialogTone = "default" | "danger";

interface DialogCopy {
  title: string;
  message: string;
  content?: ReactNode;
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
  const focusCycle = useRef(false);
  const dialogGeneration = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const safeButtonRef = useRef<HTMLButtonElement | null>(null);

  const enqueue = useCallback((request: DialogRequest) => {
    // Do not enqueue from a React state updater: StrictMode may deliberately
    // invoke an updater twice in development, which would duplicate dialogs.
    if (activeRef.current) {
      queue.current.push(request);
      return;
    }
    if (!focusCycle.current) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      focusCycle.current = true;
    }
    setInput(request.kind === "prompt" ? request.initialValue ?? "" : "");
    dialogGeneration.current += 1;
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


  const settle = useCallback((value: boolean | string | null | void) => {
    const current = activeRef.current;
    if (!current) return;
    const next = queue.current.shift() ?? null;
    activeRef.current = next;
    if (next) setInput(next.kind === "prompt" ? next.initialValue ?? "" : "");
    if (next) dialogGeneration.current += 1;
    setActive(next);
    if (current.kind === "alert") current.resolve();
    else if (current.kind === "confirm") current.resolve(Boolean(value));
    else current.resolve(typeof value === "string" ? value : null);
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


  return (
    <DecisionDialogContext.Provider value={api}>
      {children}
      <Dialog.Root open={Boolean(active)} onOpenChange={(open) => { if (!open) cancel(); }}>
        {active && (
          <Dialog.Portal>
            <Dialog.Overlay className="decision-dialog__backdrop">
            <Dialog.Content
              key={dialogGeneration.current}
              className={`decision-dialog decision-dialog--${active.tone ?? "default"}`}
              role={active.kind === "alert" ? "alertdialog" : "dialog"}
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                if (active.kind === "prompt") inputRef.current?.focus();
                else safeButtonRef.current?.focus();
              }}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                window.requestAnimationFrame(() => {
                  if (activeRef.current) return;
                  focusCycle.current = false;
                  if (returnFocus.current?.isConnected) returnFocus.current.focus();
                  returnFocus.current = null;
                });
              }}
            >
            <span className="decision-dialog__tape" aria-hidden="true" />
            <form onSubmit={submit}>
              <header className="decision-dialog__header">
                <span className="decision-dialog__mark" aria-hidden="true">
                  {active.tone === "danger" ? "!" : active.kind === "prompt" ? "+" : "?"}
                </span>
                <Dialog.Title asChild><h2>{active.title}</h2></Dialog.Title>
              </header>
              <Dialog.Description asChild><p className="decision-dialog__message" tabIndex={0}>{active.message}</p></Dialog.Description>
              {active.content && <div className="decision-dialog__content">{active.content}</div>}
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
            </Dialog.Content>
            </Dialog.Overlay>
          </Dialog.Portal>
        )}
      </Dialog.Root>
    </DecisionDialogContext.Provider>
  );
}

export function useDecisionDialog(): DecisionDialogApi {
  const value = useContext(DecisionDialogContext);
  if (!value) throw new Error("useDecisionDialog must be used inside DecisionDialogProvider");
  return value;
}
