import { useEffect, useState, useMemo } from 'react'
import Layout from '../components/Layout'
import { db } from '../lib/firebase'
import { fmtUSD } from '../lib/utils'
import { collection, getDocs, query, orderBy, limit } from 'firebase/firestore'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { getISOWeek, getISOWeekYear, getYear, getMonth, startOfISOWeek, format } from 'date-fns'
import { es } from 'date-fns/locale'

interface BillingCharge {
  id: string
  wr_id: string | null
  wr_number: string
  po_number: string
  dispatch_id?: string
  client_name: string
  billing_event: string
  total: number
  created_at: string
}

interface PeriodBucket {
  key: string
  label: string
  totalReception: number
  totalDispatch: number
  totalOptional: number
  totalAll: number
  wrCount: number
  dispatchCount: number
  poCount: number
}

function weekKey(dateStr: string): string {
  const d = new Date(dateStr)
  const w = String(getISOWeek(d)).padStart(2, '0')
  return `${getISOWeekYear(d)}-W${w}`
}

function monthKey(dateStr: string): string {
  const d = new Date(dateStr)
  return `${getYear(d)}-${String(getMonth(d) + 1).padStart(2, '0')}`
}

function buildLabel(key: string, mode: 'week' | 'month'): string {
  if (mode === 'month') {
    const [y, m] = key.split('-').map(Number)
    return format(new Date(y, m - 1, 1), 'MMM yyyy', { locale: es })
  }
  // Week: key = "2025-W46"
  const [yearStr, wStr] = key.split('-W')
  const year = Number(yearStr)
  const week = Number(wStr)
  // Get Monday of that ISO week
  const jan4 = new Date(year, 0, 4)
  const startOfYear = startOfISOWeek(jan4)
  const monday = new Date(startOfYear.getTime() + (week - 1) * 7 * 24 * 60 * 60 * 1000)
  return `S${week} ${format(monday, 'd MMM', { locale: es })}`
}

function aggregateByPeriod(
  charges: BillingCharge[],
  mode: 'week' | 'month',
  selectedClient: string,
  year: number
): PeriodBucket[] {
  const bucketMap = new Map<string, {
    label: string
    totalReception: number
    totalDispatch: number
    totalOptional: number
    wrIds: Set<string>
    dispatchIds: Set<string>
    poNumbers: Set<string>
  }>()

  for (const c of charges) {
    if (!c.created_at) continue
    const d = new Date(c.created_at)
    if (getYear(d) !== year) continue
    if (selectedClient && c.client_name !== selectedClient) continue

    const key = mode === 'week' ? weekKey(c.created_at) : monthKey(c.created_at)
    if (!bucketMap.has(key)) {
      bucketMap.set(key, {
        label: buildLabel(key, mode),
        totalReception: 0, totalDispatch: 0, totalOptional: 0,
        wrIds: new Set(), dispatchIds: new Set(), poNumbers: new Set(),
      })
    }
    const b = bucketMap.get(key)!
    if (c.billing_event === 'reception') {
      b.totalReception += c.total
      if (c.wr_id) b.wrIds.add(c.wr_id)
    } else if (c.billing_event === 'dispatch') {
      b.totalDispatch += c.total
      if (c.dispatch_id) b.dispatchIds.add(c.dispatch_id)
    } else if (c.billing_event === 'optional') {
      b.totalOptional += c.total
      if (c.wr_id) b.wrIds.add(c.wr_id)
    }
    if (c.po_number) b.poNumbers.add(c.po_number)
  }

  return Array.from(bucketMap.entries())
    .map(([key, b]) => ({
      key,
      label: b.label,
      totalReception: b.totalReception,
      totalDispatch: b.totalDispatch,
      totalOptional: b.totalOptional,
      totalAll: b.totalReception + b.totalDispatch + b.totalOptional,
      wrCount: b.wrIds.size,
      dispatchCount: b.dispatchIds.size,
      poCount: b.poNumbers.size,
    }))
    .sort((a, b) => a.key.localeCompare(b.key))
}

