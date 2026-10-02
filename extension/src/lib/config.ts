// Deve corrispondere a host_permissions in public/manifest.json.
export const SERVER_URL: string = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:8787';

export const DEFAULT_SYNC_INTERVAL_MINUTES = 7 * 24 * 60;
export const RETRY_DELAY_MINUTES = 60;

export const SYNC_ALARM = 'history-sync';
export const RETRY_ALARM = 'history-sync-retry';

// Visite per singola richiesta al server (il server ne accetta al massimo 5000).
export const UPLOAD_BATCH_SIZE = 1000;
