import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createApp } from './app.ts';
import { openDb } from './db.ts';
import { TOKEN_INFO_PATH, loadSolanaConfig } from './solana/config.ts';
import { createRewarder } from './solana/rewards.ts';

const PORT = Number(process.env.PORT ?? 8787);
const DB_PATH = process.env.DB_PATH ?? resolve(import.meta.dirname, '../data/history.db');

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = openDb(DB_PATH);

// Con il token configurato, il server invia subito il bonus di benvenuto quando un utente collega il wallet.
const solana = loadSolanaConfig();
if (!solana) console.warn(`Token non configurato (${TOKEN_INFO_PATH}): i pagamenti restano in coda.`);
const rewards = solana ? { rewarder: createRewarder(solana), decimals: solana.decimals } : {};

// Solo 127.0.0.1: non c'è ancora autenticazione, quindi il server non deve essere raggiungibile dalla rete.
createApp(db, rewards).listen(PORT, '127.0.0.1', () => {
  console.log(`History server on http://127.0.0.1:${PORT} (db: ${DB_PATH})`);
});
