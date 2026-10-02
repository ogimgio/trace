import express from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { createRewardsRouter, type RewardsOptions } from './rewards/routes.ts';

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

// Gli URL possono essere lunghissimi (data: URL, redirect di login): li tronchiamo invece di scartarli.
const MAX_URL_LENGTH = 8192;

const isString = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max;

const optionalString = (v: unknown, max: number): string | null =>
  typeof v === 'string' ? v.slice(0, max) : null;

function parseVisit(raw: unknown): IncomingVisit | null {
  const v = raw as Record<string, unknown> | null;
  if (!isString(v?.visitId, 64)) return null;
  if (typeof v.url !== 'string' || v.url.length === 0) return null;
  if (typeof v.visitTime !== 'number' || !Number.isFinite(v.visitTime)) return null;
  return {
    visitId: v.visitId,
    url: v.url.slice(0, MAX_URL_LENGTH),
    title: optionalString(v.title, 1024),
    visitTime: Math.round(v.visitTime),
    transition: optionalString(v.transition, 32),
    referringVisitId: optionalString(v.referringVisitId, 64),
  };
}

// Restituisce l'upload validato oppure un messaggio d'errore. Le singole visite malformate
// vengono scartate (e contate) invece di far fallire l'intero blocco.
function parseUpload(body: unknown): Upload | string {
  if (typeof body !== 'object' || body === null) return 'body must be a JSON object';
  const { deviceId, visits } = body as Record<string, unknown>;

  if (!isString(deviceId, 64)) return 'deviceId is required';
  if (!Array.isArray(visits)) return 'visits must be an array';
  if (visits.length > MAX_VISITS_PER_REQUEST) return `max ${MAX_VISITS_PER_REQUEST} visits per request`;

  const parsed = visits.map(parseVisit).filter((v) => v !== null);
  return { deviceId, visits: parsed, skipped: visits.length - parsed.length };
}

export function createApp(db: DatabaseSync, rewards: RewardsOptions = {}) {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  const insertDevice = db.prepare(
    'INSERT INTO devices (id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING',
  );
  const insertVisit = db.prepare(`
    INSERT INTO visits (device_id, visit_id, url, title, visit_time, transition, referring_visit_id, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id, visit_id) DO NOTHING
  `);
  const touchDevice = db.prepare('UPDATE devices SET last_sync_at = ? WHERE id = ?');
  const insertUpload = db.prepare(
    'INSERT INTO uploads (device_id, received_at, visits_received, visits_inserted) VALUES (?, ?, ?, ?)',
  );
  const selectStats = db.prepare(`
    SELECT d.id, d.created_at, d.last_sync_at,
           COUNT(v.visit_id) AS total_visits,
           MIN(v.visit_time) AS first_visit_at,
           MAX(v.visit_time) AS last_visit_at
    FROM devices d
    LEFT JOIN visits v ON v.device_id = d.id
    WHERE d.id = ?
    GROUP BY d.id
  `);
  const deleteDevice = db.prepare('DELETE FROM devices WHERE id = ?');

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Riceve un blocco di visite. Le visite già presenti (stesso device + visitId)
  // vengono ignorate, quindi l'estensione può ritentare un invio senza duplicati.
  app.post('/api/visits', (req, res) => {
    const upload = parseUpload(req.body);
    if (typeof upload === 'string') {
      res.status(400).json({ error: upload });
      return;
    }

    const now = Date.now();
    let inserted = 0;
    db.exec('BEGIN');
    try {
      insertDevice.run(upload.deviceId, now);
      for (const v of upload.visits) {
        const result = insertVisit.run(
          upload.deviceId, v.visitId, v.url, v.title, v.visitTime, v.transition, v.referringVisitId, now,
        );
        inserted += Number(result.changes);
      }
      touchDevice.run(now, upload.deviceId);
      insertUpload.run(upload.deviceId, now, upload.visits.length + upload.skipped, inserted);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    res.json({ received: upload.visits.length + upload.skipped, inserted, skipped: upload.skipped });
  });

  app.get('/api/devices/:id/stats', (req, res) => {
    const row = selectStats.get(req.params.id) as Record<string, number | string | null> | undefined;
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

  // Cancella il device e (a cascata) tutte le sue visite.
  app.delete('/api/devices/:id', (req, res) => {
    const result = deleteDevice.run(req.params.id);
    res.json({ deleted: Number(result.changes) > 0 });
  });

  app.use(createRewardsRouter(db, rewards));

  return app;
}
