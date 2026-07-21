import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  collection, query, orderBy, onSnapshot, where, doc, getDoc, getDocs, updateDoc,
} from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import {
  AirfreightBooking, AirfreightFlight, AirfreightClient,
  AirfreightDocumentFile, AwbSecondLeg, AuditLogEntry, DeliveryOrder,
} from '../../types'
import Layout from '../../components/Layout'
import { fmtNum, storagePath, storagePathFlight } from '../../lib/utils'
import { generatePalletControlOnTheFly } from '../../lib/buildupPdf'

// ── Helpers ──────────────────────────────────────────────────────────────────

function hasDoc(d?: AirfreightDocumentFile) {
  return !!(d && d.url)
}

function sanitizeLines(lines: any[]): any[] {
  return lines.map(line => JSON.parse(JSON.stringify(line)))
}

// Read the flight-level Import AWB files. Supports both the new multi-file
// array field and the legacy single-doc field.
function getFlightImportAwbs(flight: AirfreightFlight | undefined): AirfreightDocumentFile[] {
  if (!flight) return []
  const arr = (flight as any).doc_import_awb_files as AirfreightDocumentFile[] | undefined
  if (arr && arr.length > 0) return arr
  const single = (flight as any).doc_import_awb as AirfreightDocumentFile | undefined
  if (single?.url) return [single]
  return []
}

// Collect every document file attached to a row (legacy per-type slots
// + ecommerce bulk-upload bucket + flight-level Import AWBs). Used by the
// row-level print button.
function collectRowDocs(row: AwbLogRow): AirfreightDocumentFile[] {
  const out: AirfreightDocumentFile[] = []
  const push = (d?: AirfreightDocumentFile) => { if (hasDoc(d)) out.push(d!) }
  push(row.doc7512)
  push(row.docHawb)
  push(row.docDoTsa)
  push(row.docCcsf)
  for (const f of (row.docCcsfFiles || [])) {
    if (hasDoc(f) && !out.some(o => o.url === f.url)) out.push(f)
  }
  push(row.docAcceptance)
  push(row.docWhr)
  push(row.docMclTransfer)
  push(row.docScreeningCert)
  push(row.docManifesto)
  push(row.docDistribucion)
  push(row.docImportAwb)
  push(row.docLbChecklist)
  for (const f of (row.docLbChecklistFiles || [])) {
    if (hasDoc(f) && !out.some(o => o.url === f.url)) out.push(f)
  }
  return out
}

// Open every document in a new tab so the user can print them. This is the
// most reliable cross-browser approach — PDFs/images open in the browser
// viewer which already has a print button.
function printRowDocs(row: AwbLogRow) {
  const files = collectRowDocs(row)
  if (files.length === 0) {
    alert('Esta guía no tiene documentos para imprimir.')
    return
  }
  for (const f of files) {
    window.open(f.url, '_blank', 'noopener,noreferrer')
  }
}

/** Read multi-file docs array from booking (array field with single-doc fallback) */
function getBookingMultiFiles(b: AirfreightBooking, key: string): AirfreightDocumentFile[] {
  const docs = (b.documents || {}) as Record<string, unknown>
  const arr = docs[`${key}_files`] as AirfreightDocumentFile[] | undefined
  if (arr && arr.length > 0) return arr
  const single = docs[key] as AirfreightDocumentFile | undefined
  if (single?.url) return [single]
  return []
}

/** Read multi-file docs array from flight (array field with single-doc fallback) */
function getFlightDocFiles(flight: AirfreightFlight | undefined, key: string): AirfreightDocumentFile[] {
  if (!flight) return []
  const fl = flight as Record<string, unknown>
  const arr = fl[`${key}_files`] as AirfreightDocumentFile[] | undefined
  if (arr && arr.length > 0) return arr
  const single = fl[key] as AirfreightDocumentFile | undefined
  if (single?.url) return [single]
  return []
}

function fmtEtd(dateStr: string) {
  if (!dateStr) return '—'
  const dt = new Date(dateStr)
  if (isNaN(dt.getTime())) return dateStr
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const dd = String(dt.getDate()).padStart(2, '0')
  const yy = String(dt.getFullYear()).slice(2)
  const hh = String(dt.getHours()).padStart(2, '0')
  const min = String(dt.getMinutes()).padStart(2, '0')
  return `${mm}/${dd}/${yy} ${hh}:${min}`
}

// ── Row type (one per AWB line) ──────────────────────────────────────────────

interface AwbLogRow {
  // identifiers
  bookingId: string
  awbIndex: number
  flightId: string
  bookingType: 'simple' | 'mawb' | 'ecommerce' | 'export'
  isMawbHeader?: boolean  // synthetic row for MAWB-level data
  // text columns
  mawb: string
  awb1stLeg: string
  awb2ndLeg: string
  clientName: string
  agentName?: string | null
  clientId: string
  airline: string
  flightNumber: string
  etd: string
  destination: string
  pieces: number
  chargeableWeight: number
  hold: boolean | 'pending'
  // document references (existing system docs)
  doc7512?: AirfreightDocumentFile
  docHawb?: AirfreightDocumentFile
  docDoTsa?: AirfreightDocumentFile
  docCcsf?: AirfreightDocumentFile
  docCcsfFiles?: AirfreightDocumentFile[]  // multi-file CCSF (synced with AirfreightDocs)
  docDoTsaFiles?: AirfreightDocumentFile[]  // flight-level DO/TSA multi-file
  docMclTransferFiles?: AirfreightDocumentFile[]  // booking-level MCL Transfer multi-file (MAWB)
  // screening status from booking (for color indicator)
  screeningStatus?: 'pending' | 'partial' | 'complete' | 'error'
  // new manual upload docs
  docAcceptance?: AirfreightDocumentFile
  docWhr?: AirfreightDocumentFile
  docMclTransfer?: AirfreightDocumentFile
  // MAWB doc (booking-level AWB for MAWB bookings)
  docMawb?: AirfreightDocumentFile
  // screening
  docScreeningCert?: AirfreightDocumentFile
  screeningDetails?: AwbSecondLeg['screening_details']
  // Ecommerce bulk-upload bucket + checks (BookingList single-block flow)
  docUploads?: AirfreightDocumentFile[]
  docChecks?: {
    awb?: boolean
    doc_7512?: boolean
    do_tsa?: boolean
  }
  // Line-level docs (ecommerce)
  docManifesto?: AirfreightDocumentFile
  docDistribucion?: AirfreightDocumentFile
  docImportAwb?: AirfreightDocumentFile
  // LB Checklist (lithium battery) — only shown when battery flag is true
  battery?: boolean
  docLbChecklist?: AirfreightDocumentFile         // line-level single file
  docLbChecklistFiles?: AirfreightDocumentFile[]   // MAWB header multi-file
  // Flight-level Import AWB files (ecommerce). When non-empty, the Imp AWB
  // semáforo turns green and clicking opens this file list.
  importAwbFiles?: AirfreightDocumentFile[]
}

interface FlightGroup {
  // Grouping key — per flight AND per client (so we can show client name in
  // the gray header row when all AWBs below belong to the same client).
  groupKey: string
  flightId: string
  flightNumber: string
  airline: string
  etd: string
  destinations: string[]
  clientName: string
  rows: AwbLogRow[]
  docDistribucion?: AirfreightDocumentFile
  docDistribucionFiles?: AirfreightDocumentFile[]
  flightStatus?: string
}

// Manual-upload document types
const MANUAL_DOC_TYPES = [
  { field: 'doc_acceptance' as const, label: 'Acceptance' },
  { field: 'doc_mcl_transfer' as const, label: 'MCL Screening Transfer' },
] as const

type ManualDocField = typeof MANUAL_DOC_TYPES[number]['field']

// ── Component ────────────────────────────────────────────────────────────────

