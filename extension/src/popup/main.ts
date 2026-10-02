import { deleteDeviceData, fetchRewards, fetchStats, startWalletLink, type DeviceStats, type RewardsInfo } from '../lib/api';
import { SERVER_URL, SYNC_ALARM } from '../lib/config';
import { sendMessage } from '../lib/messages';
import { getState, setState, type State } from '../lib/storage';
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

const STATUS_LABEL: Record<RewardsInfo['payouts'][number]['status'], string> = {
  pending: 'queued',
  sending: 'checking',
  sent: 'sent',
  failed: 'retrying',
};


function rewardsCard(rewards: RewardsInfo | null, rewardsError: string): string {
  if (rewardsError) return `<section class="card"><h2>Rewards</h2><p class="error">${escape(rewardsError)}</p></section>`;
  if (!rewards) {
    return `<section class="card"><h2>Rewards</h2><p class="muted">You can link your wallet after the first sync.</p></section>`;
  }

  const { symbol, currentWeek: week, rules } = rewards;
  if (!rewards.wallet) {
    return `
      <section class="card">
        <h2>Rewards</h2>
        <p>Link your Phantom wallet to get a ${rules.welcomeBonus} ${symbol} welcome bonus right away, then more every week.</p>
        <button id="link-wallet" class="primary">Link with Phantom</button>
        <p class="muted small">A page opens where you sign a message with Phantom to prove the wallet is yours. Signing is free and moves no funds.</p>
      </section>
    `;
  }

  const payouts = rewards.payouts.slice(0, 5).map((p) => {
    const amount = `${p.amount} ${symbol}`;
    const status = p.explorerUrl
      ? `<a href="${escape(p.explorerUrl)}" target="_blank" rel="noopener">${STATUS_LABEL[p.status]} ↗</a>`
      : STATUS_LABEL[p.status];
    const label = p.kind === 'welcome' ? 'Welcome bonus' : `Week of ${formatDay(p.weekStartsAt)}`;
    return `<li><span>${label}</span><span>${amount}</span><span class="muted">${status}</span></li>`;
  }).join('');

  return `
    <section class="card">
      <h2>Rewards</h2>
      <p class="balance"><strong>${rewards.totalReceived}</strong> ${symbol} received</p>
      <dl>
        <dt>This week</dt><dd><strong>${week.points}</strong> points</dd>
        <dt>Unique pages</dt><dd>${week.pages}${week.pages > rules.maxPages ? ` (max ${rules.maxPages} count)` : ''}</dd>
        <dt>Active days</dt><dd>${week.activeDays} × ${rules.pointsPerActiveDay} points</dd>
        <dt>Payout</dt><dd>up to ${week.maxReward} ${symbol}, from ${formatDay(week.payableFrom)}</dd>
        <dt>Wallet</dt><dd><code title="${escape(rewards.wallet)}">${shortAddress(rewards.wallet)}</code></dd>
      </dl>
      ${payouts ? `<ul class="payouts">${payouts}</ul>` : ''}
      <p class="muted small">
        Points = unique pages (max ${rules.maxPages}) + ${rules.pointsPerActiveDay} for each day with at least
        ${rules.minVisitsPerActiveDay} visits. Welcome bonus: ${rules.welcomeBonus} ${symbol} as soon as you link
        your wallet, if your history has at least ${rules.welcomeMinActiveDays} active days.
      </p>
    </section>
  `;
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
    <p class="lead">Share your browsing history and earn TRACE, a token on Solana, every week.</p>

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
      <h2>What never leaves your browser</h2>
      <ul>
        <li>Files on your computer, Chrome's internal pages and extensions</li>
        <li>localhost and private-network addresses (router, NAS, intranet)</li>
      </ul>
      <p class="muted">You can withdraw consent and delete your data at any time from this panel.</p>
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
        <input id="interval" type="number" min="1" value="${state.syncIntervalMinutes}" />
      </label>
      <button id="save-interval">Save interval</button>
      ${rewards?.wallet ? `<hr /><button id="unlink-wallet">Change wallet</button>
      <p class="muted small">For security, unlinking requires a signature from the current wallet.</p>` : ''}
      <p class="muted small">Device ID: <code>${escape(state.deviceId)}</code></p>
      <hr />
      <button id="revoke">Withdraw consent</button>
      <button id="delete" class="danger">Withdraw consent and delete my data from the server</button>
    </details>
    <p id="msg" class="msg"></p>
  `;

  $('#sync').addEventListener('click', () => sendMessage({ type: 'sync-now' }));

  // Linking happens in a tab served by the server, where Phantom signs (Phantom isn't available in the popup).
  const openLinkPage = (action: 'link' | 'unlink') => async (event: Event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    try {
      const { url } = await startWalletLink(state.deviceId, action);
      await chrome.tabs.create({ url });
    } catch (err) {
      button.disabled = false;
      $('#msg').textContent = `Couldn't start wallet linking: ${err}`;
    }
  };
  app.querySelector('#link-wallet')?.addEventListener('click', openLinkPage('link'));
  app.querySelector('#unlink-wallet')?.addEventListener('click', openLinkPage('unlink'));

  $('#save-interval').addEventListener('click', async () => {
    const minutes = Math.floor(Number($<HTMLInputElement>('#interval').value));
    if (!(minutes >= 1)) return;
    await setState({ syncIntervalMinutes: minutes });
    await sendMessage({ type: 'reschedule' });
  });

  $('#revoke').addEventListener('click', async () => {
    if (!confirm('Stop sharing your browsing history?')) return;
    // The service worker resets consent and sync state (permissions.onRemoved).
    await chrome.permissions.remove({ permissions: ['history'] });
    await render();
  });

  $('#delete').addEventListener('click', async () => {
    if (!confirm('Withdraw consent and permanently delete your data from the server?')) return;
    try {
      await deleteDeviceData(state.deviceId);
    } catch (err) {
      $('#msg').textContent = `Deletion failed: ${err}`;
      return;
    }
    await chrome.permissions.remove({ permissions: ['history'] });
    await render();
  });
}

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') void render();
});

void render();
