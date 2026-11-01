import {
  addCollectionMember, addMap, addNode, applyGenerationPlan, approveGenerationConflicts,
  beginGeneration, createCollection, createTopicMap, editNode, followMapLink, linkMaps,
  navigateBack, navigateToBreadcrumb, planGeneration, reconcileNavigation, removeCollection,
  removeCollectionMember, removeMap, removeNode, renameCollection, renameMap, reparentNode,
  startNavigation, unlinkMap,
} from '@temivo/core';
import type {
  GenerationChange, GenerationMode, GenerationRequest, MapDocument, MapLibrary,
  NavigationPath, PendingGenerationConflicts,
} from '@temivo/core';
import {
  createNodeDraft, draftEdit, isDraftDirty, nodeFields, nodeFingerprint, visibleDepth,
} from '../entities/map';
import type { NodeDraft, NodeFields } from '../entities/map';
import type { LibrarySnapshot } from '../../../shared/desktop-api';

export interface WorkspacePorts {
  load(): Promise<LibrarySnapshot>;
  save(library: MapLibrary, expectedRevision: number): Promise<LibrarySnapshot>;
  generate?(request: GenerationRequest): Promise<readonly GenerationChange[]>;
  cancel?(mapId: string, sequence: number): Promise<void>;
  newId(): string;
}

export class DesktopPortError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DesktopPortError';
  }
}

export interface DraftEntry {
  readonly mapId: string;
  readonly nodeId: string;
  readonly draft: NodeDraft;
}

export interface ProposalEntry {
  readonly pending: PendingGenerationConflicts;
  readonly selectedIds: readonly string[];
}

export interface WorkspaceState {
  readonly library: MapLibrary | null;
  readonly revision: number | null;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly dirty: boolean;
  readonly storageConflict: boolean;
  readonly error: string | null;
  readonly saveError: string | null;
  readonly page: 'library' | 'world' | 'settings';
  readonly collectionId: string | null;
  readonly query: string;
  readonly path: NavigationPath | null;
  readonly selectedNodes: Readonly<Record<string, string>>;
  readonly expandedNodes: Readonly<Record<string, readonly string[]>>;
  readonly expandedWorlds: readonly string[];
  readonly drafts: Readonly<Record<string, DraftEntry>>;
  readonly proposals: Readonly<Record<string, ProposalEntry>>;
  readonly generation: GenerationRequest | null;
  readonly generationStatus: string | null;
}

