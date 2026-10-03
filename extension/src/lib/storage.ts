import { DEFAULT_SYNC_INTERVAL_MINUTES, MAX_SYNC_INTERVAL_MINUTES } from './config';

export type SyncTrigger = 'initial' | 'manual' | 'alarm' | 'retry' | 'startup';

export interface SyncResult {
  at: number;
  trigger: SyncTrigger;
  ok: boolean;
  visits: number;
  inserted: number;
  error?: string;
}

export interface State {
  deviceId: string;
  // When the user consented; null = no consent, no syncing.
  consentAt: number | null;
  // Start of the last successful sync: the next one sends visits from here on.
  lastSyncAt: number | null;
  lastSyncResult: SyncResult | null;
  syncIntervalMinutes: number;
  syncing: boolean;
  // Popup modals: the wallet already congratulated, the offer the user chose not to claim yet, and the
  // last sync whose result was shown.
  knownWallet: string | null;
  dismissedOffer: string | null;
  lastSyncSeen: number | null;
  // Bumped when the link page reports a wallet change, so open popups refresh.
  walletChangedAt: number | null;
}

const DEFAULTS: State = {
  deviceId: '',
  consentAt: null,
  lastSyncAt: null,
  lastSyncResult: null,
  syncIntervalMinutes: DEFAULT_SYNC_INTERVAL_MINUTES,
  syncing: false,
  knownWallet: null,
  dismissedOffer: null,
  lastSyncSeen: null,
  walletChangedAt: null,
};

export async function getState(): Promise<State> {
  const stored = (await chrome.storage.local.get(null)) as Partial<State>;
  const state = { ...DEFAULTS, ...stored };
  // Older installs stored a weekly interval: clamp it, or their visits would arrive too late to earn rewards.
  return { ...state, syncIntervalMinutes: Math.min(state.syncIntervalMinutes, MAX_SYNC_INTERVAL_MINUTES) };
}

export function setState(patch: Partial<State>): Promise<void> {
  return chrome.storage.local.set(patch);
}

export async function ensureDeviceId(): Promise<string> {
  const { deviceId } = await getState();
  if (deviceId) return deviceId;
  const id = crypto.randomUUID();
  await setState({ deviceId: id });
  return id;
}
