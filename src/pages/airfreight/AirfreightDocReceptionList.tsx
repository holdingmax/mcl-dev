import { useState, useEffect, useMemo } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { collection, query, where, orderBy, onSnapshot, deleteDoc, doc, getDocs, getDoc, limit } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import Layout from '../../components/Layout'
import { fmtNum } from '../../lib/utils'
import { useSyncAlerts, alertsByAwb, SyncAlert } from '../../lib/useSyncAlerts'
import { AwbAlertPopup } from '../../components/SyncAlertPopup'

interface DocReception {
  id: string
  awb_number: string
  mawb_number: string | null
  awb_1st_leg: string | null
  awb_2nd_leg: string | null
  client_name: string
  agent_name?: string | null
  shipper_name: string
  consignee_name: string
  destination: string
  pieces: number
  weight: number
  chargeable_weight: number
  uld_number: string | null
  bup_number: string | null
  cargo_type: 'loose' | 'bup'
  warehouse_type: 'bonded' | 'local'
  flight_number: string
  driver_name: string
  driver_id_number: string
  driver_plate: string
  driver_company: string
  observations: string
  status: 'pending_physical' | 'in_physical' | 'complete'
  created_at: string
  created_by: string
  // booking reference
  booking_id: string | null
  flight_id: string | null
}

const ORIGIN_BADGE = (bookingId: string | null) =>
  bookingId
    ? <span className="text-[10px] bg-green-50 text-green-600 px-1.5 py-0.5 rounded-full">Booking</span>
    : <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full">Sin booking</span>

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  complete: { label: 'Completo', cls: 'bg-green-50 text-green-700' },
  pending_physical: { label: 'Pend. Fisica', cls: 'bg-amber-50 text-amber-700' },
  in_physical: { label: 'En Rec. Fisica', cls: 'bg-emerald-50 text-emerald-700' },
}