function draftKey(mapId: string, nodeId: string): string {
  return JSON.stringify([mapId, nodeId]);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export class Workspace {
  private state: WorkspaceState = {
    library: null, revision: null, loading: true, saving: false, dirty: false,
    storageConflict: false, error: null, saveError: null, page: 'library',
    collectionId: null, query: '', path: null, selectedNodes: {}, expandedNodes: {},
    expandedWorlds: [], drafts: {}, proposals: {}, generation: null, generationStatus: null,
  };
  private readonly listeners = new Set<() => void>();
  private loadTask: Promise<void> | null = null;
  private saveTask: Promise<boolean> | null = null;

  constructor(private readonly ports: WorkspacePorts) {}

  readonly getSnapshot = (): WorkspaceState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<WorkspaceState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  readonly initialize = (): Promise<void> => {
    if (this.state.library) return Promise.resolve();
    if (this.loadTask) return this.loadTask;
    this.loadTask = this.loadInitial().finally(() => { this.loadTask = null; });
    return this.loadTask;
  };

  private async loadInitial(): Promise<void> {
    this.update({ loading: true, error: null });
    try {
      const snapshot = await this.ports.load();
      this.update({
        library: snapshot.library, revision: snapshot.revision, loading: false,
        generationStatus: snapshot.library.documents.some((document) => document.activeGeneration !== null)
          ? 'A previous generation did not finish in this session. Saved maps are unchanged; generate again when ready.'
          : null,
      });
    } catch (error) {
      this.update({ loading: false, error: errorMessage(error, 'Could not load your library. No data has been replaced.') });
    }
  }

  private available(): MapLibrary {
    if (!this.state.library) throw new Error('The library is not loaded.');
    if (this.state.loading) throw new Error('Wait for the library reload before applying changes. Your draft has been kept.');
    if (this.state.saving) throw new Error('Wait for the current save before changing the library. You can keep typing in your draft.');
    if (this.state.storageConflict) throw new Error('Resolve the storage version conflict before applying more library changes. Your drafts are still editable.');
    return this.state.library;
  }

  private setLibrary(library: MapLibrary): void {
    const path = this.state.path ? reconcileNavigation(library, this.state.path) : null;
    const drafts = { ...this.state.drafts };
    for (const [key, entry] of Object.entries(drafts)) {
      const document = library.documents.find((item) => item.map.id === entry.mapId);
      if (document?.map.nodes.some((node) => node.id === entry.nodeId) && !isDraftDirty(entry.draft)) {
        drafts[key] = { ...entry, draft: createNodeDraft(document, entry.nodeId) };
      }
    }
    this.update({
      library, path, dirty: true, drafts, error: null,
      proposals: Object.fromEntries(Object.entries(this.state.proposals).filter(([mapId]) => library.documents.some((document) => document.map.id === mapId))),
      page: this.state.page === 'world' && !path ? 'library' : this.state.page,
      collectionId: library.collections.some((item) => item.id === this.state.collectionId) ? this.state.collectionId : null,
    });
  }

  private change(operation: (library: MapLibrary) => MapLibrary): boolean {
    try {
      this.setLibrary(operation(this.available()));
      void this.save();
      return true;
    } catch (error) {
      this.update({ error: errorMessage(error, 'This change could not be applied. Your content has been kept.') });
      return false;
    }
  }

  readonly save = (): Promise<boolean> => {
    if (this.saveTask) return this.saveTask;
    this.saveTask = this.persist().finally(() => { this.saveTask = null; });
    return this.saveTask;
  };

  private async persist(): Promise<boolean> {
    const { library, revision } = this.state;
    if (!library || revision === null) {
      this.update({ error: 'The library must be loaded before it can be saved.' });
      return false;
    }
    if (!this.state.dirty) return true;
    if (this.state.storageConflict) return false;
    this.update({ saving: true, saveError: null });
    try {
      const snapshot = await this.ports.save(library, revision);
      this.update({ revision: snapshot.revision, saving: false, dirty: this.state.library !== library });
      return true;
    } catch (error) {
      this.update({
        saving: false, dirty: true,
        storageConflict: error instanceof DesktopPortError && error.code === 'VERSION_CONFLICT',
        saveError: errorMessage(error, 'Saving failed. Changes remain in this session; retry before closing.'),
      });
      return false;
    }
  }

  async reloadSaved(): Promise<void> {
    if (this.state.saving || this.state.loading) return;
    this.update({ loading: true, error: null });
    await this.cancelGeneration();
    try {
      const snapshot = await this.ports.load();
      const drafts = { ...this.state.drafts };
      for (const document of this.state.library?.documents ?? []) {
        const remote = snapshot.library.documents.find((item) => item.map.id === document.map.id);
        for (const node of document.map.nodes) {
          const key = draftKey(document.map.id, node.id);
          if (drafts[key] && isDraftDirty(drafts[key].draft)) continue;
          if (remote && nodeFingerprint(document, node.id) === nodeFingerprint(remote, node.id)) continue;
          const local = createNodeDraft(document, node.id);
          const original = remote?.map.nodes.some((item) => item.id === node.id) ? nodeFields(remote, node.id) : {
            text: '', description: '', instructions: '', detail: 'brief' as const, depth: '1',
          };
          drafts[key] = { mapId: document.map.id, nodeId: node.id, draft: { ...local, original } };
        }
      }
      this.update({ drafts, proposals: {}, generationStatus: null });
      this.setLibrary(snapshot.library);
      this.update({ revision: snapshot.revision, loading: false, dirty: false, storageConflict: false, saveError: null });
    } catch (error) {
      this.update({ loading: false, error: errorMessage(error, 'Reload failed. Your local work has been kept.') });
    }
  }

  showLibrary(collectionId: string | null = null): void {
    this.update({ page: 'library', collectionId, query: '' });
  }

  showSettings(): void { this.update({ page: 'settings' }); }
  setQuery(query: string): void { this.update({ query }); }
  clearError(): void { this.update({ error: null }); }

  currentDocument(): MapDocument | undefined {
    const id = this.state.path?.steps.at(-1)?.mapId;
    return this.state.library?.documents.find((document) => document.map.id === id);
  }

  openWorld(rootMapId: string, viaNodeIds: readonly string[] = []): void {
    const library = this.state.library;
    if (!library) return;
    try {
      let path = startNavigation(library, rootMapId);
      for (const nodeId of viaNodeIds) path = followMapLink(library, path, nodeId);
      this.visit(path);
    } catch (error) {
      this.update({ error: errorMessage(error, 'This world could not be opened.') });
    }
  }

  private visit(path: NavigationPath): void {
    this.update({ path, page: 'world' });
    const document = this.currentDocument();
    if (!document) return;
    const expandedNodes = { ...this.state.expandedNodes };
    if (!expandedNodes[document.map.id]) {
      let expanded: readonly string[] = [];
      for (const root of document.map.nodes.filter((node) => node.parentId === null)) {
        const depth = document.nodeMetadata.find((item) => item.nodeId === root.id)?.context.depth ?? 1;
        expanded = visibleDepth(document, expanded, root.id, depth);
      }
      expandedNodes[document.map.id] = expanded;
    }
    this.update({ expandedNodes });
    const selected = this.state.selectedNodes[document.map.id];
    const nodeId = selected && document.map.nodes.some((node) => node.id === selected) ? selected : document.map.nodes[0]?.id;
    if (nodeId) this.selectNode(nodeId);
  }

  followWorld(nodeId: string): void {
    if (!this.state.library || !this.state.path) return;
    try { this.visit(followMapLink(this.state.library, this.state.path, nodeId)); }
    catch (error) { this.update({ error: errorMessage(error, 'This world link is no longer available.') }); }
  }

  breadcrumb(index: number): void {
    if (this.state.library && this.state.path) this.visit(navigateToBreadcrumb(this.state.library, this.state.path, index));
  }

  back(): void {
    if (this.state.library && this.state.path) this.visit(navigateBack(this.state.library, this.state.path));
  }

  selectNode(nodeId: string): void {
    const document = this.currentDocument();
    if (!document || !document.map.nodes.some((node) => node.id === nodeId)) return;
    const key = draftKey(document.map.id, nodeId);
    const expanded = new Set(this.state.expandedNodes[document.map.id] ?? []);
    let node = document.map.nodes.find((item) => item.id === nodeId);
    while (node?.parentId) {
      expanded.add(node.parentId);
      node = document.map.nodes.find((item) => item.id === node?.parentId);
    }
    this.update({
      selectedNodes: { ...this.state.selectedNodes, [document.map.id]: nodeId },
      expandedNodes: { ...this.state.expandedNodes, [document.map.id]: [...expanded] },
      drafts: {
        ...this.state.drafts,
        [key]: this.state.drafts[key] ?? { mapId: document.map.id, nodeId, draft: createNodeDraft(document, nodeId) },
      },
    });
  }

  getDraft(mapId: string, nodeId: string): NodeDraft | undefined {
    return this.state.drafts[draftKey(mapId, nodeId)]?.draft;
  }

  changeDraft(mapId: string, nodeId: string, fields: NodeFields): void {
    const key = draftKey(mapId, nodeId);
    const entry = this.state.drafts[key];
    if (entry) this.update({ drafts: { ...this.state.drafts, [key]: { ...entry, draft: { ...entry.draft, fields } } } });
  }

  resetDraft(mapId: string, nodeId: string): void {
    const document = this.state.library?.documents.find((item) => item.map.id === mapId);
    if (!document?.map.nodes.some((node) => node.id === nodeId)) return;
    const key = draftKey(mapId, nodeId);
    this.update({ drafts: { ...this.state.drafts, [key]: { mapId, nodeId, draft: createNodeDraft(document, nodeId) } } });
  }

  discardDraft(mapId: string, nodeId: string): void {
    const drafts = { ...this.state.drafts };
    delete drafts[draftKey(mapId, nodeId)];
    this.update({ drafts });
  }

  applyDraft(mapId: string, nodeId: string, overwrite = false): boolean {
    const draft = this.getDraft(mapId, nodeId);
    const document = this.state.library?.documents.find((item) => item.map.id === mapId);
    if (!draft || !document) {
      this.update({ error: 'The original map or node is no longer available. Any retained draft is in the recovery section.' });
      return false;
    }
    if (!overwrite && draft.base !== nodeFingerprint(document, nodeId)) {
      this.update({ error: 'Saved content changed. Review your draft and explicitly confirm replacing the saved fields.' });
      return false;
    }
    try {
      const edit = draftEdit(draft);
      const library = editNode(this.available(), mapId, nodeId, edit);
      const next = library.documents.find((item) => item.map.id === mapId);
      if (!next) throw new Error('This map is no longer available. Your draft has been kept.');
      const key = draftKey(mapId, nodeId);
      this.setLibrary(library);
      this.update({
        drafts: { ...this.state.drafts, [key]: { mapId, nodeId, draft: createNodeDraft(next, nodeId) } },
        expandedNodes: { ...this.state.expandedNodes, [mapId]: visibleDepth(next, this.state.expandedNodes[mapId] ?? [], nodeId, Number(draft.fields.depth)) },
      });
      void this.save();
      return true;
    } catch (error) {
      this.update({ error: errorMessage(error, 'The draft could not be applied. It has been kept.') });
      return false;
    }
  }

  toggleNode(nodeId: string): void {
    const mapId = this.currentDocument()?.map.id;
    if (!mapId) return;
    const expanded = this.state.expandedNodes[mapId] ?? [];
    this.update({ expandedNodes: { ...this.state.expandedNodes, [mapId]: expanded.includes(nodeId) ? expanded.filter((id) => id !== nodeId) : [...expanded, nodeId] } });
  }

  toggleWorld(mapId: string): void {
    this.update({ expandedWorlds: this.state.expandedWorlds.includes(mapId) ? this.state.expandedWorlds.filter((id) => id !== mapId) : [...this.state.expandedWorlds, mapId] });
  }

  async createMap(topic: string, generateInitial = false, source?: { mapId: string; nodeId: string }): Promise<void> {
    try {
      const id = this.ports.newId();
      const document = createTopicMap(id, this.ports.newId(), topic);
      let library = addMap(this.available(), document);
      if (source) library = linkMaps(library, { sourceMapId: source.mapId, sourceNodeId: source.nodeId, targetMapId: id });
      else if (this.state.collectionId) library = addCollectionMember(library, this.state.collectionId, id);
      this.setLibrary(library);
      if (source && this.state.path?.steps.at(-1)?.mapId === source.mapId) this.followWorld(source.nodeId);
      else this.openWorld(id);
      const saved = await this.save();
      const root = document.map.nodes[0];
      if (saved && generateInitial && root) await this.generate(id, root.id, 'expand');
    } catch (error) {
      this.update({ error: errorMessage(error, 'The map could not be created. Your library has been kept.') });
    }
  }

  renameMap(mapId: string, title: string): void { this.change((library) => renameMap(library, mapId, title)); }
  deleteMap(mapId: string): void { this.change((library) => removeMap(library, mapId)); }
  createCollection(title: string): void { this.change((library) => createCollection(library, this.ports.newId(), title)); }
  renameCollection(id: string, title: string): void { this.change((library) => renameCollection(library, id, title)); }
  deleteCollection(id: string): void { this.change((library) => removeCollection(library, id)); }
  setMembership(collectionId: string, mapId: string, member: boolean): void {
    this.change((library) => member ? addCollectionMember(library, collectionId, mapId) : removeCollectionMember(library, collectionId, mapId));
  }
  addNode(mapId: string, parentId: string | null, text: string): void {
    const id = this.ports.newId();
    if (this.change((library) => addNode(library, mapId, { id, parentId, text }))) this.selectNode(id);
  }
  reparent(mapId: string, nodeId: string, parentId: string | null): void { this.change((library) => reparentNode(library, mapId, nodeId, parentId)); }
  deleteNode(mapId: string, nodeId: string): void { this.change((library) => removeNode(library, mapId, nodeId)); }
  linkWorld(mapId: string, nodeId: string, targetMapId: string): void { this.change((library) => linkMaps(library, { sourceMapId: mapId, sourceNodeId: nodeId, targetMapId })); }
  detachWorld(mapId: string, nodeId: string): void { this.change((library) => unlinkMap(library, mapId, nodeId)); }

  private isCurrentGeneration(request: GenerationRequest): boolean {
    return this.state.generation === request;
  }

  async generate(mapId: string, nodeId: string, mode: GenerationMode): Promise<void> {
    const generate = this.ports.generate;
    if (!generate) {
      this.update({ error: 'AI generation is unavailable in this build. Local editing and saving still work.' });
      return;
    }
    if (this.state.generation || this.state.proposals[mapId]) {
      this.update({ error: 'Finish or cancel the current generation, and review or dismiss proposals before generating again.' });
      return;
    }
    let request: GenerationRequest | null = null;
    try {
      const draft = this.getDraft(mapId, nodeId);
      if (draft && isDraftDirty(draft)) throw new Error('Apply the selected node draft before generating.');
      const begun = beginGeneration(this.available(), mapId, nodeId, mode);
      request = begun.request;
      this.setLibrary(begun.library);
      this.update({ generation: request, generationStatus: 'Saving generation context…' });
      if (!await this.save()) throw new Error('Generation was not sent because saving failed. Your content has been kept.');
      if (!this.isCurrentGeneration(request)) return;
      this.update({ generationStatus: 'Waiting for your AI provider… You can keep editing drafts.' });
      const changes = await generate(request);
      if (!this.isCurrentGeneration(request)) return;
      if (this.saveTask && !await this.saveTask) throw new Error('AI results were not applied because saving your current work failed. Retry saving, then generate again.');
      if (!this.isCurrentGeneration(request)) return;
      const current = this.available();
      const result = applyGenerationPlan(current, planGeneration(current, request, changes));
      this.setLibrary(result.library);
      const proposals = { ...this.state.proposals };
      if (result.pendingConflicts) proposals[mapId] = { pending: result.pendingConflicts, selectedIds: [] };
      const generatedDocument = result.library.documents.find((document) => document.map.id === mapId);
      this.update({
        proposals, generation: null,
        expandedNodes: generatedDocument ? {
          ...this.state.expandedNodes,
          [mapId]: visibleDepth(generatedDocument, this.state.expandedNodes[mapId] ?? [], nodeId, request.requestedDepth),
        } : this.state.expandedNodes,
        generationStatus: result.pendingConflicts ? 'Safe AI changes applied locally. Protected content is waiting for your review.' : 'AI generation applied locally.',
      });
      await this.save();
    } catch (error) {
      if (request && !this.isCurrentGeneration(request)) return;
      this.update({ generation: null, generationStatus: null, error: errorMessage(error, 'Generation failed. Your existing content and drafts have been kept.') });
    }
  }

  async cancelGeneration(): Promise<void> {
    const request = this.state.generation;
    if (!request) return;
    this.update({ generation: null, generationStatus: 'Generation canceled. Existing content and drafts are unchanged.' });
    try {
      if (!this.ports.cancel) throw new Error('Provider cancellation is unavailable. Any late result will be ignored.');
      await this.ports.cancel(request.mapId, request.sequence);
    }
    catch (error) { this.update({ error: errorMessage(error, 'The provider could not confirm cancellation. Any late result will be ignored.') }); }
  }

  toggleProposal(mapId: string, nodeId: string): void {
    const entry = this.state.proposals[mapId];
    if (!entry) return;
    const selectedIds = entry.selectedIds.includes(nodeId) ? entry.selectedIds.filter((id) => id !== nodeId) : [...entry.selectedIds, nodeId];
    this.update({ proposals: { ...this.state.proposals, [mapId]: { ...entry, selectedIds } } });
  }

  approveProposals(mapId: string): boolean {
    const entry = this.state.proposals[mapId];
    if (!entry) return false;
    if (!this.change((library) => approveGenerationConflicts(library, entry.pending, entry.selectedIds))) return false;
    this.dismissProposals(mapId);
    return true;
  }

  dismissProposals(mapId: string): void {
    const proposals = { ...this.state.proposals };
    delete proposals[mapId];
    this.update({ proposals });
  }
}
