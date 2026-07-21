import { useState, useEffect, useMemo } from 'react'
import { doc, getDoc, collection, query, where, orderBy, getDocs, limit } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import Layout from '../../components/Layout'
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, BarChart, Bar,
} from 'recharts'

/* ═══════════════════════════════════════════════════════════════
   DATA INTEGRITY DASHBOARD
   Orphans, billing mismatches, consistency, AAID results
   ═══════════════════════════════════════════════════════════════ */

interface AAIDState {
  last_run?: string
  last_status?: string
  orphan_count?: number
  mismatch_count?: number
  inconsistency_count?: number
  checks_summary?: { ok: number; warning: number; critical: number }
}

interface AuditSnapshot {
  date: string
  metrics: {
    total_checks?: number
    checks_ok?: number
    checks_warning?: number
    checks_critical?: number
    checks_error?: number
    orphan_count?: number
    mismatch_count?: number
    inconsistency_count?: number
    orphans?: Array<{ type: string; booking_id?: string; doc_id?: string; flight_id?: string }>
    mismatches?: Array<{ type: string; flight_id?: string; detail: string }>
    inconsistencies?: Array<{ type: string; collection?: string; detail: string; awb?: string }>
    integrity_stats?: any
    billing_stats?: any
  }
  summary?: string
}

