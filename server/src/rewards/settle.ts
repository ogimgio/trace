import { PublicKey, SendTransactionError } from '@solana/web3.js';
import type { Sql } from '../db.ts';
import type { Rewarder } from '../solana/rewards.ts';
import {
  MAX_TOKENS_PER_POINT, WELCOME_BONUS, WELCOME_MIN_ACTIVE_DAYS, MIN_VISITS_PER_ACTIVE_DAY,
  epochAt, epochBudget, epochRange, isSettleable, toUnits,
} from './policy.ts';
import { pageKey, scoreVisits, type ScoredVisit } from './points.ts';

// All guarantees against double payouts live in the database (unique constraints and conditional UPDATEs),
// because in production several server instances run in parallel.

export interface PlannedPayout {
  deviceId: string;
  wallet: string;
  visitorId: string; // Fingerprint visitor ID of the device's browser
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
  amount: string; // base units (numeric)
  status: 'pending' | 'sending' | 'sent' | 'failed';
  signature: string | null;
  error: string | null;
}

// Splits the budget in proportion to points, with a per-point cap. Rounds down:
// the sum never exceeds the budget, leftover dust stays in the pool.
export function distribute(budget: bigint, points: number[], maxPerPoint: bigint): bigint[] {
  const total = BigInt(points.reduce((a, b) => a + b, 0));
  if (total === 0n) return points.map(() => 0n);
  return points.map((p) => {
    const share = (budget * BigInt(p)) / total;
    const cap = BigInt(p) * maxPerPoint;
    return share < cap ? share : cap;
  });
}

// The device's visits in [from, to) that count for rewards. Each visit is paid once: the same visit (URL and
// exact time) uploaded by several devices, e.g. after reinstalling the extension or by copying a history,
// counts only for the device that uploaded it first.
export const ownedVisits = (sql: Sql, deviceId: string, from: number, to: number) => sql<ScoredVisit[]>`
  SELECT v.url, v.visit_time AS "visitTime" FROM visits v
  WHERE v.device_id = ${deviceId} AND v.visit_time >= ${from} AND v.visit_time < ${to}
    AND NOT EXISTS (
      SELECT 1 FROM visits o
      WHERE o.visit_time = v.visit_time AND o.url = v.url AND o.device_id <> v.device_id
        AND (o.received_at, o.device_id) < (v.received_at, v.device_id)
    )
`;

