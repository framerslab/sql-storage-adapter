/**
 * The cadence of a client's sync: a cycle pushes then pulls; it runs at start, on a save (at once), when the page
 * becomes visible, on reconnecting and on sign-in, and every `pullEveryMs` while the page is visible. A failed cycle is
 * tried again after `firstRetryMs`, doubling to `maxRetryMs`; a rate refusal waits as long as it asks, and a kick during
 * that wait, or during the cycle the refusal ended, runs nothing before the wait is over. One cycle runs at a time; a
 * kick during a cycle runs one more after it. A stop ends the run: a cycle still running when it came schedules
 * nothing, even when the loop starts again before that cycle ends.
 */
import type { SyncOutcome } from './client';

/** The part of a client the loop drives. */
export interface LoopClient {
  push(): Promise<SyncOutcome>;
  pull(): Promise<SyncOutcome>;
}

/** The loop's settings. */
export interface SyncLoopOptions {
  client: LoopClient;
  /** Default 60,000. */
  pullEveryMs?: number;
  /** Default 2,000. */
  firstRetryMs?: number;
  /** Default 300,000. */
  maxRetryMs?: number;
  /** Whether the page is visible; true when left out. */
  visible?: () => boolean;
  /** Told of every failed cycle; an error it throws is dropped and the retry stands. */
  onError?: (error: unknown) => void;
}

/** Why the loop was kicked. */
export type KickReason = 'load' | 'save' | 'visible' | 'online' | 'sign_in' | 'timer';

/** The loop. */
export class SyncLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private again = false;
  private stopped = true;
  /** A rate refusal's wait is running: a kick runs nothing until its timer does. */
  private holding = false;
  /** Counts the stops, so a cycle a stop overtook sees another count when it ends. */
  private stops = 0;
  private retryMs: number;

  constructor(private readonly options: SyncLoopOptions) {
    this.retryMs = options.firstRetryMs ?? 2000;
  }

  /** Starts with a cycle at once; its retries begin from `firstRetryMs` again. */
  start(): void {
    this.stopped = false;
    this.retryMs = this.options.firstRetryMs ?? 2000;
    this.kick('load');
  }

  /**
   * Stops; a running cycle ends and schedules nothing, even when the loop starts again before it ends, and a rate
   * refusal's wait is dropped.
   */
  stop(): void {
    this.stopped = true;
    this.stops += 1;
    this.again = false;
    this.holding = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Runs a cycle now, or one more after the running one; while a rate refusal's wait runs, nothing. */
  kick(_reason: KickReason): void {
    if (this.stopped || this.holding) return;
    if (this.running) {
      this.again = true;
      return;
    }
    void this.cycle();
  }

  private async cycle(): Promise<void> {
    const stops = this.stops;
    this.running = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    let wait: number | null = null;
    let hidden = false;
    let failed = false;
    try {
      for (let round = 0; round < 5; round += 1) {
        const pushed = await this.options.client.push();
        if (pushed.kind === 'wait') {
          wait = pushed.ms;
          break;
        }
        if (pushed.kind === 'resend') continue;
        const pulled = await this.options.client.pull();
        if (pulled.kind === 'wait') {
          wait = pulled.ms;
          break;
        }
        // after a recovery the rebuilt mutations go again at once
        if (pushed.kind === 'recovering' || pulled.kind === 'recovering') continue;
        break;
      }
      hidden = wait === null && !(this.options.visible?.() ?? true);
    } catch (error) {
      failed = true;
      try {
        this.options.onError?.(error);
      } catch {
        // the listener's own failure is dropped: the retry below still stands
      }
    } finally {
      this.running = false;
    }
    if (this.stopped) return;
    if (stops !== this.stops) {
      // the loop stopped and started again while this cycle ran: its outcome was the stopped run's, and the new run's
      // first kick, held while this cycle ran, runs now
      this.again = false;
      void this.cycle();
      return;
    }
    let next: number | null;
    if (failed) {
      next = this.retryMs;
      this.retryMs = Math.min(this.retryMs * 2, this.options.maxRetryMs ?? 300_000);
    } else {
      this.retryMs = this.options.firstRetryMs ?? 2000;
      next = wait ?? (hidden ? null : (this.options.pullEveryMs ?? 60_000));
    }
    const refused = !failed && wait !== null;
    if (this.again) {
      this.again = false;
      // a kick during a refused cycle is served by the cycle its wait's timer runs
      if (!refused) {
        void this.cycle();
        return;
      }
    }
    if (next === null) return;
    this.holding = refused;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.holding = false;
      this.kick('timer');
    }, next);
  }
}

/** Kicks the loop when the page becomes visible, regains focus or comes back online; answers the detach. */
export function attachSyncLoop(loop: SyncLoop, page: { window: Window; document: Document }): () => void {
  const onVisible = (): void => {
    if (page.document.visibilityState === 'visible') loop.kick('visible');
  };
  const onOnline = (): void => loop.kick('online');
  page.document.addEventListener('visibilitychange', onVisible);
  page.window.addEventListener('online', onOnline);
  page.window.addEventListener('focus', onVisible);
  return () => {
    page.document.removeEventListener('visibilitychange', onVisible);
    page.window.removeEventListener('online', onOnline);
    page.window.removeEventListener('focus', onVisible);
  };
}
