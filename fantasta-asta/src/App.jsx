import { useEffect, useMemo, useState, useCallback } from 'react'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import { supabase } from './supabaseClient'

const RUOLI = ['P', 'D', 'C', 'A']
const RUOLO_LABEL = { P: 'Portieri', D: 'Difensori', C: 'Centrocampisti', A: 'Attaccanti' }
const TAG_LABEL = {
  normale: 'Normale',
  conferma: 'Conferma',
  prelazione: 'Prelazione',
  blocco_portieri: 'Blocco portieri',
}

export default function App() {
  const [config, setConfig] = useState(null)
  const [teams, setTeams] = useState([])
  const [players, setPlayers] = useState([])
  const [picks, setPicks] = useState([])
  const [loading, setLoading] = useState(true)

  const [isEditor, setIsEditor] = useState(false)
  const [pinInput, setPinInput] = useState('')
  const [pinError, setPinError] = useState(false)

  const [filterRuolo, setFilterRuolo] = useState('P')
  const [search, setSearch] = useState('')
  const [assignPlayer, setAssignPlayer] = useState(null) // player being assigned
  const [setupOpen, setSetupOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  // ---------- Caricamento dati + realtime ----------
  const loadAll = useCallback(async () => {
    const [cfgRes, teamsRes, playersRes, picksRes] = await Promise.all([
      supabase.from('config').select('*').eq('id', 1).single(),
      supabase.from('teams').select('*').order('nome'),
      supabase.from('players').select('*').order('nome'),
      supabase.from('picks').select('*'),
    ])
    setConfig(cfgRes.data)
    setTeams(teamsRes.data || [])
    setPlayers(playersRes.data || [])
    setPicks(picksRes.data || [])
    setLoading(false)
  }, [])

  useEffect(() => {
    loadAll()
    const channel = supabase
      .channel('asta-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'picks' }, loadAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players' }, loadAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'teams' }, loadAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'config' }, loadAll)
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [loadAll])

  // ---------- Editor PIN ----------
  const tryUnlock = () => {
    if (config && pinInput === config.editor_pin) {
      setIsEditor(true)
      setPinError(false)
    } else {
      setPinError(true)
    }
  }

  // ---------- Slot calcolati ----------
  const slotConfig = useMemo(() => {
    if (!config) return { P: 3, D: 8, C: 8, A: 6 }
    return {
      P: 3,
      D: 8 + (config.slot_extra_d || 0),
      C: 8 + (config.slot_extra_c || 0),
      A: 6 + (config.slot_extra_a || 0),
    }
  }, [config])

  // ---------- Dati derivati per squadra ----------
  const teamStats = useMemo(() => {
    const map = {}
    for (const t of teams) {
      const teamPicks = picks.filter((p) => p.team_id === t.id)
      const speso = teamPicks.reduce((s, p) => s + p.prezzo, 0)
      const rimanenti = t.crediti_iniziali - speso
      const perRuolo = {}
      for (const r of RUOLI) {
        const occupati = teamPicks.filter((p) => {
          const pl = players.find((pp) => pp.id === p.player_id)
          return pl?.ruolo === r
        }).length
        perRuolo[r] = { occupati, tot: slotConfig[r] }
      }
      const slotLiberi = RUOLI.reduce((s, r) => s + Math.max(perRuolo[r].tot - perRuolo[r].occupati, 0), 0)
      const maxRilancio = slotLiberi > 0 ? Math.max(rimanenti - (slotLiberi - 1), 0) : rimanenti
      map[t.id] = { speso, rimanenti, perRuolo, slotLiberi, maxRilancio, picks: teamPicks }
    }
    return map
  }, [teams, picks, players, slotConfig])

  // ---------- Import CSV lista giocatori ----------
  const handleImportFile = (file) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (res) => {
        const rows = res.data
          .map((r) => ({
            nome: (r.nome || r.Nome || '').trim(),
            ruolo: (r.ruolo || r.Ruolo || '').trim().toUpperCase().slice(0, 1),
            squadra_reale: (r.squadra || r.Squadra || r.squadra_reale || '').trim(),
            codice: (r.codice || r.Codice || '').trim(),
          }))
          .filter((r) => r.nome && RUOLI.includes(r.ruolo))
        if (rows.length === 0) {
          alert('Nessuna riga valida trovata. Colonne attese: nome, ruolo, squadra, codice')
          return
        }
        const { error } = await supabase.from('players').insert(rows)
        if (error) alert('Errore import: ' + error.message)
        else {
          alert(`Importati ${rows.length} giocatori.`)
          setImportOpen(false)
        }
      },
    })
  }

  // ---------- Assegnazione giocatore ----------
  const confirmAssign = async ({ teamId, prezzo, tag }) => {
    if (!assignPlayer) return
    const { error } = await supabase.from('picks').insert({
      team_id: teamId,
      player_id: assignPlayer.id,
      prezzo: Number(prezzo),
      tag,
    })
    if (error) {
      alert('Errore: ' + error.message)
      return
    }
    await supabase.from('players').update({ acquistato: true }).eq('id', assignPlayer.id)
    setAssignPlayer(null)
  }

  const removePick = async (pickId, playerId) => {
    if (!confirm('Annullare questo acquisto?')) return
    await supabase.from('picks').delete().eq('id', pickId)
    await supabase.from('players').update({ acquistato: false }).eq('id', playerId)
  }

  // ---------- Setup squadre iniziali ----------
  const createTeams = async (list) => {
    // list: [{nome, crediti_iniziali}, ...]
    const { error } = await supabase.from('teams').insert(list)
    if (error) alert('Errore: ' + error.message)
    setSetupOpen(false)
  }

  const updateSlotExtra = async (field, value) => {
    await supabase.from('config').update({ [field]: value }).eq('id', 1)
  }

  // ---------- Export Excel ----------
  const exportExcel = () => {
    const rows = []
    for (const t of teams) {
      const st = teamStats[t.id]
      for (const p of st.picks) {
        const pl = players.find((pp) => pp.id === p.player_id)
        rows.push({
          Squadra: t.nome,
          Giocatore: pl?.nome || '?',
          Ruolo: pl?.ruolo || '?',
          'Squadra Serie A': pl?.squadra_reale || '?',
          Prezzo: p.prezzo,
          Nota: TAG_LABEL[p.tag] || p.tag,
        })
      }
      rows.push({
        Squadra: t.nome,
        Giocatore: '--- TOTALE ---',
        Ruolo: '',
        'Squadra Serie A': '',
        Prezzo: st.speso,
        Nota: `Rimanenti: ${st.rimanenti}`,
      })
    }
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Rose Asta')
    XLSX.writeFile(wb, `asta_fantacalcio_${new Date().toISOString().slice(0, 10)}.xlsx`)
  }

  const filteredPlayers = useMemo(() => {
    return players
      .filter((p) => p.ruolo === filterRuolo)
      .filter((p) => !p.acquistato)
      .filter((p) => p.nome.toLowerCase().includes(search.toLowerCase()))
      .slice(0, 60)
  }, [players, filterRuolo, search])

  if (loading) return <div className="loading-screen">Caricamento asta…</div>

  if (teams.length === 0) {
    return <SetupScreen onCreate={createTeams} />
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">⚽</span>
          <h1>Asta Fantacalcio</h1>
        </div>
        <div className="topbar-actions">
          {!isEditor ? (
            <div className="pin-box">
              <input
                type="password"
                placeholder="PIN editor"
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && tryUnlock()}
                className={pinError ? 'error' : ''}
              />
              <button onClick={tryUnlock}>Sblocca</button>
            </div>
          ) : (
            <>
              <span className="editor-badge">Modalità editor attiva</span>
              <button className="btn-secondary" onClick={() => setImportOpen(true)}>
                Importa lista
              </button>
            </>
          )}
          <button className="btn-primary" onClick={exportExcel}>
            Esporta Excel
          </button>
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <div className="ruolo-tabs">
            {RUOLI.map((r) => (
              <button
                key={r}
                className={filterRuolo === r ? 'active' : ''}
                onClick={() => setFilterRuolo(r)}
              >
                {RUOLO_LABEL[r]}
              </button>
            ))}
          </div>
          <input
            className="search-box"
            placeholder="Cerca giocatore…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="player-list">
            {filteredPlayers.length === 0 && <p className="empty-hint">Nessun giocatore disponibile.</p>}
            {filteredPlayers.map((p) => (
              <div key={p.id} className="player-row">
                <div>
                  <span className={`role-chip role-${p.ruolo}`}>{p.ruolo}</span>
                  <strong>{p.nome}</strong>
                  <div className="player-sub">{p.squadra_reale}</div>
                </div>
                {isEditor && (
                  <button className="btn-mini" onClick={() => setAssignPlayer(p)}>
                    Assegna
                  </button>
                )}
              </div>
            ))}
          </div>

          {isEditor && (
            <div className="slot-extra-panel">
              <h4>Slot extra</h4>
              <SlotExtraRow
                label="Difensori (+2 max)"
                value={config.slot_extra_d}
                max={2}
                onChange={(v) => updateSlotExtra('slot_extra_d', v)}
              />
              <SlotExtraRow
                label="Centrocampisti (+2 max)"
                value={config.slot_extra_c}
                max={2}
                onChange={(v) => updateSlotExtra('slot_extra_c', v)}
              />
              <SlotExtraRow
                label="Attaccanti (+1 max)"
                value={config.slot_extra_a}
                max={1}
                onChange={(v) => updateSlotExtra('slot_extra_a', v)}
              />
            </div>
          )}
        </aside>

        <main className="board">
          <div className="teams-grid">
            {teams.map((t) => (
              <TeamCard
                key={t.id}
                team={t}
                stats={teamStats[t.id]}
                players={players}
                slotConfig={slotConfig}
                isEditor={isEditor}
                onRemovePick={removePick}
              />
            ))}
          </div>
        </main>
      </div>

      {assignPlayer && (
        <AssignModal
          player={assignPlayer}
          teams={teams}
          teamStats={teamStats}
          onCancel={() => setAssignPlayer(null)}
          onConfirm={confirmAssign}
        />
      )}

      {importOpen && (
        <ImportModal onCancel={() => setImportOpen(false)} onFile={handleImportFile} />
      )}
    </div>
  )
}

