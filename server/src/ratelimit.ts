import { createHash } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import type { Sql } from './db.ts';

// Per-IP rate limits. Counters live in Postgres because on Vercel several instances serve requests in
// parallel: an in-memory counter would reset with every cold start and differ between instances.
// IPs are stored only as a salted hash, and rows are purged by the daily job.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface RateRule {
  limit: number;
  windowMs: number;
}

export interface RateLimits {
  uploads: RateRule; // POST /api/visits: the first sync sends up to ~90 days of history in batches of 1000
  newDevices: RateRule; // devices created: the main brake on scripts minting thousands of fake devices
  links: RateRule; // wallet link challenges and signature submissions
}

export const DEFAULT_RATE_LIMITS: RateLimits = {
  uploads: { limit: 120, windowMs: HOUR_MS },
  // A household or an office shares one IP: a few new devices a day is plenty for real people.
  newDevices: { limit: 5, windowMs: DAY_MS },
  links: { limit: 30, windowMs: HOUR_MS },
};

const RETENTION_MS = 2 * DAY_MS;

// On Vercel x-real-ip and x-forwarded-for are set by the platform, which overwrites what the client sends.
// Behind another proxy (or none) these headers could be forged: adapt this before deploying elsewhere.
export function clientIp(req: Request): string {
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real) return real;
  const forwarded = req.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'unknown';
}

export const hashIp = (ip: string, salt: string) => createHash('sha256').update(`${salt}\n${ip}`).digest('base64url').slice(0, 22);

// Counts one hit with a single atomic upsert, so parallel requests and instances never both slip through.
export async function hit(sql: Sql, rule: string, key: string, { limit, windowMs }: RateRule, now: number) {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const [row] = await sql<{ count: number }[]>`
    INSERT INTO rate_limits (rule, key, window_start, count) VALUES (${rule}, ${key}, ${windowStart}, 1)
    ON CONFLICT (rule, key, window_start) DO UPDATE SET count = rate_limits.count + 1
    RETURNING count
  `;
  return { ok: row.count <= limit, retryAfterMs: windowStart + windowMs - now };
}

export interface Limiter {
  middleware(rule: keyof RateLimits): RequestHandler;
  // For checks that depend on the request body (e.g. "is this a new device?"). Returns false if over the limit.
  check(req: Request, res: Response, rule: keyof RateLimits): Promise<boolean>;
}

export function createLimiter(sql: Sql, limits: RateLimits | false, salt: string, now: () => number): Limiter {
  const check: Limiter['check'] = async (req, res, rule) => {
    if (!limits) return true;
    const result = await hit(sql, rule, hashIp(clientIp(req), salt), limits[rule], now());
    if (result.ok) return true;
    res.set('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
    res.status(429).json({ error: 'too many requests from this network, try again later' });
    return false;
  };
  return {
    check,
    middleware: (rule) => async (req, res, next) => {
      if (await check(req, res, rule)) next();
    },
  };
}

export async function purgeRateLimits(sql: Sql, now: number): Promise<number> {
  const result = await sql`DELETE FROM rate_limits WHERE window_start < ${now - RETENTION_MS}`;
  return result.count;
}
