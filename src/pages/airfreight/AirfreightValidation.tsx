import { useState, useEffect, useRef } from 'react'
import {
  collection, getDocs, getDoc, addDoc, updateDoc, setDoc, query, where, orderBy, doc,
} from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import { AirfreightFlight, AirfreightBooking, AirfreightClient, AwbSecondLeg } from '../../types'
import Layout from '../../components/Layout'
import { awbIndexField } from '../../lib/bookingAwbIndex'
import * as XLSX from 'xlsx'

// ── Types ──

interface ExcelRow {
  flight: string
  awb1st: string
  awb2nd: string
  uld: string
  pcs: number
  cw: number
  pickupFrom: string
  readyForPickup: string
  lastDayFree: string
  deliverTo: string
  dest: string
  etd: string
  cutoff: string
  holdBg: string
  holdBox: string
  battery: boolean
  docsInDrive: boolean
}

interface SystemRow {
  bookingId: string
  flightId: string
  flightNumber: string
  airline: string
  flightStatus: string
  etd: string
  awbIndex: number
  awb1st: string
  awb2nd: string
  uld: string
  pcs: number
  cw: number
  dest: string
  pickupFrom: string
  readyForPickup: string
  lastDayFree: string
  onHand: boolean
  dispatched: boolean
  hasDocs: boolean
  docList: string[]
  hasScreening: boolean
  hasBilling: boolean
  holdStatus: string
  battery: boolean
  docsInDrive: boolean
  line: AwbSecondLeg
}

type RowStatus = 'match' | 'diff' | 'new' | 'removed'

interface DiffField { field: string; excel: string; system: string }

interface Alert {
  severity: 'critical' | 'warning' | 'info'
  message: string
  rowIdx: number
}

interface CompRow {
  status: RowStatus
  excel: ExcelRow | null
  system: SystemRow | null
  diffs: DiffField[]
  blocked: boolean      // true = cannot apply (dispatched, invoiced)
  alerts: Alert[]
}

// ── Helpers ──

