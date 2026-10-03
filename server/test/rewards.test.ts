import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { Keypair, SendTransactionError } from '@solana/web3.js';
import type { Sql } from '../src/db.ts';
import { pageKey, scoreVisits } from '../src/rewards/points.ts';
import { epochBudget, epochRange, toUnits } from '../src/rewards/policy.ts';
import { countableVisits, distribute, planEpoch, readyEpochs, sendPayouts, settleEpoch } from '../src/rewards/settle.ts';
import { checkVisits, type WeekVisit } from '../src/rewards/eligibility.ts';
import { purgeExpiredVisits, RETENTION_MS } from '../src/retention.ts';
import { startTestDb } from './db.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;
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

// Marks wallets as verified with World ID (one anonymous nullifier each): only those are paid.
let humans = 0;
async function verify(...wallets: string[]) {
  for (const wallet of wallets) {
    await db`INSERT INTO worldid_verifications (action, nullifier, wallet, verified_at) VALUES ('link-wallet', ${String(++humans)}, ${wallet}, 0)`;
  }
}

async function seed() {
  const { startsAt } = epochRange(0);
  const wallets = { a: Keypair.generate().publicKey.toBase58(), b: Keypair.generate().publicKey.toBase58() };
  await db`INSERT INTO devices ${db([
    { id: 'dev-a', created_at: 0, wallet_address: wallets.a },
    { id: 'dev-b', created_at: 0, wallet_address: wallets.b },
    { id: 'dev-nowallet', created_at: 0, wallet_address: null },
  ])}`;
  await verify(wallets.a, wallets.b);
  const rows: Record<string, unknown>[] = [];
  const browse = (device: string, days: number, pagesPerDay: number, from = startsAt) => {
    for (let d = 0; d < days; d++) for (let i = 0; i < pagesPerDay; i++) {
      const visitTime = from + d * DAY + i;
      // Synced an hour later: live visits
      rows.push({ device_id: device, visit_id: String(rows.length), url: `https://${device}.com/${d}/${i}`, visit_time: visitTime, received_at: visitTime + HOUR });
    }
  };
  browse('dev-a', 7, 20); // 140 pages + 700 = 840 points
  browse('dev-b', 2, 10); // 20 pages + 200 = 220 points, only 2 active days
  browse('dev-nowallet', 7, 20);
  await db`INSERT INTO visits ${db(rows)}`;
  return { wallets, afterEpoch0: epochRange(0).endsAt + 9 * DAY };
}

test('settleEpoch pays devices with a wallet, adds a welcome installment to active ones, and is final', async () => {
  const { wallets, afterEpoch0 } = await seed();
  const plan = await settleEpoch(db, 0, D, afterEpoch0);

  assert.equal(plan.totalPoints, 840 + 220);
  const byKey = Object.fromEntries(plan.payouts.map((p) => [`${p.deviceId}:${p.kind}`, p]));
  // dev-a was active 7 days: installment. dev-b only 2 days (< 3): no installment this week
  assert.deepEqual(Object.keys(byKey).sort(), ['dev-a:weekly', 'dev-a:welcome', 'dev-b:weekly']);
  // Few users: each gets the cap of 1 TRACE per point
  assert.equal(byKey['dev-a:weekly'].amount, toUnits(840n, D));
  assert.equal(byKey['dev-b:weekly'].amount, toUnits(220n, D));
  assert.equal(byKey['dev-a:welcome'].amount, toUnits(50n, D));
  assert.equal(byKey['dev-a:weekly'].wallet, wallets.a);

  const [rows] = await db`SELECT COUNT(*) AS n FROM reward_payouts WHERE status = 'pending'`;
  assert.equal(rows.n, 3);
  await assert.rejects(settleEpoch(db, 0, D, afterEpoch0), /already settled/);
  assert.deepEqual(await readyEpochs(db, afterEpoch0), []);
  // No activity the following week: no installment
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
  assert.deepEqual(rows.map((r) => r.status), ['sent', 'failed', 'sending']);

  // Without --retry-failed nothing is retried; with it, only 'failed' ('sending' may have already landed)
  assert.equal((await sendPayouts(db, rewarder)).length, 0);
  const retried = await sendPayouts(db, { send: async () => ({ signature: 'sig-2', explorerUrl: '' }) }, { retryFailed: true });
  assert.deepEqual(retried.map((r) => r.status), ['sent']);
});

