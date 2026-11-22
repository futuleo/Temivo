import { Children, createElement, isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createMapDocument } from '@temivo/core';
import { CanvasNodeCard, NodeCanvas } from './NodeCanvas';
import { CARD_SIZE, layoutNodes } from './canvas-layout';

interface TestElementProps {
  children?: ReactNode;
  className?: string;
  onClick?: () => void;
  onFocus?: (event: { target: { matches: (selector: string) => boolean } }) => void;
  'aria-pressed'?: boolean;
  'aria-expanded'?: boolean;
}

function buttons(element: ReactNode): ReactElement<TestElementProps>[] {
  if (!isValidElement<TestElementProps>(element)) return [];
  return [
    ...(element.type === 'button' ? [element] : []),
    ...Children.toArray(element.props.children).flatMap(buttons),
  ];
}

const document = createMapDocument({ id: 'one', title: 'Real world', nodes: [
  { id: 'root', parentId: null, text: 'Central topic' },
  { id: 'left', parentId: 'root', text: 'Another thought' },
  { id: 'right', parentId: 'root', text: 'A thought' },
  { id: 'deep', parentId: 'left', text: 'Saved detail' },
] });

describe('actual canvas and card presentation without a DOM/application', () => {
  it('renders a spatial scene of HTML nodes and curved SVG edges, not the former list', () => {
    const html = renderToStaticMarkup(createElement(NodeCanvas, {
      document, links: [], selectedNodeId: 'root', expandedNodeIds: ['root', 'left'],
      onSelect: vi.fn(), onToggle: vi.fn(), onOpenWorld: vi.fn(),
    }));
    expect(html.match(/data-canvas-node=/g)).toHaveLength(4);
    expect(html.match(/data-edge-to=/g)).toHaveLength(3);
    expect(html).toContain('<svg');
    expect(html).toContain('node-left');
    expect(html).toContain('node-right');
    expect(html).toContain('node-root');
    expect(html).toContain(' C ');
    expect(html).toContain('left:-140px;top:-97px;width:280px;height:194px');
    expect(html).not.toContain('node-tree');
    expect(html).not.toContain('<ol');
    expect(html).toContain('aria-label="Canvas view controls"');
    expect(html).toContain('aria-label="Canvas zoom"');
    expect(html).toContain('Fit map');
    expect(html).toContain('Focus selected');
    expect(html).toContain('arrows pan');
    expect(html).toContain('Touch pinch and node dragging are not supported');
  });

  it('keeps saved descendants hidden until expansion while rendering their actual toggle/link callbacks', () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    const onOpenWorld = vi.fn();
    const onFocusNode = vi.fn();
    const item = layoutNodes(document, ['root']).byId.get('left')!;
    const card = CanvasNodeCard({
      item, metadata: document.nodeMetadata.find((entry) => entry.nodeId === 'left'), selected: true, linked: true,
      onSelect, onToggle, onOpenWorld, onFocusNode,
    });
    const controls = buttons(card);
    const select = controls.find((element) => element.props.className === 'node-content')!;
    const toggle = controls.find((element) => element.props.className === 'branch-toggle')!;
    const open = controls.find((element) => element.props.className === 'world-link')!;
    expect(select.props['aria-pressed']).toBe(true);
    expect(toggle.props['aria-expanded']).toBe(false);
    select.props.onClick?.();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('left');
    expect(onToggle).not.toHaveBeenCalled();
    expect(onOpenWorld).not.toHaveBeenCalled();
    toggle.props.onClick?.();
    open.props.onClick?.();
    expect(onToggle).toHaveBeenCalledExactlyOnceWith('left');
    expect(onOpenWorld).toHaveBeenCalledExactlyOnceWith('left');
    expect(isValidElement<TestElementProps>(card)).toBe(true);
    if (isValidElement<TestElementProps>(card)) {
      card.props.onFocus?.({ target: { matches: () => false } });
      expect(onFocusNode).not.toHaveBeenCalled();
      card.props.onFocus?.({ target: { matches: (selector) => selector === ':focus-visible' } });
    }
    expect(onFocusNode).toHaveBeenCalledExactlyOnceWith('left');
    const html = renderToStaticMarkup(createElement(NodeCanvas, {
      document, links: [{ sourceMapId: 'one', sourceNodeId: 'left', targetMapId: 'independent' }],
      selectedNodeId: 'left', expandedNodeIds: ['root'], onSelect, onToggle, onOpenWorld,
    }));
    expect(html).not.toContain('data-canvas-node="deep"');
    expect(html).toContain('Expand 1 branches of Another thought');
    expect(html).toContain('Open world linked from Another thought');
  });

  it('escapes arbitrary IDs, full text, titles and descriptions inside fixed card bounds', () => {
    const id = 'constructor" <unsafe>';
    const text = '<script>unsafe()</script>'.repeat(200);
    const original = createMapDocument({ id, title: '<b>Map</b>', nodes: [{ id, parentId: null, text }] });
    const map = {
      ...original, nodeMetadata: original.nodeMetadata.map((item) => ({ ...item, description: '<img onerror="unsafe()">'.repeat(200) })),
    };
    const html = renderToStaticMarkup(createElement(NodeCanvas, {
      document: map, links: [], selectedNodeId: id, expandedNodeIds: [], onSelect: vi.fn(), onToggle: vi.fn(), onOpenWorld: vi.fn(),
    }));
    expect(html).toContain('data-canvas-node="constructor&quot; &lt;unsafe&gt;"');
    expect(html).toContain(`width:${CARD_SIZE.rootWidth}px;height:${CARD_SIZE.rootHeight}px`);
    expect(html).toContain('title="&lt;script&gt;');
    expect(html).toContain('&lt;img onerror=');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>Map</b>');
  });

  it('preserves AI provenance labels without treating presentation actions as edits', () => {
    const item = layoutNodes(document, ['root']).byId.get('left')!;
    const metadata = document.nodeMetadata.find((entry) => entry.nodeId === 'left')!;
    for (const userEdited of [false, true]) {
      const html = renderToStaticMarkup(createElement(CanvasNodeCard, {
        item, metadata: { ...metadata, provenance: {
          kind: 'ai', anchorNodeId: 'root', baselineRevision: 0, userEdited,
          baseline: { parentId: 'root', text: item.node.text, description: '' },
        } },
        selected: false, linked: false, onSelect: vi.fn(), onToggle: vi.fn(), onOpenWorld: vi.fn(), onFocusNode: vi.fn(),
      }));
      expect(html).toContain(userEdited ? 'AI + YOUR EDITS' : ' / AI');
      expect(html).not.toContain('Open world');
    }
    expect(metadata.provenance.kind).toBe('user');
  });

  it('renders empty-map guidance and disables only the unavailable selection focus action', () => {
    const empty = createMapDocument({ id: 'empty', title: '', nodes: [] });
    const html = renderToStaticMarkup(createElement(NodeCanvas, {
      document: empty, links: [], selectedNodeId: null, expandedNodeIds: [], onSelect: vi.fn(), onToggle: vi.fn(), onOpenWorld: vi.fn(),
    }));
    expect(html).toContain('A little space for a big idea.');
    expect(html).toContain('0 of 0 nodes visible');
    expect(html).toContain('disabled="">Focus selected');
    expect(html).not.toContain('data-canvas-node=');
    expect(html).not.toContain('<svg');
    expect(html).toContain('100%');
  });

  it('keys the actual board by map identity so navigation cannot leak viewport state between maps', () => {
    const callbacks = { onSelect: vi.fn(), onToggle: vi.fn(), onOpenWorld: vi.fn() };
    const first = NodeCanvas({ document, links: [], selectedNodeId: 'root', expandedNodeIds: [], ...callbacks });
    const otherDocument = createMapDocument({ ...document.map, id: '__proto__' });
    const second = NodeCanvas({ document: otherDocument, links: [], selectedNodeId: 'root', expandedNodeIds: [], ...callbacks });
    expect(first.key).toBe('one');
    expect(second.key).toBe('__proto__');
    expect(first.type).toBe(second.type);
    expect(second.props.onSelect).toBe(callbacks.onSelect);
    expect(second.props.onToggle).toBe(callbacks.onToggle);
    expect(second.props.onOpenWorld).toBe(callbacks.onOpenWorld);
  });
});
