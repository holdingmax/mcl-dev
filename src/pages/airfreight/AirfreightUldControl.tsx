import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  collection, query, getDocs, getDoc, addDoc, onSnapshot, orderBy, doc, updateDoc, deleteDoc, where,
} from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage'
import { db, storage } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import { AirfreightBooking, AirfreightFlight } from '../../types'
import Layout from '../../components/Layout'
import * as XLSX from 'xlsx'
import html2pdf from 'html2pdf.js'

// ── Types ──────────────────────────────────────────────────────────────────────

interface UldRecord {
  uld_code: string
  uld_airline: string
  airline: string
  flight_number: string
  flight_date: string
  flight_id: string
  booking_id: string
  client_id: string
  client_name: string
  awb: string
  status: 'in_warehouse' | 'returned'
}

interface UldReturn {
  id?: string
  uld_codes: string[]
  pdf_all_codes?: string[]  // all ULD codes extracted from PDF (matched + unmatched)
  orphan_clients?: Record<string, string>  // ULD code → client name for orphans
  returned_at: string
  returned_by: string
  proof_url: string
  proof_filename: string
  notes?: string
}

// ── Google Cloud Vision OCR ───────────────────────────────────────────────────
// Key restricted in Google Cloud Console: HTTP referrer + Vision API only

const VISION_API_KEY = import.meta.env.VITE_GOOGLE_VISION_API_KEY as string

async function extractTextFromFile(file: File): Promise<string> {
  let base64: string

  const isImage = file.type.startsWith('image/')
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')

  if (isPdf) {
    base64 = await pdfToBase64Image(file)
  } else if (isImage) {
    base64 = await fileToBase64(file)
  } else {
    return ''
  }

  const resp = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${VISION_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          image: { content: base64 },
          features: [{ type: 'TEXT_DETECTION' }],
        }],
      }),
    },
  )

  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`Vision API error: ${resp.status} ${errText}`)
  }

  const result = await resp.json()
  return result.responses?.[0]?.fullTextAnnotation?.text || ''
}

