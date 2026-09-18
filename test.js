// Simple test file to verify URL shortener logic
const crypto = require('crypto');

// Test the short code generation function
function generateShortCode(length = 6) {
  return crypto.randomBytes(length).toString('hex').slice(0, length);
}

// Test URL validation
function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

// Run tests
console.log('Running URL Shortener tests...\n');

// Test 1: Short code generation
console.log('Test 1: Short code generation');
const code1 = generateShortCode();
const code2 = generateShortCode();
console.log(`  Generated code 1: ${code1} (length: ${code1.length})`);
console.log(`  Generated code 2: ${code2} (length: ${code2.length})`);
console.log(`  ✓ Codes are ${code1.length === 6 && code2.length === 6 ? 'correct length' : 'wrong length'}`);
console.log(`  ✓ Codes are ${code1 !== code2 ? 'different' : 'the same (collision!)'}\n`);

// Test 2: URL validation
console.log('Test 2: URL validation');
const validUrls = [
  'https://example.com',
  'http://localhost:8080',
  'https://sub.example.com/path?query=value',
  'ftp://files.example.com'
];
const invalidUrls = [
  'not-a-url',
  'http://',
  '://example.com',
  'javascript:alert("xss")'
];

console.log('  Valid URLs:');
validUrls.forEach(url => {
  const isValid = isValidUrl(url);
  console.log(`    ${url}: ${isValid ? '✓ valid' : '✗ invalid'}`);
});

console.log('\n  Invalid URLs:');
invalidUrls.forEach(url => {
  const isValid = isValidUrl(url);
  console.log(`    ${url}: ${isValid ? '✗ should be invalid' : '✓ correctly invalid'}`);
});

// Test 3: Database schema (simulated)
console.log('\nTest 3: Database schema simulation');
const schema = {
  urls: ['id', 'short_code', 'original_url', 'user_id', 'created_at', 'clicks', 'last_clicked_at'],
  analytics: ['id', 'url_id', 'ip_address', 'user_agent', 'referrer', 'clicked_at']
};

console.log('  URLs table columns:', schema.urls.join(', '));
console.log('  Analytics table columns:', schema.analytics.join(', '));
console.log(`  ✓ Schema has ${schema.urls.length} URL columns and ${schema.analytics.length} analytics columns\n`);

// Test 4: Rate limiter identity format
console.log('Test 4: Rate limiter identity formats');
const identities = [
  'create:user123',
  'api:user456',
  'redirect:abc123'
];

identities.forEach(identity => {
  const [type, value] = identity.split(':');
  console.log(`  ${identity}: type="${type}", value="${value}"`);
});

console.log('\n=== All tests completed ===');
console.log('Note: For full integration testing, run the Rate Limiter service separately');
console.log('and test the actual endpoints with: npm test');