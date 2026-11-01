import type { MapLibrary } from '@temivo/core';

export function LibraryNav({
  library, collectionId, page, draftCount, disabled, onLibrary, onSettings, onCreateCollection,
}: {
  library: MapLibrary;
  collectionId: string | null;
  page: 'library' | 'world' | 'settings';
  draftCount: number;
  disabled: boolean;
  onLibrary: (collectionId: string | null) => void;
  onSettings: () => void;
  onCreateCollection: () => void;
}) {
  return (
    <aside className="sidebar">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <div className="brand"><span className="brand-mark" aria-hidden="true">t.</span><div><strong>temivo</strong><span>A little curiosity, connected.</span></div></div>
      <nav aria-label="Main navigation">
        <p className="nav-heading">WORKSPACE</p>
        <button type="button" className={`nav-item ${page === 'library' && collectionId === null ? 'active' : ''}`} aria-current={page === 'library' && collectionId === null ? 'page' : undefined} onClick={() => onLibrary(null)}><span>All maps</span><span className="nav-count">{library.documents.length}</span></button>
        <div className="nav-heading collection-heading"><span>COLLECTIONS</span><button type="button" className="icon-button" disabled={disabled} onClick={onCreateCollection} aria-label="Create collection">+</button></div>
        {library.collections.length === 0 && <p className="sidebar-hint">Group maps your way. Worlds can belong to more than one collection.</p>}
        {library.collections.map((collection) => <button key={collection.id} type="button" className={`nav-item ${page === 'library' && collectionId === collection.id ? 'active' : ''}`} aria-current={page === 'library' && collectionId === collection.id ? 'page' : undefined} onClick={() => onLibrary(collection.id)}><span>{collection.title || 'Untitled collection'}</span><span className="nav-count">{collection.mapIds.length}</span></button>)}
      </nav>
      <div className="sidebar-footer">
        {draftCount > 0 && <p className="sidebar-hint">{draftCount} node {draftCount === 1 ? 'draft' : 'drafts'} kept in this session. Apply drafts to save them.</p>}
        <button type="button" className={`nav-item ${page === 'settings' ? 'active' : ''}`} aria-current={page === 'settings' ? 'page' : undefined} onClick={onSettings}>Settings</button>
        <p className="sidebar-hint">Your maps are independent.<br />Links are just doorways.</p>
      </div>
    </aside>
  );
}
