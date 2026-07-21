import { useState, useEffect, useRef } from 'react'
import Tesseract from 'tesseract.js'

export interface ScanResult {
  barcode: string
  pieces: number
  weight: number
}

interface BarcodeScannerModalProps {
  open: boolean
  onScan: (result: ScanResult) => void
  onClose: () => void
  scannedCodes: string[]
  expectedTotal?: number
}

function parseLabelText(text: string): ScanResult | null {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const fullText = lines.join(' ')

  let barcode = ''
  for (const line of lines) {
    const match = line.match(/^([A-Z0-9]{10,})$/i)
    if (match) { barcode = match[1]; break }
  }
  if (!barcode) {
    const match = fullText.match(/\b([A-Z]{2,}[A-Z0-9]{8,})\b/i)
    if (match) barcode = match[1]
  }

  let pieces = 0
  const pcsMatch = fullText.match(/Total[:\s]*(\d+)/i)
  if (pcsMatch) pieces = parseInt(pcsMatch[1], 10)

  let weight = 0
  const kgMatch = fullText.match(/(\d+[.,]\d+)\s*kg/i)
  if (kgMatch) weight = parseFloat(kgMatch[1].replace(',', '.'))
  if (!kgMatch) {
    const kgMatch2 = fullText.match(/(\d+)\s*kg/i)
    if (kgMatch2) weight = parseFloat(kgMatch2[1])
  }

  if (!barcode && !pieces && !weight) return null
  return { barcode, pieces, weight }
}

