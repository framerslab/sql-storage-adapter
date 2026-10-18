/**
 * @fileoverview The connection a pg pool makes, written as a libpq connection URI, so that `pg_dump` reaches the
 * server, the database and the user the adapter's pool reaches, with the password and the TLS pg uses.
 *
 * pg reads a connection string with the WHATWG URL parser (pg-connection-string's `parse`), and fills what the
 * settings leave out from `PGUSER`, `PGDATABASE`, `PGPORT`, `PGHOST`, `PGPASSWORD` and `PGSSLMODE`, then the
 * operating system's user, the user's name, 5432 and localhost (pg `lib/connection-parameters.js`). libpq reads a
 * URI by its own grammar (`fe-connect.c`, `conninfo_uri_parse_options`): it ends the user part at the first `@`
 * that comes before any `/`, and it refuses a query parameter it does not know. So
 * `postgresql://db.example?application_name=x@y` names the host `db.example` to pg and `y` to libpq. The URI
 * written here holds pg's reading: the user, the host, the port and the database spelled out and percent-encoded,
 * the parameters pg reads that libpq takes, and the `sslmode` that has libpq use TLS and check the server as pg does.
 *
 * The variables pg reads are read here as pg reads them. libpq's own, which pg does not read (`PGHOSTADDR`,
 * `PGSERVICE`, `PGREQUIRESSL`, `PGSSLROOTCERT` and the rest), configure pg_dump as they configure psql.
 * @module sql-storage-adapter/exporters/pgConnection
 */

import { getStorageLogger } from '../shared/logger.js';
import { loadPg } from './pgModule.js';

/** Connection settings, as the Postgres adapter's options and a pg `Pool`'s `options` hold them. */
export interface PgConnectionSettings {
  connectionString?: string;
  host?: string;
  port?: number | string;
  database?: string;
  user?: string;
  /** A string, or a function pg calls for each connection it makes, which may answer a promise. */
  password?: unknown;
  /** pg's `ssl`: `true`, `false`, or Node TLS options. */
  ssl?: unknown;
}

/** The connection pg makes from a set of settings. */
interface PgConnection {
  host: string;
  port: string;
  user?: string;
  database?: string;
  /** A string, or a function pg calls; nothing where `PGPASSWORD` and `~/.pgpass` answer. */
  password?: unknown;
  /** The libpq parameters of the connection string, decoded, in their order. */
  parameters: Array<[string, string]>;
}

type Environment = Record<string, string | undefined>;

/** The environment pg reads its defaults from, where there is one. */
const environment = (): Environment =>
  typeof process !== 'undefined' && process.env ? (process.env as Environment) : {};

/**
 * The parameters of a connection string that pg reads and that libpq takes in a connection URI (PostgreSQL 18,
 * `fe-connect.c`, `PQconninfoOptions`): the settings pg sends when it connects (`options`, `application_name`,
 * `fallback_application_name`, `client_encoding`, `replication`; pg 8.23.1 `lib/connection-parameters.js:63-124`),
 * `sslnegotiation`, which pg reads from 8.22.0, and the certificate files pg-connection-string reads (`sslcert`,
 * `sslkey`, `sslrootcert`; `index.js:88-100`). The URI spells out the user, the host, the port and the database, and
 * `sslmode` is written for the TLS pg uses. libpq's other parameters pg does not read, and pg_dump given them would
 * read another password file than the pool (`passfile`), or refuse a server, an authentication or a session the pool
 * takes (`target_session_attrs`, `require_auth`, `channel_binding`, `gssencmode`, `sslcrl` and the rest), so they
 * are left out; so are pg's own (`statement_timeout`, `uselibpqcompat`), which libpq refuses in a URI, and
 * `sslpassword`, `oauth_client_secret`, `scram_client_key` and `scram_server_key`, which libpq takes from the
 * connection string alone, pg_dump's command line.
 */