test('concurrent sendPayouts never pay the same row twice', async () => {
  const { afterEpoch0 } = await seed();
  await settleEpoch(db, 0, D, afterEpoch0);
  let sends = 0;
  const slow = { send: async () => { sends++; await new Promise((r) => setTimeout(r, 5)); return { signature: `s${sends}`, explorerUrl: '' }; } };
  const [a, b] = await Promise.all([sendPayouts(db, slow), sendPayouts(db, slow)]);
  assert.equal(a.length + b.length, 3);
  assert.equal(sends, 3);
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
  assert.equal(payouts.n, 3);
});

// --- Live visits and duplicates (eligibility.ts) ---

// `days` days of browsing with `perDay` visits, each synced `lag` ms later.
function week(deviceId: string, { days = 7, perDay = 25, lag = HOUR, from = epochRange(0).startsAt, host = deviceId, shift = 0 } = {}): WeekVisit[] {
  const visits: WeekVisit[] = [];
  for (let d = 0; d < days; d++) for (let i = 0; i < perDay; i++) {
    const visitTime = from + d * DAY + i * 60_000 + shift;
    visits.push({ deviceId, url: `https://${host}.com/${d}/${i}`, visitTime, receivedAt: visitTime + lag });
  }
  return visits;
}

const seen = (...ids: string[]) => new Map(ids.map((id, i) => [id, i]));

test('only live visits count: late uploads and backfilled history are ignored', () => {
  const check = checkVisits([
    ...week('fresh'),
    ...week('late', { lag: 4 * DAY }), // synced 4 days later: past the 3-day window
    ...week('future', { lag: -HOUR }), // timestamps an hour ahead of the server: forged or broken clock
  ], seen('fresh', 'late', 'future'));
  assert.equal(check.visits.get('fresh')?.length, 7 * 25);
  assert.equal(check.visits.get('late'), undefined);
  assert.equal(check.visits.get('future'), undefined);
});

test('an exact copy of a history counts once, for the device that uploaded it first', () => {
  const original = week('alice');
  const copy = original.map((v) => ({ ...v, deviceId: 'mallory', receivedAt: v.receivedAt + 60_000 }));
  const check = checkVisits([...copy, ...original], seen('alice', 'mallory'));
  assert.equal(check.visits.get('alice')?.length, 7 * 25);
  assert.equal(check.visits.get('mallory'), undefined);
});

test('pieces of copied history are dropped, the rest of the device still counts', () => {
  const alice = week('alice');
  // Mallory browses for real, but also pastes 30 of Alice's visits
  const pasted = alice.slice(0, 30).map((v) => ({ ...v, deviceId: 'mallory', receivedAt: v.receivedAt + 1 }));
  const check = checkVisits([...alice, ...week('mallory'), ...pasted], seen('alice', 'mallory'));
  assert.equal(check.visits.get('mallory')?.length, 7 * 25);
  assert.equal(check.exactDuplicates.get('mallory'), 30);
  assert.equal(check.nearDuplicateOf.size, 0);
});

test('a copy with timestamps shifted by a few seconds is a near duplicate: the newer device earns nothing', () => {
  const check = checkVisits([
    ...week('alice'),
    ...week('mallory', { host: 'alice', shift: 7_000 }), // same pages, 7 seconds later
  ], seen('alice', 'mallory'));
  assert.equal(check.nearDuplicateOf.get('mallory'), 'alice');
  assert.equal(check.visits.get('mallory'), undefined);
  assert.equal(check.visits.get('alice')?.length, 7 * 25);
});

