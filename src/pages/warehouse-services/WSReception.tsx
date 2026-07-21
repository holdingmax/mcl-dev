import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  doc, getDoc, updateDoc, addDoc, collection, getDocs, writeBatch, runTransaction,
} from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import Layout from '../../components/Layout'
import type { WSServiceOrder, WRLine, WarehouseReceipt, WSBreakdownAwb } from '../../types'
import { PACKING_TYPES } from '../../types'
import { calculateBondedFee } from '../../lib/wsBilling'
import { calculateCBM, computeTotals, emptyLine, fmtNum } from '../../lib/utils'
import { printLabels } from '../../lib/printLabels'

async function getNextWSWRNumber(): Promise<string> {
  const seqRef = doc(db, 'config', 'ws_wr_sequence')
  const nextNum = await runTransaction(db, async (tx) => {
    const seqDoc = await tx.get(seqRef)
    const current = seqDoc.exists() ? (seqDoc.data().last_num || 0) : 0
    const next = current + 1
    tx.set(seqRef, { last_num: next })
    return next
  })
  return 'WS-' + String(nextNum).padStart(6, '0')
}

function toBase64(file: File, maxPx = 700, quality = 0.75): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        let w = img.width, h = img.height
        if (w > maxPx || h > maxPx) {
          if (w > h) { h = Math.round(h * maxPx / w); w = maxPx }
          else { w = Math.round(w * maxPx / h); h = maxPx }
        }
        canvas.width = w; canvas.height = h
        canvas.getContext('2d')!.drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', quality))
      }
      img.onerror = reject
      img.src = reader.result as string
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export default function WSReception() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user, isAdmin, isSuperAgent, isAgent, isCounter, isBodega } = useAuth()
  const canOperate = isAdmin || isSuperAgent || isAgent || isCounter || isBodega

  const [order, setOrder] = useState<WSServiceOrder | null>(null)
  const [wr, setWr] = useState<WarehouseReceipt | null>(null)
  const [lines, setLines] = useState<WRLine[]>([emptyLine(1)])
  const [breakdownAwbs, setBreakdownAwbs] = useState<WSBreakdownAwb[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const photoInputRefs = useRef<(HTMLInputElement | null)[]>([])

  useEffect(() => {
    if (!id) return
    loadData()
  }, [id])

  async function loadData() {
    setLoading(true)
    try {
      // Load SO
      const soSnap = await getDoc(doc(db, 'warehouse_service_orders', id!))
      if (!soSnap.exists()) { setLoading(false); return }
      const so = { id: soSnap.id, ...soSnap.data() } as WSServiceOrder
      setOrder(so)

      // Load breakdown AWBs if present
      if (so.breakdown_awbs?.length) {
        setBreakdownAwbs(so.breakdown_awbs)
      }

      // Load existing WR if already created
      if (so.wr_id) {
        const wrSnap = await getDoc(doc(db, 'warehouse_receipts', so.wr_id))
        if (wrSnap.exists()) {
          setWr({ id: wrSnap.id, ...wrSnap.data() } as WarehouseReceipt)
          // Load existing lines
          const linesSnap = await getDocs(collection(db, 'warehouse_receipts', so.wr_id, 'lines'))
          const existing = linesSnap.docs
            .map(d => ({ id: d.id, ...d.data() } as WRLine))
            .sort((a, b) => (a.line_order || 0) - (b.line_order || 0))
          if (existing.length > 0) setLines(existing)
        }
      }
    } catch (e) {
      console.error('Load error', e)
    }
    setLoading(false)
  }

  // Line helpers
  function updateLine(idx: number, field: string, value: unknown) {
    setLines(prev => prev.map((l, i) => {
      if (i !== idx) return l
      const updated = { ...l, [field]: value }
      if (['length_cm', 'width_cm', 'height_cm', 'qty'].includes(field)) {
        updated.cbm = calculateCBM(
          field === 'length_cm' ? value as number : updated.length_cm,
          field === 'width_cm' ? value as number : updated.width_cm,
          field === 'height_cm' ? value as number : updated.height_cm,
          field === 'qty' ? value as number : updated.qty,
        )
      }
      return updated
    }))
  }

  function addLine() {
    setLines(prev => [...prev, emptyLine(prev.length + 1)])
  }

  function removeLine(idx: number) {
    if (lines.length === 1) return
    setLines(prev => prev.filter((_, i) => i !== idx).map((l, i) => ({ ...l, line_order: i + 1 })))
  }

  async function handlePhoto(idx: number, e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const b64 = await toBase64(file)
    setLines(prev => prev.map((l, i) => i !== idx ? l : {
      ...l,
      photo_urls: [...(l.photo_urls || []), b64],
    }))
    e.target.value = ''
  }

  const isBreakdownBup = !!(order?.breakdown_awbs?.length)

  async function handleSave(complete: boolean) {
    if (!order) return
    setSaving(true)
    try {
      const isBreakdown = !!(order.breakdown_awbs?.length)
      // For breakdown BUP, build totals from confirmed AWBs instead of WR lines
      const totals = isBreakdown
        ? {
            total_qty: breakdownAwbs.reduce((s, a) => s + (a.received_pieces ?? a.pieces), 0),
            total_cbm: 0,
            total_weight_kg: breakdownAwbs.reduce((s, a) => s + (a.received_weight_kg ?? a.weight_kg), 0),
          }
        : computeTotals(lines)
      const now = new Date().toISOString()
      let wrId = order.wr_id

      if (!wrId) {
        // Create WR from SO data
        const wrNumber = await getNextWSWRNumber()
        const wrData = {
          wr_number: wrNumber,
          company_name: order.client_name,
          po_number: order.reference || order.so_number,
          to_port: '',
          driver_name: order.driver_name || '',
          driver_license: order.driver_license || '',
          declared_pieces: order.declared_pieces,
          observations: order.cargo_description,
          cargo_type: order.cargo_mode === 'BOND' ? 'BOND' : 'LOC',
          notify_to: '',
          client_id: order.client_id,
          client_name: order.client_name,
          consignee_name: '',
          consignee_id: null,
          from_port: 'MIA',
          status: 'LOCAL',
          source: 'warehouse_services',
          so_id: order.id,
          so_number: order.so_number,
          awb_number: order.awb_number || '',
          counter_status: 'complete',
          physical_status: complete ? 'complete' : 'pending',
          physical_by: complete ? user?.uid : null,
          counter_by: user?.uid,
          total_qty: totals.total_qty,
          total_cbm: totals.total_cbm,
          total_weight_kg: totals.total_weight_kg,
          created_at: now,
          updated_at: now,
        }
        const wrRef = await addDoc(collection(db, 'warehouse_receipts'), wrData)
        wrId = wrRef.id

        // Link WR to SO + auto-activate in_out/storage
        const soUpdate: Record<string, unknown> = {
          wr_id: wrId,
          received_at: complete ? now : null,
          global_status: complete ? 'received' : order.global_status,
        }
        if (isBreakdown) {
          soUpdate.breakdown_awbs = breakdownAwbs.map(a => ({
            ...a,
            received_pieces: a.received_pieces ?? a.pieces,
            received_weight_kg: a.received_weight_kg ?? a.weight_kg,
            confirmed: complete,
          }))
        }
        if (complete) {
          soUpdate.service_items = order.service_items.map(item => {
            if ((item.type === 'in_out' || item.type === 'storage' || item.type === 'breakdown_bup') && item.status === 'pending') {
              return { ...item, status: 'in_progress', started_at: now }
            }
            return item
          })
        }
        await updateDoc(doc(db, 'warehouse_service_orders', order.id!), soUpdate)

        // Generate bonded fee if applicable
        try {
          const bondedFee = await calculateBondedFee(order.client_id, order.cargo_mode)
          if (bondedFee) {
            await addDoc(collection(db, 'ws_billing_charges'), {
              so_id: order.id,
              so_number: order.so_number,
              client_id: order.client_id,
              client_name: order.client_name,
              service_type: bondedFee.service_type,
              description: bondedFee.description,
              amount: bondedFee.amount,
              currency: 'USD',
              status: 'pending',
              rate_id: bondedFee.rate_id,
              qty: bondedFee.qty || null,
              rate_price: bondedFee.rate_price || null,
              rate_unit: bondedFee.rate_unit || null,
              detail: bondedFee.detail || null,
              wr_id: wrId,
              created_at: now,
              created_by: user?.email || '',
            })
          }
        } catch (e) {
          console.error('Error generating bonded fee:', e)
        }
      } else {
        // Update existing WR
        const updateData: Record<string, unknown> = {
          ...totals,
          updated_at: now,
        }
        if (complete) {
          updateData.physical_status = 'complete'
          updateData.physical_by = user?.uid
        }
        await updateDoc(doc(db, 'warehouse_receipts', wrId), updateData)

        if (complete && order.global_status !== 'received') {
          const soUpdate2: Record<string, unknown> = {
            received_at: now,
            global_status: 'received',
          }
          if (isBreakdown) {
            soUpdate2.breakdown_awbs = breakdownAwbs.map(a => ({
              ...a,
              received_pieces: a.received_pieces ?? a.pieces,
              received_weight_kg: a.received_weight_kg ?? a.weight_kg,
              confirmed: true,
            }))
          }
          // Auto-activate in_out/storage on first complete
          soUpdate2.service_items = order.service_items.map(item => {
            if ((item.type === 'in_out' || item.type === 'storage' || item.type === 'breakdown_bup') && item.status === 'pending') {
              return { ...item, status: 'in_progress', started_at: now }
            }
            return item
          })
          await updateDoc(doc(db, 'warehouse_service_orders', order.id!), soUpdate2)
        }
      }

      // Save lines: delete existing + re-insert (skip for breakdown BUP — data is in breakdown_awbs)
      if (!isBreakdown) {
        const batch = writeBatch(db)
        const existingLinesSnap = await getDocs(collection(db, 'warehouse_receipts', wrId, 'lines'))
        existingLinesSnap.docs.forEach(d => batch.delete(d.ref))
        for (const line of lines) {
          const lineRef = doc(collection(db, 'warehouse_receipts', wrId, 'lines'))
          const { id: _id, ...lineData } = line as WRLine & { id?: string }
          batch.set(lineRef, lineData)
        }
        await batch.commit()
      }

      if (complete) {
        navigate(`/warehouse-services/orders/${order.id}`)
      } else {
        alert('Draft saved.')
        await loadData()
      }
    } catch (e) {
      alert('Error: ' + (e instanceof Error ? e.message : String(e)))
    }
    setSaving(false)
  }

  const totals = computeTotals(lines)
  const inputClass = 'w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30'

  if (loading) return <Layout title="Physical Reception" backTo={`/warehouse-services/orders/${id}`}><div className="text-center py-20 text-gray-400">Loading...</div></Layout>
  if (!order) return <Layout title="Physical Reception" backTo="/warehouse-services"><div className="text-center py-20 text-gray-400">Order not found</div></Layout>

  if (!canOperate) {
    return <Layout title="Reception" backTo="/warehouse-services"><p className="text-center text-gray-500 mt-10">Access restricted</p></Layout>
  }

  // Breakdown BUP totals
  const bdRecTotalPcs = breakdownAwbs.reduce((s, a) => s + (a.received_pieces ?? a.pieces), 0)
  const bdRecTotalKg = breakdownAwbs.reduce((s, a) => s + (a.received_weight_kg ?? a.weight_kg), 0)

  return (
    <Layout title={`Reception — ${order.so_number}`} backTo={`/warehouse-services/orders/${order.id}`}>
      <div className="max-w-5xl mx-auto px-4 py-6">
        {/* SO Summary */}
        <div className="bg-white rounded-xl shadow-sm border p-4 mb-4">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
            <div>
              <div className="text-xs text-gray-400 uppercase">SO</div>
              <div className="font-mono font-bold text-mcl-blue">{order.so_number}</div>
            </div>
            <div>
              <div className="text-xs text-gray-400 uppercase">Client</div>
              <div>{order.client_name}</div>
            </div>
            {!isBreakdownBup && (
              <div>
                <div className="text-xs text-gray-400 uppercase">AWB</div>
                <div className="font-mono">{order.awb_number || '—'}</div>
              </div>
            )}
            <div>
              <div className="text-xs text-gray-400 uppercase">Declared Pieces</div>
              <div>{order.declared_pieces}</div>
            </div>
            <div>
              <div className="text-xs text-gray-400 uppercase">Declared Weight</div>
              <div>{order.declared_weight ? `${order.declared_weight} kg` : '—'}</div>
            </div>
          </div>
        </div>

        {/* ── Breakdown BUP: AWB confirmation table ── */}
        {isBreakdownBup ? (
          <div className="bg-white rounded-xl shadow-sm border p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-gray-800 uppercase text-sm">Breakdown BUP — Confirm AWBs</h3>
              <span className="text-xs bg-amber-100 text-amber-700 px-2.5 py-1 rounded-full font-semibold">{breakdownAwbs.length} AWB{breakdownAwbs.length !== 1 ? 's' : ''}</span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] text-gray-500 uppercase border-b border-gray-200">
                    <th className="px-2 py-2 text-center w-8">#</th>
                    <th className="px-2 py-2 text-left">AWB Number</th>
                    <th className="px-2 py-2 text-center">Declared Pcs</th>
                    <th className="px-2 py-2 text-center">Gross Wt (kg)</th>
                    <th className="px-2 py-2 text-center">Received Pcs</th>
                    <th className="px-2 py-2 text-center">CHW (kg)</th>
                    <th className="px-2 py-2 text-center w-12">OK</th>
                  </tr>
                </thead>
                <tbody>
                  {breakdownAwbs.map((awb, idx) => (
                    <tr key={idx} className="border-b border-gray-50 hover:bg-gray-50/50 align-middle">
                      <td className="px-2 py-2 text-center text-xs text-gray-400 font-bold">{idx + 1}</td>
                      <td className="px-2 py-2 font-mono font-semibold text-gray-800">{awb.awb_number}</td>
                      <td className="px-2 py-2 text-center text-gray-500">{awb.pieces}</td>
                      <td className="px-2 py-2 text-center text-gray-500">{awb.weight_kg}</td>
                      <td className="px-2 py-2">
                        <input
                          type="number" min="0"
                          value={awb.received_pieces ?? awb.pieces}
                          onChange={e => {
                            const a = [...breakdownAwbs]
                            a[idx] = { ...a[idx], received_pieces: parseInt(e.target.value) || 0 }
                            setBreakdownAwbs(a)
                          }}
                          className={inputClass + ' w-20 text-center'}
                        />
                      </td>
                      <td className="px-2 py-2">
                        <input
                          type="number" min="0" step="0.1"
                          value={awb.received_weight_kg ?? awb.weight_kg}
                          onChange={e => {
                            const a = [...breakdownAwbs]
                            a[idx] = { ...a[idx], received_weight_kg: parseFloat(e.target.value) || 0 }
                            setBreakdownAwbs(a)
                          }}
                          className={inputClass + ' w-24 text-center'}
                        />
                      </td>
                      <td className="px-2 py-2 text-center">
                        {(awb.received_pieces ?? awb.pieces) === awb.pieces
                          ? <span className="text-green-600 font-bold">&#10003;</span>
                          : <span className="text-amber-500 font-bold">&#9888;</span>
                        }
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Totals */}
            <div className="mt-4 pt-4 border-t border-gray-100 grid grid-cols-2 gap-4 text-center">
              <div>
                <div className="text-2xl font-bold text-gray-800">{bdRecTotalPcs}</div>
                <div className="text-xs text-gray-400">Total Received Pieces</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-gray-800">{fmtNum(bdRecTotalKg, 1)}</div>
                <div className="text-xs text-gray-400">Total Received KG</div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => handleSave(false)}
                disabled={saving}
                className="flex-1 border border-gray-300 text-gray-700 px-4 py-3 rounded-xl text-sm hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                Save Draft
              </button>
              <button
                onClick={() => handleSave(true)}
                disabled={saving}
                className="flex-1 bg-mcl-blue text-white px-4 py-3 rounded-xl text-sm font-semibold hover:bg-blue-900 transition-colors disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Complete Reception'}
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* ── Standard Lines table ── */}
            <div className="bg-white rounded-xl shadow-sm border p-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-bold text-gray-800 uppercase text-sm">Líneas de Carga</h3>
                <button onClick={addLine} className="text-xs bg-mcl-blue text-white px-3 py-1.5 rounded-lg hover:bg-blue-900 transition-colors">
                  + Agregar línea
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[10px] text-gray-500 uppercase border-b border-gray-200">
                      <th className="px-1 py-2 text-center w-8">#</th>
                      <th className="px-1 py-2 text-left">Tipo</th>
                      <th className="px-1 py-2 text-center w-8">LB</th>
                      <th className="px-1 py-2 text-center w-8">DG</th>
                      <th className="px-1 py-2 text-center w-16">Qty</th>
                      <th className="px-1 py-2 text-center">Largo (cm)</th>
                      <th className="px-1 py-2 text-center">Ancho (cm)</th>
                      <th className="px-1 py-2 text-center">Alto (cm)</th>
                      <th className="px-1 py-2 text-center">CBM</th>
                      <th className="px-1 py-2 text-center">Peso (kg)</th>
                      <th className="px-1 py-2 text-center">Ubicación</th>
                      <th className="px-1 py-2 text-center">Notas</th>
                      <th className="px-1 py-2 text-center">Foto</th>
                      <th className="px-1 py-2 text-center w-8"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, idx) => (
                      <tr key={idx} className="border-b border-gray-50 hover:bg-gray-50/50 align-middle">
                        <td className="px-1 py-2 text-center text-xs text-gray-400 font-bold">{idx + 1}</td>
                        <td className="px-1 py-2">
                          <select value={line.packing_type} onChange={e => updateLine(idx, 'packing_type', e.target.value)} className={inputClass + ' min-w-[70px]'}>
                            {PACKING_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </td>
                        <td className="px-1 py-2 text-center">
                          <input type="checkbox" checked={!!line.has_lb} onChange={e => updateLine(idx, 'has_lb', e.target.checked)} className="accent-mcl-blue" />
                        </td>
                        <td className="px-1 py-2 text-center">
                          <input type="checkbox" checked={!!line.is_dg} onChange={e => updateLine(idx, 'is_dg', e.target.checked)} className="accent-mcl-blue" />
                        </td>
                        <td className="px-1 py-2">
                          <input type="number" min="1" value={line.qty || ''} onChange={e => updateLine(idx, 'qty', parseInt(e.target.value) || 0)} className={inputClass + ' w-16 text-center'} />
                        </td>
                        <td className="px-1 py-2">
                          <input type="number" value={line.length_cm || ''} onChange={e => updateLine(idx, 'length_cm', parseFloat(e.target.value) || null)} className={inputClass + ' w-20 text-center'} />
                        </td>
                        <td className="px-1 py-2">
                          <input type="number" value={line.width_cm || ''} onChange={e => updateLine(idx, 'width_cm', parseFloat(e.target.value) || null)} className={inputClass + ' w-20 text-center'} />
                        </td>
                        <td className="px-1 py-2">
                          <input type="number" value={line.height_cm || ''} onChange={e => updateLine(idx, 'height_cm', parseFloat(e.target.value) || null)} className={inputClass + ' w-20 text-center'} />
                        </td>
                        <td className="px-1 py-2 text-center text-xs text-gray-500 font-mono">{line.cbm != null ? fmtNum(line.cbm, 4) : '—'}</td>
                        <td className="px-1 py-2">
                          <input type="number" value={line.weight_kg || ''} onChange={e => updateLine(idx, 'weight_kg', parseFloat(e.target.value) || null)} className={inputClass + ' w-20 text-center'} />
                        </td>
                        <td className="px-1 py-2">
                          <input value={line.location || ''} onChange={e => updateLine(idx, 'location', e.target.value)} placeholder="R" className={inputClass + ' w-20'} />
                        </td>
                        <td className="px-1 py-2">
                          <input value={line.remarks || ''} onChange={e => updateLine(idx, 'remarks', e.target.value)} className={inputClass + ' w-24'} />
                        </td>
                        <td className="px-1 py-2 text-center">
                          <div className="flex items-center gap-1 justify-center">
                            {(line.photo_urls?.length || 0) > 0 && (
                              <img src={line.photo_urls![line.photo_urls!.length - 1]} alt="" className="w-8 h-8 object-cover rounded border border-gray-200" />
                            )}
                            <button
                              onClick={() => photoInputRefs.current[idx]?.click()}
                              className="text-gray-400 hover:text-mcl-blue"
                              title="Add photo"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                            </button>
                            <input
                              ref={el => { photoInputRefs.current[idx] = el }}
                              type="file"
                              accept="image/*"
                              capture="environment"
                              className="hidden"
                              onChange={e => handlePhoto(idx, e)}
                            />
                          </div>
                        </td>
                        <td className="px-1 py-2 text-center">
                          <div className="flex items-center gap-1 justify-center">
                            {wr && (
                              <button
                                onClick={() => printLabels(wr, lines, idx, order?.service_items?.map(i => i.type))}
                                className="text-gray-300 hover:text-mcl-blue"
                                title="Print labels for this line"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" /></svg>
                              </button>
                            )}
                            {lines.length > 1 && (
                              <button onClick={() => removeLine(idx)} className="text-gray-300 hover:text-red-500" title="Delete line">
                                &times;
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Totals */}
              <div className="mt-4 pt-4 border-t border-gray-100 grid grid-cols-3 gap-4 text-center">
                <div>
                  <div className="text-2xl font-bold text-gray-800">{fmtNum(totals.total_qty)}</div>
                  <div className="text-xs text-gray-400">Pieces</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-gray-800">{fmtNum(totals.total_cbm, 4)}</div>
                  <div className="text-xs text-gray-400">CBM</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-gray-800">{fmtNum(totals.total_weight_kg, 1)}</div>
                  <div className="text-xs text-gray-400">KG</div>
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-3 mt-6">
                <button
                  onClick={() => handleSave(false)}
                  disabled={saving}
                  className="flex-1 border border-gray-300 text-gray-700 px-4 py-3 rounded-xl text-sm hover:bg-gray-50 transition-colors disabled:opacity-50"
                >
                  Save Draft
                </button>
                <button
                  onClick={() => handleSave(true)}
                  disabled={saving}
                  className="flex-1 bg-mcl-blue text-white px-4 py-3 rounded-xl text-sm font-semibold hover:bg-blue-900 transition-colors disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Complete Reception'}
                </button>
                {wr && (
                  <button
                    onClick={() => printLabels(wr, lines, undefined, order?.service_items?.map(i => i.type))}
                    className="flex-1 border border-mcl-blue text-mcl-blue px-4 py-3 rounded-xl text-sm font-semibold hover:bg-blue-50 transition-colors flex items-center justify-center gap-2"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" /></svg>
                    Print Labels
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </Layout>
  )
}