const PG_READ_PARAMETERS = new Set([
  'options',
  'application_name',
  'fallback_application_name',
  'client_encoding',
  'replication',
  'sslnegotiation',
  'sslcert',
  'sslkey',
  'sslrootcert',
]);

/** The `sslmode` values with which libpq connects without TLS to a server that offers none, as pg does with no `ssl`. */
const PLAIN_SSLMODES = new Set(['disable', 'allow', 'prefer']);

/** A URI scheme, which pg reads a connection string as a URL for. */
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** pg's `ssl` from `PGSSLMODE`, which pg reads where neither the settings nor the connection string set TLS. */
const sslFromEnvironment = (sslmode: string | undefined): unknown => {
  switch (sslmode) {
    case 'prefer':
    case 'require':
    case 'verify-ca':
    case 'verify-full':
      return true;
    case 'no-verify':
      return { rejectUnauthorized: false };
    default:
      return false;
  }
};

/**
 * The `ssl` pg-connection-string 2.14.1's `parse` makes of a connection string's parameters (index.js:69-158), the
 * last value of a repeated parameter counting, or undefined where it makes none, so that pg reads the settings'
 * `ssl`, then `PGSSLMODE`. A certificate file or an `sslmode` turns TLS on over `ssl=0`; `sslmode=disable` turns it
 * off; `sslmode=no-verify`, and with `uselibpqcompat=true` `sslmode=prefer`, or `require` with no root certificate,
 * check no certificate.
 */
const sslOfParameters = (last: (name: string) => string | undefined): unknown => {
  let ssl: unknown = last('ssl');
  if (ssl === 'true' || ssl === '1') ssl = true;
  if (ssl === '0') ssl = false;
  const sslmode = last('sslmode');
  if (last('sslcert') || last('sslkey') || last('sslrootcert') || sslmode) ssl = {};
  if (last('sslnegotiation') === 'direct' && ssl === undefined) ssl = true;
  if (sslmode === 'disable') return false;
  const compatible = last('uselibpqcompat') === 'true';
  const checksNone = compatible
    ? sslmode === 'prefer' || (sslmode === 'require' && !last('sslrootcert'))
    : sslmode === 'no-verify';
  return checksNone ? { rejectUnauthorized: false } : ssl;
};

/** How a connection pg makes uses TLS: not at all, without checking the server's certificate, or checking it. */
type PgTls = 'none' | 'unchecked' | 'checked';

/**
 * How pg uses TLS with an `ssl`, which `lib/connection-parameters.js` reads `'true'` and `'no-verify'` in, and
 * Node's TLS checks the certificate with unless `rejectUnauthorized` is false.
 */
const tlsOf = (ssl: unknown): PgTls => {
  const value = ssl === 'true' ? true : ssl === 'no-verify' ? { rejectUnauthorized: false } : ssl;
  if (!value) return 'none';
  return typeof value === 'object' && (value as { rejectUnauthorized?: unknown }).rejectUnauthorized === false
    ? 'unchecked'
    : 'checked';
};

/**
 * The libpq settings pg_dump gets so that libpq uses TLS as pg does and checks the server as pg does, none where
 * libpq left to itself does.
 * - No TLS: `sslmode=disable` where the pool's settings or its connection string chose it (pg reads no `PGSSLMODE`
 *   then, and libpq's `prefer` or `allow` would use TLS with a server that offers it). Where no TLS is pg's default,
 *   libpq's own default (`prefer`) and a `PGSSLMODE` of `disable` or `allow` connect where pg connects, and stay;
 *   an empty `PGSSLMODE`, or one libpq does not know, which libpq refuses, gives way to `disable`.
 * - TLS that checks no certificate: `sslmode=require`, over any `PGSSLMODE`, since `verify-ca` or `verify-full`
 *   would refuse the certificate pg accepts.
 * - TLS that checks the certificate: Node's TLS checks it against Node's certificate authorities, or the root
 *   certificate the connection string names, and checks the host name, unless pg reads the string as libpq does
 *   (`uselibpqcompat=true`) with `verify-ca`, or `require` beside a root certificate. libpq checks a certificate with
 *   `verify-ca` and `verify-full` alone, the host name with `verify-full` alone, and against a root certificate file
 *   or, with `sslrootcert=system` (libpq 16 and later), the system's certificate authorities; its `require` checks
 *   nothing without a root certificate file (fe-secure-openssl.c). So `sslmode=verify-full`, or `verify-ca` where
 *   pg checks no host name, over any `PGSSLMODE`, against the connection string's `sslrootcert`, else the file
 *   `PGSSLROOTCERT` names, else `sslrootcert=system`.
 */
