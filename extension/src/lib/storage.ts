import { DEFAULT_SYNC_INTERVAL_MINUTES } from './config';

export type SyncTrigger = 'initial' | 'manual' | 'alarm' | 'retry';

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
  // Quando l'utente ha accettato; null = nessun consenso, nessuna sincronizzazione.
  consentAt: number | null;
  // Inizio dell'ultima sync riuscita: la prossima invia le visite da qui in poi.
  lastSyncAt: number | null;
  lastSyncResult: SyncResult | null;
  syncIntervalMinutes: number;
  syncing: boolean;
}

const DEFAULTS: State = {
  deviceId: '',
  consentAt: null,
  lastSyncAt: null,
  lastSyncResult: null,
  syncIntervalMinutes: DEFAULT_SYNC_INTERVAL_MINUTES,
  syncing: false,
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
