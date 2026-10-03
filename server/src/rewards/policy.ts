// TRACE reward rules. All amounts are in whole tokens; convert them
// to base units with the mint's decimals (see toUnits).
//
// Each week (epoch) a fixed budget is distributed, split among users in proportion to their points.
// The budget drops 1% per week: the sum of all future budgets is 5M / 0.01 = 500M,
// exactly the rewards pool, which therefore never runs out.

const DAY_MS = 24 * 60 * 60 * 1000;
export const EPOCH_MS = 7 * DAY_MS;

// Monday 00:00 UTC when the program starts: epoch 0 is the week starting here.
export const GENESIS_MS = Date.UTC(2026, 8, 21);

export const FIRST_EPOCH_BUDGET = 5_000_000n;
export const WEEKLY_DECAY_PERCENT = 1n;

// Points = min(unique pages, MAX_PAGES) + POINTS_PER_ACTIVE_DAY × active days.
// Pages are capped, so a script opening thousands of URLs gains nothing.
// Active days weigh a lot because they are hard to fake in bulk. Maximum: 1000 + 700 = 1700.
export const MAX_PAGES = 1000;
export const POINTS_PER_ACTIVE_DAY = 100;
export const MIN_VISITS_PER_ACTIVE_DAY = 5;

// Per-user cap: even with few users, nobody gets more than 1 TRACE per point
// (so at most 1700 TRACE per week). Undistributed budget stays in the pool.
export const MAX_TOKENS_PER_POINT = 1n;

// Only "live" visits earn rewards: a visit counts if the server received it within LIVE_WINDOW_MS
// of when it happened. Backfilled history (the first sync uploads ~90 days) is stored but never paid,
// so a script cannot invent a week of browsing and cash it in a minute: it has to keep a browser
// running for real, day after day. A small tolerance absorbs clocks running slightly ahead.
export const LIVE_WINDOW_MS = 3 * DAY_MS;
export const CLOCK_SKEW_MS = 10 * 60 * 1000;

// Welcome bonus, paid like interest: WELCOME_INSTALLMENT every week for the first weeks after linking,
// up to WELCOME_BONUS in total per device and per wallet. Each installment requires
// WELCOME_MIN_ACTIVE_DAYS live active days that week, so a wallet linked and then abandoned stops earning.
export const WELCOME_BONUS = 500n;
export const WELCOME_INSTALLMENT = 50n;
export const WELCOME_MIN_ACTIVE_DAYS = 3;

// Two devices are the same history copied (possibly with timestamps shifted by a few seconds) when this
// share of the smaller device's (page, minute) keys also appears on the other one. Genuine users
// overlap a few percent at most. Devices with fewer keys than the minimum are not compared.
export const NEAR_DUPLICATE_OVERLAP = 0.5;
export const NEAR_DUPLICATE_MIN_KEYS = 20;

// Visits arriving later than LIVE_WINDOW_MS no longer count, so a week can be settled shortly after.
export const SETTLEMENT_GRACE_MS = LIVE_WINDOW_MS + DAY_MS;

export const toUnits = (tokens: bigint, decimals: number) => tokens * 10n ** BigInt(decimals);

export function epochAt(timeMs: number): number {
  return Math.floor((timeMs - GENESIS_MS) / EPOCH_MS);
}

export function epochRange(epoch: number) {
  const startsAt = GENESIS_MS + epoch * EPOCH_MS;
  return { startsAt, endsAt: startsAt + EPOCH_MS };
}

// Epoch budget in base units: FIRST_EPOCH_BUDGET × 0.99^epoch, computed with integers.
export function epochBudget(epoch: number, decimals: number): bigint {
  let budget = toUnits(FIRST_EPOCH_BUDGET, decimals);
  for (let i = 0; i < epoch; i++) budget = (budget * (100n - WEEKLY_DECAY_PERCENT)) / 100n;
  return budget;
}

export function isSettleable(epoch: number, now: number, { ignoreGrace = false } = {}): boolean {
  const { endsAt } = epochRange(epoch);
  return epoch >= 0 && now >= endsAt + (ignoreGrace ? 0 : SETTLEMENT_GRACE_MS);
}
