import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Layout from '../../components/Layout'
import { useAuth } from '../../contexts/AuthContext'
import { db } from '../../lib/firebase'
import { collection, getDocs, query, where, doc, updateDoc } from 'firebase/firestore'
import { BrowserMultiFormatReader, DecodeHintType, BarcodeFormat, NotFoundException } from '@zxing/library'
import { WRLine, WarehouseReceipt } from '../../types'

type Step = 'scan_piece' | 'choose_location' | 'scan_rack' | 'confirm'

interface PieceInfo {
  wr: WarehouseReceipt
  line: WRLine
  pieceNum: number
  barcode: string
}

export default function WSLocatePiece() {
  const navigate = useNavigate()
  const { isAdmin, isSuperAgent, isAgent, isCounter, isBodega } = useAuth()
  const canOperate = isAdmin || isSuperAgent || isAgent || isCounter || isBodega
  const videoRef = useRef<HTMLVideoElement>(null)
  const readerRef = useRef<BrowserMultiFormatReader | null>(null)

  const [step, setStep] = useState<Step>('scan_piece')
  const [scanning, setScanning] = useState(false)
  const [pieceInfo, setPieceInfo] = useState<PieceInfo | null>(null)
  const [location, setLocation] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [successCount, setSuccessCount] = useState(0)
  const [manualRack, setManualRack] = useState('')

  useEffect(() => {
    return () => stopCamera()
  }, [])

  useEffect(() => {
    if (step === 'scan_piece' || step === 'scan_rack') {
      startCamera()
    } else {
      stopCamera()
    }
  }, [step])

  function stopCamera() {
    readerRef.current?.reset()
    readerRef.current = null
    setScanning(false)
  }

  async function startCamera() {
    setError('')
    setScanning(true)
    await new Promise(r => setTimeout(r, 100)) // wait for DOM
    const hints = new Map()
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.EAN_13, BarcodeFormat.CODE_39])
    const reader = new BrowserMultiFormatReader(hints)
    readerRef.current = reader
    try {
      await reader.decodeFromVideoDevice(undefined, videoRef.current!, (result, err) => {
        if (result) {
          const text = result.getText()
          if (step === 'scan_piece' || step === 'scan_rack') {
            reader.reset()
            readerRef.current = null
            setScanning(false)
            if (step === 'scan_piece') handlePieceBarcode(text)
            else handleRackBarcode(text)
          }
        }
        if (err && !(err instanceof NotFoundException)) {
          console.warn(err)
        }
      })
    } catch (e) {
      setError('Could not access camera. Check permissions.')
      setScanning(false)
    }
  }

  async function handlePieceBarcode(barcode: string) {
    setError('')
    // WS barcode format: WS-XXXXXX (6 digits) + piece (2 digits) + PO suffix (variable)
    // Strip "WS-" prefix if present
    let raw = barcode
    if (raw.startsWith('WS-')) {
      raw = raw.slice(3)
    } else {
      setError(`Unrecognized code: ${barcode}`)
      setStep('scan_piece')
      return
    }

    if (raw.length < 8) {
      setError(`Unrecognized code: ${barcode}`)
      setStep('scan_piece')
      return
    }

    const numericPart = raw.slice(0, 6)       // 6-digit WR number
    const pieceNum    = parseInt(raw.slice(6, 8)) // 2-digit piece number
    const wrNumber    = 'WS-' + numericPart

    try {
      const snap = await getDocs(query(
        collection(db, 'warehouse_receipts'),
        where('wr_number', '==', wrNumber)
      ))
      if (snap.empty) {
        setError(`WR ${wrNumber} not found.`)
        setStep('scan_piece')
        return
      }
      const wrDoc = snap.docs[0]
      const wr = { id: wrDoc.id, ...wrDoc.data() } as WarehouseReceipt

      // Find which line this piece belongs to
      const linesSnap = await getDocs(collection(db, 'warehouse_receipts', wrDoc.id, 'lines'))
      const lines = linesSnap.docs
        .map(d => ({ id: d.id, ...d.data() } as WRLine))
        .sort((a, b) => a.line_order - b.line_order)

      let globalPiece = 1
      let foundLine: WRLine | null = null
      for (const line of lines) {
        const qty = line.qty || 1
        if (pieceNum >= globalPiece && pieceNum < globalPiece + qty) {
          foundLine = line
          break
        }
        globalPiece += qty
      }

      if (!foundLine) {
        setError(`Piece #${pieceNum} not found in ${wrNumber}.`)
        setStep('scan_piece')
        return
      }

      setPieceInfo({ wr, line: foundLine, pieceNum, barcode })
      setLocation(foundLine.location || '')
      setStep('choose_location')
    } catch (e) {
      setError('Error searching for the piece. Try again.')
      setStep('scan_piece')
    }
  }

  function handleRackBarcode(barcode: string) {
    // Expected format: MIAEXP01A25, MIAEXP01B03, etc.
    const clean = barcode.toUpperCase().replace(/^MIAEXP/, '')
    const rackPattern = /^\d{2}[A-E]\d{2}$/
    if (!rackPattern.test(clean)) {
      setError(`Rack code not recognized: "${barcode}". Expected format: MIAEXP01A25`)
      setStep('scan_rack')
      return
    }
    setLocation(clean)
    setStep('confirm')
  }

  async function saveLocation() {
    if (!pieceInfo || !location) return
    setSaving(true)
    try {
      await updateDoc(
        doc(db, 'warehouse_receipts', pieceInfo.wr.id!, 'lines', pieceInfo.line.id!),
        { location }
      )
      setSuccessCount(c => c + 1)
      setPieceInfo(null)
      setLocation('')
      setError('')
      setStep('scan_piece')
    } catch (e) {
      setError('Error saving. Try again.')
    } finally {
      setSaving(false)
    }
  }

  if (!canOperate) {
    return <Layout title="Locate Pieces" backTo="/warehouse-services"><p className="text-center text-gray-500 mt-10">Access restricted</p></Layout>
  }

  return (
    <Layout title="Locate Pieces" backTo="/warehouse-services">
      <div className="max-w-lg mx-auto space-y-4">

        {/* Success counter */}
        {successCount > 0 && (
          <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-700 font-medium text-center">
            {successCount} piece{successCount > 1 ? 's' : ''} located this session
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* STEP: scan_piece */}
        {step === 'scan_piece' && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="bg-mcl-blue px-4 py-3">
              <p className="text-white font-semibold text-sm">Step 1 — Scan box label</p>
              <p className="text-blue-200 text-xs mt-0.5">Point the camera at the piece barcode</p>
            </div>
            <div className="relative bg-black aspect-[4/3]">
              <video ref={videoRef} className="w-full h-full object-cover" autoPlay muted playsInline />
              {/* Targeting overlay */}
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-64 h-20 border-2 border-white/70 rounded-lg relative">
                  <div className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-white rounded-tl" />
                  <div className="absolute top-0 right-0 w-4 h-4 border-t-2 border-r-2 border-white rounded-tr" />
                  <div className="absolute bottom-0 left-0 w-4 h-4 border-b-2 border-l-2 border-white rounded-bl" />
                  <div className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-white rounded-br" />
                </div>
              </div>
              {scanning && (
                <div className="absolute bottom-3 left-0 right-0 flex justify-center">
                  <span className="bg-black/50 text-white text-xs px-3 py-1 rounded-full">Scanning...</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* STEP: choose_location */}
        {step === 'choose_location' && pieceInfo && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="bg-mcl-blue px-4 py-3">
              <p className="text-white font-semibold text-sm">Step 2 — Assign location</p>
            </div>
            <div className="p-4 space-y-4">
              {/* Piece summary */}
              <div className="bg-gray-50 rounded-lg p-3 text-sm space-y-1">
                <div className="flex justify-between">
                  <span className="text-gray-500">WR</span>
                  <span className="font-mono font-bold text-mcl-blue">{pieceInfo.wr.wr_number}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">PO</span>
                  <span className="font-semibold">{pieceInfo.wr.po_number}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Consignee</span>
                  <span className="text-right max-w-[180px] truncate">{pieceInfo.wr.consignee?.name || '—'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Type</span>
                  <span>{pieceInfo.line.packing_type} · Line {pieceInfo.line.line_order}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Piece #</span>
                  <span className="font-bold">{pieceInfo.pieceNum}</span>
                </div>
                {pieceInfo.line.location && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Current location</span>
                    <span className="font-mono text-amber-600">{pieceInfo.line.location}</span>
                  </div>
                )}
              </div>

              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Select location type</p>
              <div className="grid grid-cols-3 gap-3">
                <button
                  onClick={() => setStep('scan_rack')}
                  className="flex flex-col items-center gap-2 border-2 border-mcl-blue rounded-xl py-4 text-mcl-blue font-semibold text-sm hover:bg-blue-50 transition-colors"
                >
                  <span className="text-2xl">📡</span>
                  Scan Rack
                </button>
                <button
                  onClick={() => { setLocation('FLOOR'); setStep('confirm') }}
                  className="flex flex-col items-center gap-2 border-2 border-gray-300 rounded-xl py-4 text-gray-700 font-semibold text-sm hover:bg-gray-50 transition-colors"
                >
                  <span className="text-2xl">🏬</span>
                  FLOOR
                </button>
                <button
                  onClick={() => { setLocation('Container'); setStep('confirm') }}
                  className="flex flex-col items-center gap-2 border-2 border-gray-300 rounded-xl py-4 text-gray-700 font-semibold text-sm hover:bg-gray-50 transition-colors"
                >
                  <span className="text-2xl">📦</span>
                  Container
                </button>
              </div>

              <button
                onClick={() => { setPieceInfo(null); setStep('scan_piece') }}
                className="w-full text-sm text-gray-400 hover:text-gray-600 py-2"
              >
                ← Cancel and scan again
              </button>
            </div>
          </div>
        )}

        {/* STEP: scan_rack */}
        {step === 'scan_rack' && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="bg-[#1A4D2E] px-4 py-3">
              <p className="text-white font-semibold text-sm">Scan rack position</p>
              <p className="text-green-200 text-xs mt-0.5">Point at the rack label barcode (e.g. 01A25)</p>
            </div>
            <div className="relative bg-black aspect-[4/3]">
              <video ref={videoRef} className="w-full h-full object-cover" autoPlay muted playsInline />
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-64 h-20 border-2 border-white/70 rounded-lg relative">
                  <div className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-white rounded-tl" />
                  <div className="absolute top-0 right-0 w-4 h-4 border-t-2 border-r-2 border-white rounded-tr" />
                  <div className="absolute bottom-0 left-0 w-4 h-4 border-b-2 border-l-2 border-white rounded-bl" />
                  <div className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-white rounded-br" />
                </div>
              </div>
              {scanning && (
                <div className="absolute bottom-3 left-0 right-0 flex justify-center">
                  <span className="bg-black/50 text-white text-xs px-3 py-1 rounded-full">Scanning...</span>
                </div>
              )}
            </div>
            <div className="p-4 space-y-3">
              <div className="border-t border-gray-100 pt-3">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Can't scan? Enter manually</p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={manualRack}
                    onChange={e => setManualRack(e.target.value.toUpperCase())}
                    placeholder="e.g. 01A25"
                    maxLength={5}
                    className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono uppercase focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                  />
                  <button
                    onClick={() => {
                      const v = manualRack.trim().toUpperCase()
                      if (!/^\d{2}[A-E]\d{2}$/.test(v)) {
                        setError(`Invalid format: "${v}". Must be like 01A25`)
                        return
                      }
                      setError('')
                      setManualRack('')
                      stopCamera()
                      setLocation(v)
                      setStep('confirm')
                    }}
                    className="bg-mcl-blue text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-900 transition-colors"
                  >
                    Confirm
                  </button>
                </div>
              </div>
              <button
                onClick={() => setStep('choose_location')}
                className="w-full text-sm text-gray-400 hover:text-gray-600 py-2"
              >
                ← Back
              </button>
            </div>
          </div>
        )}

        {/* STEP: confirm */}
        {step === 'confirm' && pieceInfo && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="bg-[#1A4D2E] px-4 py-3">
              <p className="text-white font-semibold text-sm">Confirm location</p>
            </div>
            <div className="p-4 space-y-4">
              <div className="bg-gray-50 rounded-lg p-3 text-sm space-y-1">
                <div className="flex justify-between">
                  <span className="text-gray-500">WR</span>
                  <span className="font-mono font-bold text-mcl-blue">{pieceInfo.wr.wr_number}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">PO</span>
                  <span className="font-semibold">{pieceInfo.wr.po_number}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Type</span>
                  <span>{pieceInfo.line.packing_type} · Line {pieceInfo.line.line_order}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Piece #</span>
                  <span className="font-bold">{pieceInfo.pieceNum}</span>
                </div>
              </div>

              <div className="text-center py-2">
                <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">New location</p>
                <p className="text-4xl font-black text-mcl-blue tracking-widest">{location}</p>
              </div>

              <button
                onClick={saveLocation}
                disabled={saving}
                className="w-full bg-mcl-blue text-white py-3 rounded-xl font-semibold text-sm hover:bg-blue-900 transition-colors disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Confirm and save'}
              </button>
              <button
                onClick={() => setStep('choose_location')}
                className="w-full text-sm text-gray-400 hover:text-gray-600 py-2"
              >
                ← Change location
              </button>
            </div>
          </div>
        )}
      </div>
    </Layout>
  )
}
