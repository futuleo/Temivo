import { Children, isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMapLibrary, createTopicMap, startNavigation } from '@temivo/core';
import { createNodeDraft, NodeCanvas } from '../../entities/map';
import { NodeEditor } from '../../features/node-editor';
import { WorldLink } from '../../features/world-link';
import { GenerationReview } from '../../features/generation-review';
import { WorldPage } from './index';
import type { WorldPageProps } from './index';

const hooks = vi.hoisted(() => ({
  open: false, setOpen: vi.fn(), focus: vi.fn(),
}));
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  return {
    ...actual,
    useId: () => 'inspector-fixture',
    useState: () => [hooks.open, hooks.setOpen],
    useRef: () => ({ current: { focus: hooks.focus } }),
  };
});

interface TestProps {
  children?: ReactNode;
  hidden?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  'aria-label'?: string;
  'aria-controls'?: string;
  'aria-expanded'?: boolean;
}

function elements(node: ReactNode): ReactElement<TestProps>[] {
  if (!isValidElement<TestProps>(node)) return [];
  return [node, ...Children.toArray(node.props.children).flatMap(elements)];
}

function props(): WorldPageProps {
  const document = createTopicMap('one', 'root', 'My topic');
  const draft = createNodeDraft(document, 'root');
  const library = createMapLibrary([document]);
  return {
    document, library, path: startNavigation(library, 'one'), selectedNodeId: 'root', expandedNodeIds: ['root'],
    disabled: false, onSelect: vi.fn(), onToggle: vi.fn(), onOpenWorld: vi.fn(), onBreadcrumb: vi.fn(), onBack: vi.fn(),
    onLibrary: vi.fn(), onAddRoot: vi.fn(), onRename: vi.fn(), onCollections: vi.fn(), review: null,
    nodeEditor: {
      document, node: document.map.nodes[0]!, draft: { ...draft, fields: { ...draft.fields, text: 'Keep typed intent' } },
      draftStale: false, disabled: false, generationBusy: false, generationBlockedReason: null, aiReady: false,
      onChange: vi.fn(), onApply: vi.fn(), onReset: vi.fn(), onReparent: vi.fn(), onAddChild: vi.fn(), onDelete: vi.fn(), onGenerate: vi.fn(), onSettings: vi.fn(),
    },
    worldLink: {
      documents: [document], link: undefined, disabled: false,
      onLink: vi.fn(), onCreate: vi.fn(), onOpen: vi.fn(), onDetach: vi.fn(),
    },
  };
}

describe('actual world-page tree with injected hooks, not browser interaction', () => {
  beforeEach(() => { hooks.open = false; hooks.setOpen.mockClear(); hooks.focus.mockClear(); });

  it('keeps editor and link-form instances mounted and keyed identically when details are hidden or open', () => {
    const input = props();
    const closed = elements(WorldPage(input));
    const aside = closed.find((element) => element.type === 'aside')!;
    expect(aside.props.hidden).toBe(true);
    const editor = closed.find((element) => element.type === NodeEditor)!;
    const link = closed.find((element) => element.type === WorldLink)!;
    expect(editor.props).toEqual(input.nodeEditor);
    expect(link.key).toBe('.$root');
    hooks.open = true;
    const open = elements(WorldPage(input));
    expect(open.find((element) => element.type === 'aside')?.props.hidden).toBe(false);
    expect(open.find((element) => element.type === NodeEditor)?.type).toBe(editor.type);
    expect(open.find((element) => element.type === WorldLink)?.key).toBe(link.key);
    expect(open.find((element) => element.type === WorldLink)?.props).toEqual(link.props);
  });

  it('keeps the details toggle available during storage/AI blocking and restores focus when dismissed', () => {
    const input = { ...props(), disabled: true };
    const closed = elements(WorldPage(input));
    const toggle = closed.find((element) => element.props['aria-controls'] === 'inspector-fixture')!;
    expect(toggle.props.disabled).toBeUndefined();
    expect(toggle.props['aria-expanded']).toBe(false);
    toggle.props.onClick?.();
    expect(hooks.setOpen).toHaveBeenCalledWith(true);
    hooks.open = true;
    const close = elements(WorldPage(input)).find((element) => element.props['aria-label'] === 'Close node details')!;
    close.props.onClick?.();
    expect(hooks.setOpen).toHaveBeenLastCalledWith(false);
    expect(hooks.focus).toHaveBeenCalledOnce();
  });

  it('surfaces a stale retained draft even while its detailed warning panel is hidden', () => {
    const input = props();
    const tree = elements(WorldPage({ ...input, nodeEditor: { ...input.nodeEditor!, draftStale: true } }));
    expect(tree.some((element) => element.type === 'span' && element.props.children === 'Review draft')).toBe(true);
    expect(tree.find((element) => element.type === 'aside')?.props.hidden).toBe(true);
  });

  it('wires the real canvas to existing callbacks and keeps root creation disabled only by domain state', () => {
    const input = props();
    const tree = elements(WorldPage(input));
    const canvas = tree.find((element) => element.type === NodeCanvas);
    expect(canvas?.props).toMatchObject({ onSelect: input.onSelect, onToggle: input.onToggle, onOpenWorld: input.onOpenWorld });
    const add = tree.find((element) => element.type === 'button' && element.props.onClick === input.onAddRoot)!;
    add.props.onClick?.();
    expect(input.onAddRoot).toHaveBeenCalledOnce();
    const blocked = elements(WorldPage({ ...input, disabled: true }));
    expect(blocked.find((element) => element.props.onClick === input.onAddRoot)?.props.disabled).toBe(true);
  });

  it('keeps proposal review outside the hidden inspector and outside the bounded board', () => {
    const input = props();
    const review: NonNullable<WorldPageProps['review']> = {
      document: input.document, pending: {
        token: { mapId: 'one', anchorNodeId: 'root', sequence: 1, documentRevision: 0, mode: 'refresh', requestedDepth: 1 },
        expectedSnapshot: 'fixture', changes: [], conflicts: [],
      },
      selectedIds: [], disabled: false, stale: false, onToggle: vi.fn(), onAccept: vi.fn(), onReject: vi.fn(),
    };
    const tree = WorldPage({ ...input, review });
    const directChildren = isValidElement<TestProps>(tree) ? Children.toArray(tree.props.children) : [];
    expect(directChildren.some((element) => isValidElement(element) && element.type === GenerationReview)).toBe(true);
  });
});