function SlotExtraRow({ label, value, max, onChange }) {
  return (
    <div className="slot-extra-row">
      <span>{label}</span>
      <div className="stepper">
        <button onClick={() => onChange(Math.max(0, value - 1))}>−</button>
        <strong>{value}</strong>
        <button onClick={() => onChange(Math.min(max, value + 1))}>+</button>
      </div>
    </div>
  )
}

function TeamCard({ team, stats, players, slotConfig, isEditor, onRemovePick }) {
  return (
    <div className="team-card">
      <div className="team-card-header">
        <h3>{team.nome}</h3>
        <span className="credits-pill">{team.crediti_iniziali} cr.</span>
      </div>
      <div className="team-card-stats">
        <div>
          <span className="stat-label">Speso</span>
          <span className="stat-value">{stats.speso}</span>
        </div>
        <div>
          <span className="stat-label">Rimanenti</span>
          <span className="stat-value highlight">{stats.rimanenti}</span>
        </div>
        <div>
          <span className="stat-label">Max rilancio</span>
          <span className="stat-value">{stats.maxRilancio}</span>
        </div>
      </div>
      <div className="slot-bar">
        {RUOLI.map((r) => (
          <span key={r} className={`slot-chip role-${r}`}>
            {r} {stats.perRuolo[r].occupati}/{slotConfig[r]}
          </span>
        ))}
      </div>
      <div className="team-roster">
        {stats.picks.length === 0 && <p className="empty-hint">Nessun giocatore ancora.</p>}
        {stats.picks.map((p) => {
          const pl = players.find((pp) => pp.id === p.player_id)
          return (
            <div key={p.id} className="roster-row">
              <span className={`role-chip role-${pl?.ruolo}`}>{pl?.ruolo}</span>
              <span className="roster-name">{pl?.nome}</span>
              <span className="roster-price">{p.prezzo}</span>
              {p.tag !== 'normale' && <span className={`tag-chip tag-${p.tag}`}>{TAG_LABEL[p.tag]}</span>}
              {isEditor && (
                <button className="btn-x" onClick={() => onRemovePick(p.id, p.player_id)}>
                  ×
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function AssignModal({ player, teams, teamStats, onCancel, onConfirm }) {
  const [teamId, setTeamId] = useState(teams[0]?.id || '')
  const [prezzo, setPrezzo] = useState(1)
  const [tag, setTag] = useState('normale')

  const tagOptions =
    player.ruolo === 'P'
      ? ['normale', 'blocco_portieri']
      : ['normale', 'conferma', 'prelazione']

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          Assegna <strong>{player.nome}</strong> ({player.ruolo} – {player.squadra_reale})
        </h3>
        <label>Squadra</label>
        <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.nome} — rimanenti {teamStats[t.id]?.rimanenti}
            </option>
          ))}
        </select>
        <label>Prezzo (crediti)</label>
        <input type="number" min="1" value={prezzo} onChange={(e) => setPrezzo(e.target.value)} />
        <label>Tipo</label>
        <select value={tag} onChange={(e) => setTag(e.target.value)}>
          {tagOptions.map((t) => (
            <option key={t} value={t}>
              {TAG_LABEL[t]}
            </option>
          ))}
        </select>
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onCancel}>
            Annulla
          </button>
          <button className="btn-primary" onClick={() => onConfirm({ teamId, prezzo, tag })}>
            Conferma acquisto
          </button>
        </div>
      </div>
    </div>
  )
}

function ImportModal({ onCancel, onFile }) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Importa lista giocatori</h3>
        <p className="modal-hint">
          File CSV con colonne: <code>nome, ruolo, squadra, codice</code>. Ruolo deve essere P, D, C o A.
        </p>
        <input
          type="file"
          accept=".csv"
          onChange={(e) => e.target.files[0] && onFile(e.target.files[0])}
        />
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onCancel}>
            Chiudi
          </button>
        </div>
      </div>
    </div>
  )
}

