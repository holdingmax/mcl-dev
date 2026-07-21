import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { doc, getDoc, collection, query, where, orderBy, limit, getDocs } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import Layout from '../../components/Layout'

/* ═══════════════════════════════════════════════════════════════
   MONITORING HUB — Dashboard Ejecutivo (para Diego)
   Estado general del sistema, agentes, despliegues, alertas
   ═══════════════════════════════════════════════════════════════ */

interface AgentState {
  last_run?: string
  last_status?: string
  updated_at?: any
  summary?: string
  [key: string]: any
}

interface MetricSnapshot {
  agent_id: string
  date: string
  metrics: any
  summary?: string
}

const AGENTS = [
  { id: 'ANDS', name: 'Despliegue Seguro', icon: '🚀', color: 'blue' },
  { id: 'ADMP', name: 'Monitoreo Performance', icon: '📊', color: 'green' },
  { id: 'AAID', name: 'Integridad de Datos', icon: '🔍', color: 'purple' },
]

const DASHBOARD_LINKS = [
  { to: '/monitoring/performance', title: 'Performance del Sistema', desc: 'Latencia, throughput, errores, queries lentas, Web Vitals', color: 'blue' },
  { to: '/monitoring/modules', title: 'Modulos Criticos', desc: 'Airfreight, Warehouse Services, Sea Freight, Billing', color: 'green' },
  { to: '/monitoring/agents', title: 'Agentes Autonomos', desc: 'Estado, ejecuciones, decisiones, logs de cada agente', color: 'purple' },
  { to: '/monitoring/deploys', title: 'Despliegues', desc: 'Canary tracking, comparacion de versiones, rollback', color: 'orange' },
  { to: '/monitoring/integrity', title: 'Integridad de Datos', desc: 'Orphans, billing mismatches, consistencia de referencias', color: 'red' },
]