async function fileToBase64(file: File): Promise<string> {
  // If image is larger than 4MB, compress it via canvas
  if (file.size > 4 * 1024 * 1024) {
    const img = await createImageBitmap(file)
    const canvas = document.createElement('canvas')
    const maxDim = 2500
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
    canvas.width = img.width * scale
    canvas.height = img.height * scale
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
    return dataUrl.split(',')[1]
  }
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

async function pdfToBase64Image(file: File): Promise<string> {
  const pdfjsLib = await import('pdfjs-dist')
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`

  const arrayBuf = await file.arrayBuffer()
  const pdfDoc = await pdfjsLib.getDocument({
    data: new Uint8Array(arrayBuf),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise

  const page = await pdfDoc.getPage(1)
  const viewport = page.getViewport({ scale: 2.0 })
  const canvas = document.createElement('canvas')
  canvas.width = viewport.width
  canvas.height = viewport.height
  const ctx = canvas.getContext('2d')!
  await page.render({ canvasContext: ctx, viewport }).promise

  // Convert canvas to JPEG (much smaller than PNG)
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
  return dataUrl.split(',')[1]
}

// ── Match logic ────────────────────────────────────────────────────────────────

// Strategy: extract multiple token types from PDF and check if any appear inside ULD codes
function extractUldTokens(text: string): string[] {
  const tokens: string[] = []
  let m: RegExpExecArray | null

  // 1) Full ULD pattern: TYPE + SERIAL + OWNER (e.g. PMC54657 5Y, PMC/54657/5Y)
  const reFull = /([A-Z]{3})\s*[\/]?\s*(\d{4,6})\s*([A-Z0-9]{1,2})\b/gi
  while ((m = reFull.exec(text)) !== null) {
    tokens.push((m[1] + m[2] + m[3]).toUpperCase())
    tokens.push((m[2] + m[3]).toUpperCase())
  }

  // 2) Multi-line OCR: TYPE, SERIAL, OWNER on separate lines
  const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean)
  for (let i = 0; i < lines.length - 2; i++) {
    const typeMatch = lines[i].match(/^([A-Z]{3})$/i)
    const serialMatch = lines[i + 1].match(/^(\d{4,6})$/)
    const ownerMatch = lines[i + 2].match(/^([A-Z0-9]{2,3})$/i)
    if (typeMatch && serialMatch && ownerMatch) {
      const full = (typeMatch[1] + serialMatch[1] + ownerMatch[1]).toUpperCase()
      tokens.push(full)
      tokens.push((serialMatch[1] + ownerMatch[1]).toUpperCase())
      tokens.push(serialMatch[1]) // pure serial
    }
  }

  // 3) Any alphanumeric sequence of 6+ chars that looks like a ULD code
  const reAlpha = /\b([A-Z]{2,3}\d{4,8}[A-Z0-9]{0,3})\b/gi
  while ((m = reAlpha.exec(text)) !== null) {
    tokens.push(m[1].toUpperCase())
  }

  // 4) Pure numeric sequences of 4+ digits (serial numbers)
  const reNum = /\b(\d{4,8})\b/g
  while ((m = reNum.exec(text)) !== null) {
    tokens.push(m[1])
  }

  return [...new Set(tokens)]
}

function matchUldCode(uldCode: string, pdfTokens: string[]): boolean {
  const clean = uldCode.replace(/[^A-Z0-9]/gi, '').toUpperCase()
  // Extract serial number from ULD code (digits only)
  const serialMatch = clean.match(/(\d{4,6})/)
  const serial = serialMatch ? serialMatch[1] : ''
  return pdfTokens.some(token => {
    if (token.length < 4) return false // skip very short tokens
    // Full code match
    if (clean === token) return true
    // Token is the serial+owner portion of the ULD code
    if (serial && token.length >= 5 && clean.endsWith(token)) return true
    // ULD code contains the token as serial number (exact serial match)
    if (serial && token === serial) return true
    // Full token contained in clean (but token must be substantial — at least 5 chars)
    if (token.length >= 5 && clean.includes(token)) return true
    return false
  })
}

// ── Extract clean ULD codes from OCR text (TYPE+SERIAL+OWNER) ─────────────────

function extractCleanUldCodes(text: string): string[] {
  const codes: string[] = []

  // Strategy 1: single-line pattern (TYPE+SERIAL+OWNER on same line)
  const re = /([A-Z]{3})\s*[\/]?\s*(\d{4,6})\s*([A-Z0-9]{1,2})\b/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    codes.push((m[1] + m[2] + m[3]).toUpperCase())
  }

  // Strategy 2: multi-line OCR — TYPE, SERIAL, OWNER on separate lines
  // e.g. "PMC\n11777\nDHL" or "PMC\n5983\nDHL"
  const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean)
  for (let i = 0; i < lines.length - 2; i++) {
    const typeMatch = lines[i].match(/^([A-Z]{3})$/i)
    const serialMatch = lines[i + 1].match(/^(\d{4,6})$/)
    const ownerMatch = lines[i + 2].match(/^([A-Z0-9]{2,3})$/i)
    if (typeMatch && serialMatch && ownerMatch) {
      codes.push((typeMatch[1] + serialMatch[1] + ownerMatch[1]).toUpperCase())
    }
  }

  // Strategy 3: collapsed text without spaces — e.g. "PMC11777DHL"
  const reCollapsed = /\b([A-Z]{3})(\d{4,6})([A-Z]{2,3})\b/gi
  while ((m = reCollapsed.exec(text)) !== null) {
    codes.push((m[1] + m[2] + m[3]).toUpperCase())
  }

  return [...new Set(codes)]
}

// ── Extract date from OCR text ─────────────────────────────────────────────────

function extractDateFromText(text: string): string | null {
  // Try 4-digit year first: DD/MM/YYYY or MM/DD/YYYY
  let m = text.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/)
  if (m) {
    const [, a, b, y] = m
    // If first number > 12, it must be DD/MM/YYYY
    if (Number(a) > 12) return `${y}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`
    // If second number > 12, it must be MM/DD/YYYY
    if (Number(b) > 12) return `${y}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`
    // Ambiguous — assume DD/MM/YYYY (more common in these comprobantes)
    return `${y}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`
  }
  // 2-digit year: DD/MM/YY or MM/DD/YY
  m = text.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})\b/)
  if (m) {
    const [, a, b, y] = m
    const fullYear = Number(y) > 50 ? `19${y}` : `20${y}`
    // If first number > 12, it must be DD/MM/YY
    if (Number(a) > 12) return `${fullYear}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`
    // If second number > 12, it must be MM/DD/YY
    if (Number(b) > 12) return `${fullYear}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`
    // Ambiguous — assume DD/MM/YY (comprobantes use this format)
    return `${fullYear}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`
  }
  return null
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function AirfreightUldControl() {
  const { isAdmin, isSuperAgent, isAgent, isCounter, isBodega, isClient, clientId } = useAuth()
  const navigate = useNavigate()
  const isMcl = isAdmin || isSuperAgent || isAgent || isCounter || isBodega

  const [uldRecords, setUldRecords] = useState<UldRecord[]>([])
  const [returns, setReturns] = useState<UldReturn[]>([])
  const [loading, setLoading] = useState(true)
  const [filterStatus, setFilterStatus] = useState<'all' | 'in_warehouse' | 'returned'>('in_warehouse')
  const [filterAirline, setFilterAirline] = useState('')
  const [filterClient, setFilterClient] = useState('')
  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')
  const [searchQuery, setSearchQuery] = useState('')

  // Return form
  const [showReturnForm, setShowReturnForm] = useState(false)
  const [selectedUlds, setSelectedUlds] = useState<Set<string>>(new Set())
  const [returnNotes, setReturnNotes] = useState('')
  const [showAllUlds, setShowAllUlds] = useState(false)
  const [saving, setSaving] = useState(false)

  // Delete mode (admin only)
  const [showDeleteMode, setShowDeleteMode] = useState(false)
  const [deleteSelectedUlds, setDeleteSelectedUlds] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)

  // Generate Return Document
  const [showGenerateReturn, setShowGenerateReturn] = useState(false)
  const [genReceivedBy, setGenReceivedBy] = useState('CO Transportation')
  const [genReceivedByCustom, setGenReceivedByCustom] = useState('')
  const [genRemarks, setGenRemarks] = useState('')
  const [genSelectedUlds, setGenSelectedUlds] = useState<Set<string>>(new Set())
  const [generatingPdf, setGeneratingPdf] = useState(false)

  // PDF upload
  const [pdfFile, setPdfFile] = useState<File | null>(null)
  const [pdfMatches, setPdfMatches] = useState<string[]>([])
  const [pdfExtractedText, setPdfExtractedText] = useState<string | null>(null)
  const [pdfExtractedDate, setPdfExtractedDate] = useState<string | null>(null)
  const [pdfAllCodes, setPdfAllCodes] = useState<string[]>([])
  const [extracting, setExtracting] = useState(false)
  const pdfInputRef = useRef<HTMLInputElement>(null)
  const proofInputRef = useRef<HTMLInputElement>(null)

  // ── Load ULDs from bookings ────────────────────────────────────────────────

  useEffect(() => {
    if (isClient && !clientId) {
      setUldRecords([])
      setLoading(false)
      return
    }

    let cancelled = false

    async function loadUlds() {
      const bookingsQuery = isClient && clientId
        ? query(collection(db, 'airfreight_bookings'), where('client_id', '==', clientId))
        : query(collection(db, 'airfreight_bookings'))

      const [flightsSnap, bookingsSnap] = await Promise.all([
        getDocs(query(collection(db, 'airfreight_flights'), orderBy('flight_datetime', 'desc'))),
        getDocs(bookingsQuery),
      ])

      const flightsMap = new Map<string, AirfreightFlight & { id: string }>()
      flightsSnap.docs.forEach(d => flightsMap.set(d.id, { ...d.data() as AirfreightFlight, id: d.id }))

      const records: UldRecord[] = []

      bookingsSnap.docs.forEach(bDoc => {
        const booking = bDoc.data() as AirfreightBooking
        const flight = flightsMap.get(booking.flight_id)
        if (!flight) return

        const flightDate = flight.flight_datetime ? flight.flight_datetime.slice(0, 10) : ''
        const flightNum = flight.flight_number || ''
        const airline = booking.airline || flight.airline || ''

        if ((booking.booking_type === 'mawb' || booking.booking_type === 'ecommerce') && booking.awb_lines) {
          booking.awb_lines.forEach(line => {
            const uldRaw = line.uld_type?.trim()
            if (!uldRaw || uldRaw.toUpperCase() === 'LOOSE') return
            // Split by " - " for multi-ULD entries
            const codes = uldRaw.split(/\s*-\s*/).filter(Boolean)
            codes.forEach(code => {
              records.push({
                uld_code: code.trim(),
                uld_airline: line.uld_airline || '',
                airline,
                flight_number: flightNum,
                flight_date: flightDate,
                flight_id: booking.flight_id,
                booking_id: bDoc.id,
                client_id: booking.client_id || '',
                client_name: booking.client_name,
                awb: line.awb_number || '',
                status: 'in_warehouse',
              })
            })
          })
        } else if (booking.booking_type === 'simple') {
          const uldRaw = booking.uld_type?.trim()
          if (uldRaw && uldRaw.toUpperCase() !== 'LOOSE') {
            const codes = uldRaw.split(/\s*-\s*/).filter(Boolean)
            codes.forEach(code => {
              records.push({
                uld_code: code.trim(),
                uld_airline: '',
                airline,
                flight_number: flightNum,
                flight_date: flightDate,
                flight_id: booking.flight_id,
                booking_id: bDoc.id,
                client_id: booking.client_id || '',
                client_name: booking.client_name,
                awb: booking.awb_1st_leg || '',
                status: 'in_warehouse',
              })
            })
          }
        }
      })

      if (cancelled) return
      setUldRecords(records)
      setLoading(false)
    }

    loadUlds()
    return () => { cancelled = true }
  }, [isClient, clientId])

  // ── Load returns ─────────────────────────────────────────────────────────────

  useEffect(() => {
    const unsub = onSnapshot(
      query(collection(db, 'uld_returns'), orderBy('returned_at', 'desc')),
      snap => {
        setReturns(snap.docs.map(d => ({ ...d.data() as UldReturn, id: d.id })))
      },
    )
    return unsub
  }, [])

  // ── Derived: apply return status ─────────────────────────────────────────────

  // Map: normalized uld_code → return info
  const returnInfoMap = new Map<string, { returned_at: string; return_id: string; proof_url: string; proof_filename: string }>()
  returns.forEach(r => r.uld_codes.forEach(c => {
    const key = c.trim().toUpperCase()
    if (!returnInfoMap.has(key)) {
      returnInfoMap.set(key, {
        returned_at: r.returned_at,
        return_id: r.id || '',
        proof_url: r.proof_url,
        proof_filename: r.proof_filename,
      })
    }
  }))

  // Find orphan ULD codes (extracted from PDF but not in any booking), grouped by return_id
  const bookingCodeSet = new Set(uldRecords.map(r => r.uld_code.trim().toUpperCase()))
  const orphansByReturn = new Map<string, { code: string; returned_at: string; client_name: string; return_id: string }[]>()
  const seenOrphans = new Set<string>()
  returns.forEach(r => {
    const allCodes = r.pdf_all_codes || r.uld_codes
    const returnId = r.id || '_ungrouped'
    allCodes.forEach(c => {
      const key = c.trim().toUpperCase()
      if (!bookingCodeSet.has(key) && !seenOrphans.has(key)) {
        seenOrphans.add(key)
        if (!orphansByReturn.has(returnId)) orphansByReturn.set(returnId, [])
        orphansByReturn.get(returnId)!.push({
          code: c,
          returned_at: r.returned_at,
          client_name: r.orphan_clients?.[key] || '',
          return_id: returnId,
        })
      }
    })
  })

  const enriched = uldRecords.map(r => {
    const key = r.uld_code.trim().toUpperCase()
    const info = returnInfoMap.get(key)
    return {
      ...r,
      status: info ? 'returned' as const : 'in_warehouse' as const,
      returned_at: info?.returned_at || '',
      return_id: info?.return_id || '',
      proof_url: info?.proof_url || '',
      proof_filename: info?.proof_filename || '',
    }
  })

  // Deduplicate by uld_code (same ULD might appear if booking was edited)
  const deduped = new Map<string, typeof enriched[0]>()
  enriched.forEach(r => {
    if (!deduped.has(r.uld_code)) deduped.set(r.uld_code, r)
  })
  const allUlds = Array.from(deduped.values())

  const airlines = [...new Set(allUlds.map(u => u.uld_airline).filter(Boolean))].sort()
  const clients = [...new Set(allUlds.map(u => u.client_name).filter(Boolean))].sort()

  const filtered = allUlds.filter(u => {
    if (filterStatus !== 'all' && u.status !== filterStatus) return false
    if (filterAirline && u.uld_airline !== filterAirline) return false
    if (filterClient && u.client_name !== filterClient) return false
    if (filterDateFrom && u.flight_date < filterDateFrom) return false
    if (filterDateTo && u.flight_date > filterDateTo) return false
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      if (
        !u.uld_code.toLowerCase().includes(q) &&
        !u.awb.toLowerCase().includes(q) &&
        !u.client_name.toLowerCase().includes(q) &&
        !u.flight_number.toLowerCase().includes(q)
      ) return false
    }
    return true
  })

  const inWarehouse = allUlds.filter(u => u.status === 'in_warehouse')

  // ── File upload + OCR auto-match ────────────────────────────────────────────

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setPdfFile(file)
    setExtracting(true)
    try {
      const text = await extractTextFromFile(file)
      setPdfExtractedText(text)
      console.log('Extracted text:', text)

      // Primary: extract full ULD codes (TYPE+SERIAL+OWNER) from OCR text
      const cleanCodes = extractCleanUldCodes(text)
      console.log('Clean ULD codes from OCR:', cleanCodes)

      // Match against in-warehouse ULDs by serial number (digits portion)
      const matched = inWarehouse.filter(u => {
        const uldClean = u.uld_code.replace(/[^A-Z0-9]/gi, '').toUpperCase()
        const uldSerial = uldClean.match(/(\d{4,6})/)?.[1] || ''
        return cleanCodes.some(code => {
          // Full code match
          if (uldClean === code) return true
          // Same serial number (digits) match
          const codeSerial = code.match(/(\d{4,6})/)?.[1] || ''
          if (uldSerial && codeSerial && uldSerial === codeSerial) return true
          return false
        })
      }).map(u => u.uld_code)

      console.log('In-warehouse ULDs:', inWarehouse.map(u => u.uld_code))
      console.log('Matched ULDs:', matched)
      setPdfMatches(matched)
      setPdfExtractedDate(extractDateFromText(text))
      setPdfAllCodes(extractCleanUldCodes(text))
      setSelectedUlds(new Set(matched))
      setShowReturnForm(true)
    } catch (err) {
      console.error('OCR/extraction error:', err)
      alert('Error al leer el archivo: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setExtracting(false)
    }
  }

  // ── Save return ────────────────────────────────────────────────────────────

  async function handleSaveReturn() {
    if (selectedUlds.size === 0) return
    setSaving(true)
    try {
      let proofUrl = ''
      let proofFilename = ''

      // Upload proof PDF if present
      if (pdfFile) {
        const path = `uld_returns/${Date.now()}_${pdfFile.name}`
        const sRef = ref(storage, path)
        await uploadBytes(sRef, pdfFile)
        proofUrl = await getDownloadURL(sRef)
        proofFilename = pdfFile.name
      }

      // Use date extracted from PDF if available, otherwise current date
      let returnedAt = new Date().toISOString()
      if (pdfExtractedDate) {
        const parsed = new Date(pdfExtractedDate + 'T12:00:00')
        if (!isNaN(parsed.getTime())) returnedAt = parsed.toISOString()
      }

      const returnData: Record<string, unknown> = {
        uld_codes: Array.from(selectedUlds),
        returned_at: returnedAt,
        returned_by: 'MCL',
        proof_url: proofUrl,
        proof_filename: proofFilename,
        notes: returnNotes || '',
      }
      if (pdfAllCodes.length > 0) {
        returnData.pdf_all_codes = pdfAllCodes
      }

      await addDoc(collection(db, 'uld_returns'), returnData)

      // Reset form
      setShowReturnForm(false)
      setSelectedUlds(new Set())
      setPdfFile(null)
      setPdfMatches([]); setPdfExtractedText(null); setPdfExtractedDate(null); setPdfAllCodes([])
      setReturnNotes('')
      if (pdfInputRef.current) pdfInputRef.current.value = ''
    } catch (err) {
      console.error('Error saving return:', err)
      alert('Error al guardar la devolución.')
    } finally {
      setSaving(false)
    }
  }

  // ── Delete return ──────────────────────────────────────────────────────────

  async function handleDeleteReturn(retId: string) {
    if (!confirm('¿Eliminar esta devolución?')) return
    await deleteDoc(doc(db, 'uld_returns', retId))
  }

  // ── Delete ULDs (admin only) ──────────────────────────────────────────────

  function toggleDeleteUld(code: string) {
    setDeleteSelectedUlds(prev => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
  }

  async function handleDeleteUlds() {
    if (deleteSelectedUlds.size === 0) return
    if (!confirm(`¿Eliminar ${deleteSelectedUlds.size} ULD(s)? Esta acción no se puede deshacer.`)) return
    setDeleting(true)
    try {
      // Group selected ULDs by booking_id
      const byBooking = new Map<string, string[]>()
      for (const u of allUlds) {
        if (!deleteSelectedUlds.has(u.uld_code)) continue
        if (!byBooking.has(u.booking_id)) byBooking.set(u.booking_id, [])
        byBooking.get(u.booking_id)!.push(u.uld_code)
      }

      for (const [bookingId, codes] of byBooking) {
        const snap = await getDoc(doc(db, 'airfreight_bookings', bookingId))
        if (!snap.exists()) continue
        const booking = snap.data() as AirfreightBooking

        if ((booking.booking_type === 'mawb' || booking.booking_type === 'ecommerce') && booking.awb_lines) {
          const updatedLines = booking.awb_lines.map(line => {
            const uldRaw = line.uld_type?.trim()
            if (!uldRaw || uldRaw.toUpperCase() === 'LOOSE') return line
            const lineCodes = uldRaw.split(/\s*-\s*/).filter(Boolean)
            const remaining = lineCodes.filter(c => !codes.includes(c.trim()))
            return { ...line, uld_type: remaining.length > 0 ? remaining.join(' - ') : null }
          })
          await updateDoc(doc(db, 'airfreight_bookings', bookingId), { awb_lines: updatedLines })
        } else if (booking.booking_type === 'simple') {
          const uldRaw = booking.uld_type?.trim()
          if (uldRaw && uldRaw.toUpperCase() !== 'LOOSE') {
            const lineCodes = uldRaw.split(/\s*-\s*/).filter(Boolean)
            const remaining = lineCodes.filter(c => !codes.includes(c.trim()))
            await updateDoc(doc(db, 'airfreight_bookings', bookingId), {
              uld_type: remaining.length > 0 ? remaining.join(' - ') : 'LOOSE',
            })
          }
        }
      }

      // Remove from local state
      setUldRecords(prev => prev.filter(r => !deleteSelectedUlds.has(r.uld_code)))
      setDeleteSelectedUlds(new Set())
      setShowDeleteMode(false)
    } catch (err) {
      console.error('Error deleting ULDs:', err)
      alert('Error al eliminar ULDs: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setDeleting(false)
    }
  }

  // ── Toggle manual selection ────────────────────────────────────────────────

  function toggleUld(code: string) {
    setSelectedUlds(prev => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
  }

  // ── Excel export ────────────────────────────────────────────────────────────

  function exportToExcel() {
    const data = filtered.map(u => ({
      'ULD Code': u.uld_code,
      'ULD Airline': u.uld_airline,
      'Aerolínea': u.airline,
      'Vuelo': u.flight_number,
      'Fecha Vuelo': u.flight_date,
      'Cliente': u.client_name,
      'AWB': u.awb,
      'Estado': u.status === 'in_warehouse' ? 'En Warehouse' : 'Devuelto',
      'Fecha Devolución': u.returned_at ? new Date(u.returned_at).toLocaleDateString() : '',
    }))
    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'ULDs')
    XLSX.writeFile(wb, `uld_control_${new Date().toLocaleDateString('en-CA')}.xlsx`)
  }

  // ── Parse ULD code into components ─────────────────────────────────────────

  function parseUldCode(code: string): { type: string; serial: string; owner: string } {
    const m = code.match(/^([A-Z]{3})(\d{4,6})([A-Z0-9]{1,2})$/i)
    if (m) return { type: m[1].toUpperCase(), serial: m[2], owner: m[3].toUpperCase() }
    // Fallback: try splitting differently
    const clean = code.replace(/[^A-Z0-9]/gi, '')
    if (clean.length >= 6) {
      return { type: clean.slice(0, 3), serial: clean.slice(3, -2), owner: clean.slice(-2) }
    }
    return { type: code, serial: '', owner: '' }
  }

  // ── Toggle generate return ULD selection ─────────────────────────────────

  function toggleGenUld(code: string) {
    setGenSelectedUlds(prev => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
  }

  // ── Generate ULD CONTROL RETURN PDF ──────────────────────────────────────

  async function handleGenerateReturnPdf() {
    if (genSelectedUlds.size === 0) return
    setGeneratingPdf(true)

    try {
      const receivedBy = genReceivedBy === '__custom__' ? genReceivedByCustom : genReceivedBy
      const today = new Date()
      const dateStr = today.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
      const selectedList = inWarehouse.filter(u => genSelectedUlds.has(u.uld_code))

      // Parse ULD codes into components
      const parsedUlds = selectedList.map(u => parseUldCode(u.uld_code))

      // Add empty rows (at least 3 extra, up to fill ~25 rows)
      const emptyRows = Math.max(3, 25 - parsedUlds.length)

      // Build ULD rows
      let tableRows = ''
      parsedUlds.forEach((p, i) => {
        const bg = i % 2 === 0 ? '#fff' : '#f9fafb'
        tableRows += `<tr style="background:${bg};">
          <td style="padding:4px 12px; border-bottom:1px solid #e5e7eb; text-align:center; font-size:12px;">${p.type}</td>
          <td style="padding:4px 12px; border-bottom:1px solid #e5e7eb; text-align:center; font-size:12px; font-weight:600;">${p.serial}</td>
          <td style="padding:4px 12px; border-bottom:1px solid #e5e7eb; text-align:center; font-size:12px;">${p.owner}</td>
        </tr>`
      })

      // Additional ULDs empty lines count
      const addLines = 5

      const html = `
        <div style="font-family: Arial, Helvetica, sans-serif; padding: 20px 25px; font-size: 12px; color: #1a1a1a; max-width: 750px; margin: 0 auto;">

          <!-- Title bar -->
          <div style="background: #1e3a5f; color: #fff; text-align: center; padding: 10px 0; font-size: 18px; font-weight: bold; letter-spacing: 3px; border-radius: 4px;">
            ULD CONTROL RETURN
          </div>

          <!-- Header info -->
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-top: 12px; margin-bottom: 12px;">
            <div style="font-size: 12px; line-height: 1.8;">
              <div><strong>Issued by:</strong> MINCURL LOGISTICS</div>
              <div><strong>Received by:</strong> ${receivedBy}</div>
              <div><strong>Date:</strong> ${dateStr}</div>
            </div>
            <div style="border: 2px solid #1e3a5f; border-radius: 6px; text-align: center; padding: 6px 18px;">
              <div style="font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 1px;">Total ULDs</div>
              <div style="font-size: 26px; font-weight: bold; color: #1e3a5f;">${parsedUlds.length}</div>
            </div>
          </div>

          <!-- Main content: ULD table + Remarks -->
          <div style="display: flex; gap: 15px; align-items: flex-start;">

            <!-- ULD Table -->
            <div style="flex: 1; border: 1.5px solid #d1d5db; border-radius: 4px; overflow: hidden;">
              <div style="background: #1e3a5f; color: #fff; text-align: center; padding: 5px 0; font-size: 11px; font-weight: bold; letter-spacing: 1px;">
                IATA ID CODE
              </div>
              <table style="width: 100%; border-collapse: collapse;">
                <thead>
                  <tr style="background: #f3f4f6;">
                    <th style="padding: 5px 12px; text-align: center; font-size: 10px; color: #555; border-bottom: 1.5px solid #d1d5db; text-transform: uppercase; letter-spacing: 0.5px;">Type Code</th>
                    <th style="padding: 5px 12px; text-align: center; font-size: 10px; color: #555; border-bottom: 1.5px solid #d1d5db; text-transform: uppercase; letter-spacing: 0.5px;">Serial Number</th>
                    <th style="padding: 5px 12px; text-align: center; font-size: 10px; color: #555; border-bottom: 1.5px solid #d1d5db; text-transform: uppercase; letter-spacing: 0.5px;">Owner</th>
                  </tr>
                </thead>
                <tbody>
                  ${tableRows}
                </tbody>
              </table>
            </div>

            <!-- Remarks -->
            <div style="width: 180px; border: 1.5px solid #d1d5db; border-radius: 4px; overflow: hidden;">
              <div style="background: #1e3a5f; color: #fff; text-align: center; padding: 5px 0; font-size: 10px; font-weight: bold; letter-spacing: 0.5px;">
                Condition Upon Receipt
              </div>
              <div style="background: #f3f4f6; text-align: center; padding: 4px; font-size: 9px; color: #555; text-transform: uppercase; border-bottom: 1px solid #d1d5db;">
                Remarks / Notes
              </div>
              <div style="padding: 8px; font-size: 11px; min-height: 60px;">
                ${genRemarks || '&nbsp;'}
              </div>
            </div>
          </div>

          <!-- Additional ULDs box -->
          <div style="margin-top: 12px; border: 1.5px solid #d1d5db; border-radius: 4px; overflow: hidden;">
            <div style="background: #f3f4f6; padding: 4px 10px; font-size: 10px; font-weight: bold; color: #555; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid #d1d5db;">
              Additional ULDs (manual)
            </div>
            <table style="width: 100%; border-collapse: collapse;">
              ${Array.from({ length: addLines }, () =>
                `<tr>
                  <td style="padding: 6px 12px; border-bottom: 1px solid #e5e7eb; width: 33%;">&nbsp;</td>
                  <td style="padding: 6px 12px; border-bottom: 1px solid #e5e7eb; width: 34%;">&nbsp;</td>
                  <td style="padding: 6px 12px; border-bottom: 1px solid #e5e7eb; width: 33%;">&nbsp;</td>
                </tr>`
              ).join('')}
            </table>
          </div>

          <!-- Signatures -->
          <div style="display: flex; justify-content: space-between; margin-top: 18px; gap: 20px; font-size: 11px;">
            <div style="flex: 1; border: 1.5px solid #d1d5db; border-radius: 4px; padding: 12px 15px;">
              <div style="font-weight: bold; font-size: 12px; margin-bottom: 8px; color: #1e3a5f;">Delivered by</div>
              <div style="color: #888; font-size: 10px; margin-bottom: 10px;">${receivedBy}</div>
              <div style="margin-bottom: 14px; border-bottom: 1px dashed #ccc; padding-bottom: 14px;">Name: </div>
              <div style="margin-bottom: 14px; border-bottom: 1px dashed #ccc; padding-bottom: 14px;">Signature: </div>
              <div>Date: </div>
            </div>
            <div style="flex: 1; border: 1.5px solid #d1d5db; border-radius: 4px; padding: 12px 15px;">
              <div style="font-weight: bold; font-size: 12px; margin-bottom: 8px; color: #1e3a5f;">Received by</div>
              <div style="margin-bottom: 14px; border-bottom: 1px dashed #ccc; padding-bottom: 14px;">Company: </div>
              <div style="margin-bottom: 14px; border-bottom: 1px dashed #ccc; padding-bottom: 14px;">Name: </div>
              <div style="margin-bottom: 14px; border-bottom: 1px dashed #ccc; padding-bottom: 14px;">Signature: </div>
              <div>Date: </div>
            </div>
          </div>
        </div>
      `

      const container = document.createElement('div')
      container.innerHTML = html
      document.body.appendChild(container)

      const pdfBlob = await html2pdf()
        .set({
          margin: [8, 8, 8, 8],
          filename: `ULD_CONTROL_RETURN_${today.toLocaleDateString('en-CA')}.pdf`,
          image: { type: 'jpeg', quality: 0.98 },
          html2canvas: { scale: 2, useCORS: true },
          jsPDF: { unit: 'mm', format: 'letter', orientation: 'portrait' },
        })
        .from(container)
        .outputPdf('blob')

      document.body.removeChild(container)

      // Upload PDF to Firebase Storage
      const filename = `ULD_CONTROL_RETURN_${today.toLocaleDateString('en-CA')}_${Date.now()}.pdf`
      const storagePath = `uld_return_documents/${filename}`
      const sRef = ref(storage, storagePath)
      await uploadBytes(sRef, pdfBlob)
      const downloadUrl = await getDownloadURL(sRef)

      // Save record to Firestore
      await addDoc(collection(db, 'uld_return_documents'), {
        received_by: receivedBy,
        remarks: genRemarks || null,
        date: today.toISOString(),
        uld_codes: Array.from(genSelectedUlds),
        uld_count: genSelectedUlds.size,
        pdf_url: downloadUrl,
        pdf_filename: filename,
        storage_path: storagePath,
        created_at: today.toISOString(),
      })

      // Open PDF in new tab
      window.open(downloadUrl, '_blank')

      // Reset state
      setShowGenerateReturn(false)
      setGenSelectedUlds(new Set())
      setGenReceivedBy('CO Transportation')
      setGenReceivedByCustom('')
      setGenRemarks('')
    } catch (err) {
      console.error('Error generating PDF:', err)
      alert('Error al generar el documento: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setGeneratingPdf(false)
    }
  }

  // ── Cleanup old return documents (>15 days) ──────────────────────────────

  useEffect(() => {
    async function cleanupOldDocs() {
      try {
        const snap = await getDocs(collection(db, 'uld_return_documents'))
        const cutoff = Date.now() - 15 * 24 * 60 * 60 * 1000
        for (const d of snap.docs) {
          const data = d.data()
          const createdAt = new Date(data.created_at).getTime()
          if (createdAt < cutoff) {
            // Delete from Storage
            if (data.storage_path) {
              try { await deleteObject(ref(storage, data.storage_path)) } catch { /* already deleted */ }
            }
            // Delete from Firestore
            await deleteDoc(doc(db, 'uld_return_documents', d.id))
          }
        }
      } catch { /* ignore cleanup errors */ }
    }
    cleanupOldDocs()
  }, [])

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <Layout title="ULD Control" backTo="/airfreight">
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" />
        </div>
      </Layout>
    )
  }

  return (
    <Layout title="ULD Control" backTo="/airfreight">
      <div className="space-y-4">

        {/* ── Summary cards ─────────────────────────────────────────────────── */}
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
            <div className="text-2xl font-bold text-mcl-blue">{allUlds.length}</div>
            <div className="text-xs text-gray-500 mt-1">Total ULDs</div>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
            <div className="text-2xl font-bold text-amber-600">{inWarehouse.length}</div>
            <div className="text-xs text-gray-500 mt-1">En Warehouse</div>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
            <div className="text-2xl font-bold text-green-600">{allUlds.length - inWarehouse.length}</div>
            <div className="text-xs text-gray-500 mt-1">Devueltos</div>
          </div>
        </div>

        {/* ── Filters ───────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-3 flex-wrap">
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value as 'all' | 'in_warehouse' | 'returned')}
            className="px-3 py-1.5 text-xs border rounded-lg"
          >
            <option value="in_warehouse">En Warehouse</option>
            <option value="returned">Devueltos</option>
            <option value="all">Todos</option>
          </select>

          <select
            value={filterAirline}
            onChange={e => setFilterAirline(e.target.value)}
            className="px-3 py-1.5 text-xs border rounded-lg"
          >
            <option value="">Todas (ULD Air)</option>
            {airlines.map(a => <option key={a} value={a}>{a}</option>)}
          </select>

          {isMcl && (
            <select
              value={filterClient}
              onChange={e => setFilterClient(e.target.value)}
              className="px-3 py-1.5 text-xs border rounded-lg"
            >
              <option value="">Todos los clientes</option>
              {clients.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          )}

          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-400">Desde</span>
            <input
              type="date"
              value={filterDateFrom}
              onChange={e => setFilterDateFrom(e.target.value)}
              className="px-2 py-1.5 text-xs border rounded-lg"
            />
            <span className="text-xs text-gray-400">Hasta</span>
            <input
              type="date"
              value={filterDateTo}
              onChange={e => setFilterDateTo(e.target.value)}
              className="px-2 py-1.5 text-xs border rounded-lg"
            />
          </div>

          <input
            type="text"
            placeholder="Buscar ULD, AWB, cliente..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="px-3 py-1.5 text-xs border rounded-lg w-56"
          />
        </div>

        {/* ── Action buttons row ──────────────────────────────────────────── */}
        <div className="flex items-center">
          {isMcl && !showReturnForm && !showDeleteMode && (
            <button
              onClick={() => {
                if (showGenerateReturn) {
                  setShowGenerateReturn(false)
                  setGenSelectedUlds(new Set())
                } else {
                  setShowGenerateReturn(true)
                  setFilterStatus('in_warehouse')
                }
              }}
              className={`px-4 py-2 text-xs font-semibold rounded-lg transition-colors ${
                showGenerateReturn
                  ? 'bg-gray-400 text-white hover:bg-gray-500'
                  : 'bg-blue-600 text-white hover:bg-blue-700'
              }`}
            >
              {showGenerateReturn ? 'Cancelar' : 'Pallet Stacks'}
            </button>
          )}

          <div className="ml-auto flex gap-2">
            {filtered.length > 0 && !showDeleteMode && (
              <button
                onClick={exportToExcel}
                className="px-4 py-2 bg-green-700 text-white text-xs font-semibold rounded-lg hover:bg-green-800 transition-colors"
              >
                Descargar Excel
              </button>
            )}
            {isMcl && !showDeleteMode && (
              <>
                <label className="px-4 py-2 bg-indigo-600 text-white text-xs font-semibold rounded-lg hover:bg-indigo-700 cursor-pointer transition-colors">
                  {extracting ? 'Procesando OCR...' : 'Subir Comprobante'}
                  <input
                    ref={pdfInputRef}
                    type="file"
                    accept=".pdf,.jpg,.jpeg,.png,.webp"
                    className="hidden"
                    onChange={handleFileUpload}
                    disabled={extracting}
                  />
                </label>
                <button
                  onClick={() => { setShowReturnForm(true); setSelectedUlds(new Set()) }}
                  className="px-4 py-2 bg-green-600 text-white text-xs font-semibold rounded-lg hover:bg-green-700 transition-colors"
                >
                  Devolución Manual
                </button>
              </>
            )}
            {(isAdmin || isSuperAgent) && !showReturnForm && !showGenerateReturn && (
              showDeleteMode ? (
                <>
                  <button
                    onClick={handleDeleteUlds}
                    disabled={deleteSelectedUlds.size === 0 || deleting}
                    className="px-4 py-2 bg-red-600 text-white text-xs font-semibold rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
                  >
                    {deleting ? 'Eliminando...' : `Eliminar (${deleteSelectedUlds.size})`}
                  </button>
                  <button
                    onClick={() => { setShowDeleteMode(false); setDeleteSelectedUlds(new Set()) }}
                    className="px-4 py-2 bg-gray-400 text-white text-xs font-semibold rounded-lg hover:bg-gray-500 transition-colors"
                  >
                    Cancelar
                  </button>
                </>
              ) : (
                <button
                  onClick={() => { setShowDeleteMode(true); setDeleteSelectedUlds(new Set()) }}
                  className="px-4 py-2 bg-red-600 text-white text-xs font-semibold rounded-lg hover:bg-red-700 transition-colors"
                >
                  Borrar ULDs
                </button>
              )
            )}
          </div>
        </div>

        {/* ── PDF match results ─────────────────────────────────────────────── */}
        {pdfExtractedText !== null && (
          <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-3 space-y-2">
            {pdfExtractedText.trim() ? (
              <>
                <div className="text-sm font-semibold text-indigo-800">
                  PDF: {pdfMatches.length} ULD(s) auto-detectados
                  {pdfMatches.length === 0 && <span className="font-normal text-indigo-500 ml-2">— seleccione manualmente abajo</span>}
                </div>
                {pdfMatches.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {pdfMatches.map(code => (
                      <span key={code} className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded">
                        {code}
                      </span>
                    ))}
                  </div>
                )}
                <details className="text-xs text-gray-500">
                  <summary className="cursor-pointer hover:text-gray-700">Ver texto extraído del PDF</summary>
                  <pre className="mt-1 max-h-40 overflow-auto bg-white border rounded p-2 whitespace-pre-wrap text-[10px]">
                    {pdfExtractedText}
                  </pre>
                </details>
              </>
            ) : (
              <div className="text-sm text-amber-700 font-semibold">
                El PDF no contiene texto extraíble (es un documento escaneado/imagen).
                <span className="font-normal block mt-1">Seleccione los ULDs manualmente abajo.</span>
              </div>
            )}
          </div>
        )}

        {/* ── Generate Return Document panel ─────────────────────────────── */}
        {showGenerateReturn && isMcl && (
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-blue-800">
                Pallet Stacks — ULD Control Return ({genSelectedUlds.size} seleccionados)
              </h3>
              <button
                onClick={() => { setShowGenerateReturn(false); setGenSelectedUlds(new Set()) }}
                className="text-gray-400 hover:text-gray-600"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Received by (Transporte)</label>
                <select
                  value={genReceivedBy}
                  onChange={e => setGenReceivedBy(e.target.value)}
                  className="w-full px-3 py-2 text-xs border rounded-lg"
                >
                  <option value="CO Transportation">CO Transportation</option>
                  <option value="__custom__">Otro (escribir)</option>
                </select>
                {genReceivedBy === '__custom__' && (
                  <input
                    type="text"
                    value={genReceivedByCustom}
                    onChange={e => setGenReceivedByCustom(e.target.value)}
                    placeholder="Nombre del transportista"
                    className="w-full mt-1 px-3 py-2 text-xs border rounded-lg"
                  />
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Remarks / Notes</label>
                <input
                  type="text"
                  value={genRemarks}
                  onChange={e => setGenRemarks(e.target.value)}
                  placeholder="Ej: ATLAS / MERFLEX"
                  className="w-full px-3 py-2 text-xs border rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Fecha</label>
                <input
                  type="text"
                  value={new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })}
                  disabled
                  className="w-full px-3 py-2 text-xs border rounded-lg bg-gray-100 text-gray-500"
                />
              </div>
            </div>

            <p className="text-xs text-blue-600">Seleccione los ULDs en la tabla de abajo haciendo click en cada checkbox.</p>

            <div className="flex gap-2">
              <button
                onClick={handleGenerateReturnPdf}
                disabled={generatingPdf || genSelectedUlds.size === 0 || (genReceivedBy === '__custom__' && !genReceivedByCustom.trim())}
                className="px-4 py-2 bg-blue-600 text-white text-xs font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {generatingPdf ? 'Generando PDF...' : `Generar PDF (${genSelectedUlds.size} ULDs)`}
              </button>
              <button
                onClick={() => { setShowGenerateReturn(false); setGenSelectedUlds(new Set()) }}
                className="px-4 py-2 bg-gray-200 text-gray-600 text-xs font-semibold rounded-lg hover:bg-gray-300 transition-colors"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        {/* ── Return form ───────────────────────────────────────────────────── */}
        {showReturnForm && isMcl && (
          <div className="bg-green-50 border border-green-200 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-green-800">
                Registrar Devolución ({selectedUlds.size} seleccionados)
                {pdfExtractedDate && (
                  <span className="ml-2 text-xs font-normal text-green-600">
                    Fecha comprobante: {new Date(pdfExtractedDate + 'T12:00:00').toLocaleDateString()}
                  </span>
                )}
              </h3>
              <button
                onClick={() => { setShowReturnForm(false); setSelectedUlds(new Set()); setPdfMatches([]); setPdfExtractedText(null); setPdfExtractedDate(null); setPdfAllCodes([]); setShowAllUlds(false) }}
                className="text-gray-400 hover:text-gray-600"
              >
                ✕
              </button>
            </div>

            {/* Checkboxes for ULDs */}
            <div className="max-h-48 overflow-y-auto border rounded bg-white p-2 space-y-1">
              {(() => {
                const matched = pdfMatches.length > 0 ? inWarehouse.filter(u => pdfMatches.includes(u.uld_code)) : []
                const displayList = pdfMatches.length > 0 && !showAllUlds ? matched : inWarehouse
                if (displayList.length === 0 && pdfMatches.length > 0) {
                  return <p className="text-xs text-gray-400">No se encontraron ULDs del comprobante en warehouse</p>
                }
                if (inWarehouse.length === 0) {
                  return <p className="text-xs text-gray-400">No hay ULDs en warehouse</p>
                }
                return displayList.map(u => {
                  const isMatch = pdfMatches.includes(u.uld_code)
                  return (
                    <label key={u.uld_code} className={`flex items-center gap-2 text-xs cursor-pointer hover:bg-gray-50 px-1 py-0.5 rounded ${isMatch ? 'bg-green-50' : ''}`}>
                      <input type="checkbox" checked={selectedUlds.has(u.uld_code)} onChange={() => toggleUld(u.uld_code)} />
                      <span className={`font-mono font-semibold ${isMatch ? 'text-green-800' : ''}`}>{u.uld_code}</span>
                      <span className={isMatch ? 'text-green-600' : 'text-gray-400'}>— {u.airline} / {u.flight_number} / {u.client_name}</span>
                    </label>
                  )
                })
              })()}
            </div>
            {pdfMatches.length > 0 && inWarehouse.length > pdfMatches.length && (
              <button type="button" onClick={() => setShowAllUlds(v => !v)}
                className="text-[11px] text-blue-600 hover:underline">
                {showAllUlds ? 'Ocultar otros ULDs' : `Mostrar todos (${inWarehouse.length} en warehouse)`}
              </button>
            )}

            <textarea
              value={returnNotes}
              onChange={e => setReturnNotes(e.target.value)}
              placeholder="Notas (opcional)"
              rows={2}
              className="w-full px-3 py-2 text-xs border rounded-lg"
            />

            {/* If no PDF was uploaded yet, allow uploading proof here */}
            {!pdfFile && (
              <label className="inline-block px-3 py-1.5 bg-gray-100 text-gray-600 text-xs rounded-lg cursor-pointer hover:bg-gray-200 border">
                Adjuntar comprobante
                <input
                  ref={proofInputRef}
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png,.webp"
                  className="hidden"
                  onChange={e => {
                    const f = e.target.files?.[0]
                    if (f) setPdfFile(f)
                  }}
                />
              </label>
            )}
            {pdfFile && (
              <div className="text-xs text-gray-500">
                Comprobante: {pdfFile.name}
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={handleSaveReturn}
                disabled={saving || selectedUlds.size === 0}
                className="px-4 py-2 bg-green-600 text-white text-xs font-semibold rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors"
              >
                {saving ? 'Guardando...' : 'Confirmar Devolución'}
              </button>
              <button
                onClick={() => { setShowReturnForm(false); setSelectedUlds(new Set()); setPdfMatches([]); setPdfExtractedText(null); setPdfExtractedDate(null); setPdfAllCodes([]); setShowAllUlds(false) }}
                className="px-4 py-2 bg-gray-200 text-gray-600 text-xs font-semibold rounded-lg hover:bg-gray-300 transition-colors"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        {/* ── ULD Inventory table ───────────────────────────────────────────── */}
        {(() => {
          // Group filtered ULDs: in_warehouse first, then returned grouped by return_id
          const warehouseUlds = filtered.filter(u => u.status === 'in_warehouse')
          const returnedUlds = filtered.filter(u => u.status === 'returned')

          // Group returned by return_id
          const returnGroups = new Map<string, typeof returnedUlds>()
          returnedUlds.forEach(u => {
            const gid = u.return_id || '_ungrouped'
            if (!returnGroups.has(gid)) returnGroups.set(gid, [])
            returnGroups.get(gid)!.push(u)
          })

          const colCount = (showReturnForm || showGenerateReturn || showDeleteMode) ? 10 : 9

          return (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wider">
                      {(showReturnForm || showGenerateReturn || showDeleteMode) && <th className="px-3 py-2 text-center w-8"></th>}
                      <th className="px-4 py-2 text-left">ULD Code</th>
                      <th className="px-4 py-2 text-left">ULD Air</th>
                      <th className="px-4 py-2 text-left">Aerolínea</th>
                      <th className="px-4 py-2 text-left">Vuelo</th>
                      <th className="px-4 py-2 text-left">Fecha Vuelo</th>
                      <th className="px-4 py-2 text-left">Cliente</th>
                      <th className="px-4 py-2 text-left">AWB</th>
                      <th className="px-4 py-2 text-center">Estado</th>
                      <th className="px-4 py-2 text-left">Fecha Devolución</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 ? (
                      <tr>
                        <td colSpan={colCount} className="text-center py-10 text-gray-400 text-sm">
                          No se encontraron ULDs
                        </td>
                      </tr>
                    ) : (
                      <>
                        {/* In-warehouse rows */}
                        {warehouseUlds.map((u, idx) => (
                          <tr
                            key={u.uld_code + idx}
                            className={`border-t border-gray-100 hover:bg-gray-50 ${
                              pdfMatches.includes(u.uld_code) ? 'bg-indigo-50' : ''
                            } ${showGenerateReturn && genSelectedUlds.has(u.uld_code) ? 'bg-blue-50' : ''} ${showDeleteMode && deleteSelectedUlds.has(u.uld_code) ? 'bg-red-50' : ''}`}
                          >
                            {showReturnForm && (
                              <td className="px-3 py-2 text-center">
                                <input
                                  type="checkbox"
                                  checked={selectedUlds.has(u.uld_code)}
                                  onChange={() => toggleUld(u.uld_code)}
                                />
                              </td>
                            )}
                            {showGenerateReturn && (
                              <td className="px-3 py-2 text-center">
                                <input
                                  type="checkbox"
                                  checked={genSelectedUlds.has(u.uld_code)}
                                  onChange={() => toggleGenUld(u.uld_code)}
                                />
                              </td>
                            )}
                            {showDeleteMode && (
                              <td className="px-3 py-2 text-center">
                                <input
                                  type="checkbox"
                                  checked={deleteSelectedUlds.has(u.uld_code)}
                                  onChange={() => toggleDeleteUld(u.uld_code)}
                                />
                              </td>
                            )}
                            <td className="px-4 py-2 font-mono font-semibold text-sm">{u.uld_code}</td>
                            <td className="px-4 py-2 text-xs">{u.uld_airline}</td>
                            <td className="px-4 py-2 text-xs">{u.airline}</td>
                            <td className="px-4 py-2 text-xs">{u.flight_number}</td>
                            <td className="px-4 py-2 text-xs">{u.flight_date}</td>
                            <td className="px-4 py-2 text-xs">{u.client_name}</td>
                            <td className="px-4 py-2 text-xs font-mono">{u.awb}</td>
                            <td className="px-4 py-2 text-center">
                              <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                                En Warehouse
                              </span>
                            </td>
                            <td className="px-4 py-2 text-xs text-gray-300">—</td>
                          </tr>
                        ))}

                        {/* Returned rows — grouped by comprobante */}
                        {Array.from(returnGroups.entries()).map(([gid, group], groupIdx) => {
                          const firstReturn = returns.find(r => r.id === gid)
                          const rows: JSX.Element[] = []

                          // Separator
                          if (warehouseUlds.length > 0 || groupIdx > 0) {
                            rows.push(
                              <tr key={`sep_${gid}`}>
                                <td colSpan={colCount} className="h-3 bg-white border-none" />
                              </tr>
                            )
                          }

                          // ULD rows
                          group.forEach(u => {
                            rows.push(
                              <tr key={u.uld_code + gid} className="border-t border-gray-200 bg-gray-100">
                                {(showReturnForm || showGenerateReturn || showDeleteMode) && <td className="px-3 py-2 bg-gray-100" />}
                                <td className="px-4 py-2 font-mono font-semibold text-sm bg-gray-100">{u.uld_code}</td>
                                <td className="px-4 py-2 text-xs bg-gray-100">{u.uld_airline}</td>
                                <td className="px-4 py-2 text-xs bg-gray-100">{u.airline}</td>
                                <td className="px-4 py-2 text-xs bg-gray-100">{u.flight_number}</td>
                                <td className="px-4 py-2 text-xs bg-gray-100">{u.flight_date}</td>
                                <td className="px-4 py-2 text-xs bg-gray-100">{u.client_name}</td>
                                <td className="px-4 py-2 text-xs font-mono bg-gray-100">{u.awb}</td>
                                <td className="px-4 py-2 text-center bg-gray-100">
                                  <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-green-100 text-green-700">
                                    Devuelto
                                  </span>
                                </td>
                                <td className="px-4 py-2 text-xs text-gray-600 bg-gray-100">
                                  {u.returned_at ? new Date(u.returned_at).toLocaleDateString() : '—'}
                                </td>
                              </tr>
                            )
                          })

                          // Orphan ULDs for this return group (not in any booking)
                          const groupOrphans = orphansByReturn.get(gid) || []
                          groupOrphans.forEach((o, oi) => {
                            rows.push(
                              <tr key={`orphan_${gid}_${oi}`} className="border-t border-amber-200 bg-amber-50">
                                {(showReturnForm || showGenerateReturn || showDeleteMode) && <td className="px-3 py-2 bg-amber-50" />}
                                <td className="px-4 py-2 font-mono font-semibold text-sm bg-amber-50 text-amber-800">{o.code}</td>
                                <td className="px-4 py-2 text-xs bg-amber-50 text-amber-500">—</td>
                                <td className="px-4 py-2 text-xs bg-amber-50 text-amber-500">—</td>
                                <td className="px-4 py-2 text-xs bg-amber-50 text-amber-600 font-semibold italic">Sin vuelo</td>
                                <td className="px-4 py-2 text-xs bg-amber-50 text-amber-500">—</td>
                                <td className="px-4 py-2 text-xs bg-amber-50">
                                  <select
                                    value={o.client_name}
                                    onChange={async (e) => {
                                      const val = e.target.value
                                      if (o.return_id && o.return_id !== '_ungrouped') {
                                        const key = o.code.trim().toUpperCase()
                                        const retRef = doc(db, 'uld_returns', o.return_id)
                                        const retSnap = await getDoc(retRef)
                                        const existing = retSnap.exists() ? (retSnap.data().orphan_clients || {}) : {}
                                        existing[key] = val
                                        await updateDoc(retRef, { orphan_clients: existing })
                                      }
                                    }}
                                    className="text-xs bg-amber-50 border border-amber-300 rounded px-1 py-0.5 text-amber-800 cursor-pointer hover:bg-amber-100"
                                  >
                                    <option value="">— Asignar —</option>
                                    {clients.map(c => (
                                      <option key={c} value={c}>{c}</option>
                                    ))}
                                  </select>
                                </td>
                                <td className="px-4 py-2 text-xs bg-amber-50 text-amber-500">—</td>
                                <td className="px-4 py-2 text-center bg-amber-50">
                                  <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-green-100 text-green-700">
                                    Devuelto
                                  </span>
                                </td>
                                <td className="px-4 py-2 text-xs text-amber-600 bg-amber-50">
                                  {o.returned_at ? new Date(o.returned_at).toLocaleDateString() : '—'}
                                </td>
                              </tr>
                            )
                          })

                          // Proof row
                          if (firstReturn) {
                            rows.push(
                              <tr key={`proof_${gid}`} className="border-b-2 border-gray-300">
                                <td colSpan={colCount} className="px-4 py-2 bg-gray-100">
                                  <div className="flex items-center gap-3">
                                    {firstReturn.proof_url && (
                                      <a
                                        href={firstReturn.proof_url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-xs text-indigo-600 hover:underline font-medium"
                                      >
                                        Ver comprobante
                                      </a>
                                    )}
                                    <span className="text-xs text-gray-400">
                                      {new Date(firstReturn.returned_at).toLocaleString()} — {firstReturn.returned_by}
                                      {firstReturn.notes && <span className="ml-1">({firstReturn.notes})</span>}
                                    </span>
                                    {isMcl && (
                                      <button
                                        onClick={() => handleDeleteReturn(firstReturn.id!)}
                                        className="text-xs text-red-400 hover:text-red-600 ml-auto"
                                        title="Eliminar devolución"
                                      >
                                        ✕
                                      </button>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )
                          }

                          return rows
                        })}
                      </>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )
        })()}

      </div>
    </Layout>
  )
}
