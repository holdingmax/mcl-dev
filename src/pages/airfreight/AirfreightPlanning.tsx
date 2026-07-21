import { useState, useEffect, useMemo, useCallback } from 'react'
import { collection, query, where, getDocs, doc, setDoc, getDoc, deleteDoc } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { AirfreightFlight, AirfreightBooking } from '../../types'
import { useAuth } from '../../contexts/AuthContext'
import Layout from '../../components/Layout'

/* ═══ CONFIG DEFAULTS ═══ */
const DEFAULTS = {
  productivity_kg_h: 550,
  shift_hours: 8,
  cutoff_hours: 6,
  kg_per_bup: 1800,
  docs_ready_hours_before: 2,
  bup_per_trip: 4.5,
  transport_hours: { LATAM: 2, AVIANCA: 2.5, default: 2.5 } as Record<string, number>,
}

/* ═══ HELPERS ═══ */
function addDays(d: Date, n: number) { const r = new Date(d); r.setDate(r.getDate() + n); return r }
function fmtDate(d: Date) { return d.toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' }) }
function fmtWeekday(d: Date) { return d.toLocaleDateString('es', { weekday: 'long' }) }
function parseFlightDt(dt: string): Date {
  if (!dt) return new Date(0)
  return dt.includes('T') ? new Date(dt) : new Date(dt + 'T00:00:00')
}
/** Round to nearest 0.5 (ceiling): 1.01→1.5, 2.0→2, 2.6→3 */
function roundHalf(n: number): number {
  return Math.ceil(n * 2) / 2
}
/** Format cutoff: ETD - cutoff_hours */
function fmtCutoff(etd: Date, hours: number): string {
  const co = new Date(etd.getTime() - hours * 3600000)
  const hh = co.getHours().toString().padStart(2, '0')
  const mm = co.getMinutes().toString().padStart(2, '0')
  const day = co.toLocaleDateString('es', { day: '2-digit', month: 'short' }).toUpperCase()
  return `${hh}:${mm} - ${day}`
}
function fmtEtd(etd: Date): string {
  const hh = etd.getHours().toString().padStart(2, '0')
  const mm = etd.getMinutes().toString().padStart(2, '0')
  const day = etd.toLocaleDateString('es', { day: '2-digit', month: 'short' }).toUpperCase()
  return `${hh}:${mm} - ${day}`
}
/** Parse "HH:MM - HH:MM" → end hour as number, or null */
function parseRangeEnd(range: string): number | null {
  const m = range.match(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/)
  if (!m) return null
  return parseInt(m[3]) + parseInt(m[4]) / 60
}
/** Hour offset from 06:00 D1 → percentage of 41h window */
function hourToPct(offset: number) { return Math.max(0, Math.min(100, (offset / 41) * 100)) }
function pct(v: number) { return `${v.toFixed(2)}%` }
function dateToOffset(d: Date, planStart: Date) { return (d.getTime() - planStart.getTime()) / 3600000 }

/* ═══ TYPES ═══ */
interface FlightRow {
  flight: AirfreightFlight & { id: string }
  bookings: (AirfreightBooking & { id: string })[]
  etd: Date
  totalKg: number
  kgOnHand: number
  awbsOnHand: number
  totalAwbs: number
  kgBuilt: number
  awbsBuilt: number
  estBup: number
  cantViajes: number
  hrsTransport: number
  docsReadySuggested: string
  isManual?: boolean
}

interface ManualFlight {
  id: string
  flight_number: string
  airline: string
  destination: string
  etd: string          // ISO datetime
  est_kg: number
  est_awbs: number
}

interface FlightPlanData {
  hora_prod_bodega: string
  k9: string
  docs_ready: string
  horario_transporte: string
  cia_transporte: string
  comentarios: string
}

interface StaffRow { name: string; schedule: string }
interface StaffBlock {
  supervisors: StaffRow[]
  agents: StaffRow[]
}
interface PlanDoc {
  date: string
  created_by: string
  created_at: string
  updated_at: string
  flight_plans: Record<string, FlightPlanData>
  manual_flights?: ManualFlight[]
  personnel: {
    counter: StaffBlock
    bodega: StaffBlock
    recepcion: StaffBlock
    screening: StaffBlock
  }
}

const EMPTY_STAFF: StaffBlock = { supervisors: [{ name: '', schedule: '' }], agents: [{ name: '', schedule: '' }] }
const EMPTY_PERSONNEL = (): PlanDoc['personnel'] => ({
  counter: { supervisors: [{ name: '', schedule: '' }], agents: [{ name: '', schedule: '' }] },
  bodega: { supervisors: [{ name: '', schedule: '' }], agents: [{ name: '', schedule: '' }] },
  recepcion: { supervisors: [{ name: '', schedule: '' }], agents: [{ name: '', schedule: '' }] },
  screening: { supervisors: [{ name: '', schedule: '' }], agents: [{ name: '', schedule: '' }] },
})
const EMPTY_FLIGHT_PLAN: FlightPlanData = { hora_prod_bodega: '', k9: '', docs_ready: '', horario_transporte: '', cia_transporte: '', comentarios: '' }

const DEST_COLORS: Record<string, string> = {
  BOG: 'bg-blue-100 text-blue-700',
  EZE: 'bg-purple-100 text-purple-700',
  MVD: 'bg-teal-100 text-teal-700',
  SCL: 'bg-orange-100 text-orange-700',
  LIM: 'bg-rose-100 text-rose-700',
  GRU: 'bg-yellow-100 text-yellow-700',
  MIA: 'bg-cyan-100 text-cyan-700',
}

/* ═══ COMPONENT ═══ */
export default function AirfreightPlanning() {
  const { user } = useAuth()
  const [planDate, setPlanDate] = useState(() => addDays(new Date(), 1).toISOString().slice(0, 10))
  const [flights, setFlights] = useState<(AirfreightFlight & { id: string })[]>([])
  const [bookings, setBookings] = useState<(AirfreightBooking & { id: string })[]>([])
  const [pickupBookings, setPickupBookings] = useState<(AirfreightBooking & { id: string })[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [expandedFlight, setExpandedFlight] = useState<string | null>(null)
  const [showNewPlan, setShowNewPlan] = useState(false)
  const [showConfig, setShowConfig] = useState(false)
  const [config, setConfig] = useState(DEFAULTS)
  const [flightPlans, setFlightPlans] = useState<Record<string, FlightPlanData>>({})
  const [manualFlights, setManualFlights] = useState<ManualFlight[]>([])
  const [personnel, setPersonnel] = useState<PlanDoc['personnel']>(EMPTY_PERSONNEL())
  const [personnelOverride, setPersonnelOverride] = useState<string>('')
  const [newPlanDate, setNewPlanDate] = useState(() => addDays(new Date(), 1).toISOString().slice(0, 10))
  const [uldAwbMap, setUldAwbMap] = useState<Map<string, string[]>>(new Map())

  const planStart = useMemo(() => { const d = new Date(planDate + 'T06:00:00'); return d }, [planDate])
  const planEnd = useMemo(() => { const d = addDays(new Date(planDate + 'T00:00:00'), 1); d.setHours(23, 0, 0, 0); return d }, [planDate])
  const d1 = new Date(planDate + 'T00:00:00')
  const d2 = addDays(d1, 1)

  // ── Load flights + bookings ──
  const loadData = useCallback(async (date: string) => {
    setLoading(true)
    try {
      const start = new Date(date + 'T06:00:00')
      const end = addDays(new Date(date + 'T00:00:00'), 1)
      end.setHours(23, 0, 0, 0)

      const fSnap = await getDocs(query(
        collection(db, 'airfreight_flights'),
        where('flight_datetime', '>=', start.toISOString().slice(0, 10)),
        where('flight_datetime', '<=', addDays(end, 1).toISOString().slice(0, 10)),
      ))
      const fDocs = fSnap.docs
        .map(d => ({ ...d.data() as AirfreightFlight, id: d.id }))
        .filter(f => { const etd = parseFlightDt(f.flight_datetime); return etd >= start && etd <= end })
        .sort((a, b) => parseFlightDt(a.flight_datetime).getTime() - parseFlightDt(b.flight_datetime).getTime())
      setFlights(fDocs)

      if (fDocs.length > 0) {
        const ids = fDocs.map(f => f.id)
        const all: (AirfreightBooking & { id: string })[] = []
        for (let i = 0; i < ids.length; i += 30) {
          const bSnap = await getDocs(query(collection(db, 'airfreight_bookings'), where('flight_id', 'in', ids.slice(i, i + 30))))
          all.push(...bSnap.docs.map(d => ({ ...d.data() as AirfreightBooking, id: d.id })))
        }
        setBookings(all)

        // Load ULD awb_numbers for KILOS BUILT
        const uldMap = new Map<string, string[]>()
        for (let i = 0; i < ids.length; i += 30) {
          const uSnap = await getDocs(query(
            collection(db, 'buildup_ulds'),
            where('flight_id', 'in', ids.slice(i, i + 30)),
          ))
          for (const d of uSnap.docs) {
            const data = d.data()
            const fid = data.flight_id as string
            const existing = uldMap.get(fid) || []
            const combined = new Set([...existing, ...((data.awb_numbers as string[]) || [])])
            uldMap.set(fid, [...combined])
          }
        }
        setUldAwbMap(uldMap)
      } else { setBookings([]); setUldAwbMap(new Map()) }

      // Load pickup-pending bookings: all ecommerce/mawb + simple with LFD
      // LFD lives inside awb_lines for ecommerce/mawb, so we load all and filter in memory
      try {
        const pickupAll: (AirfreightBooking & { id: string })[] = []
        const ecomSnap = await getDocs(query(
          collection(db, 'airfreight_bookings'),
          where('booking_type', 'in', ['mawb', 'ecommerce']),
        ))
        pickupAll.push(...ecomSnap.docs.map(d => ({ ...d.data() as AirfreightBooking, id: d.id })))
        // Also simple bookings that have LFD set
        const simpleSnap = await getDocs(query(
          collection(db, 'airfreight_bookings'),
          where('booking_type', '==', 'simple'),
        ))
        for (const d of simpleSnap.docs) {
          const b = d.data() as AirfreightBooking
          if (b.last_day_free || b.ready_for_pickup) {
            pickupAll.push({ ...b, id: d.id })
          }
        }
        setPickupBookings(pickupAll)
      } catch (err) {
        console.error('Pickup query error:', err)
        setPickupBookings([])
      }

      // Load saved plan
      const planRef = doc(db, 'airfreight_plans', date)
      const planSnap = await getDoc(planRef)
      if (planSnap.exists()) {
        const data = planSnap.data() as PlanDoc
        setFlightPlans(data.flight_plans || {})
        setManualFlights(data.manual_flights || [])
        setPersonnel(data.personnel || EMPTY_PERSONNEL())
      } else {
        setFlightPlans({})
        setManualFlights([])
        setPersonnel(EMPTY_PERSONNEL())
      }
    } catch (err) { console.error('Planning load error:', err) }
    setLoading(false)
  }, [])

  useEffect(() => { loadData(planDate) }, [planDate, loadData])

  // ── Save plan ──
  const savePlan = useCallback(async () => {
    setSaving(true)
    try {
      const planRef = doc(db, 'airfreight_plans', planDate)
      const data: PlanDoc = {
        date: planDate,
        created_by: user?.email || 'unknown',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        flight_plans: flightPlans,
        manual_flights: manualFlights,
        personnel,
      }
      await setDoc(planRef, data, { merge: true })
    } catch (err) { console.error('Save error:', err) }
    setSaving(false)
  }, [planDate, flightPlans, manualFlights, personnel, user])

  // Direct save for manual flights — bypasses state→effect chain
  const saveManualFlightsDirect = useCallback(async (mfs: ManualFlight[]) => {
    try {
      const planRef = doc(db, 'airfreight_plans', planDate)
      await setDoc(planRef, {
        date: planDate,
        manual_flights: mfs,
        updated_at: new Date().toISOString(),
        created_by: user?.email || 'unknown',
      }, { merge: true })
    } catch (err) { console.error('Save manual flights error:', err) }
  }, [planDate, user])

  // Auto-save on changes (debounced) — for flight plans and personnel edits
  useEffect(() => {
    if (loading) return
    const hasData = Object.keys(flightPlans).length > 0 || Object.keys(personnel).some(k => {
      const block = personnel[k as keyof typeof personnel]
      return block.supervisors.some(s => s.name) || block.agents.some(s => s.name)
    })
    if (!hasData) return
    const t = setTimeout(() => savePlan(), 2000)
    return () => clearTimeout(t)
  }, [flightPlans, personnel, loading, savePlan])

  // ── Cleanup old plans (>7 days) ──
  useEffect(() => {
    (async () => {
      try {
        const cutoff = addDays(new Date(), -7).toISOString().slice(0, 10)
        const snap = await getDocs(query(collection(db, 'airfreight_plans'), where('date', '<', cutoff)))
        for (const d of snap.docs) await deleteDoc(d.ref)
      } catch { /* ignore */ }
    })()
  }, [])

  // ── Flight plan field update ──
  function updateFlightPlan(flightId: string, field: keyof FlightPlanData, value: string) {
    setFlightPlans(prev => ({
      ...prev,
      [flightId]: { ...(prev[flightId] || EMPTY_FLIGHT_PLAN), [field]: value },
    }))
  }
  function getFp(flightId: string): FlightPlanData {
    return flightPlans[flightId] || EMPTY_FLIGHT_PLAN
  }

  // ── Computed flight rows ──
  const flightRows: FlightRow[] = useMemo(() => {
    // Real flights from Firestore
    const realRows: FlightRow[] = flights.map(flight => {
      const fBookings = bookings.filter(b => b.flight_id === flight.id)
      let totalKg = 0, kgOnHand = 0, awbsOnHand = 0, totalAwbs = 0

      for (const b of fBookings) {
        if (b.booking_type === 'simple') {
          const w = b.chargeable_weight || b.weight || 0
          totalKg += w; totalAwbs++
          if (b.on_hand) { kgOnHand += w; awbsOnHand++ }
        } else if (b.awb_lines) {
          for (const l of b.awb_lines) {
            const w = l.chargeable_weight || l.weight || 0
            totalKg += w; totalAwbs++
            if (l.on_hand) { kgOnHand += w; awbsOnHand++ }
          }
        }
      }

      const etd = parseFlightDt(flight.flight_datetime)
      const estBup = roundHalf(totalKg / config.kg_per_bup)
      const cantViajes = roundHalf(estBup / config.bup_per_trip)
      const airlineKey = (flight.airline || '').toUpperCase()
      const hrsPerTrip = config.transport_hours[airlineKey] || config.transport_hours.default
      const hrsTransport = cantViajes * hrsPerTrip

      // Docs Ready suggestion: 2h before end of Hora Prod Bodega
      const fp = flightPlans[flight.id]
      let docsReadySuggested = ''
      if (fp?.hora_prod_bodega) {
        const endH = parseRangeEnd(fp.hora_prod_bodega)
        if (endH !== null) {
          const sugH = endH - config.docs_ready_hours_before
          const hh = Math.floor(sugH).toString().padStart(2, '0')
          const mm = Math.round((sugH % 1) * 60).toString().padStart(2, '0')
          docsReadySuggested = `${hh}:${mm}`
        }
      }

      // KILOS BUILT: match ULD awb_numbers against bookings
      const builtAwbNums = uldAwbMap.get(flight.id) || []
      let kgBuilt = 0, awbsBuilt = 0
      for (const awbNum of builtAwbNums) {
        for (const b of fBookings) {
          if (b.booking_type === 'simple') {
            if (b.awb_number === awbNum || (b as any).awb_2nd_leg === awbNum) {
              kgBuilt += b.chargeable_weight || b.weight || 0
              awbsBuilt++
              break
            }
          } else if (b.awb_lines) {
            const line = b.awb_lines.find((l: any) => l.awb_number === awbNum || l.awb_2nd_leg === awbNum)
            if (line) {
              kgBuilt += line.chargeable_weight || line.weight || 0
              awbsBuilt++
              break
            }
          }
        }
      }

      return { flight, bookings: fBookings, etd, totalKg, kgOnHand, awbsOnHand, totalAwbs, kgBuilt, awbsBuilt, estBup, cantViajes, hrsTransport, docsReadySuggested }
    })

    // Manual flights (from plan doc, not from Firestore)
    // Skip manual flights that match a real flight (same flight_number + same ETD date)
    const manualRows: FlightRow[] = manualFlights
      .filter(mf => {
        const mfDate = (mf.etd || '').slice(0, 10)
        const mfKey = (mf.flight_number || '').replace(/[\s\-]/g, '').toUpperCase()
        return !flights.some(rf => {
          const rfKey = (rf.flight_number || '').replace(/[\s\-]/g, '').toUpperCase()
          const rfDate = (rf.flight_datetime || '').slice(0, 10)
          return rfKey === mfKey && rfDate === mfDate
        })
      })
      .map(mf => {
        const etd = parseFlightDt(mf.etd)
        const totalKg = mf.est_kg || 0
        const estBup = roundHalf(totalKg / config.kg_per_bup)
        const cantViajes = roundHalf(estBup / config.bup_per_trip)
        const airlineKey = (mf.airline || '').toUpperCase()
        const hrsPerTrip = config.transport_hours[airlineKey] || config.transport_hours.default
        const hrsTransport = cantViajes * hrsPerTrip

        const fp = flightPlans[mf.id]
        let docsReadySuggested = ''
        if (fp?.hora_prod_bodega) {
          const endH = parseRangeEnd(fp.hora_prod_bodega)
          if (endH !== null) {
            const sugH = endH - config.docs_ready_hours_before
            const hh = Math.floor(sugH).toString().padStart(2, '0')
            const mm = Math.round((sugH % 1) * 60).toString().padStart(2, '0')
            docsReadySuggested = `${hh}:${mm}`
          }
        }

        const fakeFlight = {
          id: mf.id,
          flight_number: mf.flight_number,
          airline: mf.airline,
          destinations: mf.destination ? [mf.destination] : [],
          flight_datetime: mf.etd,
        } as AirfreightFlight & { id: string }

        return {
          flight: fakeFlight, bookings: [], etd, totalKg, kgOnHand: 0, awbsOnHand: 0,
          totalAwbs: mf.est_awbs || 0, kgBuilt: 0, awbsBuilt: 0, estBup, cantViajes, hrsTransport, docsReadySuggested,
          isManual: true,
        }
      })

    return [...realRows, ...manualRows].sort((a, b) => a.etd.getTime() - b.etd.getTime())
  }, [flights, bookings, config, flightPlans, manualFlights, uldAwbMap])

  // ── Pickup KPI (replicates Transport "Pickup Today" logic) ──
  const pickupCount = useMemo(() => {
    const planDayStr = planDate // "2026-06-02"
    const threeDaysAgo = addDays(new Date(planDate + 'T00:00:00'), -3).toISOString().slice(0, 10)
    let count = 0

    const checkLine = (onHand?: boolean, warehouseStatus?: string, ready?: string | null, lfd?: string | null) => {
      // Skip already received in warehouse
      if (onHand || warehouseStatus === 'D' || warehouseStatus === 'R') return
      const lfdDate = (lfd || '').slice(0, 10)
      const readyDate = (ready || '').slice(0, 10)
      // LFD within window: threeDaysAgo <= LFD <= planDate
      if (lfdDate && lfdDate >= threeDaysAgo && lfdDate <= planDayStr) { count++; return }
      // Ready for pickup on plan date
      if (readyDate && readyDate === planDayStr) { count++; return }
    }

    for (const b of pickupBookings) {
      if (b.booking_type === 'simple') {
        checkLine(b.on_hand, (b as any).warehouse_status, b.ready_for_pickup, b.last_day_free)
      } else if (b.awb_lines) {
        for (const l of b.awb_lines) {
          checkLine(l.on_hand, (l as any).warehouse_status, l.ready_for_pickup, l.last_day_free)
        }
      }
    }
    return count
  }, [pickupBookings, planDate])

  // ── KPIs ──
  const totalKg = flightRows.reduce((s, r) => s + r.totalKg, 0)
  const totalKgOnHand = flightRows.reduce((s, r) => s + r.kgOnHand, 0)
  const totalKgBuilt = flightRows.reduce((s, r) => s + r.kgBuilt, 0)
  const totalBup = flightRows.reduce((s, r) => s + r.estBup, 0)
  const totalHH = totalKg / config.productivity_kg_h
  const suggestedPersonnel = Math.max(1, Math.ceil(totalHH / config.shift_hours))
  const displayPersonnel = personnelOverride || String(suggestedPersonnel)

  // ── Personnel helpers ──
  function updateStaff(area: keyof PlanDoc['personnel'], role: 'supervisors' | 'agents', idx: number, field: 'name' | 'schedule', value: string) {
    setPersonnel(prev => {
      const block = { ...prev[area] }
      const arr = [...block[role]]
      arr[idx] = { ...arr[idx], [field]: value }
      return { ...prev, [area]: { ...block, [role]: arr } }
    })
  }
  function addStaffRow(area: keyof PlanDoc['personnel'], role: 'supervisors' | 'agents') {
    setPersonnel(prev => {
      const block = { ...prev[area] }
      return { ...prev, [area]: { ...block, [role]: [...block[role], { name: '', schedule: '' }] } }
    })
  }
  function removeStaffRow(area: keyof PlanDoc['personnel'], role: 'supervisors' | 'agents', idx: number) {
    setPersonnel(prev => {
      const block = { ...prev[area] }
      const arr = block[role].filter((_, i) => i !== idx)
      return { ...prev, [area]: { ...block, [role]: arr.length ? arr : [{ name: '', schedule: '' }] } }
    })
  }

  // ── Gantt data ──
  const daySepPct = hourToPct(18) // midnight = 18h from 06:00
  const d1Label = d1.toLocaleDateString('es', { day: '2-digit', month: 'short' }).toUpperCase()
  const d2Label = d2.toLocaleDateString('es', { day: '2-digit', month: 'short' }).toUpperCase()
  const hours: number[] = []
  for (let h = 0; h < 41; h++) hours.push(h)

  // ── New plan ──
  function handleNewPlan() {
    setPlanDate(newPlanDate)
    setShowNewPlan(false)
  }

  return (
    <Layout title="Planning Diario" backTo="/airfreight/admin" fullWidth>
      <div className="max-w-[1920px] mx-auto px-2 space-y-5">

        {/* ── Top bar ── */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => setPlanDate(addDays(d1, -1).toISOString().slice(0, 10))} className="p-2 rounded-lg hover:bg-gray-200 text-gray-500">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
            </button>
            <div className="text-center">
              <div className="text-xl font-bold text-gray-800">{fmtDate(d1)}</div>
              <div className="text-xs text-gray-400 capitalize">{fmtWeekday(d1)} | Ventana 06:00 → 23:00 del {fmtDate(d2)}</div>
            </div>
            <button onClick={() => setPlanDate(addDays(d1, 1).toISOString().slice(0, 10))} className="p-2 rounded-lg hover:bg-gray-200 text-gray-500">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
            </button>
          </div>
          <div className="flex items-center gap-2">
            {saving && <span className="text-xs text-gray-400">Guardando...</span>}
            <button onClick={() => setShowConfig(true)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-100 flex items-center gap-1.5">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
              Config
            </button>
            <button onClick={() => { setNewPlanDate(addDays(new Date(), 1).toISOString().slice(0, 10)); setShowNewPlan(true) }} className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700">Nuevo Plan</button>
            <button onClick={() => loadData(planDate)} className="px-4 py-2 text-sm bg-amber-500 text-white rounded-lg hover:bg-amber-600">Actualizar</button>
          </div>
        </div>

        {/* ── KPIs ── */}
        <div className="grid grid-cols-2 md:grid-cols-8 gap-3">
          <KpiCard label="Vuelos" value={String(flights.length)} />
          <KpiCard label="Kilos Total" value={totalKg.toLocaleString()} />
          <KpiCard label="Recibida" value={totalKgOnHand.toLocaleString()} sub={totalKg > 0 ? `${((totalKgOnHand / totalKg) * 100).toFixed(1)}% del total` : ''} color="text-emerald-600" />
          <KpiCard label="Armada" value={totalKgBuilt.toLocaleString()} sub={totalKgOnHand > 0 ? `${((totalKgBuilt / totalKgOnHand) * 100).toFixed(1)}% de recibida` : ''} color="text-blue-600" />
          <KpiCard label="Est. BUP" value={String(totalBup)} />
          <KpiCard label="Guias a Recoger" value={String(pickupCount)} sub="pickup pendiente" color="text-purple-600" />
          <KpiCard label="Horas-Hombre" value={totalHH.toFixed(1)} sub={`${totalKg.toLocaleString()} / ${config.productivity_kg_h}`} />
          <div className="bg-white rounded-xl border px-4 py-3 text-center">
            <div className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Personal Sug.</div>
            <div className="flex items-center justify-center gap-1.5">
              <div className="text-2xl font-extrabold text-gray-800">{suggestedPersonnel}</div>
              <input type="number" value={displayPersonnel} onChange={e => setPersonnelOverride(e.target.value)}
                className="w-10 text-center border rounded text-sm font-bold text-blue-700" />
            </div>
          </div>
        </div>

        {loading && <div className="text-center py-8 text-gray-400">Cargando vuelos...</div>}

        {/* ── PLANNING TABLE ── */}
        {!loading && (
          <div className="bg-white rounded-xl border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse" style={{ fontSize: 12 }}>
                <thead>
                  <tr className="bg-gradient-to-r from-slate-700 to-slate-600 text-white text-[10px] uppercase tracking-wider">
                    <th className="px-3 py-2.5 text-left font-semibold min-w-[90px]">Cliente</th>
                    <th className="px-3 py-2.5 font-semibold min-w-[70px]">Aerolinea</th>
                    <th className="px-3 py-2.5 font-semibold min-w-[70px]">Vuelo</th>
                    <th className="px-3 py-2.5 font-semibold">Dest</th>
                    <th className="px-3 py-2.5 font-semibold min-w-[90px]">Cut Off</th>
                    <th className="px-3 py-2.5 font-semibold min-w-[90px]">ETD</th>
                    <th className="px-3 py-2.5 font-semibold"># AWBs</th>
                    <th className="px-3 py-2.5 font-semibold">Kilos</th>
                    <th className="px-3 py-2.5 font-semibold">Kilos en<br/>Bodega</th>
                    <th className="px-3 py-2.5 font-semibold">Kilos<br/>Armados</th>
                    <th className="px-3 py-2.5 font-semibold">Est.<br/>BUP</th>
                    <th className="px-3 py-2.5 font-semibold min-w-[110px]">Hora Prod<br/>Bodega</th>
                    <th className="px-3 py-2.5 font-semibold min-w-[110px]">K9</th>
                    <th className="px-3 py-2.5 font-semibold min-w-[60px]">Docs<br/>Ready</th>
                    <th className="px-3 py-2.5 font-semibold">Cant.<br/>Viajes</th>
                    <th className="px-3 py-2.5 font-semibold">Hrs<br/>Transp.</th>
                    <th className="px-3 py-2.5 font-semibold min-w-[110px]">Horario<br/>Transporte</th>
                    <th className="px-3 py-2.5 font-semibold min-w-[80px]">Cia<br/>Transporte</th>
                    <th className="px-3 py-2.5 font-semibold min-w-[120px]">Comentarios</th>
                  </tr>
                </thead>
                <tbody>
                  {flightRows.map(row => {
                    const fp = getFp(row.flight.id)
                    const dest = row.flight.destinations?.[0] || '?'
                    const destColor = DEST_COLORS[dest] || 'bg-gray-100 text-gray-700'
                    // Determine which client name to show (most common across bookings)
                    const clientName = row.bookings.length > 0 ? row.bookings[0].client_name : '—'
                    const isExpanded = expandedFlight === row.flight.id

                    const updateManual = (field: keyof ManualFlight, value: any) => {
                      const updated = manualFlights.map(mf => mf.id === row.flight.id ? { ...mf, [field]: value } : mf)
                      setManualFlights(updated)
                      // Debounced save for field edits (avoid saving on every keystroke)
                      clearTimeout((window as any).__manualSaveTimer)
                      ;(window as any).__manualSaveTimer = setTimeout(() => saveManualFlightsDirect(updated), 1000)
                    }

                    return [
                      <tr key={row.flight.id} className={`hover:bg-gray-50 border-b border-gray-200 ${row.isManual ? 'bg-amber-50/40' : ''}`}>
                        <td className="px-3 py-2 text-left font-semibold border border-gray-200">
                          {row.isManual ? (
                            <div className="flex items-center gap-1">
                              <button onClick={async () => {
                                if (!confirm(`Eliminar vuelo manual ${row.flight.flight_number}?`)) return
                                const updated = manualFlights.filter(mf => mf.id !== row.flight.id)
                                setManualFlights(updated)
                                setFlightPlans(prev => { const next = { ...prev }; delete next[row.flight.id]; return next })
                                await saveManualFlightsDirect(updated)
                              }} className="text-gray-300 hover:text-red-500 flex-shrink-0" title="Eliminar">
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                              </button>
                              <span className="text-amber-600 italic text-[10px]">Manual</span>
                            </div>
                          ) : clientName}
                        </td>
                        <td className="px-1 py-1 text-center border border-gray-200">
                          {row.isManual
                            ? <input type="text" value={row.flight.airline} onChange={e => updateManual('airline', e.target.value)}
                                placeholder="LATAM" className="w-full min-w-[70px] text-center text-xs bg-amber-50 outline-none focus:bg-white focus:ring-2 focus:ring-blue-500 rounded px-1 py-1 border border-amber-200" />
                            : row.flight.airline}
                        </td>
                        <td className="px-1 py-1 text-center font-semibold border border-gray-200">
                          {row.isManual
                            ? <input type="text" value={row.flight.flight_number} onChange={e => updateManual('flight_number', e.target.value.toUpperCase())}
                                placeholder="LA-0543" className="w-full min-w-[70px] text-center text-xs font-semibold bg-amber-50 outline-none focus:bg-white focus:ring-2 focus:ring-blue-500 rounded px-1 py-1 border border-amber-200" />
                            : <span className="cursor-pointer underline decoration-blue-300 underline-offset-2 hover:text-blue-700"
                                onClick={() => setExpandedFlight(isExpanded ? null : row.flight.id)}>
                                {row.flight.flight_number || '?'}
                              </span>}
                        </td>
                        <td className="px-1 py-1 text-center border border-gray-200">
                          {row.isManual
                            ? <input type="text" value={dest === '?' ? '' : dest} onChange={e => updateManual('destination', e.target.value.toUpperCase())}
                                placeholder="EZE" className="w-full text-center text-[10px] font-bold bg-amber-50 outline-none focus:bg-white focus:ring-2 focus:ring-blue-500 rounded px-1 py-1 border border-amber-200" />
                            : <span className={`${destColor} px-1.5 py-0.5 rounded text-[10px] font-bold`}>{dest}</span>}
                        </td>
                        <td className="px-3 py-2 text-center font-bold text-[11px] border border-gray-200">{fmtCutoff(row.etd, config.cutoff_hours)}</td>
                        <td className="px-1 py-1 text-center font-semibold border border-gray-200">
                          {row.isManual
                            ? <div className="flex flex-col gap-0.5">
                                <input type="date" value={(row.flight.flight_datetime || '').slice(0, 10)}
                                  onChange={e => { const time = (row.flight.flight_datetime || '').slice(11, 16) || '23:00'; updateManual('etd', e.target.value ? `${e.target.value}T${time}:00` : '') }}
                                  className="w-full text-center text-[10px] bg-amber-50 outline-none focus:bg-white focus:ring-2 focus:ring-blue-500 rounded px-1 py-0.5 border border-amber-200" />
                                <input type="time" value={(row.flight.flight_datetime || '').slice(11, 16)}
                                  onChange={e => { const date = (row.flight.flight_datetime || '').slice(0, 10) || planDate; updateManual('etd', `${date}T${e.target.value}:00`) }}
                                  className="w-full text-center text-[10px] bg-amber-50 outline-none focus:bg-white focus:ring-2 focus:ring-blue-500 rounded px-1 py-0.5 border border-amber-200" />
                              </div>
                            : fmtEtd(row.etd)}
                        </td>
                        <td className="px-1 py-1 text-center border border-gray-200">
                          {row.isManual
                            ? <input type="text" inputMode="numeric" value={row.totalAwbs || ''} onChange={e => updateManual('est_awbs', parseInt(e.target.value) || 0)}
                                placeholder="0" className="w-full text-center text-xs bg-amber-50 outline-none focus:bg-white focus:ring-2 focus:ring-blue-500 rounded px-1 py-1 border border-amber-200" />
                            : row.totalAwbs}
                        </td>
                        <td className="px-1 py-1 text-center font-bold border border-gray-200">
                          {row.isManual
                            ? <input type="text" inputMode="numeric" value={row.totalKg || ''} onChange={e => updateManual('est_kg', parseFloat(e.target.value) || 0)}
                                placeholder="0" className="w-full text-center text-xs font-bold bg-amber-50 outline-none focus:bg-white focus:ring-2 focus:ring-blue-500 rounded px-1 py-1 border border-amber-200" />
                            : row.totalKg.toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-center border border-gray-200">
                          {row.kgOnHand > 0
                            ? <><span className="font-semibold">{row.kgOnHand.toLocaleString()}</span><br/><span className="text-[10px] text-gray-500">{row.awbsOnHand} AWBs</span></>
                            : <span className="text-gray-400">0</span>}
                        </td>
                        <td className="px-3 py-2 text-center border border-gray-200">
                          {row.kgBuilt > 0
                            ? <><span className="font-semibold text-blue-700">{row.kgBuilt.toLocaleString()}</span><br/><span className="text-[10px] text-gray-500">{row.awbsBuilt} AWBs</span></>
                            : <span className="text-gray-400">0</span>}
                        </td>
                        <td className="px-3 py-2 text-center font-bold border border-gray-200">{row.estBup}</td>
                        {/* Manual inputs */}
                        <td className="px-1 py-1 border border-gray-200 bg-blue-50">
                          <input type="text" value={fp.hora_prod_bodega} onChange={e => updateFlightPlan(row.flight.id, 'hora_prod_bodega', e.target.value)}
                            placeholder="xx:xx - xx:xx" className="w-full text-center text-xs bg-transparent outline-none focus:bg-white focus:ring-2 focus:ring-blue-500 rounded px-1 py-1" />
                        </td>
                        <td className="px-1 py-1 border border-gray-200 bg-blue-50">
                          <input type="text" value={fp.k9} onChange={e => updateFlightPlan(row.flight.id, 'k9', e.target.value)}
                            placeholder="xx:xx - xx:xx" className="w-full text-center text-xs bg-transparent outline-none focus:bg-white focus:ring-2 focus:ring-blue-500 rounded px-1 py-1" />
                        </td>
                        <td className="px-1 py-1 border border-gray-200 bg-blue-50">
                          <input type="text" value={fp.docs_ready || row.docsReadySuggested}
                            onChange={e => updateFlightPlan(row.flight.id, 'docs_ready', e.target.value)}
                            placeholder="HH:MM" className="w-full text-center text-xs bg-transparent outline-none focus:bg-white focus:ring-2 focus:ring-blue-500 rounded px-1 py-1" />
                        </td>
                        <td className="px-3 py-2 text-center border border-gray-200">{row.cantViajes}</td>
                        <td className="px-3 py-2 text-center border border-gray-200">{row.hrsTransport}h</td>
                        <td className="px-1 py-1 border border-gray-200 bg-blue-50">
                          <input type="text" value={fp.horario_transporte} onChange={e => updateFlightPlan(row.flight.id, 'horario_transporte', e.target.value)}
                            placeholder="xx:xx - xx:xx" className="w-full text-center text-xs bg-transparent outline-none focus:bg-white focus:ring-2 focus:ring-blue-500 rounded px-1 py-1" />
                        </td>
                        <td className="px-1 py-1 border border-gray-200 bg-blue-50">
                          <select value={fp.cia_transporte} onChange={e => updateFlightPlan(row.flight.id, 'cia_transporte', e.target.value)}
                            className="w-full text-center text-xs bg-transparent outline-none focus:bg-white focus:ring-2 focus:ring-blue-500 rounded px-1 py-1">
                            <option value="">—</option>
                            <option value="COT">COT</option>
                            <option value="GEO">GEO</option>
                            <option value="Otro">Otro</option>
                          </select>
                        </td>
                        <td className="px-1 py-1 border border-gray-200 bg-blue-50">
                          <textarea rows={1} value={fp.comentarios} onChange={e => updateFlightPlan(row.flight.id, 'comentarios', e.target.value)}
                            placeholder="..." className="w-full text-left text-xs bg-transparent outline-none focus:bg-white focus:ring-2 focus:ring-blue-500 rounded px-1 py-1 resize-none" />
                        </td>
                      </tr>,
                      // Detail row
                      isExpanded && (
                        <tr key={`${row.flight.id}-detail`}>
                          <td colSpan={19} className="p-0 bg-gray-50 border border-gray-200">
                            <div className="px-6 py-4">
                              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                                Detalle de Carga — {row.flight.flight_number} ({row.totalAwbs} AWBs)
                              </div>
                              <div className="overflow-x-auto">
                                <table className="w-full text-xs border-collapse">
                                  <thead>
                                    <tr className="bg-gray-100 text-gray-600">
                                      <th className="text-left px-3 py-1.5 font-medium border">AWB</th>
                                      <th className="text-left px-3 py-1.5 font-medium border">Cliente</th>
                                      <th className="text-center px-3 py-1.5 font-medium border">PCS</th>
                                      <th className="text-center px-3 py-1.5 font-medium border">KG</th>
                                      <th className="text-center px-3 py-1.5 font-medium border">CHW</th>
                                      <th className="text-center px-3 py-1.5 font-medium border">KG Recibidos</th>
                                      <th className="text-center px-3 py-1.5 font-medium border">Recibida</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {row.bookings.flatMap(b => {
                                      if (b.booking_type === 'simple') {
                                        const w = b.chargeable_weight || b.weight || 0
                                        return [(
                                          <tr key={b.id}>
                                            <td className="px-3 py-1.5 font-mono border">{b.awb_1st_leg || '?'}</td>
                                            <td className="px-3 py-1.5 border">{b.client_name}</td>
                                            <td className="text-center border">{b.pieces}</td>
                                            <td className="text-center border">{(b.weight || 0).toLocaleString()}</td>
                                            <td className="text-center border font-semibold">{w.toLocaleString()}</td>
                                            <td className="text-center border font-semibold">{b.on_hand ? w.toLocaleString() : <span className="text-gray-400">0</span>}</td>
                                            <td className="text-center border">{b.on_hand ? <span className="text-green-600 font-bold">&#10003;</span> : <span className="text-red-600">&#10007;</span>}</td>
                                          </tr>
                                        )]
                                      }
                                      return (b.awb_lines || []).map((l, li) => {
                                        const w = l.chargeable_weight || l.weight || 0
                                        return (
                                          <tr key={`${b.id}-${li}`}>
                                            <td className="px-3 py-1.5 font-mono border">{l.awb_number || '?'}</td>
                                            <td className="px-3 py-1.5 border">{b.client_name}</td>
                                            <td className="text-center border">{l.pieces}</td>
                                            <td className="text-center border">{(l.weight || 0).toLocaleString()}</td>
                                            <td className="text-center border font-semibold">{w.toLocaleString()}</td>
                                            <td className="text-center border font-semibold">{l.on_hand ? w.toLocaleString() : <span className="text-gray-400">0</span>}</td>
                                            <td className="text-center border">{l.on_hand ? <span className="text-green-600 font-bold">&#10003;</span> : <span className="text-red-600">&#10007;</span>}</td>
                                          </tr>
                                        )
                                      })
                                    })}
                                  </tbody>
                                  <tfoot>
                                    <tr className="bg-gray-100 font-semibold">
                                      <td colSpan={4} className="text-right px-3 py-1.5 border">Total</td>
                                      <td className="text-center border">{row.totalKg.toLocaleString()}</td>
                                      <td className="text-center border">{row.kgOnHand.toLocaleString()}</td>
                                      <td className="text-center border text-[10px] text-gray-500">{row.awbsOnHand}/{row.totalAwbs}</td>
                                    </tr>
                                  </tfoot>
                                </table>
                              </div>
                            </div>
                          </td>
                        </tr>
                      ),
                    ]
                  })}
                  {/* TOTAL ROW */}
                  <tr className="bg-slate-100 font-bold border-t-2 border-slate-300">
                    <td colSpan={4} className="text-right px-3 py-2 uppercase text-[11px] tracking-wide border border-gray-200">Total</td>
                    <td className="border border-gray-200"></td>
                    <td className="border border-gray-200"></td>
                    <td className="text-center border border-gray-200">{flightRows.reduce((s, r) => s + r.totalAwbs, 0)}</td>
                    <td className="text-center border border-gray-200 bg-blue-50">{totalKg.toLocaleString()}</td>
                    <td className="text-center border border-gray-200 bg-blue-50">{totalKgOnHand.toLocaleString()}</td>
                    <td className="text-center border border-gray-200 bg-blue-50">{totalBup}</td>
                    <td colSpan={8} className="border border-gray-200"></td>
                  </tr>
                  {/* ADD MANUAL FLIGHT ROW */}
                  <tr>
                    <td colSpan={19} className="border-0 pt-1">
                      <button onClick={async () => {
                        const mf: ManualFlight = {
                          id: `manual_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                          flight_number: '',
                          airline: '',
                          destination: '',
                          etd: `${planDate}T23:00:00`,
                          est_kg: 0,
                          est_awbs: 0,
                        }
                        const updated = [...manualFlights, mf]
                        setManualFlights(updated)
                        await saveManualFlightsDirect(updated)
                      }} className="w-full py-1.5 text-xs text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-b-lg border border-dashed border-gray-200 hover:border-blue-300 transition-colors flex items-center justify-center gap-1">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                        Agregar vuelo manual
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── GANTT ── */}
        {flightRows.length > 0 && (
          <div className="bg-white rounded-xl border p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Timeline Visual — {d1Label} 06:00 → {d2Label} 23:00</h3>
              <div className="flex items-center gap-3 text-[10px] text-gray-400">
                <span className="flex items-center gap-1"><span className="w-3 h-2 bg-blue-500 rounded inline-block" /> Armado</span>
                <span className="flex items-center gap-1"><span className="w-3 h-2 bg-amber-400 rounded inline-block" /> K9</span>
                <span className="flex items-center gap-1"><span className="w-3 h-2 bg-pink-400 rounded inline-block" /> Docs</span>
                <span className="flex items-center gap-1"><span className="w-3 h-2 bg-emerald-500 rounded inline-block" /> Transporte</span>
                <span className="flex items-center gap-1"><span className="w-0.5 h-3 bg-red-600 inline-block" /> CO</span>
                <span className="flex items-center gap-1"><span className="w-0.5 h-3 bg-gray-800 inline-block" /> ETD</span>
              </div>
            </div>
            <div>
              {/* Day labels */}
              <div className="flex items-end mb-0 ml-[120px]">
                <div className="flex-1 relative h-3.5">
                  <span className="absolute text-[9px] font-semibold text-blue-700" style={{ left: '0%' }}>{d1Label}</span>
                  <div className="absolute top-0 bottom-0 w-0.5 bg-blue-700/30" style={{ left: pct(daySepPct) }} />
                  <span className="absolute text-[9px] font-semibold text-blue-700" style={{ left: pct(daySepPct + 0.5) }}>{d2Label}</span>
                </div>
              </div>
              {/* Hour headers */}
              <div className="flex items-end mb-1 ml-[120px]">
                <div className="flex-1 relative h-4">
                  {hours.map(h => {
                    const actualHour = (6 + h) % 24
                    return <span key={h} className={`absolute text-[10px] ${h === 18 ? 'text-gray-500 font-semibold' : 'text-gray-400'}`}
                      style={{ left: pct(hourToPct(h)) }}>{String(actualHour).padStart(2, '0')}</span>
                  })}
                </div>
              </div>
              {/* Flight rows */}
              {flightRows.map(row => {
                const fp = getFp(row.flight.id)
                const etdOffset = dateToOffset(row.etd, planStart)
                const coOffset = etdOffset - config.cutoff_hours
                const armadoRange = fp.hora_prod_bodega.match(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/)
                const k9Range = fp.k9.match(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/)
                const docsTime = (fp.docs_ready || row.docsReadySuggested).match(/(\d{1,2}):(\d{2})/)
                const transportRange = fp.horario_transporte.match(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/)

                function timeToOffset(hh: string, mm: string): number {
                  let hour = parseInt(hh) + parseInt(mm) / 60
                  if (hour < 6) hour += 24
                  return hour - 6
                }

                const hasAny = armadoRange || k9Range || docsTime || transportRange
                const ROW_H = 16
                const activityRows: { label: string; color: string; textColor: string; left: number; width: number }[] = []
                if (armadoRange) {
                  const l = hourToPct(timeToOffset(armadoRange[1], armadoRange[2]))
                  const r = hourToPct(timeToOffset(armadoRange[3], armadoRange[4]))
                  activityRows.push({ label: 'ARMADO', color: 'bg-blue-500', textColor: 'text-white', left: l, width: r - l })
                }
                if (k9Range) {
                  const l = hourToPct(timeToOffset(k9Range[1], k9Range[2]))
                  const r = hourToPct(timeToOffset(k9Range[3], k9Range[4]))
                  activityRows.push({ label: 'K9', color: 'bg-amber-400', textColor: 'text-amber-900', left: l, width: r - l })
                }
                if (docsTime) {
                  const l = hourToPct(timeToOffset(docsTime[1], docsTime[2]))
                  const w = hourToPct(config.docs_ready_hours_before)
                  activityRows.push({ label: 'DOCS', color: 'bg-pink-400', textColor: 'text-white', left: l, width: w })
                }
                if (transportRange) {
                  const l = hourToPct(timeToOffset(transportRange[1], transportRange[2]))
                  const r = hourToPct(timeToOffset(transportRange[3], transportRange[4]))
                  activityRows.push({ label: 'TRANSP', color: 'bg-emerald-500', textColor: 'text-white', left: l, width: r - l })
                }
                const totalH = hasAny ? activityRows.length * ROW_H + (activityRows.length - 1) * 2 + 4 : 28

                return (
                  <div key={row.flight.id} className="flex items-stretch mb-1">
                    <div className="w-[120px] flex-shrink-0 pr-3 text-right flex flex-col justify-center">
                      <div className="text-xs font-semibold text-gray-700">{row.flight.flight_number || '?'}</div>
                      <div className="text-[9px] text-gray-400">{row.flight.destinations?.[0] || '?'} | {row.totalKg.toLocaleString()} kg</div>
                    </div>
                    <div className="flex-1 relative bg-gray-50 rounded border border-gray-100" style={{ height: totalH }}>
                      <div className="absolute top-0 bottom-0 w-0.5 bg-blue-700/20" style={{ left: pct(daySepPct) }} />
                      {/* Activity rows — one per line */}
                      {activityRows.map((act, i) => (
                        <div key={act.label}
                          className={`absolute ${act.color} ${act.textColor} rounded text-[8px] flex items-center justify-center font-medium`}
                          style={{ left: pct(act.left), width: pct(act.width), top: 2 + i * (ROW_H + 2), height: ROW_H }}>
                          {act.label}
                        </div>
                      ))}
                      {/* No data */}
                      {!hasAny && (
                        <div className="flex items-center justify-center h-full text-[10px] text-gray-300 italic">Sin programar</div>
                      )}
                      {/* CO marker */}
                      <div className="absolute top-0 bottom-0 w-0.5 bg-red-600 z-10" style={{ left: pct(hourToPct(coOffset)) }}>
                        <div className="absolute -bottom-3 -left-1.5 text-[7px] text-red-600 font-bold">CO</div>
                      </div>
                      {/* ETD marker */}
                      <div className="absolute top-0 bottom-0 w-0.5 bg-gray-800 z-10" style={{ left: pct(hourToPct(etdOffset)) }}>
                        <div className="absolute -bottom-3 -left-2 text-[7px] text-gray-600 font-bold">ETD</div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ── PERSONNEL ── */}
        <div className="bg-white rounded-xl border p-4">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Planificacion de Personal — {d1Label} / {d2Label}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {(['counter', 'bodega', 'recepcion', 'screening'] as const).map(area => (
              <div key={area} className="border rounded-lg overflow-hidden">
                <div className="bg-slate-700 text-white px-3 py-1.5 text-xs font-bold uppercase tracking-wide">{area}</div>
                <div className="p-3 space-y-2">
                  {/* Supervisors */}
                  <div>
                    <div className="text-[10px] text-gray-400 uppercase font-semibold mb-1">Supervisor</div>
                    <div className="space-y-1">
                      {personnel[area].supervisors.map((s, i) => (
                        <div key={i} className="flex gap-1 items-center">
                          <input className="flex-1 bg-blue-50 border border-gray-200 rounded px-1.5 py-1 text-[11px] outline-none focus:ring-2 focus:ring-blue-500"
                            value={s.name} onChange={e => updateStaff(area, 'supervisors', i, 'name', e.target.value)} placeholder="Nombre" />
                          <input className="w-[85px] bg-blue-50 border border-gray-200 rounded px-1.5 py-1 text-[11px] text-center outline-none focus:ring-2 focus:ring-blue-500"
                            value={s.schedule} onChange={e => updateStaff(area, 'supervisors', i, 'schedule', e.target.value)} placeholder="xx:xx - xx:xx" />
                          {personnel[area].supervisors.length > 1 && (
                            <button onClick={() => removeStaffRow(area, 'supervisors', i)} className="text-gray-300 hover:text-red-500 text-sm">×</button>
                          )}
                        </div>
                      ))}
                    </div>
                    <button onClick={() => addStaffRow(area, 'supervisors')} className="text-[10px] text-blue-600 hover:text-blue-800 mt-1">+ Agregar</button>
                  </div>
                  {/* Agents */}
                  <div className="border-t pt-2">
                    <div className="text-[10px] text-gray-400 uppercase font-semibold mb-1">Agentes</div>
                    <div className="space-y-1">
                      {personnel[area].agents.map((a, i) => (
                        <div key={i} className="flex gap-1 items-center">
                          <input className="flex-1 bg-blue-50 border border-gray-200 rounded px-1.5 py-1 text-[11px] outline-none focus:ring-2 focus:ring-blue-500"
                            value={a.name} onChange={e => updateStaff(area, 'agents', i, 'name', e.target.value)} placeholder="Nombre" />
                          <input className="w-[85px] bg-blue-50 border border-gray-200 rounded px-1.5 py-1 text-[11px] text-center outline-none focus:ring-2 focus:ring-blue-500"
                            value={a.schedule} onChange={e => updateStaff(area, 'agents', i, 'schedule', e.target.value)} placeholder="xx:xx - xx:xx" />
                          {personnel[area].agents.length > 1 && (
                            <button onClick={() => removeStaffRow(area, 'agents', i)} className="text-gray-300 hover:text-red-500 text-sm">×</button>
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="flex items-center justify-between mt-1">
                      <button onClick={() => addStaffRow(area, 'agents')} className="text-[10px] text-blue-600 hover:text-blue-800">+ Agregar</button>
                      <span className="text-[10px] text-gray-400">Total: <strong>{personnel[area].agents.filter(a => a.name).length}</strong></span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── NEW PLAN MODAL ── */}
        {showNewPlan && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowNewPlan(false)}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
              <div className="px-6 py-4 border-b flex items-center justify-between">
                <h2 className="text-lg font-bold text-gray-800">Nuevo Plan</h2>
                <button onClick={() => setShowNewPlan(false)} className="text-gray-400 hover:text-gray-600 text-2xl">&times;</button>
              </div>
              <div className="px-6 py-4 space-y-3">
                <div className="p-2 bg-blue-50 border border-blue-200 rounded text-xs text-blue-700">
                  Selecciona el dia a planificar. La ventana sera desde las 06:00 del dia seleccionado hasta las 23:00 del dia siguiente.
                </div>
                <div>
                  <label className="text-xs text-gray-500">Fecha del plan</label>
                  <input type="date" value={newPlanDate} onChange={e => setNewPlanDate(e.target.value)}
                    className="w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
              </div>
              <div className="px-6 py-4 border-t flex justify-end gap-2">
                <button onClick={() => setShowNewPlan(false)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancelar</button>
                <button onClick={handleNewPlan} className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700">Crear Plan</button>
              </div>
            </div>
          </div>
        )}

        {/* ── CONFIG MODAL ── */}
        {showConfig && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowConfig(false)}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg" onClick={e => e.stopPropagation()}>
              <div className="px-6 py-4 border-b flex items-center justify-between">
                <h2 className="text-lg font-bold text-gray-800">Configuracion del Planning</h2>
                <button onClick={() => setShowConfig(false)} className="text-gray-400 hover:text-gray-600 text-2xl">&times;</button>
              </div>
              <div className="px-6 py-4 space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <CfgField label="Productividad (kg/h)" value={config.productivity_kg_h} onChange={v => setConfig(p => ({ ...p, productivity_kg_h: v }))} />
                  <CfgField label="Horas Turno" value={config.shift_hours} onChange={v => setConfig(p => ({ ...p, shift_hours: v }))} />
                  <CfgField label="Horas CO antes de ETD" value={config.cutoff_hours} onChange={v => setConfig(p => ({ ...p, cutoff_hours: v }))} />
                  <CfgField label="KG por BUP" value={config.kg_per_bup} onChange={v => setConfig(p => ({ ...p, kg_per_bup: v }))} />
                  <CfgField label="Docs Ready (h antes fin BUP)" value={config.docs_ready_hours_before} onChange={v => setConfig(p => ({ ...p, docs_ready_hours_before: v }))} />
                  <CfgField label="BUP por viaje" value={config.bup_per_trip} onChange={v => setConfig(p => ({ ...p, bup_per_trip: v }))} step={0.5} />
                </div>
                <div className="border-t pt-3">
                  <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Tiempos de traslado (horas por viaje)</div>
                  <div className="grid grid-cols-3 gap-3">
                    <CfgField label="LATAM" value={config.transport_hours.LATAM} onChange={v => setConfig(p => ({ ...p, transport_hours: { ...p.transport_hours, LATAM: v } }))} step={0.5} />
                    <CfgField label="AVIANCA" value={config.transport_hours.AVIANCA} onChange={v => setConfig(p => ({ ...p, transport_hours: { ...p.transport_hours, AVIANCA: v } }))} step={0.5} />
                    <CfgField label="Otras" value={config.transport_hours.default} onChange={v => setConfig(p => ({ ...p, transport_hours: { ...p.transport_hours, default: v } }))} step={0.5} />
                  </div>
                </div>
              </div>
              <div className="px-6 py-4 border-t flex justify-end gap-2">
                <button onClick={() => setShowConfig(false)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cerrar</button>
                <button onClick={() => setShowConfig(false)} className="px-4 py-2 text-sm bg-blue-700 text-white rounded-lg hover:bg-blue-800">Guardar</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </Layout>
  )
}

/* ═══ SUB-COMPONENTS ═══ */
function KpiCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-white rounded-xl border px-4 py-3 text-center">
      <div className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">{label}</div>
      <div className={`text-2xl font-extrabold ${color || 'text-gray-800'}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-400">{sub}</div>}
    </div>
  )
}

function CfgField({ label, value, onChange, step }: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <div>
      <label className="text-xs text-gray-500">{label}</label>
      <input type="number" value={value} step={step || 1} onChange={e => onChange(parseFloat(e.target.value) || 0)}
        className="w-full border rounded-lg px-3 py-2 text-sm" />
    </div>
  )
}
