import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  addCollectionMember, addMap, addNode, applyGenerationPlan, beginGeneration,
  createCollection, createMapDocument, createMapLibrary, editNode, InvalidMindMapError,
  linkMaps, planGeneration, removeMap, removeNode, renameMap, unlinkMap,
} from '@temivo/core';
import type { MapLibrary, MapLink, MindMap } from '@temivo/core';

import {
  LegacyLibraryWriteError, LibraryVersionConflictError, SqliteMindMapRepository,
} from './mind-map-repository';

const source: MindMap = {
  id: 'source',
  title: 'Source',
  nodes: [
    { id: 'child', parentId: 'root', text: 'Child' },
    { id: 'root', parentId: null, text: 'Root' },
  ],
};
const target: MindMap = { id: 'target', title: 'Target', nodes: [] };
const link: MapLink = { sourceMapId: source.id, sourceNodeId: 'child', targetMapId: target.id };

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function openRepository(path = ':memory:'): SqliteMindMapRepository {
  const repository = new SqliteMindMapRepository(path);
  cleanups.push(() => repository.close());
  return repository;
}

function inspect(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  cleanups.push(() => database.close());
  return database;
}

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'temivo-sqlite-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'maps.sqlite');
}

function basicLibrary(): MapLibrary {
  return linkMaps(createMapLibrary([createMapDocument(source), createMapDocument(target)]), link);
}

function richLibrary(): MapLibrary {
  let library = basicLibrary();
  library = editNode(library, source.id, 'root', {
    description: 'Saved description',
    context: { instructions: 'Keep my work', detail: 'detailed', depth: 3 },
  });
  const started = beginGeneration(library, source.id, 'root', 'refresh');
  library = applyGenerationPlan(started.library, planGeneration(started.library, started.request, [
    { kind: 'upsert', nodeId: 'ai', parentId: 'root', text: 'Generated', description: 'Baseline' },
  ])).library;
  library = editNode(library, source.id, 'ai', { text: 'User edited AI content' });
  library = addNode(library, source.id, { id: 'retired-node', parentId: null, text: '' });
  library = removeNode(library, source.id, 'retired-node');
  library = addMap(library, createMapDocument({ id: 'retired-map', title: '', nodes: [] }));
  library = removeMap(library, 'retired-map');
  library = createCollection(library, 'one', 'First');
  library = createCollection(library, 'two', 'Second');
  library = addCollectionMember(library, 'one', source.id);
  library = addCollectionMember(library, 'one', target.id);
  library = addCollectionMember(library, 'two', source.id);
  return beginGeneration(library, source.id, 'root', 'expand').library;
}

