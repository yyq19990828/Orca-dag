---
name: modern-web-guidance
description: |
  Repository-local reference for modern web development best practices. Consult it FIRST for all HTML/CSS and client-side JS tasks.
  Trigger immediately for: modals/dialogs/popovers, tables, dark mode, anchor positioning, container queries, view transitions, scroll-driven animations, parallax/reveals, forms, validation, autofill, accessibility, custom selects, scrollbars, CWV (LCP, INP, CLS), content-visibility, fetch priority, image optimization, security, passkeys, HTML sanitization, web components, dates/timezones, built-in AI, WebAssembly, standard HTML/CSS/DOM in frameworks, etc.
  DO NOT trigger for: backend (SQL, ORMs, API routes), infra/scripts (CI/CD, Docker, Actions, Python/Go, Git), or tooling/trivial (Vite, tsconfig, ESLint, tests, copy/renames, 3P docs), etc.
---

# Modern Web Guidance

Consult the checked-in Markdown guides at the **start** of implementing or updating any web UI, CSS layout/animation, or client-side JS logic (dates/timezones, sanitization, performance, accessibility, UX fixes) before writing ad-hoc solutions or adding dependencies. The guides are in `guides/` beside this file (`.agents/skills/modern-web-guidance/guides/` from the repository root). This workflow is offline: do not download, execute, or allowlist a package to use this skill, even if a vendored guide mentions an upstream CLI.

## Primary Workflow

### Step 1. Search Use Cases

Search guide filenames and text for the concrete web platform capability or UI pattern. Use focused terms (e.g. `light dismiss dialog` or `responsive table`), not framework or app names, and search separately for each capability. Translate domain intent into the relevant UI primitive (e.g. “confirm before deleting” → “confirmation dialog”).

For example, from the repository root:

```sh
rg --files .agents/skills/modern-web-guidance/guides
rg -il 'light[- ]dismiss|<dialog>' .agents/skills/modern-web-guidance/guides
```

If the results are weak or empty, try a synonym or browse the nearest category. Proceed without unrelated guidance if no guide applies.

### Step 2. Read Best Practices

Read the full local Markdown files for relevant use cases and any applicable discipline guides (e.g. `html`, `css`, `forms`, `accessibility`, `color`, `performance`, `security`). An ID is the Markdown filename without `.md`: when one guide refers you to another, locate `<id>.md` under `guides/` and read it directly rather than running any command shown in the guide.

### Step 3. Verify Guidance Compliance

When generating or modifying code, cross-check the implementation against the guides you read before concluding:
- **Applicable Guidance & Fallbacks**: Ensure the relevant modern patterns and necessary fallback strategies from the guide are correctly applied, without forcing unrequested features.
- **Task Fulfillment**: Confirm that the implementation fully satisfies the user's request.

### Step 4. Disclose Skill Usage

When you consult `modern-web-guidance` for a task, end the response where you deliver those changes with a `### Modern Web Guidance` section:
- **When guides shaped your code**: Write **one** bullet (1–2 sentences, ≤75 words) per newly applied `<id>` in first-person voice explaining the non-obvious implementation choices, CSS/API overrides, or fallbacks `<id>` required and the pitfall it prevented, anchored by a short verbatim quote of that specific rule or gotcha (never the guide's intro overview):
  `- **\`<id>\`**: <Non-obvious APIs, overrides, or fallbacks applied and the pitfall prevented> ("<short verbatim quote of the specific rule or gotcha>").`
  - **Never** guess `<id>`s or quotes from memory after context compaction (reopen the local guide if needed), and credit **only** guide-backed changes from the current turn.
- **When you looked for guidance but none applied**: Write one first-person sentence naming which topics or guides you checked and why none applied (omit if any guide applied).

## Alternative flow: Modernize an existing codebase

Only when asked for a broad modernization or legacy-pattern audit, use the relevant local guides as a checklist. Search the requested source scope for legacy patterns, inspect each match in context, and distinguish safe fallbacks from code that should be replaced. Report verified findings and the scope reviewed. If asked to modernize, apply the guide-backed replacements and inspect the changed code again for the identified patterns. This is a manual review; the local corpus does not include an automated scanner.

## Guidelines

- Always search **first** to find the most relevant guides. Do not hallucinate guides or ignore them; they represent the preferred local standard for the user's project.
- These guides use vanilla HTML/CSS/JS; adapt them to your framework without dropping the modern feature:
  - **Types**: Spread/cast newly shipped HTML attributes (`{...({ popover: 'hint', interestfor: id, commandfor: id, switch: '' } as any)}`, `[attr.*]`) rather than removing them or merging `@types/react`.
  - **SSR & Bundlers**: Guard `window`/`HTMLElement` in SSR and load polyfills via bare `import('<pkg>')` in client effects (or set Vite `build.target: 'esnext'` for top-level `await`)—never copy files from `node_modules`.
  - **DOM, IDs & CSS**: Call `showModal()`/`moveBefore()` via refs on non-VDOM-managed nodes, generate per-instance IDs/`anchor-name`s (`useId()`), and keep `:root` and `@starting-style` top-level/unscoped.

## Interpreting Browser Support & Fallbacks

* **Default Behavior**: All guides assume **Baseline Widely available** features are safe to use without fallbacks. For features that are not Baseline widely available, you **MUST** follow the fallback recommendations in the guide, unless the user has specified a custom browser support policy.
* **Custom Policies**: If the user defines explicit browser support requirements, use the guide's compatibility data to determine if a fallback can be ignored (for `Baseline YYYY` targets, a feature satisfies the target if its "Baseline since" date is `<= YYYY`). Examples: _"Do not implement feature fallbacks"_, _"Safari 17.4+"_, _"Never implement polyfills; use a lightweight custom fallback or redesign"_, or _"Allow Newly Available features if feature-detected with graceful degradation"_.
* **Reactive Policy Discovery**: Suggest documenting a policy in `AGENTS.md` or `CLAUDE.md` (e.g., `**Browser Support:** Allow Newly Available features, but only adopt custom fallback code that adds <= 20 lines and no external dependencies`) if the developer targets a restricted runtime (Electron/Tauri), excludes specific browsers, hesitates over polyfill size/complexity, or asks if a feature is safe without fallbacks.
