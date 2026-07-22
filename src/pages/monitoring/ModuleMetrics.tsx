import { useState, useEffect, useMemo } from 'react'
import { collection, query, where, orderBy, getDocs, limit, doc, getDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '../../lib/firebase'
import Layout from '../../components/Layout'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, LineChart, Line,
} from 'recharts'

/* ═══════════════════════════════════════════════════════════════
   MODULE METRICS DASHBOARD
   Per-module performance: Airfreight, Warehouse, Sea, Billing
   ═══════════════════════════════════════════════════════════════ */

const PALETTE = ['#1e3a5f', '#ea580c', '#16a34a', '#9333ea', '#dc2626', '#0891b2']

type ModuleTab = 'airfreight' | 'warehouse' | 'seafreight' | 'billing'

const MODULE_COLLECTIONS: Record<ModuleTab, string[]> = {
  airfreight: [
    'airfreight_bookings', 'airfreight_flights', 'airfreight_doc_receptions',
    'air_billing_charges', 'delivery_orders',
  ],
  warehouse: [
    'warehouse_service_orders', 'ws_billing_charges', 'ws_delivery_orders',
    'ws_delivery_tracking',
  ],
  seafreight: [
    'warehouse_receipts', 'billing_charges', 'delivery_orders',
  ],
  billing: [
    'air_billing_charges', 'billing_charges', 'ws_billing_charges',
  ],
}

const MODULE_LABELS: Record<ModuleTab, string> = {
  airfreight: 'Airfreight',
  warehouse: 'Warehouse Services',
  seafreight: 'Sea Freight',
  billing: 'Billing',
}

interface DailyMetrics {
  date: string
  metrics: Record<string, number>
  summary?: string
}

