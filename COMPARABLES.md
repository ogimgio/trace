# Trace — Analisi comparativa dei modelli token/reward (2026-10-02)

Domanda: come hanno strutturato token e reward le piattaforme simili, e cosa ha funzionato?

---

## 1. Tabella riassuntiva

| Piattaforma | Chain | Cosa forniscono gli utenti | Come vengono pagati | Legame token ↔ domanda | Esito |
|---|---|---|---|---|---|
| **Swash** | Ethereum (Streamr Data Union) | dati di navigazione, ads, survey | token SWASH | debole: "unità di scambio" + 6 burn finanziati dai pool reward | SWASH **-99.95%** dall'ATH (0.97$ → ~0.0017$) |
| **Vana** | L1 EVM propria | export (Reddit, Takeout, Spotify…) in DataDAO | token VANA + token DLP per DataDAO | i buyer usano VANA per comprare e **bruciare** token DLP | VANA **-97%**, ~26% circolante, vesting fino 2028+ |
| **Grass** | **Solana** | banda internet inutilizzata (scraping per AI) | punti → airdrop GRASS (S1), poi **USDC** (S2) | ricavi dai data client | S1: 100M GRASS a 2.8M utenti. S2: passato a **USDC** per "incertezza regolatoria"; payout di **$5–80 per ~2 anni** → backlash |
| **Kled AI** | **Solana** | foto/video/audio/schermo su task dei lab AI | **USD** (PayPal/Venmo) o wallet Solana, soglia $25 | conversione reward → buyback & burn KLED (50% burn, 50% pool anti-frode); buyback discrezionale da ricavi; staking = quota fee | $12M deal con un buyer enterprise, "profittevole". Scandalo giugno 2025: team ha venduto $800k di KLED subito dopo aver annunciato un buyback |
| **Hivemapper** | **Solana** | immagini stradali da dashcam | token HONEY | **Burn-and-Mint Equilibrium**: i clienti bruciano HONEY per comprare Map Credits (pegged USD); una quota viene ri-emessa ai contributori | modello di riferimento DePIN per legare consumo e reward |
| **Brave / BAT** | Ethereum | attenzione (ads con matching **locale**) | BAT, **70%** dei ricavi ads agli utenti | gli inserzionisti pagano in BAT | il matching locale + opt-in è il precedente più vicino al "local-first" di Trace |
| **MIDATA** | nessuna | dati sanitari | nessun pagamento individuale | — | **cooperativa svizzera**: gli utenti diventano soci e governano tramite assemblea + consiglio etico |
| **Reddit (IPO 2024)** | nessuna | contenuti/moderazione | — | — | **Directed Share Program**: 8% delle azioni IPO offerte a 75k utenti/moderatori, a livelli per contributo. Precedenti: Uber (driver), Airbnb (host) |

---

## 2. Lezioni

### 2.1 I reward token "puri" sono crollati
Swash (-99.95%) e Vana (-97%) emettono token agli utenti senza un flusso di domanda sufficiente:
ogni utente che incassa vende, la pressione di vendita supera la domanda. Il reward percepito dall'utente
crolla con il prezzo, e l'utente se ne va.

### 2.2 Il settore si sta spostando verso denaro reale
- **Grass** è passato da token a **USDC** pagati dai ricavi reali, citando l'incertezza regolatoria.
- **Kled** paga in **USD**; il token è un'opzione, alimentato da buyback.
- Ma: quando paghi in denaro reale, il valore *vero* dei dati diventa visibile. Grass ha mostrato
  $5–80 per due anni → backlash. **La domanda reale per utente è il vero collo di bottiglia**
  (coerente con il punto 20 del summary originale).

### 2.3 I modelli che reggono legano il token al consumo dei buyer
- **Burn-and-Mint (Hivemapper)**: buyer brucia token → ottiene crediti in USD → reward ai contributori.
- **Buyer brucia per accedere (Vana)**: i buyer comprano accesso al dataset bruciando token.
- **Buyback & burn da ricavi (Kled)**: il protocollo usa i ricavi reali per comprare e bruciare.
- **Token di pagamento (BAT)**: gli inserzionisti pagano nel token, la maggioranza va agli utenti.

