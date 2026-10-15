import type { StorageParameters } from '../core/contracts';

/**
 * Normalises parameter payloads into a tuple of named/object parameters and positional arrays.
 */
export const normaliseParameters = (
  parameters?: StorageParameters
): { named?: Record<string, unknown>; positional?: Array<unknown> } => {
  if (parameters == null) {
    return {};
  }

  if (Array.isArray(parameters)) {
    return { positional: parameters };
  }

  if (typeof parameters === 'object') {
    return { named: parameters as Record<string, unknown> };
  }

  // Fall back to positional when unknown primitive is provided.
  return { positional: [parameters] };
};

/**
 * Named parameters under every key sql.js may look them up by. sql.js binds a
 * named value only under the key that matches the placeholder as written
 * (":id", "@id", "$id"); better-sqlite3 takes the bare key ("id"). Expanding
 * every variant lets one payload work on both.
 */
export const expandNamedParameters = (named: Record<string, unknown>): Record<string, unknown> => {
  const expanded: Record<string, unknown> = { ...named };
  for (const [rawKey, value] of Object.entries(named)) {
    if (!rawKey) continue;
    const key = rawKey.replace(/^[:@$]/, '');
    if (!key) continue;
    if (!(key in expanded)) expanded[key] = value;
    if (!(`:${key}` in expanded)) expanded[`:${key}`] = value;
    if (!(`@${key}` in expanded)) expanded[`@${key}`] = value;
    if (!(`$${key}` in expanded)) expanded[`$${key}`] = value;
  }
  return expanded;
};
