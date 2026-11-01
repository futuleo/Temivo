import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  addCollectionMember,
  addMap,
  addNode,
  assertGenerationContext,
  assertMapDocument,
  assertMapLibrary,
  createCollection,
  createMapDocument,
  createMapLibrary,
  createTopicMap,
  editNode,
  InvalidMindMapError,
  linkMaps,
  removeCollection,
  removeCollectionMember,
  removeMap,
  removeNode,
  renameCollection,
  renameMap,
  reparentNode,
  unlinkMap,
} from './index';
import type { MapDocument, MapLibrary, MindMap } from './index';

function frozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value);
    for (const child of Object.values(value)) frozen(child);
  }
  return value;
}

function library(): MapLibrary {
  return createMapLibrary([
    createMapDocument({
      id: 'a', title: '', nodes: [
        { id: 'root', parentId: null, text: '' },
        { id: 'child', parentId: 'root', text: 'Child' },
        { id: 'leaf', parentId: 'child', text: '' },
        { id: 'other', parentId: null, text: 'Another root' },
      ],
    }),
    createTopicMap('b', 'root', 'Independent B'),
    createTopicMap('c', 'root', 'Independent C'),
  ]);
}

describe('immutable map documents and editor operations', () => {
  it('keeps rich documents distinct from storage DTOs and preserves empty maps and forests', () => {
    expectTypeOf<MapDocument>().not.toExtend<MindMap>();
    const empty = createMapDocument({ id: 'empty', title: '', nodes: [] });
    expect(() => assertMapDocument(empty)).not.toThrow();
    const maps = library();
    expect(maps.documents[0]?.map.nodes.filter((node) => node.parentId === null)).toHaveLength(2);
    expect(maps.documents[0]?.nodeMetadata.every((metadata) => metadata.provenance.kind === 'user'))
      .toBe(true);
    expect(createTopicMap('topic', 'center', '').map).toEqual({
      id: 'topic', title: '', nodes: [{ id: 'center', parentId: null, text: '' }],
    });
  });

  it('creates nodes with injected identities and edits text, description and context immutably', () => {
    const original = frozen(library());
    const context = frozen({ instructions: 'Explain for a beginner', detail: 'detailed' as const, depth: 3 });
    const node = frozen({ id: 'new', parentId: 'root', text: '', description: 'Notes', context });
    const added = addNode(original, 'a', node);
    const edited = editNode(added, 'a', 'new', {
      text: 'New text', description: '', context: { instructions: '', detail: 'brief', depth: 1 },
    });
    const renamed = renameMap(edited, 'a', '');
    expect(original.documents[0]?.map.nodes).toHaveLength(4);
    expect(added.documents[0]?.map.nodes.find((current) => current.id === 'new')?.text).toBe('');
    expect(edited.documents[0]?.nodeMetadata.find((metadata) => metadata.nodeId === 'new')).toEqual({
      nodeId: 'new', revision: 1, description: '',
      context: { instructions: '', detail: 'brief', depth: 1 }, provenance: { kind: 'user' },
    });
    expect(renamed.documents[0]?.revision).toBe(3);
    expect(renamed.documents[1]).toBe(original.documents[1]);
  });

  it('allows node IDs shared across maps but rejects duplicates, missing parents and cycles', () => {
    const original = frozen(library());
    expect(() => addNode(original, 'a', { id: 'root', parentId: null, text: '' }))
      .toThrow(InvalidMindMapError);
    expect(() => addNode(original, 'a', { id: 'new', parentId: 'missing', text: '' }))
      .toThrow(InvalidMindMapError);
    expect(() => reparentNode(original, 'a', 'root', 'leaf')).toThrow(InvalidMindMapError);
    expect(() => reparentNode(original, 'a', 'root', 'root')).toThrow(InvalidMindMapError);
    expect(() => reparentNode(original, 'a', 'child', 'missing')).toThrow(InvalidMindMapError);
    const moved = reparentNode(original, 'a', 'child', null);
    expect(moved.documents[0]?.map.nodes.find((node) => node.id === 'child')?.parentId).toBeNull();
    expect(original.documents[0]?.map.nodes.find((node) => node.id === 'child')?.parentId).toBe('root');
  });

  it('explicitly deletes a subtree, retires identities and never deletes linked maps', () => {
    const linked = frozen(linkMaps(library(), {
      sourceMapId: 'a', sourceNodeId: 'leaf', targetMapId: 'b',
    }));
    const removed = removeNode(linked, 'a', 'child');
    expect(removed.documents[0]?.map.nodes.map((node) => node.id)).toEqual(['root', 'other']);
    expect(removed.documents[0]?.retiredNodeIds).toEqual(['child', 'leaf']);
    expect(removed.links).toEqual([]);
    expect(removed.documents[1]).toBe(linked.documents[1]);
    expect(() => addNode(removed, 'a', { id: 'leaf', parentId: null, text: '' }))
      .toThrow(InvalidMindMapError);
    expect(linked.links).toHaveLength(1);
  });

  it('reports invalid edits and missing references instead of returning success-shaped defaults', () => {
    const maps = frozen(library());
    expect(() => editNode(maps, 'missing', 'root', { text: '' })).toThrow(InvalidMindMapError);
    expect(() => editNode(maps, 'a', 'missing', { text: '' })).toThrow(InvalidMindMapError);
    expect(() => editNode(maps, 'a', 'root', {})).toThrow(InvalidMindMapError);
    expect(() => editNode(maps, 'a', 'root', { text: undefined })).toThrow(InvalidMindMapError);
    expect(() => editNode(maps, 'a', 'root', { description: undefined })).toThrow(InvalidMindMapError);
    expect(() => editNode(maps, 'a', 'root', { context: undefined })).toThrow(InvalidMindMapError);
    expect(() => removeNode(maps, 'a', 'missing')).toThrow(InvalidMindMapError);
    expect(() => renameMap(maps, 'missing', '')).toThrow(InvalidMindMapError);
    expect(() => addMap(maps, createTopicMap('a', 'x', ''))).toThrow(InvalidMindMapError);
    expect(() => createTopicMap(' ', 'x', '')).toThrow(InvalidMindMapError);
  });
});

