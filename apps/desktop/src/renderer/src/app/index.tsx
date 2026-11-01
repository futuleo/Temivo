import { useEffect, useState, useSyncExternalStore } from 'react';
import type { DesktopApi } from '../../../shared/desktop-api';
import { createSettingsPorts, createWorkspacePorts } from './desktop-ports';
import { Settings } from './settings';
import { Workspace } from './workspace';
import { WorkspaceView } from './WorkspaceView';

export function App({ api }: { api?: DesktopApi }) {
  const [models] = useState(() => {
    const bridge = api ?? window.temivo;
    return {
      workspace: new Workspace(createWorkspacePorts(bridge)),
      settings: new Settings(createSettingsPorts(bridge.ai)),
    };
  });
  const settings = useSyncExternalStore(models.settings.subscribe, models.settings.getSnapshot, models.settings.getSnapshot);
  useEffect(() => { void models.settings.initialize(); }, [models]);
  return <WorkspaceView workspace={models.workspace} aiReady={models.settings.isReady()} settings={{
    fields: settings.fields,
    hasStoredKey: settings.saved?.hasKey ?? false,
    loaded: settings.loaded,
    loading: settings.loading,
    dirty: models.settings.isDirty(),
    saving: settings.saving,
    error: settings.error,
    status: settings.status,
    onChange: (fields) => models.settings.change(fields),
    onSave: () => void models.settings.save(),
    onRetryLoad: () => void models.settings.initialize(),
  }} />;
}
