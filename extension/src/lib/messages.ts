// Messages from the popup to the service worker.
export type Message =
  | { type: 'sync-now' }
  | { type: 'reschedule' }
  | { type: 'link-wallet'; action: 'link' | 'unlink' };

// Messages from the link page (served by our server, see externally_connectable in the manifest).
export type ExternalMessage = { type: 'wallet-linked' } | { type: 'wallet-unlinked' };

export function sendMessage(message: Message): Promise<unknown> {
  return chrome.runtime.sendMessage(message);
}
