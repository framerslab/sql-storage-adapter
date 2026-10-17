/**
 * @fileoverview The text the SQL key-value store keeps each value as. A value comes back as the structured clone,
 * which IndexedDB applies to every value it stores, gives it back: the SQL store and the IndexedDB store then answer
 * alike, and a copy from one into the other can be checked value by value.
 *
 * What comes back, as the structured clone gives it (V8's serializer, which Chrome and Node.js run, is the model):
 * strings (lone surrogates too), numbers (`-0`, `NaN` and the infinities too), booleans, `null`, `undefined`,
 * bigints; plain objects and class instances as plain objects with their own enumerable string-keyed properties, in
 * order; arrays with their holes and their own properties; `Date`, `RegExp` (source and flags), `Map`, `Set`,
 * `ArrayBuffer`, the typed arrays and `DataView` (a view keeps its buffer, its offset and its length, and two views of
 * one buffer share it); `Number`, `String`, `Boolean` and `BigInt` objects; errors, as `Error`, `EvalError`,
 * `RangeError`, `ReferenceError`, `SyntaxError`, `TypeError` or `URIError` by their name, with their message, stack
 * and cause. An object reached twice comes back as one object, and a cycle as a cycle.
 *
 * Refused with a `DataCloneError`, as the structured clone refuses them: functions, symbols, `WeakMap`, `WeakSet`,
 * `WeakRef`, promises, iterators, generators, `SharedArrayBuffer`, and proxies, which only the runtime's own
 * `structuredClone` tells apart from the objects they wrap (where the runtime has none, a proxy is kept as the object
 * it reads as). Refused too, though IndexedDB keeps them: `Blob`, `File`, `ImageData`, `CryptoKey` and the other host
 * objects, which text cannot hold.
 *
 * The text is JSON: it holds no NUL character, which PostgreSQL's text type refuses, and no lone surrogate, which
 * cannot be encoded as UTF-8.
 * @module sql-storage-adapter/kv/valueCodec
 */

/** The layout's version, the text's first element. */
const FORMAT = 1;

/** A node of the encoded tree: what JSON holds. */
type Node = string | number | boolean | null | Node[];

/** The error constructors a decoded error can have, by the name the structured clone reads. */
const ERROR_CONSTRUCTORS: Record<string, new (message?: string) => Error> = {
  EvalError,
  RangeError,
  ReferenceError,
  SyntaxError,
  TypeError,
  URIError,
};

/** The typed arrays a decoded view can be. */
const TYPED_ARRAY_NAMES = new Set([
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float16Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
]);

/**
 * Objects the structured clone refuses, and host objects text cannot hold, by the tag `Object.prototype.toString`
 * gives them.
 */
const REFUSED_TAG =
  /^\[object (?:Promise|WeakMap|WeakSet|WeakRef|FinalizationRegistry|SharedArrayBuffer|Symbol|Arguments|Generator|AsyncGenerator|[A-Za-z ]+ Iterator|Blob|File|FileList|ImageData|ImageBitmap|OffscreenCanvas|CryptoKey|MessagePort|ReadableStream|WritableStream|TransformStream|VideoFrame|AudioData|RTCCertificate|FileSystemHandle|FileSystemFileHandle|FileSystemDirectoryHandle|GPUCompilationMessage|global|Window|Intl\.[A-Za-z]+)\]$/;

/** The getter `name` of `owner` has, which reads an internal slot and throws for an object without it. */
const getter = (owner: object, name: PropertyKey): ((this: unknown) => unknown) => {
  const found = Object.getOwnPropertyDescriptor(owner, name)?.get;
  if (!found) throw new Error(`valueCodec: ${String(name)} has no getter`);
  return found as (this: unknown) => unknown;
};

const MAP_SIZE = getter(Map.prototype, 'size');
const SET_SIZE = getter(Set.prototype, 'size');
const ARRAY_BUFFER_BYTE_LENGTH = getter(ArrayBuffer.prototype, 'byteLength');
const DATA_VIEW_BYTE_LENGTH = getter(DataView.prototype, 'byteLength');
const REGEXP_SOURCE = getter(RegExp.prototype, 'source');
const REGEXP_FLAGS = getter(RegExp.prototype, 'flags');
/** `%TypedArray%.prototype[Symbol.toStringTag]`: a typed array's name, or undefined for any other object. */
const TYPED_ARRAY_NAME = getter(Object.getPrototypeOf(Uint8Array.prototype) as object, Symbol.toStringTag);

