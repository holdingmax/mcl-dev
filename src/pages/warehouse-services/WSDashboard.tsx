import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { collection, query, orderBy, onSnapshot } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import Layout from '../../components/Layout'
import type { WSServiceOrder, WSGlobalStatus } from '../../types'

const STATUS_LABELS: Record<WSGlobalStatus, string> = {
  requested: 'Requested',
  checked_in: 'Check-in',
  received: 'Received',
  in_progress: 'In Progress',
  completed: 'Completed',
  billed: 'Billed',
}

const STATUS_COLORS: Record<WSGlobalStatus, string> = {
  requested: 'bg-gray-100 text-gray-700',
  checked_in: 'bg-yellow-100 text-yellow-800',
  received: 'bg-blue-100 text-blue-800',
  in_progress: 'bg-orange-100 text-orange-800',
  completed: 'bg-green-100 text-green-800',
  billed: 'bg-purple-100 text-purple-800',
}

const SERVICE_LABELS: Record<string, string> = {
  screening_k9: 'Screening K9',
  screening_xray: 'Screening X-Ray',
  screening_manual: 'Screening Manual',
  transport: 'Transport',
  storage: 'Storage',
  in_out: 'In/Out',
  repack: 'Repack',
  dg_inspection: 'DG Inspection',
  handling_storage_fee: 'H&S Fee',
}

export default function WSDashboard() {
  const navigate = useNavigate()
  const { isClient, clientId } = useAuth()
  const [orders, setOrders] = useState<WSServiceOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<WSGlobalStatus | ''>('')

  useEffect(() => {
    const q = query(collection(db, 'warehouse_service_orders'), orderBy('created_at', 'desc'))
    const unsub = onSnapshot(q, snap => {
      let docs = snap.docs.map(d => ({ id: d.id, ...d.data() } as WSServiceOrder))
        .filter(o => !o.deleted_at)
      if (isClient && clientId) {
        docs = docs.filter(o => o.client_id === clientId)
      }
      setOrders(docs)
      setLoading(false)
    })
    return unsub
  }, [isClient, clientId])

  const filtered = orders.filter(o => {
    if (statusFilter && o.global_status !== statusFilter) return false
    if (search) {
      const s = search.toLowerCase()
      return (
        o.so_number.toLowerCase().includes(s) ||
        o.client_name.toLowerCase().includes(s) ||
        (o.awb_number || '').toLowerCase().includes(s) ||
        (o.reference || '').toLowerCase().includes(s)
      )
    }
    return true
  })

  // Stats
  const stats = {
    requested: orders.filter(o => o.global_status === 'requested').length,
    in_progress: orders.filter(o => ['checked_in', 'received', 'in_progress'].includes(o.global_status)).length,
    completed: orders.filter(o => o.global_status === 'completed').length,
    billed: orders.filter(o => o.global_status === 'billed').length,
  }

  return (
    <Layout title="Warehouse Services" backTo="/select">
      <div className="max-w-7xl mx-auto px-4 py-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-800">Service Orders</h1>
          <div className="flex gap-2">
            <button onClick={() => navigate('/warehouse-services/locate')} className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-3 py-2 rounded-lg">Locate</button>
            <button onClick={() => navigate('/warehouse-services/inventory')} className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-3 py-2 rounded-lg">Inventory</button>
            <button onClick={() => navigate('/warehouse-services/delivery-orders')} className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-3 py-2 rounded-lg">DOs</button>
            <button onClick={() => navigate('/warehouse-services/delivery-tracking')} className="text-xs bg-emerald-50 hover:bg-emerald-100 text-emerald-700 px-3 py-2 rounded-lg">Tracking</button>
            <button onClick={() => navigate('/warehouse-services/clients')} className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-3 py-2 rounded-lg">Clients</button>
            <button
              onClick={() => navigate('/warehouse-services/orders/new')}
              className="bg-mcl-blue text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-900 transition-colors"
            >
              + New Order
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
          <div className="bg-white rounded-xl shadow-sm border p-4">
            <div className="text-2xl font-bold text-gray-800">{stats.requested}</div>
            <div className="text-xs text-gray-500">Requested</div>
          </div>
          <div className="bg-white rounded-xl shadow-sm border p-4">
            <div className="text-2xl font-bold text-orange-600">{stats.in_progress}</div>
            <div className="text-xs text-gray-500">In Progress</div>
          </div>
          <div className="bg-white rounded-xl shadow-sm border p-4">
            <div className="text-2xl font-bold text-green-600">{stats.completed}</div>
            <div className="text-xs text-gray-500">Completed</div>
          </div>
          <div className="bg-white rounded-xl shadow-sm border p-4">
            <div className="text-2xl font-bold text-purple-600">{stats.billed}</div>
            <div className="text-xs text-gray-500">Billed</div>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3 mb-4">
          <input
            type="text"
            placeholder="Search SO, client, AWB..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
          />
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as WSGlobalStatus | '')}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
          >
            <option value="">All statuses</option>
            {Object.entries(STATUS_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>

        {/* Table */}
        {loading ? (
          <div className="text-center py-20 text-gray-400">Loading...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20 text-gray-400">
            {orders.length === 0 ? 'No service orders' : 'No results'}
          </div>
        ) : (
          <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left text-xs text-gray-500 uppercase">
                  <th className="px-4 py-3">SO #</th>
                  <th className="px-4 py-3">Client</th>
                  <th className="px-4 py-3">AWB</th>
                  <th className="px-4 py-3">Reference</th>
                  <th className="px-4 py-3">Services</th>
                  <th className="px-4 py-3">Pieces</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Date</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(o => (
                  <tr
                    key={o.id}
                    className="border-b border-gray-50 hover:bg-gray-50 cursor-pointer"
                    onClick={() => navigate(`/warehouse-services/orders/${o.id}`)}
                  >
                    <td className="px-4 py-3 font-mono font-bold text-mcl-blue">{o.so_number}</td>
                    <td className="px-4 py-3">{o.client_name}</td>
                    <td className="px-4 py-3 font-mono text-xs">{o.awb_number || '—'}</td>
                    <td className="px-4 py-3 text-xs text-gray-600">{o.reference || '—'}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {o.service_items.map(s => (
                          <span key={s.id} className="text-[10px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                            {SERVICE_LABELS[s.type] || s.type}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3">{o.declared_pieces}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-semibold px-2 py-1 rounded-full ${STATUS_COLORS[o.global_status]}`}>
                        {STATUS_LABELS[o.global_status]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {new Date(o.created_at).toLocaleDateString('es-CL')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Layout>
  )
}
