import type { DateBucketUnit, IntervalUnit } from '../core/contracts/dialect.js';

/** Seconds per addInterval unit. */
const SECONDS_PER_UNIT = new Map<string, number>([
  ['seconds', 1],
  ['minutes', 60],
  ['hours', 3600],
  ['days', 86400],
]);

/** `amount` units as a number of seconds, after checking both. */
export const intervalSeconds = (amount: number, unit: IntervalUnit): number => {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new Error(`addInterval amount must be a finite number; got ${String(amount)}.`);
  }
  const perUnit = SECONDS_PER_UNIT.get(unit);
  if (perUnit === undefined) {
    throw new Error(`addInterval unit must be 'seconds', 'minutes', 'hours' or 'days'; got ${JSON.stringify(unit)}.`);
  }
  return amount * perUnit;
};

const DATE_BUCKET_UNITS = new Set<string>(['minute', 'hour', 'day', 'month', 'year']);

/** Checks a dateBucket unit. */
export const checkDateBucketUnit = (unit: DateBucketUnit): DateBucketUnit => {
  if (!DATE_BUCKET_UNITS.has(unit)) {
    throw new Error(`dateBucket unit must be 'minute', 'hour', 'day', 'month' or 'year'; got ${JSON.stringify(unit)}.`);
  }
  return unit;
};

/** One step of a JSON path: an object key or an array index. */
export type JsonPathStep = string | number;

const PATH_STEP = /\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/y;

/**
 * Splits a JSON path of the form `$.key`, `$.key.key` or `$.key[0]` into its
 * steps. Anything else is refused, so a path never carries SQL.
 */
export const parseJsonPath = (jsonPath: string): JsonPathStep[] => {
  const refuse = (): never => {
    throw new Error(`Unsupported JSON path ${JSON.stringify(jsonPath)}: write $.key, $.key.key or $.key[0].`);
  };
  if (typeof jsonPath !== 'string' || !jsonPath.startsWith('$')) refuse();
  const steps: JsonPathStep[] = [];
  let index = 1;
  while (index < jsonPath.length) {
    PATH_STEP.lastIndex = index;
    const match = PATH_STEP.exec(jsonPath);
    if (!match) refuse();
    steps.push(match![1] !== undefined ? match![1] : Number(match![2]));
    index = PATH_STEP.lastIndex;
  }
  if (steps.length === 0) refuse();
  return steps;
};

/** Checks one of a fixed set of option values. */
export const checkChoice = <T extends string>(what: string, value: T, allowed: readonly T[]): T => {
  if (!allowed.includes(value)) {
    throw new Error(`${what} must be ${allowed.map((option) => `'${option}'`).join(', ')}; got ${JSON.stringify(value)}.`);
  }
  return value;
};

/** The columns an upsert updates: those given, or every column outside the conflict target. */
export const upsertUpdateColumns = (columns: string[], conflictColumns: string[], updateColumns?: string[]): string[] => {
  if (conflictColumns.length === 0) {
    throw new Error('upsert needs at least one conflict column.');
  }
  return updateColumns ?? columns.filter((column) => !conflictColumns.includes(column));
};
