import { Router } from 'express';
import type { Sql } from '../db.ts';
import { explorerTxUrl, formatUnits, parseWalletAddress, type Rewarder } from '../solana/rewards.ts';
import {
  LIVE_WINDOW_MS, MAX_PAGES, MAX_TOKENS_PER_POINT, MIN_VISITS_PER_ACTIVE_DAY, POINTS_PER_ACTIVE_DAY, WELCOME_BONUS,
  SETTLEMENT_GRACE_MS, WELCOME_INSTALLMENT, WELCOME_MIN_ACTIVE_DAYS, epochAt, epochBudget, epochRange,
} from './policy.ts';
import { purgeExpiredVisits } from '../retention.ts';
import { purgeRateLimits } from '../ratelimit.ts';
import { scoreVisits } from './points.ts';
import { countableVisits, readyEpochs, sendPayouts, settleEpoch, type PayoutRow } from './settle.ts';
import {
  challengeMessage, consumeChallenge, createChallenge, getChallenge, verifyWalletSignature,
  type LinkAction,
} from './link.ts';
import type { WorldId } from '../worldid.ts';

export interface RewardsOptions {
  // Without a rewarder (e.g. in tests, or token not configured) payouts stay 'pending' and `rewards:settle` sends them.
  rewarder?: Pick<Rewarder, 'send'>;
  decimals?: number;
  symbol?: string;
  now?: () => number;
  // Protects /api/cron/daily: Vercel Cron sends "Authorization: Bearer <CRON_SECRET>".
  cronSecret?: string;
  // World ID (Orb) verification, required to link a wallet. Without it linking is refused (fail closed).
  worldId?: WorldId;
}

type Device = { id: string; wallet_address: string | null };

