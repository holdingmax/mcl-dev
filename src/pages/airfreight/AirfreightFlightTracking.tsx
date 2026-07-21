import { useState, useEffect, useMemo } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { collection, query, where, getDocs } from 'firebase/firestore'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import Layout from '../../components/Layout'
import { AirfreightFlight, AirfreightBooking, DeliveryOrder, DeliveryTracking } from '../../types'

// ── Types ────────────────────────────────────────────────────────────────────

interface PhysicalPiece {
  id: string
  awb_number: string
  uld_id?: string | null
}

interface DocReception {
  id: string
  flight_id: string | null
  awb_number: string
}

interface DoEntry {
  do_id: string
  do_number: string
  frozen_pc: 'P' | 'C' | null
}

interface AwbTrackingRow {
  awb_number: string
  client_name: string
  agent_name?: string | null
  client_id: string
  booking_id: string
  awb_index: number
  pieces: number
  weight_kg: number
  // Hito 1
  physical_received: boolean
  // Hito 2
  ie_doc_uploaded: boolean
  has_ie_field: boolean
  // Hitos 3-4
  pieces_received: number
  pieces_in_uld: number
  buildup_started: boolean
  buildup_completed: boolean
  // Hito 5
  do_status: 'none' | 'partial' | 'complete'
  do_entries: DoEntry[]
  // Hitos 6-8
  truck_loaded_at?: string
  arrival_airline_at?: string
  unload_end_at?: string
  driver_name?: string
  vendor_name?: string
  // Special
  flight_dispatched: boolean
  has_driver_tracking: boolean
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(iso?: string) {
  if (!iso) return null
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  } catch { return null }
}

function fmtTimestamp(iso?: string) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
  } catch { return iso }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size))
  return result
}

// ── Component ────────────────────────────────────────────────────────────────

