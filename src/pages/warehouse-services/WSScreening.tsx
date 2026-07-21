import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { doc, getDoc, updateDoc, addDoc, collection } from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import Layout from '../../components/Layout'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import type { WSServiceOrder, WSServiceItem, WSInspectionLog } from '../../types'

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

async function buildScreeningPdf(order: WSServiceOrder, log: {
  method: string, pieces_inspected: number, pieces_total: number,
  result: string, inspector_name: string, inspector_email: string,
  ccsf_number: string, inspection_date: string, notes: string
}): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create()
  const page = pdfDoc.addPage([612, 792]) // Letter
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

  const LM = 50
  const pageWidth = 612
  let y = 740

  // Header
  page.drawText('MINCURL LOGISTICS LLC', { x: LM, y, size: 16, font: bold, color: rgb(0, 0, 0) })
  y -= 22
  page.drawText('Screening Inspection Report', { x: LM, y, size: 12, font: regular, color: rgb(0.2, 0.2, 0.2) })
  y -= 18

  // Horizontal line separator
  page.drawLine({ start: { x: LM, y }, end: { x: pageWidth - LM, y }, thickness: 1, color: rgb(0.3, 0.3, 0.3) })
  y -= 25

  // Info section - Left column
  const leftX = LM
  const rightX = 330
  const labelSize = 9
  const valueSize = 10
  const lineH = 16

  // Left column
  page.drawText('SO Number:', { x: leftX, y, size: labelSize, font: bold, color: rgb(0.3, 0.3, 0.3) })
  page.drawText(order.so_number, { x: leftX + 75, y, size: valueSize, font: regular, color: rgb(0, 0, 0) })

  // Right column - Method
  const methodLabel = log.method === 'xray' ? 'X-Ray' : log.method === 'dg_inspection' ? 'DG Inspection' : 'Manual'
  page.drawText('Method:', { x: rightX, y, size: labelSize, font: bold, color: rgb(0.3, 0.3, 0.3) })
  page.drawText(methodLabel, { x: rightX + 55, y, size: valueSize, font: regular, color: rgb(0, 0, 0) })
  y -= lineH

  page.drawText('Client:', { x: leftX, y, size: labelSize, font: bold, color: rgb(0.3, 0.3, 0.3) })
  page.drawText(order.client_name || 'N/A', { x: leftX + 75, y, size: valueSize, font: regular, color: rgb(0, 0, 0) })

  // Right column - Inspector
  page.drawText('Inspector:', { x: rightX, y, size: labelSize, font: bold, color: rgb(0.3, 0.3, 0.3) })
  page.drawText(log.inspector_name, { x: rightX + 55, y, size: valueSize, font: regular, color: rgb(0, 0, 0) })
  y -= lineH

  page.drawText('AWB:', { x: leftX, y, size: labelSize, font: bold, color: rgb(0.3, 0.3, 0.3) })
  page.drawText(order.awb_number || 'N/A', { x: leftX + 75, y, size: valueSize, font: regular, color: rgb(0, 0, 0) })

  // Right column - Result
  const resultColor = log.result === 'PASS' ? rgb(0.1, 0.6, 0.1) : rgb(0.8, 0.1, 0.1)
  page.drawText('Result:', { x: rightX, y, size: labelSize, font: bold, color: rgb(0.3, 0.3, 0.3) })
  page.drawText(log.result, { x: rightX + 55, y, size: valueSize, font: bold, color: resultColor })
  y -= lineH

  const dateFormatted = new Date(log.inspection_date).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  })
  page.drawText('Date:', { x: leftX, y, size: labelSize, font: bold, color: rgb(0.3, 0.3, 0.3) })
  page.drawText(dateFormatted, { x: leftX + 75, y, size: valueSize, font: regular, color: rgb(0, 0, 0) })
  y -= lineH + 10

  // Separator
  page.drawLine({ start: { x: LM, y }, end: { x: pageWidth - LM, y }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) })
  y -= 20

  // Details section
  page.drawText('Details', { x: LM, y, size: 11, font: bold, color: rgb(0, 0, 0) })
  y -= 18

  page.drawText(`Pieces Inspected: ${log.pieces_inspected} of ${log.pieces_total}`, { x: LM, y, size: valueSize, font: regular, color: rgb(0, 0, 0) })
  y -= lineH

  page.drawText(`CCSF #: ${log.ccsf_number || 'N/A'}`, { x: LM, y, size: valueSize, font: regular, color: rgb(0, 0, 0) })
  y -= lineH + 10

  // Notes section
  if (log.notes) {
    page.drawLine({ start: { x: LM, y }, end: { x: pageWidth - LM, y }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) })
    y -= 20
    page.drawText('Notes', { x: LM, y, size: 11, font: bold, color: rgb(0, 0, 0) })
    y -= 18

    // Simple word-wrap for notes
    const words = log.notes.split(' ')
    let line = ''
    const maxW = pageWidth - LM * 2
    for (const word of words) {
      const test = line ? `${line} ${word}` : word
      if (regular.widthOfTextAtSize(test, valueSize) > maxW) {
        page.drawText(line, { x: LM, y, size: valueSize, font: regular, color: rgb(0, 0, 0) })
        y -= 14
        line = word
      } else {
        line = test
      }
    }
    if (line) {
      page.drawText(line, { x: LM, y, size: valueSize, font: regular, color: rgb(0, 0, 0) })
      y -= 14
    }
    y -= 10
  }

  // Result banner
  y -= 20
  const bannerColor = log.result === 'PASS' ? rgb(0.1, 0.65, 0.1) : rgb(0.8, 0.1, 0.1)
  const bannerText = log.result
  const bannerFontSize = 36
  const bannerW = bold.widthOfTextAtSize(bannerText, bannerFontSize)
  const bannerX = (pageWidth - bannerW) / 2
  page.drawText(bannerText, { x: bannerX, y, size: bannerFontSize, font: bold, color: bannerColor })
  y -= 50

  // Footer
  const footerY = 40
  const footerDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  const footerText = `Generated by MCL WMS - ${footerDate}`
  page.drawText(footerText, { x: LM, y: footerY, size: 8, font: regular, color: rgb(0.5, 0.5, 0.5) })

  const confText = 'CONFIDENTIAL'
  const confW = bold.widthOfTextAtSize(confText, 8)
  page.drawText(confText, { x: pageWidth - LM - confW, y: footerY, size: 8, font: bold, color: rgb(0.5, 0.5, 0.5) })

  return await pdfDoc.save()
}

