import { describe, expect, it, vi } from 'vitest';
import { Settings } from './settings';
import type { AiSettingsSummary as SettingsSummary } from '../../../shared/desktop-api';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const summary: SettingsSummary = {
  config: { provider: 'openai-compatible', endpoint: 'https://provider.invalid/v1', model: 'user-selected-model' },
  hasKey: true,
};

describe('settings draft state with injected metadata-only ports', () => {
  it('does not populate a credential field from stored-key metadata', async () => {
    const settings = new Settings({ load: async () => summary, save: vi.fn() });
    await settings.initialize();
    expect(settings.getSnapshot().fields.apiKey).toBe('');
    expect(settings.getSnapshot().fields.keyAction).toBe('keep');
    expect(settings.isReady()).toBe(true);
    expect(settings.isDirty()).toBe(false);
  });

  it('keeps form edits typed while settings are loading', async () => {
    const result = deferred<SettingsSummary>();
    const settings = new Settings({ load: () => result.promise, save: vi.fn() });
    const loading = settings.initialize();
    settings.change({ ...settings.getSnapshot().fields, model: 'my-new-model' });
    result.resolve(summary);
    await loading;
    expect(settings.getSnapshot().fields.model).toBe('my-new-model');
    expect(settings.getSnapshot().status).toContain('draft has been kept');
  });

  it('clears only a successfully submitted key, preserving later connection and key edits', async () => {
    const result = deferred<SettingsSummary>();
    const save = vi.fn(() => result.promise);
    const settings = new Settings({ load: async () => summary, save });
    await settings.initialize();
    settings.change({ ...settings.getSnapshot().fields, keyAction: 'replace', apiKey: 'fixture-only-not-a-real-key' });
    const saving = settings.save();
    settings.change({ ...settings.getSnapshot().fields, model: 'changed-while-saving' });
    result.resolve(summary);
    await saving;
    expect(settings.getSnapshot().fields).toMatchObject({ apiKey: '', keyAction: 'keep', model: 'changed-while-saving' });
    expect(settings.isDirty()).toBe(true);

    const second = deferred<SettingsSummary>();
    const next = new Settings({ load: async () => summary, save: () => second.promise });
    await next.initialize();
    next.change({ ...next.getSnapshot().fields, keyAction: 'replace', apiKey: 'first-fixture' });
    const pending = next.save();
    next.change({ ...next.getSnapshot().fields, apiKey: 'newer-fixture' });
    second.resolve(summary);
    await pending;
    expect(next.getSnapshot().fields.apiKey).toBe('newer-fixture');
    expect(next.getSnapshot().fields.keyAction).toBe('replace');
  });

  it('retains user-entered configuration and key after a save failure without claiming readiness', async () => {
    const settings = new Settings({
      load: async () => ({ config: null, hasKey: false }),
      save: async () => { throw new Error('Protected key storage is unavailable.'); },
    });
    await settings.initialize();
    settings.change({ provider: 'anthropic', endpoint: 'https://provider.invalid/messages', model: 'chosen-model', keyAction: 'replace', apiKey: 'fixture-only' });
    await settings.save();
    expect(settings.getSnapshot().fields.apiKey).toBe('fixture-only');
    expect(settings.getSnapshot().error).toBe('Protected key storage is unavailable.');
    expect(settings.isReady()).toBe(false);
    expect(settings.isDirty()).toBe(true);
  });
});