const tlsSettingsFor = (
  tls: PgTls,
  chosen: boolean,
  hostNameChecked: boolean,
  rootCertificateNamed: boolean,
  env: Environment,
): Array<[string, string]> => {
  if (tls === 'none') {
    const pgsslmode = env.PGSSLMODE;
    return chosen || (pgsslmode !== undefined && !PLAIN_SSLMODES.has(pgsslmode)) ? [['sslmode', 'disable']] : [];
  }
  if (tls === 'unchecked') return [['sslmode', 'require']];
  const sslmode: [string, string] = ['sslmode', hostNameChecked ? 'verify-full' : 'verify-ca'];
  return rootCertificateNamed || env.PGSSLROOTCERT ? [sslmode] : [sslmode, ['sslrootcert', 'system']];
};

/**
 * What a connection string says, as pg-connection-string's `parse` reads it. pg assigns each part `parse` sets over
 * the settings, an empty one too, and keeps the settings' value of a part it does not set.
 */
interface ParsedConnectionString {
  user?: string;
  password?: string;
  host: string;
  port?: string;
  database?: string;
  parameters: Array<[string, string]>;
}

/** Percent-decoding that answers undefined where pg's decoding throws. */
const decoded = (decode: (text: string) => string, text: string): string | undefined => {
  try {
    return decode(text);
  } catch {
    return undefined;
  }
};

/**
 * A connection string as pg-connection-string 2.x's `parse` reads it: a string that starts with `/` is a socket
 * directory and a database name; anything else goes through the WHATWG URL parser, percent-encoded first where it
 * holds a space or a `%` that starts no escape, with a stand-in host where a user part comes before an empty host.
 * A query parameter `user`, `password`, `host` or `port` comes before the URL's own.
 */
const parseAsPg = (connectionString: string): ParsedConnectionString | undefined => {
  if (connectionString.startsWith('/')) {
    const [host, database] = connectionString.split(' ');
    return { host, database, parameters: [] };
  }
  let text = connectionString;
  if (/ |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(text)) {
    text = encodeURI(text).replace(/%25(\d\d)/g, '%$1');
  }
  const urlOf = (candidate: string): URL | undefined => {
    try {
      return new URL(candidate, 'postgres://base');
    } catch {
      return undefined;
    }
  };
  let url = urlOf(text);
  let standInHost = false;
  if (url === undefined) {
    url = urlOf(text.replace('@/', '@___DUMMY___/'));
    standInHost = true;
  }
  if (url === undefined) return undefined;
  const parameters: Array<[string, string]> = [];
  url.searchParams.forEach((value, key) => {
    parameters.push([key, value]);
  });
  const parameter = (name: string): string | undefined => {
    const found = parameters.filter(([key]) => key === name);
    return found.length > 0 ? found[found.length - 1][1] : undefined;
  };
  // pg decodes the URL's user name and password only where no parameter gives them, so a parameter stands in for
  // one that is not valid percent-encoding.
  const user = parameter('user') || decoded(decodeURIComponent, url.username);
  const secret = parameter('password') || decoded(decodeURIComponent, url.password);
  if (user === undefined || secret === undefined) return undefined;

  if (url.protocol === 'socket:') {
    const host = decoded(decodeURI, url.pathname);
    if (host === undefined) return undefined;
    const port = parameter('port');
    return {
      user,
      password: secret,
      host,
      ...(port === undefined ? {} : { port }),
      database: url.searchParams.get('db') ?? undefined,
      parameters,
    };
  }

  const hostname = (standInHost ? '' : url.hostname).replace(/^\[(.+)\]$/, '$1');
  let pathname = url.pathname;
  let host = parameter('host');
  if (!host) {
    const fromUrl = decoded(decodeURIComponent, hostname);
    if (fromUrl === undefined) return undefined;
    host = fromUrl;
  } else if (hostname && /^%2f/i.test(hostname)) {
    pathname = hostname + pathname;
  }
  const port = parameter('port') || url.port;
  const path = pathname.slice(1);
  const database = path ? decoded(decodeURI, path) : undefined;
  if (path && database === undefined) return undefined;
  return { user, password: secret, host, port, database, parameters };
};

