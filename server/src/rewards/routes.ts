import { Router } from 'express';
import type { Sql } from '../db.ts';
import { explorerTxUrl, formatUnits, parseWalletAddress, type Rewarder } from '../solana/rewards.ts';
import {
  DEVICE_WINDOW_MS, HISTORY_DAYS, MAX_EXTENSIONS_PER_DEVICE, MAX_PAGES_PER_DAY, MIN_VISITS_PER_ACTIVE_DAY,
  POINTS_PER_ACTIVE_DAY, TOKENS_PER_POINT, WELCOME_BONUS, WELCOME_INSTALLMENT, WELCOME_MIN_ACTIVE_DAYS, DAY_MS, epochRange,
} from './policy.ts';
import { purgeExpiredVisits } from '../retention.ts';
import { purgeRateLimits } from '../ratelimit.ts';
import { readyEpochs, sendPayouts, settleEpoch, type PayoutRow } from './settle.ts';
import { claimOffer, computeOffer, type Offer } from './claims.ts';
import {
  challengeMessage, consumeChallenge, createChallenge, getChallenge, verifyWalletSignature,
  type LinkAction,
} from './link.ts';
import type { DeviceCheck, DeviceSignals } from '../fingerprint.ts';

export interface RewardsOptions {
  // Without a rewarder (e.g. in tests, or token not configured) payouts stay 'pending' and `rewards:settle` sends them.
  rewarder?: Pick<Rewarder, 'send'>;
  decimals?: number;
  symbol?: string;
  now?: () => number;
  // Protects /api/cron/daily: Vercel Cron sends "Authorization: Bearer <CRON_SECRET>".
  cronSecret?: string;
  // Device check (Fingerprint), required to link a wallet: one device, one wallet. Without it linking is
  // refused (fail closed).
  deviceCheck?: DeviceCheck;
  // Extension installs a device may link per 30 days (policy.ts); false disables the limit (local development).
  maxExtensionsPerDevice?: number | false;
}

type Device = { id: string; wallet_address: string | null };

