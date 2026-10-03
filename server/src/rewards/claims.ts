import type { Sql } from '../db.ts';
import { DAY_MS, HISTORY_DAYS, TOKENS_PER_POINT, dayAt, epochAt, toUnits } from './policy.ts';
import { scoreDays, type DayScore } from './points.ts';
import { checkVisits, type WeekVisit } from './eligibility.ts';
import { walletsUnderReview } from './risk.ts';
import type { PayoutRow } from './settle.ts';

// Shared-data rewards. The extension shows an offer (what the user's shared history and new days are worth)
// and the user confirms it to get paid:
// - every finished UTC day of the last HISTORY_DAYS earns points (see scoreDays in points.ts);
// - a day is paid once per wallet, whichever device or install uploaded it: re-uploading earns nothing;
// - visits another device uploaded first don't count, and a device whose history mostly copies another
//   wallet's device is offered nothing (same duplicate rules as eligibility.ts, applied to history too).

export interface Offer {
  days: DayScore[]; // the days that would be paid now, oldest first
  visits: number;
  pages: number;
  activeDays: number;
  points: number;
  amount: bigint; // base units
  duplicateVisits: number; // visits uploaded first by another device: not counted
  paidDays: number; // days this wallet was already paid for: not counted
  copiedFrom: string | null; // set: this device copies another wallet's history, nothing is offered
}

const empty = (paidDays = 0, duplicateVisits = 0, copiedFrom: string | null = null): Offer => ({
  days: [], visits: 0, pages: 0, activeDays: 0, points: 0, amount: 0n, duplicateVisits, paidDays, copiedFrom,
});

// This device's visits in the window, plus other devices' visits in the same minutes: enough to find
// exact copies and devices that copy this one (or that this one copies).
function visitsAround(sql: Sql, deviceId: string, from: number, to: number) {
  return sql<WeekVisit[]>`
    SELECT device_id AS "deviceId", url, visit_time AS "visitTime", received_at AS "receivedAt" FROM visits
    WHERE visit_time >= ${from} AND visit_time < ${to}
      AND (device_id = ${deviceId} OR visit_time / 60000 IN (
        SELECT DISTINCT visit_time / 60000 FROM visits WHERE device_id = ${deviceId} AND visit_time >= ${from} AND visit_time < ${to}
      ))
  `;
}

// What the device's shared data is worth right now. `wallet` null: a preview before a wallet is linked.
export async function computeOffer(sql: Sql, deviceId: string, wallet: string | null, now: number, decimals: number): Promise<Offer> {
  const today = dayAt(now);
  const from = (today - HISTORY_DAYS) * DAY_MS;
  const to = today * DAY_MS; // today is offered once it is over

  const visits = await visitsAround(sql, deviceId, from, to);
  const deviceIds = [...new Set(visits.map((v) => v.deviceId))];
  const devices = deviceIds.length
    ? await sql<{ id: string; created_at: number; wallet_address: string | null }[]>`
        SELECT id, created_at, wallet_address FROM devices WHERE id IN ${sql(deviceIds)}
      `
    : [];
  const check = checkVisits(visits, new Map(devices.map((d) => [d.id, d.created_at])), { liveOnly: false });

  const duplicateVisits = check.exactDuplicates.get(deviceId) ?? 0;
  const original = check.nearDuplicateOf.get(deviceId);
  // Copying the history of another device of the same wallet is harmless: those days are paid once anyway.
  const originalWallet = original ? devices.find((d) => d.id === original)?.wallet_address ?? null : null;
  if (original && (wallet === null || originalWallet !== wallet)) return empty(0, duplicateVisits, original);

  const paid = wallet
    ? new Set((await sql<{ day: number }[]>`SELECT day FROM reward_days WHERE wallet = ${wallet} AND day >= ${today - HISTORY_DAYS}`).map((r) => r.day))
    : new Set<number>();
  const scored = scoreDays(check.visits.get(deviceId) ?? []);
  const days = scored.filter((d) => !paid.has(d.day) && d.points > 0);
  const points = days.reduce((a, d) => a + d.points, 0);

  return {
    days,
    visits: days.reduce((a, d) => a + d.visits, 0),
    pages: days.reduce((a, d) => a + d.pages, 0),
    activeDays: days.filter((d) => d.active).length,
    points,
    amount: toUnits(BigInt(points) * TOKENS_PER_POINT, decimals),
    duplicateVisits,
    paidDays: scored.filter((d) => paid.has(d.day)).length,
    copiedFrom: null,
  };
}

class NothingToClaim extends Error {}

// Turns the current offer into a payout. Each day is recorded in reward_days (primary key wallet + day)
// in the same transaction, so two parallel claims never pay a day twice: the second one finds nothing left.
// The payout is 'held' for review when the wallet's devices look risky (risk.ts), otherwise 'pending'.
export async function claimOffer(
  sql: Sql, deviceId: string, wallet: string, now: number, decimals: number,
): Promise<{ offer: Offer; payout: PayoutRow | null }> {
  const offer = await computeOffer(sql, deviceId, wallet, now, decimals);
  if (offer.copiedFrom || offer.points === 0) return { offer, payout: null };
  const holdReason = (await walletsUnderReview(sql, now)).get(wallet) ?? null;

  try {
    const payout = await sql.begin(async (tx) => {
      const [row] = await tx<PayoutRow[]>`
        INSERT INTO reward_payouts (epoch, device_id, wallet, kind, points, amount, status, hold_reason, created_at)
        VALUES (${epochAt(now)}, ${deviceId}, ${wallet}, 'claim', 0, 0, ${holdReason ? 'held' : 'pending'}, ${holdReason}, ${now})
        RETURNING *
      `;
      let points = 0;
      for (const d of offer.days) {
        const inserted = await tx`
          INSERT INTO reward_days (wallet, day, device_id, points, payout_id)
          VALUES (${wallet}, ${d.day}, ${deviceId}, ${d.points}, ${row.id})
          ON CONFLICT DO NOTHING
        `;
        if (inserted.count === 1) points += d.points;
      }
      if (points === 0) throw new NothingToClaim();
      const amount = toUnits(BigInt(points) * TOKENS_PER_POINT, decimals);
      const [updated] = await tx<PayoutRow[]>`
        UPDATE reward_payouts SET points = ${points}, amount = ${amount.toString()} WHERE id = ${row.id} RETURNING *
      `;
      return updated;
    });
    return { offer, payout };
  } catch (err) {
    if (err instanceof NothingToClaim) return { offer, payout: null };
    throw err;
  }
}
