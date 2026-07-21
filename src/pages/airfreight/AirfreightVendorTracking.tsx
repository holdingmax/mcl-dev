import { useState, useEffect, useMemo } from 'react'
import { collection, query, where, orderBy, onSnapshot } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import { DeliveryTracking } from '../../types'
import { requestCorrection } from '../../lib/driverTracking'
import Layout from '../../components/Layout'

const MILESTONES = [
  { key: 'arrival_mcl', label: 'Arrival MCL' },
  { key: 'truck_loaded', label: 'Truck Loaded' },
  { key: 'arrival_airline', label: 'Arrival Airline' },
  { key: 'gate_assigned', label: 'Gate Assigned' },
  { key: 'unload_start', label: 'Unload Start' },
  { key: 'unload_end', label: 'Unload End' },
]

export default function AirfreightVendorTracking() {
  const { user, vendorId } = useAuth()
  const [trackings, setTrackings] = useState<(DeliveryTracking & { id: string })[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filterStatus, setFilterStatus] = useState<string>('all')

  // Correction modal
  const [correctionModal, setCorrectionModal] = useState<{ trackingId: string; milestone: string } | null>(null)
  const [corrNewTime, setCorrNewTime] = useState('')
  const [corrReason, setCorrReason] = useState('')

  useEffect(() => {
    if (!vendorId) return
    const q = query(
      collection(db, 'delivery_tracking'),
      where('vendor_id', '==', vendorId),
      orderBy('created_at', 'desc'),
    )
    return onSnapshot(q, snap => {
      setTrackings(snap.docs.map(d => ({ ...d.data() as DeliveryTracking, id: d.id })))
    })
  }, [vendorId])

  const filtered = useMemo(() => {
    if (filterStatus === 'all') return trackings
    return trackings.filter(t => t.status === filterStatus)
  }, [trackings, filterStatus])

  const selected = trackings.find(t => t.id === selectedId) || null

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

  return (
    <Layout title="My Deliveries" backTo="/airfreight/vendor-tracking">
      <div className="max-w-5xl mx-auto space-y-3">
        <div className="flex gap-2">
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs">
            <option value="all">All Status</option>
            <option value="pending">Pending</option>
            <option value="in_progress">In Progress</option>
            <option value="completed">Completed</option>
          </select>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* List */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 text-[10px] text-gray-500 uppercase">
                  <th className="px-3 py-2 text-left">DO#</th>
                  <th className="px-3 py-2 text-left">Driver</th>
                  <th className="px-3 py-2 text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(t => (
                  <tr key={t.id} className={`border-t border-gray-100 cursor-pointer hover:bg-gray-50 ${selectedId === t.id ? 'bg-blue-50' : ''}`} onClick={() => setSelectedId(t.id!)}>
                    <td className="px-3 py-2 font-mono font-bold">{t.do_number}</td>
                    <td className="px-3 py-2">{t.driver_name}</td>
                    <td className="px-3 py-2">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${
                        t.status === 'completed' ? 'bg-green-100 text-green-700' :
                        t.status === 'in_progress' ? 'bg-blue-100 text-blue-700' :
                        'bg-gray-100 text-gray-500'
                      }`}>{t.status}</span>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && <tr><td colSpan={3} className="text-center py-8 text-gray-400">Sin viajes</td></tr>}
              </tbody>
            </table>
          </div>

          {/* Detail */}
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            {!selected ? (
              <div className="text-center py-10 text-gray-400 text-sm">Selecciona un viaje</div>
            ) : (
              <div className="space-y-3">
                <div className="text-xs">
                  <span className="text-gray-400">DO#</span> <span className="font-bold">{selected.do_number}</span>
                  <span className="text-gray-400 ml-3">Airline</span> <span className="font-semibold ml-1">{selected.airline}</span>
                </div>
                <div className="space-y-2">
                  {MILESTONES.map(m => {
                    const ms = (selected.milestones as any)[m.key]
                    return (
                      <div key={m.key} className={`flex items-center justify-between p-2 rounded-lg ${ms ? 'bg-green-50' : 'bg-gray-50'}`}>
                        <div>
                          <span className={`text-xs font-semibold ${ms ? 'text-green-700' : 'text-gray-400'}`}>{m.label}</span>
                          {ms && <span className="text-[10px] text-green-600 ml-2">{new Date(ms.timestamp).toLocaleString()}</span>}
                        </div>
                        {ms && (
                          <button onClick={() => setCorrectionModal({ trackingId: selected.id!, milestone: m.key })} className="text-[10px] text-gray-400 hover:text-mcl-blue">Solicitar correccion</button>
                        )}
                      </div>
                    )
                  })}
                </div>
                {selected.corrections.length > 0 && (
                  <div className="mt-3">
                    <div className="text-xs font-semibold text-gray-500 mb-1">Mis correcciones</div>
                    {selected.corrections.map((c, i) => (
                      <div key={i} className="bg-gray-50 rounded p-2 text-[10px] mb-1">
                        <span className="font-semibold">{c.milestone}</span> — <span className={c.status === 'approved' ? 'text-green-600' : c.status === 'rejected' ? 'text-red-500' : 'text-yellow-600'}>{c.status}</span>
                        <div className="text-gray-400">{c.reason}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Correction Modal */}
      {correctionModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <h3 className="text-sm font-bold">Solicitar correccion: {correctionModal.milestone}</h3>
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
