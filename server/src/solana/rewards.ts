import { Connection, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import type { SolanaConfig } from './config.ts';

export const MAX_DECIMALS = 9;

// Converte un importo leggibile ("1.5") in unità base (1_500_000n con 6 decimali),
// senza passare dai float: 0.1 + 0.2 non deve diventare 300000000000000004.
export function toBaseUnits(amount: string | number, decimals: number): bigint {
  const text = typeof amount === 'number' ? amount.toFixed(decimals) : amount.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error(`invalid amount: ${amount}`);
  const whole = match[1];
  const frac = (match[2] ?? '').replace(/0+$/, '');
  if (frac.length > decimals) throw new Error(`amount has more than ${decimals} decimals`);
  const units = BigInt(whole + frac.padEnd(decimals, '0'));
  if (units <= 0n) throw new Error('amount must be positive');
  return units;
}

// Inverso di toBaseUnits: 1_500_000n con 6 decimali → "1.5".
export function formatUnits(units: bigint, decimals: number): string {
  const text = units.toString().padStart(decimals + 1, '0');
  const whole = text.slice(0, text.length - decimals);
  const frac = text.slice(text.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

// Valida l'indirizzo che l'utente ha incollato nell'estensione.
// Rifiuta anche gli indirizzi fuori dalla curva (PDA): non sono wallet e non possono avere un ATA standard.
export function parseWalletAddress(address: unknown): PublicKey | null {
  if (typeof address !== 'string' || address.length < 32 || address.length > 44) return null;
  try {
    const key = new PublicKey(address);
    return PublicKey.isOnCurve(key.toBytes()) ? key : null;
  } catch {
    return null;
  }
}

export function explorerTxUrl(signature: string, cluster = 'devnet') {
  return `https://explorer.solana.com/tx/${signature}?cluster=${cluster}`;
}

export interface TransferResult {
  signature: string;
  explorerUrl: string;
}

// La supply è fissa: le ricompense non vengono create, escono dal fondo ricompense
// (il token account del wallet del server).
export function createRewarder(config: SolanaConfig) {
  const connection = new Connection(config.rpcUrl, 'confirmed');
  const { serverWallet, mint, decimals } = config;
  const poolAccount = getAssociatedTokenAddressSync(mint, serverWallet.publicKey, false, TOKEN_2022_PROGRAM_ID);

  const tokenAccountOf = (wallet: PublicKey) => getAssociatedTokenAddressSync(mint, wallet, false, TOKEN_2022_PROGRAM_ID);

  // Una sola transazione: crea il token account dell'utente se manca (idempotente) e trasferisce i token.
  // Il server paga le fee, l'utente non deve avere SOL.
  async function send(wallet: PublicKey, units: bigint): Promise<TransferResult> {
    const destination = tokenAccountOf(wallet);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        serverWallet.publicKey, destination, wallet, mint, TOKEN_2022_PROGRAM_ID,
      ),
      createTransferCheckedInstruction(
        poolAccount, mint, destination, serverWallet.publicKey, units, decimals, [], TOKEN_2022_PROGRAM_ID,
      ),
    );
    const signature = await sendAndConfirmTransaction(connection, tx, [serverWallet], { commitment: 'confirmed' });
    return { signature, explorerUrl: explorerTxUrl(signature) };
  }

  // Saldo in unità base; 0n se il token account non esiste ancora.
  async function balanceOf(wallet: PublicKey): Promise<bigint> {
    try {
      const { value } = await connection.getTokenAccountBalance(tokenAccountOf(wallet));
      return BigInt(value.amount);
    } catch {
      return 0n;
    }
  }

  return { connection, mint, decimals, send, balanceOf, poolBalance: () => balanceOf(serverWallet.publicKey) };
}

export type Rewarder = ReturnType<typeof createRewarder>;
