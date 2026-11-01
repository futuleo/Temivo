# Temivo

Temivo is an app for AI-assisted exploration and learning through linked mind maps. Nodes can
lead to separate linked maps, which stay independent and can be detached. The repository is a
monorepo with a platform-independent shared core; the desktop app is the first client and the
initial release, and other clients can reuse the core later.

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

#### Mind map model

Core exports the map/node/link types, validation helpers (`assertMindMap`, `assertMapLink`,
`assertMapId`, `InvalidMindMapError`), and the async `MindMapRepository` port. The port only
describes persistence; core contains no storage implementation. The desktop supplies a SQLite adapter;
no editor UI exists yet. Node IDs are scoped to a map and nodes have a nullable parent ID. Empty maps and
unfinished text are allowed, while duplicate IDs, missing parents, and parent cycles are rejected.
A link targets a separate map; maps stay independent of their links.

#### Editor domain (phase 1)

The richer product state is **`MapDocument` inside `MapLibrary`**, not an extension of the
persisted `MindMap` DTO. A document wraps the basic map plus per-node descriptions, generation
context, provenance/baselines, revisions and retired node identities. A library contains independent
documents, links, flat collections and retired map identities. `assertMapDocument` and
`assertMapLibrary` validate complete snapshots. All public APIs are exported from `@temivo/core`.

**This state is not persisted yet.** The current `MindMapRepository`, SQLite adapter and maps IPC
still support only the original basic model. `createMapDocument(legacyMap)` explicitly imports a
basic map as user-authored content; there is no rich-state save port or lossy export adapter.
Do not save `document.map` and assume its sibling metadata, collections or generation state were
saved. A later phase must add migrations/adapters before any UI relies on rich-state durability.

Operations return immutable snapshots and never mutate their inputs; callers must retain the
returned library and treat readonly values as immutable (core does not deep-freeze them at runtime).
IDs are supplied by the caller, with node IDs scoped per map. Deleted map/node IDs are retired
within that library/document so delayed work cannot resurrect another object under the same ID.
Invalid inputs, missing references and invalid hierarchies throw `InvalidMindMapError`.

| Surface | Contract |
| --- | --- |
| Creation/editing | `createMapDocument`, `createTopicMap`, `createMapLibrary`, `addMap`, `renameMap`, `addNode`, `editNode`, `reparentNode`, `removeNode`, `removeMap`. Empty maps/text and forests remain valid. `removeNode` is an explicit **subtree** deletion. |
| Node fields | `description` plus `context: { instructions, detail, depth }`; defaults are empty instructions/description, `brief` detail and depth `1`. `editNode` replaces supplied fields/context and records user edits even if the value is unchanged or later reverted. |
| Collections | `createCollection`, `renameCollection`, `removeCollection`, `addCollectionMember`, `removeCollectionMember`. A map may appear in multiple collections; removing membership/collection never deletes a map. Duplicate membership is idempotent. |
| Links | `linkMaps` replaces only that source node's outgoing link; `unlinkMap` detaches it. Source deletion never deletes targets. Target deletion cleans incoming links and collection references, not source maps. Link changes record edits on anchors and invalidate in-flight generation in the source map. |
| Navigation | `startNavigation`, `followMapLink`, `navigateBack`, `navigateToBreadcrumb` retain the actual traversal path, including cycles. Depth is the zero-based path index, not ownership. Historical breadcrumbs survive unlink/source-node removal; `reconcileNavigation` explicitly truncates at a deleted map, returning `null` if the starting map was deleted. |
| Overview | `projectLinkedWorlds(library, rootMapId, expandedMapIds)` emits depth-first flat rows with parent-row references. Expansion is by map ID. Cycles/shared targets are terminal reference rows; each map expands at most once. All maps remain independent library entries. |

#### Generation contract (no provider execution)

`beginGeneration(library, mapId, anchorNodeId, mode)` returns an updated library and a request
containing the selected topic, editable context, in-scope saved node snapshots, a sequence and
snapshot guard. Retain the new library **before** dispatching work outside core. Only the latest
request for a map can apply. Any intervening map edit (including context, hierarchy or source links)
invalidates it; unrelated map edits and collection organization do not.

Generation depth is a positive safe integer **relative to the selected node**: `1` means immediate
children, `2` adds one more node level. It is unrelated to navigation between independent worlds.
Reducing depth only changes the requested scope: it never removes saved descendants, even pristine
AI content. Existing deeper nodes remain available on expansion. Visual collapse state belongs to
the future renderer. No arbitrary product depth cap or layout rules are imposed by core.

