const http = require('http');
const https = require('https');
const { URL } = require('url');

const RATE_LIMIT_CHECK_URL = process.env.RATE_LIMIT_CHECK_URL || 'http://localhost:8080/check';

function checkRateLimit(identity) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(RATE_LIMIT_CHECK_URL);
    const module = parsedUrl.protocol === 'https:' ? https : http;
    const data = JSON.stringify({
      identity,
      algorithm: 'fixed_window',
      policy: { limit: 50, window: 3600000000000 }
    });

    const req = module.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          resolve({
            allowed: result.allowed,
            limit: result.limit || 50,
            remaining: result.remaining || 0,
            retryAfter: result.retry_after || 0
          });
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

module.exports = { checkRateLimit };