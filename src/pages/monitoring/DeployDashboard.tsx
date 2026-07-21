import { useState, useEffect, useMemo } from 'react'
import { doc, getDoc, collection, query, orderBy, getDocs, limit } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import Layout from '../../components/Layout'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, PieChart, Pie, Cell,
} from 'recharts'

/* ═══════════════════════════════════════════════════════════════
   DEPLOY DASHBOARD
   Canary tracking, tier progression, rollback history, metrics
   ═══════════════════════════════════════════════════════════════ */

const CANARY_TIERS = ['mcl_only', 'agents', 'all_mcl', 'clients', 'complete']
const TIER_LABELS: Record<string, string> = {
  mcl_only: 'MCL Staff Only',
  agents: 'Agentes',
  all_mcl: 'Todo MCL',
  clients: 'Clientes',
  complete: 'Produccion Completa',
}
const TIER_TRAFFIC: Record<string, string> = {
  mcl_only: '~5%',
  agents: '~15%',
  all_mcl: '~40%',
  clients: '~80%',
  complete: '100%',
}

interface DeployEvent {
  id: string
  name: string
  action: string
  result: string
  agent: string
  status: string
  created_at: any
}

interface ANDSState {
  current_deployment?: string
  current_phase?: string
  canary_tier?: string
  completed_deployments?: string[]
  baseline_metrics?: Record<string, number>
  deploy_started_at?: string
  rollback_reason?: string
  canary_started_at?: string
  tier_promoted_at?: string
  [key: string]: any
}

