import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresListener } from '../src/adapters/postgresListener.js';
import type { PostgresPoolClientLike, PostgresQueryResultLike } from '../src/adapters/postgresAdapter.js';
import { PostgresDialect } from '../src/dialects/PostgresDialect.js';
import { setStorageLogger } from '../src/shared/logger.js';

// Real notification delivery, backend termination, handler failures and
// UNLISTEN run against CI's server in changeEvents.spec.ts. These clients
// control failures and the exact instant a pool acquisition/query settles.
class Client extends EventEmitter implements PostgresPoolClientLike {
  query = vi.fn<(text: string) => Promise<PostgresQueryResultLike>>(async () => ({ rows: [] }));
  release = vi.fn<(error?: Error | boolean) => void>();
}

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe('PostgreSQL listener connection races', () => {
  const listeners: PostgresListener[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const listenerFor = (connect: () => Promise<PostgresPoolClientLike>): PostgresListener => {
    const listener = new PostgresListener(connect);
    listeners.push(listener);
    return listener;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    setStorageLogger(logger);
  });

  afterEach(async () => {
    for (const listener of listeners.splice(0)) listener.close();
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    setStorageLogger(null);
  });

  it('shares an in-flight acquisition and dispatches empty payloads only to the named channel', async () => {
    const pending = deferred<PostgresPoolClientLike>();
    const client = new Client();
    const connect = vi.fn(() => pending.promise);
    const listener = listenerFor(connect);
    const first = vi.fn();
    const second = vi.fn();
    const a = listener.listen('first', first);
    const b = listener.listen('second', second);
    pending.resolve(client);
    await Promise.all([a, b]);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith('LISTEN "first"');
    expect(client.query).toHaveBeenCalledWith('LISTEN "second"');
    client.emit('notification', { channel: 'unknown', payload: 'ignored' });
    client.emit('notification', { channel: 'first' });
    expect(first).toHaveBeenCalledExactlyOnceWith('', 'first');
    expect(second).not.toHaveBeenCalled();
  });

  it('refuses a pool client without notification events and drops the failed subscription', async () => {
    const plain = { query: vi.fn(), release: vi.fn() };
    const client = new Client();
    const connect = vi.fn<() => Promise<PostgresPoolClientLike>>()
      .mockResolvedValueOnce(plain).mockResolvedValue(client);
    const listener = listenerFor(connect);
    await expect(listener.listen('failed', vi.fn())).rejects.toThrow('not event emitters');
    expect(plain.release).toHaveBeenCalledTimes(1);
    await listener.listen('working', vi.fn());
    expect(client.query.mock.calls.every(([sql]) => sql === 'LISTEN "working"')).toBe(true);
  });

  it.each([new Error('LISTEN failed'), 'LISTEN failed'])('discards a client whose initial LISTEN fails: %s', async (error) => {
    const broken = new Client();
    broken.query.mockRejectedValueOnce(error);
    const working = new Client();
    const connect = vi.fn<() => Promise<PostgresPoolClientLike>>()
      .mockResolvedValueOnce(broken).mockResolvedValue(working);
    const listener = listenerFor(connect);
    await expect(listener.listen('failed', vi.fn())).rejects.toBe(error);
    expect(broken.release).toHaveBeenCalledExactlyOnceWith(error instanceof Error ? error : true);
    expect(broken.eventNames()).toEqual([]);
    const handler = vi.fn();
    await listener.listen('working', handler);
    working.emit('notification', { channel: 'working', payload: 'ready' });
    expect(handler).toHaveBeenCalledExactlyOnceWith('ready', 'working');
    expect(working.query.mock.calls.every(([sql]) => sql === 'LISTEN "working"')).toBe(true);
  });

  it('backs off failed reconnects up to thirty seconds and restores delivery after an end event', async () => {
    const original = new Client();
    const replacement = new Client();
    const connect = vi.fn<() => Promise<PostgresPoolClientLike>>()
      .mockResolvedValueOnce(original)
      .mockRejectedValueOnce(new Error('server restarting'))
      .mockRejectedValueOnce('still restarting')
      .mockRejectedValueOnce(new Error('still restarting'))
      .mockRejectedValueOnce(new Error('still restarting'))
      .mockRejectedValueOnce(new Error('still restarting'))
      .mockRejectedValueOnce(new Error('still restarting'))
      .mockResolvedValue(replacement);
    const listener = listenerFor(connect);
    const handler = vi.fn();
    await listener.listen('changes', handler);
    // pg_terminate_backend sends an error first. An end without an error is
    // forced here so both connection-loss entry points are exercised.
    original.emit('end');
    expect(original.release).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'The listening connection ended.' }));
    expect(original.eventNames()).toEqual([]);
    for (const [index, delay] of [1000, 2000, 4000, 8000, 16000, 30000, 30000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(connect).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(connect).toHaveBeenCalledTimes(index + 2);
    }
    expect(replacement.query).toHaveBeenCalledWith('LISTEN "changes"');
    original.emit('notification', { channel: 'changes', payload: 'stale' });
    replacement.emit('notification', { channel: 'changes', payload: 'back' });
    expect(handler).toHaveBeenCalledExactlyOnceWith('back', 'changes');
    expect(logger.info).toHaveBeenCalledWith({ adapter: 'postgres', channels: 1 }, expect.stringContaining('again'));
    replacement.emit('error', new Error('lost again'));
    expect(logger.warn).toHaveBeenLastCalledWith(
      expect.objectContaining({ retryMs: 1000 }), expect.any(String),
    );
  });

  it('cancels a scheduled reconnect on close and refuses new subscriptions', async () => {
    const client = new Client();
    const connect = vi.fn(async () => client);
    const listener = listenerFor(connect);
    const stop = await listener.listen('changes', vi.fn());
    client.emit('end');
    listener.close();
    await stop();
    await stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledTimes(1);
    await expect(listener.listen('changes', vi.fn())).rejects.toThrow('adapter is closed');
  });

  it('does not reconnect after the last subscriber leaves during the retry delay', async () => {
    const client = new Client();
    const connect = vi.fn(async () => client);
    const listener = listenerFor(connect);
    const stop = await listener.listen('changes', vi.fn());
    client.emit('end');
    await stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['close', 'unsubscribe'] as const)('discards a reconnect that arrives after %s', async (action) => {
    const original = new Client();
    const replacement = new Client();
    const pending = deferred<PostgresPoolClientLike>();
    const connect = vi.fn<() => Promise<PostgresPoolClientLike>>()
      .mockResolvedValueOnce(original).mockReturnValueOnce(pending.promise);
    const listener = listenerFor(connect);
    const handler = vi.fn();
    const stop = await listener.listen('changes', handler);
    original.emit('end');
    await vi.advanceTimersByTimeAsync(1000);
    expect(connect).toHaveBeenCalledTimes(2);
    if (action === 'close') listener.close();
    else await stop();
    pending.resolve(replacement);
    await vi.advanceTimersByTimeAsync(0);
    expect(replacement.query).not.toHaveBeenCalled();
    expect(replacement.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(replacement.eventNames()).toEqual([]);
    replacement.emit('notification', { channel: 'changes', payload: 'late' });
    expect(handler).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['close', 'unsubscribe'] as const)('does not schedule another retry when an acquisition rejects after %s', async (action) => {
    const original = new Client();
    const pending = deferred<PostgresPoolClientLike>();
    const connect = vi.fn<() => Promise<PostgresPoolClientLike>>()
      .mockResolvedValueOnce(original).mockReturnValueOnce(pending.promise);
    const listener = listenerFor(connect);
    const stop = await listener.listen('changes', vi.fn());
    original.emit('end');
    await vi.advanceTimersByTimeAsync(1000);
    if (action === 'close') listener.close();
    else await stop();
    pending.reject(new Error('pool closed during acquisition'));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it.each([new Error('UNLISTEN failed'), 'UNLISTEN failed'])('discards a connection when clearing its channels fails: %s', async (error) => {
    const client = new Client();
    const listener = listenerFor(async () => client);
    const handler = vi.fn();
    const stop = await listener.listen('changes', handler);
    const clearing = deferred<PostgresQueryResultLike>();
    client.query.mockReturnValueOnce(clearing.promise);
    await stop();
    expect(client.query).toHaveBeenLastCalledWith('UNLISTEN *');
    expect(client.release).not.toHaveBeenCalled();
    // The temporary error handler keeps a disconnect during UNLISTEN from
    // becoming an unhandled EventEmitter error.
    expect(() => client.emit('error', new Error('socket closed'))).not.toThrow();
    client.emit('notification', { channel: 'changes', payload: 'late' });
    clearing.reject(error);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(error instanceof Error ? error : true);
    expect(client.eventNames()).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(['', 'x'.repeat(64), 'bad\0channel'])('rejects an invalid channel before acquiring a connection: %j', async (channel) => {
    const connect = vi.fn(async () => new Client());
    const listener = listenerFor(connect);
    await expect(listener.listen(channel, vi.fn())).rejects.toThrow('1 to 63 characters without NUL');
    expect(() => new PostgresDialect().changeNotificationSql('notes', channel)).toThrow('1 to 63 characters without NUL');
    expect(connect).not.toHaveBeenCalled();
  });
});