/**
 * The TLS options of a pool's `ssl` that `sslmode=require` cannot carry to pg_dump, by name. Own properties are read
 * whether they are enumerable or not: pg-pool hides `ssl.key` from enumeration.
 */
const tlsSettingsBeyondSslmode = (ssl: unknown): string[] =>
  ssl !== null && typeof ssl === 'object'
    ? Object.getOwnPropertyNames(ssl).filter((name) => {
        if (name === 'rejectUnauthorized') return false;
        const value = (ssl as Record<string, unknown>)[name];
        return value !== undefined && value !== null;
      })
    : [];

/**
 * Reads connection settings as pg reads them for each connection of a pool: a connection string's parts over the
 * settings', then the environment, then pg's defaults. Undefined where pg cannot read the connection string.
 *
 * @throws {Error} When the settings ask for TLS options libpq takes only from files, or the connection string for
 *   `verify-ca` read as libpq reads it with no root certificate, or a port pg reads no number in, which pg refuses.
 */
const readAsPg = (settings: PgConnectionSettings, env: Environment): PgConnection | undefined => {
  let user = settings.user;
  let password = settings.password;
  let host = settings.host;
  // As the settings give it: pg reads 0 and an empty port as none (its val() takes a falsy setting for none).
  let port: unknown = settings.port;
  let database = settings.database;
  const parameters: Array<[string, string]> = [];
  // pg's ssl: the connection string's where its parameters make one, else the settings', else PGSSLMODE's
  // (lib/connection-parameters.js reads PGSSLMODE only where the merged settings hold no ssl).
  let ssl: unknown = settings.ssl;
  let source: 'string' | 'settings' | 'environment' = settings.ssl !== undefined ? 'settings' : 'environment';
  // Node's TLS checks the host name unless pg reads the string as libpq does with verify-ca, or require beside a root
  // certificate (pg-connection-string index.js:116-133); the root certificate pg checks against, the string names.
  let hostNameChecked = true;
  let rootCertificateNamed = false;

  if (settings.connectionString) {
    const parsed = parseAsPg(settings.connectionString);
    if (parsed === undefined) return undefined;
    // pg assigns each part the string sets over the settings, an empty part too.
    host = parsed.host;
    database = parsed.database;
    if ('user' in parsed) user = parsed.user;
    if ('password' in parsed) password = parsed.password;
    if ('port' in parsed) port = parsed.port;
    const last = (name: string): string | undefined =>
      parsed.parameters.filter(([key]) => key === name).pop()?.[1];
    const fromString = sslOfParameters(last);
    if (fromString !== undefined) {
      ssl = fromString;
      source = 'string';
      const sslmode = last('sslmode');
      const compatible = last('uselibpqcompat') === 'true';
      rootCertificateNamed = Boolean(last('sslrootcert'));
      // pg refuses verify-ca read as libpq reads it with no root certificate to check the server against
      // (pg-connection-string index.js:125-130), so the pool makes no connection, and pg_dump makes none either.
      if (compatible && sslmode === 'verify-ca' && !rootCertificateNamed) {
        throw new Error(
          'PostgresExporter: the connection string asks for sslmode=verify-ca with uselibpqcompat=true and names no ' +
            'sslrootcert, which pg refuses, so pg_dump does not connect either.',
        );
      }
      hostNameChecked = !(compatible && (sslmode === 'verify-ca' || (sslmode === 'require' && rootCertificateNamed)));
    }
    for (const [key, value] of parsed.parameters) {
      if (PG_READ_PARAMETERS.has(key)) parameters.push([key, value]);
    }
  }
  if (source === 'environment') ssl = sslFromEnvironment(env.PGSSLMODE);

  const tls = tlsOf(ssl);
  if (source === 'settings' && tls !== 'none') {
    const beyond = tlsSettingsBeyondSslmode(ssl);
    if (beyond.length > 0) {
      throw new Error(
        `PostgresExporter: the pool's ssl settings ${beyond.join(', ')} cannot reach pg_dump, which reads TLS ` +
          'material from files alone. Give the pool a connectionString whose sslrootcert, sslcert and sslkey ' +
          'parameters name the files, or set PGSSLROOTCERT, PGSSLCERT and PGSSLKEY and give the pool ssl: true.',
      );
    }
  }
  parameters.push(...tlsSettingsFor(tls, source !== 'environment', hostNameChecked, rootCertificateNamed, env));

  // pg reads the port with parseInt, after the setting, PGPORT and 5432 (lib/connection-parameters.js:70), so
  // `5432x` is 5432, which libpq would refuse as no number.
  const portNumber = Number.parseInt(String(port || env.PGPORT || 5432), 10);
  if (Number.isNaN(portNumber)) {
    throw new Error(
      "PostgresExporter: pg reads no number in the pool's port, so the pool makes no connection, and pg_dump makes " +
        'none either.',
    );
  }

  const osUser = typeof process !== 'undefined' && process.platform === 'win32' ? env.USERNAME : env.USER;
  const resolvedUser = user || env.PGUSER || osUser || undefined;
  return {
    user: resolvedUser,
    database: database || env.PGDATABASE || resolvedUser,
    host: host || env.PGHOST || 'localhost',
    port: String(portNumber),
    password: password || undefined,
    parameters,
  };
};

