import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { Keypair, SendTransactionError } from '@solana/web3.js';
import type { Sql } from '../src/db.ts';
import { pageKey, scoreDays } from '../src/rewards/points.ts';
import { epochRange, toUnits } from '../src/rewards/policy.ts';
import { planEpoch, readyEpochs, sendPayouts, settleEpoch } from '../src/rewards/settle.ts';
import { claimOffer, computeOffer } from '../src/rewards/claims.ts';
import { checkVisits, type WeekVisit } from '../src/rewards/eligibility.ts';
import { walletsUnderReview } from '../src/rewards/risk.ts';
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

test('each day earns its unique pages (capped) plus a bonus when active', () => {
  const { startsAt } = epochRange(0);
  // A script opening 5000 different URLs in one day: capped at 100 pages
  const spam = Array.from({ length: 5000 }, (_, i) => ({ url: `https://spam.com/${i}`, visitTime: startsAt + i }));
  assert.deepEqual(scoreDays(spam).map((d) => d.points), [100 + 100]);

  // 7 days with 10 visits to 10 sites, then a day with only 2 visits: no active-day bonus
  const normal = [];
  for (let d = 0; d < 7; d++) for (let i = 0; i < 10; i++) normal.push({ url: `https://site${i}.com/`, visitTime: startsAt + d * DAY + i });
  normal.push({ url: 'https://a.com/', visitTime: startsAt + 7 * DAY }, { url: 'https://b.com/', visitTime: startsAt + 7 * DAY + 1 });
  const days = scoreDays(normal);
  assert.deepEqual(days.map((d) => d.points), [110, 110, 110, 110, 110, 110, 110, 2]);
  assert.deepEqual(days.at(-1), { day: Math.floor((startsAt + 7 * DAY) / DAY), visits: 2, pages: 2, active: false, points: 2 });
});

// Marks wallets as linked through a Fingerprint device check (one device each): only those are paid.
let devices = 0;
async function verify(...wallets: string[]) {
  for (const wallet of wallets) {
    await db`
      INSERT INTO device_fingerprints (visitor_id, wallet, first_seen_at, last_seen_at, cluster_key)
      VALUES (${`visitor-${++devices}`}, ${wallet}, 0, 0, ${`net-${devices}`})
    `;
  }
}