export default function AirfreightAwbLog() {
  const { user, isAdmin, isSuperAgent, isAgent, isCounter, isBodega, isClient, clientId } = useAuth()
  const navigate = useNavigate()
  const isMcl = isAdmin || isSuperAgent || isAgent || isCounter || isBodega

  const [rows, setRows] = useState<AwbLogRow[]>([])
  const [clients, setClients] = useState<(AirfreightClient & { id: string })[]>([])
  const [loading, setLoading] = useState(true)
  const [daysBack, setDaysBack] = useState(10)

  // Raw data maps — used to build audit timeline for a specific AWB
  const [bookingsMap, setBookingsMap] = useState<Map<string, AirfreightBooking & { id: string }>>(new Map())
  const [flightsMap, setFlightsMap] = useState<Map<string, AirfreightFlight & { id: string }>>(new Map())
  // Doc receptions map: normalized AWB -> doc receptions array (for audit timeline)
  const [docReceptionsMap, setDocReceptionsMap] = useState<Map<string, { id: string; awb_number: string; status: string; pieces: number; weight: number; chargeable_weight: number; warehouse_number: string; created_at: string; created_by: string; updated_at?: string }[]>>(new Map())

  // Filters
  const [filterClient, setFilterClient] = useState('')
  const [filterHold, setFilterHold] = useState<'' | 'Y' | 'N' | 'P'>('')
  const [searchText, setSearchText] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  // Upload state
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const pendingUpload = useRef<{ bookingId: string; awbIndex: number; field: ManualDocField } | null>(null)

  // Generic doc upload state (for booking-level, flight-level, and line-level uploads)
  const genericInputRef = useRef<HTMLInputElement>(null)
  const [genericUploading, setGenericUploading] = useState(false)
  const [generatingPC, setGeneratingPC] = useState<string | null>(null) // flightId being generated
  type GenericUploadCtx =
    | { target: 'booking_multi'; bookingId: string; key: string; row: AwbLogRow }
    | { target: 'booking_single'; bookingId: string; key: string; row: AwbLogRow }
    | { target: 'flight_multi'; flightId: string; key: string; row: AwbLogRow }
    | { target: 'line_doc'; bookingId: string; awbIndex: number; key: string; row: AwbLogRow }
    | { target: 'line_multi'; bookingId: string; awbIndex: number; key: string; row: AwbLogRow }
  const pendingGenericUpload = useRef<GenericUploadCtx | null>(null)

  // Screening details modal
  const [screeningModal, setScreeningModal] = useState<AwbLogRow | null>(null)

  // Bucket viewer modal (ecommerce bulk-upload files)
  const [bucketModal, setBucketModal] = useState<AwbLogRow | null>(null)
  const openBucket = (row: AwbLogRow) => setBucketModal(row)

  // DO existence map — key = `${bookingId}::${awbIndex}`, value = array of DOs
  const [doExistsMap, setDoExistsMap] = useState<Map<string, { id: string; do_number: string; trucking: string }[]>>(new Map())

  // Generic file list modal (used for flight-level Import AWBs)
  const [fileListModal, setFileListModal] = useState<{ title: string; files: AirfreightDocumentFile[]; onUpload?: () => void; onDelete?: (fileIndex: number) => Promise<void> } | null>(null)
  const openFileList = (title: string, files: AirfreightDocumentFile[], onUpload?: () => void, onDelete?: (fileIndex: number) => Promise<void>) => setFileListModal({ title, files, onUpload, onDelete })

  // ── Load clients ──
  useEffect(() => {
    const q = query(collection(db, 'airfreight_clients'), orderBy('name'))
    return onSnapshot(q, snap => {
      setClients(snap.docs.map(d => ({ ...d.data() as AirfreightClient, id: d.id })).filter(c => c.active !== false))
    })
  }, [])

  // ── Load flights + bookings ──
  useEffect(() => {
    // Use dateFrom filter when set (user wants a specific range), otherwise default daysBack
    let cutoffISO: string
    if (dateFrom) {
      cutoffISO = new Date(dateFrom).toISOString()
    } else {
      const cutoff = new Date()
      cutoff.setDate(cutoff.getDate() - daysBack)
      cutoffISO = cutoff.toISOString()
    }

    // Server-side date filter on flights
    const flightsConstraints: any[] = [orderBy('flight_datetime', 'desc')]
    if (cutoffISO) {
      flightsConstraints.unshift(where('flight_datetime', '>=', cutoffISO))
    }
    const fQ = query(collection(db, 'airfreight_flights'), ...flightsConstraints)

    let unsubBookings: (() => void) | null = null

    const unsubFlights = onSnapshot(fQ, fSnap => {
      // Build map with ALL flights so no booking loses its flight reference
      const allFlights = fSnap.docs.map(d => ({ ...d.data() as AirfreightFlight, id: d.id }))
      const flightMap = new Map(allFlights.map(f => [f.id!, f]))
      setFlightsMap(new Map(allFlights.map(f => [f.id!, { ...f, id: f.id! }])))

      let bQ = isClient && clientId
        ? query(collection(db, 'airfreight_bookings'), where('client_id', '==', clientId))
        : query(collection(db, 'airfreight_bookings'), orderBy('created_at', 'desc'))

      if (unsubBookings) unsubBookings()

      unsubBookings = onSnapshot(bQ, bSnap => {
        const logRows: AwbLogRow[] = []

        for (const bDoc of bSnap.docs) {
          const b = { ...bDoc.data() as AirfreightBooking, id: bDoc.id }
          const flight = flightMap.get(b.flight_id)
          if (!flight) continue

          // Include flight if open OR within date window (same logic as Dashboard)
          if (flight.status !== 'open' && flight.flight_datetime < cutoffISO) continue

          if (b.booking_type === 'mawb' && b.awb_lines) {
            // MAWB header row — booking-level data with all doc columns
            const totalPcs = b.awb_lines.reduce((s, l) => s + (l.pieces || 0), 0)
            const totalChw = b.awb_lines.reduce((s, l) => s + (l.chargeable_weight || 0), 0)
            logRows.push({
              bookingId: b.id!,
              awbIndex: -1,
              flightId: b.flight_id,
              bookingType: b.booking_type,
              isMawbHeader: true,
              mawb: b.mawb_number || '',
              awb1stLeg: '',
              awb2ndLeg: '',
              clientName: b.client_name,
              agentName: b.agent_name || null,
              clientId: b.client_id,
              airline: b.airline || flight.airline || '',
              flightNumber: flight.flight_number || '',
              etd: flight.flight_datetime || '',
              destination: b.destination_id || '',
              pieces: totalPcs,
              chargeableWeight: totalChw,
              hold: b.awb_lines.some(l => l.hold === true) ? true : b.awb_lines.some(l => l.hold === 'pending') ? 'pending' as const : false,
              // Booking-level docs
              doc7512: undefined,
              docHawb: undefined,
              docDoTsa: flight.doc_do_tsa || b.documents?.doc_do_tsa,
              docDoTsaFiles: getFlightDocFiles(flight, 'doc_do_tsa'),
              docCcsf: b.documents?.doc_ccsf,
              docCcsfFiles: getBookingMultiFiles(b, 'doc_ccsf'),
              docAcceptance: undefined,
              docWhr: b.documents?.doc_whr,
              docMawb: b.documents?.doc_mawb_def || b.documents?.doc_mawb_draft,
              docMclTransfer: undefined,
              docMclTransferFiles: getBookingMultiFiles(b, 'doc_mcl_transfer'),
              docScreeningCert: undefined,
              screeningDetails: undefined,
              screeningStatus: b.screening_status as any,
              docManifesto: (flight as any).doc_manifesto,
              docDistribucion: (flight as any).doc_distribucion,
              flightStatus: (flight as any).flight_status,
              battery: b.awb_lines!.some(l => l.battery),
              docLbChecklistFiles: getBookingMultiFiles(b, 'doc_lb_checklist'),
            })
            // AWB child rows (no booking-level docs)
            b.awb_lines.forEach((line, idx) => {
              logRows.push({
                bookingId: b.id!,
                awbIndex: idx,
                flightId: b.flight_id,
                bookingType: b.booking_type,
                mawb: b.mawb_number || '',
                awb1stLeg: line.awb_number || '',
                awb2ndLeg: line.awb_2nd_leg || '',
                clientName: b.client_name,
                agentName: b.agent_name || null,
                clientId: b.client_id,
                airline: b.airline || flight.airline || '',
                flightNumber: flight.flight_number || '',
                etd: flight.flight_datetime || '',
                destination: b.destination_id || '',
                pieces: line.pieces || 0,
                chargeableWeight: line.chargeable_weight || 0,
                hold: line.hold === true ? true : line.hold === 'pending' ? 'pending' as const : false,
                doc7512: line.documents?.doc_7512,
                docHawb: line.documents?.doc_hawb,
                docDoTsa: undefined,
                docCcsf: undefined,
                docAcceptance: line.doc_acceptance,
                docWhr: line.doc_whr,
                docMclTransfer: undefined,
                docScreeningCert: line.doc_screening_cert,
                screeningDetails: line.screening_details,
                battery: line.battery,
                docLbChecklist: line.documents?.doc_lb_checklist,
              })
            })
          } else if (b.booking_type === 'ecommerce' && b.awb_lines) {
            // Ecommerce: flat rows, all columns per AWB (like Express Line)
            b.awb_lines.forEach((line, idx) => {
              logRows.push({
                bookingId: b.id!,
                awbIndex: idx,
                flightId: b.flight_id,
                bookingType: b.booking_type,
                mawb: b.mawb_number || '',
                awb1stLeg: line.awb_number || '',
                awb2ndLeg: line.awb_2nd_leg || '',
                clientName: b.client_name,
                agentName: b.agent_name || null,
                clientId: b.client_id,
                airline: b.airline || flight.airline || '',
                flightNumber: flight.flight_number || '',
                etd: flight.flight_datetime || '',
                destination: b.destination_id || '',
                pieces: line.pieces || 0,
                chargeableWeight: line.chargeable_weight || 0,
                hold: line.hold === true ? true : line.hold === 'pending' ? 'pending' as const : false,
                doc7512: line.documents?.doc_7512,
                docHawb: line.documents?.doc_hawb,
                docDoTsa: line.documents?.doc_do_tsa,
                docCcsf: line.documents?.doc_ccsf,
                docAcceptance: line.doc_acceptance,
                docWhr: line.doc_whr,
                docMclTransfer: line.doc_mcl_transfer,
                docMclTransferFiles: line.doc_mcl_transfer_files || [],
                docScreeningCert: line.doc_screening_cert,
                screeningDetails: line.screening_details,
                screeningStatus: (line.screening_status as any) || undefined,
                docManifesto: line.documents?.doc_manifesto,
                docDistribucion: (flight as any).doc_distribucion,
              flightStatus: (flight as any).flight_status,
                docImportAwb: line.documents?.doc_import_awb,
                battery: line.battery,
                docLbChecklist: line.documents?.doc_lb_checklist,
              })
            })
          } else if (b.booking_type === 'simple') {
            // Detect if this is a "new simple" flight (no legacy flight-level DO/TSA or Manifesto)
            const hasLegacyFlightDocs = (flight as any).doc_do_tsa_files?.length > 0 || !!(flight as any).doc_do_tsa?.url ||
              (flight as any).doc_manifesto_files?.length > 0 || !!(flight as any).doc_manifesto?.url
            logRows.push({
              bookingId: b.id!,
              awbIndex: 0,
              flightId: b.flight_id,
              bookingType: 'simple',
              mawb: '',
              awb1stLeg: b.awb_1st_leg || '',
              awb2ndLeg: b.awb_2nd_leg || '',
              clientName: b.client_name,
              agentName: b.agent_name || null,
              clientId: b.client_id,
              airline: b.airline || flight.airline || '',
              flightNumber: flight.flight_number || '',
              etd: flight.flight_datetime || '',
              destination: b.destination_id || '',
              pieces: b.pieces || 0,
              chargeableWeight: b.chargeable_weight || 0,
              hold: b.hold === true ? true : b.hold === 'pending' ? 'pending' as const : false,
              doc7512: b.documents?.doc_7512,
              docHawb: b.documents?.doc_hawb,
              docDoTsa: hasLegacyFlightDocs ? (flight.doc_do_tsa || b.documents?.doc_do_tsa) : b.documents?.doc_do_tsa,
              docDoTsaFiles: hasLegacyFlightDocs ? getFlightDocFiles(flight, 'doc_do_tsa') : [],
              docCcsf: b.documents?.doc_ccsf,
              docCcsfFiles: getBookingMultiFiles(b, 'doc_ccsf'),
              docAcceptance: b.documents?.doc_acceptance,
              docWhr: b.documents?.doc_whr,
              docMclTransfer: (b as any).doc_mcl_transfer,
              docMclTransferFiles: getBookingMultiFiles(b, 'doc_mcl_transfer'),
              docScreeningCert: (b as any).doc_screening_cert,
              screeningDetails: (b as any).screening_details,
              screeningStatus: (b as any).screening_status || undefined,
              docManifesto: hasLegacyFlightDocs ? (flight as any).doc_manifesto : b.documents?.doc_manifesto,
              docDistribucion: (flight as any).doc_distribucion,
              flightStatus: (flight as any).flight_status,
              battery: (b as any).battery,
              docLbChecklist: b.documents?.doc_lb_checklist,
              docImportAwb: b.documents?.doc_import_awb,
            })
          } else if (b.booking_type === 'export' && b.awb_lines) {
            // Export: flat rows from awb_lines, no header row, no MAWB
            b.awb_lines.forEach((line, idx) => {
              logRows.push({
                bookingId: b.id!,
                awbIndex: idx,
                flightId: b.flight_id,
                bookingType: 'export',
                mawb: '',
                awb1stLeg: line.awb_number || '',
                awb2ndLeg: '',
                clientName: b.client_name,
                agentName: b.agent_name || null,
                clientId: b.client_id,
                airline: b.airline || flight.airline || '',
                flightNumber: flight.flight_number || '',
                etd: flight.flight_datetime || '',
                destination: (line as any).destination || b.destination_id || '',
                pieces: line.pieces || 0,
                chargeableWeight: line.chargeable_weight || 0,
                hold: line.hold === true ? true : line.hold === 'pending' ? 'pending' as const : false,
                doc7512: (line.cargo_sub_type === 'bonded' || line.cargo_sub_type === 'bonded_local') ? line.documents?.doc_7512 : undefined,
                docHawb: line.documents?.doc_hawb,
                docDoTsa: (line.documents as Record<string, any> | undefined)?.doc_do_tsa || (line.documents as Record<string, any> | undefined)?.doc_tsa_letter,
                docCcsf: (line.documents as Record<string, any> | undefined)?.doc_ccsf,
                docAcceptance: line.doc_acceptance,
                docWhr: line.doc_whr,
                docMclTransfer: line.doc_mcl_transfer,
                docMclTransferFiles: line.doc_mcl_transfer_files || [],
                docManifesto: (flight as any).doc_manifesto,
                docDistribucion: (flight as any).doc_distribucion,
              flightStatus: (flight as any).flight_status,
                docScreeningCert: undefined,
                screeningDetails: undefined,
                battery: line.battery,
                docLbChecklist: line.documents?.doc_lb_checklist,
              })
            })
          }
        }

        // Store raw booking data for audit timeline
        const bMap = new Map<string, AirfreightBooking & { id: string }>()
        for (const bDoc of bSnap.docs) {
          const b = { ...bDoc.data() as AirfreightBooking, id: bDoc.id }
          bMap.set(bDoc.id, b)
        }
        setBookingsMap(bMap)

        setRows(logRows)
        setLoading(false)
      })
    })

    return () => {
      unsubFlights()
      if (unsubBookings) unsubBookings()
    }
  }, [daysBack, dateFrom, isClient, clientId])

  // ── Load doc receptions for audit timeline ──
  useEffect(() => {
    if (rows.length === 0) { setDocReceptionsMap(new Map()); return }
    // Collect all AWB numbers from rows (normalized)
    const awbSet = new Set<string>()
    for (const r of rows) {
      if (r.awb1stLeg) awbSet.add(r.awb1stLeg.replace(/[\s\-]/g, '').toUpperCase())
      if (r.awb2ndLeg) awbSet.add(r.awb2ndLeg.replace(/[\s\-]/g, '').toUpperCase())
    }
    if (awbSet.size === 0) { setDocReceptionsMap(new Map()); return }
    const drQ = query(collection(db, 'airfreight_doc_receptions'), orderBy('created_at', 'desc'))
    return onSnapshot(drQ, snap => {
      const drMap = new Map<string, typeof docReceptionsMap extends Map<string, infer V> ? V : never>()
      for (const d of snap.docs) {
        const data = d.data()
        const norm = (s: string) => (s || '').replace(/[\s\-]/g, '').toUpperCase()
        const keys = [norm(data.awb_number), norm(data.awb_2nd_leg), norm(data.awb_1st_leg)].filter(Boolean)
        const matched = keys.some(k => awbSet.has(k))
        if (!matched) continue
        const entry = {
          id: d.id,
          awb_number: data.awb_number || '',
          status: data.status || '',
          pieces: data.pieces || 0,
          weight: data.weight || 0,
          chargeable_weight: data.chargeable_weight || 0,
          warehouse_number: data.warehouse_number || '',
          created_at: data.created_at || '',
          created_by: data.created_by || '',
          updated_at: data.updated_at,
        }
        for (const k of keys) {
          if (!awbSet.has(k)) continue
          const arr = drMap.get(k) || []
          arr.push(entry)
          drMap.set(k, arr)
        }
      }
      setDocReceptionsMap(drMap)
    })
  }, [rows.length])

  // ── Load DO existence map for ecommerce + mawb rows ──
  useEffect(() => {
    const relevantBookingIds = new Set<string>()
    for (const r of rows) {
      if (((r.bookingType === 'ecommerce' || r.bookingType === 'export') && r.awbIndex >= 0) || r.isMawbHeader) relevantBookingIds.add(r.bookingId)
    }
    if (relevantBookingIds.size === 0) { setDoExistsMap(new Map()); return }
    const ids = Array.from(relevantBookingIds)
    ;(async () => {
      const doMap = new Map<string, { id: string; do_number: string; trucking: string }[]>()
      const seenDocIds = new Set<string>()
      // Normalize incremental keys (e.g. "abc::0::1") back to base key ("abc::0")
      const toBaseKey = (key: string) => {
        const parts = key.split('::')
        return parts.length > 2 ? `${parts[0]}::${parts[1]}` : key
      }
      const addToMap = (key: string, entry: { id: string; do_number: string; trucking: string }) => {
        const base = toBaseKey(key)
        if (seenDocIds.has(entry.id)) return
        seenDocIds.add(entry.id)
        const arr = doMap.get(base) || []
        arr.push(entry)
        doMap.set(base, arr)
      }
      // Query by legacy booking_id field
      for (let i = 0; i < ids.length; i += 10) {
        const batch = ids.slice(i, i + 10)
        const doQ = query(collection(db, 'delivery_orders'), where('booking_id', 'in', batch))
        const doSnap = await getDocs(doQ)
        for (const d of doSnap.docs) {
          const data = d.data() as DeliveryOrder
          const entry = { id: d.id, do_number: data.do_number, trucking: data.trucking_company || '' }
          if (data.awb_keys && data.awb_keys.length > 0) {
            for (const key of data.awb_keys) addToMap(key, entry)
          } else {
            addToMap(`${data.booking_id}::${data.awb_index}`, entry)
          }
        }
      }
      // Query by awb_keys array-contains for rows not found via legacy query
      const keysToCheck = new Set<string>()
      for (const r of rows) {
        if (((r.bookingType === 'ecommerce' || r.bookingType === 'export') && r.awbIndex >= 0) || r.isMawbHeader) {
          const key = `${r.bookingId}::${r.isMawbHeader ? 0 : r.awbIndex}`
          if (!doMap.has(key)) keysToCheck.add(key)
        }
      }
      for (const awbKey of keysToCheck) {
        const doQ2 = query(collection(db, 'delivery_orders'), where('awb_keys', 'array-contains', awbKey))
        const doSnap2 = await getDocs(doQ2)
        for (const d of doSnap2.docs) {
          const data = d.data() as DeliveryOrder
          const entry = { id: d.id, do_number: data.do_number, trucking: data.trucking_company || '' }
          if (data.awb_keys) {
            for (const key of data.awb_keys) addToMap(key, entry)
          }
        }
      }
      setDoExistsMap(doMap)
    })()
  }, [rows])

  // ── Filtering ──

  const filtered = rows.filter(r => {
    if (filterClient && r.clientId !== filterClient) return false
    if (filterHold === 'Y' && r.hold !== true) return false
    if (filterHold === 'N' && r.hold !== false) return false
    if (filterHold === 'P' && r.hold !== 'pending') return false
    if (dateFrom && r.etd < dateFrom) return false
    if (dateTo && r.etd > dateTo + 'T23:59:59') return false
    if (searchText) {
      const s = searchText.toLowerCase()
      if (
        !r.mawb.toLowerCase().includes(s) &&
        !r.awb1stLeg.toLowerCase().includes(s) &&
        !r.awb2ndLeg.toLowerCase().includes(s) &&
        !r.clientName.toLowerCase().includes(s) &&
        !r.flightNumber.toLowerCase().includes(s)
      ) return false
    }
    return true
  })

  // ── Group by flight + client ──
  // We group per (flight, client) so the gray header row can display the
  // client once and the rows below drop their own Client column.

  const flightGroups: FlightGroup[] = (() => {
    const map = new Map<string, FlightGroup>()
    for (const r of filtered) {
      const groupKey = `${r.flightId}::${r.clientId || r.clientName}`
      let g = map.get(groupKey)
      if (!g) {
        const fl = flightsMap.get(r.flightId)
        g = {
          groupKey,
          flightId: r.flightId,
          flightNumber: r.flightNumber,
          airline: r.airline,
          etd: r.etd,
          destinations: [],
          clientName: r.clientName || '',
          rows: [],
          docDistribucion: (fl as any)?.doc_distribucion,
          docDistribucionFiles: (fl as any)?.doc_distribucion_files || [],
          flightStatus: (fl as any)?.flight_status,
        }
        map.set(groupKey, g)
      }
      g.rows.push(r)
      if (r.destination && !g.destinations.includes(r.destination)) {
        g.destinations.push(r.destination)
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      // Primary sort: ETD desc. Secondary: client name asc.
      const etdCmp = (b.etd || '').localeCompare(a.etd || '')
      if (etdCmp !== 0) return etdCmp
      return (a.clientName || '').localeCompare(b.clientName || '')
    })
  })()

  // ── Upload handler ──

  function triggerUpload(bookingId: string, awbIndex: number, field: ManualDocField) {
    pendingUpload.current = { bookingId, awbIndex, field }
    fileInputRef.current?.click()
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    const ctx = pendingUpload.current
    if (!file || !ctx || !user) return
    e.target.value = ''
    setUploading(true)
    try {
      const row = rows.find(r => r.bookingId === ctx.bookingId && r.awbIndex === ctx.awbIndex)
      const path = storagePath({ flightNumber: row?.flightNumber, flightDate: row?.etd, airline: row?.airline, clientName: row?.clientName, mawbNumber: row?.mawb, awbNumber: row?.awb1stLeg, filename: `${ctx.field}_${Date.now()}_${file.name}` })
      const storageRef = ref(storage, path)
      await uploadBytes(storageRef, file)
      const url = await getDownloadURL(storageRef)

      const newDoc: AirfreightDocumentFile = {
        url,
        filename: file.name,
        version: 1,
        uploaded_at: new Date().toISOString(),
        uploaded_by: (user as any).email || (user as any).uid || '',
        modified_seen: true,
        history: [],
      }

      const snap = await getDoc(doc(db, 'airfreight_bookings', ctx.bookingId))
      if (!snap.exists()) return
      const data = snap.data() as AirfreightBooking

      if (ctx.awbIndex >= 0 && data.awb_lines) {
        const lines = [...data.awb_lines]
        const docLabel = MANUAL_DOC_TYPES.find(d => d.field === ctx.field)?.label || ctx.field
        const auditEntry: AuditLogEntry = {
          action: 'doc_uploaded',
          detail: `${docLabel}: ${file.name}`,
          user: (user as any).email || (user as any).uid || '',
          at: new Date().toISOString(),
          field: ctx.field,
        }
        const existingLog = lines[ctx.awbIndex].audit_log || []
        lines[ctx.awbIndex] = { ...lines[ctx.awbIndex], [ctx.field]: newDoc, audit_log: [...existingLog, auditEntry] }
        await updateDoc(doc(db, 'airfreight_bookings', ctx.bookingId), { awb_lines: sanitizeLines(lines) })
      }
    } catch (err) {
      console.error('Upload error:', err)
    } finally {
      setUploading(false)
    }
  }

  // ── Generic doc upload (booking multi-file, booking single, flight multi-file, line doc) ──

  async function handleViewPalletControl(flightId: string) {
    if (generatingPC) return
    setGeneratingPC(flightId)
    try {
      const fl = flightsMap.get(flightId)
      if (!fl) return
      const blob = await generatePalletControlOnTheFly(
        flightId,
        { id: flightId, flight_number: fl.flight_number, airline: fl.airline, flight_datetime: fl.flight_datetime, destinations: fl.destinations },
        user?.email || '',
      )
      if (!blob) { alert('No hay ULDs con piezas asignadas para este vuelo.'); return }
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank')
    } catch (e) {
      console.error(e)
      alert('Error generando Pallet Control: ' + String(e))
    } finally {
      setGeneratingPC(null)
    }
  }

  function triggerGenericUpload(ctx: GenericUploadCtx) {
    pendingGenericUpload.current = ctx
    if (genericInputRef.current) {
      genericInputRef.current.multiple = ctx.target === 'booking_multi' || ctx.target === 'flight_multi' || ctx.target === 'line_multi'
      // Restrict file picker to PDF for document types used in Document Sets
      genericInputRef.current.accept = PDF_REQUIRED_KEYS.has(ctx.key) ? '.pdf' : '.pdf,.jpg,.jpeg,.png'
    }
    genericInputRef.current?.click()
  }

  // Document keys that are used in PDF Document Sets — must be PDF format
  const PDF_REQUIRED_KEYS = new Set(['doc_7512', 'doc_hawb', 'doc_do_tsa', 'doc_ccsf', 'doc_manifesto', 'doc_distribucion'])

  async function handleGenericFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const rawFiles = e.target.files
    const ctx = pendingGenericUpload.current
    if (!rawFiles || rawFiles.length === 0 || !ctx || !user) return
    // Snapshot the FileList into a plain array BEFORE clearing the input,
    // because setting value='' empties the live FileList reference.
    const isMulti = ctx.target === 'booking_multi' || ctx.target === 'flight_multi' || ctx.target === 'line_multi'
    const filesToProcess = isMulti ? Array.from(rawFiles) : [rawFiles[0]]
    e.target.value = ''

    // Validate PDF requirement for document types used in Document Sets
    if (PDF_REQUIRED_KEYS.has(ctx.key)) {
      const rejected = filesToProcess.filter(f => f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf'))
      if (rejected.length > 0) {
        alert(`Este documento (${ctx.key.replace('doc_', '').toUpperCase()}) se utiliza en la generación de Document Sets y debe ser un archivo PDF.\n\nArchivo(s) rechazado(s): ${rejected.map(f => f.name).join(', ')}\n\nPor favor suba un archivo PDF válido.`)
        return
      }
    }
    setGenericUploading(true)
    try {
      const row = ctx.row
      const userEmail = (user as any).email || (user as any).uid || ''

      const uploadedDocs: AirfreightDocumentFile[] = []
      for (const file of filesToProcess) {
        const newDoc: AirfreightDocumentFile = {
          url: '',
          filename: file.name,
          version: 1,
          uploaded_at: new Date().toISOString(),
          uploaded_by: userEmail,
          modified_seen: false,
          history: [],
        }
        if (ctx.target === 'booking_multi' || ctx.target === 'booking_single' || ctx.target === 'line_doc' || ctx.target === 'line_multi') {
          const path = storagePath({ flightNumber: row.flightNumber, flightDate: row.etd, airline: row.airline, clientName: row.clientName, mawbNumber: row.mawb, awbNumber: row.awb1stLeg, filename: `${ctx.key}_${Date.now()}_${file.name}` })
          const storageRef = ref(storage, path)
          await uploadBytes(storageRef, file)
          newDoc.url = await getDownloadURL(storageRef)
        } else if (ctx.target === 'flight_multi') {
          const path = storagePathFlight({ flightNumber: row.flightNumber, flightDate: row.etd, airline: row.airline, filename: `${ctx.key}_${Date.now()}_${file.name}` })
          const storageRef = ref(storage, path)
          await uploadBytes(storageRef, file)
          newDoc.url = await getDownloadURL(storageRef)
        }
        uploadedDocs.push(newDoc)
      }

      if (ctx.target === 'booking_multi') {
        const snap = await getDoc(doc(db, 'airfreight_bookings', ctx.bookingId))
        if (!snap.exists()) return
        const existing = getBookingMultiFiles(snap.data() as AirfreightBooking, ctx.key)
        await updateDoc(doc(db, 'airfreight_bookings', ctx.bookingId), {
          [`documents.${ctx.key}_files`]: [...existing, ...uploadedDocs],
        })
      } else if (ctx.target === 'booking_single') {
        await updateDoc(doc(db, 'airfreight_bookings', ctx.bookingId), {
          [`documents.${ctx.key}`]: uploadedDocs[0],
        })
      } else if (ctx.target === 'flight_multi') {
        const fSnap = await getDoc(doc(db, 'airfreight_flights', ctx.flightId))
        if (!fSnap.exists()) return
        const existing = getFlightDocFiles(fSnap.data() as AirfreightFlight, ctx.key)
        await updateDoc(doc(db, 'airfreight_flights', ctx.flightId), {
          [`${ctx.key}_files`]: [...existing, ...uploadedDocs],
        })
      } else if (ctx.target === 'line_doc') {
        const snap = await getDoc(doc(db, 'airfreight_bookings', ctx.bookingId))
        if (!snap.exists()) return
        const lines = [...((snap.data() as AirfreightBooking).awb_lines || [])]
        lines[ctx.awbIndex] = {
          ...lines[ctx.awbIndex],
          documents: { ...(lines[ctx.awbIndex].documents || {}), [ctx.key]: uploadedDocs[0] },
        }
        await updateDoc(doc(db, 'airfreight_bookings', ctx.bookingId), { awb_lines: sanitizeLines(lines) })
      } else if (ctx.target === 'line_multi') {
        const snap = await getDoc(doc(db, 'airfreight_bookings', ctx.bookingId))
        if (!snap.exists()) return
        const lines = [...((snap.data() as AirfreightBooking).awb_lines || [])]
        const existing = lines[ctx.awbIndex]?.[`${ctx.key}_files` as keyof typeof lines[0]] as AirfreightDocumentFile[] || []
        lines[ctx.awbIndex] = {
          ...lines[ctx.awbIndex],
          [`${ctx.key}_files`]: [...existing, ...uploadedDocs],
        }
        await updateDoc(doc(db, 'airfreight_bookings', ctx.bookingId), { awb_lines: sanitizeLines(lines) })
      }
    } catch (err) {
      console.error('Doc upload error:', err)
    } finally {
      setGenericUploading(false)
    }
  }

  // ── Generic multi-file delete (removes one file from a Firestore array) ──

  async function deleteMultiFile(target: 'booking_multi' | 'line_multi' | 'flight_multi', ids: { bookingId?: string; flightId?: string; awbIndex?: number; key: string }, fileIndex: number) {
    try {
      if (target === 'line_multi' && ids.bookingId != null && ids.awbIndex != null) {
        const snap = await getDoc(doc(db, 'airfreight_bookings', ids.bookingId))
        if (!snap.exists()) return
        const lines = [...((snap.data() as AirfreightBooking).awb_lines || [])]
        const existing: AirfreightDocumentFile[] = lines[ids.awbIndex]?.[`${ids.key}_files` as keyof typeof lines[0]] as any || []
        lines[ids.awbIndex] = { ...lines[ids.awbIndex], [`${ids.key}_files`]: existing.filter((_, i) => i !== fileIndex) }
        await updateDoc(doc(db, 'airfreight_bookings', ids.bookingId), { awb_lines: sanitizeLines(lines) })
      } else if (target === 'booking_multi' && ids.bookingId) {
        const snap = await getDoc(doc(db, 'airfreight_bookings', ids.bookingId))
        if (!snap.exists()) return
        const existing = getBookingMultiFiles(snap.data() as AirfreightBooking, ids.key)
        await updateDoc(doc(db, 'airfreight_bookings', ids.bookingId), {
          [`documents.${ids.key}_files`]: existing.filter((_, i) => i !== fileIndex),
        })
      } else if (target === 'flight_multi' && ids.flightId) {
        const fSnap = await getDoc(doc(db, 'airfreight_flights', ids.flightId))
        if (!fSnap.exists()) return
        const existing = getFlightDocFiles(fSnap.data() as AirfreightFlight, ids.key)
        await updateDoc(doc(db, 'airfreight_flights', ids.flightId), {
          [`${ids.key}_files`]: existing.filter((_, i) => i !== fileIndex),
        })
      }
      setFileListModal(null)
    } catch (err) {
      console.error('Delete file error:', err)
    }
  }

  // ── WHR PDF generator (on-demand from doc reception + physical pieces) ──

  function getCompleteDocReception(row: AwbLogRow) {
    const norm = (s: string) => (s || '').replace(/[\s\-]/g, '').toUpperCase()
    const keys = [norm(row.awb1stLeg), norm(row.awb2ndLeg)].filter(Boolean)
    for (const k of keys) {
      const drs = docReceptionsMap.get(k)
      if (drs) {
        const complete = drs.find(d => d.status === 'complete')
        if (complete) return complete
      }
    }
    return null
  }

  async function openWhrPdf(docReceptionId: string) {
    try {
      // Fetch full doc reception
      const drSnap = await getDoc(doc(db, 'airfreight_doc_receptions', docReceptionId))
      if (!drSnap.exists()) return
      const r = drSnap.data() as any

      // Fetch physical pieces
      const piecesSnap = await getDocs(query(
        collection(db, 'airfreight_physical_pieces'),
        where('doc_reception_id', '==', docReceptionId),
      ))
      const pieces = piecesSnap.docs
        .map(d => ({ id: d.id, ...d.data() } as any))
        .sort((a: any, b: any) => a.piece_number - b.piece_number)

      const totalWeight = pieces.reduce((s: number, p: any) => s + (p.weight_kg || 0), 0)
      const totalVolWeight = pieces.reduce((s: number, p: any) => {
        return s + ((p.length_cm || 0) * (p.width_cm || 0) * (p.height_cm || 0)) / 6000
      }, 0)
      const totalCBM = pieces.reduce((s: number, p: any) => {
        return s + ((p.length_cm || 0) * (p.width_cm || 0) * (p.height_cm || 0)) / 1_000_000
      }, 0)

      const warehouseNo = r.warehouse_number || (pieces.length > 0 ? (pieces[0].warehouse_number || '-') : '-')
      const awb = r.awb_2nd_leg || r.awb_number

      // Group identical pieces
      const grpMap = new Map<string, any[]>()
      for (const p of pieces) {
        const k = `${p.weight_kg}|${p.length_cm}|${p.width_cm}|${p.height_cm}|${p.packing_type}|${p.condition}`
        if (!grpMap.has(k)) grpMap.set(k, [])
        grpMap.get(k)!.push(p)
      }
      const piecesRows = Array.from(grpMap.values()).map(grp => {
        const p = grp[0], count = grp.length
        const vwPer = ((p.length_cm || 0) * (p.width_cm || 0) * (p.height_cm || 0)) / 6000
        return `<tr>
          <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:center;font-weight:600">${count}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right">${fmtNum((p.weight_kg || 0) * count)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:center">${fmtNum((p.length_cm||0)/2.54,1)} x ${fmtNum((p.width_cm||0)/2.54,1)} x ${fmtNum((p.height_cm||0)/2.54,1)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right">${fmtNum(vwPer * count)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:center">${p.packing_type || '-'}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:center">${p.condition === 'damaged' ? '<span style="color:#dc2626">Damaged</span>' : 'OK'}</td>
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
</style></head><body>
  <div class="no-print" style="text-align:right;margin-bottom:10px">
    <button onclick="window.print()" style="padding:8px 20px;background:#1e3a5f;color:white;border:none;border-radius:6px;cursor:pointer;font-size:13px">Imprimir</button>
  </div>
  <div class="stamp">RECEIVED</div>
  <div class="header">
    <div class="logo-area">
      <div class="logo-box">MCL</div>
      <div><div class="company-name">MINCURL LOGISTICS</div><div class="company-sub">Warehouse Management System</div></div>
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
    <thead><tr>
      <th style="text-align:center">Qty</th>
      <th style="text-align:right">Weight (kg)</th>
      <th style="text-align:center">Dimensions (in)</th>
      <th style="text-align:right">Vol Wt (kg)</th>
      <th style="text-align:center">Packing</th>
      <th style="text-align:center">Condition</th>
    </tr></thead>
    <tbody>${piecesRows || '<tr><td colspan="6" style="padding:20px;text-align:center;color:#9ca3af">No pieces registered</td></tr>'}</tbody>
  </table>
  <div class="totals">
    <div class="total-box"><div class="label">Total Pieces</div><div class="value">${pieces.length} / ${r.pieces}</div></div>
    <div class="total-box"><div class="label">Gross Weight</div><div class="value">${fmtNum(totalWeight)} kg</div></div>
    <div class="total-box"><div class="label">Vol. Weight</div><div class="value">${fmtNum(totalVolWeight)} kg</div></div>
    <div class="total-box"><div class="label">Total CBM</div><div class="value">${fmtNum(totalCBM, 4)} m&sup3;</div></div>
  </div>
  ${r.observations ? `<div style="margin-top:16px;padding:10px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;font-size:11px"><strong>Observations:</strong> ${r.observations}</div>` : ''}
  <div class="footer">
    <div class="sign-box"><div class="sign-line">Received By (Warehouse)</div></div>
    <div class="sign-box"><div class="sign-line">Delivered By (Driver)</div></div>
  </div>
  <div style="text-align:center;margin-top:20px;font-size:9px;color:#9ca3af">
    Generated by MINCURL WMS &mdash; ${new Date().toISOString()}
  </div>
</body></html>`

      const w = window.open('', '_blank')
      if (w) { w.document.write(html); w.document.close() }
    } catch (err) {
      console.error('Error opening WHR PDF:', err)
    }
  }

  // ── Doc indicator ──

  function DocIndicator({
    docFile,
    isSystem,
    onUpload,
    label,
  }: {
    docFile?: AirfreightDocumentFile
    isSystem?: boolean
    onUpload?: () => void
    label: string
  }) {
    if (hasDoc(docFile)) {
      return (
        <button
          onClick={() => window.open(docFile!.url, '_blank')}
          className="inline-block w-2.5 h-2.5 rounded-full bg-green-500 hover:bg-green-600 transition-colors cursor-pointer"
          title={`${label} - Click to open`}
        />
      )
    }
    if (isSystem) {
      return (
        <span
          className="inline-block w-2.5 h-2.5 rounded-full bg-gray-300 cursor-default"
          title={`${label} - Upload from Documents module`}
        />
      )
    }
    return (
      <button
        onClick={onUpload}
        disabled={uploading}
        className="inline-block w-2.5 h-2.5 rounded-full bg-gray-300 hover:bg-gray-400 transition-colors cursor-pointer disabled:opacity-50"
        title={`${label} - Click to upload`}
      />
    )
  }

  // ── Screening indicator (special) ──

  function ScreeningIndicator({ row }: { row: AwbLogRow }) {
    const hasCert = hasDoc(row.docScreeningCert)
    const st = row.screeningStatus || (hasCert ? 'complete' : 'pending')
    const colorMap: Record<string, string> = {
      complete: 'bg-green-500 hover:bg-green-600',
      partial: 'bg-amber-400 hover:bg-amber-500',
      error: 'bg-red-500 hover:bg-red-600',
      pending: 'bg-gray-300',
    }
    const colorClass = colorMap[st] || 'bg-gray-300'
    const isPending = st === 'pending'

    const handleClick = () => {
      if (row.isMawbHeader) {
        // Navigate to screening detail page
        navigate(`/airfreight/screening/${row.bookingId}?awb=${encodeURIComponent(row.mawb)}`)
      } else if (hasCert) {
        setScreeningModal(row)
      }
    }

    return (
      <div className="flex items-center justify-center">
        {isPending ? (
          <span
            className="inline-block w-2.5 h-2.5 rounded-full bg-gray-300 cursor-default"
            title="Screening - Pending"
          />
        ) : (
          <button
            onClick={handleClick}
            className={`inline-block w-2.5 h-2.5 rounded-full transition-colors cursor-pointer ${colorClass}`}
            title={`Screening - ${st.charAt(0).toUpperCase() + st.slice(1)} — Click for details`}
          />
        )}
      </div>
    )
  }

  // ── Render ──

  if (loading) {
    return (
      <Layout title="AWB Log" backTo="/airfreight/admin">
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" />
        </div>
      </Layout>
    )
  }

  return (
    <Layout title="AWB Log" backTo="/airfreight/admin">
      <div className="space-y-4">
        {/* Filters */}
        <div className="flex items-center gap-3 flex-wrap">
          {isMcl && (() => {
            const rowClients = [...new Map(rows.map(r => [r.clientId, r.clientName])).entries()].sort((a, b) => (a[1] || '').localeCompare(b[1] || ''))
            return (
              <select value={filterClient} onChange={e => setFilterClient(e.target.value)}
                className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30">
                <option value="">All Clients</option>
                {rowClients.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            )
          })()}

          <select value={filterHold} onChange={e => setFilterHold(e.target.value as '' | 'Y' | 'N' | 'P')}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30">
            <option value="">Hold: All</option>
            <option value="Y">Hold: Y</option>
            <option value="N">Hold: N</option>
            <option value="P">Hold: Pending</option>
          </select>

          <input
            type="date"
            value={dateFrom}
            onChange={e => setDateFrom(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
            title="ETD from"
          />
          <input
            type="date"
            value={dateTo}
            onChange={e => setDateTo(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
            title="ETD to"
          />

          <input
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            placeholder="Search AWB..."
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30 min-w-[180px]"
          />
        </div>

        {/* Table */}
        {flightGroups.length === 0 ? (
          <div className="text-center py-16 text-gray-400 bg-white rounded-xl border border-gray-100">
            <p className="text-sm">No AWBs found for the last {daysBack} days</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="overflow-auto max-h-[calc(100vh-260px)]">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-gray-50 text-[10px] font-bold text-gray-500 uppercase tracking-wide border-b border-gray-200">
                    <th className="px-2 py-2 text-left">MAWB</th>
                    <th className="px-2 py-2 text-left">AWB 1st</th>
                    <th className="px-2 py-2 text-left">AWB 2nd</th>
                    <th className="px-2 py-2 text-left">Dest</th>
                    <th className="px-2 py-2 text-center">PCS</th>
                    <th className="px-2 py-2 text-center">CHW</th>
                    <th className="px-1 py-2 text-center">HOLD</th>
                    <th className="px-1 py-2 text-center">7512</th>
                    <th className="px-1 py-2 text-center">Accept</th>
                    <th className="px-1 py-2 text-center">WHR</th>
                    <th className="px-1 py-2 text-center">AWB</th>
                    <th className="px-1 py-2 text-center">Screen</th>
                    <th className="px-1 py-2 text-center">MCL Tr</th>
                    <th className="px-1 py-2 text-center">DO/TSA</th>
                    <th className="px-1 py-2 text-center">CCSF</th>
                    <th className="px-1 py-2 text-center">Manif</th>
                    <th className="px-1 py-2 text-center">Dist</th>
                    <th className="px-1 py-2 text-center">LB</th>
                    <th className="px-1 py-2 text-center">Imp AWB</th>
                    <th className="px-1 py-2 text-center">DO</th>
                  </tr>
                </thead>
                <tbody>
                  {flightGroups.map(group => (
                    <FlightGroupSection
                      key={group.groupKey}
                      group={group}
                      triggerUpload={triggerUpload}
                      uploading={uploading}
                      DocIndicator={DocIndicator}
                      ScreeningIndicator={ScreeningIndicator}
                      openBucket={openBucket}
                      openFileList={openFileList}
                      triggerGenericUpload={triggerGenericUpload}
                      genericUploading={genericUploading}
                      doExistsMap={doExistsMap}
                      deleteMultiFile={deleteMultiFile}
                      getCompleteDocReception={getCompleteDocReception}
                      openWhrPdf={openWhrPdf}
                      generatingPC={generatingPC}
                      handleViewPalletControl={handleViewPalletControl}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Load more */}
        <div className="flex justify-center">
          <button
            onClick={() => setDaysBack(d => d + 30)}
            className="text-sm text-mcl-blue hover:underline font-medium"
          >
            Load older AWBs (currently showing last {daysBack} days)
          </button>
        </div>

        {/* AWB Audit Timeline — shown when search matches specific AWB(s) */}
        {searchText.trim().length >= 3 && filtered.length > 0 && filtered.length <= 10 && (
          <AwbAuditTimeline
            matchedRows={filtered}
            bookingsMap={bookingsMap}
            flightsMap={flightsMap}
            docReceptionsMap={docReceptionsMap}
          />
        )}
      </div>

      {/* Hidden file inputs */}
      <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileSelected} accept=".pdf,.jpg,.jpeg,.png" />
      <input ref={genericInputRef} type="file" className="hidden" onChange={handleGenericFileSelected} accept=".pdf,.jpg,.jpeg,.png" />

      {/* Screening Details Modal */}
      {screeningModal && screeningModal.screeningDetails && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={() => setScreeningModal(null)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-gray-800">Screening Certificate Details</h3>
                <button onClick={() => setScreeningModal(null)} className="text-gray-400 hover:text-gray-600">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="divide-y divide-gray-100">
                {([
                  ['MAWB', screeningModal.screeningDetails.mawb],
                  ['AWB', screeningModal.screeningDetails.awb],
                  ['Date', screeningModal.screeningDetails.date],
                  ['Time', screeningModal.screeningDetails.time],
                  ['Phantom Screener', screeningModal.screeningDetails.phantom_screener],
                  ['MCL Representant', screeningModal.screeningDetails.mcl_representant],
                  ['ULD', screeningModal.screeningDetails.uld],
                  ['Pieces', String(screeningModal.screeningDetails.pieces)],
                ] as [string, string][]).map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between py-2.5">
                    <span className="text-xs font-semibold text-gray-500 uppercase">{label}</span>
                    <span className="text-sm text-gray-800 font-medium">{value || '—'}</span>
                  </div>
                ))}
              </div>
              {hasDoc(screeningModal.docScreeningCert) && (
                <button
                  onClick={() => window.open(screeningModal!.docScreeningCert!.url, '_blank')}
                  className="w-full text-center text-sm font-semibold text-mcl-blue hover:underline py-2"
                >
                  Open PDF
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {/* Bucket viewer modal (ecommerce bulk-upload files) */}
      {bucketModal && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={() => setBucketModal(null)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-gray-800">Documentos subidos</h3>
                  <p className="text-xs text-gray-500 font-mono mt-0.5">{bucketModal.awb1stLeg || bucketModal.mawb || '—'}</p>
                </div>
                <button onClick={() => setBucketModal(null)} className="text-gray-400 hover:text-gray-600">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {(bucketModal.docUploads?.length ?? 0) === 0 ? (
                <div className="text-sm text-gray-400 text-center py-6">Sin archivos</div>
              ) : (
                <div className="space-y-1 max-h-80 overflow-y-auto">
                  {bucketModal.docUploads!.map((f, i) => (
                    <button
                      key={i}
                      onClick={() => window.open(f.url, '_blank')}
                      className="w-full flex items-center gap-2 text-xs text-left px-3 py-2 rounded-lg border border-gray-100 hover:bg-blue-50 hover:border-mcl-blue/30 transition-colors"
                    >
                      <svg className="w-4 h-4 text-mcl-blue flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      <span className="truncate flex-1 text-mcl-blue hover:underline">{f.filename}</span>
                      <span className="text-[10px] text-gray-400 font-mono">{f.uploaded_at?.slice(0, 10)}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="border-t border-gray-100 pt-3">
                <div className="text-[10px] font-bold text-gray-400 uppercase mb-1.5">Tipos confirmados</div>
                <div className="flex flex-wrap gap-1.5">
                  {([
                    ['7512', 'doc_7512'],
                    ['AWB', 'awb'],
                    ['DO/TSA', 'do_tsa'],
                  ] as const).map(([label, key]) => {
                    const on = !!bucketModal.docChecks?.[key]
                    return (
                      <span
                        key={key}
                        className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${
                          on ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'
                        }`}
                      >
                        {on ? '✓ ' : ''}{label}
                      </span>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* File list modal — used for flight-level Import AWBs */}
      {fileListModal && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={() => setFileListModal(null)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-gray-800 text-sm">{fileListModal.title}</h3>
                <button onClick={() => setFileListModal(null)} className="text-gray-400 hover:text-gray-600">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {fileListModal.files.length === 0 ? (
                <p className="text-xs text-gray-400 italic">Sin archivos</p>
              ) : (
                <div className="space-y-1 max-h-80 overflow-y-auto">
                  {fileListModal.files.map((f, i) => (
                    <div key={i} className="flex items-center gap-1">
                      <button
                        onClick={() => window.open(f.url, '_blank', 'noopener,noreferrer')}
                        className="flex-1 flex items-center gap-2 text-xs px-2 py-1.5 rounded hover:bg-blue-50 text-left min-w-0"
                      >
                        <span className="truncate flex-1 text-mcl-blue hover:underline">{f.filename}</span>
                        <span className="text-[10px] text-gray-400 font-mono shrink-0">{f.uploaded_at?.slice(0, 10)}</span>
                      </button>
                      {fileListModal.onDelete && (
                        <button
                          onClick={() => {
                            if (window.confirm(`¿Eliminar "${f.filename}"? Esta acción no se puede deshacer.`)) {
                              fileListModal.onDelete!(i)
                            }
                          }}
                          className="shrink-0 p-1 text-gray-300 hover:text-red-500 transition-colors"
                          title="Eliminar archivo"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {fileListModal.onUpload && (
                <button
                  onClick={() => { setFileListModal(null); fileListModal.onUpload!() }}
                  disabled={genericUploading}
                  className="w-full flex items-center justify-center gap-1.5 text-xs font-semibold text-mcl-blue bg-mcl-blue/10 hover:bg-mcl-blue/20 px-3 py-2 rounded-lg transition-colors disabled:opacity-50"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  Subir más archivos
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </Layout>
  )
}

// ── Flight Group Section ────────────────────────────────────────────────────

function FlightGroupSection({
  group,
  triggerUpload,
  uploading,
  DocIndicator,
  ScreeningIndicator,
  openBucket,
  openFileList,
  triggerGenericUpload,
  genericUploading,
  doExistsMap,
  deleteMultiFile,
  getCompleteDocReception,
  openWhrPdf,
  generatingPC,
  handleViewPalletControl,
}: {
  group: FlightGroup
  triggerUpload: (bookingId: string, awbIndex: number, field: ManualDocField) => void
  uploading: boolean
  DocIndicator: React.FC<{
    docFile?: AirfreightDocumentFile
    isSystem?: boolean
    onUpload?: () => void
    label: string
  }>
  ScreeningIndicator: React.FC<{ row: AwbLogRow }>
  openBucket: (row: AwbLogRow) => void
  openFileList: (title: string, files: AirfreightDocumentFile[], onUpload?: () => void, onDelete?: (fileIndex: number) => Promise<void>) => void
  triggerGenericUpload: (ctx: any) => void
  genericUploading: boolean
  doExistsMap: Map<string, { id: string; do_number: string; trucking: string }[]>
  deleteMultiFile: (target: 'booking_multi' | 'line_multi' | 'flight_multi', ids: { bookingId?: string; flightId?: string; awbIndex?: number; key: string }, fileIndex: number) => Promise<void>
  getCompleteDocReception: (row: AwbLogRow) => { id: string } | null
  openWhrPdf: (docReceptionId: string) => void
  generatingPC: string | null
  handleViewPalletControl: (flightId: string) => void
}) {
  const navigate = useNavigate()
  const [doPopoverKey, setDoPopoverKey] = useState<string | null>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Close popover on outside click
  useEffect(() => {
    if (!doPopoverKey) return
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setDoPopoverKey(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [doPopoverKey])

  // Semáforo helper for ecommerce check-driven columns. Green when the
  // client ticked the box, regardless of file existence. Click opens the
  // shared bucket of files for that AWB line.
  const EcomCheckIndicator: React.FC<{ row: AwbLogRow; checkKey: 'awb' | 'doc_7512' | 'do_tsa'; label: string }> = ({ row, checkKey, label }) => {
    const on = !!row.docChecks?.[checkKey]
    const hasFiles = (row.docUploads?.length ?? 0) > 0
    const clickable = on && hasFiles
    return (
      <button
        disabled={!clickable}
        onClick={() => clickable && openBucket(row)}
        title={on
          ? `${label} ✓${hasFiles ? ' — click para ver archivos' : ' (sin archivos)'}`
          : `${label} — pendiente`}
        className={`inline-block w-2.5 h-2.5 rounded-full transition-colors ${
          on ? 'bg-green-500 hover:bg-green-600' : 'bg-gray-300'
        } ${clickable ? 'cursor-pointer' : 'cursor-default'}`}
      />
    )
  }

  return (
    <>
      {/* Flight header (gray row) — now also shows client because we group
          per (flight, client) so every row below belongs to this client. */}
      <tr className="bg-slate-100 border-t-2 border-slate-300">
        <td colSpan={20} className="px-3 py-2">
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={() => {
                const firstBookingId = group.rows[0]?.bookingId
                if (firstBookingId) navigate(`/airfreight/bookings/${firstBookingId}`)
                else navigate(`/airfreight/booking-list?flight=${group.flightId}`)
              }}
              className="text-xs font-bold text-slate-700 hover:text-mcl-blue hover:underline transition-colors"
              title="Ver booking de este vuelo"
            >
              {group.airline} {group.flightNumber ? `#${group.flightNumber}` : ''}
            </button>
            <span className="text-xs text-slate-500">{fmtEtd(group.etd)}</span>
            {group.clientName && (
              <span className="text-xs font-semibold text-mcl-blue">
                {group.clientName}
              </span>
            )}
            <div className="flex gap-0.5">
              {group.destinations.map(d => (
                <span key={d} className="text-[10px] font-mono font-semibold bg-mcl-blue/10 text-mcl-blue px-1 py-0.5 rounded">
                  {d}
                </span>
              ))}
            </div>
            <span className="text-[10px] bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded-full font-medium">
              {group.rows.length} AWB{group.rows.length !== 1 ? 's' : ''}
            </span>
            {/* AWB Cut — scissors button */}
            <span className="flex items-center gap-1 ml-auto">
              <button
                onClick={() => navigate(`/airfreight/awb-cut/flight/${group.flightId}`)}
                disabled={!group.docDistribucion?.url && !(group.docDistribucionFiles && group.docDistribucionFiles.length > 0)}
                className={`text-sm transition-colors ${
                  group.docDistribucion?.url || (group.docDistribucionFiles && group.docDistribucionFiles.length > 0)
                    ? 'text-slate-600 hover:text-mcl-blue cursor-pointer'
                    : 'text-gray-300 cursor-not-allowed'
                }`}
                title={group.docDistribucion?.url || (group.docDistribucionFiles && group.docDistribucionFiles.length > 0) ? 'Corte de AWB' : 'Corte de AWB — requiere distribución cargada'}
              >
                ✂
              </button>
            </span>
            {/* Distribution — flight-level, shown in header row */}
            <span className="flex items-center gap-1">
              <span className="text-[9px] text-slate-400 uppercase font-bold">Dist</span>
              {(() => {
                const distFiles = group.docDistribucionFiles || []
                const hasSingle = !!group.docDistribucion?.url
                const hasFiles = distFiles.length > 0
                if (hasSingle || hasFiles) {
                  return (
                    <button
                      onClick={() => {
                        if (hasFiles) {
                          openFileList(`Distribution — ${group.airline} ${group.flightNumber}`, distFiles)
                        } else {
                          window.open(group.docDistribucion!.url, '_blank')
                        }
                      }}
                      className={`inline-block w-2.5 h-2.5 rounded-full transition-colors cursor-pointer ${
                        group.flightStatus === 'built' || group.flightStatus === 'dispatched'
                          ? 'bg-green-500 hover:bg-green-600'
                          : 'bg-yellow-400 hover:bg-yellow-500'
                      }`}
                      title={`Distribution${group.flightStatus === 'built' || group.flightStatus === 'dispatched' ? ' (closed)' : ' (in progress)'} — ${hasFiles ? `${distFiles.length} archivo(s)` : group.docDistribucion?.filename}`}
                    />
                  )
                }
                return (
                  <button
                    onClick={() => triggerGenericUpload({ target: 'flight_multi', flightId: group.flightId, key: 'doc_distribucion', row: group.rows[0] })}
                    disabled={genericUploading}
                    className="inline-block w-2.5 h-2.5 rounded-full bg-gray-300 hover:bg-gray-400 transition-colors cursor-pointer disabled:opacity-50"
                    title="Distribution — Click para subir"
                  />
                )
              })()}
            </span>
            {/* Pallet Control — on-the-fly generation */}
            <span className="flex items-center gap-1">
              <span className="text-[9px] text-slate-400 uppercase font-bold">PC</span>
              <button
                onClick={() => handleViewPalletControl(group.flightId)}
                disabled={generatingPC === group.flightId}
                className={`inline-block w-2.5 h-2.5 rounded-full transition-colors cursor-pointer ${
                  generatingPC === group.flightId
                    ? 'bg-yellow-400 animate-pulse'
                    : 'bg-blue-400 hover:bg-blue-600'
                }`}
                title={generatingPC === group.flightId ? 'Generating...' : 'Pallet Control — Click para ver'}
              />
            </span>
          </div>
        </td>
      </tr>

      {/* Data rows */}
      {group.rows.map((row, i) => {
        const isHeader = !!row.isMawbHeader
        // Child rows of a MAWB (not ecommerce) get purple tint
        const isMawbChild = !isHeader && row.bookingType === 'mawb'
        const isEcommerce = row.bookingType === 'ecommerce'
        const rowBg = isHeader ? 'bg-purple-50 border-t border-purple-200' : isMawbChild ? 'bg-purple-50/20' : ''

        return (
          <tr key={`${row.bookingId}-${row.awbIndex}-${i}`} className={`transition-colors border-b border-gray-100 ${rowBg} ${isHeader ? '' : 'hover:bg-blue-50/30'}`}>
            {/* MAWB */}
            <td className={`px-2 py-1.5 font-mono text-xs max-w-[100px] truncate ${isHeader ? 'font-bold text-purple-800' : 'text-gray-600'}`} title={row.mawb}>
              {isHeader ? (row.mawb || 'Direct') : ''}
            </td>
            {/* AWB 1st / 2nd — blank on MAWB header */}
            <td className="px-2 py-1.5 font-mono text-xs text-gray-800 max-w-[100px] truncate" title={row.awb1stLeg}>
              {isHeader ? '' : (row.awb1stLeg || '—')}
            </td>
            <td className="px-2 py-1.5 font-mono text-xs text-gray-500 max-w-[100px] truncate" title={row.awb2ndLeg}>
              {isHeader ? '' : (row.awb2ndLeg || '—')}
            </td>
            <td className="px-2 py-1.5">
              {(isHeader || !isMawbChild) && row.destination && (
                <span className="text-[10px] font-mono font-semibold bg-mcl-blue/10 text-mcl-blue px-1 py-0.5 rounded">
                  {row.destination}
                </span>
              )}
            </td>
            <td className="px-2 py-1.5 text-center tabular-nums text-xs text-gray-700">{row.pieces > 0 ? fmtNum(row.pieces) : '—'}</td>
            <td className="px-2 py-1.5 text-center tabular-nums text-xs text-gray-700">{row.chargeableWeight > 0 ? fmtNum(row.chargeableWeight) : '—'}</td>
            <td className="px-1 py-1.5 text-center">
              {row.hold === true ? (
                <span className="text-[10px] font-bold bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full">Y</span>
              ) : row.hold === 'pending' ? (
                <span className="text-[10px] font-bold bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded-full">?</span>
              ) : (
                <span className="text-[10px] text-gray-300">N</span>
              )}
            </td>
            {/* 7512 — ecommerce: read doc + upload; others: read-only from system */}
            <td className="px-1 py-1.5 text-center">
              {isHeader ? null : isEcommerce
                ? <DocIndicator docFile={row.doc7512} onUpload={row.awbIndex >= 0 ? () => triggerGenericUpload({ target: 'line_doc', bookingId: row.bookingId, awbIndex: row.awbIndex, key: 'doc_7512', row }) : undefined} label="7512" />
                : <DocIndicator docFile={row.doc7512} isSystem label="7512" />}
            </td>
            {/* Acceptance */}
            <td className="px-1 py-1.5 text-center">
              {isHeader ? null : (
                <DocIndicator
                  docFile={row.docAcceptance}
                  onUpload={row.bookingType === 'simple'
                    ? () => triggerGenericUpload({ target: 'booking_single', bookingId: row.bookingId, key: 'doc_acceptance', row })
                    : row.awbIndex >= 0 ? () => triggerUpload(row.bookingId, row.awbIndex, 'doc_acceptance') : undefined}
                  label="Acceptance"
                />
              )}
            </td>
            {/* WHR — auto-generated from physical reception */}
            <td className="px-1 py-1.5 text-center">
              {isMawbChild ? null : (() => {
                // Priority 1: legacy manual upload
                if (hasDoc(row.docWhr)) {
                  return (
                    <button
                      onClick={() => window.open(row.docWhr!.url, '_blank')}
                      className="inline-block w-2.5 h-2.5 rounded-full bg-green-500 hover:bg-green-600 transition-colors cursor-pointer"
                      title="WHR — Click to open"
                    />
                  )
                }
                // Priority 2: doc reception complete → generate WR on-demand
                const dr = getCompleteDocReception(row)
                if (dr) {
                  return (
                    <button
                      onClick={() => openWhrPdf(dr.id)}
                      className="inline-block w-2.5 h-2.5 rounded-full bg-green-500 hover:bg-green-600 transition-colors cursor-pointer"
                      title="WHR — Click to open Warehouse Receipt"
                    />
                  )
                }
                // No WHR available
                return (
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-full bg-gray-300 cursor-default"
                    title="WHR — No physical reception"
                  />
                )
              })()}
            </td>
            {/* AWB — MAWB header: MAWB doc; ecommerce/simple: read doc + upload; others: read-only HAWB */}
            <td className="px-1 py-1.5 text-center">
              {isHeader ? <DocIndicator docFile={row.docMawb} isSystem label="MAWB" /> : isEcommerce
                ? <DocIndicator docFile={row.docHawb} onUpload={row.awbIndex >= 0 ? () => triggerGenericUpload({ target: 'line_doc', bookingId: row.bookingId, awbIndex: row.awbIndex, key: 'doc_hawb', row }) : undefined} label="AWB" />
                : row.bookingType === 'simple'
                ? <DocIndicator docFile={row.docHawb} onUpload={() => triggerGenericUpload({ target: 'booking_single', bookingId: row.bookingId, key: 'doc_hawb', row })} label="AWB" />
                : <DocIndicator docFile={row.docHawb} isSystem label="AWB" />}
            </td>
            {/* Screening */}
            <td className="px-1 py-1.5 text-center">
              {isHeader ? <ScreeningIndicator row={row} /> : (isMawbChild ? null : <ScreeningIndicator row={row} />)}
            </td>
            {/* MCL Screening Transfer — MAWB header: multi-file booking upload; others: line upload */}
            <td className="px-1 py-1.5 text-center">
              {isHeader ? (() => {
                const files = row.docMclTransferFiles || []
                const hasFiles = files.length > 0
                const uploadMoreMawb = () => triggerGenericUpload({ target: 'booking_multi', bookingId: row.bookingId, key: 'doc_mcl_transfer', row })
                if (hasFiles) {
                  return (
                    <button
                      onClick={() => openFileList(`MCL Transfer — ${row.clientName}${row.mawb ? ` / ${row.mawb}` : ''}`, files, uploadMoreMawb, (fi) => deleteMultiFile('booking_multi', { bookingId: row.bookingId, key: 'doc_mcl_transfer' }, fi))}
                      className="inline-block w-2.5 h-2.5 rounded-full bg-green-500 hover:bg-green-600 transition-colors cursor-pointer"
                      title={`MCL Transfer (${files.length} archivo${files.length === 1 ? '' : 's'}) — click para ver/subir más`}
                    />
                  )
                }
                return (
                  <button
                    onClick={() => triggerGenericUpload({ target: 'booking_multi', bookingId: row.bookingId, key: 'doc_mcl_transfer', row })}
                    disabled={genericUploading}
                    className="inline-block w-2.5 h-2.5 rounded-full bg-gray-300 hover:bg-gray-400 transition-colors cursor-pointer disabled:opacity-50"
                    title="MCL Transfer — Click para subir"
                  />
                )
              })() : isMawbChild ? null : (() => {
                // Combine legacy single file + new multi-file array
                const legacy = row.docMclTransfer && row.docMclTransfer.url ? [row.docMclTransfer] : []
                const multi = row.docMclTransferFiles || []
                const allFiles = [...legacy, ...multi]
                const isSimple = row.bookingType === 'simple'
                const uploadMore = isSimple
                  ? () => triggerGenericUpload({ target: 'booking_multi', bookingId: row.bookingId, key: 'doc_mcl_transfer', row })
                  : row.awbIndex >= 0 ? () => triggerGenericUpload({ target: 'line_multi', bookingId: row.bookingId, awbIndex: row.awbIndex, key: 'doc_mcl_transfer', row }) : undefined
                const deleteHandler = isSimple
                  ? (fi: number) => deleteMultiFile('booking_multi', { bookingId: row.bookingId, key: 'doc_mcl_transfer' }, fi)
                  : (fi: number) => deleteMultiFile('line_multi', { bookingId: row.bookingId, awbIndex: row.awbIndex, key: 'doc_mcl_transfer' }, fi)
                if (allFiles.length > 0) {
                  return (
                    <button
                      onClick={() => openFileList(`MCL Transfer — ${row.clientName}${row.awb1stLeg ? ` / ${row.awb1stLeg}` : ''}`, allFiles, uploadMore, deleteHandler)}
                      className="inline-block w-2.5 h-2.5 rounded-full bg-green-500 hover:bg-green-600 transition-colors cursor-pointer"
                      title={`MCL Transfer (${allFiles.length} archivo${allFiles.length === 1 ? '' : 's'}) — click para ver/subir más`}
                    />
                  )
                }
                return (
                  <button
                    onClick={uploadMore}
                    disabled={genericUploading}
                    className="inline-block w-2.5 h-2.5 rounded-full bg-gray-300 hover:bg-gray-400 transition-colors cursor-pointer disabled:opacity-50"
                    title="MCL Transfer — Click para subir"
                  />
                )
              })()}
            </td>
            {/* DO/TSA — ecommerce/export/simple-new: per-AWB single; MAWB/simple-legacy: flight-level multi-file */}
            <td className="px-1 py-1.5 text-center">
              {isMawbChild ? null : (isEcommerce || row.bookingType === 'export' || (row.bookingType === 'simple' && !(row.docDoTsaFiles?.length))) ? (
                <DocIndicator
                  docFile={row.docDoTsa}
                  onUpload={row.bookingType === 'simple'
                    ? () => triggerGenericUpload({ target: 'booking_single', bookingId: row.bookingId, key: 'doc_do_tsa', row })
                    : row.awbIndex >= 0 ? () => triggerGenericUpload({ target: 'line_doc', bookingId: row.bookingId, awbIndex: row.awbIndex, key: 'doc_do_tsa', row }) : undefined}
                  label="DO/TSA"
                />
              ) : (() => {
                const files = row.docDoTsaFiles || []
                const hasFiles = files.length > 0
                if (hasFiles) {
                  return (
                    <button
                      onClick={() => openFileList(`DO/TSA — ${row.airline}${row.flightNumber ? ' #' + row.flightNumber : ''}`, files)}
                      className="inline-block w-2.5 h-2.5 rounded-full bg-green-500 hover:bg-green-600 transition-colors cursor-pointer"
                      title={`DO/TSA (${files.length} archivo${files.length === 1 ? '' : 's'}) — click para ver`}
                    />
                  )
                }
                return (
                  <button
                    onClick={() => triggerGenericUpload({ target: 'flight_multi', flightId: row.flightId, key: 'doc_do_tsa', row })}
                    disabled={genericUploading}
                    className="inline-block w-2.5 h-2.5 rounded-full bg-gray-300 hover:bg-gray-400 transition-colors cursor-pointer disabled:opacity-50"
                    title="DO/TSA — Click para subir"
                  />
                )
              })()}
            </td>
            {/* CCSF — export/ecommerce: line-level single; MAWB/simple: booking-level multi-file */}
            <td className="px-1 py-1.5 text-center">
              {isMawbChild ? null : (row.bookingType === 'export' || isEcommerce) ? (
                <DocIndicator
                  docFile={row.docCcsf}
                  onUpload={row.awbIndex >= 0 ? () => triggerGenericUpload({ target: 'line_doc', bookingId: row.bookingId, awbIndex: row.awbIndex, key: 'doc_ccsf', row }) : undefined}
                  label="CCSF"
                />
              ) : (() => {
                const files = row.docCcsfFiles || []
                const hasFiles = files.length > 0
                const uploadMoreCcsf = () => triggerGenericUpload({ target: 'booking_multi', bookingId: row.bookingId, key: 'doc_ccsf', row })
                if (hasFiles) {
                  return (
                    <button
                      onClick={() => openFileList(`CCSF — ${row.clientName}${row.mawb ? ` / ${row.mawb}` : ''}`, files, uploadMoreCcsf, (fi) => deleteMultiFile('booking_multi', { bookingId: row.bookingId, key: 'doc_ccsf' }, fi))}
                      className="inline-block w-2.5 h-2.5 rounded-full bg-green-500 hover:bg-green-600 transition-colors cursor-pointer"
                      title={`CCSF (${files.length} archivo${files.length === 1 ? '' : 's'}) — click para ver/subir más`}
                    />
                  )
                }
                return (
                  <button
                    onClick={() => triggerGenericUpload({ target: 'booking_multi', bookingId: row.bookingId, key: 'doc_ccsf', row })}
                    disabled={genericUploading}
                    className="inline-block w-2.5 h-2.5 rounded-full bg-gray-300 hover:bg-gray-400 transition-colors cursor-pointer disabled:opacity-50"
                    title="CCSF — Click para subir"
                  />
                )
              })()}
            </td>
            {/* Manifiesto — ecommerce/simple-new: per-AWB; MAWB/simple-legacy: flight-level */}
            <td className="px-1 py-1.5 text-center">
              {isMawbChild ? null : (isEcommerce || row.bookingType === 'simple') ? (
                <DocIndicator
                  docFile={row.docManifesto}
                  onUpload={row.bookingType === 'simple'
                    ? () => triggerGenericUpload({ target: 'booking_single', bookingId: row.bookingId, key: 'doc_manifesto', row })
                    : row.awbIndex >= 0 ? () => triggerGenericUpload({ target: 'line_doc', bookingId: row.bookingId, awbIndex: row.awbIndex, key: 'doc_manifesto', row }) : undefined}
                  label="Manifiesto"
                />
              ) : (
                <DocIndicator
                  docFile={row.docManifesto}
                  onUpload={() => triggerGenericUpload({ target: 'flight_multi', flightId: row.flightId, key: 'doc_manifesto', row })}
                  label="Manifiesto"
                />
              )}
            </td>
            {/* Distribution — rendered in flight header row, empty cell here */}
            <td className="px-1 py-1.5 text-center" />
            {/* LB Checklist — only when battery flag; MAWB header: multi-file booking; line: single file */}
            <td className="px-1 py-1.5 text-center">
              {(() => {
                if (isMawbChild) return null
                if (!row.battery) return null
                if (isHeader) {
                  // MAWB header: multi-file at booking level
                  const files = row.docLbChecklistFiles || []
                  const hasFiles = files.length > 0
                  if (hasFiles) {
                    return (
                      <button
                        onClick={() => openFileList(`LB Checklist — ${row.clientName}${row.mawb ? ` / ${row.mawb}` : ''}`, files)}
                        className="inline-block w-2.5 h-2.5 rounded-full bg-green-500 hover:bg-green-600 transition-colors cursor-pointer"
                        title={`LB Checklist (${files.length} archivo${files.length === 1 ? '' : 's'}) — click para ver`}
                      />
                    )
                  }
                  return (
                    <button
                      onClick={() => triggerGenericUpload({ target: 'booking_multi', bookingId: row.bookingId, key: 'doc_lb_checklist', row })}
                      disabled={genericUploading}
                      className="inline-block w-2.5 h-2.5 rounded-full bg-gray-300 hover:bg-gray-400 transition-colors cursor-pointer disabled:opacity-50"
                      title="LB Checklist — Click para subir"
                    />
                  )
                }
                // Line-level: single file
                return (
                  <DocIndicator
                    docFile={row.docLbChecklist}
                    onUpload={row.awbIndex >= 0 ? () => triggerGenericUpload({ target: 'line_doc', bookingId: row.bookingId, awbIndex: row.awbIndex, key: 'doc_lb_checklist', row }) : undefined}
                    label="LB Checklist"
                  />
                )
              })()}
            </td>
            {/* Imp AWB — ecommerce: line-level; simple: booking-level */}
            <td className="px-1 py-1.5 text-center">
              {(() => {
                if (isMawbChild) return null
                if (!isEcommerce && row.bookingType !== 'simple') return <span className="text-[10px] text-gray-300">—</span>
                return (
                  <DocIndicator
                    docFile={row.docImportAwb}
                    onUpload={row.bookingType === 'simple'
                      ? () => triggerGenericUpload({ target: 'booking_single', bookingId: row.bookingId, key: 'doc_import_awb', row })
                      : row.awbIndex >= 0 ? () => triggerGenericUpload({ target: 'line_doc', bookingId: row.bookingId, awbIndex: row.awbIndex, key: 'doc_import_awb', row }) : undefined}
                    label="Import AWB"
                  />
                )
              })()}
            </td>
            {/* DO — ecommerce + MAWB header rows get link to Delivery Order page; others keep print */}
            <td className="px-1 py-1.5 text-center">
              {((isEcommerce || row.bookingType === 'export') && row.awbIndex >= 0) || isHeader || row.bookingType === 'simple' ? (() => {
                const doKey = `${row.bookingId}::${isHeader ? 0 : Math.max(row.awbIndex, 0)}`
                const existingDos = doExistsMap.get(doKey) || []
                const awbIdx = isHeader || row.bookingType === 'simple' ? 0 : row.awbIndex
                if (existingDos.length <= 1) {
                  // 0 or 1 DO — single button, navigate directly
                  const singleDo = existingDos[0]
                  return (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        if (singleDo) {
                          navigate(`/airfreight/delivery-order/doc/${singleDo.id}`)
                        } else {
                          navigate(`/airfreight/delivery-order/${row.bookingId}/${awbIdx}`)
                        }
                      }}
                      title={singleDo ? `DO: ${singleDo.do_number}` : 'Crear Delivery Order'}
                      className="transition-colors"
                    >
                      <svg className={`w-3.5 h-3.5 inline-block ${singleDo ? 'text-green-500 hover:text-green-600' : 'text-gray-400 hover:text-mcl-blue'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    </button>
                  )
                }
                // Multiple DOs — badge with count + popover
                return (
                  <div className="relative inline-block">
                    <button
                      onClick={(e) => { e.stopPropagation(); setDoPopoverKey(doPopoverKey === doKey ? null : doKey) }}
                      title={`${existingDos.length} DOs`}
                      className="transition-colors"
                    >
                      <span className="inline-flex items-center gap-0.5">
                        <svg className="w-3.5 h-3.5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        <span className="text-[9px] font-bold text-green-600 bg-green-100 rounded-full w-3.5 h-3.5 flex items-center justify-center">{existingDos.length}</span>
                      </span>
                    </button>
                    {doPopoverKey === doKey && (
                      <div ref={popoverRef} className="absolute z-50 right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[180px]" onClick={e => e.stopPropagation()}>
                        {existingDos.map((d, i) => (
                          <button
                            key={d.id}
                            onClick={() => { setDoPopoverKey(null); navigate(`/airfreight/delivery-order/doc/${d.id}`) }}
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-blue-50 flex items-center gap-2"
                          >
                            <span className="font-mono font-bold text-mcl-blue">{d.do_number}</span>
                            {d.trucking && <span className="text-gray-400 truncate">{d.trucking}</span>}
                          </button>
                        ))}
                        <hr className="my-1 border-gray-100" />
                        <button
                          onClick={() => { setDoPopoverKey(null); navigate(`/airfreight/delivery-order/${row.bookingId}/${awbIdx}`) }}
                          className="w-full text-left px-3 py-1.5 text-xs text-mcl-blue font-semibold hover:bg-blue-50"
                        >
                          + Nueva DO
                        </button>
                      </div>
                    )}
                  </div>
                )
              })() : isMawbChild ? null : (
                <button
                  onClick={(e) => { e.stopPropagation(); printRowDocs(row) }}
                  title={(() => {
                    const n = collectRowDocs(row).length
                    return n > 0 ? `Imprimir ${n} doc(s) de esta guía` : 'Sin documentos para imprimir'
                  })()}
                  className={`transition-colors ${
                    collectRowDocs(row).length > 0
                      ? 'text-gray-400 hover:text-mcl-blue'
                      : 'text-gray-200 cursor-not-allowed'
                  }`}
                  disabled={collectRowDocs(row).length === 0}
                >
                  <svg className="w-3.5 h-3.5 inline-block" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                  </svg>
                </button>
              )}
            </td>
          </tr>
        )
      })}
    </>
  )
}

// ── AWB Audit Timeline ──────────────────────────────────────────────────────

interface TimelineEvent {
  at: string
  user: string
  action: string
  detail: string
  icon: 'create' | 'edit' | 'doc' | 'dispatch' | 'move' | 'hold' | 'screening' | 'reopen' | 'info' | 'warehouse'
}

type DocReceptionSummary = { id: string; awb_number: string; status: string; pieces: number; weight: number; chargeable_weight: number; warehouse_number: string; created_at: string; created_by: string; updated_at?: string }

function buildTimelineEvents(
  row: AwbLogRow,
  booking: (AirfreightBooking & { id: string }) | undefined,
  flight: (AirfreightFlight & { id: string }) | undefined,
  docReceptions?: DocReceptionSummary[],
): TimelineEvent[] {
  const events: TimelineEvent[] = []
  if (!booking) return events

  // 1. Booking created
  if (booking.created_at) {
    events.push({
      at: booking.created_at,
      user: booking.created_by || 'Sistema',
      action: 'Booking creado',
      detail: `Cliente: ${booking.client_name} | Tipo: ${booking.booking_type}`,
      icon: 'create',
    })
  }

  // 2. Change log entries (booking-level edits, reassignments)
  for (const entry of (booking.change_log || [])) {
    const details = entry.fields_changed.map(f => {
      if (f.old_value) return `${f.label}: ${f.old_value} → ${f.new_value}`
      return `${f.label}: ${f.new_value}`
    }).join('; ')
    events.push({
      at: entry.changed_at,
      user: entry.changed_by,
      action: entry.change_type === 'created' ? 'Booking creado'
        : entry.change_type === 'flight_reassignment' ? 'Reasignado a otro vuelo'
        : 'Booking editado',
      detail: details,
      icon: entry.change_type === 'flight_reassignment' ? 'move' : 'edit',
    })
  }

  // 3. AWB line-level data (for mawb/ecommerce: use the matching awb_lines entry)
  const line: AwbSecondLeg | undefined = row.awbIndex >= 0 && booking.awb_lines
    ? booking.awb_lines[row.awbIndex]
    : undefined

  if (line) {
    // Documents uploaded at AWB level
    const docSlots: { field: string; label: string; doc?: AirfreightDocumentFile }[] = [
      { field: 'doc_acceptance', label: 'Acceptance', doc: line.doc_acceptance },
      { field: 'doc_whr', label: 'WHR', doc: line.doc_whr },
      { field: 'doc_mcl_transfer', label: 'MCL Screening Transfer', doc: line.doc_mcl_transfer },
      { field: 'doc_screening_cert', label: 'Screening Certificate', doc: line.doc_screening_cert },
    ]
    // AWB-level documents sub-object
    if (line.documents) {
      if (line.documents.doc_7512) docSlots.push({ field: 'doc_7512', label: '7512', doc: line.documents.doc_7512 })
      if (line.documents.doc_hawb) docSlots.push({ field: 'doc_hawb', label: 'HAWB', doc: line.documents.doc_hawb })
      if (line.documents.doc_pickup_order) docSlots.push({ field: 'doc_pickup_order', label: 'Pickup Order', doc: line.documents.doc_pickup_order })
      if (line.documents.doc_1f) docSlots.push({ field: 'doc_1f', label: '1F', doc: line.documents.doc_1f })
      if (line.documents.doc_lb_checklist) docSlots.push({ field: 'doc_lb_checklist', label: 'LB Checklist', doc: line.documents.doc_lb_checklist })
    }

    for (const slot of docSlots) {
      if (slot.doc?.uploaded_at) {
        events.push({
          at: slot.doc.uploaded_at,
          user: slot.doc.uploaded_by || 'Sistema',
          action: 'Documento subido',
          detail: slot.label + (slot.doc.filename ? ` (${slot.doc.filename})` : ''),
          icon: 'doc',
        })
        // Also add history (re-uploads)
        for (const h of (slot.doc.history || [])) {
          if (h.uploaded_at) {
            events.push({
              at: h.uploaded_at,
              user: h.uploaded_by || 'Sistema',
              action: 'Documento actualizado',
              detail: `${slot.label} v${h.version}` + (h.filename ? ` (${h.filename})` : ''),
              icon: 'doc',
            })
          }
        }
      }
    }

    // MCL Transfer multi-file uploads
    for (const f of (line.doc_mcl_transfer_files || [])) {
      if (f.uploaded_at) {
        events.push({
          at: f.uploaded_at,
          user: f.uploaded_by || 'Sistema',
          action: 'Documento subido',
          detail: `MCL Screening Transfer (${f.filename || 'archivo'})`,
          icon: 'doc',
        })
      }
    }

    // Ecommerce bulk uploads
    for (const f of (line.doc_uploads || [])) {
      if (f.uploaded_at) {
        events.push({
          at: f.uploaded_at,
          user: f.uploaded_by || 'Sistema',
          action: 'Doc bulk subido',
          detail: f.filename || 'archivo',
          icon: 'doc',
        })
      }
    }

    // Doc checks
    if (line.doc_checks_at) {
      const checks: string[] = []
      if (line.doc_checks?.awb) checks.push('AWB')
      if (line.doc_checks?.doc_7512) checks.push('7512')
      if (line.doc_checks?.do_tsa) checks.push('DO/TSA')
      events.push({
        at: line.doc_checks_at,
        user: line.doc_checks_by || 'Sistema',
        action: 'Doc checks marcados',
        detail: checks.length > 0 ? checks.join(', ') : 'Sin checks',
        icon: 'info',
      })
    }

    // Dispatched
    if (line.dispatched && line.dispatched_at) {
      events.push({
        at: line.dispatched_at,
        user: line.dispatched_by || 'Sistema',
        action: 'AWB despachado',
        detail: `AWB: ${line.awb_number || row.awb1stLeg}`,
        icon: 'dispatch',
      })
    }

    // Screening
    if (line.screening_details) {
      const sd = line.screening_details
      events.push({
        at: sd.date && sd.time ? `${sd.date}T${sd.time}` : (line.doc_screening_cert?.uploaded_at || ''),
        user: sd.mcl_representant || 'Phantom K9',
        action: 'Screening realizado',
        detail: `${sd.pieces} pzas | ULD: ${sd.uld || '—'} | Screener: ${sd.phantom_screener || '—'}`,
        icon: 'screening',
      })
    }

    // Transport docs
    for (const f of (line.transport_docs || [])) {
      if (f.uploaded_at) {
        events.push({
          at: f.uploaded_at,
          user: f.uploaded_by || 'Sistema',
          action: 'Doc transporte subido',
          detail: f.filename || 'archivo',
          icon: 'doc',
        })
      }
    }

    // Forward-written audit_log entries
    for (const entry of (line.audit_log || [])) {
      const iconMap: Record<string, TimelineEvent['icon']> = {
        screening_correction: 'screening',
        doc_uploaded: 'doc',
      }
      events.push({
        at: entry.at,
        user: entry.user,
        action: entry.action === 'screening_correction' ? 'Corrección de screening'
          : entry.action === 'doc_uploaded' ? 'Documento subido'
          : entry.action,
        detail: entry.detail || (entry.field
          ? `${entry.field}: ${entry.old_value || ''} → ${entry.new_value || ''}`
          : ''),
        icon: iconMap[entry.action] || 'info',
      })
    }
  }

  // Simple booking: docs are at booking.documents level
  if (booking.booking_type === 'simple' && booking.documents) {
    const bDocs: { label: string; doc?: AirfreightDocumentFile }[] = [
      { label: '1F', doc: booking.documents.doc_1f },
      { label: '7512', doc: booking.documents.doc_7512 },
      { label: 'DO/TSA', doc: booking.documents.doc_do_tsa },
      { label: 'MAWB Draft', doc: booking.documents.doc_mawb_draft },
      { label: 'MAWB Def', doc: booking.documents.doc_mawb_def },
      { label: 'Pickup Order', doc: booking.documents.doc_pickup_order },
      { label: 'LB Checklist', doc: booking.documents.doc_lb_checklist },
      { label: 'CCSF', doc: booking.documents.doc_ccsf },
    ]
    for (const slot of bDocs) {
      if (slot.doc?.uploaded_at) {
        events.push({
          at: slot.doc.uploaded_at,
          user: slot.doc.uploaded_by || 'Sistema',
          action: 'Documento subido',
          detail: slot.label + (slot.doc.filename ? ` (${slot.doc.filename})` : ''),
          icon: 'doc',
        })
      }
    }
  }

  // 4. Flight-level events
  if (flight) {
    if (flight.dispatched_at) {
      events.push({
        at: flight.dispatched_at,
        user: (flight as any).dispatched_by || 'Sistema',
        action: 'Vuelo despachado',
        detail: `${flight.airline} ${flight.flight_number || ''}`,
        icon: 'dispatch',
      })
    }
    if ((flight as any).reopened_by && (flight as any).reopened_at) {
      events.push({
        at: (flight as any).reopened_at,
        user: (flight as any).reopened_by,
        action: 'Vuelo reabierto',
        detail: `${flight.airline} ${flight.flight_number || ''}`,
        icon: 'reopen',
      })
    }
  }

  // 5. Doc reception / physical reception events
  if (docReceptions && docReceptions.length > 0) {
    for (const dr of docReceptions) {
      if (dr.created_at) {
        const statusLabels: Record<string, string> = {
          pending_physical: 'Pendiente rec. fisica',
          in_physical: 'En rec. fisica',
          complete: 'Completa',
        }
        events.push({
          at: dr.created_at,
          user: dr.created_by || 'Sistema',
          action: 'Recepcion documental',
          detail: `${dr.pieces} pzas · CHW ${dr.chargeable_weight} kg` +
            (dr.warehouse_number ? ` · WH# ${dr.warehouse_number}` : '') +
            ` · ${statusLabels[dr.status] || dr.status}`,
          icon: 'warehouse',
        })
      }
      if (dr.status === 'complete' && dr.created_at) {
        // Physical reception complete — use updated_at if available, else estimate
        const physAt = dr.updated_at || dr.created_at
        events.push({
          at: physAt,
          user: dr.created_by || 'Sistema',
          action: 'Recepcion fisica completa',
          detail: `${dr.pieces} pzas` +
            (dr.weight > 0 ? ` · Peso: ${dr.weight} kg` : '') +
            (dr.warehouse_number ? ` · WH# ${dr.warehouse_number}` : ''),
          icon: 'warehouse',
        })
      }
    }
  }

  // Sort chronologically
  events.sort((a, b) => {
    const ta = new Date(a.at).getTime() || 0
    const tb = new Date(b.at).getTime() || 0
    return ta - tb
  })

  return events
}

const ICON_CLASSES: Record<TimelineEvent['icon'], string> = {
  create: 'bg-green-100 text-green-600',
  edit: 'bg-amber-100 text-amber-600',
  doc: 'bg-blue-100 text-blue-600',
  dispatch: 'bg-purple-100 text-purple-600',
  move: 'bg-indigo-100 text-indigo-600',
  hold: 'bg-red-100 text-red-600',
  screening: 'bg-teal-100 text-teal-600',
  reopen: 'bg-orange-100 text-orange-600',
  info: 'bg-gray-100 text-gray-600',
  warehouse: 'bg-emerald-100 text-emerald-600',
}

const ICON_SVG: Record<TimelineEvent['icon'], string> = {
  create: 'M12 4v16m8-8H4',
  edit: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
  doc: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
  dispatch: 'M5 13l4 4L19 7',
  move: 'M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4',
  hold: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z',
  screening: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
  reopen: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
  info: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  warehouse: 'M8 14v3m4-3v3m4-3v3M3 21h18M3 10h18M3 7l9-4 9 4M4 10h16v11H4V10z',
}

function AwbAuditTimeline({
  matchedRows,
  bookingsMap,
  flightsMap,
  docReceptionsMap,
}: {
  matchedRows: AwbLogRow[]
  bookingsMap: Map<string, AirfreightBooking & { id: string }>
  flightsMap: Map<string, AirfreightFlight & { id: string }>
  docReceptionsMap: Map<string, { id: string; awb_number: string; status: string; pieces: number; weight: number; chargeable_weight: number; warehouse_number: string; created_at: string; created_by: string; updated_at?: string }[]>
}) {
  // Deduplicate by bookingId+awbIndex to avoid repeated timelines
  const seen = new Set<string>()
  const uniqueRows = matchedRows.filter(r => {
    if (r.isMawbHeader) return false // skip MAWB header rows
    const key = `${r.bookingId}::${r.awbIndex}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  if (uniqueRows.length === 0) return null

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-bold text-gray-700 flex items-center gap-2">
        <svg className="w-4 h-4 text-mcl-blue" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        AWB Audit Log
      </h3>

      {uniqueRows.map(row => {
        const booking = bookingsMap.get(row.bookingId)
        const flight = flightsMap.get(row.flightId)
        const norm = (s: string) => (s || '').replace(/[\s\-]/g, '').toUpperCase()
        const drKeys = [norm(row.awb1stLeg), norm(row.awb2ndLeg)].filter(Boolean)
        const rowDRs = drKeys.flatMap(k => docReceptionsMap.get(k) || [])
        // Deduplicate by id
        const seenDrIds = new Set<string>()
        const uniqueDRs = rowDRs.filter(dr => { if (seenDrIds.has(dr.id)) return false; seenDrIds.add(dr.id); return true })
        const events = buildTimelineEvents(row, booking, flight, uniqueDRs)
        const awbLabel = row.awb1stLeg || row.mawb || row.bookingId

        return (
          <div key={`${row.bookingId}-${row.awbIndex}`} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            {/* AWB header */}
            <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center gap-3 flex-wrap">
              <span className="text-xs font-bold text-gray-800 font-mono">{awbLabel}</span>
              {row.awb2ndLeg && (
                <span className="text-[10px] text-gray-500 font-mono">2nd: {row.awb2ndLeg}</span>
              )}
              <span className="text-[10px] bg-mcl-blue/10 text-mcl-blue px-1.5 py-0.5 rounded font-semibold">{row.destination}</span>
              <span className="text-[10px] text-gray-500">{row.clientName}</span>
              <span className="text-[10px] text-gray-400">{fmtNum(row.pieces)} pcs / {fmtNum(row.chargeableWeight)} kg chw</span>
              <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full font-medium">
                {events.length} evento{events.length !== 1 ? 's' : ''}
              </span>
            </div>

            {/* Timeline */}
            {events.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-gray-400">
                Sin eventos registrados para esta guia
              </div>
            ) : (
              <div className="px-4 py-3">
                <div className="relative">
                  {/* Vertical line */}
                  <div className="absolute left-3 top-3 bottom-3 w-px bg-gray-200" />

                  <div className="space-y-3">
                    {events.map((ev, i) => (
                      <div key={i} className="relative flex items-start gap-3 pl-0">
                        {/* Icon circle */}
                        <div className={`relative z-10 flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center ${ICON_CLASSES[ev.icon]}`}>
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={ICON_SVG[ev.icon]} />
                          </svg>
                        </div>

                        {/* Content */}
                        <div className="flex-1 min-w-0 -mt-0.5">
                          <div className="flex items-baseline gap-2 flex-wrap">
                            <span className="text-xs font-semibold text-gray-800">{ev.action}</span>
                            <span className="text-[10px] text-gray-400 font-mono whitespace-nowrap">
                              {fmtEtd(ev.at)}
                            </span>
                          </div>
                          <div className="text-[11px] text-gray-600 mt-0.5">{ev.detail}</div>
                          <div className="text-[10px] text-gray-400 mt-0.5">por {ev.user}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
