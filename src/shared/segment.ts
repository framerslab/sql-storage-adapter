/**
 * Segments keep one user's tables apart from another's in a database they
 * share. On PostgreSQL a segment is a schema of its own; on the SQLite family a
 * database file of its own; on IndexedDB and Capacitor a database name of its
 * own. A segment name is the same on every backend, so one name gives a host
 * the same separation on the server, the desktop, the phone and the browser.
 *
 * This module imports nothing, so browser bundles can include it.
 */

/** PostgreSQL's identifier limit: a schema name has at most 63 bytes. */
const MAX_SEGMENT_LENGTH = 63;

/** Lower-case letters, digits and underscores, starting with a letter or an underscore. */
const SEGMENT_PATTERN = /^[a-z_][a-z0-9_]*$/;

/** Schemas PostgreSQL keeps for itself, besides the names beginning with pg_. */
const RESERVED_SEGMENTS = new Set(['public', 'information_schema']);

/**
 * Checks a segment name and returns it.
 *
 * A segment name is lower-case letters, digits and underscores, starts with a
 * letter or an underscore, and has at most 63 characters: an unquoted
 * PostgreSQL identifier, and a safe file, IndexedDB and Capacitor database
 * name. It is not `public`, `information_schema` or a name beginning with
 * `pg_`, which PostgreSQL keeps for its own schemas.
 *
 * @throws {Error} When the name is not one a segment can take.
 */
export const validateSegment = (segment: string): string => {
  if (typeof segment !== 'string' || !SEGMENT_PATTERN.test(segment) || segment.length > MAX_SEGMENT_LENGTH) {
    throw new Error(
      `Invalid segment ${JSON.stringify(segment)}: a segment name is lower-case letters, digits and underscores, ` +
        `starts with a letter or an underscore, and has at most ${MAX_SEGMENT_LENGTH} characters.`,
    );
  }
  if (RESERVED_SEGMENTS.has(segment) || segment.startsWith('pg_')) {
    throw new Error(
      `Invalid segment "${segment}": PostgreSQL keeps public, information_schema and the names beginning with pg_ for its own schemas.`,
    );
  }
  return segment;
};

/**
 * The name of a segment's database: `name` followed by `-` and the segment,
 * or `name` itself when there is no segment. For IndexedDB and Capacitor
 * database names: `app-db` and segment `agentos` give `app-db-agentos`.
 *
 * @throws {Error} When the segment is not one a segment name can take.
 */
export const segmentName = (name: string, segment: string | undefined): string =>
  segment === undefined ? name : `${name}-${validateSegment(segment)}`;

/** SQLite's names for a database that lives in its connection alone. */
const isInMemoryPath = (filePath: string): boolean =>
  filePath === '' || filePath === ':memory:' || filePath.startsWith('file::memory:');

/**
 * The file of a segment's database: the segment goes between the file's name
 * and its extension (`/data/app.sqlite3` and segment `agentos` give
 * `/data/app-agentos.sqlite3`), or after a name with no extension. A `file:`
 * URI keeps its query, and SQLite's in-memory names (`:memory:`,
 * `file::memory:`) stay as they are, since each in-memory connection is a
 * database of its own. Without a segment the path is returned as it is.
 *
 * @throws {Error} When the segment is not one a segment name can take.
 */
export const segmentFilePath = (filePath: string, segment: string | undefined): string => {
  if (segment === undefined) return filePath;
  validateSegment(segment);
  if (isInMemoryPath(filePath)) return filePath;

  // A file: URI's path ends at its query or fragment.
  const queryAt = filePath.startsWith('file:') ? filePath.search(/[?#]/) : -1;
  const pathPart = queryAt === -1 ? filePath : filePath.slice(0, queryAt);
  const rest = queryAt === -1 ? '' : filePath.slice(queryAt);

  const nameAt = Math.max(pathPart.lastIndexOf('/'), pathPart.lastIndexOf('\\'), pathPart.startsWith('file:') ? 4 : -1) + 1;
  const directory = pathPart.slice(0, nameAt);
  const name = pathPart.slice(nameAt);
  // A dot that begins the name (.store) starts no extension.
  const extensionAt = name.lastIndexOf('.');
  const segmented =
    extensionAt > 0 ? `${name.slice(0, extensionAt)}-${segment}${name.slice(extensionAt)}` : `${name}-${segment}`;
  return `${directory}${segmented}${rest}`;
};

/** Whether a path names an in-memory SQLite database, which no file holds. */
export const namesInMemoryDatabase = isInMemoryPath;
