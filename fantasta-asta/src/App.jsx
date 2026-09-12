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
  const [assignPlayer, setAssignPlayer] = useState(null)
  const [importOpen, setImportOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [timerDurationInput, setTimerDurationInput] = useState(60)
  const [myTeamId, setMyTeamId] = useState(() => localStorage.getItem('asta_my_team_id') || '')

  const chooseMyTeam = (teamId) => {
    setMyTeamId(teamId)
    if (teamId) localStorage.setItem('asta_my_team_id', teamId)
    else localStorage.removeItem('asta_my_team_id')
  }

  // ---------- Caricamento dati + realtime ----------
  const [loadError, setLoadError] = useState(null)

  const loadAll = useCallback(async () => {
    try {
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
      setLoadError(null)
    } catch (err) {
      setLoadError(err?.message || 'Errore di connessione al database.')
    } finally {
      setLoading(false)
    }
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

  useEffect(() => {
    if (config?.current_phase) setFilterRuolo(config.current_phase)
  }, [config?.current_phase])

  useEffect(() => {
    if (config?.timer_duration) setTimerDurationInput(config.timer_duration)
  }, [config?.timer_duration])

  // Ticking del countdown: aggiorna ogni 250ms solo se un timer è attivo
  useEffect(() => {
    if (!config?.timer_active) return
    const interval = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(interval)
  }, [config?.timer_active])

  // ---------- Editor PIN ----------
  const tryUnlock = () => {
    if (config && pinInput === config.editor_pin) {
      setIsEditor(true)
      setPinError(false)
    } else {
      setPinError(true)
    }
  }

  // ---------- Slot base / massimi ----------
  const slotBase = useMemo(() => {
    const d = { P: 3, D: 8, C: 8, A: 6 }
    if (!config) return d
    return {
      P: config.slot_base_p ?? d.P,
      D: config.slot_base_d ?? d.D,
      C: config.slot_base_c ?? d.C,
      A: config.slot_base_a ?? d.A,
    }
  }, [config])

  const maxExtra = useMemo(() => {
    const d = { P: 0, D: 2, C: 2, A: 1 }
    if (!config) return d
    return {
      P: config.max_extra_p ?? d.P,
      D: config.max_extra_d ?? d.D,
      C: config.max_extra_c ?? d.C,
      A: config.max_extra_a ?? d.A,
    }
  }, [config])

  const teamSlotFor = useCallback(
    (team, ruolo) => {
      const key = `extra_${ruolo.toLowerCase()}`
      const extra = Math.min(team[key] || 0, maxExtra[ruolo])
      return slotBase[ruolo] + extra
    },
    [slotBase, maxExtra]
  )

  // ---------- Dati derivati per squadra ----------
  const teamStats = useMemo(() => {
    const map = {}
    for (const t of teams) {
      const teamPicks = picks.filter((p) => p.team_id === t.id)
      const speso = teamPicks.reduce((s, p) => s + p.prezzo, 0)
      const rimanenti = t.crediti_iniziali - speso
      const perRuolo = {}
      for (const r of RUOLI) {
        const picksRuolo = teamPicks.filter((p) => {
          const pl = players.find((pp) => pp.id === p.player_id)
          return pl?.ruolo === r
        })
        perRuolo[r] = { occupati: picksRuolo.length, tot: teamSlotFor(t, r), picks: picksRuolo }
      }
      const slotLiberi = RUOLI.reduce((s, r) => s + Math.max(perRuolo[r].tot - perRuolo[r].occupati, 0), 0)
      const maxRilancio = slotLiberi > 0 ? Math.max(rimanenti - (slotLiberi - 1), 0) : rimanenti
      map[t.id] = { speso, rimanenti, perRuolo, slotLiberi, maxRilancio, picks: teamPicks }
    }
    return map
  }, [teams, picks, players, teamSlotFor])

  // ---------- Slot per squadra (contestuali al ruolo attivo) ----------
  const changeTeamSlot = async (team, ruolo, delta) => {
    const key = `extra_${ruolo.toLowerCase()}`
    const current = team[key] || 0
    const next = Math.max(0, Math.min(maxExtra[ruolo], current + delta))
    if (next === current) return
    const { error } = await supabase.from('teams').update({ [key]: next }).eq('id', team.id)
    if (error) {
      alert(
        'Errore aggiornando lo slot: ' +
          error.message +
          "\n\nProbabile causa: mancano le colonne extra_p/d/c/a su Supabase. Esegui migration_fasi_slot.sql nell'SQL Editor."
      )
    }
  }

  // ---------- Crediti squadra (modifica diretta sulla card) ----------
  const updateTeamCredits = async (teamId, crediti) => {
    const val = Number(crediti)
    if (!Number.isFinite(val) || val < 0) return
    const { error } = await supabase.from('teams').update({ crediti_iniziali: val }).eq('id', teamId)
    if (error) alert('Errore aggiornando i crediti: ' + error.message)
  }

  // ---------- Import CSV lista giocatori ----------
  const handleImportFile = (file) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (res) => {
        const rows = res.data
          .map((r) => ({
            nome: (r.Nome || r.nome || '').trim(),
            ruolo: (r.Ruolo || r.ruolo || '').trim().toUpperCase().slice(0, 1),
            squadra_reale: (r.Squadra || r.squadra || r.squadra_reale || '').trim(),
            codice: (r.Id || r.ID || r.id || r.Codice || r.codice || '').toString().trim(),
          }))
          .filter((r) => r.nome && RUOLI.includes(r.ruolo))
        if (rows.length === 0) {
          alert('Nessuna riga valida trovata. Colonne attese: Nome, Ruolo, Squadra, Id')
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
    const info = teamStats[teamId]?.perRuolo?.[assignPlayer.ruolo]
    if (info && info.occupati >= info.tot) {
      alert('Questa squadra non ha più slot liberi per questo ruolo.')
      return
    }
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

  // ---------- Countdown asta ----------
  const timerActive = !!config?.timer_active
  const timerEndAt = config?.timer_end_at ? new Date(config.timer_end_at).getTime() : null
  const remainingMs = timerActive && timerEndAt ? Math.max(0, timerEndAt - now) : null
  const remainingSeconds = remainingMs !== null ? Math.ceil(remainingMs / 1000) : null
  const timerExpired = timerActive && remainingSeconds === 0

  const startOrRestartTimer = async () => {
    const duration = Math.max(1, Number(timerDurationInput) || 60)
    const endAt = new Date(Date.now() + duration * 1000).toISOString()
    const { error } = await supabase
      .from('config')
      .update({ timer_duration: duration, timer_end_at: endAt, timer_active: true, last_bid_team_id: myTeamId || null })
      .eq('id', 1)
    if (error) {
      alert(
        'Errore avviando il countdown: ' +
          error.message +
          "\n\nProbabile causa: mancano le colonne timer_*/last_bid_team_id su Supabase. Esegui migration_fasi_slot.sql nell'SQL Editor."
      )
    }
  }

  const resetTimer = async () => {
    await supabase.from('config').update({ timer_end_at: null, timer_active: false, last_bid_team_id: null }).eq('id', 1)
  }

  // ---------- Setup squadre iniziali ----------
  const createTeams = async (list) => {
    const { error } = await supabase.from('teams').insert(list)
    if (error) alert('Errore: ' + error.message)
  }

  // ---------- Fasi asta ----------
  const currentPhase = config?.current_phase && RUOLI.includes(config.current_phase) ? config.current_phase : 'P'
  const phaseIndex = RUOLI.indexOf(currentPhase)
  const advancePhase = async () => {
    const next = RUOLI[phaseIndex + 1]
    if (!next) return
    if (!confirm(`Passare alla fase "${RUOLO_LABEL[next]}"? Le fasi precedenti restano comunque consultabili.`)) return
    const { error } = await supabase.from('config').update({ current_phase: next }).eq('id', 1)
    if (error) {
      alert(
        'Errore avanzando la fase: ' +
          error.message +
          '\n\nProbabile causa: manca la colonna current_phase su Supabase. Esegui migration_fasi_slot.sql nell\'SQL Editor.'
      )
      return
    }
    setFilterRuolo(next)
  }
  const goBackPhase = async () => {
    const prev = RUOLI[phaseIndex - 1]
    if (!prev) return
    if (!confirm(`Tornare alla fase "${RUOLO_LABEL[prev]}"? Si potrà comunque riavanzare in seguito.`)) return
    const { error } = await supabase.from('config').update({ current_phase: prev }).eq('id', 1)
    if (error) {
      alert('Errore tornando alla fase precedente: ' + error.message)
      return
    }
    setFilterRuolo(prev)
  }

  // ---------- Impostazioni slot ----------
  const updateSlotSettings = async (patch) => {
    await supabase.from('config').update(patch).eq('id', 1)
  }

  // ---------- Reset asta ----------

  const resetAsta = async () => {
    const conferma = prompt(
      'Questo cancellerà TUTTI gli acquisti fatti finora (le squadre e la lista giocatori restano). Scrivi RESET per confermare:'
    )
    if (conferma !== 'RESET') return
    // Azzera prima il riferimento all'ultimo rilancio, altrimenti eventuali vincoli non danno problemi qui
    // (le squadre non vengono cancellate in questo reset), ma lo facciamo comunque per coerenza.
    await supabase.from('config').update({ last_bid_team_id: null, timer_end_at: null, timer_active: false }).eq('id', 1)
    const r1 = await supabase.from('picks').delete().neq('id', '00000000-0000-0000-0000-000000000000')
    if (r1.error) return alert('Errore cancellando gli acquisti: ' + r1.error.message)
    const r2 = await supabase.from('players').update({ acquistato: false }).neq('id', '00000000-0000-0000-0000-000000000000')
    if (r2.error) return alert('Errore azzerando i giocatori: ' + r2.error.message)
    for (const t of teams) {
      const r = await supabase.from('teams').update({ extra_p: 0, extra_d: 0, extra_c: 0, extra_a: 0 }).eq('id', t.id)
      if (r.error) return alert('Errore azzerando gli slot extra: ' + r.error.message)
    }
    const r3 = await supabase.from('config').update({ current_phase: 'P' }).eq('id', 1)
    if (r3.error) return alert('Errore riportando la fase a Portieri: ' + r3.error.message)
    alert('Asta resettata: acquisti azzerati, fase riportata a Portieri.')
  }

  const wipeEverything = async () => {
    const conferma = prompt(
      'Questo cancellerà ANCHE le squadre e la lista giocatori importata (si riparte dalla schermata di setup iniziale). Scrivi CANCELLA TUTTO per confermare:'
    )
    if (conferma !== 'CANCELLA TUTTO') return
    // Fondamentale: azzera il riferimento all'ultimo rilancio PRIMA di cancellare le squadre,
    // altrimenti la cancellazione delle squadre fallisce per vincolo di integrità referenziale.
    const r0 = await supabase
      .from('config')
      .update({ last_bid_team_id: null, timer_end_at: null, timer_active: false, current_phase: 'P' })
      .eq('id', 1)
    if (r0.error) return alert('Errore preparando il reset: ' + r0.error.message)

    const r1 = await supabase.from('picks').delete().neq('id', '00000000-0000-0000-0000-000000000000')
    if (r1.error) return alert('Errore cancellando gli acquisti: ' + r1.error.message)

    const r2 = await supabase.from('players').delete().neq('id', '00000000-0000-0000-0000-000000000000')
    if (r2.error) return alert('Errore cancellando i giocatori: ' + r2.error.message)

    const r3 = await supabase.from('teams').delete().neq('id', '00000000-0000-0000-0000-000000000000')
    if (r3.error) return alert('Errore cancellando le squadre: ' + r3.error.message)

    alert('Tutto cancellato. La pagina tornerà automaticamente al setup iniziale.')
  }

  // ---------- Export Excel (riepilogo generale) ----------
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

  // ---------- Export CSV formato FantaAsta Live / Leghe Fantacalcio ----------
  // Formato: nessuna intestazione, righe "$,$,$" a separare i blocchi squadra,
  // poi righe "NomeSquadra,IdGiocatore,PrezzoPagato". L'Id DEVE essere quello
  // ufficiale del listone fantacalcio.it (colonna "codice" importata insieme ai giocatori).
  const exportForLega = () => {
    const senzaId = []
    const lines = []
    for (const t of teams) {
      lines.push('$,$,$')
      const st = teamStats[t.id]
      for (const p of st.picks) {
        const pl = players.find((pp) => pp.id === p.player_id)
        const id = (pl?.codice || '').trim()
        if (!id) senzaId.push(`${pl?.nome || '?'} (${t.nome})`)
        lines.push(`${t.nome},${id},${p.prezzo}`)
      }
    }
    if (senzaId.length > 0) {
      alert(
        'Attenzione: questi giocatori non hanno un Id salvato e nel file esportato risulteranno senza ID ' +
          '(l\'import su Leghe Fantacalcio probabilmente li scarterà):\n\n' +
          senzaId.join('\n') +
          '\n\nControlla che la lista giocatori importata contenga la colonna Id con il codice ufficiale del listone.'
      )
    }
    const csv = lines.join('\r\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `fanta-asta-live-rosters_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const filteredPlayers = useMemo(() => {
    return players
      .filter((p) => p.ruolo === filterRuolo)
      .filter((p) => !p.acquistato)
      .filter((p) => p.nome.toLowerCase().includes(search.toLowerCase()))
      .slice(0, 60)
  }, [players, filterRuolo, search])

  if (loading) return <div className="loading-screen">Caricamento asta…</div>

  if (loadError) {
    return (
      <div className="loading-screen error-screen">
        <p>Non riesco a connettermi al database.</p>
        <p className="error-detail">{loadError}</p>
        <button
          className="btn-primary"
          onClick={() => {
            setLoading(true)
            loadAll()
          }}
        >
          Riprova
        </button>
      </div>
    )
  }

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
              <button className="btn-secondary" onClick={() => setSettingsOpen(true)}>
                Impostazioni
              </button>
              <button className="btn-secondary" onClick={() => setImportOpen(true)}>
                Importa lista
              </button>
            </>
          )}
          <button className="btn-primary" onClick={exportExcel}>
            Esporta Excel
          </button>
          <button className="btn-primary btn-primary-alt" onClick={exportForLega}>
            Esporta per Leghe Fantacalcio
          </button>
        </div>
      </header>

      <div className="timer-bar">
        <div className="my-team-picker">
          <span>Sei:</span>
          <select value={myTeamId} onChange={(e) => chooseMyTeam(e.target.value)}>
            <option value="">— seleziona la tua squadra —</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.nome}
              </option>
            ))}
          </select>
        </div>

        <div className={'timer-display' + (timerExpired ? ' expired' : timerActive ? ' running' : ' idle')}>
          {remainingSeconds !== null ? remainingSeconds : '—'}
          <span className="timer-unit">sec</span>
        </div>
        <div className="timer-controls">
          <input
            type="number"
            min="1"
            className="timer-duration-input"
            value={timerDurationInput}
            onChange={(e) => setTimerDurationInput(e.target.value)}
            title="Durata countdown in secondi"
          />
          {!timerExpired ? (
            <button
              className="btn-primary"
              onClick={startOrRestartTimer}
              disabled={!myTeamId}
              title={!myTeamId ? 'Seleziona prima la tua squadra' : ''}
            >
              {timerActive ? 'Riavvia' : 'Avvia'} countdown
            </button>
          ) : (
            <button className="btn-secondary" onClick={resetTimer}>
              Prossimo giocatore →
            </button>
          )}
        </div>

        <div className="last-bid-info">
          {config?.last_bid_team_id ? (
            <>
              Ultimo rilancio: <strong>{teams.find((t) => t.id === config.last_bid_team_id)?.nome || '—'}</strong>
            </>
          ) : (
            <span className="empty-hint">Nessun rilancio ancora</span>
          )}
        </div>
      </div>

      {/* ---------- Fase asta + selezione giocatore: un'unica barra in alto ---------- */}
      <div className="selector-bar">
        <div className="ruolo-tabs-horizontal">
          {RUOLI.map((r, i) => {
            const locked = i > phaseIndex
            const done = i < phaseIndex
            return (
              <button
                key={r}
                disabled={locked}
                className={
                  (filterRuolo === r ? 'active' : '') + (locked ? ' locked' : '') + (done ? ' done' : '')
                }
                onClick={() => !locked && setFilterRuolo(r)}
                title={locked ? 'Fase non ancora iniziata' : ''}
              >
                {locked ? '🔒 ' : done ? '✓ ' : ''}
                {RUOLO_LABEL[r]}
              </button>
            )
          })}
          {isEditor && phaseIndex > 0 && (
            <button className="btn-secondary phase-back-btn" onClick={goBackPhase}>
              ← Torna a {RUOLO_LABEL[RUOLI[phaseIndex - 1]]}
            </button>
          )}
          {isEditor && phaseIndex < RUOLI.length - 1 && (
            <button className="btn-mini phase-advance-btn" onClick={advancePhase}>
              Passa a {RUOLO_LABEL[RUOLI[phaseIndex + 1]]} →
            </button>
          )}
          <input
            className="search-box search-box-inline"
            placeholder="Cerca giocatore…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="player-list-horizontal">
          {filteredPlayers.length === 0 && <p className="empty-hint">Nessun giocatore disponibile.</p>}
          {filteredPlayers.map((p) => (
            <div key={p.id} className="player-chip-card">
              <span className={`role-chip role-${p.ruolo}`}>{p.ruolo}</span>
              <div className="player-chip-info">
                <strong>{p.nome}</strong>
                <span className="player-sub">{p.squadra_reale}</span>
              </div>
              {isEditor && (
                <button className="btn-mini" onClick={() => setAssignPlayer(p)}>
                  Assegna
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ---------- Squadre: riga orizzontale in basso ---------- */}
      <main className="board">
        <div className="teams-row">
          {teams.map((t) => (
            <TeamCard
              key={t.id}
              team={t}
              stats={teamStats[t.id]}
              players={players}
              activeRuolo={filterRuolo}
              maxExtra={maxExtra}
              isEditor={isEditor}
              onRemovePick={removePick}
              onChangeSlot={changeTeamSlot}
            />
          ))}
        </div>
      </main>

      {assignPlayer && (
        <AssignModal
          player={assignPlayer}
          teams={teams}
          teamStats={teamStats}
          onCancel={() => setAssignPlayer(null)}
          onConfirm={confirmAssign}
        />
      )}

      {importOpen && <ImportModal onCancel={() => setImportOpen(false)} onFile={handleImportFile} />}

      {settingsOpen && (
        <SettingsModal
          config={config}
          teams={teams}
          onCancel={() => setSettingsOpen(false)}
          onUpdateCredits={updateTeamCredits}
          onUpdateSlotSettings={updateSlotSettings}
          onResetAsta={resetAsta}
          onWipeEverything={wipeEverything}
        />
      )}
    </div>
  )
}

function TeamCard({ team, stats, players, activeRuolo, maxExtra, isEditor, onRemovePick, onChangeSlot }) {
  const key = `extra_${activeRuolo.toLowerCase()}`
  const currentExtra = team[key] || 0
  const canAddSlot = isEditor && maxExtra[activeRuolo] > 0

  return (
    <div className="team-card">
      <div className="team-card-header">
        <div className="team-card-title">
          <h3>{team.nome}</h3>
          {canAddSlot && (
            <div className="slot-request-inline" title={`Slot extra ${RUOLO_LABEL[activeRuolo]}`}>
              <button onClick={() => onChangeSlot(team, activeRuolo, -1)} disabled={currentExtra <= 0}>
                −
              </button>
              <span>
                +{currentExtra}/{maxExtra[activeRuolo]} {activeRuolo}
              </span>
              <button onClick={() => onChangeSlot(team, activeRuolo, 1)} disabled={currentExtra >= maxExtra[activeRuolo]}>
                +
              </button>
            </div>
          )}
        </div>
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
            {r} {stats.perRuolo[r].occupati}/{stats.perRuolo[r].tot}
          </span>
        ))}
      </div>


      <div className="team-roster">
        {RUOLI.map((r) => {
          const info = stats.perRuolo[r]
          const emptySlots = Math.max(info.tot - info.occupati, 0)
          if (info.tot === 0) return null
          return (
            <div key={r} className="roster-role-group">
              {info.picks.map((p) => {
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
              {Array.from({ length: emptySlots }).map((_, i) => (
                <div key={`empty-${r}-${i}`} className="roster-row roster-row-empty">
                  <span className={`role-chip role-${r}`}>{r}</span>
                  <span className="roster-name roster-empty-label">Slot libero</span>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function AssignModal({ player, teams, teamStats, onCancel, onConfirm }) {
  const teamsWithRoom = teams.filter((t) => {
    const info = teamStats[t.id]?.perRuolo?.[player.ruolo]
    return info && info.occupati < info.tot
  })
  const teamsFull = teams.filter((t) => !teamsWithRoom.includes(t))

  const [teamId, setTeamId] = useState(teamsWithRoom[0]?.id || '')
  const [prezzo, setPrezzo] = useState(1)
  const [tag, setTag] = useState('normale')

  const tagOptions = player.ruolo === 'P' ? ['normale', 'blocco_portieri'] : ['normale', 'conferma', 'prelazione']

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          Assegna <strong>{player.nome}</strong> ({player.ruolo} – {player.squadra_reale})
        </h3>
        {teamsWithRoom.length === 0 ? (
          <p className="modal-hint danger-text">
            Nessuna squadra ha più slot liberi per il ruolo {player.ruolo}. Aumenta gli slot extra dalla card
            squadra (se la fase lo consente) oppure annulla.
          </p>
        ) : (
          <>
            <label>Squadra</label>
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              {teamsWithRoom.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.nome} — rimanenti {teamStats[t.id]?.rimanenti}
                </option>
              ))}
            </select>
            {teamsFull.length > 0 && (
              <p className="modal-hint">
                Slot {player.ruolo} pieni per: {teamsFull.map((t) => t.nome).join(', ')}
              </p>
            )}
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
          </>
        )}
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onCancel}>
            Annulla
          </button>
          {teamsWithRoom.length > 0 && (
            <button className="btn-primary" onClick={() => onConfirm({ teamId, prezzo, tag })}>
              Conferma acquisto
            </button>
          )}
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
          File CSV con colonne: <code>Nome, Ruolo, Squadra, Id</code>. Ruolo deve essere P, D, C o A. Il campo Id
          viene salvato ma mai mostrato durante la selezione.
        </p>
        <p className="modal-hint danger-text">
          Importante: se poi userai "Esporta per Leghe Fantacalcio", il campo Id deve essere l'ID ufficiale del
          listone quotazioni scaricato da fantacalcio.it — non un codice a piacere — altrimenti l'import sulla
          piattaforma della lega non troverà corrispondenza.
        </p>
        <input type="file" accept=".csv" onChange={(e) => e.target.files[0] && onFile(e.target.files[0])} />
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onCancel}>
            Chiudi
          </button>
        </div>
      </div>
    </div>
  )
}

function SettingsModal({ config, teams, onCancel, onUpdateCredits, onUpdateSlotSettings, onResetAsta, onWipeEverything }) {
  const [credits, setCredits] = useState(() => Object.fromEntries(teams.map((t) => [t.id, t.crediti_iniziali])))
  const [slots, setSlots] = useState({
    slot_base_p: config.slot_base_p,
    slot_base_d: config.slot_base_d,
    slot_base_c: config.slot_base_c,
    slot_base_a: config.slot_base_a,
    max_extra_p: config.max_extra_p,
    max_extra_d: config.max_extra_d,
    max_extra_c: config.max_extra_c,
    max_extra_a: config.max_extra_a,
  })

  const saveCredits = async () => {
    for (const t of teams) {
      const val = Number(credits[t.id])
      if (Number.isFinite(val) && val !== t.crediti_iniziali) {
        await onUpdateCredits(t.id, val)
      }
    }
    alert('Crediti aggiornati.')
  }

  const saveSlots = async () => {
    await onUpdateSlotSettings(slots)
    alert('Impostazioni slot aggiornate.')
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3>Impostazioni avanzate</h3>

        <h4 className="settings-section-title">Slot base e massimi per ruolo</h4>
        <p className="modal-hint">
          "Base" è lo slot minimo garantito a ogni squadra. "Extra max" è quanti slot in più una squadra può
          richiedere durante la relativa fase (dal pulsante +/- sulla card squadra).
        </p>
        <div className="settings-slot-grid">
          {RUOLI.map((r) => (
            <div key={r} className="settings-slot-row">
              <span className={`role-chip role-${r}`}>{r}</span>
              <label>
                Base
                <input
                  type="number"
                  min="0"
                  value={slots[`slot_base_${r.toLowerCase()}`]}
                  onChange={(e) =>
                    setSlots((s) => ({ ...s, [`slot_base_${r.toLowerCase()}`]: Number(e.target.value) }))
                  }
                />
              </label>
              <label>
                Extra max
                <input
                  type="number"
                  min="0"
                  value={slots[`max_extra_${r.toLowerCase()}`]}
                  onChange={(e) =>
                    setSlots((s) => ({ ...s, [`max_extra_${r.toLowerCase()}`]: Number(e.target.value) }))
                  }
                />
              </label>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn-primary" onClick={saveSlots}>
            Salva impostazioni slot
          </button>
        </div>

        <h4 className="settings-section-title">Crediti iniziali per squadra</h4>
        <p className="modal-hint">
          Puoi anche modificare i crediti di ogni singola squadra direttamente cliccando sulla pillola crediti (✎)
          nella relativa card, senza aprire questo pannello.
        </p>
        <div className="settings-credits-grid">
          {teams.map((t) => (
            <label key={t.id} className="settings-credit-row">
              {t.nome}
              <input
                type="number"
                min="0"
                value={credits[t.id]}
                onChange={(e) => setCredits((c) => ({ ...c, [t.id]: e.target.value }))}
              />
            </label>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn-primary" onClick={saveCredits}>
            Salva crediti
          </button>
        </div>

        <h4 className="settings-section-title danger-title">Zona pericolosa</h4>
        <p className="modal-hint">
          Reset asta: cancella tutti gli acquisti e riporta la fase a Portieri, ma mantiene squadre e lista
          giocatori. Cancella tutto: azzera anche squadre e lista giocatori, si riparte dal setup iniziale.
        </p>
        <div className="modal-actions danger-actions">
          <button className="btn-danger" onClick={onResetAsta}>
            Reset asta (mantieni squadre e lista)
          </button>
          <button className="btn-danger btn-danger-strong" onClick={onWipeEverything}>
            Cancella tutto
          </button>
        </div>

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
  const [credits, setCredits] = useState(Array.from({ length: 12 }, () => 500))

  const handleNChange = (val) => {
    const num = Number(val)
    setN(num)
    setNames((prev) => {
      const arr = [...prev]
      while (arr.length < num) arr.push(`Squadra ${arr.length + 1}`)
      return arr.slice(0, num)
    })
    setCredits((prev) => {
      const arr = [...prev]
      while (arr.length < num) arr.push(creditiDefault)
      return arr.slice(0, num)
    })
  }

  const applyDefaultToAll = () => {
    setCredits(names.map(() => creditiDefault))
  }

  const submit = () => {
    const list = names.map((nome, i) => ({ nome, crediti_iniziali: Number(credits[i]) || 500 }))
    onCreate(list)
  }

  return (
    <div className="setup-screen">
      <div className="setup-card">
        <h2>Configura l'asta</h2>
        <p>Prima di iniziare, crea le squadre partecipanti. Puoi dare a ciascuna un budget diverso.</p>
        <label>Numero squadre</label>
        <input type="number" min="2" max="20" value={n} onChange={(e) => handleNChange(e.target.value)} />

        <label>Crediti di default (usali come base, poi personalizza ogni squadra sotto se serve)</label>
        <div className="setup-default-credits-row">
          <input
            type="number"
            min="0"
            value={creditiDefault}
            onChange={(e) => setCreditiDefault(Number(e.target.value))}
          />
          <button type="button" className="btn-secondary" onClick={applyDefaultToAll}>
            Applica a tutte
          </button>
        </div>

        <label>Nome e crediti per ogni squadra</label>
        <div className="names-grid setup-team-grid">
          {names.map((name, i) => (
            <div key={i} className="setup-team-row">
              <input
                value={name}
                onChange={(e) => {
                  const arr = [...names]
                  arr[i] = e.target.value
                  setNames(arr)
                }}
              />
              <input
                type="number"
                min="0"
                className="setup-team-credits"
                value={credits[i] ?? creditiDefault}
                onChange={(e) => {
                  const arr = [...credits]
                  arr[i] = e.target.value
                  setCredits(arr)
                }}
              />
            </div>
          ))}
        </div>
        <button className="btn-primary" onClick={submit}>
          Crea squadre e inizia
        </button>
      </div>
    </div>
  )
}
