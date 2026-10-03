import type { Offer, Payout } from '../lib/api';

// Modal dialogs of the popup: wallet linked, offer review (Cancel / Confirm) and the celebration after a claim.
// They live in #overlay, outside #app, so the popup re-rendering on every storage change does not close them.

const overlay = document.getElementById('overlay')!;
let open = false;

export const isModalOpen = () => open;

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const formatDay = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const number = (n: number) => n.toLocaleString('en-GB');

function show(html: string): HTMLElement {
  open = true;
  overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  overlay.hidden = false;
  return overlay.querySelector<HTMLElement>('.modal')!;
}

export function closeModal(): void {
  open = false;
  overlay.hidden = true;
  overlay.innerHTML = '';
}

// "Wallet connected" confirmation, shown once per wallet.
export function showWalletConnected(wallet: string): Promise<void> {
  const modal = show(`
    <div class="modal-icon ok">✓</div>
    <h2 class="modal-title">Wallet connected</h2>
    <p>Your TRACE rewards will be sent to</p>
    <p><code>${escape(wallet)}</code></p>
    <button class="primary" data-close>Continue</button>
  `);
  return new Promise((resolve) => modal.querySelector('[data-close]')!.addEventListener('click', () => {
    closeModal();
    resolve();
  }));
}

// Summary of the shared data and its reward. On Confirm it runs `onConfirm` (claim, or open the wallet link
// page); if that fails the error is shown in the dialog and the user can retry or cancel.
// Resolves 'confirmed' once `onConfirm` succeeded, 'cancelled' on Cancel.
export function showOffer(
  offer: Offer, symbol: string, { walletLinked }: { walletLinked: boolean }, onConfirm: () => Promise<void>,
): Promise<'confirmed' | 'cancelled'> {
  const span = offer.firstDay !== null && offer.lastDay !== null
    ? offer.firstDay === offer.lastDay ? formatDay(offer.firstDay) : `${formatDay(offer.firstDay)} – ${formatDay(offer.lastDay)}`
    : '';
  const notCounted = [
    offer.paidDays ? `${number(offer.paidDays)} day${offer.paidDays === 1 ? '' : 's'} already rewarded` : '',
    offer.duplicateVisits ? `${number(offer.duplicateVisits)} visit${offer.duplicateVisits === 1 ? '' : 's'} already shared from another install` : '',
  ].filter(Boolean);

  const modal = show(`
    <h2 class="modal-title">Your data is ready</h2>
    <p class="muted">${span}</p>
    <dl class="summary">
      <dt>Visits shared</dt><dd>${number(offer.visits)}</dd>
      <dt>Unique pages</dt><dd>${number(offer.pages)}</dd>
      <dt>Days shared</dt><dd>${number(offer.days)}</dd>
      <dt>Active days</dt><dd>${number(offer.activeDays)}</dd>
    </dl>
    ${notCounted.length ? `<p class="muted small">Not counted: ${notCounted.join(', ')}.</p>` : ''}
    <div class="reward"><span>Your reward</span><strong>${escape(offer.amount)} ${escape(symbol)}</strong></div>
    ${walletLinked ? '' : '<p class="muted small">Connect your Phantom wallet to receive it.</p>'}
    <p class="msg" data-msg></p>
    <div class="modal-actions">
      <button data-cancel>Cancel</button>
      <button class="primary" data-confirm>${walletLinked ? 'Confirm' : 'Connect wallet to claim'}</button>
    </div>
  `);
  return new Promise((resolve) => {
    modal.querySelector('[data-cancel]')!.addEventListener('click', () => {
      closeModal();
      resolve('cancelled');
    });
    modal.querySelector('[data-confirm]')!.addEventListener('click', async () => {
      modalBusy();
      try {
        await onConfirm();
        resolve('confirmed');
      } catch (err) {
        modalError(errorMessage(err));
      }
    });
  });
}

// The server answers errors as JSON ({ error }), wrapped by request() in "Server <status>: <body>".
function errorMessage(err: unknown): string {
  const text = String((err as Error)?.message ?? err);
  const match = /"error":"([^"]+)"/.exec(text);
  return match ? match[1].charAt(0).toUpperCase() + match[1].slice(1) + '.' : text;
}

