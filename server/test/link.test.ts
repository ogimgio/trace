import assert from 'node:assert/strict';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { Keypair, type PublicKey } from '@solana/web3.js';
import { createApp } from '../src/api.ts';
import { startTestDb } from './db.ts';
import type { Sql } from '../src/db.ts';
import { CHALLENGE_TTL_MS } from '../src/rewards/link.ts';
import { EPOCH_MS } from '../src/rewards/policy.ts';
import type { WorldId } from '../src/worldid.ts';

const DAY = 86_400_000;

// Signs like Phantom does: Ed25519 over the message's UTF-8 bytes.
function signWith(keypair: Keypair, message: string): string {
  const key = createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      d: Buffer.from(keypair.secretKey.subarray(0, 32)).toString('base64url'),
      x: Buffer.from(keypair.publicKey.toBytes()).toString('base64url'),
    },
    format: 'jwk',
  });
  return sign(null, Buffer.from(message, 'utf8'), key).toString('base64');
}

let base = '';
let close: () => Promise<void>;
let clock = Date.now();
let db: Sql;
const sent: string[] = [];

// Stand-in for World ID (the real one is tested in worldid.test.ts): the "proof" names a human, and the
// nullifier is derived from that name, so the same human always gets the same nullifier.
let nonces = 0;
const worldId: WorldId = {
  action: 'link-wallet',
  start: (signal) => ({
    appId: 'app_test', action: 'link-wallet', environment: 'staging', signal,
    rpContext: { rp_id: 'rp_test', nonce: `nonce-${++nonces}`, created_at: 0, expires_at: 0, signature: '0x' },
  }),
  verify: async (result, expected) => {
    const r = result as { human: string; signal: string; nonce: string };
    if (r.signal !== expected.signal || r.nonce !== expected.nonce) return { ok: false, error: 'proof bound to a different link' };
    return { ok: true, nullifier: BigInt(`0x${createHash('sha256').update(r.human).digest('hex')}`).toString() };
  },
};

