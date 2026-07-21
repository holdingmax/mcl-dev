import { useState, useEffect, useMemo } from 'react'
import { collection, query, orderBy, onSnapshot } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { buildMilestoneKeys } from '../../lib/wsTransportTracking'
import type { WSDeliveryTracking as WSTrackingType } from '../../types'
import Layout from '../../components/Layout'

type Tab = 'list' | 'detail'

export default function WSDeliveryTracking() {
  const [tab, setTab] = useState<Tab>('list')
  const [trackings, setTrackings] = useState<(WSTrackingType & { id: string })[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filterStatus, setFilterStatus] = useState<string>('all')
  const [search, setSearch] = useState('')

  useEffect(() => {
    const q = query(collection(db, 'ws_delivery_tracking'), orderBy('created_at', 'desc'))
    return onSnapshot(q, snap => {
      setTrackings(snap.docs.map(d => ({ ...d.data() as WSTrackingType, id: d.id })))
    })
  }, [])

  const filtered = useMemo(() => {
    return trackings.filter(t => {
      if (filterStatus !== 'all' && t.status !== filterStatus) return false
      if (search) {
        const s = search.toLowerCase()
        if (
          !(t.do_number || '').toLowerCase().includes(s) &&
          !(t.so_number || '').toLowerCase().includes(s) &&
          !(t.client_name || '').toLowerCase().includes(s) &&
          !(t.driver_name || '').toLowerCase().includes(s) &&
          !(t.vendor_name || '').toLowerCase().includes(s)
        ) return false
      }
      return true
    })
  }, [trackings, filterStatus, search])

  const selected = trackings.find(t => t.id === selectedId) || null

  function segmentMinutes(t: WSTrackingType, fromKey: string, toKey: string): number | null {
    const a = (t.milestones as Record<string, any>)?.[fromKey]
    const b = (t.milestones as Record<string, any>)?.[toKey]
    if (!a || !b) return null
    return Math.round((new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()) / 60000)
  }

  function fmtMin(mins: number | null): string {
    if (mins === null) return '-'
    if (mins < 60) return `${mins}m`
    return `${Math.floor(mins / 60)}h ${mins % 60}m`
  }

  const tabClass = (t: Tab) => `px-4 py-2 text-xs font-semibold rounded-t-lg ${tab === t ? 'bg-white border-b-2 border-emerald-700 text-emerald-700' : 'text-gray-400 hover:text-gray-600'}`

  return (
    <Layout title="WS Delivery Tracking" backTo="/warehouse-services">
      <div className="max-w-6xl mx-auto space-y-3">
        <div className="flex gap-1 border-b border-gray-200">
          <button className={tabClass('list')} onClick={() => setTab('list')}>Lista</button>
          <button className={tabClass('detail')} onClick={() => setTab('detail')}>Detalle</button>
        </div>

        {/* LIST TAB */}
        {tab === 'list' && (
          <div className="space-y-3">
            <div className="flex gap-2 flex-wrap">
              <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs">
                <option value="all">All Status</option>
                <option value="pending">Pending</option>
                <option value="in_progress">In Progress</option>
                <option value="completed">Completed</option>
              </select>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="DO#, SO#, cliente, driver..." className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs w-48" />
              <span className="text-xs text-gray-400 self-center">{filtered.length} tracking{filtered.length !== 1 ? 's' : ''}</span>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-gray-50 text-[10px] text-gray-500 uppercase">
                    <th className="px-3 py-2 text-left">DO#</th>
                    <th className="px-3 py-2 text-left">SO#</th>
                    <th className="px-3 py-2 text-left">Client</th>
                    <th className="px-3 py-2 text-left">Driver</th>
                    <th className="px-3 py-2 text-left">Trucking</th>
                    <th className="px-3 py-2 text-left">Route</th>
                    <th className="px-3 py-2 text-left">Status</th>
                    <th className="px-3 py-2 text-left">Created</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(t => (
                    <tr key={t.id} className="border-t border-gray-100 hover:bg-gray-50">
                      <td className="px-3 py-2 font-mono font-bold text-emerald-700">{t.do_number}</td>
                      <td className="px-3 py-2 font-mono text-gray-500">{t.so_number}</td>
                      <td className="px-3 py-2">{t.client_name}</td>
                      <td className="px-3 py-2">{t.driver_name}</td>
                      <td className="px-3 py-2">{t.vendor_name || '-'}</td>
                      <td className="px-3 py-2 text-[10px] text-gray-500 max-w-[150px] truncate">{t.pickup_from} &rarr; {t.deliver_to}</td>
                      <td className="px-3 py-2">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${
                          t.status === 'completed' ? 'bg-green-100 text-green-700' :
                          t.status === 'in_progress' ? 'bg-blue-100 text-blue-700' :
                          'bg-gray-100 text-gray-500'
                        }`}>{t.status}</span>
                      </td>
                      <td className="px-3 py-2 text-gray-400">{new Date(t.created_at).toLocaleDateString()}</td>
                      <td className="px-3 py-2">
                        <button onClick={() => { setSelectedId(t.id); setTab('detail') }} className="text-emerald-700 hover:underline text-xs">Ver</button>
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr><td colSpan={9} className="text-center py-8 text-gray-400">Sin resultados</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* DETAIL TAB */}
        {tab === 'detail' && (
          <div className="space-y-3">
            {!selected ? (
              <div className="text-center py-10 text-gray-400 text-sm">Selecciona un tracking de la lista</div>
            ) : (
              <>
                <div className="bg-white rounded-xl border border-gray-200 p-4">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs mb-4">
                    <div><span className="text-gray-400">DO#</span><br /><span className="font-bold font-mono">{selected.do_number}</span></div>
                    <div><span className="text-gray-400">SO#</span><br /><span className="font-mono">{selected.so_number}</span></div>
                    <div><span className="text-gray-400">Client</span><br /><span className="font-semibold">{selected.client_name}</span></div>
                    <div><span className="text-gray-400">Driver</span><br /><span className="font-semibold">{selected.driver_name}</span></div>
                    <div><span className="text-gray-400">Trucking</span><br /><span className="font-semibold">{selected.vendor_name || '-'}</span></div>
                    <div><span className="text-gray-400">PIN</span><br /><span className="font-mono font-bold">{selected.driver_pin}</span></div>
                    <div><span className="text-gray-400">Type</span><br /><span className="font-semibold uppercase">{selected.transport_type}</span>{selected.bup_count ? ` (${selected.bup_count} BUP)` : ''}</div>
                    <div><span className="text-gray-400">Cargo</span><br /><span className="font-semibold">{selected.total_pieces} pcs / {selected.total_weight} kg</span></div>
                  </div>

                  {/* Route */}
                  <div className="mb-4 p-3 bg-gray-50 rounded-lg text-xs">
                    <span className="text-gray-400 uppercase font-semibold">Route: </span>
                    <span className="font-semibold">{selected.pickup_from}</span>
                    {(selected.extra_stops || []).map((s, i) => (
                      <span key={i}> &rarr; <span className="text-amber-700">{s}</span></span>
                    ))}
                    <span> &rarr; <span className="font-semibold">{selected.deliver_to}</span></span>
                  </div>

                  {/* ULD numbers */}
                  {selected.uld_numbers && selected.uld_numbers.length > 0 && (
                    <div className="mb-4 flex gap-1.5 flex-wrap">
                      {selected.uld_numbers.map((u, i) => (
                        <span key={i} className="text-[10px] bg-blue-50 text-blue-700 border border-blue-200 rounded-full px-2 py-0.5 font-mono">{u}</span>
                      ))}
                    </div>
                  )}

                  {/* Timeline */}
                  <div className="text-xs font-semibold text-gray-500 uppercase mb-2">Timeline</div>
                  <div className="space-y-2">
                    {buildMilestoneKeys(selected.extra_stops || []).map(m => {
                      const ms = (selected.milestones as Record<string, any>)?.[m.key]
                      return (
                        <div key={m.key} className={`flex items-center justify-between p-2.5 rounded-lg ${ms ? 'bg-green-50' : 'bg-gray-50'}`}>
                          <div>
                            <span className={`text-xs font-semibold ${ms ? 'text-green-700' : 'text-gray-400'}`}>{m.label}</span>
                            {m.address && <span className="text-[10px] text-gray-400 ml-1">({m.address})</span>}
                            {ms && <span className="text-[10px] text-green-600 ml-2">{new Date(ms.timestamp).toLocaleString()}</span>}
                          </div>
                          <div className="flex items-center gap-2">
                            {ms?.gps && ms.gps.lat !== 0 && (
                              <a href={`https://maps.google.com/?q=${ms.gps.lat},${ms.gps.lng}`} target="_blank" rel="noopener noreferrer" className="text-[10px] text-emerald-700 hover:underline">GPS</a>
                            )}
                            {ms?.photo_urls?.length > 0 && (
                              <a href={ms.photo_urls[0]} target="_blank" rel="noopener noreferrer" className="text-[10px] text-emerald-700 hover:underline">Foto</a>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  {/* Delivery info */}
                  {selected.status === 'completed' && (
                    <div className="mt-4 p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs space-y-1">
                      <div className="font-semibold text-emerald-800">Entrega completada</div>
                      {selected.receiver_name && <div className="text-emerald-700">Receptor: {selected.receiver_name}</div>}
                      {selected.delivery_notes && <div className="text-emerald-700">Notas: {selected.delivery_notes}</div>}
                      {selected.delivery_photo_urls && selected.delivery_photo_urls.length > 0 && (
                        <div className="flex gap-2 mt-2">
                          {selected.delivery_photo_urls.map((url, i) => (
                            <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="w-16 h-16 rounded-lg overflow-hidden border border-emerald-200">
                              <img src={url} alt={`Delivery ${i + 1}`} className="w-full h-full object-cover" />
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Time segments */}
                  {selected.status === 'completed' && (() => {
                    const totalMin = segmentMinutes(selected, 'accepted', 'delivered')
                    const pickupMin = segmentMinutes(selected, 'accepted', 'loaded')
                    const transitMin = segmentMinutes(selected, 'loaded', 'delivered')
                    if (totalMin === null) return null
                    return (
                      <div className="mt-4 grid grid-cols-3 gap-3 text-center">
                        <div className="bg-gray-50 rounded-lg p-3">
                          <div className="text-[10px] text-gray-400 uppercase">Pickup</div>
                          <div className="text-sm font-bold text-gray-700">{fmtMin(pickupMin)}</div>
                        </div>
                        <div className="bg-gray-50 rounded-lg p-3">
                          <div className="text-[10px] text-gray-400 uppercase">Transit</div>
                          <div className="text-sm font-bold text-gray-700">{fmtMin(transitMin)}</div>
                        </div>
                        <div className="bg-emerald-50 rounded-lg p-3">
                          <div className="text-[10px] text-emerald-600 uppercase">Total</div>
                          <div className="text-sm font-bold text-emerald-700">{fmtMin(totalMin)}</div>
                        </div>
                      </div>
                    )
                  })()}
                </div>

                <button onClick={() => setTab('list')} className="text-xs text-gray-400 hover:text-gray-600">&larr; Volver a lista</button>
              </>
            )}
          </div>
        )}
      </div>
    </Layout>
  )
}
