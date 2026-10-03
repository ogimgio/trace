import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Device check with Fingerprint (adapted from the dev_eb branch).
//
// 1. The signing page loads Fingerprint's agent with the public key and gets an event ID for this visit.
// 2. It sends the event ID with the wallet signature. The server fetches the event with the secret key
//    (so the page cannot fake it) and gets the visitor ID: a stable identifier of the browser and device
//    that survives reinstalling the extension, cleared cookies, incognito mode and a new IP.
// 3. Bots, tampered browsers, virtual machines, emulators and stale or replayed events are refused.
// The visitor ID is what makes the welcome bonus "once per browser" (see rewards/settle.ts).

export type FingerprintRegion = 'us' | 'eu' | 'ap';

export interface FingerprintConfig {
  publicApiKey: string; // used in the browser: not secret
  secretApiKey: string; // server only
  region: FingerprintRegion;
}

export type DeviceVerdict = { ok: true; visitorId: string } | { ok: false; error: string };

export interface DeviceCheck {
  // What the signing page needs to load the agent (no secrets).
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
  if (!publicApiKey || !secretApiKey) return null;
  const region = env.FINGERPRINT_REGION ?? local.region;
  return { publicApiKey, secretApiKey, region: region === 'eu' || region === 'ap' ? region : 'us' };
}

interface FingerprintEvent {
  timestamp?: number;
  identification?: { visitor_id?: string };
  bot?: 'bad' | 'good' | 'not_detected';
  tampering?: boolean;
  virtual_machine?: boolean;
  emulator?: boolean;
  replayed?: boolean;
}

export function createDeviceCheck(config: FingerprintConfig, fetchImpl: typeof fetch = fetch): DeviceCheck {
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
      // Smart signals (absent on plans without them, then simply not enforced).
      if (event.bot === 'bad') return { ok: false, error: 'automated browser detected' };
      if (event.tampering) return { ok: false, error: 'browser tampering detected' };
      if (event.virtual_machine) return { ok: false, error: 'virtual machines are not allowed' };
      if (event.emulator) return { ok: false, error: 'emulators are not allowed' };

      return { ok: true, visitorId };
    },
  };
}
