import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Popover, Select } from "radix-ui";
import { useT } from "../i18n";

export interface DoodleOption {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

type Props = {
  value: string;
  onChange: (value: string) => void;
  options: DoodleOption[];
  placeholder?: string;
  disabled?: boolean;
  loading?: boolean;
  emptyText?: string;
  size?: "sm" | "md";
  className?: string;
  title?: string;
  ariaLabel?: string;
  searchable?: boolean;
  panelActions?: (close: () => void) => ReactNode;
};

function Chevron() {
  return <ChevronDown size={14} className="doodle-select__chev odag-chevron odag-chevron--select" aria-hidden="true" />;
}

function OptionText({ option }: { option: DoodleOption }) {
  return <span className="doodle-select__opt-text"><span className="doodle-select__opt-label">{option.label}</span>{option.hint && <span className="doodle-select__opt-hint">{option.hint}</span>}</span>;
}

// Radix reserves the empty string for clearing a Select; encode every value so
// an actual empty/default option remains selectable and round-trips unchanged.
const encode = (value: string) => `value:${value}`;

export function DoodleSelect({ value, onChange, options, placeholder, disabled = false, loading = false, emptyText, size = "md", className, title, ariaLabel, searchable = true, panelActions }: Props) {
  const t = useT();
  const placeholderText = placeholder ?? t("doodle.placeholder");
  const emptyLabel = emptyText ?? t("doodle.empty");
  const current = options.find((option) => option.value === value);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((option) => [option.label, option.value, option.hint ?? ""].some((text) => text.toLowerCase().includes(q))) : options;
  }, [options, query]);
  const enabled = filtered.filter((option) => !option.disabled);
  const active = enabled.find((option) => option.value === activeValue) ?? enabled[0];
  const activeIndex = active ? filtered.indexOf(active) : -1;
  const triggerClass = `doodle-select doodle-select--${size}${open ? " doodle-select--open" : ""}${className ? ` ${className}` : ""}`;
  const label = ariaLabel ?? title ?? placeholderText;

  function changeOpen(next: boolean) {
    setOpen(next);
    if (!next) { setQuery(""); setActiveValue(null); }
  }

  useEffect(() => {
    if (open && activeIndex >= 0) listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  function keyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); changeOpen(false);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const index = enabled.findIndex((option) => option.value === active?.value);
      const next = event.key === "ArrowDown" ? Math.min(index + 1, enabled.length - 1) : Math.max(index - 1, 0);
      setActiveValue(enabled[next]?.value ?? null);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (active && !loading) { onChange(active.value); changeOpen(false); }
    }
  }

  const triggerContents = <><span className={`doodle-select__value${current ? "" : " doodle-select__value--dim"}`}>{current?.label ?? (value || placeholderText)}</span><Chevron /></>;
  const stopEscape = (event: KeyboardEvent) => { event.stopPropagation(); };

  if (!searchable && !panelActions) {
    return <Select.Root value={encode(value)} onValueChange={(next) => onChange(next.slice(6))} open={open} onOpenChange={changeOpen} disabled={disabled}>
      <Select.Trigger className={triggerClass} title={title} aria-label={ariaLabel}>{triggerContents}</Select.Trigger>
      <Select.Portal><Select.Content className="doodle-select__panel doodle-select__panel--select" aria-label={label} position="popper" sideOffset={8} collisionPadding={8} onEscapeKeyDown={stopEscape}>
        <Select.Viewport className="doodle-select__options">
          {loading ? <div className="doodle-select__empty">{t("doodle.loading")}</div> : options.length === 0 ? <div className="doodle-select__empty">{emptyLabel}</div> : options.map((option) => <Select.Item key={option.value} value={encode(option.value)} disabled={option.disabled} textValue={option.label} className="doodle-select__opt"><Select.ItemText><OptionText option={option} /></Select.ItemText><Select.ItemIndicator className="doodle-select__indicator"><svg viewBox="0 0 16 14" aria-hidden="true"><path d="M2 7 L6 11 L14 2" /></svg></Select.ItemIndicator></Select.Item>)}
        </Select.Viewport>
      </Select.Content></Select.Portal>
    </Select.Root>;
  }

  return <Popover.Root open={open} onOpenChange={changeOpen}>
    <Popover.Trigger asChild><button type="button" className={triggerClass} disabled={disabled} title={title} aria-label={ariaLabel} onKeyDown={(event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        changeOpen(true);
      }
    }}>{triggerContents}</button></Popover.Trigger>
    <Popover.Portal><Popover.Content className={`doodle-select__panel${panelActions ? " doodle-select__panel--actions" : ""}`} sideOffset={8} collisionPadding={8} aria-label={label} onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); }} onEscapeKeyDown={stopEscape}>
      <div className="doodle-select__search">
        <svg className="doodle-select__mag" viewBox="0 0 14 14" aria-hidden="true"><circle cx="6" cy="6" r="4.3" /><path d="M9.6 9.6 L12.8 12.8" /></svg>
        <input ref={inputRef} value={query} onChange={(event) => { setQuery(event.target.value); setActiveValue(null); }} onKeyDown={keyDown} placeholder={t("doodle.searchPlaceholder")} aria-label={t("doodle.searchAria")} role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls={listId} aria-activedescendant={activeIndex >= 0 && !loading ? `${listId}-option-${activeIndex}` : undefined} spellCheck={false} />
      </div>
      {(loading || filtered.length === 0) && <div className="doodle-select__empty" role="status">{loading ? t("doodle.loading") : query ? t("doodle.noMatches") : emptyLabel}</div>}
      <div className="doodle-select__options" ref={listRef} id={listId} role="listbox" aria-label={label} aria-busy={loading || undefined}>
        {!loading && filtered.map((option, index) => <div key={option.value} id={`${listId}-option-${index}`} data-idx={index} role="option" aria-selected={option.value === value} aria-disabled={option.disabled || undefined} className={`doodle-select__opt${index === activeIndex ? " doodle-select__opt--active" : ""}${option.value === value ? " doodle-select__opt--selected" : ""}${option.disabled ? " doodle-select__opt--disabled" : ""}`} onMouseEnter={() => { if (!option.disabled) setActiveValue(option.value); }} onMouseDown={(event) => event.preventDefault()} onClick={() => { if (!option.disabled) { onChange(option.value); changeOpen(false); } }}><OptionText option={option} />{option.value === value && <span className="doodle-select__indicator"><svg viewBox="0 0 16 14" aria-hidden="true"><path d="M2 7 L6 11 L14 2" /></svg></span>}</div>)}
      </div>
      {panelActions?.(() => changeOpen(false))}
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
