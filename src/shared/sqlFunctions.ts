import type { SqlFunction, SqlFunctionOptions } from '../core/contracts';

export type { SqlFunction, SqlFunctionOptions };

const FUNCTION_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Checks a SQL function name. */
export const checkFunctionName = (name: string): string => {
  if (typeof name !== 'string' || !FUNCTION_NAME.test(name)) {
    throw new Error(`A SQL function name must be an identifier (letters, digits and underscores); got ${JSON.stringify(name)}.`);
  }
  return name;
};
