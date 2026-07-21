import { useState, useEffect, useMemo } from 'react'
import { collection, query, where, orderBy, onSnapshot, getDocs, doc, getDoc } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import type { AvDeliveryOrder, AvFlightAwb, DeliveryTracking } from '../../types'
import { approveCorrection, requestCorrection } from '../../lib/driverTracking'
import { buildAvDoHtml, openAvDoPrint } from '../../lib/avDeliveryOrderPdf'
import { buildAvTransferHtml, openAvTransferPrint } from '../../lib/avTransferCustodyPdf'
import type { AvPalletTag } from '../../types'
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

// Unified row: every AV DO appears, enriched with tracking data if dispatched
interface UnifiedRow {
  doId: string
  do_number: string
  do_status: string
  flight_number: string
  uld_numbers: string[]
  awb_numbers: string[]
  trucking_company: string
  driver_name: string
  driver_pin: string
  custody_method: string
  seal_number: string
  created_at: string
  tracking: (DeliveryTracking & { id: string }) | null
}

export default function AvDeliveryTracking() {
  const { user } = useAuth()
  const [tab, setTab] = useState<Tab>('list')
  const [rows, setRows] = useState<UnifiedRow[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedDoNumber, setSelectedDoNumber] = useState<string | null>(null)
  const [filterStatus, setFilterStatus] = useState<string>('all')
  const [filterSearch, setFilterSearch] = useState('')

  // Print cache
  const [flightCache, setFlightCache] = useState<Record<string, { awbs: (AvFlightAwb & { id: string })[]; destination: string }>>({})

  // Correction modal
  const [correctionModal, setCorrectionModal] = useState<{ trackingId: string; milestone: string } | null>(null)
  const [corrNewTime, setCorrNewTime] = useState('')
  const [corrReason, setCorrReason] = useState('')

  useEffect(() => {
    // Listen to all AV delivery orders
    const unsubDos = onSnapshot(
      query(collection(db, 'av_delivery_orders'), orderBy('created_at', 'desc')),
      doSnap => {
        const doList = doSnap.docs.map(d => ({ id: d.id, ...d.data() } as AvDeliveryOrder & { id: string }))

        // Listen to Avianca trackings
        const unsubTrack = onSnapshot(
          query(collection(db, 'delivery_tracking'), where('airline', '==', 'Avianca')),
          trackSnap => {
            const trackMap = new Map<string, DeliveryTracking & { id: string }>()
            trackSnap.docs.forEach(d => {
              const data = { ...d.data() as DeliveryTracking, id: d.id }
              trackMap.set(data.do_number, data)
            })

            const unified: UnifiedRow[] = doList.map(doItem => {
              const tracking = trackMap.get(doItem.do_number) || null
              return {
                doId: doItem.id,
                do_number: doItem.do_number,
                do_status: doItem.status,
                flight_number: doItem.flight_number,
                uld_numbers: doItem.uld_numbers,
                awb_numbers: doItem.awb_numbers,
                trucking_company: doItem.trucking_company || '',
                driver_name: doItem.driver_name || '',
                driver_pin: (doItem as any).driver_pin || '',
                custody_method: doItem.custody_method || '',
                seal_number: doItem.seal_number || '',
                created_at: doItem.created_at,
                tracking,
              }
            })

            setRows(unified)
            setLoading(false)
          }
        )

        // Return cleanup for tracking listener
        return () => unsubTrack()
      }
    )

    return () => unsubDos()
  }, [])

  const filtered = useMemo(() => {
    return rows.filter(r => {
      // Status filter
      if (filterStatus === 'draft' && r.do_status !== 'draft') return false
      if (filterStatus === 'dispatched' && r.do_status !== 'dispatched') return false
      if (filterStatus === 'in_progress' && r.tracking?.status !== 'in_progress') return false
      if (filterStatus === 'completed' && r.tracking?.status !== 'completed') return false

      // Search filter
      if (filterSearch) {
        const s = filterSearch.toLowerCase()
        const match = r.do_number.toLowerCase().includes(s) ||
          r.driver_name.toLowerCase().includes(s) ||
          r.trucking_company.toLowerCase().includes(s) ||
          r.flight_number.toLowerCase().includes(s) ||
          r.uld_numbers.some(u => u.toLowerCase().includes(s)) ||
          r.awb_numbers.some(a => a.toLowerCase().includes(s))
        if (!match) return false
      }

      return true
    })
  }, [rows, filterStatus, filterSearch])

  const selected = rows.find(r => r.do_number === selectedDoNumber) || null

  function getDisplayStatus(r: UnifiedRow): { label: string; cls: string } {
    if (r.do_status === 'draft') return { label: 'Draft', cls: 'bg-amber-100 text-amber-700' }
    if (r.tracking?.status === 'completed') return { label: 'Completed', cls: 'bg-green-100 text-green-700' }
    if (r.tracking?.status === 'in_progress') return { label: 'In Progress', cls: 'bg-blue-100 text-blue-700' }
    return { label: 'Dispatched', cls: 'bg-blue-100 text-blue-700' }
  }

  function segmentMinutes(t: DeliveryTracking, from: string, to: string): number | null {
    const a = (t.milestones as any)[from]
    const b = (t.milestones as any)[to]
    if (!a || !b) return null
    return Math.round((new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()) / 60000)
  }

  const kpiData = useMemo(() => {
    const completed = rows.filter(r => r.tracking?.status === 'completed').map(r => r.tracking!)
    const byVendor: Record<string, { count: number; segments: Record<string, number[]> }> = {}

    for (const t of completed) {
      const key = t.vendor_name || 'Unknown'
      if (!byVendor[key]) byVendor[key] = { count: 0, segments: {} }
      byVendor[key].count++
      for (const seg of SEGMENTS) {
        const mins = segmentMinutes(t, seg.from, seg.to)
        if (mins !== null) {
          if (!byVendor[key].segments[seg.label]) byVendor[key].segments[seg.label] = []
          byVendor[key].segments[seg.label].push(mins)
        }
      }
    }

    return { byVendor }
  }, [rows])

  function avg(arr: number[]): string {
    if (arr.length === 0) return '-'
    return `${Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)}m`
  }

  async function handlePrint(r: UnifiedRow) {
    if (r.do_status === 'draft') return
    // Open window immediately in user-gesture context to avoid popup blocker
    const win = window.open('', '_blank')
    if (!win) { alert('Popup bloqueado. Permite popups para este sitio.'); return }
    win.document.write('<p style="font-family:Arial;color:#888;padding:40px;">Cargando documento...</p>')

    let cached = flightCache[r.flight_number]
    if (!cached) {
      const flightSnap = await getDocs(query(collection(db, 'av_flights'), where('flight_number', '==', r.flight_number)))
      let destination = ''
      let awbs: (AvFlightAwb & { id: string })[] = []
      if (!flightSnap.empty) {
        const flightDoc = flightSnap.docs[0]
        destination = flightDoc.data().destination || ''
        const awbSnap = await getDocs(query(collection(db, 'av_flight_awbs'), where('flight_id', '==', flightDoc.id)))
        awbs = awbSnap.docs.map(d => ({ id: d.id, ...d.data() } as AvFlightAwb & { id: string })).filter(a => a.status !== 'removed')
      }
      cached = { awbs, destination }
      setFlightCache(prev => ({ ...prev, [r.flight_number]: cached }))
    }
    const doSnap = await getDoc(doc(db, 'av_delivery_orders', r.doId))
    const doData = { id: r.doId, ...doSnap.data() } as AvDeliveryOrder & { id: string; driver_pin?: string; dispatched_by?: string }
    const html = buildAvDoHtml({ doData, awbs: cached.awbs, destination: cached.destination })
    const baseUrl = window.location.origin
    const resolved = html.replace(/src="\/logo\.png"/g, `src="${baseUrl}/logo.png"`)
    win.document.open()
    win.document.write(resolved)
    win.document.close()
    win.document.title = `DO ${r.do_number}`
  }

  async function handleTransferPrint(r: UnifiedRow) {
    if (r.do_status === 'draft') return
    // Open window immediately to avoid popup blocker
    const win = window.open('', '_blank')
    if (!win) { alert('Popup bloqueado. Permite popups para este sitio.'); return }
    win.document.write('<p style="font-family:Arial;color:#888;padding:40px;">Cargando documento...</p>')

    let cached = flightCache[r.flight_number]
    if (!cached) {
      const flightSnap = await getDocs(query(collection(db, 'av_flights'), where('flight_number', '==', r.flight_number)))
      let destination = ''
      let awbs: (AvFlightAwb & { id: string })[] = []
      if (!flightSnap.empty) {
        const flightDoc = flightSnap.docs[0]
        destination = flightDoc.data().destination || ''
        const awbSnap = await getDocs(query(collection(db, 'av_flight_awbs'), where('flight_id', '==', flightDoc.id)))
        awbs = awbSnap.docs.map(d => ({ id: d.id, ...d.data() } as AvFlightAwb & { id: string })).filter(a => a.status !== 'removed')
      }
      cached = { awbs, destination }
      setFlightCache(prev => ({ ...prev, [r.flight_number]: cached }))
    }
    const doSnap = await getDoc(doc(db, 'av_delivery_orders', r.doId))
    const doData = { id: r.doId, ...doSnap.data() } as AvDeliveryOrder & { id: string; driver_pin?: string; dispatched_by?: string }
    // Get pallet tags for this flight
    const flightSnap2 = await getDocs(query(collection(db, 'av_flights'), where('flight_number', '==', r.flight_number)))
    let palletTags: { uld_id: string; awb_number: string; pieces: number }[] = []
    if (!flightSnap2.empty) {
      const ptSnap = await getDocs(query(collection(db, 'av_pallet_tags'), where('flight_id', '==', flightSnap2.docs[0].id)))
      const pts = ptSnap.docs.map(d => d.data() as AvPalletTag)
      palletTags = pts
        .filter(pt => (doData.uld_numbers || []).includes(pt.pallet_number))
        .flatMap(pt => (pt.lines || []).map(l => ({ uld_id: pt.pallet_number, awb_number: l.awb_number, pieces: l.pieces || 0 })))
    }
    const html = buildAvTransferHtml({ doData, destination: cached.destination, palletTags })
    win.document.open()
    win.document.write(html)
    win.document.close()
    win.document.title = `Transfer ${r.do_number}`
  }

  async function handleCorrection() {
    if (!correctionModal || !corrNewTime || !corrReason) return
    await requestCorrection(correctionModal.trackingId, {
      milestone: correctionModal.milestone,
      old_timestamp: '',
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

  if (loading) return <Layout title="Avianca — Delivery Tracking" backTo="/avianca/config"><div className="flex justify-center py-20"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" /></div></Layout>

  return (
    <Layout title="Avianca — Delivery Tracking" backTo="/avianca/config">
      <div className="max-w-6xl mx-auto space-y-3">
        <div className="flex gap-1 border-b border-gray-200">
          <button className={tabClass('list')} onClick={() => setTab('list')}>Lista</button>
          <button className={tabClass('detail')} onClick={() => setTab('detail')}>Detalle</button>
          <button className={tabClass('kpis')} onClick={() => setTab('kpis')}>KPIs</button>
        </div>

        {/* LIST TAB */}
        {tab === 'list' && (
          <div className="space-y-3">
            <div className="flex gap-2 flex-wrap">
              <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs">
                <option value="all">All Status</option>
                <option value="draft">Draft</option>
                <option value="dispatched">Dispatched</option>
                <option value="in_progress">In Progress</option>
                <option value="completed">Completed</option>
              </select>
              <input value={filterSearch} onChange={e => setFilterSearch(e.target.value)} placeholder="DO#, driver, trucking, vuelo..." className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs w-48" />
              <span className="text-[10px] text-gray-400 self-center ml-auto">{filtered.length} de {rows.length} DOs</span>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-gray-50 text-[10px] text-gray-500 uppercase">
                    <th className="px-3 py-2 text-left">DO#</th>
                    <th className="px-3 py-2 text-left">Vuelo</th>
                    <th className="px-3 py-2 text-left">ULDs</th>
                    <th className="px-3 py-2 text-left">Trucking</th>
                    <th className="px-3 py-2 text-left">Driver</th>
                    <th className="px-3 py-2 text-left">PIN</th>
                    <th className="px-3 py-2 text-left">Status</th>
                    <th className="px-3 py-2 text-left">Fecha</th>
                    <th className="px-3 py-2"></th>
                    <th className="px-3 py-2"></th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(r => {
                    const st = getDisplayStatus(r)
                    return (
                      <tr key={r.doId} className="border-t border-gray-100 hover:bg-gray-50">
                        <td className="px-3 py-2 font-mono font-bold">{r.do_number}</td>
                        <td className="px-3 py-2 text-gray-600">{r.flight_number}</td>
                        <td className="px-3 py-2 font-mono text-gray-600 text-[10px]">{r.uld_numbers.length} ULDs</td>
                        <td className="px-3 py-2">{r.trucking_company || <span className="text-gray-300">—</span>}</td>
                        <td className="px-3 py-2">{r.driver_name || <span className="text-gray-300">—</span>}</td>
                        <td className="px-3 py-2 font-mono font-bold text-mcl-blue">{r.driver_pin || <span className="text-gray-300">—</span>}</td>
                        <td className="px-3 py-2">
                          <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${st.cls}`}>{st.label}</span>
                        </td>
                        <td className="px-3 py-2 text-gray-400">{new Date(r.created_at).toLocaleDateString()}</td>
                        <td className="px-3 py-2">
                          {r.tracking && (
                            <button onClick={() => { setSelectedDoNumber(r.do_number); setTab('detail') }} className="text-mcl-blue hover:underline text-xs">Ver</button>
                          )}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {r.do_status === 'draft' ? (
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 inline text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" /></svg>
                          ) : (
                            <button onClick={() => handlePrint(r)} title="Imprimir DO">
                              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 inline text-gray-800 hover:text-mcl-blue" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" /></svg>
                            </button>
                          )}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {r.do_status === 'draft' ? (
                            <span className="text-[9px] font-black text-gray-300">T.AV</span>
                          ) : (
                            <button onClick={() => handleTransferPrint(r)} title="Transferencia Avianca" className="flex items-center gap-0.5 text-red-700 hover:text-red-500">
                              <span className="text-[9px] font-black leading-none">T.AV</span>
                              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4H7v4a2 2 0 002 2zm0-16h6a2 2 0 012 2v2H7V5a2 2 0 012-2z"/></svg>
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                  {filtered.length === 0 && (
                    <tr><td colSpan={11} className="text-center py-8 text-gray-400">Sin DOs</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* DETAIL TAB */}
        {tab === 'detail' && (
          <div className="space-y-3">
            {!selected || !selected.tracking ? (
              <div className="text-center py-10 text-gray-400 text-sm">
                {!selected ? 'Selecciona un tracking de la lista' : 'Esta DO aun no ha sido despachada — no tiene timeline'}
              </div>
            ) : (
              <>
                <div className="bg-white rounded-xl border border-gray-200 p-4">
                  <div className="grid grid-cols-3 gap-4 text-xs mb-4">
                    <div><span className="text-gray-400">DO#</span><br /><span className="font-bold">{selected.do_number}</span></div>
                    <div><span className="text-gray-400">Vuelo</span><br /><span className="font-semibold">{selected.flight_number}</span></div>
                    <div><span className="text-gray-400">Trucking</span><br /><span className="font-semibold">{selected.trucking_company || '-'}</span></div>
                    <div><span className="text-gray-400">Driver</span><br /><span className="font-semibold">{selected.driver_name || '-'}</span></div>
                    <div><span className="text-gray-400">PIN</span><br /><span className="font-mono font-bold">{selected.driver_pin}</span></div>
                    <div><span className="text-gray-400">Status</span><br /><span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${getDisplayStatus(selected).cls}`}>{getDisplayStatus(selected).label}</span></div>
                  </div>

                  {/* ULDs */}
                  <div className="flex flex-wrap gap-1.5 mb-4">
                    {selected.uld_numbers.map(u => (
                      <span key={u} className="inline-block px-2 py-0.5 rounded text-[11px] font-mono bg-blue-50 text-blue-700 border border-blue-200">{u}</span>
                    ))}
                  </div>

                  <div className="text-xs font-semibold text-gray-500 uppercase mb-2">Timeline</div>
                  <div className="space-y-2">
                    {MILESTONES.map(m => {
                      const ms = (selected.tracking!.milestones as any)[m.key]
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
                              <button onClick={() => setCorrectionModal({ trackingId: selected.tracking!.id!, milestone: m.key })} className="text-[10px] text-gray-400 hover:text-mcl-blue">Corregir</button>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>

                {selected.tracking.corrections.length > 0 && (
                  <div className="bg-white rounded-xl border border-gray-200 p-4">
                    <div className="text-xs font-semibold text-gray-500 uppercase mb-2">Correcciones</div>
                    <div className="space-y-2">
                      {selected.tracking.corrections.map((c, i) => (
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
                              <button onClick={() => approveCorrection(selected.tracking!.id!, i, user?.email || '', true)} className="text-[10px] bg-green-500 text-white px-3 py-1 rounded font-semibold">Aprobar</button>
                              <button onClick={() => approveCorrection(selected.tracking!.id!, i, user?.email || '', false)} className="text-[10px] bg-red-500 text-white px-3 py-1 rounded font-semibold">Rechazar</button>
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

        {/* KPIs TAB */}
        {tab === 'kpis' && (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="text-xs font-semibold text-gray-500 uppercase mb-3">Por Trucking Company</div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] text-gray-500 uppercase bg-gray-50">
                      <th className="px-2 py-1.5 text-left">Company</th>
                      <th className="px-2 py-1.5 text-right">Trips</th>
                      {SEGMENTS.map(s => <th key={s.label} className="px-2 py-1.5 text-right">{s.label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(kpiData.byVendor).map(([name, d]) => (
                      <tr key={name} className="border-t border-gray-100">
                        <td className="px-2 py-1.5 font-semibold">{name}</td>
                        <td className="px-2 py-1.5 text-right">{d.count}</td>
                        {SEGMENTS.map(s => (
                          <td key={s.label} className="px-2 py-1.5 text-right">{avg(d.segments[s.label] || [])}</td>
                        ))}
                      </tr>
                    ))}
                    {Object.keys(kpiData.byVendor).length === 0 && (
                      <tr><td colSpan={2 + SEGMENTS.length} className="text-center py-4 text-gray-400">Sin datos completados</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
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