async function pendingPayouts(n: number) {
  for (let i = 0; i < n; i++) {
    await db`
      INSERT INTO reward_payouts (epoch, device_id, wallet, kind, points, amount, status, created_at)
      VALUES (0, ${`dev-${i}`}, ${Keypair.generate().publicKey.toBase58()}, 'claim', 10, ${toUnits(10n, D).toString()}, 'pending', 0)
    `;
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

test('weekly settlement pays the welcome installment to active wallets, and is final', async () => {
  const { wallets, afterEpoch0 } = await seed();
  const plan = await settleEpoch(db, 0, D, afterEpoch0);
  // dev-a was active 7 days: installment. dev-b only 2 days (< 3): none. Shared data is paid by claims.
  assert.deepEqual(plan.payouts.map((p) => `${p.deviceId}:${p.kind}`), ['dev-a:welcome']);
  assert.equal(plan.payouts[0].amount, toUnits(50n, D));
  assert.equal(plan.payouts[0].wallet, wallets.a);

  const [rows] = await db`SELECT COUNT(*) AS n FROM reward_payouts WHERE status = 'pending'`;
  assert.equal(rows.n, 1);
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
  await pendingPayouts(3);
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
  await pendingPayouts(3);
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
  assert.equal(payouts.n, 1);
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

test('the welcome bonus ignores devices whose history copies another', async () => {
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
  assert.deepEqual(plan.payouts.map((p) => `${p.deviceId}:${p.kind}`), ['alice:welcome']);
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

test('wallets without a device check earn nothing, but their visits still count as originals', async () => {
  const { afterEpoch0, wallets } = await seed();
  await db`DELETE FROM device_fingerprints WHERE wallet = ${wallets.b}`;
  const plan = await settleEpoch(db, 0, D, afterEpoch0);
  assert.deepEqual(plan.payouts.map((p) => `${p.deviceId}:${p.kind}`), ['dev-a:welcome']);
});

test('risky devices get their wallet held for review, never refused', async () => {
  const { afterEpoch0, wallets } = await seed();
  // dev-a's device has a high suspect score
  await db`UPDATE device_fingerprints SET suspect_score = 40 WHERE wallet = ${wallets.a}`;
  const plan = await settleEpoch(db, 0, D, afterEpoch0);
  assert.deepEqual(plan.payouts.map((p) => p.wallet), [wallets.a]);
  assert.match(plan.payouts[0].holdReason!, /suspect score 40/);
  const [row] = await db<{ status: string }[]>`SELECT status FROM reward_payouts`;
  assert.equal(row.status, 'held');
  // Held payouts are never sent automatically
  assert.deepEqual(await sendPayouts(db, { send: async () => ({ signature: 's', explorerUrl: '' }) }), []);
});

test('review reasons: devices trying other wallets, and clusters of wallets on one network', async () => {
  const now = epochRange(0).endsAt;
  const w = Array.from({ length: 6 }, () => Keypair.generate().publicKey.toBase58());
  // w[0]'s device tried to link two other wallets
  await db`INSERT INTO device_fingerprints (visitor_id, wallet, first_seen_at, last_seen_at) VALUES ('farm-pc', ${w[0]}, 0, ${now})`;
  await db`INSERT INTO device_link_rejections (visitor_id, wallet, created_at) VALUES ('farm-pc', 'x', ${now}), ('farm-pc', 'y', ${now})`;
  // w[1..5]: five wallets, five devices, same network and browser setup
  for (let i = 1; i <= 5; i++) {
    await db`INSERT INTO device_fingerprints (visitor_id, wallet, first_seen_at, last_seen_at, cluster_key) VALUES (${`d${i}`}, ${w[i]}, 0, ${now}, 'same-net')`;
  }
  const review = await walletsUnderReview(db, now);
  assert.match(review.get(w[0])!, /2 attempts to link other wallets/);
  for (let i = 1; i <= 5; i++) assert.match(review.get(w[i])!, /cluster of 5 wallets/);
  // Four wallets on one network (a family) is below the threshold
  await db`DELETE FROM device_fingerprints WHERE visitor_id = 'd5'`;
  assert.equal((await walletsUnderReview(db, now)).has(w[1]), false);
});

// --- Shared-data claims (claims.ts) ---

const NOW = epochRange(0).startsAt + 20 * DAY + 5 * HOUR; // mid-morning of day 20
const TODAY = Math.floor(NOW / DAY);

// A device that just uploaded its history: `days` days before today with 10 visits each (5 pages), plus
// some visits today. Everything received now, like the first sync after installing.
async function historyDevice(id: string, wallet: string | null, { days = 10, host = id, createdAt = 0, lag = 0 } = {}) {
  await db`INSERT INTO devices (id, created_at, wallet_address) VALUES (${id}, ${createdAt}, ${wallet}) ON CONFLICT DO NOTHING`;
  const rows = [];
  for (let d = -days; d <= 0; d++) for (let i = 0; i < 10; i++) {
    const visitTime = (TODAY + d) * DAY + HOUR + i * 60_000;
    if (visitTime > NOW) continue;
    rows.push({ device_id: id, visit_id: `${d}-${i}`, url: `https://${host}.com/${d}/${i % 5}`, visit_time: visitTime, received_at: NOW + lag });
  }
  await db`INSERT INTO visits ${db(rows)}`;
}

test('shared history is offered day by day, today excluded until it ends', async () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  await historyDevice('h1', wallet);
  const offer = await computeOffer(db, 'h1', wallet, NOW, D);
  // 10 finished days × (5 pages + 100 for an active day)
  assert.equal(offer.days.length, 10);
  assert.equal(offer.points, 10 * 105);
  assert.equal(offer.visits, 100);
  assert.equal(offer.activeDays, 10);
  assert.equal(offer.amount, toUnits(1050n, D));
  assert.ok(offer.days.every((d) => d.day < TODAY));
  // History older than 90 days is not paid
  assert.equal((await computeOffer(db, 'h1', wallet, NOW + 95 * DAY, D)).points, 0);
});

test('a claim pays the offered days once: claiming again or re-uploading from another install earns nothing', async () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  await historyDevice('h2', wallet);
  const { payout } = await claimOffer(db, 'h2', wallet, NOW, D);
  assert.equal(payout?.kind, 'claim');
  assert.equal(payout?.points, 1050);
  assert.equal(payout?.status, 'pending');

  assert.equal((await claimOffer(db, 'h2', wallet, NOW, D)).payout, null);
  // The same history from a reinstalled extension (new device ID, same wallet): exact copies and paid days
  await historyDevice('h2-reinstall', wallet, { host: 'h2', lag: 1 });
  const again = await computeOffer(db, 'h2-reinstall', wallet, NOW, D);
  assert.equal(again.points, 0);
  assert.equal(again.copiedFrom, null); // a copy of the same wallet's own device is not flagged as theft
  // The next day, yesterday becomes claimable
  const tomorrow = await computeOffer(db, 'h2', wallet, NOW + DAY, D);
  assert.deepEqual(tomorrow.days.map((d) => d.day), [TODAY]);
});

test('other wallets get nothing for a copied history, and the original keeps its offer', async () => {
  const [alice, mallory] = [Keypair.generate(), Keypair.generate()].map((k) => k.publicKey.toBase58());
  await historyDevice('orig', alice, { createdAt: 1 });
  await historyDevice('copy', mallory, { host: 'orig', createdAt: 2, lag: 1 });
  const copy = await computeOffer(db, 'copy', mallory, NOW, D);
  assert.equal(copy.copiedFrom, 'orig');
  assert.equal(copy.points, 0);
  assert.equal((await claimOffer(db, 'copy', mallory, NOW, D)).payout, null);
  assert.equal((await computeOffer(db, 'orig', alice, NOW, D)).points, 1050);
});

test('parallel claims never pay a day twice', async () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  await historyDevice('h3', wallet);
  const results = await Promise.all([claimOffer(db, 'h3', wallet, NOW, D), claimOffer(db, 'h3', wallet, NOW, D)]);
  const paid = results.filter((r) => r.payout).map((r) => r.payout!.points);
  assert.equal(paid.reduce((a, b) => a + b, 0), 1050);
  const [days] = await db`SELECT COUNT(*)::int AS n FROM reward_days WHERE wallet = ${wallet}`;
  assert.equal(days.n, 10);
});

test('claims of risky wallets are held for review', async () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  await historyDevice('h4', wallet);
  await db`INSERT INTO device_fingerprints (visitor_id, wallet, first_seen_at, last_seen_at, suspect_score) VALUES ('risky', ${wallet}, 0, ${NOW}, 40)`;
  const { payout } = await claimOffer(db, 'h4', wallet, NOW, D);
  assert.equal(payout?.status, 'held');
  assert.match(payout?.hold_reason ?? '', /suspect score/);
});