export default function BillingClientSummary() {
  const [allCharges,     setAllCharges]     = useState<BillingCharge[]>([])
  const [loading,        setLoading]        = useState(true)
  const [mode,           setMode]           = useState<'week' | 'month'>('month')
  const [selectedClient, setSelectedClient] = useState('')
  const year = new Date().getFullYear()

  useEffect(() => { loadCharges() }, [])

  async function loadCharges() {
    setLoading(true)
    try {
      const snap = await getDocs(
        query(collection(db, 'billing_charges'), orderBy('created_at', 'desc'), limit(3000))
      )
      setAllCharges(snap.docs.map(d => ({ id: d.id, ...d.data() })) as BillingCharge[])
    } catch (e) { console.error(e) }
    setLoading(false)
  }

  const clientList = useMemo(() =>
    [...new Set(allCharges.map(c => c.client_name).filter(Boolean))].sort()
  , [allCharges])

  const buckets = useMemo(() =>
    aggregateByPeriod(allCharges, mode, selectedClient, year)
  , [allCharges, mode, selectedClient, year])

  const grandTotal      = buckets.reduce((s, b) => s + b.totalAll, 0)
  const totalWRs        = buckets.reduce((s, b) => s + b.wrCount, 0)
  const totalDispatches = buckets.reduce((s, b) => s + b.dispatchCount, 0)
  const totalPOs        = buckets.reduce((s, b) => s + b.poCount, 0)

  // Totals per column for table footer
  const footerReception = buckets.reduce((s, b) => s + b.totalReception, 0)
  const footerDispatch  = buckets.reduce((s, b) => s + b.totalDispatch, 0)
  const footerOptional  = buckets.reduce((s, b) => s + b.totalOptional, 0)

  // Chart shows only last 13 periods; table shows all (up to 52 weeks)
  const chartBuckets = buckets.slice(-13)

  return (
    <Layout title="Resumen por Cliente" backTo="/billing">
      <div className="max-w-5xl mx-auto space-y-4">

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex rounded-lg overflow-hidden border border-gray-200 h-9">
            <button
              onClick={() => setMode('month')}
              className={`px-4 text-sm font-semibold transition-colors ${mode === 'month' ? 'bg-mcl-blue text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
            >
              Por Mes
            </button>
            <button
              onClick={() => setMode('week')}
              className={`px-4 text-sm font-semibold border-l border-gray-200 transition-colors ${mode === 'week' ? 'bg-mcl-blue text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
            >
              Por Semana
            </button>
          </div>
          <select
            value={selectedClient}
            onChange={e => setSelectedClient(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 h-9 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30 bg-white"
          >
            <option value="">Todos los clientes</option>
            {clientList.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <span className="text-sm text-gray-400 ml-auto">{year}</span>
        </div>

        {loading ? (
          <div className="flex justify-center p-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" />
          </div>
        ) : buckets.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-10 text-center text-gray-400">
            No hay cargos registrados para {year}. Ejecuta el backfill desde el dashboard.
          </div>
        ) : (
          <>
            {/* KPI banner */}
            <div className="bg-mcl-blue text-white rounded-xl px-5 py-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-blue-200 uppercase tracking-wide">Total Ingresos</p>
                <p className="text-2xl font-bold mt-0.5">{fmtUSD(grandTotal)}</p>
              </div>
              <div>
                <p className="text-xs text-blue-200 uppercase tracking-wide">WRs</p>
                <p className="text-2xl font-bold mt-0.5">{totalWRs}</p>
              </div>
              <div>
                <p className="text-xs text-blue-200 uppercase tracking-wide">Consolidados</p>
                <p className="text-2xl font-bold mt-0.5">{totalDispatches}</p>
              </div>
              <div>
                <p className="text-xs text-blue-200 uppercase tracking-wide">POs</p>
                <p className="text-2xl font-bold mt-0.5">{totalPOs}</p>
              </div>
            </div>

            {/* Trend chart */}
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Tendencia de Ingresos</p>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={chartBuckets} margin={{ top: 4, right: 8, left: 0, bottom: 48 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: '#6b7280' }}
                    angle={-35}
                    textAnchor="end"
                    interval={0}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: '#6b7280' }}
                    tickFormatter={v => `$${v}`}
                    width={60}
                  />
                  <Tooltip
                    formatter={(value) => [fmtUSD(Number(value))]}
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
                  <Bar dataKey="totalReception" name="Recepción" stackId="a" fill="#1e3a5f" radius={[0,0,0,0]} />
                  <Bar dataKey="totalDispatch"  name="Consolidado"  stackId="a" fill="#ea580c" radius={[0,0,0,0]} />
                  <Bar dataKey="totalOptional"  name="Opcionales" stackId="a" fill="#9333ea" radius={[4,4,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Period table */}
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-100">
                    <tr>
                      <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase">Período</th>
                      <th className="text-right px-4 py-3 font-semibold text-xs uppercase" style={{ color: '#1e3a5f' }}>Recepción</th>
                      <th className="text-right px-4 py-3 font-semibold text-xs uppercase" style={{ color: '#ea580c' }}>Consolidado</th>
                      <th className="text-right px-4 py-3 font-semibold text-xs uppercase" style={{ color: '#9333ea' }}>Opcionales</th>
                      <th className="text-right px-4 py-3 font-semibold text-gray-600 text-xs uppercase">Total</th>
                      <th className="text-center px-4 py-3 font-semibold text-gray-400 text-xs uppercase"># WRs</th>
                      <th className="text-center px-4 py-3 font-semibold text-gray-400 text-xs uppercase hidden sm:table-cell"># Desp.</th>
                      <th className="text-center px-4 py-3 font-semibold text-gray-400 text-xs uppercase hidden sm:table-cell"># POs</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {buckets.map(b => (
                      <tr key={b.key} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-2.5 text-gray-700 font-medium">{b.label}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-xs text-gray-600">
                          {b.totalReception > 0 ? fmtUSD(b.totalReception) : '—'}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-xs text-gray-600">
                          {b.totalDispatch > 0 ? fmtUSD(b.totalDispatch) : '—'}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-xs text-gray-600">
                          {b.totalOptional > 0 ? fmtUSD(b.totalOptional) : '—'}
                        </td>
                        <td className="px-4 py-2.5 text-right font-bold text-gray-800">{fmtUSD(b.totalAll)}</td>
                        <td className="px-4 py-2.5 text-center text-gray-500">{b.wrCount || '—'}</td>
                        <td className="px-4 py-2.5 text-center text-gray-500 hidden sm:table-cell">{b.dispatchCount || '—'}</td>
                        <td className="px-4 py-2.5 text-center text-gray-500 hidden sm:table-cell">{b.poCount || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-gray-50 border-t-2 border-gray-200">
                    <tr>
                      <td className="px-4 py-3 text-xs font-bold text-gray-600 uppercase">Total {year}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs font-bold" style={{ color: '#1e3a5f' }}>
                        {fmtUSD(footerReception)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs font-bold" style={{ color: '#ea580c' }}>
                        {fmtUSD(footerDispatch)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs font-bold" style={{ color: '#9333ea' }}>
                        {fmtUSD(footerOptional)}
                      </td>
                      <td className="px-4 py-3 text-right font-bold text-mcl-blue">{fmtUSD(grandTotal)}</td>
                      <td className="px-4 py-3 text-center font-bold text-gray-600">{totalWRs}</td>
                      <td className="px-4 py-3 text-center font-bold text-gray-600 hidden sm:table-cell">{totalDispatches}</td>
                      <td className="px-4 py-3 text-center font-bold text-gray-600 hidden sm:table-cell">{totalPOs}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </Layout>
  )
}
