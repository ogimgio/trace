// Regole delle ricompense TRACE. Tutti gli importi sono in token interi; vanno convertiti
// in unità base con i decimali del mint (vedi toUnits).
//
// Ogni settimana (epoch) si distribuisce un budget fisso, diviso tra gli utenti in proporzione ai punti.
// Il budget cala dell'1% a settimana: la somma di tutti i budget futuri è 5M / 0.01 = 500M,
// cioè esattamente il fondo ricompense, che quindi non si esaurisce mai.

const DAY_MS = 24 * 60 * 60 * 1000;
export const EPOCH_MS = 7 * DAY_MS;

// Lunedì 00:00 UTC in cui parte il programma: l'epoch 0 è la settimana che inizia qui.
export const GENESIS_MS = Date.UTC(2026, 8, 21);

export const FIRST_EPOCH_BUDGET = 5_000_000n;
export const WEEKLY_DECAY_PERCENT = 1n;

// Punti = min(pagine uniche, MAX_PAGES) + POINTS_PER_ACTIVE_DAY × giorni attivi.
// Le pagine hanno un tetto, così uno script che apre migliaia di URL non serve a niente.
// I giorni attivi pesano tanto perché sono difficili da falsificare in blocco. Massimo: 1000 + 700 = 1700.
export const MAX_PAGES = 1000;
export const POINTS_PER_ACTIVE_DAY = 100;
export const MIN_VISITS_PER_ACTIVE_DAY = 5;

// Tetto per utente: anche se gli utenti sono pochi, nessuno riceve più di 1 TRACE per punto
// (quindi al massimo 1700 TRACE a settimana). Il budget non distribuito resta nel fondo.
export const MAX_TOKENS_PER_POINT = 1n;

// Bonus una tantum per chi collega il wallet con almeno una settimana di storico già inviato.
// La cronologia passata non viene pagata a visita: è la più facile da inventare.
export const WELCOME_BONUS = 500n;
export const WELCOME_MIN_ACTIVE_DAYS = 7;

// L'estensione sincronizza ogni 7 giorni, quindi i dati di una settimana arrivano fino a 7 giorni dopo.
// Si chiude una settimana solo dopo questo margine.
export const SETTLEMENT_GRACE_MS = 8 * DAY_MS;

export const toUnits = (tokens: bigint, decimals: number) => tokens * 10n ** BigInt(decimals);

export function epochAt(timeMs: number): number {
  return Math.floor((timeMs - GENESIS_MS) / EPOCH_MS);
}

export function epochRange(epoch: number) {
  const startsAt = GENESIS_MS + epoch * EPOCH_MS;
  return { startsAt, endsAt: startsAt + EPOCH_MS };
}

// Budget dell'epoch in unità base: FIRST_EPOCH_BUDGET × 0.99^epoch, calcolato con interi.
export function epochBudget(epoch: number, decimals: number): bigint {
  let budget = toUnits(FIRST_EPOCH_BUDGET, decimals);
  for (let i = 0; i < epoch; i++) budget = (budget * (100n - WEEKLY_DECAY_PERCENT)) / 100n;
  return budget;
}

export function isSettleable(epoch: number, now: number, { ignoreGrace = false } = {}): boolean {
  const { endsAt } = epochRange(epoch);
  return epoch >= 0 && now >= endsAt + (ignoreGrace ? 0 : SETTLEMENT_GRACE_MS);
}
