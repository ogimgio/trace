// Chiude le settimane finite e invia i pagamenti. Da lanciare a mano o con un cron settimanale.
//
//   npm run rewards:settle                     chiude le settimane pronte e invia i pagamenti
//   npm run rewards:settle -- --dry-run        mostra cosa verrebbe pagato, senza scrivere né inviare
//   npm run rewards:settle -- --ignore-grace   chiude anche le settimane finite da meno di 8 giorni (demo)
//   npm run rewards:settle -- --retry-failed   ritenta i pagamenti rifiutati in simulazione
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openDb } from '../db.ts';
import { loadSolanaConfig, TOKEN_INFO_PATH } from '../solana/config.ts';
import { createRewarder, formatUnits } from '../solana/rewards.ts';
import { epochAt, epochRange, isSettleable } from './policy.ts';
import { ensureRewardsSchema, isSettled, planEpoch, sendPayouts, settleEpoch, type EpochPlan } from './settle.ts';

const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    'ignore-grace': { type: 'boolean', default: false },
    'retry-failed': { type: 'boolean', default: false },
  },
});

const config = loadSolanaConfig();
if (!config) {
  console.error(`Token non configurato (${TOKEN_INFO_PATH} mancante): lancia prima \`npm run solana:setup\`.`);
  process.exit(1);
}
const { decimals } = config;
const fmt = (units: bigint) => formatUnits(units, decimals);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const db = openDb(process.env.DB_PATH ?? resolve(import.meta.dirname, '../../data/history.db'));
ensureRewardsSchema(db);

function print(plan: EpochPlan) {
  const { startsAt, endsAt } = epochRange(plan.epoch);
  console.log(`\nSettimana ${plan.epoch} (${day(startsAt)} → ${day(endsAt - 1)}): budget ${fmt(plan.budget)}, ${plan.totalPoints} punti totali`);
  if (plan.payouts.length === 0) console.log('  nessun device con wallet e attività');
  for (const p of plan.payouts) {
    console.log(`  ${p.kind.padEnd(7)} ${p.deviceId.slice(0, 8)}… → ${p.wallet.slice(0, 8)}…  ${String(p.points).padStart(5)} punti  ${fmt(p.amount)}`);
  }
}

const now = Date.now();
const ready: number[] = [];
for (let epoch = 0; epoch < epochAt(now); epoch++) {
  if (!isSettled(db, epoch) && isSettleable(epoch, now, { ignoreGrace: args['ignore-grace'] })) ready.push(epoch);
}
if (ready.length === 0) console.log('Nessuna settimana da chiudere.');

for (const epoch of ready) {
  if (args['dry-run']) {
    print(planEpoch(db, epoch, decimals));
  } else {
    print(settleEpoch(db, epoch, decimals, now, { ignoreGrace: args['ignore-grace'] }));
  }
}

if (args['dry-run']) process.exit(0);

const rewarder = createRewarder(config);
const sent = await sendPayouts(db, rewarder, { retryFailed: args['retry-failed'] });
if (sent.length > 0) console.log('\nPagamenti:');
for (const row of sent) {
  const detail = row.status === 'sent' ? `https://explorer.solana.com/tx/${row.signature}?cluster=devnet` : row.error;
  console.log(`  #${row.id} ${row.kind} ${fmt(BigInt(row.amount))} → ${row.wallet.slice(0, 8)}…  ${row.status}  ${detail}`);
}
const stuck = db.prepare("SELECT COUNT(*) AS n FROM reward_payouts WHERE status = 'sending'").get() as { n: number };
if (stuck.n > 0) console.log(`\n⚠ ${stuck.n} pagamenti in stato 'sending': controlla su Explorer se sono arrivati prima di ritentarli.`);
console.log(`\nFondo ricompense: ${fmt(await rewarder.poolBalance())}`);
