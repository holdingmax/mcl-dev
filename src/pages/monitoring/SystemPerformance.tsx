import { useState, useEffect, useMemo } from 'react'
import { collection, query, where, orderBy, getDocs, limit } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import Layout from '../../components/Layout'
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, PieChart, Pie, Cell,
} from 'recharts'

/* ═══════════════════════════════════════════════════════════════
   SYSTEM PERFORMANCE DASHBOARD
   Latencia, throughput, errores, Web Vitals, queries lentas
   ═══════════════════════════════════════════════════════════════ */

const PALETTE = ['#1e3a5f', '#ea580c', '#16a34a', '#9333ea', '#dc2626', '#0891b2', '#ca8a04', '#6366f1']

interface HourlyMetric {
  date: string
  hour: number
  query_count: number
  error_count: number
  page_view_count: number
  queries: Record<string, { total: number; count: number; errors: number; maxDuration: number }>
  pages: Record<string, { total: number; count: number; maxLoad: number }>
  recent_errors: Array<{ message: string; page: string; at: number }>
}

type TimeRange = '24h' | '7d' | '30d'

export default function SystemPerformance() {
  const [metrics, setMetrics] = useState<HourlyMetric[]>([])
  const [range, setRange] = useState<TimeRange>('24h')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadMetrics()
  }, [range])

  async function loadMetrics() {
    setLoading(true)
    try {
      const daysBack = range === '24h' ? 1 : range === '7d' ? 7 : 30
      const cutoff = new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10)
      const q = query(
        collection(db, '_client_metrics'),
        where('date', '>=', cutoff),
        orderBy('date', 'asc'),
        limit(720), // 30 days * 24 hours
      )
      const snap = await getDocs(q)
      setMetrics(snap.docs.map(d => d.data() as HourlyMetric))
    } catch (err) {
      console.error('Error loading client metrics:', err)
    } finally {
      setLoading(false)
    }
  }

  // ── Computed Data ──────────────────────────────────────────

  const totalQueries = useMemo(() => metrics.reduce((s, m) => s + (m.query_count || 0), 0), [metrics])
  const totalErrors = useMemo(() => metrics.reduce((s, m) => s + (m.error_count || 0), 0), [metrics])
  const totalPageViews = useMemo(() => metrics.reduce((s, m) => s + (m.page_view_count || 0), 0), [metrics])

  // Throughput chart data (queries per hour)
  const throughputData = useMemo(() => {
    return metrics.map(m => ({
      label: range === '24h' ? `${m.hour}:00` : `${m.date} ${m.hour}h`,
      queries: m.query_count || 0,
      errors: m.error_count || 0,
      pages: m.page_view_count || 0,
    }))
  }, [metrics, range])

  // Average latency per collection (across all hours)
  const queryLatency = useMemo(() => {
    const agg: Record<string, { totalDur: number; count: number; errors: number; maxDur: number }> = {}
    for (const m of metrics) {
      if (!m.queries) continue
      for (const [col, stats] of Object.entries(m.queries)) {
        if (col.startsWith('_')) continue // Skip _long_task
        if (!agg[col]) agg[col] = { totalDur: 0, count: 0, errors: 0, maxDur: 0 }
        agg[col].totalDur += stats.total
        agg[col].count += stats.count
        agg[col].errors += stats.errors
        if (stats.maxDuration > agg[col].maxDur) agg[col].maxDur = stats.maxDuration
      }
    }
    return Object.entries(agg)
      .map(([name, stats]) => ({
        name: name.replace('airfreight_', 'air_').replace('warehouse_', 'ws_'),
        avg: Math.round(stats.totalDur / Math.max(stats.count, 1)),
        max: stats.maxDur,
        count: stats.count,
        errors: stats.errors,
      }))
      .sort((a, b) => b.avg - a.avg)
  }, [metrics])

  // Page load times
  const pageLoadData = useMemo(() => {
    const agg: Record<string, { totalLoad: number; count: number; maxLoad: number }> = {}
    for (const m of metrics) {
      if (!m.pages) continue
      for (const [page, stats] of Object.entries(m.pages)) {
        if (!agg[page]) agg[page] = { totalLoad: 0, count: 0, maxLoad: 0 }
        agg[page].totalLoad += stats.total
        agg[page].count += stats.count
        if (stats.maxLoad > agg[page].maxLoad) agg[page].maxLoad = stats.maxLoad
      }
    }
    return Object.entries(agg)
      .map(([page, stats]) => ({
        page: page.length > 30 ? '...' + page.slice(-27) : page,
        avg: Math.round(stats.totalLoad / Math.max(stats.count, 1)),
        max: stats.maxLoad,
        views: stats.count,
      }))
      .sort((a, b) => b.avg - a.avg)
      .slice(0, 15)
  }, [metrics])

  // Recent errors (all)
  const allErrors = useMemo(() => {
    const errs: Array<{ message: string; page: string; at: number }> = []
    for (const m of metrics) {
      if (m.recent_errors) errs.push(...m.recent_errors)
    }
    return errs.sort((a, b) => b.at - a.at).slice(0, 20)
  }, [metrics])

  // Error distribution by page
  const errorsByPage = useMemo(() => {
    const map: Record<string, number> = {}
    for (const e of allErrors) {
      const page = e.page || 'unknown'
      map[page] = (map[page] || 0) + 1
    }
    return Object.entries(map).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value)
  }, [allErrors])

  const errorRate = totalQueries > 0 ? ((totalErrors / totalQueries) * 100).toFixed(2) : '0'

  return (
    <Layout title="Performance del Sistema" backTo="/monitoring">
      {/* ── Time Range Selector ─────────────────────────── */}
      <div className="flex items-center gap-2 mb-6">
        {(['24h', '7d', '30d'] as TimeRange[]).map(r => (
          <button key={r} onClick={() => setRange(r)}
            className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${
              range === r ? 'bg-mcl-blue text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}>{r}</button>
        ))}
        <button onClick={loadMetrics} className="text-xs text-gray-400 hover:text-gray-600 ml-auto">Refrescar</button>
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-mcl-blue" />
        </div>
      ) : metrics.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-8 text-center">
          <p className="text-gray-500 text-sm">No hay metricas de cliente aun.</p>
          <p className="text-xs text-gray-400 mt-2">Las metricas se recopilan automaticamente cuando los usuarios navegan la aplicacion. Asegurate de que <code>initWebVitals()</code> este habilitado en <code>main.tsx</code>.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* ── KPI Cards ────────────────────────────────── */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <StatCard label="Total Queries" value={totalQueries.toLocaleString()} color="blue" />
            <StatCard label="Errores" value={totalErrors.toLocaleString()} color={totalErrors > 0 ? 'red' : 'green'} />
            <StatCard label="Error Rate" value={`${errorRate}%`} color={parseFloat(errorRate) > 5 ? 'red' : 'green'} />
            <StatCard label="Page Views" value={totalPageViews.toLocaleString()} color="blue" />
          </div>

          {/* ── Throughput Chart ──────────────────────────── */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">Throughput (queries/hora)</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={throughputData} margin={{ top: 4, right: 8, left: 0, bottom: 40 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" angle={-45} textAnchor="end" height={60} tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="queries" fill="#1e3a5f" name="Queries" />
                <Bar dataKey="errors" fill="#dc2626" name="Errores" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* ── Query Latency Table ──────────────────────── */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-700">Latencia por Coleccion (Firestore Queries)</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr>
                    <th className="text-left px-4 py-2 text-xs text-gray-500 font-medium">Coleccion</th>
                    <th className="text-right px-4 py-2 text-xs text-gray-500 font-medium">Avg (ms)</th>
                    <th className="text-right px-4 py-2 text-xs text-gray-500 font-medium">Max (ms)</th>
                    <th className="text-right px-4 py-2 text-xs text-gray-500 font-medium">Queries</th>
                    <th className="text-right px-4 py-2 text-xs text-gray-500 font-medium">Errores</th>
                    <th className="text-center px-4 py-2 text-xs text-gray-500 font-medium">Estado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {queryLatency.slice(0, 15).map((q, i) => (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="px-4 py-2 text-gray-700 font-mono text-xs">{q.name}</td>
                      <td className="px-4 py-2 text-right text-gray-700">{q.avg}</td>
                      <td className="px-4 py-2 text-right text-gray-500">{q.max}</td>
                      <td className="px-4 py-2 text-right text-gray-500">{q.count}</td>
                      <td className="px-4 py-2 text-right text-gray-500">{q.errors}</td>
                      <td className="px-4 py-2 text-center">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          q.avg > 1000 ? 'bg-red-100 text-red-700' :
                          q.avg > 500 ? 'bg-orange-100 text-orange-700' :
                          q.avg > 200 ? 'bg-yellow-100 text-yellow-700' :
                          'bg-green-100 text-green-700'
                        }`}>{q.avg > 1000 ? 'Lento' : q.avg > 500 ? 'Alto' : q.avg > 200 ? 'Normal' : 'Rapido'}</span>
                      </td>
                    </tr>
                  ))}
                  {queryLatency.length === 0 && (
                    <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-400 text-xs">Sin datos de queries</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* ── Page Load Times ──────────────────────── */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">Latencia por Pagina (Top 10)</h3>
              {pageLoadData.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={pageLoadData.slice(0, 10)} layout="vertical" margin={{ left: 100 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis type="number" tick={{ fontSize: 11 }} label={{ value: 'ms', position: 'insideBottomRight' }} />
                    <YAxis dataKey="page" type="category" tick={{ fontSize: 10 }} width={100} />
                    <Tooltip />
                    <Bar dataKey="avg" fill="#1e3a5f" name="Promedio (ms)" />
                    <Bar dataKey="max" fill="#ea580c" name="Max (ms)" />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-xs text-gray-400 text-center py-8">Sin datos de carga de paginas</p>
              )}
            </div>

            {/* ── Error Distribution ──────────────────── */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">Errores por Pagina</h3>
              {errorsByPage.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie dataKey="value" data={errorsByPage} cx="50%" cy="50%" outerRadius={100} label={({ name, value }) => `${name}: ${value}`}>
                      {errorsByPage.map((_, i) => (
                        <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-xs text-green-500 text-center py-8">Sin errores en el periodo</p>
              )}
            </div>
          </div>

          {/* ── Recent Errors Log ─────────────────────── */}
          {allErrors.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100">
                <h3 className="text-sm font-semibold text-gray-700">Errores Recientes</h3>
              </div>
              <div className="divide-y divide-gray-50 max-h-64 overflow-y-auto">
                {allErrors.map((e, i) => (
                  <div key={i} className="px-5 py-2 flex items-start gap-3">
                    <span className="text-xs text-gray-400 whitespace-nowrap mt-0.5">
                      {new Date(e.at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span className="text-xs text-red-600 font-mono break-all">{e.message}</span>
                    <span className="text-xs text-gray-400 whitespace-nowrap ml-auto">{e.page}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Layout>
  )
}

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
      <p className="text-[10px] sm:text-xs text-gray-500 uppercase">{label}</p>
      <p className={`text-xl sm:text-2xl font-bold ${
        color === 'blue' ? 'text-mcl-blue' :
        color === 'green' ? 'text-green-600' :
        color === 'red' ? 'text-red-600' :
        'text-gray-700'
      }`}>{value}</p>
    </div>
  )
}
