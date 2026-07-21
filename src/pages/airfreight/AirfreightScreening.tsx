import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  collection, query, orderBy, onSnapshot, doc, setDoc,
} from 'firebase/firestore'
import { db, functions } from '../../lib/firebase'
import { httpsCallable } from 'firebase/functions'
import { useAuth } from '../../contexts/AuthContext'
import {
  AirfreightBooking, AirfreightFlight, ScreeningEvent, ScreeningSettings, EscalationEntry,
} from '../../types'
import Layout from '../../components/Layout'
import * as XLSX from 'xlsx'

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const yy = String(d.getFullYear()).slice(2)
  const hh = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${mm}/${dd}/${yy} ${hh}:${min}`
}

function fmtShortDate(iso: string) {
  if (!iso) return '—'
  // Handle YYYY-MM-DD format (no time)
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split('-')
    return `${m}/${d}/${y.slice(2)}`
  }
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${String(d.getFullYear()).slice(2)}`
}

function normalizeAwb(awb: string) {
  return (awb || '').replace(/[\s\-\u2013\u2014]/g, '').replace(/[Oo]/g, '0').trim()
}

// ── Types ────────────────────────────────────────────────────────────────────

interface ScreeningRow {
  bookingId: string
  flightId: string
  flightNumber: string
  flightDate: string
  clientName: string
  mawb: string
  awb2ndLeg: string
  bookingPieces: number
  screenedPieces: number
  screeningStatus: 'pending' | 'partial' | 'complete' | 'error'
  eventIds: string[]
  lastCertDate: string
  screener: string
  mclRep: string
}

// ── Component ────────────────────────────────────────────────────────────────

