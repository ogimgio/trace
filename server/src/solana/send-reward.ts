// Manual test: sends tokens from the rewards pool to a wallet.
//   npm run solana:reward -- <wallet-address> [amount]
import { loadSolanaConfig } from './config.ts';
import { createRewarder, formatUnits, parseWalletAddress, toBaseUnits } from './rewards.ts';

const [address, amount = '1'] = process.argv.slice(2);
const wallet = parseWalletAddress(address);
if (!wallet) {
  console.error('Usage: npm run solana:reward -- <wallet-address> [amount]');
  process.exit(1);
}

const config = loadSolanaConfig();
if (!config) {
  console.error('Token not configured: run `npm run solana:setup` first.');
  process.exit(1);
}

const rewarder = createRewarder(config);
const result = await rewarder.send(wallet, toBaseUnits(amount, config.decimals));
const [balance, pool] = await Promise.all([rewarder.balanceOf(wallet), rewarder.poolBalance()]);
console.log(`✓ Sent ${amount} tokens to ${wallet.toBase58()}`);
console.log(`  User balance: ${formatUnits(balance, config.decimals)}`);
console.log(`  Rewards pool: ${formatUnits(pool, config.decimals)}`);
console.log(`  ${result.explorerUrl}`);
