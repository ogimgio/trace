# TRACE

**Get paid for the browsing data you choose to share.**

Your browsing history is already collected and monetized by trackers, for free. TRACE is a Chrome extension that lets you share it on your own terms (explicit consent, local filtering, stop anytime) and pays you in **TRACE**, a fixed-supply token on Solana: for the history already in your browser, then for every day you keep sharing. You see exactly what your data is worth before you claim it.

- **Live MVP:** https://trace-rewards.vercel.app (download the extension and try it)
- **Network:** Solana **Devnet**
- **Token (Token-2022):** [`Gveaq1FkXYNY8CXLBEkdHwgfwzpFrBRr7vTWfJTCQFxc`](https://explorer.solana.com/address/Gveaq1FkXYNY8CXLBEkdHwgfwzpFrBRr7vTWfJTCQFxc?cluster=devnet)

## How it works

1. **Consent.** On install a welcome tab explains exactly what is shared. Chrome's `history` permission is optional and only requested when the user clicks *Accept*.
2. **Local filtering.** Local files, browser-internal pages, `localhost` and private-network addresses never leave the browser.
3. **Sync.** The first sync uploads the available history (Chrome keeps ~90 days); then new visits every hour, and on browser start. Uploads are idempotent (`device_id`, `visit_id`).
4. **Link a wallet by signature, with a device check.** The extension opens a small popup window where the user signs a one-time message with Phantom (free, no transaction) while Fingerprint checks the browser. The server verifies both and links the wallet; the window closes by itself and the extension shows "Wallet connected". One device can link one wallet only (a wallet can be used on many devices), and a linked wallet can only be changed by signing with it.
5. **See the offer, claim it.** After a sync the extension shows what the shared data is worth (visits, pages, days, TRACE) with Cancel / Confirm. Confirm sends the TRACE right away and shows a celebration; with nothing to reward yet it says so, and without a wallet it asks to connect one. A welcome bonus of 50 TRACE a week (up to 500) is added while the user keeps browsing.

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
| Example reward payout | [tx](https://explorer.solana.com/tx/T27iDDMLBi6ksU3RqU5Vtf13Jq9FVCJ1tyV3rgs5HXKKdhRtXcBfZvrbpB4x5hki2p5KyQvbGR6yF5RsyTD2phm?cluster=devnet) |
| Example welcome bonus | [tx](https://explorer.solana.com/tx/4M8xvdxMZDZKPXXTiNthxcoAWDBghms7oiMXJZ537NbvEoo3vKhVF35kG5yQ8PcwAQxnuoge4P2mhKkEgorR9NfW?cluster=devnet) |

## Rewards

Users are paid for the data they share, day by day (`server/src/rewards/claims.ts`, rules in `policy.ts`):

- **Points per day** = min(unique pages that day, 100) + 100 if the day had at least 5 visits. **1 point = 1 TRACE**, so the extension can show the exact amount before the user claims it. A page is domain + path without the query string, so generated URLs (`?q=1`, `?q=2`, …) count once.
- **History and new days.** The last 90 days of history count as soon as they are uploaded; then every new day, once it is over (today is offered tomorrow). Sharing can be stopped at any time from the extension.
- **Offer, then claim.** After a sync the extension shows a summary (visits, pages, days, reward) with Cancel / Confirm (`GET /api/devices/:id/offer`). Confirm (`POST /api/devices/:id/claim`) records the days and sends the payout right away, then shows a celebration. Cancel hides that offer until it changes.
- **Each day is paid once per wallet** (`reward_days`, primary key wallet + day): re-uploading the same history, from a reinstall or another device, earns nothing new, and parallel claims never pay a day twice.
- **Duplicates.** A visit (URL + exact timestamp) uploaded by several devices counts only for the device that uploaded it first. A device whose (page, minute) keys mostly match another wallet's device (a copy with shifted timestamps) is offered nothing.
- **Welcome bonus** of 500 TRACE, paid like interest: 50 TRACE each week with at least 3 active days of live browsing (synced within 3 days), at most one installment per wallet per week. A daily Vercel Cron job settles finished weeks and sends queued payouts.

## Device check (one device, one wallet)

Linking a wallet requires a [Fingerprint](https://fingerprint.com) device check (`server/src/fingerprint.ts`):

1. The link page loads Fingerprint's agent with the public key and, at signing time, gets an event ID for the visit. It posts it with the wallet signature.
2. The server fetches the event with the secret key (`GET /v4/events/{event_id}`), so the page cannot fake it. It refuses bots, tampered browsers, virtual machines, emulators, replayed or stale events (older than 10 minutes), and each event ID counts once.
3. The event's visitor ID (a stable browser/device identifier that survives cleared cookies, incognito and IP changes) is bound to the wallet in `device_fingerprints`. The same device cannot link a second wallet; the same wallet can be linked from several devices. Refused attempts are logged.
4. One device can link at most 3 extension installs per 30 days (`device_extensions`): reinstalling the extension is how a script would start fresh histories.

Other signals never block anyone. A wallet's claims and welcome installments are created **held** for manual review (`npm run rewards:review`) when one of its devices has a high suspect score, tried twice to link other wallets, or when 5+ wallets share the same network and browser setup (a salted hash of IP + browser + OS, never the IP itself). Thresholds are in `server/src/rewards/policy.ts`.

Only wallets that passed a device check can claim; wallets linked before it existed can link again from the extension (same wallet). Without Fingerprint configured the server refuses to link wallets (fail closed). The local development server (`npm run dev:local`) turns off the per-IP rate limits and the extension-install limit.

## Data and privacy

- Users can withdraw consent from the extension at any time; syncing stops immediately.
- Access and deletion requests are handled by email (`privacy@trace-rewards.vercel.app`) within 30 days; an operator runs `npm run admin:delete-device`. There is no public delete endpoint, so knowing a device ID is not enough to erase someone's data.
- Shared history is kept for up to 18 months and then purged by the daily job. Only anonymized, aggregated insights are shared with third parties.
- Full policy: [trace-rewards.vercel.app/privacy.html](https://trace-rewards.vercel.app/privacy.html)
- **No double payments:** every payout is claimed with a conditional `UPDATE`, `reward_days` (wallet + day) guards claims and unique indexes guard the welcome bonus, and a payout whose confirmation timed out is held for manual review instead of being retried.
- **Wallet history:** every link and unlink is logged in `wallet_links`, so the full wallet ↔ device mapping is kept even after a wallet is replaced.
- **Rate limits per IP** (counters in Postgres, IPs stored only as a salted hash and purged after 2 days): at most 20 new devices per IP per day (offices share an IP: the real per-device limit is Fingerprint's), 120 uploads per hour, 30 wallet-link and claim requests per hour. Set `IP_HASH_SALT` in production (defaults to `CRON_SECRET`).

The rules live in [`server/src/rewards/policy.ts`](server/src/rewards/policy.ts).

## Architecture

```
extension/   Chrome extension (Manifest V3, TypeScript, Vite)
server/      API (Node 24, Express) on Vercel + Postgres on Supabase + Solana payouts
  src/api.ts            visits upload, stats, rate limits
  src/fingerprint.ts    device check (Fingerprint Server API)
  src/local.ts          local server with an embedded Postgres (PGlite), no accounts needed
  src/rewards/          points per day, offers and claims, duplicate checks, risk review,
                        signed wallet linking, welcome bonus settlement, cron
  src/solana/           token setup, payouts
  public/               landing page, privacy policy, signing page (link.html), extension zip
extension/src/popup/    consent, rewards card and modals (wallet connected, offer, celebration)
brand/       Logo, icons and token metadata (served at trace-token.vercel.app)
```

- **Database:** Supabase Postgres. Row Level Security is enabled on every table with no policies, so Supabase's public REST API exposes nothing; only the server (table owner) reads and writes.
- **Signing page:** Phantom is not injected into extension pages, so the extension opens `/link.html?code=…` on the server in a small popup window, where the user signs. The page tells the extension when it is done (`externally_connectable`) and the window closes.

## Run it locally

Quickest way, no database or token accounts needed (payouts stay queued; put the Fingerprint keys in `server/.secrets/antisybil.json` or the environment to link wallets):

```bash
cd server && npm install && npm run dev:local     # http://localhost:8787, database in server/data/
cd ../extension && npm install && npm run build:local
```

Full setup, with Supabase and a Devnet token. Requirements: Node 24, a Postgres database (a free Supabase project works), Chrome with Phantom.

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
npm run dev:local                           # local server with an embedded database, limits off
npm run rewards:settle -- --dry-run         # welcome installments that would be paid
npm run rewards:settle                      # settle finished weeks and send queued payouts (claims included)
npm run rewards:settle -- --ignore-grace    # demo: also settle weeks that ended less than 4 days ago
npm run rewards:review                      # payouts held for review; -- --release <wallet> / --reject <wallet>
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
| `FINGERPRINT_PUBLIC_KEY` | Fingerprint public API key (used in the link page) |
| `FINGERPRINT_SECRET_KEY` | Fingerprint secret API key (Server API). Secret |
| `FINGERPRINT_REGION` | `eu`, `us` or `ap`: the region of the Fingerprint workspace |
| `IP_HASH_SALT` | optional, salt for hashing IPs in rate limits (defaults to `CRON_SECRET`) |

`server/.secrets/` is git-ignored and never deployed: without it you lose access to the reward pool.

## API

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/visits` | `{ deviceId, visits[] }`, max 5000 per request; returns `{ received, inserted, skipped }` |
| `GET` | `/api/devices/:id/stats` | Total visits, first and last visit, last sync |
| `GET` | `/api/devices/:id/rewards` | Current offer, payout history with Explorer links, rules |
| `GET` | `/api/devices/:id/offer` | What the shared data is worth now: visits, pages, days, points, TRACE, what was not counted |
| `POST` | `/api/devices/:id/claim` | Claims the offer (wallet linked through the device check): records the days and sends the payout |
| `POST` | `/api/devices/:id/link-challenge` | `{ action: 'link' \| 'unlink' }`: one-time code (10 min) and signing page URL |
| `GET` | `/api/link/:code` | Message to sign, code status (`valid`, `used`, `expired`) and the Fingerprint public key for the device check |
| `POST` | `/api/link/:code` | `{ wallet, signature, deviceEventId }` (base64 Ed25519, Fingerprint event ID): verifies and links or unlinks; on link returns the welcome bonus rules |
| `GET` | `/api/stats` | Public aggregate numbers for the landing page (devices, visits, payouts, TRACE paid) |
| `GET` | `/api/cron/daily` | Settles finished weeks (welcome bonus), sends pending payouts and purges visits older than 18 months (requires `Authorization: Bearer $CRON_SECRET`) |

## Known limitations and next steps

- **Device identity.** The signature proves wallet ownership, not device ownership: the random `deviceId` is still the credential for uploading history.
- **Sybil resistance.** The device check stops one computer from farming many wallets, but not someone with many real devices. A wallet earns at most 200 TRACE per day whatever its devices. Next: a proof of personhood; a Didit selfie-liveness workflow (with duplicate-face detection, no ID document) is set up but not integrated yet, it costs $0.10 per check.
- **History can be fabricated.** Paying for past history means a single device can invent up to 90 days of browsing once; duplicate checks, the device check and the risk review limit it to one device and one wallet, but there is no plausibility check of the history itself yet.
- **Fixed rate.** 1 point = 1 TRACE: the 500M pool covers roughly 27,000 users with a full 90-day history plus their new days. The rate needs tuning before mainnet.
- **Chrome Web Store.** Publishing requires a privacy policy, a data-use disclosure and compliance with the store's Limited Use policy (browsing data only for user-facing features, never sold to third parties); the MVP is distributed as an unpacked extension.
- **Mainnet.** Paying users for personal data has GDPR implications and, in the EU, MiCA implications for the token; both need legal review before launch.
