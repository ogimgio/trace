import { PublicKey, SendTransactionError } from '@solana/web3.js';
import type { Sql } from '../db.ts';
import type { Rewarder } from '../solana/rewards.ts';
import {
  MAX_TOKENS_PER_POINT, WELCOME_BONUS, WELCOME_MIN_ACTIVE_DAYS, MIN_VISITS_PER_ACTIVE_DAY,
  epochAt, epochBudget, epochRange, isSettleable, toUnits,
} from './policy.ts';
import { pageKey, scoreVisits, type ScoredVisit } from './points.ts';

// Tutte le garanzie contro i doppi pagamenti stanno nel database (vincoli unici e UPDATE condizionati),
// perché in produzione girano più istanze del server in parallelo.

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

export interface PayoutRow {
  id: number;
  epoch: number;
  device_id: string;
  wallet: string;
  kind: 'weekly' | 'welcome';
  points: number;
  amount: string; // unità base (numeric)
  status: 'pending' | 'sending' | 'sent' | 'failed';
  signature: string | null;
  error: string | null;
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

const visitsBetween = (sql: Sql, deviceId: string, from: number, to: number) => sql<ScoredVisit[]>`
  SELECT url, visit_time AS "visitTime" FROM visits
  WHERE device_id = ${deviceId} AND visit_time >= ${from} AND visit_time < ${to}
`;

// Calcola chi riceve cosa per un epoch, senza scrivere niente. Partecipano solo i device con un wallet.
export async function planEpoch(sql: Sql, epoch: number, decimals: number): Promise<EpochPlan> {
  const { startsAt, endsAt } = epochRange(epoch);
  const devices = await sql<{ id: string; wallet_address: string }[]>`
    SELECT id, wallet_address FROM devices WHERE wallet_address IS NOT NULL ORDER BY id
  `;

  const scored = [];
  for (const device of devices) {
    const score = scoreVisits(await visitsBetween(sql, device.id, startsAt, endsAt));
    if (score.points > 0) scored.push({ device, score });
  }

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
    if (!(await isWelcomeEligible(sql, d.id, d.wallet_address, endsAt))) continue;
    payouts.push({ deviceId: d.id, wallet: d.wallet_address, kind: 'welcome', points: 0, amount: toUnits(WELCOME_BONUS, decimals) });
  }

