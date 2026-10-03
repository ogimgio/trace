import {
  claimRewards, fetchRewards, fetchStats, type DeviceStats, type Offer, type Payout, type PayoutStatus, type RewardsInfo,
} from '../lib/api';
import { MAX_SYNC_INTERVAL_MINUTES, PRIVACY_EMAIL, PRIVACY_URL, SERVER_URL, SYNC_ALARM } from '../lib/config';
import { sendMessage } from '../lib/messages';
import { getState, setState, type State } from '../lib/storage';
import {
  closeModal, isModalOpen, showCelebration, showConnectWallet, showNotEnoughData, showOffer, showWalletConnected,
} from './modals';
import './popup.css';

const app = document.getElementById('app')!;
document.body.classList.toggle('tab', new URLSearchParams(location.search).has('onboarding'));

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const formatDate = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

function formatInterval(minutes: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (minutes % (24 * 60) === 0) return plural(minutes / (24 * 60), 'day');
  if (minutes % 60 === 0) return plural(minutes / 60, 'hour');
  return plural(minutes, 'minute');
}

const $ = <T extends HTMLElement>(sel: string) => app.querySelector<T>(sel)!;

const header = `<header class="brand"><img src="logo.svg" alt="" width="28" height="28" /><h1>TRACE</h1></header>`;

const shortAddress = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

const deletionMailto = (deviceId: string) => `mailto:${PRIVACY_EMAIL}?${new URLSearchParams({
  subject: 'TRACE data request',
  body: `Device ID: ${deviceId}\n\nI would like to (access / delete) the data I shared with TRACE.`,
}).toString().replaceAll('+', '%20')}`;

const STATUS_LABEL: Record<PayoutStatus, string> = {
  pending: 'queued',
  sending: 'checking',
  sent: 'sent',
  failed: 'retrying',
  held: 'under review',
  rejected: 'rejected',
};


// The offer is identified by its value and last day: a new day or a new sync makes it a new offer, shown again.
const offerKey = (o: Offer) => `${o.points}:${o.lastDay}`;
const canClaim = (r: RewardsInfo) => r.wallet !== null && r.deviceChecked;

const PAYOUT_LABEL = { claim: 'Shared data', welcome: 'Welcome bonus' } as const;

function rewardsCard(rewards: RewardsInfo | null, rewardsError: string): string {
  if (rewardsError) return `<section class="card"><h2>Rewards</h2><p class="error">${escape(rewardsError)}</p></section>`;
  if (!rewards) {
    return `<section class="card"><h2>Rewards</h2><p class="muted">Your reward appears after the first sync.</p></section>`;
  }

  const { symbol, offer, rules } = rewards;
  // One action at a time: claim what is ready (linking the wallet first if needed), or link the wallet.
  const action = offer.points > 0
    ? `<div class="claim"><span>Ready to claim</span><strong>${escape(offer.amount)} ${symbol}</strong></div>
       <button id="claim" class="primary">${canClaim(rewards) ? 'Review & claim' : 'Connect wallet to claim'}</button>`
    : offer.copied
      ? `<p class="error">This history copies another device's: it can't be rewarded.</p>`
      : !rewards.wallet
        ? `<button id="link-wallet" class="primary">Connect wallet</button>`
        : `<p class="muted small">Nothing new to claim: every day you keep sharing adds to your reward.</p>`;
  const relink = rewards.wallet && !rewards.deviceChecked ? `
      <p class="error">This wallet was linked before the device check existed: link it again to claim.</p>
      <button id="link-wallet">Link again with Phantom</button>` : '';

  const payouts = rewards.payouts.slice(0, 5).map((p) => {
    const status = p.explorerUrl
      ? `<a href="${escape(p.explorerUrl)}" target="_blank" rel="noopener">${STATUS_LABEL[p.status]} ↗</a>`
      : STATUS_LABEL[p.status];
    const label = p.kind === 'weekly' ? `Week of ${formatDay(p.weekStartsAt)}` : PAYOUT_LABEL[p.kind];
    return `<li><span>${label}</span><span>${p.amount} ${symbol}</span><span class="muted">${status}</span></li>`;
  }).join('');

  return `
    <section class="card">
      <h2>Rewards</h2>
      <p class="balance"><strong>${rewards.totalReceived}</strong> ${symbol} received</p>
      ${action}${relink}
      ${canClaim(rewards) ? `<p class="connected">✓ Wallet connected · <code title="${escape(rewards.wallet!)}">${shortAddress(rewards.wallet!)}</code></p>` : ''}
      ${payouts ? `<ul class="payouts">${payouts}</ul>` : ''}
      <p class="muted small">
        Each day you share earns its unique pages (max ${rules.maxPagesPerDay}) + ${rules.pointsPerActiveDay} if you made at
        least ${rules.minVisitsPerActiveDay} visits, and 1 point = ${rules.tokensPerPoint} ${symbol}. Your last
        ${rules.historyDays} days of history count, then every new day; each day is rewarded once. Welcome bonus:
        ${rules.welcomeInstallment} ${symbol} every week with at least ${rules.welcomeMinActiveDays} active days, up to ${rules.welcomeBonus} ${symbol}.
      </p>
    </section>
  `;
}

