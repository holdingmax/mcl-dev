import { useState, useEffect, useRef, useCallback } from 'react'
import { MultiFormatReader, BarcodeFormat, DecodeHintType, HTMLCanvasElementLuminanceSource, BinaryBitmap, HybridBinarizer } from '@zxing/library'

// ── Types ────────────────────────────────────────────────────────────────────

interface PieceRef {
  id: string
  barcode: string
  awb_number: string
  warehouse_number: string
  piece_number: number
  weight_kg: number
  uld_id?: string | null
}

interface ScanLogEntry {
  id: number
  barcode: string
  type: 'ok' | 'moved' | 'duplicate' | 'notfound'
  msg: string
  detail: string
  ts: number
}

interface Props {
  open: boolean
  onClose: () => void
  allPieces: PieceRef[]
  targetUldId: string
  targetUldNumber: string
  onPieceAssigned: (pieceId: string, sourceUldId?: string) => void
  uldLookup?: Map<string, string>
}

// ── Audio feedback ──────────────────────────────────────────────────────────

let audioCtx: AudioContext | null = null
function getAudioCtx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext()
  return audioCtx
}
function beepOk() {
  try { const ctx = getAudioCtx(); const o = ctx.createOscillator(); const g = ctx.createGain(); o.connect(g); g.connect(ctx.destination); o.frequency.value = 800; g.gain.value = 0.3; o.start(); o.stop(ctx.currentTime + 0.1) } catch {}
}
function beepDuplicate() {
  try { const ctx = getAudioCtx(); const o = ctx.createOscillator(); const g = ctx.createGain(); o.connect(g); g.connect(ctx.destination); o.frequency.value = 500; g.gain.value = 0.25; o.start(); o.stop(ctx.currentTime + 0.08); setTimeout(() => { const o2 = ctx.createOscillator(); const g2 = ctx.createGain(); o2.connect(g2); g2.connect(ctx.destination); o2.frequency.value = 500; g2.gain.value = 0.25; o2.start(); o2.stop(ctx.currentTime + 0.08) }, 120) } catch {}
}
function beepError() {
  try { const ctx = getAudioCtx(); const o = ctx.createOscillator(); const g = ctx.createGain(); o.connect(g); g.connect(ctx.destination); o.frequency.value = 300; g.gain.value = 0.3; o.start(); o.stop(ctx.currentTime + 0.3) } catch {}
}

// ── Component ────────────────────────────────────────────────────────────────

