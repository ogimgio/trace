import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair, SendTransactionError } from '@solana/web3.js';
import { openDb } from '../src/db.ts';
import { pageKey, scoreVisits } from '../src/rewards/points.ts';
import { epochBudget, epochRange, toUnits } from '../src/rewards/policy.ts';
import { distribute, ensureRewardsSchema, grantWelcome, planEpoch, sendPayouts, settleEpoch } from '../src/rewards/settle.ts';

const DAY = 86_400_000;
const D = 6; // decimali

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
  // Uno script che apre 5000 URL diversi in un giorno
  const spam = Array.from({ length: 5000 }, (_, i) => ({ url: `https://spam.com/${i}`, visitTime: startsAt + i }));
  assert.deepEqual(scoreVisits(spam), { pages: 5000, activeDays: 1, points: 1000 + 100 });

  // Navigazione normale: 7 giorni con 10 visite, più un giorno con solo 2 visite che non conta
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
  // Pochi utenti: vale il tetto per punto
  assert.deepEqual(distribute(1_000_000n, [100, 300], 10n), [1000n, 3000n]);
  // Tanti punti: vale la proporzione
  assert.deepEqual(distribute(1000n, [100, 300], 10n), [250n, 750n]);
  const amounts = distribute(1000n, [1, 1, 1], 1000n);
  assert.ok(amounts.reduce((a, b) => a + b) <= 1000n);
  assert.deepEqual(distribute(1000n, [], 1n), []);
});

function seed() {
  const db = openDb(':memory:');
  ensureRewardsSchema(db);
  const { startsAt } = epochRange(0);
  const wallets = { a: Keypair.generate().publicKey.toBase58(), b: Keypair.generate().publicKey.toBase58() };
  const addDevice = db.prepare('INSERT INTO devices (id, created_at, wallet_address) VALUES (?, 0, ?)');
  addDevice.run('dev-a', wallets.a);
  addDevice.run('dev-b', wallets.b);
  addDevice.run('dev-nowallet', null);
  const addVisit = db.prepare("INSERT INTO visits (device_id, visit_id, url, visit_time, received_at) VALUES (?, ?, ?, ?, 0)");
  let id = 0;
  const browse = (device: string, days: number, pagesPerDay: number, from = startsAt) => {
    for (let d = 0; d < days; d++) for (let i = 0; i < pagesPerDay; i++) {
      addVisit.run(device, String(id++), `https://${device}.com/${d}/${i}`, from + d * DAY + i);
    }
  };
  browse('dev-a', 7, 20); // 140 pagine + 700 = 840 punti
  browse('dev-b', 2, 10); // 20 pagine + 200 = 220 punti, solo 2 giorni attivi
  browse('dev-nowallet', 7, 20);
  browse('dev-b', 7, 10, startsAt - 7 * DAY); // storico prima dell'epoch 0: 7 giorni attivi → bonus
  return { db, wallets, afterEpoch0: epochRange(0).endsAt + 9 * DAY };
}

test('settleEpoch pays devices with a wallet, adds the welcome bonus once, and is final', () => {
  const { db, wallets, afterEpoch0 } = seed();
  const plan = settleEpoch(db, 0, D, afterEpoch0);

  assert.equal(plan.totalPoints, 840 + 220);
  const byKey = Object.fromEntries(plan.payouts.map((p) => [`${p.deviceId}:${p.kind}`, p]));
  // dev-a ha 7 giorni attivi nella settimana, dev-b nello storico precedente: bonus a entrambi
  assert.deepEqual(Object.keys(byKey).sort(), ['dev-a:weekly', 'dev-a:welcome', 'dev-b:weekly', 'dev-b:welcome']);
  // Pochi utenti: ognuno prende il tetto di 1 TRACE per punto
  assert.equal(byKey['dev-a:weekly'].amount, toUnits(840n, D));
  assert.equal(byKey['dev-b:weekly'].amount, toUnits(220n, D));
  assert.equal(byKey['dev-b:welcome'].amount, toUnits(500n, D));
  assert.equal(byKey['dev-a:weekly'].wallet, wallets.a);

  const rows = db.prepare("SELECT COUNT(*) AS n FROM reward_payouts WHERE status = 'pending'").get() as { n: number };
  assert.equal(rows.n, 4);
  assert.throws(() => settleEpoch(db, 0, D, afterEpoch0), /already settled/);
  // Il bonus non viene ripetuto la settimana dopo
  assert.ok(!planEpoch(db, 1, D).payouts.some((p) => p.kind === 'welcome'));
});

test('settleEpoch refuses weeks that are not over (or within the grace period)', () => {
  const { db } = seed();
  const { endsAt } = epochRange(0);
  assert.throws(() => settleEpoch(db, 0, D, endsAt - 1, { ignoreGrace: true }), /cannot be settled/);
  assert.throws(() => settleEpoch(db, 0, D, endsAt + DAY), /cannot be settled/);
  assert.doesNotThrow(() => settleEpoch(db, 0, D, endsAt + DAY, { ignoreGrace: true }));
});

test('sendPayouts marks sent, retryable failures, and unknown outcomes separately', async () => {
  const { db, afterEpoch0 } = seed();
  settleEpoch(db, 0, D, afterEpoch0);
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

  // Senza --retry-failed non si ritenta niente; con, solo il 'failed' (il 'sending' potrebbe essere già arrivato)
  assert.equal((await sendPayouts(db, rewarder)).length, 0);
  const retried = await sendPayouts(db, { send: async () => ({ signature: 'sig-2', explorerUrl: '' }) }, { retryFailed: true });
  assert.deepEqual(retried.map((r) => r.status), ['sent']);
});

test('welcome bonus is granted once per device and once per wallet', () => {
  const { db, wallets, afterEpoch0 } = seed();
  // dev-a ha 7 giorni attivi: bonus subito
  const row = grantWelcome(db, 'dev-a', wallets.a, D, afterEpoch0);
  assert.equal(row?.status, 'pending');
  assert.equal(row?.amount, toUnits(500n, D).toString());
  assert.equal(grantWelcome(db, 'dev-a', wallets.a, D, afterEpoch0), null);
  // Lo stesso wallet su un altro device non prende un secondo bonus
  assert.equal(grantWelcome(db, 'dev-nowallet', wallets.a, D, afterEpoch0), null);
  // E la chiusura della settimana non lo ripaga
  assert.ok(!planEpoch(db, 0, D).payouts.some((p) => p.deviceId === 'dev-a' && p.kind === 'welcome'));
});

test('welcome bonus waits for enough history', () => {
  const { db, wallets } = seed();
  const { startsAt } = epochRange(0);
  // A metà della prima settimana dev-a ha solo 3 giorni attivi
  assert.equal(grantWelcome(db, 'dev-a', wallets.a, D, startsAt + 3 * DAY), null);
});

test('concurrent sendPayouts never pay the same row twice', async () => {
  const { db, afterEpoch0 } = seed();
  settleEpoch(db, 0, D, afterEpoch0);
  let sends = 0;
  const slow = { send: async () => { sends++; await new Promise((r) => setTimeout(r, 5)); return { signature: `s${sends}`, explorerUrl: '' }; } };
  const [a, b] = await Promise.all([sendPayouts(db, slow), sendPayouts(db, slow)]);
  assert.equal(a.length + b.length, 4);
  assert.equal(sends, 4);
});
