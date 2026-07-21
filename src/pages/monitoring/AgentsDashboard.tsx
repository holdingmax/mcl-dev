import { useState, useEffect } from 'react'
import { doc, getDoc, collection, query, where, orderBy, getDocs, limit } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import Layout from '../../components/Layout'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend,
} from 'recharts'

/* ═══════════════════════════════════════════════════════════════
   AGENTS DASHBOARD
   Estado, ejecuciones, decisiones, logs de cada agente GitHub
   ═══════════════════════════════════════════════════════════════ */

interface AgentState {
  last_run?: string
  last_status?: string
  updated_at?: any
  // ANDS specific
  current_deployment?: string
  current_phase?: string
  canary_tier?: string
  completed_deployments?: string[]
  baseline_metrics?: any
  deploy_started_at?: string
  rollback_reason?: string
  // ADMP specific
  baselines?: any
  // AAID specific
  orphan_count?: number
  mismatch_count?: number
  inconsistency_count?: number
  checks_summary?: { ok: number; warning: number; critical: number }
  [key: string]: any
}

interface MetricSnapshot {
  agent_id: string
  date: string
  metrics: any
  summary?: string
}

const AGENTS = [
  { id: 'ANDS', name: 'Agente Nocturno de Despliegue Seguro', schedule: '2:00 AM UTC / 10:00 PM EST', color: '#1e3a5f' },
  { id: 'ADMP', name: 'Agente Diario de Monitoreo de Performance', schedule: '11:00 AM UTC / 7:00 AM EST', color: '#16a34a' },
  { id: 'AAID', name: 'Agente Autonomo de Integridad de Datos', schedule: '4:00 AM UTC / 12:00 AM EST', color: '#9333ea' },
]

