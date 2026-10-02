// Prova manuale: invia token dal fondo ricompense a un wallet.
//   npm run solana:reward -- <indirizzo-wallet> [importo]
import { loadSolanaConfig } from './config.ts';
import { createRewarder, formatUnits, parseWalletAddress, toBaseUnits } from './rewards.ts';

const [address, amount = '1'] = process.argv.slice(2);
const wallet = parseWalletAddress(address);
if (!wallet) {
  console.error('Uso: npm run solana:reward -- <indirizzo-wallet> [importo]');
  process.exit(1);
}

const config = loadSolanaConfig();
if (!config) {
  console.error('Token non configurato: lancia prima `npm run solana:setup`.');
  process.exit(1);
}

const rewarder = createRewarder(config);
const result = await rewarder.send(wallet, toBaseUnits(amount, config.decimals));
const [balance, pool] = await Promise.all([rewarder.balanceOf(wallet), rewarder.poolBalance()]);
console.log(`✓ Inviati ${amount} token a ${wallet.toBase58()}`);
console.log(`  Saldo utente: ${formatUnits(balance, config.decimals)}`);
console.log(`  Fondo ricompense: ${formatUnits(pool, config.decimals)}`);
console.log(`  ${result.explorerUrl}`);
