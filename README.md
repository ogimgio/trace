# TRACE

Estensione Chrome che, con il consenso esplicito dell'utente, invia la sua cronologia di navigazione a un backend, che la salva. In cambio l'utente riceve ogni settimana TRACE, un token su Solana (devnet).

```
extension/   Estensione Chrome (Manifest V3, TypeScript + Vite)
server/      Backend locale (Node 24 + Express + SQLite integrato in Node) + ricompense Solana
brand/       Logo, icone e metadati del token, pubblicati su https://trace-token.vercel.app
```

## Come funziona

1. Quando l'estensione viene installata si apre una scheda di benvenuto che spiega cosa viene condiviso.
2. Se l'utente accetta, viene richiesto il permesso `history`, che è opzionale: senza quel click l'estensione non ha accesso alla cronologia.
3. Prima sync: viene inviata tutta la cronologia disponibile (Chrome ne conserva circa 90 giorni).
4. Poi un `chrome.alarms` invia ogni 7 giorni le visite nuove. Se un invio fallisce, si riprova dopo 1 ora.
5. Il server deduplica su `(device_id, visit_id)`, quindi ripetere un invio non crea duplicati.
6. Dal popup l'utente può sincronizzare subito, revocare il consenso o cancellare i propri dati dal server.

## Avvio

```bash
# 1. Backend
cd server
npm install
npm run dev          # http://127.0.0.1:8787, DB in server/data/history.db

# 2. Estensione
cd extension
npm install
npm run build        # oppure `npm run watch` mentre sviluppi
```

3. Apri `chrome://extensions`, attiva **Modalità sviluppatore**, clicca **Carica estensione non pacchettizzata** e scegli `extension/dist`.
4. Si apre la scheda di benvenuto: clicca **Accetto e concedo l'accesso** e conferma il dialog di Chrome.

## Test

```bash
cd server && npm test
```

Prova manuale della sync periodica: nel popup apri **Impostazioni**, imposta l'intervallo a `1` minuto, naviga un po' e controlla che "Visite sul server" aumenti.

Per guardare i dati salvati:

```bash
sqlite3 server/data/history.db "SELECT datetime(visit_time/1000,'unixepoch'), transition, url FROM visits ORDER BY visit_time DESC LIMIT 20;"
```

Log del service worker: `chrome://extensions` → TRACE → **service worker**.

## API

| Metodo | Path | Descrizione |
| --- | --- | --- |
| `POST` | `/api/visits` | `{ deviceId, visits[] }`, max 5000 visite per richiesta, restituisce `{ received, inserted }` |
| `GET` | `/api/devices/:id/stats` | Totale visite, prima e ultima visita, ultima sync |
| `DELETE` | `/api/devices/:id` | Cancella il device e tutte le sue visite |

## Limiti noti (da risolvere prima della produzione)

- **Nessuna autenticazione.** Il `deviceId` fa da segreto: chi lo conosce può leggere le statistiche o cancellare i dati. Per questo il server ascolta solo su `127.0.0.1`. Con Solana il device verrà legato a un wallet tramite firma.
- Per cambiare l'URL del server bisogna aggiornare sia `VITE_SERVER_URL` sia `host_permissions` in `extension/public/manifest.json`.
- Per pubblicare sul Chrome Web Store servono una privacy policy e la dichiarazione dell'uso dei dati, perché la cronologia è un dato sensibile.

## Token TRACE e ricompense (Solana devnet)

Token-2022 con metadati on-chain, 6 decimali, **supply fissa di 1.000.000.000 TRACE**: il setup crea tutta la supply in una sola transazione e revoca subito la mint authority, quindi nessuno può crearne altri.

| Quota | Dove sta |
| --- | --- |
| 50% fondo ricompense | wallet del server (`server/.secrets/server-wallet.json`), che paga anche le fee |
| 50% riserva (team, progetto, liquidità) | wallet separato (`server/.secrets/reserve-wallet.json`), il server non lo usa |

`server/.secrets/` non va nel repo: senza quei file si perde l'accesso ai token.

### Come si guadagna

Ogni settimana (da lunedì 00:00 UTC) si distribuisce un budget fisso, diviso tra gli utenti in proporzione ai punti:

