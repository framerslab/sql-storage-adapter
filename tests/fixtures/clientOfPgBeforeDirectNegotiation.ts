import pg from 'pg';

/**
 * How the pg-connection-string under a pg before 8.22.0 reads `sslnegotiation=direct` in a connection string:
 * 2.14.0 and later turn TLS on for it where the string sets no other TLS (index.js:81-86), and earlier ones read
 * nothing in it. pg 8.13.1 to 8.21.x take pg-connection-string through a caret range (^2.7.0 to ^2.13.0) that admits
 * versions either side of 2.14.0, so either reading is what an install of them may run.
 */
export type ParseOfDirect = 'turns-tls-on' | 'reads-nothing';

/** A connection string with its `sslnegotiation` parameters taken out. */
const withoutSslNegotiation = (connectionString: string): string => {
  const url = new URL(connectionString);
  url.searchParams.delete('sslnegotiation');
  return url.toString();
};

/**
 * The `Client` of a pool made with a pg before 8.22.0, which reads no `sslnegotiation`: it keeps none among its
 * ConnectionParameters and opens TLS with an SSLRequest whatever a connection string or the settings say (pg 8.21.0
 * `lib/client.js` and `lib/connection.js`), where the installed pg (8.22.0 and later) reads the parameter and with
 * `direct` starts TLS at once. Whether `direct` turns TLS on is the parse's doing, chosen here. It stands for a pool
 * of another copy of pg than the one this library loads: pg-pool makes each connection with the Client its options
 * name (pg-pool 3.14.0, index.js:95 and 241) and keeps it as the pool's `Client`.
 */
export const clientOfPgBeforeDirectNegotiation = (parse: ParseOfDirect): typeof pg.Client =>
  class ClientOfPgBeforeDirectNegotiation extends pg.Client {
    constructor(config?: string | pg.ClientConfig) {
      const settings: pg.ClientConfig = typeof config === 'string' ? { connectionString: config } : { ...config };
      if (typeof config === 'object' && config !== null) {
        // pg-pool keeps the settings' password from enumeration, so it is copied by name.
        settings.password = config.password;
      }
      if (parse === 'reads-nothing' && settings.connectionString && !settings.connectionString.startsWith('/')) {
        settings.connectionString = withoutSslNegotiation(settings.connectionString);
      }
      super(settings);
      // pg's own fields, which @types/pg does not declare.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const self = this as any;
      delete self.connectionParameters.sslnegotiation;
      self.sslNegotiation = 'postgres';
      if (self.connection) self.connection.sslNegotiation = 'postgres';
    }
  };
