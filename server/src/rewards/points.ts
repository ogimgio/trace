import { MAX_PAGES_PER_DAY, MIN_VISITS_PER_ACTIVE_DAY, POINTS_PER_ACTIVE_DAY, dayAt } from './policy.ts';

export interface ScoredVisit {
  url: string;
  visitTime: number;
}

export interface DayScore {
  day: number; // UTC day number (ms / 86_400_000)
  visits: number; // public web visits that day
  pages: number; // unique pages (domain + path) that day
  active: boolean; // at least MIN_VISITS_PER_ACTIVE_DAY visits
  points: number;
}

export interface Score {
  visits: number;
  pages: number; // sum of each day's unique pages
  days: number;
  activeDays: number;
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

// Day by day: each UTC day with public visits earns min(unique pages, MAX_PAGES_PER_DAY) + POINTS_PER_ACTIVE_DAY
// if it had at least MIN_VISITS_PER_ACTIVE_DAY visits. Days are sorted oldest first.
export function scoreDays(visits: Iterable<ScoredVisit>): DayScore[] {
  const days = new Map<number, { visits: number; pages: Set<string> }>();
  for (const visit of visits) {
    const key = pageKey(visit.url);
    if (key === null) continue;
    const day = dayAt(visit.visitTime);
    let entry = days.get(day);
    if (!entry) days.set(day, (entry = { visits: 0, pages: new Set() }));
    entry.visits++;
    entry.pages.add(key);
  }
  return [...days].sort(([a], [b]) => a - b).map(([day, { visits, pages }]) => {
    const active = visits >= MIN_VISITS_PER_ACTIVE_DAY;
    return { day, visits, pages: pages.size, active, points: Math.min(pages.size, MAX_PAGES_PER_DAY) + (active ? POINTS_PER_ACTIVE_DAY : 0) };
  });
}

export function scoreVisits(visits: Iterable<ScoredVisit>): Score {
  const days = scoreDays(visits);
  return {
    visits: days.reduce((a, d) => a + d.visits, 0),
    pages: days.reduce((a, d) => a + d.pages, 0),
    days: days.length,
    activeDays: days.filter((d) => d.active).length,
    points: days.reduce((a, d) => a + d.points, 0),
  };
}
