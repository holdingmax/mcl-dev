import { useState, useEffect, useMemo } from 'react'
import {
  collection,
  getDocs,
  query,
  orderBy,
  limit,
} from 'firebase/firestore'
import { db } from '../../lib/firebase'
import Layout from '../../components/Layout'
import { fmtUSD } from '../../lib/utils'
import type { AirBillingCharge, AirfreightFlight } from '../../types'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, PieChart, Pie, Cell,
} from 'recharts'
import { getISOWeek, getISOWeekYear, getYear, getMonth, startOfISOWeek, format } from 'date-fns'
import { es } from 'date-fns/locale'

/* ═══════════════════════════════════════════════════════════════
   PALETTE & HELPERS
   ═══════════════════════════════════════════════════════════════ */

const PALETTE = [
  '#1e3a5f', '#ea580c', '#16a34a', '#9333ea',
  '#dc2626', '#0891b2', '#ca8a04', '#6366f1',
  '#be185d', '#059669', '#d97706', '#4f46e5',
]

/* ── airline normalization ─────────────────────────────────── */
function normalizeAirline(raw: string | undefined | null): string {
  const upper = (raw || '').toUpperCase().trim()
  if (!upper) return '(SIN AEROLINEA)'
  if (upper.includes('AVIANCA')) return 'AVIANCA'
  if (upper.includes('LATAM')) return 'LATAM'
  if (upper.includes('ELC') || upper.includes('9950 NW')) return 'LOOSE CARGO'
  return raw!.trim()
}

/* ── period helpers ────────────────────────────────────────── */
type PeriodMode = 'day' | 'week' | 'month'

function dy(dateStr: string) {
  try {
    const d = new Date(dateStr)
    if (isNaN(d.getTime())) return 'unknown'
    return d.toLocaleDateString('en-CA') // YYYY-MM-DD
  } catch { return 'unknown' }
}

function wk(dateStr: string) {
  try {
    const d = new Date(dateStr)
    if (isNaN(d.getTime())) return 'unknown'
    return `${getISOWeekYear(d)}-W${String(getISOWeek(d)).padStart(2, '0')}`
  } catch { return 'unknown' }
}

function mo(dateStr: string) {
  try {
    const d = new Date(dateStr)
    if (isNaN(d.getTime())) return 'unknown'
    return `${getYear(d)}-${String(getMonth(d) + 1).padStart(2, '0')}`
  } catch { return 'unknown' }
}

function periodKey(dateStr: string, mode: PeriodMode) {
  if (mode === 'day') return dy(dateStr)
  if (mode === 'week') return wk(dateStr)
  return mo(dateStr)
}

function periodLabel(key: string, mode: PeriodMode) {
  if (key === 'unknown') return 'Sin fecha'
  try {
    if (mode === 'day') {
      const d = new Date(key + 'T12:00:00')
      if (isNaN(d.getTime())) return key
      return format(d, 'EEE d MMM', { locale: es })
    }
    if (mode === 'month') {
      const [y, m] = key.split('-').map(Number)
      if (isNaN(y) || isNaN(m)) return key
      return format(new Date(y, m - 1, 1), 'MMM yyyy', { locale: es })
    }
    const [yearStr, wStr] = key.split('-W')
    const year = Number(yearStr)
    const week = Number(wStr)
    if (isNaN(year) || isNaN(week)) return key
    const jan4 = new Date(year, 0, 4)
    const sow = startOfISOWeek(jan4)
    const monday = new Date(sow.getTime() + (week - 1) * 7 * 86400000)
    return `S${week} ${format(monday, 'd MMM', { locale: es })}`
  } catch { return key }
}

function pctDelta(a: number, b: number): number | null {
  if (b === 0) return null
  return ((a - b) / b) * 100
}

