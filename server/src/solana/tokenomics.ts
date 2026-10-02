// Supply fissa: tutti i token vengono creati una volta sola dal setup, poi il permesso di
// crearne altri (mint authority) viene revocato per sempre.
export const TOTAL_SUPPLY = 1_000_000_000n; // in token interi

// Metà va nel fondo ricompense, posseduto dal wallet del server, che lo distribuisce un po' alla volta
// (vedi rewards/policy.ts). L'altra metà va alla riserva (team, progetto, liquidità), che il server non tocca.
export const REWARDS_POOL_SHARE_PERCENT = 50n;

export function allocations(decimals: number) {
  const total = TOTAL_SUPPLY * 10n ** BigInt(decimals);
  const rewardsPool = (total * REWARDS_POOL_SHARE_PERCENT) / 100n;
  return { total, rewardsPool, reserve: total - rewardsPool };
}