/** Whether a pg of this version calls a password function with no arguments, as every pg before 8.19.0 does. */
const callsPasswordWithNoArguments = (version: string): boolean => {
  const match = /^(\d+)\.(\d+)\./.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  return major < 8 || (major === 8 && Number(match[2]) < 19);
};

/** Whether the warning that the exporter could not read pg has been written; it is written once. */
let toldPgUnread = false;

/**
 * The receiver and the arguments pg calls a pool's password function with for each connection the pool makes: a
 * client made of the pool's settings (pg-pool `newClient`: `new this.Client(this.options)`), which pg calls the
 * function as a method of, with no arguments before pg 8.19.0 and from 8.19.0 with the client's
 * `ConnectionParameters` (node-postgres #3602; `lib/client.js` `_getPassword`:
 * `this.password(this.connectionParameters)`), where the pool names no `Client` that asks it itself. The client is of
 * the pg this library loads, made without the settings' `stream`, a function pg calls to open the socket, and never
 * connected. Where that pg cannot be read, the function gets no receiver and the connection's user, database, host
 * and port, as pg 8.19.0 and later give it theirs, or nothing where the version read is older.
 */
const passwordCallOf = async (
  connection: PgConnection,
  settings: PgConnectionSettings,
): Promise<{ self: unknown; args: unknown[] }> => {
  const pg = await loadPg();
  const noArguments = pg.version !== undefined && callsPasswordWithNoArguments(pg.version);
  if (pg.version !== undefined && pg.Client !== undefined) {
    // pg-pool keeps the settings' password from enumeration, so it is copied by name.
    const client = new pg.Client({ ...settings, password: settings.password, stream: undefined });
    return { self: client, args: noArguments ? [] : [client.connectionParameters] };
  }
  if (!toldPgUnread) {
    toldPgUnread = true;
    getStorageLogger().warn(
      { scope: 'PostgresExporter', pgVersion: pg.version ?? null, pgClient: pg.Client !== undefined },
      "The pg this library loads could not be read, so a pool's password function is called on no client, with " +
        `${noArguments ? 'no arguments' : "the connection's user, database, host and port"}.`,
    );
  }
  return {
    self: undefined,
    args: noArguments
      ? []
      : [{ user: connection.user, database: connection.database, host: connection.host, port: Number(connection.port) }],
  };
};