function fmtKg(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

function isKgUnit(unit: string | undefined | null) {
  return (unit || '').toUpperCase().includes('KG')
}

function shortLabel(name: string, max = 16) {
  return name.length > max ? name.substring(0, max - 1) + '\u2026' : name
}

function toDateStr(d: Date) {
  return d.toLocaleDateString('en-CA')
}

/* Safely convert a value that might be a Firestore Timestamp to ISO string */
function safeDate(v: any): string {
  if (!v) return ''
  if (typeof v === 'string') return v
  if (v.toDate) return v.toDate().toISOString()
  if (typeof v === 'number') return new Date(v).toISOString()
  return String(v)
}

/* Resolve the ETD (flight_datetime) for a charge using the flight map.
   Falls back to dispatched_at → created_at if flight not found. */
function resolveEtd(c: AirBillingCharge, flightMap: Map<string, string>): string {
  return flightMap.get(c.flight_id) || safeDate(c.dispatched_at) || safeDate(c.created_at)
}

/* ═══════════════════════════════════════════════════════════════
   MAIN COMPONENT
   ═══════════════════════════════════════════════════════════════ */

export default function AirfreightBillingSummary() {
  /* ── state ──────────────────────────────────────────────────── */
  const [charges, setCharges] = useState<AirBillingCharge[]>([])
  const [flightDateMap, setFlightDateMap] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<PeriodMode>('month')

  // Date range defaults: Jan 1 current year → today
  const [dateFrom, setDateFrom] = useState(() => `${new Date().getFullYear()}-01-01`)
  const [dateTo, setDateTo] = useState(() => toDateStr(new Date()))

  const [selClient, setSelClient] = useState('')
  const [selAirline, setSelAirline] = useState('')

  /* ── load charges + flights (independent, so one failing doesn't block the other) */
  useEffect(() => {
    let dead = false
    ;(async () => {
      try {
        const chargeSnap = await getDocs(
          query(collection(db, 'air_billing_charges'), orderBy('created_at', 'desc'), limit(3000)),
        )
        if (!dead)
          setCharges(chargeSnap.docs.map(d => ({ id: d.id, ...d.data() } as AirBillingCharge)))
      } catch (e) {
        console.error('Error loading air_billing_charges', e)
      }

      try {
        const flightSnap = await getDocs(query(collection(db, 'airfreight_flights'), orderBy('flight_datetime', 'desc'), limit(500)))
        if (dead) return
        const fMap = new Map<string, string>()
        for (const d of flightSnap.docs) {
          try {
            const raw = d.data().flight_datetime
            if (!raw) continue
            const dt = safeDate(raw)
            if (dt) fMap.set(d.id, dt)
          } catch { /* skip bad flight */ }
        }
        setFlightDateMap(fMap)
      } catch (e) {
        console.error('Error loading airfreight_flights', e)
      }

      if (!dead) setLoading(false)
    })()
    return () => { dead = true }
  }, [])

  /* ── filter: date range (ETD) + client + normalized airline, exclude voided */
  const filtered = useMemo(() => {
    return charges.filter(c => {
      if (c.status === 'voided') return false
      const etd = resolveEtd(c, flightDateMap)
      if (!etd) return false
      const dateOnly = etd.slice(0, 10)
      if (dateFrom && dateOnly < dateFrom) return false
      if (dateTo && dateOnly > dateTo) return false
      if (selClient && c.client_name !== selClient) return false
      if (selAirline && normalizeAirline(c.airline) !== selAirline) return false
      return true
    })
  }, [charges, flightDateMap, dateFrom, dateTo, selClient, selAirline])

  /* ── dropdown options ───────────────────────────────────────── */
  const clients = useMemo(
    () => [...new Set(charges.map(c => c.client_name).filter(Boolean))].sort(),
    [charges],
  )
  const normalizedAirlines = useMemo(
    () => [...new Set(charges.map(c => normalizeAirline(c.airline)).filter(a => a !== '(SIN AEROLINEA)'))].sort(),
    [charges],
  )

  /* auto-set dateFrom to earliest ETD on first load */
  const [dateAutoSet, setDateAutoSet] = useState(false)
  useEffect(() => {
    if (dateAutoSet || charges.length === 0 || flightDateMap.size === 0) return
    let min = ''
    for (const c of charges) {
      const etd = resolveEtd(c, flightDateMap)
      if (etd) {
        const d = etd.slice(0, 10)
        if (!min || d < min) min = d
      }
    }
    if (min) {
      setDateFrom(min)
      setDateAutoSet(true)
    }
  }, [charges, flightDateMap, dateAutoSet])

  /* ── top charge names (categories for charts) ───────────────── */
  const chargeNameMap = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of filtered) m.set(c.charge_name, (m.get(c.charge_name) || 0) + (c.total ?? 0))
    const sorted = [...m.entries()].sort((a, b) => b[1] - a[1])
    const top = sorted.slice(0, 7).map(([name]) => name)
    return { top, all: sorted }
  }, [filtered])

  function chargeCategory(name: string) {
    return chargeNameMap.top.includes(name) ? name : 'OTROS'
  }

  const allCategories = useMemo(
    () => [...chargeNameMap.top, ...(chargeNameMap.all.length > chargeNameMap.top.length ? ['OTROS'] : [])],
    [chargeNameMap],
  )

  const catColors = useMemo(() => {
    const m: Record<string, string> = {}
    chargeNameMap.top.forEach((name, i) => { m[name] = PALETTE[i % PALETTE.length] })
    m['OTROS'] = '#9ca3af'
    return m
  }, [chargeNameMap.top])

  /* ── distinct KG per AWB (chargeable_weight counted once per billing_unit_id) */
  const distinctKgMap = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of filtered) {
      if (!m.has(c.billing_unit_id)) m.set(c.billing_unit_id, c.chargeable_weight ?? 0)
    }
    return m
  }, [filtered])
  const totalDistinctKg = useMemo(() => {
    let s = 0
    for (const v of distinctKgMap.values()) s += v
    return s
  }, [distinctKgMap])

  /* ── KPIs ───────────────────────────────────────────────────── */
  const totalRevenue = useMemo(() => filtered.reduce((s, c) => s + (c.total ?? 0), 0), [filtered])
  const totalKg = totalDistinctKg
  const totalAwbs = useMemo(() => new Set(filtered.map(c => c.billing_unit_id)).size, [filtered])
  const totalFlights = useMemo(() => new Set(filtered.map(c => c.flight_id)).size, [filtered])

  /* ── period buckets ─────────────────────────────────────────── */
  const periodBuckets = useMemo(() => {
    const map = new Map<string, {
      revenue: number
      awbKg: Map<string, number>
      awbs: Set<string>; flights: Set<string>
      byCharge: Map<string, number>
    }>()

    for (const c of filtered) {
      const etd = resolveEtd(c, flightDateMap)
      const key = periodKey(etd, mode)
      if (key === 'unknown') continue
      if (!map.has(key))
        map.set(key, { revenue: 0, awbKg: new Map(), awbs: new Set(), flights: new Set(), byCharge: new Map() })
      const b = map.get(key)!
      b.revenue += c.total ?? 0
      if (!b.awbKg.has(c.billing_unit_id)) b.awbKg.set(c.billing_unit_id, c.chargeable_weight ?? 0)
      b.awbs.add(c.billing_unit_id)
      b.flights.add(c.flight_id)
      const cat = chargeCategory(c.charge_name)
      b.byCharge.set(cat, (b.byCharge.get(cat) || 0) + (c.total ?? 0))
    }

    return [...map.entries()]
      .map(([key, b]) => {
        let kg = 0; for (const v of b.awbKg.values()) kg += v
        return {
          key,
          label: periodLabel(key, mode),
          revenue: b.revenue,
          kg,
          awbs: b.awbs.size,
          flights: b.flights.size,
          ...Object.fromEntries(allCategories.map(n => [n, b.byCharge.get(n) || 0])),
        }
      })
      .sort((a, b) => a.key.localeCompare(b.key))
  }, [filtered, mode, allCategories, flightDateMap])

  /* KPI deltas: last complete period vs previous */
  const kpiDelta = useMemo(() => {
    if (periodBuckets.length < 2) return { revenue: null, kg: null, awbs: null, flights: null }
    const curr = periodBuckets[periodBuckets.length - 1]
    const prev = periodBuckets[periodBuckets.length - 2]
    return {
      revenue: pctDelta(curr.revenue, prev.revenue),
      kg: pctDelta(curr.kg, prev.kg),
      awbs: pctDelta(curr.awbs, prev.awbs),
      flights: pctDelta(curr.flights, prev.flights),
    }
  }, [periodBuckets])

  /* ── charge composition (donut) ─────────────────────────────── */
  const chargeComposition = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of filtered) {
      const cat = chargeCategory(c.charge_name)
      m.set(cat, (m.get(cat) || 0) + (c.total ?? 0))
    }
    return [...m.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
  }, [filtered, chargeNameMap.top])

  /* ── BUP vs LOOSE (distinct KG per AWB) ─────────────────────── */
  const bupLoose = useMemo(() => {
    const r = {
      BUP: { revenue: 0, awbKg: new Map<string, number>() },
      LOOSE: { revenue: 0, awbKg: new Map<string, number>() },
    }
    for (const c of filtered) {
      const t = c.cargo_type === 'BUP' ? 'BUP' : 'LOOSE'
      r[t].revenue += c.total ?? 0
      if (!r[t].awbKg.has(c.billing_unit_id)) r[t].awbKg.set(c.billing_unit_id, c.chargeable_weight ?? 0)
    }
    const bupKg = [...r.BUP.awbKg.values()].reduce((s, v) => s + v, 0)
    const looseKg = [...r.LOOSE.awbKg.values()].reduce((s, v) => s + v, 0)
    return [
      { name: 'BUP', revenue: r.BUP.revenue, kg: bupKg },
      { name: 'LOOSE', revenue: r.LOOSE.revenue, kg: looseKg },
    ]
  }, [filtered])

  /* ── by airline (normalized, distinct KG per AWB) ────────────── */
  const byAirline = useMemo(() => {
    const m = new Map<string, { revenue: number; awbKg: Map<string, number> }>()
    for (const c of filtered) {
      const a = normalizeAirline(c.airline)
      if (!m.has(a)) m.set(a, { revenue: 0, awbKg: new Map() })
      const row = m.get(a)!
      row.revenue += c.total ?? 0
      if (!row.awbKg.has(c.billing_unit_id)) row.awbKg.set(c.billing_unit_id, c.chargeable_weight ?? 0)
    }
    return [...m.entries()]
      .map(([name, v]) => {
        let kg = 0; for (const k of v.awbKg.values()) kg += k
        return { name, revenue: v.revenue, kg }
      })
      .sort((a, b) => b.revenue - a.revenue)
  }, [filtered])

  /* ── by client (table: Revenue, %, KG distinct, %, $/KG) ───── */
  const byClientTable = useMemo(() => {
    const m = new Map<string, { revenue: number; awbKg: Map<string, number> }>()
    for (const c of filtered) {
      const cl = c.client_name || '(unknown)'
      if (!m.has(cl)) m.set(cl, { revenue: 0, awbKg: new Map() })
      const row = m.get(cl)!
      row.revenue += c.total ?? 0
      if (!row.awbKg.has(c.billing_unit_id)) row.awbKg.set(c.billing_unit_id, c.chargeable_weight ?? 0)
    }
    return [...m.entries()]
      .map(([name, v]) => {
        let kg = 0; for (const k of v.awbKg.values()) kg += k
        return { name, revenue: v.revenue, kg }
      })
      .sort((a, b) => b.revenue - a.revenue)
  }, [filtered])

  /* ── by client (stacked bar by charge) ──────────────────────── */
  const byClientChart = useMemo(() => {
    const m = new Map<string, Map<string, number>>()
    for (const c of filtered) {
      const cl = c.client_name || '(unknown)'
      if (!m.has(cl)) m.set(cl, new Map())
      const cat = chargeCategory(c.charge_name)
      const cm = m.get(cl)!
      cm.set(cat, (cm.get(cat) || 0) + (c.total ?? 0))
    }
    return [...m.entries()]
      .map(([name, cm]) => ({
        name,
        total: [...cm.values()].reduce((s, v) => s + v, 0),
        ...Object.fromEntries(allCategories.map(n => [n, cm.get(n) || 0])),
      }))
      .sort((a, b) => b.total - a.total)
  }, [filtered, allCategories])

  /* ── charge detail table ────────────────────────────────────── */
  const chargeDetail = useMemo(() => {
    const m = new Map<string, { revenue: number; kg: number; count: number; rates: number[] }>()
    for (const c of filtered) {
      if (!m.has(c.charge_name)) m.set(c.charge_name, { revenue: 0, kg: 0, count: 0, rates: [] })
      const row = m.get(c.charge_name)!
      row.revenue += c.total ?? 0
      if (isKgUnit(c.unit)) row.kg += c.qty ?? 0
      row.count += 1
      if (c.rate) row.rates.push(c.rate)
    }
    const tot = [...m.values()].reduce((s, r) => s + r.revenue, 0)
    return [...m.entries()]
      .map(([name, r]) => ({
        name,
        revenue: r.revenue,
        pct: tot > 0 ? (r.revenue / tot) * 100 : 0,
        kg: r.kg,
        avgRate: r.rates.length > 0 ? r.rates.reduce((a, b) => a + b, 0) / r.rates.length : 0,
        count: r.count,
      }))
      .sort((a, b) => b.revenue - a.revenue)
  }, [filtered])

  /* ── trend data (last N periods for chart) ──────────────────── */
  const trendData = periodBuckets.slice(mode === 'day' ? -30 : -13)

  /* ═══════════════════════════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════════════════════════ */

  if (loading) {
    return (
      <Layout title="Análisis de Ingresos" backTo="/airfreight/admin">
        <div className="flex items-center justify-center py-32">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" />
        </div>
      </Layout>
    )
  }

  const periodLbl = mode === 'day' ? 'día ant.' : mode === 'week' ? 'semana ant.' : 'mes ant.'

  return (
    <Layout title="Análisis de Ingresos Airfreight" backTo="/airfreight/admin">
      <div className="space-y-6">

        {/* ─── Controls ──────────────────────────────────────── */}
        <div className="flex flex-wrap items-end gap-3">
          {/* Day/Week/Month toggle */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Periodo</label>
            <div className="flex rounded-lg overflow-hidden border border-gray-200 h-9">
              <button
                onClick={() => setMode('month')}
                className={`px-4 text-sm font-semibold transition-colors ${mode === 'month' ? 'bg-mcl-blue text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
              >
                Mensual
              </button>
              <button
                onClick={() => setMode('week')}
                className={`px-4 text-sm font-semibold border-l border-gray-200 transition-colors ${mode === 'week' ? 'bg-mcl-blue text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
              >
                Semanal
              </button>
              <button
                onClick={() => setMode('day')}
                className={`px-4 text-sm font-semibold border-l border-gray-200 transition-colors ${mode === 'day' ? 'bg-mcl-blue text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
              >
                Diario
              </button>
            </div>
          </div>

          {/* Date range */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Desde</label>
            <input
              type="date"
              value={dateFrom}
              onChange={e => setDateFrom(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 h-9 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Hasta</label>
            <input
              type="date"
              value={dateTo}
              onChange={e => setDateTo(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 h-9 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
            />
          </div>

          {/* Client */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Cliente</label>
            <select
              value={selClient}
              onChange={e => setSelClient(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 h-9 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
            >
              <option value="">Todos</option>
              {clients.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          {/* Airline (normalized) */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Aerolínea</label>
            <select
              value={selAirline}
              onChange={e => setSelAirline(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 h-9 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
            >
              <option value="">Todas</option>
              {normalizedAirlines.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>

          {/* Clear */}
          {(dateFrom !== `${new Date().getFullYear()}-01-01` || dateTo !== toDateStr(new Date()) || selClient || selAirline) && (
            <button
              onClick={() => {
                setDateFrom(`${new Date().getFullYear()}-01-01`)
                setDateTo(toDateStr(new Date()))
                setSelClient('')
                setSelAirline('')
              }}
              className="text-xs text-blue-600 hover:underline pb-2"
            >
              Limpiar filtros
            </button>
          )}
        </div>

        {/* ─── KPI Cards ─────────────────────────────────────── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard label="Revenue Total" value={fmtUSD(totalRevenue)} d={kpiDelta.revenue} vs={periodLbl} />
          <KpiCard label="KG Procesados" value={fmtKg(totalKg)} d={kpiDelta.kg} vs={periodLbl} />
          <KpiCard label="AWBs Despachados" value={String(totalAwbs)} d={kpiDelta.awbs} vs={periodLbl} />
          <KpiCard label="Vuelos" value={String(totalFlights)} d={kpiDelta.flights} vs={periodLbl} />
        </div>

        {filtered.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-10 text-center text-gray-400">
            No hay cargos registrados para el periodo seleccionado.
          </div>
        ) : (
          <>
            {/* ─── Trend chart ─────────────────────────────── */}
            <section className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
              <div className="flex items-baseline justify-between mb-3">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  {mode === 'day' ? 'KG Procesados por Día' : 'Tendencia de Ingresos por Tipo de Cargo'}
                </p>
                <span className="text-xs text-gray-400">{periodBuckets.length} {mode === 'day' ? 'días' : mode === 'week' ? 'semanas' : 'meses'}</span>
              </div>
              <ResponsiveContainer key={`trend-${mode}`} width="100%" height={mode === 'day' ? 320 : 280}>
                <BarChart data={trendData} margin={{ top: 4, right: 8, left: 0, bottom: 48 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: mode === 'day' ? 9 : 11, fill: '#6b7280' }}
                    angle={-45}
                    textAnchor="end"
                    interval={0}
                  />
                  {mode === 'day' ? (
                    <>
                      <YAxis
                        tick={{ fontSize: 11, fill: '#6b7280' }}
                        tickFormatter={v => fmtKg(v)}
                        width={55}
                      />
                      <Tooltip
                        formatter={(value: number) => [`${fmtKg(value)} KG`]}
                        contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
                      />
                      <Bar dataKey="kg" name="KG" fill="#1e3a5f" radius={[3, 3, 0, 0]} />
                    </>
                  ) : (
                    <>
                      <YAxis
                        tick={{ fontSize: 11, fill: '#6b7280' }}
                        tickFormatter={v => v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v}`}
                        width={55}
                      />
                      <Tooltip
                        formatter={(value: number) => [fmtUSD(value)]}
                        contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
                      />
                      <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
                      {allCategories.map((cat, i) => (
                        <Bar
                          key={cat}
                          dataKey={cat}
                          stackId="a"
                          fill={catColors[cat] || PALETTE[i % PALETTE.length]}
                          radius={i === allCategories.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]}
                        />
                      ))}
                    </>
                  )}
                </BarChart>
              </ResponsiveContainer>
            </section>

            {/* ─── Dual: Composición + BUP/LOOSE ─────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Donut: composición del ingreso */}
              <section className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                  Composición del Ingreso
                </p>
                <div className="flex items-center gap-4">
                  <ResponsiveContainer width="50%" height={210}>
                    <PieChart>
                      <Pie
                        data={chargeComposition}
                        innerRadius={50}
                        outerRadius={88}
                        dataKey="value"
                        nameKey="name"
                        paddingAngle={2}
                      >
                        {chargeComposition.map((entry, i) => (
                          <Cell key={entry.name} fill={catColors[entry.name] || PALETTE[i % PALETTE.length]} />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(value: number) => [fmtUSD(value)]}
                        contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="flex-1 space-y-1.5 overflow-hidden">
                    {chargeComposition.map((entry, i) => {
                      const p = totalRevenue > 0 ? (entry.value / totalRevenue) * 100 : 0
                      return (
                        <div key={entry.name} className="flex items-center gap-2 text-xs">
                          <div
                            className="w-3 h-3 rounded-sm flex-shrink-0"
                            style={{ backgroundColor: catColors[entry.name] || PALETTE[i % PALETTE.length] }}
                          />
                          <span className="text-gray-600 truncate flex-1" title={entry.name}>{entry.name}</span>
                          <span className="font-semibold text-gray-800 tabular-nums flex-shrink-0">
                            {p.toFixed(1)}%
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </section>

              {/* BUP vs LOOSE */}
              <section className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                  BUP vs LOOSE
                </p>
                <div className="grid grid-cols-2 gap-4 mb-3">
                  {bupLoose.map(item => {
                    const revPct = totalRevenue > 0 ? (item.revenue / totalRevenue) * 100 : 0
                    const kgPct = totalKg > 0 ? (item.kg / totalKg) * 100 : 0
                    return (
                      <div key={item.name} className="text-center">
                        <p className="text-lg font-bold text-gray-900">{item.name}</p>
                        <p className="text-sm text-gray-600 mt-1">{fmtUSD(item.revenue)} <span className="text-xs text-gray-400">({revPct.toFixed(1)}%)</span></p>
                        <p className="text-xs text-gray-500">{fmtKg(item.kg)} KG <span className="text-gray-400">({kgPct.toFixed(1)}%)</span></p>
                      </div>
                    )
                  })}
                </div>
                <ResponsiveContainer width="100%" height={140}>
                  <BarChart data={bupLoose} margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                    <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#374151' }} />
                    <YAxis
                      tick={{ fontSize: 11, fill: '#6b7280' }}
                      tickFormatter={v => v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v}`}
                    />
                    <Tooltip
                      formatter={(value: number) => [fmtUSD(value)]}
                      contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
                    />
                    <Bar dataKey="revenue" name="Revenue" fill="#1e3a5f" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </section>
            </div>

            {/* ─── Revenue por Aerolínea ──────────────────────── */}
            <section className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                Revenue y KG por Aerolínea
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-100">
                    <tr>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-600 uppercase">Aerolínea</th>
                      <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-600 uppercase">Revenue</th>
                      <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-600 uppercase">% Ingreso</th>
                      <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-600 uppercase">KG</th>
                      <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-600 uppercase">% KG</th>
                      <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-600 uppercase">$/KG Prom.</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {byAirline.map(row => {
                      const revPct = totalRevenue > 0 ? (row.revenue / totalRevenue) * 100 : 0
                      const kgPct = totalKg > 0 ? (row.kg / totalKg) * 100 : 0
                      const perKg = row.kg > 0 ? row.revenue / row.kg : 0
                      return (
                        <tr key={row.name} className="hover:bg-gray-50 transition-colors">
                          <td className="px-4 py-2.5 font-medium text-gray-800">{row.name}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{fmtUSD(row.revenue)}</td>
                          <td className="px-4 py-2.5 text-right"><PctBar pct={revPct} /></td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-gray-600">{fmtKg(row.kg)}</td>
                          <td className="px-4 py-2.5 text-right"><PctBar pct={kgPct} color="#ea580c" /></td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-gray-600">${perKg.toFixed(4)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot className="bg-gray-50 border-t-2 border-gray-200">
                    <tr>
                      <td className="px-4 py-2.5 text-xs font-bold text-gray-600 uppercase">Total</td>
                      <td className="px-4 py-2.5 text-right font-bold text-mcl-blue tabular-nums">{fmtUSD(totalRevenue)}</td>
                      <td className="px-4 py-2.5 text-right text-xs font-bold text-gray-500">100%</td>
                      <td className="px-4 py-2.5 text-right font-bold text-gray-700 tabular-nums">{fmtKg(totalKg)}</td>
                      <td className="px-4 py-2.5 text-right text-xs font-bold text-gray-500">100%</td>
                      <td className="px-4 py-2.5 text-right font-bold text-gray-700 tabular-nums">
                        ${totalKg > 0 ? (totalRevenue / totalKg).toFixed(4) : '0.0000'}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>

            {/* ─── Revenue por Cliente (tabla) ────────────────── */}
            <section className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                Revenue y KG por Cliente
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-100">
                    <tr>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-600 uppercase">Cliente</th>
                      <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-600 uppercase">Revenue</th>
                      <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-600 uppercase">% Ingreso</th>
                      <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-600 uppercase">KG</th>
                      <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-600 uppercase">% KG</th>
                      <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-600 uppercase">$/KG Prom.</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {byClientTable.map(row => {
                      const revPct = totalRevenue > 0 ? (row.revenue / totalRevenue) * 100 : 0
                      const kgPct = totalKg > 0 ? (row.kg / totalKg) * 100 : 0
                      const perKg = row.kg > 0 ? row.revenue / row.kg : 0
                      return (
                        <tr key={row.name} className="hover:bg-gray-50 transition-colors">
                          <td className="px-4 py-2.5 font-medium text-gray-800">{row.name}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{fmtUSD(row.revenue)}</td>
                          <td className="px-4 py-2.5 text-right"><PctBar pct={revPct} /></td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-gray-600">{fmtKg(row.kg)}</td>
                          <td className="px-4 py-2.5 text-right"><PctBar pct={kgPct} color="#ea580c" /></td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-gray-600">${perKg.toFixed(4)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot className="bg-gray-50 border-t-2 border-gray-200">
                    <tr>
                      <td className="px-4 py-2.5 text-xs font-bold text-gray-600 uppercase">Total</td>
                      <td className="px-4 py-2.5 text-right font-bold text-mcl-blue tabular-nums">{fmtUSD(totalRevenue)}</td>
                      <td className="px-4 py-2.5 text-right text-xs font-bold text-gray-500">100%</td>
                      <td className="px-4 py-2.5 text-right font-bold text-gray-700 tabular-nums">{fmtKg(totalKg)}</td>
                      <td className="px-4 py-2.5 text-right text-xs font-bold text-gray-500">100%</td>
                      <td className="px-4 py-2.5 text-right font-bold text-gray-700 tabular-nums">
                        ${totalKg > 0 ? (totalRevenue / totalKg).toFixed(4) : '0.0000'}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>

            {/* ─── Revenue por Cliente × Tipo de Cargo (chart) ── */}
            {!selClient && byClientChart.length > 0 && (
              <section className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                  Revenue por Cliente (desglose por cargo)
                </p>
                <ResponsiveContainer width="100%" height={Math.max(120, byClientChart.length * 45 + 40)}>
                  <BarChart data={byClientChart} layout="vertical" margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                    <XAxis
                      type="number"
                      tick={{ fontSize: 11, fill: '#6b7280' }}
                      tickFormatter={v => v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v}`}
                    />
                    <YAxis
                      type="category"
                      dataKey="name"
                      tick={{ fontSize: 11, fill: '#374151' }}
                      width={130}
                    />
                    <Tooltip
                      formatter={(value: number) => [fmtUSD(value)]}
                      contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    {allCategories.map((cat, i) => (
                      <Bar
                        key={cat}
                        dataKey={cat}
                        stackId="a"
                        fill={catColors[cat] || PALETTE[i % PALETTE.length]}
                        radius={i === allCategories.length - 1 ? [0, 3, 3, 0] : [0, 0, 0, 0]}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </section>
            )}

            {/* ─── Detalle por Periodo (tabla) ────────────────── */}
            <section className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="flex items-baseline justify-between px-4 pt-4 mb-2">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Detalle por Periodo ({mode === 'day' ? 'Diario' : mode === 'week' ? 'Semanal' : 'Mensual'})
                </p>
                <span className="text-xs text-gray-400">{periodBuckets.length} {mode === 'day' ? 'días' : mode === 'week' ? 'semanas' : 'meses'}</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-100">
                    <tr>
                      <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase sticky left-0 bg-gray-50">
                        Periodo
                      </th>
                      {chargeNameMap.top.map((name, i) => (
                        <th
                          key={name}
                          className="text-right px-3 py-3 font-semibold text-xs uppercase whitespace-nowrap"
                          style={{ color: PALETTE[i] }}
                          title={name}
                        >
                          {shortLabel(name)}
                        </th>
                      ))}
                      {chargeNameMap.all.length > chargeNameMap.top.length && (
                        <th className="text-right px-3 py-3 font-semibold text-gray-400 text-xs uppercase">
                          Otros
                        </th>
                      )}
                      <th className="text-right px-4 py-3 font-semibold text-gray-600 text-xs uppercase">Total</th>
                      <th className="text-center px-3 py-3 font-semibold text-gray-400 text-xs uppercase">KG</th>
                      <th className="text-center px-3 py-3 font-semibold text-gray-400 text-xs uppercase">AWBs</th>
                      <th className="text-center px-3 py-3 font-semibold text-gray-400 text-xs uppercase">Vuelos</th>
                      <th className="text-right px-3 py-3 font-semibold text-gray-400 text-xs uppercase">&Delta;</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {periodBuckets.map((b, idx) => {
                      const prev = idx > 0 ? periodBuckets[idx - 1] : null
                      const d = prev ? pctDelta(b.revenue, prev.revenue) : null
                      return (
                        <tr key={b.key} className="hover:bg-gray-50 transition-colors">
                          <td className="px-4 py-2.5 text-gray-700 font-medium whitespace-nowrap sticky left-0 bg-white">
                            {b.label}
                          </td>
                          {chargeNameMap.top.map(name => (
                            <td key={name} className="px-3 py-2.5 text-right font-mono text-xs text-gray-600">
                              {(b as any)[name] > 0 ? fmtUSD((b as any)[name]) : '\u2014'}
                            </td>
                          ))}
                          {chargeNameMap.all.length > chargeNameMap.top.length && (
                            <td className="px-3 py-2.5 text-right font-mono text-xs text-gray-400">
                              {(b as any)['OTROS'] > 0 ? fmtUSD((b as any)['OTROS']) : '\u2014'}
                            </td>
                          )}
                          <td className="px-4 py-2.5 text-right font-bold text-gray-800">{fmtUSD(b.revenue)}</td>
                          <td className="px-3 py-2.5 text-center text-gray-500 text-xs tabular-nums">{fmtKg(b.kg)}</td>
                          <td className="px-3 py-2.5 text-center text-gray-500">{b.awbs}</td>
                          <td className="px-3 py-2.5 text-center text-gray-500">{b.flights}</td>
                          <td className="px-3 py-2.5 text-right text-xs font-medium">
                            {d !== null ? (
                              <span className={d >= 0 ? 'text-green-600' : 'text-red-500'}>
                                {d >= 0 ? '\u2191' : '\u2193'}{Math.abs(d).toFixed(1)}%
                              </span>
                            ) : '\u2014'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot className="bg-gray-50 border-t-2 border-gray-200">
                    <tr>
                      <td className="px-4 py-3 text-xs font-bold text-gray-600 uppercase sticky left-0 bg-gray-50">
                        Total
                      </td>
                      {chargeNameMap.top.map(name => {
                        const t = periodBuckets.reduce((s, b) => s + ((b as any)[name] || 0), 0)
                        return (
                          <td key={name} className="px-3 py-3 text-right font-mono text-xs font-bold text-gray-700">
                            {fmtUSD(t)}
                          </td>
                        )
                      })}
                      {chargeNameMap.all.length > chargeNameMap.top.length && (
                        <td className="px-3 py-3 text-right font-mono text-xs font-bold text-gray-400">
                          {fmtUSD(periodBuckets.reduce((s, b) => s + ((b as any)['OTROS'] || 0), 0))}
                        </td>
                      )}
                      <td className="px-4 py-3 text-right font-bold text-mcl-blue">{fmtUSD(totalRevenue)}</td>
                      <td className="px-3 py-3 text-center font-bold text-gray-600 text-xs">{fmtKg(totalKg)}</td>
                      <td className="px-3 py-3 text-center font-bold text-gray-600">{totalAwbs}</td>
                      <td className="px-3 py-3 text-center font-bold text-gray-600">{totalFlights}</td>
                      <td className="px-3 py-3" />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>

            {/* ─── Desglose por Tipo de Cargo (tabla) ─────────── */}
            <section className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 pt-4 mb-2">
                Desglose por Tipo de Cargo
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-100">
                    <tr>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Cargo</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Revenue</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-gray-600 uppercase">% Ingreso</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-gray-600 uppercase">KG</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Rate Prom.</th>
                      <th className="text-center px-4 py-3 text-xs font-semibold text-gray-600 uppercase"># Trans.</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {chargeDetail.map(row => (
                      <tr key={row.name} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-2.5 text-gray-800 font-medium">{row.name}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{fmtUSD(row.revenue)}</td>
                        <td className="px-4 py-2.5 text-right"><PctBar pct={row.pct} /></td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-gray-600">
                          {row.kg > 0 ? fmtKg(row.kg) : '\u2014'}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-gray-600">
                          {row.avgRate > 0 ? `$${row.avgRate.toFixed(4)}` : '\u2014'}
                        </td>
                        <td className="px-4 py-2.5 text-center text-gray-500">{row.count}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-gray-50 border-t-2 border-gray-200">
                    <tr>
                      <td className="px-4 py-2.5 text-xs font-bold text-gray-600 uppercase">Total</td>
                      <td className="px-4 py-2.5 text-right font-bold text-mcl-blue tabular-nums">
                        {fmtUSD(chargeDetail.reduce((s, r) => s + r.revenue, 0))}
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs font-bold text-gray-500">100%</td>
                      <td className="px-4 py-2.5 text-right font-bold text-gray-700 tabular-nums">
                        {fmtKg(chargeDetail.reduce((s, r) => s + r.kg, 0))}
                      </td>
                      <td className="px-4 py-2.5" />
                      <td className="px-4 py-2.5 text-center font-bold text-gray-600">
                        {chargeDetail.reduce((s, r) => s + r.count, 0)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </Layout>
  )
}

/* ═══════════════════════════════════════════════════════════════
   SUB-COMPONENTS
   ═══════════════════════════════════════════════════════════════ */

function KpiCard({ label, value, d, vs }: { label: string; value: string; d: number | null; vs: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
      <p className="text-2xl font-bold text-gray-900 tabular-nums">{value}</p>
      <p className="text-sm text-gray-500 mt-1">{label}</p>
      {d !== null && (
        <p className={`text-xs mt-1.5 font-medium ${d >= 0 ? 'text-green-600' : 'text-red-500'}`}>
          {d >= 0 ? '\u2191' : '\u2193'} {Math.abs(d).toFixed(1)}% vs {vs}
        </p>
      )}
    </div>
  )
}

function PctBar({ pct, color = '#1e3a5f' }: { pct: number; color?: string }) {
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: color }} />
      </div>
      <span className="text-xs text-gray-600 tabular-nums w-12 text-right">{pct.toFixed(1)}%</span>
    </div>
  )
}
