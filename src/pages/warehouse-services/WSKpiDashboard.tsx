import { useState, useEffect, useMemo } from 'react'
import { collection, getDocs } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import Layout from '../../components/Layout'
import { CONTAINER_SIZES, NAVIERAS } from '../../types'
import { fmtNum } from '../../lib/utils'

// ── Types ─────────────────────────────────────────────────────────────────────

interface FactRow {
  wr_id: string
  wr_number: string
  client_id: string
  client_name: string
  cargo_type: 'BOND' | 'LOC' | ''
  cargo_mode: string
  pieces: number
  weight_kg: number
  cbm: number
  received_at: string | null   // WR created_at
  dispatched_at: string | null // dispatch gate_out_at or dispatch created_at
  days_in_warehouse: number | null
  // Dispatch info
  dispatch_id: string | null
  booking_number: string
  container_size: string
  naviera: string
  container_number: string
  destination: string
  // Billing
  revenue: number
  revenueDrayage: number  // portion of revenue that is drayage
  // SO info
  so_id: string | null
  service_type: string
}

interface Filters {
  clients: string[]
  navieras: string[]
  containerSizes: string[]
  cargoTypes: string[]
  destinations: string[]
  dateFrom: string
  dateTo: string
  periodGroup: 'week' | 'month'
  search: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoWeek(d: Date): string {
  const dt = new Date(d.getTime())
  dt.setHours(0, 0, 0, 0)
  dt.setDate(dt.getDate() + 3 - ((dt.getDay() + 6) % 7))
  const week1 = new Date(dt.getFullYear(), 0, 4)
  const weekNum = 1 + Math.round(((dt.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7)
  return `${dt.getFullYear()}-W${String(weekNum).padStart(2, '0')}`
}

function isoMonth(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function fmtUSD(n: number): string {
  return '$' + fmtNum(n, 2)
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function WSKpiDashboard() {
  const { isAdmin, isAccounting } = useAuth()
  const [loading, setLoading] = useState(true)
  const [factTable, setFactTable] = useState<FactRow[]>([])
  const [filters, setFilters] = useState<Filters>({
    clients: [],
    navieras: [],
    containerSizes: [],
    cargoTypes: [],
    destinations: [],
    dateFrom: '',
    dateTo: '',
    periodGroup: 'week',
    search: '',
  })
  const [activeSection, setActiveSection] = useState<string>('overview')
  const [includeDrayage, setIncludeDrayage] = useState(true)

  // All unique clients for filter dropdown
  const allClients = useMemo(() => {
    const map = new Map<string, string>()
    factTable.forEach(r => { if (r.client_id) map.set(r.client_id, r.client_name) })
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]))
  }, [factTable])

  const allDestinations = useMemo(() => {
    const set = new Set<string>()
    factTable.forEach(r => { if (r.destination) set.add(r.destination) })
    return Array.from(set).sort()
  }, [factTable])

  // ── Data Loading ──────────────────────────────────────────────────────────

  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
    setLoading(true)
    try {
      const [wrSnap, dispSnap, chargeSnap] = await Promise.all([
        getDocs(collection(db, 'warehouse_receipts')),
        getDocs(collection(db, 'dispatches')),
        getDocs(collection(db, 'billing_charges')),
      ])

      // Index WRs
      const wrs = new Map<string, any>()
      wrSnap.docs.forEach(d => {
        const data = { id: d.id, ...d.data() }
        wrs.set(d.id, data)
      })

      // Index dispatches by wr_id
      const dispByWr = new Map<string, any>()
      const dispatches: any[] = []
      dispSnap.docs.forEach(d => {
        const data = { id: d.id, ...d.data() }
        dispatches.push(data)
        ;(data.wr_ids || []).forEach((wrId: string) => {
          if (!dispByWr.has(wrId)) dispByWr.set(wrId, data)
        })
      })

      // Index dispatch wr_ids for distributing dispatch-level charges
      const dispatchWrIds = new Map<string, string[]>()
      dispatches.forEach(d => {
        if (d.id && d.wr_ids?.length) dispatchWrIds.set(d.id, d.wr_ids)
      })

      // Sum charges by wr_id (direct) or distributed from dispatch_id
      // Also track unmatched charges to distribute by client_id
      const revenueByWr = new Map<string, number>()
      const drayageByWr = new Map<string, number>()
      const unmatchedByClient = new Map<string, number>()
      const unmatchedDrayageByClient = new Map<string, number>()
      chargeSnap.docs.forEach(d => {
        const c = d.data()
        if (c.status === 'invalidated' || c.status === 'voided') return
        const amount = c.total || c.amount || 0
        if (amount === 0) return
        const isDrayage = (c.charge_name || '').toLowerCase().startsWith('drayage')
        if (c.wr_id) {
          revenueByWr.set(c.wr_id, (revenueByWr.get(c.wr_id) || 0) + amount)
          if (isDrayage) drayageByWr.set(c.wr_id, (drayageByWr.get(c.wr_id) || 0) + amount)
        } else if (c.dispatch_id) {
          const wrIds = dispatchWrIds.get(c.dispatch_id)
          if (wrIds && wrIds.length > 0) {
            const share = amount / wrIds.length
            wrIds.forEach(wrId => {
              revenueByWr.set(wrId, (revenueByWr.get(wrId) || 0) + share)
              if (isDrayage) drayageByWr.set(wrId, (drayageByWr.get(wrId) || 0) + share)
            })
          } else if (c.client_id) {
            // Dispatch without WR mapping — accumulate by client
            unmatchedByClient.set(c.client_id, (unmatchedByClient.get(c.client_id) || 0) + amount)
            if (isDrayage) unmatchedDrayageByClient.set(c.client_id, (unmatchedDrayageByClient.get(c.client_id) || 0) + amount)
          }
        }
      })

      // Distribute unmatched client revenue across that client's WRs
      if (unmatchedByClient.size > 0) {
        const wrsByClient = new Map<string, string[]>()
        wrs.forEach((wr, wrId) => {
          if (wr.source === 'warehouse_services') return
          const cid = wr.client_id
          if (!cid) return
          if (!wrsByClient.has(cid)) wrsByClient.set(cid, [])
          wrsByClient.get(cid)!.push(wrId)
        })
        unmatchedByClient.forEach((amount, clientId) => {
          const clientWrs = wrsByClient.get(clientId)
          if (clientWrs && clientWrs.length > 0) {
            const share = amount / clientWrs.length
            clientWrs.forEach(wrId => {
              revenueByWr.set(wrId, (revenueByWr.get(wrId) || 0) + share)
            })
          }
        })
        unmatchedDrayageByClient.forEach((amount, clientId) => {
          const clientWrs = wrsByClient.get(clientId)
          if (clientWrs && clientWrs.length > 0) {
            const share = amount / clientWrs.length
            clientWrs.forEach(wrId => {
              drayageByWr.set(wrId, (drayageByWr.get(wrId) || 0) + share)
            })
          }
        })
      }

      // Build fact table from WRs (seafreight only — exclude warehouse_services)
      const facts: FactRow[] = []
      wrs.forEach((wr, wrId) => {
        if (wr.source === 'warehouse_services') return
        const disp = dispByWr.get(wrId)
        const receivedAt = wr.created_at || null
        const dispatchedAt = disp?.gate_out_at || disp?.created_at || null

        let daysInWh: number | null = null
        if (receivedAt && dispatchedAt) {
          const diff = new Date(dispatchedAt).getTime() - new Date(receivedAt).getTime()
          daysInWh = Math.max(0, Math.round(diff / 86400000))
        } else if (receivedAt) {
          const diff = Date.now() - new Date(receivedAt).getTime()
          daysInWh = Math.max(0, Math.round(diff / 86400000))
        }

        facts.push({
          wr_id: wrId,
          wr_number: wr.wr_number || '',
          client_id: wr.client_id || '',
          client_name: wr.client_name || wr.company_name || '',
          cargo_type: wr.cargo_type || '',
          cargo_mode: wr.cargo_type || '',
          pieces: wr.total_qty || wr.declared_pieces || 0,
          weight_kg: wr.total_weight_kg || wr.declared_weight_kg || 0,
          cbm: wr.total_cbm || 0,
          received_at: receivedAt,
          dispatched_at: dispatchedAt,
          days_in_warehouse: daysInWh,
          dispatch_id: disp?.id || null,
          booking_number: disp?.booking_number || '',
          container_size: disp?.container_size || '',
          naviera: disp?.naviera || '',
          container_number: disp?.container_number || '',
          destination: disp?.destinations?.[0] || wr.to_port || '',
          revenue: revenueByWr.get(wrId) || 0,
          revenueDrayage: drayageByWr.get(wrId) || 0,
          so_id: wr.so_id || null,
          service_type: '',
        })
      })

      setFactTable(facts)
    } catch (e: any) {
      console.error('KPI load error:', e.message)
    }
    setLoading(false)
  }

  // Revenue helper: excludes drayage when toggle is off
  const rev = (r: FactRow) => includeDrayage ? r.revenue : r.revenue - r.revenueDrayage

  // ── Filtered Data ─────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    return factTable.filter(r => {
      if (filters.clients.length > 0 && !filters.clients.includes(r.client_id)) return false
      if (filters.navieras.length > 0 && !filters.navieras.includes(r.naviera)) return false
      if (filters.containerSizes.length > 0 && !filters.containerSizes.includes(r.container_size)) return false
      if (filters.cargoTypes.length > 0 && !filters.cargoTypes.includes(r.cargo_type)) return false
      if (filters.destinations.length > 0 && !filters.destinations.includes(r.destination)) return false
      if (filters.dateFrom) {
        const ref = r.received_at || r.dispatched_at
        if (!ref || ref < filters.dateFrom) return false
      }
      if (filters.dateTo) {
        const ref = r.received_at || r.dispatched_at
        if (!ref || ref > filters.dateTo + 'T23:59:59') return false
      }
      if (filters.search) {
        const s = filters.search.toLowerCase()
        if (!r.booking_number.toLowerCase().includes(s) &&
            !r.wr_number.toLowerCase().includes(s) &&
            !r.container_number.toLowerCase().includes(s) &&
            !r.client_name.toLowerCase().includes(s)) return false
      }
      return true
    })
  }, [factTable, filters])

  // ── Derived KPIs ──────────────────────────────────────────────────────────

  const kpis = useMemo(() => {
    const totalKg = filtered.reduce((s, r) => s + r.weight_kg, 0)
    const totalCbm = filtered.reduce((s, r) => s + r.cbm, 0)
    const totalPieces = filtered.reduce((s, r) => s + r.pieces, 0)
    const totalRevenue = filtered.reduce((s, r) => s + rev(r), 0)
    const dispatched = filtered.filter(r => r.dispatch_id)
    const inWarehouse = filtered.filter(r => !r.dispatch_id)
    const daysArr = filtered.filter(r => r.days_in_warehouse !== null).map(r => r.days_in_warehouse!)
    const avgDays = daysArr.length > 0 ? daysArr.reduce((s, d) => s + d, 0) / daysArr.length : 0
    const bondCount = filtered.filter(r => r.cargo_type === 'BOND').length
    const locCount = filtered.filter(r => r.cargo_type === 'LOC').length
    const uniqueContainers = new Set(dispatched.filter(r => r.container_number).map(r => r.container_number)).size
    const uniqueBookings = new Set(dispatched.filter(r => r.booking_number).map(r => r.booking_number)).size
    const uniqueDestinations = new Set(filtered.filter(r => r.destination).map(r => r.destination)).size

    return {
      totalKg, totalCbm, totalPieces, totalRevenue,
      dispatchedCount: dispatched.length,
      inWarehouseCount: inWarehouse.length,
      avgDays,
      bondCount, locCount,
      uniqueContainers, uniqueBookings, uniqueDestinations,
      perKg: totalKg > 0 ? totalRevenue / totalKg : 0,
      perCbm: totalCbm > 0 ? totalRevenue / totalCbm : 0,
      perContainer: uniqueContainers > 0 ? totalRevenue / uniqueContainers : 0,
    }
  }, [filtered, includeDrayage])

  // ── Period grouping for charts ────────────────────────────────────────────

  const periodData = useMemo(() => {
    const grouped = new Map<string, { bond: number; loc: number; kg: number; cbm: number; pieces: number; containers: Set<string>; bookings: Set<string>; destinations: Set<string>; daysSum: number; daysCount: number }>()
    filtered.forEach(r => {
      const dateStr = r.received_at || r.dispatched_at
      if (!dateStr) return
      const d = new Date(dateStr)
      if (isNaN(d.getTime())) return
      const key = filters.periodGroup === 'week' ? isoWeek(d) : isoMonth(d)
      if (!grouped.has(key)) grouped.set(key, { bond: 0, loc: 0, kg: 0, cbm: 0, pieces: 0, containers: new Set(), bookings: new Set(), destinations: new Set(), daysSum: 0, daysCount: 0 })
      const g = grouped.get(key)!
      if (r.cargo_type === 'BOND') g.bond++
      else g.loc++
      g.kg += r.weight_kg
      g.cbm += r.cbm
      g.pieces += r.pieces
      if (r.container_number) g.containers.add(r.container_number)
      if (r.booking_number) g.bookings.add(r.booking_number)
      if (r.destination) g.destinations.add(r.destination)
      if (r.days_in_warehouse !== null && r.dispatch_id) { g.daysSum += r.days_in_warehouse; g.daysCount++ }
    })
    return Array.from(grouped.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([period, data]) => ({
        period,
        bond: data.bond,
        loc: data.loc,
        kg: data.kg,
        cbm: data.cbm,
        pieces: data.pieces,
        containers: data.containers.size,
        bookings: data.bookings.size,
        destinations: data.destinations.size,
        avgDays: data.daysCount > 0 ? data.daysSum / data.daysCount : null,
      }))
  }, [filtered, filters.periodGroup])

  // ── By client ─────────────────────────────────────────────────────────────

  const byClient = useMemo(() => {
    const map = new Map<string, { name: string; kg: number; cbm: number; pieces: number; revenue: number; wrs: number; containers: Set<string> }>()
    filtered.forEach(r => {
      if (!r.client_id) return
      if (!map.has(r.client_id)) map.set(r.client_id, { name: r.client_name, kg: 0, cbm: 0, pieces: 0, revenue: 0, wrs: 0, containers: new Set() })
      const c = map.get(r.client_id)!
      c.kg += r.weight_kg
      c.cbm += r.cbm
      c.pieces += r.pieces
      c.revenue += rev(r)
      c.wrs++
      if (r.container_number) c.containers.add(r.container_number)
    })
    return Array.from(map.values()).sort((a, b) => b.kg - a.kg)
  }, [filtered, includeDrayage])

  // ── By container size ─────────────────────────────────────────────────────

  const byContainerSize = useMemo(() => {
    const map = new Map<string, { count: number; kg: number; cbm: number; revenue: number }>()
    const dispatched = filtered.filter(r => r.dispatch_id && r.container_size)
    dispatched.forEach(r => {
      if (!map.has(r.container_size)) map.set(r.container_size, { count: 0, kg: 0, cbm: 0, revenue: 0 })
      const c = map.get(r.container_size)!
      c.count++
      c.kg += r.weight_kg
      c.cbm += r.cbm
      c.revenue += rev(r)
    })
    return Array.from(map.entries()).sort((a, b) => b[1].count - a[1].count)
  }, [filtered, includeDrayage])

  // ── By naviera ────────────────────────────────────────────────────────────

  const byNaviera = useMemo(() => {
    const map = new Map<string, { containers: Set<string>; kg: number; cbm: number; bookings: Set<string>; revenue: number }>()
    const dispatched = filtered.filter(r => r.dispatch_id && r.naviera)
    dispatched.forEach(r => {
      if (!map.has(r.naviera)) map.set(r.naviera, { containers: new Set(), kg: 0, cbm: 0, bookings: new Set(), revenue: 0 })
      const n = map.get(r.naviera)!
      if (r.container_number) n.containers.add(r.container_number)
      n.kg += r.weight_kg
      n.cbm += r.cbm
      if (r.booking_number) n.bookings.add(r.booking_number)
      n.revenue += rev(r)
    })
    return Array.from(map.entries()).sort((a, b) => b[1].containers.size - a[1].containers.size)
  }, [filtered, includeDrayage])

  // ── Permanencia distribution ──────────────────────────────────────────────

  const permanencia = useMemo(() => {
    const buckets = [
      { label: '0-3 dias', min: 0, max: 3, count: 0 },
      { label: '4-7 dias', min: 4, max: 7, count: 0 },
      { label: '8-14 dias', min: 8, max: 14, count: 0 },
      { label: '15-30 dias', min: 15, max: 30, count: 0 },
      { label: '30+ dias', min: 31, max: 9999, count: 0 },
    ]
    filtered.forEach(r => {
      if (r.days_in_warehouse === null) return
      const b = buckets.find(b => r.days_in_warehouse! >= b.min && r.days_in_warehouse! <= b.max)
      if (b) b.count++
    })
    return buckets
  }, [filtered])

  // ── Rentabilidad by client ────────────────────────────────────────────────

  const rentByClient = useMemo(() => {
    return byClient
      .filter(c => c.revenue > 0)
      .map(c => ({
        name: c.name,
        revenue: c.revenue,
        perKg: c.kg > 0 ? c.revenue / c.kg : 0,
        perCbm: c.cbm > 0 ? c.revenue / c.cbm : 0,
        perContainer: c.containers.size > 0 ? c.revenue / c.containers.size : 0,
      }))
      .sort((a, b) => b.revenue - a.revenue)
  }, [byClient])

  // ── Render ────────────────────────────────────────────────────────────────

  if (!isAdmin && !isAccounting) {
    return <Layout title="KPI Dashboard" backTo="/billing"><p className="text-center text-gray-500 mt-10">Admin / Accounting only</p></Layout>
  }

  if (loading) {
    return (
      <Layout title="KPI Dashboard" backTo="/billing">
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue"></div>
        </div>
      </Layout>
    )
  }

  const sections = [
    { id: 'overview', label: 'Overview' },
    { id: 'flujo', label: 'Flujo de Carga' },
    { id: 'permanencia', label: 'Permanencia' },
    { id: 'containers', label: 'Contenedores' },
    { id: 'naviera', label: 'Navieras' },
    { id: 'rentabilidad', label: 'Rentabilidad' },
  ]

  return (
    <Layout title="Seafreight KPI Dashboard" backTo="/billing">
      <div className="max-w-7xl mx-auto space-y-6">

        {/* ── Filter Panel ──────────────────────────────────────────────── */}
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
            {/* Client */}
            <div>
              <label className="text-[10px] font-medium text-gray-500 uppercase">Cliente</label>
              <select
                value={filters.clients[0] || ''}
                onChange={e => setFilters(f => ({ ...f, clients: e.target.value ? [e.target.value] : [] }))}
                className="w-full border border-gray-200 rounded px-2 py-1.5 text-xs"
              >
                <option value="">Todos</option>
                {allClients.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            </div>
            {/* Naviera */}
            <div>
              <label className="text-[10px] font-medium text-gray-500 uppercase">Naviera</label>
              <select
                value={filters.navieras[0] || ''}
                onChange={e => setFilters(f => ({ ...f, navieras: e.target.value ? [e.target.value] : [] }))}
                className="w-full border border-gray-200 rounded px-2 py-1.5 text-xs"
              >
                <option value="">Todas</option>
                {NAVIERAS.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            {/* Container Size */}
            <div>
              <label className="text-[10px] font-medium text-gray-500 uppercase">Tamano</label>
              <select
                value={filters.containerSizes[0] || ''}
                onChange={e => setFilters(f => ({ ...f, containerSizes: e.target.value ? [e.target.value] : [] }))}
                className="w-full border border-gray-200 rounded px-2 py-1.5 text-xs"
              >
                <option value="">Todos</option>
                {CONTAINER_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            {/* Cargo Type */}
            <div>
              <label className="text-[10px] font-medium text-gray-500 uppercase">Tipo Carga</label>
              <select
                value={filters.cargoTypes[0] || ''}
                onChange={e => setFilters(f => ({ ...f, cargoTypes: e.target.value ? [e.target.value] : [] }))}
                className="w-full border border-gray-200 rounded px-2 py-1.5 text-xs"
              >
                <option value="">Todos</option>
                <option value="BOND">Bonded</option>
                <option value="LOC">Local</option>
              </select>
            </div>
            {/* Destination */}
            <div>
              <label className="text-[10px] font-medium text-gray-500 uppercase">Destino</label>
              <select
                value={filters.destinations[0] || ''}
                onChange={e => setFilters(f => ({ ...f, destinations: e.target.value ? [e.target.value] : [] }))}
                className="w-full border border-gray-200 rounded px-2 py-1.5 text-xs"
              >
                <option value="">Todos</option>
                {allDestinations.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            {/* Date From */}
            <div>
              <label className="text-[10px] font-medium text-gray-500 uppercase">Desde</label>
              <input
                type="date"
                value={filters.dateFrom}
                onChange={e => setFilters(f => ({ ...f, dateFrom: e.target.value }))}
                className="w-full border border-gray-200 rounded px-2 py-1.5 text-xs"
              />
            </div>
            {/* Date To */}
            <div>
              <label className="text-[10px] font-medium text-gray-500 uppercase">Hasta</label>
              <input
                type="date"
                value={filters.dateTo}
                onChange={e => setFilters(f => ({ ...f, dateTo: e.target.value }))}
                className="w-full border border-gray-200 rounded px-2 py-1.5 text-xs"
              />
            </div>
          </div>
          {/* Search + period toggle */}
          <div className="flex items-center gap-3 mt-3">
            <input
              value={filters.search}
              onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
              placeholder="Buscar booking, WR, contenedor, cliente..."
              className="flex-1 border border-gray-200 rounded px-3 py-1.5 text-xs"
            />
            <div className="flex bg-gray-100 rounded-lg p-0.5">
              <button
                onClick={() => setFilters(f => ({ ...f, periodGroup: 'week' }))}
                className={`px-3 py-1 text-xs rounded-md font-medium ${filters.periodGroup === 'week' ? 'bg-white shadow text-mcl-blue' : 'text-gray-500'}`}
              >Semana</button>
              <button
                onClick={() => setFilters(f => ({ ...f, periodGroup: 'month' }))}
                className={`px-3 py-1 text-xs rounded-md font-medium ${filters.periodGroup === 'month' ? 'bg-white shadow text-mcl-blue' : 'text-gray-500'}`}
              >Mes</button>
            </div>
            <span className="text-xs text-gray-400">{filtered.length} registros</span>
          </div>
        </div>

        {/* ── Section Tabs ──────────────────────────────────────────────── */}
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1 overflow-x-auto">
          {sections.map(s => (
            <button
              key={s.id}
              onClick={() => setActiveSection(s.id)}
              className={`px-4 py-2 text-xs font-medium rounded-md whitespace-nowrap transition-colors ${
                activeSection === s.id ? 'bg-white shadow text-mcl-blue' : 'text-gray-500 hover:text-gray-700'
              }`}
            >{s.label}</button>
          ))}
        </div>

        {/* ── Drayage toggle + Header KPIs ─────────────────────────────── */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIncludeDrayage(v => !v)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
              includeDrayage
                ? 'bg-mcl-blue text-white border-mcl-blue'
                : 'bg-white text-gray-600 border-gray-300'
            }`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
            DRAYAGE {includeDrayage ? 'ON' : 'OFF'}
          </button>
          {!includeDrayage && <span className="text-[10px] text-amber-600 font-medium">Revenue sin drayage</span>}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          <KpiCard label="Piezas" value={fmtNum(kpis.totalPieces)} />
          <KpiCard label="Kilos" value={fmtNum(kpis.totalKg)} />
          <KpiCard label="CBM" value={fmtNum(kpis.totalCbm, 4)} />
          <KpiCard label="Permanencia Prom." value={`${kpis.avgDays.toFixed(1)} dias`} />
          <KpiCard label="Contenedores" value={String(kpis.uniqueContainers)} />
          <KpiCard label="Destinos" value={String(kpis.uniqueDestinations)} />
          <KpiCard label="Revenue" value={fmtUSD(kpis.totalRevenue)} />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <KpiCard label="En Bodega" value={String(kpis.inWarehouseCount)} sub="WRs activos" />
          <KpiCard label="Despachados" value={String(kpis.dispatchedCount)} sub="WRs" />
          <KpiCard label="BOND" value={String(kpis.bondCount)} sub={`${kpis.bondCount + kpis.locCount > 0 ? Math.round(100 * kpis.bondCount / (kpis.bondCount + kpis.locCount)) : 0}%`} />
          <KpiCard label="LOC" value={String(kpis.locCount)} sub={`${kpis.bondCount + kpis.locCount > 0 ? Math.round(100 * kpis.locCount / (kpis.bondCount + kpis.locCount)) : 0}%`} />
        </div>

        {/* ── Section Content ───────────────────────────────────────────── */}

        {activeSection === 'overview' && (
          <div className="space-y-4">
            <SectionTitle title="Resumen por Periodo" />
            <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">Periodo</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">BOND</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">LOC</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Piezas</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Kilos</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">CBM</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Contenedores</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Destinos</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Bookings</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {periodData.slice(-12).map(p => (
                    <tr key={p.period}>
                      <td className="px-3 py-2 font-mono font-medium">{p.period}</td>
                      <td className="px-3 py-2 text-right">{p.bond}</td>
                      <td className="px-3 py-2 text-right">{p.loc}</td>
                      <td className="px-3 py-2 text-right">{fmtNum(p.pieces)}</td>
                      <td className="px-3 py-2 text-right">{fmtNum(p.kg)}</td>
                      <td className="px-3 py-2 text-right">{fmtNum(p.cbm, 4)}</td>
                      <td className="px-3 py-2 text-right">{p.containers}</td>
                      <td className="px-3 py-2 text-right">{p.destinations}</td>
                      <td className="px-3 py-2 text-right">{p.bookings}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeSection === 'flujo' && (
          <div className="space-y-4">
            <SectionTitle title="Flujo de Carga por Periodo" />
            {/* Visual bar chart */}
            <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-2">
              {periodData.slice(-12).map(p => {
                const total = p.bond + p.loc
                const maxTotal = Math.max(...periodData.slice(-12).map(x => x.bond + x.loc), 1)
                const pct = (total / maxTotal) * 100
                const bondPct = total > 0 ? (p.bond / total) * 100 : 0
                return (
                  <div key={p.period} className="flex items-center gap-3">
                    <span className="text-[10px] font-mono w-16 text-gray-500">{p.period}</span>
                    <div className="flex-1 h-5 bg-gray-100 rounded-full overflow-hidden relative">
                      <div className="absolute inset-y-0 left-0 flex" style={{ width: `${pct}%` }}>
                        <div className="bg-blue-500 h-full" style={{ width: `${bondPct}%` }}></div>
                        <div className="bg-emerald-400 h-full" style={{ width: `${100 - bondPct}%` }}></div>
                      </div>
                    </div>
                    <span className="text-[10px] text-gray-500 w-8 text-right">{total}</span>
                  </div>
                )
              })}
              <div className="flex gap-4 mt-2 text-[10px] text-gray-500">
                <span className="flex items-center gap-1"><span className="w-3 h-3 bg-blue-500 rounded"></span> BOND</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 bg-emerald-400 rounded"></span> LOC</span>
              </div>
            </div>

            <SectionTitle title="Ranking por Cliente (Kg)" />
            <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">Cliente</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Kg</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">CBM</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Piezas</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">WRs</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Contenedores</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {byClient.slice(0, 15).map(c => (
                    <tr key={c.name}>
                      <td className="px-3 py-2 font-medium">{c.name}</td>
                      <td className="px-3 py-2 text-right">{fmtNum(c.kg)}</td>
                      <td className="px-3 py-2 text-right">{fmtNum(c.cbm, 4)}</td>
                      <td className="px-3 py-2 text-right">{fmtNum(c.pieces)}</td>
                      <td className="px-3 py-2 text-right">{c.wrs}</td>
                      <td className="px-3 py-2 text-right">{c.containers.size}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeSection === 'permanencia' && (
          <div className="space-y-4">
            {/* Trend: avg days per period */}
            <SectionTitle title="Tendencia Semanal — Dias Promedio en Bodega" />
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              {(() => {
                const trendData = periodData.filter(p => p.avgDays !== null)
                if (trendData.length === 0) return <p className="text-xs text-gray-400">Sin datos de permanencia</p>
                const maxDays = Math.max(...trendData.map(p => p.avgDays!), 1)
                const last = trendData.slice(-12)
                return (
                  <div className="space-y-1">
                    {/* Chart area with line */}
                    <div className="relative h-40 flex items-end gap-1">
                      {last.map((p, i) => {
                        const h = (p.avgDays! / maxDays) * 100
                        const isImproving = i > 0 && last[i - 1].avgDays !== null && p.avgDays! < last[i - 1].avgDays!
                        return (
                          <div key={p.period} className="flex-1 flex flex-col items-center justify-end h-full">
                            <span className="text-[9px] font-semibold text-gray-600 mb-1">{p.avgDays!.toFixed(1)}</span>
                            <div
                              className={`w-full rounded-t-md transition-all ${isImproving ? 'bg-emerald-400' : 'bg-amber-400'}`}
                              style={{ height: `${h}%` }}
                            ></div>
                          </div>
                        )
                      })}
                    </div>
                    {/* X labels */}
                    <div className="flex gap-1">
                      {last.map(p => (
                        <div key={p.period} className="flex-1 text-center text-[8px] text-gray-400 truncate">{p.period.replace(/^\d{4}-/, '')}</div>
                      ))}
                    </div>
                    <div className="flex gap-4 mt-2 text-[10px] text-gray-500">
                      <span className="flex items-center gap-1"><span className="w-3 h-3 bg-emerald-400 rounded"></span> Mejora vs anterior</span>
                      <span className="flex items-center gap-1"><span className="w-3 h-3 bg-amber-400 rounded"></span> Igual o peor</span>
                    </div>
                  </div>
                )
              })()}
            </div>

            <SectionTitle title="Distribucion de Permanencia en Bodega" />
            <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
              {permanencia.map(b => {
                const maxCount = Math.max(...permanencia.map(x => x.count), 1)
                const pct = (b.count / maxCount) * 100
                const isAlert = b.min >= 15
                return (
                  <div key={b.label} className="flex items-center gap-3">
                    <span className="text-xs w-20 text-gray-600">{b.label}</span>
                    <div className="flex-1 h-6 bg-gray-100 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${isAlert ? 'bg-red-400' : 'bg-mcl-blue'}`} style={{ width: `${pct}%` }}></div>
                    </div>
                    <span className={`text-xs font-semibold w-10 text-right ${isAlert ? 'text-red-600' : 'text-gray-700'}`}>{b.count}</span>
                  </div>
                )
              })}
            </div>

            {/* Alert: long permanencia */}
            {(() => {
              const longStay = filtered.filter(r => r.days_in_warehouse !== null && r.days_in_warehouse >= 15 && !r.dispatch_id)
              if (longStay.length === 0) return null
              return (
                <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                  <h4 className="text-sm font-semibold text-red-700 mb-2">Alerta: {longStay.length} WR(s) con 15+ dias en bodega sin despacho</h4>
                  <div className="max-h-40 overflow-auto">
                    <table className="w-full text-xs">
                      <thead><tr><th className="text-left px-2 py-1">WR</th><th className="text-left px-2 py-1">Cliente</th><th className="text-right px-2 py-1">Dias</th><th className="text-right px-2 py-1">Kg</th></tr></thead>
                      <tbody>
                        {longStay.sort((a, b) => (b.days_in_warehouse || 0) - (a.days_in_warehouse || 0)).slice(0, 20).map(r => (
                          <tr key={r.wr_id}>
                            <td className="px-2 py-1 font-mono">{r.wr_number || r.wr_id.slice(0, 8)}</td>
                            <td className="px-2 py-1">{r.client_name}</td>
                            <td className="px-2 py-1 text-right font-semibold text-red-600">{r.days_in_warehouse}</td>
                            <td className="px-2 py-1 text-right">{fmtNum(r.weight_kg)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            })()}
          </div>
        )}

        {activeSection === 'containers' && (
          <div className="space-y-4">
            {/* Donut-style cards */}
            <SectionTitle title="Distribucion por Tamano de Contenedor" />
            {(() => {
              const totalContainers = byContainerSize.reduce((s, [, d]) => s + d.count, 0) || 1
              const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6']
              return (
                <div className="bg-white rounded-xl border border-gray-200 p-5">
                  {/* Horizontal proportional bar */}
                  <div className="h-8 rounded-full overflow-hidden flex mb-4">
                    {byContainerSize.map(([size, data], i) => (
                      <div
                        key={size}
                        style={{ width: `${(data.count / totalContainers) * 100}%`, backgroundColor: COLORS[i % COLORS.length] }}
                        className="h-full flex items-center justify-center text-white text-[10px] font-bold"
                      >{data.count > 0 ? size : ''}</div>
                    ))}
                  </div>
                  {/* Legend + metrics */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                    {byContainerSize.map(([size, data], i) => (
                      <div key={size} className="flex items-start gap-2">
                        <div className="w-3 h-3 rounded mt-0.5 flex-shrink-0" style={{ backgroundColor: COLORS[i % COLORS.length] }}></div>
                        <div>
                          <div className="text-sm font-bold text-gray-800">{data.count} <span className="text-xs font-normal text-gray-400">({Math.round(data.count / totalContainers * 100)}%)</span></div>
                          <div className="text-xs text-gray-600">{size === 'LCL' ? 'LCL' : `${size}'`}</div>
                          <div className="text-[10px] text-gray-400">{fmtNum(data.kg)} kg · {fmtNum(data.cbm, 4)} cbm</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })()}

            {/* Stacked bar chart by period */}
            <SectionTitle title="Tamano por Periodo" />
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              {(() => {
                const COLORS: Record<string, string> = { '20': '#3b82f6', '40': '#10b981', '40HC': '#f59e0b', '45': '#ef4444', 'LCL': '#8b5cf6' }
                const byPeriodSize = new Map<string, Record<string, number>>()
                filtered.filter(r => r.dispatch_id && r.container_size).forEach(r => {
                  const dateStr = r.dispatched_at || r.received_at
                  if (!dateStr) return
                  const d = new Date(dateStr)
                  if (isNaN(d.getTime())) return
                  const key = filters.periodGroup === 'week' ? isoWeek(d) : isoMonth(d)
                  if (!byPeriodSize.has(key)) byPeriodSize.set(key, {})
                  const row = byPeriodSize.get(key)!
                  row[r.container_size] = (row[r.container_size] || 0) + 1
                })
                const periods = Array.from(byPeriodSize.entries()).sort((a, b) => a[0].localeCompare(b[0])).slice(-12)
                const maxTotal = Math.max(...periods.map(([, s]) => Object.values(s).reduce((a, b) => a + b, 0)), 1)
                const activeSizes = [...new Set(periods.flatMap(([, s]) => Object.keys(s)))].sort()

                return (
                  <div className="space-y-1">
                    <div className="flex items-end gap-1" style={{ height: 160 }}>
                      {periods.map(([period, sizes]) => {
                        const total = Object.values(sizes).reduce((a, b) => a + b, 0)
                        const h = (total / maxTotal) * 100
                        return (
                          <div key={period} className="flex-1 flex flex-col items-center justify-end h-full">
                            <span className="text-[9px] text-gray-500 mb-1">{total}</span>
                            <div className="w-full rounded-t-md overflow-hidden flex flex-col-reverse" style={{ height: `${h}%` }}>
                              {activeSizes.map(s => {
                                const count = sizes[s] || 0
                                if (!count) return null
                                return <div key={s} style={{ height: `${(count / total) * 100}%`, backgroundColor: COLORS[s] || '#94a3b8' }} className="w-full"></div>
                              })}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                    <div className="flex gap-1">
                      {periods.map(([period]) => (
                        <div key={period} className="flex-1 text-center text-[8px] text-gray-400 truncate">{period.replace(/^\d{4}-/, '')}</div>
                      ))}
                    </div>
                    <div className="flex gap-3 mt-2 text-[10px] text-gray-500 flex-wrap">
                      {activeSizes.map(s => (
                        <span key={s} className="flex items-center gap-1">
                          <span className="w-3 h-3 rounded" style={{ backgroundColor: COLORS[s] || '#94a3b8' }}></span>
                          {s === 'LCL' ? 'LCL' : `${s}'`}
                        </span>
                      ))}
                    </div>
                  </div>
                )
              })()}
            </div>
          </div>
        )}

        {activeSection === 'naviera' && (
          <div className="space-y-4">
            {/* Horizontal bar chart by containers */}
            <SectionTitle title="Contenedores por Naviera" />
            <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-2">
              {(() => {
                const maxContainers = Math.max(...byNaviera.map(([, d]) => d.containers.size), 1)
                const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#6366f1', '#14b8a6']
                return byNaviera.map(([name, data], i) => (
                  <div key={name} className="flex items-center gap-3">
                    <span className="text-xs font-medium w-28 text-gray-700 truncate">{name}</span>
                    <div className="flex-1 h-7 bg-gray-100 rounded-md overflow-hidden relative">
                      <div
                        className="h-full rounded-md flex items-center px-2"
                        style={{ width: `${(data.containers.size / maxContainers) * 100}%`, backgroundColor: COLORS[i % COLORS.length] }}
                      >
                        <span className="text-white text-[10px] font-bold">{data.containers.size}</span>
                      </div>
                    </div>
                    <div className="text-[10px] text-gray-500 w-32 text-right">
                      {fmtNum(data.kg)} kg · {data.bookings.size} bkgs
                    </div>
                  </div>
                ))
              })()}
            </div>

            {/* Kg distribution by naviera */}
            <SectionTitle title="Kilos por Naviera" />
            <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-2">
              {(() => {
                const sorted = [...byNaviera].sort((a, b) => b[1].kg - a[1].kg)
                const maxKg = Math.max(...sorted.map(([, d]) => d.kg), 1)
                return sorted.map(([name, data]) => (
                  <div key={name} className="flex items-center gap-3">
                    <span className="text-xs font-medium w-28 text-gray-700 truncate">{name}</span>
                    <div className="flex-1 h-5 bg-gray-100 rounded-md overflow-hidden">
                      <div
                        className="h-full rounded-md bg-indigo-400"
                        style={{ width: `${(data.kg / maxKg) * 100}%` }}
                      ></div>
                    </div>
                    <span className="text-[10px] text-gray-600 w-24 text-right font-mono">{fmtNum(data.kg)} kg</span>
                  </div>
                ))
              })()}
            </div>

            {/* Revenue by naviera */}
            {byNaviera.some(([, d]) => d.revenue > 0) && (
              <>
                <SectionTitle title="Revenue por Naviera" />
                <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-2">
                  {(() => {
                    const sorted = [...byNaviera].filter(([, d]) => d.revenue > 0).sort((a, b) => b[1].revenue - a[1].revenue)
                    const maxRev = Math.max(...sorted.map(([, d]) => d.revenue), 1)
                    return sorted.map(([name, data]) => (
                      <div key={name} className="flex items-center gap-3">
                        <span className="text-xs font-medium w-28 text-gray-700 truncate">{name}</span>
                        <div className="flex-1 h-5 bg-gray-100 rounded-md overflow-hidden">
                          <div
                            className="h-full rounded-md bg-emerald-400"
                            style={{ width: `${(data.revenue / maxRev) * 100}%` }}
                          ></div>
                        </div>
                        <span className="text-[10px] text-gray-600 w-24 text-right font-mono">{fmtUSD(data.revenue)}</span>
                      </div>
                    ))
                  })()}
                </div>
              </>
            )}
          </div>
        )}

        {activeSection === 'rentabilidad' && (
          <div className="space-y-4">
            {/* Global rent KPIs */}
            <div className="grid grid-cols-3 gap-3">
              <KpiCard label="$/Kg" value={fmtUSD(kpis.perKg)} />
              <KpiCard label="$/CBM" value={fmtUSD(kpis.perCbm)} />
              <KpiCard label="$/Contenedor" value={fmtUSD(kpis.perContainer)} />
            </div>

            <SectionTitle title="Rentabilidad por Cliente" />
            <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">Cliente</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Revenue</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">$/Kg</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">$/CBM</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">$/Contenedor</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rentByClient.slice(0, 15).map(c => (
                    <tr key={c.name}>
                      <td className="px-3 py-2 font-medium">{c.name}</td>
                      <td className="px-3 py-2 text-right">{fmtUSD(c.revenue)}</td>
                      <td className="px-3 py-2 text-right">{fmtUSD(c.perKg)}</td>
                      <td className="px-3 py-2 text-right">{fmtUSD(c.perCbm)}</td>
                      <td className="px-3 py-2 text-right">{c.perContainer > 0 ? fmtUSD(c.perContainer) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Rent by cargo type */}
            <SectionTitle title="Rentabilidad por Tipo de Carga" />
            <div className="grid grid-cols-2 gap-4">
              {['BOND', 'LOC'].map(ct => {
                const rows = filtered.filter(r => r.cargo_type === ct)
                const ctRev = rows.reduce((s, r) => s + rev(r), 0)
                const kg = rows.reduce((s, r) => s + r.weight_kg, 0)
                const cbm = rows.reduce((s, r) => s + r.cbm, 0)
                return (
                  <div key={ct} className="bg-white rounded-xl border border-gray-200 p-4">
                    <h4 className="font-semibold text-sm text-gray-700 mb-2">{ct === 'BOND' ? 'Bonded' : 'Local'}</h4>
                    <div className="space-y-1 text-xs text-gray-600">
                      <div className="flex justify-between"><span>Revenue</span><span className="font-semibold">{fmtUSD(ctRev)}</span></div>
                      <div className="flex justify-between"><span>$/Kg</span><span>{kg > 0 ? fmtUSD(ctRev / kg) : '—'}</span></div>
                      <div className="flex justify-between"><span>$/CBM</span><span>{cbm > 0 ? fmtUSD(ctRev / cbm) : '—'}</span></div>
                      <div className="flex justify-between"><span>WRs</span><span>{rows.length}</span></div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </Layout>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="text-[10px] font-medium text-gray-500 uppercase">{label}</div>
      <div className="text-lg font-bold text-gray-800 mt-1">{value}</div>
      {sub && <div className="text-[10px] text-gray-400 mt-0.5">{sub}</div>}
    </div>
  )
}

function SectionTitle({ title }: { title: string }) {
  return <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
}
