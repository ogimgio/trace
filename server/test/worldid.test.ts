import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { hashSignal } from '@worldcoin/idkit-core/hashing';
import { createWorldId, loadWorldIdConfig, type WorldIdConfig } from '../src/worldid.ts';

const config: WorldIdConfig = {
  appId: 'app_test',
  rpId: 'rp_test',
  signingKey: `0x${randomBytes(32).toString('hex')}`,
  action: 'link-wallet',
  environment: 'staging',
};
const NULLIFIER = '0x2bf8406809dcefb1486dadc96c0a897db9bab002053054cf64272db512c6fbd8';

// World's verify API, recording what it receives.
function fakeApi(reply: { status?: number; body: unknown }) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const ok = {
  success: true, action: 'link-wallet', environment: 'staging', nullifier: NULLIFIER,
  results: [{ identifier: 'proof_of_human', success: true, nullifier: NULLIFIER }],
};

// An IDKit result as World App would return it for this request.
function idkitResult(signal: string, nonce: string, overrides: Record<string, unknown> = {}, identifier = 'proof_of_human') {
  return {
    protocol_version: '4.0', nonce, action: 'link-wallet', environment: 'staging',
    responses: [{ identifier, signal_hash: hashSignal(signal), proof: ['0x1', '0x2'], nullifier: NULLIFIER, issuer_schema_id: 1 }],
    ...overrides,
  };
}

test('start signs a request for the configured app and action', () => {
  const request = createWorldId(config).start('code-1');
  assert.equal(request.appId, 'app_test');
  assert.equal(request.signal, 'code-1');
  assert.equal(request.rpContext.rp_id, 'rp_test');
  assert.match(request.rpContext.signature, /^0x[0-9a-f]{130}$/);
  assert.ok(request.rpContext.expires_at > request.rpContext.created_at);
  // A fresh nonce every time
  assert.notEqual(createWorldId(config).start('code-1').rpContext.nonce, request.rpContext.nonce);
});

test('a valid Orb proof is forwarded to World as-is and yields the decimal nullifier', async () => {
  const api = fakeApi({ body: ok });
  const worldId = createWorldId(config, api.fetchImpl);
  const { rpContext } = worldId.start('code-1');
  const result = idkitResult('code-1', rpContext.nonce);

  const verdict = await worldId.verify(result, { signal: 'code-1', nonce: rpContext.nonce });
  assert.deepEqual(verdict, { ok: true, nullifier: BigInt(NULLIFIER).toString() });
  assert.equal(api.calls[0].url, 'https://developer.world.org/api/v4/verify/rp_test');
  assert.deepEqual(api.calls[0].body, result);
});

test('proofs are checked locally before calling World', async () => {
  const api = fakeApi({ body: ok });
  const worldId = createWorldId(config, api.fetchImpl);
  const { rpContext } = worldId.start('code-1');
  const expected = { signal: 'code-1', nonce: rpContext.nonce };

  const cases: [unknown, RegExp][] = [
    [idkitResult('code-2', rpContext.nonce), /different link/], // made for another link code
    [idkitResult('code-1', '0x1234'), /different request/], // another request's nonce
    [idkitResult('code-1', rpContext.nonce, { environment: 'production' }), /production/],
    [idkitResult('code-1', rpContext.nonce, { action: 'other' }), /different action/],
    [idkitResult('code-1', rpContext.nonce, { protocol_version: '3.0' }), /4\.0/],
    [idkitResult('code-1', rpContext.nonce, {}, 'selfie'), /Orb/], // not an Orb credential
    [null, /4\.0/],
  ];
  for (const [result, error] of cases) {
    const verdict = await worldId.verify(result, expected);
    assert.equal(verdict.ok, false);
    assert.match((verdict as { error: string }).error, error);
  }
  assert.equal(api.calls.length, 0);
});

test('a proof World rejects is refused', async () => {
  for (const reply of [
    { status: 400, body: { success: false, code: 'all_verifications_failed', detail: 'All proof verifications failed.' } },
    { body: { ...ok, environment: 'production' } },
    { body: { ...ok, results: [{ identifier: 'proof_of_human', success: false }] } },
  ]) {
    const worldId = createWorldId(config, fakeApi(reply).fetchImpl);
    const { rpContext } = worldId.start('code-1');
    const verdict = await worldId.verify(idkitResult('code-1', rpContext.nonce), { signal: 'code-1', nonce: rpContext.nonce });
    assert.equal(verdict.ok, false);
  }
});

test('configuration comes from the environment and is off without keys', () => {
  assert.equal(loadWorldIdConfig({}, null), null);
  const loaded = loadWorldIdConfig({ WORLD_APP_ID: 'app_x', WORLD_RP_ID: 'rp_x', WORLD_RP_SIGNING_KEY: '0xab' }, null);
  assert.deepEqual(loaded, { appId: 'app_x', rpId: 'rp_x', signingKey: '0xab', action: 'link-wallet', environment: 'production' });
});
