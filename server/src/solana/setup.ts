// Sets up everything needed on Devnet, without installing the Solana CLI:
//   1. creates the server and reserve wallet keypairs in .secrets/ (if missing)
//   2. requests a test SOL airdrop if the server balance is low
//   3. creates the token (Token-2022 with on-chain metadata) and saves the address to .secrets/token.json
//   4. mints the entire supply, splits it between rewards pool and reserve, and revokes the mint authority
//   5. with --uri, updates the metadata link (logo etc.)
// Safe to re-run: steps already done are skipped.
//
//   npm run solana:setup -- --name TRACE --symbol TRACE [--uri https://.../metadata.json] [--decimals 6]
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  AuthorityType, ExtensionType, LENGTH_SIZE, TOKEN_2022_PROGRAM_ID, TYPE_SIZE,
  createAssociatedTokenAccountIdempotentInstruction, createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction, createMintToCheckedInstruction, createSetAuthorityInstruction,
  getAssociatedTokenAddressSync, getMint, getMintLen, getTokenMetadata, tokenMetadataUpdateFieldWithRentTransfer,
} from '@solana/spl-token';
import { Field, createInitializeInstruction, pack, type TokenMetadata } from '@solana/spl-token-metadata';
import {
  DEFAULT_RPC_URL, RESERVE_KEYPAIR_PATH, SECRETS_DIR, SERVER_KEYPAIR_PATH, TOKEN_INFO_PATH, keypairFromJson,
  type TokenInfo,
} from './config.ts';
import { MAX_DECIMALS, formatUnits } from './rewards.ts';
import { allocations } from './tokenomics.ts';

const { values: args } = parseArgs({
  options: {
    name: { type: 'string' },
    symbol: { type: 'string' },
    uri: { type: 'string' },
    decimals: { type: 'string', default: '6' },
  },
});

const MIN_BALANCE_SOL = 0.5;
const explorer = (kind: 'tx' | 'address', id: string) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

const rpcUrl = process.env.SOLANA_RPC_URL ?? DEFAULT_RPC_URL;
const connection = new Connection(rpcUrl, 'confirmed');
mkdirSync(SECRETS_DIR, { recursive: true });

function loadOrCreateKeypair(path: string, label: string): Keypair {
  if (existsSync(path)) {
    const keypair = keypairFromJson(readFileSync(path, 'utf8'));
    console.log(`✓ ${label}: ${keypair.publicKey.toBase58()}`);
    return keypair;
  }
  const keypair = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
  console.log(`✓ ${label} created: ${keypair.publicKey.toBase58()} (saved to ${path})`);
  return keypair;
}

// 1. Keypairs. The first setup called the server wallet "mint-authority": reuse it, it already has SOL.
const legacyPath = resolve(SECRETS_DIR, 'mint-authority.json');
if (!existsSync(SERVER_KEYPAIR_PATH) && existsSync(legacyPath)) renameSync(legacyPath, SERVER_KEYPAIR_PATH);
const server = loadOrCreateKeypair(SERVER_KEYPAIR_PATH, 'Server wallet');
const reserve = loadOrCreateKeypair(RESERVE_KEYPAIR_PATH, 'Reserve wallet');

// 2. SOL for fees
const balance = await connection.getBalance(server.publicKey);
console.log(`  Server balance: ${balance / LAMPORTS_PER_SOL} SOL`);
if (balance < MIN_BALANCE_SOL * LAMPORTS_PER_SOL) {
  try {
    console.log('  Requesting a 1 SOL airdrop...');
    const sig = await connection.requestAirdrop(server.publicKey, LAMPORTS_PER_SOL);
    await connection.confirmTransaction({ signature: sig, ...(await connection.getLatestBlockhash()) });
    console.log('✓ Airdrop received');
  } catch (err) {
    console.error(`✗ Airdrop failed (${(err as Error).message.split('\n')[0]})`);
    console.error(`  Go to https://faucet.solana.com, paste ${server.publicKey.toBase58()} and choose Devnet.`);
    console.error('  Then run this command again.');
    process.exit(1);
  }
}

