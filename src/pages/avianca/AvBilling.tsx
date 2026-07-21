import { useState, useEffect } from 'react'
import { collection, getDocs, deleteDoc, doc, updateDoc, query, where } from 'firebase/firestore'
import { db, auth } from '../../lib/firebase'
import Layout from '../../components/Layout'
import { getAvBillingConfig, generateFlatInvoice, generateBracketInvoice, getQuincenalPeriods } from '../../lib/avBilling'
import type { AvInvoice, AvBillingConfig, AvFlight, AvFlightAwb } from '../../types'
import { logAvEventBatch } from '../../lib/avLog'

type InvWithId = AvInvoice & { id: string }
type FlightRow = AvFlight & { id: string; awbCount: number; totalKg: number; invoiceId?: string; invoiceNumber?: string; invoiceStatus?: string; chargeTotal?: number }

export default function AvBilling() {
  const [config, setConfig] = useState<AvBillingConfig | null>(null)
  const [flightRows, setFlightRows] = useState<FlightRow[]>([])
  const [invoices, setInvoices] = useState<InvWithId[]>([])
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  // Filters
  const [filterStatus, setFilterStatus] = useState('Todos')
  const [filterFlight, setFilterFlight] = useState('')
  const [filterFrom, setFilterFrom] = useState('')
  const [filterTo, setFilterTo] = useState('')

  // Modals
  const [viewInvoice, setViewInvoice] = useState<InvWithId | null>(null)
  const [expandedFlight, setExpandedFlight] = useState<string | null>(null)
  const [flightAwbs, setFlightAwbs] = useState<Record<string, AvFlightAwb[]>>({})

  // Brackets period picker
  const [showPeriodPicker, setShowPeriodPicker] = useState(false)
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear())
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth() + 1)
  const [selectedPeriodIdx, setSelectedPeriodIdx] = useState(0)

  useEffect(() => { loadData() }, [])

  async function loadData() {
    setLoading(true)
    const [cfgData, flightsSnap, awbsSnap, invSnap] = await Promise.all([
      getAvBillingConfig(),
      getDocs(query(collection(db, 'av_flights'), where('status', '==', 'dispatched'))),
      getDocs(collection(db, 'av_flight_awbs')),
      getDocs(collection(db, 'av_invoices')),
    ])
    setConfig(cfgData)

    const allInvoices = invSnap.docs
      .map(d => ({ id: d.id, ...d.data() } as InvWithId))
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    setInvoices(allInvoices)

    // Build flight→invoice map (for flat mode invoices)
    const flightInvMap: Record<string, InvWithId> = {}
    for (const inv of allInvoices) {
      if (inv.mode === 'flat' && inv.flight_id && inv.status !== 'void') {
        flightInvMap[inv.flight_id] = inv
      }
    }

    // Group AWBs by flight
    const awbsByFlight: Record<string, AvFlightAwb[]> = {}
    for (const d of awbsSnap.docs) {
      const awb = d.data() as AvFlightAwb
      if (!awbsByFlight[awb.flight_id]) awbsByFlight[awb.flight_id] = []
      awbsByFlight[awb.flight_id].push(awb)
    }
    setFlightAwbs(awbsByFlight)

    const rows: FlightRow[] = flightsSnap.docs.map(d => {
      const f = { id: d.id, ...d.data() } as AvFlight & { id: string }
      const fAwbs = awbsByFlight[f.id] || []
      const totalKg = fAwbs.reduce((s, a) => s + (a.gross_weight_kg || 0), 0)
      const inv = flightInvMap[f.id]
      const rate = cfgData.flat_rate || 0.20
      return {
        ...f,
        awbCount: fAwbs.length,
        totalKg,
        invoiceId: inv?.id,
        invoiceNumber: inv?.invoice_number,
        invoiceStatus: inv?.status,
        chargeTotal: Math.round(totalKg * rate * 100) / 100,
      }
    }).sort((a, b) => (b.etd || '').localeCompare(a.etd || ''))

    setFlightRows(rows)
    setLoading(false)
  }

  // Generate flat invoice for a flight
  async function handleGenerateFlat(flightId: string) {
    if (!confirm('Generar factura para este vuelo?')) return
    setGenerating(true)
    setError('')
    setSuccess('')
    try {
      await generateFlatInvoice(flightId, auth.currentUser?.email || '')
      // Log invoiced event for all AWBs in this flight
      const fAwbs = flightAwbs[flightId] || []
      if (fAwbs.length > 0) {
        const awbNums = fAwbs.map(a => a.awb_number)
        logAvEventBatch(flightId, awbNums, 'invoiced', `Factura flat generada`, auth.currentUser?.email || '')
      }
      setSuccess('Factura generada exitosamente')
      await loadData()
    } catch (err: any) {
      setError(err.message || 'Error generando factura')
    } finally {
      setGenerating(false)
    }
  }

  // Generate bracket invoice
  async function handleGenerateBracket() {
    const periods = getQuincenalPeriods(selectedYear, selectedMonth)
    const period = periods[selectedPeriodIdx]
    if (!period) return
    setGenerating(true)
    setError('')
    setSuccess('')
    try {
      await generateBracketInvoice(period.label, period.start, period.end, auth.currentUser?.email || '')
      setSuccess(`Factura generada para ${period.label}`)
      setShowPeriodPicker(false)
      await loadData()
    } catch (err: any) {
      setError(err.message || 'Error generando factura')
    } finally {
      setGenerating(false)
    }
  }

  // Void invoice
  async function handleVoid(inv: InvWithId) {
    if (!confirm(`Anular factura ${inv.invoice_number}? Esta accion no se puede deshacer.`)) return
    await updateDoc(doc(db, 'av_invoices', inv.id), { status: 'void' })
    // Log void for all AWBs in invoice
    const awbNums = inv.lines.map(l => l.awb_number)
    const flightId = inv.flight_id || (inv.flights[0]?.flight_id || '')
    if (flightId && awbNums.length > 0) {
      logAvEventBatch(flightId, [...new Set(awbNums)], 'invoice_voided', `Factura ${inv.invoice_number} anulada`, auth.currentUser?.email || '')
    }
    setSuccess(`Factura ${inv.invoice_number} anulada`)
    if (viewInvoice?.id === inv.id) setViewInvoice(null)
    await loadData()
  }

  // Delete draft invoice
  async function handleDelete(inv: InvWithId) {
    if (!confirm(`Eliminar factura borrador ${inv.invoice_number}?`)) return
    await deleteDoc(doc(db, 'av_invoices', inv.id))
    if (viewInvoice?.id === inv.id) setViewInvoice(null)
    await loadData()
  }

  // Mark as sent
  async function handleMarkSent(inv: InvWithId) {
    await updateDoc(doc(db, 'av_invoices', inv.id), { status: 'sent' })
    await loadData()
    if (viewInvoice?.id === inv.id) setViewInvoice({ ...inv, status: 'sent' })
  }

  // Mark as paid
  async function handleMarkPaid(inv: InvWithId) {
    await updateDoc(doc(db, 'av_invoices', inv.id), { status: 'paid' })
    await loadData()
    if (viewInvoice?.id === inv.id) setViewInvoice({ ...inv, status: 'paid' })
  }

  function statusBadge(status?: string) {
    switch (status) {
      case 'draft': return <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-gray-100 text-gray-600">Draft</span>
      case 'sent': return <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-100 text-blue-700">Enviada</span>
      case 'paid': return <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-green-100 text-green-700">Pagada</span>
      case 'void': return <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-700">Anulada</span>
      default: return <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-700">Pendiente</span>
    }
  }

  // Filter logic
  const filtered = flightRows.filter(f => {
    if (filterStatus === 'Pendiente' && f.invoiceStatus) return false
    if (filterStatus === 'Facturado' && f.invoiceStatus !== 'sent' && f.invoiceStatus !== 'paid' && f.invoiceStatus !== 'draft') return false
    if (filterStatus === 'Pagado' && f.invoiceStatus !== 'paid') return false
    if (filterStatus === 'Anulado' && f.invoiceStatus !== 'void') return false
    if (filterFlight && !f.flight_number.toLowerCase().includes(filterFlight.toLowerCase())) return false
    const d = f.etd?.slice(0, 10) || ''
    if (filterFrom && d < filterFrom) return false
    if (filterTo && d > filterTo) return false
    return true
  })

  const pendingRows = flightRows.filter(f => !f.invoiceStatus || f.invoiceStatus === 'void')
  const pendingTotal = pendingRows.reduce((s, f) => s + (f.chargeTotal || 0), 0)
  const totalCharged = flightRows.reduce((s, f) => s + (f.chargeTotal || 0), 0)

  if (loading) return <Layout title="Avianca Billing" backTo="/avianca"><div className="flex justify-center py-20"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" /></div></Layout>

  return (
    <Layout title="Avianca Billing" backTo="/avianca">
      {/* Filters + Summary */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 mb-6">
        <div className="flex flex-wrap items-end gap-4">
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
          <div>
            <label className="text-[10px] font-semibold text-gray-400 uppercase block mb-1">Estado</label>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30">
              <option>Todos</option>
              <option>Pendiente</option>
              <option>Facturado</option>
              <option>Pagado</option>
              <option>Anulado</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] font-semibold text-gray-400 uppercase block mb-1">Desde</label>
            <input type="date" value={filterFrom} onChange={e => setFilterFrom(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
          </div>
          <div>
            <label className="text-[10px] font-semibold text-gray-400 uppercase block mb-1">Hasta</label>
            <input type="date" value={filterTo} onChange={e => setFilterTo(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
          </div>
          <div className="ml-auto flex items-center gap-4">
            <div className="border-2 border-amber-400 rounded-xl px-5 py-2 text-center">
              <div className="text-[10px] font-semibold text-amber-600 uppercase">Por Facturar</div>
              <div className="text-xl font-bold text-amber-700 font-mono">${pendingTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
            </div>
            {config?.mode === 'brackets' && (
              <button
                onClick={() => setShowPeriodPicker(true)}
                className="bg-mcl-blue text-white px-4 py-2 rounded-lg text-xs font-medium hover:bg-blue-900"
              >
                + Factura Quincenal
              </button>
            )}
          </div>
        </div>
        <div className="mt-3 text-xs text-gray-400">
          {filtered.length} vuelos · {filtered.reduce((s, f) => s + f.awbCount, 0)} AWBs · Total: <span className="font-semibold text-gray-600">${totalCharged.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
          <span className="ml-3">Modo: <span className="font-semibold text-gray-600">{config?.mode === 'brackets' ? 'Brackets Quincenal' : `Flat $${config?.flat_rate}/kg`}</span></span>
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4 text-sm text-red-700">{error}<button onClick={() => setError('')} className="ml-2 text-red-400 hover:text-red-600">✕</button></div>}
      {success && <div className="bg-green-50 border border-green-200 rounded-lg p-3 mb-4 text-sm text-green-700">{success}<button onClick={() => setSuccess('')} className="ml-2 text-green-400 hover:text-green-600">✕</button></div>}

      {/* Flight charges list */}
      <div className="space-y-2">
        {filtered.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-8 text-center text-gray-400 text-sm">
            No hay vuelos que coincidan con los filtros.
          </div>
        ) : filtered.map(f => {
          const isExpanded = expandedFlight === f.id
          const awbs = flightAwbs[f.id] || []
          const inv = invoices.find(i => i.flight_id === f.id && i.status !== 'void')
          return (
            <div key={f.id} className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
              {/* Row */}
              <div
                className="flex items-center px-5 py-4 cursor-pointer hover:bg-gray-50/50"
                onClick={() => setExpandedFlight(isExpanded ? null : f.id)}
              >
                <div className="mr-3 text-gray-300">
                  <svg className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="font-bold text-gray-800">{f.flight_number}</span>
                    <span className="text-xs text-gray-400 font-mono">{f.destination}</span>
                    <span className="text-xs text-gray-400">{f.awbCount} AWBs</span>
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5">{f.etd?.slice(0, 10)}</div>
                </div>
                <div className="flex items-center gap-4">
                  {statusBadge(f.invoiceStatus)}
                  {f.invoiceNumber && (
                    <span className="text-xs font-mono text-gray-400">{f.invoiceNumber}</span>
                  )}
                  <span className="text-sm font-bold font-mono text-gray-800 w-28 text-right">
                    ${(f.chargeTotal || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </span>
                </div>
              </div>

              {/* Expanded detail */}
              {isExpanded && (
                <div className="border-t border-gray-100 px-5 py-4 bg-gray-50/30">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-semibold text-gray-500 uppercase">
                      {awbs.length} AWBs · {f.totalKg.toLocaleString()} kg · Rate: ${config?.flat_rate}/kg
                    </span>
                    <div className="flex items-center gap-2">
                      {inv && inv.status !== 'void' && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setViewInvoice(inv) }}
                          className="text-mcl-blue hover:underline text-xs font-semibold"
                        >
                          Ver Factura
                        </button>
                      )}
                      {!f.invoiceStatus && config?.mode === 'flat' && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleGenerateFlat(f.id) }}
                          disabled={generating || f.awbCount === 0}
                          className="bg-mcl-blue text-white px-3 py-1 rounded-lg text-[10px] font-semibold hover:bg-blue-900 disabled:opacity-50"
                        >
                          {generating ? 'Generando...' : 'Generar Factura'}
                        </button>
                      )}
                      {f.invoiceStatus === 'void' && config?.mode === 'flat' && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleGenerateFlat(f.id) }}
                          disabled={generating || f.awbCount === 0}
                          className="bg-mcl-blue text-white px-3 py-1 rounded-lg text-[10px] font-semibold hover:bg-blue-900 disabled:opacity-50"
                        >
                          Re-facturar
                        </button>
                      )}
                    </div>
                  </div>
                  <table className="w-full text-xs">
                    <thead className="text-[10px] text-gray-400 uppercase">
                      <tr>
                        <th className="text-left px-2 py-1 font-semibold">AWB</th>
                        <th className="text-right px-2 py-1 font-semibold">PCS</th>
                        <th className="text-right px-2 py-1 font-semibold">Gross KG</th>
                        <th className="text-right px-2 py-1 font-semibold">Cargo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {awbs.sort((a, b) => a.awb_number.localeCompare(b.awb_number)).map((a, i) => (
                        <tr key={i} className="border-t border-gray-100">
                          <td className="px-2 py-1.5 font-mono text-gray-700">{a.awb_number}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{a.pieces}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{a.gross_weight_kg.toLocaleString()}</td>
                          <td className="px-2 py-1.5 text-right font-mono">${(a.gross_weight_kg * (config?.flat_rate || 0.20)).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="font-semibold border-t-2 border-gray-300">
                      <tr>
                        <td className="px-2 py-1.5">TOTAL</td>
                        <td className="px-2 py-1.5 text-right font-mono">{awbs.reduce((s, a) => s + a.pieces, 0)}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{f.totalKg.toLocaleString()}</td>
                        <td className="px-2 py-1.5 text-right font-mono">${(f.chargeTotal || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Invoice Detail Modal */}
      {viewInvoice && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 overflow-y-auto" onClick={() => setViewInvoice(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl my-4" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-gray-800 text-lg">{viewInvoice.invoice_number}</h3>
                <p className="text-xs text-gray-400 mt-0.5">
                  {viewInvoice.mode === 'brackets' ? `Periodo: ${viewInvoice.period}` : `Vuelo: ${viewInvoice.flight_number}`}
                  {viewInvoice.due_date && ` — Vence: ${viewInvoice.due_date}`}
                  <span className="ml-2">{statusBadge(viewInvoice.status)}</span>
                </p>
              </div>
              <div className="flex items-center gap-2">
                {viewInvoice.status === 'draft' && (
                  <>
                    <button onClick={() => handleMarkSent(viewInvoice)} className="text-blue-600 hover:underline text-xs font-semibold">Marcar Enviada</button>
                    <button onClick={() => handleDelete(viewInvoice)} className="text-red-400 hover:text-red-600 text-xs">Eliminar</button>
                  </>
                )}
                {viewInvoice.status === 'sent' && (
                  <>
                    <button onClick={() => handleMarkPaid(viewInvoice)} className="text-green-600 hover:underline text-xs font-semibold">Marcar Pagada</button>
                    <button onClick={() => handleVoid(viewInvoice)} className="text-red-400 hover:text-red-600 text-xs">Anular</button>
                  </>
                )}
                {(viewInvoice.status === 'paid') && (
                  <button onClick={() => handleVoid(viewInvoice)} className="text-red-400 hover:text-red-600 text-xs">Anular</button>
                )}
                <button onClick={() => setViewInvoice(null)} className="text-gray-400 hover:text-gray-600 ml-2">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </div>
            <div className="px-6 py-5 max-h-[70vh] overflow-y-auto">
              {/* Flight summary */}
              {viewInvoice.flights.length > 1 && (
                <div className="mb-4">
                  <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">Vuelos en este periodo</h4>
                  <div className="flex flex-wrap gap-2">
                    {viewInvoice.flights.map((f, i) => (
                      <span key={i} className="bg-gray-100 rounded px-2 py-1 text-xs font-mono">
                        {f.flight_number} <span className="text-gray-400">({f.total_kg.toLocaleString()} kg)</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* AWB Lines */}
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">Detalle por AWB</h4>
              <table className="w-full text-xs mb-4 border-collapse">
                <thead className="bg-gray-50 text-gray-500 uppercase text-[10px]">
                  <tr>
                    <th className="text-left px-2 py-1.5 font-semibold">Vuelo</th>
                    <th className="text-left px-2 py-1.5 font-semibold">AWB</th>
                    <th className="text-right px-2 py-1.5 font-semibold">Gross KG</th>
                    <th className="text-right px-2 py-1.5 font-semibold">Rate</th>
                    <th className="text-right px-2 py-1.5 font-semibold">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {viewInvoice.lines.map((l, i) => (
                    <tr key={i} className="border-t border-gray-50">
                      <td className="px-2 py-1.5 text-gray-600">{l.flight_number}</td>
                      <td className="px-2 py-1.5 font-mono text-gray-800">{l.awb_number}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{l.gross_weight_kg.toLocaleString()}</td>
                      <td className="px-2 py-1.5 text-right font-mono">${l.rate.toFixed(4)}</td>
                      <td className="px-2 py-1.5 text-right font-mono">${l.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 font-semibold border-t-2 border-gray-300">
                  <tr>
                    <td className="px-2 py-1.5" colSpan={2}>SUBTOTAL</td>
                    <td className="px-2 py-1.5 text-right font-mono">{viewInvoice.total_kg.toLocaleString()}</td>
                    <td className="px-2 py-1.5" />
                    <td className="px-2 py-1.5 text-right font-mono">${viewInvoice.subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                  </tr>
                </tfoot>
              </table>

              {/* Bracket breakdown */}
              {viewInvoice.mode === 'brackets' && viewInvoice.bracket_breakdown.length > 0 && (
                <>
                  <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">Distribucion por Bracket</h4>
                  <table className="w-full text-xs mb-4 border-collapse">
                    <thead className="bg-blue-50 text-blue-600 uppercase text-[10px]">
                      <tr>
                        <th className="text-left px-2 py-1.5 font-semibold">Tramo</th>
                        <th className="text-right px-2 py-1.5 font-semibold">KG en Tramo</th>
                        <th className="text-right px-2 py-1.5 font-semibold">Rate</th>
                        <th className="text-right px-2 py-1.5 font-semibold">Subtotal</th>
                      </tr>
                    </thead>
                    <tbody>
                      {viewInvoice.bracket_breakdown.map((b, i) => (
                        <tr key={i} className="border-t border-blue-50">
                          <td className="px-2 py-1.5 text-gray-700">{b.bracket_label}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{b.kg_in_bracket.toLocaleString()}</td>
                          <td className="px-2 py-1.5 text-right font-mono">${b.rate.toFixed(4)}</td>
                          <td className="px-2 py-1.5 text-right font-mono">${b.subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              {/* Adjustment */}
              {viewInvoice.adjustment && viewInvoice.adjustment !== 0 && (
                <div className={`rounded-lg p-3 mb-4 text-xs ${viewInvoice.adjustment < 0 ? 'bg-green-50 border border-green-200 text-green-700' : 'bg-amber-50 border border-amber-200 text-amber-700'}`}>
                  <span className="font-semibold">Ajuste:</span> ${viewInvoice.adjustment.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  {viewInvoice.adjustment_note && <span className="ml-2 text-gray-500">— {viewInvoice.adjustment_note}</span>}
                </div>
              )}

              {/* Total */}
              <div className="bg-gray-800 text-white rounded-lg p-4 flex items-center justify-between">
                <span className="text-sm font-semibold">TOTAL</span>
                <span className="text-xl font-bold font-mono">${viewInvoice.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Brackets: Period Picker Modal */}
      {showPeriodPicker && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowPeriodPicker(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-gray-100">
              <h3 className="font-bold text-gray-800 text-lg">Generar Factura Quincenal</h3>
              <p className="text-xs text-gray-400 mt-1">Selecciona el periodo a facturar</p>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Ano</label>
                  <select value={selectedYear} onChange={e => setSelectedYear(Number(e.target.value))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm">
                    {[2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Mes</label>
                  <select value={selectedMonth} onChange={e => setSelectedMonth(Number(e.target.value))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm">
                    {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
                      <option key={m} value={m}>{new Date(2026, m - 1).toLocaleString('es', { month: 'long' })}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Quincena</label>
                <div className="flex gap-3">
                  {getQuincenalPeriods(selectedYear, selectedMonth).map((p, idx) => (
                    <label key={idx} className={`flex-1 p-3 rounded-lg border text-center cursor-pointer ${selectedPeriodIdx === idx ? 'border-mcl-blue bg-blue-50' : 'border-gray-200 hover:bg-gray-50'}`}>
                      <input type="radio" checked={selectedPeriodIdx === idx} onChange={() => setSelectedPeriodIdx(idx)} className="hidden" />
                      <div className="text-sm font-semibold text-gray-700">Q{idx + 1}</div>
                      <div className="text-[10px] text-gray-400">{p.start} — {p.end}</div>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
              <button onClick={() => setShowPeriodPicker(false)} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">Cancelar</button>
              <button
                onClick={handleGenerateBracket}
                disabled={generating}
                className="bg-mcl-blue text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-900 disabled:opacity-50"
              >
                {generating ? 'Generando...' : 'Generar Factura'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}