/** pg's words for an answer of a password function that is not a string (`lib/client.js`, `_getPassword`). */
const NOT_A_STRING = 'Password must be a string';

/**
 * The refusal of an export whose password function failed, or answered no string, which pg reports as a
 * `TypeError` in its own words. The function's own error is kept as the cause, out of the message, which a log may
 * show.
 */
const passwordFailure = (error: unknown): Error => {
  if (error instanceof TypeError && error.message === NOT_A_STRING) {
    return new Error('PostgresExporter: the password function of the pool answered no string, which pg refuses too.');
  }
  const failure: Error & { cause?: unknown } = new Error(
    'PostgresExporter: the password function of the pool failed, so pg_dump has no password.',
  );
  failure.cause = error;
  return failure;
};

/** The connection of a pg `Client`, whose `error` event reports what its password routine meets. */
interface ClientConnection {
  once(event: 'error', listener: (error: unknown) => void): unknown;
  removeListener?(event: 'error', listener: (error: unknown) => void): unknown;
}

/** A pg `Client` as the exporter uses one: its password, its connection and the routine that asks a function. */
interface AskingClient {
  password?: unknown;
  connection?: unknown;
  _getPassword?: (done: () => void) => void;
  _checkPgPass?: (done: () => void) => void;
}

const hasEvents = (value: unknown): value is ClientConnection =>
  value !== null && typeof value === 'object' && typeof (value as { once?: unknown }).once === 'function';

/**
 * The name of the routine with which a pg `Client` class asks a password function for each connection:
 * `_getPassword`, which pg 8.13.1 and earlier name `_checkPgPass`. Undefined for a class with neither, which is no
 * pg `Client` (pg's native one among them).
 */
const askingRoutineOf = (PoolClient: unknown): '_getPassword' | '_checkPgPass' | undefined => {
  const prototype = typeof PoolClient === 'function' ? (PoolClient as { prototype?: unknown }).prototype : undefined;
  if (prototype === null || typeof prototype !== 'object') return undefined;
  if (typeof (prototype as AskingClient)._getPassword === 'function') return '_getPassword';
  if (typeof (prototype as AskingClient)._checkPgPass === 'function') return '_checkPgPass';
  return undefined;
};

/**
 * Asks a pool's password function through the pool's own `Client`, as that Client asks it for each connection the
 * pool makes (pg-pool 3.14.0, `newClient`, `index.js:241`): the Client's routine runs on a client of the pool's
 * settings, made without the settings' `stream` and `connection` and never connected, and calls the function on that
 * client with the arguments its pg gives, none before pg 8.19.0 and the client's `ConnectionParameters` from 8.19.0.
 * So a pool made with another copy of pg than the one this library loads is asked as its own pg asks. The answer is
 * the client's password once the routine is done: a string, or undefined where the function answered none.
 * Undefined where the Client has no such routine, or no connection whose errors it can be heard on.
 *
 * @throws {unknown} What the routine reports on the client's connection: the function's own error, or pg's
 *   `TypeError` for an answer that is not a string.
 */
const askThroughPoolClient = async (
  PoolClient: unknown,
  settings: PgConnectionSettings,
): Promise<{ answer: string | undefined } | undefined> => {
  const routine = askingRoutineOf(PoolClient);
  if (routine === undefined) return undefined;
  const client = new (PoolClient as new (config: object) => AskingClient)({
    ...settings,
    // pg-pool keeps the settings' password from enumeration, so it is copied by name.
    password: settings.password,
    stream: undefined,
    connection: undefined,
  });
  const ask = client[routine];
  const { connection } = client;
  if (typeof ask !== 'function' || !hasEvents(connection)) return undefined;
  return new Promise((resolve, reject) => {
    const failed = (error: unknown): void => reject(error);
    connection.once('error', failed);
    try {
      ask.call(client, () => {
        connection.removeListener?.('error', failed);
        resolve({ answer: typeof client.password === 'string' ? client.password : undefined });
      });
    } catch (error) {
      connection.removeListener?.('error', failed);
      reject(error);
    }
  });
};

