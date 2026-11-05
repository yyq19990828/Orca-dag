import { useLang, setLang } from "../i18n";
import { Tooltip } from "./Tooltip";

/** Crayon language switch: shows the language you'd switch TO, one click. */
export function LangToggle() {
  const lang = useLang();
  return (
    <Tooltip className="workbench-header-lang" content={lang === "en" ? "切换至简体中文" : "Switch to English"}>
      <button
        type="button"
        className="btn btn--lang btn--icon"
        aria-pressed={lang === "zh"}
        aria-label="切换界面语言 / Switch UI language"
        onClick={() => setLang(lang === "en" ? "zh" : "en")}
      >
        {lang === "en" ? "中" : "EN"}
      </button>
    </Tooltip>
  );
}
