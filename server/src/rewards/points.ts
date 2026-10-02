import { MAX_PAGES, MIN_VISITS_PER_ACTIVE_DAY, POINTS_PER_ACTIVE_DAY } from './policy.ts';

export interface ScoredVisit {
  url: string;
  visitTime: number;
}

export interface Score {
  pages: number; // unique pages (domain + path) visited during the week
  activeDays: number; // UTC days with at least MIN_VISITS_PER_ACTIVE_DAY valid visits
  points: number;
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]$|0\.0\.0\.0$)|\.local$|\.internal$/;

// Page key: domain + path, without query and fragment.
// So ?q=1, ?q=2, ... count as a single page and generated URLs cannot inflate points.
// Returns null for anything that is not public web browsing (file://, extensions, localhost, private networks).
export function pageKey(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const host = parsed.hostname.toLowerCase();
  if (PRIVATE_HOST.test(host)) return null;
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${host}${path}`;
}

export function scoreVisits(visits: Iterable<ScoredVisit>): Score {
  const pages = new Set<string>();
  const visitsPerDay = new Map<number, number>();

  for (const visit of visits) {
    const key = pageKey(visit.url);
    if (key === null) continue;
    pages.add(key);
    const day = Math.floor(visit.visitTime / 86_400_000);
    visitsPerDay.set(day, (visitsPerDay.get(day) ?? 0) + 1);
  }

  let activeDays = 0;
  for (const count of visitsPerDay.values()) if (count >= MIN_VISITS_PER_ACTIVE_DAY) activeDays++;

  return {
    pages: pages.size,
    activeDays,
    points: Math.min(pages.size, MAX_PAGES) + POINTS_PER_ACTIVE_DAY * activeDays,
  };
}