// 3. Mint with metadata
let info: TokenInfo;
if (existsSync(TOKEN_INFO_PATH)) {
  info = JSON.parse(readFileSync(TOKEN_INFO_PATH, 'utf8')) as TokenInfo;
  console.log(`✓ Token already created: ${info.name} (${info.symbol}) ${info.mint}`);
} else {
  if (!args.name || !args.symbol) {
    console.error('✗ Creating the token requires --name and --symbol, e.g.: npm run solana:setup -- --name TRACE --symbol TRACE');
    process.exit(1);
  }
  const decimals = Number(args.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    console.error(`✗ --decimals must be an integer between 0 and ${MAX_DECIMALS}`);
    process.exit(1);
  }

  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;
  const metadata: TokenMetadata = {
    updateAuthority: server.publicKey,
    mint,
    name: args.name,
    symbol: args.symbol,
    uri: args.uri ?? '',
    additionalMetadata: [],
  };

  // The mint holds both the token data and the metadata (MetadataPointer + TokenMetadata extensions).
  // The initial space covers only the pointer; the metadata is allocated by its program,
  // but rent for both must be paid upfront.
  const mintLen = getMintLen([ExtensionType.MetadataPointer]);
  const metadataLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen + metadataLen);

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: server.publicKey,
      newAccountPubkey: mint,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeMetadataPointerInstruction(mint, server.publicKey, mint, TOKEN_2022_PROGRAM_ID),
    // No freeze authority: we cannot freeze users' tokens.
    createInitializeMintInstruction(mint, decimals, server.publicKey, null, TOKEN_2022_PROGRAM_ID),
    createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      metadata: mint,
      updateAuthority: server.publicKey,
      mint,
      mintAuthority: server.publicKey,
      name: metadata.name,
      symbol: metadata.symbol,
      uri: metadata.uri,
    }),
  );

  console.log(`  Creating token ${args.name} (${args.symbol})...`);
  const signature = await sendAndConfirmTransaction(connection, tx, [server, mintKeypair]);
  info = { mint: mint.toBase58(), decimals, name: args.name, symbol: args.symbol };
  writeFileSync(TOKEN_INFO_PATH, JSON.stringify(info, null, 2) + '\n');
  console.log(`✓ Token created: ${info.mint}`);
  console.log(`  ${explorer('tx', signature)}`);
}

// 4. Fixed supply: mint everything and revoke the mint authority in the same transaction,
// so there is never an intermediate state where the supply exists but can still be increased.
const mint = new PublicKey(info.mint);
const mintState = await getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
const split = allocations(info.decimals);
const poolAccount = getAssociatedTokenAddressSync(mint, server.publicKey, false, TOKEN_2022_PROGRAM_ID);
const reserveAccount = getAssociatedTokenAddressSync(mint, reserve.publicKey, false, TOKEN_2022_PROGRAM_ID);

if (mintState.mintAuthority === null) {
  console.log(`✓ Fixed supply: ${formatUnits(mintState.supply, info.decimals)} ${info.symbol}, mint authority revoked`);
} else if (mintState.supply !== 0n) {
  console.error(`✗ The mint already has ${formatUnits(mintState.supply, info.decimals)} tokens but the mint authority is still active.`);
  console.error('  It was not created by this setup: delete .secrets/token.json and run again to create a new one.');
  process.exit(1);
} else {
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(server.publicKey, poolAccount, server.publicKey, mint, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(server.publicKey, reserveAccount, reserve.publicKey, mint, TOKEN_2022_PROGRAM_ID),
    createMintToCheckedInstruction(mint, poolAccount, server.publicKey, split.rewardsPool, info.decimals, [], TOKEN_2022_PROGRAM_ID),
    createMintToCheckedInstruction(mint, reserveAccount, server.publicKey, split.reserve, info.decimals, [], TOKEN_2022_PROGRAM_ID),
    createSetAuthorityInstruction(mint, server.publicKey, AuthorityType.MintTokens, null, [], TOKEN_2022_PROGRAM_ID),
  );
  console.log(`  Minting ${formatUnits(split.total, info.decimals)} ${info.symbol} and revoking the mint authority...`);
  const signature = await sendAndConfirmTransaction(connection, tx, [server]);
  console.log(`✓ Fixed supply minted, nobody can ever mint more`);
  console.log(`  ${explorer('tx', signature)}`);
}

// 5. Metadata link (logo, description)
if (args.uri !== undefined) {
  const current = await getTokenMetadata(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
  if (current?.uri === args.uri) {
    console.log('✓ Metadata URI already up to date');
  } else {
    const signature = await tokenMetadataUpdateFieldWithRentTransfer(
      connection, server, mint, server, Field.Uri, args.uri, [], undefined, TOKEN_2022_PROGRAM_ID,
    );
    console.log(`✓ Metadata URI updated: ${args.uri}`);
    console.log(`  ${explorer('tx', signature)}`);
  }
}

const [pool, reserveBalance] = await Promise.all([
  connection.getTokenAccountBalance(poolAccount),
  connection.getTokenAccountBalance(reserveAccount),
]);
console.log('');
console.log(`Token:        ${explorer('address', info.mint)}`);
console.log(`Rewards pool: ${pool.value.uiAmountString} ${info.symbol} (wallet ${server.publicKey.toBase58()})`);
console.log(`Reserve:      ${reserveBalance.value.uiAmountString} ${info.symbol} (wallet ${reserve.publicKey.toBase58()})`);