export default function AirfreightFlightTracking() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const flightId = params.get('flight') || ''

  const [flight, setFlight] = useState<(AirfreightFlight & { id: string }) | null>(null)
  const [rows, setRows] = useState<AwbTrackingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  async function loadData() {
    if (!flightId) { setError('No flight ID'); setLoading(false); return }
    setLoading(true)
    setError('')
    try {
      // Flight data
      const flightSnap = await getDoc(doc(db, 'airfreight_flights', flightId))
      if (!flightSnap.exists()) { setError('Vuelo no encontrado'); setLoading(false); return }
      const flightData = { ...flightSnap.data() as AirfreightFlight, id: flightSnap.id }
      setFlight(flightData)

      const flightStatus = flightData.flight_status || 'booked'
      const isDispatched = flightStatus === 'dispatched' || flightStatus === 'terminado'

      // Query 1: Bookings
      const bookingsSnap = await getDocs(query(
        collection(db, 'airfreight_bookings'),
        where('flight_id', '==', flightId),
      ))
      const bookings = bookingsSnap.docs.map(d => ({ ...d.data() as AirfreightBooking, id: d.id }))

      // Build AWB list from bookings
      const awbList: {
        awb_number: string; client_name: string; client_id: string;
        booking_id: string; awb_index: number; pieces: number; weight_kg: number;
        ie_doc_uploaded: boolean; has_ie_field: boolean;
      }[] = []

      for (const b of bookings) {
        if (b.booking_type === 'simple') {
          awbList.push({
            awb_number: b.awb_2nd_leg || b.awb_1st_leg || '',
            client_name: b.client_name,
            agent_name: b.agent_name || null,
            client_id: b.client_id,
            booking_id: b.id!,
            awb_index: 0,
            pieces: b.pieces || 0,
            weight_kg: b.weight || 0,
            ie_doc_uploaded: !!(b.documents as any)?.doc_7512?.url,
            has_ie_field: true,
          })
        } else if (b.awb_lines) {
          b.awb_lines.forEach((line, idx) => {
            const hasDoc = !!(line.documents?.doc_7512?.url)
            awbList.push({
              awb_number: line.awb_2nd_leg || line.awb_number || '',
              client_name: b.client_name,
              agent_name: b.agent_name || null,
              client_id: b.client_id,
              booking_id: b.id!,
              awb_index: idx,
              pieces: line.pieces || 0,
              weight_kg: line.weight || 0,
              ie_doc_uploaded: hasDoc,
              has_ie_field: true,
            })
          })
        }
      }

      // Query 2: Doc Receptions
      const recSnap = await getDocs(query(
        collection(db, 'airfreight_doc_receptions'),
        where('flight_id', '==', flightId),
      ))
      const receptions = recSnap.docs.map(d => ({ id: d.id, ...d.data() } as DocReception))

      // Query 3: Physical Pieces (by doc_reception_id in batches)
      const recIds = receptions.map(r => r.id)
      let allPieces: PhysicalPiece[] = []
      if (recIds.length > 0) {
        const batches = chunk(recIds, 30)
        const results = await Promise.all(batches.map(batch =>
          getDocs(query(
            collection(db, 'airfreight_physical_pieces'),
            where('doc_reception_id', 'in', batch),
          ))
        ))
        allPieces = results.flatMap(snap =>
          snap.docs.map(d => ({ id: d.id, ...d.data() } as PhysicalPiece))
        )
      }

      // Group pieces by AWB
      const piecesByAwb = new Map<string, { total: number; inUld: number }>()
      for (const p of allPieces) {
        const entry = piecesByAwb.get(p.awb_number) || { total: 0, inUld: 0 }
        entry.total++
        if (p.uld_id) entry.inUld++
        piecesByAwb.set(p.awb_number, entry)
      }

      // Query 4: Delivery Orders (by awb_keys)
      const awbKeys = awbList.map(a => `${a.booking_id}::${a.awb_index}`)
      let allDOs: (DeliveryOrder & { id: string })[] = []
      if (awbKeys.length > 0) {
        const doBatches = chunk(awbKeys, 30)
        const doResults = await Promise.all(doBatches.map(batch =>
          getDocs(query(
            collection(db, 'delivery_orders'),
            where('awb_keys', 'array-contains-any', batch),
          ))
        ))
        const seenIds = new Set<string>()
        allDOs = doResults.flatMap(snap =>
          snap.docs.filter(d => {
            if (seenIds.has(d.id)) return false
            seenIds.add(d.id)
            return true
          }).map(d => ({ ...d.data() as DeliveryOrder, id: d.id }))
        )
      }

      // Map AWB → DO entries
      const doByAwb = new Map<string, DoEntry[]>()
      for (const doDoc of allDOs) {
        for (const entry of (doDoc.awb_entries || [])) {
          const key = entry.awb_number
          const list = doByAwb.get(key) || []
          list.push({ do_id: doDoc.id, do_number: doDoc.do_number, frozen_pc: entry.frozen_pc || null })
          doByAwb.set(key, list)
        }
      }

      // Query 5: Delivery Tracking
      const doIds = allDOs.map(d => d.id)
      const trackByDoId = new Map<string, DeliveryTracking>()
      if (doIds.length > 0) {
        const trackBatches = chunk(doIds, 30)
        const trackResults = await Promise.all(trackBatches.map(batch =>
          getDocs(query(
            collection(db, 'delivery_tracking'),
            where('do_id', 'in', batch),
          ))
        ))
        for (const snap of trackResults) {
          for (const d of snap.docs) {
            const t = { ...d.data() as DeliveryTracking, id: d.id }
            trackByDoId.set(t.do_id, t)
          }
        }
      }

      // Build rows
      const finalRows: AwbTrackingRow[] = awbList.map(awb => {
        const pcs = piecesByAwb.get(awb.awb_number) || { total: 0, inUld: 0 }
        const doEntries = doByAwb.get(awb.awb_number) || []

        // DO status
        let doStatus: 'none' | 'partial' | 'complete' = 'none'
        if (doEntries.length > 0) {
          doStatus = doEntries.some(e => e.frozen_pc === 'C') ? 'complete' : 'partial'
        }

        // Driver milestones: prioritize DO with 'C', fallback to most recent with tracking
        let tracking: DeliveryTracking | undefined
        const completeDo = doEntries.find(e => e.frozen_pc === 'C')
        if (completeDo) {
          tracking = trackByDoId.get(completeDo.do_id)
        }
        if (!tracking) {
          for (const entry of doEntries) {
            const t = trackByDoId.get(entry.do_id)
            if (t) { tracking = t; break }
          }
        }

        const hasDriverTracking = !!(
          tracking?.milestones?.truck_loaded ||
          tracking?.milestones?.arrival_airline ||
          tracking?.milestones?.unload_end
        )

        return {
          awb_number: awb.awb_number,
          client_name: awb.client_name,
          client_id: awb.client_id,
          booking_id: awb.booking_id,
          awb_index: awb.awb_index,
          pieces: awb.pieces,
          weight_kg: awb.weight_kg,
          physical_received: pcs.total > 0,
          ie_doc_uploaded: awb.ie_doc_uploaded,
          has_ie_field: awb.has_ie_field,
          pieces_received: pcs.total,
          pieces_in_uld: pcs.inUld,
          buildup_started: pcs.inUld > 0,
          buildup_completed: pcs.inUld === pcs.total && pcs.total > 0,
          do_status: doStatus,
          do_entries: doEntries,
          truck_loaded_at: tracking?.milestones?.truck_loaded?.timestamp,
          arrival_airline_at: tracking?.milestones?.arrival_airline?.timestamp,
          unload_end_at: tracking?.milestones?.unload_end?.timestamp,
          driver_name: tracking?.driver_name,
          vendor_name: tracking?.vendor_name,
          flight_dispatched: isDispatched,
          has_driver_tracking: hasDriverTracking,
        }
      })

      setRows(finalRows)
    } catch (err) {
      console.error('FlightTracking load error:', err)
      setError('Error cargando datos: ' + (err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadData() }, [flightId])

  // KPIs
  const kpis = useMemo(() => {
    const total = rows.length
    const received = rows.filter(r => r.physical_received).length
    const ieRows = rows.filter(r => r.has_ie_field)
    const ieComplete = ieRows.filter(r => r.ie_doc_uploaded).length
    const buildupDone = rows.filter(r => r.buildup_completed).length
    const doComplete = rows.filter(r => r.do_status === 'complete').length
    const delivered = rows.filter(r => !!r.unload_end_at).length
    return { total, received, ieTotal: ieRows.length, ieComplete, buildupDone, doComplete, delivered }
  }, [rows])

  const flightStatus = flight?.flight_status || 'booked'
  const statusLabel = flightStatus === 'dispatched' ? 'Dispatched'
    : flightStatus === 'built' ? 'Built'
    : flightStatus === 'terminado' ? 'Terminado'
    : flightStatus === 'in_progress' ? 'In Progress'
    : 'Booked'
  const statusColor = flightStatus === 'dispatched' ? 'bg-green-100 text-green-700'
    : flightStatus === 'built' ? 'bg-purple-100 text-purple-700'
    : flightStatus === 'terminado' ? 'bg-orange-100 text-orange-700'
    : flightStatus === 'in_progress' ? 'bg-yellow-100 text-yellow-700'
    : 'bg-blue-100 text-blue-700'

  // ── Render ──

  function ProgressBar({ value, total, label }: { value: number; total: number; label: string }) {
    const pct = total > 0 ? Math.round((value / total) * 100) : 0
    return (
      <div className="flex-1 min-w-[120px]">
        <div className="text-xs text-gray-500 mb-1">{label}</div>
        <div className="flex items-center gap-2">
          <div className="flex-1 bg-gray-200 rounded-full h-2">
            <div
              className={`h-2 rounded-full transition-all ${pct === 100 ? 'bg-green-500' : pct > 0 ? 'bg-yellow-400' : 'bg-gray-200'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-xs font-mono text-gray-600">{value}/{total}</span>
        </div>
      </div>
    )
  }

  function MilestoneBadge({ timestamp, dispatched, hasTracking, driverName, vendorName }: {
    timestamp?: string; dispatched: boolean; hasTracking: boolean; driverName?: string; vendorName?: string
  }) {
    const time = fmtTime(timestamp)
    if (time) {
      return (
        <span
          className="text-xs font-mono text-green-700 bg-green-50 px-1.5 py-0.5 rounded"
          title={`${fmtTimestamp(timestamp)}${driverName ? `\nDriver: ${driverName}` : ''}${vendorName ? `\nVendor: ${vendorName}` : ''}`}
        >
          {time}
        </span>
      )
    }
    if (dispatched && !hasTracking) {
      return (
        <span
          className="text-[10px] text-gray-400 bg-gray-100 px-1 py-0.5 rounded"
          title="Vuelo despachado — sin tracking del conductor"
        >
          Disp.
        </span>
      )
    }
    return <span className="text-gray-300">—</span>
  }

  return (
    <Layout title="Seguimiento Operacional">
      <div className="max-w-7xl mx-auto px-4 py-6">
        {/* Back button */}
        <button
          onClick={() => navigate('/airfreight')}
          className="text-sm text-mcl-blue hover:underline mb-4 flex items-center gap-1"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Flight Ops Board
        </button>

        {loading && (
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" />
          </div>
        )}

        {error && <div className="text-red-600 text-sm py-4">{error}</div>}

        {!loading && flight && (
          <>
            {/* Flight Header */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mb-4">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-4">
                  <div>
                    <span className="text-lg font-bold text-gray-800">{flight.airline}</span>
                    {flight.flight_number && (
                      <span className="text-lg text-gray-500 ml-2">#{flight.flight_number}</span>
                    )}
                  </div>
                  <div className="text-sm text-gray-500">
                    ETD: <span className="font-mono">{(flight.flight_datetime || '').slice(0, 16).replace('T', ' ')}</span>
                  </div>
                  <span className={`text-xs px-2.5 py-1 rounded-full font-semibold ${statusColor}`}>
                    {statusLabel}
                  </span>
                </div>
                <button
                  onClick={() => loadData()}
                  className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-3 py-1.5 rounded-lg transition-colors"
                >
                  Actualizar
                </button>
              </div>
            </div>

            {/* KPI Summary */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mb-4">
              <div className="flex flex-wrap gap-4">
                <ProgressBar value={kpis.received} total={kpis.total} label="Recibidos Fisicamente" />
                {kpis.ieTotal > 0 && (
                  <ProgressBar value={kpis.ieComplete} total={kpis.ieTotal} label="IE Completos" />
                )}
                <ProgressBar value={kpis.buildupDone} total={kpis.total} label="Build-Up Completo" />
                <ProgressBar value={kpis.doComplete} total={kpis.total} label="DOs Completas" />
                <ProgressBar value={kpis.delivered} total={kpis.total} label="Entregados" />
              </div>
            </div>

            {/* Tracking Table */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-xs font-bold text-gray-500 uppercase border-b border-gray-200">
                    <th className="px-2 py-2.5 text-left">AWB</th>
                    <th className="px-2 py-2.5 text-left">Client</th>
                    <th className="px-2 py-2.5 text-center">Pcs</th>
                    <th className="px-2 py-2.5 text-center">Kg</th>
                    <th className="px-2 py-2.5 text-center">Fisico</th>
                    <th className="px-2 py-2.5 text-center">IE</th>
                    <th className="px-2 py-2.5 text-center">B.Start</th>
                    <th className="px-2 py-2.5 text-center">B.End</th>
                    <th className="px-2 py-2.5 text-center">DO</th>
                    <th className="px-2 py-2.5 text-center">Truck</th>
                    <th className="px-2 py-2.5 text-center">Arr</th>
                    <th className="px-2 py-2.5 text-center">Unload</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.length === 0 && (
                    <tr><td colSpan={12} className="text-center py-8 text-gray-400">Sin AWBs para este vuelo</td></tr>
                  )}
                  {rows.map((r, i) => (
                    <tr key={`${r.awb_number}-${i}`} className="hover:bg-gray-50/50">
                      <td className="px-2 py-2 font-mono text-xs text-gray-700">{r.awb_number || '—'}</td>
                      <td className="px-2 py-2 text-xs text-gray-600 max-w-[120px] truncate">{r.agent_name || r.client_name}</td>
                      <td className="px-2 py-2 text-center text-xs text-gray-600">{r.pieces}</td>
                      <td className="px-2 py-2 text-center text-xs text-gray-600">{Math.round(r.weight_kg)}</td>

                      {/* Hito 1: Fisico */}
                      <td className="px-2 py-2 text-center">
                        {r.physical_received
                          ? <span className="text-green-600 font-bold" title="Piezas fisicas recibidas">&#10003;</span>
                          : <span className="text-gray-300">—</span>
                        }
                      </td>

                      {/* Hito 2: IE */}
                      <td className="px-2 py-2 text-center">
                        {!r.has_ie_field
                          ? <span className="text-[10px] text-gray-300">n/a</span>
                          : r.ie_doc_uploaded
                            ? <span className="text-green-600 font-bold" title="7512 uploaded">&#10003;</span>
                            : <span className="text-gray-300">—</span>
                        }
                      </td>

                      {/* Hito 3: B.Start */}
                      <td className="px-2 py-2 text-center">
                        {r.buildup_started
                          ? <span className="text-green-600 font-bold" title={`${r.pieces_in_uld}/${r.pieces_received} en ULD`}>&#10003;</span>
                          : <span className="text-red-400 font-bold" title="Sin piezas en ULD">&#10007;</span>
                        }
                      </td>

                      {/* Hito 4: B.End */}
                      <td className="px-2 py-2 text-center">
                        {r.buildup_completed
                          ? <span className="text-green-600 font-bold" title="100% piezas en ULD">&#10003;</span>
                          : <span className="text-red-400 font-bold" title={r.buildup_started ? `${r.pieces_in_uld}/${r.pieces_received} en ULD` : 'Sin distribución'}>&#10007;</span>
                        }
                      </td>

                      {/* Hito 5: DO */}
                      <td className="px-2 py-2 text-center">
                        {r.do_status === 'none'
                          ? <span className="text-gray-300">—</span>
                          : r.do_status === 'complete'
                            ? <span
                                className="text-xs font-semibold text-green-700 bg-green-50 px-1.5 py-0.5 rounded"
                                title={r.do_entries.map(e => `${e.do_number} [${e.frozen_pc || '?'}]`).join('\n')}
                              >
                                {r.do_entries.find(e => e.frozen_pc === 'C')?.do_number?.replace('DO-', '') || 'C'}
                              </span>
                            : <span
                                className="text-xs font-semibold text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded"
                                title={r.do_entries.map(e => `${e.do_number} [P]`).join('\n')}
                              >
                                {r.do_entries[0]?.do_number?.replace('DO-', '') || 'P'}
                              </span>
                        }
                      </td>

                      {/* Hitos 6-8: Driver milestones */}
                      <td className="px-2 py-2 text-center">
                        <MilestoneBadge
                          timestamp={r.truck_loaded_at}
                          dispatched={r.flight_dispatched}
                          hasTracking={r.has_driver_tracking}
                          driverName={r.driver_name}
                          vendorName={r.vendor_name}
                        />
                      </td>
                      <td className="px-2 py-2 text-center">
                        <MilestoneBadge
                          timestamp={r.arrival_airline_at}
                          dispatched={r.flight_dispatched}
                          hasTracking={r.has_driver_tracking}
                          driverName={r.driver_name}
                          vendorName={r.vendor_name}
                        />
                      </td>
                      <td className="px-2 py-2 text-center">
                        <MilestoneBadge
                          timestamp={r.unload_end_at}
                          dispatched={r.flight_dispatched}
                          hasTracking={r.has_driver_tracking}
                          driverName={r.driver_name}
                          vendorName={r.vendor_name}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Layout>
  )
}