function createV1Fixture(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE mind_maps (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL) STRICT;
      CREATE TABLE mind_map_nodes (
        map_id TEXT NOT NULL REFERENCES mind_maps(id) ON DELETE CASCADE,
        id TEXT NOT NULL, parent_id TEXT, text TEXT NOT NULL, position INTEGER NOT NULL,
        PRIMARY KEY (map_id, id),
        FOREIGN KEY (map_id, parent_id) REFERENCES mind_map_nodes(map_id, id) DEFERRABLE INITIALLY DEFERRED
      ) STRICT;
      CREATE TABLE map_links (
        source_map_id TEXT NOT NULL, source_node_id TEXT NOT NULL,
        target_map_id TEXT NOT NULL REFERENCES mind_maps(id) ON DELETE CASCADE,
        PRIMARY KEY (source_map_id, source_node_id),
        FOREIGN KEY (source_map_id, source_node_id) REFERENCES mind_map_nodes(map_id, id) ON DELETE CASCADE,
        CHECK (source_map_id <> target_map_id)
      ) STRICT;
      CREATE INDEX map_links_target ON map_links(target_map_id);
      BEGIN;
    `);
    for (const map of [source, target]) {
      database.prepare('INSERT INTO mind_maps VALUES (?, ?)').run(map.id, map.title);
      map.nodes.forEach((node, index) => {
        database.prepare('INSERT INTO mind_map_nodes VALUES (?, ?, ?, ?, ?)')
          .run(map.id, node.id, node.parentId, node.text, index);
      });
    }
    database.prepare('INSERT INTO map_links VALUES (?, ?, ?)').run(link.sourceMapId, link.sourceNodeId, link.targetMapId);
    database.exec('PRAGMA user_version = 1; COMMIT;');
  } finally {
    database.close();
  }
}

describe('SQLite library repository', () => {
  it('creates a versioned database, saves complete state, and survives reopening', async () => {
    const path = temporaryDatabasePath();
    const first = new SqliteMindMapRepository(path);
    const library = richLibrary();
    try {
      expect(await first.loadLibrary()).toEqual({ revision: 0, library: createMapLibrary() });
      expect(await first.saveLibrary(library, 0)).toEqual({ revision: 1, library });
    } finally {
      first.close();
    }
    const reopened = openRepository(path);
    expect(await reopened.loadLibrary()).toEqual({ revision: 1, library });
    expect(await reopened.get(source.id)).toEqual(library.documents[0]?.map);
    expect(await reopened.getLinks(source.id)).toEqual([link]);
    expect(await reopened.list()).toEqual([
      { id: 'source', title: 'Source' },
      { id: 'target', title: 'Target' },
    ]);
    expect(await reopened.get('missing')).toBeNull();
    const database = inspect(path);
    expect(database.prepare('PRAGMA user_version').get()?.['user_version']).toBe(2);
    expect(database.prepare('PRAGMA journal_mode').get()?.['journal_mode']).toBe('wal');
    expect(database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all())
      .toEqual([{ name: 'map_library' }]);
  });

  it('migrates the current v1 schema atomically with order, empty maps and user provenance intact', async () => {
    const path = temporaryDatabasePath();
    createV1Fixture(path);
    const repository = openRepository(path);
    const migrated = await repository.loadLibrary();
    expect(migrated).toEqual({
      revision: 0,
      library: { ...createMapLibrary([createMapDocument(source), createMapDocument(target)]), links: [link] },
    });
    expect(await repository.get(source.id)).toEqual(source);
    expect(await repository.getLinks(source.id)).toEqual([link]);
    expect(inspect(path).prepare('PRAGMA user_version').get()?.['user_version']).toBe(2);
  });

  it('updates and reorders nodes without losing metadata, collections or links on retained nodes', async () => {
    const repository = openRepository();
    const library = richLibrary();
    await repository.saveLibrary(library, 0);
    const renamed = renameMap(library, source.id, 'Updated');
    const reordered = {
      ...renamed,
      documents: renamed.documents.map((document) => ({
        ...document, map: { ...document.map, nodes: [...document.map.nodes].reverse() },
      })),
    };
    await repository.saveLibrary(reordered, 1);
    expect(await repository.loadLibrary()).toEqual({ revision: 2, library: reordered });
    expect(await repository.getLinks(source.id)).toEqual([link]);
  });

  it('persists empty maps, unfinished text, forests, scoped node IDs and SQL-like text', async () => {
    const repository = openRepository();
    const text = "'; DROP TABLE map_library; --";
    const maps: MindMap[] = [
      { id: 'draft', title: '', nodes: [] },
      { id: 'unfinished', title: '', nodes: [{ id: 'root', parentId: null, text: '' }] },
      source,
      { ...source, id: 'other', title: text, nodes: [...source.nodes, { id: 'another-root', parentId: null, text: '' }] },
    ];
    await repository.saveLibrary(createMapLibrary(maps.map(createMapDocument)), 0);
    for (const map of maps) expect(await repository.get(map.id)).toEqual(map);
  });

  it('replaces and detaches links without deleting independent target maps', async () => {
    const repository = openRepository();
    const otherTarget = { ...target, id: 'other-target' };
    let library = addMap(basicLibrary(), createMapDocument(otherTarget));
    const replacement = { ...link, targetMapId: otherTarget.id };
    library = linkMaps(library, replacement);
    await repository.saveLibrary(library, 0);
    expect(await repository.getLinks(source.id)).toEqual([replacement]);
    library = unlinkMap(library, source.id, 'child');
    await repository.saveLibrary(library, 1);
    expect(await repository.getLinks(source.id)).toEqual([]);
    expect(await repository.get(target.id)).toEqual(target);
    expect(await repository.get(otherTarget.id)).toEqual(otherTarget);
  });

  it.each(['source-node', 'source-map', 'target-map'])('cleans references for explicit %s removal without deleting other maps', async (kind) => {
    const repository = openRepository();
    const library = richLibrary();
    await repository.saveLibrary(library, 0);
    const next = kind === 'source-node' ? removeNode(library, source.id, 'child')
      : removeMap(library, kind === 'source-map' ? source.id : target.id);
    await repository.saveLibrary(next, 1);
    expect(await repository.loadLibrary()).toEqual({ revision: 2, library: next });
    expect(await repository.getLinks(source.id)).toEqual([]);
    if (kind !== 'source-map') expect(await repository.get(source.id)).not.toBeNull();
    if (kind !== 'target-map') expect(await repository.get(target.id)).toEqual(target);
  });

  it('blocks every legacy mutation without losing rich data or advancing the revision', async () => {
    const repository = openRepository();
    const library = richLibrary();
    await repository.saveLibrary(library, 0);
    for (const operation of [
      () => repository.save(source),
      () => repository.save({ id: 'new', title: '', nodes: [] }),
      () => repository.delete(source.id),
      () => repository.link(link),
      () => repository.unlink(source.id, 'child'),
    ]) {
      await expect(operation()).rejects.toThrow(LegacyLibraryWriteError);
      expect(await repository.loadLibrary()).toEqual({ revision: 1, library });
    }
  });

  it('rejects invalid snapshots, revisions and legacy arguments without changing data', async () => {
    const repository = openRepository();
    const library = basicLibrary();
    await repository.saveLibrary(library, 0);
    await expect(repository.saveLibrary({ ...library, links: [{ ...link, targetMapId: 'missing' }] }, 1))
      .rejects.toThrow(InvalidMindMapError);
    for (const revision of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(repository.saveLibrary(library, revision)).rejects.toThrow(InvalidMindMapError);
    }
    await expect(repository.save({
      ...source, nodes: [{ id: 'invalid', parentId: 'missing', text: '' }],
    })).rejects.toThrow(InvalidMindMapError);
    await expect(repository.link({ ...link, targetMapId: '' })).rejects.toThrow(InvalidMindMapError);
    await expect(repository.delete('')).rejects.toThrow(InvalidMindMapError);
    await expect(repository.unlink(source.id, '')).rejects.toThrow(InvalidMindMapError);
    expect(await repository.loadLibrary()).toEqual({ revision: 1, library });
  });

  it('rejects delayed saves from another connection and permits an explicit reloaded edit', async () => {
    const path = temporaryDatabasePath();
    const first = openRepository(path);
    const second = openRepository(path);
    const library = richLibrary();
    await first.saveLibrary(library, 0);
    const stale = await second.loadLibrary();
    const edited = editNode(library, source.id, 'ai', { description: 'New user work' });
    await first.saveLibrary(edited, 1);
    await expect(second.saveLibrary(stale.library, stale.revision)).rejects.toThrow(LibraryVersionConflictError);
    expect(await second.loadLibrary()).toEqual({ revision: 2, library: edited });
    const current = await second.loadLibrary();
    await second.saveLibrary(renameMap(current.library, target.id, 'Renamed'), current.revision);
    expect((await first.loadLibrary()).revision).toBe(3);
  });

  it('does not let even a current CAS caller discard tombstones or resurrect retired identities', async () => {
    const repository = openRepository();
    const library = richLibrary();
    await repository.saveLibrary(library, 0);
    for (const next of [
      { ...library, retiredMapIds: [] },
      { ...library, documents: library.documents.map((document) => ({ ...document, retiredNodeIds: [] })) },
      { ...library, documents: library.documents.filter((document) => document.map.id !== target.id) },
      { ...library, documents: library.documents.map((document) => document.map.id !== source.id ? document : {
        ...document, map: { ...document.map, nodes: document.map.nodes.filter((node) => node.id !== 'ai') },
        nodeMetadata: document.nodeMetadata.filter((metadata) => metadata.nodeId !== 'ai'),
      }) },
      { ...library, documents: [...library.documents, createMapDocument({ ...target, id: 'retired-map' })] },
    ]) {
      await expect(repository.saveLibrary(next, 1)).rejects.toThrow(InvalidMindMapError);
      expect(await repository.loadLibrary()).toEqual({ revision: 1, library });
    }
  });

  it('rolls back the entire snapshot and revision on SQL failure', async () => {
    const path = temporaryDatabasePath();
    const repository = openRepository(path);
    const library = richLibrary();
    await repository.saveLibrary(library, 0);
    const database = inspect(path);
    database.exec(`
      CREATE TRIGGER reject_fixture AFTER UPDATE ON map_library
      BEGIN SELECT RAISE(ABORT, 'fixture failure'); END
    `);
    await expect(repository.saveLibrary(renameMap(library, source.id, 'Must not persist'), 1))
      .rejects.toThrow('fixture failure');
    expect(await repository.loadLibrary()).toEqual({ revision: 1, library });
  });

  it('rolls back a write that creates invalid stored structure instead of returning success', async () => {
    const path = temporaryDatabasePath();
    const repository = openRepository(path);
    const library = richLibrary();
    await repository.saveLibrary(library, 0);
    inspect(path).exec(`
      CREATE TRIGGER corrupt_fixture AFTER UPDATE ON map_library
      BEGIN UPDATE map_library SET payload = '{}' WHERE id = NEW.id; END
    `);
    await expect(repository.saveLibrary(renameMap(library, source.id, 'Must not persist'), 1))
      .rejects.toThrow('Invalid library structure in local storage.');
    expect(await repository.loadLibrary()).toEqual({ revision: 1, library });
  });

  it('returns detached snapshots so caller mutations cannot change persisted data', async () => {
    const repository = openRepository();
    const library = richLibrary();
    await repository.saveLibrary(library, 0);
    const loaded = await repository.loadLibrary();
    Object.assign(loaded.library.documents[0]?.nodeMetadata[0] ?? {}, { description: 'Uncommitted' });
    expect(await repository.loadLibrary()).toEqual({ revision: 1, library });
  });

  it('refuses revision overflow and schemas advanced after opening without writing', async () => {
    const path = temporaryDatabasePath();
    const repository = openRepository(path);
    const library = richLibrary();
    await repository.saveLibrary(library, 0);
    const database = inspect(path);
    database.prepare('UPDATE map_library SET revision = ?').run(Number.MAX_SAFE_INTEGER);
    await expect(repository.saveLibrary(library, Number.MAX_SAFE_INTEGER)).rejects.toThrow('revision is exhausted');
    expect(await repository.loadLibrary()).toEqual({ revision: Number.MAX_SAFE_INTEGER, library });
    database.exec('PRAGMA user_version = 3');
    await expect(repository.saveLibrary(library, Number.MAX_SAFE_INTEGER)).rejects.toThrow('Invalid library structure');
    await expect(repository.loadLibrary()).rejects.toThrow('Invalid library structure');
    expect(database.prepare('SELECT revision FROM map_library').get()?.['revision']).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rolls back schema changes when v1 migration cannot drop an old table', () => {
    const path = temporaryDatabasePath();
    createV1Fixture(path);
    const database = inspect(path);
    database.exec(`
      CREATE TABLE migration_blocker (map_id TEXT REFERENCES mind_maps(id) ON DELETE RESTRICT);
      INSERT INTO migration_blocker VALUES ('source');
    `);
    expect(() => new SqliteMindMapRepository(path)).toThrow();
    expect(database.prepare('PRAGMA user_version').get()?.['user_version']).toBe(1);
    expect(database.prepare('SELECT * FROM mind_maps ORDER BY id').all()).toEqual([
      { id: 'source', title: 'Source' }, { id: 'target', title: 'Target' },
    ]);
    expect(database.prepare('SELECT count(*) AS count FROM mind_map_nodes').get()?.['count']).toBe(2);
    expect(database.prepare('SELECT count(*) AS count FROM map_links').get()?.['count']).toBe(1);
    expect(database.prepare("SELECT name FROM sqlite_schema WHERE name = 'map_library'").get()).toBeUndefined();
  });

  it.each(['cycle', 'dangling-link', 'orphan-node'])('refuses corrupt v1 %s data without migrating it', (kind) => {
    const path = temporaryDatabasePath();
    createV1Fixture(path);
    const database = inspect(path);
    database.exec('PRAGMA foreign_keys = OFF');
    if (kind === 'cycle') database.exec("UPDATE mind_map_nodes SET parent_id = 'child' WHERE id = 'root'");
    if (kind === 'dangling-link') database.exec("UPDATE map_links SET target_map_id = 'missing'");
    if (kind === 'orphan-node') database.exec("INSERT INTO mind_map_nodes VALUES ('missing', 'orphan', NULL, '', 0)");
    const before = [
      database.prepare('SELECT * FROM mind_maps').all(),
      database.prepare('SELECT * FROM mind_map_nodes').all(),
      database.prepare('SELECT * FROM map_links').all(),
    ];
    expect(() => new SqliteMindMapRepository(path)).toThrow();
    expect(database.prepare('PRAGMA user_version').get()?.['user_version']).toBe(1);
    expect([
      database.prepare('SELECT * FROM mind_maps').all(),
      database.prepare('SELECT * FROM mind_map_nodes').all(),
      database.prepare('SELECT * FROM map_links').all(),
    ]).toEqual(before);
  });

  it('refuses newer schemas and unversioned nonempty databases without resetting data', () => {
    for (const version of [0, 3]) {
      const path = temporaryDatabasePath();
      const database = inspect(path);
      database.exec(`CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('keep'); PRAGMA user_version = ${version};`);
      expect(() => new SqliteMindMapRepository(path)).toThrow(version === 3 ? 'unsupported schema version' : 'unversioned nonempty');
      expect(database.prepare('SELECT value FROM future_data').get()?.['value']).toBe('keep');
      expect(database.prepare('PRAGMA user_version').get()?.['user_version']).toBe(version);
    }
  });

  it.each(['json', 'metadata', 'collections', 'missing-row', 'revision'])('treats corrupt persisted %s as storage failure for every read and CAS', async (kind) => {
    const path = temporaryDatabasePath();
    const repository = openRepository(path);
    const library = richLibrary();
    await repository.saveLibrary(library, 0);
    const database = inspect(path);
    if (kind === 'missing-row') database.exec('DELETE FROM map_library');
    else if (kind === 'revision') {
      database.exec('PRAGMA ignore_check_constraints = ON; UPDATE map_library SET revision = -1');
    } else {
      const corrupt = kind === 'json' ? '{invalid'
        : JSON.stringify(kind === 'metadata'
          ? { ...library, documents: library.documents.map((document) => ({ ...document, nodeMetadata: [] })) }
          : { ...library, collections: [{ id: 'bad', title: '', mapIds: ['missing'] }] });
      database.prepare('UPDATE map_library SET payload = ?').run(corrupt);
    }
    const before = database.prepare('SELECT * FROM map_library').all();
    for (const read of [
      () => repository.loadLibrary(), () => repository.list(), () => repository.get(source.id),
      () => repository.getLinks(source.id), () => repository.saveLibrary(library, 1),
    ]) {
      await expect(read()).rejects.toThrow('Invalid library structure in local storage.');
      await expect(read()).rejects.not.toBeInstanceOf(InvalidMindMapError);
    }
    expect(() => new SqliteMindMapRepository(path)).toThrow('Invalid library structure in local storage.');
    expect(database.prepare('SELECT * FROM map_library').all()).toEqual(before);
  });
});
