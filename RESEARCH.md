# Trace — Ricerca iniziale (2026-10-02)

Contesto: hackathon Colosseum (Solana), team di 2, consegna in 3 giorni.
Focus immediato: token `TRACE` come reward per i contributori di dati, struttura simile a Swash.

---

## 1. Come funziona Swash (il modello di riferimento)

- Token: **SWASH**, ERC-20 su Ethereum, supply massima 1B.
- Utilità dichiarata: transact (vendita dati/servizi), govern (DAO fund, roadmap), rewards (utenti), multiply (donazione dati).
- Allocazione: Community & Platform Rewards 14%, Ecosystem & DAO Growth 14%, Foundation 15%,
  Team & Advisors 15%, Founders 15%, Pre-seed 9%, Seed 3%, Strategic 5%.
- Reward: gli utenti installano l'estensione, condividono dati di navigazione nella "Data Union",
  ricevono SWASH proporzionalmente al valore aggregato.
- Burn: 6 meccanismi di burn finanziati dai pool Ecosystem + Community (28% supply).
- Nota: il token è un **utility/governance token**, non dà diritti sull'equity della società.

## 2. ⚠️ Token "basato sull'equity" = security

Questo è il punto più importante della ricerca.

- **Svizzera (FINMA)**: classifica i token in payment / utility / **asset**. Un token che rappresenta
  "equity claims on the issuer" o una quota di utili futuri è un **asset token → trattato come security**.
  Anche un utility token, se funziona in parte come investimento, viene trattato come security.
- **USA (SEC)**: statement del 28/01/2026 — la tokenizzazione è solo "recordkeeping", non cambia la
  natura giuridica. Se dà diritti economici/voto/dividendi, è una security. L'exemption di settembre 2026
  riguarda azioni quotate su venue qualificate, non startup che distribuiscono equity come reward.
- **UE (MiCA)**: i token che sono strumenti finanziari sono esclusi da MiCA e ricadono in MiFID/prospetto.

Conseguenza pratica: **distribuire equity tokenizzata a chiunque come premio per i dati è, di fatto,
un'offerta pubblica di securities** (prospetto, KYC, restrizioni di trasferimento, ecc.).
Non è un problema per un mint su **devnet** durante l'hackathon, ma lo è per il pitch e per un lancio reale:
i giudici di Colosseum chiederanno quasi certamente "è una security?".

*(Non è consulenza legale — da verificare con un avvocato prima di qualsiasi lancio.)*

### Opzioni

| Opzione | Descrizione | Rischio legale | Effort 3 giorni |
|---|---|---|---|
| A. Utility/reward token (stile Swash) | `TRACE` dà sconti/accesso/governance, nessun diritto su equity | medio (dipende da marketing) | basso |
| B. Punti non trasferibili | Token-2022 `NonTransferable`: reputazione/contributo, non si specula | basso | basso |
| C. Equity token "vero" | security token con KYC + transfer hook whitelist | alto, serve struttura legale | medio |
| D. Solo USDC + TRACE come reputazione | utenti pagati in USDC dai buyer, TRACE solo "contribution score" | basso | medio |

Raccomandazione per l'hackathon: **A o B**, e nel pitch presentare il legame con l'equity solo come
possibilità futura "soggetta a strutturazione legale", senza prometterlo.

## 3. Lezioni dai token di reward esistenti

- **Vana** (L1 EVM, DataDAO, ~1M+ utenti): token VANA **-97% dall'ATH**, solo ~26% in circolazione.
- **Swash**: stesso pattern, prezzo crollato dopo il lancio.
- **Kled AI** (su Solana!): ha un token KLED, ma "la maggior parte dei contributori usa PayPal/Venmo
  invece di tenere il token".

Insight: gli utenti vogliono soldi reali; i reward token puri tendono a crollare perché vengono venduti
subito. Un design credibile lega il token a **domanda reale** (fee dei buyer → buyback/burn, staking dei buyer, ecc.).

## 4. ⚠️ Concorrente diretto su Solana: Kled AI

- Marketplace di "human data": i lab AI pubblicano task, **il compenso è mostrato in anticipo**, payout su Solana.
- 500k+ contributori, 8M datapoint/giorno, seed da $5.5M (totale $9M). V3 lanciata il 30/09/2026.
- Differenza rispetto a Trace: Kled paga per **catturare dati nuovi** (foto, video, audio, schermo).
  Trace valorizza la **storia digitale già esistente** (browser, Google, Amazon, Spotify), con matching
  **locale** e **a-posteriori** contro richieste già finanziate.
- Il pitch deve marcare questa distinzione in modo esplicito.

## 5. Design tecnico del token su Solana (per 3 giorni)

```
TRACE mint (Token-2022)
 ├─ MetadataPointer + TokenMetadata   → nome, simbolo, URI (logo)
 ├─ supply fissa (es. 1B), mint authority revocata dopo il mint iniziale
 └─ (opz.) NonTransferable se si sceglie l'opzione B

Allocation vaults (PDA del programma)
 ├─ Community Rewards
 ├─ Ecosystem / Treasury
 └─ Team (con vesting semplice: cliff + linear)

Reward distribution (pattern merkle distributor, epoch-based)
 1. Backend calcola i reward per wallet nell'epoca N (dai contributi accettati)
 2. Pubblica la merkle root on-chain → account Epoch{N, root, total}
 3. L'utente chiama claim(proof, amount) → transfer dal Community vault
 4. ClaimStatus PDA per (epoch, wallet) impedisce doppi claim
```

Perché il merkle distributor: una sola transazione per epoca lato backend, l'utente paga il proprio claim,
scala a migliaia di utenti, è un pattern consolidato su Solana (es. Jito/Jupiter airdrop).

## 6. Requisiti di submission Colosseum

- Repo GitHub con codice scritto durante l'hackathon (dichiarare il codice pre-esistente)
- Video pitch (max 3 min): team, problema, target user
- Video demo tecnica: implementazione, integrazione Solana, architettura
- Nome, descrizione, logo, membri del team con background

## Fonti

- Swash token: https://swashapp.io/blog/the-swash-token-giving-rise-to-a-new-paradigm-in-data/ — https://tokeninsight.com/en/coins/swash/tokenomics
- FINMA ICO guidelines: https://cms.law/en/che/legal-updates/finma-ico-guidelines — https://www.lexr.com/en-ch/blog/crypto-token-types-switzerland/
- SEC tokenized securities: https://www.morganlewis.com/pubs/2026/02/sec-clarifies-federal-securities-law-treatment-of-tokenized-securities — https://www.fintechanddigitalassets.com/2026/09/sec-clears-path-for-on-chain-trading-of-tokenized-stocks-with-landmark-innovation-exemption/
- Vana: https://coinmarketcap.com/cmc-ai/vana/latest-updates/ — https://ownyourmind.ai/projects/vana/
- Kled: https://solanacompass.com/news/kled-v3-launches-on-ios-rebuilding-its-solana-paid-ai-data-app-around-lab — https://www.founded.com/kled-ai-app-pays-for-data-used-to-train-ai/
- Token-2022: https://www.solana-program.com/docs/token-2022 — https://neodyme.io/en/blog/token-2022/
- Colosseum: https://colosseum.com/hackathon — https://github.com/SuperteamCanada/how-to-win-colosseum-hackathon
