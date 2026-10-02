import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS devices (
    id              TEXT PRIMARY KEY,
    created_at      INTEGER NOT NULL,
    last_sync_at    INTEGER,
    wallet_address  TEXT
  );

  CREATE TABLE IF NOT EXISTS visits (
    device_id           TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    visit_id            TEXT NOT NULL,
    url                 TEXT NOT NULL,
    title               TEXT,
    visit_time          INTEGER NOT NULL,
    transition          TEXT,
    referring_visit_id  TEXT,
    received_at         INTEGER NOT NULL,
    PRIMARY KEY (device_id, visit_id)
  );

  CREATE INDEX IF NOT EXISTS visits_device_time ON visits (device_id, visit_time);

  CREATE TABLE IF NOT EXISTS uploads (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id        TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    received_at      INTEGER NOT NULL,
    visits_received  INTEGER NOT NULL,
    visits_inserted  INTEGER NOT NULL
  );
`;

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}
