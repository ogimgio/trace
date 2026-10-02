import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { formatUnits, parseWalletAddress, toBaseUnits } from '../src/solana/rewards.ts';

test('toBaseUnits converts without float errors', () => {
  assert.equal(toBaseUnits('1', 6), 1_000_000n);
  assert.equal(toBaseUnits('1.5', 6), 1_500_000n);
  assert.equal(toBaseUnits(0.3, 6), 300_000n);
  assert.equal(toBaseUnits('0.000001', 6), 1n);
  assert.equal(toBaseUnits('2.500000000', 6), 2_500_000n);
  assert.equal(toBaseUnits('7', 0), 7n);
});

test('toBaseUnits rejects invalid amounts', () => {
  for (const bad of ['0', '-1', 'abc', '', '1e3', '0.0000001']) {
    assert.throws(() => toBaseUnits(bad, 6), `${bad} should be rejected`);
  }
  assert.throws(() => toBaseUnits(-1, 6));
});

test('parseWalletAddress accepts wallets and rejects junk or PDAs', () => {
  const wallet = Keypair.generate().publicKey;
  assert.ok(parseWalletAddress(wallet.toBase58())?.equals(wallet));

  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('x')], TOKEN_2022_PROGRAM_ID);
  assert.equal(parseWalletAddress(pda.toBase58()), null);

  for (const bad of [undefined, 42, '', 'not-a-key', '0'.repeat(44)]) {
    assert.equal(parseWalletAddress(bad), null);
  }
});

test('formatUnits is the inverse of toBaseUnits', () => {
  assert.equal(formatUnits(1_500_000n, 6), '1.5');
  assert.equal(formatUnits(1n, 6), '0.000001');
  assert.equal(formatUnits(0n, 6), '0');
  assert.equal(formatUnits(500_000_000_000_000n, 6), '500000000');
  assert.equal(formatUnits(7n, 0), '7');
});
