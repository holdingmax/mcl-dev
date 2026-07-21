import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import Layout from '../components/Layout'
import { db } from '../lib/firebase'
import { doc, getDoc, getDocs, collection, updateDoc, deleteField } from 'firebase/firestore'
import { Dispatch, WarehouseReceipt, WRLine, CorrectionEntry, CONTAINER_SIZES, NAVIERAS } from '../types'
import { useAuth } from '../contexts/AuthContext'
import { fmtNum } from '../lib/utils'

const PACKING_TYPES = ['SKID', 'Bolsa', 'DContainer', 'Crate', 'Oversize', 'Otro']

interface EditableWR {
  id: string
  wr_number: string
  po_number: string
  company_name: string
  consignee_name: string
  to_port: string
  cargo_type: string
  lines: EditableLine[]
}

interface EditableLine {
  id: string
  line_order: number
  packing_type: string
  has_lb: boolean
  is_dg: boolean
  qty: number
  length_cm: number | null
  width_cm: number | null
  height_cm: number | null
  cbm: number | null
  weight_kg: number | null
  location: string
  remarks: string
}

export default function DispatchCorrection() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user, isAdmin, isSuperAgent } = useAuth()
  const canCorrect = isAdmin || isSuperAgent

  const [dispatch, setDispatch] = useState<Dispatch | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState('')
  const [error, setError] = useState('')
  const [reverting, setReverting] = useState(false)

  // Dispatch-level editable fields
  const [bookingNumber, setBookingNumber] = useState('')
  const [containerNumber, setContainerNumber] = useState('')
  const [containerSize, setContainerSize] = useState('40')
  const [naviera, setNaviera] = useState('MSC')
  const [navieraOther, setNavieraOther] = useState('')
  const [transportCompany, setTransportCompany] = useState('')
  const [scheduledAt, setScheduledAt] = useState('')
  const [loadingType, setLoadingType] = useState<'forklift' | 'by_hand' | null>('forklift')
  const [hasDrayage, setHasDrayage] = useState(true)
  const [hasHazmat, setHasHazmat] = useState(false)

  const isLCL = containerSize === 'LCL'

  // WR-level editable data
  const [wrs, setWrs] = useState<EditableWR[]>([])

  // Original snapshots for diff
  const [origDispatch, setOrigDispatch] = useState<Record<string, any>>({})
  const [origWrs, setOrigWrs] = useState<EditableWR[]>([])

  useEffect(() => { loadAll() }, [id])

  async function loadAll() {
    if (!id) return
    setLoading(true)
    try {
      const dSnap = await getDoc(doc(db, 'dispatches', id))
      if (!dSnap.exists()) { setError('Consolidado no encontrado'); setLoading(false); return }
      const d = { id: dSnap.id, ...dSnap.data() } as Dispatch
      setDispatch(d)
      setOrigDispatch(dSnap.data() as Record<string, any>)

      // Populate dispatch fields
      setBookingNumber(d.booking_number || '')
      setContainerNumber(d.container_number || '')
      setContainerSize(d.container_size || '40')
      setNaviera(d.naviera || 'MSC')
      setNavieraOther(d.naviera_other || '')
      setTransportCompany(d.transport_company || '')
      setScheduledAt(d.scheduled_at ? d.scheduled_at.slice(0, 16) : '')
      setLoadingType(d.container_size === 'LCL' ? null : (d.loading_type || 'forklift'))
      setHasDrayage(d.drayage !== undefined ? d.drayage : true)
      setHasHazmat(d.hazmat || false)

      // Load WRs + lines
      const wrIds = d.wr_ids || []
      const loaded: EditableWR[] = []
      for (const wrId of wrIds) {
        const wrSnap = await getDoc(doc(db, 'warehouse_receipts', wrId))
        if (!wrSnap.exists()) continue
        const wr = wrSnap.data() as WarehouseReceipt
        const linesSnap = await getDocs(collection(db, 'warehouse_receipts', wrId, 'lines'))
        const lines: EditableLine[] = linesSnap.docs
          .map(ld => {
            const l = ld.data() as WRLine
            return {
              id: ld.id,
              line_order: l.line_order,
              packing_type: l.packing_type || '',
              has_lb: l.has_lb || false,
              is_dg: l.is_dg || false,
              qty: l.qty || 0,
              length_cm: l.length_cm ?? null,
              width_cm: l.width_cm ?? null,
              height_cm: l.height_cm ?? null,
              cbm: l.cbm ?? null,
              weight_kg: l.weight_kg ?? null,
              location: l.location || '',
              remarks: l.remarks || '',
            }
          })
          .sort((a, b) => a.line_order - b.line_order)

        loaded.push({
          id: wrId,
          wr_number: wr.wr_number || '',
          po_number: wr.po_number || '',
          company_name: wr.company_name || '',
          consignee_name: wr.consignee?.name || wr.consignee_name || '',
          to_port: wr.to_port || '',
          cargo_type: wr.cargo_type || '',
          lines,
        })
      }
      setWrs(loaded)
      setOrigWrs(JSON.parse(JSON.stringify(loaded)))
    } catch (e: any) {
      setError(e.message || 'Error al cargar')
    }
    setLoading(false)
  }

  function updateWrField(wrIdx: number, field: keyof EditableWR, value: any) {
    setWrs(prev => prev.map((w, i) => i === wrIdx ? { ...w, [field]: value } : w))
  }

  function updateLine(wrIdx: number, lineIdx: number, field: keyof EditableLine, value: any) {
    setWrs(prev => prev.map((w, i) => {
      if (i !== wrIdx) return w
      const newLines = w.lines.map((l, li) => {
        if (li !== lineIdx) return l
        const updated = { ...l, [field]: value }
        // Recalculate CBM when dimensions or qty change
        if (['qty', 'length_cm', 'width_cm', 'height_cm'].includes(field)) {
          const q = field === 'qty' ? (value as number) : updated.qty
          const len = field === 'length_cm' ? (value as number) : updated.length_cm
          const wid = field === 'width_cm' ? (value as number) : updated.width_cm
          const hei = field === 'height_cm' ? (value as number) : updated.height_cm
          if (len && wid && hei && q) {
            updated.cbm = Math.round(((len * wid * hei) / 1_000_000) * q * 1000) / 1000
          } else {
            updated.cbm = null
          }
        }
        return updated
      })
      return { ...w, lines: newLines }
    }))
  }

  // Computed totals
  const totalQty = wrs.reduce((s, w) => s + w.lines.reduce((s2, l) => s2 + (l.qty || 0), 0), 0)
  const totalCBM = wrs.reduce((s, w) => s + w.lines.reduce((s2, l) => s2 + (l.cbm || 0), 0), 0)
  const totalKG = wrs.reduce((s, w) => s + w.lines.reduce((s2, l) => s2 + (l.weight_kg || 0), 0), 0)

  async function handleSave() {
    setError('')
    setSaving(true)
    try {
      // Build correction log
      const changes: Record<string, { from: any; to: any }> = {}
      if (origDispatch.booking_number !== bookingNumber) changes.booking_number = { from: origDispatch.booking_number, to: bookingNumber }
      if (origDispatch.container_number !== containerNumber) changes.container_number = { from: origDispatch.container_number, to: containerNumber }
      if (origDispatch.container_size !== containerSize) changes.container_size = { from: origDispatch.container_size, to: containerSize }
      if (origDispatch.naviera !== naviera) changes.naviera = { from: origDispatch.naviera, to: naviera }
      if (origDispatch.transport_company !== transportCompany) changes.transport_company = { from: origDispatch.transport_company, to: transportCompany }
      if (origDispatch.loading_type !== loadingType) changes.loading_type = { from: origDispatch.loading_type, to: loadingType }
      if (origDispatch.drayage !== hasDrayage) changes.drayage = { from: origDispatch.drayage, to: hasDrayage }
      if (origDispatch.hazmat !== hasHazmat) changes.hazmat = { from: origDispatch.hazmat, to: hasHazmat }

      // Detect WR-level changes
      for (let wi = 0; wi < wrs.length; wi++) {
        const cur = wrs[wi], orig = origWrs[wi]
        if (!orig) continue
        const wrKey = cur.wr_number || cur.id
        if (cur.po_number !== orig.po_number) changes[`${wrKey}.po_number`] = { from: orig.po_number, to: cur.po_number }
        if (cur.company_name !== orig.company_name) changes[`${wrKey}.company_name`] = { from: orig.company_name, to: cur.company_name }
        if (cur.consignee_name !== orig.consignee_name) changes[`${wrKey}.consignee_name`] = { from: orig.consignee_name, to: cur.consignee_name }
        if (cur.to_port !== orig.to_port) changes[`${wrKey}.to_port`] = { from: orig.to_port, to: cur.to_port }
        if (cur.cargo_type !== orig.cargo_type) changes[`${wrKey}.cargo_type`] = { from: orig.cargo_type, to: cur.cargo_type }

        // Line-level changes
        for (let li = 0; li < cur.lines.length; li++) {
          const cl = cur.lines[li], ol = orig.lines[li]
          if (!ol) continue
          const lKey = `${wrKey}.L${cl.line_order}`
          if (cl.qty !== ol.qty) changes[`${lKey}.qty`] = { from: ol.qty, to: cl.qty }
          if (cl.weight_kg !== ol.weight_kg) changes[`${lKey}.weight_kg`] = { from: ol.weight_kg, to: cl.weight_kg }
          if (cl.length_cm !== ol.length_cm) changes[`${lKey}.length_cm`] = { from: ol.length_cm, to: cl.length_cm }
          if (cl.width_cm !== ol.width_cm) changes[`${lKey}.width_cm`] = { from: ol.width_cm, to: cl.width_cm }
          if (cl.height_cm !== ol.height_cm) changes[`${lKey}.height_cm`] = { from: ol.height_cm, to: cl.height_cm }
          if (cl.packing_type !== ol.packing_type) changes[`${lKey}.packing_type`] = { from: ol.packing_type, to: cl.packing_type }
          if (cl.location !== ol.location) changes[`${lKey}.location`] = { from: ol.location, to: cl.location }
          if (cl.remarks !== ol.remarks) changes[`${lKey}.remarks`] = { from: ol.remarks, to: cl.remarks }
          if (cl.has_lb !== ol.has_lb) changes[`${lKey}.has_lb`] = { from: ol.has_lb, to: cl.has_lb }
          if (cl.is_dg !== ol.is_dg) changes[`${lKey}.is_dg`] = { from: ol.is_dg, to: cl.is_dg }
        }
      }

      const poNums = [...new Set(wrs.map(w => w.po_number).filter(Boolean))]
      const consNames = [...new Set(wrs.map(w => w.consignee_name).filter(Boolean))]
      const dests = [...new Set(wrs.map(w => w.to_port).filter(Boolean))]

      // 1. Update dispatch document
      const dispatchUpdate: Record<string, any> = {
        booking_number: bookingNumber,
        container_number: isLCL ? '' : containerNumber,
        container_size: containerSize,
        naviera,
        ...(naviera === 'Otra' && navieraOther ? { naviera_other: navieraOther } : {}),
        transport_company: transportCompany,
        scheduled_at: scheduledAt,
        loading_type: isLCL ? null : loadingType,
        drayage: isLCL ? false : hasDrayage,
        hazmat: hasHazmat,
        po_numbers: poNums,
        consignees: consNames,
        destinations: dests,
        total_qty: totalQty,
        total_cbm: totalCBM,
        total_kg: totalKG,
      }

      if (Object.keys(changes).length > 0) {
        const entry: CorrectionEntry = {
          corrected_at: new Date().toISOString(),
          corrected_by: user?.email || '',
          changes,
        }
        dispatchUpdate.corrections = [...(origDispatch.corrections || []), entry]
      }

      await updateDoc(doc(db, 'dispatches', id!), dispatchUpdate)

      // 2. Update each WR + its lines
      for (const wr of wrs) {
        const wrTotalQty = wr.lines.reduce((s, l) => s + (l.qty || 0), 0)
        const wrTotalCBM = wr.lines.reduce((s, l) => s + (l.cbm || 0), 0)
        const wrTotalKG = wr.lines.reduce((s, l) => s + (l.weight_kg || 0), 0)

        await updateDoc(doc(db, 'warehouse_receipts', wr.id), {
          po_number: wr.po_number,
          company_name: wr.company_name,
          consignee_name: wr.consignee_name,
          'consignee.name': wr.consignee_name,
          to_port: wr.to_port,
          cargo_type: wr.cargo_type || null,
          total_qty: wrTotalQty,
          total_cbm: wrTotalCBM,
          total_weight_kg: wrTotalKG,
          container_number: containerNumber,
          dispatch_booking_number: bookingNumber,
        })

        // Update each line
        for (const line of wr.lines) {
          await updateDoc(doc(db, 'warehouse_receipts', wr.id, 'lines', line.id), {
            packing_type: line.packing_type,
            has_lb: line.has_lb,
            is_dg: line.is_dg,
            qty: line.qty,
            length_cm: line.length_cm,
            width_cm: line.width_cm,
            height_cm: line.height_cm,
            cbm: line.cbm,
            weight_kg: line.weight_kg,
            location: line.location,
            remarks: line.remarks,
          })
        }
      }

      setSavedMsg('Corrección guardada correctamente')
      setOrigDispatch({ ...origDispatch, ...dispatchUpdate })
      setOrigWrs(JSON.parse(JSON.stringify(wrs)))
      setTimeout(() => setSavedMsg(''), 4000)
    } catch (e: any) {
      setError(e.message || 'Error al guardar')
    }
    setSaving(false)
  }

  async function handleRevertGateOut() {
    if (!dispatch || dispatch.status !== 'gate_out') return
    if (!window.confirm('¿Estás seguro? Se eliminará toda la información del Gate Out (sello, chofer, fotos, fecha).')) return
    setReverting(true)
    setError('')
    try {
      const gateOutData: Record<string, any> = {}
      if (dispatch.seal_number) gateOutData.seal_number = dispatch.seal_number
      if (dispatch.seal_photo_url) gateOutData.seal_photo_url = dispatch.seal_photo_url
      if (dispatch.container_photo_url) gateOutData.container_photo_url = dispatch.container_photo_url
      if (dispatch.gate_driver_name) gateOutData.gate_driver_name = dispatch.gate_driver_name
      if (dispatch.gate_driver_license) gateOutData.gate_driver_license = dispatch.gate_driver_license
      if (dispatch.gate_driver_photo_url) gateOutData.gate_driver_photo_url = dispatch.gate_driver_photo_url
      if (dispatch.gate_out_at) gateOutData.gate_out_at = dispatch.gate_out_at

      const entry: CorrectionEntry = {
        corrected_at: new Date().toISOString(),
        corrected_by: user?.email || '',
        changes: { gate_out_revert: { from: gateOutData, to: null } },
      }

      await updateDoc(doc(db, 'dispatches', id!), {
        status: 'booked',
        seal_number: deleteField(),
        seal_photo_url: deleteField(),
        container_photo_url: deleteField(),
        gate_driver_name: deleteField(),
        gate_driver_license: deleteField(),
        gate_driver_photo_url: deleteField(),
        gate_out_at: deleteField(),
        corrections: [...(origDispatch.corrections || []), entry],
      })

      // Revert WR dispatch_status back to reserved/partial
      if (dispatch.wr_ids?.length) {
        const partialIds = new Set<string>(dispatch.partial_wr_ids || [])
        await Promise.all(dispatch.wr_ids.map(wrId =>
          updateDoc(doc(db, 'warehouse_receipts', wrId), {
            dispatch_status: partialIds.has(wrId) ? 'partial' : 'reserved',
            dispatched_at: deleteField(),
            dispatch_seal_number: deleteField(),
            dispatch_driver_name: deleteField(),
          })
        ))
      }

      setSavedMsg('Gate Out revertido correctamente')
      setTimeout(() => setSavedMsg(''), 4000)
      await loadAll()
    } catch (e: any) {
      setError(e.message || 'Error al revertir Gate Out')
    }
    setReverting(false)
  }

  if (!canCorrect) {
    return (
      <Layout title="Sin Acceso" backTo="/dispatches">
        <p className="text-center text-gray-400 py-8">Solo Admin y Super Agent pueden corregir consolidado.</p>
      </Layout>
    )
  }

  if (loading) {
    return (
      <Layout title="Corregir Consolidado" backTo="/dispatches">
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" />
        </div>
      </Layout>
    )
  }

  const labelClass = 'block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1'
  const inputClass = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30'
  const smallInput = 'w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-mcl-blue/30'

  return (
    <Layout title="Corregir Consolidado" backTo="/dispatches">
      <div className="max-w-3xl mx-auto space-y-5">

        {/* Toast */}
        {savedMsg && (
          <div className="bg-green-50 border border-green-200 text-green-700 text-sm font-medium px-4 py-2 rounded-lg">{savedMsg}</div>
        )}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm font-medium px-4 py-2 rounded-lg">{error}</div>
        )}

        {/* ── Revert Gate Out ── */}
        {dispatch?.status === 'gate_out' && (
          <div className="bg-red-50 rounded-xl border border-red-200 p-4">
            <h3 className="font-semibold text-red-700 text-sm mb-3">Gate Out Registrado</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm text-red-800 mb-4">
              {dispatch.gate_driver_name && <div><span className="font-semibold">Chofer:</span> {dispatch.gate_driver_name}</div>}
              {dispatch.gate_driver_license && <div><span className="font-semibold">Licencia:</span> {dispatch.gate_driver_license}</div>}
              {dispatch.seal_number && <div><span className="font-semibold">Sello:</span> {dispatch.seal_number}</div>}
              {dispatch.gate_out_at && <div><span className="font-semibold">Fecha:</span> {new Date(dispatch.gate_out_at).toLocaleString()}</div>}
            </div>
            <button
              onClick={handleRevertGateOut}
              disabled={reverting}
              className="w-full bg-red-600 text-white font-semibold py-2.5 rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
            >
              {reverting ? 'Revirtiendo...' : 'Revertir Gate Out'}
            </button>
          </div>
        )}

        {/* ── Dispatch-level: Container info ── */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <h3 className="font-semibold text-gray-700 text-sm mb-4">Información del Contenedor</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Booking #</label>
              <input value={bookingNumber} onChange={e => setBookingNumber(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Número de Contenedor</label>
              <input value={isLCL ? '' : containerNumber} onChange={e => setContainerNumber(e.target.value.toUpperCase())} className={inputClass} disabled={isLCL} placeholder={isLCL ? 'N/A (LCL)' : ''} />
            </div>
            <div>
              <label className={labelClass}>Tamaño</label>
              <select value={containerSize} onChange={e => {
                const v = e.target.value
                setContainerSize(v)
                if (v === 'LCL') { setLoadingType(null); setHasDrayage(false); setHasHazmat(false); setContainerNumber('') }
                else if (containerSize === 'LCL') { setLoadingType('forklift'); setHasDrayage(true) }
              }} className={inputClass}>
                {CONTAINER_SIZES.map(s => <option key={s} value={s}>{s === 'LCL' ? 'LCL' : s + "'"}</option>)}
              </select>
            </div>
            <div>
              <label className={labelClass}>Naviera</label>
              <select value={naviera} onChange={e => setNaviera(e.target.value)} className={inputClass}>
                {NAVIERAS.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
              {naviera === 'Otra' && (
                <input value={navieraOther} onChange={e => setNavieraOther(e.target.value)}
                  placeholder="Especificar naviera" className={inputClass + ' mt-2'} />
              )}
            </div>
            <div>
              <label className={labelClass}>Empresa de Transporte</label>
              <input value={transportCompany} onChange={e => setTransportCompany(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Fecha/Hora Programada</label>
              <input type="datetime-local" value={scheduledAt} onChange={e => setScheduledAt(e.target.value)} className={inputClass} />
            </div>
          </div>
        </div>

        {/* ── Billing options ── */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <h3 className="font-semibold text-gray-700 text-sm mb-4">Opciones de Facturación</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className={labelClass}>Tipo de Carga</label>
              <div className="flex rounded-lg overflow-hidden border border-gray-200 h-[38px]">
                <button type="button" onClick={() => !isLCL && setLoadingType('forklift')}
                  className={`flex-1 text-xs font-semibold transition-colors ${isLCL ? 'bg-gray-100 text-gray-300 cursor-not-allowed' : loadingType === 'forklift' ? 'bg-mcl-blue text-white' : 'bg-white text-gray-400 hover:bg-gray-50'}`}
                  disabled={isLCL}>
                  Forklift
                </button>
                <button type="button" onClick={() => !isLCL && setLoadingType('by_hand')}
                  className={`flex-1 text-xs font-semibold border-l border-gray-200 transition-colors ${isLCL ? 'bg-gray-100 text-gray-300 cursor-not-allowed' : loadingType === 'by_hand' ? 'bg-mcl-blue text-white' : 'bg-white text-gray-400 hover:bg-gray-50'}`}
                  disabled={isLCL}>
                  By Hand
                </button>
              </div>
              {isLCL && <p className="text-[10px] text-gray-400 mt-1">No aplica para LCL</p>}
            </div>
            <div>
              <label className={labelClass}>Drayage</label>
              <div className="flex rounded-lg overflow-hidden border border-gray-200 h-[38px]">
                <button type="button" onClick={() => !isLCL && setHasDrayage(true)}
                  className={`flex-1 text-xs font-semibold transition-colors ${isLCL ? 'bg-gray-100 text-gray-300 cursor-not-allowed' : hasDrayage ? 'bg-mcl-blue text-white' : 'bg-white text-gray-400 hover:bg-gray-50'}`}
                  disabled={isLCL}>
                  Aplica
                </button>
                <button type="button" onClick={() => { if (!isLCL) { setHasDrayage(false); setHasHazmat(false) } }}
                  className={`flex-1 text-xs font-semibold border-l border-gray-200 transition-colors ${isLCL ? 'bg-gray-100 text-gray-300 cursor-not-allowed' : !hasDrayage ? 'bg-gray-500 text-white' : 'bg-white text-gray-400 hover:bg-gray-50'}`}
                  disabled={isLCL}>
                  No Aplica
                </button>
              </div>
              {isLCL && <p className="text-[10px] text-gray-400 mt-1">No aplica para LCL</p>}
            </div>
            <div>
              <label className={labelClass}>Hazmat / DG</label>
              <div className="flex rounded-lg overflow-hidden border border-gray-200 h-[38px]">
                <button type="button" onClick={() => setHasHazmat(false)}
                  className={`flex-1 text-xs font-semibold transition-colors ${!hasHazmat ? 'bg-mcl-blue text-white' : 'bg-white text-gray-400 hover:bg-gray-50'}`}
                  disabled={!hasDrayage}>
                  No
                </button>
                <button type="button" onClick={() => setHasHazmat(true)}
                  className={`flex-1 text-xs font-semibold border-l border-gray-200 transition-colors ${hasHazmat ? 'bg-red-500 text-white' : 'bg-white text-gray-400 hover:bg-gray-50'} disabled:opacity-40`}
                  disabled={!hasDrayage}>
                  Sí
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* ── WRs with lines ── */}
        {wrs.map((wr, wi) => {
          const wrQty = wr.lines.reduce((s, l) => s + (l.qty || 0), 0)
          const wrCBM = wr.lines.reduce((s, l) => s + (l.cbm || 0), 0)
          const wrKG = wr.lines.reduce((s, l) => s + (l.weight_kg || 0), 0)

          return (
            <div key={wr.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
              {/* WR header */}
              <div className="flex items-center gap-2 mb-3">
                <span className="font-mono font-bold text-mcl-blue text-sm">{wr.wr_number}</span>
                <span className="text-xs text-gray-400">·</span>
                <span className="text-xs text-gray-500">{wrQty} pzas · {fmtNum(wrCBM, 4)} CBM · {fmtNum(wrKG, 1)} KG</span>
              </div>

              {/* WR-level fields */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
                <div>
                  <label className={labelClass}>PO Number</label>
                  <input value={wr.po_number} onChange={e => updateWrField(wi, 'po_number', e.target.value)} className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>Shipper</label>
                  <input value={wr.company_name} onChange={e => updateWrField(wi, 'company_name', e.target.value)} className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>Consignee</label>
                  <input value={wr.consignee_name} onChange={e => updateWrField(wi, 'consignee_name', e.target.value)} className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>Destino</label>
                  <input value={wr.to_port} onChange={e => updateWrField(wi, 'to_port', e.target.value.toUpperCase())} className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>Tipo de Carga</label>
                  <div className="flex rounded-lg overflow-hidden border border-gray-200 h-[38px]">
                    <button type="button" onClick={() => updateWrField(wi, 'cargo_type', 'BOND')}
                      className={`flex-1 text-xs font-semibold transition-colors ${wr.cargo_type === 'BOND' ? 'bg-amber-500 text-white' : 'bg-white text-gray-400 hover:bg-gray-50'}`}>
                      BOND
                    </button>
                    <button type="button" onClick={() => updateWrField(wi, 'cargo_type', 'LOC')}
                      className={`flex-1 text-xs font-semibold border-l border-gray-200 transition-colors ${wr.cargo_type === 'LOC' ? 'bg-mcl-blue text-white' : 'bg-white text-gray-400 hover:bg-gray-50'}`}>
                      LOC
                    </button>
                  </div>
                </div>
              </div>

              {/* Lines */}
              <div className="border border-gray-100 rounded-lg overflow-hidden">
                <div className="bg-gray-50 px-2 py-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider grid grid-cols-12 gap-1 items-center">
                  <span className="col-span-1">#</span>
                  <span className="col-span-2">Empaque</span>
                  <span className="col-span-1 text-center">Qty</span>
                  <span className="col-span-1 text-center">L</span>
                  <span className="col-span-1 text-center">W</span>
                  <span className="col-span-1 text-center">H</span>
                  <span className="col-span-1 text-center">CBM</span>
                  <span className="col-span-1 text-center">KG</span>
                  <span className="col-span-1 text-center">Ubic</span>
                  <span className="col-span-2">Flags</span>
                </div>
                {wr.lines.map((line, li) => (
                  <div key={line.id} className="px-2 py-1.5 border-t border-gray-50 grid grid-cols-12 gap-1 items-center">
                    <span className="col-span-1 text-xs text-gray-400 font-mono">{line.line_order}</span>
                    <div className="col-span-2">
                      <select value={line.packing_type} onChange={e => updateLine(wi, li, 'packing_type', e.target.value)} className={smallInput}>
                        {PACKING_TYPES.map(p => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </div>
                    <div className="col-span-1">
                      <input type="number" min={0} value={line.qty || ''} onChange={e => updateLine(wi, li, 'qty', Number(e.target.value))} className={smallInput + ' text-center'} />
                    </div>
                    <div className="col-span-1">
                      <input type="number" min={0} value={line.length_cm ?? ''} onChange={e => updateLine(wi, li, 'length_cm', e.target.value ? Number(e.target.value) : null)} className={smallInput + ' text-center'} />
                    </div>
                    <div className="col-span-1">
                      <input type="number" min={0} value={line.width_cm ?? ''} onChange={e => updateLine(wi, li, 'width_cm', e.target.value ? Number(e.target.value) : null)} className={smallInput + ' text-center'} />
                    </div>
                    <div className="col-span-1">
                      <input type="number" min={0} value={line.height_cm ?? ''} onChange={e => updateLine(wi, li, 'height_cm', e.target.value ? Number(e.target.value) : null)} className={smallInput + ' text-center'} />
                    </div>
                    <div className="col-span-1">
                      <span className="block text-xs text-gray-500 text-center font-mono">{line.cbm != null ? fmtNum(line.cbm, 4) : '—'}</span>
                    </div>
                    <div className="col-span-1">
                      <input type="number" min={0} value={line.weight_kg ?? ''} onChange={e => updateLine(wi, li, 'weight_kg', e.target.value ? Number(e.target.value) : null)} className={smallInput + ' text-center'} />
                    </div>
                    <div className="col-span-1">
                      <input value={line.location} onChange={e => updateLine(wi, li, 'location', e.target.value)} className={smallInput} />
                    </div>
                    <div className="col-span-2 flex items-center gap-2">
                      <label className="flex items-center gap-0.5 text-[10px] text-gray-500 cursor-pointer">
                        <input type="checkbox" checked={line.has_lb} onChange={e => updateLine(wi, li, 'has_lb', e.target.checked)} className="w-3 h-3 accent-amber-500" />
                        LB
                      </label>
                      <label className="flex items-center gap-0.5 text-[10px] text-gray-500 cursor-pointer">
                        <input type="checkbox" checked={line.is_dg} onChange={e => updateLine(wi, li, 'is_dg', e.target.checked)} className="w-3 h-3 accent-red-500" />
                        DG
                      </label>
                    </div>
                  </div>
                ))}
              </div>

              {/* Line remarks (collapsible per line) */}
              {wr.lines.some(l => l.remarks) && (
                <div className="mt-2 space-y-1">
                  {wr.lines.filter(l => l.remarks).map((l, li) => (
                    <div key={l.id} className="flex items-start gap-2 text-xs">
                      <span className="text-gray-400 font-mono">L{l.line_order}:</span>
                      <input value={l.remarks}
                        onChange={e => {
                          const realIdx = wr.lines.findIndex(x => x.id === l.id)
                          updateLine(wi, realIdx, 'remarks', e.target.value)
                        }}
                        className={smallInput + ' flex-1'} placeholder="Remarks" />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}

        {/* ── Totals ── */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <div className="flex flex-wrap gap-6 text-sm">
            <span className="text-gray-500">WRs: <strong className="text-mcl-blue">{wrs.length}</strong></span>
            <span className="text-gray-500">Piezas: <strong className="text-gray-700">{fmtNum(totalQty)}</strong></span>
            <span className="text-gray-500">CBM: <strong className="text-gray-700">{fmtNum(totalCBM, 4)}</strong></span>
            <span className="text-gray-500">KG: <strong className="text-gray-700">{fmtNum(totalKG, 1)}</strong></span>
          </div>
        </div>

        {/* ── Correction history ── */}
        {(origDispatch.corrections || []).length > 0 && (
          <div className="bg-amber-50 rounded-xl border border-amber-200 p-4">
            <h3 className="font-semibold text-amber-700 text-sm mb-2">Historial de Correcciones ({origDispatch.corrections.length})</h3>
            {origDispatch.corrections.map((c: CorrectionEntry, i: number) => (
              <div key={i} className="text-xs text-amber-800 border-t border-amber-200 pt-2 mt-2 first:border-0 first:pt-0 first:mt-0">
                <p className="font-semibold">{new Date(c.corrected_at).toLocaleString()} — {c.corrected_by}</p>
                <ul className="mt-1 space-y-0.5">
                  {Object.entries(c.changes).map(([field, { from, to }]) => (
                    <li key={field}>
                      <span className="font-mono text-amber-600">{field}</span>: <span className="line-through text-amber-400">{JSON.stringify(from)}</span> → <span className="font-semibold">{JSON.stringify(to)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        {/* ── Save button ── */}
        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full bg-amber-500 text-white font-semibold py-3 rounded-xl hover:bg-amber-600 transition-colors disabled:opacity-50"
        >
          {saving ? 'Guardando...' : 'Guardar Corrección'}
        </button>
      </div>
    </Layout>
  )
}