function parseDate(raw: any): string {
  if (raw === null || raw === undefined || raw === '') return ''
  if (typeof raw === 'number') {
    const d = new Date((raw - 25569) * 86400000)
    if (raw % 1 !== 0) {
      const hh = String(d.getUTCHours()).padStart(2, '0')
      const mm = String(d.getUTCMinutes()).padStart(2, '0')
      return `${d.toISOString().slice(0, 10)}T${hh}:${mm}:00`
    }
    return d.toISOString().slice(0, 10)
  }
  const s = String(raw).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!s || /^[a-z]/i.test(s)) return s

  function parseTime(t: string): string {
    const tk = t.trim().toLowerCase()
    const rangeMatch = tk.match(/(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
    if (rangeMatch) {
      let hr = parseInt(rangeMatch[3])
      const min = rangeMatch[4] || '00'
      const ampm = rangeMatch[5]?.toLowerCase()
      if (ampm === 'pm' && hr < 12) hr += 12
      if (ampm === 'am' && hr === 12) hr = 0
      return `${String(hr).padStart(2, '0')}:${min}`
    }
    const timeMatch = tk.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
    if (timeMatch) {
      let hr = parseInt(timeMatch[1])
      const min = timeMatch[2] || '00'
      const ampm = timeMatch[3]?.toLowerCase()
      if (ampm === 'pm' && hr < 12) hr += 12
      if (ampm === 'am' && hr === 12) hr = 0
      return `${String(hr).padStart(2, '0')}:${min}`
    }
    return ''
  }

  const today = new Date().toLocaleDateString('en-CA')

  if (!s.includes('/') && /^\d{1,2}\s*-\s*\d{1,2}\s*(am|pm)/i.test(s)) {
    const t = parseTime(s)
    return t ? `${today}T${t}:00` : s
  }

  const dateRe = /(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/
  const dateMatch = s.match(dateRe)
  if (dateMatch) {
    const mm = dateMatch[1].padStart(2, '0')
    const dd = dateMatch[2].padStart(2, '0')
    const yearRaw = dateMatch[3]
    const year = yearRaw ? (yearRaw.length === 2 ? '20' + yearRaw : yearRaw) : String(new Date().getFullYear())
    const datePart = `${year}-${mm}-${dd}`
    const afterDate = s.slice(dateMatch.index! + dateMatch[0].length)
    const timeParsed = afterDate ? parseTime(afterDate) : ''
    return timeParsed ? `${datePart}T${timeParsed}:00` : datePart
  }
  // Ensure any T-prefixed time gets a date
  if (s.includes('T') && !s.match(/^\d{4}-/)) return `${today}${s.startsWith('T') ? '' : 'T'}${s}`
  return s
}

function isYes(val: string): boolean {
  const v = val.toLowerCase().trim()
  return v === 'y' || v === 'yes' || v === 'si' || v === 'sí' || v === 'true' || v === '1'
}

function normStr(s: string): string { return (s || '').trim().toUpperCase() }

function hasDocFile(d: any): boolean { return !!(d && d.url) }

// ── Component ──

export default function AirfreightValidation() {
  const { isAdmin, isAccounting, isSuperAgent, user } = useAuth()
  const fileRef = useRef<HTMLInputElement>(null)
  const [clients, setClients] = useState<(AirfreightClient & { id: string })[]>([])
  const [clientId, setClientId] = useState('')
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState('')
  const [compRows, setCompRows] = useState<CompRow[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [dismissed, setDismissed] = useState<Set<string>>(new Set()) // AWB 1st leg keys
  const [summary, setSummary] = useState<{ total: number; match: number; diff: number; newRows: number; removed: number } | null>(null)
  const [filterStatus, setFilterStatus] = useState<RowStatus | ''>('')
  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')
  const [applyLog, setApplyLog] = useState<string[]>([])

  // Keep references to loaded data for apply phase
  const bookingsRef = useRef<(AirfreightBooking & { id: string })[]>([])
  const flightMapRef = useRef<Map<string, AirfreightFlight & { id: string }>>(new Map())
  const allFlightsRef = useRef<(AirfreightFlight & { id: string })[]>([])

  useEffect(() => {
    getDocs(query(collection(db, 'airfreight_clients'), orderBy('name'))).then(snap => {
      setClients(snap.docs.map(d => ({ id: d.id, ...d.data() } as AirfreightClient & { id: string })))
    })
  }, [])

  // ── Parse & Compare ──

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    if (!clientId) { setError('Selecciona un cliente primero'); return }

    setLoading(true)
    setError('')
    setCompRows([])
    setSummary(null)
    setSelected(new Set())
    setApplyLog([])

    try {
      // ── 1. Parse Excel ──
      const data = await file.arrayBuffer()
      const wb = XLSX.read(data, { type: 'array', cellDates: false })
      const sheetName = wb.SheetNames.find(n => n.toLowerCase().includes('ejemplo')) || wb.SheetNames[0]
      const ws = wb.Sheets[sheetName]
      const rawRows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

      const HEADER_ALIASES: [string, string[]][] = [
        ['flight_number', ['flight number', 'flight#', 'flight #', 'vuelo', 'numero de vuelo']],
        ['awb_1st', ['1st leg awb', '1st leg', 'awb 1st leg', '1st awb', '1st leg awb#']],
        ['awb_2nd', ['2nd leg awb', '2nd leg', 'awb 2nd leg', '2nd awb', '2nd leg awb#']],
        ['uld', ['uld', 'uld type', 'uld / loose', 'uld/loose']],
        ['pieces', ['pcs', 'pieces', 'piezas']],
        ['cw', ['cw', 'chw', 'chargeable', 'chargeable wt', 'chargeable weight']],
        ['pickup_from', ['pick up from', 'pickup from', 'pick-up from']],
        ['ready_for_pickup', ['ready for pickup', 'ready', 'ready date', 'ready for pick up']],
        ['lfd', ['lfd', 'last day free', 'last free day', 'free days']],
        ['deliver_to', ['deliver to', 'airline']],
        ['destination', ['dest', 'dest.', 'destination', 'destino']],
        ['cutoff', ['cutoff', 'cut off', 'cutoff time', 'cut-off', 'cut off date/time']],
        ['etd', ['etd', 'departure', 'date & etd time']],
        ['hold_bg', ['hold bg#', 'hold bg #', 'hold bg', 'bag#', 'bag #', 'bg#', 'bg #']],
        ['hold_box', ['hold box#', 'hold box #', 'hold box', 'box#', 'box #']],
        ['battery', ['battery', 'bateria', 'lithium', 'lb', 'lithium battery', 'battery yes/no']],
      ]

      let headerRowIdx = -1
      let colMap: Record<string, number> = {}
      for (let i = 0; i < Math.min(rawRows.length, 20); i++) {
        const row = rawRows[i]
        let matchCount = 0
        const tempMap: Record<string, number> = {}
        for (let j = 0; j < row.length; j++) {
          const cell = String(row[j] ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
          if (!cell) continue
          for (const [key, aliases] of HEADER_ALIASES) {
            if (key in tempMap) continue
            if (aliases.some(a => cell === a || cell.includes(a))) { tempMap[key] = j; matchCount++; break }
          }
        }
        if (matchCount >= 3) { headerRowIdx = i; colMap = tempMap; break }
      }

      if (headerRowIdx < 0) { setError('No se encontró fila de encabezado en el Excel'); setLoading(false); return }

      // Detect headerless "docs_in_drive" column (col A is empty header, data has "DOCS IN DRIVE")
      if (!('docs_in_drive' in colMap)) {
        const sampleRows = rawRows.slice(headerRowIdx + 1, headerRowIdx + 6)
        for (let j = 0; j < 3; j++) {
          const inMap = Object.values(colMap).includes(j)
          if (inMap) continue
          if (sampleRows.some(r => /docs/i.test(String(r[j] || '')))) {
            colMap['docs_in_drive'] = j
            break
          }
        }
      }

      const col = (r: any[], key: string) => key in colMap ? String(r[colMap[key]] ?? '').trim() : ''
      const colRaw = (r: any[], key: string) => key in colMap ? r[colMap[key]] : ''

      const dataRows = rawRows.slice(headerRowIdx + 1).filter(r => {
        const awb1 = col(r, 'awb_1st')
        const awb2 = col(r, 'awb_2nd')
        const fn = col(r, 'flight_number')
        return (awb1 || awb2) && fn
      })

      const excelRows: ExcelRow[] = dataRows.map(r => ({
        flight: col(r, 'flight_number').toUpperCase(),
        awb1st: col(r, 'awb_1st'),
        awb2nd: col(r, 'awb_2nd'),
        uld: col(r, 'uld').toUpperCase(),
        pcs: Number(col(r, 'pieces')) || 0,
        cw: Number(col(r, 'cw')) || 0,
        pickupFrom: col(r, 'pickup_from'),
        readyForPickup: parseDate(colRaw(r, 'ready_for_pickup')),
        lastDayFree: parseDate(colRaw(r, 'lfd')),
        deliverTo: col(r, 'deliver_to'),
        dest: col(r, 'destination').toUpperCase(),
        etd: parseDate(colRaw(r, 'etd')),
        cutoff: parseDate(colRaw(r, 'cutoff')),
        holdBg: col(r, 'hold_bg'),
        holdBox: col(r, 'hold_box'),
        battery: isYes(col(r, 'battery')),
        docsInDrive: isYes(col(r, 'docs_in_drive')) || /^docs(\s+(in\s+drive|ok|si|yes))?$/i.test(col(r, 'docs_in_drive').trim()),
      }))

      // ── 2. Load system data ──
      const bookingsSnap = await getDocs(query(
        collection(db, 'airfreight_bookings'),
        where('client_id', '==', clientId),
        where('booking_type', '==', 'ecommerce'),
      ))

      const flightIds = new Set<string>()
      const bookings: (AirfreightBooking & { id: string })[] = []
      bookingsSnap.forEach(d => {
        const b = { id: d.id, ...d.data() } as AirfreightBooking & { id: string }
        bookings.push(b)
        if (b.flight_id) flightIds.add(b.flight_id)
      })
      bookingsRef.current = bookings

      const flightMap = new Map<string, AirfreightFlight & { id: string }>()
      const flightSnap = await getDocs(query(collection(db, 'airfreight_flights'), orderBy('flight_datetime', 'desc')))
      const allFlights: (AirfreightFlight & { id: string })[] = []
      flightSnap.forEach(d => {
        const f = { id: d.id, ...d.data() } as AirfreightFlight & { id: string }
        allFlights.push(f)
        if (flightIds.has(f.id!)) flightMap.set(f.id!, f)
      })
      flightMapRef.current = flightMap
      allFlightsRef.current = allFlights

      const billingMap = new Map<string, boolean>()
      try {
        const chargesSnap = await getDocs(query(
          collection(db, 'airfreight_billing_charges'),
          where('client_id', '==', clientId),
        ))
        chargesSnap.forEach(d => {
          const ch = d.data() as any
          if (ch.booking_id) billingMap.set(`${ch.booking_id}_${ch.awb_index ?? ''}`, true)
        })
      } catch { /* ignore */ }

      // Build system rows
      const systemByAwb1 = new Map<string, SystemRow>()
      const systemByAwb2 = new Map<string, SystemRow>()

      for (const b of bookings) {
        const flight = flightMap.get(b.flight_id)
        if (!b.awb_lines) continue
        const lines = b.awb_lines as AwbSecondLeg[]
        lines.forEach((line, idx) => {
          const docList: string[] = []
          if (line.documents) {
            for (const [k, v] of Object.entries(line.documents)) { if (hasDocFile(v)) docList.push(k.replace('doc_', '')) }
          }
          if (hasDocFile(line.doc_acceptance)) docList.push('acceptance')
          if (hasDocFile(line.doc_whr)) docList.push('whr')
          if (hasDocFile(line.doc_mcl_transfer)) docList.push('mcl_transfer')
          if (hasDocFile(line.doc_screening_cert)) docList.push('screening_cert')
          if (line.doc_uploads?.length) docList.push(`uploads(${line.doc_uploads.length})`)

          const holdStatus = line.hold === true ? 'HOLD' : line.hold === 'pending' ? 'PENDING' : 'NO HOLD'
          const fStatus = flight?.flight_status || (flight?.dispatched_at ? 'dispatched' : 'booked')

          const sysRow: SystemRow = {
            bookingId: b.id!, flightId: b.flight_id,
            flightNumber: flight?.flight_number || b.flight_number || '',
            airline: flight?.airline || b.airline || '',
            flightStatus: fStatus,
            etd: flight?.flight_datetime || '',
            awbIndex: idx, awb1st: line.awb_number || '', awb2nd: line.awb_2nd_leg || '',
            uld: (line.uld_type || '').toUpperCase(),
            pcs: line.pieces || 0, cw: line.chargeable_weight || 0,
            dest: (b.destination_id || '').toUpperCase(),
            pickupFrom: (line as any).pickup_from || '',
            readyForPickup: (line as any).ready_for_pickup || b.ready_for_pickup || '',
            lastDayFree: (line as any).last_day_free || b.last_day_free || '',
            onHand: !!line.on_hand, dispatched: !!line.dispatched,
            hasDocs: docList.length > 0, docList,
            hasScreening: !!line.doc_screening_cert?.url,
            hasBilling: billingMap.has(`${b.id}_${idx}`) || billingMap.has(`${b.id}_`),
            holdStatus, battery: !!line.battery,
            docsInDrive: !!(line as any).docs_in_drive,
            line,
          }

          if (sysRow.awb1st) systemByAwb1.set(normStr(sysRow.awb1st), sysRow)
          if (sysRow.awb2nd) systemByAwb2.set(normStr(sysRow.awb2nd), sysRow)
        })
      }

      // ── 3. Compare ──
      const results: CompRow[] = []
      const matchedSystemKeys = new Set<string>()

      for (const ex of excelRows) {
        const key1 = normStr(ex.awb1st)
        const key2 = normStr(ex.awb2nd)
        const sys = systemByAwb1.get(key1) || systemByAwb2.get(key2) || null

        if (!sys) {
          results.push({ status: 'new', excel: ex, system: null, diffs: [], blocked: false, alerts: [] })
        } else {
          if (key1) matchedSystemKeys.add(key1)
          if (key2) matchedSystemKeys.add(key2)

          const diffs: DiffField[] = []
          if (normStr(sys.flightNumber) !== normStr(ex.flight)) diffs.push({ field: 'Vuelo', excel: ex.flight, system: sys.flightNumber })
          if (ex.pcs !== sys.pcs) diffs.push({ field: 'PCS', excel: String(ex.pcs), system: String(sys.pcs) })
          if (Math.abs(ex.cw - sys.cw) > 0.5) diffs.push({ field: 'CW', excel: String(ex.cw), system: String(sys.cw) })
          const exUld = normStr(ex.uld).replace(/\s/g, '') || 'LOOSE'
          const sysUld = normStr(sys.uld).replace(/\s/g, '') || 'LOOSE'
          if (exUld !== sysUld) diffs.push({ field: 'ULD', excel: ex.uld || 'LOOSE', system: sys.uld || 'LOOSE' })
          if (normStr(ex.dest) !== normStr(sys.dest)) diffs.push({ field: 'Dest', excel: ex.dest, system: sys.dest })
          if (normStr(ex.awb2nd) !== normStr(sys.awb2nd)) diffs.push({ field: '2nd Leg', excel: ex.awb2nd, system: sys.awb2nd })
          const exHoldLower = (ex.holdBg || '').toLowerCase().trim()
          const exHoldStatus = (!exHoldLower || exHoldLower === 'no hold' || exHoldLower === 'no' || exHoldLower === 'n/a' || exHoldLower === '—' || exHoldLower === '-' || exHoldLower === '0')
            ? 'NO HOLD' : (exHoldLower === 'pending' || exHoldLower === 'pendiente') ? 'PENDING' : 'HOLD'
          // Only flag hold diff if Excel has actual HOLD and system doesn't, or system has HOLD and Excel doesn't
          // Ignore PENDING vs NO HOLD variations
          const holdChanged = (exHoldStatus === 'HOLD' && sys.holdStatus !== 'HOLD') || (sys.holdStatus === 'HOLD' && exHoldStatus !== 'HOLD')
          if (holdChanged) diffs.push({ field: 'Hold', excel: exHoldStatus, system: sys.holdStatus })
          if (ex.battery !== sys.battery) diffs.push({ field: 'Battery', excel: ex.battery ? 'Y' : 'N', system: sys.battery ? 'Y' : 'N' })
          if (ex.docsInDrive !== sys.docsInDrive) diffs.push({ field: 'Docs/Drive', excel: ex.docsInDrive ? 'YES' : 'NO', system: sys.docsInDrive ? 'YES' : 'NO' })
          if (normStr(ex.pickupFrom) !== normStr(sys.pickupFrom)) diffs.push({ field: 'Pickup', excel: ex.pickupFrom, system: sys.pickupFrom })
          if (normStr(ex.readyForPickup.slice(0, 10)) !== normStr(sys.readyForPickup.slice(0, 10))) diffs.push({ field: 'Ready', excel: ex.readyForPickup, system: sys.readyForPickup })
          if (normStr(ex.lastDayFree.slice(0, 10)) !== normStr(sys.lastDayFree.slice(0, 10))) diffs.push({ field: 'LFD', excel: ex.lastDayFree, system: sys.lastDayFree })

          // ── Phase 3 alerts ──
          const alerts: Alert[] = []
          let blocked = false
          const rowIdx = results.length

          if (diffs.length > 0 && (sys.dispatched || sys.flightStatus === 'dispatched')) {
            alerts.push({ severity: 'critical', message: 'AWB/Vuelo despachado — no se puede modificar', rowIdx })
            blocked = true
          }
          if (diffs.some(d => d.field === 'Vuelo')) {
            if (sys.hasDocs) alerts.push({ severity: 'info', message: `Cambio de vuelo: ${sys.docList.length} doc(s) se transferirán con la AWB`, rowIdx })
            if (sys.onHand) alerts.push({ severity: 'warning', message: 'AWB on-hand — mover de vuelo puede afectar trazabilidad', rowIdx })
            if (sys.hasBilling) { alerts.push({ severity: 'critical', message: 'AWB tiene cargos de billing — mover de vuelo requiere recálculo', rowIdx }); blocked = true }
          }
          if (diffs.some(d => d.field === 'PCS' || d.field === 'CW')) {
            if (sys.hasBilling) alerts.push({ severity: 'warning', message: 'PCS/CW cambió — billing existente puede requerir recálculo', rowIdx })
            if (sys.hasScreening) alerts.push({ severity: 'warning', message: 'PCS/CW cambió — screening cert puede ser inválido', rowIdx })
          }

          results.push({ status: diffs.length > 0 ? 'diff' : 'match', excel: ex, system: sys, diffs, blocked, alerts })
        }
      }

      // Removed rows (in system, not in Excel)
      for (const [key, sys] of systemByAwb1) {
        if (matchedSystemKeys.has(key)) continue
        const awb2Key = normStr(sys.awb2nd)
        if (awb2Key && matchedSystemKeys.has(awb2Key)) continue
        const fStatus = sys.flightStatus
        if (fStatus === 'dispatched') continue

        const alerts: Alert[] = []
        let blocked = false
        const rowIdx = results.length
        if (sys.dispatched) { alerts.push({ severity: 'critical', message: 'AWB despachada — no se puede eliminar', rowIdx }); blocked = true }
        if (sys.hasBilling) { alerts.push({ severity: 'critical', message: 'AWB tiene billing — no se puede eliminar', rowIdx }); blocked = true }
        if (sys.hasDocs) alerts.push({ severity: 'warning', message: `AWB tiene ${sys.docList.length} doc(s) — se perderán si se elimina`, rowIdx })
        if (sys.onHand) alerts.push({ severity: 'warning', message: 'AWB on-hand — eliminar genera inconsistencia', rowIdx })

        results.push({ status: 'removed', excel: null, system: sys, diffs: [], blocked, alerts })
      }

      const statusOrder: Record<RowStatus, number> = { diff: 0, new: 1, removed: 2, match: 3 }
      results.sort((a, b) => statusOrder[a.status] - statusOrder[b.status])

      setCompRows(results)
      setSummary({
        total: results.length,
        match: results.filter(r => r.status === 'match').length,
        diff: results.filter(r => r.status === 'diff').length,
        newRows: results.filter(r => r.status === 'new').length,
        removed: results.filter(r => r.status === 'removed').length,
      })
    } catch (err: any) {
      setError('Error: ' + err.message)
      console.error(err)
    }
    setLoading(false)
  }

  // ── Select helpers ──
  function toggleSelect(idx: number) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(idx) ? next.delete(idx) : next.add(idx)
      return next
    })
  }

  function selectAllActionable() {
    const next = new Set<number>()
    compRows.forEach((r, i) => {
      if (r.status !== 'match' && !r.blocked && !isRowDismissed(r)) next.add(i)
    })
    setSelected(next)
  }

  function deselectAll() { setSelected(new Set()) }

  function dismissRow(row: CompRow) {
    const key = normStr(row.excel?.awb1st || row.system?.awb1st || '')
    if (!key) return
    setDismissed(prev => { const n = new Set(prev); n.add(key); return n })
    // Deselect if selected
    const idx = compRows.indexOf(row)
    if (selected.has(idx)) {
      setSelected(prev => { const n = new Set(prev); n.delete(idx); return n })
    }
  }

  function undismissRow(row: CompRow) {
    const key = normStr(row.excel?.awb1st || row.system?.awb1st || '')
    if (!key) return
    setDismissed(prev => { const n = new Set(prev); n.delete(key); return n })
  }

  function isRowDismissed(row: CompRow): boolean {
    const key = normStr(row.excel?.awb1st || row.system?.awb1st || '')
    return dismissed.has(key)
  }

  // ── Apply changes ──

  async function handleApply() {
    const rows = compRows.filter((_, i) => selected.has(i))
    if (rows.length === 0) return

    // Check for warnings
    const warnings = rows.flatMap(r => r.alerts.filter(a => a.severity === 'warning'))
    const criticals = rows.flatMap(r => r.alerts.filter(a => a.severity === 'critical'))
    if (criticals.length > 0) {
      alert('Hay alertas críticas en las filas seleccionadas que bloquean la aplicación. Deselecciónalas primero.')
      return
    }
    if (warnings.length > 0) {
      const msg = `Hay ${warnings.length} advertencia(s):\n\n${warnings.map(w => '• ' + w.message).join('\n')}\n\n¿Continuar?`
      if (!confirm(msg)) return
    }
    if (!confirm(`¿Aplicar ${rows.length} cambio(s) al sistema?`)) return

    setApplying(true)
    const log: string[] = []
    const client = clients.find(c => c.id === clientId)
    const now = new Date().toISOString()
    const userEmail = user?.email || ''

    try {
      for (const row of rows) {
        const ex = row.excel
        const sys = row.system

        if (row.status === 'diff' && ex && sys) {
          // ── Update existing AWB ──
          const hasFlightChange = row.diffs.some(d => d.field === 'Vuelo')

          if (hasFlightChange) {
            // Move AWB to different flight — extract full line object with docs
            const srcSnap = await getDoc(doc(db, 'airfreight_bookings', sys.bookingId))
            if (!srcSnap.exists()) { log.push(`ERROR: Booking ${sys.bookingId.slice(0, 8)} no encontrado`); continue }
            const srcData = srcSnap.data() as AirfreightBooking
            const srcLines = [...(srcData.awb_lines || [])] as AwbSecondLeg[]
            const lineObj = { ...srcLines[sys.awbIndex] }

            // Update fields on the line object
            lineObj.pieces = ex.pcs
            lineObj.chargeable_weight = ex.cw
            lineObj.uld_type = ex.uld || null
            lineObj.awb_2nd_leg = ex.awb2nd || null
            lineObj.battery = ex.battery
            ;(lineObj as any).pickup_from = ex.pickupFrom || null
            ;(lineObj as any).ready_for_pickup = ex.readyForPickup || null
            ;(lineObj as any).last_day_free = ex.lastDayFree || null
            ;(lineObj as any).docs_in_drive = ex.docsInDrive || false
            const holdBgLower = (ex.holdBg || '').toLowerCase().trim()
            const isNoHold = !holdBgLower || holdBgLower === 'no hold' || holdBgLower === 'no' || holdBgLower === 'n/a'
            const isPending = holdBgLower === 'pending' || holdBgLower === 'pendiente'
            lineObj.hold = isNoHold ? false : isPending ? 'pending' : true
            if (lineObj.hold === true && ex.holdBg) {
              lineObj.holds = [{ bag: ex.holdBg, box: ex.holdBox || '' } as any]
            }

            // Remove from source booking
            srcLines.splice(sys.awbIndex, 1)
            await updateDoc(doc(db, 'airfreight_bookings', sys.bookingId), {
              awb_lines: srcLines,
              pieces: srcLines.reduce((s, l) => s + (l.pieces || 0), 0),
            })

            // Find or create target flight + booking
            const targetFlightNumber = normStr(ex.flight)
            const etdDate = ex.etd.slice(0, 10)
            const airline = ex.deliverTo || ''
            let targetFlight = allFlightsRef.current.find(f =>
              normStr(f.flight_number || '') === targetFlightNumber &&
              (etdDate ? f.flight_datetime.startsWith(etdDate) : true) &&
              normStr(f.airline || '') === normStr(airline)
            )

            if (!targetFlight) {
              const flightData: any = {
                airline: airline || 'Unknown', flight_number: ex.flight || null,
                flight_datetime: ex.etd || now, cutoff_datetime: ex.cutoff || null,
                destinations: ex.dest ? [ex.dest] : [], status: 'open',
                created_by: userEmail, created_at: now,
              }
              const docRef = await addDoc(collection(db, 'airfreight_flights'), flightData)
              targetFlight = { ...flightData, id: docRef.id } as AirfreightFlight & { id: string }
              allFlightsRef.current.push(targetFlight)
              log.push(`Vuelo creado: ${ex.flight} (${ex.etd.slice(0, 10)})`)
            }

            // Find existing booking for this client+flight or create
            const existingSnap = await getDocs(query(
              collection(db, 'airfreight_bookings'),
              where('flight_id', '==', targetFlight.id),
              where('client_id', '==', clientId),
              where('booking_type', '==', 'ecommerce'),
            ))
            const existingBooking = existingSnap.docs[0]

            if (existingBooking) {
              const tgtData = existingBooking.data() as AirfreightBooking
              const tgtLines = [...(tgtData.awb_lines || []), lineObj]
              await updateDoc(doc(db, 'airfreight_bookings', existingBooking.id), {
                awb_lines: tgtLines,
                pieces: tgtLines.reduce((s, l) => s + ((l as any).pieces || 0), 0),
                destination_id: ex.dest || tgtData.destination_id,
              })
            } else {
              const newAwbLines = [lineObj]
              await addDoc(collection(db, 'airfreight_bookings'), {
                flight_id: targetFlight.id, flight_number: targetFlight.flight_number || null,
                airline: targetFlight.airline || '', booking_type: 'ecommerce',
                client_id: clientId, client_name: client?.name || '',
                status: 'submitted', created_by: userEmail, created_at: now,
                change_count: 0, modified_seen: true, change_log: [], documents: {},
                destination_id: ex.dest || '', awb_lines: newAwbLines,
                pieces: lineObj.pieces || 0, hold: !!lineObj.hold, on_hand: false,
                ...awbIndexField({ booking_type: 'ecommerce', awb_lines: newAwbLines }),
              })
            }

            log.push(`AWB ${ex.awb1st} movida: ${sys.flightNumber} → ${ex.flight} (docs transferidos)`)

          } else {
            // Same flight — just update fields in place
            const bookingSnap = await getDoc(doc(db, 'airfreight_bookings', sys.bookingId))
            if (!bookingSnap.exists()) { log.push(`ERROR: Booking ${sys.bookingId.slice(0, 8)} no encontrado`); continue }
            const bData = bookingSnap.data() as AirfreightBooking
            const lines = [...(bData.awb_lines || [])] as any[]
            const line = { ...lines[sys.awbIndex] }

            for (const d of row.diffs) {
              if (d.field === 'PCS') line.pieces = ex.pcs
              if (d.field === 'CW') line.chargeable_weight = ex.cw
              if (d.field === 'ULD') line.uld_type = ex.uld || null
              if (d.field === '2nd Leg') line.awb_2nd_leg = ex.awb2nd || null
              if (d.field === 'Dest') { /* dest is at booking level */ }
              if (d.field === 'Battery') line.battery = ex.battery
              if (d.field === 'Pickup') line.pickup_from = ex.pickupFrom || null
              if (d.field === 'Ready') line.ready_for_pickup = ex.readyForPickup || null
              if (d.field === 'LFD') line.last_day_free = ex.lastDayFree || null
              if (d.field === 'Docs/Drive') line.docs_in_drive = ex.docsInDrive || false
              if (d.field === 'Hold') {
                const holdBgLower = (ex.holdBg || '').toLowerCase().trim()
                const isNoHold = !holdBgLower || holdBgLower === 'no hold' || holdBgLower === 'no' || holdBgLower === 'n/a'
                const isPending = holdBgLower === 'pending' || holdBgLower === 'pendiente'
                line.hold = isNoHold ? false : isPending ? 'pending' : true
                if (line.hold === true && ex.holdBg) {
                  line.holds = [{ bag: ex.holdBg, box: ex.holdBox || '' }]
                } else if (isNoHold) {
                  line.holds = []
                }
              }
            }

            lines[sys.awbIndex] = line
            const updates: Record<string, any> = {
              awb_lines: lines,
              pieces: lines.reduce((s, l) => s + (l.pieces || 0), 0),
            }
            if (row.diffs.some(d => d.field === 'Dest') && ex.dest) updates.destination_id = ex.dest
            await updateDoc(doc(db, 'airfreight_bookings', sys.bookingId), updates)

            log.push(`AWB ${ex.awb1st} actualizada: ${row.diffs.map(d => d.field).join(', ')}`)
          }

        } else if (row.status === 'new' && ex) {
          // ── Add new AWB ──
          const targetFlightNumber = normStr(ex.flight)
          const etdDate = ex.etd.slice(0, 10)
          const airline = ex.deliverTo || ''
          let targetFlight = allFlightsRef.current.find(f =>
            normStr(f.flight_number || '') === targetFlightNumber &&
            (etdDate ? f.flight_datetime.startsWith(etdDate) : true) &&
            normStr(f.airline || '') === normStr(airline)
          )

          if (!targetFlight) {
            const flightData: any = {
              airline: airline || 'Unknown', flight_number: ex.flight || null,
              flight_datetime: ex.etd || now, cutoff_datetime: ex.cutoff || null,
              destinations: ex.dest ? [ex.dest] : [], status: 'open',
              created_by: userEmail, created_at: now,
            }
            const docRef = await addDoc(collection(db, 'airfreight_flights'), flightData)
            targetFlight = { ...flightData, id: docRef.id } as AirfreightFlight & { id: string }
            allFlightsRef.current.push(targetFlight)
            log.push(`Vuelo creado: ${ex.flight} (${etdDate})`)
          }

          const holdBgLower = (ex.holdBg || '').toLowerCase().trim()
          const isNoHold = !holdBgLower || holdBgLower === 'no hold' || holdBgLower === 'no' || holdBgLower === 'n/a'
          const isPending = holdBgLower === 'pending' || holdBgLower === 'pendiente'
          const hasHold = !isNoHold && !isPending && !!ex.holdBg

          const newLine = {
            awb_number: ex.awb1st, awb_2nd_leg: ex.awb2nd || null,
            pieces: ex.pcs, weight: 0, chargeable_weight: ex.cw,
            uld_type: ex.uld || null, pickup_from: ex.pickupFrom || null,
            ready_for_pickup: ex.readyForPickup || null,
            last_day_free: ex.lastDayFree || null,
            docs_in_drive: ex.docsInDrive || false,
            battery: ex.battery, ddgg: false,
            hold: hasHold ? true : isNoHold ? false : 'pending' as const,
            on_hand: false,
            ...(hasHold ? { holds: [{ bag: ex.holdBg, box: ex.holdBox || '' }] } : {}),
          }

          const existingSnap = await getDocs(query(
            collection(db, 'airfreight_bookings'),
            where('flight_id', '==', targetFlight.id),
            where('client_id', '==', clientId),
            where('booking_type', '==', 'ecommerce'),
          ))
          const existingBooking = existingSnap.docs[0]

          if (existingBooking) {
            const bData = existingBooking.data() as AirfreightBooking
            const lines = [...(bData.awb_lines || []), newLine]
            await updateDoc(doc(db, 'airfreight_bookings', existingBooking.id), {
              awb_lines: lines,
              pieces: lines.reduce((s, l) => s + ((l as any).pieces || 0), 0),
              destination_id: ex.dest || bData.destination_id,
            })
          } else {
            const newAwbLines2 = [newLine]
            await addDoc(collection(db, 'airfreight_bookings'), {
              flight_id: targetFlight.id, flight_number: targetFlight.flight_number || null,
              airline: targetFlight.airline || '', booking_type: 'ecommerce',
              client_id: clientId, client_name: client?.name || '',
              status: 'submitted', created_by: userEmail, created_at: now,
              change_count: 0, modified_seen: true, change_log: [], documents: {},
              destination_id: ex.dest || '', awb_lines: newAwbLines2,
              pieces: newLine.pieces, hold: !!newLine.hold, on_hand: false,
              ...awbIndexField({ booking_type: 'ecommerce', awb_lines: newAwbLines2 }),
            })
          }

          log.push(`AWB ${ex.awb1st} agregada al vuelo ${ex.flight}`)

        } else if (row.status === 'removed' && sys) {
          // ── Remove AWB from system ──
          const bookingSnap = await getDoc(doc(db, 'airfreight_bookings', sys.bookingId))
          if (!bookingSnap.exists()) { log.push(`ERROR: Booking ${sys.bookingId.slice(0, 8)} no encontrado`); continue }
          const bData = bookingSnap.data() as AirfreightBooking
          const lines = [...(bData.awb_lines || [])] as AwbSecondLeg[]
          lines.splice(sys.awbIndex, 1)
          await updateDoc(doc(db, 'airfreight_bookings', sys.bookingId), {
            awb_lines: lines,
            pieces: lines.reduce((s, l) => s + (l.pieces || 0), 0),
          })
          log.push(`AWB ${sys.awb1st} eliminada del vuelo ${sys.flightNumber}`)
        }
      }

      // Flag billing recalculation for affected flight+client combos
      const billingAffected = new Set<string>()
      for (const row of rows) {
        if (row.system?.hasBilling && row.diffs.some(d => d.field === 'PCS' || d.field === 'CW' || d.field === 'ULD' || d.field === 'Vuelo')) {
          billingAffected.add(`${row.system.flightId}__${clientId}`)
        }
      }
      for (const key of billingAffected) {
        try {
          await setDoc(doc(db, 'air_billing_recalc_flags', key), {
            flight_id: key.split('__')[0],
            client_id: key.split('__')[1],
            flagged_at: now,
            flagged_by: userEmail,
            reason: 'validation_change',
          })
        } catch {}
      }
      if (billingAffected.size > 0) {
        log.push(`\n⚠️ ${billingAffected.size} grupo(s) de billing marcados para recálculo.`)
      }

      log.push(`\n✅ ${rows.length} cambio(s) aplicados exitosamente.`)
    } catch (err: any) {
      log.push(`\nERROR: ${err.message}`)
    }

    setApplyLog(log)
    setApplying(false)
    setSelected(new Set())
  }

  // ── Render ──

  const filtered = compRows.filter(r => {
    if (filterStatus && r.status !== filterStatus) return false
    if (filterDateFrom || filterDateTo) {
      const etd = (r.system?.etd || r.excel?.etd || '').slice(0, 10)
      if (filterDateFrom && etd < filterDateFrom) return false
      if (filterDateTo && etd > filterDateTo) return false
    }
    return true
  })
  const actionableCount = compRows.filter(r => r.status !== 'match').length
  const selectedCount = selected.size
  const selectedBlocked = [...selected].filter(i => compRows[i]?.blocked).length

  if (!isAdmin && !isAccounting && !isSuperAgent) {
    return <Layout title="Validation" backTo="/airfreight"><p className="text-center text-gray-500 mt-10">Admin only</p></Layout>
  }

  return (
    <Layout title="Booking Validation" backTo="/airfreight">
      <div className="max-w-[1400px] mx-auto space-y-4">
        {/* Controls */}
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Cliente</label>
            <select value={clientId} onChange={e => setClientId(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm min-w-[200px]">
              <option value="">Seleccionar...</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleUpload} />
            <button onClick={() => fileRef.current?.click()} disabled={!clientId || loading}
              className="bg-mcl-blue text-white px-5 py-2 rounded-lg text-sm font-semibold disabled:opacity-50 hover:bg-blue-900 transition-colors">
              {loading ? 'Procesando...' : 'Subir Excel para Validar'}
            </button>
          </div>
          {compRows.length > 0 && (
            <>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Desde</label>
                <input type="date" value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)}
                  className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Hasta</label>
                <input type="date" value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)}
                  className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
              </div>
            </>
          )}
          {actionableCount > 0 && applyLog.length === 0 && (
            <div className="flex items-center gap-2 ml-auto">
              <button onClick={selectAllActionable} className="text-xs text-mcl-blue hover:underline font-medium">
                Seleccionar todos ({compRows.filter(r => r.status !== 'match' && !r.blocked && !isRowDismissed(r)).length})
              </button>
              <button onClick={deselectAll} className="text-xs text-gray-400 hover:underline">Deseleccionar</button>
              <button
                onClick={handleApply}
                disabled={selectedCount === 0 || applying || selectedBlocked > 0}
                className="bg-green-600 text-white px-5 py-2 rounded-lg text-sm font-semibold disabled:opacity-50 hover:bg-green-700 transition-colors"
              >
                {applying ? 'Aplicando...' : `Aplicar ${selectedCount} cambio(s)`}
              </button>
            </div>
          )}
        </div>

        {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-2 text-sm">{error}</div>}

        {/* Summary */}
        {summary && (
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setFilterStatus('')}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${!filterStatus ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
              Todos ({summary.total})
            </button>
            <button onClick={() => setFilterStatus('match')}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${filterStatus === 'match' ? 'bg-green-600 text-white' : 'bg-green-50 text-green-700 hover:bg-green-100'}`}>
              ✅ Coinciden ({summary.match})
            </button>
            <button onClick={() => setFilterStatus('diff')}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${filterStatus === 'diff' ? 'bg-amber-600 text-white' : 'bg-amber-50 text-amber-700 hover:bg-amber-100'}`}>
              ⚠️ Diferencias ({summary.diff})
            </button>
            <button onClick={() => setFilterStatus('new')}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${filterStatus === 'new' ? 'bg-blue-600 text-white' : 'bg-blue-50 text-blue-700 hover:bg-blue-100'}`}>
              🆕 Nuevas ({summary.newRows})
            </button>
            <button onClick={() => setFilterStatus('removed')}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${filterStatus === 'removed' ? 'bg-red-600 text-white' : 'bg-red-50 text-red-700 hover:bg-red-100'}`}>
              🗑 No en Excel ({summary.removed})
            </button>
          </div>
        )}

        {/* Apply log */}
        {applyLog.length > 0 && (
          <div className="bg-gray-900 text-green-400 rounded-xl p-4 font-mono text-xs space-y-0.5 max-h-60 overflow-auto">
            {applyLog.map((l, i) => <div key={i}>{l}</div>)}
            <button onClick={() => { setApplyLog([]); setCompRows([]); setSummary(null) }}
              className="mt-3 text-white bg-gray-700 hover:bg-gray-600 px-4 py-1.5 rounded text-xs font-semibold">
              Cerrar y cargar nuevo Excel
            </button>
          </div>
        )}

        {/* Results table */}
        {filtered.length > 0 && applyLog.length === 0 && (
          <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto shadow-sm">
            <table className="w-full text-[11px]">
              <thead className="bg-gray-50 border-b sticky top-0 z-10">
                <tr>
                  <th className="px-2 py-2 w-6">#</th>
                  <th className="px-1 py-2 w-6"></th>
                  <th className="px-2 py-2 w-8"></th>
                  <th colSpan={7} className="px-2 py-1.5 text-center font-bold text-mcl-blue border-r border-gray-200 bg-blue-50/50">EXCEL</th>
                  <th colSpan={9} className="px-2 py-1.5 text-center font-bold text-emerald-700 bg-green-50/50">SISTEMA</th>
                  <th className="px-2 py-1.5 text-center font-bold text-gray-600">DIFERENCIAS</th>
                </tr>
                <tr className="border-t border-gray-100">
                  <th className="px-2 py-1.5 text-left font-medium text-gray-500">#</th>
                  <th className="px-1 py-1.5"></th>
                  <th className="px-2 py-1.5"></th>
                  <th className="px-2 py-1.5 text-left font-medium text-gray-500">Vuelo</th>
                  <th className="px-2 py-1.5 text-left font-medium text-gray-500">AWB 1st</th>
                  <th className="px-2 py-1.5 text-left font-medium text-gray-500">AWB 2nd</th>
                  <th className="px-2 py-1.5 text-right font-medium text-gray-500">PCS</th>
                  <th className="px-2 py-1.5 text-right font-medium text-gray-500">CW</th>
                  <th className="px-2 py-1.5 text-left font-medium text-gray-500">Dest</th>
                  <th className="px-2 py-1.5 text-left font-medium text-gray-500 border-r border-gray-200">Hold</th>
                  <th className="px-2 py-1.5 text-left font-medium text-gray-500">Vuelo</th>
                  <th className="px-2 py-1.5 text-center font-medium text-gray-500">Status</th>
                  <th className="px-2 py-1.5 text-left font-medium text-gray-500">ULD</th>
                  <th className="px-2 py-1.5 text-right font-medium text-gray-500">PCS</th>
                  <th className="px-2 py-1.5 text-right font-medium text-gray-500">CW</th>
                  <th className="px-2 py-1.5 text-left font-medium text-gray-500">Dest</th>
                  <th className="px-2 py-1.5 text-left font-medium text-gray-500 whitespace-nowrap">ETD</th>
                  <th className="px-2 py-1.5 text-center font-medium text-gray-500">Docs</th>
                  <th className="px-2 py-1.5 text-center font-medium text-gray-500">Disp</th>
                  <th className="px-2 py-1.5 text-left font-medium text-gray-500"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map((row, fi) => {
                  // Find original index for selection
                  const origIdx = compRows.indexOf(row)
                  const bg = row.status === 'match' ? '' : row.status === 'diff' ? 'bg-amber-50/40' : row.status === 'new' ? 'bg-blue-50/40' : 'bg-red-50/40'
                  const ex = row.excel
                  const sys = row.system
                  const diffFields = new Set(row.diffs.map(d => d.field))
                  const isSelected = selected.has(origIdx)
                  const isActionable = row.status !== 'match'

                  return (
                    <tr key={fi} className={`${bg} ${isSelected ? 'ring-2 ring-inset ring-green-400' : ''} hover:bg-gray-50/60`}>
                      <td className="px-2 py-1.5 text-right font-mono text-[10px] text-gray-400">{fi + 1}</td>
                      <td className="px-1 py-1.5 text-center">
                        {isActionable && (
                          <input
                            type="checkbox"
                            checked={isSelected}
                            disabled={row.blocked || isRowDismissed(row)}
                            onChange={() => toggleSelect(origIdx)}
                            className="w-3.5 h-3.5 rounded border-gray-300 text-green-600 focus:ring-green-500 disabled:opacity-30"
                            title={row.blocked ? 'Bloqueado — ver alertas' : isRowDismissed(row) ? 'Desestimada' : 'Seleccionar para aplicar'}
                          />
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        {row.status === 'match' && <span title="Coincide">✅</span>}
                        {row.status === 'diff' && <span title="Diferencias">⚠️</span>}
                        {row.status === 'new' && <span title="Nueva">🆕</span>}
                        {row.status === 'removed' && <span title="No en Excel">🗑</span>}
                      </td>
                      <td className={`px-2 py-1.5 font-mono ${diffFields.has('Vuelo') ? 'text-amber-700 font-bold' : 'text-gray-700'}`}>{ex?.flight || '—'}</td>
                      <td className="px-2 py-1.5 font-mono text-gray-600 text-[10px]">{ex?.awb1st || sys?.awb1st || '—'}</td>
                      <td className={`px-2 py-1.5 font-mono text-[10px] ${diffFields.has('2nd Leg') ? 'text-amber-700 font-bold' : 'text-gray-600'}`}>{ex?.awb2nd || '—'}</td>
                      <td className={`px-2 py-1.5 text-right font-mono ${diffFields.has('PCS') ? 'text-amber-700 font-bold' : 'text-gray-700'}`}>{ex?.pcs ?? '—'}</td>
                      <td className={`px-2 py-1.5 text-right font-mono ${diffFields.has('CW') ? 'text-amber-700 font-bold' : 'text-gray-700'}`}>{ex?.cw ?? '—'}</td>
                      <td className={`px-2 py-1.5 ${diffFields.has('Dest') ? 'text-amber-700 font-bold' : 'text-gray-700'}`}>{ex?.dest || '—'}</td>
                      <td className={`px-2 py-1.5 border-r border-gray-200 text-[10px] ${diffFields.has('Hold') ? 'text-amber-700 font-bold' : 'text-gray-500'}`}>{ex?.holdBg || '—'}</td>
                      <td className={`px-2 py-1.5 font-mono ${diffFields.has('Vuelo') ? 'text-amber-700 font-bold' : 'text-gray-700'}`}>
                        <div className="flex items-center gap-1">
                          <span>{sys?.flightNumber || '—'}</span>
                          {sys?.hasBilling && row.diffs.some(d => d.field === 'PCS' || d.field === 'CW' || d.field === 'ULD') && (
                            <a
                              href="/airfreight/billing/charges"
                              target="_blank"
                              title="Recalcular billing"
                              className="text-red-500 hover:text-red-700"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                            </a>
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        {sys ? (
                          <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold ${
                            sys.flightStatus === 'dispatched' ? 'bg-purple-100 text-purple-700'
                            : sys.flightStatus === 'terminado' ? 'bg-blue-100 text-blue-700'
                            : 'bg-gray-100 text-gray-600'
                          }`}>{sys.flightStatus.toUpperCase()}</span>
                        ) : '—'}
                      </td>
                      <td className={`px-2 py-1.5 font-mono text-[10px] ${diffFields.has('ULD') ? 'text-amber-700 font-bold' : 'text-gray-600'}`}>{sys?.uld || 'LOOSE'}</td>
                      <td className={`px-2 py-1.5 text-right font-mono ${diffFields.has('PCS') ? 'text-amber-700 font-bold' : 'text-gray-700'}`}>{sys?.pcs ?? '—'}</td>
                      <td className={`px-2 py-1.5 text-right font-mono ${diffFields.has('CW') ? 'text-amber-700 font-bold' : 'text-gray-700'}`}>{sys?.cw ?? '—'}</td>
                      <td className={`px-2 py-1.5 ${diffFields.has('Dest') ? 'text-amber-700 font-bold' : 'text-gray-700'}`}>{sys?.dest || '—'}</td>
                      <td className="px-2 py-1.5 font-mono text-[10px] whitespace-nowrap text-gray-600">{sys?.etd ? (() => { try { const d = new Date(sys.etd); return isNaN(d.getTime()) ? sys.etd.slice(0,16) : `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}` } catch { return sys.etd.slice(0,16) } })() : '—'}</td>
                      <td className="px-2 py-1.5 text-center">
                        {sys ? (sys.hasDocs ? <span className="text-blue-600 font-bold cursor-help" title={sys.docList.join(', ')}>{sys.docList.length}</span> : <span className="text-gray-300">0</span>) : '—'}
                      </td>
                      <td className="px-2 py-1.5 text-center">{sys ? (sys.dispatched ? <span className="text-purple-600 font-bold">✓</span> : <span className="text-gray-300">—</span>) : '—'}</td>
                      <td className="px-2 py-1.5">
                        <div className="space-y-0.5">
                          {isRowDismissed(row) && (
                            <div className="flex items-center gap-1">
                              <span className="inline-block bg-gray-200 text-gray-500 text-[9px] font-medium px-1.5 py-0.5 rounded">Desestimada</span>
                              <button onClick={(e) => { e.stopPropagation(); undismissRow(row) }} className="text-[9px] text-gray-400 hover:text-gray-600 underline">revertir</button>
                            </div>
                          )}
                          {row.diffs.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {row.diffs.map((d, j) => (
                                <span key={j} className="inline-block bg-amber-100 text-amber-800 text-[9px] font-medium px-1.5 py-0.5 rounded">
                                  {d.field}: {d.system} → {d.excel}
                                </span>
                              ))}
                            </div>
                          )}
                          {row.status === 'new' && <span className="text-[9px] text-blue-600 font-medium">No existe en sistema</span>}
                          {row.status === 'removed' && <span className="text-[9px] text-red-600 font-medium">No está en Excel</span>}
                          {row.status === 'match' && !isRowDismissed(row) && <span className="text-[9px] text-green-600">OK</span>}
                          {row.alerts.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-0.5">
                              {row.alerts.map((a, j) => (
                                <span key={j} className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
                                  a.severity === 'critical' ? 'bg-red-100 text-red-700' :
                                  a.severity === 'warning' ? 'bg-orange-100 text-orange-700' :
                                  'bg-blue-50 text-blue-600'
                                }`}>
                                  {a.severity === 'critical' ? '🔒' : a.severity === 'warning' ? '⚠' : 'ℹ'} {a.message}
                                </span>
                              ))}
                            </div>
                          )}
                          {isActionable && !isRowDismissed(row) && applyLog.length === 0 && (
                            <button onClick={(e) => { e.stopPropagation(); dismissRow(row) }}
                              className="text-[9px] text-gray-400 hover:text-red-500 underline mt-0.5">
                              Desestimar
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot className="bg-gray-100 border-t-2 border-gray-300 font-bold text-[11px]">
                <tr>
                  <td colSpan={3} className="px-2 py-2"></td>
                  <td colSpan={3} className="px-2 py-2 text-right text-gray-500">Totales Excel:</td>
                  <td className="px-2 py-2 text-right font-mono text-gray-800">{filtered.reduce((s, r) => s + (r.excel?.pcs || 0), 0).toLocaleString()}</td>
                  <td className="px-2 py-2 text-right font-mono text-gray-800">{filtered.reduce((s, r) => s + (r.excel?.cw || 0), 0).toLocaleString()}</td>
                  <td className="px-2 py-2 border-r border-gray-200"></td>
                  <td colSpan={3} className="px-2 py-2 text-right text-gray-500">Totales Sistema:</td>
                  <td className="px-2 py-2 text-right font-mono text-gray-800">{filtered.reduce((s, r) => s + (r.system?.pcs || 0), 0).toLocaleString()}</td>
                  <td className="px-2 py-2 text-right font-mono text-gray-800">{filtered.reduce((s, r) => s + (r.system?.cw || 0), 0).toLocaleString()}</td>
                  <td colSpan={6} className="px-2 py-2"></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {compRows.length === 0 && !loading && !error && applyLog.length === 0 && (
          <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-gray-400">
            Sube un Excel de bookings para comparar con los datos en sistema
          </div>
        )}
      </div>
    </Layout>
  )
}