export function createRewardsRouter(
  sql: Sql, { rewarder, decimals = 6, symbol = 'TRACE', now = Date.now, cronSecret, worldId }: RewardsOptions = {},
) {
  const router = Router();

  const getDevice = async (id: string) => (await sql<Device[]>`SELECT id, wallet_address FROM devices WHERE id = ${id}`)[0];
  const isVerified = async (wallet: string | null) =>
    wallet !== null && (await sql`SELECT 1 FROM worldid_verifications WHERE wallet = ${wallet}`).length > 0;
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
  // 'link' is also how a wallet linked before World ID was required gets verified (same wallet).
  router.post('/api/devices/:id/link-challenge', async (req, res) => {
    const action: LinkAction = req.body?.action === 'unlink' ? 'unlink' : 'link';
    const device = await getDevice(req.params.id);
    if (!device) {
      res.status(404).json({ error: 'device not found' });
      return;
    }
    if (action === 'link' && device.wallet_address && (await isVerified(device.wallet_address))) {
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
      // Linking a wallet that is not yet verified: the device's current wallet must be the one verified.
      currentWallet: challenge.action === 'link' ? device?.wallet_address ?? null : null,
      expiresAt: challenge.expires_at,
      status,
      worldIdVerified: challenge.worldid_nullifier !== null,
      message: challengeMessage(challenge),
    });
  });

  // --- World ID (see worldid.ts): required before a wallet can be linked ---

  // Signed request parameters for IDKit. The proof will commit to the link code (signal).
  router.post('/api/link/:code/worldid/start', async (req, res) => {
    const challenge = await getChallenge(sql, req.params.code);
    if (!challenge || challenge.action !== 'link' || challenge.used_at || challenge.expires_at <= now()) {
      res.status(410).json({ error: 'code already used or expired: start again from the extension' });
      return;
    }
    if (!worldId) {
      res.status(503).json({ error: 'World ID verification is not configured on this server' });
      return;
    }
    const request = worldId.start(challenge.code);
    await sql`UPDATE wallet_challenges SET worldid_nonce = ${request.rpContext.nonce} WHERE code = ${challenge.code}`;
    res.json(request);
  });

  // The IDKit result. If valid, the anonymous nullifier is attached to the link code until the wallet signs.
  router.post('/api/link/:code/worldid', async (req, res) => {
    const challenge = await getChallenge(sql, req.params.code);
    if (!challenge || challenge.action !== 'link' || challenge.used_at || challenge.expires_at <= now() || !challenge.worldid_nonce) {
      res.status(410).json({ error: 'code already used or expired: start again from the extension' });
      return;
    }
    if (!worldId) {
      res.status(503).json({ error: 'World ID verification is not configured on this server' });
      return;
    }
    const verdict = await worldId.verify(req.body, { signal: challenge.code, nonce: challenge.worldid_nonce });
    if (!verdict.ok) {
      res.status(400).json({ error: verdict.error });
      return;
    }
    await sql`UPDATE wallet_challenges SET worldid_nullifier = ${verdict.nullifier} WHERE code = ${challenge.code}`;
    // A human who already verified can only link that same wallet again: say which one before Phantom opens.
    const [bound] = await sql<{ wallet: string }[]>`
      SELECT wallet FROM worldid_verifications WHERE action = ${worldId.action} AND nullifier = ${verdict.nullifier}
    `;
    res.json({ verified: true, boundWallet: bound?.wallet ?? null });
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
    // Linking requires a unique human: checked before the code is consumed, so the user can still fix it.
    if (challenge.action === 'link') {
      if (!worldId) {
        res.status(503).json({ error: 'World ID verification is not configured on this server' });
        return;
      }
      if (challenge.worldid_nullifier === null) {
        res.status(403).json({ error: 'verify with World ID first' });
        return;
      }
      const conflict = await worldIdConflict(sql, worldId.action, challenge.worldid_nullifier, wallet.toBase58());
      if (conflict) {
        res.status(409).json({ error: conflict });
        return;
      }
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
      await setWallet(device.id, 'unlink', wallet.toBase58());
      res.json({ action: 'unlink', wallet: null, welcome: null });
      return;
    }

    if (device.wallet_address && device.wallet_address !== wallet.toBase58()) {
      res.status(409).json({ error: 'a wallet is already linked: unlink it first' });
      return;
    }
    // One human, one wallet: the unique constraints decide if two requests race (see bindWorldId).
    const conflict = await bindWorldId(sql, worldId!.action, challenge.worldid_nullifier!, wallet.toBase58(), now());
    if (conflict) {
      res.status(409).json({ error: conflict });
      return;
    }
    if (device.wallet_address !== wallet.toBase58()) await setWallet(device.id, 'link', wallet.toBase58());
    res.json({ action: 'link', wallet: wallet.toBase58(), verified: true, welcome: welcomeRules });
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
    const score = scoreVisits(await countableVisits(sql, device.id, startsAt, endsAt));
    const payouts = await sql<PayoutRow[]>`SELECT * FROM reward_payouts WHERE device_id = ${device.id} ORDER BY epoch DESC, id DESC`;
    const received = payouts.filter((p) => p.status === 'sent').reduce((a, p) => a + BigInt(p.amount), 0n);

    res.json({
      symbol,
      wallet: device.wallet_address,
      // Only wallets verified with World ID are paid.
      verified: await isVerified(device.wallet_address),
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
        welcomeInstallment: WELCOME_INSTALLMENT.toString(),
        welcomeMinActiveDays: WELCOME_MIN_ACTIVE_DAYS,
        liveWindowHours: LIVE_WINDOW_MS / 3_600_000,
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
    const purgedRateLimits = await purgeRateLimits(sql, now());
    res.json({ settled, sent: sent.map((p) => ({ id: p.id, kind: p.kind, status: p.status })), purgedVisits, purgedRateLimits });
  });

  return router;
}

// Why this human (nullifier) and this wallet cannot be bound together, or null if they can:
// each human has one wallet and each wallet one human, forever.
async function worldIdConflict(sql: Sql, action: string, nullifier: string, wallet: string): Promise<string | null> {
  const rows = await sql<{ nullifier: string; wallet: string }[]>`
    SELECT nullifier, wallet FROM worldid_verifications WHERE (action = ${action} AND nullifier = ${nullifier}) OR wallet = ${wallet}
  `;
  for (const row of rows) {
    if (row.nullifier === nullifier && row.wallet !== wallet) {
      return `this World ID is already linked to wallet ${row.wallet}: one person can link one wallet only`;
    }
    if (row.wallet === wallet && row.nullifier !== nullifier) return 'this wallet was verified by another person';
  }
  return null;
}

// Stores the binding. The primary key (action, nullifier) and UNIQUE (wallet) make it atomic:
// if a parallel request bound either side first, the insert does nothing and the conflict is reported.
async function bindWorldId(sql: Sql, action: string, nullifier: string, wallet: string, now: number): Promise<string | null> {
  await sql`
    INSERT INTO worldid_verifications (action, nullifier, wallet, verified_at)
    VALUES (${action}, ${nullifier}, ${wallet}, ${now})
    ON CONFLICT DO NOTHING
  `;
  return worldIdConflict(sql, action, nullifier, wallet);
}
