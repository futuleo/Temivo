import { useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { MapDocument, MapLink, NodeMetadata } from '@temivo/core';
import { BRANCH_COLORS, layoutNodes, visibleAnchor } from './canvas-layout';
import type { CanvasNode } from './canvas-layout';
import { boardKeyboardAction, canvasViewReducer, createCanvasView, MAX_SCALE, minimumScale, zoomLabel } from './canvas-viewport';
import { createCanvasPan } from './canvas-interaction';

export interface NodeCanvasProps {
  document: MapDocument;
  links: readonly MapLink[];
  selectedNodeId: string | null;
  expandedNodeIds: readonly string[];
  onSelect: (nodeId: string) => void;
  onToggle: (nodeId: string) => void;
  onOpenWorld: (nodeId: string) => void;
}

export function NodeCanvas(props: NodeCanvasProps) {
  return <CanvasBoard key={props.document.map.id} {...props} />;
}

export function CanvasNodeCard({
  item, metadata, linked, selected, onSelect, onToggle, onOpenWorld, onFocusNode,
}: {
  item: CanvasNode;
  metadata: NodeMetadata | undefined;
  linked: boolean;
  selected: boolean;
  onSelect: NodeCanvasProps['onSelect'];
  onToggle: NodeCanvasProps['onToggle'];
  onOpenWorld: NodeCanvasProps['onOpenWorld'];
  onFocusNode: (nodeId: string) => void;
}) {
  const { node, depth, childCount, expanded, side, color, x, y, width, height } = item;
  const text = node.text || 'Untitled node';
  const style: CSSProperties & { '--branch-color': string } = {
    left: x, top: y, width, height, '--branch-color': BRANCH_COLORS[color] ?? BRANCH_COLORS[0],
  };
  return (
    <article data-canvas-node={node.id} style={style} onFocus={(event) => {
      if (event.target.matches(':focus-visible')) onFocusNode(node.id);
    }}
      className={`node-card node-${side} ${selected ? 'selected' : ''}`}>
      <button type="button" className="node-content" aria-pressed={selected} onClick={() => onSelect(node.id)} title={text}>
        <span className="node-kind"><span className="node-color-dot" aria-hidden="true" />
          {depth === 0 ? 'CENTRAL TOPIC' : `LEVEL ${depth}`}
          {metadata?.provenance.kind === 'ai' ? (metadata.provenance.userEdited ? ' / AI + YOUR EDITS' : ' / AI') : ' / YOUR NODE'}
        </span>
        <strong>{text}</strong>
        {metadata?.description && <span className="node-description">{metadata.description}</span>}
      </button>
      <div className="node-tools">
        {linked && <button type="button" className="world-link" onClick={() => onOpenWorld(node.id)} aria-label={`Open world linked from ${text}`}>Open world <span aria-hidden="true">↗</span></button>}
        {childCount > 0 && <button type="button" className="branch-toggle" aria-expanded={expanded} onClick={() => onToggle(node.id)} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${childCount} branches of ${text}`}><span aria-hidden="true">{expanded ? '−' : '+'}</span> {childCount}</button>}
      </div>
    </article>
  );
}

function CanvasBoard({
  document,
  links,
  selectedNodeId,
  expandedNodeIds,
  onSelect,
  onToggle,
  onOpenWorld,
}: NodeCanvasProps) {
  const boardRef = useRef<HTMLDivElement>(null);
  const helpId = useId();
  const layout = useMemo(() => layoutNodes(document, expandedNodeIds), [document, expandedNodeIds]);
  const anchorId = useMemo(() => visibleAnchor(document, layout, selectedNodeId), [document, layout, selectedNodeId]);
  const [view, dispatch] = useReducer(canvasViewReducer, { layout, anchorId }, ({ layout, anchorId }) => createCanvasView(layout, anchorId));
  const pan = useMemo(() => createCanvasPan(dispatch), [dispatch]);
  const metadata = new Map(document.nodeMetadata.map((item) => [item.nodeId, item]));
  const linkedNodes = new Set(links.filter((link) => link.sourceMapId === document.map.id).map((link) => link.sourceNodeId));

  useLayoutEffect(() => { dispatch({ type: 'sync', layout, anchorId }); }, [layout, anchorId]);
  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const measure = () => {
      const { width, height } = board.getBoundingClientRect();
      if (width > 0 && height > 0) dispatch({ type: 'resize', size: { width, height } });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(board);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rectangle = board.getBoundingClientRect();
      dispatch({ type: 'wheel', wheel: event, anchor: { x: event.clientX - rectangle.left, y: event.clientY - rectangle.top } });
    };
    board.addEventListener('wheel', wheel, { passive: false });
    return () => board.removeEventListener('wheel', wheel);
  }, []);
  useEffect(() => () => pan.dispose(), [pan]);
  useEffect(() => {
    if (!view.gesture) pan.release();
  }, [pan, view.gesture]);

  return (
    <section className="node-canvas" aria-label="Map nodes">
      <div ref={boardRef} tabIndex={0} role="region"
        aria-label={`Mind map canvas: ${document.map.title || 'Untitled map'}`} aria-describedby={helpId}
        className={`canvas-viewport ${view.gesture?.dragged ? 'is-panning' : ''}`}
        onKeyDown={(event) => {
          const action = boardKeyboardAction({ ...event, targetIsBoard: event.target === event.currentTarget });
          if (action) { event.preventDefault(); dispatch(action); }
        }}
        onPointerDown={(event) => {
          const isControl = event.target instanceof Element && !!event.target.closest('button, a, input, textarea, select, summary, [data-canvas-node], [data-canvas-controls]');
          pan.start({
            pointerId: event.pointerId, pointerType: event.pointerType, button: event.button, isControl,
            point: { x: event.clientX, y: event.clientY }, target: event.currentTarget,
            preventDefault: () => event.preventDefault(),
          });
        }}
        onPointerMove={(event) => {
          pan.move(event.pointerId, { x: event.clientX, y: event.clientY });
        }}
        onPointerUp={(event) => {
          pan.end(event.pointerId, { x: event.clientX, y: event.clientY });
        }}
        onPointerCancel={(event) => pan.cancel(event.pointerId)}
        onLostPointerCapture={(event) => pan.lost(event.pointerId)}>
        <div className="canvas-caption" data-canvas-controls>
          <div><span className="eyebrow">YOUR THINKING SPACE</span><span className="canvas-node-count">{layout.nodes.length} of {document.map.nodes.length} nodes visible</span></div>
          <span className="canvas-local-label">Collapse to focus. Saved branches stay safe.</span>
        </div>
        {layout.nodes.length === 0 && <div className="canvas-empty"><span className="canvas-empty-symbol" aria-hidden="true">+</span><h2>A little space for a big idea.</h2><p>This world is a blank page. Add a root node to begin.</p></div>}
        <div className="canvas-scene" style={{ transform: `translate(${view.viewport.x}px, ${view.viewport.y}px) scale(${view.viewport.scale})` }}>
          {layout.edges.length > 0 && <svg className="canvas-edges" aria-hidden="true" focusable="false"
            style={{ left: layout.bounds.x, top: layout.bounds.y }} width={layout.bounds.width} height={layout.bounds.height}
            viewBox={`${layout.bounds.x} ${layout.bounds.y} ${layout.bounds.width} ${layout.bounds.height}`}>
            {layout.edges.map((edge) => <path key={edge.targetId} data-edge-from={edge.sourceId} data-edge-to={edge.targetId} d={edge.path}
              stroke={BRANCH_COLORS[edge.color]} fill="none" strokeWidth={2} vectorEffect="non-scaling-stroke" />)}
          </svg>}
          {layout.nodes.map((item) => <CanvasNodeCard key={item.node.id} item={item} metadata={metadata.get(item.node.id)}
            linked={linkedNodes.has(item.node.id)} selected={selectedNodeId === item.node.id}
            onSelect={onSelect} onToggle={onToggle} onOpenWorld={onOpenWorld}
            onFocusNode={(nodeId) => dispatch({ type: 'reveal', nodeId })} />)}
        </div>
        <div className="canvas-toolbar" role="group" aria-label="Canvas view controls" data-canvas-controls>
          <button type="button" aria-label="Zoom out" title="Zoom out" disabled={view.viewport.scale <= minimumScale(layout, view.size)} onClick={() => dispatch({ type: 'zoom', factor: 1 / 1.2 })}>−</button>
          <output aria-label="Canvas zoom">{zoomLabel(view.viewport.scale)}</output>
          <button type="button" aria-label="Zoom in" title="Zoom in" disabled={view.viewport.scale >= MAX_SCALE} onClick={() => dispatch({ type: 'zoom', factor: 1.2 })}>+</button>
          <span className="toolbar-divider" aria-hidden="true" />
          <button type="button" onClick={() => dispatch({ type: 'fit' })}>Fit map</button>
          <button type="button" disabled={selectedNodeId === null || !layout.byId.has(selectedNodeId)} onClick={() => {
            if (selectedNodeId !== null) dispatch({ type: 'reveal', nodeId: selectedNodeId });
          }}>Focus selected</button>
        </div>
        <details className="canvas-help" data-canvas-controls>
          <summary aria-label="Canvas controls help">? <span>Controls</span></summary>
          <p id={helpId}>Drag the empty board with a mouse or pen to pan. Scroll to pan; Ctrl/Cmd + scroll to zoom at the pointer. When the board is focused: arrows pan, +/- zoom, F fits, Esc cancels a pan. Select a thought, then open Node details. Touch pinch and node dragging are not supported.</p>
        </details>
      </div>
    </section>
  );
}
