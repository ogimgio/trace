import express from 'express';
import { createApp } from './api.ts';
import { connect, databaseUrl } from './db.ts';
import { TOKEN_INFO_PATH, loadSolanaConfig } from './solana/config.ts';
import { createRewarder } from './solana/rewards.ts';

// Ingresso del server, configurato dall'ambiente. Su Vercel l'export di default diventa la funzione
// (i file in public/ li serve la CDN); in locale si mette in ascolto su 127.0.0.1.
const sql = connect(databaseUrl());

// Con il token configurato, il server invia subito il bonus di benvenuto quando un utente collega il wallet.
const solana = loadSolanaConfig();
if (!solana) console.warn(`Token non configurato (${TOKEN_INFO_PATH} o variabili d'ambiente): i pagamenti restano in coda.`);

const app = express();
app.use(createApp(sql, {
  rewarder: solana ? createRewarder(solana) : undefined,
  decimals: solana?.decimals,
  cronSecret: process.env.CRON_SECRET,
}));

export default app;

if (!process.env.VERCEL) {
  const PORT = Number(process.env.PORT ?? 8787);
  app.listen(PORT, '127.0.0.1', () => console.log(`TRACE server on http://127.0.0.1:${PORT}`));
}