test('genuine users visiting the same popular pages are not flagged', () => {
  const popular = (deviceId: string, shift: number) => week(deviceId, { host: 'google', days: 1, perDay: 3, shift });
  const check = checkVisits([...week('alice'), ...popular('alice', 0), ...week('bob'), ...popular('bob', 1234)], seen('alice', 'bob'));
  assert.equal(check.nearDuplicateOf.size, 0);
  // Same URL, same minute, but not the same millisecond: both keep their visits
  assert.equal(check.visits.get('bob')?.length, 7 * 25 + 3);
});

test('settlement ignores duplicated devices and the estimate drops exact copies', async () => {
  const { startsAt, endsAt } = epochRange(0);
  const wallets = [Keypair.generate(), Keypair.generate()].map((k) => k.publicKey.toBase58());
  await db`INSERT INTO devices ${db([
    { id: 'alice', created_at: 1, wallet_address: wallets[0] },
    { id: 'mallory', created_at: 2, wallet_address: wallets[1] },
  ])}`;
  await verify(...wallets);
  const original = week('alice');
  const rows = [...original, ...original.map((v) => ({ ...v, deviceId: 'mallory', receivedAt: v.receivedAt + 1 }))]
    .map((v, i) => ({ device_id: v.deviceId, visit_id: String(i), url: v.url, visit_time: v.visitTime, received_at: v.receivedAt }));
  await db`INSERT INTO visits ${db(rows)}`;

  const plan = await planEpoch(db, 0, D);
  assert.deepEqual(plan.payouts.map((p) => `${p.deviceId}:${p.kind}`).sort(), ['alice:weekly', 'alice:welcome']);
  assert.equal((await countableVisits(db, 'alice', startsAt, endsAt)).length, 7 * 25);
  assert.equal((await countableVisits(db, 'mallory', startsAt, endsAt)).length, 0);
});

test('the welcome bonus is paid in weekly installments up to the total, once per wallet per week', async () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  // Two devices of the same person (same wallet), both active every week
  await db`INSERT INTO devices ${db([
    { id: 'laptop', created_at: 1, wallet_address: wallet },
    { id: 'desktop', created_at: 2, wallet_address: wallet },
  ])}`;
  await verify(wallet);
  const weeks = 12;
  const rows = [];
  for (let e = 0; e < weeks; e++) for (const id of ['laptop', 'desktop']) {
    for (const v of week(id, { days: 3, perDay: 5, from: epochRange(e).startsAt })) {
      rows.push({ device_id: id, visit_id: String(rows.length), url: v.url, visit_time: v.visitTime, received_at: v.receivedAt });
    }
  }
  await db`INSERT INTO visits ${db(rows)}`;

  const late = epochRange(weeks).endsAt + 9 * DAY;
  for (let e = 0; e < weeks; e++) await settleEpoch(db, e, D, late);

  const welcome = await db<{ epoch: number; amount: string }[]>`
    SELECT epoch, amount FROM reward_payouts WHERE kind = 'welcome' ORDER BY epoch
  `;
  // 50 per week, one per wallet per week, 500 in total: weeks 0..9, then nothing
  assert.deepEqual(welcome.map((w) => w.epoch), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(welcome.every((w) => w.amount === toUnits(50n, D).toString()));
});

test('wallets not verified with World ID earn nothing, but their visits still count as originals', async () => {
  const { afterEpoch0, wallets } = await seed();
  await db`DELETE FROM worldid_verifications WHERE wallet = ${wallets.b}`;
  const plan = await settleEpoch(db, 0, D, afterEpoch0);
  assert.deepEqual(plan.payouts.map((p) => `${p.deviceId}:${p.kind}`).sort(), ['dev-a:weekly', 'dev-a:welcome']);
});
