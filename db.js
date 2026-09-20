const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'db.sqlite'));

db.exec('PRAGMA journal_mode=WAL');
db.exec('PRAGMA foreign_keys=OFF');  // must be OFF during table reconstruction

// ── Check current urls columns ───────────────────────────────────────────────
const cols = db.prepare('PRAGMA table_info(urls)').all().map(r => r.name);
const hasOldSchema = cols.includes('user_id') && !cols.includes('creator_sid');
const needsMigration = cols.includes('user_id');  // user_id must be gone

if (needsMigration) {
  console.log('[db] Rebuilding urls table to remove user_id column…');
  db.exec(`
    BEGIN;

    -- 1. Rename old table
    ALTER TABLE urls RENAME TO urls_old;

    -- 2. Create clean table
    CREATE TABLE urls (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      short_code      TEXT    UNIQUE NOT NULL,
      original_url    TEXT    NOT NULL,
      creator_sid     TEXT    NOT NULL DEFAULT 'legacy',
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at      DATETIME DEFAULT NULL,
      clicks          INTEGER DEFAULT 0,
      last_clicked_at DATETIME
    );

    -- 3. Copy data, map user_id → creator_sid
    INSERT INTO urls (id, short_code, original_url, creator_sid, created_at, expires_at, clicks, last_clicked_at)
    SELECT
      id,
      short_code,
      original_url,
      COALESCE(creator_sid, user_id, 'legacy'),
      created_at,
      NULL,
      clicks,
      last_clicked_at
    FROM urls_old;

    -- 4. Drop old table
    DROP TABLE urls_old;

    COMMIT;
  `);
  console.log('[db] Migration complete');
}

// ── Create tables if fresh database ─────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS urls (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    short_code      TEXT    UNIQUE NOT NULL,
    original_url    TEXT    NOT NULL,
    creator_sid     TEXT    NOT NULL DEFAULT 'legacy',
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at      DATETIME DEFAULT NULL,
    clicks          INTEGER DEFAULT 0,
    last_clicked_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS analytics (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    url_id      INTEGER NOT NULL,
    ip_address  TEXT,
    user_agent  TEXT,
    referrer    TEXT,
    clicked_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (url_id) REFERENCES urls(id)
  );
`);

// ── Add expires_at if missing (pre-migration dbs that already had creator_sid) ─
const colsNow = db.prepare('PRAGMA table_info(urls)').all().map(r => r.name);
if (!colsNow.includes('expires_at')) {
  db.exec(`ALTER TABLE urls ADD COLUMN expires_at DATETIME DEFAULT NULL`);
  console.log('[db] Added expires_at column');
}

// ── Indexes ──────────────────────────────────────────────────────────────────
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_urls_short_code  ON urls(short_code);
  CREATE INDEX IF NOT EXISTS idx_urls_creator_sid ON urls(creator_sid);
  CREATE INDEX IF NOT EXISTS idx_urls_expires_at  ON urls(expires_at);
  CREATE INDEX IF NOT EXISTS idx_analytics_url_id ON analytics(url_id);
`);

// Re-enable FK enforcement
db.exec('PRAGMA foreign_keys=ON');

module.exports = db;
