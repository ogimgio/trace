import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { Keypair, type PublicKey } from '@solana/web3.js';
import { createApp } from '../src/api.ts';
import { startTestDb } from './db.ts';
import { CHALLENGE_TTL_MS } from '../src/rewards/link.ts';
import { EPOCH_MS } from '../src/rewards/policy.ts';

const DAY = 86_400_000;

// Firma come farebbe Phantom: Ed25519 sui byte UTF-8 del messaggio.
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
const sent: string[] = [];

before(async () => {
  const rewarder = {
    send: async (wallet: PublicKey) => {
      sent.push(wallet.toBase58());
      return { signature: `sig-${sent.length}`, explorerUrl: '' };
    },
  };
  const db = await startTestDb();
  const server = createApp(db.sql, { rewarder, now: () => clock, cronSecret: 'cron-test' }).listen(0, '127.0.0.1');
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

// Device con 8 giorni attivi di storico: ha diritto al bonus di benvenuto.
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

async function submit(code: string, keypair: Keypair, message?: string) {
  const info = await (await fetch(`${base}/api/link/${code}`)).json();
  const res = await fetch(`${base}/api/link/${code}`, json('POST', {
    wallet: keypair.publicKey.toBase58(),
    signature: signWith(keypair, message ?? info.message),
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
  assert.match(info.message, /Collega questo wallet al dispositivo dev-1/);
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

  // Firma di un altro wallet che si spaccia per alice
  const forged = await fetch(`${base}/api/link/${c.code}`, json('POST', {
    wallet: alice.publicKey.toBase58(),
    signature: signWith(mallory, info.message),
  }));
  assert.equal(forged.status, 401);
  // Messaggio diverso da quello della challenge
  assert.equal((await submit(c.code, alice, info.message.replace('dev-2', 'dev-X'))).status, 401);
  // Firma non valida
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

  // Chi conosce il deviceId non può collegare il suo wallet al posto di quello di alice
  assert.equal((await challenge('dev-5', 'link')).status, 409);
  const { body: unlink } = await challenge('dev-5', 'unlink');
  assert.equal((await submit(unlink.code, mallory)).status, 403);
  assert.equal((await rewards('dev-5')).wallet, alice.publicKey.toBase58());

  // Alice si scollega e collega un nuovo wallet: niente secondo bonus di benvenuto
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

  // Il cron richiede il segreto
  assert.equal((await fetch(`${base}/api/cron/settle`)).status, 401);
  const cron = await fetch(`${base}/api/cron/settle`, { headers: { authorization: 'Bearer cron-test' } });
  assert.equal(cron.status, 200);

  // L'API vecchia senza firma non esiste più
  const unsigned = await fetch(`${base}/api/devices/dev-6/wallet`, json('PUT', { wallet: Keypair.generate().publicKey.toBase58() }));
  assert.equal(unsigned.status, 404);

  const r = await rewards('dev-6');
  assert.equal(r.currentWeek.endsAt - r.currentWeek.startsAt, EPOCH_MS);
});
