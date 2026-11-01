import { useId } from 'react';
import type { MapDocument, MindMapNode } from '@temivo/core';
import { isDraftDirty, parentChoices } from '../../entities/map';
import type { NodeDraft, NodeFields } from '../../entities/map';
import { Notice } from '../../shared/ui';

export interface NodeEditorProps {
  document: MapDocument;
  node: MindMapNode;
  draft: NodeDraft;
  draftStale: boolean;
  disabled: boolean;
  generationBusy: boolean;
  aiReady: boolean;
  onChange: (fields: NodeFields) => void;
  onApply: () => void;
  onReset: () => void;
  onReparent: (parentId: string | null) => void;
  onAddChild: () => void;
  onDelete: () => void;
  onGenerate: (mode: 'refresh' | 'expand') => void;
  onSettings: () => void;
}

export function NodeEditor({
  document, node, draft, draftStale, disabled, generationBusy, aiReady,
  onChange, onApply, onReset, onReparent, onAddChild, onDelete, onGenerate, onSettings,
}: NodeEditorProps) {
  const id = useId();
  const dirty = isDraftDirty(draft);
  const update = <K extends keyof NodeFields>(key: K, value: NodeFields[K]) => onChange({ ...draft.fields, [key]: value });
  return (
    <section className="inspector-section" aria-labelledby={`${id}-heading`}>
      <header className="section-heading"><h2 id={`${id}-heading`}>Node details</h2><span className="badge">{dirty ? 'Draft' : 'Applied fields'}</span></header>
      {draftStale && <Notice tone="error">Saved content changed while you were editing. Your draft is intact. Review it, then explicitly apply your version or reset to saved content.</Notice>}
      <form onSubmit={(event) => { event.preventDefault(); onApply(); }}>
        <label className="field">Node text<textarea value={draft.fields.text} onChange={(event) => update('text', event.target.value)} rows={2} /></label>
        <label className="field">Description<textarea value={draft.fields.description} onChange={(event) => update('description', event.target.value)} rows={3} /></label>
        <label className="field">AI instructions<textarea value={draft.fields.instructions} onChange={(event) => update('instructions', event.target.value)} placeholder="Audience, perspective, questions to explore…" rows={3} /></label>
        <div className="field-pair">
          <label className="field">Detail<select value={draft.fields.detail} onChange={(event) => update('detail', event.target.value === 'detailed' ? 'detailed' : 'brief')}><option value="brief">Brief</option><option value="detailed">Detailed</option></select></label>
          <label className="field">Branch depth<input type="number" min="1" step="1" required value={draft.fields.depth} onChange={(event) => update('depth', event.target.value)} /></label>
        </div>
        <p className="help">Depth starts at this node. A smaller depth only folds saved branches; it never deletes them.</p>
        <div className="actions">
          <button type="submit" className="primary" disabled={disabled || !dirty}>{draftStale ? 'Apply my draft…' : 'Apply changes'}</button>
          <button type="button" disabled={!dirty && !draftStale} onClick={onReset}>Reset draft…</button>
        </div>
      </form>
      <div className="inspector-block">
        <h3>Explore with AI</h3>
        {!aiReady && <p className="help">AI is not configured. Editing and saving work without it. <button className="text-button" type="button" onClick={onSettings}>Open settings</button></p>}
        {dirty && <p className="help">Apply your draft before generating. Only unchanged AI content updates automatically; your edits become proposals.</p>}
        <div className="actions">
          <button type="button" disabled={disabled || generationBusy || dirty || !aiReady} onClick={() => onGenerate('refresh')}>{generationBusy ? 'Generating…' : 'Generate / refresh'}</button>
          <button type="button" disabled={disabled || generationBusy || dirty || !aiReady} onClick={() => onGenerate('expand')}>Expand missing</button>
        </div>
        <p className="help">Expand missing reuses saved branches and only asks for new content.</p>
      </div>
      <div className="inspector-block">
        <h3>Structure</h3>
        <label className="field">Parent node<select value={node.parentId ?? ''} disabled={disabled} onChange={(event) => onReparent(event.target.value || null)}>
          <option value="">No parent (root)</option>
          {parentChoices(document, node.id).map((parent) => <option key={parent.id} value={parent.id}>{parent.text || 'Untitled node'}</option>)}
        </select></label>
        <div className="actions">
          <button type="button" disabled={disabled} onClick={onAddChild}>+ Child node</button>
          <button type="button" className="danger-quiet" disabled={disabled} onClick={onDelete}>Delete subtree…</button>
        </div>
      </div>
    </section>
  );
}
