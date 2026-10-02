import { Router } from 'express';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { explorerTxUrl, formatUnits, parseWalletAddress, type Rewarder } from '../solana/rewards.ts';
import {
  MAX_PAGES, MAX_TOKENS_PER_POINT, MIN_VISITS_PER_ACTIVE_DAY, POINTS_PER_ACTIVE_DAY, WELCOME_BONUS,
  SETTLEMENT_GRACE_MS, WELCOME_MIN_ACTIVE_DAYS, epochAt, epochBudget, epochRange,
} from './policy.ts';
import { scoreVisits, type ScoredVisit } from './points.ts';
import { ensureRewardsSchema, grantWelcome, sendPayouts, type PayoutRow } from './settle.ts';
import {
  challengeMessage, consumeChallenge, createChallenge, ensureLinkSchema, getChallenge, verifyWalletSignature,
  type LinkAction,
} from './link.ts';

const LINK_PAGE = resolve(import.meta.dirname, 'link-page.html');
const LOGO = resolve(import.meta.dirname, '../../../brand/logo.svg');

export interface RewardsOptions {
  // Senza rewarder (es. nei test, o token non configurato) il bonus resta 'pending' e lo invia `rewards:settle`.
  rewarder?: Pick<Rewarder, 'send'>;
  decimals?: number;
  symbol?: string;
  now?: () => number;
}

export function createRewardsRouter(db: DatabaseSync, { rewarder, decimals = 6, symbol = 'TRACE', now = Date.now }: RewardsOptions = {}) {
  ensureRewardsSchema(db);
  ensureLinkSchema(db);
  const router = Router();

  const selectDevice = db.prepare('SELECT id, wallet_address FROM devices WHERE id = ?');
  const updateWallet = db.prepare('UPDATE devices SET wallet_address = ? WHERE id = ?');
  const selectVisits = db.prepare('SELECT url, visit_time AS visitTime FROM visits WHERE device_id = ? AND visit_time >= ? AND visit_time < ?');
  const selectPayouts = db.prepare('SELECT * FROM reward_payouts WHERE device_id = ? ORDER BY epoch DESC, id DESC');

  const tokens = (units: bigint) => formatUnits(units, decimals);

  const payoutJson = (p: PayoutRow) => ({
    epoch: p.epoch,
    weekStartsAt: epochRange(p.epoch).startsAt,
    kind: p.kind,
    amount: tokens(BigInt(p.amount)),
    status: p.status,
    explorerUrl: p.signature ? explorerTxUrl(p.signature) : null,
  });

  // --- Collegamento del wallet con firma (vedi link.ts) ---

  // L'estensione chiede un codice per collegare un wallet ('link') o scollegare quello attuale ('unlink').
  router.post('/api/devices/:id/link-challenge', (req, res) => {
    const action: LinkAction = req.body?.action === 'unlink' ? 'unlink' : 'link';
    const device = selectDevice.get(req.params.id) as { id: string; wallet_address: string | null } | undefined;
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
    const challenge = createChallenge(db, device.id, action, action === 'unlink' ? device.wallet_address : null, now());
    res.json({ code: challenge.code, action, expiresAt: challenge.expires_at, url: `/link?code=${challenge.code}` });
  });

  // Letta dalla pagina /link: cosa firmare.
  router.get('/api/link/:code', (req, res) => {
    const challenge = getChallenge(db, req.params.code);
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

  // La pagina /link manda la firma. Se è valida, collega (e la prima volta invia il bonus) o scollega.
  router.post('/api/link/:code', async (req, res) => {
    const challenge = getChallenge(db, req.params.code);
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
    if (!consumeChallenge(db, challenge.code, now())) {
      res.status(410).json({ error: 'code already used or expired: start again from the extension' });
      return;
    }

    const device = selectDevice.get(challenge.device_id) as { id: string; wallet_address: string | null } | undefined;
    if (!device) {
      res.status(404).json({ error: 'device not found' });
      return;
    }

    if (challenge.action === 'unlink') {
      if (device.wallet_address !== challenge.wallet) {
        res.status(409).json({ error: 'the linked wallet has changed in the meantime' });
        return;
      }
      updateWallet.run(null, device.id);
      res.json({ action: 'unlink', wallet: null, welcome: null });
      return;
    }

    if (device.wallet_address && device.wallet_address !== wallet.toBase58()) {
      res.status(409).json({ error: 'a wallet is already linked: unlink it first' });
      return;
    }
    updateWallet.run(wallet.toBase58(), device.id);
    let welcome = grantWelcome(db, device.id, wallet.toBase58(), decimals, now());
    if (welcome && rewarder) welcome = (await sendPayouts(db, rewarder, { ids: [welcome.id] }))[0] ?? welcome;
    res.json({ action: 'link', wallet: wallet.toBase58(), welcome: welcome ? payoutJson(welcome) : null });
  });

  // Pagina dove Phantom firma. Phantom non funziona nelle pagine dell'estensione, per questo la serve il server.
  router.get('/link', (_req, res) => res.sendFile(LINK_PAGE));
  router.get('/link/logo.svg', (_req, res) => res.sendFile(LOGO));

  router.get('/api/devices/:id/rewards', (req, res) => {
    const device = selectDevice.get(req.params.id) as { id: string; wallet_address: string | null } | undefined;
    if (!device) {
      res.status(404).json({ error: 'device not found' });
      return;
    }

    const epoch = epochAt(now());
    const { startsAt, endsAt } = epochRange(epoch);
    const score = scoreVisits(selectVisits.all(device.id, startsAt, endsAt) as unknown as ScoredVisit[]);
    const payouts = selectPayouts.all(device.id) as unknown as PayoutRow[];
    const received = payouts.filter((p) => p.status === 'sent').reduce((a, p) => a + BigInt(p.amount), 0n);

    res.json({
      symbol,
      wallet: device.wallet_address,
      totalReceived: tokens(received),
      // Stima della settimana in corso: i punti sono definitivi, l'importo dipende da quanti punti fanno gli altri.
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

  return router;
}
