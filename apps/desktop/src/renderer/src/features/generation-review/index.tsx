import type { GenerationConflictReason, MapDocument, PendingGenerationConflicts } from '@temivo/core';
import { Notice } from '../../shared/ui';

const reasons: Record<GenerationConflictReason, string> = {
  'manual-or-edited': 'You created or edited this node',
  'different-generation': 'Created from a different generation scope',
  'linked-world': 'This node opens an independent world',
  'protected-descendants': 'This change affects protected descendants',
  'depends-on-conflict': 'Depends on another proposed change',
};

export interface GenerationReviewProps {
  document: MapDocument;
  pending: PendingGenerationConflicts;
  selectedIds: readonly string[];
  disabled: boolean;
  stale: boolean;
  onToggle: (nodeId: string) => void;
  onAccept: () => void;
  onReject: () => void;
}

export function GenerationReview({ document, pending, selectedIds, disabled, stale, onToggle, onAccept, onReject }: GenerationReviewProps) {
  return (
    <section className="proposal-panel" aria-label="AI change proposals">
      <header className="section-heading"><div><span className="eyebrow">YOU DECIDE</span><h2>Review AI proposals</h2></div><span className="badge">{pending.conflicts.length}</span></header>
      <p>These changes are not applied. Compare with your saved content and select only what you want to replace. Unselected proposals are discarded after approval.</p>
      {stale && <Notice tone="error">Content has changed since these proposals were created. Discard them and generate again; your work has not been overwritten.</Notice>}
      <div className="proposal-list">
        {pending.conflicts.map((conflict) => {
          const current = document.map.nodes.find((node) => node.id === conflict.nodeId);
          const metadata = document.nodeMetadata.find((entry) => entry.nodeId === conflict.nodeId);
          const change = pending.changes.find((entry) => entry.nodeId === conflict.nodeId);
          const proposedParent = change?.kind === 'upsert' ? pending.changes.find((entry) => entry.nodeId === change.parentId) : undefined;
          const parentTitle = change?.kind === 'upsert' && change.parentId !== null
            ? (proposedParent?.kind === 'upsert' ? proposedParent.text : document.map.nodes.find((node) => node.id === change.parentId)?.text) || 'Untitled node'
            : 'Root';
          return (
            <article key={conflict.nodeId} className="proposal">
              <label className="check-label"><input type="checkbox" checked={selectedIds.includes(conflict.nodeId)} disabled={disabled || stale} onChange={() => onToggle(conflict.nodeId)} /><strong>{current?.text || (change?.kind === 'upsert' ? change.text : 'Node removal')}</strong></label>
              <p className="help">{reasons[conflict.reason]}</p>
              <div className="comparison">
                <div><span className="eyebrow">CURRENT</span><p>{current?.text || 'Not yet created'}</p>{metadata?.description && <p>{metadata.description}</p>}<small>Parent: {document.map.nodes.find((node) => node.id === current?.parentId)?.text || 'Root'}</small></div>
                <div><span className="eyebrow">PROPOSED</span>{change?.kind === 'upsert' ? <><p>{change.text || 'Untitled node'}</p><p>{change.description}</p><small>Parent: {parentTitle}</small></> : <p>Remove this node. Surviving children are kept; linked worlds stay independent.</p>}</div>
              </div>
            </article>
          );
        })}
      </div>
      <div className="actions"><button type="button" className="primary" disabled={disabled || stale || selectedIds.length === 0} onClick={onAccept}>Apply {selectedIds.length} selected…</button><button type="button" disabled={disabled} onClick={onReject}>Keep my content / dismiss</button></div>
    </section>
  );
}
