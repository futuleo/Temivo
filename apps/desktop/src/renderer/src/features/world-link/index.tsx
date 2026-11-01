import { useState } from 'react';
import type { MapDocument, MapLink } from '@temivo/core';

export interface WorldLinkProps {
  documents: readonly MapDocument[];
  link: MapLink | undefined;
  disabled: boolean;
  onLink: (mapId: string) => void;
  onCreate: () => void;
  onOpen: () => void;
  onDetach: () => void;
}

export function WorldLink({ documents, link, disabled, onLink, onCreate, onOpen, onDetach }: WorldLinkProps) {
  const [targetId, setTargetId] = useState('');
  const target = documents.find((document) => document.map.id === link?.targetMapId);
  return (
    <section className="inspector-section">
      <h2>Linked world</h2>
      <p className="help">A doorway to an independent map, not a nested file. Detaching never deletes the other world.</p>
      {target ? <>
        <div className="linked-target"><span className="world-symbol" aria-hidden="true">↗</span><strong>{target.map.title || 'Untitled map'}</strong></div>
        <div className="actions"><button type="button" onClick={onOpen}>Enter world ↗</button><button type="button" disabled={disabled} onClick={onDetach}>Detach…</button></div>
      </> : <>
        <button type="button" className="full-width" disabled={disabled} onClick={onCreate}>+ Create a world from this node</button>
        <form className="link-form" onSubmit={(event) => { event.preventDefault(); if (targetId) onLink(targetId); }}>
          <label className="field">Or link an existing map<select value={targetId} disabled={disabled} required onChange={(event) => setTargetId(event.target.value)}>
            <option value="">Choose a map</option>
            {documents.map((document) => <option key={document.map.id} value={document.map.id}>{document.map.title || 'Untitled map'}</option>)}
          </select></label>
          <button type="submit" disabled={disabled || !targetId}>Link world</button>
        </form>
      </>}
    </section>
  );
}
