// Prepara tutto il necessario su Devnet, senza installare la CLI di Solana:
//   1. crea i keypair del wallet del server e della riserva in .secrets/ (se non ci sono)
//   2. chiede un airdrop di SOL di test se il saldo del server è basso
//   3. crea il token (Token-2022 con metadati on-chain) e salva l'indirizzo in .secrets/token.json
//   4. crea l'intera supply, la divide tra fondo ricompense e riserva e revoca la mint authority
//   5. con --uri, aggiorna il link ai metadati (logo ecc.)
// Si può rilanciare: i passi già fatti vengono saltati.
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
  console.log(`✓ ${label} creato: ${keypair.publicKey.toBase58()} (salvato in ${path})`);
  return keypair;
}

// 1. Keypair. Il primo setup chiamava il wallet del server "mint-authority": lo riusiamo, ha già i SOL.
const legacyPath = resolve(SECRETS_DIR, 'mint-authority.json');
if (!existsSync(SERVER_KEYPAIR_PATH) && existsSync(legacyPath)) renameSync(legacyPath, SERVER_KEYPAIR_PATH);
const server = loadOrCreateKeypair(SERVER_KEYPAIR_PATH, 'Wallet del server');
const reserve = loadOrCreateKeypair(RESERVE_KEYPAIR_PATH, 'Wallet della riserva');

// 2. SOL per le fee
const balance = await connection.getBalance(server.publicKey);
console.log(`  Saldo server: ${balance / LAMPORTS_PER_SOL} SOL`);
if (balance < MIN_BALANCE_SOL * LAMPORTS_PER_SOL) {
  try {
    console.log('  Chiedo un airdrop di 1 SOL...');
    const sig = await connection.requestAirdrop(server.publicKey, LAMPORTS_PER_SOL);
    await connection.confirmTransaction({ signature: sig, ...(await connection.getLatestBlockhash()) });
    console.log('✓ Airdrop ricevuto');
  } catch (err) {
    console.error(`✗ Airdrop fallito (${(err as Error).message.split('\n')[0]})`);
    console.error(`  Vai su https://faucet.solana.com, incolla ${server.publicKey.toBase58()} e scegli Devnet.`);
    console.error('  Poi rilancia questo comando.');
    process.exit(1);
  }
}

// 3. Mint con metadati
let info: TokenInfo;
if (existsSync(TOKEN_INFO_PATH)) {
  info = JSON.parse(readFileSync(TOKEN_INFO_PATH, 'utf8')) as TokenInfo;
  console.log(`✓ Token già creato: ${info.name} (${info.symbol}) ${info.mint}`);
} else {
  if (!args.name || !args.symbol) {
    console.error('✗ Per creare il token servono --name e --symbol, es: npm run solana:setup -- --name TRACE --symbol TRACE');
    process.exit(1);
  }
  const decimals = Number(args.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    console.error(`✗ --decimals deve essere un intero tra 0 e ${MAX_DECIMALS}`);
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

  // Il mint contiene sia i dati del token sia i metadati (estensioni MetadataPointer + TokenMetadata).
  // Lo spazio iniziale copre solo il puntatore; i metadati vengono allocati dal loro programma,
  // ma l'affitto (rent) per entrambi va pagato subito.
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
    // Nessuna freeze authority: non possiamo bloccare i token degli utenti.
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

  console.log(`  Creo il token ${args.name} (${args.symbol})...`);
  const signature = await sendAndConfirmTransaction(connection, tx, [server, mintKeypair]);
  info = { mint: mint.toBase58(), decimals, name: args.name, symbol: args.symbol };
  writeFileSync(TOKEN_INFO_PATH, JSON.stringify(info, null, 2) + '\n');
  console.log(`✓ Token creato: ${info.mint}`);
  console.log(`  ${explorer('tx', signature)}`);
}

// 4. Supply fissa: conio tutto e revoco la mint authority nella stessa transazione,
// così non può esistere uno stato intermedio in cui la supply è stata creata ma si può ancora aumentare.
const mint = new PublicKey(info.mint);
const mintState = await getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
const split = allocations(info.decimals);
const poolAccount = getAssociatedTokenAddressSync(mint, server.publicKey, false, TOKEN_2022_PROGRAM_ID);
const reserveAccount = getAssociatedTokenAddressSync(mint, reserve.publicKey, false, TOKEN_2022_PROGRAM_ID);

if (mintState.mintAuthority === null) {
  console.log(`✓ Supply fissa: ${formatUnits(mintState.supply, info.decimals)} ${info.symbol}, mint authority revocata`);
} else if (mintState.supply !== 0n) {
  console.error(`✗ Il mint ha già ${formatUnits(mintState.supply, info.decimals)} token ma la mint authority è ancora attiva.`);
  console.error('  Non è stato creato da questo setup: cancella .secrets/token.json e rilancia per crearne uno nuovo.');
  process.exit(1);
} else {
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(server.publicKey, poolAccount, server.publicKey, mint, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(server.publicKey, reserveAccount, reserve.publicKey, mint, TOKEN_2022_PROGRAM_ID),
    createMintToCheckedInstruction(mint, poolAccount, server.publicKey, split.rewardsPool, info.decimals, [], TOKEN_2022_PROGRAM_ID),
    createMintToCheckedInstruction(mint, reserveAccount, server.publicKey, split.reserve, info.decimals, [], TOKEN_2022_PROGRAM_ID),
    createSetAuthorityInstruction(mint, server.publicKey, AuthorityType.MintTokens, null, [], TOKEN_2022_PROGRAM_ID),
  );
  console.log(`  Creo ${formatUnits(split.total, info.decimals)} ${info.symbol} e revoco la mint authority...`);
  const signature = await sendAndConfirmTransaction(connection, tx, [server]);
  console.log(`✓ Supply fissa creata, nessuno potrà più crearne altri`);
  console.log(`  ${explorer('tx', signature)}`);
}

// 5. Link ai metadati (logo, descrizione)
if (args.uri !== undefined) {
  const current = await getTokenMetadata(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
  if (current?.uri === args.uri) {
    console.log('✓ URI dei metadati già aggiornato');
  } else {
    const signature = await tokenMetadataUpdateFieldWithRentTransfer(
      connection, server, mint, server, Field.Uri, args.uri, [], undefined, TOKEN_2022_PROGRAM_ID,
    );
    console.log(`✓ URI dei metadati aggiornato: ${args.uri}`);
    console.log(`  ${explorer('tx', signature)}`);
  }
}

const [pool, reserveBalance] = await Promise.all([
  connection.getTokenAccountBalance(poolAccount),
  connection.getTokenAccountBalance(reserveAccount),
]);
console.log('');
console.log(`Token:            ${explorer('address', info.mint)}`);
console.log(`Fondo ricompense: ${pool.value.uiAmountString} ${info.symbol} (wallet ${server.publicKey.toBase58()})`);
console.log(`Riserva:          ${reserveBalance.value.uiAmountString} ${info.symbol} (wallet ${reserve.publicKey.toBase58()})`);
