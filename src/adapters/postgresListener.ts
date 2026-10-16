import { checkChannelName } from '../dialects/shared';
import { getStorageLogger } from '../shared/logger';
import type { PostgresPoolClientLike } from './postgresAdapter';

/** Called with each notification's payload ('' when it has none) and its channel. */
export type PostgresNotificationHandler = (payload: string, channel: string) => void;

/** A pg client as LISTEN uses it: an event emitter that delivers notifications. */
interface NotifyingClient extends PostgresPoolClientLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}

/** Holds a connection error that arrives while the connection is handed back, which would otherwise end the process. */
const ignoreError = (): void => undefined;

const FIRST_RETRY_MS = 1_000;
const LAST_RETRY_MS = 30_000;

/** The channel as a quoted identifier, so LISTEN keeps its case as pg_notify() does. */
const quoted = (channel: string): string => `"${channel.replace(/"/g, '""')}"`;

/**
 * The PostgreSQL adapter's LISTEN side: one connection held from the pool for
 * as long as a channel has a handler, which listens on every channel. When the
 * server ends that connection, the listener takes another and listens again,
 * after 1 second, then 2, up to 30; notifications sent in between are lost,
 * since PostgreSQL keeps none for a session that is not listening
 * (https://www.postgresql.org/docs/current/sql-notify.html).
 */
export class PostgresListener {
  private client: NotifyingClient | null = null;
  private detach: (() => void) | null = null;
  private connecting: Promise<void> | null = null;
  private readonly handlers = new Map<string, Set<PostgresNotificationHandler>>();
  private retry: ReturnType<typeof setTimeout> | null = null;
  private delay = FIRST_RETRY_MS;
  private closed = false;

  constructor(private readonly connect: () => Promise<PostgresPoolClientLike>) {}

  /** Calls `handler` with each notification on `channel`. Resolves, once listening, to a function that stops it. */
  async listen(channel: string, handler: PostgresNotificationHandler): Promise<() => Promise<void>> {
    checkChannelName(channel);
    if (this.closed) throw new Error('The adapter is closed; it listens on no channel.');
    let set = this.handlers.get(channel);
    const first = !set;
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);
    try {
      await this.ensureConnected();
      // A connection made before this channel's handler was added listens on it now.
      if (first && this.client) await this.client.query(`LISTEN ${quoted(channel)}`);
    } catch (error) {
      this.drop(channel, handler);
      throw error;
    }
    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      const last = this.drop(channel, handler);
      if (!last || !this.client) return;
      if (this.handlers.size === 0) {
        this.release();
        return;
      }
      await this.client.query(`UNLISTEN ${quoted(channel)}`);
    };
  }

  /** Stops listening and hands the connection back. */
  close(): void {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.handlers.clear();
    this.release();
  }

  /** Takes `handler` off `channel`; true when the channel has none left. */
  private drop(channel: string, handler: PostgresNotificationHandler): boolean {
    const set = this.handlers.get(channel);
    if (!set) return false;
    set.delete(handler);
    if (set.size > 0) return false;
    this.handlers.delete(channel);
    return true;
  }

  private ensureConnected(): Promise<void> {
    if (this.client) return Promise.resolve();
    if (!this.connecting) {
      this.connecting = this.open().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async open(): Promise<void> {
    const client = (await this.connect()) as NotifyingClient;
    if (typeof client.on !== 'function' || typeof client.removeListener !== 'function') {
      client.release();
      throw new Error("This pool's connections are not event emitters, so they cannot deliver notifications.");
    }
    const onNotification = (message: { channel: string; payload?: string }): void => this.dispatch(message.channel, message.payload ?? '');
    const onError = (error: Error): void => this.lost(client, error);
    const onEnd = (): void => this.lost(client, new Error('The listening connection ended.'));
    client.on('notification', onNotification);
    client.on('error', onError);
    client.on('end', onEnd);
    const detach = (): void => {
      client.removeListener('notification', onNotification);
      client.removeListener('error', onError);
      client.removeListener('end', onEnd);
    };
    try {
      for (const channel of this.handlers.keys()) await client.query(`LISTEN ${quoted(channel)}`);
    } catch (error) {
      detach();
      client.release(error instanceof Error ? error : true);
      throw error;
    }
    if (this.closed || this.handlers.size === 0) {
      detach();
      client.release(true);
      return;
    }
    this.client = client;
    this.detach = detach;
    this.delay = FIRST_RETRY_MS;
  }

  private dispatch(channel: string, payload: string): void {
    for (const handler of [...(this.handlers.get(channel) ?? [])]) {
      try {
        handler(payload, channel);
      } catch (error) {
        getStorageLogger().warn(
          { adapter: 'postgres', channel, error: error instanceof Error ? error.message : String(error) },
          `A notification handler on channel "${channel}" failed; the listener goes on.`,
        );
      }
    }
  }

  /** The listening connection broke: close it, and listen again on a new one if a channel still has a handler. */
  private lost(client: NotifyingClient, error: Error): void {
    if (this.client !== client) return;
    this.detach?.();
    this.detach = null;
    this.client = null;
    client.release(error);
    if (this.closed || this.handlers.size === 0) return;
    const wait = this.delay;
    this.delay = Math.min(this.delay * 2, LAST_RETRY_MS);
    getStorageLogger().warn(
      { adapter: 'postgres', channels: this.handlers.size, error: error.message, retryMs: wait },
      `The PostgreSQL connection that listens for notifications ended (${error.message}); listening again in ${wait} ms. ` +
        'Notifications sent until then are lost.',
    );
    this.schedule(wait);
  }

  private schedule(wait: number): void {
    if (this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.closed || this.handlers.size === 0) return;
      this.ensureConnected().then(
        () => {
          getStorageLogger().info({ adapter: 'postgres', channels: this.handlers.size }, 'Listening for PostgreSQL notifications again.');
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          const next = this.delay;
          this.delay = Math.min(this.delay * 2, LAST_RETRY_MS);
          getStorageLogger().warn(
            { adapter: 'postgres', error: message, retryMs: next },
            `Listening for PostgreSQL notifications again failed (${message}); trying again in ${next} ms.`,
          );
          this.schedule(next);
        },
      );
    }, wait);
  }

  /** Hands the connection back to the pool, listening on nothing. */
  private release(): void {
    const client = this.client;
    if (!client) return;
    client.on('error', ignoreError);
    this.detach?.();
    this.detach = null;
    this.client = null;
    // UNLISTEN * clears the session's channels before the pool hands it out again.
    const handBack = (error?: Error | boolean): void => {
      client.release(error);
      client.removeListener('error', ignoreError);
    };
    client.query('UNLISTEN *').then(
      () => handBack(),
      (error: unknown) => handBack(error instanceof Error ? error : true),
    );
  }
}
