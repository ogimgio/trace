import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';

let base = '';
let close: () => void;

before(async () => {
  const server = createApp(openDb(':memory:')).listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});

after(() => close());

const visit = (id: number, url = `https://example.com/${id}`) => ({
  visitId: String(id),
  url,
  title: `Page ${id}`,
  visitTime: 1_700_000_000_000 + id,
  transition: 'link',
  referringVisitId: '0',
});

const upload = (deviceId: string, visits: unknown[]) =>
  fetch(`${base}/api/visits`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId, visits }),
  });

test('stores visits and ignores duplicates on re-upload', async () => {
  const first = await upload('dev-a', [visit(1), visit(2), visit(3)]);
  assert.deepEqual(await first.json(), { received: 3, inserted: 3, skipped: 0 });

  const retry = await upload('dev-a', [visit(2), visit(3), visit(4)]);
  assert.deepEqual(await retry.json(), { received: 3, inserted: 1, skipped: 0 });

  const stats = await (await fetch(`${base}/api/devices/dev-a/stats`)).json();
  assert.equal(stats.totalVisits, 4);
  assert.equal(stats.firstVisitAt, visit(1).visitTime);
  assert.equal(stats.lastVisitAt, visit(4).visitTime);
});

test('same visitId on different devices are separate rows', async () => {
  await upload('dev-b', [visit(1)]);
  const stats = await (await fetch(`${base}/api/devices/dev-b/stats`)).json();
  assert.equal(stats.totalVisits, 1);
});

test('rejects malformed payloads', async () => {
  const noDevice = await upload('', [visit(1)]);
  assert.equal(noDevice.status, 400);

  const notArray = await fetch(`${base}/api/visits`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'dev-c', visits: 'nope' }),
  });
  assert.equal(notArray.status, 400);
});

test('skips malformed visits without failing the batch', async () => {
  const res = await upload('dev-e', [visit(1), { visitId: '2', url: 'https://x.com' }, visit(3)]);
  assert.deepEqual(await res.json(), { received: 3, inserted: 2, skipped: 1 });
});

test('truncates very long urls instead of rejecting them', async () => {
  const longUrl = `https://example.com/?q=${'a'.repeat(20_000)}`;
  const res = await upload('dev-f', [visit(1, longUrl)]);
  assert.deepEqual(await res.json(), { received: 1, inserted: 1, skipped: 0 });
});

test('deleting a device removes its visits', async () => {
  await upload('dev-d', [visit(1), visit(2)]);
  const del = await fetch(`${base}/api/devices/dev-d`, { method: 'DELETE' });
  assert.deepEqual(await del.json(), { deleted: true });

  const stats = await fetch(`${base}/api/devices/dev-d/stats`);
  assert.equal(stats.status, 404);
});
