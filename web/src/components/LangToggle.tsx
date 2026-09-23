import { useLang, setLang } from "../i18n";

/** Crayon language switch: shows the language you'd switch TO, one click. */
export function LangToggle() {
  const lang = useLang();
  return (
    <button
      type="button"
      className="btn btn--lang"
      aria-pressed={lang === "zh"}
      title="切换界面语言 / Switch UI language"
      onClick={() => setLang(lang === "en" ? "zh" : "en")}
    >
      {lang === "en" ? "中" : "EN"}
    </button>
  );
}