export default function AirfreightScreening() {
  const { user, isAdmin } = useAuth()
  const navigate = useNavigate()

  // Data (SOL-14: raw state for independent listeners)
  const [rawFlights, setRawFlights] = useState<(AirfreightFlight & { id: string })[]>([])
  const [rawBookings, setRawBookings] = useState<(AirfreightBooking & { id: string })[]>([])
  const [events, setEvents] = useState<(ScreeningEvent & { id: string })[]>([])
  const [escalations, setEscalations] = useState<(EscalationEntry & { id: string })[]>([])
  const [settings, setSettings] = useState<ScreeningSettings>({
    phantom_k9_emails: [],
    mcl_alert_emails: [],
    enabled: false,
  })
  const [loading, setLoading] = useState(true)

  // UI state
  const [tab, setTab] = useState<'main' | 'unmatched' | 'alerts'>('main')
  const [showConfig, setShowConfig] = useState(false)
  const [filterClient, setFilterClient] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [searchText, setSearchText] = useState('')
  const [certDateFrom, setCertDateFrom] = useState('')
  const [certDateTo, setCertDateTo] = useState('')
  const [runningNow, setRunningNow] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetFromDate, setResetFromDate] = useState('')

  // Settings form
  const [editEmails, setEditEmails] = useState('')
  const [editMclEmails, setEditMclEmails] = useState('')
  const [editEnabled, setEditEnabled] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)

  // ── Load settings ──
  useEffect(() => {
    return onSnapshot(doc(db, 'screening_settings', 'config'), snap => {
      if (snap.exists()) {
        const data = snap.data() as ScreeningSettings
        setSettings(data)
        setEditEmails((data.phantom_k9_emails || []).join(', '))
        setEditMclEmails((data.mcl_alert_emails || []).join(', '))
        setEditEnabled(data.enabled)
      }
    })
  }, [])

  // ── Load screening events ──
  useEffect(() => {
    const q = query(collection(db, 'screening_events'), orderBy('processed_at', 'desc'))
    return onSnapshot(q, snap => {
      setEvents(snap.docs.map(d => ({ ...d.data() as ScreeningEvent, id: d.id })))
    })
  }, [])

  // SOL-14: Independent listeners for flights and bookings
  useEffect(() => {
    const fQ = query(collection(db, 'airfreight_flights'), orderBy('flight_datetime', 'desc'))
    const unsubFlights = onSnapshot(fQ, fSnap => {
      setRawFlights(fSnap.docs.map(d => ({ ...d.data() as AirfreightFlight, id: d.id })))
    })

    const bQ = query(collection(db, 'airfreight_bookings'), orderBy('created_at', 'desc'))
    const unsubBookings = onSnapshot(bQ, bSnap => {
      setRawBookings(bSnap.docs.map(d => ({ ...d.data() as AirfreightBooking, id: d.id })))
      setLoading(false)
    })

    return () => { unsubFlights(); unsubBookings() }
  }, [])

  // SOL-14: Derive screening rows from raw state
  const rows = useMemo(() => {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 30)
    const cutoffISO = cutoff.toISOString()
    const flightMap = new Map(rawFlights.map(f => [f.id!, f]))
    const screenRows: ScreeningRow[] = []

    for (const b of rawBookings) {
      const flight = flightMap.get(b.flight_id)
      if (!flight) continue
      if (flight.status !== 'open' && flight.flight_datetime < cutoffISO) continue

      const base = {
        bookingId: b.id!,
        flightId: b.flight_id,
        flightNumber: flight.flight_number || flight.airline || '',
        flightDate: flight.flight_datetime,
        clientName: b.client_name,
        eventIds: b.screening_events || [],
        lastCertDate: '',
        screener: '',
        mclRep: '',
      }

      if (b.booking_type === 'mawb' && b.awb_lines) {
        if (b.mawb_number) {
          const totalPcs = b.awb_lines.reduce((s, l) => s + (l.pieces || 0), 0)
          screenRows.push({
            ...base,
            mawb: b.mawb_number,
            awb2ndLeg: '',
            bookingPieces: totalPcs,
            screenedPieces: b.screening_pieces_total || 0,
            screeningStatus: (b.screening_status as ScreeningRow['screeningStatus']) || 'pending',
          })
        } else {
          for (const line of b.awb_lines) {
            screenRows.push({
              ...base,
              mawb: '',
              awb2ndLeg: line.awb_2nd_leg || line.awb_number || '',
              bookingPieces: line.pieces || 0,
              screenedPieces: line.screening_pieces_screened || 0,
              screeningStatus: (line.screening_status as ScreeningRow['screeningStatus']) || 'pending',
            })
          }
        }
      } else if ((b.booking_type === 'ecommerce' || b.booking_type === 'export') && b.awb_lines) {
        const grouped = new Map<string, { totalPcs: number; totalScreened: number }>()
        for (const line of b.awb_lines) {
          const key = line.awb_2nd_leg || line.awb_number || ''
          const prev = grouped.get(key) || { totalPcs: 0, totalScreened: 0 }
          prev.totalPcs += line.pieces || 0
          prev.totalScreened += line.screening_pieces_screened || 0
          grouped.set(key, prev)
        }
        for (const [awbKey, sums] of grouped) {
          let st: ScreeningRow['screeningStatus'] = 'pending'
          if (sums.totalScreened > sums.totalPcs) st = 'error'
          else if (sums.totalScreened === sums.totalPcs && sums.totalScreened > 0) st = 'complete'
          else if (sums.totalScreened > 0) st = 'partial'
          screenRows.push({
            ...base,
            mawb: '',
            awb2ndLeg: awbKey,
            bookingPieces: sums.totalPcs,
            screenedPieces: sums.totalScreened,
            screeningStatus: st,
          })
        }
      } else if (b.booking_type === 'simple') {
        const sd = b.screening_details
        screenRows.push({
          ...base,
          mawb: '',
          awb2ndLeg: b.awb_2nd_leg || b.awb_1st_leg || '',
          bookingPieces: b.pieces || 0,
          screenedPieces: b.screening_pieces_total || sd?.pieces || 0,
          screeningStatus: (b.screening_status as ScreeningRow['screeningStatus']) || (sd?.pieces ? 'partial' : 'pending'),
          lastCertDate: sd?.date || '',
          screener: sd?.phantom_screener || '',
          mclRep: sd?.mcl_representant || '',
        })
      }
    }
    return screenRows
  }, [rawFlights, rawBookings])

  // ── Load escalations ──
  useEffect(() => {
    return onSnapshot(
      collection(db, 'screening_settings', 'config', 'escalations'),
      snap => {
        setEscalations(snap.docs.map(d => ({ ...d.data() as EscalationEntry, id: d.id })))
      }
    )
  }, [])

  // ── Enrich rows with last cert date + screener/rep from events ──
  const enrichedRows = rows.map(r => {
    // Find events related to this booking
    let relatedEvents = events.filter(e => r.eventIds.includes(e.id))
    // Fallback: match by booking ID when screening_events array wasn't populated
    if (relatedEvents.length === 0) {
      relatedEvents = events.filter(e => e.matched_booking_id === r.bookingId)
    }

    // When the row represents a specific AWB (not a MAWB), narrow events to only
    // those whose extracted AWB matches this row's AWB. This prevents events from
    // other AWBs within the same booking from contaminating this row's totals.
    const rowAwb = r.awb2ndLeg || ''
    if (rowAwb && !r.mawb && relatedEvents.length > 0) {
      const normRowAwb = normalizeAwb(rowAwb)
      const awbFiltered = relatedEvents.filter(e =>
        normalizeAwb(e.extracted?.awb || '') === normRowAwb
      )
      // Only narrow if we found matches; otherwise keep all (MAWB-style events
      // may not have per-AWB extracted.awb)
      if (awbFiltered.length > 0) relatedEvents = awbFiltered
    }

    if (relatedEvents.length === 0) return r
    const latest = relatedEvents.sort((a, b) => (b.processed_at || '').localeCompare(a.processed_at || ''))[0]
    const enriched = {
      ...r,
      lastCertDate: latest.extracted.date || r.lastCertDate || '',
      screener: latest.extracted.phantom_screener || r.screener || '',
      mclRep: latest.extracted.mcl_representant || r.mclRep || '',
    }
    // Fix screened pieces from events when booking field is missing
    if (enriched.screenedPieces === 0 && relatedEvents.length > 0) {
      const validEvents = relatedEvents.filter(e => e.status !== 'duplicate')
      const fromEvents = validEvents.reduce((s, e) => s + (e.extracted?.pieces || 0), 0)
      if (fromEvents > 0) {
        enriched.screenedPieces = fromEvents
        let st: ScreeningRow['screeningStatus'] = 'pending'
        if (fromEvents > enriched.bookingPieces && enriched.bookingPieces > 0) st = 'error'
        else if (fromEvents === enriched.bookingPieces && fromEvents > 0) st = 'complete'
        else if (fromEvents > 0) st = 'partial'
        enriched.screeningStatus = st
      }
    }
    return enriched
  })

  // ── Filtering ──
  const clients = [...new Set(enrichedRows.map(r => r.clientName))].sort()

  let filtered = enrichedRows.filter(r => {
    if (filterClient && r.clientName !== filterClient) return false
    if (filterStatus && r.screeningStatus !== filterStatus) return false
    if (searchText) {
      const s = searchText.toLowerCase()
      if (!r.mawb.toLowerCase().includes(s) && !r.awb2ndLeg.toLowerCase().includes(s) && !r.clientName.toLowerCase().includes(s)) return false
    }
    // Cert date range filter
    if (certDateFrom && r.lastCertDate) {
      const certD = r.lastCertDate.replace(/\//g, '-') // normalize
      if (certD < certDateFrom) return false
    }
    if (certDateTo && r.lastCertDate) {
      const certD = r.lastCertDate.replace(/\//g, '-')
      if (certD > certDateTo) return false
    }
    // If date filter is set but row has no cert date, exclude it
    if ((certDateFrom || certDateTo) && !r.lastCertDate) return false
    return true
  })

  filtered.sort((a, b) => (b.flightDate || '').localeCompare(a.flightDate || ''))

  const unmatchedEvents = events.filter(e => e.status === 'unmatched')

  // Stats
  const completeCount = filtered.filter(r => r.screeningStatus === 'complete').length
  const partialCount = filtered.filter(r => r.screeningStatus === 'partial').length
  const pendingCount = filtered.filter(r => r.screeningStatus === 'pending').length
  const errorCount = filtered.filter(r => r.screeningStatus === 'error').length

  // ── Save settings ──
  async function handleSaveSettings() {
    setSavingSettings(true)
    try {
      await setDoc(doc(db, 'screening_settings', 'config'), {
        phantom_k9_emails: editEmails.split(',').map(e => e.trim()).filter(Boolean),
        mcl_alert_emails: editMclEmails.split(',').map(e => e.trim()).filter(Boolean),
        enabled: editEnabled,
      }, { merge: true })
    } catch (err) {
      console.error('Error saving settings:', err)
    }
    setSavingSettings(false)
  }

  // ── Run Now ──
  async function handleRunNow() {
    if (!user) return
    setRunningNow(true)
    try {
      const triggerFn = httpsCallable(functions, 'triggerScreeningManual')
      const result = await triggerFn()
      console.log('Manual run result:', result.data)
    } catch (err) {
      console.error('Run now error:', err)
    }
    setRunningNow(false)
  }

  // ── Recalculate — rebuild booking screening data from existing events ──
  const [recalculating, setRecalculating] = useState(false)
  async function handleRecalculate() {
    if (!confirm('Recalculate all booking screening data from existing events?')) return
    setRecalculating(true)
    try {
      const resetFn = httpsCallable(functions, 'resetScreeningData')
      const result = await resetFn({ mode: 'recalculate' })
      console.log('Recalculate result:', result.data)
      alert(`Recalculated ${(result.data as any).recalculated} bookings from ${(result.data as any).totalEvents} events`)
    } catch (err) {
      console.error('Recalculate error:', err)
      alert('Error recalculating: ' + (err as any).message)
    }
    setRecalculating(false)
  }

  // ── Reset (with optional date filter) ──
  async function handleReset() {
    const msg = resetFromDate
      ? `Reset screening data from ${resetFromDate} onwards? Data before that date will be preserved.`
      : 'Delete ALL screening events, clean all bookings and reset last_run?'
    if (!confirm(msg)) return
    setResetting(true)
    try {
      const resetFn = httpsCallable(functions, 'resetScreeningData')
      const result = await resetFn({ fromDate: resetFromDate || null })
      console.log('Reset result:', result.data)
    } catch (err) {
      console.error('Reset error:', err)
    }
    setResetting(false)
  }

  // ── Download Inconsistency Report ──
  function downloadReport() {
    const reportRows = filtered.filter(r => r.screeningStatus === 'error' || r.screeningStatus === 'partial')
    if (reportRows.length === 0) {
      alert('No inconsistencies (error/partial) found with current filters.')
      return
    }
    const data = reportRows.map(r => ({
      'Flight #': r.flightNumber,
      'Flight Date': r.flightDate ? fmtShortDate(r.flightDate) : '',
      'Client': r.clientName,
      'MAWB': r.mawb || '',
      'AWB 2nd Leg': r.awb2ndLeg || '',
      'Booking PCS': r.bookingPieces,
      'Screened PCS': r.screenedPieces,
      'Difference': r.bookingPieces - r.screenedPieces,
      'Status': r.screeningStatus === 'error' ? 'ERROR (over-screened)' : 'PARTIAL (under-screened)',
      'Cert Date': r.lastCertDate ? fmtShortDate(r.lastCertDate) : '',
      'Screener': r.screener || '',
      'MCL Rep': r.mclRep || '',
    }))
    const ws = XLSX.utils.json_to_sheet(data)
    // Auto-size columns
    const colWidths = Object.keys(data[0]).map(k => ({
      wch: Math.max(k.length, ...data.map(r => String((r as any)[k] ?? '').length)) + 2,
    }))
    ws['!cols'] = colWidths
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Inconsistencies')
    const dateStr = new Date().toLocaleDateString('en-CA')
    const clientSuffix = filterClient ? `_${filterClient.replace(/\s+/g, '_')}` : '_All'
    XLSX.writeFile(wb, `Screening_Inconsistencies${clientSuffix}_${dateStr}.xlsx`)
  }

  // ── Status Badge ──
  function StatusBadge({ status, screened, total }: { status: string; screened: number; total: number }) {
    if (status === 'complete') return <span className="inline-flex items-center gap-1 bg-green-100 text-green-700 text-xs px-2 py-0.5 rounded-full font-medium">&#x1F7E2; {screened}/{total}</span>
    if (status === 'partial') return <span className="inline-flex items-center gap-1 bg-amber-100 text-amber-700 text-xs px-2 py-0.5 rounded-full font-medium">&#x1F7E1; {screened}/{total}</span>
    if (status === 'error') return <span className="inline-flex items-center gap-1 bg-red-100 text-red-700 text-xs px-2 py-0.5 rounded-full font-medium">&#x1F534; Error</span>
    return <span className="inline-flex items-center gap-1 bg-gray-100 text-gray-400 text-xs px-2 py-0.5 rounded-full">&#x26AA; Pending</span>
  }

  // ── Render ──

  if (loading) {
    return (
      <Layout title="Screening" backTo="/airfreight/admin">
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" />
        </div>
      </Layout>
    )
  }

  const selectClass = 'border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-mcl-blue/30 bg-white'

  return (
    <Layout title="Screening" backTo="/airfreight/admin">

      {/* Config Panel (admin only) */}
      {isAdmin && (
        <div className="mb-4">
          <button
            onClick={() => setShowConfig(!showConfig)}
            className="flex items-center gap-2 text-sm font-medium text-mcl-blue hover:underline mb-2"
          >
            <svg className={`w-4 h-4 transition-transform ${showConfig ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            Agent Configuration
          </button>
          {showConfig && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">Phantom K9 Alert Emails</label>
                  <input value={editEmails} onChange={e => setEditEmails(e.target.value)} placeholder="email1@phantom.com, email2@phantom.com" className={selectClass + ' w-full'} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">MCL Internal Alert Emails</label>
                  <input value={editMclEmails} onChange={e => setEditMclEmails(e.target.value)} placeholder="ops@mincurllogistics.com" className={selectClass + ' w-full'} />
                </div>
              </div>
              <div className="flex items-center gap-4 flex-wrap">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={editEnabled} onChange={e => setEditEnabled(e.target.checked)} className="rounded border-gray-300" />
                  Agent Enabled
                </label>
                <button onClick={handleSaveSettings} disabled={savingSettings} className="bg-mcl-blue text-white text-sm px-4 py-1.5 rounded-lg hover:bg-mcl-blue/90 disabled:opacity-50">
                  {savingSettings ? 'Saving...' : 'Save Settings'}
                </button>
                <button onClick={handleRunNow} disabled={runningNow || !settings.enabled} className="bg-green-600 text-white text-sm px-4 py-1.5 rounded-lg hover:bg-green-700 disabled:opacity-50">
                  {runningNow ? 'Running...' : 'Run Now'}
                </button>
                <button onClick={handleRecalculate} disabled={recalculating} className="bg-amber-500 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-amber-600 disabled:opacity-50">
                  {recalculating ? 'Recalculating...' : 'Recalculate'}
                </button>
                <div className="flex items-center gap-1.5 border border-red-200 rounded-lg px-2 py-1 bg-red-50">
                  <label className="text-xs text-red-700 whitespace-nowrap">Reset from:</label>
                  <input type="date" value={resetFromDate} onChange={e => setResetFromDate(e.target.value)}
                    className="text-xs border border-red-200 rounded px-1.5 py-0.5 w-32" placeholder="All" />
                  <button onClick={handleReset} disabled={resetting} className="bg-red-600 text-white text-xs px-3 py-1 rounded hover:bg-red-700 disabled:opacity-50 whitespace-nowrap">
                    {resetting ? 'Resetting...' : resetFromDate ? `Reset from ${resetFromDate}` : 'Reset All'}
                  </button>
                </div>
                {settings.last_run && (
                  <span className="text-xs text-gray-500">
                    Last run: {fmtDate(settings.last_run)} —{' '}
                    <span className={settings.last_run_status === 'success' ? 'text-green-600' : 'text-red-600'}>{settings.last_run_status}</span>
                    {settings.last_run_count !== undefined && ` (${settings.last_run_count} emails)`}
                    {(settings as any).last_run_retried > 0 && `, ${(settings as any).last_run_retried} retried`}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
        <div className="bg-white rounded-xl shadow-sm p-3 border border-gray-100">
          <p className="text-[10px] text-gray-400 uppercase tracking-wide">Bookings</p>
          <p className="text-2xl font-bold text-mcl-blue">{filtered.length}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm p-3 border border-green-100">
          <p className="text-[10px] text-green-600 uppercase tracking-wide">Complete</p>
          <p className="text-2xl font-bold text-green-600">{completeCount}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm p-3 border border-amber-100">
          <p className="text-[10px] text-amber-600 uppercase tracking-wide">Partial</p>
          <p className="text-2xl font-bold text-amber-600">{partialCount}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm p-3 border border-gray-100">
          <p className="text-[10px] text-gray-400 uppercase tracking-wide">Pending</p>
          <p className="text-2xl font-bold text-gray-400">{pendingCount}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm p-3 border border-red-100">
          <p className="text-[10px] text-red-600 uppercase tracking-wide">Error</p>
          <p className="text-2xl font-bold text-red-600">{errorCount}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4">
        {(['main', 'unmatched', 'alerts'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
              tab === t ? 'bg-white text-mcl-blue border border-b-0 border-gray-200' : 'bg-gray-100 text-gray-500 hover:text-gray-700'
            }`}
          >
            {t === 'main' ? 'Screening' : t === 'unmatched' ? `Unmatched (${unmatchedEvents.length})` : `Alerts (${escalations.filter(e => e.status === 'open').length})`}
          </button>
        ))}
      </div>

      {/* Tab: Main */}
      {tab === 'main' && (
        <>
          {/* Filters */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 mb-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 items-end">
              <div>
                <label className="block text-[10px] font-semibold text-gray-400 uppercase mb-1">Client</label>
                <select value={filterClient} onChange={e => setFilterClient(e.target.value)} className={selectClass + ' w-full'}>
                  <option value="">All clients</option>
                  {clients.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-gray-400 uppercase mb-1">Status</label>
                <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className={selectClass + ' w-full'}>
                  <option value="">All statuses</option>
                  <option value="complete">Complete</option>
                  <option value="partial">Partial</option>
                  <option value="pending">Pending</option>
                  <option value="error">Error</option>
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-gray-400 uppercase mb-1">Search</label>
                <input value={searchText} onChange={e => setSearchText(e.target.value)} placeholder="MAWB/AWB..." className={selectClass + ' w-full'} />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-gray-400 uppercase mb-1">Cert From</label>
                <input type="date" value={certDateFrom} onChange={e => setCertDateFrom(e.target.value)} className={selectClass + ' w-full'} />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-gray-400 uppercase mb-1">Cert To</label>
                <input type="date" value={certDateTo} onChange={e => setCertDateTo(e.target.value)} className={selectClass + ' w-full'} />
              </div>
              <div>
                <button
                  onClick={downloadReport}
                  className="w-full flex items-center justify-center gap-1.5 bg-red-600 text-white text-sm px-3 py-2 rounded-lg hover:bg-red-700 transition-colors"
                  title="Download Excel with error & partial AWBs"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  Report
                </button>
              </div>
            </div>
          </div>

          {/* Main table */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-4">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[900px]">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr>
                    <th className="text-left px-3 py-3 font-semibold text-gray-600 text-xs uppercase">Flight</th>
                    <th className="text-left px-3 py-3 font-semibold text-gray-600 text-xs uppercase">Client</th>
                    <th className="text-left px-3 py-3 font-semibold text-gray-600 text-xs uppercase">MAWB / AWB</th>
                    <th className="text-center px-3 py-3 font-semibold text-gray-600 text-xs uppercase">Booking</th>
                    <th className="text-center px-3 py-3 font-semibold text-gray-600 text-xs uppercase">Screened</th>
                    <th className="text-center px-3 py-3 font-semibold text-gray-600 text-xs uppercase">Status</th>
                    <th className="text-left px-3 py-3 font-semibold text-gray-600 text-xs uppercase">Screener</th>
                    <th className="text-left px-3 py-3 font-semibold text-gray-600 text-xs uppercase">MCL Rep</th>
                    <th className="text-center px-3 py-3 font-semibold text-gray-600 text-xs uppercase">Last Cert</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {filtered.map(r => (
                    <tr
                      key={`${r.bookingId}-${r.mawb || r.awb2ndLeg}`}
                      onClick={() => {
                        const awb = r.mawb || r.awb2ndLeg || ''
                        navigate(`/airfreight/screening/${r.bookingId}${awb ? `?awb=${encodeURIComponent(awb)}` : ''}`)
                      }}
                      className="hover:bg-blue-50/40 transition-colors cursor-pointer"
                    >
                      <td className="px-3 py-3 text-xs">
                        <span className="font-semibold text-gray-700">{r.flightNumber}</span>
                        <span className="text-gray-400 ml-1">{fmtShortDate(r.flightDate)}</span>
                      </td>
                      <td className="px-3 py-3 text-xs text-gray-700">{r.clientName}</td>
                      <td className="px-3 py-3 font-mono text-xs font-bold text-mcl-blue">{r.mawb || r.awb2ndLeg || '—'}</td>
                      <td className="px-3 py-3 text-center text-xs text-gray-700 font-semibold">{r.bookingPieces}</td>
                      <td className="px-3 py-3 text-center text-xs font-semibold">
                        <span className={r.screenedPieces > 0 ? 'text-gray-700' : 'text-gray-300'}>{r.screenedPieces}</span>
                      </td>
                      <td className="px-3 py-3 text-center">
                        <StatusBadge status={r.screeningStatus} screened={r.screenedPieces} total={r.bookingPieces} />
                      </td>
                      <td className="px-3 py-3 text-xs text-gray-600">{r.screener || '—'}</td>
                      <td className="px-3 py-3 text-xs text-gray-600">{r.mclRep || '—'}</td>
                      <td className="px-3 py-3 text-center text-xs text-gray-500">{r.lastCertDate ? fmtShortDate(r.lastCertDate) : '—'}</td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-400">No bookings found</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Tab: Unmatched */}
      {tab === 'unmatched' && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          {unmatchedEvents.length === 0 ? (
            <div className="px-4 py-8 text-center text-gray-400 text-sm">No unmatched certificates</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-red-50 border-b border-red-100">
                  <tr>
                    <th className="text-left px-4 py-3 font-semibold text-red-600 text-xs uppercase">MAWB</th>
                    <th className="text-left px-4 py-3 font-semibold text-red-600 text-xs uppercase">AWB</th>
                    <th className="text-center px-4 py-3 font-semibold text-red-600 text-xs uppercase">Pieces</th>
                    <th className="text-left px-4 py-3 font-semibold text-red-600 text-xs uppercase">Gmail Subject</th>
                    <th className="text-left px-4 py-3 font-semibold text-red-600 text-xs uppercase">Processed</th>
                    <th className="text-left px-4 py-3 font-semibold text-red-600 text-xs uppercase">Near Match</th>
                    <th className="text-center px-4 py-3 font-semibold text-red-600 text-xs uppercase">PDF</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-red-50">
                  {unmatchedEvents.map(ev => (
                    <tr key={ev.id} className="hover:bg-red-50/30">
                      <td className="px-4 py-3 font-mono text-xs font-bold text-gray-700">{ev.extracted.mawb || '—'}</td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-600">{ev.extracted.awb || '—'}</td>
                      <td className="px-4 py-3 text-center text-xs text-gray-600">{ev.extracted.pieces}</td>
                      <td className="px-4 py-3 text-xs text-gray-500 max-w-[200px] truncate" title={ev.gmail_subject}>{ev.gmail_subject}</td>
                      <td className="px-4 py-3 text-xs text-gray-500">{fmtDate(ev.processed_at)}</td>
                      <td className="px-4 py-3 text-xs max-w-[220px]">
                        {(ev as any).near_match_suggestion ? (
                          <span className="text-amber-700 bg-amber-50 px-2 py-0.5 rounded text-[10px] font-medium" title={(ev as any).near_match_suggestion}>
                            {(ev as any).near_match_suggestion}
                          </span>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {ev.pdf_url && (
                          <button onClick={() => window.open(ev.pdf_url, '_blank')} className="text-xs text-mcl-blue hover:underline font-semibold">Open</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Tab: Alerts */}
      {tab === 'alerts' && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          {escalations.length === 0 ? (
            <div className="px-4 py-8 text-center text-gray-400 text-sm">No alerts sent yet</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase">MAWB / AWB</th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase">First Alert</th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase">Last Alert</th>
                    <th className="text-center px-4 py-3 font-semibold text-gray-600 text-xs uppercase">Alerts Sent</th>
                    <th className="text-center px-4 py-3 font-semibold text-gray-600 text-xs uppercase">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {escalations.sort((a, b) => (b.last_alert_date || '').localeCompare(a.last_alert_date || '')).map(esc => (
                    <tr key={esc.id} className="hover:bg-gray-50/50">
                      <td className="px-4 py-3 font-mono text-xs font-bold text-gray-700">{esc.mawb_or_awb}</td>
                      <td className="px-4 py-3 text-xs text-gray-600">{fmtShortDate(esc.first_alert_date)}</td>
                      <td className="px-4 py-3 text-xs text-gray-600">{fmtShortDate(esc.last_alert_date)}</td>
                      <td className="px-4 py-3 text-center text-xs font-semibold text-gray-700">{esc.alert_count}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${esc.status === 'open' ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>{esc.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Layout>
  )
}
