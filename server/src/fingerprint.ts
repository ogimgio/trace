import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Device check with Fingerprint: one browser/device, one wallet.
//
// 1. The link page loads Fingerprint's agent with the public key and gets an event ID for this visit.
// 2. It sends the event ID with the wallet signature. The server fetches the event with the secret key
//    (so the page cannot fake it) and gets the visitor ID: a stable identifier of the browser and device,
//    which survives cleared cookies, incognito mode and a new IP.
// 3. The server refuses bots, tampered browsers, virtual machines, emulators and stale events, and binds
//    the visitor ID to the wallet (see routes.ts): the same device cannot link a second wallet.
// 4. Other signals do not block anyone: they are stored and can hold a wallet's payouts for review
//    (see rewards/risk.ts): suspect score, VPN, incognito, and a cluster key grouping devices that share
//    the same network and browser setup.

export type FingerprintRegion = 'us' | 'eu' | 'ap';

export interface FingerprintConfig {
  publicApiKey: string; // used in the browser: not secret
  secretApiKey: string; // server only
  region: FingerprintRegion;
}

export interface DeviceSignals {
  suspectScore: number | null;
  vpn: boolean;
  incognito: boolean;
  // Hash of IP address + browser + OS + device model: many wallets with the same key look like one farm.
  // Only the hash is stored, never the IP.
  clusterKey: string | null;
}

export type DeviceVerdict = { ok: true; visitorId: string; signals: DeviceSignals } | { ok: false; error: string };

export interface DeviceCheck {
  // What the link page needs to load the agent (no secrets).
  readonly browser: { apiKey: string; region: FingerprintRegion };
  check(eventId: string, now: number): Promise<DeviceVerdict>;
}

const API_HOSTS: Record<FingerprintRegion, string> = { us: 'api.fpjs.io', eu: 'eu.api.fpjs.io', ap: 'ap.api.fpjs.io' };
// The event must come from the page the user is on now, not from an old visit.
const MAX_EVENT_AGE_MS = 10 * 60 * 1000;
const SECRETS_FILE = resolve(import.meta.dirname, '../.secrets/antisybil.json');

// From the environment (Vercel), or locally from server/.secrets/antisybil.json (git-ignored).
export function loadFingerprintConfig(env = process.env, file: string | null = SECRETS_FILE): FingerprintConfig | null {
  const local = file && existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as { fingerprint?: Partial<FingerprintConfig> }).fingerprint ?? {}
    : {};
  const publicApiKey = env.FINGERPRINT_PUBLIC_KEY ?? local.publicApiKey;
  const secretApiKey = env.FINGERPRINT_SECRET_KEY ?? local.secretApiKey;
  if (!publicApiKey || !secretApiKey || publicApiKey.startsWith('PASTE_') || secretApiKey.startsWith('PASTE_')) return null;
  const region = env.FINGERPRINT_REGION ?? local.region;
  return { publicApiKey, secretApiKey, region: region === 'eu' || region === 'ap' ? region : 'us' };
}

interface FingerprintEvent {
  event_id?: string;
  timestamp?: number;
  identification?: { visitor_id?: string };
  suspect_score?: number;
  bot?: 'bad' | 'good' | 'not_detected';
  vpn?: boolean;
  incognito?: boolean;
  tampering?: boolean;
  virtual_machine?: boolean;
  emulator?: boolean;
  replayed?: boolean;
  ip_address?: string;
  browser_details?: { browser_name?: string; browser_major_version?: string; os?: string; os_version?: string; device?: string };
}

function clusterKey(event: FingerprintEvent, salt: string): string | null {
  if (!event.ip_address) return null;
  const b = event.browser_details ?? {};
  const parts = [event.ip_address, b.browser_name, b.browser_major_version, b.os, b.os_version, b.device];
  return createHash('sha256').update(`${salt}\n${parts.join('|')}`).digest('base64url').slice(0, 22);
}

// `salt`: mixed into the cluster key hash, so stored keys cannot be matched against known IPs.
export function createDeviceCheck(config: FingerprintConfig, salt: string, fetchImpl: typeof fetch = fetch): DeviceCheck {
  return {
    browser: { apiKey: config.publicApiKey, region: config.region },

    async check(eventId, now) {
      if (!/^[\w.-]{1,128}$/.test(eventId)) return { ok: false, error: 'invalid device check' };
      const res = await fetchImpl(`https://${API_HOSTS[config.region]}/v4/events/${encodeURIComponent(eventId)}`, {
        headers: { authorization: `Bearer ${config.secretApiKey}` },
      });
      if (res.status === 404) return { ok: false, error: 'device check not found: reload the page and try again' };
      if (!res.ok) return { ok: false, error: `device check failed (${res.status})` };
      const event = await res.json() as FingerprintEvent;

      const visitorId = event.identification?.visitor_id;
      if (!visitorId) return { ok: false, error: 'device not identified: reload the page and try again' };
      if (!event.timestamp || now - event.timestamp > MAX_EVENT_AGE_MS) return { ok: false, error: 'device check expired: reload the page' };
      if (event.replayed) return { ok: false, error: 'device check already used: reload the page' };
      // Smart signals (missing on plans without them, then simply not enforced).
      if (event.bot === 'bad') return { ok: false, error: 'automated browser detected' };
      if (event.tampering) return { ok: false, error: 'browser tampering detected' };
      if (event.virtual_machine) return { ok: false, error: 'virtual machines are not allowed' };
      if (event.emulator) return { ok: false, error: 'emulators are not allowed' };

      return {
        ok: true,
        visitorId,
        signals: {
          suspectScore: event.suspect_score ?? null,
          vpn: event.vpn === true,
          incognito: event.incognito === true,
          clusterKey: clusterKey(event, salt),
        },
      };
    },
  };
}
