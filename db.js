const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'db.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS urls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    short_code TEXT UNIQUE NOT NULL,
    original_url TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    clicks INTEGER DEFAULT 0,
    last_clicked_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url_id INTEGER NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    referrer TEXT,
    clicked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (url_id) REFERENCES urls(id)
  );

  CREATE INDEX IF NOT EXISTS idx_urls_short_code ON urls(short_code);
  CREATE INDEX IF NOT EXISTS idx_urls_user_id ON urls(user_id);
  CREATE INDEX IF NOT EXISTS idx_analytics_url_id ON analytics(url_id);
`);

module.exports = db;
