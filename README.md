# Temivo

Temivo is a desktop app for exploring and learning topics through AI-generated mind maps. Nodes can
lead to separate linked maps, which stay independent and can be detached.

> This repository currently contains the project foundation: a pnpm workspace with a shared core
> package and an Electron desktop app showing a placeholder screen.

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
| `pnpm test`      | Run Vitest tests for all packages.                            |

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

### Desktop security

The renderer runs with `contextIsolation`, `sandbox`, and no Node.js integration. It talks to the
rest of the app only through the preload API. New windows and navigation are blocked, permission
requests are denied, and a Content-Security-Policy restricts loaded content.

## License

[MIT](LICENSE)
