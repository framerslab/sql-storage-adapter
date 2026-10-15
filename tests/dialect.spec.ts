import { describe, it, expect } from 'vitest';
import { SqliteDialect } from '../src/dialects/SqliteDialect.js';
import { PostgresDialect } from '../src/dialects/PostgresDialect.js';

describe('SqliteDialect', () => {
  const d = new SqliteDialect();

  it('name is sqlite', () => {
    expect(d.name).toBe('sqlite');
  });

  it('insertOrIgnore returns INSERT OR IGNORE', () => {
    expect(d.insertOrIgnore('brain_meta', ['key', 'value'], ['?', '?']))
      .toBe('INSERT OR IGNORE INTO brain_meta (key, value) VALUES (?, ?)');
  });

  it('insertOrReplace updates the row in place instead of INSERT OR REPLACE, which deletes it first', () => {
    expect(d.insertOrReplace('brain_meta', ['key', 'value'], ['?', '?']))
      .toBe('INSERT INTO brain_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
  });

  it('jsonExtract returns json_extract()', () => {
    expect(d.jsonExtract('metadata', '$.scopeId'))
      .toBe("json_extract(metadata, '$.scopeId')");
  });

  it('ifnull returns ifnull()', () => {
    expect(d.ifnull("json_extract(metadata, '$.scopeId')", "''"))
      .toBe("ifnull(json_extract(metadata, '$.scopeId'), '')");
  });

  it('autoIncrementPrimaryKey returns AUTOINCREMENT', () => {
    expect(d.autoIncrementPrimaryKey())
      .toBe('INTEGER PRIMARY KEY AUTOINCREMENT');
  });

  it('pragma returns PRAGMA statement', () => {
    expect(d.pragma('journal_mode', 'WAL')).toBe('PRAGMA journal_mode = WAL');
    expect(d.pragma('foreign_keys', 'ON')).toBe('PRAGMA foreign_keys = ON');
  });

  it('placeholder returns ?', () => {
    expect(d.placeholder(0)).toBe('?');
    expect(d.placeholder(5)).toBe('?');
  });
});

describe('PostgresDialect', () => {
  const d = new PostgresDialect();

  it('name is postgres', () => {
    expect(d.name).toBe('postgres');
  });

  it('insertOrIgnore returns ON CONFLICT DO NOTHING', () => {
    expect(d.insertOrIgnore('brain_meta', ['key', 'value'], ['$1', '$2']))
      .toBe('INSERT INTO brain_meta (key, value) VALUES ($1, $2) ON CONFLICT DO NOTHING');
  });

  it('insertOrReplace returns ON CONFLICT DO UPDATE', () => {
    const result = d.insertOrReplace('brain_meta', ['key', 'value'], ['$1', '$2'], 'key');
    expect(result).toContain('ON CONFLICT (key) DO UPDATE SET');
    expect(result).toContain('value = EXCLUDED.value');
  });

  it('insertOrReplace defaults primaryKey to first column', () => {
    const result = d.insertOrReplace('brain_meta', ['key', 'value'], ['$1', '$2']);
    expect(result).toContain('ON CONFLICT (key) DO UPDATE SET');
  });

  it('jsonExtract returns ->> for simple paths', () => {
    expect(d.jsonExtract('metadata', '$.scopeId'))
      .toBe("(metadata::jsonb)->>'scopeId'");
  });

  it('jsonExtract handles nested paths', () => {
    expect(d.jsonExtract('metadata', '$.a.b'))
      .toContain('jsonb_extract_path_text');
  });

  it('ifnull returns COALESCE', () => {
    expect(d.ifnull('expr', "'fallback'"))
      .toBe("COALESCE(expr, 'fallback')");
  });

  it('autoIncrementPrimaryKey returns GENERATED ALWAYS AS IDENTITY', () => {
    expect(d.autoIncrementPrimaryKey())
      .toBe('INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY');
  });

  it('pragma returns null for most pragmas', () => {
    expect(d.pragma('journal_mode', 'WAL')).toBeNull();
    expect(d.pragma('foreign_keys', 'ON')).toBeNull();
  });

  it('placeholder returns $N (1-based)', () => {
    expect(d.placeholder(0)).toBe('$1');
    expect(d.placeholder(4)).toBe('$5');
  });
});