// Computes who gets what for an epoch, without writing anything. Only devices with a wallet that passed the
// device check (Fingerprint) take part.
export async function planEpoch(sql: Sql, epoch: number, decimals: number): Promise<EpochPlan> {
  const { startsAt, endsAt } = epochRange(epoch);
  const devices = await sql<{ id: string; wallet_address: string; visitor_id: string }[]>`
    SELECT id, wallet_address, visitor_id FROM devices
    WHERE wallet_address IS NOT NULL AND visitor_id IS NOT NULL ORDER BY id
  `;

  const scored = [];
  for (const device of devices) {
    const score = scoreVisits(await ownedVisits(sql, device.id, startsAt, endsAt));
    if (score.points > 0) scored.push({ device, score });
  }

  const budget = epochBudget(epoch, decimals);
  const amounts = distribute(budget, scored.map((s) => s.score.points), toUnits(MAX_TOKENS_PER_POINT, decimals));
  const payouts: PlannedPayout[] = scored.map((s, i) => ({
    deviceId: s.device.id,
    wallet: s.device.wallet_address,
    visitorId: s.device.visitor_id,
    kind: 'weekly',
    points: s.score.points,
    amount: amounts[i],
  }));

  // Welcome bonus not yet granted when the wallet was linked (e.g. history arrived later): grant it now.
  for (const d of devices) {
    if (!(await isWelcomeEligible(sql, d.id, d.wallet_address, d.visitor_id, endsAt))) continue;
    payouts.push({
      deviceId: d.id, wallet: d.wallet_address, visitorId: d.visitor_id, kind: 'welcome', points: 0,
      amount: toUnits(WELCOME_BONUS, decimals),
    });
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

// The welcome bonus is granted once per device, per wallet and per browser (Fingerprint visitor ID): neither
// reinstalling the extension nor switching wallet earns it again. It needs WELCOME_MIN_ACTIVE_DAYS active days
// of history that no other device uploaded first.
export async function isWelcomeEligible(
  sql: Sql, deviceId: string, wallet: string, visitorId: string, until: number,
): Promise<boolean> {
  const [already] = await sql`
    SELECT 1 FROM reward_payouts
    WHERE kind = 'welcome' AND (device_id = ${deviceId} OR wallet = ${wallet} OR visitor_id = ${visitorId}) LIMIT 1
  `;
  if (already) return false;
  return activeDays(await ownedVisits(sql, deviceId, 0, until)) >= WELCOME_MIN_ACTIVE_DAYS;
}

// On wallet link: if eligible, immediately creates the welcome bonus payout ('pending').
// Returns the created row, or null if not eligible (or another request just created it).
export async function grantWelcome(
  sql: Sql, deviceId: string, wallet: string, visitorId: string, decimals: number, now = Date.now(),
): Promise<PayoutRow | null> {
  if (!(await isWelcomeEligible(sql, deviceId, wallet, visitorId, now))) return null;
  const [row] = await sql<PayoutRow[]>`
    INSERT INTO reward_payouts (epoch, device_id, wallet, visitor_id, kind, points, amount, status, created_at)
    VALUES (${epochAt(now)}, ${deviceId}, ${wallet}, ${visitorId}, 'welcome', 0, ${toUnits(WELCOME_BONUS, decimals).toString()}, 'pending', ${now})
    ON CONFLICT DO NOTHING
    RETURNING *
  `;
  return row ?? null;
}

export async function isSettled(sql: Sql, epoch: number): Promise<boolean> {
  const [row] = await sql`SELECT 1 FROM reward_epochs WHERE epoch = ${epoch}`;
  return row !== undefined;
}

// Settles an epoch: stores payouts as 'pending'. A settled epoch is never recomputed,
// so visits arriving later no longer count for that week.
export async function settleEpoch(
  sql: Sql, epoch: number, decimals: number, now = Date.now(), { ignoreGrace = false } = {},
): Promise<EpochPlan> {
  if (!isSettleable(epoch, now, { ignoreGrace })) throw new Error(`epoch ${epoch} cannot be settled yet`);
  if (await isSettled(sql, epoch)) throw new Error(`epoch ${epoch} is already settled`);

  const plan = await planEpoch(sql, epoch, decimals);
  const weekly = plan.payouts.filter((p) => p.kind === 'weekly').reduce((a, p) => a + p.amount, 0n);

  await sql.begin(async (tx) => {
    // The primary key on epoch prevents two parallel settlements from both writing.
    const inserted = await tx`
      INSERT INTO reward_epochs (epoch, budget, total_points, distributed, settled_at)
      VALUES (${epoch}, ${plan.budget.toString()}, ${plan.totalPoints}, ${weekly.toString()}, ${now})
      ON CONFLICT DO NOTHING
    `;
    if (inserted.count === 0) throw new Error(`epoch ${epoch} is already settled`);
    for (const p of plan.payouts) {
      if (p.amount <= 0n) continue;
      await tx`
        INSERT INTO reward_payouts (epoch, device_id, wallet, visitor_id, kind, points, amount, status, created_at)
        VALUES (${epoch}, ${p.deviceId}, ${p.wallet}, ${p.visitorId}, ${p.kind}, ${p.points}, ${p.amount.toString()}, 'pending', ${now})
        ON CONFLICT DO NOTHING
      `;
    }
  });
  return plan;
}

// Sends pending payouts on-chain. Before sending, the row moves to 'sending'.
// - Rejected in simulation (SendTransactionError): it never reached the chain, becomes 'failed' and can be retried.
// - Any other error (e.g. confirmation timeout) or a process dying midway: the transaction may have
//   succeeded, so the row stays 'sending' and must be checked by hand, to avoid paying twice.
// With `ids` only those rows are sent (e.g. the bonus just created). Each row is "claimed" with a conditional
// UPDATE, so two parallel runs never pay the same row twice.
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
    if (!row) continue; // already claimed by another run
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

// Finished weeks (past the grace period) not yet settled, oldest first.
export async function readyEpochs(sql: Sql, now: number, { ignoreGrace = false } = {}): Promise<number[]> {
  const settled = new Set((await sql<{ epoch: number }[]>`SELECT epoch FROM reward_epochs`).map((r) => r.epoch));
  const ready: number[] = [];
  for (let epoch = 0; epoch < epochAt(now); epoch++) {
    if (!settled.has(epoch) && isSettleable(epoch, now, { ignoreGrace })) ready.push(epoch);
  }
  return ready;
}
