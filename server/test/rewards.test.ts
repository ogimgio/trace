import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { Keypair, SendTransactionError } from '@solana/web3.js';
import type { Sql } from '../src/db.ts';
import { pageKey, scoreVisits } from '../src/rewards/points.ts';
import { epochBudget, epochRange, toUnits } from '../src/rewards/policy.ts';
import { distribute, grantWelcome, planEpoch, readyEpochs, sendPayouts, settleEpoch } from '../src/rewards/settle.ts';
import { purgeExpiredVisits, RETENTION_MS } from '../src/retention.ts';
import { startTestDb } from './db.ts';

const DAY = 86_400_000;
const D = 6; // decimals

let db: Sql;
let reset: () => Promise<void>;
let stop: () => Promise<void>;
before(async () => ({ sql: db, reset, stop } = await startTestDb()));
beforeEach(() => reset());
after(() => stop());

test('pageKey keeps only public web pages and ignores query/fragment', () => {
  assert.equal(pageKey('https://Example.com/a/b/?q=1#top'), 'example.com/a/b');
  assert.equal(pageKey('https://example.com/a/b?q=2'), 'example.com/a/b');
  for (const url of ['file:///Users/me/doc.pdf', 'chrome-extension://abc/popup.html', 'http://localhost:3000/',
    'http://127.0.0.1:8787/health', 'http://192.168.1.1/admin', 'http://printer.local/', 'not a url']) {
    assert.equal(pageKey(url), null, url);
  }
});

test('scoreVisits caps pages and counts active days', () => {
  const { startsAt } = epochRange(0);
  // A script opening 5000 different URLs in one day
  const spam = Array.from({ length: 5000 }, (_, i) => ({ url: `https://spam.com/${i}`, visitTime: startsAt + i }));
  assert.deepEqual(scoreVisits(spam), { pages: 5000, activeDays: 1, points: 1000 + 100 });

  // Normal browsing: 7 days with 10 visits, plus a day with only 2 visits that does not count
  const normal = [];
  for (let d = 0; d < 7; d++) for (let i = 0; i < 10; i++) normal.push({ url: `https://site${i}.com/`, visitTime: startsAt + d * DAY + i });
  assert.deepEqual(scoreVisits(normal), { pages: 10, activeDays: 7, points: 10 + 700 });
});

test('weekly budget decays by 1% and never exceeds the 500M pool', () => {
  assert.equal(epochBudget(0, D), toUnits(5_000_000n, D));
  assert.equal(epochBudget(1, D), toUnits(4_950_000n, D));
  let total = 0n;
  for (let e = 0; e < 1500; e++) total += epochBudget(e, D);
  assert.ok(total <= toUnits(500_000_000n, D));
  assert.ok(total > toUnits(499_000_000n, D));
});

test('distribute is proportional, capped per point and never exceeds the budget', () => {
  // Few users: the per-point cap applies
  assert.deepEqual(distribute(1_000_000n, [100, 300], 10n), [1000n, 3000n]);
  // Many points: the proportional split applies
  assert.deepEqual(distribute(1000n, [100, 300], 10n), [250n, 750n]);
  const amounts = distribute(1000n, [1, 1, 1], 1000n);
  assert.ok(amounts.reduce((a, b) => a + b) <= 1000n);
  assert.deepEqual(distribute(1000n, [], 1n), []);
});

async function seed() {
  const { startsAt } = epochRange(0);
  const wallets = { a: Keypair.generate().publicKey.toBase58(), b: Keypair.generate().publicKey.toBase58() };
  await db`INSERT INTO devices ${db([
    { id: 'dev-a', created_at: 0, wallet_address: wallets.a },
    { id: 'dev-b', created_at: 0, wallet_address: wallets.b },
    { id: 'dev-nowallet', created_at: 0, wallet_address: null },
  ])}`;
  const rows: Record<string, unknown>[] = [];
  const browse = (device: string, days: number, pagesPerDay: number, from = startsAt) => {
    for (let d = 0; d < days; d++) for (let i = 0; i < pagesPerDay; i++) {
      rows.push({ device_id: device, visit_id: String(rows.length), url: `https://${device}.com/${d}/${i}`, visit_time: from + d * DAY + i, received_at: 0 });
    }
  };
  browse('dev-a', 7, 20); // 140 pages + 700 = 840 points
  browse('dev-b', 2, 10); // 20 pages + 200 = 220 points, only 2 active days
  browse('dev-nowallet', 7, 20);
  browse('dev-b', 7, 10, startsAt - 7 * DAY); // history before epoch 0: 7 active days → bonus
  await db`INSERT INTO visits ${db(rows)}`;
  return { wallets, afterEpoch0: epochRange(0).endsAt + 9 * DAY };
}

