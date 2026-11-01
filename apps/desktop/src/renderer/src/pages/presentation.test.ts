import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createMapLibrary, createTopicMap, linkMaps } from '@temivo/core';
import { LibraryPage } from './library';
import { NodeCanvas, createNodeDraft } from '../entities/map';
import { NodeEditor } from '../features/node-editor';
import { ProviderSettings } from '../features/provider-settings';
import { LinkedWorlds } from '../widgets/linked-worlds';

describe('isolated server-rendered UI, without launching an application', () => {
  it('renders the library empty state and accessible create/search controls', () => {
    const noop = vi.fn();
    const html = renderToStaticMarkup(createElement(LibraryPage, {
      library: createMapLibrary(), collectionId: null, query: '', expandedMapIds: [], disabled: false,
      onQuery: noop, onCreateMap: noop, onRenameMap: noop, onDeleteMap: noop, onOrganizeMap: noop,
      onRenameCollection: noop, onDeleteCollection: noop, onToggleWorld: noop, onOpenWorld: noop,
    }));
    expect(html).toContain('Start with a word.');
    expect(html).toContain('Search maps by title');
    expect(html).toContain('Create your first map');
  });

  it('escapes user content and renders selection and explicit non-destructive node controls', () => {
    const document = createTopicMap('one', 'root', '<script>unsafe()</script>');
    const noop = vi.fn();
    const canvas = renderToStaticMarkup(createElement(NodeCanvas, {
      document, links: [], selectedNodeId: 'root', expandedNodeIds: [], onSelect: noop, onToggle: noop, onOpenWorld: noop,
    }));
    expect(canvas).toContain('&lt;script&gt;');
    expect(canvas).not.toContain('<script>');
    expect(canvas).toContain('aria-pressed="true"');
    const inspector = renderToStaticMarkup(createElement(NodeEditor, {
      document, node: document.map.nodes[0]!, draft: createNodeDraft(document, 'root'), draftStale: false,
      disabled: false, generationBusy: false, aiReady: false, onChange: noop, onApply: noop, onReset: noop,
      onReparent: noop, onAddChild: noop, onDelete: noop, onGenerate: noop, onSettings: noop,
    }));
    expect(inspector).toContain('AI is not configured');
    expect(inspector).toContain('Delete subtree');
    expect(inspector).toContain('only folds saved branches');
  });

  it('terminates linked-world cycles with reference rows and keeps open actions available', () => {
    let library = createMapLibrary([createTopicMap('one', 'root', 'One'), createTopicMap('two', 'root', 'Two')]);
    library = linkMaps(library, { sourceMapId: 'one', sourceNodeId: 'root', targetMapId: 'two' });
    library = linkMaps(library, { sourceMapId: 'two', sourceNodeId: 'root', targetMapId: 'one' });
    const html = renderToStaticMarkup(createElement(LinkedWorlds, {
      library, rootMapId: 'one', expandedMapIds: ['one', 'two'], onToggle: vi.fn(), onOpen: vi.fn(),
    }));
    expect(html).toContain('Cycle reference');
    expect(html.match(/<li/g)).toHaveLength(3);
  });

  it('shows explicit provider/model/key configuration and no invented working AI state', () => {
    const html = renderToStaticMarkup(createElement(ProviderSettings, {
      fields: { provider: 'openai-compatible', endpoint: '', model: '', keyAction: 'keep', apiKey: '' },
      hasStoredKey: false, loaded: true, loading: false, dirty: false, saving: false,
      error: null, status: null, onChange: vi.fn(), onSave: vi.fn(), onRetryLoad: vi.fn(),
    }));
    expect(html).toContain('including DeepSeek');
    expect(html).toContain('Anthropic (native Messages API)');
    expect(html).toContain('No key configured');
    expect(html).toContain('write-only');
    expect(html).toContain('does not test the provider');
    expect(html).not.toContain('type="password"');
  });
});
