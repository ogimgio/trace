import { Router } from 'express';
import type { Sql } from '../db.ts';
import { explorerTxUrl, formatUnits, parseWalletAddress, type Rewarder } from '../solana/rewards.ts';
import {
  MAX_PAGES, MAX_TOKENS_PER_POINT, MIN_VISITS_PER_ACTIVE_DAY, POINTS_PER_ACTIVE_DAY, WELCOME_BONUS,
  SETTLEMENT_GRACE_MS, WELCOME_MIN_ACTIVE_DAYS, epochAt, epochBudget, epochRange,
} from './policy.ts';
import { purgeExpiredVisits } from '../retention.ts';
import { scoreVisits, type ScoredVisit } from './points.ts';
import { grantWelcome, readyEpochs, sendPayouts, settleEpoch, type PayoutRow } from './settle.ts';
import {
  challengeMessage, consumeChallenge, createChallenge, getChallenge, verifyWalletSignature,
  type LinkAction,
} from './link.ts';

export interface RewardsOptions {
  // Without a rewarder (e.g. in tests, or token not configured) the bonus stays 'pending' and `rewards:settle` sends it.
  rewarder?: Pick<Rewarder, 'send'>;
  decimals?: number;
  symbol?: string;
  now?: () => number;
  // Protects /api/cron/daily: Vercel Cron sends "Authorization: Bearer <CRON_SECRET>".
  cronSecret?: string;
}

type Device = { id: string; wallet_address: string | null };

export function createRewardsRouter(
  sql: Sql, { rewarder, decimals = 6, symbol = 'TRACE', now = Date.now, cronSecret }: RewardsOptions = {},
) {
  const router = Router();

  const getDevice = async (id: string) => (await sql<Device[]>`SELECT id, wallet_address FROM devices WHERE id = ${id}`)[0];
  const setWallet = (id: string, wallet: string | null) => sql`UPDATE devices SET wallet_address = ${wallet} WHERE id = ${id}`;

  const tokens = (units: bigint) => formatUnits(units, decimals);

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
  router.post('/api/devices/:id/link-challenge', async (req, res) => {
    const action: LinkAction = req.body?.action === 'unlink' ? 'unlink' : 'link';
    const device = await getDevice(req.params.id);
    if (!device) {
      res.status(404).json({ error: 'device not found' });
      return;
    }
    if (action === 'link' && device.wallet_address) {
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
    res.json({
      action: challenge.action,
      deviceId: challenge.device_id,
      wallet: challenge.wallet,
      expiresAt: challenge.expires_at,
      status,
      message: challengeMessage(challenge),
    });
  });

  // The /link page posts the signature. If valid, links (sending the bonus the first time) or unlinks.
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
    if (!(await consumeChallenge(sql, challenge.code, now()))) {
      res.status(410).json({ error: 'code already used or expired: start again from the extension' });
      return;
    }

    const device = await getDevice(challenge.device_id);
    if (!device) {
      res.status(404).json({ error: 'device not found' });
      return;
    }

    if (challenge.action === 'unlink') {
      if (device.wallet_address !== challenge.wallet) {
        res.status(409).json({ error: 'the linked wallet has changed in the meantime' });
        return;
      }
      await setWallet(device.id, null);
      res.json({ action: 'unlink', wallet: null, welcome: null });
      return;
    }

    if (device.wallet_address && device.wallet_address !== wallet.toBase58()) {
      res.status(409).json({ error: 'a wallet is already linked: unlink it first' });
      return;
    }
    await setWallet(device.id, wallet.toBase58());
    let welcome = await grantWelcome(sql, device.id, wallet.toBase58(), decimals, now());
    if (welcome && rewarder) welcome = (await sendPayouts(sql, rewarder, { ids: [welcome.id] }))[0] ?? welcome;
    res.json({ action: 'link', wallet: wallet.toBase58(), welcome: welcome ? payoutJson(welcome) : null });
  });

  // The page where Phantom signs is public/link.html (Phantom does not work in extension pages).

  router.get('/api/devices/:id/rewards', async (req, res) => {
    const device = await getDevice(req.params.id);
    if (!device) {
      res.status(404).json({ error: 'device not found' });
      return;
    }

    const epoch = epochAt(now());
    const { startsAt, endsAt } = epochRange(epoch);
    const score = scoreVisits(await sql<ScoredVisit[]>`
      SELECT url, visit_time AS "visitTime" FROM visits
      WHERE device_id = ${device.id} AND visit_time >= ${startsAt} AND visit_time < ${endsAt}
    `);
    const payouts = await sql<PayoutRow[]>`SELECT * FROM reward_payouts WHERE device_id = ${device.id} ORDER BY epoch DESC, id DESC`;
    const received = payouts.filter((p) => p.status === 'sent').reduce((a, p) => a + BigInt(p.amount), 0n);

    res.json({
      symbol,
      wallet: device.wallet_address,
      totalReceived: tokens(received),
      // Current week estimate: points are final, the amount depends on how many points others earn.
      currentWeek: {
        epoch,
        startsAt,
        endsAt,
        payableFrom: endsAt + SETTLEMENT_GRACE_MS,
        ...score,
        maxReward: tokens(BigInt(score.points) * MAX_TOKENS_PER_POINT * 10n ** BigInt(decimals)),
        weeklyBudget: tokens(epochBudget(epoch, decimals)),
      },
      payouts: payouts.map(payoutJson),
      rules: {
        maxPages: MAX_PAGES,
        pointsPerActiveDay: POINTS_PER_ACTIVE_DAY,
        minVisitsPerActiveDay: MIN_VISITS_PER_ACTIVE_DAY,
        maxTokensPerPoint: MAX_TOKENS_PER_POINT.toString(),
        welcomeBonus: WELCOME_BONUS.toString(),
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
      settled.push({ epoch, payouts: plan.payouts.length, totalPoints: plan.totalPoints });
    }
    const sent = rewarder ? await sendPayouts(sql, rewarder) : [];
    const purgedVisits = await purgeExpiredVisits(sql, now());
    res.json({ settled, sent: sent.map((p) => ({ id: p.id, kind: p.kind, status: p.status })), purgedVisits });
  });

  return router;
}