  return { epoch, budget, totalPoints: scored.reduce((a, s) => a + s.score.points, 0), payouts };
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

// Il bonus di benvenuto spetta una volta sola per device e per wallet (collegare lo stesso wallet a più
// device non lo moltiplica), a chi ha almeno WELCOME_MIN_ACTIVE_DAYS giorni attivi di storico.
export async function isWelcomeEligible(sql: Sql, deviceId: string, wallet: string, until: number): Promise<boolean> {
  const [already] = await sql`
    SELECT 1 FROM reward_payouts WHERE kind = 'welcome' AND (device_id = ${deviceId} OR wallet = ${wallet}) LIMIT 1
  `;
  if (already) return false;
  return activeDays(await visitsBetween(sql, deviceId, 0, until)) >= WELCOME_MIN_ACTIVE_DAYS;
}

// Al collegamento del wallet: se spetta, crea subito il pagamento del bonus di benvenuto ('pending').
// Restituisce la riga creata, oppure null se il bonus non spetta (o un'altra richiesta l'ha appena creato).
export async function grantWelcome(sql: Sql, deviceId: string, wallet: string, decimals: number, now = Date.now()): Promise<PayoutRow | null> {
  if (!(await isWelcomeEligible(sql, deviceId, wallet, now))) return null;
  const [row] = await sql<PayoutRow[]>`
    INSERT INTO reward_payouts (epoch, device_id, wallet, kind, points, amount, status, created_at)
    VALUES (${epochAt(now)}, ${deviceId}, ${wallet}, 'welcome', 0, ${toUnits(WELCOME_BONUS, decimals).toString()}, 'pending', ${now})
    ON CONFLICT DO NOTHING
    RETURNING *
  `;
  return row ?? null;
}

export async function isSettled(sql: Sql, epoch: number): Promise<boolean> {
  const [row] = await sql`SELECT 1 FROM reward_epochs WHERE epoch = ${epoch}`;
  return row !== undefined;
}

// Chiude un epoch: salva i pagamenti come 'pending'. Un epoch chiuso non viene mai ricalcolato,
// quindi le visite che arrivano dopo non contano più per quella settimana.
export async function settleEpoch(
  sql: Sql, epoch: number, decimals: number, now = Date.now(), { ignoreGrace = false } = {},
): Promise<EpochPlan> {
  if (!isSettleable(epoch, now, { ignoreGrace })) throw new Error(`epoch ${epoch} cannot be settled yet`);
  if (await isSettled(sql, epoch)) throw new Error(`epoch ${epoch} is already settled`);

  const plan = await planEpoch(sql, epoch, decimals);
  const weekly = plan.payouts.filter((p) => p.kind === 'weekly').reduce((a, p) => a + p.amount, 0n);

  await sql.begin(async (tx) => {
    // La chiave primaria su epoch impedisce che due chiusure in parallelo scrivano entrambe.
    const inserted = await tx`
      INSERT INTO reward_epochs (epoch, budget, total_points, distributed, settled_at)
      VALUES (${epoch}, ${plan.budget.toString()}, ${plan.totalPoints}, ${weekly.toString()}, ${now})
      ON CONFLICT DO NOTHING
    `;
    if (inserted.count === 0) throw new Error(`epoch ${epoch} is already settled`);
    for (const p of plan.payouts) {
      if (p.amount <= 0n) continue;
      await tx`
        INSERT INTO reward_payouts (epoch, device_id, wallet, kind, points, amount, status, created_at)
        VALUES (${epoch}, ${p.deviceId}, ${p.wallet}, ${p.kind}, ${p.points}, ${p.amount.toString()}, 'pending', ${now})
        ON CONFLICT DO NOTHING
      `;
    }
  });
  return plan;
}

// Invia on-chain i pagamenti in attesa. Prima di inviare, la riga passa a 'sending'.
// - Rifiutata in simulazione (SendTransactionError): non è arrivata on-chain, diventa 'failed' e si può ritentare.
// - Qualsiasi altro errore (es. timeout di conferma) o processo morto a metà: la transazione potrebbe essere
//   andata a buon fine, quindi la riga resta 'sending' e va controllata a mano, per non pagare due volte.
// Con `ids` invia solo quelle righe (es. il bonus appena creato). Ogni riga viene "presa" con un UPDATE
// condizionato, quindi due invii in parallelo non pagano mai due volte la stessa riga.
export async function sendPayouts(
  sql: Sql, rewarder: Pick<Rewarder, 'send'>, { retryFailed = false, ids }: { retryFailed?: boolean; ids?: number[] } = {},
): Promise<PayoutRow[]> {
  const statuses = retryFailed ? ['pending', 'failed'] : ['pending'];
  const candidates = await sql<{ id: number }[]>`
    SELECT id FROM reward_payouts
    WHERE status IN ${sql(statuses)} ${ids ? sql`AND id IN ${sql(ids.length ? ids : [-1])}` : sql``}
    ORDER BY id
  `;

  const rows: PayoutRow[] = [];
  for (const { id } of candidates) {
    const [row] = await sql<PayoutRow[]>`
      UPDATE reward_payouts SET status = 'sending', error = NULL
      WHERE id = ${id} AND status IN ${sql(statuses)}
      RETURNING *
    `;
    if (!row) continue; // già preso da un altro invio
    try {
      const { signature } = await rewarder.send(new PublicKey(row.wallet), BigInt(row.amount));
      await sql`UPDATE reward_payouts SET status = 'sent', signature = ${signature}, sent_at = ${Date.now()} WHERE id = ${id}`;
      rows.push({ ...row, status: 'sent', signature });
    } catch (err) {
      const error = (err as Error).message.slice(0, 500);
      const status = err instanceof SendTransactionError ? 'failed' : 'sending';
      await sql`UPDATE reward_payouts SET status = ${status}, error = ${error} WHERE id = ${id}`;
      rows.push({ ...row, status, error });
    }
  }
  return rows;
}

// Settimane finite (e oltre il margine) non ancora chiuse, dalla più vecchia.
export async function readyEpochs(sql: Sql, now: number, { ignoreGrace = false } = {}): Promise<number[]> {
  const settled = new Set((await sql<{ epoch: number }[]>`SELECT epoch FROM reward_epochs`).map((r) => r.epoch));
  const ready: number[] = [];
  for (let epoch = 0; epoch < epochAt(now); epoch++) {
    if (!settled.has(epoch) && isSettleable(epoch, now, { ignoreGrace })) ready.push(epoch);
  }
  return ready;
}
