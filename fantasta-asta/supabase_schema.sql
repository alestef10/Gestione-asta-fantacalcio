-- =====================================================
-- SCHEMA ASTA FANTACALCIO - Eseguire su Supabase SQL Editor
-- =====================================================

-- Estensione per generare UUID
create extension if not exists "uuid-ossp";

-- Lista giocatori fantacalcio (importata da CSV/Excel)
create table players (
  id uuid primary key default uuid_generate_v4(),
  nome text not null,
  ruolo text not null check (ruolo in ('P','D','C','A')),
  squadra_reale text not null,
  codice text,                 -- codice fantacalcio, nascosto in UI durante l'asta
  acquistato boolean default false,
  created_at timestamptz default now()
);

-- Le 12 squadre partecipanti
create table teams (
  id uuid primary key default uuid_generate_v4(),
  nome text not null,
  crediti_iniziali int not null default 500,
  slot_p int not null default 3,
  slot_d int not null default 8,
  slot_c int not null default 8,
  slot_a int not null default 6,
  created_at timestamptz default now()
);

-- Acquisti effettuati durante l'asta
create table picks (
  id uuid primary key default uuid_generate_v4(),
  team_id uuid references teams(id) on delete cascade,
  player_id uuid references players(id) on delete cascade,
  prezzo int not null,
  tag text default 'normale' check (tag in ('normale','conferma','prelazione','blocco_portieri')),
  created_at timestamptz default now()
);

-- Configurazione globale asta (slot extra attivati, PIN editor)
create table config (
  id int primary key default 1,
  slot_extra_d int default 0 check (slot_extra_d between 0 and 2),
  slot_extra_c int default 0 check (slot_extra_c between 0 and 2),
  slot_extra_a int default 0 check (slot_extra_a between 0 and 1),
  editor_pin text not null default '1234',
  constraint single_row check (id = 1)
);
insert into config (id) values (1);

-- =====================================================
-- ROW LEVEL SECURITY: lettura libera a tutti, scrittura solo con PIN valido
-- =====================================================
alter table players enable row level security;
alter table teams enable row level security;
alter table picks enable row level security;
alter table config enable row level security;

-- Lettura pubblica (tutti i 12 partecipanti vedono tutto)
create policy "public read players" on players for select using (true);
create policy "public read teams" on teams for select using (true);
create policy "public read picks" on picks for select using (true);
create policy "public read config" on config for select using (true);

-- Scrittura: la app verifica il PIN lato client prima di chiamare queste funzioni;
-- per semplicità in un contesto privato (lega amatoriale) la scrittura è aperta
-- alla anon key (che condividerai solo con i 4 editor), ma i 12 partecipanti
-- normalmente useranno solo la lettura. Se vuoi un controllo più rigido,
-- vedi la nota "SICUREZZA AVANZATA" nel README.
create policy "write players" on players for all using (true) with check (true);
create policy "write teams" on teams for all using (true) with check (true);
create policy "write picks" on picks for all using (true) with check (true);
create policy "write config" on config for all using (true) with check (true);

-- Abilita realtime sulle tabelle chiave
alter publication supabase_realtime add table picks;
alter publication supabase_realtime add table players;
alter publication supabase_realtime add table teams;
alter publication supabase_realtime add table config;
