# TRACE demo video (Remotion)

Video demo di ~2:32 per la submission (1920×1080, 30 fps). Le scene animate sono pronte; le 4 scene del flusso utente aspettano le **registrazioni schermo reali**, e ogni scena può avere la sua **voce fuori campo**.

```bash
npm i
npm run dev          # Remotion Studio: anteprima su http://localhost:3000
npx remotion render TraceDemo out/trace-demo.mp4   # quando è tutto pronto
```

## Struttura

| # | Scena | Durata | Contenuto |
|---|---|---|---|
| 1 | Hook | 8 s | Il problema + logo |
| 2 | Flip | 12 s | Consenso, filtro locale, pagato su Solana |
| 3 | Install | 22 s | 🎥 `public/clips/01-install.mp4` |
| 4 | Sync | 14 s | 🎥 `public/clips/02-sync.mp4` |
| 5 | Link wallet | 28 s | 🎥 `public/clips/03-link.mp4` |
| 6 | Paid | 22 s | 🎥 `public/clips/04-paid.mp4` |
| 7 | Rewards | 20 s | Formula punti + budget settimanale |
| 8 | On-chain | 20 s | Token-2022, supply fissa, payout, firma |
| 9 | Outro | 10 s | Link live + GitHub |

Finché un file manca, la scena mostra un riquadro "SCREEN RECORDING TO ADD" con le azioni da registrare. Appena metti il file con quel nome in `public/clips/`, compare il video al suo posto.

## Registrare i clip

- macOS: `Cmd+Shift+5` → "Registra porzione selezionata", seleziona solo la finestra di Chrome (formato orizzontale, circa 16:10).
- Prima di registrare: nascondi la barra dei preferiti, zoom Chrome al 110–125%, chiudi le altre schede, Phantom in modalità **Devnet** (Impostazioni → Developer settings → Testnet mode).
- Converti i `.mov` in `.mp4`: `npx remotion ffmpeg -i Registrazione.mov -c:v libx264 -crf 18 -an public/clips/01-install.mp4`
- Se un clip è più lungo della scena: in Studio seleziona il `<ScreenClip>` e cambia **Playback speed** (es. 1.5) o **Skip the first N seconds**. In alternativa allunga `durationInFrames` della scena in `src/TraceDemo.tsx` e `src/Root.tsx`, e aggiorna i totali.

⚠️ **Welcome bonus:** viene pagato una volta per browser (visitor ID Fingerprint) e una volta per wallet. Se il tuo Chrome o il tuo wallet l'hanno già ricevuto, nella registrazione non arriverà. Per la demo usa un browser o un computer che non l'ha mai ricevuto, con un wallet Phantom nuovo, e una history con almeno 7 giorni attivi.

### Cosa registrare

1. **01-install**: trace-rewards.vercel.app → Download extension → `chrome://extensions` → Load unpacked → si apre il welcome tab → scorri "What is shared…" → "I agree, grant access" → prompt di Chrome → Allow.
2. **02-sync**: apri il popup: "Syncing…" e poi "Active", visite condivise, last sync, next sync.
3. **03-link**: popup → "Link with Phantom" → si apre la pagina di firma → device check → Phantom: firma il messaggio → wallet collegato.
4. **04-paid**: popup con "500 TRACE received" e i punti della settimana → Phantom con il saldo TRACE → clic su "sent ↗" accanto al welcome bonus → transazione su Solana Explorer (Devnet).

## Voce fuori campo (in inglese, per i giudici)

Un file per scena in `public/voice/` (es. `01-hook.mp3`); se esiste, la scena lo riproduce. Puoi registrarli con QuickTime ("Nuova registrazione audio") ed esportarli come `.m4a`; poi convertili in mp3 con `npx remotion ffmpeg -i in.m4a public/voice/01-hook.mp3`. Il ritmo è di circa 150 parole al minuto.

**01-hook (8 s)**
Your browsing history is already collected and sold by trackers, and you never see a cent of it. This is TRACE.

**02-flip (12 s)**
TRACE is a Chrome extension that flips this. You decide what to share, it's filtered on your device, and you get paid in TRACE tokens on Solana.

**03-install (22 s)**
Let's try it. From trace-rewards.vercel.app I download the extension and load it in Chrome. A welcome tab explains exactly what is shared, when, and how it's used. Nothing leaves the browser until I accept, and only then does Chrome ask for access to my history.

**04-sync (14 s)**
The first sync uploads the history Chrome keeps, about ninety days. Local files, localhost and private network addresses are filtered out on the device. After that, new visits sync once a day in the background.

**05-link (28 s)**
Now I link a wallet. The popup opens a signing page, since Phantom isn't available inside extension pages. A Fingerprint device check keeps bots, virtual machines and wallet farms out. Then I sign a one-time message with Phantom. It's free and moves no funds. The server verifies the Ed25519 signature against my public key, and the wallet is linked.

**06-paid (22 s)**
Seconds later, the 500 TRACE welcome bonus arrives. The server pays the fees and creates my token account, so I never need SOL. Here it is in Phantom, and here's the transfer on Solana Explorer. Every payout is public.

**07-rewards (20 s)**
From then on, rewards are weekly. Points are unique pages, capped at a thousand, plus a hundred for every active day. A fixed weekly budget, shrinking one percent each week, is split by points, and each visit is paid only once.

**08-onchain (20 s)**
Under the hood it's standard Solana: a Token-2022 mint with on-chain metadata, a fixed supply of one billion with the mint authority revoked, and TransferChecked payouts from the rewards pool, with the server paying every fee.

**09-outro (10 s)**
TRACE is live on Solana devnet. Try it at trace-rewards.vercel.app.

## Pubblicare

Renderizza in `out/` (cartella ignorata da git), carica l'mp4 su YouTube come video **non in elenco** (oppure su Loom) e metti il link nella submission.