export default function ModuleMetrics() {
  const [tab, setTab] = useState<ModuleTab>('airfreight')
  const [dailyData, setDailyData] = useState<DailyMetrics[]>([])
  const [clientMetrics, setClientMetrics] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  // ── POC MariaDB (Escenario B, paso 0) ──────────────────────
  // Prueba end-to-end: Cloud Function `getModuleMetrics` -> pool -> MariaDB.
  // No reemplaza ninguna metrica existente, es un chequeo aislado y acotado.
  const [mariaDbPoc, setMariaDbPoc] = useState<{ warehouse_receipts_total: number; billing_charges_total: number } | null>(null)
  const [mariaDbPocError, setMariaDbPocError] = useState<string | null>(null)

  useEffect(() => {
    const getModuleMetricsFn = httpsCallable(functions, 'getModuleMetrics')
    getModuleMetricsFn()
      .then(res => setMariaDbPoc(res.data as { warehouse_receipts_total: number; billing_charges_total: number }))
      .catch(err => setMariaDbPocError(err.message))
  }, [])

  useEffect(() => {
    loadData()
  }, [tab])

  async function loadData() {
    setLoading(true)
    try {
      // Load agent daily metrics (ADMP writes these)
      const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
      const metricsQ = query(
        collection(db, '_metrics_daily'),
        where('agent_id', '==', 'ADMP'),
        where('date', '>=', cutoff),
        orderBy('date', 'asc'),
        limit(30),
      )

      // Load client-side metrics for query latency per module
      const clientQ = query(
        collection(db, '_client_metrics'),
        where('date', '>=', cutoff),
        orderBy('date', 'asc'),
        limit(720),
      )

      const [metricsSnap, clientSnap] = await Promise.all([
        getDocs(metricsQ).catch(() => null),
        getDocs(clientQ).catch(() => null),
      ])

      if (metricsSnap) {
        setDailyData(metricsSnap.docs.map(d => d.data() as DailyMetrics))
      }
      if (clientSnap) {
        setClientMetrics(clientSnap.docs.map(d => d.data()))
      }
    } catch (err) {
      console.error('Error loading module metrics:', err)
    } finally {
      setLoading(false)
    }
  }

  // ── Computed: Collection growth trends ─────────────────────
  const growthTrend = useMemo(() => {
    const collections = MODULE_COLLECTIONS[tab]
    return dailyData.map(d => {
      const row: Record<string, any> = { date: d.date.slice(5) } // MM-DD
      for (const col of collections) {
        const key = `${col}_total`
        row[col.replace('airfreight_', '').replace('warehouse_', 'ws_').replace('_charges', '')] = d.metrics?.[key] ?? null
      }
      return row
    }).filter(r => Object.values(r).some(v => v !== null && v !== r.date))
  }, [dailyData, tab])

  // ── Computed: Activity 24h trends ──────────────────────────
  const activityTrend = useMemo(() => {
    const collections = MODULE_COLLECTIONS[tab]
    return dailyData.map(d => {
      const row: Record<string, any> = { date: d.date.slice(5) }
      for (const col of collections) {
        const key = `${col}_24h`
        if (d.metrics?.[key] != null) {
          row[col.replace('airfreight_', '').replace('warehouse_', 'ws_').replace('_charges', '')] = d.metrics[key]
        }
      }
      return row
    }).filter(r => Object.keys(r).length > 1)
  }, [dailyData, tab])

  // ── Computed: Query latency per module collections ─────────
  const moduleLatency = useMemo(() => {
    const collections = MODULE_COLLECTIONS[tab]
    const agg: Record<string, { totalDur: number; count: number; errors: number }> = {}

    for (const m of clientMetrics) {
      if (!m.queries) continue
      for (const [col, stats] of Object.entries(m.queries) as any) {
        if (!collections.some(c => col.includes(c.replace('airfreight_', '').replace('warehouse_', '')))) continue
        if (!agg[col]) agg[col] = { totalDur: 0, count: 0, errors: 0 }
        agg[col].totalDur += stats.total
        agg[col].count += stats.count
        agg[col].errors += stats.errors
      }
    }

    return Object.entries(agg)
      .map(([name, stats]) => ({
        name: name.length > 25 ? name.slice(-22) : name,
        avg: Math.round(stats.totalDur / Math.max(stats.count, 1)),
        count: stats.count,
        errors: stats.errors,
      }))
      .sort((a, b) => b.avg - a.avg)
  }, [clientMetrics, tab])

  // ── Module-specific KPIs ───────────────────────────────────
  const latestMetrics = dailyData.length > 0 ? dailyData[dailyData.length - 1].metrics : {}

  function getModuleKPIs(): Array<{ label: string; value: string | number; status: string }> {
    const m = latestMetrics || {}
    switch (tab) {
      case 'airfreight': return [
        { label: 'Bookings Total', value: m.airfreight_bookings_total ?? '-', status: 'ok' },
        { label: 'Flights', value: m.airfreight_flights_total ?? '-', status: 'ok' },
        { label: 'Doc Receptions (24h)', value: m.airfreight_doc_receptions_24h ?? '-', status: 'ok' },
        { label: 'Bookings sin Flight', value: m.bookings_no_flight ?? '-', status: (m.bookings_no_flight || 0) > 50 ? 'warning' : 'ok' },
        { label: 'Air Charges Pending', value: m.air_charges_pending ?? '-', status: (m.air_charges_pending || 0) > 5000 ? 'warning' : 'ok' },
        { label: 'Bookings (24h)', value: m.airfreight_bookings_24h ?? '-', status: 'ok' },
      ]
      case 'warehouse': return [
        { label: 'Ordenes Activas', value: m.ws_orders_active ?? '-', status: 'ok' },
        { label: 'Ordenes Completadas', value: m.ws_orders_completed ?? '-', status: 'ok' },
        { label: 'WS Orders Total', value: m.warehouse_service_orders_total ?? '-', status: 'ok' },
        { label: 'WS Delivery Orders', value: m.ws_delivery_orders_total ?? '-', status: 'ok' },
        { label: 'WS Billing Charges', value: m.ws_billing_charges_total ?? '-', status: 'ok' },
        { label: 'Actividad 24h', value: m.warehouse_service_orders_24h ?? '-', status: 'ok' },
      ]
      case 'seafreight': return [
        { label: 'Warehouse Receipts', value: m.warehouse_receipts_total ?? '-', status: 'ok' },
        { label: 'WRs (24h)', value: m.warehouse_receipts_24h ?? '-', status: 'ok' },
        { label: 'Billing Charges', value: m.billing_charges_total ?? '-', status: 'ok' },
        { label: 'Delivery Orders', value: m.delivery_orders_total ?? '-', status: 'ok' },
      ]
      case 'billing': return [
        { label: 'Air Charges Total', value: m.air_billing_charges_total ?? '-', status: 'ok' },
        { label: 'Air Pending', value: m.air_charges_pending ?? '-', status: (m.air_charges_pending || 0) > 5000 ? 'warning' : 'ok' },
        { label: 'Air Invoiced', value: m.air_charges_invoiced ?? '-', status: 'ok' },
        { label: 'Air Paid', value: m.air_charges_paid ?? '-', status: 'ok' },
        { label: 'Sea Charges', value: m.billing_charges_total ?? '-', status: 'ok' },
        { label: 'WS Charges', value: m.ws_billing_charges_total ?? '-', status: 'ok' },
      ]
    }
  }

  const kpis = getModuleKPIs()
  const chartKeys = growthTrend.length > 0 ? Object.keys(growthTrend[0]).filter(k => k !== 'date') : []

  return (
    <Layout title="Modulos Criticos" backTo="/monitoring">
      {/* ── Module Tabs ─────────────────────────────────── */}
      <div className="flex items-center gap-2 mb-6 flex-wrap">
        {(Object.keys(MODULE_LABELS) as ModuleTab[]).map(m => (
          <button key={m} onClick={() => setTab(m)}
            className={`text-xs px-4 py-2 rounded-lg font-medium transition-colors ${
              tab === m ? 'bg-mcl-blue text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}>{MODULE_LABELS[m]}</button>
        ))}
      </div>

      {/* ── POC MariaDB (Escenario B, paso 0) — bloque aislado, no reemplaza nada ── */}
      <div className="bg-purple-50 border border-purple-200 rounded-xl p-3 mb-6 text-xs text-purple-700">
        <strong>POC MariaDB:</strong>{' '}
        {mariaDbPocError
          ? `error al llamar getModuleMetrics: ${mariaDbPocError}`
          : mariaDbPoc
            ? `warehouse_receipts=${mariaDbPoc.warehouse_receipts_total}, billing_charges=${mariaDbPoc.billing_charges_total}`
            : 'cargando...'}
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-mcl-blue" />
        </div>
      ) : (
        <div className="space-y-6">
          {/* ── Module KPI Cards ─────────────────────── */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {kpis.map((kpi, i) => (
              <div key={i} className={`bg-white rounded-xl shadow-sm border p-3 ${
                kpi.status === 'warning' ? 'border-orange-200 bg-orange-50' : 'border-gray-100'
              }`}>
                <p className="text-[10px] text-gray-500 uppercase">{kpi.label}</p>
                <p className={`text-lg font-bold ${
                  kpi.status === 'warning' ? 'text-orange-600' : 'text-mcl-blue'
                }`}>{typeof kpi.value === 'number' ? kpi.value.toLocaleString() : kpi.value}</p>
              </div>
            ))}
          </div>

          {/* ── Growth Trend Chart ────────────────────── */}
          {growthTrend.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">Crecimiento de Colecciones (30d)</h3>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={growthTrend} margin={{ top: 4, right: 8, left: 0, bottom: 40 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" angle={-45} textAnchor="end" height={60} tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Legend />
                  {chartKeys.map((key, i) => (
                    <Line key={key} type="monotone" dataKey={key} stroke={PALETTE[i % PALETTE.length]}
                      strokeWidth={2} dot={false} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* ── Activity 24h Trend ────────────────────── */}
          {activityTrend.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">Actividad Diaria (documentos creados en 24h)</h3>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={activityTrend} margin={{ top: 4, right: 8, left: 0, bottom: 40 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" angle={-45} textAnchor="end" height={60} tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Legend />
                  {Object.keys(activityTrend[0] || {}).filter(k => k !== 'date').map((key, i) => (
                    <Bar key={key} dataKey={key} fill={PALETTE[i % PALETTE.length]} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* ── Query Latency for Module ──────────────── */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-700">Latencia de Queries — {MODULE_LABELS[tab]}</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr>
                    <th className="text-left px-4 py-2 text-xs text-gray-500 font-medium">Query</th>
                    <th className="text-right px-4 py-2 text-xs text-gray-500 font-medium">Avg (ms)</th>
                    <th className="text-right px-4 py-2 text-xs text-gray-500 font-medium">Invocaciones</th>
                    <th className="text-right px-4 py-2 text-xs text-gray-500 font-medium">Errores</th>
                    <th className="text-center px-4 py-2 text-xs text-gray-500 font-medium">Estado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {moduleLatency.length > 0 ? moduleLatency.map((q, i) => (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="px-4 py-2 text-gray-700 font-mono text-xs">{q.name}</td>
                      <td className="px-4 py-2 text-right text-gray-700">{q.avg}</td>
                      <td className="px-4 py-2 text-right text-gray-500">{q.count}</td>
                      <td className="px-4 py-2 text-right text-gray-500">{q.errors}</td>
                      <td className="px-4 py-2 text-center">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          q.avg > 1000 ? 'bg-red-100 text-red-700' :
                          q.avg > 300 ? 'bg-yellow-100 text-yellow-700' :
                          'bg-green-100 text-green-700'
                        }`}>{q.avg > 1000 ? 'Lento' : q.avg > 300 ? 'Normal' : 'Rapido'}</span>
                      </td>
                    </tr>
                  )) : (
                    <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-400 text-xs">
                      Sin datos de latencia para este modulo. Las metricas se recopilan del uso del cliente.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {dailyData.length === 0 && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
              <p className="text-xs text-blue-700">Los datos de este dashboard provienen del agente ADMP (Monitoreo de Performance). Se actualizan diariamente a las 7:00 AM EST. Si no hay datos, el agente aun no ha ejecutado su primera corrida.</p>
            </div>
          )}
        </div>
      )}
    </Layout>
  )
}
