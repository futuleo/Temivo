import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';

import {
  assertMapId, assertMapLibrary, assertMapLink, assertMindMap,
  createMapDocument, createMapLibrary, InvalidMindMapError,
} from '@temivo/core';
import type { MapLibrary, MapLink, MindMap, MindMapRepository, MindMapSummary } from '@temivo/core';

import type { LibrarySnapshot } from '../shared/desktop-api';

const SCHEMA_VERSION = 2;
const LIBRARY_SCHEMA = `
  CREATE TABLE map_library (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL CHECK (revision >= 0 AND revision <= 9007199254740991),
    payload TEXT NOT NULL
  ) STRICT;
`;

export interface LibraryRepository extends MindMapRepository {
  loadLibrary(): Promise<LibrarySnapshot>;
  saveLibrary(library: MapLibrary, expectedRevision: number): Promise<LibrarySnapshot>;
}

export class LibraryVersionConflictError extends Error {
  constructor() {
    super('The library changed. Reload it before applying your changes.');
    this.name = 'LibraryVersionConflictError';
  }
}

export class LegacyLibraryWriteError extends Error {
  constructor() {
    super('Legacy writes are disabled. Use maps.loadLibrary and maps.saveLibrary with its storage revision.');
    this.name = 'LegacyLibraryWriteError';
  }
}

export function assertStorageRevision(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidMindMapError('The expected storage revision must be a nonnegative safe integer.');
  }
}

function textColumn(row: Record<string, SQLOutputValue>, name: string): string {
  const value = row[name];
  if (typeof value !== 'string') throw new Error('Invalid text column in the maps database.');
  return value;
}

function assertRetiredHistory(current: MapLibrary, next: MapLibrary): void {
  const retiredMaps = new Set(next.retiredMapIds);
  const nextDocuments = new Map(next.documents.map((document) => [document.map.id, document]));
  for (const id of current.retiredMapIds) {
    if (!retiredMaps.has(id)) throw new InvalidMindMapError('Retired map identities must be retained.');
  }
  for (const document of current.documents) {
    const replacement = nextDocuments.get(document.map.id);
    if (!replacement) {
      if (!retiredMaps.has(document.map.id)) {
        throw new InvalidMindMapError('Deleted map identities must be retired.');
      }
      continue;
    }
    const retiredNodes = new Set(replacement.retiredNodeIds);
    const nextNodes = new Set(replacement.map.nodes.map((node) => node.id));
    for (const id of document.retiredNodeIds) {
      if (!retiredNodes.has(id)) throw new InvalidMindMapError('Retired node identities must be retained.');
    }
    for (const node of document.map.nodes) {
      if (!nextNodes.has(node.id) && !retiredNodes.has(node.id)) {
        throw new InvalidMindMapError('Deleted node identities must be retired.');
      }
    }
  }
}

export class SqliteMindMapRepository implements LibraryRepository {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    try {
      this.database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      this.transaction(() => {
        const version = this.database.prepare('PRAGMA user_version').get()?.['user_version'];
        if (typeof version !== 'number' || version < 0 || version > SCHEMA_VERSION) {
          throw new Error('The maps database has an unsupported schema version.');
        }
        if (version < SCHEMA_VERSION) {
          let library: MapLibrary;
          if (version === 0) {
            if (this.database.prepare(
              "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
            ).all().length > 0) {
              throw new Error('An unversioned nonempty maps database cannot be initialized.');
            }
            library = createMapLibrary();
          } else {
            library = this.readLegacyLibrary();
          }
          this.database.exec(LIBRARY_SCHEMA);
          this.database.prepare('INSERT INTO map_library (id, revision, payload) VALUES (1, 0, ?)')
            .run(JSON.stringify(library));
          if (version === 1) {
            this.database.exec('DROP TABLE map_links; DROP TABLE mind_map_nodes; DROP TABLE mind_maps;');
          }
          this.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        }
        this.readSnapshot();
      });
      this.database.exec('PRAGMA journal_mode = WAL');
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  async loadLibrary(): Promise<LibrarySnapshot> {
    return this.readSnapshot();
  }

