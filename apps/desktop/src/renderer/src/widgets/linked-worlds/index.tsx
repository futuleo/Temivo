import { projectLinkedWorlds } from '@temivo/core';
import type { MapLibrary } from '@temivo/core';

export function LinkedWorlds({
  library, rootMapId, expandedMapIds, onToggle, onOpen,
}: {
  library: MapLibrary;
  rootMapId: string;
  expandedMapIds: readonly string[];
  onToggle: (mapId: string) => void;
  onOpen: (rootMapId: string, viaNodeIds: readonly string[]) => void;
}) {
  const liveIds = new Set(library.documents.map((document) => document.map.id));
  const rows = projectLinkedWorlds(library, rootMapId, expandedMapIds.filter((id) => liveIds.has(id)));
  return (
    <ol className="world-overview" aria-label="Linked worlds overview">
      {rows.map((row, index) => {
        const path: string[] = [];
        let current = rows[index];
        while (current?.via) {
          path.unshift(current.via.sourceNodeId);
          current = current.parentRow === null ? undefined : rows[current.parentRow];
        }
        const hasLinks = library.links.some((link) => link.sourceMapId === row.mapId);
        const source = row.via ? library.documents.find((document) => document.map.id === row.via?.sourceMapId)?.map.nodes.find((node) => node.id === row.via?.sourceNodeId)?.text : null;
        return (
          <li key={index} style={{ marginInlineStart: `${Math.min(row.depth, 10)}rem` }}>
            {row.kind === 'map' && hasLinks ? <button className="icon-button" type="button" onClick={() => onToggle(row.mapId)} aria-expanded={row.expanded} aria-label={`${row.expanded ? 'Collapse' : 'Expand'} linked worlds of ${row.title}`}>{row.expanded ? '−' : '+'}</button> : <span className="reference-mark" aria-hidden="true">↗</span>}
            <button type="button" className="overview-link" onClick={() => onOpen(rootMapId, path)}>{row.title || 'Untitled map'}</button>
            {source && <span className="help">via {source}</span>}
            {row.kind !== 'map' && <span className="badge">{row.kind === 'cycle-reference' ? 'Cycle reference' : 'Shared world'}</span>}
          </li>
        );
      })}
    </ol>
  );
}