export default function DataIntegrity() {
  const [aaidState, setAaidState] = useState<AAIDState>({})
  const [snapshots, setSnapshots] = useState<AuditSnapshot[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { loadData() }, [])

  async function loadData() {
    try {
      const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
      const [stateSnap, metricsSnap] = await Promise.all([
        getDoc(doc(db, '_agent_state', 'AAID')),
        getDocs(query(
          collection(db, '_metrics_daily'),
          where('agent_id', '==', 'AAID'),
          where('date', '>=', cutoff),
          orderBy('date', 'asc'),
          limit(30),
        )).catch(() => null),
      ])

      setAaidState(stateSnap.exists() ? stateSnap.data() as AAIDState : {})
      if (metricsSnap) {
        setSnapshots(metricsSnap.docs.map(d => d.data() as AuditSnapshot))
      }
    } catch (err) {
      console.error('Error loading integrity data:', err)
    } finally {
      setLoading(false)
    }
  }

  // Latest audit
  const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null
  const latestMetrics = latest?.metrics || {}

  // Trend data (orphans, mismatches, inconsistencies over time)
  const trendData = useMemo(() =>
    snapshots.map(s => ({
      date: s.date.slice(5),
      orphans: s.metrics.orphan_count ?? 0,
      mismatches: s.metrics.mismatch_count ?? 0,
      inconsistencies: s.metrics.inconsistency_count ?? 0,
    }))
  , [snapshots])

  // Checks breakdown for latest
  const checksData = latestMetrics.total_checks ? [
    { name: 'OK', value: latestMetrics.checks_ok || 0, color: '#16a34a' },
    { name: 'Warning', value: latestMetrics.checks_warning || 0, color: '#ea580c' },
    { name: 'Critical', value: latestMetrics.checks_critical || 0, color: '#dc2626' },
    { name: 'Error', value: latestMetrics.checks_error || 0, color: '#6366f1' },
  ].filter(c => c.value > 0) : []

  // Billing stats
  const billing = latestMetrics.billing_stats || {}
  const integrity = latestMetrics.integrity_stats || {}

  function timeAgo(isoStr?: string): string {
    if (!isoStr) return 'Nunca'
    const diff = Date.now() - new Date(isoStr).getTime()
    if (diff < 3600000) return `Hace ${Math.round(diff / 60000)} min`
    if (diff < 86400000) return `Hace ${Math.round(diff / 3600000)}h`
    return `Hace ${Math.round(diff / 86400000)}d`
  }

  return (
    <Layout title="Integridad de Datos" backTo="/monitoring">
      {loading ? (
        <div className="flex justify-center py-20">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-mcl-blue" />
        </div>
      ) : (
        <div className="space-y-6">
          {/* ── Status Banner ─────────────────────────────── */}
          <div className={`rounded-xl p-5 border-2 ${
            aaidState.last_status === 'critical' ? 'bg-red-50 border-red-200' :
            aaidState.last_status === 'warning' ? 'bg-orange-50 border-orange-200' :
            aaidState.last_status === 'ok' || aaidState.last_status === 'healthy' ? 'bg-green-50 border-green-200' :
            'bg-gray-50 border-gray-200'
          }`}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wider">Integridad del Sistema</p>
                <p className={`text-2xl font-bold mt-1 ${
                  aaidState.last_status === 'critical' ? 'text-red-700' :
                  aaidState.last_status === 'warning' ? 'text-orange-700' :
                  'text-green-700'
                }`}>{(aaidState.last_status || 'sin datos').toUpperCase()}</p>
                {latest?.summary && <p className="text-sm text-gray-600 mt-1">{latest.summary}</p>}
              </div>
              <div className="text-right text-xs text-gray-400">
                <p>Ultima auditoria</p>
                <p className="font-medium">{timeAgo(aaidState.last_run)}</p>
              </div>
            </div>
          </div>

          {/* ── KPI Cards ─────────────────────────────────── */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <KpiCard label="Orphans" value={aaidState.orphan_count ?? '-'}
              warn={(aaidState.orphan_count || 0) > 0} />
            <KpiCard label="Mismatches" value={aaidState.mismatch_count ?? '-'}
              warn={(aaidState.mismatch_count || 0) > 0} />
            <KpiCard label="Inconsistencias" value={aaidState.inconsistency_count ?? '-'}
              warn={(aaidState.inconsistency_count || 0) > 0} />
            <KpiCard label="Checks OK" value={aaidState.checks_summary?.ok ?? '-'} />
            <KpiCard label="Checks Warning" value={aaidState.checks_summary?.warning ?? '-'}
              warn={(aaidState.checks_summary?.warning || 0) > 0} />
          </div>

          {/* ── Trend Chart ───────────────────────────────── */}
          {trendData.length > 1 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">Tendencia de Issues (30d)</h3>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={trendData} margin={{ top: 4, right: 8, left: 0, bottom: 40 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" angle={-45} textAnchor="end" height={60} tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="orphans" stroke="#dc2626" strokeWidth={2} name="Orphans" />
                  <Line type="monotone" dataKey="mismatches" stroke="#ea580c" strokeWidth={2} name="Mismatches" />
                  <Line type="monotone" dataKey="inconsistencies" stroke="#9333ea" strokeWidth={2} name="Inconsistencias" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* ── Checks Breakdown + Billing Stats ──────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">Checks de Integridad (ultima corrida)</h3>
              {checksData.length > 0 ? (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={checksData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="value" name="Cantidad">
                      {checksData.map((entry, i) => (
                        <Bar key={i} dataKey="value" fill={entry.color} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-xs text-gray-400 text-center py-8">Sin datos de checks</p>
              )}
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Stats de Billing</h3>
              <div className="space-y-2">
                {Object.entries(billing).length > 0 ? (
                  Object.entries(billing).map(([key, value]) => (
                    <div key={key} className="flex justify-between py-1 border-b border-gray-50">
                      <span className="text-xs text-gray-600">{key.replace(/_/g, ' ')}</span>
                      <span className="text-xs font-medium text-gray-700">{String(value)}</span>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-gray-400">Sin stats de billing</p>
                )}
              </div>

              <h3 className="text-sm font-semibold text-gray-700 mt-4 mb-3">Stats de Integridad</h3>
              <div className="space-y-2">
                {Object.entries(integrity).length > 0 ? (
                  Object.entries(integrity).map(([key, value]) => (
                    <div key={key} className="flex justify-between py-1 border-b border-gray-50">
                      <span className="text-xs text-gray-600">{key.replace(/_/g, ' ')}</span>
                      <span className="text-xs font-medium text-gray-700">
                        {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-gray-400">Sin stats de integridad</p>
                )}
              </div>
            </div>
          </div>

          {/* ── Detected Issues Tables ────────────────────── */}
          {(latestMetrics.orphans?.length || 0) > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100">
                <h3 className="text-sm font-semibold text-red-700">Documentos Huerfanos Detectados</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-red-50 border-b border-red-100">
                    <tr>
                      <th className="text-left px-4 py-2 text-xs text-red-600 font-medium">Tipo</th>
                      <th className="text-left px-4 py-2 text-xs text-red-600 font-medium">ID</th>
                      <th className="text-left px-4 py-2 text-xs text-red-600 font-medium">Referencia Rota</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {latestMetrics.orphans!.map((o: any, i: number) => (
                      <tr key={i} className="hover:bg-red-50/50">
                        <td className="px-4 py-2 text-xs text-gray-700">{o.type}</td>
                        <td className="px-4 py-2 text-xs font-mono text-gray-600">{o.booking_id || o.doc_id || o.do_id}</td>
                        <td className="px-4 py-2 text-xs font-mono text-gray-500">{o.flight_id || o.booking_id || o.order_id}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {(latestMetrics.mismatches?.length || 0) > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100">
                <h3 className="text-sm font-semibold text-orange-700">Mismatches de Billing</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-orange-50 border-b border-orange-100">
                    <tr>
                      <th className="text-left px-4 py-2 text-xs text-orange-600 font-medium">Tipo</th>
                      <th className="text-left px-4 py-2 text-xs text-orange-600 font-medium">Detalle</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {latestMetrics.mismatches!.map((m: any, i: number) => (
                      <tr key={i} className="hover:bg-orange-50/50">
                        <td className="px-4 py-2 text-xs text-gray-700">{m.type}</td>
                        <td className="px-4 py-2 text-xs text-gray-600">{m.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {(latestMetrics.inconsistencies?.length || 0) > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100">
                <h3 className="text-sm font-semibold text-purple-700">Inconsistencias Detectadas</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-purple-50 border-b border-purple-100">
                    <tr>
                      <th className="text-left px-4 py-2 text-xs text-purple-600 font-medium">Tipo</th>
                      <th className="text-left px-4 py-2 text-xs text-purple-600 font-medium">Detalle</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {latestMetrics.inconsistencies!.map((inc: any, i: number) => (
                      <tr key={i} className="hover:bg-purple-50/50">
                        <td className="px-4 py-2 text-xs text-gray-700">{inc.type}</td>
                        <td className="px-4 py-2 text-xs text-gray-600">{inc.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {snapshots.length === 0 && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
              <p className="text-xs text-blue-700">Los datos de integridad provienen del agente AAID. Se ejecuta diariamente a las 12:00 AM EST. Tras su primera corrida, los datos aparecerán aqui automaticamente.</p>
            </div>
          )}
        </div>
      )}
    </Layout>
  )
}

function KpiCard({ label, value, warn }: { label: string; value: number | string; warn?: boolean }) {
  return (
    <div className={`bg-white rounded-xl shadow-sm border p-3 ${warn ? 'border-orange-200 bg-orange-50' : 'border-gray-100'}`}>
      <p className="text-[10px] text-gray-500 uppercase">{label}</p>
      <p className={`text-lg font-bold ${warn ? 'text-orange-600' : 'text-mcl-blue'}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </p>
    </div>
  )
}
