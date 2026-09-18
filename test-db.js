const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

// Test database path
const testDbPath = path.join(__dirname, 'test-db.sqlite');

// Clean up any existing test database
if (fs.existsSync(testDbPath)) {
  fs.unlinkSync(testDbPath);
}

console.log('Testing database schema creation...\n');

// Create test database
const db = new DatabaseSync(testDbPath);

// Create schema (same as in db.js)
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

console.log('✓ Database schema created successfully\n');

// Test 1: Verify tables exist
console.log('Test 1: Verifying table structure...');
const tables = db.prepare(`
  SELECT name FROM sqlite_master 
  WHERE type='table' 
  ORDER BY name
`).all();

console.log('  Tables found:', tables.map(t => t.name).join(', '));

const expectedTables = ['urls', 'analytics'];
const missingTables = expectedTables.filter(table => 
  !tables.some(t => t.name === table)
);

if (missingTables.length > 0) {
  console.error(`  ✗ Missing tables: ${missingTables.join(', ')}`);
  process.exit(1);
}
console.log('  ✓ All expected tables exist\n');

// Test 2: Verify table columns
console.log('Test 2: Verifying table columns...');

const urlColumns = db.prepare('PRAGMA table_info(urls)').all();
console.log('  URLs table columns:');
urlColumns.forEach(col => {
  console.log(`    ${col.name} (${col.type}) ${col.notnull ? 'NOT NULL' : ''} ${col.pk ? 'PRIMARY KEY' : ''}`);
});

const analyticsColumns = db.prepare('PRAGMA table_info(analytics)').all();
console.log('\n  Analytics table columns:');
analyticsColumns.forEach(col => {
  console.log(`    ${col.name} (${col.type}) ${col.notnull ? 'NOT NULL' : ''} ${col.pk ? 'PRIMARY KEY' : ''}`);
});

// Check for required columns
const requiredUrlColumns = ['short_code', 'original_url', 'user_id'];
const missingUrlColumns = requiredUrlColumns.filter(colName =>
  !urlColumns.some(col => col.name === colName && col.notnull === 1)
);

if (missingUrlColumns.length > 0) {
  console.error(`  ✗ Missing required columns in urls: ${missingUrlColumns.join(', ')}`);
} else {
  console.log('  ✓ All required columns are NOT NULL\n');
}

// Test 3: Insert sample data
console.log('Test 3: Testing with sample data...');

// Insert a URL
const insertUrl = db.prepare('INSERT INTO urls (short_code, original_url, user_id) VALUES (?, ?, ?)');
const result = insertUrl.run('test123', 'https://example.com', 'user1');
const urlId = result.lastInsertRowid;

console.log(`  Inserted URL with ID: ${urlId}`);

// Insert analytics data
const insertAnalytics = db.prepare(`
  INSERT INTO analytics (url_id, ip_address, user_agent, referrer) 
  VALUES (?, ?, ?, ?)
`);

insertAnalytics.run(urlId, '192.168.1.1', 'Test Browser', 'https://google.com');
insertAnalytics.run(urlId, '192.168.1.2', 'Another Browser', '');

console.log('  Inserted 2 analytics records');

// Update click count
const updateClicks = db.prepare('UPDATE urls SET clicks = clicks + 1 WHERE id = ?');
updateClicks.run(urlId);

console.log('  Updated click count\n');

// Test 4: Query data
console.log('Test 4: Querying data...');

// Get URL with analytics
const urlData = db.prepare('SELECT * FROM urls WHERE id = ?').get(urlId);
console.log(`  URL data: ${urlData.short_code} -> ${urlData.original_url}`);
console.log(`  Clicks: ${urlData.clicks}`);

const analyticsData = db.prepare('SELECT COUNT(*) as count FROM analytics WHERE url_id = ?').get(urlId);
console.log(`  Analytics count: ${analyticsData.count}`);

// Test 5: Test constraints
console.log('\nTest 5: Testing constraints...');

// Test UNIQUE constraint on short_code
try {
  insertUrl.run('test123', 'https://example2.com', 'user2');
  console.error('  ✗ UNIQUE constraint failed: Duplicate short_code allowed');
  process.exit(1);
} catch (err) {
  if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    console.log('  ✓ UNIQUE constraint works correctly');
  } else {
    console.error(`  ✗ Unexpected error: ${err.message}`);
  }
}

// Test NOT NULL constraint
try {
  db.prepare('INSERT INTO urls (short_code, original_url) VALUES (?, ?)').run('test456', 'https://example.com');
  console.error('  ✗ NOT NULL constraint failed: NULL user_id allowed');
  process.exit(1);
} catch (err) {
  if (err.message.includes('NOT NULL')) {
    console.log('  ✓ NOT NULL constraint works correctly');
  } else {
    console.error(`  ✗ Unexpected error: ${err.message}`);
  }
}

// Test 6: Test indexes
console.log('\nTest 6: Testing indexes...');
const indexes = db.prepare(`
  SELECT name FROM sqlite_master 
  WHERE type='index' 
  AND name LIKE 'idx_%'
`).all();

console.log('  Indexes found:', indexes.map(i => i.name).join(', '));

const expectedIndexes = ['idx_urls_short_code', 'idx_urls_user_id', 'idx_analytics_url_id'];
const missingIndexes = expectedIndexes.filter(index =>
  !indexes.some(i => i.name === index)
);

if (missingIndexes.length > 0) {
  console.error(`  ✗ Missing indexes: ${missingIndexes.join(', ')}`);
} else {
  console.log('  ✓ All expected indexes exist\n');
}

// Clean up
db.close();
fs.unlinkSync(testDbPath);

console.log('=== Database schema tests completed successfully! ===');
console.log('\nNext steps:');
console.log('1. Start the Rate Limiter service (port 8081)');
console.log('2. Start the URL Shortener: npm start');
console.log('3. Test endpoints with curl or the web interface');
console.log('4. Run integration tests: npm run test:integration');