export default function BarcodeScannerModal({ open, onScan, onClose, scannedCodes, expectedTotal }: BarcodeScannerModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [error, setError] = useState('')
  const [processing, setProcessing] = useState(false)
  const [lastResult, setLastResult] = useState<ScanResult | null>(null)
  const [rawText, setRawText] = useState('')
  const [scanCount, setScanCount] = useState(0)
  const [showManual, setShowManual] = useState(false)
  const [manualBarcode, setManualBarcode] = useState('')
  const [manualPieces, setManualPieces] = useState('')
  const [manualWeight, setManualWeight] = useState('')
  const [cameraReady, setCameraReady] = useState(false)

  // Start camera when modal opens
  useEffect(() => {
    if (!open) return
    setError('')
    setCameraReady(false)
    setScanCount(0)
    setLastResult(null)
    setRawText('')
    setShowManual(false)

    let cancelled = false

    async function initCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
        })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream
        // Wait for video element to be in DOM
        const tryAttach = () => {
          if (videoRef.current) {
            videoRef.current.srcObject = stream
            videoRef.current.play().catch(() => {})
            setCameraReady(true)
          } else if (!cancelled) {
            setTimeout(tryAttach, 50)
          }
        }
        tryAttach()
      } catch (e) {
        console.error('Camera error:', e)
        if (!cancelled) setError('No se pudo acceder a la cámara. Verifica permisos.')
      }
    }

    initCamera()

    return () => {
      cancelled = true
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop())
        streamRef.current = null
      }
    }
  }, [open])

  async function captureAndRead() {
    if (!videoRef.current || !canvasRef.current) return
    setProcessing(true)
    setRawText('')
    setLastResult(null)

    const video = videoRef.current
    const canvas = canvasRef.current
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(video, 0, 0)

    try {
      const { data: { text } } = await Tesseract.recognize(canvas, 'eng', { logger: () => {} })
      setRawText(text)
      const result = parseLabelText(text)
      if (result) setLastResult(result)
    } catch (err) {
      console.error('OCR error:', err)
      setRawText('Error al leer la etiqueta')
    } finally {
      setProcessing(false)
    }
  }

  function confirmResult() {
    if (!lastResult) return
    onScan(lastResult)
    setScanCount(c => c + 1)
    setLastResult(null)
    setRawText('')
  }

  function handleManualSubmit() {
    const barcode = manualBarcode.trim()
    if (!barcode) return
    onScan({ barcode, pieces: parseInt(manualPieces, 10) || 0, weight: parseFloat(manualWeight) || 0 })
    setScanCount(c => c + 1)
    setManualBarcode('')
    setManualPieces('')
    setManualWeight('')
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-black/80 shrink-0">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-white text-sm">Escanear etiquetas</h3>
          {(() => {
            const total = scannedCodes.length + scanCount
            const allDone = expectedTotal ? total >= expectedTotal : false
            return total > 0 || expectedTotal ? (
              <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${allDone ? 'bg-green-500 text-white' : 'bg-yellow-400 text-gray-800'}`}>
                {expectedTotal ? `${total}/${expectedTotal}` : total}
              </span>
            ) : null
          })()}
        </div>
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => setShowManual(!showManual)}
            className="text-xs text-blue-300 hover:text-white">
            {showManual ? 'Cámara' : 'Manual'}
          </button>
          <button type="button" onClick={onClose} className="text-white/70 hover:text-white">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {!showManual ? (
        <>
          {/* Camera — fills all available space */}
          <div className="flex-1 relative">
            <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover" playsInline muted autoPlay />
            <canvas ref={canvasRef} className="hidden" />

            {error && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-900/80">
                <p className="text-white text-sm text-center px-4">{error}</p>
              </div>
            )}

            {/* Vertical guide rectangle — matches label shape */}
            {cameraReady && !error && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="border-2 border-green-400/80 rounded-xl" style={{ width: '65%', height: '80%' }}>
                  <p className="absolute -bottom-6 left-0 right-0 text-center text-white/60 text-xs">
                    Centra la etiqueta dentro del recuadro
                  </p>
                </div>
              </div>
            )}

            {/* Capture button */}
            {!error && !lastResult && (
              <div className="absolute bottom-6 left-0 right-0 flex justify-center">
                <button type="button" onClick={captureAndRead} disabled={processing}
                  className="w-18 h-18 rounded-full bg-white/90 shadow-lg flex items-center justify-center disabled:opacity-50"
                  style={{ width: 72, height: 72 }}>
                  {processing ? (
                    <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-blue-600" />
                  ) : (
                    <div className="rounded-full border-4 border-blue-600" style={{ width: 52, height: 52 }} />
                  )}
                </button>
              </div>
            )}
          </div>

          {/* Result panel — slides up from bottom */}
          {lastResult && (
            <div className="px-4 py-3 bg-green-50 shrink-0">
              <div className="grid grid-cols-3 gap-2 mb-2">
                <div>
                  <label className="text-[10px] text-gray-400 uppercase">Código</label>
                  <p className="text-sm font-mono font-bold text-gray-800 truncate">{lastResult.barcode || '—'}</p>
                </div>
                <div>
                  <label className="text-[10px] text-gray-400 uppercase">SLACS</label>
                  <p className="text-sm font-bold text-gray-800">{lastResult.pieces || '—'}</p>
                </div>
                <div>
                  <label className="text-[10px] text-gray-400 uppercase">Peso (kg)</label>
                  <p className="text-sm font-bold text-gray-800">{lastResult.weight || '—'}</p>
                </div>
              </div>
              {scannedCodes.includes(lastResult.barcode) && (
                <p className="text-xs text-orange-600 font-medium mb-2">Este código ya fue escaneado</p>
              )}
              <div className="flex gap-2">
                <button type="button" onClick={confirmResult}
                  className="flex-1 py-2.5 bg-green-600 text-white text-sm font-semibold rounded-lg">
                  OK - Siguiente
                </button>
                <button type="button" onClick={() => { setLastResult(null); setRawText('') }}
                  className="px-4 py-2.5 bg-gray-200 text-gray-600 text-sm rounded-lg">
                  Reintentar
                </button>
              </div>
            </div>
          )}

          {/* OCR failed */}
          {rawText && !lastResult && !processing && (
            <div className="px-4 py-3 bg-yellow-50 shrink-0">
              <p className="text-xs text-yellow-700 font-medium mb-1">No se detecto. Reintenta o usa modo manual.</p>
              <pre className="text-[10px] text-gray-500 whitespace-pre-wrap max-h-16 overflow-y-auto">{rawText}</pre>
            </div>
          )}

          {processing && (
            <div className="px-4 py-3 bg-blue-50 shrink-0 flex items-center gap-2">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600" />
              <p className="text-xs text-blue-700">Leyendo etiqueta...</p>
            </div>
          )}
        </>
      ) : (
        <div className="px-4 py-6 space-y-3 bg-white flex-1">
          <p className="text-xs text-gray-500">Ingreso manual:</p>
          <div>
            <label className="text-[10px] text-gray-400">Código</label>
            <input type="text" value={manualBarcode} onChange={e => setManualBarcode(e.target.value)}
              placeholder="PVGC..." className="w-full border border-gray-200 rounded px-3 py-2 text-sm font-mono" autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-gray-400">SLACS</label>
              <input type="number" value={manualPieces} onChange={e => setManualPieces(e.target.value)}
                placeholder="0" className="w-full border border-gray-200 rounded px-3 py-2 text-sm text-center" />
            </div>
            <div>
              <label className="text-[10px] text-gray-400">Peso (kg)</label>
              <input type="number" step="0.001" value={manualWeight} onChange={e => setManualWeight(e.target.value)}
                placeholder="0" className="w-full border border-gray-200 rounded px-3 py-2 text-sm text-center" />
            </div>
          </div>
          <button type="button" onClick={handleManualSubmit} disabled={!manualBarcode.trim()}
            className="w-full py-2.5 bg-blue-700 text-white text-sm font-semibold rounded-lg disabled:opacity-40">
            Agregar
          </button>
        </div>
      )}
    </div>
  )
}
