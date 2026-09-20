# URL Shortener — Project Spec

## Overview

A lightweight URL shortening service with analytics, built to serve as the test bed for the Rate Limiter project. Per 30.md, this is Toy Project 1 in the portfolio.

## Tech Stack

- **Backend:** Node.js (Express)
- **Database:** SQLite (Node built-in `node:sqlite` — no native dependencies)
- **Frontend:** HTML5 + vanilla JS (no frameworks)
- **Rate Limiter:** Go service via HTTP (`/check` endpoint on `localhost:8081`)

## What It Does

### Core Features

1. **Shorten URLs** — `POST /api/shorten` with `{url, user_id}` → returns `{short_code, short_url}`
2. **Redirect** — `GET /:shortCode` → 301 redirect to original URL, logs analytics click
3. **View Analytics** — `GET /api/analytics/:shortCode` → click count, recent clicks with IP/user-agent/referrer
4. **List User URLs** — `GET /api/urls?user_id=xxx` → all URLs for that user

### Rate Limiter Integration Points

The Rate Limiter (Go service on `localhost:8080`) controls three flows:

| Flow | Identity | Rate Limit | Purpose |
|------|----------|------------|---------|
| URL creation | `create:{user_id}` | 50 per 60 min | Prevent spam creation |
| API shortening | `api:{user_id}` | 100 per 60 min | General API usage |
| Redirects | `redirect:{short_code}` | 200 per 60 min | Prevent redirect abuse |

The URL Shortener calls the Rate Limiter's `/check` endpoint before creating URLs. If denied, returns `429 Too Many Requests`.

## Endpoints

### Shorten URL

```
POST /api/shorten
Content-Type: application/json

{ "url": "https://example.com/very/long/path", "user_id": "alice" }

→ 200 { "short_code": "a4b9c1", "short_url": "http://localhost:8080/a4b9c1" }
→ 429 { "error": "Rate limit exceeded. Try again later." }
→ 400 { "error": "url and user_id are required" }
```

### Redirect (Short URL)

```
GET /:shortCode

→ 301 Location: https://original-url.com
→ 404 { "error": "URL not found" }
```

### Analytics

```
GET /api/analytics/:shortCode

→ 200 {
    "original_url": "https://example.com/...",
    "user_id": "alice",
    "created_at": "2026-09-18T...",
    "clicks": 42,
    "recent_clicks": [{ "ip_address": "...", "user_agent": "...", "clicked_at": "..." }, ...]
  }
```

### List URLs

```
GET /api/urls?user_id=alice

→ 200 { "urls": [{ "short_code": "...", "original_url": "...", ... }, ...] }
```

### Crash Endpoint (for testing)

The Rate Limiter exposes `/crash` which fires a barrage of concurrent requests at this service to stress test it. See Rate Limiter docs for usage.

### WebSocket Events

| Endpoint | Direction | Description |
|----------|-----------|-------------|
| `/ws/logs` | Server → Client | Streams server log lines in real time as JSON `{ type: "log", message: "..." }` |

## Rate Limiter Connection

## Database Schema

```sql
CREATE TABLE urls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    short_code TEXT UNIQUE NOT NULL,
    original_url TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    clicks INTEGER DEFAULT 0,
    last_clicked_at DATETIME
);

CREATE TABLE analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url_id INTEGER NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    referrer TEXT,
    clicked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (url_id) REFERENCES urls(id)
);
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `5175` | Server port |
| `RATE_LIMIT_CHECK_URL` | `http://localhost:8080/check` | Rate limiter check endpoint |

## Configuration

### Rate Limiter (Go service)

- Algorithm: `fixed_window`
- Default limit per user: 50 URLs per 60-minute window
- The Rate Limiter is started separately on port 8081 with MemoryStorage and default limit 100

### URL Shortener (Node.js)

- Runs on port 8080
- Calls Rate Limiter before creating URLs
- Stores all URL data in SQLite (`db.sqlite` in project root)

## Project Structure

```
URL-Shorterner/
├── server.js          # Express server, all routes
├── db.js              # SQLite setup, schema init
├── db.sqlite          # Created at runtime
├── public/
│   └── index.html     # Frontend UI
├── package.json
└── .gitignore
```

## Integration Testing Plan

1. Start Rate Limiter on `:8081` with default config
2. Start URL Shortener on `:8080`
3. Shorten URLs rapidly → verify 429 after limit hit
4. Hit redirects rapidly → verify rate limiting works
5. Hit /crash on Rate Limiter → verify URL Shortener gets barraged and either survives (rate limiter ON) or crashes (rate limiter OFF)
6. Check analytics accuracy after many clicks

## Future Enhancements

- Custom short codes
- QR code generation for each URL
- Password-protected URLs
- API key authentication per user
- Dashboard UI for analytics visualization