// Linking happens on a page served by the server, where Phantom signs (Phantom isn't available in extension
// pages). The service worker opens it in a small popup window and closes it when the wallet is linked.
async function openLinkPage(action: 'link' | 'unlink'): Promise<void> {
  const response = await sendMessage({ type: 'link-wallet', action }) as { ok: boolean; error?: string } | undefined;
  if (!response?.ok) throw new Error(response?.error ?? 'could not open the wallet window');
}

// Reviews the offer: Confirm claims it and celebrates (or, without a wallet, opens the link page; the offer
// shows again once the wallet is linked). Cancel hides this offer until it changes.
async function reviewOffer(state: State, rewards: RewardsInfo): Promise<void> {
  let payout: Payout | null = null;
  const result = await showOffer(rewards.offer, rewards.symbol, { walletLinked: canClaim(rewards) }, async () => {
    if (!canClaim(rewards)) return openLinkPage('link');
    payout = (await claimRewards(state.deviceId)).payout;
  });
  if (result === 'cancelled') {
    await setState({ dismissedOffer: offerKey(rewards.offer) });
    return;
  }
  closeModal();
  if (payout) {
    await showCelebration(payout, rewards.symbol);
    await render();
  }
}

// Shows what deserves attention, one modal at a time:
// 1. the wallet just linked;
// 2. after a sync the user started (first sync, "Sync now"): connect the wallet if there is none, the offer,
//    or "not enough data yet" when there is nothing to reward;
// 3. otherwise (hourly syncs), a new offer, unless the user already chose not to claim it yet.
let modalFlow = false;
async function showPendingModals(state: State, rewards: RewardsInfo | null): Promise<void> {
  if (!rewards || modalFlow || isModalOpen()) return;
  modalFlow = true;
  try {
    if (canClaim(rewards) && state.knownWallet !== rewards.wallet) {
      await showWalletConnected(rewards.wallet!);
      await setState({ knownWallet: rewards.wallet });
    }

    const last = state.lastSyncResult;
    const newSync = last?.ok === true && last.at !== state.lastSyncSeen;
    if (newSync) await setState({ lastSyncSeen: last.at });
    const userSync = newSync && (last.trigger === 'manual' || last.trigger === 'initial');
    const hasOffer = rewards.offer.points > 0;

    if (hasOffer && (userSync || offerKey(rewards.offer) !== state.dismissedOffer)) {
      await reviewOffer(state, rewards); // without a wallet, its Confirm is "Connect wallet to claim"
    } else if (userSync && !canClaim(rewards)) {
      if (await showConnectWallet()) await openLinkPage('link').catch(() => {});
    } else if (userSync) {
      await showNotEnoughData({ minVisits: rewards.rules.minVisitsPerActiveDay });
    }
  } finally {
    modalFlow = false;
  }
}

const formatDay = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });

async function render(): Promise<void> {
  const state = await getState();
  const granted = await chrome.permissions.contains({ permissions: ['history'] });
  if (state.consentAt === null || !granted) renderConsent(state);
  else await renderActive(state);
}

function renderConsent(state: State): void {
  app.innerHTML = `
    ${header}
    <p class="lead">Share your browsing history and earn TRACE, a token on Solana: your past history right away, then every day you keep sharing.</p>

    <section class="card">
      <h2>What is shared</h2>
      <ul>
        <li>Address (URL) and title of the pages you visit</li>
        <li>Date and time of each visit</li>
        <li>How you got there (link, typed, bookmark…)</li>
      </ul>
      <h2>When and where</h2>
      <ul>
        <li>Right away, all available history (Chrome keeps about 90 days)</li>
        <li>Then new visits, automatically every ${formatInterval(state.syncIntervalMinutes)}</li>
        <li>Sent to <code>${escape(SERVER_URL)}</code></li>
      </ul>
      <h2>How it's used</h2>
      <ul>
        <li>To calculate and pay your TRACE rewards</li>
        <li>To build anonymized, aggregated insights that may be shared with or sold to third parties; they never identify you</li>
        <li>Kept for up to 18 months; email <code>${escape(PRIVACY_EMAIL)}</code> to access or delete it</li>
      </ul>
      <h2>What never leaves your browser</h2>
      <ul>
        <li>Files on your computer, Chrome's internal pages and extensions</li>
        <li>localhost and private-network addresses (router, NAS, intranet)</li>
      </ul>
      <p class="muted">You can withdraw consent at any time from this panel. Details in our <a href="${PRIVACY_URL}" target="_blank" rel="noopener">privacy policy</a>.</p>
    </section>

    <button id="accept" class="primary">I agree, grant access</button>
    <p id="msg" class="msg"></p>
  `;

  $('#accept').addEventListener('click', async () => {
    // The request must start straight from the click (user gesture), before any other await.
    const granted = await chrome.permissions.request({ permissions: ['history'] });
    if (!granted) {
      $('#msg').textContent = 'Permission denied: without access to your history we can\'t continue.';
      return;
    }
    // The service worker starts the first sync (permissions.onAdded).
    await setState({ consentAt: Date.now() });
  });
}

