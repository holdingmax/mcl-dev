import { useState, useEffect } from 'react'
import { collection, getDocs, query, where, orderBy } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import Layout from '../../components/Layout'
import type { AvFlight, AvFlightAwb } from '../../types'

type LogEntry = {
  id: string
  flight_id: string
  awb_number: string
  event: string
  detail: string
  user: string
  timestamp: string
}

type AwbRow = {
  awb: AvFlightAwb & { id: string }
  flight: AvFlight & { id: string }
  logs: LogEntry[]
}

const EVENT_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
  // Flight
  flight_created: { label: 'Vuelo creado', color: 'text-blue-700 bg-blue-100', icon: '✈' },
  flight_edited: { label: 'Vuelo editado', color: 'text-blue-600 bg-blue-100', icon: '✎' },
  flight_deleted: { label: 'Vuelo eliminado', color: 'text-red-600 bg-red-100', icon: '✕' },
  // AWB
  awb_created: { label: 'AWB creada', color: 'text-green-600 bg-green-100', icon: '+' },
  awb_edited: { label: 'AWB editada', color: 'text-blue-600 bg-blue-100', icon: '✎' },
  awb_deleted: { label: 'AWB eliminada', color: 'text-red-600 bg-red-100', icon: '✕' },
  awb_removed: { label: 'AWB dada de baja', color: 'text-red-600 bg-red-100', icon: '✕' },
  awb_moved_out: { label: 'AWB movida (salida)', color: 'text-amber-600 bg-amber-100', icon: '→' },
  awb_moved_in: { label: 'AWB movida (entrada)', color: 'text-amber-600 bg-amber-100', icon: '←' },
  awb_ai_extracted: { label: 'AI extrajo datos', color: 'text-violet-600 bg-violet-100', icon: '⚙' },
  // Documents
  doc_uploaded: { label: 'Documento subido', color: 'text-indigo-600 bg-indigo-100', icon: '⬆' },
  dg_doc_uploaded: { label: 'Doc DG subido', color: 'text-red-600 bg-red-100', icon: '⬆' },
  // Pallet Tag
  pallet_tag_uploaded: { label: 'Pallet Tag subido', color: 'text-teal-600 bg-teal-100', icon: '⬆' },
  pallet_tag_processed: { label: 'Pallet Tag procesado', color: 'text-teal-600 bg-teal-100', icon: '⚙' },
  pallet_tag_edited: { label: 'Pallet Tag editado', color: 'text-teal-600 bg-teal-100', icon: '✎' },
  pallet_tag_deleted: { label: 'Pallet Tag eliminado', color: 'text-red-600 bg-red-100', icon: '✕' },
  manual_position_created: { label: 'Posicion manual creada', color: 'text-teal-600 bg-teal-100', icon: '+' },
  // Screening & Checks
  screening_certified: { label: 'Screening certificado', color: 'text-green-600 bg-green-100', icon: '✓' },
  manifest_checked: { label: 'Manifiesto revisado', color: 'text-amber-600 bg-amber-100', icon: '⚠' },
  lb_checklist_generated: { label: 'Checklist LB generado', color: 'text-amber-600 bg-amber-100', icon: '📋' },
  // Delivery Orders
  do_created: { label: 'DO creada', color: 'text-purple-600 bg-purple-100', icon: '🚛' },
  do_edited: { label: 'DO editada', color: 'text-purple-600 bg-purple-100', icon: '✎' },
  do_dispatched: { label: 'DO despachada', color: 'text-purple-600 bg-purple-100', icon: '→' },
  do_reverted: { label: 'DO revertida a Draft', color: 'text-amber-600 bg-amber-100', icon: '↩' },
  do_deleted: { label: 'DO eliminada', color: 'text-red-600 bg-red-100', icon: '✕' },
  // Delivery Milestones
  cargo_loaded: { label: 'Carga loaded', color: 'text-orange-600 bg-orange-100', icon: '↑' },
  arrival_airline: { label: 'Arrival aerolinea', color: 'text-blue-600 bg-blue-100', icon: '✈' },
  unload_complete: { label: 'Descarga completada', color: 'text-green-600 bg-green-100', icon: '✓' },
  // Billing
  invoiced: { label: 'Facturada', color: 'text-emerald-600 bg-emerald-100', icon: '$' },
  invoice_voided: { label: 'Factura anulada', color: 'text-red-600 bg-red-100', icon: '✕' },
  // Notes
  flight_note: { label: 'Nota de vuelo', color: 'text-gray-600 bg-gray-100', icon: '💬' },
}

