// Handles a data deletion request received by email: deletes the device and, by cascade,
// its visits, uploads and wallet challenges. Payout records are kept (they are public on-chain).
//   npm run admin:delete-device -- <deviceId> [--yes]
import { parseArgs } from 'node:util';
import { connect, databaseUrl } from './db.ts';

const { values, positionals } = parseArgs({ options: { yes: { type: 'boolean', default: false } }, allowPositionals: true });
const [deviceId] = positionals;
if (!deviceId) {
  console.error('Usage: npm run admin:delete-device -- <deviceId> [--yes]');
  process.exit(1);
}

const sql = connect(databaseUrl(), { max: 1 });
try {
  const [device] = await sql<{ id: string; wallet_address: string | null; visits: number }[]>`
    SELECT d.id, d.wallet_address, (SELECT COUNT(*) FROM visits v WHERE v.device_id = d.id) AS visits
    FROM devices d WHERE d.id = ${deviceId}
  `;
  if (!device) {
    console.error(`✗ Device ${deviceId} not found`);
    process.exitCode = 1;
  } else if (!values.yes) {
    console.log(`Device ${device.id}: ${device.visits} visits, wallet ${device.wallet_address ?? 'none'}`);
    console.log('Run again with --yes to delete it.');
  } else {
    await sql`DELETE FROM devices WHERE id = ${deviceId}`;
    console.log(`✓ Deleted device ${deviceId} and its ${device.visits} visits`);
  }
} finally {
  await sql.end();
}
