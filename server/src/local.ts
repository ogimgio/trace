// Local server with an embedded Postgres (PGlite) saved in server/data/: no database account needed.
// Same API and pages as production, on http://localhost:8787. Without the token secrets (server/.secrets/)
// payouts stay queued; everything else (device check, wallet linking, points, duplicate checks) works.
//   npm run dev:local
// Delete server/data/ to start from an empty database.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { createApp } from './api.ts';
import { connect, migrate } from './db.ts';
import { loadSolanaConfig } from './solana/config.ts';
import { createRewarder } from './solana/rewards.ts';
import { createDeviceCheck, loadFingerprintConfig } from './fingerprint.ts';

const PORT = 8787;

const dataDir = resolve(import.meta.dirname, '../data/pglite');
mkdirSync(dataDir, { recursive: true });
const pg = await PGlite.create(dataDir);
const socket = new PGLiteSocketServer({ db: pg, port: 0, host: '127.0.0.1' });
await socket.start();
const { port } = (socket as unknown as { server: { address(): { port: number } } }).server.address();
// PGlite serves one connection at a time.
const sql = connect(`postgres://postgres@127.0.0.1:${port}/postgres`, { max: 1 });
await migrate(sql);

const solana = loadSolanaConfig();
const fingerprintConfig = loadFingerprintConfig();
const app = createApp(sql, {
  rewarder: solana ? createRewarder(solana) : undefined,
  decimals: solana?.decimals,
  deviceCheck: fingerprintConfig ? createDeviceCheck(fingerprintConfig, 'trace-local') : undefined,
  // Every request comes from the same IP locally: rate limits would only get in the way. Same for the limit
  // on extension installs per device: while developing, the extension is reinstalled all the time.
  rateLimits: false,
  maxExtensionsPerDevice: false,
});

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`TRACE local server on http://localhost:${PORT} (database in server/data/pglite)`);
  console.log(`Device check (Fingerprint): ${fingerprintConfig ? `region ${fingerprintConfig.region}` : 'NOT configured, wallets cannot be linked'}`);
  console.log('Limits off for development: rate limits per IP, extension installs per device');
  console.log(`Payouts: ${solana ? 'sent on Devnet' : 'queued (token secrets not on this machine)'}`);
});
server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(err.code === 'EADDRINUSE' ? `✗ Port ${PORT} is already in use: is another TRACE server still running?` : err);
  process.exit(1);
});