/** Whether `call` runs: a built-in's method that throws for an object without the built-in's internal slot. */
const holds = (call: () => unknown): boolean => {
  try {
    call();
    return true;
  } catch {
    return false;
  }
};

/** The error the structured clone throws for what it cannot copy. */
const cloneError = (what: string): Error => {
  const message = `${what} could not be cloned.`;
  const DomException = (globalThis as unknown as { DOMException?: new (message?: string, name?: string) => Error })
    .DOMException;
  if (typeof DomException === 'function') {
    return new DomException(message, 'DataCloneError');
  }
  const error = new Error(message);
  error.name = 'DataCloneError';
  return error;
};

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUES = new Map<string, number>([...BASE64].map((char, index): [string, number] => [char, index]));

const toBase64 = (bytes: Uint8Array): string => {
  const parts: string[] = [];
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    parts.push(BASE64[(n >> 18) & 63] + BASE64[(n >> 12) & 63] + BASE64[(n >> 6) & 63] + BASE64[n & 63]);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    parts.push(`${BASE64[(n >> 18) & 63]}${BASE64[(n >> 12) & 63]}==`);
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    parts.push(`${BASE64[(n >> 18) & 63]}${BASE64[(n >> 12) & 63]}${BASE64[(n >> 6) & 63]}=`);
  }
  return parts.join('');
};

