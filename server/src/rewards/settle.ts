import type { DatabaseSync } from 'node:sqlite';
import { PublicKey, SendTransactionError } from '@solana/web3.js';
import type { Rewarder } from '../solana/rewards.ts';
import {
  MAX_TOKENS_PER_POINT, WELCOME_BONUS, WELCOME_MIN_ACTIVE_DAYS, MIN_VISITS_PER_ACTIVE_DAY,
  epochAt, epochBudget, epochRange, isSettleable, toUnits,
} from './policy.ts';
import { pageKey, scoreVisits, type ScoredVisit } from './points.ts';

// I pagamenti restano nel DB anche se l'utente cancella i propri dati: sono il registro di cosa è stato inviato.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS reward_epochs (
    epoch         INTEGER PRIMARY KEY,
    budget        TEXT NOT NULL,
    total_points  INTEGER NOT NULL,
    distributed   TEXT NOT NULL,
    settled_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reward_payouts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    epoch       INTEGER NOT NULL,
    device_id   TEXT NOT NULL,
    wallet      TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('weekly', 'welcome')),
    points      INTEGER NOT NULL,
    amount      TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
    signature   TEXT,
    error       TEXT,
    created_at  INTEGER NOT NULL,
    sent_at     INTEGER,
    UNIQUE (epoch, device_id, kind)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS reward_payouts_one_welcome ON reward_payouts (device_id) WHERE kind = 'welcome';
  CREATE INDEX IF NOT EXISTS reward_payouts_device ON reward_payouts (device_id, epoch);
`;

export function ensureRewardsSchema(db: DatabaseSync) {
  db.exec(SCHEMA);
}

export interface PlannedPayout {
  deviceId: string;
  wallet: string;
  kind: 'weekly' | 'welcome';
  points: number;
  amount: bigint;
}

export interface EpochPlan {
  epoch: number;
  budget: bigint;
  totalPoints: number;
  payouts: PlannedPayout[];
}

// Divide il budget in proporzione ai punti, con un tetto per punto. Arrotonda per difetto:
// la somma non supera mai il budget, gli spiccioli restano nel fondo.
export function distribute(budget: bigint, points: number[], maxPerPoint: bigint): bigint[] {
  const total = BigInt(points.reduce((a, b) => a + b, 0));
  if (total === 0n) return points.map(() => 0n);
  return points.map((p) => {
    const share = (budget * BigInt(p)) / total;
    const cap = BigInt(p) * maxPerPoint;
    return share < cap ? share : cap;
  });
}

// Calcola chi riceve cosa per un epoch, senza scrivere niente. Partecipano solo i device con un wallet.
export function planEpoch(db: DatabaseSync, epoch: number, decimals: number): EpochPlan {
  const { startsAt, endsAt } = epochRange(epoch);

  const devices = db.prepare('SELECT id, wallet_address FROM devices WHERE wallet_address IS NOT NULL').all() as
    { id: string; wallet_address: string }[];
  const visitsOf = db.prepare('SELECT url, visit_time AS visitTime FROM visits WHERE device_id = ? AND visit_time >= ? AND visit_time < ?');

  const scored = devices
    .map((d) => ({ device: d, score: scoreVisits(visitsOf.all(d.id, startsAt, endsAt) as unknown as ScoredVisit[]) }))
    .filter((s) => s.score.points > 0);

  const budget = epochBudget(epoch, decimals);
  const amounts = distribute(budget, scored.map((s) => s.score.points), toUnits(MAX_TOKENS_PER_POINT, decimals));
  const payouts: PlannedPayout[] = scored.map((s, i) => ({
    deviceId: s.device.id,
    wallet: s.device.wallet_address,
    kind: 'weekly',
    points: s.score.points,
    amount: amounts[i],
  }));

  // Bonus di benvenuto non ancora dato al collegamento del wallet (es. storico arrivato dopo): lo diamo ora.
  for (const d of devices) {
    if (!isWelcomeEligible(db, d.id, d.wallet_address, endsAt)) continue;
    payouts.push({ deviceId: d.id, wallet: d.wallet_address, kind: 'welcome', points: 0, amount: toUnits(WELCOME_BONUS, decimals) });
  }

  return { epoch, budget, totalPoints: scored.reduce((a, s) => a + s.score.points, 0), payouts };
}

// Il bonus di benvenuto spetta una volta sola per device e per wallet (collegare lo stesso wallet a più
// device non lo moltiplica), a chi ha almeno WELCOME_MIN_ACTIVE_DAYS giorni attivi di storico.
export function isWelcomeEligible(db: DatabaseSync, deviceId: string, wallet: string, until: number): boolean {
  const already = db.prepare("SELECT 1 FROM reward_payouts WHERE kind = 'welcome' AND (device_id = ? OR wallet = ?)").get(deviceId, wallet);
  if (already) return false;
  const history = db.prepare('SELECT url, visit_time AS visitTime FROM visits WHERE device_id = ? AND visit_time < ?')
    .all(deviceId, until) as unknown as ScoredVisit[];
  return activeDays(history) >= WELCOME_MIN_ACTIVE_DAYS;
}

// Al collegamento del wallet: se spetta, crea subito il pagamento del bonus di benvenuto ('pending').
// Restituisce la riga creata, oppure null se il bonus non spetta.
export function grantWelcome(db: DatabaseSync, deviceId: string, wallet: string, decimals: number, now = Date.now()): PayoutRow | null {
  if (!isWelcomeEligible(db, deviceId, wallet, now)) return null;
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO reward_payouts (epoch, device_id, wallet, kind, points, amount, status, created_at)
    VALUES (?, ?, ?, 'welcome', 0, ?, 'pending', ?)
  `).run(epochAt(now), deviceId, wallet, toUnits(WELCOME_BONUS, decimals).toString(), now);
  return db.prepare('SELECT * FROM reward_payouts WHERE id = ?').get(lastInsertRowid) as unknown as PayoutRow;
}

