import { PublicKey, SendTransactionError } from '@solana/web3.js';
import type { Sql } from '../db.ts';
import type { Rewarder } from '../solana/rewards.ts';
import {
  CLOCK_SKEW_MS, LIVE_WINDOW_MS, MAX_TOKENS_PER_POINT, WELCOME_BONUS, WELCOME_INSTALLMENT, WELCOME_MIN_ACTIVE_DAYS,
  epochAt, epochBudget, epochRange, isSettleable, toUnits,
} from './policy.ts';
import { scoreVisits, type ScoredVisit } from './points.ts';
import { checkVisits, type WeekVisit } from './eligibility.ts';

// All guarantees against double payouts live in the database (unique constraints and conditional UPDATEs),
// because in production several server instances run in parallel.

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
  exactDuplicates: Map<string, number>; // per device: visits dropped as copies of another device's
  nearDuplicateOf: Map<string, string>; // copy device → original: the copy earns nothing this week
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

// All visits of the week, from every device: duplicates are found by comparing devices with each other.
const weekVisits = (sql: Sql, from: number, to: number) => sql<WeekVisit[]>`
  SELECT device_id AS "deviceId", url, visit_time AS "visitTime", received_at AS "receivedAt" FROM visits
  WHERE visit_time >= ${from} AND visit_time < ${to}
`;

// Computes who gets what for an epoch, without writing anything. Only devices whose wallet is verified with
// World ID are paid, but every device takes part in the duplicate check.
export async function planEpoch(sql: Sql, epoch: number, decimals: number): Promise<EpochPlan> {
  const { startsAt, endsAt } = epochRange(epoch);
  const devices = await sql<{ id: string; wallet_address: string | null; created_at: number; verified: boolean }[]>`
    SELECT d.id, d.wallet_address, d.created_at, EXISTS (SELECT 1 FROM worldid_verifications w WHERE w.wallet = d.wallet_address) AS verified
    FROM devices d ORDER BY d.id
  `;
  const check = checkVisits(await weekVisits(sql, startsAt, endsAt), new Map(devices.map((d) => [d.id, d.created_at])));

  const scored = [];
  for (const device of devices) {
    if (!device.wallet_address || !device.verified) continue;
    const score = scoreVisits(check.visits.get(device.id) ?? []);
    if (score.points > 0) scored.push({ device: { ...device, wallet_address: device.wallet_address }, score });
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

  // Welcome bonus installments: active this week, and the device and the wallet are both still under the total.
  const installment = toUnits(WELCOME_INSTALLMENT, decimals);
  const total = toUnits(WELCOME_BONUS, decimals);
  const paid = await welcomePaid(sql);
  const walletsThisWeek = new Set<string>();
  for (const { device, score } of scored) {
    const wallet = device.wallet_address;
    if (score.activeDays < WELCOME_MIN_ACTIVE_DAYS || walletsThisWeek.has(wallet)) continue;
    if ((paid.byDevice.get(device.id) ?? 0n) + installment > total) continue;
    if ((paid.byWallet.get(wallet) ?? 0n) + installment > total) continue;
    walletsThisWeek.add(wallet);
    payouts.push({ deviceId: device.id, wallet, kind: 'welcome', points: 0, amount: installment });
  }

  return {
    epoch,
    budget,
    totalPoints: scored.reduce((a, s) => a + s.score.points, 0),
    payouts,
    exactDuplicates: check.exactDuplicates,
    nearDuplicateOf: check.nearDuplicateOf,
  };
}

// Welcome bonus already granted, per device and per wallet (including payouts not yet sent).
async function welcomePaid(sql: Sql) {
  const rows = await sql<{ device_id: string; wallet: string; amount: string }[]>`
    SELECT device_id, wallet, amount FROM reward_payouts WHERE kind = 'welcome'
  `;
  const byDevice = new Map<string, bigint>();
  const byWallet = new Map<string, bigint>();
  for (const r of rows) {
    byDevice.set(r.device_id, (byDevice.get(r.device_id) ?? 0n) + BigInt(r.amount));
    byWallet.set(r.wallet, (byWallet.get(r.wallet) ?? 0n) + BigInt(r.amount));
  }
  return { byDevice, byWallet };
}

// Visits of one device that would count right now: the estimate shown in the extension. It applies the live
// window and drops exact copies of another device's visits; near duplicates are only detected at settlement.
export function countableVisits(sql: Sql, deviceId: string, from: number, to: number) {
  return sql<ScoredVisit[]>`
    SELECT v.url, v.visit_time AS "visitTime" FROM visits v
    WHERE v.device_id = ${deviceId} AND v.visit_time >= ${from} AND v.visit_time < ${to}
      AND v.received_at - v.visit_time <= ${LIVE_WINDOW_MS} AND v.visit_time - v.received_at <= ${CLOCK_SKEW_MS}
      AND NOT EXISTS (
        SELECT 1 FROM visits o
        WHERE o.visit_time = v.visit_time AND o.url = v.url AND o.device_id <> v.device_id
          AND o.received_at - o.visit_time <= ${LIVE_WINDOW_MS} AND o.visit_time - o.received_at <= ${CLOCK_SKEW_MS}
          AND (o.received_at < v.received_at OR (o.received_at = v.received_at AND o.device_id < v.device_id))
      )
  `;
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
        INSERT INTO reward_payouts (epoch, device_id, wallet, kind, points, amount, status, created_at)
        VALUES (${epoch}, ${p.deviceId}, ${p.wallet}, ${p.kind}, ${p.points}, ${p.amount.toString()}, 'pending', ${now})
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
