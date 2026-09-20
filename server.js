const express      = require('express');
const crypto       = require('crypto');
const helmet       = require('helmet');
const cookieParser = require('cookie-parser');
const { spawn }    = require('child_process');
const db           = require('./db');
const { checkRateLimit } = require('./rateLimiter');

const app  = express();
const PORT = process.env.PORT || 8080;

// ── Security ─────────────────────────────────────────────────────────────────
app.set('trust proxy', true);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      styleSrc:    ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
      imgSrc:      ["'self'", "data:", "https://cdn.jsdelivr.net"],
      connectSrc:  ["'self'", "http://localhost:8080", "http://localhost:5175"],
      frameAncestors: ["'none'"],
    }
  },
  crossOriginEmbedderPolicy: false,  // not needed for this app
}));

app.use(cookieParser(process.env.COOKIE_SECRET || 'changeme-in-prod'));
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: true, limit: '16kb' }));
app.use(express.static('public'));

// ── Request logger ────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// ── Session cookie middleware ─────────────────────────────────────────────────
// Assigns every visitor a random httpOnly cookie the first time they arrive.
// This is the only "identity" we track — no login, no user_id.
const SID_COOKIE   = 'sid';
const SID_MAX_AGE  = 365 * 24 * 60 * 60 * 1000; // 1 year

