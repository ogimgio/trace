// Messaggi dal popup al service worker.
export type Message = { type: 'sync-now' } | { type: 'reschedule' };

export function sendMessage(message: Message): Promise<unknown> {
  return chrome.runtime.sendMessage(message);
}
