const session = require('express-session');

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS sessions (
    sid     VARCHAR       NOT NULL PRIMARY KEY,
    sess    JSONB         NOT NULL,
    expire  TIMESTAMPTZ   NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expire_idx ON sessions (expire);
`;

class PgSessionStore extends session.Store {
  constructor(pool) {
    super();
    this.pool = pool;
    // Create table on startup — safe to call repeatedly (IF NOT EXISTS)
    pool.query(CREATE_TABLE).catch(err =>
      console.error('PgSessionStore: table init error:', err.message)
    );
    // Prune expired rows once per hour
    this._pruneTimer = setInterval(() => {
      pool.query('DELETE FROM sessions WHERE expire < NOW()').catch(() => {});
    }, 3600 * 1000);
    this._pruneTimer.unref(); // don't keep process alive just for this
  }

  get(sid, cb) {
    this.pool.query(
      'SELECT sess FROM sessions WHERE sid = $1 AND expire > NOW()',
      [sid]
    ).then(({ rows }) => cb(null, rows[0]?.sess ?? null))
     .catch(cb);
  }

  set(sid, sess, cb) {
    const ttl = sess.cookie?.maxAge ?? 8 * 3600 * 1000;
    const expire = new Date(Date.now() + ttl);
    this.pool.query(
      `INSERT INTO sessions (sid, sess, expire) VALUES ($1, $2, $3)
       ON CONFLICT (sid) DO UPDATE SET sess = $2, expire = $3`,
      [sid, sess, expire]
    ).then(() => cb(null))
     .catch(cb);
  }

  destroy(sid, cb) {
    this.pool.query('DELETE FROM sessions WHERE sid = $1', [sid])
      .then(() => cb(null))
      .catch(cb);
  }

  touch(sid, sess, cb) {
    const ttl = sess.cookie?.maxAge ?? 8 * 3600 * 1000;
    const expire = new Date(Date.now() + ttl);
    this.pool.query(
      'UPDATE sessions SET expire = $2 WHERE sid = $1',
      [sid, expire]
    ).then(() => cb(null))
     .catch(cb);
  }
}

module.exports = PgSessionStore;