before(async () => {
  const rewarder = {
    send: async (wallet: PublicKey) => {
      sent.push(wallet.toBase58());
      return { signature: `sig-${sent.length}`, explorerUrl: '' };
    },
  };
  const db0 = await startTestDb();
  db = db0.sql;
  const server = createApp(db0.sql, { rewarder, now: () => clock, cronSecret: 'cron-test', rateLimits: false, worldId }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = async () => {
    server.close();
    await db0.stop();
  };
});

after(() => close());

const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

// Device with 8 active days of history: eligible for the welcome bonus.
async function newDevice(id: string) {
  const visits = [];
  for (let d = 1; d <= 8; d++) for (let i = 0; i < 5; i++) {
    visits.push({ visitId: `${d}-${i}`, url: `https://x.com/${d}/${i}`, visitTime: clock - d * DAY + i });
  }
  await fetch(`${base}/api/visits`, json('POST', { deviceId: id, visits }));
}

async function challenge(deviceId: string, action: 'link' | 'unlink' = 'link') {
  const res = await fetch(`${base}/api/devices/${deviceId}/link-challenge`, json('POST', { action }));
  return { status: res.status, body: await res.json() };
}

// Proves with (fake) World ID that `human` is behind this link code.
async function proveHuman(code: string, human: string) {
  const started = await fetch(`${base}/api/link/${code}/worldid/start`, json('POST'));
  const start = await started.json();
  if (!started.ok) return { status: started.status, body: start };
  const res = await fetch(`${base}/api/link/${code}/worldid`, json('POST', { human, signal: start.signal, nonce: start.rpContext.nonce }));
  return { status: res.status, body: await res.json() };
}

// Signs the link with Phantom. For 'link' it first proves with World ID as `human` (by default one human
// per wallet); `human: null` skips the proof.
async function submit(code: string, keypair: Keypair, message?: string, human: string | null = keypair.publicKey.toBase58()) {
  const info = await (await fetch(`${base}/api/link/${code}`)).json();
  if (info.action === 'link' && !info.worldIdVerified && human !== null) await proveHuman(code, human);
  const res = await fetch(`${base}/api/link/${code}`, json('POST', {
    wallet: keypair.publicKey.toBase58(),
    signature: signWith(keypair, message ?? info.message),
  }));
  return { status: res.status, body: await res.json() };
}

const rewards = async (deviceId: string) => (await fetch(`${base}/api/devices/${deviceId}/rewards`)).json();

test('signed link connects the wallet and explains the weekly welcome installments', async () => {
  await newDevice('dev-1');
  const alice = Keypair.generate();
  const { body: c } = await challenge('dev-1');
  assert.match(c.url, /^\/link\.html\?code=[0-9a-f]{32}$/);

  const info = await (await fetch(`${base}/api/link/${c.code}`)).json();
  assert.equal(info.status, 'valid');
  assert.match(info.message, /Link this wallet to device dev-1/);
  assert.match(info.message, new RegExp(c.code));

  const { status, body } = await submit(c.code, alice);
  assert.equal(status, 200);
  assert.equal(body.wallet, alice.publicKey.toBase58());
  // The bonus is no longer sent on link: it is paid weekly to wallets that keep browsing
  assert.deepEqual(body.welcome, { installment: '50', total: '500', minActiveDays: 3 });
  assert.equal(sent.length, 0);
  assert.equal(body.verified, true);
  const r = await rewards('dev-1');
  assert.equal(r.wallet, alice.publicKey.toBase58());
  assert.equal(r.verified, true);
});

test('a wrong signature is rejected and does not burn the code', async () => {
  await newDevice('dev-2');
  const alice = Keypair.generate();
  const mallory = Keypair.generate();
  const { body: c } = await challenge('dev-2');
  const info = await (await fetch(`${base}/api/link/${c.code}`)).json();

  // Signature from another wallet pretending to be alice
  const forged = await fetch(`${base}/api/link/${c.code}`, json('POST', {
    wallet: alice.publicKey.toBase58(),
    signature: signWith(mallory, info.message),
  }));
  assert.equal(forged.status, 401);
  // A message different from the challenge's
  assert.equal((await submit(c.code, alice, info.message.replace('dev-2', 'dev-X'))).status, 401);
  // Malformed signature
  const garbage = await fetch(`${base}/api/link/${c.code}`, json('POST', { wallet: alice.publicKey.toBase58(), signature: 'AAAA' }));
  assert.equal(garbage.status, 401);

  assert.equal((await rewards('dev-2')).wallet, null);
  assert.equal((await submit(c.code, alice)).status, 200);
});

test('codes are single use and expire', async () => {
  await newDevice('dev-3');
  const alice = Keypair.generate();
  const { body: c } = await challenge('dev-3');
  assert.equal((await submit(c.code, alice)).status, 200);
  assert.equal((await submit(c.code, alice)).status, 410);
  assert.equal((await (await fetch(`${base}/api/link/${c.code}`)).json()).status, 'used');

  await newDevice('dev-4');
  const { body: late } = await challenge('dev-4');
  clock += CHALLENGE_TTL_MS + 1;
  try {
    assert.equal((await (await fetch(`${base}/api/link/${late.code}`)).json()).status, 'expired');
    assert.equal((await submit(late.code, alice)).status, 410);
  } finally {
    clock -= CHALLENGE_TTL_MS + 1;
  }
  assert.equal((await fetch(`${base}/api/link/nope`)).status, 404);
});

test('a linked wallet is locked: only that wallet can unlink it', async () => {
  await newDevice('dev-5');
  const alice = Keypair.generate();
  const mallory = Keypair.generate();
  await submit((await challenge('dev-5')).body.code, alice);

  // Knowing the deviceId is not enough to replace alice's wallet with your own
  assert.equal((await challenge('dev-5', 'link')).status, 409);
  const { body: unlink } = await challenge('dev-5', 'unlink');
  assert.equal((await submit(unlink.code, mallory)).status, 403);
  assert.equal((await rewards('dev-5')).wallet, alice.publicKey.toBase58());

  // Alice unlinks and links a new wallet
  const out = await submit(unlink.code, alice);
  assert.deepEqual(out.body, { action: 'unlink', wallet: null, welcome: null });
  assert.equal((await rewards('dev-5')).wallet, null);
  const bob = Keypair.generate();
  const relinked = await submit((await challenge('dev-5')).body.code, bob);
  assert.equal(relinked.body.wallet, bob.publicKey.toBase58());

  // Every link and unlink is logged: the device's wallet history is not lost when the wallet changes
  const log = await db<{ wallet: string; action: string }[]>`SELECT wallet, action FROM wallet_links WHERE device_id = 'dev-5' ORDER BY id`;
  assert.deepEqual(log.map((l) => [l.action, l.wallet]), [
    ['link', alice.publicKey.toBase58()],
    ['unlink', alice.publicKey.toBase58()],
    ['link', bob.publicKey.toBase58()],
  ]);
});

test('challenge errors and the signing page', async () => {
  assert.equal((await challenge('unknown')).status, 404);
  await newDevice('dev-6');
  assert.equal((await challenge('dev-6', 'unlink')).status, 409);

  const page = await fetch(`${base}/link.html?code=x`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /signMessage/);
  assert.equal((await fetch(`${base}/logo.svg`)).status, 200);

  // The cron endpoint requires the secret
  assert.equal((await fetch(`${base}/api/cron/daily`)).status, 401);
  const cron = await fetch(`${base}/api/cron/daily`, { headers: { authorization: 'Bearer cron-test' } });
  assert.equal(cron.status, 200);

  // The old unsigned API is gone
  const unsigned = await fetch(`${base}/api/devices/dev-6/wallet`, json('PUT', { wallet: Keypair.generate().publicKey.toBase58() }));
  assert.equal(unsigned.status, 404);

  const r = await rewards('dev-6');
  assert.equal(r.currentWeek.endsAt - r.currentWeek.startsAt, EPOCH_MS);
});

// --- World ID: one human, one wallet ---

test('a wallet cannot be linked without World ID, and trying does not burn the code', async () => {
  await newDevice('dev-w1');
  const alice = Keypair.generate();
  const { body: c } = await challenge('dev-w1');
  const refused = await submit(c.code, alice, undefined, null);
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /World ID/);
  assert.equal((await rewards('dev-w1')).wallet, null);
  // After proving, the same code works
  assert.equal((await submit(c.code, alice)).status, 200);
});