function SetupScreen({ onCreate }) {
  const [n, setN] = useState(12)
  const [creditiDefault, setCreditiDefault] = useState(500)
  const [names, setNames] = useState(Array.from({ length: 12 }, (_, i) => `Squadra ${i + 1}`))

  const handleNChange = (val) => {
    const num = Number(val)
    setN(num)
    setNames((prev) => {
      const arr = [...prev]
      while (arr.length < num) arr.push(`Squadra ${arr.length + 1}`)
      return arr.slice(0, num)
    })
  }

  const submit = () => {
    const list = names.map((nome) => ({ nome, crediti_iniziali: Number(creditiDefault) }))
    onCreate(list)
  }

  return (
    <div className="setup-screen">
      <div className="setup-card">
        <h2>Configura l'asta</h2>
        <p>Prima di iniziare, crea le squadre partecipanti.</p>
        <label>Numero squadre</label>
        <input type="number" min="2" max="20" value={n} onChange={(e) => handleNChange(e.target.value)} />
        <label>Crediti iniziali (uguali per tutti, modificabile dopo per squadra da Supabase)</label>
        <input
          type="number"
          min="500"
          max="725"
          value={creditiDefault}
          onChange={(e) => setCreditiDefault(e.target.value)}
        />
        <label>Nomi squadre</label>
        <div className="names-grid">
          {names.map((name, i) => (
            <input
              key={i}
              value={name}
              onChange={(e) => {
                const arr = [...names]
                arr[i] = e.target.value
                setNames(arr)
              }}
            />
          ))}
        </div>
        <button className="btn-primary" onClick={submit}>
          Crea squadre e inizia
        </button>
      </div>
    </div>
  )
}