/**
 * The password pg sends for a connection: the settings' string, or the answer of the settings' function, which pg
 * calls on the connecting client, with its `ConnectionParameters` from pg 8.19.0. The function is asked through the
 * pool's own `Client` where the pool names one, as pg-pool's pools do, and otherwise as the pg this library loads
 * asks it. Undefined where neither gives one.
 *
 * @throws {Error} When the function fails or answers something other than a string or undefined.
 */
const passwordOf = async (
  connection: PgConnection,
  settings: PgConnectionSettings,
  PoolClient?: unknown,
): Promise<string | undefined> => {
  const { password } = connection;
  if (typeof password !== 'function') {
    return typeof password === 'string' ? password : undefined;
  }
  let asked: { answer: string | undefined } | undefined;
  try {
    asked = await askThroughPoolClient(PoolClient, settings);
  } catch (error) {
    throw passwordFailure(error);
  }
  if (asked !== undefined) return asked.answer;

  const { self, args } = await passwordCallOf(connection, settings);
  let answer: unknown;
  try {
    answer = await (password as (...parameters: unknown[]) => unknown).apply(self, args);
  } catch (error) {
    throw passwordFailure(error);
  }
  if (answer === undefined) return undefined;
  if (typeof answer !== 'string') throw passwordFailure(new TypeError(NOT_A_STRING));
  return answer;
};

/**
 * A libpq connection URI that reaches what a pg pool with these settings reaches, with its password in the user
 * part, where `PostgresExporter` takes it out for `PGPASSWORD`. Where the pool has no password, the URI holds none
 * and libpq reads `PGPASSWORD`, then `~/.pgpass`, as pg does. Where its password function answers none, pg connects
 * with no password and reads no `PGPASSWORD` (`lib/client.js`, `_getPassword`): the URI holds an empty `password`
 * parameter, which becomes an empty `PGPASSWORD`, so libpq sends the environment's no more than pg does. A
 * connection string pg cannot read as a URL (a keyword=value string) is given back as it is. Undefined when the
 * settings name no database pg would reach. `PoolClient` is the `Client` the pool makes its connections with, which
 * pg-pool keeps as the pool's `Client`: a password function is asked through it.
 *
 * @throws {Error} When the settings ask for TLS that pg_dump cannot take or that pg refuses, or a port pg reads no
 *   number in, or the password function fails.
 */
export const libpqConnectionStringOf = async (
  settings: PgConnectionSettings,
  PoolClient?: unknown,
): Promise<string | undefined> => {
  const { connectionString } = settings;
  if (connectionString && !connectionString.startsWith('/') && !URL_SCHEME.test(connectionString)) {
    return connectionString;
  }
  const env = environment();
  const connection = readAsPg(settings, env);
  if (connection === undefined) return connectionString;
  if (!connection.database) return undefined;

  const password = await passwordOf(connection, settings, PoolClient);
  const parameters = [...connection.parameters];
  if (typeof connection.password === 'function' && !password) parameters.push(['password', '']);
  const user = connection.user ? encodeURIComponent(connection.user) : '';
  const secret = password ? `:${encodeURIComponent(password)}` : '';
  const auth = user || secret ? `${user}${secret}@` : '';
  const query = parameters.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  return (
    `postgresql://${auth}${encodeURIComponent(connection.host)}:${encodeURIComponent(connection.port)}` +
    `/${encodeURIComponent(connection.database)}${query.length > 0 ? `?${query.join('&')}` : ''}`
  );
};
