import { useState } from 'react';
import type { DesktopApi } from '../../../shared/desktop-api';
import { createLibraryPorts } from './desktop-ports';
import { Workspace } from './workspace';
import { WorkspaceView } from './WorkspaceView';

export function App({ api }: { api?: DesktopApi }) {
  const [workspace] = useState(() => new Workspace({
    ...createLibraryPorts((api ?? window.temivo).maps),
    newId: () => crypto.randomUUID(),
  }));
  return <WorkspaceView workspace={workspace} settings={null} aiReady={false} />;
}
