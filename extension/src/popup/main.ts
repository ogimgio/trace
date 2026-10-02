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
  ms ? new Date(ms).toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

function formatInterval(minutes: number): string {
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} giorni`;
  if (minutes % 60 === 0) return `${minutes / 60} ore`;
  return `${minutes} minuti`;
}

const $ = <T extends HTMLElement>(sel: string) => app.querySelector<T>(sel)!;

const header = `<header class="brand"><img src="logo.svg" alt="" width="28" height="28" /><h1>TRACE</h1></header>`;

const shortAddress = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

const STATUS_LABEL: Record<RewardsInfo['payouts'][number]['status'], string> = {
  pending: 'in coda',
  sending: 'in verifica',
  sent: 'inviato',
  failed: 'da ritentare',
};


function rewardsCard(rewards: RewardsInfo | null, rewardsError: string): string {
  if (rewardsError) return `<section class="card"><h2>Ricompense</h2><p class="error">${escape(rewardsError)}</p></section>`;
  if (!rewards) {
    return `<section class="card"><h2>Ricompense</h2><p class="muted">Dopo la prima sincronizzazione potrai collegare il tuo wallet.</p></section>`;
  }

  const { symbol, currentWeek: week, rules } = rewards;
  if (!rewards.wallet) {
    return `
      <section class="card">
        <h2>Ricompense</h2>
        <p>Collega il tuo wallet Phantom e ricevi subito ${rules.welcomeBonus} ${symbol} di benvenuto, poi altri ogni settimana.</p>
        <button id="link-wallet" class="primary">Collega con Phantom</button>
        <p class="muted small">Si apre una pagina dove firmi un messaggio con Phantom per dimostrare che il wallet è tuo. Firmare è gratis e non sposta fondi.</p>
      </section>
    `;
  }

  const payouts = rewards.payouts.slice(0, 5).map((p) => {
    const amount = `${p.amount} ${symbol}`;
    const status = p.explorerUrl
      ? `<a href="${escape(p.explorerUrl)}" target="_blank" rel="noopener">${STATUS_LABEL[p.status]} ↗</a>`
      : STATUS_LABEL[p.status];
    const label = p.kind === 'welcome' ? 'Benvenuto' : `Sett. del ${formatDay(p.weekStartsAt)}`;
    return `<li><span>${label}</span><span>${amount}</span><span class="muted">${status}</span></li>`;
  }).join('');

  return `
    <section class="card">
      <h2>Ricompense</h2>
      <p class="balance"><strong>${rewards.totalReceived}</strong> ${symbol} ricevuti</p>
      <dl>
        <dt>Questa settimana</dt><dd><strong>${week.points}</strong> punti</dd>
        <dt>Pagine uniche</dt><dd>${week.pages}${week.pages > rules.maxPages ? ` (contano max ${rules.maxPages})` : ''}</dd>
        <dt>Giorni attivi</dt><dd>${week.activeDays} × ${rules.pointsPerActiveDay} punti</dd>
        <dt>Pagamento</dt><dd>fino a ${week.maxReward} ${symbol}, dal ${formatDay(week.payableFrom)}</dd>
        <dt>Wallet</dt><dd><code title="${escape(rewards.wallet)}">${shortAddress(rewards.wallet)}</code></dd>
      </dl>
      ${payouts ? `<ul class="payouts">${payouts}</ul>` : ''}
      <p class="muted small">
        Punti = pagine uniche (max ${rules.maxPages}) + ${rules.pointsPerActiveDay} per ogni giorno con almeno
        ${rules.minVisitsPerActiveDay} visite. Bonus di benvenuto: ${rules.welcomeBonus} ${symbol} appena colleghi
        il wallet, se hai almeno ${rules.welcomeMinActiveDays} giorni attivi di cronologia.
      </p>
    </section>
  `;
}

const formatDay = (ms: number) => new Date(ms).toLocaleDateString('it-IT', { day: 'numeric', month: 'long' });

async function render(): Promise<void> {
  const state = await getState();
  const granted = await chrome.permissions.contains({ permissions: ['history'] });
  if (state.consentAt === null || !granted) renderConsent(state);
  else await renderActive(state);
}

function renderConsent(state: State): void {
  app.innerHTML = `
    ${header}
    <p class="lead">Condividi la tua cronologia di navigazione e ricevi TRACE, un token su Solana, ogni settimana.</p>

    <section class="card">
      <h2>Cosa viene condiviso</h2>
      <ul>
        <li>Indirizzo (URL) e titolo delle pagine visitate</li>
        <li>Data e ora di ogni visita</li>
        <li>Come ci sei arrivato (link, digitato, preferito…)</li>
      </ul>
      <h2>Quando e dove</h2>
      <ul>
        <li>Subito tutta la cronologia disponibile (Chrome ne conserva circa 90 giorni)</li>
        <li>Poi le nuove visite, automaticamente ogni ${formatInterval(state.syncIntervalMinutes)}</li>
        <li>Inviate a <code>${escape(SERVER_URL)}</code></li>
      </ul>
      <p class="muted">Puoi revocare il consenso e cancellare i tuoi dati in qualsiasi momento da questo pannello.</p>
    </section>

    <button id="accept" class="primary">Accetto e concedo l'accesso</button>
    <p id="msg" class="msg"></p>
  `;

  $('#accept').addEventListener('click', async () => {
    // La richiesta deve partire subito dal click (user gesture), prima di altri await.
    const granted = await chrome.permissions.request({ permissions: ['history'] });
    if (!granted) {
      $('#msg').textContent = 'Permesso negato: senza accesso alla cronologia non possiamo continuare.';
      return;
    }
    // La prima sync la avvia il service worker (permissions.onAdded).
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
  else serverError = `Server non raggiungibile (${SERVER_URL})`;
  if (rewardsResult.status === 'fulfilled') rewards = rewardsResult.value;
  else if (!serverError) rewardsError = 'Ricompense non disponibili al momento';

  const last = state.lastSyncResult;
  const lastLine = !last
    ? 'Nessuna sincronizzazione ancora'
    : last.ok
      ? `${formatDate(last.at)} · ${last.visits} visite lette, ${last.inserted} nuove`
      : `${formatDate(last.at)} · errore: ${escape(last.error ?? '')}`;

  app.innerHTML = `
    ${header}
    <p class="status ${state.syncing ? 'busy' : 'ok'}">
      ${state.syncing ? 'Sincronizzazione in corso…' : 'Attivo'}
    </p>

    <section class="card">
      <dl>
        <dt>Visite sul server</dt><dd>${stats?.totalVisits ?? 0}</dd>
        <dt>Ultima sync</dt><dd class="${last && !last.ok ? 'error' : ''}">${lastLine}</dd>
        <dt>Prossima sync</dt><dd>${formatDate(alarm?.scheduledTime)}</dd>
      </dl>
      ${serverError ? `<p class="error">${escape(serverError)}</p>` : ''}
    </section>

    ${rewardsCard(rewards, rewardsError)}

    <button id="sync" class="primary" ${state.syncing ? 'disabled' : ''}>Sincronizza ora</button>

    <details>
      <summary>Impostazioni</summary>
      <label>
        Intervallo di sync (minuti)
        <input id="interval" type="number" min="1" value="${state.syncIntervalMinutes}" />
      </label>
      <button id="save-interval">Salva intervallo</button>
      ${rewards?.wallet ? `<hr /><button id="unlink-wallet">Cambia wallet</button>
      <p class="muted small">Per sicurezza, per scollegare il wallet devi firmare con quello attuale.</p>` : ''}
      <p class="muted small">ID dispositivo: <code>${escape(state.deviceId)}</code></p>
      <hr />
      <button id="revoke">Revoca consenso</button>
      <button id="delete" class="danger">Revoca e cancella i miei dati dal server</button>
    </details>
    <p id="msg" class="msg"></p>
  `;

  $('#sync').addEventListener('click', () => sendMessage({ type: 'sync-now' }));

  // Il collegamento avviene in una scheda servita dal server, dove Phantom firma (Phantom non funziona nel popup).
  const openLinkPage = (action: 'link' | 'unlink') => async (event: Event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    try {
      const { url } = await startWalletLink(state.deviceId, action);
      await chrome.tabs.create({ url });
    } catch (err) {
      button.disabled = false;
      $('#msg').textContent = `Non riesco ad avviare il collegamento: ${err}`;
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
    if (!confirm('Interrompere la condivisione della cronologia?')) return;
    // Il service worker azzera consenso e stato della sync (permissions.onRemoved).
    await chrome.permissions.remove({ permissions: ['history'] });
    await render();
  });

  $('#delete').addEventListener('click', async () => {
    if (!confirm('Revocare il consenso e cancellare definitivamente i tuoi dati dal server?')) return;
    try {
      await deleteDeviceData(state.deviceId);
    } catch (err) {
      $('#msg').textContent = `Cancellazione non riuscita: ${err}`;
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
