import express from 'express';
import { resolve } from 'node:path';
import type { Sql } from './db.ts';
import { formatUnits } from './solana/rewards.ts';
import { createRewardsRouter, type RewardsOptions } from './rewards/routes.ts';
import { createLimiter, DEFAULT_RATE_LIMITS, type RateLimits } from './ratelimit.ts';

export interface AppOptions extends RewardsOptions {
  // Per-IP limits (see ratelimit.ts); false disables them (tests).
  rateLimits?: RateLimits | false;
  // Salt for hashing IPs before they are stored.
  ipSalt?: string;
}

export const MAX_VISITS_PER_REQUEST = 5000;

interface IncomingVisit {
  visitId: string;
  url: string;
  title: string | null;
  visitTime: number;
  transition: string | null;
  referringVisitId: string | null;
}

interface Upload {
  deviceId: string;
  visits: IncomingVisit[];
  skipped: number;
}

// URLs can be very long (data: URLs, login redirects): truncate them instead of dropping them.
const MAX_URL_LENGTH = 8192;

const isString = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max;

// Postgres does not accept the NUL character in text.
const clean = (s: string) => s.replaceAll('\u0000', '');

const optionalString = (v: unknown, max: number): string | null =>
  typeof v === 'string' ? clean(v.slice(0, max)) : null;

function parseVisit(raw: unknown): IncomingVisit | null {
  const v = raw as Record<string, unknown> | null;
  if (!isString(v?.visitId, 64)) return null;
  if (typeof v.url !== 'string' || v.url.length === 0) return null;
  if (typeof v.visitTime !== 'number' || !Number.isFinite(v.visitTime)) return null;
  return {
    visitId: v.visitId,
    url: clean(v.url.slice(0, MAX_URL_LENGTH)),
    title: optionalString(v.title, 1024),
    visitTime: Math.round(v.visitTime),
    transition: optionalString(v.transition, 32),
    referringVisitId: optionalString(v.referringVisitId, 64),
  };
}

// Returns the validated upload or an error message. Individual malformed visits
// are dropped (and counted) instead of failing the whole batch.
function parseUpload(body: unknown): Upload | string {
  if (typeof body !== 'object' || body === null) return 'body must be a JSON object';
  const { deviceId, visits } = body as Record<string, unknown>;

  if (!isString(deviceId, 64)) return 'deviceId is required';
  if (!Array.isArray(visits)) return 'visits must be an array';
  if (visits.length > MAX_VISITS_PER_REQUEST) return `max ${MAX_VISITS_PER_REQUEST} visits per request`;

  const parsed = visits.map(parseVisit).filter((v) => v !== null);
  return { deviceId, visits: parsed, skipped: visits.length - parsed.length };
}

// Visits inserted per query (Postgres allows at most 65535 parameters per query).
const INSERT_CHUNK = 1000;

export function createApp(sql: Sql, { rateLimits = DEFAULT_RATE_LIMITS, ipSalt = 'trace', ...rewards }: AppOptions = {}) {
  const app = express();
  const limiter = createLimiter(sql, rateLimits, ipSalt, rewards.now ?? Date.now);
  app.use(express.json({ limit: '25mb' }));
  // Local only; on Vercel public/ is served by the CDN, but "/" still reaches us.
  app.use(express.static(resolve(import.meta.dirname, '../public')));
  app.get('/', (_req, res) => res.redirect(302, '/index.html'));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Public, aggregate-only numbers for the landing page (no per-user data). Cached for a minute at the CDN.
  app.get('/api/stats', async (_req, res) => {
    const [row] = await sql<{ devices: number; visits: number; paid: string; payouts: number }[]>`
      SELECT (SELECT COUNT(*) FROM devices) AS devices,
             (SELECT COUNT(*) FROM visits) AS visits,
             (SELECT COALESCE(SUM(amount), 0) FROM reward_payouts WHERE status = 'sent') AS paid,
             (SELECT COUNT(*) FROM reward_payouts WHERE status = 'sent') AS payouts
    `;
    res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    res.json({
      devices: row.devices,
      visitsShared: row.visits,
      payouts: row.payouts,
      tokensPaid: formatUnits(BigInt(row.paid), rewards.decimals ?? 6),
    });
  });

  // Receives a batch of visits. Visits already stored (same device + visitId)
  // are ignored, so the extension can retry an upload without creating duplicates.
  app.post('/api/visits', limiter.middleware('uploads'), async (req, res) => {
    const upload = parseUpload(req.body);
    if (typeof upload === 'string') {
      res.status(400).json({ error: upload });
      return;
    }

    // Creating devices is what a script farming rewards does in bulk: few new devices per IP.
    const [known] = await sql`SELECT 1 FROM devices WHERE id = ${upload.deviceId}`;
    if (!known && !(await limiter.check(req, res, 'newDevices'))) return;

    const now = Date.now();
    const rows = upload.visits.map((v) => ({
      device_id: upload.deviceId,
      visit_id: v.visitId,
      url: v.url,
      title: v.title,
      visit_time: v.visitTime,
      transition: v.transition,
      referring_visit_id: v.referringVisitId,
      received_at: now,
    }));

    const inserted = await sql.begin(async (tx) => {
      await tx`INSERT INTO devices (id, created_at) VALUES (${upload.deviceId}, ${now}) ON CONFLICT (id) DO NOTHING`;
      let count = 0;
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        const result = await tx`
          INSERT INTO visits ${tx(rows.slice(i, i + INSERT_CHUNK))}
          ON CONFLICT (device_id, visit_id) DO NOTHING
        `;
        count += result.count;
      }
      await tx`UPDATE devices SET last_sync_at = ${now} WHERE id = ${upload.deviceId}`;
      await tx`
        INSERT INTO uploads (device_id, received_at, visits_received, visits_inserted)
        VALUES (${upload.deviceId}, ${now}, ${upload.visits.length + upload.skipped}, ${count})
      `;
      return count;
    });

    res.json({ received: upload.visits.length + upload.skipped, inserted, skipped: upload.skipped });
  });

  app.get('/api/devices/:id/stats', async (req, res) => {
    const [row] = await sql`
      SELECT d.id, d.created_at, d.last_sync_at,
             COUNT(v.visit_id) AS total_visits,
             MIN(v.visit_time) AS first_visit_at,
             MAX(v.visit_time) AS last_visit_at
      FROM devices d
      LEFT JOIN visits v ON v.device_id = d.id
      WHERE d.id = ${req.params.id}
      GROUP BY d.id
    `;
    if (!row) {
      res.status(404).json({ error: 'device not found' });
      return;
    }
    res.json({
      deviceId: row.id,
      createdAt: row.created_at,
      lastSyncAt: row.last_sync_at,
      totalVisits: row.total_visits,
      firstVisitAt: row.first_visit_at,
      lastVisitAt: row.last_visit_at,
    });
  });

  app.post(['/api/devices/:id/link-challenge', '/api/link/:code', '/api/link/:code/worldid/start', '/api/link/:code/worldid'],
    limiter.middleware('links'));
  app.use(createRewardsRouter(sql, rewards));

  return app;
}
