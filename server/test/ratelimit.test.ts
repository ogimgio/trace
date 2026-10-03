import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { createApp } from '../src/api.ts';
import { purgeRateLimits } from '../src/ratelimit.ts';
import type { Sql } from '../src/db.ts';
import { startTestDb } from './db.ts';

const HOUR = 3_600_000;
let base = '';
let db: Sql;
let clock = Date.UTC(2026, 9, 3, 12);
let close: () => Promise<void>;

before(async () => {
  const test = await startTestDb();
  db = test.sql;
  const rateLimits = {
    uploads: { limit: 4, windowMs: HOUR },
    newDevices: { limit: 2, windowMs: 24 * HOUR },
    links: { limit: 2, windowMs: HOUR },
  };
  const server = createApp(db, { rateLimits, ipSalt: 'salt', now: () => clock }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = async () => {
    server.close();
    await test.stop();
  };
});

after(() => close());

// On Vercel the platform sets x-real-ip; here it simulates requests from different networks.
const upload = (deviceId: string, ip: string) => fetch(`${base}/api/visits`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-real-ip': ip },
  body: JSON.stringify({ deviceId, visits: [] }),
});

test('an IP can create only a few devices a day, but keeps syncing the ones it has', async () => {
  assert.equal((await upload('dev-1', '1.1.1.1')).status, 200);
  assert.equal((await upload('dev-2', '1.1.1.1')).status, 200);
  const blocked = await upload('dev-3', '1.1.1.1');
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  // Existing devices still sync; another network can still create devices
  assert.equal((await upload('dev-1', '1.1.1.1')).status, 200);
  assert.equal((await upload('dev-3', '2.2.2.2')).status, 200);
  const [row] = await db`SELECT COUNT(*) AS n FROM devices`;
  assert.equal(row.n, 3);
});

test('uploads per IP per hour are capped and the window resets', async () => {
  // 1.1.1.1 already made 4 uploads in this hour (3 accepted + the blocked one)
  assert.equal((await upload('dev-1', '1.1.1.1')).status, 429);
  clock += HOUR;
  assert.equal((await upload('dev-1', '1.1.1.1')).status, 200);
});

test('link challenges are rate limited too', async () => {
  const challenge = () => fetch(`${base}/api/devices/dev-1/link-challenge`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '3.3.3.3' }, body: '{}',
  });
  assert.equal((await challenge()).status, 200);
  assert.equal((await challenge()).status, 200);
  assert.equal((await challenge()).status, 429);
});

test('raw IPs are never stored and old counters are purged', async () => {
  const keys = await db<{ key: string }[]>`SELECT key FROM rate_limits`;
  assert.ok(keys.length > 0);
  assert.ok(keys.every((k) => !k.key.includes('1.1.1.1') && !k.key.includes('2.2.2.2')));
  assert.equal(await purgeRateLimits(db, clock + 3 * 24 * HOUR), keys.length);
});
