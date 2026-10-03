import { CLOCK_SKEW_MS, LIVE_WINDOW_MS, NEAR_DUPLICATE_MIN_KEYS, NEAR_DUPLICATE_OVERLAP } from './policy.ts';
import { pageKey, type ScoredVisit } from './points.ts';

// Decides which of a week's visits may earn rewards. Run on all devices at once (with or without a wallet),
// because duplicates are found by comparing devices with each other.
//
// 1. Live only (for the weekly welcome bonus): a visit counts if it reached the server within LIVE_WINDOW_MS.
// 2. Exact duplicates: the same URL at the same millisecond on several devices is one visit copied around.
//    It counts once, for the device that uploaded it first; the copies count for nobody.
// 3. Near duplicates: a device whose (page, minute) keys mostly match another device's is a copy with
//    shifted timestamps. The device seen later earns nothing that week.

// Wherever duplicates are checked: the weekly welcome bonus and shared-history claims (claims.ts).
export interface WeekVisit extends ScoredVisit {
  deviceId: string;
  receivedAt: number;
}

export interface Eligibility {
  visits: Map<string, ScoredVisit[]>; // per device: the visits that count
  exactDuplicates: Map<string, number>; // per device: visits dropped as copies of another device's
  nearDuplicateOf: Map<string, string>; // copy device → the device it copies
}

// A key shared by more devices than this is a popular page at a busy minute, not a sign of copying.
// Skipping it also keeps the pair count from growing quadratically.
const MAX_DEVICES_PER_KEY = 50;

export function isLive(v: Pick<WeekVisit, 'visitTime' | 'receivedAt'>): boolean {
  return v.receivedAt - v.visitTime <= LIVE_WINDOW_MS && v.visitTime - v.receivedAt <= CLOCK_SKEW_MS;
}

// `firstSeen`: when each device was created; on a near-duplicate pair the newer device is the copy.
// `liveOnly: false` keeps backfilled history too (shared-history rewards), with the same duplicate rules.
export function checkVisits(visits: Iterable<WeekVisit>, firstSeen: Map<string, number>, { liveOnly = true } = {}): Eligibility {
  const live = liveOnly ? [...visits].filter(isLive) : [...visits];

  // Exact duplicates: the owner of each (url, visitTime) is the earliest upload (device id breaks ties).
  const owners = new Map<string, WeekVisit>();
  for (const v of live) {
    const key = `${v.visitTime}\n${v.url}`;
    const owner = owners.get(key);
    if (!owner || v.receivedAt < owner.receivedAt || (v.receivedAt === owner.receivedAt && v.deviceId < owner.deviceId)) {
      owners.set(key, v);
    }
  }

  const nearDuplicateOf = findNearDuplicates(live, firstSeen);

  const result = new Map<string, ScoredVisit[]>();
  const exactDuplicates = new Map<string, number>();
  for (const v of live) {
    if (nearDuplicateOf.has(v.deviceId)) continue;
    if (owners.get(`${v.visitTime}\n${v.url}`) !== v) {
      exactDuplicates.set(v.deviceId, (exactDuplicates.get(v.deviceId) ?? 0) + 1);
      continue;
    }
    const list = result.get(v.deviceId) ?? [];
    list.push({ url: v.url, visitTime: v.visitTime });
    result.set(v.deviceId, list);
  }

  return { visits: result, exactDuplicates, nearDuplicateOf };
}

function findNearDuplicates(live: WeekVisit[], firstSeen: Map<string, number>): Map<string, string> {
  // (page, minute) keys per device, and the devices sharing each key.
  const keysPerDevice = new Map<string, Set<string>>();
  const devicesPerKey = new Map<string, Set<string>>();
  for (const v of live) {
    const page = pageKey(v.url);
    if (page === null) continue;
    const key = `${Math.floor(v.visitTime / 60_000)} ${page}`;
    let keys = keysPerDevice.get(v.deviceId);
    if (!keys) keysPerDevice.set(v.deviceId, (keys = new Set()));
    keys.add(key);
    let devices = devicesPerKey.get(key);
    if (!devices) devicesPerKey.set(key, (devices = new Set()));
    devices.add(v.deviceId);
  }

  const shared = new Map<string, number>(); // "a\nb" (a < b) → number of common keys
  for (const devices of devicesPerKey.values()) {
    if (devices.size < 2 || devices.size > MAX_DEVICES_PER_KEY) continue;
    const ids = [...devices].sort();
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const pair = `${ids[i]}\n${ids[j]}`;
      shared.set(pair, (shared.get(pair) ?? 0) + 1);
    }
  }

  const copies = new Map<string, string>();
  for (const [pair, common] of shared) {
    const [a, b] = pair.split('\n');
    const smaller = Math.min(keysPerDevice.get(a)!.size, keysPerDevice.get(b)!.size);
    if (smaller < NEAR_DUPLICATE_MIN_KEYS || common / smaller < NEAR_DUPLICATE_OVERLAP) continue;
    const aFirst = (firstSeen.get(a) ?? 0) <= (firstSeen.get(b) ?? 0); // ids are sorted, so a wins ties
    const [original, copy] = aFirst ? [a, b] : [b, a];
    if (!copies.has(copy)) copies.set(copy, original);
  }
  return copies;
}