function ensureSid(req, res) {
  let sid = req.cookies[SID_COOKIE];
  if (!sid || !/^[a-f0-9]{32}$/.test(sid)) {
    sid = crypto.randomBytes(16).toString('hex');
    res.cookie(SID_COOKIE, sid, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge:   SID_MAX_AGE,
      // secure: true,  // enable behind HTTPS in production
    });
  }
  return sid;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateShortCode(length = 7) {
  // 7 base62 chars → ~3.5 trillion combinations
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

/** Validate a custom alias: 3-32 chars, alphanumeric + -_ */
function validateAlias(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (v.length < 3 || v.length > 32) return null;
  if (!/^[a-z0-9_-]+$/.test(v)) return null;
  return v;
}

// Paths that can never be used as short codes or aliases
const RESERVED = new Set([
  'api', 'health', 'crash', 'public', 'static',
  'favicon.ico', 'robots.txt', 'sitemap.xml',
]);

// node:sqlite uses errcode 2067 for UNIQUE constraint violations
function isUniqueViolation(err) {
  return err.errcode === 2067 || err.message?.includes('UNIQUE constraint failed');
}

/** Insert with retry loop for random-code collisions */
function insertWithRetry(originalUrl, creatorSid, preferredCode, expiresAt, maxAttempts = 8) {
  const insert = db.prepare(
    'INSERT INTO urls (short_code, original_url, creator_sid, expires_at) VALUES (?, ?, ?, ?)'
  );

  if (preferredCode) {
    insert.run(preferredCode, originalUrl, creatorSid, expiresAt);
    return preferredCode;
  }

  for (let i = 0; i < maxAttempts; i++) {
    const code = generateShortCode();
    try {
      insert.run(code, originalUrl, creatorSid, expiresAt);
      return code;
    } catch (err) {
      if (isUniqueViolation(err) && i < maxAttempts - 1) {
        console.warn(`Collision on "${code}", retrying (${i + 1}/${maxAttempts})…`);
        continue;
      }
      throw err;
    }
  }
}

/** Parse a TTL string like "1h", "7d", "30d", "never" → ISO datetime or null */
function parseTtl(ttl) {
  if (!ttl || ttl === 'never') return null;
  const map = { '1h': 3600, '24h': 86400, '7d': 604800, '30d': 2592000 };
  const secs = map[ttl];
  if (!secs) return null;
  return new Date(Date.now() + secs * 1000).toISOString();
}

function isExpired(row) {
  return row.expires_at && new Date(row.expires_at) < new Date();
}

// ── API Routes ────────────────────────────────────────────────────────────────

// POST /api/shorten
app.post('/api/shorten', async (req, res) => {
  const sid = ensureSid(req, res);
  const { url, custom_alias, ttl } = req.body;

  // Validate URL
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required' });
  }
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'Only http and https URLs are allowed' });
  }

  // Validate custom alias
  let shortCode = null;
  if (custom_alias) {
    shortCode = validateAlias(custom_alias);
    if (!shortCode) {
      return res.status(400).json({
        error: 'Alias must be 3–32 characters: lowercase letters, numbers, - or _'
      });
    }
    if (RESERVED.has(shortCode)) {
      return res.status(400).json({ error: `"${shortCode}" is reserved` });
    }
  }

  // Parse TTL
  const expiresAt = parseTtl(ttl);

  // Rate limit by IP
  const ip = req.ip || '0.0.0.0';
  try {
    const rl = await checkRateLimit(`create:${ip}`);
    if (!rl.allowed) {
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }
  } catch {
    // Rate limiter down — fail open, log only
    console.warn('Rate limiter unavailable');
  }

  try {
    const code = insertWithRetry(parsed.href, sid, shortCode, expiresAt);
    console.log(`[shorten] ${code} → ${parsed.href} (sid:${sid.slice(0,8)}… ttl:${ttl || 'never'})`);

    return res.status(201).json({
      short_code:   code,
      short_url:    `${req.protocol}://${req.headers.host}/${code}`,
      preview_url:  `${req.protocol}://${req.headers.host}/${code}+`,
      original_url: parsed.href,
      expires_at:   expiresAt,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: `Alias "${shortCode}" is already taken` });
    }
    console.error('[shorten] error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/urls/:shortCode — cookie-ownership check
app.delete('/api/urls/:shortCode', (req, res) => {
  const sid = req.cookies[SID_COOKIE];
  if (!sid) return res.status(401).json({ error: 'No session — nothing to delete' });

  const { shortCode } = req.params;
  const row = db.prepare('SELECT * FROM urls WHERE short_code = ?').get(shortCode);

  if (!row)             return res.status(404).json({ error: 'Not found' });
  if (row.creator_sid !== sid) return res.status(403).json({ error: 'Not your link' });

  db.prepare('DELETE FROM analytics WHERE url_id = ?').run(row.id);
  db.prepare('DELETE FROM urls WHERE id = ?').run(row.id);

  console.log(`[delete] ${shortCode} by sid:${sid.slice(0,8)}…`);
  return res.json({ deleted: true, short_code: shortCode });
});

// GET /api/my-urls — links belonging to this browser session
app.get('/api/my-urls', (req, res) => {
  const sid = req.cookies[SID_COOKIE];
  if (!sid) return res.json({ urls: [] });

  const urls = db.prepare(
    'SELECT * FROM urls WHERE creator_sid = ? ORDER BY created_at DESC LIMIT 100'
  ).all(sid);

  return res.json({ urls });
});

// GET /api/analytics/:shortCode — public stats (no auth required)
app.get('/api/analytics/:shortCode', (req, res) => {
  const { shortCode } = req.params;
  const row = db.prepare('SELECT * FROM urls WHERE short_code = ?').get(shortCode);

  if (!row)         return res.status(404).json({ error: 'Not found' });
  if (isExpired(row)) return res.status(410).json({ error: 'This link has expired' });

  const totalClicks  = db
    .prepare('SELECT COUNT(*) as count FROM analytics WHERE url_id = ?')
    .get(row.id).count;
  const recentClicks = db
    .prepare('SELECT ip_address, referrer, clicked_at FROM analytics WHERE url_id = ? ORDER BY clicked_at DESC LIMIT 50')
    .all(row.id);

  return res.json({
    short_code:    row.short_code,
    original_url:  row.original_url,
    created_at:    row.created_at,
    expires_at:    row.expires_at,
    clicks:        totalClicks,
    recent_clicks: recentClicks,
    is_owner:      req.cookies[SID_COOKIE] === row.creator_sid,
  });
});

// ── Special routes (must come before /:shortCode wildcard) ───────────────────

// GET /health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()) });
});

// GET /crash — intentional crash for rate-limiter resilience testing
app.get('/crash', () => process.exit(1));

// POST /api/rate-limiter/start — restart Rate Limiter process (demo convenience)
app.post('/api/rate-limiter/start', (req, res) => {
  const rl = spawn('go', ['run', './cmd/rate-limiter'], {
    cwd: 'C:\\Users\\zoro\\Desktop\\30\\Rate Limiter',
    detached: true,
    stdio: 'ignore',
  });
  rl.unref();
  res.json({ status: 'starting', pid: rl.pid });
});