export default function MonitoringHub() {
  const [agentStates, setAgentStates] = useState<Record<string, AgentState>>({})
  const [recentMetrics, setRecentMetrics] = useState<MetricSnapshot[]>([])
  const [recentDeploys, setRecentDeploys] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
    try {
      // Load agent states in parallel
      const statePromises = AGENTS.map(async (a) => {
        const snap = await getDoc(doc(db, '_agent_state', a.id))
        return { id: a.id, data: snap.exists() ? snap.data() as AgentState : {} }
      })

      // Load recent metrics
      const today = new Date().toISOString().slice(0, 10)
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
      const metricsQ = query(
        collection(db, '_metrics_daily'),
        where('date', '>=', yesterday),
        orderBy('date', 'desc'),
        limit(10),
      )

      // Load deploy history
      const deployQ = query(
        collection(db, '_deploy_history'),
        orderBy('created_at', 'desc'),
        limit(5),
      )

      const [stateResults, metricsSnap, deploySnap] = await Promise.all([
        Promise.all(statePromises),
        getDocs(metricsQ).catch(() => null),
        getDocs(deployQ).catch(() => null),
      ])

      const states: Record<string, AgentState> = {}
      stateResults.forEach(r => { states[r.id] = r.data })
      setAgentStates(states)

      if (metricsSnap) {
        setRecentMetrics(metricsSnap.docs.map(d => d.data() as MetricSnapshot))
      }
      if (deploySnap) {
        setRecentDeploys(deploySnap.docs.map(d => ({ id: d.id, ...d.data() })))
      }
    } catch (err) {
      console.error('Error loading monitoring data:', err)
    } finally {
      setLoading(false)
    }
  }

  function getStatusColor(status?: string) {
    if (!status) return 'gray'
    if (status === 'ok' || status === 'healthy' || status === 'idle' || status === 'promoted' || status === 'completed') return 'green'
    if (status === 'warning' || status === 'waiting' || status === 'deployed' || status === 'monitoring') return 'yellow'
    if (status === 'degraded' || status === 'blocked') return 'orange'
    if (status === 'critical' || status === 'error' || status === 'rollback') return 'red'
    return 'gray'
  }

  function getOverallStatus(): { label: string; color: string } {
    const statuses = AGENTS.map(a => agentStates[a.id]?.last_status)
    if (statuses.some(s => s === 'critical' || s === 'error' || s === 'rollback')) {
      return { label: 'CRITICO', color: 'red' }
    }
    if (statuses.some(s => s === 'degraded' || s === 'warning')) {
      return { label: 'DEGRADADO', color: 'orange' }
    }
    if (statuses.every(s => !s)) {
      return { label: 'SIN DATOS', color: 'gray' }
    }
    return { label: 'OPERATIVO', color: 'green' }
  }

  function timeAgo(isoStr?: string): string {
    if (!isoStr) return 'Nunca'
    const diff = Date.now() - new Date(isoStr).getTime()
    if (diff < 3600000) return `Hace ${Math.round(diff / 60000)} min`
    if (diff < 86400000) return `Hace ${Math.round(diff / 3600000)}h`
    return `Hace ${Math.round(diff / 86400000)}d`
  }

  const overall = getOverallStatus()

  return (
    <Layout title="Centro de Monitoreo" backTo="/select">
      {loading ? (
        <div className="flex justify-center py-20">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-mcl-blue" />
        </div>
      ) : (
        <div className="space-y-6">
          {/* ── Overall Status Banner ────────────────────────────── */}
          <div className={`rounded-xl p-6 border-2 ${
            overall.color === 'green' ? 'bg-green-50 border-green-200' :
            overall.color === 'orange' ? 'bg-orange-50 border-orange-200' :
            overall.color === 'red' ? 'bg-red-50 border-red-200' :
            'bg-gray-50 border-gray-200'
          }`}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wider">Estado General del Sistema</p>
                <p className={`text-3xl font-bold mt-1 ${
                  overall.color === 'green' ? 'text-green-700' :
                  overall.color === 'orange' ? 'text-orange-700' :
                  overall.color === 'red' ? 'text-red-700' :
                  'text-gray-500'
                }`}>{overall.label}</p>
              </div>
              <div className="text-right text-sm text-gray-500">
                <p>{new Date().toLocaleDateString('es', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
                <p className="mt-1">{new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}</p>
              </div>
            </div>
          </div>

          {/* ── Agent Status Cards ───────────────────────────────── */}
          <div>
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">Agentes Autonomos</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {AGENTS.map(agent => {
                const state = agentStates[agent.id] || {}
                const sc = getStatusColor(state.last_status)
                return (
                  <Link to="/monitoring/agents" key={agent.id}
                    className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 hover:shadow-md transition-shadow">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-lg">{agent.icon}</span>
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                        sc === 'green' ? 'bg-green-100 text-green-700' :
                        sc === 'yellow' ? 'bg-yellow-100 text-yellow-700' :
                        sc === 'orange' ? 'bg-orange-100 text-orange-700' :
                        sc === 'red' ? 'bg-red-100 text-red-700' :
                        'bg-gray-100 text-gray-500'
                      }`}>{state.last_status || 'sin datos'}</span>
                    </div>
                    <p className="font-semibold text-gray-800 text-sm">{agent.id}</p>
                    <p className="text-xs text-gray-500">{agent.name}</p>
                    <p className="text-xs text-gray-400 mt-2">{timeAgo(state.last_run)}</p>
                  </Link>
                )
              })}
            </div>
          </div>

          {/* ── Dashboard Navigation Grid ────────────────────────── */}
          <div>
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">Dashboards</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {DASHBOARD_LINKS.map(link => (
                <Link to={link.to} key={link.to}
                  className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 hover:shadow-md transition-shadow group">
                  <p className={`font-semibold text-sm group-hover:text-mcl-blue transition-colors ${
                    link.color === 'blue' ? 'text-blue-800' :
                    link.color === 'green' ? 'text-green-800' :
                    link.color === 'purple' ? 'text-purple-800' :
                    link.color === 'orange' ? 'text-orange-800' :
                    'text-red-800'
                  }`}>{link.title}</p>
                  <p className="text-xs text-gray-500 mt-1">{link.desc}</p>
                </Link>
              ))}
            </div>
          </div>

          {/* ── Recent Activity ───────────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Recent Metrics */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Metricas Recientes</h3>
              {recentMetrics.length === 0 ? (
                <p className="text-xs text-gray-400">No hay snapshots de metricas aun. Los agentes escribiran datos tras su primera ejecucion.</p>
              ) : (
                <div className="space-y-2">
                  {recentMetrics.slice(0, 5).map((m, i) => (
                    <div key={i} className="flex items-center justify-between py-1.5 border-b border-gray-50 last:border-0">
                      <div>
                        <span className="text-xs font-medium text-gray-700">{m.agent_id}</span>
                        <span className="text-xs text-gray-400 ml-2">{m.date}</span>
                      </div>
                      <p className="text-xs text-gray-500 max-w-[200px] truncate">{m.summary || '-'}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Recent Deploys */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Despliegues Recientes</h3>
              {recentDeploys.length === 0 ? (
                <p className="text-xs text-gray-400">No hay despliegues registrados aun. ANDS registrara eventos automaticamente.</p>
              ) : (
                <div className="space-y-2">
                  {recentDeploys.map((d, i) => (
                    <div key={i} className="flex items-center justify-between py-1.5 border-b border-gray-50 last:border-0">
                      <div>
                        <span className="text-xs font-medium text-gray-700">{d.name}</span>
                        <span className={`text-xs ml-2 px-1.5 py-0.5 rounded ${
                          d.action === 'rollback' ? 'bg-red-100 text-red-600' :
                          d.action?.includes('promote') ? 'bg-green-100 text-green-600' :
                          'bg-blue-100 text-blue-600'
                        }`}>{d.action}</span>
                      </div>
                      <p className="text-xs text-gray-400">{d.result}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ── Claude Daily Summary ──────────────────────────────── */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Resumen Diario (Claude AI)</h3>
            <div className="space-y-3">
              {AGENTS.map(agent => {
                const state = agentStates[agent.id]
                const latestMetric = recentMetrics.find(m => m.agent_id === agent.id)
                const summary = latestMetric?.summary || state?.summary || null
                return (
                  <div key={agent.id} className="border-l-2 border-gray-200 pl-3 py-1">
                    <p className="text-xs font-semibold text-gray-600">{agent.icon} {agent.id} — {agent.name}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{summary || 'Sin resumen disponible — el agente aun no ha ejecutado.'}</p>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}
