import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';

// Postgres (Supabase in production, PGlite in tests). Times are Unix milliseconds in bigint columns;
// token amounts are numeric (base units) and arrive as strings, to be converted with BigInt().
export type Sql = postgres.Sql<{ bigint: number }>;

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS devices (
    id              text PRIMARY KEY,
    created_at      bigint NOT NULL,
    last_sync_at    bigint,
    wallet_address  text
  );

  CREATE TABLE IF NOT EXISTS visits (
    device_id           text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    visit_id            text NOT NULL,
    url                 text NOT NULL,
    title               text,
    visit_time          bigint NOT NULL,
    transition          text,
    referring_visit_id  text,
    received_at         bigint NOT NULL,
    PRIMARY KEY (device_id, visit_id)
  );

  CREATE INDEX IF NOT EXISTS visits_device_time ON visits (device_id, visit_time);
  -- Duplicate check: the same visit (url + exact visit_time) uploaded by several devices.
  CREATE INDEX IF NOT EXISTS visits_time ON visits (visit_time);

  CREATE TABLE IF NOT EXISTS uploads (
    id               bigserial PRIMARY KEY,
    device_id        text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    received_at      bigint NOT NULL,
    visits_received  integer NOT NULL,
    visits_inserted  integer NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reward_epochs (
    epoch         integer PRIMARY KEY,
    budget        numeric(40, 0) NOT NULL,
    total_points  integer NOT NULL,
    distributed   numeric(40, 0) NOT NULL,
    settled_at    bigint NOT NULL
  );

  -- Payouts are kept even if the user deletes their data: they are the record of what was sent.
  CREATE TABLE IF NOT EXISTS reward_payouts (
    id          bigserial PRIMARY KEY,
    epoch       integer NOT NULL,
    device_id   text NOT NULL,
    wallet      text NOT NULL,
    kind        text NOT NULL,
    points      integer NOT NULL,
    amount      numeric(40, 0) NOT NULL,
    status      text NOT NULL,
    signature   text,
    error       text,
    created_at  bigint NOT NULL,
    sent_at     bigint
  );

  -- 'held': waiting for manual review (risky device, see rewards/risk.ts); 'rejected': refused on review.
  ALTER TABLE reward_payouts ADD COLUMN IF NOT EXISTS hold_reason text;
  ALTER TABLE reward_payouts DROP CONSTRAINT IF EXISTS reward_payouts_status_check;
  ALTER TABLE reward_payouts ADD CONSTRAINT reward_payouts_status_check
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'held', 'rejected'));

  -- 'claim': shared data claimed from the extension (rewards/claims.ts), any number per device and week.
  -- The weekly kinds stay at most one per device per week.
  ALTER TABLE reward_payouts DROP CONSTRAINT IF EXISTS reward_payouts_kind_check;
  ALTER TABLE reward_payouts ADD CONSTRAINT reward_payouts_kind_check CHECK (kind IN ('weekly', 'welcome', 'claim'));
  ALTER TABLE reward_payouts DROP CONSTRAINT IF EXISTS reward_payouts_epoch_device_id_kind_key;
  CREATE UNIQUE INDEX IF NOT EXISTS reward_payouts_one_per_week ON reward_payouts (epoch, device_id, kind) WHERE kind <> 'claim';

  -- Shared days already paid, per wallet: each UTC day of browsing is paid once, whichever device or
  -- install uploads it (rewards/claims.ts).
  CREATE TABLE IF NOT EXISTS reward_days (
    wallet     text NOT NULL,
    day        integer NOT NULL,
    device_id  text NOT NULL,
    points     integer NOT NULL,
    payout_id  bigint NOT NULL,
    PRIMARY KEY (wallet, day)
  );

  -- The welcome bonus is paid in weekly installments: at most one per wallet per week
  -- (one per device per week is guaranteed by reward_payouts_one_per_week).
  DROP INDEX IF EXISTS reward_payouts_one_welcome;
  DROP INDEX IF EXISTS reward_payouts_one_welcome_per_wallet;
  CREATE UNIQUE INDEX IF NOT EXISTS reward_payouts_welcome_wallet_week ON reward_payouts (epoch, wallet) WHERE kind = 'welcome';
  CREATE INDEX IF NOT EXISTS reward_payouts_device ON reward_payouts (device_id, epoch);

  CREATE TABLE IF NOT EXISTS wallet_challenges (
    code        text PRIMARY KEY,
    device_id   text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    action      text NOT NULL CHECK (action IN ('link', 'unlink')),
    wallet      text,
    created_at  bigint NOT NULL,
    expires_at  bigint NOT NULL,
    used_at     bigint
  );

  -- One device, one wallet: Fingerprint's visitor ID (a stable browser/device identifier) bound to the first
  -- wallet linked from it. A wallet may have several devices. Signals are kept from the latest check.
  CREATE TABLE IF NOT EXISTS device_fingerprints (
    visitor_id     text PRIMARY KEY,
    wallet         text NOT NULL,
    first_seen_at  bigint NOT NULL,
    last_seen_at   bigint NOT NULL,
    suspect_score  integer,
    vpn            boolean NOT NULL DEFAULT false,
    incognito      boolean NOT NULL DEFAULT false,
    cluster_key    text
  );

  CREATE INDEX IF NOT EXISTS device_fingerprints_wallet ON device_fingerprints (wallet);
  CREATE INDEX IF NOT EXISTS device_fingerprints_cluster ON device_fingerprints (cluster_key);

  -- Extension installs (device IDs) linked from each device: a browser that keeps reinstalling the
  -- extension to start fresh histories is limited per month.
  CREATE TABLE IF NOT EXISTS device_extensions (
    visitor_id  text NOT NULL,
    device_id   text NOT NULL,
    linked_at   bigint NOT NULL,
    PRIMARY KEY (visitor_id, device_id)
  );

  -- Link attempts refused because the device already belongs to another wallet: a device that keeps
  -- trying new wallets gets its own wallet's payouts held for review.
  CREATE TABLE IF NOT EXISTS device_link_rejections (
    id          bigserial PRIMARY KEY,
    visitor_id  text NOT NULL,
    wallet      text NOT NULL,
    created_at  bigint NOT NULL
  );

  CREATE INDEX IF NOT EXISTS device_link_rejections_visitor ON device_link_rejections (visitor_id, created_at);

  -- Fingerprint event IDs already used to link: each device check counts once.
  CREATE TABLE IF NOT EXISTS fingerprint_events (
    event_id  text PRIMARY KEY,
    used_at   bigint NOT NULL
  );

  -- Every link and unlink, so the full wallet ↔ device history is known even after a wallet is replaced.
  CREATE TABLE IF NOT EXISTS wallet_links (
    id          bigserial PRIMARY KEY,
    device_id   text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    wallet      text NOT NULL,
    action      text NOT NULL CHECK (action IN ('link', 'unlink')),
    created_at  bigint NOT NULL
  );

  CREATE INDEX IF NOT EXISTS wallet_links_wallet ON wallet_links (wallet);
  CREATE INDEX IF NOT EXISTS wallet_links_device ON wallet_links (device_id);

  -- Rate limit counters per (rule, hashed IP, time window). Raw IPs are never stored; rows are purged daily.
  CREATE TABLE IF NOT EXISTS rate_limits (
    rule          text NOT NULL,
    key           text NOT NULL,
    window_start  bigint NOT NULL,
    count         integer NOT NULL,
    PRIMARY KEY (rule, key, window_start)
  );

  -- Supabase exposes "public" tables via its API with the anon key. With RLS enabled and no policies
  -- that access is closed: only the server, which connects as the table owner, reads and writes.
  ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
  ALTER TABLE visits ENABLE ROW LEVEL SECURITY;
  ALTER TABLE uploads ENABLE ROW LEVEL SECURITY;
  ALTER TABLE reward_epochs ENABLE ROW LEVEL SECURITY;
  ALTER TABLE reward_payouts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE wallet_challenges ENABLE ROW LEVEL SECURITY;
  ALTER TABLE wallet_links ENABLE ROW LEVEL SECURITY;
  ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
  ALTER TABLE device_fingerprints ENABLE ROW LEVEL SECURITY;
  ALTER TABLE fingerprint_events ENABLE ROW LEVEL SECURITY;
  ALTER TABLE device_extensions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE device_link_rejections ENABLE ROW LEVEL SECURITY;
  ALTER TABLE reward_days ENABLE ROW LEVEL SECURITY;
`;

export function connect(url: string, options: postgres.Options<{}> = {}): Sql {
  return postgres(url, {
    // Supabase's pooler in transaction mode does not support prepared statements.
    prepare: false,
    // In serverless functions each instance keeps only a few connections.
    max: 3,
    idle_timeout: 20,
    onnotice: () => {},
    // bigint as number: they are ms timestamps and counters, well below 2^53.
    types: {
      bigint: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
    },
    ...options,
  }) as unknown as Sql;
}

export async function migrate(sql: Sql) {
  await sql.unsafe(SCHEMA);
}

// DATABASE_URL, or databaseUrl in server/.secrets/supabase.json (written by the local setup).
export function databaseUrl(env = process.env): string {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const file = resolve(import.meta.dirname, '../.secrets/supabase.json');
  const url = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { databaseUrl?: string }).databaseUrl : undefined;
  if (!url) throw new Error('DATABASE_URL not set (nor in server/.secrets/supabase.json)');
  return url;
}