export default function AvAwbLog() {
  const [awbRows, setAwbRows] = useState<AwbRow[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedAwb, setExpandedAwb] = useState<string | null>(null)
  const [filterAwb, setFilterAwb] = useState('')
  const [filterFlight, setFilterFlight] = useState('')
  const [daysBack, setDaysBack] = useState(10)

  useEffect(() => { loadData() }, [daysBack])

  async function loadData() {
    setLoading(true)

    // Load flights, AWBs, and logs
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - daysBack)
    const cutoffStr = cutoff.toISOString()

    const [flightsSnap, awbsSnap, logsSnap] = await Promise.all([
      getDocs(collection(db, 'av_flights')),
      getDocs(collection(db, 'av_flight_awbs')),
      getDocs(query(collection(db, 'av_awb_logs'), where('timestamp', '>=', cutoffStr), orderBy('timestamp', 'asc'))),
    ])

    const flights = new Map<string, AvFlight & { id: string }>()
    flightsSnap.docs.forEach(d => flights.set(d.id, { id: d.id, ...d.data() } as AvFlight & { id: string }))

    const logs: LogEntry[] = logsSnap.docs.map(d => ({ id: d.id, ...d.data() } as LogEntry))

    // Group logs by awb_number
    const logsByAwb = new Map<string, LogEntry[]>()
    for (const log of logs) {
      const key = `${log.flight_id}__${log.awb_number}`
      if (!logsByAwb.has(key)) logsByAwb.set(key, [])
      logsByAwb.get(key)!.push(log)
    }

    // Build rows: only AWBs that have logs
    const awbMap = new Map<string, AvFlightAwb & { id: string }>()
    awbsSnap.docs.forEach(d => {
      const awb = { id: d.id, ...d.data() } as AvFlightAwb & { id: string }
      awbMap.set(`${awb.flight_id}__${awb.awb_number}`, awb)
    })

    const rows: AwbRow[] = []
    for (const [key, awbLogs] of logsByAwb) {
      const [flightId] = key.split('__')
      const flight = flights.get(flightId)
      if (!flight) continue
      const awb = awbMap.get(key) || {
        id: '',
        flight_id: flightId,
        awb_number: awbLogs[0].awb_number,
        iac: '', pieces: 0, gross_weight_kg: 0, chw_kg: 0,
        dg: false, dg_codes: [], lb: false, lb_detail: '',
        total_pcs_in_pallets: 0, screened_pcs: 0, screening_status: 'pending' as const,
        created_at: '',
      }
      rows.push({ awb: awb as AvFlightAwb & { id: string }, flight, logs: awbLogs })
    }

    // Sort by most recent log desc
    rows.sort((a, b) => {
      const aLast = a.logs[a.logs.length - 1]?.timestamp || ''
      const bLast = b.logs[b.logs.length - 1]?.timestamp || ''
      return bLast.localeCompare(aLast)
    })

    setAwbRows(rows)
    setLoading(false)
  }

  const filtered = awbRows.filter(r => {
    if (filterAwb && !r.awb.awb_number.includes(filterAwb)) return false
    if (filterFlight && !r.flight.flight_number.toLowerCase().includes(filterFlight.toLowerCase())) return false
    return true
  })

  const totalEvents = filtered.reduce((s, r) => s + r.logs.length, 0)

  if (loading) return <Layout title="AWB Audit Log" backTo="/avianca/config"><div className="flex justify-center py-20"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" /></div></Layout>

  return (
    <Layout title="AWB Audit Log" backTo="/avianca/config">
      {/* Load older */}
      <div className="text-center mb-4">
        <button
          onClick={() => setDaysBack(prev => prev + 10)}
          className="text-mcl-blue text-sm font-semibold hover:underline"
        >
          Cargar AWBs mas antiguas (mostrando ultimos {daysBack} dias)
        </button>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 mb-6 flex flex-wrap items-end gap-4">
        <div>
          <label className="text-[10px] font-semibold text-gray-400 uppercase block mb-1">AWB</label>
          <input
            type="text"
            value={filterAwb}
            onChange={e => setFilterAwb(e.target.value)}
            placeholder="729-95079..."
            className="w-40 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
          />
        </div>
        <div>
          <label className="text-[10px] font-semibold text-gray-400 uppercase block mb-1">Vuelo</label>
          <input
            type="text"
            value={filterFlight}
            onChange={e => setFilterFlight(e.target.value)}
            placeholder="M4003..."
            className="w-36 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
          />
        </div>
        <div className="text-xs text-gray-400 ml-auto">
          {filtered.length} AWBs · {totalEvents} eventos
        </div>
      </div>

      {/* AWB list */}
      <div className="space-y-3">
        {filtered.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-8 text-center text-gray-400 text-sm">
            No hay eventos registrados en los ultimos {daysBack} dias.
          </div>
        ) : filtered.map(row => {
          const isExpanded = expandedAwb === `${row.awb.flight_id}__${row.awb.awb_number}`
          const key = `${row.awb.flight_id}__${row.awb.awb_number}`
          return (
            <div key={key} className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
              {/* AWB header */}
              <div
                className="flex items-center px-5 py-3 cursor-pointer hover:bg-gray-50/50"
                onClick={() => setExpandedAwb(isExpanded ? null : key)}
              >
                <div className="mr-3 text-gray-300">
                  <svg className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                </div>
                <div className="flex-1 flex items-baseline gap-3 flex-wrap">
                  <span className="font-bold font-mono text-gray-800">{row.awb.awb_number}</span>
                  <span className="text-xs font-semibold text-gray-600">{row.flight.flight_number}</span>
                  <span className="text-[10px] bg-gray-700 text-white px-1.5 py-0.5 rounded font-bold">{row.flight.destination}</span>
                  <span className="text-xs text-gray-400">{row.awb.pieces} pcs / {row.awb.gross_weight_kg.toLocaleString()} kg</span>
                </div>
                <span className="text-xs text-gray-400">{row.logs.length} eventos</span>
              </div>

              {/* Timeline */}
              {isExpanded && (
                <div className="border-t border-gray-100 px-5 py-4 bg-gray-50/20">
                  <div className="relative pl-8">
                    {/* Vertical line */}
                    <div className="absolute left-3 top-0 bottom-0 w-px bg-gray-200" />

                    {row.logs.map((log, i) => {
                      const cfg = EVENT_CONFIG[log.event] || { label: log.event, color: 'text-gray-600 bg-gray-100', icon: '•' }
                      const dt = new Date(log.timestamp)
                      const dateStr = `${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}/${String(dt.getFullYear()).slice(2)}`
                      const timeStr = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                      return (
                        <div key={log.id} className={`relative mb-5 ${i === row.logs.length - 1 ? 'mb-0' : ''}`}>
                          {/* Circle icon */}
                          <div className={`absolute -left-5 w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold ${cfg.color}`}>
                            {cfg.icon}
                          </div>
                          <div>
                            <div className="flex items-baseline gap-2">
                              <span className="text-sm font-bold text-gray-800">{cfg.label}</span>
                              <span className="text-xs text-gray-400">{dateStr} {timeStr}</span>
                            </div>
                            {log.detail && (
                              <p className="text-xs text-gray-600 mt-0.5">{log.detail}</p>
                            )}
                            <p className="text-[10px] text-gray-400 mt-0.5">por {log.user}</p>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Layout>
  )
}
