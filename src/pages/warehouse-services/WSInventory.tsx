import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { collection, query, where, onSnapshot } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import Layout from '../../components/Layout'
import type { WSServiceOrder } from '../../types'
import { fmtNum } from '../../lib/utils'

export default function WSInventory() {
  const navigate = useNavigate()
  const { isAdmin, isSuperAgent, isAccounting, isAgent, isCounter, isBodega } = useAuth()
  const canView = isAdmin || isSuperAgent || isAccounting || isAgent || isCounter || isBodega
  const [orders, setOrders] = useState<WSServiceOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  useEffect(() => {
    // All SOs with WR (cargo received) — cargo is in warehouse until POS or DO releases it
    const q = query(
      collection(db, 'warehouse_service_orders'),
      where('wr_id', '!=', null),
    )
    const unsub = onSnapshot(q, snap => {
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() } as WSServiceOrder))
      // Cargo still in warehouse = no POS generated yet
      const inWarehouse = docs.filter(o => !o.pod_at)
      setOrders(inWarehouse)
      setLoading(false)
    })
    return unsub
  }, [])

  function storageDays(o: WSServiceOrder): number {
    const storageItem = o.service_items.find(s => s.type === 'storage' || s.type === 'in_out')
    const startDate = o.received_at || o.created_at
    if (!startDate) return 0
    const start = new Date(startDate).getTime()
    const now = Date.now()
    return Math.max(1, Math.ceil((now - start) / 86400000))
  }

  function storageLocation(o: WSServiceOrder): string {
    const storageItem = o.service_items.find(s => s.type === 'storage' || s.type === 'in_out')
    return storageItem?.location || '—'
  }

  const filtered = orders.filter(o => {
    if (!search) return true
    const s = search.toLowerCase()
    return o.so_number.toLowerCase().includes(s)
      || o.client_name.toLowerCase().includes(s)
      || (o.awb_number || '').toLowerCase().includes(s)
  })

  if (!canView) {
    return <Layout title="Inventory" backTo="/warehouse-services"><p className="text-center text-gray-500 mt-10">Access restricted</p></Layout>
  }

  return (
    <Layout title="WS Inventory" backTo="/warehouse-services">
      <div className="max-w-5xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-800">Warehouse Inventory</h1>
          <div className="text-sm text-gray-500">{filtered.length} orden{filtered.length !== 1 ? 'es' : ''} en storage</div>
        </div>

        <input
          type="text"
          placeholder="Search SO, client, AWB..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-64 mb-4 focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
        />

        {loading ? (
          <div className="text-center py-20 text-gray-400">Loading...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20 text-gray-400">No cargo in warehouse</div>
        ) : (
          <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left text-xs text-gray-500 uppercase">
                  <th className="px-4 py-3">SO #</th>
                  <th className="px-4 py-3">Client</th>
                  <th className="px-4 py-3">AWB</th>
                  <th className="px-4 py-3">Pieces</th>
                  <th className="px-4 py-3">Weight</th>
                  <th className="px-4 py-3">Location</th>
                  <th className="px-4 py-3">Days</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Received</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(o => (
                  <tr key={o.id} className="border-b border-gray-50 hover:bg-gray-50 cursor-pointer" onClick={() => navigate(`/warehouse-services/orders/${o.id}`)}>
                    <td className="px-4 py-3 font-mono font-bold text-mcl-blue">{o.so_number}</td>
                    <td className="px-4 py-3">{o.client_name}</td>
                    <td className="px-4 py-3 font-mono text-xs">{o.awb_number || '—'}</td>
                    <td className="px-4 py-3">{o.declared_pieces}</td>
                    <td className="px-4 py-3">{o.declared_weight ? `${fmtNum(o.declared_weight, 1)} kg` : '—'}</td>
                    <td className="px-4 py-3 font-mono">{storageLocation(o)}</td>
                    <td className="px-4 py-3">
                      <span className={`font-bold ${storageDays(o) > 7 ? 'text-orange-600' : 'text-gray-800'}`}>
                        {storageDays(o)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-semibold px-2 py-1 rounded-full ${
                        o.global_status === 'completed' ? 'bg-green-100 text-green-700' :
                        o.global_status === 'in_progress' ? 'bg-orange-100 text-orange-700' :
                        'bg-blue-100 text-blue-700'
                      }`}>
                        {o.global_status === 'completed' ? 'Completed' : o.global_status === 'in_progress' ? 'In Progress' : 'Received'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {new Date(o.received_at || o.created_at).toLocaleDateString('es-CL')}
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
