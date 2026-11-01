# Copilot instructions for Temivo

Temivo is a desktop app for exploring and learning topics through AI-generated mind maps. A node can
link to a separate mind map; linked maps stay independent and can be detached. The repository is
currently a scaffold — add product features in focused follow-up changes.

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
```

Before finishing a change, run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.

Electron needs a display: in headless Linux use `xvfb-run -a pnpm dev`. If Electron aborts with a
`chrome-sandbox` error, the helper must be owned by root with mode `4755` (the Copilot setup
steps do this; see README). Do not disable the sandbox in code.

## Copilot hooks

`.github/hooks/pre-tool-use.json` runs `.github/hooks/scripts/pre-tool-use.mjs` before each tool
call. It denies edits to generated files and npm/yarn install commands. Keep hook scripts fast,
dependency-free, and fail-open on unexpected input.
