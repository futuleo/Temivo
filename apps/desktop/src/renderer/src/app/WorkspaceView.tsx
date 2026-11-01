import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { isDraftDirty, nodeFingerprint, parentChoices } from '../entities/map';
import type { ProviderSettingsProps } from '../features/provider-settings';
import { LibraryPage } from '../pages/library';
import { WorldPage } from '../pages/world';
import { SettingsPage } from '../pages/settings';
import { ConfirmDialog, Modal, NameDialog, Notice } from '../shared/ui';
import { LibraryNav } from '../widgets/library-nav';
import type { Workspace } from './workspace';

type Dialog =
  | { kind: 'name'; title: string; label: string; value?: string; submitLabel: string; onSubmit: (value: string) => void }
  | { kind: 'confirm'; title: string; body: ReactNode; confirmLabel: string; onConfirm: () => void }
  | { kind: 'create-map'; initialTopic: string; source?: { mapId: string; nodeId: string } }
  | { kind: 'memberships'; mapId: string };

export function WorkspaceView({
  workspace,
  settings,
  aiReady,
}: {
  workspace: Workspace;
  settings: ProviderSettingsProps;
  aiReady: boolean;
}) {
  const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const drafts = Object.values(state.drafts).filter((entry) => isDraftDirty(entry.draft));
  const hasUnsaved = state.dirty || drafts.length > 0 || settings.dirty || settings.saving || state.generation !== null;
  useEffect(() => {
    void workspace.initialize();
  }, [workspace]);
  useEffect(() => {
    if (!hasUnsaved) return;
    const protectDrafts = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', protectDrafts);
    return () => window.removeEventListener('beforeunload', protectDrafts);
  }, [hasUnsaved]);

  const library = state.library;
  if (!library) {
    return <main className="startup-state"><span className="brand-mark" aria-hidden="true">t.</span><h1>{state.loading ? 'Opening your worlds…' : 'Your library could not be opened'}</h1>{state.error && <Notice tone="error">{state.error}</Notice>}{!state.loading && <button type="button" className="primary" onClick={() => void workspace.initialize()}>Retry loading library</button>}<p className="help">No placeholder library is created when storage fails.</p></main>;
  }

  const disabled = state.saving || state.loading || state.storageConflict;
  const document = workspace.currentDocument();
  const mapId = document?.map.id;
  const nodeId = mapId ? state.selectedNodes[mapId] : undefined;
  const node = document?.map.nodes.find((item) => item.id === nodeId);
  const draft = mapId && nodeId ? workspace.getDraft(mapId, nodeId) : undefined;
  const draftStale = !!(document && node && draft && draft.base !== nodeFingerprint(document, node.id));
  const proposal = mapId ? state.proposals[mapId] : undefined;
  const closeDialog = () => setDialog(null);
  const confirm = (title: string, body: ReactNode, confirmLabel: string, onConfirm: () => void) => setDialog({ kind: 'confirm', title, body, confirmLabel, onConfirm });
  const name = (title: string, label: string, submitLabel: string, onSubmit: (value: string) => void, value?: string) => setDialog({ kind: 'name', title, label, submitLabel, onSubmit, value });
  const rename = (id: string) => name('Rename map', 'Map title', 'Rename map', (value) => workspace.renameMap(id, value), library.documents.find((item) => item.map.id === id)?.map.title);
  const organize = (id: string) => setDialog({ kind: 'memberships', mapId: id });
  const create = () => setDialog({ kind: 'create-map', initialTopic: '' });
  const deleteMap = (id: string) => confirm('Delete this map?', <><p>This deletes the map and its nodes, and removes incoming links and collection memberships.</p><p>Other maps, including worlds linked from this map, will not be deleted. Unapplied node drafts are kept in this session.</p></>, 'Delete map', () => workspace.deleteMap(id));

  return (
    <div className="app-shell">
      <LibraryNav library={library} collectionId={state.collectionId} page={state.page} draftCount={drafts.length} disabled={disabled}
        onLibrary={(id) => workspace.showLibrary(id)} onSettings={() => workspace.showSettings()}
        onCreateCollection={() => name('Create a collection', 'Collection name', 'Create collection', (value) => workspace.createCollection(value))} />
      <main className="main-content" id="main-content" tabIndex={-1}>
        <div className={`status-bar ${state.dirty ? 'status-unsaved' : ''}`}>
          <span role="status"><span className="status-dot" aria-hidden="true" />{state.loading ? 'Reloading saved library…' : state.storageConflict ? 'Version conflict · Local work retained' : state.saving ? 'Saving library…' : state.dirty ? 'Changes kept locally · Not saved yet' : 'All applied changes saved on this device'}</span>
          <div className="actions">
            {drafts.length > 0 && <span>{drafts.length} unapplied {drafts.length === 1 ? 'draft' : 'drafts'}</span>}
            {state.dirty && !state.storageConflict && <button type="button" disabled={state.saving} onClick={() => void workspace.save()}>Retry save</button>}
          </div>
        </div>
        <div className="global-notices">
          {state.error && <Notice tone="error"><div className="section-heading"><span>{state.error}</span><button type="button" onClick={() => workspace.clearError()} aria-label="Dismiss error">Dismiss</button></div></Notice>}
          {state.saveError && <Notice tone="error"><p>{state.saveError} Local changes and typed drafts have not been replaced.</p>{state.storageConflict && <><p>Reloading keeps editable node text as drafts, but discards unsaved structural changes, titles, links and collection changes. There is no automatic overwrite.</p><div className="actions"><button type="button" disabled={state.loading} onClick={() => confirm('Reload the saved library?', <p>Your local node fields will remain as drafts for review. Unsaved map titles, deletions, links, collection and hierarchy changes will be discarded. Keep this window open if you need to record those changes first.</p>, 'Reload saved version', () => void workspace.reloadSaved())}>Reload saved version…</button></div></>}</Notice>}
          {state.generationStatus && <Notice><div className="section-heading"><span>{state.generationStatus}</span>{state.generation && <button type="button" onClick={() => void workspace.cancelGeneration()}>Cancel generation</button>}</div></Notice>}
        </div>
        {state.page === 'library' && <LibraryPage library={library} collectionId={state.collectionId} query={state.query} expandedMapIds={state.expandedWorlds} disabled={disabled}
          onQuery={(query) => workspace.setQuery(query)} onCreateMap={create} onRenameMap={rename} onDeleteMap={deleteMap} onOrganizeMap={organize}
          onRenameCollection={(id) => name('Rename collection', 'Collection name', 'Rename collection', (value) => workspace.renameCollection(id, value), library.collections.find((item) => item.id === id)?.title)}
          onDeleteCollection={(id) => confirm('Delete this collection?', <p>Only this collection is removed. Every map stays in All Maps and in its other collections.</p>, 'Delete collection', () => workspace.deleteCollection(id))}
          onToggleWorld={(id) => workspace.toggleWorld(id)} onOpenWorld={(id, via) => workspace.openWorld(id, via)} />}
        {state.page === 'settings' && <SettingsPage {...settings} />}
        {state.page === 'world' && document && state.path && <WorldPage library={library} document={document} path={state.path} selectedNodeId={node?.id ?? null} expandedNodeIds={state.expandedNodes[document.map.id] ?? []} disabled={disabled}
          onSelect={(id) => workspace.selectNode(id)} onToggle={(id) => workspace.toggleNode(id)} onOpenWorld={(id) => workspace.followWorld(id)}
          onBreadcrumb={(index) => workspace.breadcrumb(index)} onBack={() => workspace.back()} onLibrary={() => workspace.showLibrary()}
          onAddRoot={() => name('Add a root node', 'Node text', 'Add node', (text) => workspace.addNode(document.map.id, null, text))}
          onRename={() => rename(document.map.id)} onCollections={() => organize(document.map.id)}
          nodeEditor={node && draft ? {
            document, node, draft, draftStale, disabled, generationBusy: state.generation !== null || !!proposal, aiReady,
            onChange: (fields) => workspace.changeDraft(document.map.id, node.id, fields),
            onApply: () => {
              if (draftStale) confirm('Apply your draft over changed fields?', <p>Your draft will replace the current saved text, description and generation context for this node. Its current parent is kept.</p>, 'Apply my draft', () => { workspace.applyDraft(document.map.id, node.id, true); });
              else workspace.applyDraft(document.map.id, node.id);
            },
            onReset: () => confirm('Reset this node draft?', <p>Your unapplied edits will be replaced with this node's current saved fields.</p>, 'Reset draft', () => workspace.resetDraft(document.map.id, node.id)),
            onReparent: (parentId) => workspace.reparent(document.map.id, node.id, parentId),
            onAddChild: () => name('Add a child node', 'Node text', 'Add child', (text) => workspace.addNode(document.map.id, node.id, text)),
            onDelete: () => confirm('Delete this subtree?', <><p>This removes {document.map.nodes.length - parentChoices(document, node.id).length} nodes, including this node and all saved descendants. This is separate from changing depth.</p><p>Linked worlds stay in All Maps. Unapplied drafts are kept in this session.</p></>, 'Delete subtree', () => workspace.deleteNode(document.map.id, node.id)),
            onGenerate: (mode) => void workspace.generate(document.map.id, node.id, mode),
            onSettings: () => workspace.showSettings(),
          } : null}
          worldLink={node ? {
            documents: library.documents, link: library.links.find((link) => link.sourceMapId === document.map.id && link.sourceNodeId === node.id), disabled,
            onLink: (id) => workspace.linkWorld(document.map.id, node.id, id),
            onCreate: () => setDialog({ kind: 'create-map', initialTopic: node.text, source: { mapId: document.map.id, nodeId: node.id } }),
            onOpen: () => workspace.followWorld(node.id),
            onDetach: () => confirm('Detach this world?', <p>The doorway is removed, but the linked map and all its content stay in All Maps.</p>, 'Detach world', () => workspace.detachWorld(document.map.id, node.id)),
          } : null}
          review={proposal ? {
            document, pending: proposal.pending, selectedIds: proposal.selectedIds, disabled,
            stale: document.revision !== proposal.pending.token.documentRevision || document.activeGeneration !== null,
            onToggle: (id) => workspace.toggleProposal(document.map.id, id),
            onAccept: () => confirm('Apply selected AI proposals?', <p>Selected proposals replace saved content. Unselected proposals will be discarded. Typed node drafts remain available for your review.</p>, 'Apply selected proposals', () => { workspace.approveProposals(document.map.id); }),
            onReject: () => workspace.dismissProposals(document.map.id),
          } : null} />}
        {drafts.length > 0 && <details className="draft-recovery"><summary>Unapplied node drafts ({drafts.length})</summary><p className="help">These drafts stay here while you navigate. Apply them to save; they are not stored across app restarts. Drafts for deleted nodes are retained below for manual recovery.</p>
          {drafts.map((entry) => {
            const live = library.documents.find((item) => item.map.id === entry.mapId)?.map.nodes.some((item) => item.id === entry.nodeId);
            return <article key={JSON.stringify([entry.mapId, entry.nodeId])}><strong>{entry.draft.fields.text || 'Untitled draft'}</strong>
              {live ? <div className="actions"><button type="button" onClick={() => { workspace.openWorld(entry.mapId); workspace.selectNode(entry.nodeId); }}>Continue editing</button></div> : <><p className="help">The original map or node is no longer present. Copy these fields before discarding this draft.</p><label className="field">Node text<textarea readOnly value={entry.draft.fields.text} /></label><label className="field">Description<textarea readOnly value={entry.draft.fields.description} /></label><label className="field">AI instructions<textarea readOnly value={entry.draft.fields.instructions} /></label><p className="help">Depth: {entry.draft.fields.depth}; detail: {entry.draft.fields.detail}</p></>}
              <button type="button" className="danger-quiet" onClick={() => confirm('Discard this unapplied draft?', <p>This removes only the draft, not the saved node. This cannot be undone.</p>, 'Discard draft', () => {
                if (live) workspace.resetDraft(entry.mapId, entry.nodeId);
                else workspace.discardDraft(entry.mapId, entry.nodeId);
              })}>Discard draft…</button></article>;
          })}
        </details>}
      </main>
      {dialog?.kind === 'name' && <NameDialog title={dialog.title} label={dialog.label} initialValue={dialog.value} submitLabel={dialog.submitLabel} disabled={disabled} error={state.error} onClose={closeDialog} onSubmit={(value) => {
        const before = workspace.getSnapshot().library;
        dialog.onSubmit(value);
        if (workspace.getSnapshot().library !== before) closeDialog();
      }} />}
      {dialog?.kind === 'confirm' && <ConfirmDialog title={dialog.title} confirmLabel={dialog.confirmLabel} onClose={closeDialog} onConfirm={() => { dialog.onConfirm(); closeDialog(); }}>{dialog.body}</ConfirmDialog>}
      {dialog?.kind === 'create-map' && <Modal title={dialog.source ? 'Create a linked world' : 'Create a map'} onClose={closeDialog}>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (disabled) return;
          const data = new FormData(event.currentTarget);
          const topic = data.get('topic');
          if (typeof topic !== 'string' || !topic.trim()) return;
          const before = workspace.getSnapshot().library;
          void workspace.createMap(topic.trim(), aiReady && data.get('generate') === 'on', dialog.source);
          if (workspace.getSnapshot().library !== before) closeDialog();
        }}>
          {state.error && <Notice tone="error">{state.error}</Notice>}
          <label className="field">Central word or phrase<input name="topic" autoFocus defaultValue={dialog.initialTopic} pattern=".*\S.*" required /></label>
          {aiReady ? <label className="check-label"><input type="checkbox" name="generate" defaultChecked />Generate initial branches with my AI provider</label> : <p className="help">Start locally. Configure an AI provider in Settings when you want to generate branches.</p>}
          <p className="help">The central node starts with editable description, instructions, detail and depth fields. All linked worlds are separate maps.</p>
          <div className="actions dialog-actions"><button type="button" onClick={closeDialog}>Cancel</button><button type="submit" className="primary" disabled={disabled}>Create map</button></div>
        </form>
      </Modal>}
      {dialog?.kind === 'memberships' && <Modal title="Organize in collections" onClose={closeDialog}>
        <p className="help">Select any number of flat collections. Removing membership never deletes the map.</p>
        <div className="membership-list">{library.collections.map((collection) => <label key={collection.id} className="check-label"><input type="checkbox" disabled={disabled} checked={collection.mapIds.includes(dialog.mapId)} onChange={(event) => workspace.setMembership(collection.id, dialog.mapId, event.target.checked)} />{collection.title || 'Untitled collection'}</label>)}</div>
        {library.collections.length === 0 && <p>Create a collection from the sidebar first.</p>}
        <div className="actions dialog-actions"><button type="button" className="primary" onClick={closeDialog}>Done</button></div>
      </Modal>}
    </div>
  );
}