async function renderActive(state: State): Promise<void> {
  const alarm = await chrome.alarms.get(SYNC_ALARM);
  let stats: DeviceStats | null = null;
  let rewards: RewardsInfo | null = null;
  let serverError = '';
  let rewardsError = '';
  const [statsResult, rewardsResult] = await Promise.allSettled([
    fetchStats(state.deviceId),
    fetchRewards(state.deviceId),
  ]);
  if (statsResult.status === 'fulfilled') stats = statsResult.value;
  else serverError = `Server unreachable (${SERVER_URL})`;
  if (rewardsResult.status === 'fulfilled') rewards = rewardsResult.value;
  else if (!serverError) rewardsError = 'Rewards are unavailable right now';

  const last = state.lastSyncResult;
  const lastLine = !last
    ? 'No sync yet'
    : last.ok
      ? `${formatDate(last.at)} · ${last.visits} visits read, ${last.inserted} new`
      : `${formatDate(last.at)} · error: ${escape(last.error ?? '')}`;

  app.innerHTML = `
    ${header}
    <p class="status ${state.syncing ? 'busy' : 'ok'}">
      ${state.syncing ? 'Syncing…' : 'Active'}
    </p>

    <section class="card">
      <dl>
        <dt>Visits shared</dt><dd>${stats?.totalVisits ?? 0}</dd>
        <dt>Last sync</dt><dd class="${last && !last.ok ? 'error' : ''}">${lastLine}</dd>
        <dt>Next sync</dt><dd>${formatDate(alarm?.scheduledTime)}</dd>
      </dl>
      ${serverError ? `<p class="error">${escape(serverError)}</p>` : ''}
    </section>

    ${rewardsCard(rewards, rewardsError)}

    <button id="sync" class="primary" ${state.syncing ? 'disabled' : ''}>Sync now</button>

    <details>
      <summary>Settings</summary>
      <label>
        Sync interval (minutes)
        <input id="interval" type="number" min="1" max="${MAX_SYNC_INTERVAL_MINUTES}" value="${state.syncIntervalMinutes}" />
      </label>
      <button id="save-interval">Save interval</button>
      ${rewards?.wallet ? `<hr /><button id="unlink-wallet">Change wallet</button>
      <p class="muted small">For security, unlinking requires a signature from the current wallet.</p>` : ''}
      <p class="muted small">Device ID: <code>${escape(state.deviceId)}</code></p>
      <hr />
      <button id="revoke">Withdraw consent</button>
      <p class="muted small">
        To access or delete data you've already shared, <a href="${deletionMailto(state.deviceId)}" target="_blank" rel="noopener">email ${PRIVACY_EMAIL}</a>
        with your device ID. See the <a href="${PRIVACY_URL}" target="_blank" rel="noopener">privacy policy</a>.
      </p>
    </details>
    <p id="msg" class="msg"></p>
  `;

  $('#sync').addEventListener('click', () => sendMessage({ type: 'sync-now' }));

  const linkButton = (action: 'link' | 'unlink') => async (event: Event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    try {
      await openLinkPage(action);
    } catch (err) {
      button.disabled = false;
      $('#msg').textContent = `Couldn't start wallet linking: ${err}`;
    }
  };
  app.querySelector('#link-wallet')?.addEventListener('click', linkButton('link'));
  app.querySelector('#unlink-wallet')?.addEventListener('click', linkButton('unlink'));
  app.querySelector('#claim')?.addEventListener('click', () => {
    if (rewards && !isModalOpen()) void reviewOffer(state, rewards);
  });

  $('#save-interval').addEventListener('click', async () => {
    const minutes = Math.floor(Number($<HTMLInputElement>('#interval').value));
    if (!(minutes >= 1 && minutes <= MAX_SYNC_INTERVAL_MINUTES)) return;
    await setState({ syncIntervalMinutes: minutes });
    await sendMessage({ type: 'reschedule' });
  });

  $('#revoke').addEventListener('click', async () => {
    if (!confirm('Stop sharing your browsing history?')) return;
    // The service worker resets consent and sync state (permissions.onRemoved).
    await chrome.permissions.remove({ permissions: ['history'] });
    await render();
  });

  void showPendingModals(state, rewards);

}

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') void render();
});

void render();
