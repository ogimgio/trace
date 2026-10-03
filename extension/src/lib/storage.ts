export type SyncTrigger = 'initial' | 'alarm' | 'retry' | 'startup';

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
  syncing: boolean;
  // Visits uploaded so far in the running sync (shown in the popup).
  syncProgress: { sent: number; total: number } | null;
}

const DEFAULTS: State = {
  deviceId: '',
  consentAt: null,
  lastSyncAt: null,
  lastSyncResult: null,
  syncing: false,
  syncProgress: null,
};

export async function getState(): Promise<State> {
  const stored = (await chrome.storage.local.get(null)) as Partial<State>;
  return { ...DEFAULTS, ...stored };
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
