// Load test at assumption A1 (docs/01-srs.md: 100k customers, ~2M orders per tenant).
// Targets (NFR-PERF): CRUD p95 < 300 ms, dashboard endpoints p95 < 500 ms.
//
//   docker run --rm -i -e BASE_URL=http://host.docker.internal:8080 -e EMAIL=... -e PASSWORD=... \
//     grafana/k6:0.57.0 run - < infra/load/a1.k6.js
//
// Every virtual user shares one sign-in, so start the API with RATE_LIMIT_PER_USER=100000 for
// the run (the default 300 per user per minute would reject most of it).
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = `${__ENV.BASE_URL || 'http://localhost:8080'}/api/v1`;

// Realistic SMB usage: each virtual user makes one request at a time with a short think time.
export const options = {
  scenarios: {
    crud: {
      executor: 'constant-vus',
      vus: 15,
      duration: '60s',
      exec: 'crud',
      tags: { kind: 'crud' },
    },
    dashboard: {
      executor: 'constant-vus',
      vus: 10,
      duration: '60s',
      exec: 'dashboard',
      tags: { kind: 'dashboard' },
    },
  },
  thresholds: {
    'http_req_duration{kind:crud}': ['p(95)<300'],
    'http_req_duration{kind:dashboard}': ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  const login = http.post(
    `${BASE}/auth/login`,
    JSON.stringify({ email: __ENV.EMAIL, password: __ENV.PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(login, { 'signed in': (r) => r.status === 200 });
  const token = login.json('accessToken');
  const headers = { Authorization: `Bearer ${token}` };
  const page = http.get(`${BASE}/customers?limit=200&sort=-total_spent`, { headers });
  // Warm-up: the first request for a data version computes the analytics result (cold), every
  // later one is served from the query cache. Cold times are reported separately.
  for (const path of ['analytics/overview', 'analytics/retention', 'segments', 'recommendations']) {
    const res = http.get(`${BASE}/${path}`, {
      headers,
      timeout: '60s',
      tags: { name: `cold ${path}` },
    });
    console.log(`cold ${path}: ${res.status} in ${Math.round(res.timings.duration)} ms`);
  }
  return { headers, ids: page.json('data').map((c) => c.id) };
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];

const think = () => sleep(0.5 + Math.random());

function get(path, headers, name) {
  const res = http.get(`${BASE}/${path}`, { headers, tags: { name } });
  check(res, { '2xx': (r) => r.status >= 200 && r.status < 300 });
  think();
}

export function crud(data) {
  const { headers, ids } = data;
  get('customers?limit=50', headers, 'customers list');
  get(`customers/${pick(ids)}`, headers, 'customer detail');
  get(`customers/${pick(ids)}/orders?limit=25`, headers, 'customer orders');
  get(
    `customers?q=${pick(['ana', 'garcia', 'luis', 'C-0004'])}&limit=50`,
    headers,
    'customer search',
  );
  get('customers?limit=50&sort=-total_spent', headers, 'customers by spend');
  get('orders?limit=50', headers, 'orders list');
}

export function dashboard(data) {
  const { headers } = data;
  get('analytics/overview', headers, 'overview');
  get('segments', headers, 'segments');
  get('recommendations', headers, 'recommendations');
  get('analytics/retention', headers, 'retention');
  get('analytics/status', headers, 'status');
}
