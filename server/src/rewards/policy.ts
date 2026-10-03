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

// One-time bonus for linking a wallet with at least a week of history already uploaded.
// Past history is not paid per visit: it is the easiest to fabricate.
export const WELCOME_BONUS = 500n;
export const WELCOME_MIN_ACTIVE_DAYS = 7;

// The extension syncs daily, but a device that was offline can upload a week's data days later.
// A week is settled only after this grace period.
export const SETTLEMENT_GRACE_MS = 8 * DAY_MS;

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
