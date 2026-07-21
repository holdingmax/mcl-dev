import { useState, useEffect, useMemo } from 'react'
import { collection, query, orderBy, onSnapshot } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import { DeliveryTracking, TrackingCorrection, DeliveryOrder } from '../../types'
import { approveCorrection, requestCorrection } from '../../lib/driverTracking'
import Layout from '../../components/Layout'

const MILESTONES = [
  { key: 'arrival_mcl', label: 'Arrival MCL' },
  { key: 'truck_loaded', label: 'Truck Loaded' },
  { key: 'arrival_airline', label: 'Arrival Airline' },
  { key: 'gate_assigned', label: 'Gate Assigned' },
  { key: 'unload_start', label: 'Unload Start' },
  { key: 'unload_end', label: 'Unload End' },
]

const SEGMENTS = [
  { from: 'arrival_mcl', to: 'truck_loaded', label: 'Loading' },
  { from: 'truck_loaded', to: 'arrival_airline', label: 'Transit' },
  { from: 'arrival_airline', to: 'gate_assigned', label: 'Gate Wait' },
  { from: 'gate_assigned', to: 'unload_start', label: 'Pre-Unload' },
  { from: 'unload_start', to: 'unload_end', label: 'Unloading' },
  { from: 'arrival_mcl', to: 'unload_end', label: 'Total' },
]

type Tab = 'list' | 'detail' | 'kpis'

