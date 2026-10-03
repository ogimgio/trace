import express from 'express';
import { createApp } from './api.ts';
import { createDeviceCheck, loadFingerprintConfig } from './fingerprint.ts';
import { connect, databaseUrl } from './db.ts';
import { TOKEN_INFO_PATH, loadSolanaConfig } from './solana/config.ts';
import { createRewarder } from './solana/rewards.ts';

// Server entry point, configured from the environment. On Vercel the default export becomes the function
// (files in public/ are served by the CDN); locally it listens on 127.0.0.1.
const sql = connect(databaseUrl());

// With the token configured, the server sends the welcome bonus as soon as a user links a wallet.
const solana = loadSolanaConfig();
if (!solana) console.warn(`Token not configured (${TOKEN_INFO_PATH} or environment variables): payouts stay queued.`);

// Device check (Fingerprint): without the keys, wallets cannot be linked (fail closed).
const fingerprint = loadFingerprintConfig();
if (!fingerprint) console.warn('Fingerprint not configured (server/.secrets/antisybil.json or FINGERPRINT_* variables): wallet linking is disabled.');

const app = express();
app.use(createApp(sql, {
  rewarder: solana ? createRewarder(solana) : undefined,
  decimals: solana?.decimals,
  cronSecret: process.env.CRON_SECRET,
  deviceCheck: fingerprint ? createDeviceCheck(fingerprint) : undefined,
}));

export default app;

if (!process.env.VERCEL) {
  const PORT = Number(process.env.PORT ?? 8787);
  app.listen(PORT, '127.0.0.1', () => console.log(`TRACE server on http://127.0.0.1:${PORT}`));
}
