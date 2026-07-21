import { useState, useRef, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { collection, query, where, getDocs, doc, getDoc, updateDoc } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { AirfreightBooking, AirfreightFlight, AwbSecondLeg } from '../../types'
import Layout from '../../components/Layout'
import {
  DistributionData, PalletEntry, AwbPage,
  pdfToImages, splitPdfPages,
  callProcessDistribution, callIdentifyAwbs,
  writePalletsOnAwb, writePalletsOnFullAwb, uploadModifiedAwb,
} from '../../lib/awbCut'

type Step = 'select' | 'processing' | 'distribution' | 'awbs' | 'edit' | 'preview'

/** Remove undefined values from objects in an array (Firestore rejects undefined) */
function sanitizeLines(lines: any[]): any[] {
  return lines.map(line => JSON.parse(JSON.stringify(line)))
}

interface FlightAwbInfo {
  bookingId: string
  awbIndex: number
  awbNumber: string       // awb_2nd_leg or awb_number
  awb1stLeg: string
  pieces: number
  chargeableWeight: number
  hasHawb: boolean
  hawbUrl?: string
  selected: boolean
}

export default function AirfreightAwbCut() {
  const { flightId } = useParams<{ flightId: string }>()
  const navigate = useNavigate()
  const isAutoMode = !!flightId

  const [step, setStep] = useState<Step>(isAutoMode ? 'select' : 'distribution')

  // Flight info (auto mode)
  const [flightInfo, setFlightInfo] = useState<{ airline: string; flightNumber: string; etd: string; destinations: string[] } | null>(null)
  const [flightAwbs, setFlightAwbs] = useState<FlightAwbInfo[]>([])
  const [flightLoading, setFlightLoading] = useState(false)
  const [flightError, setFlightError] = useState('')

  // Processing state (auto mode)
  const [processStatus, setProcessStatus] = useState('')
  const [processError, setProcessError] = useState('')

  // Step 1: Distribution (manual mode)
  const [distLoading, setDistLoading] = useState(false)
  const [distData, setDistData] = useState<DistributionData | null>(null)
  const [distError, setDistError] = useState('')
  const distInputRef = useRef<HTMLInputElement>(null)

  // Step 2: AWBs (manual mode)
  const [awbsLoading, setAwbsLoading] = useState(false)
  const [awbPages, setAwbPages] = useState<AwbPage[]>([])
  const [awbsError, setAwbsError] = useState('')
  const awbInputRef = useRef<HTMLInputElement>(null)

  // Step 3: Edit
  const [selectedAwbIdx, setSelectedAwbIdx] = useState(0)

  // Step 4: Preview + Upload
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewUrls, setPreviewUrls] = useState<Map<number, string>>(new Map())
  const [uploading, setUploading] = useState(false)
  const [uploadDone, setUploadDone] = useState(false)

  // Auto mode: full PDF bytes per AWB (for writing pallets on all copies)
  const [fullPdfMap, setFullPdfMap] = useState<Map<number, ArrayBuffer>>(new Map())

  // ── Auto mode: Load flight data ──
  useEffect(() => {
    if (!isAutoMode || !flightId) return
    loadFlightData()
  }, [flightId])

  async function loadFlightData() {
    setFlightLoading(true)
    setFlightError('')
    try {
      const flightSnap = await getDoc(doc(db, 'airfreight_flights', flightId!))
      if (!flightSnap.exists()) { setFlightError('Vuelo no encontrado'); setFlightLoading(false); return }
      const flight = flightSnap.data() as AirfreightFlight
      setFlightInfo({
        airline: flight.airline,
        flightNumber: flight.flight_number || '',
        etd: flight.flight_datetime || '',
        destinations: flight.destinations || [],
      })

      // Find all bookings for this flight
      const bQuery = query(collection(db, 'airfreight_bookings'), where('flight_id', '==', flightId))
      const bSnap = await getDocs(bQuery)

      const awbs: FlightAwbInfo[] = []
      for (const bDoc of bSnap.docs) {
        const booking = bDoc.data() as AirfreightBooking
        if (booking.booking_type === 'mawb' && booking.awb_lines) {
          booking.awb_lines.forEach((line, idx) => {
            const awbNum = line.awb_2nd_leg || line.awb_number || ''
            awbs.push({
              bookingId: bDoc.id,
              awbIndex: idx,
              awbNumber: awbNum,
              awb1stLeg: line.awb_number || '',
              pieces: line.pieces || 0,
              chargeableWeight: line.chargeable_weight || 0,
              hasHawb: !!line.documents?.doc_hawb?.url,
              hawbUrl: line.documents?.doc_hawb?.url,
              selected: !!line.documents?.doc_hawb?.url,
            })
          })
        } else if (booking.awb_lines) {
          booking.awb_lines.forEach((line, idx) => {
            const awbNum = line.awb_2nd_leg || line.awb_number || ''
            awbs.push({
              bookingId: bDoc.id,
              awbIndex: idx,
              awbNumber: awbNum,
              awb1stLeg: line.awb_number || '',
              pieces: line.pieces || 0,
              chargeableWeight: line.chargeable_weight || 0,
              hasHawb: !!line.documents?.doc_hawb?.url,
              hawbUrl: line.documents?.doc_hawb?.url,
              selected: !!line.documents?.doc_hawb?.url,
            })
          })
        }
      }
      setFlightAwbs(awbs)
    } catch (e: any) {
      setFlightError(e.message || 'Error cargando vuelo')
    }
    setFlightLoading(false)
  }

  function toggleAwbSelection(idx: number) {
    setFlightAwbs(prev => prev.map((a, i) => i === idx ? { ...a, selected: !a.selected } : a))
  }

  function toggleAllAwbs() {
    const selectableAwbs = flightAwbs.filter(a => a.hasHawb)
    const allSelected = selectableAwbs.every(a => a.selected)
    setFlightAwbs(prev => prev.map(a => a.hasHawb ? { ...a, selected: !allSelected } : a))
  }

  // ── Auto mode: Process distribution + download AWBs ──
  async function handleAutoProcess() {
    setStep('processing')
    setProcessStatus('Descargando distribución...')
    setProcessError('')
    try {
      // 1. Download distribution PDF from flight
      const flightSnap = await getDoc(doc(db, 'airfreight_flights', flightId!))
      const flight = flightSnap.data() as AirfreightFlight
      const distUrl = (flight as any).doc_distribucion_files?.[0]?.url || (flight as any).doc_distribucion?.url
      if (!distUrl) throw new Error('No se encontró distribución cargada para este vuelo')

      const distResp = await fetch(distUrl)
      if (!distResp.ok) throw new Error('Error descargando PDF de distribución')
      const distBytes = await distResp.arrayBuffer()

      // 2. Process distribution with Claude
      setProcessStatus('Procesando distribución con IA...')
      const distResult = await callProcessDistribution(distBytes)
      setDistData(distResult)

      // 3. Download AWB PDFs for selected AWBs
      const selected = flightAwbs.filter(a => a.selected && a.hasHawb)
      const pages: AwbPage[] = []
      const fullPdfs = new Map<number, ArrayBuffer>()

      for (let si = 0; si < selected.length; si++) {
        const awb = selected[si]
        setProcessStatus(`Descargando guía ${si + 1}/${selected.length}: ${awb.awbNumber}...`)

        const resp = await fetch(awb.hawbUrl!)
        if (!resp.ok) {
          console.warn(`Error descargando AWB ${awb.awbNumber}`)
          continue
        }
        const awbBytes = await resp.arrayBuffer()
        const awbNormalized = awb.awbNumber.replace(/[^0-9]/g, '')

        // Store full PDF for later multi-page writing
        fullPdfs.set(pages.length, awbBytes)

        // Split into pages and get first odd page (page 1 = index 0) for preview
        const allPageBuffers = await splitPdfPages(awbBytes)
        const firstPageBytes = allPageBuffers[0]
        const images = await pdfToImages(new Uint8Array(firstPageBytes).buffer)

        // Match with distribution
        let pallets: PalletEntry[] = []
        let matched = false
        const distEntry = distResult.entries.find(e =>
          e.awb.replace(/[^0-9]/g, '') === awbNormalized
        )
        if (distEntry) {
          pallets = distEntry.pallets.map(p => ({ ...p }))
          matched = true
        }

        pages.push({
          pageIndex: pages.length,
          awb_number: awb.awbNumber,
          imageDataUrl: `data:image/png;base64,${images[0]}`,
          pdfPageBytes: firstPageBytes,
          pallets,
          matched,
          // Store booking reference for direct update
          _bookingId: awb.bookingId,
          _awbIndex: awb.awbIndex,
        } as AwbPage & { _bookingId: string; _awbIndex: number })
      }

      setFullPdfMap(fullPdfs)
      setAwbPages(pages)
      setSelectedAwbIdx(0)

      const unmatched = pages.filter(p => !p.matched && p.awb_number)
      if (unmatched.length > 0) {
        setProcessStatus(`Listo. ${unmatched.length} AWB(s) sin match en distribución: ${unmatched.map(p => p.awb_number).join(', ')}`)
      } else {
        setProcessStatus('')
      }
      setStep('edit')
    } catch (e: any) {
      console.error('Auto process error:', e)
      setProcessError(e.message || 'Error en el procesamiento automático')
    }
  }

  // ── Manual mode: Step 1 Upload Distribution ──
  async function handleDistUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setDistLoading(true)
    setDistError('')
    try {
      const arrayBuf = await file.arrayBuffer()
      const result = await callProcessDistribution(arrayBuf)
      setDistData(result)
      setStep('awbs')
    } catch (err) {
      console.error('Distribution error:', err)
      setDistError('Error procesando la distribución: ' + (err as Error).message)
    } finally {
      setDistLoading(false)
      if (distInputRef.current) distInputRef.current.value = ''
    }
  }

  // ── Manual mode: Step 2 Upload AWBs ──
  async function handleAwbUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !distData) return
    setAwbsLoading(true)
    setAwbsError('')
    try {
      const arrayBuf = await file.arrayBuffer()
      const pageBuffers = await splitPdfPages(arrayBuf)
      const images = await pdfToImages(arrayBuf)

      const knownAwbs = distData ? distData.entries.map(e => e.awb) : undefined
      const pagesToIdentify = pageBuffers.map((buf, i) => ({ pdfBytes: buf, pageIndex: i }))
      const identified = await callIdentifyAwbs(pagesToIdentify, knownAwbs)

      const pages: AwbPage[] = []
      const unmatchedAwbs: string[] = []

      for (let i = 0; i < pageBuffers.length; i++) {
        const id = identified.find(r => r.pageIndex === i)
        const awbNum = id?.awb_number || null

        let pallets: PalletEntry[] = []
        let matched = false
        if (awbNum && distData) {
          const distEntry = distData.entries.find(e =>
            e.awb.replace(/[^0-9]/g, '') === awbNum.replace(/[^0-9]/g, '')
          )
          if (distEntry) {
            pallets = distEntry.pallets.map(p => ({ ...p }))
            matched = true
          } else {
            unmatchedAwbs.push(awbNum)
          }
        }

        pages.push({
          pageIndex: i,
          awb_number: awbNum,
          imageDataUrl: `data:image/png;base64,${images[i]}`,
          pdfPageBytes: pageBuffers[i],
          pallets,
          matched,
        })
      }

      setAwbPages(pages)
      setSelectedAwbIdx(0)

      if (unmatchedAwbs.length > 0) {
        const proceed = window.confirm(
          `Las siguientes AWBs no tienen match en la distribución:\n${unmatchedAwbs.join('\n')}\n\n¿Continuar sin pallet info para estas guías?`
        )
        if (!proceed) {
          setAwbsLoading(false)
          return
        }
      }

      setStep('edit')
    } catch (err) {
      console.error('AWB identification error:', err)
      setAwbsError('Error identificando AWBs: ' + (err as Error).message)
    } finally {
      setAwbsLoading(false)
      if (awbInputRef.current) awbInputRef.current.value = ''
    }
  }

  // ── Step 3: Edit pallets ──
  const currentPage = awbPages[selectedAwbIdx]

  function updatePallet(palletIdx: number, field: 'pallet_no' | 'pieces', value: string | number) {
    setAwbPages(prev => {
      const next = [...prev]
      const page = { ...next[selectedAwbIdx] }
      const pallets = [...page.pallets]
      pallets[palletIdx] = { ...pallets[palletIdx], [field]: value }
      page.pallets = pallets
      next[selectedAwbIdx] = page
      return next
    })
  }

  function removePallet(palletIdx: number) {
    setAwbPages(prev => {
      const next = [...prev]
      const page = { ...next[selectedAwbIdx] }
      page.pallets = page.pallets.filter((_, i) => i !== palletIdx)
      next[selectedAwbIdx] = page
      return next
    })
  }

  function addPallet() {
    setAwbPages(prev => {
      const next = [...prev]
      const page = { ...next[selectedAwbIdx] }
      page.pallets = [...page.pallets, { pallet_no: '', pieces: 0 }]
      next[selectedAwbIdx] = page
      return next
    })
  }

  // ── Step 4: Generate preview ──
  async function handleGeneratePreview() {
    setPreviewLoading(true)
    try {
      const urls = new Map<number, string>()
      for (let i = 0; i < awbPages.length; i++) {
        const page = awbPages[i]
        if (page.pallets.length === 0) continue

        let modified: ArrayBuffer
        if (isAutoMode && fullPdfMap.has(i)) {
          // Auto mode: write on all 5 odd pages of the full 10-page PDF
          modified = await writePalletsOnFullAwb(fullPdfMap.get(i)!, page.pallets, page.palletPos)
        } else {
          // Manual mode: single page
          modified = await writePalletsOnAwb(page.pdfPageBytes, page.pallets, page.palletPos)
        }
        const blob = new Blob([modified], { type: 'application/pdf' })
        urls.set(i, URL.createObjectURL(blob))
      }
      setPreviewUrls(urls)
      setStep('preview')
    } catch (err) {
      console.error('Preview error:', err)
      alert('Error generando preview: ' + (err as Error).message)
    } finally {
      setPreviewLoading(false)
    }
  }

  function openPreview(idx: number) {
    const url = previewUrls.get(idx)
    if (url) window.open(url, '_blank')
  }

  // ── Upload to AWB Log ──
  async function handleUploadToAwbLog() {
    if (!window.confirm('¿Aprobar y subir las AWBs modificadas al AWB Log? Esto reemplazará los archivos actuales.')) return
    setUploading(true)
    try {
      for (let i = 0; i < awbPages.length; i++) {
        const page = awbPages[i] as AwbPage & { _bookingId?: string; _awbIndex?: number }
        if (!page.awb_number || page.pallets.length === 0) continue

        // Generate final PDF with pallets written
        let modified: ArrayBuffer
        if (isAutoMode && fullPdfMap.has(i)) {
          modified = await writePalletsOnFullAwb(fullPdfMap.get(i)!, page.pallets, page.palletPos)
        } else {
          modified = await writePalletsOnAwb(page.pdfPageBytes, page.pallets, page.palletPos)
        }

        // Upload to Storage
        const { url, storagePath } = await uploadModifiedAwb(modified, page.awb_number)

        // Auto mode: direct reference to booking + awb index
        if (isAutoMode && page._bookingId && page._awbIndex !== undefined) {
          const bSnap = await getDoc(doc(db, 'airfreight_bookings', page._bookingId))
          if (!bSnap.exists()) continue
          const booking = bSnap.data() as AirfreightBooking
          if (!booking.awb_lines) continue

          const updatedLines = [...booking.awb_lines]
          const lineToUpdate = { ...updatedLines[page._awbIndex] }
          const docs = { ...(lineToUpdate.documents || {}) }
          docs.doc_hawb = {
            url,
            filename: `AWB_${page.awb_number}_cut.pdf`,
            version: ((docs.doc_hawb as any)?.version || 0) + 1,
            uploaded_at: new Date().toISOString(),
            uploaded_by: 'awb-cut-module',
            modified_seen: false,
            history: [
              ...((docs.doc_hawb as any)?.history || []),
              ...(docs.doc_hawb ? [{
                url: (docs.doc_hawb as any).url,
                filename: (docs.doc_hawb as any).filename,
                version: (docs.doc_hawb as any).version || 1,
                uploaded_at: (docs.doc_hawb as any).uploaded_at,
                uploaded_by: (docs.doc_hawb as any).uploaded_by,
              }] : []),
            ],
          }
          lineToUpdate.documents = docs as any
          updatedLines[page._awbIndex] = lineToUpdate
          await updateDoc(doc(db, 'airfreight_bookings', page._bookingId), { awb_lines: sanitizeLines(updatedLines) })
          continue
        }

        // Manual mode: search by AWB number
        const awbNormalized = page.awb_number.replace(/[^0-9]/g, '')
        const bQuery = query(collection(db, 'airfreight_bookings'), where('booking_type', '==', 'ecommerce'))
        const bSnap = await getDocs(bQuery)

        let found = false
        for (const bDoc of bSnap.docs) {
          const booking = bDoc.data() as AirfreightBooking
          if (!booking.awb_lines) continue
          for (let li = 0; li < booking.awb_lines.length; li++) {
            const line = booking.awb_lines[li]
            const lineAwb = (line.awb_2nd_leg || line.awb_number || '').replace(/[^0-9]/g, '')
            if (lineAwb === awbNormalized) {
              const updatedLines = [...booking.awb_lines]
              const lineToUpdate = { ...updatedLines[li] }
              const docs = { ...(lineToUpdate.documents || {}) }
              docs.doc_hawb = {
                url,
                filename: `AWB_${page.awb_number}_cut.pdf`,
                version: ((docs.doc_hawb as any)?.version || 0) + 1,
                uploaded_at: new Date().toISOString(),
                uploaded_by: 'awb-cut-module',
                modified_seen: false,
                history: [
                  ...((docs.doc_hawb as any)?.history || []),
                  ...(docs.doc_hawb ? [{
                    url: (docs.doc_hawb as any).url,
                    filename: (docs.doc_hawb as any).filename,
                    version: (docs.doc_hawb as any).version || 1,
                    uploaded_at: (docs.doc_hawb as any).uploaded_at,
                    uploaded_by: (docs.doc_hawb as any).uploaded_by,
                  }] : []),
                ],
              }
              lineToUpdate.documents = docs as any
              updatedLines[li] = lineToUpdate
              await updateDoc(doc(db, 'airfreight_bookings', bDoc.id), { awb_lines: sanitizeLines(updatedLines) })
              found = true
              break
            }
          }
          if (found) break
        }

        if (!found) {
          console.warn(`No se encontró booking para AWB ${page.awb_number}`)
        }
      }
      setUploadDone(true)
      alert('AWBs subidas exitosamente al AWB Log')
    } catch (err) {
      console.error('Upload error:', err)
      alert('Error subiendo al AWB Log: ' + (err as Error).message)
    } finally {
      setUploading(false)
    }
  }

  // ── Restart ──
  function handleRestart() {
    setStep(isAutoMode ? 'select' : 'distribution')
    setDistData(null)
    setDistError('')
    setAwbPages([])
    setAwbsError('')
    setSelectedAwbIdx(0)
    setPreviewUrls(new Map())
    setUploadDone(false)
    setFullPdfMap(new Map())
    setProcessStatus('')
    setProcessError('')
    if (isAutoMode) loadFlightData()
  }

  // ── Step indicators ──
  const autoSteps: Step[] = ['select', 'processing', 'edit', 'preview']
  const autoLabels = ['1. Selección', '2. Procesando', '3. Editar', '4. Preview']
  const manualSteps: Step[] = ['distribution', 'awbs', 'edit', 'preview']
  const manualLabels = ['1. Distribución', '2. AWBs', '3. Editar', '4. Preview']

  const steps = isAutoMode ? autoSteps : manualSteps
  const labels = isAutoMode ? autoLabels : manualLabels

  return (
    <Layout title="Corte de AWB" backTo={isAutoMode ? '/airfreight/awb-log' : '/airfreight/admin'}>
      <div className="max-w-5xl mx-auto space-y-4">

        {/* Step indicator */}
        <div className="flex items-center gap-2 text-xs">
          {steps.map((s, i) => {
            const active = step === s
            const done = steps.indexOf(step) > i
            return (
              <div key={s} className="flex items-center gap-2">
                {i > 0 && <div className="w-6 h-px bg-gray-300" />}
                <span className={`px-2 py-1 rounded-full font-semibold ${active ? 'bg-mcl-blue text-white' : done ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-400'}`}>
                  {labels[i]}
                </span>
              </div>
            )
          })}
        </div>

        {/* ══════ AUTO MODE: Select AWBs ══════ */}
        {isAutoMode && step === 'select' && (
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Paso 1 — Selección de AWBs</span>
            </div>

            {flightLoading ? (
              <div className="flex items-center gap-2 py-4">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-mcl-blue" />
                <span className="text-xs text-gray-500">Cargando vuelo...</span>
              </div>
            ) : flightError ? (
              <p className="text-xs text-red-500">{flightError}</p>
            ) : (
              <>
                {/* Flight info */}
                {flightInfo && (
                  <div className="flex items-center gap-3 mb-4 text-xs">
                    <span className="font-bold text-slate-700">{flightInfo.airline} {flightInfo.flightNumber ? `#${flightInfo.flightNumber}` : ''}</span>
                    <span className="text-slate-500">{flightInfo.etd ? new Date(flightInfo.etd).toLocaleString() : ''}</span>
                    <div className="flex gap-1">
                      {flightInfo.destinations.map(d => (
                        <span key={d} className="text-[10px] font-mono font-semibold bg-mcl-blue/10 text-mcl-blue px-1 py-0.5 rounded">{d}</span>
                      ))}
                    </div>
                  </div>
                )}

                {/* AWB list with checkboxes */}
                <div className="mb-3">
                  <label className="flex items-center gap-2 text-xs font-semibold text-gray-600 mb-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={flightAwbs.filter(a => a.hasHawb).length > 0 && flightAwbs.filter(a => a.hasHawb).every(a => a.selected)}
                      onChange={toggleAllAwbs}
                      className="w-3.5 h-3.5 accent-mcl-blue"
                    />
                    Seleccionar todas
                  </label>
                </div>

                <div className="space-y-1 mb-4">
                  {flightAwbs.map((awb, idx) => (
                    <label
                      key={`${awb.bookingId}-${awb.awbIndex}`}
                      className={`flex items-center gap-3 px-3 py-2 rounded-lg border text-xs cursor-pointer transition-colors ${
                        !awb.hasHawb
                          ? 'border-gray-100 bg-gray-50 opacity-50 cursor-not-allowed'
                          : awb.selected
                            ? 'border-mcl-blue/30 bg-mcl-blue/5'
                            : 'border-gray-200 hover:bg-gray-50'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={awb.selected}
                        onChange={() => toggleAwbSelection(idx)}
                        disabled={!awb.hasHawb}
                        className="w-3.5 h-3.5 accent-mcl-blue"
                      />
                      <span className="font-mono font-bold">{awb.awbNumber || `AWB ${idx + 1}`}</span>
                      {awb.awb1stLeg && awb.awb1stLeg !== awb.awbNumber && (
                        <span className="text-gray-400 font-mono">(1st: {awb.awb1stLeg})</span>
                      )}
                      <span className="text-gray-400">{awb.pieces} pzas · {awb.chargeableWeight} CHW</span>
                      {!awb.hasHawb && (
                        <span className="text-amber-500 text-[10px] font-semibold">Sin guía cargada</span>
                      )}
                      {awb.hasHawb && (
                        <span className="w-2 h-2 rounded-full bg-green-500" title="Guía cargada" />
                      )}
                    </label>
                  ))}
                </div>

                {flightAwbs.filter(a => a.selected).length === 0 ? (
                  <p className="text-xs text-amber-600">Selecciona al menos una AWB para continuar</p>
                ) : (
                  <button
                    onClick={handleAutoProcess}
                    className="px-6 py-2 bg-mcl-blue text-white text-xs font-semibold rounded-lg hover:bg-mcl-blue/90"
                  >
                    Continuar ({flightAwbs.filter(a => a.selected).length} AWB{flightAwbs.filter(a => a.selected).length !== 1 ? 's' : ''})
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {/* ══════ AUTO MODE: Processing ══════ */}
        {isAutoMode && step === 'processing' && (
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Paso 2 — Procesamiento</span>
            </div>

            {processError ? (
              <div>
                <p className="text-xs text-red-500 mb-3">{processError}</p>
                <button onClick={() => setStep('select')} className="px-4 py-2 border border-gray-300 text-gray-700 text-xs font-semibold rounded-lg hover:bg-gray-50">
                  Volver a selección
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-3 py-4">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-mcl-blue" />
                <span className="text-xs text-gray-600">{processStatus || 'Procesando...'}</span>
              </div>
            )}
          </div>
        )}

        {/* ══════ MANUAL MODE: Step 1 Distribution ══════ */}
        {!isAutoMode && (
          <div className={`bg-white rounded-xl border border-gray-200 p-4 ${step !== 'distribution' && distData ? 'opacity-70' : ''}`}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Paso 1 — Distribución</span>
              {distData && step !== 'distribution' && (
                <span className="text-[10px] text-emerald-600 font-semibold">Procesado</span>
              )}
            </div>

            {!distData ? (
              <div>
                <label className="inline-flex items-center gap-2 px-4 py-2 bg-mcl-blue text-white text-xs font-semibold rounded-lg cursor-pointer hover:bg-mcl-blue/90">
                  <input ref={distInputRef} type="file" accept=".pdf" onChange={handleDistUpload} className="hidden" />
                  {distLoading ? 'Procesando...' : 'Subir PDF Distribución'}
                </label>
                {distError && <p className="text-xs text-red-500 mt-2">{distError}</p>}
              </div>
            ) : (
              <div>
                <div className="text-xs text-gray-500 mb-2">
                  {distData.carrier} — Vuelo {distData.flight} — {distData.destination} — {distData.date}
                </div>
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-gray-50 text-[10px] text-gray-500 uppercase">
                      <th className="px-2 py-1.5 text-left">AWB</th>
                      <th className="px-2 py-1.5 text-left">Pallet No.</th>
                      <th className="px-2 py-1.5 text-right">Pieces</th>
                    </tr>
                  </thead>
                  <tbody>
                    {distData.entries.flatMap(entry =>
                      entry.pallets.map((p, pi) => (
                        <tr key={`${entry.awb}-${pi}`} className="border-t border-gray-100">
                          {pi === 0 && (
                            <td className="px-2 py-1 font-mono font-bold" rowSpan={entry.pallets.length}>{entry.awb}</td>
                          )}
                          <td className="px-2 py-1 font-mono">{p.pallet_no}</td>
                          <td className="px-2 py-1 text-right">{p.pieces}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ══════ MANUAL MODE: Step 2 Upload AWBs ══════ */}
        {!isAutoMode && (step === 'awbs' || step === 'edit' || step === 'preview') && (
          <div className={`bg-white rounded-xl border border-gray-200 p-4 ${step !== 'awbs' ? 'opacity-70' : ''}`}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Paso 2 — Subir AWBs</span>
              {awbPages.length > 0 && step !== 'awbs' && (
                <span className="text-[10px] text-emerald-600 font-semibold">{awbPages.length} AWB{awbPages.length !== 1 ? 's' : ''} identificada{awbPages.length !== 1 ? 's' : ''}</span>
              )}
            </div>

            {awbPages.length === 0 ? (
              <div>
                <label className="inline-flex items-center gap-2 px-4 py-2 bg-mcl-blue text-white text-xs font-semibold rounded-lg cursor-pointer hover:bg-mcl-blue/90">
                  <input ref={awbInputRef} type="file" accept=".pdf" onChange={handleAwbUpload} className="hidden" />
                  {awbsLoading ? 'Identificando AWBs...' : 'Subir PDF(s) de AWBs'}
                </label>
                {awbsError && <p className="text-xs text-red-500 mt-2">{awbsError}</p>}
              </div>
            ) : (
              <div className="space-y-1">
                {awbPages.map((p, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className={`w-4 h-4 rounded-full flex items-center justify-center text-white text-[9px] ${p.matched ? 'bg-emerald-500' : p.pallets.length > 0 ? 'bg-amber-500' : 'bg-gray-400'}`}>
                      {p.matched ? '\u2713' : '!'}
                    </span>
                    <span className="font-mono font-bold">{p.awb_number || `Página ${i + 1} (no identificada)`}</span>
                    <span className="text-gray-400">— {p.pallets.length} pallet{p.pallets.length !== 1 ? 's' : ''}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ══════ SHARED: Distribution result (auto mode, shown after processing) ══════ */}
        {isAutoMode && distData && (step === 'edit' || step === 'preview') && (
          <div className="bg-white rounded-xl border border-gray-200 p-4 opacity-70">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Distribución</span>
              <span className="text-[10px] text-emerald-600 font-semibold">Procesado</span>
            </div>
            <div className="text-xs text-gray-500 mb-2">
              {distData.carrier} — Vuelo {distData.flight} — {distData.destination} — {distData.date} — {distData.entries.length} AWBs
            </div>
            {processStatus && <p className="text-xs text-amber-600">{processStatus}</p>}
          </div>
        )}

        {/* ══════ SHARED: Step Edit Pallets ══════ */}
        {(step === 'edit' || step === 'preview') && awbPages.length > 0 && (
          <div className={`bg-white rounded-xl border border-gray-200 p-4 ${step !== 'edit' ? 'opacity-70' : ''}`}>
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                {isAutoMode ? 'Paso 3' : 'Paso 3'} — Editar Pallets
              </span>
            </div>

            {/* AWB selector */}
            <div className="flex items-center gap-2 mb-3">
              <label className="text-xs text-gray-500">AWB:</label>
              <select
                value={selectedAwbIdx}
                onChange={e => setSelectedAwbIdx(Number(e.target.value))}
                className="border border-gray-200 rounded-lg px-2 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
              >
                {awbPages.map((p, i) => (
                  <option key={i} value={i}>{p.awb_number || `Página ${i + 1}`}</option>
                ))}
              </select>
              {currentPage && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${currentPage.matched ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                  {currentPage.matched ? 'Match' : 'Sin match'}
                </span>
              )}
            </div>

            {currentPage && (
              <div className="grid grid-cols-2 gap-4">
                {/* Pallet list */}
                <div>
                  <table className="w-full text-xs border-collapse mb-2">
                    <thead>
                      <tr className="bg-gray-50 text-[10px] text-gray-500 uppercase">
                        <th className="px-2 py-1 text-left">Pallet No.</th>
                        <th className="px-2 py-1 text-right">Pieces</th>
                        <th className="px-2 py-1 w-6"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {currentPage.pallets.map((p, pi) => (
                        <tr key={pi} className="border-t border-gray-100">
                          <td className="px-1 py-1">
                            <input
                              value={p.pallet_no}
                              onChange={e => updatePallet(pi, 'pallet_no', e.target.value)}
                              className="w-full border border-gray-200 rounded px-1.5 py-0.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                            />
                          </td>
                          <td className="px-1 py-1">
                            <input
                              type="number"
                              value={p.pieces}
                              onChange={e => updatePallet(pi, 'pieces', Number(e.target.value))}
                              className="w-full border border-gray-200 rounded px-1.5 py-0.5 text-xs text-right focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                            />
                          </td>
                          <td className="px-1 py-1 text-center">
                            <button onClick={() => removePallet(pi)} className="text-red-400 hover:text-red-600">&times;</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <button onClick={addPallet} className="text-[10px] text-mcl-blue font-semibold hover:underline">+ Agregar pallet</button>
                </div>

                {/* AWB preview — click to position pallets */}
                <div className="border border-gray-200 rounded-lg overflow-hidden bg-gray-50 relative">
                  <div
                    className="relative cursor-crosshair"
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect()
                      const xPct = (e.clientX - rect.left) / rect.width
                      const yPct = (e.clientY - rect.top) / rect.height
                      setAwbPages(prev => {
                        const next = [...prev]
                        next[selectedAwbIdx] = { ...next[selectedAwbIdx], palletPos: { xPct, yPct } }
                        return next
                      })
                    }}
                  >
                    <img src={currentPage.imageDataUrl} alt="AWB preview" className="w-full h-auto select-none" draggable={false} />
                    {/* Pallet overlay preview */}
                    {currentPage.palletPos && currentPage.pallets.length > 0 && (
                      <div
                        className="absolute pointer-events-none"
                        style={{
                          left: `${currentPage.palletPos.xPct * 100}%`,
                          top: `${currentPage.palletPos.yPct * 100}%`,
                        }}
                      >
                        {currentPage.pallets.map((p, pi) => (
                          <div key={pi} className="text-[8px] font-mono leading-tight text-red-600 whitespace-nowrap">
                            {p.pallet_no} ({p.pieces})
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <p className="text-[9px] text-gray-400 text-center py-1">
                    {currentPage.palletPos ? 'Click en otra posición para reposicionar' : 'Click en la imagen para posicionar los pallets'}
                  </p>
                </div>
              </div>
            )}

            {step === 'edit' && (() => {
              const missingPos = awbPages.filter(p => p.pallets.length > 0 && !p.palletPos)
              return (
                <div className="mt-3 flex items-center gap-3">
                  <button
                    onClick={handleGeneratePreview}
                    disabled={previewLoading || missingPos.length > 0}
                    className="px-4 py-2 bg-mcl-blue text-white text-xs font-semibold rounded-lg hover:bg-mcl-blue/90 disabled:opacity-50"
                  >
                    {previewLoading ? 'Generando...' : 'Generar Preview'}
                  </button>
                  {missingPos.length > 0 && (
                    <span className="text-[10px] text-amber-600">
                      Falta posicionar pallets en: {missingPos.map(p => p.awb_number || `Pág ${p.pageIndex + 1}`).join(', ')}
                    </span>
                  )}
                </div>
              )
            })()}
          </div>
        )}

        {/* ══════ SHARED: Step Preview + Upload ══════ */}
        {step === 'preview' && (
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                {isAutoMode ? 'Paso 4' : 'Paso 4'} — Preview y Aprobación
              </span>
            </div>

            <div className="space-y-1 mb-4">
              {awbPages.map((p, i) => (
                <div key={i} className="flex items-center gap-3 text-xs">
                  <span className="font-mono font-bold">{p.awb_number || `Página ${i + 1}`}</span>
                  <span className="text-gray-400">{p.pallets.length} pallet{p.pallets.length !== 1 ? 's' : ''}</span>
                  {previewUrls.has(i) && (
                    <button onClick={() => openPreview(i)} className="text-mcl-blue hover:underline font-semibold">Ver PDF</button>
                  )}
                  {p.pallets.length === 0 && (
                    <span className="text-amber-500 text-[10px]">Sin pallets — no se modificará</span>
                  )}
                  {isAutoMode && (
                    <span className="text-[10px] text-gray-400">(5 copias)</span>
                  )}
                </div>
              ))}
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setStep('edit')}
                className="px-4 py-2 border border-gray-300 text-gray-700 text-xs font-semibold rounded-lg hover:bg-gray-50"
              >
                Volver a editar
              </button>
              <button
                onClick={handleUploadToAwbLog}
                disabled={uploading || uploadDone}
                className="px-6 py-2 bg-emerald-600 text-white text-xs font-semibold rounded-lg hover:bg-emerald-700 disabled:opacity-50"
              >
                {uploading ? 'Subiendo...' : uploadDone ? 'Subido' : 'Aprobar y subir al AWB Log'}
              </button>
              {uploadDone && (
                <button onClick={handleRestart} className="px-4 py-2 text-mcl-blue text-xs font-semibold hover:underline">
                  Nuevo corte
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </Layout>
  )
}