  async saveLibrary(library: MapLibrary, expectedRevision: number): Promise<LibrarySnapshot> {
    assertStorageRevision(expectedRevision);
    assertMapLibrary(library);
    return this.transaction(() => {
      const current = this.readSnapshot();
      if (current.revision !== expectedRevision) throw new LibraryVersionConflictError();
      if (current.revision === Number.MAX_SAFE_INTEGER) {
        throw new Error('The library storage revision is exhausted.');
      }
      assertRetiredHistory(current.library, library);
      this.database.prepare('UPDATE map_library SET revision = ?, payload = ? WHERE id = 1 AND revision = ?')
        .run(current.revision + 1, JSON.stringify(library), expectedRevision);
      // Re-read and validate what was actually stored, including any database-trigger effects.
      const saved = this.readSnapshot();
      if (saved.revision !== current.revision + 1) throw new Error('The library write did not advance its revision.');
      return saved;
    });
  }

  async list(): Promise<readonly MindMapSummary[]> {
    return this.readSnapshot().library.documents.map(({ map }) => ({ id: map.id, title: map.title }))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  async get(id: string): Promise<MindMap | null> {
    assertMapId(id);
    return this.readSnapshot().library.documents.find((document) => document.map.id === id)?.map ?? null;
  }

  async getLinks(sourceMapId: string): Promise<readonly MapLink[]> {
    assertMapId(sourceMapId);
    return this.readSnapshot().library.links.filter((link) => link.sourceMapId === sourceMapId)
      .sort((a, b) => a.sourceNodeId < b.sourceNodeId ? -1 : a.sourceNodeId > b.sourceNodeId ? 1 : 0);
  }

  async save(map: MindMap): Promise<void> {
    assertMindMap(map);
    throw new LegacyLibraryWriteError();
  }

  async delete(id: string): Promise<void> {
    assertMapId(id);
    throw new LegacyLibraryWriteError();
  }

  async link(link: MapLink): Promise<void> {
    assertMapLink(link);
    throw new LegacyLibraryWriteError();
  }

  async unlink(sourceMapId: string, sourceNodeId: string): Promise<void> {
    assertMapId(sourceMapId);
    assertMapId(sourceNodeId);
    throw new LegacyLibraryWriteError();
  }

  close(): void {
    this.database.close();
  }

  private readLegacyLibrary(): MapLibrary {
    if (this.database.prepare('PRAGMA foreign_key_check').all().length > 0) {
      throw new Error('Invalid references in the legacy maps database.');
    }
    const mapRows = this.database.prepare('SELECT id, title FROM mind_maps ORDER BY id').all();
    const mapIds = new Set(mapRows.map((row) => textColumn(row, 'id')));
    const nodesByMap = new Map<string, MindMap['nodes'][number][]>();
    for (const node of this.database.prepare(
      'SELECT map_id, id, parent_id, text FROM mind_map_nodes ORDER BY map_id, position',
    ).all()) {
      const mapId = textColumn(node, 'map_id');
      if (!mapIds.has(mapId)) throw new Error('An orphan node exists in the legacy maps database.');
      const nodes = nodesByMap.get(mapId) ?? [];
      nodes.push({
        id: textColumn(node, 'id'),
        parentId: node['parent_id'] === null ? null : textColumn(node, 'parent_id'),
        text: textColumn(node, 'text'),
      });
      nodesByMap.set(mapId, nodes);
    }
    const documents = mapRows.map((row) => {
      const id = textColumn(row, 'id');
      return createMapDocument({ id, title: textColumn(row, 'title'), nodes: nodesByMap.get(id) ?? [] });
    });
    const links = this.database.prepare(
      'SELECT source_map_id, source_node_id, target_map_id FROM map_links ORDER BY source_map_id, source_node_id',
    ).all().map((row) => ({
      sourceMapId: textColumn(row, 'source_map_id'),
      sourceNodeId: textColumn(row, 'source_node_id'),
      targetMapId: textColumn(row, 'target_map_id'),
    }));
    const library = { ...createMapLibrary(documents), links };
    assertMapLibrary(library);
    return library;
  }

  private readSnapshot(): LibrarySnapshot {
    try {
      if (this.database.prepare('PRAGMA user_version').get()?.['user_version'] !== SCHEMA_VERSION) {
        throw new Error('The maps database has an unsupported schema version.');
      }
      const rows = this.database.prepare('SELECT id, revision, payload FROM map_library').all();
      const row = rows[0];
      if (rows.length !== 1 || !row || row['id'] !== 1) throw new Error('A single library snapshot is required.');
      const revision = row['revision'];
      assertStorageRevision(revision);
      const library: unknown = JSON.parse(textColumn(row, 'payload'));
      assertMapLibrary(library);
      return { revision, library };
    } catch (error) {
      throw new Error('Invalid library structure in local storage.', { cause: error });
    }
  }

  private transaction<T>(action: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Database transaction and rollback failed.', {
          cause: rollbackError,
        });
      }
      throw error;
    }
  }
}
