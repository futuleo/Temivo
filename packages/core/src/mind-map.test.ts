import { describe, expect, it } from 'vitest';

import { assertMapLink, assertMindMap, InvalidMindMapError } from './index';

describe('mind map validation', () => {
  it('accepts empty maps and nodes in any order, including unfinished text', () => {
    expect(() => assertMindMap({ id: 'map', title: '', nodes: [] })).not.toThrow();
    expect(() =>
      assertMindMap({
        id: 'map',
        title: 'Topic',
        nodes: [
          { id: 'child', parentId: 'root', text: '' },
          { id: 'root', parentId: null, text: 'Topic' },
        ],
      }),
    ).not.toThrow();
  });

  it.each([
    null,
    {},
    { id: '', title: 'Topic', nodes: [] },
    { id: 'map', title: 'Topic', nodes: [null] },
    { id: 'map', title: 'Topic', nodes: [{ id: 'node', text: 'Missing parent field' }] },
    { id: 'map', title: 'Topic', nodes: [{ id: 'node', parentId: 'missing', text: '' }] },
    { id: 'map', title: 'Topic', nodes: [{ id: 'node', parentId: 'node', text: '' }] },
    {
      id: 'map',
      title: 'Topic',
      nodes: [
        { id: 'a', parentId: 'b', text: '' },
        { id: 'b', parentId: 'a', text: '' },
      ],
    },
    {
      id: 'map',
      title: 'Topic',
      nodes: [
        { id: 'node', parentId: null, text: '' },
        { id: 'node', parentId: null, text: '' },
      ],
    },
  ])('rejects invalid map structure: %j', (map) => {
    expect(() => assertMindMap(map)).toThrow(InvalidMindMapError);
  });

  it('validates independent-map links without depending on storage', () => {
    expect(() =>
      assertMapLink({ sourceMapId: 'a', sourceNodeId: 'node', targetMapId: 'b' }),
    ).not.toThrow();
    expect(() =>
      assertMapLink({ sourceMapId: 'a', sourceNodeId: 'node', targetMapId: 'a' }),
    ).toThrow(InvalidMindMapError);
    expect(() => assertMapLink({ sourceMapId: 'a', sourceNodeId: '', targetMapId: 'b' })).toThrow(
      InvalidMindMapError,
    );
  });
});
