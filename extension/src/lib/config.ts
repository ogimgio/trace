// Must match host_permissions in public/manifest.json.
// Locally: VITE_SERVER_URL=http://localhost:8787 npm run build
export const SERVER_URL: string = import.meta.env.VITE_SERVER_URL ?? 'https://trace-rewards.vercel.app';

// Data access and deletion requests are handled by email (see the privacy policy).
export const PRIVACY_EMAIL = 'privacy@trace-rewards.vercel.app';
export const PRIVACY_URL = `${SERVER_URL}/privacy.html`;

// Rewards only count visits that reach the server within 3 days (see server/src/rewards/policy.ts):
// sync every hour, and never less often than once a day.
export const DEFAULT_SYNC_INTERVAL_MINUTES = 60;
export const MAX_SYNC_INTERVAL_MINUTES = 24 * 60;
export const RETRY_DELAY_MINUTES = 60;

export const SYNC_ALARM = 'history-sync';
export const RETRY_ALARM = 'history-sync-retry';

// Visits per server request (the server accepts at most 5000).
export const UPLOAD_BATCH_SIZE = 1000;
