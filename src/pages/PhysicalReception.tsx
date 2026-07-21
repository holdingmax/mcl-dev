import { useState, useEffect, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Layout from '../components/Layout'
import { db } from '../lib/firebase'
import {
  doc, getDoc, getDocs, addDoc, updateDoc,
  collection, writeBatch
} from 'firebase/firestore'
import { useAuth } from '../contexts/AuthContext'
import { WarehouseReceipt, WRLine, SkuLine, PACKING_TYPES, Consignee } from '../types'
import { calculateCBM, computeTotals, emptyLine, toTitleCase, fmtNum } from '../lib/utils'
import { printLabels } from '../lib/printLabels'
import { calculateReceptionCharges } from '../lib/billing'
import * as XLSX from 'xlsx'

export default function PhysicalReception() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()

  const [wr, setWr]       = useState<WarehouseReceipt | null>(null)
  const [lines, setLines] = useState<WRLine[]>([emptyLine(1)])
  const [saving, setSaving]   = useState(false)
  const [loading, setLoading] = useState(true)
  const photoInputRefs = useRef<(HTMLInputElement | null)[]>([])

  // SKU detail lines
  const [skuLines, setSkuLines] = useState<SkuLine[]>([])
  const [showSku, setShowSku]   = useState(false)
  const skuFileRef = useRef<HTMLInputElement | null>(null)

  function printLineLabels(idx: number) {
    if (!wr) return
    printLabels(wr, lines, idx)
  }

  useEffect(() => {
    loadData()
  }, [id])

  async function loadData() {
    setLoading(true)
    try {
      const wrSnap = await getDoc(doc(db, 'warehouse_receipts', id!))
      if (wrSnap.exists()) {
        const data = { id: wrSnap.id, ...wrSnap.data() } as WarehouseReceipt
        if (data.consignee_id) {
          const consSnap = await getDoc(doc(db, 'consignees', data.consignee_id))
          if (consSnap.exists()) {
            data.consignee = { id: consSnap.id, ...consSnap.data() } as Consignee
          }
        }
        setWr(data)
      }
    } catch (e) { console.error('WR load error', e) }

    try {
      const linesSnap = await getDocs(collection(db, 'warehouse_receipts', id!, 'lines'))
      const existingLines = linesSnap.docs
        .map(d => ({ id: d.id, ...d.data() })) as WRLine[]
      const sorted = existingLines
        .sort((a, b) => (a.line_order ?? 0) - (b.line_order ?? 0))
        .map(l => ({
          ...l,
          // migrate legacy single photo_url → photo_urls array
          photo_urls: l.photo_urls?.length ? l.photo_urls : (l.photo_url ? [l.photo_url] : []),
        }))
      if (sorted.length > 0) setLines(sorted)
    } catch (e) { console.error('Lines load error', e) }

    // Load SKU lines
    try {
      const skuSnap = await getDocs(collection(db, 'warehouse_receipts', id!, 'sku_lines'))
      const existing = skuSnap.docs.map(d => ({ id: d.id, ...d.data() })) as SkuLine[]
      if (existing.length > 0) {
        setSkuLines(existing)
        setShowSku(true)
      }
    } catch (e) { console.error('SKU load error', e) }

    setLoading(false)
  }

  function updateLine(index: number, field: keyof WRLine, value: unknown) {
    setLines(prev => {
      const updated = [...prev]
      const line = { ...updated[index], [field]: value }
      if (['length_cm', 'width_cm', 'height_cm', 'qty'].includes(field)) {
        const l = field === 'length_cm' ? Number(value) : Number(line.length_cm)
        const w = field === 'width_cm' ? Number(value) : Number(line.width_cm)
        const h = field === 'height_cm' ? Number(value) : Number(line.height_cm)
        const q = field === 'qty' ? Number(value) : Number(line.qty)
        line.cbm = calculateCBM(l, w, h, q)
      }
      updated[index] = line
      return updated
    })
  }

  function addLine() {
    setLines(prev => [...prev, emptyLine(prev.length + 1)])
  }

  function removeLine(index: number) {
    if (lines.length === 1) return
    setLines(prev => prev.filter((_, i) => i !== index).map((l, i) => ({ ...l, line_order: i + 1 })))
  }

  async function toBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image()
      const url = URL.createObjectURL(file)
      img.onload = () => {
        const MAX = 700
        let { width, height } = img
        if (width > MAX || height > MAX) {
          if (width > height) { height = Math.round(height * MAX / width); width = MAX }
          else { width = Math.round(width * MAX / height); height = MAX }
        }
        const canvas = document.createElement('canvas')
        canvas.width = width; canvas.height = height
        canvas.getContext('2d')!.drawImage(img, 0, 0, width, height)
        URL.revokeObjectURL(url)
        resolve(canvas.toDataURL('image/jpeg', 0.75))
      }
      img.onerror = reject
      img.src = url
    })
  }

  async function handleLinePhoto(index: number, e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const base64 = await toBase64(file)
    setLines(prev => {
      const updated = [...prev]
      const existing = updated[index].photo_urls || []
      updated[index] = { ...updated[index], photo_urls: [...existing, base64] }
      return updated
    })
    // reset so same file can be picked again if needed
    e.target.value = ''
  }

  function removeLinePhoto(lineIndex: number, photoIndex: number) {
    setLines(prev => {
      const updated = [...prev]
      const photos = [...(updated[lineIndex].photo_urls || [])]
      photos.splice(photoIndex, 1)
      updated[lineIndex] = { ...updated[lineIndex], photo_urls: photos }
      return updated
    })
  }

  const totals = computeTotals(lines)

  // ── SKU helpers ───────────────────────────────────────────────────
  function addSkuLine() {
    setSkuLines(prev => [...prev, { sku: '', vin: '', received_qty: 0, case_pack: 0 }])
  }

  function removeSkuLine(idx: number) {
    setSkuLines(prev => prev.filter((_, i) => i !== idx))
  }

  function updateSkuLine(idx: number, field: keyof SkuLine, value: any) {
    setSkuLines(prev => prev.map((s, i) => i === idx ? { ...s, [field]: value } : s))
  }

  function handleSkuImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (evt) => {
      const data = new Uint8Array(evt.target!.result as ArrayBuffer)
      const wb = XLSX.read(data, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json<Record<string, any>>(ws)
      const imported: SkuLine[] = rows
        .filter(r => r['SKU'] || r['sku'])
        .map(r => ({
          sku: String(r['SKU'] || r['sku'] || ''),
          vin: String(r['VIN'] || r['vin'] || ''),
          received_qty: Number(r['QUANTITY SKU'] || r['Quantity SKU'] || r['quantity sku'] || r['RECEIVED QUANTITY'] || 0),
          case_pack: Number(r['CASE PACK'] || r['Case Pack'] || r['CasePack'] || r['case pack'] || 0),
        }))
      if (imported.length > 0) {
        setSkuLines(prev => [...prev, ...imported])
        setShowSku(true)
      } else {
        alert('No se encontraron columnas SKU en el archivo.')
      }
    }
    reader.readAsArrayBuffer(file)
    e.target.value = ''
  }

  async function handleSave(complete: boolean) {
    setSaving(true)
    try {
      // Delete existing lines then re-insert
      const existingSnap = await getDocs(collection(db, 'warehouse_receipts', id!, 'lines'))
      const batch = writeBatch(db)
      existingSnap.docs.forEach(d => batch.delete(d.ref))
      await batch.commit()

      for (let i = 0; i < lines.length; i++) {
        const { id: _id, wr_id: _wr_id, photo_url: _legacy, ...lineData } = lines[i]
        await addDoc(collection(db, 'warehouse_receipts', id!, 'lines'), {
          ...lineData,
          line_order: i + 1,
          qty: lineData.qty || 0,
          cbm: lineData.cbm ?? null,
          photo_urls: lineData.photo_urls || [],
        })
      }

      // Save SKU lines (delete + re-insert)
      const existingSkuSnap = await getDocs(collection(db, 'warehouse_receipts', id!, 'sku_lines'))
      if (existingSkuSnap.size > 0) {
        const skuBatch = writeBatch(db)
        existingSkuSnap.docs.forEach(d => skuBatch.delete(d.ref))
        await skuBatch.commit()
      }
      for (const sku of skuLines) {
        const { id: _skuId, ...skuData } = sku
        await addDoc(collection(db, 'warehouse_receipts', id!, 'sku_lines'), skuData)
      }

      const updateData: Record<string, unknown> = {
        total_qty: totals.total_qty,
        total_cbm: totals.total_cbm,
        total_weight_kg: totals.total_weight_kg,
        updated_at: new Date().toISOString(),
        has_sku_lines: skuLines.length > 0,
      }
      if (complete) {
        updateData.physical_status = 'complete'
        updateData.physical_by = user?.uid
      }
      await updateDoc(doc(db, 'warehouse_receipts', id!), updateData)

      if (complete && wr) {
        try {
          await calculateReceptionCharges(wr, lines, totals)
        } catch (billingErr) {
          console.error('Billing calculation error:', billingErr)
          alert('Warning: Reception saved but billing charges failed to generate. Please notify accounting to review this WR.')
        }
        navigate(`/wr/${id}/print`)
      } else {
        navigate('/sea')
      }
    } catch (err) {
      console.error(err)
      alert('Error al guardar.')
    } finally {
      setSaving(false)
    }
  }

  const inputClass = 'w-full border border-gray-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-mcl-blue/30'

  if (loading) return (
    <Layout title="Recepción Física" backTo="/sea">
      <div className="flex justify-center p-8"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" /></div>
    </Layout>
  )

  return (
    <Layout title={`Recepción Física — ${wr?.wr_number || ''}`} backTo="/sea">
      <div className="max-w-full">

        {/* WR Summary */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 mb-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div><span className="text-xs text-gray-400 block">WR #</span><span className="font-mono font-bold text-mcl-blue">{wr?.wr_number}</span></div>
            <div><span className="text-xs text-gray-400 block">PO</span><span className="font-medium">{wr?.po_number}</span></div>
            <div><span className="text-xs text-gray-400 block">Shipper/Vendor</span><span className="font-medium">{toTitleCase(wr?.company_name)}</span></div>
            <div><span className="text-xs text-gray-400 block">Destino</span><span className="font-medium">{wr?.from_port} → {wr?.to_port}</span></div>
          </div>
        </div>


        {/* Lines */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-4">
          <div className="p-4 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide">Líneas de Carga</h2>
            <button onClick={addLine} className="text-sm bg-mcl-blue text-white px-3 py-1.5 rounded-lg hover:bg-blue-900 transition-colors">
              + Agregar línea
            </button>
          </div>

          {/* Desktop table */}
          <div className="hidden lg:block overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold text-gray-500 uppercase">#</th>
                  <th className="px-3 py-2 text-left font-semibold text-gray-500 uppercase">Tipo</th>
                  <th className="px-3 py-2 text-center font-semibold text-gray-500 uppercase">LB</th>
                  <th className="px-3 py-2 text-center font-semibold text-gray-500 uppercase">DG</th>
                  <th className="px-3 py-2 text-right font-semibold text-gray-500 uppercase">QTY</th>
                  <th className="px-3 py-2 text-right font-semibold text-gray-500 uppercase">Largo (cm)</th>
                  <th className="px-3 py-2 text-right font-semibold text-gray-500 uppercase">Ancho (cm)</th>
                  <th className="px-3 py-2 text-right font-semibold text-gray-500 uppercase">Alto (cm)</th>
                  <th className="px-3 py-2 text-right font-semibold text-gray-500 uppercase">CBM</th>
                  <th className="px-3 py-2 text-right font-semibold text-gray-500 uppercase">Peso (KG)</th>
                  <th className="px-3 py-2 text-left font-semibold text-gray-500 uppercase">Ubicación</th>
                  <th className="px-3 py-2 text-left font-semibold text-gray-500 uppercase">Notas</th>
                  <th className="px-3 py-2 text-center font-semibold text-gray-500 uppercase">Foto</th>
                  <th className="px-3 py-2 text-center font-semibold text-gray-500 uppercase">Etiq.</th>
                  <th className="px-2 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {lines.map((line, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="px-3 py-1.5 text-gray-400">{i + 1}</td>
                    <td className="px-3 py-1.5">
                      <select className={inputClass} value={line.packing_type} onChange={e => updateLine(i, 'packing_type', e.target.value)}>
                        {PACKING_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      <input type="checkbox" checked={line.has_lb} onChange={e => updateLine(i, 'has_lb', e.target.checked)} className="w-4 h-4 accent-mcl-blue" />
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      <input type="checkbox" checked={line.is_dg} onChange={e => updateLine(i, 'is_dg', e.target.checked)} className="w-4 h-4 accent-mcl-red" />
                    </td>
                    <td className="px-3 py-1.5"><input type="number" className={inputClass + ' text-right'} value={line.qty || ''} min={1} onChange={e => updateLine(i, 'qty', parseInt(e.target.value) || 0)} /></td>
                    <td className="px-3 py-1.5"><input type="number" className={inputClass + ' text-right'} value={line.length_cm || ''} step="0.1" onChange={e => updateLine(i, 'length_cm', parseFloat(e.target.value) || null)} /></td>
                    <td className="px-3 py-1.5"><input type="number" className={inputClass + ' text-right'} value={line.width_cm || ''} step="0.1" onChange={e => updateLine(i, 'width_cm', parseFloat(e.target.value) || null)} /></td>
                    <td className="px-3 py-1.5"><input type="number" className={inputClass + ' text-right'} value={line.height_cm || ''} step="0.1" onChange={e => updateLine(i, 'height_cm', parseFloat(e.target.value) || null)} /></td>
                    <td className="px-3 py-1.5 text-right font-mono text-gray-600">{line.cbm != null ? fmtNum(line.cbm, 4) : '—'}</td>
                    <td className="px-3 py-1.5"><input type="number" className={inputClass + ' text-right'} value={line.weight_kg || ''} step="0.01" onChange={e => updateLine(i, 'weight_kg', parseFloat(e.target.value) || null)} /></td>
                    <td className="px-3 py-1.5"><input className={inputClass} value={line.location} onChange={e => updateLine(i, 'location', e.target.value)} placeholder="01-A26" /></td>
                    <td className="px-3 py-1.5"><input className={inputClass} value={line.remarks} onChange={e => updateLine(i, 'remarks', e.target.value)} /></td>
                    <td className="px-3 py-1.5 text-center">
                      <input
                        ref={el => { photoInputRefs.current[i] = el }}
                        type="file"
                        accept="image/*"
                        capture="environment"
                        onChange={e => handleLinePhoto(i, e)}
                        className="hidden"
                      />
                      <div className="flex items-center gap-1 justify-center flex-wrap">
                        {(line.photo_urls || []).map((url, pi) => (
                          <div key={pi} className="relative group">
                            <img src={url} alt="foto" className="h-8 w-12 object-cover rounded" />
                            <button type="button" onClick={() => removeLinePhoto(i, pi)} className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full w-3.5 h-3.5 text-xs items-center justify-center hidden group-hover:flex leading-none">×</button>
                          </div>
                        ))}
                        <button type="button" onClick={() => photoInputRefs.current[i]?.click()} className="text-gray-300 hover:text-mcl-blue transition-colors">
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                          </svg>
                        </button>
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      <button
                        type="button"
                        onClick={() => printLineLabels(i)}
                        className="text-gray-300 hover:text-mcl-blue transition-colors"
                        title="Imprimir etiquetas de esta línea"
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5l5 5v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2zm7 0v5h5" />
                        </svg>
                      </button>
                    </td>
                    <td className="px-2 py-1.5">
                      <button onClick={() => removeLine(i)} className="text-gray-300 hover:text-mcl-red transition-colors">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-gray-50 border-t-2 border-gray-200">
                <tr>
                  <td colSpan={4} className="px-3 py-2 text-xs font-bold text-gray-600 uppercase">TOTALES</td>
                  <td className="px-3 py-2 text-right font-bold text-mcl-blue">{fmtNum(totals.total_qty)}</td>
                  <td colSpan={3}></td>
                  <td className="px-3 py-2 text-right font-bold text-mcl-blue font-mono">{fmtNum(totals.total_cbm, 4)}</td>
                  <td className="px-3 py-2 text-right font-bold text-mcl-blue font-mono">{fmtNum(totals.total_weight_kg)}</td>
                  <td colSpan={5}></td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="lg:hidden divide-y divide-gray-100">
            {lines.map((line, i) => (
              <div key={i} className="p-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-bold text-gray-500">LÍNEA {i + 1}</span>
                  <button onClick={() => removeLine(i)} className="text-gray-300 hover:text-mcl-red">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2">
                    <label className="text-xs text-gray-500 mb-1 block">Tipo de pieza</label>
                    <select className={inputClass} value={line.packing_type} onChange={e => updateLine(i, 'packing_type', e.target.value)}>
                      {PACKING_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  <div className="flex gap-4 items-center">
                    <label className="flex items-center gap-1 text-sm cursor-pointer">
                      <input type="checkbox" checked={line.has_lb} onChange={e => updateLine(i, 'has_lb', e.target.checked)} className="w-4 h-4 accent-mcl-blue" />
                      <span>LB</span>
                    </label>
                    <label className="flex items-center gap-1 text-sm cursor-pointer">
                      <input type="checkbox" checked={line.is_dg} onChange={e => updateLine(i, 'is_dg', e.target.checked)} className="w-4 h-4 accent-mcl-red" />
                      <span className="text-mcl-red font-semibold">DG</span>
                    </label>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">QTY</label>
                    <input type="number" className={inputClass} value={line.qty || ''} min={1} onChange={e => updateLine(i, 'qty', parseInt(e.target.value) || 0)} />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Largo (cm)</label>
                    <input type="number" className={inputClass} value={line.length_cm || ''} step="0.1" onChange={e => updateLine(i, 'length_cm', parseFloat(e.target.value) || null)} />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Ancho (cm)</label>
                    <input type="number" className={inputClass} value={line.width_cm || ''} step="0.1" onChange={e => updateLine(i, 'width_cm', parseFloat(e.target.value) || null)} />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Alto (cm)</label>
                    <input type="number" className={inputClass} value={line.height_cm || ''} step="0.1" onChange={e => updateLine(i, 'height_cm', parseFloat(e.target.value) || null)} />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">CBM (auto)</label>
                    <div className="px-3 py-2 bg-gray-50 rounded text-sm font-mono text-gray-600">{line.cbm != null ? fmtNum(line.cbm, 4) : '—'}</div>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Peso (KG)</label>
                    <input type="number" className={inputClass} value={line.weight_kg || ''} step="0.01" onChange={e => updateLine(i, 'weight_kg', parseFloat(e.target.value) || null)} />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Ubicación</label>
                    <input className={inputClass} value={line.location} onChange={e => updateLine(i, 'location', e.target.value)} placeholder="01-A26" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Notas</label>
                    <input className={inputClass} value={line.remarks} onChange={e => updateLine(i, 'remarks', e.target.value)} />
                  </div>
                  <div className="col-span-2">
                    <label className="text-xs text-gray-500 mb-1 block">Fotos</label>
                    <input
                      ref={el => { photoInputRefs.current[i] = el }}
                      type="file"
                      accept="image/*"
                      capture="environment"
                      onChange={e => handleLinePhoto(i, e)}
                      className="hidden"
                    />
                    <div className="flex flex-wrap gap-2 mb-2">
                      {(line.photo_urls || []).map((url, pi) => (
                        <div key={pi} className="relative">
                          <img src={url} alt="foto" className="h-16 w-24 object-cover rounded border border-gray-200" />
                          <button type="button" onClick={() => removeLinePhoto(i, pi)} className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs leading-none">×</button>
                        </div>
                      ))}
                    </div>
                    <button type="button" onClick={() => photoInputRefs.current[i]?.click()} className="flex items-center gap-2 border border-dashed border-gray-300 rounded-lg px-4 py-3 w-full hover:border-mcl-blue transition-colors text-gray-400 hover:text-mcl-blue">
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                      <span className="text-sm">+ Agregar foto</span>
                    </button>
                  </div>
                  <div className="col-span-2">
                    <button
                      type="button"
                      onClick={() => printLineLabels(i)}
                      className="flex items-center gap-2 border border-dashed border-gray-300 rounded-lg px-4 py-3 w-full hover:border-mcl-blue transition-colors text-gray-400 hover:text-mcl-blue"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5l5 5v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2zm7 0v5h5" />
                      </svg>
                      <span className="text-sm">Imprimir etiquetas ({line.qty || 1} pcs)</span>
                    </button>
                  </div>
                </div>
              </div>
            ))}
            <div className="p-4 bg-gray-50">
              <div className="grid grid-cols-3 gap-2 text-center">
                <div><div className="text-xs text-gray-500">Total Piezas</div><div className="font-bold text-mcl-blue text-lg">{fmtNum(totals.total_qty)}</div></div>
                <div><div className="text-xs text-gray-500">Total CBM</div><div className="font-bold text-mcl-blue text-lg">{fmtNum(totals.total_cbm, 4)}</div></div>
                <div><div className="text-xs text-gray-500">Total KG</div><div className="font-bold text-mcl-blue text-lg">{fmtNum(totals.total_weight_kg, 1)}</div></div>
              </div>
            </div>
          </div>
        </div>

        {/* ── SKU Detail Section ── */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="px-4 py-3 bg-gray-50 flex items-center justify-between">
            <h3 className="font-semibold text-gray-700 text-sm">Detalle SKU</h3>
            <div className="flex items-center gap-2">
              {!showSku && (
                <button
                  type="button"
                  onClick={() => { setShowSku(true); if (skuLines.length === 0) addSkuLine() }}
                  className="flex items-center gap-1 text-xs font-semibold text-mcl-blue hover:text-blue-900 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  Agregar SKUs
                </button>
              )}
              {showSku && (
                <>
                  <input ref={skuFileRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleSkuImport} className="hidden" />
                  <button
                    type="button"
                    onClick={() => skuFileRef.current?.click()}
                    className="flex items-center gap-1 text-xs font-semibold text-green-700 hover:text-green-900 border border-green-200 bg-green-50 px-2 py-1 rounded-lg transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                    </svg>
                    Importar Excel
                  </button>
                  <button
                    type="button"
                    onClick={addSkuLine}
                    className="flex items-center gap-1 text-xs font-semibold text-mcl-blue hover:text-blue-900 border border-blue-200 bg-blue-50 px-2 py-1 rounded-lg transition-colors"
                  >
                    + Línea
                  </button>
                </>
              )}
            </div>
          </div>

          {showSku && skuLines.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-100">
                    <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase">#</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase">SKU</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase">VIN</th>
                    <th className="px-3 py-2 text-center text-xs font-semibold text-gray-500 uppercase">Received Qty SKU</th>
                    <th className="px-3 py-2 text-center text-xs font-semibold text-gray-500 uppercase">Case Pack</th>
                    <th className="px-1 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {skuLines.map((sku, i) => (
                    <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="px-3 py-1.5 text-xs text-gray-400 font-mono">{i + 1}</td>
                      <td className="px-2 py-1.5">
                        <input value={sku.sku} onChange={e => updateSkuLine(i, 'sku', e.target.value)}
                          className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-mcl-blue/30" placeholder="SKU" />
                      </td>
                      <td className="px-2 py-1.5">
                        <input value={sku.vin} onChange={e => updateSkuLine(i, 'vin', e.target.value)}
                          className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-mcl-blue/30" placeholder="VIN" />
                      </td>
                      <td className="px-2 py-1.5">
                        <input type="number" min={0} value={sku.received_qty || ''} onChange={e => updateSkuLine(i, 'received_qty', Number(e.target.value))}
                          className="w-20 mx-auto block border border-gray-200 rounded px-2 py-1 text-xs text-center focus:outline-none focus:ring-1 focus:ring-mcl-blue/30" />
                      </td>
                      <td className="px-2 py-1.5">
                        <input type="number" min={0} value={sku.case_pack || ''} onChange={e => updateSkuLine(i, 'case_pack', Number(e.target.value))}
                          className="w-20 mx-auto block border border-gray-200 rounded px-2 py-1 text-xs text-center focus:outline-none focus:ring-1 focus:ring-mcl-blue/30" />
                      </td>
                      <td className="px-1 py-1.5">
                        <button type="button" onClick={() => removeSkuLine(i)} className="text-red-400 hover:text-red-600 text-xs p-1">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-4 py-2 bg-gray-50 text-xs text-gray-500">
                {skuLines.length} línea{skuLines.length !== 1 ? 's' : ''} SKU
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-3">
          <button onClick={() => handleSave(false)} disabled={saving} className="flex-1 border border-gray-300 text-gray-700 px-4 py-3 rounded-xl text-sm hover:bg-gray-50 transition-colors disabled:opacity-50">
            Guardar Borrador
          </button>
          <button onClick={() => handleSave(true)} disabled={saving} className="flex-1 bg-mcl-blue text-white px-4 py-3 rounded-xl text-sm font-semibold hover:bg-blue-900 transition-colors disabled:opacity-50">
            {saving ? 'Guardando...' : 'Completar e Imprimir WR ✓'}
          </button>
        </div>
      </div>

    </Layout>
  )
}