export default function AgentsDashboard() {
  const [states, setStates] = useState<Record<string, AgentState>>({})
  const [history, setHistory] = useState<MetricSnapshot[]>([])
  const [selectedAgent, setSelectedAgent] = useState<string>('ANDS')
  const [loading, setLoading] = useState(true)

  useEffect(() => { loadData() }, [])

  async function loadData() {
    try {
      const statePromises = AGENTS.map(async (a) => {
        const snap = await getDoc(doc(db, '_agent_state', a.id))
        return { id: a.id, data: snap.exists() ? snap.data() as AgentState : {} }
      })

      const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
      const histQ = query(
        collection(db, '_metrics_daily'),
        where('date', '>=', cutoff),
        orderBy('date', 'desc'),
        limit(90),
      )

      const [stateResults, histSnap] = await Promise.all([
        Promise.all(statePromises),
        getDocs(histQ).catch(() => null),
      ])

      const stateMap: Record<string, AgentState> = {}
      stateResults.forEach(r => { stateMap[r.id] = r.data })
      setStates(stateMap)

      if (histSnap) {
        setHistory(histSnap.docs.map(d => d.data() as MetricSnapshot))
      }
    } catch (err) {
      console.error('Error loading agent data:', err)
    } finally {
      setLoading(false)
    }
  }

  function timeAgo(isoStr?: string): string {
    if (!isoStr) return 'Nunca'
    const diff = Date.now() - new Date(isoStr).getTime()
    if (diff < 60000) return 'Hace menos de 1 min'
    if (diff < 3600000) return `Hace ${Math.round(diff / 60000)} min`
    if (diff < 86400000) return `Hace ${Math.round(diff / 3600000)}h`
    return `Hace ${Math.round(diff / 86400000)}d`
  }

  function getStatusBadge(status?: string) {
    const sc = status || 'unknown'
    const colors: Record<string, string> = {
      idle: 'bg-gray-100 text-gray-600',
      ok: 'bg-green-100 text-green-700',
      healthy: 'bg-green-100 text-green-700',
      deployed: 'bg-blue-100 text-blue-700',
      monitoring: 'bg-blue-100 text-blue-700',
      waiting: 'bg-yellow-100 text-yellow-700',
      promoted: 'bg-green-100 text-green-700',
      promoted_tier: 'bg-green-100 text-green-700',
      completed: 'bg-green-100 text-green-700',
      warning: 'bg-orange-100 text-orange-700',
      degraded: 'bg-orange-100 text-orange-700',
      blocked: 'bg-orange-100 text-orange-700',
      rollback: 'bg-red-100 text-red-700',
      critical: 'bg-red-100 text-red-700',
      error: 'bg-red-100 text-red-700',
    }
    return <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${colors[sc] || 'bg-gray-100 text-gray-500'}`}>{sc}</span>
  }

  const agentHistory = history.filter(h => h.agent_id === selectedAgent)

  // Build execution timeline
  const executionData = AGENTS.map(a => {
    const runs = history.filter(h => h.agent_id === a.id)
    return { agent: a.id, runs: runs.length, color: a.color }
  })

  return (
    <Layout title="Agentes Autonomos" backTo="/monitoring">
      {loading ? (
        <div className="flex justify-center py-20">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-mcl-blue" />
        </div>
      ) : (
        <div className="space-y-6">
          {/* ── Agent Status Cards ───────────────────────── */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {AGENTS.map(agent => {
              const state = states[agent.id] || {}
              return (
                <button key={agent.id} onClick={() => setSelectedAgent(agent.id)}
                  className={`text-left bg-white rounded-xl shadow-sm border p-4 transition-all ${
                    selectedAgent === agent.id ? 'border-mcl-blue ring-2 ring-mcl-blue/20' : 'border-gray-100 hover:shadow-md'
                  }`}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-bold text-gray-800">{agent.id}</span>
                    {getStatusBadge(state.last_status)}
                  </div>
                  <p className="text-xs text-gray-500">{agent.name}</p>
                  <p className="text-xs text-gray-400 mt-1">Horario: {agent.schedule}</p>
                  <p className="text-xs text-gray-400">Ultima ejecucion: {timeAgo(state.last_run)}</p>
                </button>
              )
            })}
          </div>

          {/* ── Selected Agent Detail ────────────────────── */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">
              Detalle: {selectedAgent} — {AGENTS.find(a => a.id === selectedAgent)?.name}
            </h3>

            {/* Agent-specific state */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
              {selectedAgent === 'ANDS' && (
                <>
                  <MiniCard label="Deployment Actual" value={states.ANDS?.current_deployment || 'Ninguno'} />
                  <MiniCard label="Fase" value={states.ANDS?.current_phase || '-'} />
                  <MiniCard label="Canary Tier" value={states.ANDS?.canary_tier || '-'} />
                  <MiniCard label="Completados" value={`${states.ANDS?.completed_deployments?.length || 0} / 8`} />
                </>
              )}
              {selectedAgent === 'ADMP' && (
                <>
                  <MiniCard label="Estado" value={states.ADMP?.last_status || '-'} />
                  <MiniCard label="Ultima Corrida" value={states.ADMP?.last_run?.slice(0, 16) || 'Nunca'} />
                  <MiniCard label="Baselines" value={states.ADMP?.baselines ? 'Activos' : 'Sin configurar'} />
                  <MiniCard label="Historial" value={`${agentHistory.length} corridas`} />
                </>
              )}
              {selectedAgent === 'AAID' && (
                <>
                  <MiniCard label="Orphans" value={String(states.AAID?.orphan_count ?? '-')}
                    warn={(states.AAID?.orphan_count || 0) > 0} />
                  <MiniCard label="Mismatches" value={String(states.AAID?.mismatch_count ?? '-')}
                    warn={(states.AAID?.mismatch_count || 0) > 0} />
                  <MiniCard label="Inconsistencias" value={String(states.AAID?.inconsistency_count ?? '-')}
                    warn={(states.AAID?.inconsistency_count || 0) > 0} />
                  <MiniCard label="Checks OK" value={
                    states.AAID?.checks_summary
                      ? `${states.AAID.checks_summary.ok}/${states.AAID.checks_summary.ok + states.AAID.checks_summary.warning + states.AAID.checks_summary.critical}`
                      : '-'
                  } />
                </>
              )}
            </div>

            {/* Raw state (collapsible) */}
            <details className="mt-4">
              <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-600">Ver estado completo (JSON)</summary>
              <pre className="mt-2 text-xs bg-gray-50 p-3 rounded-lg overflow-x-auto max-h-48 text-gray-600">
                {JSON.stringify(states[selectedAgent] || {}, null, 2)}
              </pre>
            </details>
          </div>

          {/* ── Execution History ─────────────────────────── */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">
              Historial de Ejecuciones — {selectedAgent} ({agentHistory.length} corridas en 30d)
            </h3>
            {agentHistory.length > 0 ? (
              <div className="space-y-2 max-h-80 overflow-y-auto">
                {agentHistory.map((h, i) => (
                  <div key={i} className="flex items-start gap-3 py-2 border-b border-gray-50 last:border-0">
                    <span className="text-xs text-gray-400 whitespace-nowrap min-w-[80px]">{h.date}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-700 whitespace-pre-wrap break-words">{h.summary || 'Sin resumen'}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-400 text-center py-6">No hay historial de ejecuciones. El agente aun no ha ejecutado.</p>
            )}
          </div>

          {/* ── Runs per Agent (Bar Chart) ────────────────── */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">Ejecuciones por Agente (30d)</h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={executionData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="agent" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="runs" name="Ejecuciones">
                  {executionData.map((entry, i) => (
                    <BarChart key={i}>
                      <Bar dataKey="runs" fill={entry.color} />
                    </BarChart>
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* ── ANDS Deploy Plan Progress ─────────────────── */}
          {selectedAgent === 'ANDS' && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">Plan de Despliegue — Progreso</h3>
              <div className="space-y-2">
                {[
                  { id: 'sol-1', name: 'useMemo AuthContext', risk: 'high' },
                  { id: 'sol-8', name: 'AWB Search Optimization', risk: 'high' },
                  { id: 'sol-16a', name: 'writeBatch airBilling', risk: 'medium' },
                  { id: 'sol-16b', name: 'writeBatch billing.ts', risk: 'medium' },
                  { id: 'sol-12', name: 'Buildup Promise.all', risk: 'medium' },
                  { id: 'sol-17', name: 'WSDashboard client_id filter', risk: 'medium' },
                  { id: 'sol-14a', name: 'Separate BookingList listener', risk: 'high' },
                  { id: 'sol-26', name: 'Parallelize Generate Sets', risk: 'medium' },
                ].map((step) => {
                  const completed = states.ANDS?.completed_deployments?.includes(step.id)
                  const isCurrent = states.ANDS?.current_deployment === step.name
                  return (
                    <div key={step.id} className={`flex items-center gap-3 px-3 py-2 rounded-lg ${
                      completed ? 'bg-green-50' : isCurrent ? 'bg-blue-50' : 'bg-gray-50'
                    }`}>
                      <span className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold ${
                        completed ? 'bg-green-500 text-white' :
                        isCurrent ? 'bg-blue-500 text-white animate-pulse' :
                        'bg-gray-300 text-gray-500'
                      }`}>{completed ? '\u2713' : isCurrent ? '\u25B6' : '\u2022'}</span>
                      <span className="text-xs font-medium text-gray-700 flex-1">{step.id}: {step.name}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                        step.risk === 'high' ? 'bg-red-100 text-red-600' : 'bg-yellow-100 text-yellow-600'
                      }`}>{step.risk}</span>
                      <span className={`text-[10px] ${
                        completed ? 'text-green-600' : isCurrent ? 'text-blue-600' : 'text-gray-400'
                      }`}>{completed ? 'completado' : isCurrent ? states.ANDS?.current_phase || 'activo' : 'pendiente'}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </Layout>
  )
}

function MiniCard({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={`rounded-lg border p-2.5 ${warn ? 'border-orange-200 bg-orange-50' : 'border-gray-100 bg-gray-50'}`}>
      <p className="text-[10px] text-gray-500 uppercase">{label}</p>
      <p className={`text-sm font-semibold ${warn ? 'text-orange-600' : 'text-gray-700'}`}>{value}</p>
    </div>
  )
}
