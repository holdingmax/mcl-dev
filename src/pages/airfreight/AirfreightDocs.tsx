import { useState, useEffect, useRef, Fragment } from 'react'
import { useSearchParams, Navigate } from 'react-router-dom'
import {
  collection, query, orderBy, onSnapshot, doc, updateDoc, getDoc, getDocs, where, addDoc, deleteDoc,
} from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage'
import { db, storage } from '../../lib/firebase'
import { fmtNum, storagePath, storagePathFlight } from '../../lib/utils'
import { useAuth } from '../../contexts/AuthContext'
import { AirfreightFlight, AirfreightBooking, AirfreightDocumentFile, AirfreightDocuments, AirfreightClient, HoldItem, ScanItem, AwbSecondLeg } from '../../types'
import Layout from '../../components/Layout'
import BarcodeScannerModal, { ScanResult } from '../../components/BarcodeScannerModal'
import { generatePalletControlOnTheFly } from '../../lib/buildupPdf'

// ─── Types ────────────────────────────────────────────────────────────────────

type DocStatus = 'none' | 'partial' | 'has7512' | 'complete'

interface DocSlotDef {
  key: string
  label: string
  uploader: 'client' | 'mcl' | 'both'
  multi?: boolean
}

interface DrawerItem {
  id: string
  label: string
  subLabel?: string
  bookingId: string
  booking: AirfreightBooking & { id: string }
  awbIndex?: number   // set for mawb sub-AWB rows
  awbNumber?: string  // AWB number for safe line lookup (index can go stale)
  isGroup?: boolean   // set for mawb group header
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  const d = new Date(iso)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${String(d.getFullYear()).slice(2)}`
}

function etdDateStr(iso: string) {
  // Returns YYYY-MM-DD avoiding timezone shift
  return iso.slice(0, 10)
}

function fmtYMD(ymd: string) {
  const [y, m, d] = ymd.split('-')
  return `${m}/${d}/${y.slice(2)}`
}

function PrintIcon({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title="Print documents"
      className="p-1 rounded hover:bg-gray-100 transition-colors text-gray-400 hover:text-mcl-blue disabled:opacity-25 disabled:cursor-not-allowed"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
      </svg>
    </button>
  )
}

interface DocEntry { label: string; url: string; filename: string }

const DOC_LABELS: Record<string, string> = {
  doc_7512: '7512', doc_hawb: 'HAWB', doc_1f: '1F', doc_pickup_order: 'Pickup Order',
  doc_lb_checklist: 'LB Checklist', doc_mawb_draft: 'AWB Draft', doc_mawb_def: 'AWB Final',
  doc_ccsf: 'CCSF', doc_whr: 'WHR', doc_do_tsa: 'DO / TSA Letter', doc_tsa_letter: 'TSA Letter',
  doc_shipper_dg: 'Shipper Declaration DDGG', doc_manifesto: 'Manifesto',
  doc_distribucion: 'Distribution', doc_import_awb: 'Import AWB',
}

/** Collect all doc entries from a booking (simple or MAWB group or sub-AWB) */
function collectBookingDocs(booking: AirfreightBooking, awbIndex?: number, isGroup?: boolean): DocEntry[] {
  const entries: DocEntry[] = []
  if (isGroup) {
    const docs = (booking.documents || {}) as Record<string, unknown>
    for (const key of ['doc_mawb_draft', 'doc_mawb_def']) {
      const d = docs[key] as AirfreightDocumentFile | undefined
      if (d?.url) entries.push({ label: DOC_LABELS[key] || key, url: d.url, filename: d.filename })
    }
    // CCSF multi-file support
    const ccsfFiles = getMultiDocsFromBooking(booking, 'doc_ccsf')
    ccsfFiles.forEach((d, i) => {
      entries.push({ label: `CCSF${ccsfFiles.length > 1 ? ` (${i + 1})` : ''}`, url: d.url, filename: d.filename })
    })
  } else if (awbIndex !== undefined) {
    const line = booking.awb_lines?.[awbIndex]
    if (line?.documents) {
      for (const [key, d] of Object.entries(line.documents)) {
        if (d?.url) entries.push({ label: DOC_LABELS[key] || key, url: d.url, filename: d.filename })
      }
    }
  } else {
    if (booking.documents) {
      for (const [key, d] of Object.entries(booking.documents)) {
        if (key.endsWith('_files')) continue // skip array fields, handled below
        if ((d as AirfreightDocumentFile)?.url) {
          const df = d as AirfreightDocumentFile
          entries.push({ label: DOC_LABELS[key] || key, url: df.url, filename: df.filename })
        }
      }
    }
    // CCSF multi-file support for simple bookings
    const ccsfFiles = getMultiDocsFromBooking(booking, 'doc_ccsf')
    ccsfFiles.forEach((d, i) => {
      // Avoid duplicating if already added from single doc above
      if (!entries.some(e => e.url === d.url)) {
        entries.push({ label: `CCSF${ccsfFiles.length > 1 ? ` (${i + 1})` : ''}`, url: d.url, filename: d.filename })
      }
    })
  }
  return entries
}

function openDocsViewer(docs: DocEntry[], title: string) {
  if (docs.length === 0) return
  const win = window.open('', '_blank')
  if (!win) return

  const isImage = (fn: string) => /\.(jpg|jpeg|png|gif|webp)$/i.test(fn)

  const embedHtml = docs.map(d => {
    const titleHtml = `<h2 style="margin:0 0 8px;font-size:14px;color:#333;font-family:sans-serif;">${d.label} — <span style="color:#888;font-weight:normal">${d.filename}</span></h2>`
    if (isImage(d.filename)) {
      return `<div style="margin-bottom:32px;">${titleHtml}<img src="${d.url}" style="max-width:100%;border:1px solid #ddd;border-radius:4px;" /></div>`
    }
    return `<div style="margin-bottom:32px;">${titleHtml}<iframe src="${d.url}" style="width:100%;height:80vh;border:1px solid #ddd;border-radius:4px;"></iframe></div>`
  }).join('')

  win.document.write(`<!DOCTYPE html><html><head><title>${title}</title></head><body style="margin:24px;font-family:sans-serif;">
    <h1 style="font-size:16px;color:#1a3b5c;margin-bottom:16px;">${title} — ${docs.length} documento${docs.length > 1 ? 's' : ''}</h1>
    ${embedHtml}
  </body></html>`)
  win.document.close()
}

function buildDocFile(
  file: File,
  existing: AirfreightDocumentFile | undefined,
  url: string,
  uploadedBy: string,
): AirfreightDocumentFile {
  return {
    url,
    filename: file.name,
    version: (existing?.version || 0) + 1,
    uploaded_at: new Date().toISOString(),
    uploaded_by: uploadedBy,
    modified_seen: false,
    history: existing
      ? [...(existing.history || []), {
          url: existing.url,
          filename: existing.filename,
          version: existing.version,
          uploaded_at: existing.uploaded_at,
          uploaded_by: existing.uploaded_by,
        }]
      : [],
  }
}

function getDocFromBooking(
  booking: AirfreightBooking,
  key: string,
  awbIndex?: number,
): AirfreightDocumentFile | undefined {
  if (awbIndex !== undefined) {
    const line = booking.awb_lines?.[awbIndex]
    return (line?.documents as Record<string, AirfreightDocumentFile | undefined> | undefined)?.[key]
  }
  return (booking.documents as Record<string, AirfreightDocumentFile | undefined> | undefined)?.[key]
}

/** Get multi-file docs array from booking (reads array field with legacy single-doc fallback) */
function getMultiDocsFromBooking(
  booking: AirfreightBooking,
  key: string,
): AirfreightDocumentFile[] {
  const docs = (booking.documents || {}) as Record<string, unknown>
  const arr = docs[`${key}_files`] as AirfreightDocumentFile[] | undefined
  if (arr && arr.length > 0) return arr
  // Fallback: legacy single doc
  const single = docs[key] as AirfreightDocumentFile | undefined
  if (single?.url) return [single]
  return []
}

// ─── Status helpers ───────────────────────────────────────────────────────────

function getSimpleStatus(b: AirfreightBooking): DocStatus {
  const d = b.documents || {}
  const has7512 = !!d.doc_7512
  const hasDraft = !!d.doc_mawb_draft
  const hasFinal = !!d.doc_mawb_def
  const hasAny = has7512 || hasDraft || hasFinal
  if (!hasAny) return 'none'
  if (!has7512) return 'partial'
  return hasDraft && hasFinal ? 'complete' : 'has7512'
}

function getMawbGroupStatus(b: AirfreightBooking): DocStatus {
  const d = b.documents || {}
  const hasDraft = !!d.doc_mawb_draft
  const hasFinal = !!d.doc_mawb_def
  if (!hasDraft && !hasFinal) return 'none'
  if (!hasDraft) return 'partial'
  return hasFinal ? 'complete' : 'has7512'
}

function getMawbAwbStatus(line: NonNullable<AirfreightBooking['awb_lines']>[number]): DocStatus {
  const d = line.documents || {}
  const has7512 = !!d.doc_7512
  const hasHawb = !!d.doc_hawb
  if (!has7512 && !hasHawb) return 'none'
  if (!has7512) return 'partial'
  return hasHawb ? 'complete' : 'has7512'
}

// ─── StatusDot ────────────────────────────────────────────────────────────────

function StatusDot({ status, size = 'sm' }: { status: DocStatus; size?: 'sm' | 'md' }) {
  const dim = size === 'md' ? 'w-3.5 h-3.5' : 'w-2.5 h-2.5'
  const color = {
    none:     'bg-gray-200',
    partial:  'bg-yellow-400',
    has7512:  'bg-green-300',
    complete: 'bg-green-600',
  }[status]
  return <span className={`inline-block rounded-full shrink-0 ${dim} ${color}`} />
}

// ─── DocSlotCard ──────────────────────────────────────────────────────────────

function DocSlotCard({
  slot,
  existing,
  canUpload,
  uploading,
  onUpload,
  onDelete,
  onDrop,
}: {
  slot: DocSlotDef
  existing?: AirfreightDocumentFile
  canUpload: boolean
  uploading: boolean
  onUpload: () => void
  onDelete?: () => void
  onDrop?: (files: FileList) => void
}) {
  const [dragOver, setDragOver] = useState(false)
  const uploaderLabel = slot.uploader === 'mcl' ? 'MCL' : slot.uploader === 'both' ? 'Client / MCL' : 'Client'

  const handleDragOver = (e: React.DragEvent) => { if (canUpload) { e.preventDefault(); e.stopPropagation(); setDragOver(true) } }
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setDragOver(false) }
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setDragOver(false)
    if (canUpload && onDrop && e.dataTransfer.files.length > 0) onDrop(e.dataTransfer.files)
  }

  return (
    <div
      className={`border rounded-lg p-2.5 space-y-1.5 transition-colors ${dragOver ? 'border-mcl-blue bg-blue-50/40' : 'border-gray-100'}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="text-xs font-semibold text-gray-700">{slot.label}</span>
        <span className="text-[10px] text-gray-400">{uploaderLabel}</span>
      </div>