The default `refresh` mode accepts explicit node-ID patches:
`{ kind: 'upsert', nodeId, parentId, text, description }` or `{ kind: 'remove', nodeId }`.
An omitted node is **always retained**; a shorter response is never interpreted as a deletion diff.
Changes outside the selected scope/depth, duplicate/reused IDs, missing parents, cycles, and
removing/reparenting the anchor are rejected. Every existing upsert/remove target must already
belong to the anchor's **current** subtree and requested depth. Historical AI provenance does not
re-admit a relocated branch or its pristine descendants; those nodes must first be explicitly moved
back by the editor or addressed from their current location. In-scope user reparenting remains
protected by conflict proposals.

Use `expand` mode for lazy loading: the request includes existing saved children for reuse, and
patches may only add missing identities or repeat unchanged content. Changing/removing existing
content is rejected. Identity/semantic matching is the caller/provider adapter's responsibility;
core never guesses that two phrases identify the same node.

`planGeneration(library, request, changes)` separates `automaticNodeIds` from reasoned `conflicts`.
`applyGenerationPlan` revalidates/recomputes that classification, applies safe work immediately and
returns `{ library, pendingConflicts }`. Only unchanged AI nodes from the same anchor scope can be
automatically rewritten. User-authored/edited nodes, other generation scopes and linked anchors
remain proposals; equal-valued patches are no-ops and never clear user provenance. Moving/deleting
an AI ancestor with protected descendants also requires a proposal. Generation removal deletes
only the named node, promoting surviving children to the nearest surviving parent, never silently
deleting a subtree or an independent linked world. Removal patches cannot target deeper stored
content outside the current requested depth; explicit editor deletion remains a separate action.

`approveGenerationConflicts(library, pendingConflicts, selectedNodeIds)` applies an explicit batch,
rechecking the current hierarchy, depth and snapshot. Dependent changes may need approval together.
The receipt is single-use: accepting a subset invalidates the remainder, so discard it or regenerate
against the new snapshot. Discarding a receipt is rejection; there is no required confirmation step
for safe automatic work. Approved user content stays user-protected for future generations.
`StaleGenerationError` (an `InvalidMindMapError`) rejects old results, out-of-order work, replays or
stale approvals rather than rebasing over intervening edits. Guards include exact canonical content
as well as revisions, distinguishing divergent immutable snapshots with equal counters; they are
optimistic concurrency data, not security credentials.

### Local persistence

The Electron main process stores maps in `temivo.sqlite` under Electron's per-user `userData`
directory, not the checkout. It uses Node's built-in `node:sqlite` (also available in the pinned
Electron runtime), with foreign keys, WAL journaling, transactional map saves, and versioned,
transactional schema migrations. A database from a newer schema version is rejected, never reset.
Startup failures are reported without deleting or replacing existing storage.

The desktop implements core's `MindMapRepository` interface; a future mobile app can supply its
own adapter. Links are separate rows. A source node has at most one outgoing map link; linking
again replaces that link. Detaching, removing the source node, or deleting the source map does
not delete the target. Deleting a target removes incoming links, not their source maps.

Renderer code uses `window.temivo.maps` through the preload bridge: `list`, `get`, `save`, `delete`,
`getLinks`, `link`, and `unlink`. Results are `{ ok: true, value }` or
`{ ok: false, error: { code, message } }`; callers must handle failures. Failure codes are
`INVALID_INPUT`, `FORBIDDEN`, and `STORAGE_ERROR`. Main validates inputs, rejects untrusted frames,
and keeps raw database errors out of IPC responses. No database path, raw IPC, Node.js objects,
or credentials are exposed to the renderer.

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
Keep AI credentials out of `VITE_*`, renderer/preload APIs, and any local database.
AI provider infrastructure is described below; it is not connected to the application yet.

### AI infrastructure (not yet integrated)

Main-only modules in `apps/desktop/src/main/ai-*` provide bounded JSON transport and protected
settings storage. They are intentionally **not wired to startup, IPC, preload, core, SQLite, or
the UI**. They do not constitute a working generation feature; approved domain-output validation,
application of results, and provider/settings UI are still pending.

`AiProviderTransport` takes an injected fetch function and an explicit provider, API base URL,
user-selected model, credential, and private prompt. The `openai-compatible` adapter appends
`/chat/completions` (for example a DeepSeek API base); `anthropic` appends `/messages` and uses
native Messages headers/body (its API base includes `/v1`). No model, endpoint, or provider is
silently selected. Both use `max_tokens`; a configured model must support that protocol parameter.
Non-loopback endpoints require HTTPS; HTTP is allowed only for literal `127.0.0.1` and `::1`.
URL credentials, queries, fragments, redirects, retries, and provider fallback are disallowed.
Requests default to a 30-second deadline and a 256-KiB streamed response limit. Only complete text
responses containing valid JSON are accepted; tool calls, refusals, malformed replies, and
provider-reported truncation fail explicitly. Returned JSON is still `unknown`, not validated
domain data. Errors contain fixed codes/messages, never raw provider bodies or exception causes.

