# Temivo

Temivo is a desktop app for exploring and learning topics through AI-generated mind maps. Nodes can
lead to separate linked maps, which stay independent and can be detached.

> This repository contains the project foundation: a shared domain model, SQLite persistence, and
> an Electron desktop app still showing a placeholder screen. The map editor and AI integration
> are follow-up features.

## Requirements

- Node.js 22.12 or newer (see `.nvmrc`)
- pnpm (the version is pinned in `package.json` → `packageManager`; run `corepack enable` or
  install it as described at <https://pnpm.io/installation>)

## Installation

```sh
pnpm install
```

Electron downloads its binary the first time it runs. To fetch it up front, run
`pnpm --filter @temivo/desktop exec install-electron`.

## Development

| Command          | Description                                                   |
| ---------------- | ------------------------------------------------------------- |
| `pnpm dev`       | Start the desktop app with hot reload.                        |
| `pnpm build`     | Build all packages (desktop output: `apps/desktop/out`).    |
| `pnpm typecheck` | Run strict TypeScript checks for all packages.                |
| `pnpm lint`      | Lint the repository with ESLint.                              |
| `pnpm test`      | Run tooling and workspace tests.                             |
| `pnpm env:check` | Check required configuration without printing values.        |

To run the production build locally: `pnpm build && pnpm --filter @temivo/desktop start`.

### Linux notes

- On a headless machine, run Electron with a virtual display: `xvfb-run -a pnpm dev`.
- If Electron aborts with “The SUID sandbox helper binary was found, but is not configured
  correctly”, give the helper the permissions Chromium expects:

  ```sh
  sudo chown root:root node_modules/.pnpm/electron@*/node_modules/electron/dist/chrome-sandbox
  sudo chmod 4755 node_modules/.pnpm/electron@*/node_modules/electron/dist/chrome-sandbox
  ```

## Architecture

```
apps/
  desktop/        Electron + React + TypeScript + Vite (electron-vite)
    src/main/       Electron main process
    src/preload/    Secure bridge exposing a small typed API as window.temivo
    src/shared/     Types shared by preload and renderer
    src/renderer/   React UI
packages/
  core/           @temivo/core — shared, platform-independent domain logic
```

### Shared core

`@temivo/core` holds the domain logic that every client shares: the mind map data model and map
operations. It is plain TypeScript with no dependency on Electron, React, browser or Node.js APIs,
storage, or the operating system, so the desktop app and a future mobile app can both use it.
Platform-specific concerns (persistence, AI requests, file access, UI) live in each app and are
passed into core through parameters or interfaces. The boundary is enforced by core's
`tsconfig.json` (ES libraries only) and by ESLint import restrictions.

The core package exports its TypeScript sources and is bundled by each consuming app.

### Local persistence

The Electron main process stores maps in `temivo.sqlite` under Electron's per-user `userData`
directory, not the checkout. It uses Node's built-in `node:sqlite` (also available in the pinned
Electron runtime), with foreign keys, WAL journaling, transactional writes, and versioned schema
migrations. A database from a newer schema version is rejected, never reset.

Core exports platform-independent map/node/link types, validation, and the `MindMapRepository`
interface. The desktop implements that interface; a future mobile app can supply its own adapter.
Node IDs are scoped to a map. Nodes have a nullable parent ID; empty maps and unfinished text are
allowed, while duplicate IDs, missing parents, and parent cycles are rejected.

Links are separate from maps. A source node has at most one outgoing map link; linking again
replaces that link. Detaching, removing the source node, or deleting the source map does not
delete the target. Deleting a target removes incoming links, not their source maps.

Renderer code uses `window.temivo.maps` through the preload bridge: `list`, `get`, `save`, `delete`,
`getLinks`, `link`, and `unlink`. Results are `{ ok: true, value }` or
`{ ok: false, error: { code, message } }`; callers must handle failures. Main validates inputs,
rejects untrusted frames, and keeps raw database errors out of IPC responses. No editor UI is
included yet.

### Configuration and secrets

No application environment variables are required yet. `.env.example` is the public contract:
future required variables are declared as unique `NAME=` entries with empty placeholders.
Users supply their values through the process environment or a local, ignored `.env`.
`pnpm env:check` only reports declared names as `present` or `missing`, exits nonzero for missing
values or check failures, and never prints values. An inherited process value takes precedence.
The helper validates configuration; it does not load it into the app.

Agents must use the helper instead of reading real environment files. The pre-tool hook also
blocks direct secret-file paths, common shell secret reads, and obvious environment dumps.
It is a guardrail, not a sandbox: arbitrary shell code or unrecognized tools cannot be fully
secured by path and command matching. Only `.env.example` may be edited as a public template.
Keep AI credentials out of `VITE_*`, renderer/preload APIs, and the SQLite maps database.
Production credential storage is a separate, platform-protected integration.

### Copilot configuration

`.github/copilot-instructions.md` defines architecture, product invariants, validation, and
secret-handling rules. `.github/github-app.yml` adds manual environment-check and validation
commands in the Copilot app. Review and accept that configuration in the app before it applies.

Focused custom agents live in `.github/agents/`:

| Agent | Model | Scope |
| --- | --- | --- |
| `reviewer` | `claude-opus-5.5` | Read-only review of substantial or risky changes. |
| `designer` | `claude-sonnet-5.5` | Scoped UI/UX implementation and accessibility. |
| `checks` | `claude-haiku-5.5` | Run existing checks and report failures, without fixes. |

Use the primary agent directly for small tasks and complex implementation. Delegate only a
bounded task when useful, do not recursively delegate, and escalate ambiguous failures instead
of looping with a lightweight model. Profiles request these models; actual availability and
model selection support depend on the Copilot host and account. If a model is unavailable,
select an available alternative explicitly rather than assuming a silent fallback.

`pnpm test` includes dependency-free Node.js tests for hooks and the configuration helper,
Vitest domain tests, SQLite persistence tests, and main/preload IPC contract tests.

### Desktop security

The renderer runs with `contextIsolation`, `sandbox`, and no Node.js integration. It talks to the
rest of the app only through the preload API. New windows and navigation are blocked, permission
requests are denied, and a Content-Security-Policy restricts loaded content.

## License

[MIT](LICENSE)