      {existing ? (
        <div>
          <div className="flex items-center justify-between gap-1">
            <a
              href={existing.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-600 hover:underline truncate min-w-0"
            >
              📄 {existing.filename}
            </a>
            {canUpload && (
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={onUpload}
                  disabled={uploading}
                  className="text-[10px] text-gray-400 hover:text-gray-600"
                >
                  {uploading ? '...' : '↑'}
                </button>
                {onDelete && (
                  <button
                    type="button"
                    onClick={onDelete}
                    className="text-red-400 hover:text-red-600 text-xs ml-0.5"
                    title="Eliminar"
                  >
                    ✕
                  </button>
                )}
              </div>
            )}
          </div>
          <p className="text-[10px] text-gray-400 mt-0.5">
            v{existing.version} · {fmtDate(existing.uploaded_at)}
          </p>
        </div>
      ) : canUpload ? (
        <button
          type="button"
          onClick={onUpload}
          disabled={uploading}
          className={`w-full border border-dashed rounded py-1.5 transition-colors flex items-center justify-center gap-1.5 text-xs ${dragOver ? 'border-mcl-blue text-mcl-blue' : 'border-gray-200 text-gray-400 hover:border-mcl-blue hover:text-mcl-blue'}`}
        >
          {uploading ? '...' : dragOver ? 'Soltar aquí' : '+ Upload'}
        </button>
      ) : (
        <p className="text-[10px] text-gray-300">—</p>
      )}
    </div>
  )
}

// ─── Multi-file DocSlotCard ───────────────────────────────────────────────────

function MultiDocSlotCard({
  slot,
  files,
  canUpload,
  uploading,
  onUpload,
  onDelete,
  onDrop,
}: {
  slot: DocSlotDef
  files: AirfreightDocumentFile[]
  canUpload: boolean
  uploading: boolean
  onUpload: () => void
  onDelete?: (index: number) => void
  onDrop?: (files: FileList) => void
}) {
  const [dragOver, setDragOver] = useState(false)
  const uploaderLabel = slot.uploader === 'mcl' ? 'MCL' : slot.uploader === 'both' ? 'Client / MCL' : 'Client'

  const handleDragOver = (e: React.DragEvent) => { if (canUpload) { e.preventDefault(); e.stopPropagation(); setDragOver(true) } }
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setDragOver(false) }
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setDragOver(false)
    if (canUpload && onDrop && e.dataTransfer.files.length > 0) onDrop(e.dataTransfer.files)
  }

  return (
    <div
      className={`border rounded-lg p-2.5 space-y-1.5 col-span-2 transition-colors ${dragOver ? 'border-mcl-blue bg-blue-50/40' : 'border-gray-100'}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="text-xs font-semibold text-gray-700">{slot.label}</span>
        <span className="text-[10px] text-gray-400">{uploaderLabel}</span>
      </div>

      {files.length > 0 && (
        <div className="space-y-1">
          {files.map((f, i) => (
            <div key={i} className="flex items-center justify-between gap-1">
              <a
                href={f.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-600 hover:underline truncate min-w-0"
              >
                📄 {f.filename}
              </a>
              <div className="flex items-center gap-1 shrink-0">
                <span className="text-[10px] text-gray-400">v{f.version} · {fmtDate(f.uploaded_at)}</span>
                {canUpload && onDelete && (
                  <button
                    type="button"
                    onClick={() => onDelete(i)}
                    className="text-red-400 hover:text-red-600 text-xs ml-1"
                    title="Eliminar"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {canUpload && (
        <button
          type="button"
          onClick={onUpload}
          disabled={uploading}
          className={`w-full border border-dashed rounded py-1.5 transition-colors flex items-center justify-center gap-1.5 text-xs ${dragOver ? 'border-mcl-blue text-mcl-blue' : 'border-gray-200 text-gray-400 hover:border-mcl-blue hover:text-mcl-blue'}`}
        >
          {uploading ? '...' : dragOver ? 'Soltar aquí' : '+ Upload'}
        </button>
      )}

      {!canUpload && files.length === 0 && (
        <p className="text-[10px] text-gray-300">—</p>
      )}
    </div>
  )
}

// ─── Drag & Drop wrapper for flight doc slots ────────────────────────────────

function FlightDocSlot({ slotKey, children, canUpload, onDrop }: {
  slotKey: string
  children: (dragOver: boolean) => React.ReactNode
  canUpload: boolean
  onDrop?: (files: FileList) => void
}) {
  const [dragOver, setDragOver] = useState(false)
  const handleDragOver = (e: React.DragEvent) => { if (canUpload) { e.preventDefault(); e.stopPropagation(); setDragOver(true) } }
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setDragOver(false) }
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setDragOver(false)
    if (canUpload && onDrop && e.dataTransfer.files.length > 0) onDrop(e.dataTransfer.files)
  }
  return (
    <div
      key={slotKey}
      className={`border rounded-xl p-3 space-y-2 transition-colors ${dragOver ? 'border-mcl-blue bg-blue-50/40' : 'border-gray-100'}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {children(dragOver)}
    </div>
  )
}

// ─── Upload icon ──────────────────────────────────────────────────────────────