export default function DeployDashboard() {
  const [andsState, setAndsState] = useState<ANDSState>({})
  const [featureFlags, setFeatureFlags] = useState<Record<string, any>>({})
  const [deployHistory, setDeployHistory] = useState<DeployEvent[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { loadData() }, [])

  async function loadData() {
    try {
      const [stateSnap, flagsSnap, histSnap] = await Promise.all([
        getDoc(doc(db, '_agent_state', 'ANDS')),
        getDoc(doc(db, 'config', 'feature_flags')),
        getDocs(query(collection(db, '_deploy_history'), orderBy('created_at', 'desc'), limit(50))).catch(() => null),
      ])

      setAndsState(stateSnap.exists() ? stateSnap.data() as ANDSState : {})
      setFeatureFlags(flagsSnap.exists() ? flagsSnap.data()! : {})

      if (histSnap) {
        setDeployHistory(histSnap.docs.map(d => ({ id: d.id, ...d.data() } as DeployEvent)))
      }
    } catch (err) {
      console.error('Error loading deploy data:', err)
    } finally {
      setLoading(false)
    }
  }

  // Canary tier visual position
  const currentTierIdx = andsState.canary_tier ? CANARY_TIERS.indexOf(andsState.canary_tier) : -1

  // Deploy outcomes distribution
  const outcomeData = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const d of deployHistory) {
      const action = d.action || 'unknown'
      counts[action] = (counts[action] || 0) + 1
    }
    return Object.entries(counts).map(([name, value]) => ({ name, value }))
  }, [deployHistory])

  const PALETTE = ['#16a34a', '#1e3a5f', '#ea580c', '#dc2626', '#9333ea', '#0891b2']

  // Baseline vs current comparison
  const baselineMetrics = andsState.baseline_metrics || {}
  const baselineComparison = Object.entries(baselineMetrics)
    .filter(([, v]) => typeof v === 'number')
    .slice(0, 10)
    .map(([key, value]) => ({ name: key.replace('count_', '').replace('airfreight_', 'air_'), baseline: value as number }))

  return (
    <Layout title="Despliegues" backTo="/monitoring">
      {loading ? (
        <div className="flex justify-center py-20">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-mcl-blue" />
        </div>
      ) : (
        <div className="space-y-6">
          {/* ── Current Deploy Status ────────────────────── */}
          <div className={`rounded-xl p-6 border-2 ${
            andsState.current_phase === 'rolled_back' ? 'bg-red-50 border-red-200' :
            andsState.current_phase === 'canary_active' ? 'bg-blue-50 border-blue-200' :
            andsState.current_phase === 'completed' ? 'bg-green-50 border-green-200' :
            'bg-gray-50 border-gray-200'
          }`}>
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wider">Deployment Activo</p>
                <p className="text-xl font-bold text-gray-800 mt-1">{andsState.current_deployment || 'Ninguno'}</p>
                <p className="text-sm text-gray-500 mt-1">Fase: <span className="font-medium">{andsState.current_phase || 'idle'}</span></p>
                {andsState.rollback_reason && (
                  <p className="text-sm text-red-600 mt-1">Rollback: {andsState.rollback_reason}</p>
                )}
              </div>
              <div className="text-right">
                <p className="text-xs text-gray-500">Completados: {andsState.completed_deployments?.length || 0} / 8</p>
                {andsState.deploy_started_at && (
                  <p className="text-xs text-gray-400 mt-1">Inicio: {new Date(andsState.deploy_started_at).toLocaleString('es')}</p>
                )}
              </div>
            </div>
          </div>

          {/* ── Canary Tier Progression ───────────────────── */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">Progresion Canary — Estado del Trafico</h3>
            <div className="flex items-center gap-1">
              {CANARY_TIERS.map((tier, i) => {
                const isActive = i === currentTierIdx
                const isPast = i < currentTierIdx
                const isFuture = i > currentTierIdx
                return (
                  <div key={tier} className="flex-1">
                    <div className={`h-3 rounded-full transition-colors ${
                      isPast ? 'bg-green-400' :
                      isActive ? 'bg-blue-500 animate-pulse' :
                      'bg-gray-200'
                    }`} />
                    <div className="mt-2 text-center">
                      <p className={`text-[10px] font-medium ${
                        isActive ? 'text-blue-700' : isPast ? 'text-green-600' : 'text-gray-400'
                      }`}>{TIER_LABELS[tier]}</p>
                      <p className={`text-[10px] ${
                        isActive ? 'text-blue-500' : isFuture ? 'text-gray-300' : 'text-green-400'
                      }`}>{TIER_TRAFFIC[tier]}</p>
                    </div>
                  </div>
                )
              })}
            </div>
            {currentTierIdx === -1 && (
              <p className="text-xs text-gray-400 text-center mt-4">No hay canary activo</p>
            )}
          </div>

          {/* ── Feature Flags ─────────────────────────────── */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Feature Flags Activos</h3>
            {Object.keys(featureFlags).length > 0 ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {Object.entries(featureFlags).map(([flag, value]) => (
                  <div key={flag} className={`rounded-lg border px-3 py-2 ${
                    value === true ? 'bg-green-50 border-green-200' :
                    value === false ? 'bg-gray-50 border-gray-200' :
                    'bg-blue-50 border-blue-200'
                  }`}>
                    <p className="text-xs font-mono text-gray-700">{flag}</p>
                    <p className={`text-xs font-medium mt-0.5 ${
                      value === true ? 'text-green-600' :
                      value === false ? 'text-gray-400' :
                      'text-blue-600'
                    }`}>{String(value)}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-400">No hay feature flags configurados</p>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* ── Deploy Outcomes ──────────────────────── */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">Resultados de Despliegues</h3>
              {outcomeData.length > 0 ? (
                <ResponsiveContainer width="100%" height={250}>
                  <PieChart>
                    <Pie dataKey="value" data={outcomeData} cx="50%" cy="50%" outerRadius={90}
                      label={({ name, value }) => `${name}: ${value}`}>
                      {outcomeData.map((_, i) => (
                        <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-xs text-gray-400 text-center py-8">Sin historial de despliegues</p>
              )}
            </div>

            {/* ── Baseline Metrics ─────────────────────── */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">Metricas Baseline (pre-deploy)</h3>
              {baselineComparison.length > 0 ? (
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={baselineComparison} margin={{ top: 4, right: 8, left: 0, bottom: 40 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" angle={-45} textAnchor="end" height={60} tick={{ fontSize: 9 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="baseline" fill="#1e3a5f" name="Baseline" />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-xs text-gray-400 text-center py-8">Sin baseline guardado. Se registra al iniciar un canary.</p>
              )}
            </div>
          </div>

          {/* ── Deploy History Table ──────────────────────── */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-700">Historial de Despliegues</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr>
                    <th className="text-left px-4 py-2 text-xs text-gray-500 font-medium">Nombre</th>
                    <th className="text-center px-4 py-2 text-xs text-gray-500 font-medium">Accion</th>
                    <th className="text-left px-4 py-2 text-xs text-gray-500 font-medium">Resultado</th>
                    <th className="text-center px-4 py-2 text-xs text-gray-500 font-medium">Estado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {deployHistory.length > 0 ? deployHistory.map((d, i) => (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="px-4 py-2 text-gray-700 text-xs">{d.name}</td>
                      <td className="px-4 py-2 text-center">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          d.action === 'rollback' ? 'bg-red-100 text-red-700' :
                          d.action?.includes('promote') ? 'bg-green-100 text-green-700' :
                          d.action === 'canary_started' ? 'bg-blue-100 text-blue-700' :
                          'bg-gray-100 text-gray-600'
                        }`}>{d.action}</span>
                      </td>
                      <td className="px-4 py-2 text-xs text-gray-500">{d.result}</td>
                      <td className="px-4 py-2 text-center">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${
                          d.status === 'rollback' ? 'bg-red-100 text-red-600' :
                          d.status === 'promoted' ? 'bg-green-100 text-green-600' :
                          'bg-gray-100 text-gray-500'
                        }`}>{d.status}</span>
                      </td>
                    </tr>
                  )) : (
                    <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-400 text-xs">
                      Sin eventos de despliegue. ANDS registrara eventos automaticamente.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}