`AiSettingsStore` takes an explicit main-private file path and an injected key codec. Use one
instance per file. Updates serialize within that instance and atomically replace the file via a
same-directory, exclusively created, mode-0600 temporary file, synced before rename. Settings
contain versioned provider metadata and ciphertext only, never plaintext credentials. Corrupt or
unsupported files are rejected, not reset; failed updates preserve the previous file. A missing
key update retains a key only for the same provider and normalized API base; changing either
removes the old key unless a new one is explicitly supplied. Model-only edits retain it.
Encrypted envelopes also bind the key to that destination. `null` removes a key. The serializable
summary contains only `config` and `hasKey`; `hasKey` indicates stored ciphertext, not successful
unlocking. `readForRequest()` returns credentials **only for use inside main**, never for IPC.

`createAiKeyCodec` accepts Electron 45's async safeStorage API by injection; it imports no Electron
runtime. Creation, metadata writes, and summary reads do not initialize key protection or prompt
Keychain. Actual key encryption/decryption checks availability lazily and fails explicitly if
unavailable, with no plaintext fallback. macOS/Windows are supported by this wrapper. Linux is
currently **unavailable by design**: the installed API's `getSelectedStorageBackend()` does not
establish the backend used by its separate async encryptor, so neither an unknown backend nor a
potential basic-text fallback is accepted as protection. Linux support needs a verifiable protected
async backend before enabling it.

Unit tests inject fetch and fake safeStorage/codec implementations and use newly created
temporary files. They use no network sockets, live providers, real keys, Electron process,
Keychain, or existing application/user-data directories. No manual app or live-provider check is
implied by these tests or by a static production build.

### Copilot configuration

`.github/copilot-instructions.md` defines architecture, product invariants, validation, and
secret-handling rules. `.github/github-app.yml` adds manual environment-check and validation
commands in the Copilot app. Review and accept that configuration in the app before it applies.

Focused custom agents live in `.github/agents/`:

| Agent | Model | Scope |
| --- | --- | --- |
| `coordinator` | `claude-sonnet-5.5` | Owns accepted tasks, assigns workers, gates and integrates. |
| `reviewer` | `claude-opus-5.5` | Read-only review of substantial or risky changes; reports via `send_session_message`. |
| `designer` | `claude-sonnet-5.5` | Scoped UI/UX implementation and accessibility. |
| `checks` | `claude-haiku-5.5` | Run existing checks and report failures, without fixes. |

Use the primary agent directly for small tasks and complex implementation. Delegate only a
bounded task when useful, do not recursively delegate, and escalate ambiguous failures instead
of looping with a lightweight model. Profiles request these models; actual availability and
model selection support depend on the Copilot host and account. If a model is unavailable,
select an available alternative explicitly rather than assuming a silent fallback.

#### Coordinator workflow (no PRs)

Start work by opening a session with the `coordinator` profile and accepting a task. Then:

1. The coordinator starts a worker in an isolated worktree (native coordinated session, notified
   on idle; no polling) and records task, session, branch, and base.
2. The worker commits and pushes only its own branch and sends **READY**: task/session, branch,
   exact head SHA, base SHA/ref, scope, validation results, blockers. Idle alone is not READY.
3. The coordinator re-reads Git refs, then launches a different read-only `reviewer` on the exact
   base/head SHAs. Findings or uncertainty go back to the worker; fixed SHAs are re-reviewed.
4. After a clean review, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` must pass on the
   exact SHA, plus applicable remote checks.
5. The coordinator alone integrates, one branch at a time, by fast-forward after re-checking remote
   `main`. If `main` advanced, the worker updates and revalidates, and the new SHA is re-reviewed.

PRs are created only on request. Limitation: this relies on active local app/session
coordination; it is not an always-on global watcher of arbitrary branches, and no schedule or
daemon is configured.

`pnpm test` includes dependency-free Node.js tests for hooks and the configuration helper,
Vitest domain tests, SQLite persistence tests, and main/preload IPC contract tests.

### Desktop security

The renderer runs with `contextIsolation`, `sandbox`, and no Node.js integration. It talks to the
rest of the app only through the preload API. New windows and navigation are blocked, permission
requests are denied, and a Content-Security-Policy restricts loaded content.

## License

[MIT](LICENSE)
