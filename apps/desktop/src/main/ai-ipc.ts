import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';

import { AI_CHANNELS } from '../shared/ai-api';
import type { DesktopResult, LibrarySnapshot } from '../shared/desktop-api';
import { AiInfrastructureError } from './ai-errors';
import {
  assertCurrentGeneration, decodeGenerationChanges, generationPrompt,
  parseCancellation, parseGenerationRequest,
} from './ai-generation';
import { assertAiKey, isRecord, parseAiProviderConfig } from './ai-provider-config';
import type { AiProviderTransport } from './ai-provider-transport';
import type { AiSettingsStore } from './ai-settings-store';
import type { LibraryRepository } from './mind-map-repository';

interface AiDependencies {
  repository: Pick<LibraryRepository, 'loadLibrary'>;
  settings: Pick<AiSettingsStore, 'summary' | 'update' | 'readForRequest'>;
  transport: Pick<AiProviderTransport, 'request'>;
  createId: () => string;
}

interface ActiveGeneration {
  owner: WebContents;
  sequence: number;
  controller: AbortController;
}

type TerminalCode = 'CANCELLED' | 'STALE_GENERATION';
interface SequenceGuard { sequence: number; code: TerminalCode }

class AiStorageError extends Error {}

function updateInput(value: unknown): { config: ReturnType<typeof parseAiProviderConfig>; key: string | null | undefined } {
  if (
    !isRecord(value) || Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'config') || !Object.hasOwn(value, 'keyAction') ||
    !isRecord(value.keyAction)
  ) throw new AiInfrastructureError('INVALID_CONFIG');
  const action = value.keyAction;
  const config = parseAiProviderConfig(value.config);
  if (Object.keys(action).length === 1 && Object.hasOwn(action, 'kind')) {
    if (action.kind === 'keep') return { config, key: undefined };
    if (action.kind === 'remove') return { config, key: null };
  }
  if (
    Object.keys(action).length === 2 && Object.hasOwn(action, 'key') &&
    action.kind === 'replace' && typeof action.key === 'string'
  ) {
    assertAiKey(action.key);
    return { config, key: action.key };
  }
  throw new AiInfrastructureError('INVALID_CONFIG');
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Generation only proposes changes. Renderer owns core application and storage CAS. */
export function registerAiIpc(
  dependencies: AiDependencies,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): { cancelOwner(owner: WebContents): void; dispose(): void } {
  const active = new Map<string, ActiveGeneration>();
  const history = new WeakMap<WebContents, Map<string, SequenceGuard>>();
  let disposed = false;

  const ownerHistory = (owner: WebContents): Map<string, SequenceGuard> => {
    let guards = history.get(owner);
    if (!guards) {
      guards = new Map();
      history.set(owner, guards);
    }
    return guards;
  };
  const requireCapacity = (guards: Map<string, SequenceGuard>, mapId: string): void => {
    // Keep pre-cancellation and replay guards bounded without evicting safety information.
    if (!guards.has(mapId) && guards.size >= 128) throw new AiInfrastructureError('REQUEST_LIMIT');
  };
  const checkSequence = (owner: WebContents, mapId: string, sequence: number): void => {
    const guards = ownerHistory(owner);
    requireCapacity(guards, mapId);
    const previous = guards.get(mapId);
    if (previous && sequence <= previous.sequence) {
      throw new AiInfrastructureError(sequence === previous.sequence ? previous.code : 'STALE_GENERATION');
    }
  };
  const cancelOwner = (owner: WebContents): void => {
    for (const [mapId, job] of active) {
      if (job.owner !== owner) continue;
      const guards = ownerHistory(owner);
      if ((guards.get(mapId)?.sequence ?? 0) <= job.sequence) {
        guards.set(mapId, { sequence: job.sequence, code: 'CANCELLED' });
      }
      job.controller.abort(new AiInfrastructureError('CANCELLED'));
    }
  };
  const ensureLive = (event: IpcMainInvokeEvent, job?: ActiveGeneration): void => {
    if (job?.controller.signal.aborted) throw job.controller.signal.reason;
    if (disposed || !isTrustedSender(event)) throw new AiInfrastructureError('CANCELLED');
  };
  const loadLibrary = async (): Promise<LibrarySnapshot> => {
    try {
      return await dependencies.repository.loadLibrary();
    } catch {
      throw new AiStorageError();
    }
  };

  function handle<T>(channel: string, action: (event: IpcMainInvokeEvent, args: unknown[]) => Promise<T>): void {
    ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<DesktopResult<T>> => {
      if (!isTrustedSender(event)) {
        console.warn('Rejected an AI request from an untrusted frame.');
        return { ok: false, error: { code: 'FORBIDDEN', message: 'This frame cannot access AI.' } };
      }
      try {
        ensureLive(event);
        const value = await action(event, args);
        ensureLive(event);
        if (channel === AI_CHANNELS.generate) {
          const request = parseGenerationRequest(args[0]);
          const guard = ownerHistory(event.sender).get(request.mapId);
          if (guard && guard.sequence > request.sequence) throw new AiInfrastructureError('STALE_GENERATION');
          if (guard?.sequence === request.sequence && guard.code === 'CANCELLED') {
            throw new AiInfrastructureError('CANCELLED');
          }
        }
        return { ok: true, value };
      } catch (error) {
        const failure = disposed || !isTrustedSender(event) ? new AiInfrastructureError('CANCELLED') : error;
        if (failure instanceof AiStorageError) {
          console.warn('AI map snapshot read failed.');
          return { ok: false, error: { code: 'STORAGE_ERROR', message: 'Unable to access local maps.' } };
        }
        const safe = new AiInfrastructureError(failure instanceof AiInfrastructureError ? failure.code : 'AI_ERROR');
        console.warn('AI operation failed.', safe.code);
        return { ok: false, error: { code: safe.code, message: safe.message } };
      }
    });
  }

  handle(AI_CHANNELS.getSettings, async (_event, args) => {
    if (args.length !== 0) throw new AiInfrastructureError('INVALID_REQUEST');
    return dependencies.settings.summary();
  });
  handle(AI_CHANNELS.updateSettings, async (_event, args) => {
    if (args.length !== 1) throw new AiInfrastructureError('INVALID_CONFIG');
    const { config, key } = updateInput(args[0]);
    return dependencies.settings.update(config, key);
  });
  handle(AI_CHANNELS.cancelGeneration, async (event, args) => {
    if (args.length !== 2) throw new AiInfrastructureError('INVALID_REQUEST');
    const { mapId, sequence } = parseCancellation(args[0], args[1]);
    const guards = ownerHistory(event.sender);
    requireCapacity(guards, mapId);
    const previous = guards.get(mapId);
    if (!previous || sequence >= previous.sequence) guards.set(mapId, { sequence, code: 'CANCELLED' });
    const job = active.get(mapId);
    if (job?.owner === event.sender && job.sequence === sequence) {
      job.controller.abort(new AiInfrastructureError('CANCELLED'));
    }
    return null;
  });
  handle(AI_CHANNELS.generate, async (event, args) => {
    if (args.length !== 1) throw new AiInfrastructureError('INVALID_REQUEST');
    const request = parseGenerationRequest(args[0]);
    checkSequence(event.sender, request.mapId, request.sequence);
    const initial = await loadLibrary();
    ensureLive(event);
    assertCurrentGeneration(initial.library, request);
    const prompt = generationPrompt(request);
    checkSequence(event.sender, request.mapId, request.sequence);
    const previous = active.get(request.mapId);
    if (previous && previous.sequence >= request.sequence) throw new AiInfrastructureError('STALE_GENERATION');
    if ([...active.values()].filter((job) => job.owner === event.sender && job !== previous).length >= 8) {
      throw new AiInfrastructureError('REQUEST_LIMIT');
    }
    previous?.controller.abort(new AiInfrastructureError('STALE_GENERATION'));
    const job: ActiveGeneration = { owner: event.sender, sequence: request.sequence, controller: new AbortController() };
    active.set(request.mapId, job);
    ownerHistory(event.sender).set(request.mapId, { sequence: request.sequence, code: 'STALE_GENERATION' });
    const ownerClosed = (): void => cancelOwner(event.sender);
    event.sender.once('destroyed', ownerClosed);
    event.sender.once('render-process-gone', ownerClosed);
    const live = async <T>(operation: () => Promise<T>): Promise<T> => {
      ensureLive(event, job);
      const result = await abortable(operation(), job.controller.signal);
      ensureLive(event, job);
      return result;
    };
    try {
      const { config, key } = await live(() => dependencies.settings.readForRequest());
      const response = await live(() => dependencies.transport.request(config, key, prompt, job.controller.signal));
      const latest = await live(loadLibrary);
      assertCurrentGeneration(latest.library, request);
      const changes = decodeGenerationChanges(response, latest.library, request, dependencies.createId);
      ensureLive(event, job);
      return changes;
    } finally {
      if (active.get(request.mapId) === job) active.delete(request.mapId);
      event.sender.removeListener('destroyed', ownerClosed);
      event.sender.removeListener('render-process-gone', ownerClosed);
    }
  });

  return {
    cancelOwner,
    dispose() {
      disposed = true;
      for (const job of active.values()) job.controller.abort(new AiInfrastructureError('CANCELLED'));
    },
  };
}
