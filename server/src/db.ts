import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';

// Postgres (Supabase in produzione, PGlite nei test). I tempi sono millisecondi Unix in colonne bigint;
// gli importi dei token sono numeric (unità base) e arrivano come stringhe, da convertire con BigInt().
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

  -- I pagamenti restano anche se l'utente cancella i propri dati: sono il registro di cosa è stato inviato.
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

  -- Supabase espone le tabelle di "public" via API con la chiave anonima. Con RLS attivo e nessuna policy
  -- quell'accesso è chiuso: solo il server, che si collega come proprietario delle tabelle, legge e scrive.
  ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
  ALTER TABLE visits ENABLE ROW LEVEL SECURITY;
  ALTER TABLE uploads ENABLE ROW LEVEL SECURITY;
  ALTER TABLE reward_epochs ENABLE ROW LEVEL SECURITY;
  ALTER TABLE reward_payouts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE wallet_challenges ENABLE ROW LEVEL SECURITY;
`;

export function connect(url: string, options: postgres.Options<{}> = {}): Sql {
  return postgres(url, {
    // Il pooler di Supabase in modalità transaction non supporta i prepared statement.
    prepare: false,
    // Nelle funzioni serverless ogni istanza tiene poche connessioni.
    max: 3,
    idle_timeout: 20,
    onnotice: () => {},
    // bigint come number: sono timestamp in ms e contatori, ben sotto 2^53.
    types: {
      bigint: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
    },
    ...options,
  }) as unknown as Sql;
}

export async function migrate(sql: Sql) {
  await sql.unsafe(SCHEMA);
}

// DATABASE_URL, oppure databaseUrl in server/.secrets/supabase.json (scritto dal setup locale).
export function databaseUrl(env = process.env): string {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const file = resolve(import.meta.dirname, '../.secrets/supabase.json');
  const url = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { databaseUrl?: string }).databaseUrl : undefined;
  if (!url) throw new Error('DATABASE_URL non impostato (né in server/.secrets/supabase.json)');
  return url;
}