const fromBase64 = (text: string): Uint8Array => {
  const digits = text.replace(/=+$/, '');
  const bytes = new Uint8Array(Math.floor((digits.length * 3) / 4));
  let bits = 0;
  let pending = 0;
  let at = 0;
  for (const char of digits) {
    const value = BASE64_VALUES.get(char);
    if (value === undefined) throw new Error('valueCodec: the stored bytes are not base64.');
    pending = ((pending << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[at] = (pending >> bits) & 0xff;
      at += 1;
    }
  }
  return bytes;
};

/** A number as a node: JSON holds every number but `-0`, `NaN` and the infinities. */
const numberNode = (value: number): Node => {
  if (Number.isNaN(value)) return ['n', 'NaN'];
  if (value === Infinity) return ['n', 'Infinity'];
  if (value === -Infinity) return ['n', '-Infinity'];
  if (Object.is(value, -0)) return ['n', '-0'];
  return value;
};

/**
 * Encodes `value` as text the SQL store keeps.
 *
 * @throws {Error} A `DataCloneError` for a value the structured clone refuses, or one text cannot hold.
 */
export function encodeValue(value: unknown): string {
  // The runtime's own structured clone runs first, for what no inspection can
  // tell apart from what it copies: a proxy answers every check below as the
  // object it wraps would (an array proxy is an array to Array.isArray), and the
  // structured clone, as IndexedDB's put, refuses it. The text is still written
  // from the value itself, so what comes back does not change.
  const runtimeClone = (globalThis as unknown as { structuredClone?: (input: unknown) => unknown }).structuredClone;
  if (typeof runtimeClone === 'function') {
    runtimeClone.call(globalThis, value);
  }

  /** Each object met so far, by the order it was met in, which the decoder repeats. */
  const ids = new Map<object, number>();

  const encode = (input: unknown): Node => {
    switch (typeof input) {
      case 'string':
      case 'boolean':
        return input;
      case 'number':
        return numberNode(input);
      case 'undefined':
        return ['u'];
      case 'bigint':
        return ['b', input.toString()];
      case 'symbol':
        throw cloneError('A symbol');
      case 'function':
        throw cloneError('A function');
    }
    if (input === null) return null;
    const object = input as object;
    const seen = ids.get(object);
    if (seen !== undefined) return ['r', seen];
    ids.set(object, ids.size);
    return encodeObject(object);
  };

  /** Own enumerable string-keyed properties, in order, as key and value nodes. */
  const properties = (object: object): Node[] => {
    const entries: Node[] = [];
    for (const key of Object.keys(object)) {
      entries.push(key, encode((object as Record<string, unknown>)[key]));
    }
    return entries;
  };

  const encodeObject = (object: object): Node => {
    if (Array.isArray(object)) {
      return ['a', object.length, properties(object)];
    }
    if (holds(() => Date.prototype.getTime.call(object))) {
      return ['D', numberNode(Date.prototype.getTime.call(object))];
    }
    if (object !== RegExp.prototype && holds(() => REGEXP_SOURCE.call(object))) {
      return ['R', REGEXP_SOURCE.call(object) as string, REGEXP_FLAGS.call(object) as string];
    }
    if (holds(() => MAP_SIZE.call(object))) {
      const entries: Node[] = [];
      Map.prototype.forEach.call(object, (entryValue: unknown, entryKey: unknown) => {
        entries.push(encode(entryKey), encode(entryValue));
      });
      return ['M', entries];
    }
    if (holds(() => SET_SIZE.call(object))) {
      const members: Node[] = [];
      Set.prototype.forEach.call(object, (member: unknown) => {
        members.push(encode(member));
      });
      return ['S', members];
    }
    if (holds(() => ARRAY_BUFFER_BYTE_LENGTH.call(object))) {
      if ((object as { detached?: unknown }).detached === true) throw cloneError('A detached ArrayBuffer');
      return ['B', toBase64(new Uint8Array(object as ArrayBuffer))];
    }
    if (ArrayBuffer.isView(object)) {
      if (holds(() => DATA_VIEW_BYTE_LENGTH.call(object))) {
        const view = object as DataView;
        return ['V', encode(view.buffer), view.byteOffset, view.byteLength];
      }
      const name = TYPED_ARRAY_NAME.call(object);
      if (typeof name === 'string' && TYPED_ARRAY_NAMES.has(name)) {
        const view = object as Uint8Array;
        return ['T', name, encode(view.buffer), view.byteOffset, view.length];
      }
      throw cloneError('An ArrayBuffer view');
    }
    if (holds(() => Number.prototype.valueOf.call(object))) {
      return ['N', numberNode(Number.prototype.valueOf.call(object))];
    }
    if (holds(() => String.prototype.valueOf.call(object))) {
      return ['Z', String.prototype.valueOf.call(object)];
    }
    if (holds(() => Boolean.prototype.valueOf.call(object))) {
      return ['Q', Boolean.prototype.valueOf.call(object)];
    }
    if (typeof BigInt === 'function' && holds(() => BigInt.prototype.valueOf.call(object))) {
      return ['G', BigInt.prototype.valueOf.call(object).toString()];
    }
    if (holds(() => Symbol.prototype.valueOf.call(object))) {
      throw cloneError('A Symbol object');
    }
    const tag = Object.prototype.toString.call(object);
    if (isError(object, tag)) {
      return encodeError(object as Error);
    }
    if (REFUSED_TAG.test(tag)) {
      throw cloneError(tag.slice(8, -1));
    }
    return ['o', properties(object)];
  };

  /**
   * An error as the structured clone writes it: the prototype its `name` picks, its own `message`, its `stack` and
   * its own `cause`. Its other properties are not kept.
   */
  const encodeError = (error: Error): Node => {
    const name = String(error.name);
    const prototypeName = Object.prototype.hasOwnProperty.call(ERROR_CONSTRUCTORS, name) ? name : 'Error';
    const messageDescriptor = Object.getOwnPropertyDescriptor(error, 'message');
    const message =
      messageDescriptor && 'value' in messageDescriptor ? String(messageDescriptor.value) : null;
    const stack: unknown = error.stack;
    const node: Node[] = ['E', prototypeName, message, typeof stack === 'string' ? stack : null];
    const causeDescriptor = Object.getOwnPropertyDescriptor(error, 'cause');
    if (causeDescriptor && 'value' in causeDescriptor) {
      node.push(encode(causeDescriptor.value));
    }
    return node;
  };

  return JSON.stringify([FORMAT, encode(value)]);
}

/** Whether `object` is an error: one made by an error constructor, as the structured clone tells them. */
const isError = (object: object, tag: string): boolean => {
  const errorIs = (Error as unknown as { isError?: (value: unknown) => boolean }).isError;
  return typeof errorIs === 'function' ? errorIs(object) : tag === '[object Error]';
};

/** Defines an own property as the structured clone's copy has it: writable, enumerable and configurable. */
const defineOwn = (target: object, key: string, value: unknown): void => {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
};

/**
 * Decodes text `encodeValue` wrote.
 *
 * @throws {Error} When the text is not one `encodeValue` writes.
 */
export function decodeValue(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== FORMAT) {
    throw new Error('valueCodec: the stored value is not one the key-value store wrote.');
  }
  /** Each object made so far, by the order it was met in when encoded. */
  const objects: unknown[] = [];

  const malformed = (): Error => new Error('valueCodec: the stored value is malformed.');

  /** Reserves the next object's place, so the objects inside it come after it, as they did when encoded. */
  const reserve = (): number => {
    objects.push(undefined);
    return objects.length - 1;
  };

  const register = <T>(object: T): T => {
    objects.push(object);
    return object;
  };

  const decodeNumber = (node: unknown): number => {
    const decoded = decode(node);
    if (typeof decoded !== 'number') throw malformed();
    return decoded;
  };

  const decodeProperties = (target: object, entries: unknown): void => {
    if (!Array.isArray(entries) || entries.length % 2 !== 0) throw malformed();
    for (let i = 0; i < entries.length; i += 2) {
      const key = entries[i];
      if (typeof key !== 'string') throw malformed();
      defineOwn(target, key, decode(entries[i + 1]));
    }
  };

  const decode = (node: unknown): unknown => {
    if (node === null || typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
      return node;
    }
    if (!Array.isArray(node) || typeof node[0] !== 'string') throw malformed();
    switch (node[0]) {
      case 'u':
        return undefined;
      case 'n':
        switch (node[1]) {
          case 'NaN':
            return NaN;
          case 'Infinity':
            return Infinity;
          case '-Infinity':
            return -Infinity;
          case '-0':
            return -0;
          default:
            throw malformed();
        }
      case 'b':
        return BigInt(String(node[1]));
      case 'r': {
        const id = node[1];
        if (typeof id !== 'number' || id < 0 || id >= objects.length) throw malformed();
        return objects[id];
      }
      case 'o': {
        const object = register({});
        decodeProperties(object, node[1]);
        return object;
      }
      case 'a': {
        if (typeof node[1] !== 'number') throw malformed();
        const array = register(new Array<unknown>(node[1]));
        decodeProperties(array, node[2]);
        return array;
      }
      case 'D': {
        const id = reserve();
        const date = new Date(decodeNumber(node[1]));
        objects[id] = date;
        return date;
      }
      case 'R':
        return register(new RegExp(String(node[1]), String(node[2])));
      case 'M': {
        const map = register(new Map<unknown, unknown>());
        const entries = node[1];
        if (!Array.isArray(entries) || entries.length % 2 !== 0) throw malformed();
        for (let i = 0; i < entries.length; i += 2) {
          const key = decode(entries[i]);
          map.set(key, decode(entries[i + 1]));
        }
        return map;
      }
      case 'S': {
        const set = register(new Set<unknown>());
        const members = node[1];
        if (!Array.isArray(members)) throw malformed();
        for (const member of members) set.add(decode(member));
        return set;
      }
      case 'B': {
        const bytes = fromBase64(String(node[1]));
        return register(bytes.buffer);
      }
      case 'V': {
        const id = reserve();
        const buffer = decode(node[1]);
        if (!(buffer instanceof ArrayBuffer)) throw malformed();
        const view = new DataView(buffer, Number(node[2]), Number(node[3]));
        objects[id] = view;
        return view;
      }
      case 'T': {
        const name = String(node[1]);
        const Constructor = (globalThis as unknown as Record<string, unknown>)[name];
        if (!TYPED_ARRAY_NAMES.has(name) || typeof Constructor !== 'function') throw malformed();
        const id = reserve();
        const buffer = decode(node[2]);
        if (!(buffer instanceof ArrayBuffer)) throw malformed();
        const view = new (Constructor as new (buffer: ArrayBuffer, byteOffset: number, length: number) => object)(
          buffer,
          Number(node[3]),
          Number(node[4]),
        );
        objects[id] = view;
        return view;
      }
      case 'N': {
        const id = reserve();
        const boxed = new Number(decodeNumber(node[1]));
        objects[id] = boxed;
        return boxed;
      }
      case 'Z':
        return register(new String(String(node[1])));
      case 'Q':
        return register(new Boolean(node[1] === true));
      case 'G':
        return register(Object(BigInt(String(node[1]))));
      case 'E':
        return decodeError(node);
      default:
        throw malformed();
    }
  };

  /** An error as the structured clone makes it: its prototype, message, stack and cause, nothing else. */
  const decodeError = (node: unknown[]): Error => {
    const name = String(node[1]);
    const Constructor: new (message?: string) => Error = Object.prototype.hasOwnProperty.call(ERROR_CONSTRUCTORS, name)
      ? ERROR_CONSTRUCTORS[name]
      : Error;
    const message = node[2];
    const error = typeof message === 'string' ? new Constructor(message) : new Constructor();
    register(error);
    const stack = node[3];
    try {
      if (typeof stack === 'string') {
        Object.defineProperty(error, 'stack', { value: stack, writable: true, enumerable: false, configurable: true });
      } else {
        delete (error as { stack?: unknown }).stack;
      }
    } catch {
      // An engine whose stack property cannot be redefined keeps the one it made.
    }
    if (node.length > 4) {
      Object.defineProperty(error, 'cause', {
        value: decode(node[4]),
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
    return error;
  };

  return decode(parsed[1]);
}
