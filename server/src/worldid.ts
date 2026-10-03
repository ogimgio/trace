import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { signRequest } from '@worldcoin/idkit-core/signing';
import { hashSignal } from '@worldcoin/idkit-core/hashing';

// World ID (Orb) verification: one human, one wallet.
//
// 1. The link page asks the server for an RP context (a request signed with our RP key, see rpContext()).
// 2. The user proves in World App that they are a unique human verified at an Orb. The proof is bound
//    to the link code through the signal, so it cannot be replayed on another link.
// 3. The server checks the proof locally (action, environment, nonce, signal, credential) and then with
//    World's verify API, which returns the nullifier: an anonymous number, the same every time this human
//    verifies with TRACE, unrelated to their identity and to any other app.
//
// We never receive the person's name, biometrics or World ID account: only the proof and the nullifier.

export interface WorldIdConfig {
  appId: string; // app_...
  rpId: string; // rp_...
  signingKey: string; // RP signing key (hex), server-side only
  action: string; // action configured in the Developer Portal
  environment: 'production' | 'staging'; // staging works with the World ID Simulator
}

// What the link page needs to start the request (no secrets).
export interface WorldIdRequest {
  appId: string;
  action: string;
  environment: string;
  rpContext: { rp_id: string; nonce: string; created_at: number; expires_at: number; signature: string };
}

export type WorldIdVerdict = { ok: true; nullifier: string } | { ok: false; error: string };

export interface WorldId {
  readonly action: string;
  // `signal`: the value the proof must commit to (the link code).
  start(signal: string): WorldIdRequest & { signal: string };
  verify(result: unknown, expected: { signal: string; nonce: string }): Promise<WorldIdVerdict>;
}

const VERIFY_URL = 'https://developer.world.org/api/v4/verify';
// Orb verification ("proof of human"). Device-level or document credentials are not accepted.
const ORB_CREDENTIAL = 'proof_of_human';
const RP_SIGNATURE_TTL_S = 10 * 60;
const SECRETS_FILE = resolve(import.meta.dirname, '../.secrets/worldid.json');

// TEMPORARY, for the hackathon deploy: the TRACE app's World ID credentials committed to the repo.
// TODO: move signingKey to Vercel (WORLD_RP_SIGNING_KEY), delete it from here and rotate it in the
// Developer Portal ("Rotate signer key"): it stays in git history, so treat it as leaked once removed.
const COMMITTED_DEFAULTS: Partial<WorldIdConfig> = {
  appId: 'app_21dd590852303c8b3899b0dc157f9a5d',
  rpId: 'rp_1a46f716be68482d',
  signingKey: '0x4eb3703750c313daf274df99efa5857646c9148a187f0fc4464615cff546b947',
  action: 'link-wallet',
  environment: 'production',
};

// From the environment (Vercel), or locally from server/.secrets/worldid.json (git-ignored), or the committed defaults.
export function loadWorldIdConfig(env = process.env, file: string | null = SECRETS_FILE): WorldIdConfig | null {
  const local = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Partial<WorldIdConfig> : file === SECRETS_FILE ? COMMITTED_DEFAULTS : {};
  const appId = env.WORLD_APP_ID ?? local.appId;
  const rpId = env.WORLD_RP_ID ?? local.rpId;
  const signingKey = env.WORLD_RP_SIGNING_KEY ?? local.signingKey;
  if (!appId || !rpId || !signingKey) return null;
  return {
    appId,
    rpId,
    signingKey,
    action: env.WORLD_ACTION ?? local.action ?? 'link-wallet',
    environment: (env.WORLD_ENVIRONMENT ?? local.environment) === 'staging' ? 'staging' : 'production',
  };
}

// Nullifiers are 256-bit numbers: stored as decimal strings (numeric(78, 0)) so hex case and padding
// can never make the same human look like two.
export const nullifierToDecimal = (hex: string) => BigInt(hex).toString();

const sameField = (a: unknown, b: string) => {
  try {
    return typeof a === 'string' && BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
};

export function createWorldId(config: WorldIdConfig, fetchImpl: typeof fetch = fetch): WorldId {
  return {
    action: config.action,
    start(signal) {
      const rp = signRequest({ signingKeyHex: config.signingKey, action: config.action, ttl: RP_SIGNATURE_TTL_S });
      return {
        appId: config.appId,
        action: config.action,
        environment: config.environment,
        signal,
        rpContext: { rp_id: config.rpId, nonce: rp.nonce, created_at: rp.createdAt, expires_at: rp.expiresAt, signature: rp.sig },
      };
    },

    async verify(result, expected) {
      const r = result as {
        protocol_version?: string; nonce?: string; action?: string; environment?: string;
        responses?: { identifier?: string; signal_hash?: string }[];
      } | null;
      // Local checks first: they are free and say exactly what is wrong.
      if (r?.protocol_version !== '4.0') return { ok: false, error: 'World ID 4.0 proof required: update World App' };
      if (r.action !== config.action) return { ok: false, error: 'proof for a different action' };
      if (r.environment !== config.environment) return { ok: false, error: `proof from the ${r.environment} environment` };
      if (!r.nonce || !sameField(r.nonce, expected.nonce)) return { ok: false, error: 'proof for a different request' };
      const orb = r.responses?.find((x) => x.identifier === ORB_CREDENTIAL);
      if (!orb) return { ok: false, error: 'Orb verification required' };
      if (!sameField(orb.signal_hash, hashSignal(expected.signal))) return { ok: false, error: 'proof bound to a different link' };

      const res = await fetchImpl(`${VERIFY_URL}/${config.rpId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(result), // forwarded as-is, as World requires
      });
      const body = await res.json().catch(() => null) as {
        success?: boolean; environment?: string; detail?: string;
        results?: { identifier?: string; success?: boolean; nullifier?: string }[];
      } | null;
      const verified = body?.results?.find((x) => x.identifier === ORB_CREDENTIAL && x.success);
      if (!res.ok || !body?.success || body.environment !== config.environment || !verified?.nullifier) {
        return { ok: false, error: `World ID verification failed${body?.detail ? `: ${body.detail}` : ''}` };
      }
      return { ok: true, nullifier: nullifierToDecimal(verified.nullifier) };
    },
  };
}
