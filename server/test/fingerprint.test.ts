import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeviceCheck, loadFingerprintConfig, type FingerprintConfig } from '../src/fingerprint.ts';

const config: FingerprintConfig = { publicApiKey: 'pk', secretApiKey: 'sk', region: 'eu' };
const NOW = 1_800_000_000_000;

// Fingerprint's Server API, recording what it receives.
function fakeApi(event: Record<string, unknown> | null, status = 200) {
  const calls: { url: string; auth: string | null }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get('authorization') });
    return new Response(JSON.stringify(event ?? { error: { code: 'event_not_found' } }), { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const event = (overrides: Record<string, unknown> = {}) => ({
  event_id: 'ev-1',
  timestamp: NOW - 30_000,
  identification: { visitor_id: 'visitor-abc' },
  suspect_score: 3,
  bot: 'not_detected',
  vpn: true,
  incognito: false,
  tampering: false,
  virtual_machine: false,
  emulator: false,
  replayed: false,
  ip_address: '203.0.113.7',
  browser_details: { browser_name: 'Chrome', browser_major_version: '130', os: 'Windows', os_version: '11', device: 'Other' },
  ...overrides,
});

test('a genuine browser passes and the event is fetched with the secret key from the right region', async () => {
  const api = fakeApi(event());
  const verdict = await createDeviceCheck(config, 'salt', api.fetchImpl).check('ev-1', NOW);
  assert.equal(verdict.ok, true);
  assert.equal(api.calls[0].url, 'https://eu.api.fpjs.io/v4/events/ev-1');
  assert.equal(api.calls[0].auth, 'Bearer sk');
  if (!verdict.ok) return;
  assert.equal(verdict.visitorId, 'visitor-abc');
  assert.equal(verdict.signals.vpn, true);
  assert.equal(verdict.signals.suspectScore, 3);
  // The cluster key is a salted hash: never the IP itself
  assert.ok(verdict.signals.clusterKey && !verdict.signals.clusterKey.includes('203.0.113'));
});

test('same network and browser setup gives the same cluster key, another network a different one', async () => {
  const key = async (overrides: Record<string, unknown>) => {
    const verdict = await createDeviceCheck(config, 'salt', fakeApi(event(overrides)).fetchImpl).check('ev-1', NOW);
    return verdict.ok ? verdict.signals.clusterKey : null;
  };
  assert.equal(await key({ identification: { visitor_id: 'other' } }), await key({}));
  assert.notEqual(await key({ ip_address: '198.51.100.1' }), await key({}));
});

test('bots, tampering, virtual machines, emulators, replays and stale events are refused', async () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ bot: 'bad' }, /automated/],
    [{ tampering: true }, /tampering/],
    [{ virtual_machine: true }, /virtual machine/],
    [{ emulator: true }, /emulator/],
    [{ replayed: true }, /already used/],
    [{ timestamp: NOW - 11 * 60_000 }, /expired/],
    [{ identification: {} }, /not identified/],
  ];
  for (const [overrides, error] of cases) {
    const verdict = await createDeviceCheck(config, 'salt', fakeApi(event(overrides)).fetchImpl).check('ev-1', NOW);
    assert.equal(verdict.ok, false);
    assert.match((verdict as { error: string }).error, error);
  }
});

test('unknown events and malformed IDs are refused without trusting the page', async () => {
  const notFound = await createDeviceCheck(config, 'salt', fakeApi(null, 404).fetchImpl).check('ev-1', NOW);
  assert.equal(notFound.ok, false);
  const api = fakeApi(event());
  const malformed = await createDeviceCheck(config, 'salt', api.fetchImpl).check('../../admin', NOW);
  assert.equal(malformed.ok, false);
  assert.equal(api.calls.length, 0);
});

test('configuration comes from the environment and is off without keys', () => {
  assert.equal(loadFingerprintConfig({}, null), null);
  assert.deepEqual(
    loadFingerprintConfig({ FINGERPRINT_PUBLIC_KEY: 'pk', FINGERPRINT_SECRET_KEY: 'sk', FINGERPRINT_REGION: 'eu' }, null),
    { publicApiKey: 'pk', secretApiKey: 'sk', region: 'eu' },
  );
});
