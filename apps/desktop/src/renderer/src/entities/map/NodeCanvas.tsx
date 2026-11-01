import type { MapDocument, MapLink } from '@temivo/core';
import { projectNodes } from './model';

export interface NodeCanvasProps {
  document: MapDocument;
  links: readonly MapLink[];
  selectedNodeId: string | null;
  expandedNodeIds: readonly string[];
  onSelect: (nodeId: string) => void;
  onToggle: (nodeId: string) => void;
  onOpenWorld: (nodeId: string) => void;
}

export function NodeCanvas({
  document,
  links,
  selectedNodeId,
  expandedNodeIds,
  onSelect,
  onToggle,
  onOpenWorld,
}: NodeCanvasProps) {
  const rows = projectNodes(document, expandedNodeIds);
  return (
    <section className="node-canvas" aria-label="Map nodes">
      <div className="canvas-caption"><span className="eyebrow">YOUR THINKING SPACE</span><span>Collapse to focus. Saved branches stay safe.</span></div>
      {rows.length === 0 ? <p className="canvas-empty">This world is a blank page. Add a root node to begin.</p> : (
        <ol className="node-tree">
          {rows.map(({ node, depth, childCount, expanded }) => {
            const metadata = document.nodeMetadata.find((item) => item.nodeId === node.id);
            const linked = links.some((link) => link.sourceMapId === document.map.id && link.sourceNodeId === node.id);
            return (
              <li key={node.id} style={{ marginInlineStart: `${Math.min(depth, 12) * 1.75}rem` }} className="node-row">
                <div className={`node-card ${depth === 0 ? 'root-node' : ''} ${selectedNodeId === node.id ? 'selected' : ''}`}>
                  <button type="button" className="node-content" aria-pressed={selectedNodeId === node.id} onClick={() => onSelect(node.id)}>
                    <span className="node-kind">
                      {depth === 0 ? 'ROOT' : `LEVEL ${depth}`}
                      {metadata?.provenance.kind === 'ai' ? (metadata.provenance.userEdited ? ' · AI + YOUR EDITS' : ' · AI') : ' · YOUR NODE'}
                    </span>
                    <strong>{node.text || 'Untitled node'}</strong>
                    {metadata?.description && <span className="node-description">{metadata.description}</span>}
                  </button>
                  <div className="node-tools">
                    {linked && <button type="button" className="world-link" onClick={() => onOpenWorld(node.id)} aria-label={`Open world linked from ${node.text || 'untitled node'}`}>Open world ↗</button>}
                    {childCount > 0 && <button type="button" className="branch-toggle" aria-expanded={expanded} onClick={() => onToggle(node.id)} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${childCount} branches of ${node.text || 'untitled node'}`}>{expanded ? '−' : '+'} {childCount}</button>}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