export default function AirfreightTracking() {
  const { user } = useAuth()
  const [tab, setTab] = useState<Tab>('list')
  const [trackings, setTrackings] = useState<(DeliveryTracking & { id: string })[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filterStatus, setFilterStatus] = useState<string>('all')
  const [filterAirline, setFilterAirline] = useState('')
  const [filterVendor, setFilterVendor] = useState('')
  const [filterClient, setFilterClient] = useState('')
  const [doClientMap, setDoClientMap] = useState<Record<string, string>>({})

  // Correction modal
  const [correctionModal, setCorrectionModal] = useState<{ trackingId: string; milestone: string } | null>(null)
  const [corrNewTime, setCorrNewTime] = useState('')
  const [corrReason, setCorrReason] = useState('')

  useEffect(() => {
    const q = query(collection(db, 'delivery_tracking'), orderBy('created_at', 'desc'))
    return onSnapshot(q, snap => {
      setTrackings(snap.docs.map(d => ({ ...d.data() as DeliveryTracking, id: d.id })))
    })
  }, [])

  useEffect(() => {
    const q = query(collection(db, 'delivery_orders'), orderBy('created_at', 'desc'))
    return onSnapshot(q, snap => {
      const map: Record<string, string> = {}
      snap.docs.forEach(d => {
        const data = d.data() as DeliveryOrder
        const clients = [...new Set((data.awb_entries || []).map(e => e.client_name).filter(Boolean))].join(', ')
        map[d.id] = clients
      })
      setDoClientMap(map)
    })
  }, [])

  const filtered = useMemo(() => {
    return trackings.filter(t => {
      if (filterStatus !== 'all' && t.status !== filterStatus) return false
      if (filterAirline && !t.airline.toLowerCase().includes(filterAirline.toLowerCase())) return false
      if (filterVendor && !t.vendor_name.toLowerCase().includes(filterVendor.toLowerCase())) return false
      if (filterClient) {
        const clients = (doClientMap[t.do_id] || '').toLowerCase()
        if (!clients.includes(filterClient.toLowerCase())) return false
      }
      return true
    })
  }, [trackings, filterStatus, filterAirline, filterVendor, filterClient, doClientMap])

  const selected = trackings.find(t => t.id === selectedId) || null

  function segmentMinutes(t: DeliveryTracking, from: string, to: string): number | null {
    const a = (t.milestones as any)[from]
    const b = (t.milestones as any)[to]
    if (!a || !b) return null
    return Math.round((new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()) / 60000)
  }

  // ── KPI calculations ──
  const kpiData = useMemo(() => {
    const completed = trackings.filter(t => t.status === 'completed')
    const byAirline: Record<string, { count: number; segments: Record<string, number[]> }> = {}
    const byVendor: Record<string, { count: number; segments: Record<string, number[]> }> = {}

    for (const t of completed) {
      for (const group of [
        { map: byAirline, key: t.airline || 'Unknown' },
        { map: byVendor, key: t.vendor_name || 'Unknown' },
      ]) {
        if (!group.map[group.key]) group.map[group.key] = { count: 0, segments: {} }
        group.map[group.key].count++
        for (const seg of SEGMENTS) {
          const mins = segmentMinutes(t, seg.from, seg.to)
          if (mins !== null) {
            if (!group.map[group.key].segments[seg.label]) group.map[group.key].segments[seg.label] = []
            group.map[group.key].segments[seg.label].push(mins)
          }
        }
      }
    }

    return { byAirline, byVendor }
  }, [trackings])

  function avg(arr: number[]): string {
    if (arr.length === 0) return '-'
    const v = arr.reduce((a, b) => a + b, 0) / arr.length
    return `${Math.round(v)}m`
  }

  async function handleCorrection() {
    if (!correctionModal || !corrNewTime || !corrReason) return
    const t = trackings.find(x => x.id === correctionModal.trackingId)
    if (!t) return
    const existing = (t.milestones as any)[correctionModal.milestone]
    await requestCorrection(correctionModal.trackingId, {
      milestone: correctionModal.milestone,
      old_timestamp: existing?.timestamp || '',
      new_timestamp: new Date(corrNewTime).toISOString(),
      reason: corrReason,
      requested_by: user?.email || '',
      requested_at: new Date().toISOString(),
    })
    setCorrectionModal(null)
    setCorrNewTime('')
    setCorrReason('')
  }

  const tabClass = (t: Tab) => `px-4 py-2 text-xs font-semibold rounded-t-lg ${tab === t ? 'bg-white border-b-2 border-mcl-blue text-mcl-blue' : 'text-gray-400 hover:text-gray-600'}`

  return (
    <Layout title="Delivery Tracking" backTo="/airfreight">
      <div className="max-w-6xl mx-auto space-y-3">
        <div className="flex gap-1 border-b border-gray-200">
          <button className={tabClass('list')} onClick={() => setTab('list')}>Lista</button>
          <button className={tabClass('detail')} onClick={() => setTab('detail')}>Detalle</button>
          <button className={tabClass('kpis')} onClick={() => setTab('kpis')}>KPIs</button>
        </div>

        {/* ── LIST TAB ── */}
        {tab === 'list' && (
          <div className="space-y-3">
            <div className="flex gap-2 flex-wrap">
              <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs">
                <option value="all">All Status</option>
                <option value="pending">Pending</option>
                <option value="in_progress">In Progress</option>
                <option value="completed">Completed</option>
              </select>
              <input value={filterAirline} onChange={e => setFilterAirline(e.target.value)} placeholder="Airline..." className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs w-32" />
              <input value={filterVendor} onChange={e => setFilterVendor(e.target.value)} placeholder="Vendor..." className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs w-32" />
              <input value={filterClient} onChange={e => setFilterClient(e.target.value)} placeholder="Cliente..." className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs w-32" />
            </div>
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-gray-50 text-[10px] text-gray-500 uppercase">
                    <th className="px-3 py-2 text-left">DO#</th>
                    <th className="px-3 py-2 text-left">Driver</th>
                    <th className="px-3 py-2 text-left">Vendor</th>
                    <th className="px-3 py-2 text-left">Airline</th>
                    <th className="px-3 py-2 text-left">Cliente</th>
                    <th className="px-3 py-2 text-left">Status</th>
                    <th className="px-3 py-2 text-left">Created</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(t => (
                    <tr key={t.id} className="border-t border-gray-100 hover:bg-gray-50">
                      <td className="px-3 py-2 font-mono font-bold">{t.do_number}</td>
                      <td className="px-3 py-2">{t.driver_name}</td>
                      <td className="px-3 py-2">{t.vendor_name || '-'}</td>
                      <td className="px-3 py-2">{t.airline}</td>
                      <td className="px-3 py-2">{doClientMap[t.do_id] || '-'}</td>
                      <td className="px-3 py-2">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${
                          t.status === 'completed' ? 'bg-green-100 text-green-700' :
                          t.status === 'in_progress' ? 'bg-blue-100 text-blue-700' :
                          'bg-gray-100 text-gray-500'
                        }`}>{t.status}</span>
                      </td>
                      <td className="px-3 py-2 text-gray-400">{new Date(t.created_at).toLocaleDateString()}</td>
                      <td className="px-3 py-2">
                        <button onClick={() => { setSelectedId(t.id!); setTab('detail') }} className="text-mcl-blue hover:underline text-xs">Ver</button>
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr><td colSpan={8} className="text-center py-8 text-gray-400">Sin resultados</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── DETAIL TAB ── */}
        {tab === 'detail' && (
          <div className="space-y-3">
            {!selected ? (
              <div className="text-center py-10 text-gray-400 text-sm">Selecciona un tracking de la lista</div>
            ) : (
              <>
                <div className="bg-white rounded-xl border border-gray-200 p-4">
                  <div className="grid grid-cols-3 gap-4 text-xs mb-4">
                    <div><span className="text-gray-400">DO#</span><br /><span className="font-bold">{selected.do_number}</span></div>
                    <div><span className="text-gray-400">Driver</span><br /><span className="font-semibold">{selected.driver_name}</span></div>
                    <div><span className="text-gray-400">Vendor</span><br /><span className="font-semibold">{selected.vendor_name || '-'}</span></div>
                    <div><span className="text-gray-400">Airline</span><br /><span className="font-semibold">{selected.airline}</span></div>
                    <div><span className="text-gray-400">Plate</span><br /><span className="font-semibold">{selected.driver_plate || '-'}</span></div>
                    <div><span className="text-gray-400">PIN</span><br /><span className="font-mono font-bold">{selected.driver_pin}</span></div>
                  </div>
                  <div className="text-xs font-semibold text-gray-500 uppercase mb-2">Timeline</div>
                  <div className="space-y-2">
                    {MILESTONES.map(m => {
                      const ms = (selected.milestones as any)[m.key]
                      return (
                        <div key={m.key} className={`flex items-center justify-between p-2 rounded-lg ${ms ? 'bg-green-50' : 'bg-gray-50'}`}>
                          <div>
                            <span className={`text-xs font-semibold ${ms ? 'text-green-700' : 'text-gray-400'}`}>{m.label}</span>
                            {ms && <span className="text-[10px] text-green-600 ml-2">{new Date(ms.timestamp).toLocaleString()}</span>}
                          </div>
                          <div className="flex items-center gap-2">
                            {ms?.gps && (
                              <a href={`https://maps.google.com/?q=${ms.gps.lat},${ms.gps.lng}`} target="_blank" rel="noopener noreferrer" className="text-[10px] text-mcl-blue hover:underline">GPS</a>
                            )}
                            {m.key === 'truck_loaded' && ms?.seal_photo_url && (
                              <a href={ms.seal_photo_url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-mcl-blue hover:underline">Foto sello</a>
                            )}
                            {ms && (
                              <button onClick={() => setCorrectionModal({ trackingId: selected.id!, milestone: m.key })} className="text-[10px] text-gray-400 hover:text-mcl-blue">Corregir</button>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* Corrections */}
                {selected.corrections.length > 0 && (
                  <div className="bg-white rounded-xl border border-gray-200 p-4">
                    <div className="text-xs font-semibold text-gray-500 uppercase mb-2">Correcciones</div>
                    <div className="space-y-2">
                      {selected.corrections.map((c, i) => (
                        <div key={i} className="bg-gray-50 rounded-lg p-3 text-xs space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="font-semibold">{c.milestone}</span>
                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${
                              c.status === 'approved' ? 'bg-green-100 text-green-700' :
                              c.status === 'rejected' ? 'bg-red-100 text-red-700' :
                              'bg-yellow-100 text-yellow-700'
                            }`}>{c.status}</span>
                          </div>
                          <div className="text-gray-400">Motivo: {c.reason}</div>
                          <div className="text-gray-400">Nuevo: {new Date(c.new_timestamp).toLocaleString()}</div>
                          <div className="text-gray-400">Por: {c.requested_by}</div>
                          {c.status === 'pending' && (
                            <div className="flex gap-2 pt-1">
                              <button onClick={() => approveCorrection(selected.id!, i, user?.email || '', true)} className="text-[10px] bg-green-500 text-white px-3 py-1 rounded font-semibold">Aprobar</button>
                              <button onClick={() => approveCorrection(selected.id!, i, user?.email || '', false)} className="text-[10px] bg-red-500 text-white px-3 py-1 rounded font-semibold">Rechazar</button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── KPIs TAB ── */}
        {tab === 'kpis' && (
          <div className="space-y-4">
            {[
              { title: 'Por Airline', data: kpiData.byAirline },
              { title: 'Por Vendor', data: kpiData.byVendor },
            ].map(group => (
              <div key={group.title} className="bg-white rounded-xl border border-gray-200 p-4">
                <div className="text-xs font-semibold text-gray-500 uppercase mb-3">{group.title}</div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-[10px] text-gray-500 uppercase bg-gray-50">
                        <th className="px-2 py-1.5 text-left">Name</th>
                        <th className="px-2 py-1.5 text-right">Trips</th>
                        {SEGMENTS.map(s => <th key={s.label} className="px-2 py-1.5 text-right">{s.label}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(group.data).map(([name, d]) => (
                        <tr key={name} className="border-t border-gray-100">
                          <td className="px-2 py-1.5 font-semibold">{name}</td>
                          <td className="px-2 py-1.5 text-right">{d.count}</td>
                          {SEGMENTS.map(s => (
                            <td key={s.label} className="px-2 py-1.5 text-right">{avg(d.segments[s.label] || [])}</td>
                          ))}
                        </tr>
                      ))}
                      {Object.keys(group.data).length === 0 && (
                        <tr><td colSpan={2 + SEGMENTS.length} className="text-center py-4 text-gray-400">Sin datos</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Correction Modal */}
      {correctionModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <h3 className="text-sm font-bold text-gray-800">Corregir: {correctionModal.milestone}</h3>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Nuevo timestamp</label>
              <input type="datetime-local" value={corrNewTime} onChange={e => setCorrNewTime(e.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Motivo</label>
              <textarea value={corrReason} onChange={e => setCorrReason(e.target.value)} rows={2} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setCorrectionModal(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Cancelar</button>
              <button onClick={handleCorrection} disabled={!corrNewTime || !corrReason} className="px-4 py-2 text-sm font-semibold bg-mcl-blue text-white rounded-lg disabled:opacity-50">Solicitar</button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}
