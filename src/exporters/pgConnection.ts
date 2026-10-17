/**
 * @fileoverview The connection a pg pool makes, written as a libpq connection URI, so that `pg_dump` reaches the
 * server, the database and the user the adapter's pool reaches.
 *
 * pg reads a connection string with the WHATWG URL parser (pg-connection-string's `parse`), and fills what the
 * settings leave out from `PGUSER`, `PGDATABASE`, `PGPORT` and `PGHOST`, then the operating system's user, the
 * user's name, 5432 and localhost (pg `lib/connection-parameters.js`). libpq reads a URI by its own grammar
 * (`fe-connect.c`, `conninfo_uri_parse_options`): it ends the user part at the first `@` that comes before any
 * `/`, and it refuses a query parameter it does not know. So `postgresql://db.example?application_name=x@y` names
 * the host `db.example` to pg and `y` to libpq. The URI written here holds pg's reading: the user, the host, the
 * port and the database spelled out and percent-encoded, and the parameters libpq knows, pg's own spellings of
 * TLS translated.
 * @module sql-storage-adapter/exporters/pgConnection
 */

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
 * The parameters libpq takes in a connection URI (PostgreSQL 18, `fe-connect.c`, `PQconninfoOptions`), less the
 * ones the URI spells out (`user`, `password`, `host`, `port`, `dbname`) and the ones pg does not read (`service`,
 * `hostaddr`). libpq refuses a URI with any other, so pg's own (`statement_timeout`, `uselibpqcompat`) and names
 * neither knows are left out. So are `sslpassword`, `oauth_client_secret`, `scram_client_key` and
 * `scram_server_key`: libpq takes them from the connection string alone, which is pg_dump's command line, and pg
 * reads none of them, so the connection pg makes needs none.
 */
const LIBPQ_PARAMETERS = new Set([
  'passfile',
  'channel_binding',
  'connect_timeout',
  'client_encoding',
  'options',
  'application_name',
  'fallback_application_name',
  'keepalives',
  'keepalives_idle',
  'keepalives_interval',
  'keepalives_count',
  'tcp_user_timeout',
  'sslmode',
  'sslnegotiation',
  'sslcompression',
  'sslcert',
  'sslkey',
  'sslcertmode',
  'sslrootcert',
  'sslcrl',
  'sslcrldir',
  'sslsni',
  'requirepeer',
  'require_auth',
  'min_protocol_version',
  'max_protocol_version',
  'ssl_min_protocol_version',
  'ssl_max_protocol_version',
  'gssencmode',
  'krbsrvname',
  'gsslib',
  'gssdelegation',
  'replication',
  'target_session_attrs',
  'load_balance_hosts',
  'oauth_issuer',
  'oauth_client_id',
  'oauth_scope',
  'sslkeylogfile',
]);

/** The connection string parameters that set TLS, after which pg reads none of the settings' `ssl`. */
const TLS_PARAMETERS = ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert'];

/** The `sslmode` values that make libpq use TLS, which a pool's `ssl` asks for. */
const TLS_SSLMODES = new Set(['require', 'verify-ca', 'verify-full']);

/** The `sslmode` values with which libpq connects without TLS to a server that offers none, as pg does with no `ssl`. */
const PLAIN_SSLMODES = new Set(['disable', 'allow', 'prefer']);

/** A URI scheme, which pg reads a connection string as a URL for. */
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** pg's `ssl` from `PGSSLMODE` where the settings give none (pg `lib/connection-parameters.js`). */
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
 * @throws {Error} When the settings ask for TLS options libpq takes only from files.
 */
