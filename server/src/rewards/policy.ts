// TRACE reward rules. All amounts are in whole tokens; convert them
// to base units with the mint's decimals (see toUnits).
//
// Users are paid for the data they share, day by day: the history already in the browser (up to
// HISTORY_DAYS) and then every new day while they keep sharing. Each finished UTC day earns
//   min(unique pages that day, MAX_PAGES_PER_DAY) + POINTS_PER_ACTIVE_DAY if it had MIN_VISITS_PER_ACTIVE_DAY visits
// and 1 point = TOKENS_PER_POINT TRACE, so the extension can show an exact offer before the user claims it.
// A day is paid once per wallet: uploading the same history again (reinstall, another device) earns nothing.

export const DAY_MS = 24 * 60 * 60 * 1000;
export const EPOCH_MS = 7 * DAY_MS;

// Monday 00:00 UTC when the program starts: epoch 0 is the week starting here. Weeks still pace the
// welcome bonus and label payouts.
export const GENESIS_MS = Date.UTC(2026, 8, 21);

// Pages are capped per day, so a script opening thousands of URLs gains nothing. Active days weigh as much
// as a full day of pages: they are hard to fake in bulk. Maximum per day: 100 + 100 = 200 points.
export const MAX_PAGES_PER_DAY = 100;
export const POINTS_PER_ACTIVE_DAY = 100;
export const MIN_VISITS_PER_ACTIVE_DAY = 5;
export const TOKENS_PER_POINT = 1n;

// How far back shared history is paid (Chrome keeps about 90 days). Today is not offered until it ends,
// so the day is paid with all its visits.
export const HISTORY_DAYS = 90;

// Live window used by the welcome bonus: a week counts as active only with visits synced within
// LIVE_WINDOW_MS, so the bonus rewards people who keep browsing, not a backfilled history.
export const LIVE_WINDOW_MS = 3 * DAY_MS;
export const CLOCK_SKEW_MS = 10 * 60 * 1000;

// Welcome bonus, paid like interest: WELCOME_INSTALLMENT every week for the first weeks after linking,
// up to WELCOME_BONUS in total per device and per wallet. Each installment requires
// WELCOME_MIN_ACTIVE_DAYS live active days that week, so a wallet linked and then abandoned stops earning.
export const WELCOME_BONUS = 500n;
export const WELCOME_INSTALLMENT = 50n;
export const WELCOME_MIN_ACTIVE_DAYS = 3;

// Device checks (Fingerprint). A device links one wallet; on top of that:
// - one device can link at most MAX_EXTENSIONS_PER_DEVICE extension installs per window (reinstalling the
//   extension is how a script would start fresh histories);
// - a wallet's payouts are held for manual review, never refused automatically, when one of its devices has a
//   suspect score of at least REVIEW_SUSPECT_SCORE, or tried REVIEW_REJECTED_ATTEMPTS times to link other
//   wallets, or when CLUSTER_MIN_WALLETS wallets share the same network + browser setup (cluster key).
// The suspect score is Fingerprint's weighted sum of risk signals: tune the threshold on real data.
export const DEVICE_WINDOW_MS = 30 * DAY_MS;
export const MAX_EXTENSIONS_PER_DEVICE = 3;
export const REVIEW_SUSPECT_SCORE = 15;
export const REVIEW_REJECTED_ATTEMPTS = 2;
export const CLUSTER_MIN_WALLETS = 5;

// Two devices are the same history copied (possibly with timestamps shifted by a few seconds) when this
// share of the smaller device's (page, minute) keys also appears on the other one. Genuine users
// overlap a few percent at most. Devices with fewer keys than the minimum are not compared.
export const NEAR_DUPLICATE_OVERLAP = 0.5;
export const NEAR_DUPLICATE_MIN_KEYS = 20;

// Visits arriving later than LIVE_WINDOW_MS no longer count for the welcome bonus, so a week can be settled
// shortly after it ends.
export const SETTLEMENT_GRACE_MS = LIVE_WINDOW_MS + DAY_MS;

export const toUnits = (tokens: bigint, decimals: number) => tokens * 10n ** BigInt(decimals);

export const dayAt = (timeMs: number) => Math.floor(timeMs / DAY_MS);

export function epochAt(timeMs: number): number {
  return Math.floor((timeMs - GENESIS_MS) / EPOCH_MS);
}

export function epochRange(epoch: number) {
  const startsAt = GENESIS_MS + epoch * EPOCH_MS;
  return { startsAt, endsAt: startsAt + EPOCH_MS };
}

export function isSettleable(epoch: number, now: number, { ignoreGrace = false } = {}): boolean {
  const { endsAt } = epochRange(epoch);
  return epoch >= 0 && now >= endsAt + (ignoreGrace ? 0 : SETTLEMENT_GRACE_MS);
}