export function createRewardsRouter(
  sql: Sql, { rewarder, decimals = 6, symbol = 'TRACE', now = Date.now, cronSecret, deviceCheck,
    maxExtensionsPerDevice = MAX_EXTENSIONS_PER_DEVICE }: RewardsOptions = {},
) {
  const router = Router();

  const getDevice = async (id: string) => (await sql<Device[]>`SELECT id, wallet_address FROM devices WHERE id = ${id}`)[0];
  // Only wallets linked through a device check are paid (wallets linked before it existed must link again).
  const isDeviceChecked = async (wallet: string | null) =>
    wallet !== null && (await sql`SELECT 1 FROM device_fingerprints WHERE wallet = ${wallet}`).length > 0;
  // Every change is also logged in wallet_links, so the full wallet ↔ device history survives a wallet swap.
  const setWallet = (id: string, action: LinkAction, wallet: string) => sql.begin(async (tx) => {
    await tx`UPDATE devices SET wallet_address = ${action === 'link' ? wallet : null} WHERE id = ${id}`;
    await tx`INSERT INTO wallet_links (device_id, wallet, action, created_at) VALUES (${id}, ${wallet}, ${action}, ${now()})`;
  });

  const welcomeRules = {
    installment: WELCOME_INSTALLMENT.toString(),
    total: WELCOME_BONUS.toString(),
    minActiveDays: WELCOME_MIN_ACTIVE_DAYS,
  };

  const tokens = (units: bigint) => formatUnits(units, decimals);

  const offerJson = (o: Offer) => ({
    points: o.points,
    amount: tokens(o.amount),
    visits: o.visits,
    pages: o.pages,
    days: o.days.length,
    activeDays: o.activeDays,
    firstDay: o.days.length ? o.days[0].day * DAY_MS : null,
    lastDay: o.days.length ? o.days[o.days.length - 1].day * DAY_MS : null,
    duplicateVisits: o.duplicateVisits,
    paidDays: o.paidDays,
    copied: o.copiedFrom !== null,
  });

  const payoutJson = (p: PayoutRow) => ({
    epoch: p.epoch,
    weekStartsAt: epochRange(p.epoch).startsAt,
    kind: p.kind,
    amount: tokens(BigInt(p.amount)),
    status: p.status,
    explorerUrl: p.signature ? explorerTxUrl(p.signature) : null,
  });

  // --- Wallet linking via signature (see link.ts) ---

  // The extension requests a code to link a wallet ('link') or unlink the current one ('unlink').
  // 'link' is also how a wallet linked before the device check existed passes it (same wallet).
  router.post('/api/devices/:id/link-challenge', async (req, res) => {
    const action: LinkAction = req.body?.action === 'unlink' ? 'unlink' : 'link';
    const device = await getDevice(req.params.id);
    if (!device) {
      res.status(404).json({ error: 'device not found' });
      return;
    }
    if (action === 'link' && device.wallet_address && (await isDeviceChecked(device.wallet_address))) {
      res.status(409).json({ error: 'a wallet is already linked: unlink it first' });
      return;
    }
    if (action === 'unlink' && !device.wallet_address) {
      res.status(409).json({ error: 'no wallet linked' });
      return;
    }
    const challenge = await createChallenge(sql, device.id, action, action === 'unlink' ? device.wallet_address : null, now());
    res.json({ code: challenge.code, action, expiresAt: challenge.expires_at, url: `/link.html?code=${challenge.code}` });
  });

  // Read by the /link page: what to sign.
  router.get('/api/link/:code', async (req, res) => {
    const challenge = await getChallenge(sql, req.params.code);
    if (!challenge) {
      res.status(404).json({ error: 'unknown code' });
      return;
    }
    const status = challenge.used_at ? 'used' : challenge.expires_at <= now() ? 'expired' : 'valid';
    const device = await getDevice(challenge.device_id);
    res.json({
      action: challenge.action,
      deviceId: challenge.device_id,
      wallet: challenge.wallet,
      // Linking a wallet that has not passed the device check yet: it must be the device's current wallet.
      currentWallet: challenge.action === 'link' ? device?.wallet_address ?? null : null,
      expiresAt: challenge.expires_at,
      status,
      // Fingerprint agent parameters for the device check (public key, not secret).
      deviceCheck: challenge.action === 'link' ? deviceCheck?.browser ?? null : null,
      message: challengeMessage(challenge),
    });
  });

  // The /link page posts the signature. If valid, links or unlinks. The welcome bonus is no longer sent here:
  // it is paid in weekly installments at settlement, to wallets that keep browsing.
  router.post('/api/link/:code', async (req, res) => {
    const challenge = await getChallenge(sql, req.params.code);
    if (!challenge) {
      res.status(404).json({ error: 'unknown code' });
      return;
    }
    const wallet = parseWalletAddress(req.body?.wallet);
    const signature = typeof req.body?.signature === 'string' ? Buffer.from(req.body.signature, 'base64') : null;
    if (!wallet || !signature) {
      res.status(400).json({ error: 'wallet and signature (base64) are required' });
      return;
    }
    if (challenge.action === 'unlink' && wallet.toBase58() !== challenge.wallet) {
      res.status(403).json({ error: `only the linked wallet ${challenge.wallet} can unlink it` });
      return;
    }
    if (!verifyWalletSignature(challengeMessage(challenge), signature, wallet)) {
      res.status(401).json({ error: 'invalid signature' });
      return;
    }
    if (challenge.used_at || challenge.expires_at <= now()) {
      res.status(410).json({ error: 'code already used or expired: start again from the extension' });
      return;
    }
    // Linking requires a device check: one device, one wallet. Checked before the code is consumed,
    // so the user can still fix things and retry.
    let device: { visitorId: string; signals: DeviceSignals } | null = null;
    if (challenge.action === 'link') {
      if (!deviceCheck) {
        res.status(503).json({ error: 'the device check is not configured on this server' });
        return;
      }
      const eventId = req.body?.deviceEventId;
      if (typeof eventId !== 'string' || eventId === '') {
        res.status(400).json({ error: 'device check missing: reload the page and try again' });
        return;
      }
      const verdict = await deviceCheck.check(eventId, now());
      if (!verdict.ok) {
        res.status(403).json({ error: verdict.error });
        return;
      }
      const fresh = await sql`INSERT INTO fingerprint_events (event_id, used_at) VALUES (${eventId}, ${now()}) ON CONFLICT DO NOTHING`;
      if (fresh.count === 0) {
        res.status(409).json({ error: 'device check already used: reload the page and try again' });
        return;
      }
      const conflict = await deviceConflict(sql, verdict.visitorId, wallet.toBase58());
      if (conflict) {
        // Logged: a device that keeps trying other wallets gets its own wallet's payouts reviewed (risk.ts).
        await sql`
          INSERT INTO device_link_rejections (visitor_id, wallet, created_at)
          VALUES (${verdict.visitorId}, ${wallet.toBase58()}, ${now()})
        `;
        res.status(409).json({ error: conflict });
        return;
      }
      // Reinstalling the extension starts a fresh history: a few installs per device per month.
      if (maxExtensionsPerDevice !== false) {
        const [installs] = await sql<{ n: number }[]>`
          SELECT COUNT(*)::int AS n FROM device_extensions
          WHERE visitor_id = ${verdict.visitorId} AND device_id <> ${challenge.device_id} AND linked_at >= ${now() - DEVICE_WINDOW_MS}
        `;
        if (installs.n >= maxExtensionsPerDevice) {
          res.status(429).json({ error: `this device already linked ${installs.n} extension installs in the last 30 days: try again later` });
          return;
        }
      }
      device = verdict;
    }
    if (!(await consumeChallenge(sql, challenge.code, now()))) {
      res.status(410).json({ error: 'code already used or expired: start again from the extension' });
      return;
    }

    const extension = await getDevice(challenge.device_id);
    if (!extension) {
      res.status(404).json({ error: 'device not found' });
      return;
    }

    if (challenge.action === 'unlink') {
      if (extension.wallet_address !== challenge.wallet) {
        res.status(409).json({ error: 'the linked wallet has changed in the meantime' });
        return;
      }
      await setWallet(extension.id, 'unlink', wallet.toBase58());
      res.json({ action: 'unlink', wallet: null, welcome: null });
      return;
    }

    if (extension.wallet_address && extension.wallet_address !== wallet.toBase58()) {
      res.status(409).json({ error: 'a wallet is already linked: unlink it first' });
      return;
    }
    // One device, one wallet: the primary key decides if two requests race (see bindDevice).
    const conflict = await bindDevice(sql, device!.visitorId, wallet.toBase58(), device!.signals, now());
    if (conflict) {
      res.status(409).json({ error: conflict });
      return;
    }
    await sql`
      INSERT INTO device_extensions (visitor_id, device_id, linked_at) VALUES (${device!.visitorId}, ${extension.id}, ${now()})
      ON CONFLICT DO NOTHING
    `;
    if (extension.wallet_address !== wallet.toBase58()) await setWallet(extension.id, 'link', wallet.toBase58());
    res.json({ action: 'link', wallet: wallet.toBase58(), deviceChecked: true, welcome: welcomeRules });
  });

  // The page where Phantom signs is public/link.html (Phantom does not work in extension pages).

  // What the shared data is worth right now: shown to the user before they claim it.
  router.get('/api/devices/:id/offer', async (req, res) => {
    const device = await getDevice(req.params.id);
    if (!device) {
      res.status(404).json({ error: 'device not found' });
      return;
    }
    const offer = await computeOffer(sql, device.id, device.wallet_address, now(), decimals);
    res.json({ symbol, wallet: device.wallet_address, deviceChecked: await isDeviceChecked(device.wallet_address), ...offerJson(offer) });
  });

  // The user confirms the offer: the days are recorded as paid and the payout is sent right away
  // (or held for review when the wallet's devices look risky).
  router.post('/api/devices/:id/claim', async (req, res) => {
    const device = await getDevice(req.params.id);
    if (!device) {
      res.status(404).json({ error: 'device not found' });
      return;
    }
    if (!device.wallet_address || !(await isDeviceChecked(device.wallet_address))) {
      res.status(403).json({ error: 'link your wallet first' });
      return;
    }
    const { offer, payout } = await claimOffer(sql, device.id, device.wallet_address, now(), decimals);
    if (!payout) {
      res.status(409).json({
        error: offer.copiedFrom ? 'this history copies another device: it cannot be rewarded' : 'nothing new to claim',
        offer: offerJson(offer),
      });
      return;
    }
    const final = payout.status === 'pending' && rewarder ? (await sendPayouts(sql, rewarder, { ids: [payout.id] }))[0] ?? payout : payout;
    res.json({ payout: payoutJson(final), points: payout.points, symbol });
  });

  router.get('/api/devices/:id/rewards', async (req, res) => {
    const device = await getDevice(req.params.id);
    if (!device) {
      res.status(404).json({ error: 'device not found' });
      return;
    }
    const payouts = await sql<PayoutRow[]>`SELECT * FROM reward_payouts WHERE device_id = ${device.id} ORDER BY id DESC`;
    const received = payouts.filter((p) => p.status === 'sent').reduce((a, p) => a + BigInt(p.amount), 0n);
    const offer = await computeOffer(sql, device.id, device.wallet_address, now(), decimals);

    res.json({
      symbol,
      wallet: device.wallet_address,
      // false for a wallet linked before the device check existed: it earns nothing until it links again.
      deviceChecked: await isDeviceChecked(device.wallet_address),
      totalReceived: tokens(received),
      offer: offerJson(offer),
      payouts: payouts.map(payoutJson),
      rules: {
        maxPagesPerDay: MAX_PAGES_PER_DAY,
        pointsPerActiveDay: POINTS_PER_ACTIVE_DAY,
        minVisitsPerActiveDay: MIN_VISITS_PER_ACTIVE_DAY,
        tokensPerPoint: TOKENS_PER_POINT.toString(),
        historyDays: HISTORY_DAYS,
        welcomeBonus: WELCOME_BONUS.toString(),
        welcomeInstallment: WELCOME_INSTALLMENT.toString(),
        welcomeMinActiveDays: WELCOME_MIN_ACTIVE_DAYS,
      },
    });
  });

  // Called daily by Vercel Cron: settles ready weeks, sends queued payouts and purges visits past retention.
  router.get('/api/cron/daily', async (req, res) => {
    if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const settled = [];
    for (const epoch of await readyEpochs(sql, now())) {
      const plan = await settleEpoch(sql, epoch, decimals, now());
      settled.push({ epoch, payouts: plan.payouts.length });
    }
    const sent = rewarder ? await sendPayouts(sql, rewarder) : [];
    const purgedVisits = await purgeExpiredVisits(sql, now());
    const purgedRateLimits = await purgeRateLimits(sql, now());
    res.json({ settled, sent: sent.map((p) => ({ id: p.id, kind: p.kind, status: p.status })), purgedVisits, purgedRateLimits });
  });

  return router;
}

