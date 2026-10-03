# TRACE

**Get paid for the browsing data you choose to share.**

Your browsing history is already collected and monetized by trackers, for free. TRACE is a Chrome extension that lets you share it on your own terms (explicit consent, local filtering, stop anytime) and pays you in **TRACE**, a fixed-supply token on Solana.

- **Live MVP:** https://trace-rewards.vercel.app (download the extension and try it)
- **Network:** Solana **Devnet**
- **Token (Token-2022):** [`Gveaq1FkXYNY8CXLBEkdHwgfwzpFrBRr7vTWfJTCQFxc`](https://explorer.solana.com/address/Gveaq1FkXYNY8CXLBEkdHwgfwzpFrBRr7vTWfJTCQFxc?cluster=devnet)

## How it works

1. **Consent.** On install a welcome tab explains exactly what is shared. Chrome's `history` permission is optional and only requested when the user clicks *Accept*.
2. **Local filtering.** Local files, browser-internal pages, `localhost` and private-network addresses never leave the browser.
3. **Sync.** The first sync uploads the available history (Chrome keeps ~90 days); then new visits every hour, and on browser start. Uploads are idempotent (`device_id`, `visit_id`).
4. **Verify with World ID, then link a wallet by signature.** The user first proves with World ID (Orb) that they are a unique human, then signs a one-time message with Phantom (free, no transaction). The server verifies both and links the wallet. One human can link one wallet only, and a linked wallet can only be changed by signing with it. Only verified wallets are paid.
5. **Get paid.** Rewards are paid weekly, plus a welcome bonus of 50 TRACE a week (up to 500) while the user keeps browsing.

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
- **Live visits only.** A visit earns points only if it reached the server within 3 days of happening. The ~90 days of history uploaded on install are stored but never paid: they are the easiest to fake, and a script cannot invent a week of browsing and cash it in a minute.
- **Duplicates count once.** The same visit (URL + exact timestamp) uploaded by several devices counts only for the device that uploaded it first. A device whose (page, minute) keys mostly match another device's (a copy with shifted timestamps) earns nothing that week. The settlement CLI lists what was excluded.
- **Welcome bonus** of 500 TRACE, paid like interest: 50 TRACE each week with at least 3 active days, at most one installment per wallet per week, 500 in total per device and per wallet.
- **Settlement** happens after the week ends plus a 4-day grace period (visits older than 3 days no longer count anyway). A settled week is final. A daily Vercel Cron job settles and pays automatically.

## World ID (one human, one wallet)

Linking a wallet requires an Orb-verified World ID (IDKit 4, `proof_of_human` credential, World ID 4.0 proofs only):

1. The link page asks `POST /api/link/:code/worldid/start` for a request signed with the RP key (`signRequest`). The proof's signal is the link code, so a proof cannot be replayed on another link.
2. The user scans the QR code with World App. IDKit returns the proof, which the page posts to `POST /api/link/:code/worldid`.
3. The server checks action, environment, nonce, credential and signal hash, then forwards the proof to World's `POST /api/v4/verify/{rp_id}`, which returns the **nullifier**: an anonymous number, the same each time this human verifies with TRACE, different in every other app.
4. When the wallet signs, `worldid_verifications` binds nullifier ↔ wallet. The primary key on the nullifier and `UNIQUE (wallet)` make the binding permanent and race-free: the same human cannot verify a second wallet, and a verified wallet cannot be claimed by another human. The same wallet can be linked on several devices.

TRACE never receives the person's name, biometrics or World ID account. Settlement pays only devices whose wallet has a binding; wallets linked before World ID was required can be verified from the extension (same wallet). Without World ID configuration the server refuses to link wallets (fail closed).

For testing, set `WORLD_ENVIRONMENT=staging` with a staging app in the Developer Portal and use the World ID Simulator instead of a real Orb.

## Data and privacy

- Users can withdraw consent from the extension at any time; syncing stops immediately.
- Access and deletion requests are handled by email (`privacy@trace-rewards.vercel.app`) within 30 days; an operator runs `npm run admin:delete-device`. There is no public delete endpoint, so knowing a device ID is not enough to erase someone's data.
- Shared history is kept for up to 18 months and then purged by the daily job. Only anonymized, aggregated insights are shared with third parties.
- Full policy: [trace-rewards.vercel.app/privacy.html](https://trace-rewards.vercel.app/privacy.html)
- **No double payments:** every payout is claimed with a conditional `UPDATE`, unique indexes guard the welcome bonus, and a payout whose confirmation timed out is held for manual review instead of being retried.
- **Wallet history:** every link and unlink is logged in `wallet_links`, so the full wallet ↔ device mapping is kept even after a wallet is replaced.
- **Rate limits per IP** (counters in Postgres, IPs stored only as a salted hash and purged after 2 days): at most 5 new devices per IP per day, 120 uploads per hour, 30 wallet-link requests per hour. Set `IP_HASH_SALT` in production (defaults to `CRON_SECRET`).

The rules live in [`server/src/rewards/policy.ts`](server/src/rewards/policy.ts).

## Architecture

```
extension/   Chrome extension (Manifest V3, TypeScript, Vite)
server/      API (Node 24, Express) on Vercel + Postgres on Supabase + Solana payouts
  src/api.ts            visits upload, stats
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
npm test                                    # tests on an in-memory Postgres (PGlite), no setup needed
npm run rewards:settle -- --dry-run         # what would be paid
npm run rewards:settle                      # settle finished weeks and send payouts
npm run rewards:settle -- --ignore-grace    # demo: also settle weeks that ended less than 8 days ago
npm run solana:reward -- <wallet> 10        # manual transfer from the pool
npm run solana:setup -- --uri <url>         # update the metadata URI
npm run admin:delete-device -- <deviceId>   # handle an emailed deletion request (add --yes to delete)
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
| `CRON_SECRET` | random string; Vercel Cron sends it to `/api/cron/daily` |
| `SOLANA_RPC_URL` | optional, defaults to the public Devnet RPC |
| `WORLD_APP_ID`, `WORLD_RP_ID` | World ID app and relying party from the [Developer Portal](https://developer.world.org) |
| `WORLD_RP_SIGNING_KEY` | RP signing key (hex). Secret: anyone holding it can impersonate TRACE to World ID |
| | ⚠ **Temporary:** for the hackathon the World ID app ID, RP ID and signing key are committed as defaults in `server/src/worldid.ts` (`COMMITTED_DEFAULTS`). Move the key to Vercel, delete it from the code and rotate it in the Developer Portal: it stays in git history. |
| `WORLD_ACTION` | optional, the action configured in the portal (default `link-wallet`) |
| `WORLD_ENVIRONMENT` | `production` (default) or `staging` (World ID Simulator) |
| `IP_HASH_SALT` | optional, salt for hashing IPs in rate limits (defaults to `CRON_SECRET`) |

`server/.secrets/` is git-ignored and never deployed: without it you lose access to the reward pool.

## API

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/visits` | `{ deviceId, visits[] }`, max 5000 per request; returns `{ received, inserted, skipped }` |
| `GET` | `/api/devices/:id/stats` | Total visits, first and last visit, last sync |
| `GET` | `/api/devices/:id/rewards` | Current week's points, payout history with Explorer links, rules |
| `POST` | `/api/devices/:id/link-challenge` | `{ action: 'link' \| 'unlink' }`: one-time code (10 min) and signing page URL |
| `GET` | `/api/link/:code` | Message to sign, code status (`valid`, `used`, `expired`) and whether World ID is already verified |
| `POST` | `/api/link/:code/worldid/start` | Signed IDKit request parameters (app, action, RP context, signal) |
| `POST` | `/api/link/:code/worldid` | The IDKit result: verified with World, attaches the anonymous nullifier to the link code |
| `POST` | `/api/link/:code` | `{ wallet, signature }` (base64 Ed25519): verifies and links or unlinks; on link returns the welcome bonus rules |
| `GET` | `/api/stats` | Public aggregate numbers for the landing page (devices, visits, payouts, TRACE paid) |
| `GET` | `/api/cron/daily` | Settles finished weeks, sends pending payouts and purges visits older than 18 months (requires `Authorization: Bearer $CRON_SECRET`) |

## Known limitations and next steps

- **Device identity.** The signature proves wallet ownership, not device ownership: the random `deviceId` is still the credential for uploading history.
- **Sybil resistance.** One verified human has one wallet, but weekly points are still computed per device: the same person with several devices on one wallet earns for each. Next: cap points per wallet. Verified humans can also rent out their verification; rewards that vest over time would make that less attractive.
- **Chrome Web Store.** Publishing requires a privacy policy, a data-use disclosure and compliance with the store's Limited Use policy (browsing data only for user-facing features, never sold to third parties); the MVP is distributed as an unpacked extension.
- **Mainnet.** Paying users for personal data has GDPR implications and, in the EU, MiCA implications for the token; both need legal review before launch.
