import type { ProviderFields } from '../features/provider-settings';
import type { AiSettingsSummary } from '../../../shared/desktop-api';

export interface SettingsPorts {
  load(): Promise<AiSettingsSummary>;
  save(fields: ProviderFields): Promise<AiSettingsSummary>;
}

export interface SettingsState {
  readonly fields: ProviderFields;
  readonly saved: AiSettingsSummary | null;
  readonly loading: boolean;
  readonly loaded: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly status: string | null;
}

function emptyFields(): ProviderFields {
  return { provider: 'openai-compatible', endpoint: '', model: '', keyAction: 'keep', apiKey: '' };
}

function fromSummary(summary: AiSettingsSummary): ProviderFields {
  return { ...emptyFields(), ...summary.config };
}

export class Settings {
  private state: SettingsState = {
    fields: emptyFields(), saved: null, loading: true, loaded: false, saving: false, error: null, status: null,
  };
  private readonly listeners = new Set<() => void>();
  private loadTask: Promise<void> | null = null;
  private editVersion = 0;

  constructor(private readonly ports: SettingsPorts) {}

  readonly getSnapshot = (): SettingsState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<SettingsState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  readonly initialize = (): Promise<void> => {
    if (this.state.loaded) return Promise.resolve();
    if (this.loadTask) return this.loadTask;
    this.loadTask = this.load().finally(() => { this.loadTask = null; });
    return this.loadTask;
  };

  private async load(): Promise<void> {
    const version = this.editVersion;
    this.update({ loading: true, error: null });
    try {
      const saved = await this.ports.load();
      this.update({
        saved, loading: false, loaded: true,
        fields: this.editVersion === version ? fromSummary(saved) : this.state.fields,
        status: this.editVersion === version ? null : 'Saved settings loaded. Your newer form draft has been kept.',
      });
    } catch (error) {
      this.update({ loading: false, error: error instanceof Error ? error.message : 'Settings could not be loaded. Your draft has been kept.' });
    }
  }

  change(fields: ProviderFields): void {
    this.editVersion += 1;
    this.update({ fields, status: null });
  }

  isDirty(): boolean {
    const saved = this.state.saved ? fromSummary(this.state.saved) : emptyFields();
    const fields = this.state.fields;
    return fields.provider !== saved.provider || fields.endpoint !== saved.endpoint ||
      fields.model !== saved.model || fields.keyAction !== 'keep' || fields.apiKey !== '';
  }

  isReady(): boolean {
    return !!this.state.saved?.config && this.state.saved.hasKey;
  }

  async save(): Promise<void> {
    if (this.state.saving) return;
    if (!this.state.loaded) {
      this.update({ error: 'Load the saved settings before applying changes. Your form draft is intact.' });
      return;
    }
    const submitted = this.state.fields;
    if (!submitted.endpoint.trim() || !submitted.model.trim() ||
      (submitted.keyAction === 'replace' && !submitted.apiKey.trim())) {
      this.update({ error: 'Enter an endpoint, a model ID, and a new key when replacing credentials.' });
      return;
    }
    this.update({ saving: true, error: null, status: null });
    try {
      const saved = await this.ports.save(submitted);
      const current = this.state.fields;
      const canonical = fromSummary(saved);
      const keyUnchanged = current.keyAction === submitted.keyAction && current.apiKey === submitted.apiKey;
      this.update({
        saved, saving: false,
        fields: {
          provider: current.provider === submitted.provider ? canonical.provider : current.provider,
          endpoint: current.endpoint === submitted.endpoint ? canonical.endpoint : current.endpoint,
          model: current.model === submitted.model ? canonical.model : current.model,
          keyAction: keyUnchanged ? 'keep' : current.keyAction,
          apiKey: keyUnchanged ? '' : current.apiKey,
        },
        status: 'Settings saved. No provider request was sent. Any newer form edits are still a draft.',
      });
    } catch (error) {
      this.update({
        saving: false,
        error: error instanceof Error ? error.message : 'Settings could not be saved. Your form draft has been kept.',
      });
    }
  }
}
