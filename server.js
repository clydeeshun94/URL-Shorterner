const express = require('express');
const crypto = require('crypto');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 8080;
const CRASH_ENDPOINT = process.env.CRASH_ENDPOINT || '/crash';
const RATE_LIMIT_CHECK_URL = process.env.RATE_LIMIT_CHECK_URL || 'http://localhost:8081/check';

// Trust proxy for accurate IP addresses (useful if behind reverse proxy)
app.set('trust proxy', true);

app.use(express.json());
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

function generateShortCode(length = 6) {
  return crypto.randomBytes(length).toString('hex').slice(0, length);
}

async function checkRateLimit(identity, policy = { limit: 50, window: 60 }) {
  try {
    const res = await fetch(RATE_LIMIT_CHECK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identity,
        algorithm: 'fixed_window',
        policy
      })
    });
    
    if (!res.ok) {
      // If Rate Limiter service is down or returns error, fail open (allow)
      console.error(`Rate limiter check failed with status: ${res.status}`);
      return { allowed: true };
    }
    
    const data = await res.json();
    return data;
  } catch (err) {
    // If fetch fails (network error), fail open (allow)
    console.error(`Rate limiter check error: ${err.message}`);
    return { allowed: true };
  }
}

app.post('/api/shorten', async (req, res) => {
  const { url, user_id } = req.body;

  if (!url || !user_id) {
    return res.status(400).json({ error: 'url and user_id are required' });
  }

  // Validate URL format
  try {
    new URL(url);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  const rateLimit = await checkRateLimit(`create:${user_id}`);
  if (!rateLimit.allowed) {
    return res.status(429).json({ 
      error: 'Rate limit exceeded. Try again later.',
      retryAfter: rateLimit.retryAfter || 60
    });
  }

  try {
    const shortCode = generateShortCode();
    const insert = db.prepare('INSERT INTO urls (short_code, original_url, user_id) VALUES (?, ?, ?)');
    insert.run(shortCode, url, user_id);
    
    console.log(`Shortened URL for user ${user_id}: ${shortCode} -> ${url}`);
    
    res.json({ 
      short_code: shortCode, 
      short_url: `${req.protocol}://${req.headers.host}/${shortCode}`,
      original_url: url,
      user_id: user_id
    });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      // Retry with a new code if collision happens (very rare)
      console.warn(`Short code collision for ${shortCode}, retrying...`);
      const shortCode = generateShortCode();
      const insert = db.prepare('INSERT INTO urls (short_code, original_url, user_id) VALUES (?, ?, ?)');
      insert.run(shortCode, url, user_id);
      res.json({ 
        short_code: shortCode, 
        short_url: `${req.protocol}://${req.headers.host}/${shortCode}`,
        original_url: url,
        user_id: user_id
      });
    } else {
      console.error(`Error shortening URL: ${err.message}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

app.get('/:shortCode', async (req, res) => {
  const { shortCode } = req.params;
  const urlRow = db.prepare('SELECT * FROM urls WHERE short_code = ?').get(shortCode);

  if (!urlRow) {
    return res.status(404).json({ error: 'URL not found' });
  }

  // Apply redirect rate limiting per short code
  const rateLimit = await checkRateLimit(`redirect:${shortCode}`, { limit: 200, window: 60 });
  if (!rateLimit.allowed) {
    return res.status(429).json({ error: 'Redirect rate limit exceeded for this URL. Try again later.' });
  }

  const insertClick = db.prepare(`INSERT INTO analytics (url_id, ip_address, user_agent, referrer) VALUES (?, ?, ?, ?)`);
  insertClick.run(
    urlRow.id,
    req.ip,
    req.get('User-Agent'),
    req.get('Referer') || ''
  );

  db.prepare('UPDATE urls SET clicks = clicks + 1, last_clicked_at = CURRENT_TIMESTAMP WHERE id = ?').run(urlRow.id);

  res.redirect(301, urlRow.original_url);
});

// Middleware for API rate limiting
async function apiRateLimit(req, res, next) {
  const userId = req.body?.user_id || req.query?.user_id;
  if (!userId) {
    return res.status(400).json({ error: 'user_id required for rate limiting' });
  }
  
  const rateLimit = await checkRateLimit(`api:${userId}`, { limit: 100, window: 60 });
  if (!rateLimit.allowed) {
    return res.status(429).json({ error: 'API rate limit exceeded. Try again later.' });
  }
  next();
}

app.get('/api/analytics/:shortCode', async (req, res) => {
  // Get user_id from the URL owner, not from request
  const { shortCode } = req.params;
  const urlRow = db.prepare('SELECT * FROM urls WHERE short_code = ?').get(shortCode);

  if (!urlRow) {
    return res.status(404).json({ error: 'URL not found' });
  }

  // Apply API rate limiting for the URL owner
  const rateLimit = await checkRateLimit(`api:${urlRow.user_id}`, { limit: 100, window: 60 });
  if (!rateLimit.allowed) {
    return res.status(429).json({ error: 'API rate limit exceeded. Try again later.' });
  }

  const clicks = db.prepare('SELECT * FROM analytics WHERE url_id = ? ORDER BY clicked_at DESC LIMIT 100').all(urlRow.id);
  const totalClicks = db.prepare('SELECT COUNT(*) as count FROM analytics WHERE url_id = ?').get(urlRow.id).count;

  res.json({
    original_url: urlRow.original_url,
    user_id: urlRow.user_id,
    created_at: urlRow.created_at,
    clicks: totalClicks,
    recent_clicks: clicks
  });
});

app.get('/api/urls', async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) {
    return res.status(400).json({ error: 'user_id required' });
  }

  // Apply API rate limiting
  const rateLimit = await checkRateLimit(`api:${user_id}`, { limit: 100, window: 60 });
  if (!rateLimit.allowed) {
    return res.status(429).json({ error: 'API rate limit exceeded. Try also again later.' });
  }

  const urls = db.prepare('SELECT * FROM urls WHERE user_id = ? ORDER BY created_at DESC').all(user_id);
  res.json({ urls });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

app.get('/crash', (req, res) => {
  process.exit(1);
});

const serverInstance = app.listen(PORT, () => {
  console.log(`URL Shortener running on port ${PORT}`);
  console.log(`Crash endpoint: ${CRASH_ENDPOINT}`);
});

function shutdown() {
  console.log('Shutting down gracefully...');
  serverInstance.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