const readAsPg = (settings: PgConnectionSettings, env: Environment): PgConnection | undefined => {
  let user = settings.user;
  let password = settings.password;
  let host = settings.host;
  let port = settings.port === undefined ? undefined : String(settings.port);
  let database = settings.database;
  const parameters: Array<[string, string]> = [];
  let ownTls = false;

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
    const sslParameter = last('ssl');
    const sslmode = last('sslmode');
    // pg takes its TLS from the string, and not from the settings' ssl, when the string has an ssl
    // parameter, a sslmode, sslcert, sslkey or sslrootcert, or sslnegotiation=direct.
    ownTls =
      sslParameter !== undefined ||
      TLS_PARAMETERS.some((name) => name !== 'ssl' && Boolean(last(name))) ||
      last('sslnegotiation') === 'direct';
    for (const [key, value] of parsed.parameters) {
      if (key === 'sslmode') {
        // pg's no-verify is libpq's require; an empty sslmode is none, to pg too.
        if (value) parameters.push([key, value === 'no-verify' ? 'require' : value]);
      } else if (LIBPQ_PARAMETERS.has(key)) {
        parameters.push([key, value]);
      }
    }
    if (!sslmode) {
      if (sslParameter !== undefined) {
        // pg reads ssl=0 and an empty ssl as no TLS and any other value as TLS; libpq knows only ssl=true.
        parameters.push(['sslmode', sslParameter === '0' || sslParameter === '' ? 'disable' : 'require']);
      } else if (ownTls && !TLS_SSLMODES.has(env.PGSSLMODE ?? '')) {
        // A certificate file or direct negotiation turns pg's TLS on, which libpq's default sslmode leaves optional.
        parameters.push(['sslmode', 'require']);
      }
    }
  }

  const osUser = typeof process !== 'undefined' && process.platform === 'win32' ? env.USERNAME : env.USER;
  const resolvedUser = user || env.PGUSER || osUser || undefined;
  const connection: PgConnection = {
    user: resolvedUser,
    database: database || env.PGDATABASE || resolvedUser,
    host: host || env.PGHOST || 'localhost',
    port: port || env.PGPORT || '5432',
    password: password || undefined,
    parameters,
  };

  if (!ownTls) {
    const ssl = settings.ssl !== undefined ? settings.ssl : sslFromEnvironment(env.PGSSLMODE);
    if (ssl) {
      const beyond = tlsSettingsBeyondSslmode(ssl);
      if (beyond.length > 0) {
        throw new Error(
          `PostgresExporter: the pool's ssl settings ${beyond.join(', ')} cannot reach pg_dump, which reads TLS ` +
            'material from files alone. Give the pool a connectionString whose sslrootcert, sslcert and sslkey ' +
            'parameters name the files, or set PGSSLROOTCERT, PGSSLCERT and PGSSLKEY and give the pool ssl: true.',
        );
      }
      // libpq's require encrypts and checks no certificate; a PGSSLMODE that checks one is kept.
      if (!TLS_SSLMODES.has(env.PGSSLMODE ?? '')) {
        connection.parameters.push(['sslmode', 'require']);
      }
    } else if (env.PGSSLMODE && !PLAIN_SSLMODES.has(env.PGSSLMODE)) {
      // pg connects without TLS here, its ssl being false or PGSSLMODE a value it does not know. libpq would read
      // PGSSLMODE: it refuses pg's no-verify, and require or verify-* insist on TLS where pg makes none.
      connection.parameters.push(['sslmode', 'disable']);
    }
  }
  return connection;
};

/**
 * The password pg sends for a connection: the settings' string, or the answer of the settings' function, which pg
 * calls with the connection's parameters. Undefined gives pg_dump no password, so libpq reads `PGPASSWORD` and
 * `~/.pgpass`; pg, given undefined by a function, connects with no password and reads neither.
 *
 * @throws {Error} When the function fails or answers something other than a string or undefined.
 */
const passwordOf = async (connection: PgConnection): Promise<string | undefined> => {
  const { password } = connection;
  if (typeof password !== 'function') {
    return typeof password === 'string' ? password : undefined;
  }
  let answer: unknown;
  try {
    answer = await (password as (parameters: object) => unknown)({
      user: connection.user,
      database: connection.database,
      host: connection.host,
      port: Number(connection.port),
    });
  } catch (error) {
    // The function's own error is kept as the cause, out of the message, which a log may show.
    const failure: Error & { cause?: unknown } = new Error(
      'PostgresExporter: the password function of the pool failed, so pg_dump has no password.',
    );
    failure.cause = error;
    throw failure;
  }
  if (answer === undefined) return undefined;
  if (typeof answer !== 'string') {
    throw new Error('PostgresExporter: the password function of the pool answered no string, which pg refuses too.');
  }
  return answer;
};

/**
 * A libpq connection URI that reaches what a pg pool with these settings reaches, with its password in the user
 * part, where `PostgresExporter` takes it out for `PGPASSWORD`. A connection string pg cannot read as a URL (a
 * keyword=value string) is given back as it is. Undefined when the settings name no database pg would reach.
 *
 * @throws {Error} When the settings ask for TLS that pg_dump cannot take, or the password function fails.
 */
export const libpqConnectionStringOf = async (settings: PgConnectionSettings): Promise<string | undefined> => {
  const { connectionString } = settings;
  if (connectionString && !connectionString.startsWith('/') && !URL_SCHEME.test(connectionString)) {
    return connectionString;
  }
  const env = environment();
  const connection = readAsPg(settings, env);
  if (connection === undefined) return connectionString;
  if (!connection.database) return undefined;

  const password = await passwordOf(connection);
  const user = connection.user ? encodeURIComponent(connection.user) : '';
  const secret = password ? `:${encodeURIComponent(password)}` : '';
  const auth = user || secret ? `${user}${secret}@` : '';
  const query = connection.parameters.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  return (
    `postgresql://${auth}${encodeURIComponent(connection.host)}:${encodeURIComponent(connection.port)}` +
    `/${encodeURIComponent(connection.database)}${query.length > 0 ? `?${query.join('&')}` : ''}`
  );
};
