import { createPublicKey, randomBytes, verify } from 'node:crypto';
import type { Sql } from '../db.ts';
import { PublicKey } from '@solana/web3.js';

// Wallet linking by signature.
//
// 1. The extension requests a "challenge" for its device: a one-time code that expires in 10 minutes.
// 2. It opens /link.html?code=..., a page served by this server, where Phantom signs the challenge message.
// 3. The server verifies the signature with the wallet's public key, which proves the wallet belongs to the user.
//
// Once linked, the wallet is locked: changing it first requires an 'unlink' challenge signed by the
// current wallet. Someone who learns another user's deviceId therefore cannot redirect their rewards.

export const CHALLENGE_TTL_MS = 10 * 60 * 1000;

export type LinkAction = 'link' | 'unlink';

export interface Challenge {
  code: string;
  device_id: string;
  action: LinkAction;
  wallet: string | null; // for 'unlink': the wallet that must sign
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

// Marks the challenge as used only if it is still valid: two requests with the same code can't both succeed.
export async function consumeChallenge(sql: Sql, code: string, now: number): Promise<boolean> {
  const result = await sql`
    UPDATE wallet_challenges SET used_at = ${now} WHERE code = ${code} AND used_at IS NULL AND expires_at > ${now}
  `;
  return result.count === 1;
}

// The text the user sees and signs in Phantom. It includes device and code, so the signature is good for nothing else.
export function challengeMessage(c: Pick<Challenge, 'code' | 'device_id' | 'action' | 'wallet' | 'expires_at'>): string {
  const action = c.action === 'link'
    ? `Link this wallet to device ${c.device_id} to receive rewards.`
    : `Unlink wallet ${c.wallet} from device ${c.device_id}.`;
  return [
    'TRACE',
    '',
    action,
    '',
    `Code: ${c.code}`,
    `Expires: ${new Date(c.expires_at).toISOString()}`,
    '',
    'Signing is free and moves no funds.',
  ].join('\n');
}

// Verifies an Ed25519 signature (the scheme Solana wallets use) of `message` by `wallet`.
export function verifyWalletSignature(message: string, signature: Uint8Array, wallet: PublicKey): boolean {
  if (signature.length !== 64) return false;
  const key = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(wallet.toBytes()).toString('base64url') },
    format: 'jwk',
  });
  return verify(null, Buffer.from(message, 'utf8'), key, signature);
}
