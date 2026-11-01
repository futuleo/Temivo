import { ProviderSettings } from '../../features/provider-settings';
import type { ProviderSettingsProps } from '../../features/provider-settings';

export function SettingsPage(props: ProviderSettingsProps) {
  return (
    <section className="settings-page">
      <header className="page-heading"><div><p className="eyebrow">SET THINGS UP YOUR WAY</p><h1>Settings</h1><p className="page-description">Connect an AI provider when you are ready. Your maps stay yours.</p></div></header>
      <ProviderSettings {...props} />
      <section className="settings-note"><h2>What AI can change</h2><p>Unchanged AI-generated nodes can update automatically. Your own nodes and edited AI content receive explicit proposals instead. Reducing depth folds branches, and linked worlds always remain independent.</p></section>
    </section>
  );
}