test('one human cannot link a second wallet, but can link the same wallet on another device', async () => {
  await newDevice('dev-w2');
  await newDevice('dev-w3');
  await newDevice('dev-w4');
  const first = Keypair.generate();
  const second = Keypair.generate();
  assert.equal((await submit((await challenge('dev-w2')).body.code, first, undefined, 'carol')).status, 200);

  // Carol on another device with a new wallet: refused, and told which wallet her World ID belongs to
  const { body: c } = await challenge('dev-w3');
  const proof = await proveHuman(c.code, 'carol');
  assert.equal(proof.body.boundWallet, first.publicKey.toBase58());
  const refused = await submit(c.code, second, undefined, 'carol');
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /one wallet only/);
  assert.equal((await rewards('dev-w3')).wallet, null);

  // Her own wallet on a second device is fine
  assert.equal((await submit((await challenge('dev-w4')).body.code, first, undefined, 'carol')).status, 200);
  // And another human cannot take over Carol's verified wallet
  await newDevice('dev-w5');
  const stolen = await submit((await challenge('dev-w5')).body.code, first, undefined, 'dave');
  assert.equal(stolen.status, 409);
  assert.match(stolen.body.error, /another person/);
});

test('a World ID proof made for another link is rejected', async () => {
  await newDevice('dev-w6');
  await newDevice('dev-w7');
  const a = (await challenge('dev-w6')).body.code;
  const b = (await challenge('dev-w7')).body.code;
  const startA = await (await fetch(`${base}/api/link/${a}/worldid/start`, json('POST'))).json();
  await fetch(`${base}/api/link/${b}/worldid/start`, json('POST'));
  // The proof commits to link A: sent to link B it does not verify
  const res = await fetch(`${base}/api/link/${b}/worldid`, json('POST', { human: 'erin', signal: startA.signal, nonce: startA.rpContext.nonce }));
  assert.equal(res.status, 400);
  assert.equal((await (await fetch(`${base}/api/link/${b}`)).json()).worldIdVerified, false);
});

test('a wallet linked before World ID was required can be verified, and is not paid until then', async () => {
  const legacy = Keypair.generate();
  await newDevice('dev-legacy');
  await db`UPDATE devices SET wallet_address = ${legacy.publicKey.toBase58()} WHERE id = 'dev-legacy'`;
  assert.equal((await rewards('dev-legacy')).verified, false);

  // 'link' is allowed again on an unverified wallet, but only for that same wallet
  const other = await submit((await challenge('dev-legacy')).body.code, Keypair.generate());
  assert.equal(other.status, 409);
  const ok = await submit((await challenge('dev-legacy')).body.code, legacy);
  assert.equal(ok.status, 200);
  assert.equal((await rewards('dev-legacy')).verified, true);
  // Once verified, a new link request needs an unlink first, as before
  assert.equal((await challenge('dev-legacy')).status, 409);
});