// Shows an error inside the open modal (e.g. a failed claim) and re-enables its buttons.
export function modalError(message: string): void {
  const msg = overlay.querySelector<HTMLElement>('[data-msg]');
  if (msg) msg.textContent = message;
  overlay.querySelectorAll('button').forEach((b) => { b.disabled = false; });
}

export function modalBusy(): void {
  overlay.querySelectorAll('button').forEach((b) => { b.disabled = true; });
}

const STATUS_LINE: Record<Payout['status'], string> = {
  sent: 'Sent to your wallet.',
  pending: 'On its way to your wallet.',
  sending: 'On its way to your wallet.',
  failed: 'On its way to your wallet.',
  held: 'Under a quick review before it is sent.',
  rejected: 'This reward could not be sent.',
};

// The celebration after a confirmed claim: confetti, the amount and where it is.
export function showCelebration(payout: Payout, symbol: string): Promise<void> {
  const colors = ['#5ec8f2', '#ffd66b', '#ff7aa2', '#7cf29c', '#b48cff'];
  const confetti = Array.from({ length: 70 }, (_, i) => {
    const left = Math.random() * 100;
    const delay = Math.random() * 0.6;
    const duration = 1.8 + Math.random() * 1.4;
    const rotate = Math.floor(Math.random() * 360);
    return `<i style="left:${left}%;background:${colors[i % colors.length]};animation-delay:${delay}s;animation-duration:${duration}s;transform:rotate(${rotate}deg)"></i>`;
  }).join('');
  const link = payout.explorerUrl
    ? ` <a href="${escape(payout.explorerUrl)}" target="_blank" rel="noopener">View transaction ↗</a>`
    : '';
  const modal = show(`
    <div class="trophy" aria-hidden="true">🎉</div>
    <h2 class="modal-title">Congratulations!</h2>
    <p class="earned">+${escape(payout.amount)} <span>${escape(symbol)}</span></p>
    <p>${STATUS_LINE[payout.status]}${link}</p>
    <button class="primary" data-close>Awesome</button>
  `);
  modal.classList.add('celebrate');
  // Over the whole popup, behind the dialog.
  overlay.insertAdjacentHTML('afterbegin', `<div class="confetti" aria-hidden="true">${confetti}</div>`);
  return new Promise((resolve) => modal.querySelector('[data-close]')!.addEventListener('click', () => {
    closeModal();
    resolve();
  }));
}

// After a sync, when no wallet is linked yet: rewards need one. Resolves true on Connect.
export function showConnectWallet(): Promise<boolean> {
  const modal = show(`
    <div class="modal-icon wallet" aria-hidden="true">👛</div>
    <h2 class="modal-title">Connect your wallet</h2>
    <p>Your history is synced. Connect your Phantom wallet to start earning TRACE for every day you share.</p>
    <div class="modal-actions">
      <button data-cancel>Not now</button>
      <button class="primary" data-confirm>Connect wallet</button>
    </div>
  `);
  return new Promise((resolve) => {
    modal.querySelector('[data-cancel]')!.addEventListener('click', () => { closeModal(); resolve(false); });
    modal.querySelector('[data-confirm]')!.addEventListener('click', () => { closeModal(); resolve(true); });
  });
}

// After a sync that found nothing to reward yet.
export function showNotEnoughData({ minVisits }: { minVisits: number }): Promise<void> {
  const modal = show(`
    <div class="sad" aria-hidden="true">😕</div>
    <h2 class="modal-title">Not enough data yet</h2>
    <p>There isn't enough browsing history to earn TRACE yet.</p>
    <p class="muted small">Each finished day in which you browse with Chrome (at least ${minVisits} visits) earns TRACE. Keep browsing: today's pages count from tomorrow.</p>
    <button class="primary" data-close>OK</button>
  `);
  return new Promise((resolve) => modal.querySelector('[data-close]')!.addEventListener('click', () => {
    closeModal();
    resolve();
  }));
}
