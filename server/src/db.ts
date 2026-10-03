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
    kind        text NOT NULL CHECK (kind IN ('weekly', 'welcome')),
    points      integer NOT NULL,
    amount      numeric(40, 0) NOT NULL,
    status      text NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
    signature   text,
    error       text,
    created_at  bigint NOT NULL,
    sent_at     bigint,
    UNIQUE (epoch, device_id, kind)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS reward_payouts_one_welcome ON reward_payouts (device_id) WHERE kind = 'welcome';
  CREATE UNIQUE INDEX IF NOT EXISTS reward_payouts_one_welcome_per_wallet ON reward_payouts (wallet) WHERE kind = 'welcome';
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

  -- Device check (Fingerprint): the visitor ID of the browser that linked the wallet. Devices linked before the
  -- check existed have none and must verify again to keep earning (rewards/routes.ts).
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS visitor_id text;
  CREATE INDEX IF NOT EXISTS devices_visitor ON devices (visitor_id);

  -- The welcome bonus is paid once per browser too: reinstalling the extension does not earn it again.
  ALTER TABLE reward_payouts ADD COLUMN IF NOT EXISTS visitor_id text;
  CREATE UNIQUE INDEX IF NOT EXISTS reward_payouts_one_welcome_per_visitor ON reward_payouts (visitor_id)
    WHERE kind = 'welcome' AND visitor_id IS NOT NULL;

  -- Each Fingerprint event can be used once.
  CREATE TABLE IF NOT EXISTS fingerprint_events (
    event_id  text PRIMARY KEY,
    used_at   bigint NOT NULL
  );

  -- Finds the same visit uploaded by another device (rewards/settle.ts: each visit is paid once).
  CREATE INDEX IF NOT EXISTS visits_time ON visits (visit_time);

  -- Supabase exposes "public" tables via its API with the anon key. With RLS enabled and no policies
  -- that access is closed: only the server, which connects as the table owner, reads and writes.
  ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
  ALTER TABLE visits ENABLE ROW LEVEL SECURITY;
  ALTER TABLE uploads ENABLE ROW LEVEL SECURITY;
  ALTER TABLE reward_epochs ENABLE ROW LEVEL SECURITY;
  ALTER TABLE reward_payouts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE wallet_challenges ENABLE ROW LEVEL SECURITY;
  ALTER TABLE fingerprint_events ENABLE ROW LEVEL SECURITY;
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
