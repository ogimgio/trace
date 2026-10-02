import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';

// Tutto ciò che è segreto o specifico della macchina sta in server/.secrets/ (fuori dal repo).
export const SECRETS_DIR = resolve(import.meta.dirname, '../../.secrets');
// Wallet "caldo" del server: paga le fee, possiede il fondo ricompense e può aggiornare i metadati.
export const SERVER_KEYPAIR_PATH = resolve(SECRETS_DIR, 'server-wallet.json');
// Wallet della riserva (team, progetto, liquidità): il server non lo usa mai.
export const RESERVE_KEYPAIR_PATH = resolve(SECRETS_DIR, 'reserve-wallet.json');
export const TOKEN_INFO_PATH = resolve(SECRETS_DIR, 'token.json');

export const DEFAULT_RPC_URL = 'https://api.devnet.solana.com';

// Scritto da `npm run solana:setup` dopo aver creato il mint.
export interface TokenInfo {
  mint: string;
  decimals: number;
  name: string;
  symbol: string;
}

export interface SolanaConfig {
  rpcUrl: string;
  serverWallet: Keypair;
  mint: PublicKey;
  decimals: number;
}

export function keypairFromJson(json: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(json) as number[]));
}

// Le variabili d'ambiente hanno la precedenza sui file in .secrets/ (utile in deploy):
//   SOLANA_RPC_URL, SERVER_WALLET (contenuto JSON del keypair), MINT_ADDRESS, MINT_DECIMALS
// Restituisce null se il token non è ancora stato creato.
export function loadSolanaConfig(env = process.env): SolanaConfig | null {
  const fileInfo: Partial<TokenInfo> = existsSync(TOKEN_INFO_PATH)
    ? JSON.parse(readFileSync(TOKEN_INFO_PATH, 'utf8'))
    : {};

  const mint = env.MINT_ADDRESS ?? fileInfo.mint;
  const keypairJson = env.SERVER_WALLET
    ?? (existsSync(SERVER_KEYPAIR_PATH) ? readFileSync(SERVER_KEYPAIR_PATH, 'utf8') : undefined);
  if (!mint || !keypairJson) return null;

  return {
    rpcUrl: env.SOLANA_RPC_URL ?? DEFAULT_RPC_URL,
    serverWallet: keypairFromJson(keypairJson),
    mint: new PublicKey(mint),
    decimals: Number(env.MINT_DECIMALS ?? fileInfo.decimals ?? 6),
  };
}
