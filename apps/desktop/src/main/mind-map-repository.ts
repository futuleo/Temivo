import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';

import { assertMapId, assertMapLink, assertMindMap, InvalidMindMapError } from '@temivo/core';
import type { MapLink, MindMap, MindMapRepository, MindMapSummary } from '@temivo/core';

const SCHEMA_VERSION = 1;
const INITIAL_SCHEMA = `
  CREATE TABLE mind_maps (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL
  ) STRICT;
  CREATE TABLE mind_map_nodes (
    map_id TEXT NOT NULL REFERENCES mind_maps(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    parent_id TEXT,
    text TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (map_id, id),
    FOREIGN KEY (map_id, parent_id) REFERENCES mind_map_nodes(map_id, id)
      DEFERRABLE INITIALLY DEFERRED
  ) STRICT;
  CREATE TABLE map_links (
    source_map_id TEXT NOT NULL,
    source_node_id TEXT NOT NULL,
    target_map_id TEXT NOT NULL REFERENCES mind_maps(id) ON DELETE CASCADE,
    PRIMARY KEY (source_map_id, source_node_id),
    FOREIGN KEY (source_map_id, source_node_id)
      REFERENCES mind_map_nodes(map_id, id) ON DELETE CASCADE,
    CHECK (source_map_id <> target_map_id)
  ) STRICT;
  CREATE INDEX map_links_target ON map_links(target_map_id);
`;

function textColumn(row: Record<string, SQLOutputValue>, name: string): string {
  const value = row[name];
  if (typeof value !== 'string') throw new Error('Invalid text column in the maps database.');
  return value;
}

export class SqliteMindMapRepository implements MindMapRepository {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    try {
      this.database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      this.transaction(() => {
        const version = this.database.prepare('PRAGMA user_version').get()?.['user_version'];
        if (typeof version !== 'number' || version > SCHEMA_VERSION) {
          throw new Error('The maps database has an unsupported schema version.');
        }
        if (version === 0) {
          this.database.exec(INITIAL_SCHEMA);
          this.database.exec('PRAGMA user_version = 1');
        }
      });
      this.database.exec('PRAGMA journal_mode = WAL');
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  async list(): Promise<readonly MindMapSummary[]> {
    return this.database.prepare('SELECT id, title FROM mind_maps ORDER BY id').all().map((row) => ({
      id: textColumn(row, 'id'),
      title: textColumn(row, 'title'),
    }));
  }

  async get(id: string): Promise<MindMap | null> {
    assertMapId(id);
    const row = this.database.prepare('SELECT id, title FROM mind_maps WHERE id = ?').get(id);
    if (!row) return null;
    const nodes = this.database.prepare(
      'SELECT id, parent_id, text FROM mind_map_nodes WHERE map_id = ? ORDER BY position',
    ).all(id).map((node) => ({
      id: textColumn(node, 'id'),
      parentId: node['parent_id'] === null ? null : textColumn(node, 'parent_id'),
      text: textColumn(node, 'text'),
    }));
    const map = { id: textColumn(row, 'id'), title: textColumn(row, 'title'), nodes };
    try {
      assertMindMap(map);
    } catch (error) {
      throw new Error('Invalid map structure in local storage.', { cause: error });
    }
    return map;
  }

  async save(map: MindMap): Promise<void> {
    assertMindMap(map);
    this.transaction(() => {
      this.database.prepare(
        'INSERT INTO mind_maps (id, title) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET title = excluded.title',
      ).run(map.id, map.title);
      const upsertNode = this.database.prepare(`
        INSERT INTO mind_map_nodes (map_id, id, parent_id, text, position) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (map_id, id) DO UPDATE SET
          parent_id = excluded.parent_id, text = excluded.text, position = excluded.position
      `);
      map.nodes.forEach((node, position) => {
        upsertNode.run(map.id, node.id, node.parentId, node.text, position);
      });
      const retained = new Set(map.nodes.map(({ id }) => id));
      const deleteNode = this.database.prepare('DELETE FROM mind_map_nodes WHERE map_id = ? AND id = ?');
      for (const row of this.database.prepare('SELECT id FROM mind_map_nodes WHERE map_id = ?').all(map.id)) {
        const id = textColumn(row, 'id');
        if (!retained.has(id)) deleteNode.run(map.id, id);
      }
    });
  }

  async delete(id: string): Promise<void> {
    assertMapId(id);
    this.database.prepare('DELETE FROM mind_maps WHERE id = ?').run(id);
  }

  async getLinks(sourceMapId: string): Promise<readonly MapLink[]> {
    assertMapId(sourceMapId);
    return this.database.prepare(`
      SELECT source_map_id, source_node_id, target_map_id FROM map_links
      WHERE source_map_id = ? ORDER BY source_node_id
    `).all(sourceMapId).map((row) => ({
      sourceMapId: textColumn(row, 'source_map_id'),
      sourceNodeId: textColumn(row, 'source_node_id'),
      targetMapId: textColumn(row, 'target_map_id'),
    }));
  }

  async link(link: MapLink): Promise<void> {
    assertMapLink(link);
    const source = this.database.prepare(
      'SELECT id FROM mind_map_nodes WHERE map_id = ? AND id = ?',
    ).get(link.sourceMapId, link.sourceNodeId);
    const target = this.database.prepare('SELECT id FROM mind_maps WHERE id = ?').get(link.targetMapId);
    if (!source || !target) {
      throw new InvalidMindMapError('The source node and target map must exist before linking.');
    }
    this.database.prepare(`
      INSERT INTO map_links (source_map_id, source_node_id, target_map_id) VALUES (?, ?, ?)
      ON CONFLICT (source_map_id, source_node_id) DO UPDATE SET target_map_id = excluded.target_map_id
    `).run(link.sourceMapId, link.sourceNodeId, link.targetMapId);
  }

  async unlink(sourceMapId: string, sourceNodeId: string): Promise<void> {
    assertMapId(sourceMapId);
    assertMapId(sourceNodeId);
    this.database.prepare(
      'DELETE FROM map_links WHERE source_map_id = ? AND source_node_id = ?',
    ).run(sourceMapId, sourceNodeId);
  }

  close(): void {
    this.database.close();
  }

  private transaction(action: () => void): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      action();
      this.database.exec('COMMIT');
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
