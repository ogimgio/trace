import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { Keypair, type PublicKey } from '@solana/web3.js';
import { createApp } from '../src/api.ts';
import type { Sql } from '../src/db.ts';
import type { DeviceCheck } from '../src/fingerprint.ts';
import { startTestDb } from './db.ts';
import { CHALLENGE_TTL_MS } from '../src/rewards/link.ts';
import { EPOCH_MS } from '../src/rewards/policy.ts';

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
let sql: Sql;
let clock = Date.now();
const sent: string[] = [];

// Fake Fingerprint: the event ID is "<visitorId>.<n>"; visitors starting with "bot" are refused.
const deviceCheck: DeviceCheck = {
  browser: { apiKey: 'public-key', region: 'eu' },
  async check(eventId) {
    const visitorId = eventId.slice(0, eventId.lastIndexOf('.'));
    return visitorId.startsWith('bot') ? { ok: false, error: 'automated browser detected' } : { ok: true, visitorId };
  },
};
let eventSeq = 0;

before(async () => {
  const rewarder = {
    send: async (wallet: PublicKey) => {
      sent.push(wallet.toBase58());
      return { signature: `sig-${sent.length}`, explorerUrl: '' };
    },
  };
  const db = await startTestDb();
  sql = db.sql;
  const server = createApp(db.sql, { rewarder, now: () => clock, cronSecret: 'cron-test', deviceCheck }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = async () => {
    server.close();
    await db.stop();
  };
});

after(() => close());

const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

// Device with 8 active days of its own history: eligible for the welcome bonus.
async function newDevice(id: string) {
  const visits = [];
  for (let d = 1; d <= 8; d++) for (let i = 0; i < 5; i++) {
    visits.push({ visitId: `${d}-${i}`, url: `https://x.com/${id}/${d}/${i}`, visitTime: clock - d * DAY + i });
  }
  await fetch(`${base}/api/visits`, json('POST', { deviceId: id, visits }));
}

async function challenge(deviceId: string, action: 'link' | 'unlink' = 'link') {
  const res = await fetch(`${base}/api/devices/${deviceId}/link-challenge`, json('POST', { action }));
  return { status: res.status, body: await res.json() };
}

// `browser`: the Fingerprint visitor of the signing page (null: no device check sent).
async function submit(code: string, keypair: Keypair, { message, browser = `browser-${code}` }: { message?: string; browser?: string | null } = {}) {
  const info = await (await fetch(`${base}/api/link/${code}`)).json();
  const res = await fetch(`${base}/api/link/${code}`, json('POST', {
    wallet: keypair.publicKey.toBase58(),
    signature: signWith(keypair, message ?? info.message),
    ...(browser === null ? {} : { deviceEventId: `${browser}.${eventSeq++}` }),
  }));
  return { status: res.status, body: await res.json() };
}

const rewards = async (deviceId: string) => (await fetch(`${base}/api/devices/${deviceId}/rewards`)).json();

test('signed link connects the wallet and sends the welcome bonus right away', async () => {
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
  assert.equal(body.welcome.status, 'sent');
  assert.equal(body.welcome.amount, '500');
  assert.equal((await rewards('dev-1')).wallet, alice.publicKey.toBase58());
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
  assert.equal((await submit(c.code, alice, { message: info.message.replace('dev-2', 'dev-X') })).status, 401);
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

  // Alice unlinks and links a new wallet: no second welcome bonus
  const out = await submit(unlink.code, alice);
  assert.deepEqual(out.body, { action: 'unlink', wallet: null, welcome: null });
  assert.equal((await rewards('dev-5')).wallet, null);
  const bob = Keypair.generate();
  const relinked = await submit((await challenge('dev-5')).body.code, bob);
  assert.equal(relinked.body.wallet, bob.publicKey.toBase58());
  assert.equal(relinked.body.welcome, null);
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

test('linking requires a passing device check, and a failed check does not use up the code', async () => {
  await newDevice('dev-7');
  const alice = Keypair.generate();
  const { body: c } = await challenge('dev-7');
  const info = await (await fetch(`${base}/api/link/${c.code}`)).json();
  assert.deepEqual(info.deviceCheck, { apiKey: 'public-key', region: 'eu' });

  assert.equal((await submit(c.code, alice, { browser: null })).status, 400);
  const bot = await submit(c.code, alice, { browser: 'bot-farm' });
  assert.equal(bot.status, 403);
  assert.match(bot.body.error, /automated browser/);

  const ok = await submit(c.code, alice, { browser: 'laptop-7' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.deviceChecked, true);
  assert.equal((await rewards('dev-7')).deviceChecked, true);
});

test('the welcome bonus is paid once per browser: reinstalling with a new wallet does not earn it again', async () => {
  await newDevice('dev-8a');
  const first = await submit((await challenge('dev-8a')).body.code, Keypair.generate(), { browser: 'pc-8' });
  assert.equal(first.body.welcome.status, 'sent');

  // Same browser, new install (new device ID), new wallet
  await newDevice('dev-8b');
  const again = await submit((await challenge('dev-8b')).body.code, Keypair.generate(), { browser: 'pc-8' });
  assert.equal(again.status, 200);
  assert.equal(again.body.welcome, null);
});

test('devices linked before the device check can verify again, with the same wallet only', async () => {
  await newDevice('dev-9');
  const alice = Keypair.generate();
  await sql`UPDATE devices SET wallet_address = ${alice.publicKey.toBase58()}, visitor_id = NULL WHERE id = 'dev-9'`;
  assert.equal((await rewards('dev-9')).deviceChecked, false);

  const { status, body: c } = await challenge('dev-9', 'link');
  assert.equal(status, 200);
  assert.equal((await submit(c.code, Keypair.generate(), { browser: 'pc-9' })).status, 403);
  const ok = await submit(c.code, alice, { browser: 'pc-9' });
  assert.equal(ok.status, 200);
  assert.equal((await rewards('dev-9')).deviceChecked, true);
  // Verified: a second link is refused until unlinking
  assert.equal((await challenge('dev-9', 'link')).status, 409);
});

test('without Fingerprint configured, linking is refused', async () => {
  const server = createApp(sql, { now: () => clock }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const other = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await newDevice('dev-10');
    const { code } = await (await fetch(`${other}/api/devices/dev-10/link-challenge`, json('POST', { action: 'link' }))).json();
    const info = await (await fetch(`${other}/api/link/${code}`)).json();
    assert.equal(info.deviceCheck, null);
    const alice = Keypair.generate();
    const res = await fetch(`${other}/api/link/${code}`, json('POST', {
      wallet: alice.publicKey.toBase58(), signature: signWith(alice, info.message), deviceEventId: 'pc.1',
    }));
    assert.equal(res.status, 503);
  } finally {
    server.close();
  }
});
