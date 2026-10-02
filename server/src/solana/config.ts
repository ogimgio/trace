import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';

// Everything secret or machine-specific lives in server/.secrets/ (outside the repo).
export const SECRETS_DIR = resolve(import.meta.dirname, '../../.secrets');
// Server "hot" wallet: pays fees, holds the rewards pool and can update the metadata.
export const SERVER_KEYPAIR_PATH = resolve(SECRETS_DIR, 'server-wallet.json');
// Reserve wallet (team, project, liquidity): the server never uses it.
export const RESERVE_KEYPAIR_PATH = resolve(SECRETS_DIR, 'reserve-wallet.json');
export const TOKEN_INFO_PATH = resolve(SECRETS_DIR, 'token.json');

export const DEFAULT_RPC_URL = 'https://api.devnet.solana.com';

// Written by `npm run solana:setup` after creating the mint.
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

// Environment variables take precedence over the files in .secrets/ (useful when deploying):
//   SOLANA_RPC_URL, SERVER_WALLET (keypair JSON contents), MINT_ADDRESS, MINT_DECIMALS
// Returns null if the token has not been created yet.
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
