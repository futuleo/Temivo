import type { MapLibrary } from '@temivo/core';
import { EmptyState } from '../../shared/ui';
import { LinkedWorlds } from '../../widgets/linked-worlds';

export interface LibraryPageProps {
  library: MapLibrary;
  collectionId: string | null;
  query: string;
  expandedMapIds: readonly string[];
  disabled: boolean;
  onQuery: (query: string) => void;
  onCreateMap: () => void;
  onRenameMap: (mapId: string) => void;
  onDeleteMap: (mapId: string) => void;
  onOrganizeMap: (mapId: string) => void;
  onRenameCollection: (collectionId: string) => void;
  onDeleteCollection: (collectionId: string) => void;
  onToggleWorld: (mapId: string) => void;
  onOpenWorld: (rootMapId: string, viaNodeIds: readonly string[]) => void;
}

export function LibraryPage({
  library, collectionId, query, expandedMapIds, disabled, onQuery, onCreateMap,
  onRenameMap, onDeleteMap, onOrganizeMap, onRenameCollection, onDeleteCollection, onToggleWorld, onOpenWorld,
}: LibraryPageProps) {
  const collection = library.collections.find((item) => item.id === collectionId);
  const maps = library.documents.filter((document) =>
    (!collection || collection.mapIds.includes(document.map.id)) &&
    document.map.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <section className="library-page">
      <header className="page-heading">
        <div><p className="eyebrow">MAKE ROOM FOR AN IDEA</p><h1>{collection?.title || (collection ? 'Untitled collection' : 'All maps')}</h1><p className="page-description">{collection ? 'A collection of independent worlds. Removing a map from here keeps it in All Maps.' : 'A home for every world you create, wherever your curiosity takes you.'}</p></div>
        <button type="button" className="primary" disabled={disabled} onClick={onCreateMap}>+ New map</button>
      </header>
      <div className="library-toolbar">
        <label className="search-field"><span className="sr-only">Search maps by title</span><input type="search" value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Find a world…" /></label>
        <span className="help">{maps.length} {maps.length === 1 ? 'map' : 'maps'}</span>
        {collection && <div className="actions"><button type="button" disabled={disabled} onClick={() => onRenameCollection(collection.id)}>Rename collection…</button><button type="button" className="danger-quiet" disabled={disabled} onClick={() => onDeleteCollection(collection.id)}>Delete collection…</button></div>}
      </div>
      {maps.length === 0 ? <EmptyState title={query ? 'No matching worlds' : collection ? 'Make this collection yours' : 'Start with a word. See where it leads.'}><p>{query ? 'Try a different title.' : 'Create a map around a topic or phrase. Add your own thoughts first, or explore with AI when configured.'}</p>{!query && <button type="button" className="primary" disabled={disabled} onClick={onCreateMap}>Create your first map</button>}</EmptyState> : (
        <div className="map-grid">
          {maps.map((document) => {
            const map = document.map;
            const root = map.nodes.find((node) => node.parentId === null);
            const description = document.nodeMetadata.find((entry) => entry.nodeId === root?.id)?.description;
            const links = library.links.filter((link) => link.sourceMapId === map.id);
            const memberships = library.collections.filter((item) => item.mapIds.includes(map.id));
            return (
              <article key={map.id} className="map-card">
                <div className="map-card-top"><span className="map-glyph" aria-hidden="true">✳</span><span className="help">{map.nodes.length} nodes · {links.length} doorways</span></div>
                <button type="button" className="map-title" onClick={() => onOpenWorld(map.id, [])}><h2>{map.title || 'Untitled map'}</h2></button>
                <p className="map-summary">{description || root?.text || 'An open space for your next idea.'}</p>
                {memberships.length > 0 && <div className="tags">{memberships.map((item) => <span className="badge" key={item.id}>{item.title || 'Untitled collection'}</span>)}</div>}
                <div className="actions card-actions"><button type="button" disabled={disabled} onClick={() => onRenameMap(map.id)}>Rename…</button><button type="button" disabled={disabled} onClick={() => onOrganizeMap(map.id)}>Collections…</button><button type="button" className="danger-quiet" disabled={disabled} onClick={() => onDeleteMap(map.id)} aria-label={`Delete ${map.title || 'untitled map'}`}>Delete…</button></div>
                {links.length > 0 && <div className="card-overview"><LinkedWorlds library={library} rootMapId={map.id} expandedMapIds={expandedMapIds} onToggle={onToggleWorld} onOpen={onOpenWorld} /></div>}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
