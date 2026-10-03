import { uploadVisits } from '../lib/api';
import { RETRY_ALARM, RETRY_DELAY_MINUTES, SYNC_ALARM, SYNC_INTERVAL_MINUTES, UPLOAD_BATCH_SIZE } from '../lib/config';
import { collectVisitsSince } from '../lib/history';
import { ensureDeviceId, getState, setState, type SyncTrigger } from '../lib/storage';

// A freshly started service worker has no sync in progress: reset a flag left
// at true if the previous worker was killed midway.
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
    // lastSyncAt stays unchanged: the next attempt resends everything and the server drops duplicates.
    await setState({
      lastSyncResult: { at: Date.now(), trigger, ok: false, visits: total, inserted, error: String(err) },
    });
    await chrome.alarms.create(RETRY_ALARM, { delayInMinutes: RETRY_DELAY_MINUTES });
  } finally {
    await setState({ syncing: false });
  }
}

async function scheduleSync(): Promise<void> {
  const existing = await chrome.alarms.get(SYNC_ALARM);
  if (existing?.periodInMinutes === SYNC_INTERVAL_MINUTES) return;
  await chrome.alarms.create(SYNC_ALARM, {
    delayInMinutes: SYNC_INTERVAL_MINUTES,
    periodInMinutes: SYNC_INTERVAL_MINUTES,
  });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await ensureDeviceId();
  await scheduleSync();
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) {
    // Welcome page in a tab: the permission dialog does not close it, unlike the popup.
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

// The "history" permission is optional and only requested by the consent button in the popup.
// Handling it here starts the first sync even if the popup closes during the dialog.
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