function activeDays(visits: ScoredVisit[]): number {
  const perDay = new Map<number, number>();
  for (const v of visits) {
    if (pageKey(v.url) === null) continue;
    const day = Math.floor(v.visitTime / 86_400_000);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  return [...perDay.values()].filter((n) => n >= MIN_VISITS_PER_ACTIVE_DAY).length;
}

export function isSettled(db: DatabaseSync, epoch: number): boolean {
  return db.prepare('SELECT 1 FROM reward_epochs WHERE epoch = ?').get(epoch) !== undefined;
}

// Chiude un epoch: salva i pagamenti come 'pending'. Un epoch chiuso non viene mai ricalcolato,
// quindi le visite che arrivano dopo non contano più per quella settimana.
export function settleEpoch(
  db: DatabaseSync, epoch: number, decimals: number, now = Date.now(), { ignoreGrace = false } = {},
): EpochPlan {
  if (!isSettleable(epoch, now, { ignoreGrace })) throw new Error(`epoch ${epoch} cannot be settled yet`);
  if (isSettled(db, epoch)) throw new Error(`epoch ${epoch} is already settled`);

  const plan = planEpoch(db, epoch, decimals);
  const insertPayout = db.prepare(`
    INSERT INTO reward_payouts (epoch, device_id, wallet, kind, points, amount, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `);
  db.exec('BEGIN');
  try {
    const weekly = plan.payouts.filter((p) => p.kind === 'weekly').reduce((a, p) => a + p.amount, 0n);
    db.prepare('INSERT INTO reward_epochs (epoch, budget, total_points, distributed, settled_at) VALUES (?, ?, ?, ?, ?)')
      .run(epoch, plan.budget.toString(), plan.totalPoints, weekly.toString(), now);
    for (const p of plan.payouts) {
      if (p.amount > 0n) insertPayout.run(epoch, p.deviceId, p.wallet, p.kind, p.points, p.amount.toString(), now);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return plan;
}

export interface PayoutRow {
  id: number;
  epoch: number;
  device_id: string;
  wallet: string;
  kind: string;
  amount: string;
  status: string;
  signature: string | null;
  error: string | null;
}

// Invia on-chain i pagamenti in attesa. Prima di inviare, la riga passa a 'sending'.
// - Rifiutata in simulazione (SendTransactionError): non è arrivata on-chain, diventa 'failed' e si può ritentare.
// - Qualsiasi altro errore (es. timeout di conferma) o processo morto a metà: la transazione potrebbe essere
//   andata a buon fine, quindi la riga resta 'sending' e va controllata a mano, per non pagare due volte.
// Con `ids` invia solo quelle righe (es. il bonus appena creato). Ogni riga viene "presa" con un UPDATE
// condizionato, quindi due invii in parallelo (CLI e server) non pagano mai due volte la stessa riga.
export async function sendPayouts(
  db: DatabaseSync, rewarder: Pick<Rewarder, 'send'>, { retryFailed = false, ids }: { retryFailed?: boolean; ids?: number[] } = {},
): Promise<PayoutRow[]> {
  const statuses = retryFailed ? "('pending', 'failed')" : "('pending')";
  const candidates = (db.prepare(`SELECT * FROM reward_payouts WHERE status IN ${statuses} ORDER BY id`).all() as unknown as PayoutRow[])
    .filter((row) => !ids || ids.includes(row.id));
  const claim = db.prepare(`UPDATE reward_payouts SET status = 'sending', error = NULL WHERE id = ? AND status IN ${statuses}`);
  const mark = db.prepare('UPDATE reward_payouts SET status = ?, signature = ?, error = ?, sent_at = ? WHERE id = ?');

  const rows: PayoutRow[] = [];
  for (const row of candidates) {
    if (Number(claim.run(row.id).changes) !== 1) continue; // già preso da un altro invio
    rows.push(row);
    try {
      const { signature } = await rewarder.send(new PublicKey(row.wallet), BigInt(row.amount));
      mark.run('sent', signature, null, Date.now(), row.id);
      Object.assign(row, { status: 'sent', signature });
    } catch (err) {
      const error = (err as Error).message.slice(0, 500);
      const status = err instanceof SendTransactionError ? 'failed' : 'sending';
      mark.run(status, null, error, null, row.id);
      Object.assign(row, { status, error });
    }
  }
  return rows;
}
