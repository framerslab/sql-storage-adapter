import pg from 'pg';

/**
 * A pg `Client` that asks a password function as pg before 8.19.0 asks it: as a
 * method of the connecting client, with no arguments. Its `_getPassword` asks
 * a function as pg 8.18.0's does (lib/client.js), where the installed pg
 * (8.19.0 and later) passes the client's ConnectionParameters, and leaves a
 * password that is no function as it is. It stands for the Client of a pool made
 * with another copy of pg than the one this library loads: pg-pool makes each
 * connection with the Client its options name, else its pg's (pg-pool 3.14.0,
 * index.js:95 and 241), and keeps it as the pool's `Client`.
 */
export class ClientOfEarlierPg extends pg.Client {
  // pg's own fields, which @types/pg does not declare.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _getPassword(this: any, cb: () => void): void {
    const con = this.connection;
    if (typeof this.password === 'function') {
      this._Promise
        .resolve()
        .then(() => this.password())
        .then((pass: unknown) => {
          if (pass !== undefined) {
            if (typeof pass !== 'string') {
              con.emit('error', new TypeError('Password must be a string'));
              return;
            }
            this.connectionParameters.password = this.password = pass;
          } else {
            this.connectionParameters.password = this.password = null;
          }
          cb();
        })
        .catch((err: unknown) => {
          con.emit('error', err);
        });
    } else {
      cb();
    }
  }
}
