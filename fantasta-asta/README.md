# Asta Fantacalcio — Guida deploy

## 1. Supabase (database + realtime)

1. Vai su [supabase.com](https://supabase.com) → **New project**.
2. Una volta creato, apri **SQL Editor** → incolla tutto il contenuto di `supabase_schema.sql` → **Run**.
3. Vai su **Project Settings → API**: copia `Project URL` e `anon public key`. Ti serviranno tra poco.
4. (Opzionale ma consigliato) Cambia il PIN editor di default: nella tabella `config` (Table Editor), modifica il campo `editor_pin` da `1234` a un PIN tuo. Questo è il PIN che darai solo ai 4 editor.

## 2. Repository GitHub

1. Crea un nuovo repo (es. `asta-fantacalcio`).
2. Carica tutti i file di questo progetto (drag & drop su GitHub va bene, oppure `git push` se preferisci da terminale).
3. **Non caricare un file `.env` con le chiavi vere** — userai le variabili d'ambiente di Vercel (punto 3).

## 3. Deploy su Vercel

1. Vai su [vercel.com](https://vercel.com) → **Add New Project** → importa il repo GitHub appena creato.
2. Framework preset: Vercel lo rileva da solo come **Vite**.
3. Prima di fare deploy, apri **Environment Variables** e aggiungi:
   - `VITE_SUPABASE_URL` = l'URL copiato da Supabase
   - `VITE_SUPABASE_ANON_KEY` = la anon key copiata da Supabase
4. Deploy. In ~1 minuto ottieni un link tipo `https://asta-fantacalcio.vercel.app` — quello è il link da condividere con tutti e 12 i partecipanti.

## 4. Il giorno dell'asta

1. Apri il link su un computer/tablet: la prima volta ti chiederà di creare le 12 squadre (nomi + crediti iniziali, 500-725). Fallo una sola volta, tutti vedranno le stesse squadre.
2. I 4 editor incollano il PIN nel campo in alto a destra per sbloccare i pulsanti di acquisto.
3. Un editor importa la lista giocatori (CSV con colonne `nome,ruolo,squadra,codice`) dal pulsante "Importa lista".
4. Durante l'asta: cerchi il giocatore nella colonna sinistra, clicchi "Assegna", scegli squadra/prezzo/tipo (Normale, Conferma, Prelazione, o Blocco portieri per i portieri).
5. Tutti i 12 vedono l'assegnazione comparire in tempo reale sulla loro board, senza dover fare nulla.
6. A fine asta: pulsante "Esporta Excel" in alto — genera un file con tutte le rose, prezzi e annotazioni (conferma/prelazione/blocco portieri).

## 5. Formato del file CSV da importare

```
nome,ruolo,squadra,codice
Osimhen,A,Napoli,OSI001
Maignan,P,Milan,MAI002
```

- `ruolo` deve essere una lettera: P, D, C, A.
- `codice` è il codice interno fantacalcio: viene salvato ma **mai mostrato** durante la selezione — utile solo dopo, per l'export/integrazione con Fantacalcio Leghe.
- Se la tua lista è in Excel, salvala con "Salva come → CSV" prima di importarla.

## 6. Note su stabilità e sicurezza

- **Persistenza**: tutti i dati vivono su Supabase (Postgres), non nel browser. Se qualcuno chiude la scheda o cade la connessione, alla riapertura del link ritrova tutto.
- **Realtime**: gli aggiornamenti si propagano via websocket a tutti i client collegati, tipicamente in meno di un secondo.
- **Permessi**: qualsiasi cosa che chiami la funzione di scrittura (inserire un acquisto, importare la lista) richiede di aver sbloccato la modalità editor con il PIN. Attenzione: è una protezione adeguata per un contesto privato tra amici, non un sistema di autenticazione bancario — chiunque conosca il PIN può scrivere. Se vuoi un controllo più rigido (autenticazione via email per i 4 editor, RLS lato server basata su utente reale invece che PIN client-side) è fattibile ma richiede un setup più complesso con Supabase Auth: dimmelo se ti interessa e te lo preparo.
- **Backup**: da Supabase → Database → Backups puoi scaricare in ogni momento un dump completo, oltre all'export Excel manuale già integrato nell'app.

## 7. Sviluppo locale (opzionale, se vuoi testare prima)

```bash
npm install
cp .env.example .env   # poi inserisci le tue chiavi Supabase
npm run dev
```
