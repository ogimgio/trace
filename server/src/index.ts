import express from 'express';
import { createApp } from './api.ts';
import { connect, databaseUrl } from './db.ts';
import { TOKEN_INFO_PATH, loadSolanaConfig } from './solana/config.ts';
import { createRewarder } from './solana/rewards.ts';
import { createWorldId, loadWorldIdConfig } from './worldid.ts';

// Server entry point, configured from the environment. On Vercel the default export becomes the function
// (files in public/ are served by the CDN); locally it listens on 127.0.0.1.
const sql = connect(databaseUrl());

// With the token configured, the daily cron sends the settled payouts on-chain.
const solana = loadSolanaConfig();
if (!solana) console.warn(`Token not configured (${TOKEN_INFO_PATH} or environment variables): payouts stay queued.`);

// World ID is required to link a wallet: without its configuration, linking is refused.
const worldIdConfig = loadWorldIdConfig();
if (!worldIdConfig) console.warn('World ID not configured (WORLD_APP_ID, WORLD_RP_ID, WORLD_RP_SIGNING_KEY): wallets cannot be linked.');

const app = express();
app.use(createApp(sql, {
  rewarder: solana ? createRewarder(solana) : undefined,
  decimals: solana?.decimals,
  cronSecret: process.env.CRON_SECRET,
  // IPs are hashed with this salt before being stored for rate limiting.
  ipSalt: process.env.IP_HASH_SALT ?? process.env.CRON_SECRET,
  worldId: worldIdConfig ? createWorldId(worldIdConfig) : undefined,
}));

export default app;

if (!process.env.VERCEL) {
  const PORT = Number(process.env.PORT ?? 8787);
  app.listen(PORT, '127.0.0.1', () => console.log(`TRACE server on http://127.0.0.1:${PORT}`));
}
