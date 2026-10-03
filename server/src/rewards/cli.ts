// Settles finished weeks and sends payouts. In production the Vercel cron does this (/api/cron/daily).
//
//   npm run rewards:settle                     settles ready weeks and sends payouts
//   npm run rewards:settle -- --dry-run        shows what would be paid, without writing or sending
//   npm run rewards:settle -- --ignore-grace   also settles weeks that ended less than 8 days ago (demo)
//   npm run rewards:settle -- --retry-failed   retries payouts rejected in simulation
import { parseArgs } from 'node:util';
import { connect, databaseUrl } from '../db.ts';
import { loadSolanaConfig, TOKEN_INFO_PATH } from '../solana/config.ts';
import { createRewarder, formatUnits } from '../solana/rewards.ts';
import { epochRange } from './policy.ts';
import { planEpoch, readyEpochs, sendPayouts, settleEpoch, type EpochPlan } from './settle.ts';

const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    'ignore-grace': { type: 'boolean', default: false },
    'retry-failed': { type: 'boolean', default: false },
  },
});

const config = loadSolanaConfig();
if (!config) {
  console.error(`Token not configured (${TOKEN_INFO_PATH} missing): run \`npm run solana:setup\` first.`);
  process.exit(1);
}
const { decimals } = config;
const fmt = (units: bigint) => formatUnits(units, decimals);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const sql = connect(databaseUrl(), { max: 1 });

function print(plan: EpochPlan) {
  const { startsAt, endsAt } = epochRange(plan.epoch);
  console.log(`\nWeek ${plan.epoch} (${day(startsAt)} → ${day(endsAt - 1)}): budget ${fmt(plan.budget)}, ${plan.totalPoints} total points`);
  if (plan.payouts.length === 0) console.log('  no devices with a wallet and activity');
  for (const p of plan.payouts) {
    console.log(`  ${p.kind.padEnd(7)} ${p.deviceId.slice(0, 8)}… → ${p.wallet.slice(0, 8)}…  ${String(p.points).padStart(5)} points  ${fmt(p.amount)}`);
  }
}

try {
  const now = Date.now();
  const ready = await readyEpochs(sql, now, { ignoreGrace: args['ignore-grace'] });
  if (ready.length === 0) console.log('No weeks to settle.');

  for (const epoch of ready) {
    print(args['dry-run']
      ? await planEpoch(sql, epoch, decimals)
      : await settleEpoch(sql, epoch, decimals, now, { ignoreGrace: args['ignore-grace'] }));
  }

  if (!args['dry-run']) {
    const rewarder = createRewarder(config);
    const sent = await sendPayouts(sql, rewarder, { retryFailed: args['retry-failed'] });
    if (sent.length > 0) console.log('\nPayouts:');
    for (const row of sent) {
      const detail = row.status === 'sent' ? `https://explorer.solana.com/tx/${row.signature}?cluster=devnet` : row.error;
      console.log(`  #${row.id} ${row.kind} ${fmt(BigInt(row.amount))} → ${row.wallet.slice(0, 8)}…  ${row.status}  ${detail}`);
    }
    const [stuck] = await sql<{ n: number }[]>`SELECT COUNT(*) AS n FROM reward_payouts WHERE status = 'sending'`;
    if (stuck.n > 0) console.log(`\n⚠ ${stuck.n} payouts in 'sending' state: check on Explorer whether they landed before retrying them.`);
    console.log(`\nRewards pool: ${fmt(await rewarder.poolBalance())}`);
  }
} finally {
  await sql.end();
}