export default function BarcodeContinuousScanner({
  open, onClose, allPieces, targetUldId, targetUldNumber, onPieceAssigned, uldLookup,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const cooldownRef = useRef<Map<string, number>>(new Map())
  const logIdRef = useRef(0)

  const [cameraError, setCameraError] = useState('')
  const [cameraReady, setCameraReady] = useState(false)
  const [scanLog, setScanLog] = useState<ScanLogEntry[]>([])
  const [scanCount, setScanCount] = useState(0)
  const [flashColor, setFlashColor] = useState<string | null>(null)

  // Stable refs for callbacks
  const allPiecesRef = useRef(allPieces)
  allPiecesRef.current = allPieces
  const targetUldIdRef = useRef(targetUldId)
  targetUldIdRef.current = targetUldId
  const onPieceAssignedRef = useRef(onPieceAssigned)
  onPieceAssignedRef.current = onPieceAssigned
  const uldLookupRef = useRef(uldLookup)
  uldLookupRef.current = uldLookup

  const addLog = useCallback((entry: Omit<ScanLogEntry, 'id' | 'ts'>) => {
    setScanLog(prev => [{ ...entry, id: ++logIdRef.current, ts: Date.now() }, ...prev].slice(0, 50))
  }, [])

  const flash = useCallback((color: string) => {
    setFlashColor(color)
    setTimeout(() => setFlashColor(null), 300)
  }, [])

  // Handle a detected barcode
  const handleDetection = useCallback((barcode: string) => {
    const now = Date.now()
    const lastSeen = cooldownRef.current.get(barcode) || 0
    if (now - lastSeen < 2000) return
    cooldownRef.current.set(barcode, now)

    const piece = allPiecesRef.current.find(p => p.barcode === barcode)
    if (!piece) {
      beepError(); flash('#ef4444')
      addLog({ barcode, type: 'notfound', msg: 'No encontrada', detail: `Barcode ${barcode} no existe en este vuelo` })
      try { navigator.vibrate?.([50, 50, 50]) } catch {}
      return
    }
    if (piece.uld_id === targetUldIdRef.current) {
      beepDuplicate(); flash('#f59e0b')
      addLog({ barcode, type: 'duplicate', msg: 'Ya asignada', detail: `${piece.awb_number} #${piece.piece_number} ya esta en este ULD` })
      return
    }

    const sourceUldId = piece.uld_id || undefined
    const sourceUldNum = sourceUldId && uldLookupRef.current ? uldLookupRef.current.get(sourceUldId) : undefined
    try {
      onPieceAssignedRef.current(piece.id, sourceUldId || undefined)
      beepOk(); flash('#22c55e')
      try { navigator.vibrate?.(100) } catch {}
      setScanCount(c => c + 1)
      if (sourceUldId) {
        addLog({ barcode, type: 'moved', msg: `Movida desde ${sourceUldNum || 'otro ULD'}`, detail: `${piece.awb_number} #${piece.piece_number} | ${piece.weight_kg} kg` })
      } else {
        addLog({ barcode, type: 'ok', msg: 'Asignada', detail: `${piece.awb_number} #${piece.piece_number} | ${piece.weight_kg} kg` })
      }
    } catch (err: any) {
      beepError(); flash('#ef4444')
      addLog({ barcode, type: 'notfound', msg: 'Error', detail: err.message || 'Error al asignar' })
    }
  }, [addLog, flash])

  // Camera init — same proven pattern as BarcodeScannerModal (seafreight)
  useEffect(() => {
    if (!open) return

    setCameraError('')
    setCameraReady(false)
    setScanLog([])
    setScanCount(0)
    cooldownRef.current.clear()

    let cancelled = false

    async function initCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream

        // Recursive attach — same pattern as working seafreight scanner
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
      } catch (e: any) {
        console.error('Camera error:', e)
        if (!cancelled) {
          setCameraError(
            e.name === 'NotAllowedError' ? 'Permiso de camara denegado. Habilita el acceso en configuracion del navegador.'
            : e.name === 'NotFoundError' ? 'No se encontro camara disponible.'
            : e.name === 'NotReadableError' ? 'La camara esta en uso por otra aplicacion.'
            : 'No se pudo acceder a la camara. Verifica permisos.'
          )
        }
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
  }, [open]) // ONLY depends on open — no callbacks

  // Continuous ZXing decode loop — captures frames from video, decodes independently
  useEffect(() => {
    if (!cameraReady) return

    const hints = new Map()
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.EAN_13, BarcodeFormat.CODE_39])
    hints.set(DecodeHintType.TRY_HARDER, true)
    const reader = new MultiFormatReader()
    reader.setHints(hints)

    let active = true
    const intervalId = setInterval(() => {
      if (!active || !videoRef.current || !canvasRef.current) return
      const video = videoRef.current
      if (video.readyState < 2 || video.videoWidth === 0) return

      const canvas = canvasRef.current
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(video, 0, 0)

      try {
        const luminance = new HTMLCanvasElementLuminanceSource(canvas)
        const bitmap = new BinaryBitmap(new HybridBinarizer(luminance))
        const result = reader.decode(bitmap)
        if (result) {
          handleDetection(result.getText())
        }
      } catch {
        // No barcode found in this frame — normal, keep scanning
      }
    }, 150)

    return () => {
      active = false
      clearInterval(intervalId)
    }
  }, [cameraReady, handleDetection])

  if (!open) return null

  const logColors: Record<string, string> = { ok: 'text-green-400', moved: 'text-blue-400', duplicate: 'text-amber-400', notfound: 'text-red-400' }
  const logIcons: Record<string, string> = { ok: '\u2713', moved: '\u21C4', duplicate: '\u25CF', notfound: '\u2717' }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-black/90 shrink-0 z-10">
        <div className="flex items-center gap-3">
          <span className="text-white text-sm font-bold">ULD: {targetUldNumber}</span>
          <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-green-500 text-white">
            {scanCount} escaneadas
          </span>
        </div>
        <button type="button" onClick={onClose} className="text-white/70 hover:text-white p-1">
          <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Camera area */}
      <div className="relative" style={{ height: '60vh' }}>
        <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover" playsInline muted autoPlay />
        <canvas ref={canvasRef} className="hidden" />

        {flashColor && (
          <div className="absolute inset-0 pointer-events-none transition-opacity duration-300"
            style={{ backgroundColor: flashColor, opacity: 0.35 }} />
        )}

        {cameraReady && !cameraError && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="border-2 border-green-400/70 rounded-lg" style={{ width: '80%', height: '30%' }}>
              <div className="absolute left-0 right-0 -bottom-5 text-center">
                <span className="text-white/50 text-[10px]">Apunta al barcode de la etiqueta</span>
              </div>
            </div>
          </div>
        )}

        {!cameraReady && !cameraError && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-400" />
          </div>
        )}

        {cameraError && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900/90 px-6">
            <div className="text-center">
              <svg className="w-12 h-12 text-red-400 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              <p className="text-white text-sm mb-4">{cameraError}</p>
              <button onClick={onClose} className="px-4 py-2 bg-white/20 text-white text-sm rounded-lg hover:bg-white/30">Cerrar</button>
            </div>
          </div>
        )}
      </div>

      {/* Scan log */}
      <div className="flex-1 bg-gray-950 overflow-y-auto px-3 py-2">
        {scanLog.length === 0 && !cameraError && (
          <p className="text-gray-600 text-xs text-center py-4">Esperando escaneos...</p>
        )}
        {scanLog.map(entry => (
          <div key={entry.id} className={`flex items-start gap-2 py-1.5 border-b border-gray-800/50 ${logColors[entry.type]}`}>
            <span className="text-sm font-bold w-4 shrink-0">{logIcons[entry.type]}</span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono font-bold truncate">{entry.barcode}</span>
                <span className="text-[10px] opacity-70">{entry.msg}</span>
              </div>
              <p className="text-[10px] opacity-50 truncate">{entry.detail}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
