import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { collection, getDocs, query, orderBy, doc, deleteDoc, where } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { DeliveryOrder, DeliveryTracking } from '../../types'
import { legacyToMulti } from '../../lib/deliveryOrder'
import Layout from '../../components/Layout'

function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
}

function custodyLabel(method: string): string {
  if (method === 'seal') return 'Tamper Seal'
  if (method === 'escort') return 'Escort'
  if (method === 'locked_vehicle') return 'Locked Vehicle'
  return method || '—'
}

export default function AirfreightDeliveryOrders() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [orders, setOrders] = useState<(DeliveryOrder & { id: string })[]>([])
  const [trackingMap, setTrackingMap] = useState<Record<string, string>>({}) // do_number -> tracking status
  const [search, setSearch] = useState('')

  useEffect(() => {
    ;(async () => {
      try {
        const [doSnap, trackSnap] = await Promise.all([
          getDocs(query(collection(db, 'delivery_orders'), orderBy('created_at', 'desc'))),
          getDocs(collection(db, 'delivery_tracking')),
        ])
        const results: (DeliveryOrder & { id: string })[] = []
        for (const d of doSnap.docs) {
          const raw = { ...d.data() as DeliveryOrder, id: d.id }
          results.push(legacyToMulti(raw) as DeliveryOrder & { id: string })
        }
        setOrders(results)
        // Build tracking status map by do_number
        const tMap: Record<string, string> = {}
        for (const t of trackSnap.docs) {
          const data = t.data() as DeliveryTracking
          if (data.do_number) tMap[data.do_number] = data.status
        }
        setTrackingMap(tMap)
      } catch (err) {
        console.error('Error loading DOs:', err)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const filtered = useMemo(() => {
    if (!search.trim()) return orders
    const q = search.toLowerCase()
    return orders.filter(o => {
      const awbs = (o.awb_entries || []).map(e => e.awb_number || e.awb_1st_leg).join(' ').toLowerCase()
      const clients = (o.awb_entries || []).map(e => e.client_name).join(' ').toLowerCase()
      return (
        (o.do_number || '').toLowerCase().includes(q) ||
        awbs.includes(q) ||
        clients.includes(q) ||
        (o.trucking_company || '').toLowerCase().includes(q)
      )
    })
  }, [orders, search])

  function navigateToDo(o: DeliveryOrder & { id: string }) {
    navigate(`/airfreight/delivery-order/doc/${o.id}`)
  }

  async function handleDelete(o: DeliveryOrder & { id: string }) {
    const confirmed = window.confirm(`Eliminar ${o.do_number}? Esta accion no se puede deshacer.`)
    if (!confirmed) return
    try {
      await deleteDoc(doc(db, 'delivery_orders', o.id))
      setOrders(prev => prev.filter(x => x.id !== o.id))
    } catch (err) {
      console.error('Delete error:', err)
      alert('Error al eliminar: ' + (err as Error).message)
    }
  }

  return (
    <Layout title="Delivery Orders" backTo="/airfreight/awb-log">
      <div className="max-w-5xl mx-auto space-y-4">
        {/* Search + Nueva DO */}
        <div className="flex items-center gap-3">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar por DO#, AWB, cliente, trucking..."
            className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
          />
          <span className="text-xs text-gray-400">{filtered.length} DO{filtered.length !== 1 ? 's' : ''}</span>
          <button
            onClick={() => navigate('/airfreight/delivery-order/new')}
            className="px-3 py-2 bg-mcl-blue text-white text-sm font-semibold rounded-lg hover:bg-mcl-blue/90 transition-colors whitespace-nowrap"
          >
            + Nueva DO
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20 text-gray-400 text-sm">No se encontraron Delivery Orders</div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-xs text-gray-500 uppercase">
                    <th className="px-3 py-2.5 text-left">DO#</th>
                    <th className="px-3 py-2.5 text-left">Fecha</th>
                    <th className="px-3 py-2.5 text-left">AWBs</th>
                    <th className="px-3 py-2.5 text-left">Cliente(s)</th>
                    <th className="px-3 py-2.5 text-left">Trucking</th>
                    <th className="px-3 py-2.5 text-left">Custody</th>
                    <th className="px-3 py-2.5 text-center">Status</th>
                    <th className="px-3 py-2.5 text-center">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(o => {
                    const awbs = (o.awb_entries || []).map(e => e.awb_number || e.awb_1st_leg)
                    const clients = [...new Set((o.awb_entries || []).map(e => e.client_name))].join(', ')
                    return (
                      <tr
                        key={o.id}
                        className="border-t border-gray-100 hover:bg-blue-50/40 cursor-pointer transition-colors"
                        onClick={() => navigateToDo(o)}
                      >
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <span className="font-mono font-bold text-mcl-blue">{o.do_number}</span>
                          {(o as any).origin === 'bodega' && (
                            <span className="ml-1.5 inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-700 border border-amber-200">BOD</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">{fmtDate(o.created_at)}</td>
                        <td className="px-3 py-2.5">
                          <div className="flex flex-col gap-0.5">
                            {awbs.map((a, i) => (
                              <span key={i} className="font-mono text-xs">{a}</span>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-2.5">{clients || '—'}</td>
                        <td className="px-3 py-2.5">{o.trucking_company || '—'}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">{custodyLabel(o.custody_method)}</td>
                        <td className="px-3 py-2.5 text-center">
                          {(() => {
                            const tStatus = trackingMap[o.do_number]
                            if (tStatus === 'completed') return <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700">Completed</span>
                            if (tStatus === 'in_progress') return <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-700">In Progress</span>
                            if (tStatus === 'pending') return <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700">Pending</span>
                            return <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-500">{o.status === 'complete' ? 'No Tracking' : 'Draft'}</span>
                          })()}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <div className="flex items-center justify-center gap-3">
                            <button
                              onClick={(e) => { e.stopPropagation(); navigateToDo(o) }}
                              className="text-mcl-blue hover:underline text-xs font-semibold"
                            >
                              Abrir
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleDelete(o) }}
                              className="text-red-400 hover:text-red-600 text-xs font-semibold"
                            >
                              Eliminar
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Layout>
  )
}