export default function AirfreightDocReceptionList() {
  const navigate = useNavigate()
  const { isDistribuidor, isClient, clientId } = useAuth()
  const [clientName, setClientName] = useState<string | null>(null)
  const [receptions, setReceptions] = useState<DocReception[]>([])
  const [flightStatusMap, setFlightStatusMap] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [clientFilter, setClientFilter] = useState('')
  // Date range filter: default to today-7 → today
  const [showDuplicates, setShowDuplicates] = useState(false)
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 7)
    return d.toISOString().slice(0, 10)
  })
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10))

  // Sync alerts
  const syncAlerts = useSyncAlerts()
  const awbAlertMap = alertsByAwb(syncAlerts)
  const [alertPopupAwb, setAlertPopupAwb] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DocReception | null>(null)

  // Load client name for filtering (client role only)
  useEffect(() => {
    if (!isClient || !clientId) return
    getDoc(doc(db, 'airfreight_clients', clientId)).then(snap => {
      if (snap.exists()) setClientName((snap.data() as any).name || null)
    })
  }, [isClient, clientId])

  useEffect(() => {
    setLoading(true)
    const constraints: any[] = [orderBy('created_at', 'desc')]
    if (dateFrom) constraints.push(where('created_at', '>=', dateFrom + 'T00:00:00'))
    if (dateTo) constraints.push(where('created_at', '<=', dateTo + 'T23:59:59'))
    constraints.push(limit(200))
    const q = query(collection(db, 'airfreight_doc_receptions'), ...constraints)
    const unsub = onSnapshot(q, (snap) => {
      setReceptions(snap.docs.map(d => ({ id: d.id, ...d.data() } as DocReception)))
      setLoading(false)
    })
    return unsub
  }, [dateFrom, dateTo])

  // Load flight statuses
  useEffect(() => {
    const flightIds = [...new Set(receptions.map(r => r.flight_id).filter(Boolean))] as string[]
    if (flightIds.length === 0) return
    // Query only the flights we need, batched by 30 (Firestore 'in' limit)
    const batches: string[][] = []
    for (let i = 0; i < flightIds.length; i += 30) batches.push(flightIds.slice(i, i + 30))
    Promise.all(batches.map(batch =>
      getDocs(query(collection(db, 'airfreight_flights'), where('__name__', 'in', batch)))
    )).then(snapshots => {
      const map: Record<string, string> = {}
      for (const snap of snapshots) {
        snap.docs.forEach(d => { map[d.id] = (d.data() as any).flight_status || 'booked' })
      }
      setFlightStatusMap(map)
    })
  }, [receptions])

  // Distribution status per reception: total pieces vs pieces with uld_id
  const [distStatus, setDistStatus] = useState<Record<string, { total: number; distributed: number }>>({})

  useEffect(() => {
    if (receptions.length === 0) return
    const ids = receptions.map(r => r.id)
    const batches: string[][] = []
    for (let i = 0; i < ids.length; i += 30) batches.push(ids.slice(i, i + 30))

    Promise.all(batches.map(batch =>
      getDocs(query(collection(db, 'airfreight_physical_pieces'), where('doc_reception_id', 'in', batch)))
    )).then(snapshots => {
      const map: Record<string, { total: number; distributed: number }> = {}
      for (const snap of snapshots) {
        for (const d of snap.docs) {
          const data = d.data()
          const rid = data.doc_reception_id as string
          if (!map[rid]) map[rid] = { total: 0, distributed: 0 }
          map[rid].total++
          if (data.uld_id) map[rid].distributed++
        }
      }
      setDistStatus(map)
    })
  }, [receptions])

  const clientOptions = useMemo(() =>
    [...new Set(receptions.map(r => r.client_name).filter(Boolean))].sort(),
  [receptions])

  const filtered = useMemo(() => {
    let list = receptions
    // Client role: only show their own receptions
    if (isClient && clientName) {
      list = list.filter(r => r.client_name === clientName)
    }
    if (clientFilter) {
      list = list.filter(r => r.client_name === clientFilter)
    }
    if (search) {
      const s = search.toLowerCase()
      list = list.filter(r =>
        (r.awb_number || '').toLowerCase().includes(s) ||
        (r.client_name || '').toLowerCase().includes(s) ||
        (r.shipper_name || '').toLowerCase().includes(s) ||
        (r.awb_2nd_leg || '').toLowerCase().includes(s)
      )
    }
    if (statusFilter) {
      list = list.filter(r => r.status === statusFilter)
    }
    if (showDuplicates) {
      const awbCount = new Map<string, number>()
      for (const r of list) {
        const awb = (r.awb_2nd_leg || r.awb_number || '').replace(/[-\s]/g, '')
        if (awb) awbCount.set(awb, (awbCount.get(awb) || 0) + 1)
      }
      list = list.filter(r => {
        const awb = (r.awb_2nd_leg || r.awb_number || '').replace(/[-\s]/g, '')
        return awb && (awbCount.get(awb) || 0) > 1
      })
    }
    return list
  }, [receptions, search, statusFilter, clientFilter, showDuplicates, isClient, clientName])

  function fmtDate(iso: string | undefined | null) {
    if (!iso) return '-'
    const d = new Date(iso)
    if (isNaN(d.getTime())) return '-'
    return d.toLocaleDateString('en-US', { day: '2-digit', month: 'short' }) +
      ', ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  }


  async function openWarehouseReceiptPDF(r: DocReception) {
    // Fetch pieces for this reception
    const snap = await getDocs(query(
      collection(db, 'airfreight_physical_pieces'),
      where('doc_reception_id', '==', r.id),
    ))
    const pieces = snap.docs
      .map(d => ({ id: d.id, ...d.data() } as any))
      .sort((a: any, b: any) => a.piece_number - b.piece_number)

    const totalWeight = pieces.reduce((s: number, p: any) => s + (p.weight_kg || 0), 0)
    const totalVolWeight = pieces.reduce((s: number, p: any) => {
      const vw = ((p.length_cm || 0) * (p.width_cm || 0) * (p.height_cm || 0)) / 6000
      return s + vw
    }, 0)
    const totalCBM = pieces.reduce((s: number, p: any) => {
      return s + ((p.length_cm || 0) * (p.width_cm || 0) * (p.height_cm || 0)) / 1_000_000
    }, 0)

    const warehouseNo = pieces.length > 0 ? (pieces[0].warehouse_number || '-') : '-'
    const awb = r.awb_2nd_leg || r.awb_number

    // Group identical pieces for PDF
    const pdfGroups: { count: number; p: any; nums: number[] }[] = []
    const pdfMap = new Map<string, { pieces: any[] }>()
    for (const p of pieces) {
      const k = `${p.weight_kg}|${p.length_cm}|${p.width_cm}|${p.height_cm}|${p.packing_type}|${p.condition}`
      if (!pdfMap.has(k)) pdfMap.set(k, { pieces: [] })
      pdfMap.get(k)!.pieces.push(p)
    }
    for (const [, grp] of pdfMap) {
      const nums = grp.pieces.map((x: any) => x.piece_number).sort((a: number, b: number) => a - b)
      pdfGroups.push({ count: grp.pieces.length, p: grp.pieces[0], nums })
    }

    const piecesRows = pdfGroups.map(g => {
      const vwPer = (((g.p.length_cm||0)*(g.p.width_cm||0)*(g.p.height_cm||0))/6000)
      const totalWt = (g.p.weight_kg || 0) * g.count
      const totalVw = vwPer * g.count
      return `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:center;font-weight:600">${g.count}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right">${fmtNum(totalWt)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:center">${fmtNum((g.p.length_cm || 0)/2.54,1)} x ${fmtNum((g.p.width_cm || 0)/2.54,1)} x ${fmtNum((g.p.height_cm || 0)/2.54,1)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right">${fmtNum(totalVw)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:center">${g.p.packing_type || '-'}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:center">${g.p.condition === 'damaged' ? '<span style="color:#dc2626">Damaged</span>' : 'OK'}</td>
      </tr>`
    }).join('')

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Warehouse Receipt - ${awb}</title>
<style>
  @page { size: A4; margin: 15mm; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1f2937; margin: 0; padding: 20px; font-size: 12px; }
  .header { display: flex; align-items: center; justify-content: space-between; border-bottom: 3px solid #1e3a5f; padding-bottom: 15px; margin-bottom: 20px; }
  .logo-area { display: flex; align-items: center; gap: 12px; }
  .logo-box { width: 50px; height: 50px; background: #1e3a5f; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: white; font-weight: 800; font-size: 14px; letter-spacing: 1px; }
  .company-name { font-size: 22px; font-weight: 700; color: #1e3a5f; letter-spacing: 1px; }
  .company-sub { font-size: 10px; color: #6b7280; margin-top: 2px; }
  .doc-title { font-size: 18px; font-weight: 700; color: #1e3a5f; text-align: right; }
  .doc-number { font-size: 13px; color: #6b7280; text-align: right; margin-top: 4px; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
  .info-box { border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px; }
  .info-box h3 { font-size: 11px; text-transform: uppercase; color: #6b7280; margin: 0 0 10px; letter-spacing: 0.5px; }
  .info-row { display: flex; justify-content: space-between; margin-bottom: 6px; }
  .info-label { color: #6b7280; font-size: 11px; }
  .info-value { font-weight: 600; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  thead th { background: #1e3a5f; color: white; padding: 8px 10px; text-align: left; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
  .totals { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 20px; }
  .total-box { background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; text-align: center; }
  .total-box .label { font-size: 10px; text-transform: uppercase; color: #6b7280; margin-bottom: 4px; }
  .total-box .value { font-size: 18px; font-weight: 700; color: #1e3a5f; }
  .footer { margin-top: 30px; padding-top: 15px; border-top: 2px solid #e5e7eb; display: flex; justify-content: space-between; }
  .sign-box { width: 200px; text-align: center; }
  .sign-line { border-top: 1px solid #9ca3af; margin-top: 50px; padding-top: 6px; font-size: 10px; color: #6b7280; }
  .stamp { position: absolute; top: 200px; right: 60px; font-size: 48px; font-weight: 800; color: rgba(34,197,94,0.15); transform: rotate(-15deg); letter-spacing: 4px; }
  @media print { body { padding: 0; } .no-print { display: none; } }
</style>
</head><body>
  <div class="no-print" style="text-align:right;margin-bottom:10px">
    <button onclick="window.print()" style="padding:8px 20px;background:#1e3a5f;color:white;border:none;border-radius:6px;cursor:pointer;font-size:13px">Imprimir</button>
  </div>

  ${r.status === 'complete' ? '<div class="stamp">RECEIVED</div>' : ''}

  <div class="header">
    <div class="logo-area">
      <div class="logo-box">MCL</div>
      <div>
        <div class="company-name">MINCURL LOGISTICS</div>
        <div class="company-sub">Warehouse Management System</div>
      </div>
    </div>
    <div>
      <div class="doc-title">WAREHOUSE RECEIPT</div>
      <div class="doc-number">WR-${warehouseNo}</div>
      <div class="doc-number">${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' })}</div>
    </div>
  </div>

  <div class="info-grid">
    <div class="info-box">
      <h3>Shipment Information</h3>
      <div class="info-row"><span class="info-label">AWB Number</span><span class="info-value">${awb}</span></div>
      ${r.mawb_number && r.mawb_number !== awb ? `<div class="info-row"><span class="info-label">MAWB</span><span class="info-value">${r.mawb_number}</span></div>` : ''}
      <div class="info-row"><span class="info-label">Flight</span><span class="info-value">${r.flight_number || '-'}</span></div>
      <div class="info-row"><span class="info-label">Cargo Type</span><span class="info-value">${r.cargo_type === 'bup' ? 'BUP' + (r.uld_number ? ' - ' + r.uld_number : '') : 'Loose'}</span></div>
      <div class="info-row"><span class="info-label">Warehouse</span><span class="info-value">${r.warehouse_type === 'bonded' ? 'Bonded' : 'Local'}</span></div>
      <div class="info-row"><span class="info-label">Destination</span><span class="info-value">${r.destination || '-'}</span></div>
      <div class="info-row"><span class="info-label">Declared Pieces</span><span class="info-value">${fmtNum(r.pieces)}</span></div>
      <div class="info-row"><span class="info-label">Declared Weight</span><span class="info-value">${fmtNum(r.weight)} kg</span></div>
    </div>
    <div class="info-box">
      <h3>Parties</h3>
      <div class="info-row"><span class="info-label">Client</span><span class="info-value">${r.client_name || '-'}</span></div>
      ${r.agent_name ? `<div class="info-row"><span class="info-label">Agent</span><span class="info-value">${r.agent_name}</span></div>` : ''}
      <div class="info-row"><span class="info-label">Shipper</span><span class="info-value">${r.shipper_name || '-'}</span></div>
      <div class="info-row"><span class="info-label">Consignee</span><span class="info-value">${r.consignee_name || '-'}</span></div>
      <div class="info-row"><span class="info-label">Driver</span><span class="info-value">${r.driver_name || '-'}</span></div>
      <div class="info-row"><span class="info-label">Plate</span><span class="info-value">${r.driver_plate || '-'}</span></div>
      <div class="info-row"><span class="info-label">Company</span><span class="info-value">${r.driver_company || '-'}</span></div>
    </div>
  </div>

  <h3 style="font-size:13px;color:#1e3a5f;margin-bottom:10px">Piece Detail</h3>
  <table>
    <thead>
      <tr>
        <th style="text-align:center">Qty</th>
        <th style="text-align:right">Weight (kg)</th>
        <th style="text-align:center">Dimensions (in)</th>
        <th style="text-align:right">Vol Wt (kg)</th>
        <th style="text-align:center">Packing</th>
        <th style="text-align:center">Condition</th>
      </tr>
    </thead>
    <tbody>
      ${piecesRows || '<tr><td colspan="6" style="padding:20px;text-align:center;color:#9ca3af">No pieces registered</td></tr>'}
    </tbody>
  </table>

  <div class="totals">
    <div class="total-box">
      <div class="label">Total Pieces</div>
      <div class="value">${pieces.length} / ${r.pieces}</div>
    </div>
    <div class="total-box">
      <div class="label">Gross Weight</div>
      <div class="value">${fmtNum(totalWeight)} kg</div>
    </div>
    <div class="total-box">
      <div class="label">Vol. Weight</div>
      <div class="value">${fmtNum(totalVolWeight)} kg</div>
    </div>
    <div class="total-box">
      <div class="label">Total CBM</div>
      <div class="value">${fmtNum(totalCBM, 4)} m&sup3;</div>
    </div>
  </div>

  ${r.observations ? `<div style="margin-top:16px;padding:10px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;font-size:11px"><strong>Observations:</strong> ${r.observations}</div>` : ''}

  <div class="footer">
    <div class="sign-box">
      <div class="sign-line">Received By (Warehouse)</div>
    </div>
    <div class="sign-box">
      <div class="sign-line">Delivered By (Driver)</div>
    </div>
  </div>

  <div style="text-align:center;margin-top:20px;font-size:9px;color:#9ca3af">
    Generated by MINCURL WMS &mdash; ${new Date().toISOString()}
  </div>
</body></html>`

    const w = window.open('', '_blank')
    if (w) { w.document.write(html); w.document.close() }
  }

  return (
    <Layout
      title="Recepcion Documental"
      backTo="/airfreight"
    >
      <div className="max-w-[1400px] mx-auto px-4 py-4">
        {/* Filters */}
        <div className="flex flex-wrap gap-3 mb-4">
          <input
            type="text"
            placeholder="Buscar AWB..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-64 focus:outline-none focus:border-blue-800"
          />
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-600"
          >
            <option value="">Todos los estados</option>
            <option value="pending_physical">Pendiente recepcion fisica</option>
            <option value="in_physical">En recepcion fisica</option>
            <option value="complete">Completo</option>
          </select>
          {!isClient && (
            <select
              value={clientFilter}
              onChange={e => setClientFilter(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-600"
            >
              <option value="">Todos los clientes</option>
              {clientOptions.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          )}
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-gray-500">Desde</label>
            <input
              type="date"
              value={dateFrom}
              onChange={e => setDateFrom(e.target.value)}
              className="border border-gray-200 rounded-lg px-2 py-2 text-sm text-gray-600 focus:outline-none focus:border-blue-800"
            />
            <label className="text-xs text-gray-500">Hasta</label>
            <input
              type="date"
              value={dateTo}
              onChange={e => setDateTo(e.target.value)}
              className="border border-gray-200 rounded-lg px-2 py-2 text-sm text-gray-600 focus:outline-none focus:border-blue-800"
            />
          </div>
          {!isClient && (
            <button
              onClick={() => setShowDuplicates(v => !v)}
              className={`px-3 py-2 text-xs font-semibold rounded-lg border transition-colors ${
                showDuplicates
                  ? 'bg-red-50 text-red-700 border-red-300'
                  : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
              }`}
            >
              Duplicadas
            </button>
          )}
          <div className="flex-1" />
          {!isClient && (
            <Link
              to="/airfreight/physical-reception"
              className="px-4 py-2 bg-gray-500 text-white text-sm font-semibold rounded-lg hover:bg-gray-600 transition-colors"
            >
              Rec. Fisica
            </Link>
          )}
          {!isDistribuidor && !isClient && (
            <button
              onClick={() => navigate('/airfreight/doc-reception/new')}
              className="px-4 py-2 bg-blue-800 text-white text-sm font-semibold rounded-lg hover:bg-blue-900 transition-colors"
            >
              + Nueva Recepcion
            </button>
          )}
        </div>

        {/* Table */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
          {loading ? (
            <div className="p-8 text-center text-gray-400">Cargando...</div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-gray-400">No hay recepciones documentales</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-2 py-2 font-semibold text-gray-500 uppercase tracking-wide text-[10px]">AWB</th>
                  <th className="text-left px-2 py-2 font-semibold text-gray-500 uppercase tracking-wide text-[10px]">Cliente</th>
                  <th className="text-left px-2 py-2 font-semibold text-gray-500 uppercase tracking-wide text-[10px]">Agent</th>
                  <th className="text-left px-2 py-2 font-semibold text-gray-500 uppercase tracking-wide text-[10px]">Tipo</th>
                  <th className="text-center px-2 py-2 font-semibold text-gray-500 uppercase tracking-wide text-[10px]">Pzas</th>
                  <th className="text-right px-2 py-2 font-semibold text-gray-500 uppercase tracking-wide text-[10px]">Peso</th>
                  <th className="text-right px-2 py-2 font-semibold text-gray-500 uppercase tracking-wide text-[10px]">Chg Wt</th>
                  <th className="text-left px-2 py-2 font-semibold text-gray-500 uppercase tracking-wide text-[10px]">Alm</th>
                  <th className="text-left px-2 py-2 font-semibold text-gray-500 uppercase tracking-wide text-[10px]">Vuelo</th>
                  <th className="text-left px-2 py-2 font-semibold text-gray-500 uppercase tracking-wide text-[10px]">Driver</th>
                  <th className="text-left px-2 py-2 font-semibold text-gray-500 uppercase tracking-wide text-[10px]">Fecha</th>
                  <th className="text-left px-2 py-2 font-semibold text-gray-500 uppercase tracking-wide text-[10px]">Estado</th>
                  {!isClient && <th className="text-center px-1 py-2 font-semibold text-gray-500 uppercase tracking-wide text-[10px]">Rec.F</th>}
                  <th className="text-center px-1 py-2 font-semibold text-gray-500 uppercase tracking-wide text-[10px]">WR</th>
                  {!isClient && <th className="text-center px-1 py-2 font-semibold text-gray-500 uppercase tracking-wide text-[10px]">Dist</th>}
                  {!isClient && <th className="px-1 py-2 w-8"></th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map(r => {
                  const st = STATUS_LABELS[r.status] || { label: r.status, cls: 'bg-gray-50 text-gray-600' }
                  return (
                    <tr
                      key={r.id}
                      onClick={() => !isDistribuidor && !isClient && navigate(`/airfreight/doc-reception/${r.id}/edit`)}
                      className={`hover:bg-gray-50 ${isDistribuidor || isClient ? '' : 'cursor-pointer'}`}
                    >
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-1">
                          <span className="font-mono font-semibold text-blue-800 text-[11px]">{r.awb_2nd_leg || r.awb_number}</span>
                          {(() => {
                            const awbKey = r.awb_2nd_leg || r.awb_number
                            const alerts = (awbAlertMap.get(awbKey) || []).filter(a => a.status === 'pending')
                            if (alerts.length === 0) return null
                            const isCritical = alerts.some(a => a.alert_type === 'built_change' || a.alert_type === 'dispatched_change')
                            return (
                              <button
                                onClick={e => { e.stopPropagation(); setAlertPopupAwb(awbKey) }}
                                title={isCritical ? 'Alerta critica: guia distribuida/despachada' : 'Alerta: cambios detectados'}
                                className={`${isCritical ? 'text-red-500 hover:text-red-700' : 'text-amber-500 hover:text-amber-700'} transition-colors`}
                              >
                                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                                  <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
                                </svg>
                              </button>
                            )
                          })()}
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-gray-700">
                        <div className="leading-tight">{r.client_name || <span className="text-gray-400 italic">-</span>}</div>
                        <div>{ORIGIN_BADGE(r.booking_id)}</div>
                      </td>
                      <td className="px-2 py-1.5 text-gray-500 text-[10px]">
                        {r.agent_name || ''}
                      </td>
                      <td className="px-2 py-1.5">
                        {r.cargo_type === 'bup' ? (
                          <span className="text-[10px] bg-purple-50 text-purple-700 px-1.5 py-0.5 rounded-full whitespace-nowrap">
                            BUP{(r.bup_number || r.uld_number) ? ` - ${r.bup_number || r.uld_number}` : ''}
                          </span>
                        ) : (
                          <span className="text-[10px] bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded-full">Loose</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-center text-gray-700">{fmtNum(r.pieces)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-gray-700">{fmtNum(r.weight)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-gray-700">{fmtNum(r.chargeable_weight)}</td>
                      <td className="px-2 py-1.5">
                        {r.warehouse_type === 'bonded' ? (
                          <span className="text-[10px] bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded font-medium">Bonded</span>
                        ) : (
                          <span className="text-[10px] bg-emerald-50 text-emerald-700 px-1.5 py-0.5 rounded font-medium">Local</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        {r.flight_number ? (
                          <div className="flex items-center gap-1">
                            <span className="text-gray-600 font-mono text-[11px]">{r.flight_number}</span>
                            {(() => {
                              const fs = r.flight_id ? (flightStatusMap[r.flight_id] || 'booked') : 'booked'
                              const fsColors: Record<string, string> = {
                                booked: 'bg-gray-400',
                                in_progress: 'bg-blue-500',
                                built: 'bg-purple-500',
                                dispatched: 'bg-emerald-500',
                              }
                              const fsLabels: Record<string, string> = {
                                booked: 'Booked',
                                in_progress: 'In Progress',
                                built: 'Built',
                                dispatched: 'Dispatched',
                              }
                              return (
                                <span
                                  title={fsLabels[fs] || fs}
                                  className={`inline-block w-2 h-2 rounded-full ${fsColors[fs] || 'bg-gray-300'}`}
                                />
                              )
                            })()}
                          </div>
                        ) : (
                          <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-medium">Sin vuelo</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-gray-600 text-[11px] max-w-[100px] truncate">{r.driver_name || '-'}</td>
                      <td className="px-2 py-1.5 text-gray-500 text-[10px] whitespace-nowrap">{fmtDate(r.created_at)}</td>
                      <td className="px-2 py-1.5">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${st.cls}`}>{st.label}</span>
                      </td>
                      {/* Physical reception link */}
                      {!isClient && (
                        <td className="px-1 py-1.5 text-center">
                          <Link
                            to={`/airfreight/physical-reception?id=${r.id}`}
                            onClick={e => e.stopPropagation()}
                            className="text-gray-400 hover:text-blue-700 transition-colors"
                            title="Ir a recepcion fisica"
                          >
                            <svg className="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                            </svg>
                          </Link>
                        </td>
                      )}
                      {/* Warehouse receipt PDF */}
                      <td className="px-1 py-1.5 text-center">
                        {r.status === 'complete' ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              openWarehouseReceiptPDF(r)
                            }}
                            className="text-gray-400 hover:text-red-600 transition-colors"
                            title="Ver Warehouse Receipt PDF"
                          >
                            <svg className="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                            </svg>
                          </button>
                        ) : (
                          <span className="text-gray-300">
                            <svg className="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                            </svg>
                          </span>
                        )}
                      </td>
                      {/* Distribution — link to Build-up */}
                      {!isClient && (
                        <td className="px-1 py-1.5 text-center">
                          {(() => {
                            const ds = distStatus[r.id]
                            const isDistributed = ds && ds.total > 0 && ds.distributed === ds.total
                            return isDistributed ? (
                              <Link
                                to={`/airfreight/buildup?flight=${r.flight_id}`}
                                onClick={(e) => e.stopPropagation()}
                                className="text-gray-700 hover:text-blue-800 transition-colors"
                                title="Ver distribución del vuelo"
                              >
                                <svg className="w-4 h-4 inline" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12" />
                                </svg>
                              </Link>
                            ) : (
                              <span className="text-gray-300" title={ds ? `${ds.distributed}/${ds.total} piezas distribuidas` : 'Sin piezas'}>
                                <svg className="w-4 h-4 inline" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12" />
                                </svg>
                              </span>
                            )
                          })()}
                        </td>
                      )}
                      {!isClient && (
                        <td className="px-1 py-1.5">
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setDeleteTarget(r)
                            }}
                            className="text-red-400 hover:text-red-600 transition-colors"
                            title="Borrar"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Sync Alert Popup (AWB level) */}
      {alertPopupAwb && (() => {
        const alerts = (awbAlertMap.get(alertPopupAwb) || []).filter(a => a.status === 'pending')
        if (alerts.length === 0) return null
        return <AwbAlertPopup alerts={alerts} onClose={() => setAlertPopupAwb(null)} />
      })()}

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setDeleteTarget(null)}>
          <div className="bg-white rounded-xl p-6 max-w-sm mx-4 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-bold text-gray-800 mb-2">Eliminar recepcion</h3>
            <p className="text-sm text-gray-600 mb-4">
              ¿Esta seguro que desea eliminar la recepcion de <span className="font-semibold text-blue-800">{deleteTarget.awb_2nd_leg || deleteTarget.awb_number}</span>?
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                className="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200"
              >
                Cancelar
              </button>
              <button
                onClick={async () => {
                  await deleteDoc(doc(db, 'airfreight_doc_receptions', deleteTarget.id))
                  setDeleteTarget(null)
                }}
                className="px-4 py-2 text-sm text-white bg-red-600 rounded-lg hover:bg-red-700"
              >
                Eliminar
              </button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}
