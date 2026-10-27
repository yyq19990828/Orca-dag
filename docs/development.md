# Development and Release Guide

English | [简体中文](development_zh.md)

Back to [README](../README.md) · [Documentation Index](README.md)

This guide covers building, testing, live-provider verification, cross-compilation, and release procedures for the `orca-dag` project.

For system architecture, execution models, and code layout, consult the [Architecture Reference](reference/architecture.md). For HTTP endpoint specifications, see the [HTTP API Reference](reference/http-api.md).

---

## Development Commands

All standard development tasks are managed through npm scripts:

```bash
npm install                                # Install development dependencies
npm run check                              # Run skill validation, typecheck, tests, and web build (CI check)
npm run dev                                # Run frontend (:5173) and backend (:8787); Vite proxies /api
npm run build:npm                          # Stage publishable npm package into dist-npm/ (Node.js only)
npm run build:binary                       # Build standalone binary into dist/orca-dag (requires Bun)
npm run release 1.0.0                      # Tag and push a release; CI handles publishing and binaries
```

---

## Real-Provider Verification (`verify:live`)

The live verification suite exercises genuine worker parallelism and task completion against an active Orca runtime and configured AI provider.

```bash
npm run verify:live -- http://127.0.0.1:8787
```

> ⚠️ **Warning:** `verify:live` is a source-checkout tool and is **not part of `npm run check`**. It launches three real Codex tasks and **consumes billable provider quota**.

### Verification Semantics

- **Prerequisites:** A local viewer must be running and idle at the specified URL.
- **Workflow:** The script creates a new Run containing three tasks. Tasks A and B run in parallel to generate independent inputs. Task C depends on A and B, computing and validating the result `51`.
- **Coordinator Ownership:** The viewer coordinator independently manages worker launches, execution, and settlement. The verifier observes parallelism non-invasively without artificial test hooks.
- **Handling Unknowns:** Dispatches in an unknown or unverified state are kept under observation. They are **never** automatically retried or cancelled.
- **Observation Deadline:** After 15 minutes, the verifier reports `unverifiable`, not success. It leaves the coordinator and workers untouched; it does not change Orca Task or Dispatch outcomes.
- **Evidence Retention:** Test execution artifacts and logs are preserved in `.orca-dag/<timestamp>-verification-*/`. Concurrency limits are restored to their previous settings, and the verification Run remains selected in the viewer.

---

## Standalone Binary and Cross-Compilation

Standalone binaries bundle the Express backend, compiled React frontend, and skill into a single executable using Bun.

### Single-Target Build

```bash
npm run build:binary                       # Builds for current host platform into dist/orca-dag
```

To cross-compile for an alternate platform:
```bash
TARGET=bun-linux-x64 npm run build:binary
```

### Multi-Target Distribution

The release script cross-compiles all target architectures, archives them, and generates SHA-256 checksums:

```bash
bash scripts/build-all-binaries.sh
```

Supported build targets include:
- `darwin-arm64` (Apple Silicon)
- `darwin-x64` (Intel macOS)
- `linux-x64` (x86_64 Linux)
- `linux-arm64` (AArch64 Linux)
- `windows-x64` (x86_64 Windows)

---

## Release Workflow and Trusted Publishing (OIDC)

Releases are published to npm and GitHub Releases via GitHub Actions using **npm Trusted Publishing (OIDC)**. No static `NPM_TOKEN` secret is required.

### Initial Bootstrap (One-Time Setup)

npm requires a package to exist before configuring trusted publishers. For the initial release of a new package, publish a bootstrap prerelease manually:

1. **Sign in to npm with 2FA:**
   ```bash
   npm login
   ```
2. **Build and publish a bootstrap prerelease:**
   ```bash
   PKG_VERSION=1.0.0-oidc-bootstrap.0 npm run build:npm
   npm publish ./dist-npm --access public --tag bootstrap
   ```
   > *Note:* npm initializes `latest` to the prerelease on first publish despite `--tag bootstrap`. The first stable release will correctly advance `latest` to `1.0.0`.

3. **Configure Trusted Publishing on npmjs.com:**
   - Navigate to **`orca-orchestration-launcher` → Settings → Trusted publishing → GitHub Actions**.
   - Set **Owner:** `yyq19990828`
   - Set **Repository:** `Orca-dag`
   - Set **Workflow filename:** `release.yml`
   - Set **Environment:** *(leave blank)*
   - Check **Allow npm publish**.

   *Alternative (npm ≥ 11.15.0 CLI):*
   ```bash
   npm trust github orca-orchestration-launcher --repo yyq19990828/Orca-dag --file release.yml --allow-publish
   npm trust list orca-orchestration-launcher
   ```

4. **Commit and push** the `.github/workflows/release.yml` workflow to `main`.

### Publishing Releases

Once OIDC is configured, all subsequent releases are triggered using:

```bash
npm run release 1.0.0
```

Before releasing, run `npm run check` and push the reviewed source to `main`. The release script then:
1. Requires a clean `main` checkout matching `origin/main`, a supported version format, and an unused tag.
2. Validates the skill, checks server TypeScript, and stages the npm package (including its web build).
3. Creates the annotated `v<version>` tag and pushes that tag; it does not push uncommitted or unpublished source for you.

GitHub Actions builds all release binaries, attaches them to a new GitHub Release, and publishes the package to npm using OIDC provenance. Consult [npm Trusted Publishers documentation](https://docs.npmjs.com/trusted-publishers/) for additional details.

The stable release tag is the version of record; `PKG_VERSION` supplies staged package metadata, so no repository version-bump commit is required. The npm job uses Node 24, npm ≥ 11.5.1, and `id-token: write` for OIDC.

### Recovering a Failed npm Publish

If npm rejects OIDC authentication before publishing, fix the Trusted Publisher mapping and rerun the failed job:

```bash
gh run rerun <run-id> --failed
```

The rerun checks out the same tag and publishes that tagged tree. Do not cut a new version solely for an authentication failure.
