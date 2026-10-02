import { uploadVisits } from '../lib/api';
import { RETRY_ALARM, RETRY_DELAY_MINUTES, SYNC_ALARM, UPLOAD_BATCH_SIZE } from '../lib/config';
import { collectVisitsSince } from '../lib/history';
import type { Message } from '../lib/messages';
import { ensureDeviceId, getState, setState, type SyncTrigger } from '../lib/storage';

// Un service worker appena avviato non ha sync in corso: azzera un flag rimasto
// a true se il worker precedente è stato terminato a metà.
void setState({ syncing: false });

let currentSync: Promise<void> | null = null;

async function canSync(): Promise<boolean> {
  const { consentAt } = await getState();
  return consentAt !== null && (await chrome.permissions.contains({ permissions: ['history'] }));
}

function runSync(trigger: SyncTrigger): Promise<void> {
  currentSync ??= doSync(trigger).finally(() => {
    currentSync = null;
  });
  return currentSync;
}

async function doSync(trigger: SyncTrigger): Promise<void> {
  if (!(await canSync())) return;

  const deviceId = await ensureDeviceId();
  const { lastSyncAt } = await getState();
  const startedAt = Date.now();
  await setState({ syncing: true });

  let total = 0;
  let inserted = 0;
  try {
    const visits = await collectVisitsSince(lastSyncAt ?? 0);
    total = visits.length;
    for (let i = 0; i < visits.length; i += UPLOAD_BATCH_SIZE) {
      const result = await uploadVisits(deviceId, visits.slice(i, i + UPLOAD_BATCH_SIZE));
      inserted += result.inserted;
    }
    await setState({
      lastSyncAt: startedAt,
      lastSyncResult: { at: Date.now(), trigger, ok: true, visits: total, inserted },
    });
    await chrome.alarms.clear(RETRY_ALARM);
  } catch (err) {
    // lastSyncAt resta invariato: il prossimo tentativo rimanda tutto e il server scarta i duplicati.
    await setState({
      lastSyncResult: { at: Date.now(), trigger, ok: false, visits: total, inserted, error: String(err) },
    });
    await chrome.alarms.create(RETRY_ALARM, { delayInMinutes: RETRY_DELAY_MINUTES });
  } finally {
    await setState({ syncing: false });
  }
}

async function scheduleSync(): Promise<void> {
  const { syncIntervalMinutes } = await getState();
  const existing = await chrome.alarms.get(SYNC_ALARM);
  if (existing?.periodInMinutes === syncIntervalMinutes) return;
  await chrome.alarms.create(SYNC_ALARM, {
    delayInMinutes: syncIntervalMinutes,
    periodInMinutes: syncIntervalMinutes,
  });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await ensureDeviceId();
  await scheduleSync();
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) {
    // Pagina di benvenuto in una scheda: il dialog dei permessi non la chiude, a differenza del popup.
    await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?onboarding=1') });
  }
});

chrome.runtime.onStartup.addListener(() => {
  void scheduleSync();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) void runSync('alarm');
  if (alarm.name === RETRY_ALARM) void runSync('retry');
});

// Il permesso "history" è opzionale e viene richiesto solo dal bottone di consenso nel popup.
// Gestirlo qui fa partire la prima sync anche se il popup si chiude durante il dialog.
chrome.permissions.onAdded.addListener(async ({ permissions }) => {
  if (!permissions?.includes('history')) return;
  const { consentAt } = await getState();
  if (consentAt === null) await setState({ consentAt: Date.now() });
  void runSync('initial');
});

chrome.permissions.onRemoved.addListener(async ({ permissions }) => {
  if (!permissions?.includes('history')) return;
  await setState({ consentAt: null, lastSyncAt: null });
  await chrome.alarms.clear(RETRY_ALARM);
});

chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  switch (message.type) {
    case 'sync-now':
      void runSync('manual');
      sendResponse({ ok: true });
      return;
    case 'reschedule':
      scheduleSync().then(() => sendResponse({ ok: true }));
      return true;
  }
});
