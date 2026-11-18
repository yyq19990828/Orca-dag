import claudeIcon from "../assets/harness/claude.svg";
import codexIcon from "../assets/harness/codex.png";
import antigravityIcon from "../assets/harness/antigravity.svg";
import ompIcon from "../assets/harness/omp.svg";
import opencodeIcon from "../assets/harness/opencode.svg";

/*
 * Vendored unmodified marks:
 * Oh My Pi: https://github.com/can1357/oh-my-pi/blob/88a69582c755bd000e8dc0290981fc787a4f400c/assets/icon.svg
 * OpenCode: https://github.com/anomalyco/opencode/blob/893e8dc43f05e872d4cac603486ce8a7181170fa/packages/console/app/src/asset/brand/opencode-logo-light-square.svg
 * Both repositories license their contents under MIT; trademarks remain their
 * respective owners' and use here identifies the harness, not endorsement.
 * https://github.com/can1357/oh-my-pi/blob/main/LICENSE
 * https://github.com/anomalyco/opencode/blob/dev/LICENSE
 *
 * Copyright (c) 2025 Mario Zechner
 * Copyright (c) 2025-2026 Can Bölük
 * Copyright (c) 2026 Stencil Labs, Inc.
 * Copyright (c) 2025 opencode
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Claude: https://claude.com/icon.svg
 * Anthropic requires specific permission and prior approval for its trademarks:
 * https://www.anthropic.com/legal/trademark-guidelines
 * Antigravity: https://antigravity.google/assets/image/brand/antigravity-icon__full-color.svg
 * Google product-icon guidance calls for an approval request:
 * https://partnermarketinghub.withgoogle.com/brands/google/branding-guidelines/how-to-show-googles-brand/
 * Codex's official extension uses the OpenAI Blossom:
 * https://open-vsx.org/api/openai/chatgpt/alpine-arm64/26.51021.22027/file/blossom.dark.png
 * Extension terms: https://openai.com/policies/row-terms-of-use; brand rules:
 * https://openai.com/brand. No asset license or permission is implied.
 * These public marks identify third-party harnesses, not endorsement. Upstream
 * licenses do not grant trademark rights; redistribution may require permission.
 */

type HarnessAvatarProps = {
  harness?: string | null;
  label?: string;
  size?: number;
  kind?: "agent" | "operator" | "system";
};

const harnessIcons: Record<string, string> = {
  claude: claudeIcon,
  codex: codexIcon,
  opencode: opencodeIcon,
  opencode2: opencodeIcon,
  omp: ompIcon,
  antigravity: antigravityIcon,
};

export function HarnessAvatar({ harness, size = 36, kind = "agent" }: HarnessAvatarProps) {
  const name = harness?.trim().toLowerCase();
  const icon = kind === "agent" && name && Object.prototype.hasOwnProperty.call(harnessIcons, name) ? harnessIcons[name] : undefined;
  const background = icon ? (name === "omp" || name === "codex" ? "#000" : "#fff") : "#eaecef";

  return (
    <span aria-hidden="true" style={{ width: size, height: size, flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: "50%", background, color: "#565b65", overflow: "hidden" }}>
      {icon ? (
        <img src={icon} alt="" style={{ width: "68%", height: "68%", objectFit: "contain" }} />
      ) : (
        <svg width="58%" height="58%" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {kind === "operator" ? (
            <><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></>
          ) : kind === "system" ? (
            <><path d="M15 14H7l-4 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2Z" /><path d="M8 18h9l4 3V10a2 2 0 0 0-2-2" /></>
          ) : (
            <><rect x="4" y="7" width="16" height="12" rx="3" /><path d="M12 4v3M8 12h.01M16 12h.01M9 16h6" /></>
          )}
        </svg>
      )}
    </span>
  );
}
