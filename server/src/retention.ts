import type { Sql } from './db.ts';

// Shared browsing data is kept for at most 18 months after it was received (see public/privacy.html).
// Payout records are kept: they mirror public on-chain transactions.
export const RETENTION_MS = 548 * 24 * 60 * 60 * 1000;

export async function purgeExpiredVisits(sql: Sql, now: number): Promise<number> {
  const result = await sql`DELETE FROM visits WHERE received_at < ${now - RETENTION_MS}`;
  return result.count;
}
