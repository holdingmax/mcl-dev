import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { collection, getDocs, query, orderBy, doc, deleteDoc } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { PickupOrder } from '../../types'
import Layout from '../../components/Layout'

function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
}

export default function AirfreightPickupOrders() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [orders, setOrders] = useState<(PickupOrder & { id: string })[]>([])
  const [search, setSearch] = useState('')

  useEffect(() => {
    ;(async () => {
      try {
        const q = query(collection(db, 'pickup_orders'), orderBy('created_at', 'desc'))
        const snap = await getDocs(q)
        const results: (PickupOrder & { id: string })[] = snap.docs.map(d => ({
          ...d.data() as PickupOrder,
          id: d.id,
        }))
        setOrders(results)
      } catch (err) {
        console.error('Error loading PUOs:', err)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const filtered = useMemo(() => {
    if (!search.trim()) return orders
    const q = search.toLowerCase()
    return orders.filter(o => {
      const lineText = (o.lines || []).map(l =>
        `${l.client} ${l.awb} ${l.pmc}`
      ).join(' ').toLowerCase()
      return (
        (o.pu_number || '').toLowerCase().includes(q) ||
        lineText.includes(q) ||
        (o.trucking_company || '').toLowerCase().includes(q) ||
        (o.driver_name || '').toLowerCase().includes(q)
      )
    })
  }, [orders, search])

  async function handleDelete(o: PickupOrder & { id: string }) {
    const confirmed = window.confirm(`Delete ${o.pu_number}? This action cannot be undone.`)
    if (!confirmed) return
    try {
      await deleteDoc(doc(db, 'pickup_orders', o.id))
      setOrders(prev => prev.filter(x => x.id !== o.id))
    } catch (err) {
      console.error('Delete error:', err)
      alert('Error deleting: ' + (err as Error).message)
    }
  }

  return (
    <Layout title="Pick Up Orders" backTo="/airfreight/admin">
      <div className="max-w-5xl mx-auto space-y-4">
        {/* Search + New PUO */}
        <div className="flex items-center gap-3">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by PU#, AWB, client, trucking..."
            className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
          />
          <span className="text-xs text-gray-400">{filtered.length} PU{filtered.length !== 1 ? 's' : ''}</span>
          <button
            onClick={() => navigate('/airfreight/pickup-order/new')}
            className="px-3 py-2 bg-mcl-blue text-white text-sm font-semibold rounded-lg hover:bg-mcl-blue/90 transition-colors whitespace-nowrap"
          >
            + New PU
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20 text-gray-400 text-sm">No Pick Up Orders found</div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-xs text-gray-500 uppercase">
                    <th className="px-3 py-2.5 text-left">PU#</th>
                    <th className="px-3 py-2.5 text-left">Date</th>
                    <th className="px-3 py-2.5 text-left">Client(s)</th>
                    <th className="px-3 py-2.5 text-left">AWB(s)</th>
                    <th className="px-3 py-2.5 text-left">Trucking</th>
                    <th className="px-3 py-2.5 text-left">Driver</th>
                    <th className="px-3 py-2.5 text-center">Lines</th>
                    <th className="px-3 py-2.5 text-center">Status</th>
                    <th className="px-3 py-2.5 text-center">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(o => {
                    const clients = [...new Set((o.lines || []).map(l => l.client))].join(', ')
                    const awbs = (o.lines || []).map(l => l.awb)
                    return (
                      <tr
                        key={o.id}
                        className="border-t border-gray-100 hover:bg-blue-50/40 cursor-pointer transition-colors"
                        onClick={() => navigate(`/airfreight/pickup-order/${o.id}`)}
                      >
                        <td className="px-3 py-2.5 font-mono font-bold text-mcl-blue whitespace-nowrap">{o.pu_number}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">{fmtDate(o.created_at)}</td>
                        <td className="px-3 py-2.5">{clients || '—'}</td>
                        <td className="px-3 py-2.5">
                          <div className="flex flex-col gap-0.5">
                            {awbs.map((a, i) => (
                              <span key={i} className="font-mono text-xs">{a || '—'}</span>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-2.5">{o.trucking_company || '—'}</td>
                        <td className="px-3 py-2.5">{o.driver_name || '—'}</td>
                        <td className="px-3 py-2.5 text-center">{(o.lines || []).length}</td>
                        <td className="px-3 py-2.5 text-center">
                          <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${
                            o.status === 'complete' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
                          }`}>
                            {o.status === 'complete' ? 'Complete' : 'Draft'}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <div className="flex items-center justify-center gap-3">
                            <button
                              onClick={(e) => { e.stopPropagation(); navigate(`/airfreight/pickup-order/${o.id}`) }}
                              className="text-mcl-blue hover:underline text-xs font-semibold"
                            >
                              Open
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleDelete(o) }}
                              className="text-red-400 hover:text-red-600 text-xs font-semibold"
                            >
                              Delete
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
