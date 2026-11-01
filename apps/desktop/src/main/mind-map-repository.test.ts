import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { InvalidMindMapError } from '@temivo/core';
import type { MapLink, MindMap } from '@temivo/core';

import { SqliteMindMapRepository } from './mind-map-repository';

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

function openMemoryRepository(): SqliteMindMapRepository {
  const repository = new SqliteMindMapRepository(':memory:');
  cleanups.push(() => repository.close());
  return repository;
}

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'temivo-sqlite-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'maps.sqlite');
}

async function seed(repository: SqliteMindMapRepository): Promise<void> {
  await repository.save(source);
  await repository.save(target);
  await repository.link(link);
}

describe('SQLite mind map repository', () => {
  it('creates a versioned database, saves complete maps, and survives reopening', async () => {
    const path = temporaryDatabasePath();
    const first = new SqliteMindMapRepository(path);
    try {
      await seed(first);
    } finally {
      first.close();
    }
    const reopened = new SqliteMindMapRepository(path);
    cleanups.push(() => reopened.close());
    expect(await reopened.get(source.id)).toEqual(source);
    expect(await reopened.getLinks(source.id)).toEqual([link]);
    expect(await reopened.list()).toEqual([
      { id: 'source', title: 'Source' },
      { id: 'target', title: 'Target' },
    ]);
    expect(await reopened.get('missing')).toBeNull();
    const inspection = new DatabaseSync(path);
    try {
      expect(inspection.prepare('PRAGMA user_version').get()?.['user_version']).toBe(1);
    } finally {
      inspection.close();
    }
  });

  it('updates and reorders nodes without losing links on retained nodes', async () => {
    const repository = openMemoryRepository();
    await seed(repository);
    const updated: MindMap = { ...source, title: 'Updated', nodes: [...source.nodes].reverse() };
    await repository.save(updated);
    expect(await repository.get(source.id)).toEqual(updated);
    expect(await repository.getLinks(source.id)).toEqual([link]);
  });

  it('detaches a map without changing either independent map', async () => {
    const repository = openMemoryRepository();
    await seed(repository);
    await repository.unlink(source.id, 'child');
    expect(await repository.getLinks(source.id)).toEqual([]);
    expect(await repository.get(source.id)).toEqual(source);
    expect(await repository.get(target.id)).toEqual(target);
  });

  it('removes a source node and its link without deleting the target', async () => {
    const repository = openMemoryRepository();
    await seed(repository);
    await repository.save({ ...source, nodes: [] });
    expect(await repository.getLinks(source.id)).toEqual([]);
    expect(await repository.get(target.id)).toEqual(target);
  });

  it('deletes a source map without deleting its target', async () => {
    const repository = openMemoryRepository();
    await seed(repository);
    await repository.delete(source.id);
    expect(await repository.get(source.id)).toBeNull();
    expect(await repository.getLinks(source.id)).toEqual([]);
    expect(await repository.get(target.id)).toEqual(target);
  });

  it('cleans dangling incoming links when the target itself is deleted', async () => {
    const repository = openMemoryRepository();
    await seed(repository);
    await repository.delete(target.id);
    expect(await repository.getLinks(source.id)).toEqual([]);
    expect(await repository.get(source.id)).toEqual(source);
  });

  it('allows the same node ID in independent maps and safely stores SQL-like text', async () => {
    const repository = openMemoryRepository();
    const text = "'; DROP TABLE mind_maps; --";
    await repository.save(source);
    await repository.save({ ...source, id: 'other', title: text });
    expect(await repository.get('other')).toEqual({ ...source, id: 'other', title: text });
    expect(await repository.get(source.id)).toEqual(source);
  });

  it('rejects invalid writes and links without changing existing data', async () => {
    const repository = openMemoryRepository();
    await seed(repository);
    await expect(repository.save({
      ...source, nodes: [{ id: 'invalid', parentId: 'missing', text: '' }],
    })).rejects.toThrow(InvalidMindMapError);
    await expect(repository.link({ ...link, targetMapId: 'missing' })).rejects.toThrow(InvalidMindMapError);
    await expect(repository.link({ ...link, sourceNodeId: 'missing' })).rejects.toThrow(InvalidMindMapError);
    expect(await repository.get(source.id)).toEqual(source);
    expect(await repository.getLinks(source.id)).toEqual([link]);
  });

  it('rolls back the entire save when SQL fails midway', async () => {
    const path = temporaryDatabasePath();
    const repository = new SqliteMindMapRepository(path);
    cleanups.push(() => repository.close());
    await seed(repository);
    const inspection = new DatabaseSync(path);
    try {
      inspection.exec(`
        CREATE TRIGGER reject_fixture BEFORE INSERT ON mind_map_nodes
        WHEN NEW.id = 'reject'
        BEGIN SELECT RAISE(ABORT, 'fixture failure'); END
      `);
      await expect(repository.save({
        ...source,
        title: 'Must not persist',
        nodes: [...source.nodes, { id: 'reject', parentId: null, text: '' }],
      })).rejects.toThrow('fixture failure');
      expect(await repository.get(source.id)).toEqual(source);
      expect(await repository.getLinks(source.id)).toEqual([link]);
    } finally {
      inspection.close();
    }
  });

  it('refuses newer schemas without resetting user data', () => {
    const path = temporaryDatabasePath();
    const future = new DatabaseSync(path);
    future.exec('CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES (\'keep\'); PRAGMA user_version = 2;');
    future.close();
    expect(() => new SqliteMindMapRepository(path)).toThrow('unsupported schema version');
    const inspection = new DatabaseSync(path);
    try {
      expect(inspection.prepare('SELECT value FROM future_data').get()?.['value']).toBe('keep');
      expect(inspection.prepare('PRAGMA user_version').get()?.['user_version']).toBe(2);
    } finally {
      inspection.close();
    }
  });

  it('treats corrupted persisted structure as a storage error, not invalid renderer input', async () => {
    const path = temporaryDatabasePath();
    const repository = new SqliteMindMapRepository(path);
    cleanups.push(() => repository.close());
    await repository.save(source);
    const inspection = new DatabaseSync(path);
    try {
      inspection.exec('PRAGMA foreign_keys = OFF');
      inspection.exec("UPDATE mind_map_nodes SET parent_id = 'missing' WHERE id = 'child'");
      await expect(repository.get(source.id)).rejects.toThrow('Invalid map structure in local storage.');
      await expect(repository.get(source.id)).rejects.not.toBeInstanceOf(InvalidMindMapError);
    } finally {
      inspection.close();
    }
  });
});