function UploadIcon({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Upload documents"
      className="text-gray-300 hover:text-mcl-blue transition-colors"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
      </svg>
    </button>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function AirfreightDocs() {
  const [searchParams] = useSearchParams()
  const { user, isAdmin, isSuperAgent, isAgent, isCounter, isBodega, isClient, isViewer, clientId, isEcommerceClient } = useAuth()
  const isMCL = isAdmin || isSuperAgent || isAgent || isCounter || isBodega
  const isClientScoped = isClient || isViewer

  // Ecommerce clients manage docs via Booking List, not this page
  if (isEcommerceClient) {
    return <Navigate to="/airfreight/booking-list" replace />
  }

  const paramFlight  = searchParams.get('flight')
  const paramBooking = searchParams.get('booking')
  const paramAwb     = searchParams.get('awb')

  // ── State ─────────────────────────────────────────────────────────────────
  const [flights, setFlights]               = useState<(AirfreightFlight & { id: string })[]>([])
  const [clients, setClients]               = useState<(AirfreightClient & { id: string })[]>([])
  const [clientFlightIds, setClientFlightIds] = useState<Map<string, Set<string>>>(new Map())
  const [selectedFlightId, setSelectedFlightId] = useState(paramFlight || '')
  const [selectedClientId, setSelectedClientId] = useState('')
  const defaultDocsFrom = new Date(); defaultDocsFrom.setDate(defaultDocsFrom.getDate() - 10)
  const [dateFrom, setDateFrom] = useState(defaultDocsFrom.toLocaleDateString('en-CA'))
  const [dateTo, setDateTo]     = useState('')
  const [flight, setFlight]                 = useState<(AirfreightFlight & { id: string }) | null>(null)
  const [bookings, setBookings]             = useState<(AirfreightBooking & { id: string })[]>([])
  const [loading, setLoading]               = useState(false)
  const [drawerItem, setDrawerItem]         = useState<DrawerItem | null>(null)
  const [uploading, setUploading]           = useState<string | null>(null)

  const bookingFileRef   = useRef<HTMLInputElement>(null)
  const flightFileRef    = useRef<HTMLInputElement>(null)
  const holdPhotoRef     = useRef<HTMLInputElement>(null)
  const pendingBookingUp = useRef<{ item: DrawerItem; key: string; multi?: boolean } | null>(null)
  const pendingFlightKey = useRef<string | null>(null)
  const pendingHoldPhoto = useRef<{ item: DrawerItem; holdIndex: number } | null>(null)
  const [scannerOpen, setScannerOpen] = useState(false)
  const [scannerItem, setScannerItem] = useState<DrawerItem | null>(null)

  // ── Load flights + bookings mapping (same pattern as Dashboard) ──────────
  useEffect(() => {
    // Clients/viewers without a linked client_id cannot query bookings
    if (isClientScoped && !clientId) {
      setFlights([])
      setClientFlightIds(new Map())
      return
    }

    let unsubBookings: (() => void) | null = null

    // Server-side date filter on flights
    const flightsConstraints: any[] = [orderBy('flight_datetime', 'desc')]
    if (dateFrom) {
      flightsConstraints.unshift(where('flight_datetime', '>=', new Date(dateFrom + 'T00:00:00').toISOString()))
    }
    if (dateTo) {
      flightsConstraints.push(where('flight_datetime', '<=', new Date(dateTo + 'T23:59:59').toISOString()))
    }
    const unsubFlights = onSnapshot(
      query(collection(db, 'airfreight_flights'), ...flightsConstraints),
      fSnap => {
        setFlights(fSnap.docs.map(d => ({ ...d.data() as AirfreightFlight, id: d.id })))

        // Nested bookings listener (same as Dashboard)
        let bookingsQ = query(collection(db, 'airfreight_bookings'), orderBy('created_at', 'desc'))
        if (isClientScoped && clientId) {
          bookingsQ = query(
            collection(db, 'airfreight_bookings'),
            where('client_id', '==', clientId),
            orderBy('created_at', 'desc'),
          )
        }

        if (unsubBookings) unsubBookings()
        unsubBookings = onSnapshot(bookingsQ, bSnap => {
          const m = new Map<string, Set<string>>()
          for (const d of bSnap.docs) {
            const { client_id: cid, flight_id } = d.data() as AirfreightBooking
            if (!m.has(cid)) m.set(cid, new Set())
            m.get(cid)!.add(flight_id)
          }
          setClientFlightIds(m)
        }, err => console.error('bookings mapping error', err))
      },
    )

    return () => {
      unsubFlights()
      if (unsubBookings) unsubBookings()
    }
  }, [isClientScoped, clientId, dateFrom, dateTo])

  // ── Load clients list (MCL only) ───────────────────────────────────────────
  useEffect(() => {
    if (!isMCL) return
    return onSnapshot(
      query(collection(db, 'airfreight_clients'), orderBy('name')),
      snap => setClients(snap.docs
        .map(d => ({ ...d.data() as AirfreightClient, id: d.id }))
        .filter(c => c.active !== false)),
    )
  }, [isMCL])

  // ── Resolve flight from booking param ─────────────────────────────────────
  useEffect(() => {
    if (!paramBooking || selectedFlightId) return
    getDoc(doc(db, 'airfreight_bookings', paramBooking)).then(snap => {
      if (snap.exists()) setSelectedFlightId((snap.data() as AirfreightBooking).flight_id)
    })
  }, [paramBooking]) // eslint-disable-line

  // ── Load flight + bookings when flight changes ─────────────────────────────
  useEffect(() => {
    if (!selectedFlightId) { setFlight(null); setBookings([]); return }
    setLoading(true)
    getDoc(doc(db, 'airfreight_flights', selectedFlightId)).then(snap => {
      if (snap.exists()) setFlight({ ...snap.data() as AirfreightFlight, id: snap.id })
    })
    // Clients/viewers can only read their own bookings (Firestore rules enforce this)
    const constraints = isClientScoped && clientId
      ? [where('flight_id', '==', selectedFlightId), where('client_id', '==', clientId), orderBy('created_at', 'asc')]
      : [where('flight_id', '==', selectedFlightId), orderBy('created_at', 'asc')]
    const q = query(collection(db, 'airfreight_bookings'), ...constraints)
    return onSnapshot(q, snap => {
      setBookings(snap.docs.map(d => ({ ...d.data() as AirfreightBooking, id: d.id })))
      setLoading(false)
    }, err => {
      console.error('bookings listener error', err)
      setLoading(false)
    })
  }, [selectedFlightId, isClientScoped, clientId])

  // ── Keep drawer in sync when bookings refresh ──────────────────────────────
  useEffect(() => {
    if (!drawerItem) return
    const fresh = bookings.find(b => b.id === drawerItem.bookingId)
    if (fresh) setDrawerItem(prev => prev ? { ...prev, booking: fresh } : null)
  }, [bookings]) // eslint-disable-line

  // ── Open drawer from URL params once bookings load ────────────────────────
  useEffect(() => {
    if (!paramBooking || bookings.length === 0 || drawerItem) return
    const b = bookings.find(bk => bk.id === paramBooking)
    if (!b) return
    if (paramAwb && (b.booking_type === 'mawb' || b.booking_type === 'ecommerce' || b.booking_type === 'export')) {
      let idx = (b.awb_lines || []).findIndex(l => l.awb_number === paramAwb)
      // Also search by awb_2nd_leg (for split lines where awb_number is empty)
      if (idx < 0) idx = (b.awb_lines || []).findIndex(l => l.awb_2nd_leg === paramAwb)
      if (idx >= 0) {
        const line = b.awb_lines![idx]
        setDrawerItem({
          id: `${b.id}_awb_${idx}`,
          label: line.awb_number || line.awb_2nd_leg || `Split #${idx + 1}`,
          subLabel: b.client_name,
          bookingId: b.id!,
          booking: b,
          awbIndex: idx,
          awbNumber: line.awb_number,
        })
      }
    } else {
      setDrawerItem({
        id: b.id!,
        label: b.awb_1st_leg || b.id!,
        subLabel: b.client_name,
        bookingId: b.id!,
        booking: b,
      })
    }
  }, [paramBooking, paramAwb, bookings]) // eslint-disable-line

  // ── Flat list for drawer prev/next ────────────────────────────────────────
  const drawerItems: DrawerItem[] = []
  for (const b of bookings) {
    if (b.booking_type === 'mawb' || b.booking_type === 'ecommerce') {
      drawerItems.push({
        id: `${b.id}_group`,
        label: b.booking_type === 'ecommerce' ? (b.client_name || '—') : (b.mawb_number || '—'),
        subLabel: b.client_name,
        bookingId: b.id!,
        booking: b,
        isGroup: true,
      })
      ;(b.awb_lines || []).forEach((line, i) => {
        drawerItems.push({
          id: `${b.id}_awb_${i}`,
          label: line.awb_number,
          subLabel: `${fmtNum(line.pieces)} pcs · ${fmtNum(line.weight)} kg`,
          bookingId: b.id!,
          booking: b,
          awbIndex: i,
          awbNumber: line.awb_number,
        })
      })
    } else if (b.booking_type === 'export') {
      // Export: line-level rows (with group header in table)
      ;(b.awb_lines || []).forEach((line, i) => {
        drawerItems.push({
          id: `${b.id}_awb_${i}`,
          label: line.awb_number,
          subLabel: `${b.client_name} · ${line.destination || ''} · ${fmtNum(line.pieces)} pcs`,
          bookingId: b.id!,
          booking: b,
          awbIndex: i,
          awbNumber: line.awb_number,
        })
      })
    } else {
      drawerItems.push({
        id: b.id!,
        label: b.awb_1st_leg || b.id!,
        subLabel: b.client_name,
        bookingId: b.id!,
        booking: b,
      })
    }
  }
  const drawerIdx = drawerItem ? drawerItems.findIndex(i => i.id === drawerItem.id) : -1

  // ── Doc slot definitions ──────────────────────────────────────────────────
  function getSlots(item: DrawerItem): DocSlotDef[] {
    const { booking, awbIndex, isGroup } = item
    if (booking.booking_type === 'ecommerce') {
      if (isGroup) return []  // No MAWB docs for ecommerce
      const line = booking.awb_lines?.[awbIndex!]
      return [
        ...(line?.loc_bond !== 'L' ? [{ key: 'doc_7512' as const, label: '7512', uploader: 'client' as const }] : []),
        { key: 'doc_hawb', label: 'Export AWB', uploader: 'client' },
        { key: 'doc_do_tsa', label: 'DO / TSA', uploader: 'both' },
        { key: 'doc_manifesto', label: 'Manifiesto', uploader: 'both' },
        { key: 'doc_import_awb', label: 'Import AWB', uploader: 'both' },
        { key: 'doc_ccsf', label: 'CCSF', uploader: 'mcl', multi: true },
        ...(line?.battery ? [{ key: 'doc_lb_checklist', label: 'LB Checklist', uploader: 'both' as const }] : []),
      ]
    }
    if (booking.booking_type === 'export') {
      if (isGroup) return [] // no group-level docs for export
      const line = booking.awb_lines?.[awbIndex!]
      const isBonded = line?.cargo_sub_type === 'bonded' || line?.cargo_sub_type === 'bonded_local'
      return [
        { key: 'doc_hawb', label: 'AWB', uploader: 'client' },
        { key: 'doc_whr', label: 'WHR', uploader: 'mcl' },
        ...(isBonded ? [{ key: 'doc_7512' as const, label: '7512', uploader: 'client' as const }] : []),
        { key: 'doc_ccsf', label: 'CCSF', uploader: 'mcl' as const, multi: true },
        { key: 'doc_do_tsa', label: 'Delivery Order', uploader: 'client' as const },
        { key: 'doc_tsa_letter', label: 'TSA Letter', uploader: 'client' as const },
        ...(line?.battery ? [{ key: 'doc_lb_checklist' as const, label: 'Checklist LB', uploader: 'both' as const }] : []),
        ...(line?.ddgg ? [{ key: 'doc_shipper_dg' as const, label: 'Shipper Declaration DDGG', uploader: 'client' as const }] : []),
      ]
    }
    if (booking.booking_type === 'mawb') {
      if (isGroup) {
        return [
          { key: 'doc_mawb_draft', label: 'Cover MAWB Draft', uploader: 'client' },
          { key: 'doc_mawb_def',   label: 'Cover MAWB Final', uploader: 'both'   },
          { key: 'doc_ccsf',       label: 'CCSF',             uploader: 'mcl', multi: true },
          { key: 'doc_lb_checklist', label: 'LB Checklist',   uploader: 'both', multi: true },
        ]
      }
      const line = booking.awb_lines?.[awbIndex!]
      // Split lines only need HAWB
      if (line?.split_from) {
        return [
          { key: 'doc_hawb', label: 'HAWB', uploader: 'client' },
        ]
      }
      return [
        ...(line?.loc_bond !== 'L' ? [{ key: 'doc_7512' as const, label: '7512', uploader: 'client' as const }] : []),
        { key: 'doc_hawb', label: 'HAWB', uploader: 'client' },
      ]
    }
    // simple — new behavior: DO/TSA, Manifesto, Import AWB at booking level (like ecommerce)
    return [
      { key: 'doc_7512',        label: '7512',         uploader: 'client' },
      { key: 'doc_mawb_draft',  label: 'AWB Draft',    uploader: 'client' },
      { key: 'doc_mawb_def',    label: 'AWB Final',    uploader: 'both'   },
      { key: 'doc_do_tsa',      label: 'DO / TSA',     uploader: 'both'   },
      { key: 'doc_manifesto',   label: 'Manifiesto',   uploader: 'both'   },
      { key: 'doc_import_awb',  label: 'Import AWB',   uploader: 'both'   },
      ...(booking.battery ? [{ key: 'doc_lb_checklist', label: 'LB Checklist', uploader: 'both' as const }] : []),
      { key: 'doc_ccsf',        label: 'CCSF',         uploader: 'mcl', multi: true },
    ]
  }

  function canUploadSlot(slot: DocSlotDef): boolean {
    if (isViewer) return false
    if (slot.uploader === 'mcl') return isMCL
    return true
  }

  // ── Multi-file slot keys ────────────────────────────────────────────────────
  // ── Booking doc upload ────────────────────────────────────────────────────
  async function processBookingFiles(files: FileList, ctx: { item: DrawerItem; key: string; multi?: boolean }) {
    if (!user) return
    const { item, key } = ctx
    setUploading(key)
    try {
      if (ctx.multi) {
        // Multi-file: upload all selected files and append to array
        const existingArr = getMultiDocsFromBooking(item.booking, key)
        const newDocs: AirfreightDocumentFile[] = []
        for (let i = 0; i < files.length; i++) {
          const file = files[i]
          const ext  = file.name.split('.').pop() || 'pdf'
          const path = storagePath({ flightNumber: flight?.flight_number, flightDate: flight?.flight_datetime, airline: flight?.airline, clientName: item.booking.client_name, mawbNumber: item.booking.mawb_number, awbNumber: item.awbNumber, filename: `${key}_${Date.now()}_${i}.${ext}` })
          const storageRef = ref(storage, path)
          await uploadBytes(storageRef, file)
          const url = await getDownloadURL(storageRef)
          newDocs.push({
            url,
            filename: file.name,
            version: 1,
            uploaded_at: new Date().toISOString(),
            uploaded_by: user.email || user.uid,
            modified_seen: false,
            history: [],
          })
        }
        const updated = [...existingArr, ...newDocs]
        await updateDoc(doc(db, 'airfreight_bookings', item.bookingId), {
          [`documents.${key}_files`]: updated,
        })
      } else {
        const file = files[0]
        const ext  = file.name.split('.').pop() || 'pdf'
        const path = storagePath({ flightNumber: flight?.flight_number, flightDate: flight?.flight_datetime, airline: flight?.airline, clientName: item.booking.client_name, mawbNumber: item.booking.mawb_number, awbNumber: item.awbNumber, filename: `${key}_${Date.now()}.${ext}` })
        const storageRef = ref(storage, path)
        await uploadBytes(storageRef, file)
        const url = await getDownloadURL(storageRef)
        const existing = getDocFromBooking(item.booking, key, item.awbIndex)
        const newDoc   = buildDocFile(file, existing, url, user.email || user.uid)

        if (item.awbIndex !== undefined) {
          const snap  = await getDoc(doc(db, 'airfreight_bookings', item.bookingId))
          const lines = [...((snap.data() as AirfreightBooking).awb_lines || [])]
          const targetIdx = resolveAwbIdx(item, lines)
          lines[targetIdx] = {
            ...lines[targetIdx],
            documents: { ...(lines[targetIdx].documents || {}), [key]: newDoc },
          }
          await updateDoc(doc(db, 'airfreight_bookings', item.bookingId), { awb_lines: lines })
        } else {
          await updateDoc(doc(db, 'airfreight_bookings', item.bookingId), {
            [`documents.${key}`]: newDoc,
          })
        }
      }
    } catch (err) {
      console.error('Booking doc upload failed:', err)
      alert('Upload failed. Check console for details.')
    } finally {
      setUploading(null)
      if (bookingFileRef.current) bookingFileRef.current.value = ''
    }
  }

  async function handleBookingFile(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    const ctx = pendingBookingUp.current
    if (!files || files.length === 0 || !ctx) return
    await processBookingFiles(files, ctx)
    pendingBookingUp.current = null
  }

  function handleBookingDrop(item: DrawerItem, key: string, multi: boolean, files: FileList) {
    processBookingFiles(files, { item, key, multi })
  }

  function triggerBookingUpload(item: DrawerItem, key: string, multi?: boolean) {
    pendingBookingUp.current = { item, key, multi }
    bookingFileRef.current?.click()
  }

  async function handleDeleteMultiDoc(item: DrawerItem, key: string, fileIndex: number) {
    if (!confirm('¿Eliminar este documento?')) return
    try {
      const existingArr = getMultiDocsFromBooking(item.booking, key)
      const fileToDelete = existingArr[fileIndex]
      // Delete from Storage
      if (fileToDelete?.url) {
        try {
          const fileRef = ref(storage, fileToDelete.url)
          await deleteObject(fileRef)
        } catch (err) {
          console.warn('Could not delete file from storage:', err)
        }
      }
      const updated = existingArr.filter((_, i) => i !== fileIndex)
      await updateDoc(doc(db, 'airfreight_bookings', item.bookingId), {
        [`documents.${key}_files`]: updated,
      })
    } catch (err) {
      console.error('Error deleting multi-doc:', err)
      alert('Error al eliminar documento')
    }
  }

  async function handleDeleteSingleDoc(item: DrawerItem, key: string) {
    if (!confirm('¿Eliminar este documento?')) return
    try {
      const existing = getDocFromBooking(item.booking, key, item.awbIndex)
      if (existing?.url) {
        try {
          const fileRef = ref(storage, existing.url)
          await deleteObject(fileRef)
        } catch (err) {
          console.warn('Could not delete file from storage:', err)
        }
      }
      if (item.awbIndex !== undefined) {
        // Line-level doc
        const snap = await getDoc(doc(db, 'airfreight_bookings', item.bookingId))
        const lines = [...((snap.data() as AirfreightBooking).awb_lines || [])]
        const line = { ...lines[item.awbIndex] }
        const docs = { ...(line.documents || {}) } as Record<string, unknown>
        delete docs[key]
        line.documents = docs as any
        lines[item.awbIndex] = line
        await updateDoc(doc(db, 'airfreight_bookings', item.bookingId), { awb_lines: lines })
      } else {
        // Booking-level doc
        await updateDoc(doc(db, 'airfreight_bookings', item.bookingId), {
          [`documents.${key}`]: null,
        })
      }
    } catch (err) {
      console.error('Error deleting doc:', err)
      alert('Error al eliminar documento')
    }
  }

  // ── Flight doc upload (supports multiple files per slot) ──────────────────
  async function processFlightFiles(files: FileList, key: string) {
    if (!flight || !user) return
    setUploading(`flight_${key}`)
    try {
      const existingArr = getFlightDocArray(flight, key)
      const newDocs = [...existingArr]

      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        const ext = file.name.split('.').pop() || 'pdf'
        const flightPath = storagePathFlight({ flightNumber: flight.flight_number, flightDate: flight.flight_datetime, airline: flight.airline, filename: `${key}_${Date.now()}_${i}.${ext}` })
        const storageRef = ref(storage, flightPath)
        await uploadBytes(storageRef, file)
        const url = await getDownloadURL(storageRef)
        newDocs.push({
          url,
          filename: file.name,
          version: 1,
          uploaded_at: new Date().toISOString(),
          uploaded_by: user.email || user.uid,
          modified_seen: false,
          history: [],
        })
      }

      // Save as array field (e.g. doc_do_tsa_files)
      const arrayKey = `${key}_files`
      await updateDoc(doc(db, 'airfreight_flights', flight.id!), { [arrayKey]: newDocs })
      setFlight(prev => prev ? { ...prev, [arrayKey]: newDocs } : prev)
    } catch (err) {
      console.error('[FlightUpload] FAILED:', err)
      alert('Upload failed — see browser console (F12) for details.')
    } finally {
      setUploading(null)
      if (flightFileRef.current) flightFileRef.current.value = ''
    }
  }

  async function handleFlightFile(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    const key = pendingFlightKey.current
    if (!files || files.length === 0 || !key) return
    await processFlightFiles(files, key)
    pendingFlightKey.current = null
  }

  function handleFlightDrop(key: string, files: FileList) {
    processFlightFiles(files, key)
  }

  /** Get flight doc array for a slot — reads both legacy single-doc and new array format */
  function getFlightDocArray(fl: Record<string, unknown>, key: string): AirfreightDocumentFile[] {
    const arrayKey = `${key}_files`
    const arr = fl[arrayKey] as AirfreightDocumentFile[] | undefined
    if (arr && arr.length > 0) return arr
    // Fallback: legacy single doc
    const single = fl[key] as AirfreightDocumentFile | undefined
    if (single?.url) return [single]
    return []
  }

  function triggerFlightUpload(key: string) {
    pendingFlightKey.current = key
    flightFileRef.current?.click()
  }

  // ── Safe AWB line lookup ────────────────────────────────────────────────
  /** Resolve the correct awb_lines index using awbNumber (safe) or awbIndex (fallback) */
  function resolveAwbIdx(item: DrawerItem, lines?: AwbSecondLeg[]): number {
    const arr = lines || item.booking.awb_lines || []
    if (item.awbNumber) {
      const idx = arr.findIndex(l => l.awb_number === item.awbNumber)
      if (idx >= 0) return idx
    }
    return item.awbIndex ?? -1
  }

  // ── Hold helpers ────────────────────────────────────────────────────────

  function getHoldsFromItem(item: DrawerItem): HoldItem[] {
    if (item.awbIndex !== undefined) {
      const idx = resolveAwbIdx(item)
      return item.booking.awb_lines?.[idx]?.holds || []
    }
    return item.booking.holds || []
  }

  function isHoldActive(item: DrawerItem): boolean {
    if (item.isGroup) return false
    // Show the Holds section for both confirmed (true) and pending holds —
    // pending AWBs still need MCL to enter bag/box numbers here.
    if (item.awbIndex !== undefined) {
      const idx = resolveAwbIdx(item)
      const h = item.booking.awb_lines?.[idx]?.hold
      return h === true || h === 'pending'
    }
    const h = item.booking.hold
    return h === true || h === 'pending'
  }

  /** Derive the hold flag from a holds array:
   *  empty → false; any hold with bag or box → true; otherwise → 'pending'. */
  function deriveHoldFlag(holds: HoldItem[]): boolean | 'pending' {
    if (holds.length === 0) return false
    if (holds.some(h => (h.bag && h.bag.trim()) || (h.box && h.box.trim()))) return true
    return 'pending'
  }

  async function saveHolds(item: DrawerItem, holds: HoldItem[]) {
    const holdFlag = deriveHoldFlag(holds)
    const awbNumber = item.awbNumber || ''
    if (item.awbIndex !== undefined) {
      const snap = await getDoc(doc(db, 'airfreight_bookings', item.bookingId))
      const lines = [...((snap.data() as AirfreightBooking).awb_lines || [])]
      const targetIdx = resolveAwbIdx(item, lines)
      lines[targetIdx] = { ...lines[targetIdx], holds, hold: holdFlag }
      await updateDoc(doc(db, 'airfreight_bookings', item.bookingId), { awb_lines: lines })
    } else {
      await updateDoc(doc(db, 'airfreight_bookings', item.bookingId), { holds, hold: holdFlag })
    }
    // Sync to airfreight_holds collection
    await syncHoldsToCollection(item.bookingId, awbNumber, item.booking, holds)
  }

  /** Sync holds from booking to airfreight_holds collection (create/update/delete) */
  async function syncHoldsToCollection(bookingId: string, awbNumber: string, booking: AirfreightBooking, holds: HoldItem[]) {
    try {
      // Get existing holds for this booking+awb
      const q = query(
        collection(db, 'airfreight_holds'),
        where('booking_id', '==', bookingId),
        where('awb_number', '==', awbNumber),
      )
      const existingSnap = await getDocs(q)
      const existingMap = new Map<string, string>() // bag|box → docId
      for (const d of existingSnap.docs) {
        const data = d.data()
        existingMap.set(`${data.bag}|${data.box}`, d.id)
      }

      const now = new Date().toISOString()
      const flightNumber = flight?.flight_number || ''
      const flightDate = flight?.flight_datetime ? flight.flight_datetime.slice(0, 10) : ''
      const newKeys = new Set<string>()

      for (const h of holds) {
        const key = `${h.bag}|${h.box}`
        newKeys.add(key)
        if (existingMap.has(key)) {
          // Already exists — skip (photo sync handled separately)
          existingMap.delete(key)
        } else if (h.bag || h.box) {
          // Create new hold in collection
          await addDoc(collection(db, 'airfreight_holds'), {
            booking_id: bookingId,
            flight_id: booking.flight_id || '',
            flight_number: flightNumber,
            flight_date: flightDate,
            client_id: booking.client_id || '',
            client_name: booking.client_name || '',
            awb_number: awbNumber,
            bag: h.bag || '',
            box: h.box || '',
            status: h.photo?.url ? 'photo_taken' : 'informed',
            hold_photo: h.photo || null,
            created_at: now,
          })
        }
      }
      // Delete holds that were removed from the booking
      for (const [, docId] of existingMap) {
        await deleteDoc(doc(db, 'airfreight_holds', docId))
      }
    } catch (err) {
      console.error('Error syncing holds to collection:', err)
    }
  }

  async function handleAddHold() {
    if (!drawerItem) return
    const holds = [...getHoldsFromItem(drawerItem), { bag: '', box: '', photo: null }]
    await saveHolds(drawerItem, holds)
  }

  async function handleUpdateHold(index: number, field: 'bag' | 'box', value: string) {
    if (!drawerItem) return
    const holds = [...getHoldsFromItem(drawerItem)]
    holds[index] = { ...holds[index], [field]: value }
    await saveHolds(drawerItem, holds)
  }

  async function handleRemoveHold(index: number) {
    if (!drawerItem) return
    const holds = getHoldsFromItem(drawerItem).filter((_, i) => i !== index)
    await saveHolds(drawerItem, holds)
  }

  function triggerHoldPhotoUpload(item: DrawerItem, holdIndex: number) {
    pendingHoldPhoto.current = { item, holdIndex }
    holdPhotoRef.current?.click()
  }

  async function handleHoldPhotoFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    const ctx = pendingHoldPhoto.current
    if (!file || !ctx || !user) return
    const { item, holdIndex } = ctx
    setUploading(`hold_${holdIndex}`)
    try {
      const ext = file.name.split('.').pop() || 'jpg'
      const path = storagePath({ flightNumber: flight?.flight_number, flightDate: flight?.flight_datetime, airline: flight?.airline, clientName: item.booking.client_name, mawbNumber: item.booking.mawb_number, awbNumber: item.awbNumber, filename: `hold_${holdIndex}_${Date.now()}.${ext}` })
      const storageRef = ref(storage, path)
      await uploadBytes(storageRef, file)
      const url = await getDownloadURL(storageRef)
      const holds = [...getHoldsFromItem(item)]
      holds[holdIndex] = {
        ...holds[holdIndex],
        photo: {
          url,
          filename: file.name,
          version: 1,
          uploaded_at: new Date().toISOString(),
          uploaded_by: user.email || user.uid,
          modified_seen: false,
          history: [],
        },
      }
      await saveHolds(item, holds)

      // Sync photo to airfreight_holds collection
      const holdItem = holds[holdIndex]
      if (holdItem.bag || holdItem.box) {
        await syncPhotoToHoldsCollection(item.bookingId, holdItem, holds[holdIndex].photo!)
      }
    } catch (err) {
      console.error('Hold photo upload failed:', err)
      alert('Error al subir foto de hold.')
    } finally {
      setUploading(null)
      pendingHoldPhoto.current = null
      if (holdPhotoRef.current) holdPhotoRef.current.value = ''
    }
  }

  /** Sync a hold photo from booking to the airfreight_holds collection */
  async function syncPhotoToHoldsCollection(
    bookingId: string, holdItem: HoldItem, photo: AirfreightDocumentFile,
  ) {
    try {
      const q = query(
        collection(db, 'airfreight_holds'),
        where('booking_id', '==', bookingId),
        where('bag', '==', holdItem.bag),
        where('box', '==', holdItem.box),
      )
      const snap = await getDocs(q)
      for (const d of snap.docs) {
        const current = d.data() as { status: string }
        await updateDoc(doc(db, 'airfreight_holds', d.id), {
          hold_photo: photo,
          // Only advance status if still 'informed'
          ...(current.status === 'informed' ? { status: 'photo_taken' } : {}),
          updated_at: new Date().toISOString(),
        })
      }
    } catch (err) {
      console.error('Error syncing photo to holds collection:', err)
    }
  }

  // ── Split / Scan helpers ─────────────────────────────────────────────────

  function getScansFromItem(item: DrawerItem): ScanItem[] {
    if (item.awbIndex !== undefined) {
      const idx = resolveAwbIdx(item)
      return item.booking.awb_lines?.[idx]?.scans || []
    }
    return []
  }

  function isSplitLine(item: DrawerItem): boolean {
    if (item.awbIndex !== undefined) {
      const idx = resolveAwbIdx(item)
      return !!item.booking.awb_lines?.[idx]?.split_from
    }
    return false
  }

  function openScanner(item: DrawerItem) {
    setScannerItem(item)
    setScannerOpen(true)
  }

  async function handleScanBarcode(result: ScanResult) {
    if (!scannerItem || !user) return
    const scans = [...getScansFromItem(scannerItem)]
    const newScan: ScanItem = {
      barcode: result.barcode,
      weight: result.weight,
      pieces: result.pieces,
      scanned_at: new Date().toISOString(),
      scanned_by: user.email || user.uid,
    }
    scans.push(newScan)
    await saveScansList(scannerItem, scans)
  }

  async function handleRemoveScan(index: number) {
    if (!drawerItem) return
    const scans = getScansFromItem(drawerItem).filter((_, i) => i !== index)
    await saveScansList(drawerItem, scans)
  }

  async function handleClearAllScans() {
    if (!drawerItem) return
    if (!confirm('¿Borrar TODOS los scans de esta pieza?')) return
    await saveScansList(drawerItem, [])
  }

  async function saveScansList(item: DrawerItem, scans: ScanItem[]) {
    if (item.awbIndex === undefined) return
    const snap = await getDoc(doc(db, 'airfreight_bookings', item.bookingId))
    const lines = [...((snap.data() as AirfreightBooking).awb_lines || [])]
    const targetIdx = resolveAwbIdx(item, lines)
    lines[targetIdx] = { ...lines[targetIdx], scans }
    await updateDoc(doc(db, 'airfreight_bookings', item.bookingId), { awb_lines: lines })
  }

  // ── Filter helpers ───────────────────────────────────────────────────────
  // For clients/viewers: only show flights where they have bookings
  // If mapping hasn't loaded yet, show NO flights (safe default)
  const myFlightSet = isClientScoped && clientId ? clientFlightIds.get(clientId) : undefined
  const clientFlightSet = selectedClientId ? clientFlightIds.get(selectedClientId) : undefined
  const filteredFlights = flights
    .filter(f => {
      const d = etdDateStr(f.flight_datetime)
      if (dateFrom && d < dateFrom) return false
      if (dateTo && d > dateTo) return false
      return true
    })
    .filter(f => !clientFlightSet || clientFlightSet.has(f.id!))
    .filter(f => !isClientScoped || (myFlightSet ? myFlightSet.has(f.id!) : false))

  // ─── Render ───────────────────────────────────────────────────────────────
  const isExportFlight = bookings.length > 0 && bookings.every(b => b.booking_type === 'export')
  // Simple-only flights: if no legacy flight-level docs exist, hide DO/TSA + Manifesto + Import AWB from flight section
  const isSimpleOnlyFlight = bookings.length > 0 && bookings.every(b => b.booking_type === 'simple')
  const hasLegacyFlightDocs = flight ? (
    (flight.doc_do_tsa_files as any)?.length > 0 || !!(flight.doc_do_tsa as any)?.url ||
    (flight.doc_manifesto_files as any)?.length > 0 || !!(flight.doc_manifesto as any)?.url
  ) : false
  const isNewSimpleFlight = isSimpleOnlyFlight && !hasLegacyFlightDocs

  const flightDocs: { key: string; label: string; uploader: 'client' | 'mcl'; generated?: boolean }[] = isExportFlight
    ? [
        { key: 'doc_distribucion', label: 'Distribution', uploader: 'mcl' },
        { key: 'doc_pallet_control', label: 'Pallet Control', uploader: 'mcl', generated: true },
      ]
    : isNewSimpleFlight
    ? [
        { key: 'doc_distribucion', label: 'Distribution', uploader: 'mcl' },
        { key: 'doc_pallet_control', label: 'Pallet Control', uploader: 'mcl', generated: true },
      ]
    : [
        { key: 'doc_do_tsa',           label: 'DO / TSA Letter',  uploader: 'client' },
        { key: 'doc_manifesto',        label: 'Manifesto',         uploader: 'client' },
        { key: 'doc_distribucion',     label: 'Distribution',      uploader: 'mcl'    },
        { key: 'doc_pallet_control',   label: 'Pallet Control',    uploader: 'mcl', generated: true },
        { key: 'doc_import_awb',       label: 'Import AWBs',       uploader: 'client' },
      ]

  const [generatingPC, setGeneratingPC] = useState(false)
  async function handleViewPalletControl() {
    if (!flight || generatingPC) return
    setGeneratingPC(true)
    try {
      const blob = await generatePalletControlOnTheFly(
        flight.id!,
        { id: flight.id!, flight_number: flight.flight_number, airline: flight.airline, flight_datetime: flight.flight_datetime, destinations: flight.destinations },
        user?.email || '',
      )
      if (!blob) { alert('No hay ULDs con piezas asignadas para este vuelo.'); return }
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank')
    } catch (e) {
      console.error(e)
      alert('Error generando Pallet Control: ' + String(e))
    } finally {
      setGeneratingPC(false)
    }
  }

  return (
    <Layout title="Documents" backTo={selectedFlightId
      ? (bookings.some(b => b.booking_type === 'export')
        ? `/airfreight/bookings/export?flight=${selectedFlightId}`
        : `/airfreight/bookings/new?flight=${selectedFlightId}`)
      : '/airfreight'}>
      {/* Hidden file inputs */}
      <input ref={bookingFileRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.xls,.xlsx,.csv" className="hidden" onChange={handleBookingFile} multiple />
      <input ref={flightFileRef}  type="file" accept=".pdf,.jpg,.jpeg,.png,.xls,.xlsx,.csv" className="hidden" onChange={handleFlightFile} multiple />
      <input ref={holdPhotoRef}   type="file" accept=".jpg,.jpeg,.png,.pdf" className="hidden" onChange={handleHoldPhotoFile} />

      <div className="space-y-4">

        {/* ── Flight selector + filters ──────────────────────────────── */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 space-y-3">
          {/* Filters row: From / To / Client */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-500 font-medium">From</label>
              <input
                type="date"
                value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
                className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-500 font-medium">To</label>
              <input
                type="date"
                value={dateTo}
                onChange={e => setDateTo(e.target.value)}
                className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
              />
            </div>
            {isMCL && clients.length > 0 && (
              <select
                value={selectedClientId}
                onChange={e => setSelectedClientId(e.target.value)}
                className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
              >
                <option value="">All clients</option>
                {clients.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            )}
          </div>
          {/* Flight dropdown */}
          <select
            value={selectedFlightId}
            onChange={e => setSelectedFlightId(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
          >
            <option value="">Select flight...</option>
            {filteredFlights.map(f => (
              <option key={f.id} value={f.id}>
                {f.airline}{f.flight_number ? ` #${f.flight_number}` : ''} · {fmtDate(f.flight_datetime)} · {f.destinations?.join(', ')}
              </option>
            ))}
          </select>
        </div>

        {flight && (
          <>
            {/* ── Flight info + flight-level docs ─────────────────────── */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 space-y-4">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-lg">✈️</span>
                <div>
                  <p className="font-semibold text-gray-800">
                    {flight.airline}{flight.flight_number ? ` · #${flight.flight_number}` : ''}
                  </p>
                  <p className="text-xs text-gray-400">{fmtDate(flight.flight_datetime)} · {flight.destinations?.join(', ')}</p>
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-bold text-gray-400 uppercase tracking-wide">Flight Documents</p>
                  <button
                    type="button"
                    onClick={() => {
                      const docs: DocEntry[] = []
                      for (const slot of flightDocs) {
                        const arr = getFlightDocArray(flight as Record<string, unknown>, slot.key)
                        arr.forEach((d, i) => {
                          docs.push({ label: `${DOC_LABELS[slot.key] || slot.label}${arr.length > 1 ? ` (${i + 1})` : ''}`, url: d.url, filename: d.filename })
                        })
                      }
                      openDocsViewer(docs, `Flight ${flight!.airline}${flight!.flight_number ? ' #' + flight!.flight_number : ''}`)
                    }}
                    disabled={!flightDocs.some(s => getFlightDocArray(flight as Record<string, unknown>, s.key).length > 0)}
                    className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-mcl-blue border border-gray-200 rounded-lg px-2.5 py-1.5 hover:bg-gray-50 transition-colors disabled:opacity-25 disabled:cursor-not-allowed"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                    </svg>
                    Print All
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                  {flightDocs.map(slot => {
                    // Generated docs (Pallet Control) — special rendering
                    if (slot.generated) {
                      return (
                        <div key={slot.key} className="border border-gray-200 rounded-lg p-3 space-y-2">
                          <div className="flex items-center justify-between gap-1">
                            <span className="text-xs font-semibold text-gray-600">{slot.label}</span>
                            <span className="text-xs text-gray-400">MCL</span>
                          </div>
                          <button
                            type="button"
                            onClick={handleViewPalletControl}
                            disabled={generatingPC}
                            className="w-full text-xs border border-gray-200 rounded-lg py-2 text-blue-600 hover:bg-blue-50 hover:border-blue-300 transition-colors disabled:opacity-50"
                          >
                            {generatingPC ? 'Generating...' : '📄 View Pallet Control'}
                          </button>
                        </div>
                      )
                    }

                    const docArr    = getFlightDocArray(flight as Record<string, unknown>, slot.key)
                    const canUpload = isViewer ? false : (slot.uploader === 'mcl' ? isMCL : true)
                    const isUp      = uploading === `flight_${slot.key}`
                    return (
                      <FlightDocSlot key={slot.key} slotKey={slot.key} canUpload={canUpload} onDrop={canUpload ? (f) => handleFlightDrop(slot.key, f) : undefined}>
                        {(dragOver) => (<>
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-xs font-semibold text-gray-600">{slot.label}</span>
                          <span className="text-xs text-gray-400">{slot.uploader === 'mcl' ? 'MCL' : 'Client'}</span>
                        </div>
                        {docArr.length > 0 && (
                          <div className="space-y-1.5">
                            {docArr.map((d, i) => (
                              <div key={i} className="flex items-center gap-2">
                                <a href={d.url} target="_blank" rel="noopener noreferrer"
                                  className="text-xs text-blue-600 hover:underline truncate flex-1">
                                  📄 {d.filename}
                                </a>
                                <span className="text-xs text-gray-400 shrink-0">{fmtDate(d.uploaded_at)}</span>
                                {canUpload && (
                                  <button
                                    type="button"
                                    onClick={async () => {
                                      if (!confirm(`¿Eliminar "${d.filename}"?`)) return
                                      const updated = docArr.filter((_, idx) => idx !== i)
                                      const arrayKey = `${slot.key}_files`
                                      await updateDoc(doc(db, 'airfreight_flights', flight!.id!), {
                                        [arrayKey]: updated.length > 0 ? updated : null,
                                        [slot.key]: updated.length > 0 ? updated[0] : null,
                                      })
                                      setFlight(prev => prev ? { ...prev, [arrayKey]: updated.length > 0 ? updated : null, [slot.key]: updated.length > 0 ? updated[0] : null } : prev)
                                    }}
                                    className="text-xs text-red-400 hover:text-red-600 shrink-0"
                                    title="Eliminar archivo"
                                  >
                                    ✕
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                        {canUpload && (
                          <button type="button" onClick={() => triggerFlightUpload(slot.key)}
                            disabled={!!uploading}
                            className={`w-full text-xs border border-dashed rounded-lg py-2 transition-colors ${dragOver ? 'border-mcl-blue text-mcl-blue' : 'border-gray-200 text-gray-400 hover:border-mcl-blue hover:text-mcl-blue'}`}>
                            {isUp ? 'Uploading...' : dragOver ? 'Soltar aquí' : '+ Upload'}
                          </button>
                        )}
                        {docArr.length === 0 && !canUpload && (
                          <p className="text-xs text-gray-300">Not uploaded</p>
                        )}
                        </>)}
                      </FlightDocSlot>
                    )
                  })}
                </div>
              </div>
            </div>

            {/* ── AWB table ─────────────────────────────────────────────── */}
            {loading ? (
              <div className="flex justify-center py-10">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-mcl-blue" />
              </div>
            ) : bookings.length === 0 ? (
              <div className="text-center py-10 text-gray-400 text-sm bg-white rounded-xl border border-gray-100">
                No bookings for this flight
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-x-auto">
                <table className="w-full text-sm min-w-[600px]">
                  <thead>
                    {isExportFlight ? (
                      <tr className="bg-gray-50 text-xs font-bold text-gray-500 uppercase tracking-wide border-b border-gray-200">
                        <th className="px-3 py-3 text-center w-8">#</th>
                        <th className="px-3 py-3 text-center">DEST</th>
                        <th className="px-3 py-3 text-left">AWB #</th>
                        <th className="px-3 py-3 text-center">PCS</th>
                        <th className="px-3 py-3 text-center">GW</th>
                        <th className="px-3 py-3 text-center">VW</th>
                        <th className="px-3 py-3 text-center">CHW</th>
                        <th className="px-3 py-3 text-center w-8" title="Lithium Battery">🔋</th>
                        <th className="px-3 py-3 text-center w-8" title="Dangerous Goods">⚠️</th>
                        <th className="px-3 py-3 text-center">Status</th>
                        <th className="px-3 py-3 text-center">Upload</th>
                        <th className="px-3 py-3 text-center w-10"></th>
                      </tr>
                    ) : (
                      <tr className="bg-gray-50 text-xs font-bold text-gray-500 uppercase tracking-wide border-b border-gray-200">
                        <th className="px-4 py-3 text-left">AWB / MAWB</th>
                        <th className="px-4 py-3 text-left">2nd Leg</th>
                        <th className="px-4 py-3 text-center">PCS</th>
                        <th className="px-4 py-3 text-center">SLACS</th>
                        <th className="px-4 py-3 text-center">KG</th>
                        <th className="px-4 py-3 text-center">Status</th>
                        <th className="px-4 py-3 text-center">Upload</th>
                        <th className="px-4 py-3 text-center w-10"></th>
                      </tr>
                    )}
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {bookings.map(b => {
                      if (b.booking_type === 'mawb' || b.booking_type === 'ecommerce') {
                        const groupItem: DrawerItem = {
                          id: `${b.id}_group`, label: b.booking_type === 'ecommerce' ? (b.client_name || '—') : (b.mawb_number || '—'),
                          subLabel: b.client_name, bookingId: b.id!, booking: b, isGroup: true,
                        }
                        const totPcs  = (b.awb_lines || []).reduce((s, l) => s + (l.pieces || 0), 0)
                        const totSlacs = (b.awb_lines || []).reduce((s, l) => s + (l.slacs || 0), 0)
                        const totKg   = (b.awb_lines || []).reduce((s, l) => s + (l.weight  || 0), 0)
                        return (
                          <Fragment key={b.id}>
                            {/* MAWB/Ecommerce group header */}
                            <tr className={b.booking_type === 'ecommerce' ? 'bg-green-50/40' : 'bg-purple-50/40'}>
                              <td className="px-4 py-2" colSpan={2}>
                                <div className="flex items-center gap-2">
                                  <span className={`font-mono text-xs font-bold ${b.booking_type === 'ecommerce' ? 'text-green-700' : 'text-purple-700'}`}>
                                    {b.booking_type === 'ecommerce' ? (b.client_name || '—') : (b.mawb_number || '—')}
                                  </span>
                                  {b.booking_type !== 'ecommerce' && <span className="text-xs text-gray-400">{b.client_name}</span>}
                                  <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${b.booking_type === 'ecommerce' ? 'bg-green-100 text-green-600' : 'bg-purple-100 text-purple-600'}`}>
                                    {b.booking_type === 'ecommerce' ? 'Ecommerce' : 'MAWB'}
                                  </span>
                                </div>
                              </td>
                              <td className="px-4 py-2 text-center text-xs text-gray-500">{fmtNum(totPcs)}</td>
                              <td className="px-4 py-2 text-center text-xs text-gray-500">{totSlacs || '—'}</td>
                              <td className="px-4 py-2 text-center text-xs text-gray-500">{fmtNum(totKg)}</td>
                              <td className="px-4 py-2 text-center">
                                <StatusDot status={getMawbGroupStatus(b)} />
                              </td>
                              <td className="px-4 py-2 text-center">
                                <UploadIcon onClick={() => setDrawerItem(groupItem)} />
                              </td>
                              <td className="px-4 py-2 text-center">
                                <PrintIcon
                                  onClick={() => openDocsViewer(collectBookingDocs(b, undefined, true), `MAWB ${b.mawb_number || '—'}`)}
                                  disabled={collectBookingDocs(b, undefined, true).length === 0}
                                />
                              </td>
                            </tr>
                            {/* Sub-AWB rows */}
                            {(b.awb_lines || []).map((line, idx) => {
                              const awbItem: DrawerItem = {
                                id: `${b.id}_awb_${idx}`, label: line.awb_number,
                                subLabel: b.client_name, bookingId: b.id!, booking: b, awbIndex: idx, awbNumber: line.awb_number,
                              }
                              return (
                                <tr key={idx} className="hover:bg-gray-50/50">
                                  <td className="px-4 py-2 pl-8 font-mono text-xs text-gray-600 max-w-[180px] break-all whitespace-pre-wrap">{line.awb_number}</td>
                                  <td className="px-4 py-2 font-mono text-xs text-gray-400">{line.awb_2nd_leg || '—'}</td>
                                  <td className="px-4 py-2 text-center text-xs text-gray-600">{fmtNum(line.pieces)}</td>
                                  <td className="px-4 py-2 text-center text-xs text-gray-600">{line.slacs || '—'}</td>
                                  <td className="px-4 py-2 text-center text-xs text-gray-600">{fmtNum(line.weight)}</td>
                                  <td className="px-4 py-2 text-center">
                                    <StatusDot status={getMawbAwbStatus(line)} />
                                  </td>
                                  <td className="px-4 py-2 text-center">
                                    <UploadIcon onClick={() => setDrawerItem(awbItem)} />
                                  </td>
                                  <td className="px-4 py-2 text-center">
                                    <PrintIcon
                                      onClick={() => {
                                      const line = b.awb_lines?.[idx]
                                      openDocsViewer(collectBookingDocs(b, idx), `AWB ${line?.awb_number || '—'}`)
                                    }}
                                      disabled={collectBookingDocs(b, idx).length === 0}
                                    />
                                  </td>
                                </tr>
                              )
                            })}
                          </Fragment>
                        )
                      }

                      if (b.booking_type === 'export') {
                        // Export: flat rows with export-specific columns
                        return (
                          <Fragment key={b.id}>
                            {(b.awb_lines || []).map((line, idx) => {
                              const awbItem: DrawerItem = {
                                id: `${b.id}_awb_${idx}`, label: line.awb_number,
                                subLabel: `${line.destination || ''} · ${fmtNum(line.pieces)} pcs · ${fmtNum(line.weight)} kg`,
                                bookingId: b.id!, booking: b, awbIndex: idx, awbNumber: line.awb_number,
                              }
                              return (
                                <tr key={idx} className="hover:bg-gray-50/50">
                                  <td className="px-3 py-2 text-center text-xs text-gray-400">{idx + 1}</td>
                                  <td className="px-3 py-2 text-center">
                                    <span className="text-xs font-mono font-semibold text-mcl-blue">{line.destination || '—'}</span>
                                  </td>
                                  <td className="px-3 py-2 font-mono text-xs text-gray-700 font-medium">{line.awb_number}</td>
                                  <td className="px-3 py-2 text-center text-xs text-gray-600">{fmtNum(line.pieces)}</td>
                                  <td className="px-3 py-2 text-center text-xs text-gray-600">{fmtNum(line.weight)}</td>
                                  <td className="px-3 py-2 text-center text-xs text-gray-600">{fmtNum(line.volume_weight)}</td>
                                  <td className="px-3 py-2 text-center text-xs text-gray-600">{fmtNum(line.chargeable_weight)}</td>
                                  <td className="px-3 py-2 text-center text-xs">{line.battery ? '🔋' : ''}</td>
                                  <td className="px-3 py-2 text-center text-xs">{line.ddgg ? '⚠️' : ''}</td>
                                  <td className="px-3 py-2 text-center">
                                    <StatusDot status={getMawbAwbStatus(line)} />
                                  </td>
                                  <td className="px-3 py-2 text-center">
                                    <UploadIcon onClick={() => setDrawerItem(awbItem)} />
                                  </td>
                                  <td className="px-3 py-2 text-center">
                                    <PrintIcon
                                      onClick={() => openDocsViewer(collectBookingDocs(b, idx), `AWB ${line.awb_number || '—'}`)}
                                      disabled={collectBookingDocs(b, idx).length === 0}
                                    />
                                  </td>
                                </tr>
                              )
                            })}
                            {/* Totals row */}
                            {(b.awb_lines || []).length > 1 && (() => {
                              const lines = b.awb_lines || []
                              const tPcs = lines.reduce((s, l) => s + (l.pieces || 0), 0)
                              const tGw  = lines.reduce((s, l) => s + (l.weight || 0), 0)
                              const tVw  = lines.reduce((s, l) => s + (l.volume_weight || 0), 0)
                              const tChw = lines.reduce((s, l) => s + (l.chargeable_weight || 0), 0)
                              return (
                                <tr className="bg-gray-50 border-t-2 border-gray-200">
                                  <td colSpan={3} className="px-3 py-2 text-right text-xs font-bold text-gray-500">TOTAL</td>
                                  <td className="px-3 py-2 text-center text-xs font-bold text-gray-700">{tPcs}</td>
                                  <td className="px-3 py-2 text-center text-xs font-bold text-gray-700">{tGw}</td>
                                  <td className="px-3 py-2 text-center text-xs font-bold text-gray-700">{tVw || '—'}</td>
                                  <td className="px-3 py-2 text-center text-xs font-bold text-gray-700">{tChw || '—'}</td>
                                  <td colSpan={5}></td>
                                </tr>
                              )
                            })()}
                          </Fragment>
                        )
                      }

                      // Simple booking
                      const simpleItem: DrawerItem = {
                        id: b.id!, label: b.awb_1st_leg || b.id!,
                        subLabel: b.client_name, bookingId: b.id!, booking: b,
                      }
                      return (
                        <tr key={b.id} className="hover:bg-gray-50/50">
                          <td className="px-4 py-3 font-mono text-xs text-gray-700 font-medium">{b.awb_1st_leg || '—'}</td>
                          <td className="px-4 py-3 font-mono text-xs text-gray-400">{b.awb_2nd_leg || '—'}</td>
                          <td className="px-4 py-3 text-center text-xs text-gray-600">{fmtNum(b.pieces)}</td>
                          <td className="px-4 py-3 text-center text-xs text-gray-600">{b.slacs || '—'}</td>
                          <td className="px-4 py-3 text-center text-xs text-gray-600">{fmtNum(b.weight)}</td>
                          <td className="px-4 py-3 text-center">
                            <StatusDot status={getSimpleStatus(b)} />
                          </td>
                          <td className="px-4 py-3 text-center">
                            <UploadIcon onClick={() => setDrawerItem(simpleItem)} />
                          </td>
                          <td className="px-4 py-3 text-center">
                            <PrintIcon
                              onClick={() => openDocsViewer(collectBookingDocs(b), `AWB ${b.awb_1st_leg || '—'}`)}
                              disabled={collectBookingDocs(b).length === 0}
                            />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Slide-over drawer ──────────────────────────────────────────────── */}
      {drawerItem && (
        <>
          <div className="fixed inset-0 bg-black/20 z-40" onClick={() => setDrawerItem(null)} />
          <div className="fixed top-0 right-0 h-full w-full sm:w-[420px] bg-white shadow-2xl z-50 flex flex-col">

            {/* Drawer header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div className="min-w-0">
                <p className="font-semibold text-gray-800 font-mono text-sm truncate">{drawerItem.label}</p>
                {drawerItem.subLabel && <p className="text-xs text-gray-400 truncate">{drawerItem.subLabel}</p>}
              </div>
              <div className="flex items-center gap-1 shrink-0 ml-3">
                <button type="button"
                  disabled={drawerIdx <= 0}
                  onClick={() => setDrawerItem(drawerItems[drawerIdx - 1])}
                  className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-25 transition-colors">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <span className="text-xs text-gray-400 tabular-nums px-1">
                  {drawerIdx + 1}/{drawerItems.length}
                </span>
                <button type="button"
                  disabled={drawerIdx >= drawerItems.length - 1}
                  onClick={() => setDrawerItem(drawerItems[drawerIdx + 1])}
                  className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-25 transition-colors">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
                <button type="button" onClick={() => setDrawerItem(null)}
                  className="p-1.5 ml-1 rounded hover:bg-gray-100 transition-colors text-gray-400">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Doc slots + Holds */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                {getSlots(drawerItem).map(slot => slot.multi ? (
                  <MultiDocSlotCard
                    key={slot.key}
                    slot={slot}
                    files={getMultiDocsFromBooking(drawerItem.booking, slot.key)}
                    canUpload={canUploadSlot(slot)}
                    uploading={uploading === slot.key}
                    onUpload={() => triggerBookingUpload(drawerItem, slot.key, true)}
                    onDelete={canUploadSlot(slot) ? (i) => handleDeleteMultiDoc(drawerItem, slot.key, i) : undefined}
                    onDrop={canUploadSlot(slot) ? (f) => handleBookingDrop(drawerItem, slot.key, true, f) : undefined}
                  />
                ) : (
                  <DocSlotCard
                    key={slot.key}
                    slot={slot}
                    existing={getDocFromBooking(drawerItem.booking, slot.key, drawerItem.awbIndex)}
                    canUpload={canUploadSlot(slot)}
                    uploading={uploading === slot.key}
                    onUpload={() => triggerBookingUpload(drawerItem, slot.key, false)}
                    onDelete={canUploadSlot(slot) && getDocFromBooking(drawerItem.booking, slot.key, drawerItem.awbIndex) ? () => handleDeleteSingleDoc(drawerItem, slot.key) : undefined}
                    onDrop={canUploadSlot(slot) ? (f) => handleBookingDrop(drawerItem, slot.key, false, f) : undefined}
                  />
                ))}
              </div>

              {/* ── Holds section (only if hold flag is active) ────────── */}
              {isHoldActive(drawerItem) && (() => {
                const holds = getHoldsFromItem(drawerItem)
                return (
                  <div className="border border-orange-200 rounded-xl p-4 space-y-3 bg-orange-50/40">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="inline-block w-3 h-3 rounded-full bg-orange-500" />
                        <span className="text-sm font-semibold text-gray-700">Holds</span>
                        {holds.length > 0 && (
                          <span className="text-xs text-gray-400">
                            {holds.filter(h => h.photo).length}/{holds.length} fotos
                          </span>
                        )}
                      </div>
                      {(isClient || isMCL) && (
                        <button
                          type="button"
                          onClick={handleAddHold}
                          className="text-xs bg-orange-100 text-orange-700 hover:bg-orange-200 px-2.5 py-1 rounded-lg font-medium transition-colors"
                        >
                          + Agregar
                        </button>
                      )}
                    </div>

                    {holds.length === 0 ? (
                      <p className="text-xs text-gray-400 py-2 text-center">Sin holds registrados</p>
                    ) : (
                      <div className="space-y-2">
                        {holds.map((hold, idx) => (
                          <div key={idx} className="bg-white rounded-lg border border-gray-100 p-3 space-y-2">
                            <div className="flex items-center gap-2">
                              <div className="flex-1">
                                <label className="text-xs text-gray-400 font-medium"># Bag</label>
                                <input
                                  type="text"
                                  defaultValue={hold.bag}
                                  onBlur={e => { if (e.target.value !== hold.bag) handleUpdateHold(idx, 'bag', e.target.value) }}
                                  placeholder="—"
                                  className="w-full border border-gray-200 rounded px-2 py-1 text-sm mt-0.5"
                                  readOnly={!isClient && !isMCL}
                                />
                              </div>
                              <div className="flex-1">
                                <label className="text-xs text-gray-400 font-medium"># Box</label>
                                <input
                                  type="text"
                                  defaultValue={hold.box}
                                  onBlur={e => { if (e.target.value !== hold.box) handleUpdateHold(idx, 'box', e.target.value) }}
                                  placeholder="—"
                                  className="w-full border border-gray-200 rounded px-2 py-1 text-sm mt-0.5"
                                  readOnly={!isClient && !isMCL}
                                />
                              </div>
                              {(isClient || isMCL) && (
                                <button
                                  type="button"
                                  onClick={() => handleRemoveHold(idx)}
                                  className="text-gray-300 hover:text-red-500 transition-colors mt-4"
                                  title="Eliminar hold"
                                >
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                  </svg>
                                </button>
                              )}
                            </div>

                            {/* Photo */}
                            <div className="flex items-center justify-between gap-2">
                              {hold.photo ? (
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-green-500 shrink-0" />
                                  <a
                                    href={hold.photo.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-xs text-blue-600 hover:underline truncate"
                                  >
                                    {hold.photo.filename}
                                  </a>
                                  {isMCL && (
                                    <button
                                      type="button"
                                      onClick={() => triggerHoldPhotoUpload(drawerItem, idx)}
                                      disabled={!!uploading}
                                      className="text-xs text-gray-400 hover:text-gray-600 shrink-0"
                                    >
                                      {uploading === `hold_${idx}` ? '...' : '↑'}
                                    </button>
                                  )}
                                </div>
                              ) : isMCL ? (
                                <button
                                  type="button"
                                  onClick={() => triggerHoldPhotoUpload(drawerItem, idx)}
                                  disabled={!!uploading}
                                  className="w-full text-xs border border-dashed border-orange-300 rounded-lg py-2 text-orange-400 hover:border-orange-500 hover:text-orange-600 transition-colors flex items-center justify-center gap-1.5"
                                >
                                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                      d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                                  </svg>
                                  {uploading === `hold_${idx}` ? 'Subiendo...' : 'Subir foto'}
                                </button>
                              ) : (
                                <div className="flex items-center gap-2">
                                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-red-400 shrink-0" />
                                  <span className="text-xs text-gray-400">Pendiente foto MCL</span>
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })()}

              {/* ── Split / Scans section (only for split lines) ───────── */}
              {isSplitLine(drawerItem) && (() => {
                const scans = getScansFromItem(drawerItem)
                const totalSlacs = scans.reduce((s, sc) => s + sc.pieces, 0)
                const totalKg = scans.reduce((s, sc) => s + sc.weight, 0)
                const awbIdx = resolveAwbIdx(drawerItem)
                const splitLine = drawerItem.booking.awb_lines?.[awbIdx]
                const parentLine = splitLine?.split_from
                  ? drawerItem.booking.awb_lines?.find(l => l.awb_number === splitLine.split_from && !l.split_from)
                  : null
                const expectedPieces = parentLine?.pieces || splitLine?.pieces || 0
                const scansDone = scans.length === expectedPieces
                return (
                  <div className="border border-purple-200 rounded-xl p-4 space-y-3 bg-purple-50/40">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-sm">✂️</span>
                        <span className="text-sm font-semibold text-gray-700">Split Scans</span>
                        {expectedPieces > 0 ? (
                          <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full ${scansDone ? 'bg-green-100 text-green-700' : 'bg-purple-100 text-purple-700'}`}>
                            {scans.length}/{expectedPieces}
                          </span>
                        ) : scans.length > 0 ? (
                          <span className="text-xs text-gray-400">{scans.length} escaneados</span>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-1.5">
                        {isMCL && scans.length > 0 && (
                          <button
                            type="button"
                            onClick={handleClearAllScans}
                            className="text-xs bg-red-50 text-red-600 hover:bg-red-100 px-2 py-1 rounded-lg font-medium transition-colors flex items-center gap-1"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                            Borrar todos
                          </button>
                        )}
                        {isMCL && (
                          <button
                            type="button"
                            onClick={() => openScanner(drawerItem)}
                            className="text-xs bg-purple-100 text-purple-700 hover:bg-purple-200 px-2.5 py-1 rounded-lg font-medium transition-colors flex items-center gap-1"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
                            </svg>
                            Escanear
                          </button>
                        )}
                      </div>
                    </div>

                    {scans.length === 0 ? (
                      <p className="text-xs text-gray-400 py-2 text-center">Sin scans registrados</p>
                    ) : (
                      <div className="space-y-1">
                        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-1 text-[10px] text-gray-400 font-medium uppercase px-1">
                          <span>Código</span>
                          <span className="text-center w-12">Slacs</span>
                          <span className="text-right w-14">Kg</span>
                          <span className="w-4" />
                        </div>
                        {scans.map((scan, idx) => (
                          <div key={idx} className="grid grid-cols-[1fr_auto_auto_auto] gap-1 items-center bg-white rounded-lg border border-gray-100 px-2 py-1.5 group">
                            <span className="font-mono text-xs text-gray-700 truncate">{scan.barcode}</span>
                            <span className="text-xs text-gray-500 text-center w-12">{fmtNum(scan.pieces)}</span>
                            <span className="text-xs text-gray-500 text-right w-14">{fmtNum(scan.weight)}</span>
                            <div className="w-4 flex justify-end">
                              {isMCL && (
                                <button
                                  type="button"
                                  onClick={() => handleRemoveScan(idx)}
                                  className="text-red-400 hover:text-red-600 transition-colors"
                                >
                                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                  </svg>
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                        {/* Totals */}
                        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-1 px-2 pt-2 border-t border-purple-200">
                          <span className="text-xs font-semibold text-gray-600">Total</span>
                          <span className="text-xs font-semibold text-gray-600 text-center w-12">{totalSlacs}</span>
                          <span className="text-xs font-semibold text-gray-600 text-right w-14">{fmtNum(totalKg)}</span>
                          <span className="w-4" />
                        </div>
                        <div className="grid grid-cols-[1fr_auto] gap-1 px-2 pt-1">
                          <span className="text-xs font-semibold text-purple-700">Piezas (códigos escaneados)</span>
                          <span className="text-xs font-bold text-purple-700">{scans.length}</span>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })()}
            </div>
          </div>
        </>
      )}

      {/* Barcode Scanner Modal */}
      <BarcodeScannerModal
        open={scannerOpen}
        onScan={handleScanBarcode}
        onClose={() => { setScannerOpen(false); setScannerItem(null) }}
        scannedCodes={scannerItem ? getScansFromItem(scannerItem).map(s => s.barcode) : []}
        expectedTotal={scannerItem ? (() => {
          const idx = resolveAwbIdx(scannerItem)
          const line = scannerItem.booking.awb_lines?.[idx]
          const parent = line?.split_from
            ? scannerItem.booking.awb_lines?.find(l => l.awb_number === line.split_from && !l.split_from)
            : null
          return parent?.pieces || line?.pieces || 0
        })() : undefined}
      />
    </Layout>
  )
}
