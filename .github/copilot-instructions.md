# Copilot instructions for Temivo

Temivo is a desktop app for exploring and learning topics through AI-generated mind maps. A node can
link to a separate mind map; linked maps stay independent and can be detached. The repository is
currently a scaffold — add product features in focused follow-up changes.

## Product invariants

- Maps have independent identities and lifecycles. A node may link to another map.
  Detaching a link, removing its source node, or deleting its source map must not delete the target map.
- Do not infer new product requirements from the technical scaffold. Confirm substantial behavior
  changes and keep UI, AI-provider integration, and synchronization out of unrelated changes.

## Architecture

pnpm workspaces monorepo:

| Path            | Package           | Purpose                                                                     |
| --------------- | ----------------- | --------------------------------------------------------------------------- |
| `packages/core` | `@temivo/core`    | Shared, platform-independent TypeScript domain logic (data model, map ops). |
| `apps/desktop`  | `@temivo/desktop` | Electron + React + Vite desktop client (built with electron-vite).          |

A future mobile client will live in `apps/` with its own UI and platform integrations and will reuse
`@temivo/core`.

### Package boundaries

- `@temivo/core` must stay pure TypeScript: **no** Electron, React, DOM/browser APIs, Node.js
  built-ins, storage, network, or OS APIs. Its `tsconfig.json` only loads the `ES2022` lib, and ESLint
  (`no-restricted-imports`) blocks platform imports. Inject platform capabilities (IDs, clocks,
  persistence, AI calls) from the app through parameters or interfaces.
- `@temivo/core` exposes TypeScript sources via `exports` (`./src/index.ts`); consumers bundle it.
  Only import from the package root (`@temivo/core`), and re-export new public API from
  `packages/core/src/index.ts`.
- Apps may depend on `@temivo/core`; core must never depend on an app.

### Desktop (`apps/desktop`)

- `src/main` — Electron main process (window creation, app lifecycle, OS integration).
- `src/preload` — the only bridge between main and renderer. Expose a minimal, typed API with
  `contextBridge.exposeInMainWorld('temivo', …)`; never expose `ipcRenderer` or Node.js objects.
- `src/shared` — types shared by preload and renderer (e.g. `DesktopApi`).
- `src/renderer` — React UI. It runs sandboxed with no Node.js access; use `window.temivo` and
  `@temivo/core`. Do not import `electron` or `node:*` here (ESLint enforces this).
- Keep the security defaults in `src/main/index.ts`: `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`, denied window opening/navigation, denied permission
  requests, and the Content-Security-Policy in `src/renderer/index.html`.
- Workspace packages must be bundled, not externalized, in main/preload (see
  `electron.vite.config.ts`).
- Any future persistence belongs in `src/main`; never put SQL or a database driver in core,
  preload, or renderer. Validate IPC inputs in main and return sanitized failures.

## Secrets and configuration

- Do not read, edit, search inside, or print real `.env` files, private keys, or credential files.
  Do not dump process environments or interpolate secrets into commands, logs, or messages.
- `.env.example` is the public configuration contract. Use empty placeholders, never real values.
  Use `pnpm env:check` to check configuration; it reports declared variable names and status only
  and is the permitted way for agents to check local config.
  Users populate real secret values themselves.
- The app currently requires no application environment variables. Do not invent required AI credentials
  before a provider integration exists.
- Keep provider credentials in Electron main. Never expose them through preload, `VITE_*` settings,
  renderer bundles, or the maps database. Production credentials need platform-protected storage.
- Hooks are accident-prevention guardrails, not a sandbox or complete shell security boundary.

## Agent selection

- Handle small tasks directly. Do not launch all agents for every change or let agents delegate
  recursively.
- `reviewer` (Opus): bounded, read-only review of substantial logic, persistence, IPC, or risky changes.
- `designer` (Sonnet): scoped UI/UX work and accessibility, not architectural decisions.
- `checks` (Haiku): mechanical validation and exact failure reporting; no autonomous fixes.
- Keep complex implementation and ambiguous failures with the primary capable agent. Escalate from
  a lightweight agent rather than repeating guesses.
- Agent models are declared in `.github/agents/*.agent.md`. Availability depends on the host and
  account; if a configured model is unavailable, report it and obtain an available alternative.

## Conventions

- TypeScript `strict` everywhere (shared options in `tsconfig.base.json`, including
  `noUncheckedIndexedAccess` and `verbatimModuleSyntax` — use `import type` for types).
- ES modules, named exports, and extensionless relative imports.
- Tests use Vitest and live next to the code as `*.test.ts`. Put domain logic in `@temivo/core`
  and test it there.
- Use **pnpm** only (never npm or yarn). Add dependencies with `pnpm --filter <package> add <dep>`;
  shared tool versions (TypeScript, Vitest) live in the `catalog` in `pnpm-workspace.yaml`.
- Do not edit generated files: `pnpm-lock.yaml`, `node_modules/`, `out/`, `dist/`.
- Keep changes small and focused; prefer existing tooling over new dependencies.

## Commands

Run from the repository root (Node.js ≥ 22.12, pnpm from `packageManager`):

```sh
pnpm install     # install all workspace dependencies
pnpm dev         # start the desktop app with hot reload (needs a display)
pnpm build       # build all packages (desktop output: apps/desktop/out)
pnpm typecheck   # strict TypeScript checks for every package
pnpm lint        # ESLint for the whole repository
pnpm test        # Vitest tests for every package
pnpm env:check   # configuration status, without printing values
```

Before finishing a change, run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.

Electron needs a display: in headless Linux use `xvfb-run -a pnpm dev`. If Electron aborts with a
`chrome-sandbox` error, the helper must be owned by root with mode `4755` (the Copilot setup
steps do this; see README). Do not disable the sandbox in code.

## Copilot hooks

`.github/hooks/pre-tool-use.json` runs `.github/hooks/scripts/pre-tool-use.mjs` before each tool
call. It denies direct access to secret files, obvious environment-dumping commands, edits to
generated files, and npm/yarn install commands. Keep hook scripts fast, dependency-free, and
fail-open on unexpected input. Cover policy changes with the colocated Node.js tests.
