import { createPublicKey, randomBytes, verify } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { PublicKey } from '@solana/web3.js';

// Collegamento del wallet con firma.
//
// 1. L'estensione chiede una "challenge" per il suo device: un codice monouso che scade in 10 minuti.
// 2. Apre /link?code=..., una pagina servita da questo server, dove Phantom firma il messaggio della challenge.
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

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS wallet_challenges (
    code        TEXT PRIMARY KEY,
    device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    action      TEXT NOT NULL CHECK (action IN ('link', 'unlink')),
    wallet      TEXT,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    used_at     INTEGER
  );
`;

export function ensureLinkSchema(db: DatabaseSync) {
  db.exec(SCHEMA);
}

export function createChallenge(db: DatabaseSync, deviceId: string, action: LinkAction, wallet: string | null, now: number): Challenge {
  const challenge: Challenge = {
    code: randomBytes(16).toString('hex'),
    device_id: deviceId,
    action,
    wallet,
    expires_at: now + CHALLENGE_TTL_MS,
    used_at: null,
  };
  db.prepare('INSERT INTO wallet_challenges (code, device_id, action, wallet, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(challenge.code, deviceId, action, wallet, now, challenge.expires_at);
  return challenge;
}

export function getChallenge(db: DatabaseSync, code: string): Challenge | undefined {
  return db.prepare('SELECT code, device_id, action, wallet, expires_at, used_at FROM wallet_challenges WHERE code = ?')
    .get(code) as unknown as Challenge | undefined;
}

// Segna la challenge come usata solo se è ancora valida: due richieste con lo stesso codice non passano entrambe.
export function consumeChallenge(db: DatabaseSync, code: string, now: number): boolean {
  const result = db.prepare('UPDATE wallet_challenges SET used_at = ? WHERE code = ? AND used_at IS NULL AND expires_at > ?')
    .run(now, code, now);
  return Number(result.changes) === 1;
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