// ── Preview page  GET /:shortCode+ ──────────────────────────────────────────
// The "+" suffix shows a preview instead of redirecting — a standard convention
// used by Bitly, TinyURL, etc.
app.get('/:shortCode\\+', (req, res) => {
  // Express decodes the param; strip the trailing + that was part of the path
  const shortCode = req.params.shortCode;
  const row = db.prepare('SELECT * FROM urls WHERE short_code = ?').get(shortCode);

  if (!row) return res.status(404).sendFile('404.html', { root: 'public' });

  const expired   = isExpired(row);
  const totalClicks = db.prepare('SELECT COUNT(*) as c FROM analytics WHERE url_id = ?').get(row.id).c;
  const isOwner   = req.cookies[SID_COOKIE] === row.creator_sid;

  // Minimal HTML preview — no framework needed
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Link Preview · snip.ly</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
         background:#0f1117;color:#e8eaf6;display:flex;flex-direction:column;
         align-items:center;justify-content:center;min-height:100vh;padding:20px}
    .card{background:#1a1d27;border:1px solid #2e3250;border-radius:14px;
          padding:36px 40px;max-width:560px;width:100%;text-align:center}
    .logo{font-size:13px;font-weight:700;color:#6c63ff;letter-spacing:1px;
          text-transform:uppercase;margin-bottom:24px}
    .code{font-size:28px;font-weight:800;color:#e8eaf6;margin-bottom:6px}
    .dest{font-size:13px;color:#7b7f9e;word-break:break-all;margin-bottom:28px;
          padding:10px 14px;background:#0f1117;border-radius:8px;border:1px solid #2e3250}
    .meta{display:flex;gap:20px;justify-content:center;flex-wrap:wrap;
          margin-bottom:28px;font-size:12px;color:#4a4e6a}
    .meta span b{color:#7b7f9e}
    .btn{display:inline-block;padding:13px 32px;border-radius:9px;font-size:15px;
         font-weight:700;text-decoration:none;transition:.15s}
    .btn-go{background:#6c63ff;color:#fff}
    .btn-go:hover{background:#857dff}
    .expired{color:#ef4444;font-size:14px;margin-bottom:16px;
             padding:10px;background:rgba(239,68,68,.1);border-radius:8px;
             border:1px solid rgba(239,68,68,.3)}
    .back{margin-top:20px;font-size:12px;color:#4a4e6a}
    .back a{color:#6c63ff;text-decoration:none}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">snip.ly · link preview</div>
    <div class="code">/${row.short_code}</div>
    <div class="dest">${escHtml(row.original_url)}</div>
    <div class="meta">
      <span><b>${totalClicks}</b> clicks</span>
      <span>Created <b>${new Date(row.created_at).toLocaleDateString()}</b></span>
      ${row.expires_at ? `<span>Expires <b>${new Date(row.expires_at).toLocaleDateString()}</b></span>` : ''}
    </div>
    ${expired
      ? `<div class="expired">⚠️ This link has expired and will no longer redirect.</div>`
      : `<a class="btn btn-go" href="/${row.short_code}">Continue to destination →</a>`
    }
    <div class="back"><a href="/">← Back to snip.ly</a></div>
  </div>
</body>
</html>`);
});

// ── Redirect  GET /:shortCode ─────────────────────────────────────────────────
app.get('/:shortCode', async (req, res) => {
  const { shortCode } = req.params;

  // Let static files fall through
  if (shortCode.includes('.')) return res.status(404).send('Not found');

  const row = db.prepare('SELECT * FROM urls WHERE short_code = ?').get(shortCode);
  if (!row) return res.status(404).sendFile('404.html', { root: 'public' });

  if (isExpired(row)) {
    return res.status(410).sendFile('410.html', { root: 'public' });
  }

  // Rate limit by short code to prevent redirect abuse
  try {
    const rl = await checkRateLimit(`redirect:${shortCode}`);
    if (!rl.allowed) return res.status(429).json({ error: 'Too many requests' });
  } catch {
    console.warn('Rate limiter unavailable');
  }

  // Log analytics (non-blocking)
  try {
    db.prepare(
      'INSERT INTO analytics (url_id, ip_address, user_agent, referrer) VALUES (?, ?, ?, ?)'
    ).run(row.id, req.ip || '', req.get('User-Agent') || '', req.get('Referer') || '');
    db.prepare(
      'UPDATE urls SET clicks = clicks + 1, last_clicked_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(row.id);
  } catch (err) {
    console.error('[analytics] write failed:', err.message);
  }

  return res.redirect(301, row.original_url);
});

// ── Error pages helpers ───────────────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Start ─────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`snip.ly running on http://localhost:${PORT}`);
});

function shutdown(signal) {
  console.log(`[${signal}] Shutting down…`);
  server.close(() => { console.log('Server closed'); process.exit(0); });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
