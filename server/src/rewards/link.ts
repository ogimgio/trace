import { createPublicKey, randomBytes, verify } from 'node:crypto';
import type { Sql } from '../db.ts';
import { PublicKey } from '@solana/web3.js';

// Collegamento del wallet con firma.
//
// 1. L'estensione chiede una "challenge" per il suo device: un codice monouso che scade in 10 minuti.
// 2. Apre /link.html?code=..., una pagina servita da questo server, dove Phantom firma il messaggio della challenge.
// 3. Il server verifica la firma con la chiave pubblica del wallet: così sa che il wallet è davvero dell'utente.
//
// Una volta collegato, il wallet è bloccato: per cambiarlo serve prima una challenge 'unlink'
// firmata dal wallet attuale. Chi scopre il deviceId di un altro non può quindi dirottarne le ricompense.

export const CHALLENGE_TTL_MS = 10 * 60 * 1000;

export type LinkAction = 'link' | 'unlink';

export interface Challenge {
  code: string;
  device_id: string;
  action: LinkAction;
  wallet: string | null; // per 'unlink': il wallet che deve firmare
  expires_at: number;
  used_at: number | null;
}

export async function createChallenge(sql: Sql, deviceId: string, action: LinkAction, wallet: string | null, now: number): Promise<Challenge> {
  const challenge: Challenge = {
    code: randomBytes(16).toString('hex'),
    device_id: deviceId,
    action,
    wallet,
    expires_at: now + CHALLENGE_TTL_MS,
    used_at: null,
  };
  await sql`
    INSERT INTO wallet_challenges (code, device_id, action, wallet, created_at, expires_at)
    VALUES (${challenge.code}, ${deviceId}, ${action}, ${wallet}, ${now}, ${challenge.expires_at})
  `;
  return challenge;
}

export async function getChallenge(sql: Sql, code: string): Promise<Challenge | undefined> {
  const [row] = await sql<Challenge[]>`
    SELECT code, device_id, action, wallet, expires_at, used_at FROM wallet_challenges WHERE code = ${code}
  `;
  return row;
}

// Segna la challenge come usata solo se è ancora valida: due richieste con lo stesso codice non passano entrambe.
export async function consumeChallenge(sql: Sql, code: string, now: number): Promise<boolean> {
  const result = await sql`
    UPDATE wallet_challenges SET used_at = ${now} WHERE code = ${code} AND used_at IS NULL AND expires_at > ${now}
  `;
  return result.count === 1;
}

// Il testo che l'utente vede in Phantom e firma. Contiene device e codice, quindi la firma non vale per altro.
export function challengeMessage(c: Pick<Challenge, 'code' | 'device_id' | 'action' | 'wallet' | 'expires_at'>): string {
  const action = c.action === 'link' ? 'Collega questo wallet' : `Scollega il wallet ${c.wallet}`;
  return [
    'TRACE',
    '',
    `${action} al dispositivo ${c.device_id} per ricevere le ricompense.`,
    '',
    `Codice: ${c.code}`,
    `Scade: ${new Date(c.expires_at).toISOString()}`,
    '',
    'Firmare non costa nulla e non sposta fondi.',
  ].join('\n');
}

// Verifica una firma Ed25519 (quella dei wallet Solana) di `message` fatta da `wallet`.
export function verifyWalletSignature(message: string, signature: Uint8Array, wallet: PublicKey): boolean {
  if (signature.length !== 64) return false;
  const key = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(wallet.toBytes()).toString('base64url') },
    format: 'jwk',
  });
  return verify(null, Buffer.from(message, 'utf8'), key, signature);
}
