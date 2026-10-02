// Fixed supply: all tokens are minted once by the setup, then the permission to
// mint more (mint authority) is revoked forever.
export const TOTAL_SUPPLY = 1_000_000_000n; // in whole tokens

// Half goes to the rewards pool, held by the server wallet, which distributes it gradually
// (see rewards/policy.ts). The other half goes to the reserve (team, project, liquidity), which the server never touches.
export const REWARDS_POOL_SHARE_PERCENT = 50n;

export function allocations(decimals: number) {
  const total = TOTAL_SUPPLY * 10n ** BigInt(decimals);
  const rewardsPool = (total * REWARDS_POOL_SHARE_PERCENT) / 100n;
  return { total, rewardsPool, reserve: total - rewardsPool };
}