- **Punti** = min(pagine uniche, 1000) + 100 × giorni attivi (giorni con almeno 5 visite). Massimo 1700 a settimana.
  Le pagine sono dominio + percorso, senza query: `?q=1`, `?q=2` contano una volta. `file://`, `localhost`, reti private ed estensioni non contano.
- **Budget**: 5.000.000 TRACE la prima settimana, poi -1% ogni settimana. La somma di tutti i budget è 500M, cioè il fondo ricompense.
- **Tetto**: al massimo 1 TRACE per punto. Quando gli utenti sono pochi il budget non si esaurisce e il resto rimane nel fondo.
- **Bonus di benvenuto, subito**: 500 TRACE inviati appena l'utente collega il wallet, se ha almeno 7 giorni attivi di storico. Una volta sola per device e per wallet. Se lo storico non basta ancora, arriva alla prima chiusura settimanale in cui basta. La cronologia passata non viene pagata a visita, perché è la più facile da inventare.
- **Pagamento a settimana chiusa**, con 8 giorni di margine perché l'estensione sincronizza ogni 7. Una settimana chiusa non viene ricalcolata.

Le regole stanno in `server/src/rewards/policy.ts`.

### Comandi

```bash
cd server
npm run solana:setup -- --name TRACE --symbol TRACE   # una volta: wallet, token, supply (rilanciabile)
npm run solana:setup -- --uri https://.../metadata.json  # aggiorna il link a logo e descrizione
npm run rewards:settle -- --dry-run                    # cosa verrebbe pagato
npm run rewards:settle                                 # chiude le settimane pronte e paga
npm run rewards:settle -- --ignore-grace               # demo: chiude anche settimane finite da poco
npm run solana:reward -- <wallet> 10                   # invio manuale dal fondo
```

Se l'airdrop automatico fallisce: https://faucet.solana.com, indirizzo del wallet del server, rete Devnet.

| Metodo | Path | Descrizione |
| --- | --- | --- |
| `POST` | `/api/devices/:id/link-challenge` | `{ action: 'link' \| 'unlink' }`, crea un codice monouso (10 minuti) e restituisce l'URL della pagina di firma |
| `GET` | `/link?code=…` | Pagina dove Phantom firma il messaggio (servita dal server: Phantom non funziona nelle pagine dell'estensione) |
| `GET` | `/api/link/:code` | Messaggio da firmare e stato del codice (`valid`, `used`, `expired`) |
| `POST` | `/api/link/:code` | `{ wallet, signature }` (firma Ed25519 in base64): verifica e collega o scollega; al primo collegamento invia subito il bonus e lo restituisce in `welcome` |
| `GET` | `/api/devices/:id/rewards` | Punti della settimana in corso, storico pagamenti con link a Explorer, regole |

Logo e icone in `brand/` (`logo.svg`, `logo-512.png`, `icons/icon-{16,32,48,128}.png`). La cartella è pubblicata su Vercel (progetto `trace-token`) perché wallet ed explorer leggono logo e descrizione da `https://trace-token.vercel.app/metadata.json`, l'URI salvato on-chain nel token. Per aggiornarla: `cd brand && vercel deploy --prod`. Le icone dell'estensione sono copiate in `extension/public/icons/`.

### Collegamento del wallet con firma

1. Nel popup l'utente clicca **Collega con Phantom**: l'estensione chiede al server un codice monouso e apre `/link?code=…`.
2. Phantom firma un messaggio che contiene device e codice (gratis, non è una transazione).
3. Il server verifica la firma Ed25519 con la chiave pubblica del wallet, segna il codice come usato e collega il wallet.

Una volta collegato, **il wallet è bloccato**: per cambiarlo bisogna prima scollegarlo firmando con il wallet attuale. Chi scopre il `deviceId` di un altro non può quindi dirottarne le ricompense.

Limiti noti: la firma dimostra che il wallet è tuo, non che il device è tuo. Il `deviceId` resta l'unica credenziale per inviare cronologia e leggere le statistiche. Le regole valgono per device e per wallet, quindi chi crea molti device e wallet moltiplica i bonus. Prima di mainnet serve un controllo contro gli account multipli.
