/**
 * Counters of the mutation sync: mutation ids, versions and cookies travel as decimal strings, since a Postgres
 * `bigint` reaches JavaScript as text, and are read back as safe integers before any arithmetic. The first mutation id
 * is 1, a version starts at 0, and neither wraps or is reused.
 */

/** A counter that is not a safe non-negative integer; the message names no value. */
export class CounterError extends Error {
  constructor() {
    super('a counter is a safe non-negative integer written in decimal');
    this.name = 'CounterError';
  }
}

const DECIMAL = /^(?:0|[1-9][0-9]{0,15})$/;

/** Reads a counter: decimal text, a number or a bigint of a safe non-negative integer. Anything else throws. */
export function readCounter(value: unknown): number {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= 0) return value;
    throw new CounterError();
  }
  if (typeof value === 'bigint') {
    if (value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
    throw new CounterError();
  }
  if (typeof value !== 'string' || !DECIMAL.test(value)) throw new CounterError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new CounterError();
  return parsed;
}

/** Writes a counter as decimal text. */
export function writeCounter(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new CounterError();
  return String(value);
}

/** The counter after `value`; it never passes `Number.MAX_SAFE_INTEGER`. */
export function nextCounter(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER) throw new CounterError();
  return value + 1;
}
