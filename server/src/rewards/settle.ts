import { PublicKey, SendTransactionError } from '@solana/web3.js';
import type { Sql } from '../db.ts';
import type { Rewarder } from '../solana/rewards.ts';
import {
  WELCOME_BONUS, WELCOME_INSTALLMENT, WELCOME_MIN_ACTIVE_DAYS, epochAt, epochRange, isSettleable, toUnits,
} from './policy.ts';
import { scoreVisits } from './points.ts';
import { checkVisits, type WeekVisit } from './eligibility.ts';
import { walletsUnderReview } from './risk.ts';

// Weekly settlement. Shared data is paid when the user claims it (claims.ts); what remains weekly is the
// welcome bonus, paid in installments to wallets that keep browsing.
//
// All guarantees against double payouts live in the database (unique constraints and conditional UPDATEs),
// because in production several server instances run in parallel.

export interface PlannedPayout {
  deviceId: string;
  wallet: string;
  kind: 'welcome';
  points: number;
  amount: bigint;
  holdReason: string | null; // set: created 'held', waiting for manual review instead of being sent
}

export interface EpochPlan {
  epoch: number;
  payouts: PlannedPayout[];
  exactDuplicates: Map<string, number>; // per device: visits dropped as copies of another device's
  nearDuplicateOf: Map<string, string>; // copy device → original: the copy earns nothing this week
}

export interface PayoutRow {
  id: number;
  epoch: number;
  device_id: string;
  wallet: string;
  kind: 'weekly' | 'welcome' | 'claim'; // 'weekly': paid by the old weekly budget, before claims existed
  points: number;
  amount: string; // base units (numeric)
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'held' | 'rejected';
  hold_reason: string | null;
  signature: string | null;
  error: string | null;
}

// All visits of the week, from every device: duplicates are found by comparing devices with each other.
const weekVisits = (sql: Sql, from: number, to: number) => sql<WeekVisit[]>`
  SELECT device_id AS "deviceId", url, visit_time AS "visitTime", received_at AS "receivedAt" FROM visits
  WHERE visit_time >= ${from} AND visit_time < ${to}
`;

// Computes the welcome installments of an epoch, without writing anything. Only wallets linked through a
// Fingerprint device check are paid, and only live, non-duplicated activity counts (eligibility.ts).
export async function planEpoch(sql: Sql, epoch: number, decimals: number, now = Date.now()): Promise<EpochPlan> {
  const { startsAt, endsAt } = epochRange(epoch);
  const devices = await sql<{ id: string; wallet_address: string | null; created_at: number; device_checked: boolean }[]>`
    SELECT d.id, d.wallet_address, d.created_at,
      EXISTS (SELECT 1 FROM device_fingerprints f WHERE f.wallet = d.wallet_address) AS device_checked
    FROM devices d ORDER BY d.id
  `;
  const check = checkVisits(await weekVisits(sql, startsAt, endsAt), new Map(devices.map((d) => [d.id, d.created_at])));

  const scored = [];
  for (const device of devices) {
    if (!device.wallet_address || !device.device_checked) continue;
    const score = scoreVisits(check.visits.get(device.id) ?? []);
    if (score.points > 0) scored.push({ device: { ...device, wallet_address: device.wallet_address }, score });
  }
  const payouts: PlannedPayout[] = [];

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
    payouts.push({ deviceId: device.id, wallet, kind: 'welcome', points: 0, amount: installment, holdReason: null });
  }

  // Risky devices: the wallet's payouts wait for manual review (see risk.ts).
  const review = await walletsUnderReview(sql, now);
  for (const p of payouts) p.holdReason = review.get(p.wallet) ?? null;

  return {
    epoch,
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

export async function isSettled(sql: Sql, epoch: number): Promise<boolean> {
  const [row] = await sql`SELECT 1 FROM reward_epochs WHERE epoch = ${epoch}`;
  return row !== undefined;
}

// Settles an epoch: stores its welcome installments ('pending', or 'held' for review). A settled epoch is
// never recomputed, so visits arriving later no longer count for that week.
export async function settleEpoch(
  sql: Sql, epoch: number, decimals: number, now = Date.now(), { ignoreGrace = false } = {},
): Promise<EpochPlan> {
  if (!isSettleable(epoch, now, { ignoreGrace })) throw new Error(`epoch ${epoch} cannot be settled yet`);
  if (await isSettled(sql, epoch)) throw new Error(`epoch ${epoch} is already settled`);

  const plan = await planEpoch(sql, epoch, decimals, now);
  const distributed = plan.payouts.reduce((a, p) => a + p.amount, 0n);

  await sql.begin(async (tx) => {
    // The primary key on epoch prevents two parallel settlements from both writing.
    const inserted = await tx`
      INSERT INTO reward_epochs (epoch, budget, total_points, distributed, settled_at)
      VALUES (${epoch}, 0, 0, ${distributed.toString()}, ${now})
      ON CONFLICT DO NOTHING
    `;
    if (inserted.count === 0) throw new Error(`epoch ${epoch} is already settled`);
    for (const p of plan.payouts) {
      if (p.amount <= 0n) continue;
      await tx`
        INSERT INTO reward_payouts (epoch, device_id, wallet, kind, points, amount, status, hold_reason, created_at)
        VALUES (${epoch}, ${p.deviceId}, ${p.wallet}, ${p.kind}, ${p.points}, ${p.amount.toString()},
          ${p.holdReason ? 'held' : 'pending'}, ${p.holdReason}, ${now})
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
