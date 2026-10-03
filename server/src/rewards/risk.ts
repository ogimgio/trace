import type { Sql } from '../db.ts';
import { CLUSTER_MIN_WALLETS, DEVICE_WINDOW_MS, REVIEW_REJECTED_ATTEMPTS, REVIEW_SUSPECT_SCORE } from './policy.ts';

// Which wallets have their payouts held for manual review instead of sent automatically, and why.
// Nobody is blocked here: a held payout is released or rejected by an operator (`npm run rewards:review`).
export async function walletsUnderReview(sql: Sql, now: number): Promise<Map<string, string>> {
  const since = now - DEVICE_WINDOW_MS;
  const reasons = new Map<string, string[]>();
  const add = (wallet: string, reason: string) => reasons.set(wallet, [...(reasons.get(wallet) ?? []), reason]);

  // A device Fingerprint finds suspicious (VPN, incognito, developer tools… weighted together).
  for (const r of await sql<{ wallet: string; score: number }[]>`
    SELECT wallet, MAX(suspect_score) AS score FROM device_fingerprints
    WHERE suspect_score >= ${REVIEW_SUSPECT_SCORE} GROUP BY wallet
  `) add(r.wallet, `suspect score ${r.score}`);

  // A device that keeps trying to link other wallets: its own wallet is likely a farm.
  for (const r of await sql<{ wallet: string; attempts: number }[]>`
    SELECT f.wallet, COUNT(*)::int AS attempts FROM device_link_rejections x
    JOIN device_fingerprints f ON f.visitor_id = x.visitor_id
    WHERE x.created_at >= ${since} GROUP BY f.wallet HAVING COUNT(*) >= ${REVIEW_REJECTED_ATTEMPTS}
  `) add(r.wallet, `${r.attempts} attempts to link other wallets from its device`);

  // Many wallets on the same network with the same browser setup: one person or farm behind them.
  for (const r of await sql<{ wallets: string[] }[]>`
    SELECT array_agg(DISTINCT wallet) AS wallets FROM device_fingerprints
    WHERE cluster_key IS NOT NULL AND last_seen_at >= ${since}
    GROUP BY cluster_key HAVING COUNT(DISTINCT wallet) >= ${CLUSTER_MIN_WALLETS}
  `) for (const wallet of r.wallets) add(wallet, `cluster of ${r.wallets.length} wallets with the same network and browser`);

  return new Map([...reasons].map(([wallet, list]) => [wallet, list.join('; ')]));
}