test('settleEpoch pays devices with a wallet, adds the welcome bonus once, and is final', async () => {
  const { wallets, afterEpoch0 } = await seed();
  const plan = await settleEpoch(db, 0, D, afterEpoch0);

  assert.equal(plan.totalPoints, 840 + 220);
  const byKey = Object.fromEntries(plan.payouts.map((p) => [`${p.deviceId}:${p.kind}`, p]));
  // dev-a has 7 active days in the week, dev-b in its earlier history: bonus for both
  assert.deepEqual(Object.keys(byKey).sort(), ['dev-a:weekly', 'dev-a:welcome', 'dev-b:weekly', 'dev-b:welcome']);
  // Few users: each gets the cap of 1 TRACE per point
  assert.equal(byKey['dev-a:weekly'].amount, toUnits(840n, D));
  assert.equal(byKey['dev-b:weekly'].amount, toUnits(220n, D));
  assert.equal(byKey['dev-b:welcome'].amount, toUnits(500n, D));
  assert.equal(byKey['dev-a:weekly'].wallet, wallets.a);

  const [rows] = await db`SELECT COUNT(*) AS n FROM reward_payouts WHERE status = 'pending'`;
  assert.equal(rows.n, 4);
  await assert.rejects(settleEpoch(db, 0, D, afterEpoch0), /already settled/);
  assert.deepEqual(await readyEpochs(db, afterEpoch0), []);
  // The bonus is not repeated the following week
  assert.ok(!(await planEpoch(db, 1, D)).payouts.some((p) => p.kind === 'welcome'));
});

test('settleEpoch refuses weeks that are not over (or within the grace period)', async () => {
  await seed();
  const { endsAt } = epochRange(0);
  await assert.rejects(settleEpoch(db, 0, D, endsAt - 1, { ignoreGrace: true }), /cannot be settled/);
  await assert.rejects(settleEpoch(db, 0, D, endsAt + DAY), /cannot be settled/);
  assert.deepEqual(await readyEpochs(db, endsAt + DAY), []);
  assert.deepEqual(await readyEpochs(db, endsAt + DAY, { ignoreGrace: true }), [0]);
  await settleEpoch(db, 0, D, endsAt + DAY, { ignoreGrace: true });
});

test('sendPayouts marks sent, retryable failures, and unknown outcomes separately', async () => {
  const { afterEpoch0 } = await seed();
  await settleEpoch(db, 0, D, afterEpoch0);
  let call = 0;
  const rewarder = {
    async send() {
      call++;
      if (call === 1) return { signature: 'sig-1', explorerUrl: '' };
      if (call === 2) throw new SendTransactionError({ action: 'send', signature: '', transactionMessage: 'insufficient funds' });
      throw new Error('block height exceeded');
    },
  };
  const rows = await sendPayouts(db, rewarder);
  assert.deepEqual(rows.map((r) => r.status), ['sent', 'failed', 'sending', 'sending']);

  // Without --retry-failed nothing is retried; with it, only 'failed' ('sending' may have already landed)
  assert.equal((await sendPayouts(db, rewarder)).length, 0);
  const retried = await sendPayouts(db, { send: async () => ({ signature: 'sig-2', explorerUrl: '' }) }, { retryFailed: true });
  assert.deepEqual(retried.map((r) => r.status), ['sent']);
});

test('welcome bonus is granted once per device and once per wallet', async () => {
  const { wallets, afterEpoch0 } = await seed();
  // dev-a has 7 active days: bonus right away
  const row = await grantWelcome(db, 'dev-a', wallets.a, D, afterEpoch0);
  assert.equal(row?.status, 'pending');
  assert.equal(row?.amount, toUnits(500n, D).toString());
  assert.equal(await grantWelcome(db, 'dev-a', wallets.a, D, afterEpoch0), null);
  // The same wallet on another device does not get a second bonus
  assert.equal(await grantWelcome(db, 'dev-nowallet', wallets.a, D, afterEpoch0), null);
  // And settling the week does not pay it again
  assert.ok(!(await planEpoch(db, 0, D)).payouts.some((p) => p.deviceId === 'dev-a' && p.kind === 'welcome'));
});

test('welcome bonus waits for enough history', async () => {
  const { wallets } = await seed();
  const { startsAt } = epochRange(0);
  // Halfway through the first week dev-a has only 3 active days
  assert.equal(await grantWelcome(db, 'dev-a', wallets.a, D, startsAt + 3 * DAY), null);
});

test('concurrent sendPayouts never pay the same row twice', async () => {
  const { afterEpoch0 } = await seed();
  await settleEpoch(db, 0, D, afterEpoch0);
  let sends = 0;
  const slow = { send: async () => { sends++; await new Promise((r) => setTimeout(r, 5)); return { signature: `s${sends}`, explorerUrl: '' }; } };
  const [a, b] = await Promise.all([sendPayouts(db, slow), sendPayouts(db, slow)]);
  assert.equal(a.length + b.length, 4);
  assert.equal(sends, 4);
});

test('visits are purged after the retention period, payouts are kept', async () => {
  const { afterEpoch0 } = await seed();
  await settleEpoch(db, 0, D, afterEpoch0);
  const now = RETENTION_MS + 10;
  await db`UPDATE visits SET received_at = 5 WHERE device_id = 'dev-a'`;
  await db`UPDATE visits SET received_at = 20 WHERE device_id <> 'dev-a'`;
  assert.equal(await purgeExpiredVisits(db, now), 140);
  const [left] = await db`SELECT COUNT(*) AS n FROM visits WHERE device_id = 'dev-a'`;
  assert.equal(left.n, 0);
  const [payouts] = await db`SELECT COUNT(*) AS n FROM reward_payouts`;
  assert.equal(payouts.n, 4);
});
