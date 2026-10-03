import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { Keypair, type PublicKey } from '@solana/web3.js';
import { createApp } from '../src/api.ts';
import { startTestDb } from './db.ts';
import type { Sql } from '../src/db.ts';
import { CHALLENGE_TTL_MS } from '../src/rewards/link.ts';
import type { DeviceCheck } from '../src/fingerprint.ts';

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

// Stand-in for Fingerprint (the real one is tested in fingerprint.test.ts): the event ID names the device
// ("device:n"). A device named "bot…" is refused like an automated browser.
let events = 0;
const deviceCheck: DeviceCheck = {
  browser: { apiKey: 'pk_test', region: 'eu' },
  check: async (eventId) => {
    const visitorId = eventId.split(':')[0];
    if (visitorId.startsWith('bot')) return { ok: false, error: 'automated browser detected' };
    return { ok: true, visitorId, signals: { suspectScore: 0, vpn: false, incognito: false, clusterKey: `net-${visitorId}` } };
  },
};
const deviceEvent = (device: string) => `${device}:${++events}`;

before(async () => {
  const rewarder = {
    send: async (wallet: PublicKey) => {
      sent.push(wallet.toBase58());
      return { signature: `sig-${sent.length}`, explorerUrl: '' };
    },
  };
  const db0 = await startTestDb();
  db = db0.sql;
  const server = createApp(db0.sql, { rewarder, now: () => clock, cronSecret: 'cron-test', rateLimits: false, deviceCheck }).listen(0, '127.0.0.1');
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

// Signs the link with Phantom from `device` (by default each wallet on its own device). `eventId` overrides
// the device check's event (e.g. to replay one); `null` sends none.
async function submit(
  code: string, keypair: Keypair, message?: string,
  device = `pc-${keypair.publicKey.toBase58().slice(0, 8)}`, eventId: string | null = deviceEvent(device),
) {
  const info = await (await fetch(`${base}/api/link/${code}`)).json();
  const res = await fetch(`${base}/api/link/${code}`, json('POST', {
    wallet: keypair.publicKey.toBase58(),
    signature: signWith(keypair, message ?? info.message),
    ...(eventId === null ? {} : { deviceEventId: eventId }),
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
  // The page gets the public Fingerprint key to run the device check
  assert.deepEqual(info.deviceCheck, { apiKey: 'pk_test', region: 'eu' });

  const { status, body } = await submit(c.code, alice);
  assert.equal(status, 200);
  assert.equal(body.wallet, alice.publicKey.toBase58());
  // The bonus is no longer sent on link: it is paid weekly to wallets that keep browsing
  assert.deepEqual(body.welcome, { installment: '50', total: '500', minActiveDays: 3 });
  assert.equal(sent.length, 0);
  assert.equal(body.deviceChecked, true);
  const r = await rewards('dev-1');
  assert.equal(r.wallet, alice.publicKey.toBase58());
  assert.equal(r.deviceChecked, true);
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
  assert.equal(r.offer.points, 0); // newDevice() uploads the same visits for every device: all exact copies of dev-1's
  assert.equal(r.rules.historyDays, 90);
});

// --- Device check (Fingerprint): one device, one wallet ---

test('linking requires a passed device check, and a failed one does not burn the code', async () => {
  await newDevice('dev-f1');
  const alice = Keypair.generate();
  const { body: c } = await challenge('dev-f1');
  const missing = await submit(c.code, alice, undefined, 'pc-f1', null);
  assert.equal(missing.status, 400);
  const bot = await submit(c.code, alice, undefined, 'bot-farm');
  assert.equal(bot.status, 403);
  assert.match(bot.body.error, /automated/);
  assert.equal((await rewards('dev-f1')).wallet, null);
  assert.equal((await submit(c.code, alice, undefined, 'pc-f1')).status, 200);
});

test('a device links one wallet, and the same wallet can be linked from several devices', async () => {
  for (const id of ['dev-f2', 'dev-f3', 'dev-f4', 'dev-f5']) await newDevice(id);
  const alice = Keypair.generate();
  const mallory = Keypair.generate();
  assert.equal((await submit((await challenge('dev-f2')).body.code, alice, undefined, 'office-pc')).status, 200);

  // Another wallet from the same computer: refused, and the attempt is logged
  const refused = await submit((await challenge('dev-f3')).body.code, mallory, undefined, 'office-pc');
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /one wallet only/);
  const [logged] = await db`SELECT COUNT(*)::int AS n FROM device_link_rejections WHERE visitor_id = 'office-pc'`;
  assert.equal(logged.n, 1);

  // Alice's own wallet on her laptop, and again on the office PC: both fine
  assert.equal((await submit((await challenge('dev-f4')).body.code, alice, undefined, 'alice-laptop')).status, 200);
  assert.equal((await submit((await challenge('dev-f5')).body.code, alice, undefined, 'office-pc')).status, 200);
  const devices = await db<{ visitor_id: string }[]>`SELECT visitor_id FROM device_fingerprints WHERE wallet = ${alice.publicKey.toBase58()} ORDER BY visitor_id`;
  assert.deepEqual(devices.map((d) => d.visitor_id), ['alice-laptop', 'office-pc']);
});

test('a device check counts once', async () => {
  await newDevice('dev-f6');
  await newDevice('dev-f7');
  const alice = Keypair.generate();
  const used = deviceEvent('pc-f6');
  assert.equal((await submit((await challenge('dev-f6')).body.code, alice, undefined, 'pc-f6', used)).status, 200);
  const replay = await submit((await challenge('dev-f7')).body.code, alice, undefined, 'pc-f6', used);
  assert.equal(replay.status, 409);
  assert.match(replay.body.error, /already used/);
});

test('a device can link only a few extension installs per month', async () => {
  const alice = Keypair.generate();
  for (let i = 1; i <= 4; i++) await newDevice(`dev-i${i}`);
  for (let i = 1; i <= 3; i++) assert.equal((await submit((await challenge(`dev-i${i}`)).body.code, alice, undefined, 'reinstaller')).status, 200);
  // A fourth fresh install from the same browser within 30 days
  const fourth = await submit((await challenge('dev-i4')).body.code, alice, undefined, 'reinstaller');
  assert.equal(fourth.status, 429);
  clock += 31 * DAY;
  try {
    assert.equal((await submit((await challenge('dev-i4')).body.code, alice, undefined, 'reinstaller')).status, 200);
  } finally {
    clock -= 31 * DAY;
  }
});

test('a wallet linked before the device check existed earns nothing until it passes it', async () => {
  const legacy = Keypair.generate();
  await newDevice('dev-legacy');
  await db`UPDATE devices SET wallet_address = ${legacy.publicKey.toBase58()} WHERE id = 'dev-legacy'`;
  const before = await rewards('dev-legacy');
  assert.equal(before.deviceChecked, false);
  const claim = await fetch(`${base}/api/devices/dev-legacy/claim`, json('POST'));
  assert.equal(claim.status, 403);

  // 'link' is allowed again on that wallet, but only for the same wallet
  assert.equal((await submit((await challenge('dev-legacy')).body.code, Keypair.generate())).status, 409);
  assert.equal((await submit((await challenge('dev-legacy')).body.code, legacy)).status, 200);
  assert.equal((await rewards('dev-legacy')).deviceChecked, true);
  // Once checked, a new link request needs an unlink first, as before
  assert.equal((await challenge('dev-legacy')).status, 409);
});

test('the extension install limit can be turned off (local development)', async () => {
  const { startTestDb } = await import('./db.ts');
  const dev = await startTestDb();
  const server = createApp(dev.sql, { rateLimits: false, deviceCheck, maxExtensionsPerDevice: false }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const devBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const alice = Keypair.generate();
    for (let i = 1; i <= 5; i++) {
      await fetch(`${devBase}/api/visits`, json('POST', { deviceId: `dev-x${i}`, visits: [] }));
      const { code } = await (await fetch(`${devBase}/api/devices/dev-x${i}/link-challenge`, json('POST', {}))).json();
      const info = await (await fetch(`${devBase}/api/link/${code}`)).json();
      const res = await fetch(`${devBase}/api/link/${code}`, json('POST', {
        wallet: alice.publicKey.toBase58(), signature: signWith(alice, info.message), deviceEventId: deviceEvent('dev-pc'),
      }));
      assert.equal(res.status, 200, `install ${i}`);
    }
  } finally {
    server.close();
    await dev.stop();
  }
});