// Why this device (Fingerprint visitor ID) cannot link this wallet, or null if it can:
// a device belongs to the first wallet linked from it; a wallet may use several devices.
async function deviceConflict(sql: Sql, visitorId: string, wallet: string): Promise<string | null> {
  const [row] = await sql<{ wallet: string }[]>`SELECT wallet FROM device_fingerprints WHERE visitor_id = ${visitorId}`;
  return row && row.wallet !== wallet
    ? `this device is already linked to wallet ${row.wallet}: one device can link one wallet only`
    : null;
}

// Stores the device ↔ wallet binding (refreshing the signals of a known device). The primary key on the
// visitor ID makes it atomic: if another wallet bound this device first, the conflict is reported.
async function bindDevice(sql: Sql, visitorId: string, wallet: string, signals: DeviceSignals, now: number): Promise<string | null> {
  await sql`
    INSERT INTO device_fingerprints (visitor_id, wallet, first_seen_at, last_seen_at, suspect_score, vpn, incognito, cluster_key)
    VALUES (${visitorId}, ${wallet}, ${now}, ${now}, ${signals.suspectScore}, ${signals.vpn}, ${signals.incognito}, ${signals.clusterKey})
    ON CONFLICT (visitor_id) DO UPDATE SET
      last_seen_at = EXCLUDED.last_seen_at, suspect_score = EXCLUDED.suspect_score,
      vpn = EXCLUDED.vpn, incognito = EXCLUDED.incognito, cluster_key = EXCLUDED.cluster_key
    WHERE device_fingerprints.wallet = EXCLUDED.wallet
  `;
  return deviceConflict(sql, visitorId, wallet);
}
