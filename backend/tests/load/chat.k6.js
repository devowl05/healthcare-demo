/**
 * k6 load test for POST /api/chat.
 *
 * Usage:
 *
 *   # 1. Boot the backend with the deterministic mock LLM so we don't burn
 *   #    OpenAI credits and so latency is bounded by our code, not the upstream:
 *   MOCK_LLM=1 NODE_ENV=development \
 *     DATABASE_URL=postgres://... REDIS_URL=redis://... \
 *     /opt/homebrew/bin/bun run src/index.ts
 *
 *   # 2. Issue a JWT for a seeded test user. We don't ship the helper here —
 *   #    use `bun run scripts/issue-jwt.ts <user-id>` (TODO: author the helper).
 *   export TOKEN=$(bun run scripts/issue-jwt.ts <user-id>)
 *
 *   # 3. Run the load test:
 *   k6 run --env BASE_URL=http://localhost:3000 --env TOKEN=$TOKEN backend/tests/load/chat.k6.js
 *
 * Thresholds:
 *   - p95 time-to-first-byte < 800ms (the route opens the SSE stream and
 *     immediately writes the `conversation` frame — anything slower means we
 *     have synchronous work blocking the response)
 *   - p95 total turn duration < 4s (mock LLM is deterministic; this is mostly
 *     DB write latency + Hono overhead)
 *   - failure rate < 1%
 *
 * If thresholds fail the script exits non-zero, which CI can pick up.
 */

import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 50,
  duration: '2m',
  thresholds: {
    'http_req_duration{name:first_byte}': ['p(95) < 800'],
    'http_req_duration{name:total}': ['p(95) < 4000'],
    http_req_failed: ['rate < 0.01'],
  },
};

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const TOKEN = __ENV.TOKEN || '';

const SAMPLE_PROMPTS = [
  'What are the warnings for ibuprofen?',
  'I have a fever and a sore throat',
  'Compare acetaminophen and ibuprofen',
  'Is it safe to take aspirin daily?',
  'What does the openFDA label say about acetaminophen?',
];

function pickPrompt() {
  return SAMPLE_PROMPTS[Math.floor(Math.random() * SAMPLE_PROMPTS.length)];
}

export default function () {
  const payload = JSON.stringify({ message: pickPrompt() });

  const res = http.post(`${BASE}/api/chat`, payload, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      'X-CSRF-Token': 'k6-test-csrf',
      // The CSRF middleware double-submits a cookie/header pair.
      Cookie: 'csrf_token=k6-test-csrf',
    },
    tags: { name: 'total' },
    timeout: '30s',
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    // SSE responses set Content-Type: text/event-stream.
    'is event-stream': (r) => {
      const ct = r.headers['Content-Type'] || r.headers['content-type'] || '';
      return ct.indexOf('text/event-stream') !== -1;
    },
    'has at least one frame': (r) => typeof r.body === 'string' && r.body.indexOf('event:') !== -1,
    'reaches done frame': (r) => typeof r.body === 'string' && r.body.indexOf('event: done') !== -1,
  });

  // Pace the VU so we don't single-handedly soak all DB connections.
  sleep(1);
}
