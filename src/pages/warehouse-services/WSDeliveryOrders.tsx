import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { collection, query, orderBy, onSnapshot, doc, deleteDoc, getDoc, updateDoc, getDocs } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import Layout from '../../components/Layout'

interface WSDeliveryOrder {
  id?: string
  do_number: string
  so_id: string
  so_number: string
  client_name: string
  driver_name: string
  trucking_company: string
  status: 'draft' | 'complete'
  created_at: string
}

export default function WSDeliveryOrders() {
  const navigate = useNavigate()
  const { isAdmin, isSuperAgent, isAccounting, isAgent, isCounter, isBodega } = useAuth()
  const canView = isAdmin || isSuperAgent || isAccounting || isAgent || isCounter || isBodega
  const [orders, setOrders] = useState<WSDeliveryOrder[]>([])
  const [trackingMap, setTrackingMap] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  useEffect(() => {
    const q = query(collection(db, 'ws_delivery_orders'), orderBy('created_at', 'desc'))
    const unsub = onSnapshot(q, snap => {
      setOrders(snap.docs.map(d => ({ id: d.id, ...d.data() } as WSDeliveryOrder)))
      setLoading(false)
    })
    // Load tracking statuses
    getDocs(collection(db, 'ws_delivery_tracking')).then(snap => {
      const tMap: Record<string, string> = {}
      for (const d of snap.docs) {
        const data = d.data()
        if (data.do_number) tMap[data.do_number] = data.status
      }
      setTrackingMap(tMap)
    }).catch(() => {})
    return unsub
  }, [])

  const filtered = orders.filter(o => {
    if (!search) return true
    const s = search.toLowerCase()
    return o.do_number.toLowerCase().includes(s)
      || o.so_number.toLowerCase().includes(s)
      || o.client_name.toLowerCase().includes(s)
      || o.trucking_company.toLowerCase().includes(s)
  })

  if (!canView) {
    return <Layout title="Delivery Orders" backTo="/warehouse-services"><p className="text-center text-gray-500 mt-10">Access restricted</p></Layout>
  }

  return (
    <Layout title="Delivery Orders — WS" backTo="/warehouse-services">
      <div className="max-w-5xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-800">Delivery Orders</h1>
          <button
            onClick={() => navigate('/warehouse-services/delivery-order/new')}
            className="bg-mcl-blue text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-900 transition-colors"
          >
            + New DO
          </button>
        </div>

        <input
          type="text"
          placeholder="Search DO, SO, client..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-64 mb-4 focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
        />

        {loading ? (
          <div className="text-center py-20 text-gray-400">Loading...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20 text-gray-400">No delivery orders</div>
        ) : (
          <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left text-xs text-gray-500 uppercase">
                  <th className="px-4 py-3">DO #</th>
                  <th className="px-4 py-3">SO</th>
                  <th className="px-4 py-3">Client</th>
                  <th className="px-4 py-3">Trucking</th>
                  <th className="px-4 py-3">Driver</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(o => (
                  <tr key={o.id} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono font-bold text-mcl-blue">{o.do_number}</td>
                    <td className="px-4 py-3 font-mono text-xs">{o.so_number}</td>
                    <td className="px-4 py-3">{o.client_name}</td>
                    <td className="px-4 py-3">{o.trucking_company}</td>
                    <td className="px-4 py-3">{o.driver_name || '—'}</td>
                    <td className="px-4 py-3">
                      {(() => {
                        const tStatus = trackingMap[o.do_number]
                        if (tStatus === 'completed') return <span className="text-xs font-semibold px-2 py-1 rounded-full bg-green-100 text-green-700">Completed</span>
                        if (tStatus === 'in_progress') return <span className="text-xs font-semibold px-2 py-1 rounded-full bg-blue-100 text-blue-700">In Progress</span>
                        if (tStatus === 'pending') return <span className="text-xs font-semibold px-2 py-1 rounded-full bg-amber-100 text-amber-700">Pending</span>
                        return <span className="text-xs font-semibold px-2 py-1 rounded-full bg-gray-100 text-gray-500">{o.status === 'complete' ? 'No Tracking' : 'Draft'}</span>
                      })()}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">{new Date(o.created_at).toLocaleDateString('es-CL')}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => navigate(`/warehouse-services/delivery-order/${o.id}`)}
                          className="text-gray-400 hover:text-mcl-blue"
                          title="View / Print"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                        </button>
                        <button
                          onClick={() => navigate(`/warehouse-services/delivery-order/new?edit=${o.id}`)}
                          className="text-gray-400 hover:text-mcl-blue"
                          title="Edit"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                        </button>
                        <button
                          onClick={async () => {
                            if (!confirm(`¿Está seguro de que desea eliminar ${o.do_number}? Esta acción no se puede deshacer.`)) return
                            // Remove DO reference from linked SO and revert transport status
                            if (o.so_id) {
                              const soRef = doc(db, 'warehouse_service_orders', o.so_id)
                              const soSnap = await getDoc(soRef)
                              if (soSnap.exists()) {
                                const soData = soSnap.data()
                                const revertedItems = (soData.service_items || []).map((item: Record<string, unknown>) => {
                                  if (item.type === 'transport' && item.status === 'completed') {
                                    return { ...item, status: 'pending', completed_at: null, completed_by: null }
                                  }
                                  if ((item.type === 'in_out' || item.type === 'storage') && item.status === 'completed' && soData.global_status === 'completed') {
                                    return { ...item, status: 'in_progress', completed_at: null, completed_by: null }
                                  }
                                  return item
                                })
                                await updateDoc(soRef, {
                                  do_id: null,
                                  do_number: null,
                                  service_items: revertedItems,
                                  global_status: soData.received_at ? 'in_progress' : soData.checked_in_at ? 'checked_in' : 'requested',
                                  completed_at: null,
                                })
                              }
                            }
                            await deleteDoc(doc(db, 'ws_delivery_orders', o.id!))
                          }}
                          className="text-gray-400 hover:text-red-600"
                          title="Delete"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                        </button>
                      </div>
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