### 2.4 Nessuno usa il token per dare equity
- Kled lo esclude esplicitamente nella documentazione: *"$KLED does not represent equity in Nitrility Inc."*
- Swash, Vana, Grass, Hivemapper: tutti utility/governance, nessun diritto su azioni o utili della società.
- Quando gli utenti hanno ricevuto equity vera, è successo **fuori dal token**, con strumenti regolati:
  - IPO con directed share program (Reddit, Uber, Airbnb)
  - cooperativa di cui gli utenti sono soci (MIDATA in Svizzera)
- Quota delle fee di staking (Kled) è la zona grigia: economicamente assomiglia a un dividendo.

### 2.5 La fiducia si perde sulla tesoreria
Il caso Kled (vendita di $800k da wallet del team dopo un buyback annunciato) mostra che servono:
vesting **on-chain** non revocabile, tesoreria trasparente, buyback programmatici invece che "discrezionali".

---

## 3. Implicazioni per TRACE

1. **Gli utenti vanno pagati in USDC dai buyer**, non in un token emesso dal nulla. È ciò che il summary
   originale proponeva ed è dove Grass e Kled sono arrivati dopo anni.
2. **Se esiste un token TRACE, deve essere legato al consumo dei buyer**:
   - es. fee del protocollo su ogni bounty → buyback & burn TRACE eseguito dal programma (non discrezionale), oppure
   - i buyer bruciano TRACE per pubblicare richieste / ottenere priorità (stile Hivemapper).
3. **L'equity non va messa nel token.** Se volete che gli utenti partecipino al valore della società,
   i precedenti puliti sono: struttura cooperativa (MIDATA) o un futuro programma azionario regolato
   (stile Reddit/Uber). Nel pitch può essere la visione, non una feature del token.
4. **Vesting del team on-chain** fin dal giorno zero: è un argomento di pitch, non solo di sicurezza.
5. **Differenziazione**: nessuno dei comparabili mostra all'utente un'offerta finanziata dai buyer
   *sui dati storici che ha già* prima che lasci il dispositivo (Kled mostra il compenso, ma per dati
   nuovi da catturare; Brave fa matching locale, ma per ads, non per vendere dati).

---

## Fonti

- Swash: https://swashapp.io/blog/the-swash-token-giving-rise-to-a-new-paradigm-in-data/ — https://www.bitget.com/price/swash/historical-data — https://streamr.network/case-studies/swash/
- Vana: https://www.kucoin.com/research/project-reports/vana-vana — https://docs.vana.org/docs/vanaxp-your-proof-of-contribution — https://ownyourmind.ai/projects/vana/
- Grass: https://stakin.com/blog/grass-rewards-and-token-utility-explained — https://www.theblock.co/post/323805/grass-becomes-most-distributed-solana-airdrop-as-nearly-1-5-million-addresses-claim-tokens — https://airdropeasy.com/en/news/grass-stage-2-rewards-checker/ — https://bbx.com/article/542440
- Kled: https://www.kled.ai/kled-tokenomics — https://solanacompass.com/news/kled-ai-signs-12m-data-deal-calls-marketplace-officially-profitable — https://cryptoslate.com/silent-800k-shuffle-kled-ai-wallet-moves-sparks-debate-over-token-buybacks-promise/
- Hivemapper: https://studio.hivemapper.com/mapping-network/ — https://docs.hivemapper.com/honey-token/earning-honey/reward-types/
- Brave/BAT: https://www.gate.com/learn/articles/how-bat-reward-mechanism-works
- MIDATA: https://www.midata.coop/en/cooperative/
- Reddit DSP: https://fortune.com/2024/03/20/reddit-ipo-directed-share-program-dsr-initial-public-offering — https://www.cbsnews.com/news/reddit-ipo-shares-redditors-how-it-works/
