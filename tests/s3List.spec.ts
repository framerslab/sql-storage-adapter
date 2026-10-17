import { describe, expect, it } from 'vitest';
import { S3StorageProvider } from '../src/features/backup/cloudBackup';

/** A client that answers ListObjectsV2 in pages of two keys, as S3 does with its continuation token. */
function pagedClient(keys: string[]): { send: (command: unknown) => Promise<unknown>; calls: number } {
  const client = {
    calls: 0,
    send: async (command: unknown) => {
      client.calls += 1;
      const input = (command as { input: { Prefix?: string; ContinuationToken?: string } }).input;
      const start = input.ContinuationToken === undefined ? 0 : Number(input.ContinuationToken);
      const page = keys.filter((key) => key.startsWith(input.Prefix ?? '')).slice(start, start + 2);
      const more = start + 2 < keys.length;
      return { Contents: page.map((Key) => ({ Key })), IsTruncated: more, NextContinuationToken: more ? String(start + 2) : undefined };
    },
  };
  return client;
}

describe('S3StorageProvider.list', () => {
  it('reads every page of a prefix', async () => {
    const keys = ['fences/a', 'fences/b', 'fences/c', 'fences/d', 'fences/e'];
    const client = pagedClient(keys);
    expect(await new S3StorageProvider(client, 'bucket').list('fences/')).toEqual(keys);
    expect(client.calls).toBe(3);
  });
});