describe('independent linked-map lifecycles', () => {
  it('replaces only the one outgoing link and allows cross-map cycles and shared targets', () => {
    const original = frozen(library());
    let maps = linkMaps(original, { sourceMapId: 'a', sourceNodeId: 'root', targetMapId: 'b' });
    maps = linkMaps(maps, { sourceMapId: 'a', sourceNodeId: 'root', targetMapId: 'c' });
    maps = linkMaps(maps, { sourceMapId: 'a', sourceNodeId: 'child', targetMapId: 'c' });
    maps = linkMaps(maps, { sourceMapId: 'c', sourceNodeId: 'root', targetMapId: 'a' });
    expect(maps.links).toHaveLength(3);
    expect(maps.links[0]?.targetMapId).toBe('c');
    expect(maps.documents).toHaveLength(3);
    expect(original.links).toEqual([]);
    const detached = unlinkMap(frozen(maps), 'a', 'root');
    expect(detached.links).toHaveLength(2);
    expect(detached.documents).toHaveLength(3);
    expect(unlinkMap(detached, 'b', 'root')).toEqual(detached);
  });

  it('source-map deletion leaves targets; target deletion only cleans references and memberships', () => {
    let maps = linkMaps(library(), { sourceMapId: 'a', sourceNodeId: 'root', targetMapId: 'b' });
    maps = linkMaps(maps, { sourceMapId: 'c', sourceNodeId: 'root', targetMapId: 'b' });
    maps = addCollectionMember(createCollection(maps, 'group', 'Group'), 'group', 'b');
    const original = frozen(maps);
    const sourceRemoved = removeMap(original, 'a');
    expect(sourceRemoved.documents.map((document) => document.map.id)).toEqual(['b', 'c']);
    expect(sourceRemoved.links).toHaveLength(1);
    const targetRemoved = removeMap(original, 'b');
    expect(targetRemoved.documents.map((document) => document.map.id)).toEqual(['a', 'c']);
    expect(targetRemoved.documents[0]?.map).toEqual(original.documents[0]?.map);
    expect(targetRemoved.links).toEqual([]);
    expect(targetRemoved.collections[0]?.mapIds).toEqual([]);
    expect(targetRemoved.retiredMapIds).toEqual(['b']);
    expect(() => addMap(targetRemoved, createTopicMap('b', 'root', 'Reused')))
      .toThrow(InvalidMindMapError);
    expect(original.links).toHaveLength(2);
  });

  it('rejects invalid endpoints and same-map self-links', () => {
    const maps = frozen(library());
    for (const link of [
      { sourceMapId: 'a', sourceNodeId: 'root', targetMapId: 'a' },
      { sourceMapId: 'a', sourceNodeId: 'missing', targetMapId: 'b' },
      { sourceMapId: 'a', sourceNodeId: 'root', targetMapId: 'missing' },
      { sourceMapId: 'missing', sourceNodeId: 'root', targetMapId: 'b' },
    ]) expect(() => linkMaps(maps, link)).toThrow(InvalidMindMapError);
    expect(() => unlinkMap(maps, 'a', 'missing')).toThrow(InvalidMindMapError);
    expect(() => removeMap(maps, 'missing')).toThrow(InvalidMindMapError);
  });
});

