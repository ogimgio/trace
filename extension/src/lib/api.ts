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

// null if the server does not know this device yet (no sync done).
export async function fetchStats(deviceId: string): Promise<DeviceStats | null> {
  const res = await fetch(`${SERVER_URL}/api/devices/${encodeURIComponent(deviceId)}/stats`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Server ${res.status}`);
  return res.json() as Promise<DeviceStats>;
}

// What the shared data is worth right now (server: rewards/claims.ts). `firstDay` / `lastDay` in ms.
export interface Offer {
  points: number;
  amount: string;
  visits: number;
  pages: number;
  days: number;
  activeDays: number;
  firstDay: number | null;
  lastDay: number | null;
  duplicateVisits: number; // uploaded first by another device: not counted
  paidDays: number; // already rewarded: not counted
  copied: boolean; // this history copies another wallet's device: nothing is offered
}

export type PayoutStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'held' | 'rejected';

export interface Payout {
  epoch: number;
  weekStartsAt: number;
  kind: 'weekly' | 'welcome' | 'claim';
  amount: string;
  status: PayoutStatus;
  explorerUrl: string | null;
}

export interface RewardsInfo {
  symbol: string;
  wallet: string | null;
  deviceChecked: boolean; // wallet linked through a device check: only those are paid
  totalReceived: string;
  offer: Offer;
  payouts: Payout[];
  rules: {
    maxPagesPerDay: number;
    pointsPerActiveDay: number;
    minVisitsPerActiveDay: number;
    tokensPerPoint: string;
    historyDays: number;
    welcomeBonus: string;
    welcomeInstallment: string;
    welcomeMinActiveDays: number;
  };
}

// null if the server does not know this device yet (no sync done).
export async function fetchRewards(deviceId: string): Promise<RewardsInfo | null> {
  const res = await fetch(`${SERVER_URL}/api/devices/${encodeURIComponent(deviceId)}/rewards`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Server ${res.status}`);
  return res.json() as Promise<RewardsInfo>;
}

// Requests a one-time code from the server and returns the URL of the page where Phantom signs.
export async function startWalletLink(deviceId: string, action: 'link' | 'unlink') {
  const { url } = await request<{ url: string }>(`/api/devices/${encodeURIComponent(deviceId)}/link-challenge`, {
    method: 'POST',
    body: JSON.stringify({ action }),
  });
  return { url: `${SERVER_URL}${url}` };
}

// Confirms the current offer: the server records the days as paid and sends the payout.
export function claimRewards(deviceId: string) {
  return request<{ payout: Payout; points: number; symbol: string }>(`/api/devices/${encodeURIComponent(deviceId)}/claim`, {
    method: 'POST',
  });
}
