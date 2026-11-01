import { describe, expect, it } from 'vitest';
import { createMapDocument } from '@temivo/core';
import { createNodeDraft, draftEdit, isDraftDirty, parentChoices, projectNodes, visibleDepth } from './model';

const document = createMapDocument({
  id: 'map', title: 'Topic',
  nodes: [
    { id: 'root', parentId: null, text: 'Topic' },
    { id: 'child', parentId: 'root', text: 'Branch' },
    { id: 'deep', parentId: 'child', text: 'Saved detail' },
    { id: 'other', parentId: null, text: 'Other root' },
  ],
});

describe('node editor presentation state', () => {
  it('keeps form text as a draft and validates relative depth without imposing a cap', () => {
    const draft = createNodeDraft(document, 'root');
    expect(draft.fields.depth).toBe('1');
    expect(isDraftDirty(draft)).toBe(false);
    const edited = { ...draft, fields: { ...draft.fields, text: 'My topic', depth: '100' } };
    expect(isDraftDirty(edited)).toBe(true);
    expect(draftEdit(edited)).toMatchObject({ text: 'My topic', context: { depth: 100 } });
    for (const depth of ['', '0', '-1', '1.5', 'not a number', '9007199254740992']) {
      expect(() => draftEdit({ ...draft, fields: { ...draft.fields, depth } })).toThrow('whole number');
    }
    expect(document.map.nodes[0]?.text).toBe('Topic');
  });

  it('collapses descendants without deleting saved content and reuses them on expansion', () => {
    const deep = visibleDepth(document, [], 'root', 2);
    expect(projectNodes(document, deep).map((row) => row.node.id)).toEqual(['root', 'child', 'deep', 'other']);
    const shallow = visibleDepth(document, deep, 'root', 1);
    expect(projectNodes(document, shallow).map((row) => row.node.id)).toEqual(['root', 'child', 'other']);
    const expanded = visibleDepth(document, shallow, 'child', 1);
    expect(projectNodes(document, expanded).map((row) => row.node.id)).toEqual(['root', 'child', 'deep', 'other']);
    expect(document.map.nodes).toHaveLength(4);
  });

  it('excludes the selected node and its whole subtree from parent choices', () => {
    expect(parentChoices(document, 'child').map((node) => node.id)).toEqual(['root', 'other']);
    expect(parentChoices(document, 'root').map((node) => node.id)).toEqual(['other']);
  });
});
