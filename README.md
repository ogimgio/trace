# TRACE

**Get paid for the browsing data you choose to share.**

Your browsing history is already collected and monetized by trackers, for free. TRACE is a Chrome extension that lets you share it on your own terms (explicit consent, local filtering, stop anytime) and pays you in **TRACE**, a fixed-supply token on Solana.

- **Live MVP:** https://trace-rewards.vercel.app (download the extension and try it)
- **Network:** Solana **Devnet**
- **Token (Token-2022):** [`Gveaq1FkXYNY8CXLBEkdHwgfwzpFrBRr7vTWfJTCQFxc`](https://explorer.solana.com/address/Gveaq1FkXYNY8CXLBEkdHwgfwzpFrBRr7vTWfJTCQFxc?cluster=devnet)

## How it works

1. **Consent.** On install a welcome tab explains exactly what is shared. Chrome's `history` permission is optional and only requested when the user clicks *Accept*.
2. **Local filtering.** Local files, browser-internal pages, `localhost` and private-network addresses never leave the browser.
3. **Sync.** The first sync uploads the available history (Chrome keeps ~90 days); then new visits every 7 days. Uploads are idempotent (`device_id`, `visit_id`).
4. **Link a wallet by signature.** The user signs a one-time message with Phantom (free, no transaction). The server verifies the Ed25519 signature and links the wallet. A linked wallet can only be changed by signing with it.
5. **Get paid.** A 500 TRACE welcome bonus is sent within seconds of linking (if the history has at least 7 active days). After that, rewards are paid weekly.

## Solana integration

| What | How |
| --- | --- |
| Token | SPL **Token-2022** mint with on-chain metadata (MetadataPointer + TokenMetadata extensions), 6 decimals |
| Fixed supply | 1,000,000,000 TRACE minted in a single transaction that also **revokes the mint authority**. No freeze authority. |
| Allocation | 50% rewards pool (server wallet), 50% reserve (separate wallet the server never uses) |
| Payouts | `TransferChecked` from the rewards pool; the user's associated token account is created idempotently in the same transaction. The server pays the fees, so users need no SOL. |
| Wallet linking | Phantom `signMessage`, verified server-side as Ed25519 with the wallet's public key |
| Metadata | Name, symbol and URI on-chain; logo and description at [trace-token.vercel.app/metadata.json](https://trace-token.vercel.app/metadata.json) |

Libraries: `@solana/web3.js`, `@solana/spl-token`, `@solana/spl-token-metadata`. No custom program is needed: everything uses the standard Token-2022 and Associated Token Account programs.

### Deployment details (Devnet)

| | Address |
| --- | --- |
| Token mint | [`Gveaq1FkXYNY8CXLBEkdHwgfwzpFrBRr7vTWfJTCQFxc`](https://explorer.solana.com/address/Gveaq1FkXYNY8CXLBEkdHwgfwzpFrBRr7vTWfJTCQFxc?cluster=devnet) |
| Rewards pool wallet (fee payer, metadata update authority) | [`2qz2nKWq5HiqFjS1qSU9nA9CkVjoYQ97UgE3TJ8AVFvv`](https://explorer.solana.com/address/2qz2nKWq5HiqFjS1qSU9nA9CkVjoYQ97UgE3TJ8AVFvv?cluster=devnet) |
| Reserve wallet | [`AKdB7rwwMM18huUQuifnA1DubfHvhepXme68x1AWNXbQ`](https://explorer.solana.com/address/AKdB7rwwMM18huUQuifnA1DubfHvhepXme68x1AWNXbQ?cluster=devnet) |
| Supply minted + mint authority revoked | [tx](https://explorer.solana.com/tx/bMXDcrDogkVibX7oSjschdzwZ3hPumg3ikftUKHWWZCkPUe3NmMwy232ygidYVfpgPYXYfV2ortUUWL3wY8mmak?cluster=devnet) |
| Example weekly payout | [tx](https://explorer.solana.com/tx/T27iDDMLBi6ksU3RqU5Vtf13Jq9FVCJ1tyV3rgs5HXKKdhRtXcBfZvrbpB4x5hki2p5KyQvbGR6yF5RsyTD2phm?cluster=devnet) |
| Example welcome bonus | [tx](https://explorer.solana.com/tx/4M8xvdxMZDZKPXXTiNthxcoAWDBghms7oiMXJZ537NbvEoo3vKhVF35kG5yQ8PcwAQxnuoge4P2mhKkEgorR9NfW?cluster=devnet) |

## Rewards

Every week (Monday 00:00 UTC) a fixed budget is split among users in proportion to their points:

- **Points** = min(unique pages, 1000) + 100 × active days (days with at least 5 visits). Max 1,700 per week. A page is domain + path without the query string, so generated URLs (`?q=1`, `?q=2`, …) count once.
- **Budget** starts at 5,000,000 TRACE and shrinks 1% per week. The sum of all weekly budgets is exactly the 500M pool, so it never runs out.
- **Cap** of 1 TRACE per point: with few users nobody gets millions; unused budget stays in the pool.
- **Welcome bonus** of 500 TRACE, once per device and once per wallet, sent instantly when the wallet is linked. Past history is not paid per visit, since it is the easiest to fake.
- **Settlement** happens after the week ends plus an 8-day grace period (the extension syncs every 7 days). A settled week is final. A daily Vercel Cron job settles and pays automatically.
- **No double payments:** every payout is claimed with a conditional `UPDATE`, unique indexes guard the welcome bonus, and a payout whose confirmation timed out is held for manual review instead of being retried.

The rules live in [`server/src/rewards/policy.ts`](server/src/rewards/policy.ts).

## Architecture

```
extension/   Chrome extension (Manifest V3, TypeScript, Vite)
server/      API (Node 24, Express) on Vercel + Postgres on Supabase + Solana payouts
  src/api.ts            visits upload, stats, delete
  src/rewards/          points, weekly settlement, signed wallet linking, cron
  src/solana/           token setup, payouts
  public/               landing page, signing page (link.html), extension zip
brand/       Logo, icons and token metadata (served at trace-token.vercel.app)
```

- **Database:** Supabase Postgres. Row Level Security is enabled on every table with no policies, so Supabase's public REST API exposes nothing; only the server (table owner) reads and writes.
- **Signing page:** Phantom is not injected into extension pages, so the extension opens `/link.html?code=…` on the server, where the user signs.

## Run it locally

Requirements: Node 24, a Postgres database (a free Supabase project works), Chrome with Phantom.

```bash
# 1. Server
cd server
npm install
export DATABASE_URL="postgresql://..."      # or put { "databaseUrl": "..." } in server/.secrets/supabase.json
npm run db:migrate                           # creates the tables (idempotent)

# 2. Token on Devnet (once): creates the wallets in server/.secrets/, the mint, the fixed supply
npm run solana:setup -- --name TRACE --symbol TRACE
#   if the airdrop fails, fund the printed server wallet at https://faucet.solana.com (Devnet) and rerun

npm run dev                                  # http://127.0.0.1:8787

# 3. Extension, pointed at the local server
cd ../extension
npm install
VITE_SERVER_URL=http://localhost:8787 npm run build
```

Then open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and pick `extension/dist`.

### Commands

```bash
cd server
npm test                                    # 26 tests on an in-memory Postgres (PGlite), no setup needed
npm run rewards:settle -- --dry-run         # what would be paid
npm run rewards:settle                      # settle finished weeks and send payouts
npm run rewards:settle -- --ignore-grace    # demo: also settle weeks that ended less than 8 days ago
npm run solana:reward -- <wallet> 10        # manual transfer from the pool
npm run solana:setup -- --uri <url>         # update the metadata URI
```

### Deploy

```bash
cd extension && npm run package             # builds and zips the extension into server/public/
cd ../server && vercel deploy --prod
```

Environment variables on Vercel:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Supabase pooler URL (transaction mode, port 6543) |
| `SERVER_WALLET` | JSON array of the server wallet's secret key (`server/.secrets/server-wallet.json`) |
| `MINT_ADDRESS`, `MINT_DECIMALS` | from `server/.secrets/token.json` |
| `CRON_SECRET` | random string; Vercel Cron sends it to `/api/cron/settle` |
| `SOLANA_RPC_URL` | optional, defaults to the public Devnet RPC |

`server/.secrets/` is git-ignored and never deployed: without it you lose access to the reward pool.

## API

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/visits` | `{ deviceId, visits[] }`, max 5000 per request; returns `{ received, inserted, skipped }` |
| `GET` | `/api/devices/:id/stats` | Total visits, first and last visit, last sync |
| `DELETE` | `/api/devices/:id` | Deletes the device and all its visits |
| `GET` | `/api/devices/:id/rewards` | Current week's points, payout history with Explorer links, rules |
| `POST` | `/api/devices/:id/link-challenge` | `{ action: 'link' \| 'unlink' }`: one-time code (10 min) and signing page URL |
| `GET` | `/api/link/:code` | Message to sign and code status (`valid`, `used`, `expired`) |
| `POST` | `/api/link/:code` | `{ wallet, signature }` (base64 Ed25519): verifies and links or unlinks; on first link returns the welcome payout |
| `GET` | `/api/cron/settle` | Settles finished weeks and sends pending payouts (requires `Authorization: Bearer $CRON_SECRET`) |

## Known limitations and next steps

- **Device identity.** The signature proves wallet ownership, not device ownership: the random `deviceId` is still the credential for uploading history.
- **Sybil resistance.** Rules apply per device and per wallet, so many devices and wallets multiply bonuses. Next: proof-of-personhood or stake-weighted limits before mainnet.
- **Chrome Web Store.** Publishing requires a privacy policy, a data-use disclosure and compliance with the store's Limited Use policy (browsing data only for user-facing features, never sold to third parties); the MVP is distributed as an unpacked extension.
- **Mainnet.** Paying users for personal data has GDPR implications and, in the EU, MiCA implications for the token; both need legal review before launch.
