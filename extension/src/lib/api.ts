import { SERVER_URL } from './config';
import type { VisitRecord } from './history';

export interface DeviceStats {
  deviceId: string;
  createdAt: number;
  lastSyncAt: number | null;
  totalVisits: number;
  firstVisitAt: number | null;
  lastVisitAt: number | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!res.ok) throw new Error(`Server ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export function uploadVisits(deviceId: string, visits: VisitRecord[]) {
  return request<{ received: number; inserted: number }>('/api/visits', {
    method: 'POST',
    body: JSON.stringify({ deviceId, visits }),
  });
}

// null se il server non conosce ancora questo device (nessuna sync fatta).
export async function fetchStats(deviceId: string): Promise<DeviceStats | null> {
  const res = await fetch(`${SERVER_URL}/api/devices/${encodeURIComponent(deviceId)}/stats`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Server ${res.status}`);
  return res.json() as Promise<DeviceStats>;
}

export function deleteDeviceData(deviceId: string) {
  return request<{ deleted: boolean }>(`/api/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
}

export interface RewardsInfo {
  symbol: string;
  wallet: string | null;
  totalReceived: string;
  currentWeek: {
    epoch: number;
    startsAt: number;
    endsAt: number;
    payableFrom: number; // la settimana viene pagata da questo momento in poi
    pages: number;
    activeDays: number;
    points: number;
    maxReward: string;
    weeklyBudget: string;
  };
  payouts: {
    epoch: number;
    weekStartsAt: number;
    kind: 'weekly' | 'welcome';
    amount: string;
    status: 'pending' | 'sending' | 'sent' | 'failed';
    explorerUrl: string | null;
  }[];
  rules: {
    maxPages: number;
    pointsPerActiveDay: number;
    minVisitsPerActiveDay: number;
    maxTokensPerPoint: string;
    welcomeBonus: string;
    welcomeMinActiveDays: number;
  };
}

// null se il server non conosce ancora questo device (nessuna sync fatta).
export async function fetchRewards(deviceId: string): Promise<RewardsInfo | null> {
  const res = await fetch(`${SERVER_URL}/api/devices/${encodeURIComponent(deviceId)}/rewards`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Server ${res.status}`);
  return res.json() as Promise<RewardsInfo>;
}

// Chiede al server un codice monouso e restituisce l'URL della pagina dove Phantom firma.
export async function startWalletLink(deviceId: string, action: 'link' | 'unlink') {
  const { url } = await request<{ url: string }>(`/api/devices/${encodeURIComponent(deviceId)}/link-challenge`, {
    method: 'POST',
    body: JSON.stringify({ action }),
  });
  return { url: `${SERVER_URL}${url}` };
}
