// Manual review of payouts held because of a risky device (see risk.ts).
//
//   npm run rewards:review                         lists held payouts by wallet, with the reason
//   npm run rewards:review -- --release <wallet>   releases them: the next settle/cron run sends them
//   npm run rewards:review -- --reject <wallet>    rejects them for good
import { parseArgs } from 'node:util';
import { connect, databaseUrl } from '../db.ts';

const { values: args } = parseArgs({ options: { release: { type: 'string' }, reject: { type: 'string' } } });

const sql = connect(databaseUrl(), { max: 1 });
try {
  if (args.release || args.reject) {
    const wallet = (args.release ?? args.reject)!;
    const status = args.release ? 'pending' : 'rejected';
    const result = await sql`UPDATE reward_payouts SET status = ${status} WHERE wallet = ${wallet} AND status = 'held'`;
    console.log(`${result.count} held payouts of ${wallet} → ${status}`);
  } else {
    const rows = await sql<{ wallet: string; payouts: number; amount: string; reason: string }[]>`
      SELECT wallet, COUNT(*)::int AS payouts, SUM(amount)::text AS amount, MAX(hold_reason) AS reason
      FROM reward_payouts WHERE status = 'held' GROUP BY wallet ORDER BY wallet
    `;
    if (rows.length === 0) console.log('No held payouts.');
    for (const r of rows) console.log(`${r.wallet}  ${r.payouts} payouts, ${r.amount} base units\n  reason: ${r.reason}`);
  }
} finally {
  await sql.end();
}