describe('flat collections', () => {
  it('groups references many-to-many without changing maps, links or map lifecycles', () => {
    const original = frozen(library());
    let maps = createCollection(original, 'one', '');
    maps = createCollection(maps, 'two', 'Second');
    maps = addCollectionMember(maps, 'one', 'a');
    maps = addCollectionMember(maps, 'one', 'b');
    maps = addCollectionMember(maps, 'two', 'a');
    maps = addCollectionMember(maps, 'one', 'a');
    expect(maps.collections.map((collection) => collection.mapIds)).toEqual([['a', 'b'], ['a']]);
    const renamed = renameCollection(frozen(maps), 'one', 'Renamed');
    const ungrouped = removeCollectionMember(renamed, 'one', 'a');
    const removed = removeCollection(ungrouped, 'two');
    expect(removed.collections).toEqual([{ id: 'one', title: 'Renamed', mapIds: ['b'] }]);
    expect(removed.documents).toBe(original.documents);
    expect(removed.links).toBe(original.links);
    expect(original.collections).toEqual([]);
  });

  it('validates group and map identities and does not create dangling memberships', () => {
    const maps = frozen(createCollection(library(), 'group', ''));
    expect(() => createCollection(maps, 'group', '')).toThrow(InvalidMindMapError);
    expect(() => createCollection(maps, '', '')).toThrow(InvalidMindMapError);
    expect(() => addCollectionMember(maps, 'group', 'missing')).toThrow(InvalidMindMapError);
    expect(() => addCollectionMember(maps, 'missing', 'a')).toThrow(InvalidMindMapError);
    expect(() => removeCollectionMember(maps, 'group', 'missing')).toThrow(InvalidMindMapError);
    expect(() => renameCollection(maps, 'missing', '')).toThrow(InvalidMindMapError);
    expect(() => removeCollection(maps, 'missing')).toThrow(InvalidMindMapError);
  });
});

describe('rich snapshot validation', () => {
  it.each([
    null, {}, { instructions: '', detail: 'unlimited' }, { instructions: 2, detail: 'brief' },
  ])('rejects malformed generation context: %j', (context) => {
    expect(() => assertGenerationContext(context)).toThrow(InvalidMindMapError);
  });

  it('rejects incomplete metadata, invalid revisions and malformed baselines', () => {
    const document = createTopicMap('map', 'root', '');
    const metadata = document.nodeMetadata[0];
    expect(() => assertMapDocument({ ...document, nodeMetadata: [] })).toThrow(InvalidMindMapError);
    expect(() => assertMapDocument({ ...document, nodeMetadata: [metadata, metadata] }))
      .toThrow(InvalidMindMapError);
    expect(() => assertMapDocument({ ...document, retiredNodeIds: ['root'] }))
      .toThrow(InvalidMindMapError);
    for (const revision of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => assertMapDocument({ ...document, revision })).toThrow(InvalidMindMapError);
    }
    expect(() => assertMapDocument({
      ...document,
      nodeMetadata: [{
        ...metadata,
        provenance: {
          kind: 'ai', anchorNodeId: 'root', baselineRevision: 10, userEdited: false,
          baseline: { parentId: null, text: '', description: '' },
        },
      }],
    })).toThrow(InvalidMindMapError);
    expect(() => assertMapDocument({ ...document, activeGeneration: {} })).toThrow(InvalidMindMapError);
  });

  it('rejects duplicate maps, outgoing links and collections or dangling references', () => {
    const maps = library();
    const link = { sourceMapId: 'a', sourceNodeId: 'root', targetMapId: 'b' };
    for (const invalid of [
      { ...maps, documents: [...maps.documents, maps.documents[0]] },
      { ...maps, links: [link, link] },
      { ...maps, links: [{ ...link, targetMapId: 'missing' }] },
      { ...maps, collections: [{ id: 'g', title: '', mapIds: ['missing'] }] },
      { ...maps, collections: [{ id: 'g', title: '', mapIds: ['a', 'a'] }] },
      { ...maps, retiredMapIds: ['a'] },
    ]) expect(() => assertMapLibrary(invalid)).toThrow(InvalidMindMapError);
  });
});
