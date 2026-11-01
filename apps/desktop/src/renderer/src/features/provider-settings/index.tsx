import { Notice } from '../../shared/ui';

export interface ProviderFields {
  readonly provider: 'openai-compatible' | 'anthropic';
  readonly endpoint: string;
  readonly model: string;
  readonly keyAction: 'keep' | 'replace' | 'remove';
  readonly apiKey: string;
}

export interface ProviderSettingsProps {
  fields: ProviderFields;
  hasStoredKey: boolean;
  dirty: boolean;
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  status: string | null;
  onChange: (fields: ProviderFields) => void;
  onSave: () => void;
  onRetryLoad: () => void;
}

export function ProviderSettings({
  fields, hasStoredKey, dirty, loaded, loading, saving, error, status, onChange, onSave, onRetryLoad,
}: ProviderSettingsProps) {
  const update = <K extends keyof ProviderFields>(key: K, value: ProviderFields[K]) => onChange({ ...fields, [key]: value });
  return (
    <form className="settings-card" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      <div className="section-heading"><div><span className="eyebrow">YOUR PROVIDER, YOUR CHOICE</span><h2>AI connection</h2></div><span className="badge">{!loaded ? 'Settings not loaded' : hasStoredKey ? 'Key configured' : 'No key configured'}</span></div>
      <p className="help">Temivo never supplies a key or chooses a model for you. Local maps work without AI. Saving settings does not test the provider or send a request.</p>
      {error && <Notice tone="error">{error}</Notice>}
      {status && <Notice tone="success">{status}</Notice>}
      {!loaded && <Notice>{loading ? 'Loading saved provider settings… Your form edits stay safe.' : <><p>Saved settings could not be loaded. Local maps still work; your form draft has been kept.</p><button type="button" onClick={onRetryLoad}>Retry loading settings</button></>}</Notice>}
      <label className="field">Provider protocol<select value={fields.provider} onChange={(event) => update('provider', event.target.value === 'anthropic' ? 'anthropic' : 'openai-compatible')}>
        <option value="openai-compatible">OpenAI-compatible (including DeepSeek)</option><option value="anthropic">Anthropic (native Messages API)</option>
      </select></label>
      <label className="field">Endpoint URL<input type="url" required value={fields.endpoint} placeholder="Enter your provider endpoint" onChange={(event) => update('endpoint', event.target.value)} spellCheck={false} /></label>
      <p className="help">Use your provider's documented endpoint. The desktop main process validates it and handles all network requests.</p>
      <label className="field">Model ID<input required value={fields.model} placeholder="Exact model ID from your provider" onChange={(event) => update('model', event.target.value)} spellCheck={false} /></label>
      <fieldset className="credential-fields"><legend>API key (write-only)</legend>
        <label className="field">Credential action<select value={fields.keyAction} onChange={(event) => onChange({ ...fields, keyAction: event.target.value === 'replace' ? 'replace' : event.target.value === 'remove' ? 'remove' : 'keep', apiKey: '' })}>
          <option value="keep">{hasStoredKey ? 'Keep the configured key' : 'Do not add a key'}</option><option value="replace">Enter a new key</option><option value="remove">Remove the configured key</option>
        </select></label>
        {fields.keyAction === 'replace' && <label className="field">New API key<input type="password" autoComplete="new-password" required value={fields.apiKey} onChange={(event) => update('apiKey', event.target.value)} spellCheck={false} /></label>}
        <p className="help">Only the key you type is present in this form. Stored keys are never returned or displayed. New keys are cleared from the form after a successful save.</p>
      </fieldset>
      <p className="help">Generation uses the last saved connection, not unapplied settings form edits.</p>
      <button type="submit" className="primary" disabled={saving || !dirty || !loaded}>{saving ? 'Saving settings…' : 'Save settings'}</button>
    </form>
  );
}