export default function WSScreening() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user, isAdmin, isSuperAgent, isAgent, isCounter, isBodega } = useAuth()
  const canOperate = isAdmin || isSuperAgent || isAgent || isCounter || isBodega

  const [order, setOrder] = useState<WSServiceOrder | null>(null)
  const [screeningItem, setScreeningItem] = useState<WSServiceItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // K9 cert
  const [certUrl, setCertUrl] = useState('')
  const certFileRef = useRef<HTMLInputElement | null>(null)

  // Inspection Log fields (xray, manual, dg_inspection)
  const [piecesInspected, setPiecesInspected] = useState('')
  const [piecesTotal, setPiecesTotal] = useState('')
  const [result, setResult] = useState<'PASS' | 'FAIL'>('PASS')
  const [inspectorName, setInspectorName] = useState('')
  const [logNotes, setLogNotes] = useState('')
  const [photos, setPhotos] = useState<string[]>([])
  const photoRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!id) return
    loadData()
  }, [id])

  async function loadData() {
    setLoading(true)
    const snap = await getDoc(doc(db, 'warehouse_service_orders', id!))
    if (snap.exists()) {
      const so = { id: snap.id, ...snap.data() } as WSServiceOrder
      setOrder(so)
      const sItem = so.service_items.find(s =>
        s.type.startsWith('screening_') || s.type === 'dg_inspection'
      )
      if (sItem) {
        setScreeningItem(sItem)
        setPiecesTotal(String(so.declared_pieces || 0))
        setPiecesInspected(String(so.declared_pieces || 0))
        setInspectorName(user?.email?.split('@')[0] || '')
        if (sItem.cert_url) setCertUrl(sItem.cert_url)
      }
    }
    setLoading(false)
  }

  async function handleCertUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const b64 = await toBase64(file, 1200, 0.85)
    setCertUrl(b64)
    e.target.value = ''
  }

  async function handlePhotoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const b64 = await toBase64(file)
    setPhotos(prev => [...prev, b64])
    e.target.value = ''
  }

  async function handleComplete() {
    if (!order || !screeningItem) return
    if (screeningItem.type === 'screening_k9' && !certUrl) {
      alert('Attach the K9 certificate.')
      return
    }
    if (screeningItem.type !== 'screening_k9') {
      if (!inspectorName.trim()) { alert('Inspector name is required.'); return }
    }

    setSaving(true)
    try {
      const now = new Date().toISOString()
      let inspectionLogId: string | null = null

      // Create Inspection Log for non-K9 methods
      let reportPdfUrl: string | null = null

      if (screeningItem.type !== 'screening_k9') {
        const logData: Omit<WSInspectionLog, 'id'> = {
          so_id: order.id!,
          so_number: order.so_number,
          service_item_id: screeningItem.id,
          awb_number: order.awb_number || null,
          method: screeningItem.type === 'screening_xray' ? 'xray'
            : screeningItem.type === 'dg_inspection' ? 'dg_inspection'
            : 'manual',
          pieces_inspected: parseInt(piecesInspected) || 0,
          pieces_total: parseInt(piecesTotal) || 0,
          result,
          inspector_name: inspectorName.trim(),
          inspector_email: user?.email || '',
          ccsf_number: '',
          inspection_date: now,
          notes: logNotes.trim(),
          photo_urls: photos,
          doc_urls: [],
          created_at: now,
          created_by: user?.email || '',
        }
        const logRef = await addDoc(collection(db, 'ws_inspection_logs'), logData)
        inspectionLogId = logRef.id

        // Generate PDF report
        try {
          const pdfBytes = await buildScreeningPdf(order, {
            method: logData.method,
            pieces_inspected: logData.pieces_inspected,
            pieces_total: logData.pieces_total,
            result: logData.result,
            inspector_name: logData.inspector_name,
            inspector_email: logData.inspector_email,
            ccsf_number: logData.ccsf_number || '',
            inspection_date: logData.inspection_date,
            notes: logData.notes,
          })
          const timestamp = Date.now()
          const storagePath = `ws_screening_reports/${order.so_number}_${logData.method}_${timestamp}.pdf`
          const storageRef = ref(storage, storagePath)
          await uploadBytes(storageRef, pdfBytes, { contentType: 'application/pdf' })
          reportPdfUrl = await getDownloadURL(storageRef)
        } catch (pdfErr) {
          console.error('Failed to generate/upload screening PDF:', pdfErr)
        }
      }

      // Update service item in SO
      const updatedItems = order.service_items.map(item => {
        if (item.id !== screeningItem.id) return item
        return {
          ...item,
          status: result === 'FAIL' ? 'fail' as const : 'completed' as const,
          completed_at: now,
          completed_by: user?.email || null,
          cert_url: screeningItem.type === 'screening_k9' ? certUrl : null,
          inspection_log_id: inspectionLogId,
          report_pdf_url: screeningItem.type === 'screening_k9' ? null : reportPdfUrl,
        }
      })

      // Derive global status
      const allDone = updatedItems.every(i => i.status === 'completed' || i.status === 'cancelled' || i.status === 'fail')
      const anyActive = updatedItems.some(i => i.status === 'in_progress' || i.status === 'completed')

      const update: Record<string, unknown> = {
        service_items: updatedItems,
        global_status: allDone ? 'completed' : anyActive ? 'in_progress' : order.global_status,
      }
      if (allDone) update.completed_at = now

      await updateDoc(doc(db, 'warehouse_service_orders', order.id!), update)
      navigate(`/warehouse-services/orders/${order.id}`)
    } catch (e) {
      alert('Error: ' + (e instanceof Error ? e.message : String(e)))
    }
    setSaving(false)
  }

  const inputClass = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30'
  const labelClass = 'text-xs font-semibold text-gray-500 uppercase block mb-1'

  if (loading) return <Layout title="Screening" backTo={`/warehouse-services/orders/${id}`}><div className="text-center py-20 text-gray-400">Loading...</div></Layout>
  if (!order || !screeningItem) return <Layout title="Screening" backTo="/warehouse-services"><div className="text-center py-20 text-gray-400">No screening service found in this order.</div></Layout>

  const isK9 = screeningItem.type === 'screening_k9'
  const methodLabel = isK9 ? 'K9'
    : screeningItem.type === 'screening_xray' ? 'X-Ray'
    : screeningItem.type === 'dg_inspection' ? 'DG Inspection'
    : 'Manual'

  if (!canOperate) {
    return <Layout title="Screening" backTo="/warehouse-services"><p className="text-center text-gray-500 mt-10">Access restricted</p></Layout>
  }

  return (
    <Layout title={`Screening ${methodLabel} — ${order.so_number}`} backTo={`/warehouse-services/orders/${order.id}`}>
      <div className="max-w-2xl mx-auto px-4 py-6">
        {/* SO Summary */}
        <div className="bg-white rounded-xl shadow-sm border p-4 mb-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div>
              <div className="text-xs text-gray-400">SO</div>
              <div className="font-mono font-bold text-mcl-blue">{order.so_number}</div>
            </div>
            <div>
              <div className="text-xs text-gray-400">Client</div>
              <div>{order.client_name}</div>
            </div>
            <div>
              <div className="text-xs text-gray-400">AWB</div>
              <div className="font-mono">{order.awb_number || '—'}</div>
            </div>
            <div>
              <div className="text-xs text-gray-400">Pieces</div>
              <div>{order.declared_pieces}</div>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border">
          <div className="px-6 py-4 border-b border-gray-100">
            <h3 className="font-bold text-gray-800">Screening — {methodLabel}</h3>
          </div>

          <div className="px-6 py-5 space-y-4">
            {isK9 ? (
              /* ── K9: Upload certificate ── */
              <div>
                <label className={labelClass}>K9 Certificate</label>
                {certUrl ? (
                  <div className="space-y-2">
                    <div className="text-xs text-green-600 font-semibold">Certificate uploaded</div>
                    <img src={certUrl} alt="K9 Cert" className="max-h-40 rounded border" />
                    <button onClick={() => setCertUrl('')} className="text-xs text-red-500 hover:underline">Remove</button>
                  </div>
                ) : (
                  <div>
                    <button
                      onClick={() => certFileRef.current?.click()}
                      className="text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 px-4 py-2 rounded-lg"
                    >
                      Attach Certificate
                    </button>
                    <input ref={certFileRef} type="file" accept="image/*,.pdf" className="hidden" onChange={handleCertUpload} />
                  </div>
                )}
              </div>
            ) : (
              /* ── X-Ray / Manual / DG: Inspection Log ── */
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelClass}>Pieces Inspected</label>
                    <input type="number" value={piecesInspected} onChange={e => setPiecesInspected(e.target.value)} className={inputClass} />
                  </div>
                  <div>
                    <label className={labelClass}>Total Pieces</label>
                    <input type="number" value={piecesTotal} onChange={e => setPiecesTotal(e.target.value)} className={inputClass} />
                  </div>
                </div>
                <div>
                  <label className={labelClass}>Inspector</label>
                  <input value={inspectorName} onChange={e => setInspectorName(e.target.value)} className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>Result</label>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => setResult('PASS')}
                      className={`flex-1 text-sm font-semibold py-2 rounded-lg border transition-colors ${result === 'PASS' ? 'bg-green-500 text-white border-green-500' : 'bg-white text-gray-600 border-gray-200'}`}
                    >
                      PASS
                    </button>
                    <button
                      type="button"
                      onClick={() => setResult('FAIL')}
                      className={`flex-1 text-sm font-semibold py-2 rounded-lg border transition-colors ${result === 'FAIL' ? 'bg-red-500 text-white border-red-500' : 'bg-white text-gray-600 border-gray-200'}`}
                    >
                      FAIL
                    </button>
                  </div>
                </div>
                <div>
                  <label className={labelClass}>Notes</label>
                  <textarea value={logNotes} onChange={e => setLogNotes(e.target.value)} rows={3} className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>Photos</label>
                  <div className="flex flex-wrap gap-2 mb-2">
                    {photos.map((p, i) => (
                      <div key={i} className="relative">
                        <img src={p} alt="" className="h-16 w-16 object-cover rounded border" />
                        <button
                          onClick={() => setPhotos(prev => prev.filter((_, j) => j !== i))}
                          className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full w-4 h-4 text-[10px] flex items-center justify-center"
                        >
                          x
                        </button>
                      </div>
                    ))}
                  </div>
                  <button onClick={() => photoRef.current?.click()} className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-1.5 rounded-lg">
                    + Photo
                  </button>
                  <input ref={photoRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handlePhotoUpload} />
                </div>
              </>
            )}
          </div>

          {/* Actions */}
          <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
            <button
              onClick={() => navigate(`/warehouse-services/orders/${order.id}`)}
              className="text-sm text-gray-500 hover:text-gray-700 px-4 py-2"
              disabled={saving}
            >
              Cancel
            </button>
            <button
              onClick={handleComplete}
              disabled={saving}
              className={`text-sm font-semibold px-5 py-2 rounded-lg transition-colors disabled:opacity-50 ${
                result === 'FAIL'
                  ? 'bg-red-500 hover:bg-red-600 text-white'
                  : 'bg-green-600 hover:bg-green-700 text-white'
              }`}
            >
              {saving ? 'Saving...' : result === 'FAIL' ? 'Mark FAIL' : 'Complete Screening'}
            </button>
          </div>
        </div>
      </div>
    </Layout>
  )
}
