import type { MapDocument, MapLibrary, NavigationPath } from '@temivo/core';
import { NodeCanvas } from '../../entities/map';
import { NodeEditor } from '../../features/node-editor';
import type { NodeEditorProps } from '../../features/node-editor';
import { WorldLink } from '../../features/world-link';
import type { WorldLinkProps } from '../../features/world-link';
import { GenerationReview } from '../../features/generation-review';
import type { GenerationReviewProps } from '../../features/generation-review';
import { EmptyState } from '../../shared/ui';

export interface WorldPageProps {
  library: MapLibrary;
  document: MapDocument;
  path: NavigationPath;
  selectedNodeId: string | null;
  expandedNodeIds: readonly string[];
  nodeEditor: NodeEditorProps | null;
  worldLink: WorldLinkProps | null;
  review: GenerationReviewProps | null;
  disabled: boolean;
  onSelect: (nodeId: string) => void;
  onToggle: (nodeId: string) => void;
  onOpenWorld: (nodeId: string) => void;
  onBreadcrumb: (index: number) => void;
  onBack: () => void;
  onLibrary: () => void;
  onAddRoot: () => void;
  onRename: () => void;
  onCollections: () => void;
}

export function WorldPage({
  library, document, path, selectedNodeId, expandedNodeIds, nodeEditor, worldLink, review, disabled,
  onSelect, onToggle, onOpenWorld, onBreadcrumb, onBack, onLibrary, onAddRoot, onRename, onCollections,
}: WorldPageProps) {
  return (
    <div className="world-page">
      <header className="world-header">
        <nav className="breadcrumbs" aria-label="Visited worlds">
          <button type="button" onClick={onLibrary}>All maps</button>
          {path.steps.map((step, index) => <span key={index}><span className="breadcrumb-divider" aria-hidden="true">/</span><button type="button" aria-current={index === path.steps.length - 1 ? 'page' : undefined} onClick={() => onBreadcrumb(index)}>{library.documents.find((item) => item.map.id === step.mapId)?.map.title || 'Untitled map'}</button></span>)}
        </nav>
        <div className="section-heading world-title"><div><p className="eyebrow">WORLD LEVEL {path.steps.length - 1}</p><h1>{document.map.title || 'Untitled map'}</h1></div><div className="actions"><button type="button" disabled={path.steps.length < 2} onClick={onBack}>← Back a world</button><button type="button" disabled={disabled} onClick={onRename}>Rename…</button><button type="button" disabled={disabled} onClick={onCollections}>Collections…</button><button type="button" className="primary" disabled={disabled} onClick={onAddRoot}>+ Root node</button></div></div>
      </header>
      <div className="world-layout">
        <div className="world-workspace">
          <NodeCanvas document={document} links={library.links} selectedNodeId={selectedNodeId} expandedNodeIds={expandedNodeIds} onSelect={onSelect} onToggle={onToggle} onOpenWorld={onOpenWorld} />
          {review && <GenerationReview {...review} />}
        </div>
        <aside className="inspector" aria-label="Selected node inspector">
          {nodeEditor ? <><NodeEditor {...nodeEditor} />{worldLink && <WorldLink key={selectedNodeId} {...worldLink} />}</> : <EmptyState title="Choose a thought"><p>Select a node to edit its text, context, depth or linked world.</p></EmptyState>}
        </aside>
      </div>
    </div>
  );
}
