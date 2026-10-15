import { describe, expect, it } from 'vitest';
import { decodeValue, encodeValue } from '../../src/features/kv/valueCodec.js';

// The SQL key-value store keeps each value as text. A value must come back as
// the structured clone, which IndexedDB applies, gives it back: the browser
// store and the SQL store then answer alike, and a copy from one into the other
// can be checked value by value. Node's structuredClone is V8's, Chrome's.

/** The value as the SQL store gives it back. */
const roundTrip = <T>(value: T): T => decodeValue(encodeValue(value)) as T;

class Point {
  constructor(
    public x: number,
    public y: number,
  ) {}

  length(): number {
    return Math.hypot(this.x, this.y);
  }
}

const values: Array<[string, unknown]> = [
  ['a string', 'notes | kw: a'],
  ['an empty string', ''],
  ['a string with a lone surrogate', 'a\ud800b'],
  ['zero', 0],
  ['negative zero', -0],
  ['a fraction', 1.5],
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['the largest safe integer', Number.MAX_SAFE_INTEGER],
  ['true', true],
  ['false', false],
  ['null', null],
  ['undefined', undefined],
  ['a bigint', 12345678901234567890123n],
  ['a negative bigint', -42n],
  ['an object', { text: '## Note', saved: 1, tags: ['a', 'b'], nested: { deep: { deeper: null } } }],
  ['an object with an undefined property', { kept: undefined, other: 1 }],
  ['an empty object', {}],
  ['an array', [1, 'two', null, { three: 3 }]],
  ['an empty array', []],
  // eslint-disable-next-line no-sparse-arrays
  ['an array with holes', [1, , 3, , ]],
  ['an array with a property of its own', Object.assign([1, 2], { label: 'extra' })],
  ['a date', new Date(Date.UTC(2026, 9, 15, 12, 30))],
  ['a regular expression', /ab+c/gi],
  ['a map', new Map<unknown, unknown>([[1, 'one'], ['k', { v: 2 }], [{ key: 'object' }, [3]]])],
  ['a set', new Set<unknown>([1, 'two', 3n, { four: 4 }])],
  ['an ArrayBuffer', new Uint8Array([0, 1, 2, 253, 254, 255]).buffer],
  ['an empty ArrayBuffer', new ArrayBuffer(0)],
  ['a Uint8Array', new Uint8Array([1, 2, 3])],
  ['a Float64Array with negative zero and NaN', new Float64Array([1.5, -0, NaN])],
  ['an Int32Array', new Int32Array([-1, 2 ** 31 - 1])],
  ['a BigInt64Array', new BigInt64Array([1n, -2n])],
  ['a view into part of a buffer', new Uint16Array(new ArrayBuffer(16), 4, 3)],
  ['a DataView', new DataView(new Uint8Array([9, 8, 7, 6]).buffer, 1, 2)],
  ['a boxed number', new Number(3)],
  ['a boxed string', new String('boxed')],
  ['a boxed boolean', new Boolean(false)],
  ['a class instance, which comes back a plain object', new Point(3, 4)],
  ['an object with no prototype', Object.assign(Object.create(null) as object, { a: 1 })],
  ['a TypeError', new TypeError('bad input')],
  ['an Error', new Error('plain')],
];

describe('the SQL key-value store value text', () => {
  it.each(values)('gives back %s as structuredClone does', (_name, value) => {
    expect(roundTrip(value)).toStrictEqual(structuredClone(value));
  });

  it('keeps negative zero apart from zero', () => {
    expect(Object.is(roundTrip(-0), -0)).toBe(true);
    expect(Object.is(roundTrip({ n: -0 }).n, -0)).toBe(true);
  });

  it('gives back an invalid date as an invalid date', () => {
    const back = roundTrip(new Date(Number.NaN));
    expect(back).toBeInstanceOf(Date);
    expect(Number.isNaN(back.getTime())).toBe(true);
  });

  it('keeps the order of an object\'s keys', () => {
    expect(Object.keys(roundTrip({ b: 1, a: 2, 10: 'x', 2: 'y' }))).toEqual(['2', '10', 'b', 'a']);
  });

  it('keeps one object one object where it is reached twice', () => {
    const shared = { x: 1 };
    const back = roundTrip({ first: shared, second: shared, list: [shared] });

    expect(back.first).toBe(back.second);
    expect(back.list[0]).toBe(back.first);
  });

  it('keeps a cycle', () => {
    const cyclic: { name: string; self?: unknown; children: unknown[] } = { name: 'loop', children: [] };
    cyclic.self = cyclic;
    cyclic.children.push(cyclic);

    const back = roundTrip(cyclic);
    expect(back.self).toBe(back);
    expect(back.children[0]).toBe(back);
  });

  it('keeps two views of one buffer on one buffer', () => {
    const buffer = new ArrayBuffer(8);
    const back = roundTrip({ whole: new Uint8Array(buffer), part: new Uint8Array(buffer, 2, 2) });

    expect(back.part.buffer).toBe(back.whole.buffer);
    back.whole[2] = 7;
    expect(back.part[0]).toBe(7);
  });

  it('keeps the name, message and stack of an error, and its class', () => {
    const error = new RangeError('out of range');
    const back = roundTrip(error);

    expect(back).toBeInstanceOf(RangeError);
    expect(back.name).toBe('RangeError');
    expect(back.message).toBe('out of range');
    expect(back.stack).toBe(error.stack);
  });

  it('keeps the cause of an error', () => {
    const back = roundTrip(new Error('outer', { cause: { inner: 'why' } }));

    expect(back.message).toBe('outer');
    expect(back.cause).toEqual({ inner: 'why' });
  });

  it('comes back as an Error for an error of a class of its own, as structuredClone does', () => {
    class AppError extends Error {
      code = 'E_APP';
    }
    const back = roundTrip(new AppError('custom'));

    expect(back).toStrictEqual(structuredClone(new AppError('custom')));
    expect(Object.getPrototypeOf(back)).toBe(Error.prototype);
  });

  it.each([
    ['a function', () => 1],
    ['a symbol', Symbol('s')],
    ['an object holding a function', { run: () => 1 }],
    ['a WeakMap', new WeakMap()],
    ['a WeakSet', new WeakSet()],
    ['a promise', Promise.resolve(1)],
  ])('refuses %s, as structuredClone and IndexedDB do', (_name, value) => {
    expect(() => structuredClone(value)).toThrow();
    let refused: unknown;
    try {
      encodeValue(value);
    } catch (error) {
      refused = error;
    }
    expect((refused as { name?: string } | undefined)?.name).toBe('DataCloneError');
  });

  it('writes text that holds no NUL character, which PostgreSQL text refuses', () => {
    const text = encodeValue({ nul: 'a\u0000b', bytes: new Uint8Array([0, 0, 0]) });

    expect(text.includes('\u0000')).toBe(false);
    expect(roundTrip({ nul: 'a\u0000b' })).toEqual({ nul: 'a\u0000b' });
  });
});
