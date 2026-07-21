import { useState, useEffect, useMemo, Fragment, useRef, ChangeEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  collection, query, orderBy, onSnapshot, where, doc, updateDoc, deleteDoc,
  addDoc, getDocs, writeBatch, limit,
} from 'firebase/firestore'
import { ref as fbStorageRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage'
import * as XLSX from 'xlsx'
import { db, storage } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import { AirfreightFlight, AirfreightBooking, AwbSecondLeg, AirfreightDocumentFile, AirfreightHold, AirfreightClient, ChangeLogEntry, AuditLogEntry } from '../../types'
import Layout from '../../components/Layout'
import { storagePath } from '../../lib/utils'
import { calculateAirfreightCharges, undoDispatchCharges } from '../../lib/airBilling'
import { awbIndexField } from '../../lib/bookingAwbIndex'
import { normalizeAwb } from '../../lib/awbNormalize'

/** Clean up doc_receptions and physical_pieces when a booking is deleted (HAL-07). */
async function cascadeDeleteBooking(bookingId: string) {
  try {
    const drSnap = await getDocs(query(
      collection(db, 'airfreight_doc_receptions'),
      where('booking_id', '==', bookingId),
    ))
    if (drSnap.empty) return
    const batch = writeBatch(db)
    for (const drDoc of drSnap.docs) {
      // Delete physical pieces linked to this doc_reception
      const ppSnap = await getDocs(query(
        collection(db, 'airfreight_physical_pieces'),
        where('doc_reception_id', '==', drDoc.id),
      ))
      for (const ppDoc of ppSnap.docs) {
        batch.delete(ppDoc.ref)
      }
      batch.delete(drDoc.ref)
    }
    await batch.commit()
  } catch (err) {
    console.error('Cascade delete for booking failed:', err)
  }
}

/** Strip undefined values from an object (Firestore rejects undefined). */
function stripUndefined(obj: any): any {
  if (Array.isArray(obj)) return obj.map(stripUndefined)
  if (obj && typeof obj === 'object' && !(obj instanceof Date)) {
    const out: any = {}
    for (const [k, v] of Object.entries(obj)) {
      if (v !== undefined) out[k] = stripUndefined(v)
    }
    return out
  }
  return obj
}

function mkAudit(action: string, user: string, detail?: string, field?: string, oldVal?: string, newVal?: string): AuditLogEntry {
  return { action, user, at: new Date().toISOString(), detail, field, old_value: oldVal, new_value: newVal }
}

function appendAudit(line: AwbSecondLeg, entry: AuditLogEntry): AwbSecondLeg {
  return { ...line, audit_log: [...(line.audit_log || []), entry] }
}

function isYes(val: string): boolean {
  const v = val.trim().toUpperCase()
  return v === 'Y' || v === 'YES' || v === 'SI' || v === 'X' || v === 'TRUE' || v === '1'
}

/** Normalize AWB number for duplicate detection: strip all non-alphanumeric, uppercase */
function normalizeAwb(awb: string | undefined | null): string {
  return (awb || '').replace(/[^A-Z0-9]/gi, '').toUpperCase()
}

/**
 * Merge fields from an old AWB line into a new one (from Excel).
 * Excel wins on operational data (pieces, weight, uld, pickup, etc.).
 * Old line wins on documents + physical state (docs, scans, holds, on_hand, screening, etc.).
 * If moveLogEntry is provided, appends it to move_log.
 */
function mergePreservedFields(newLine: any, oldLine: any, moveLogEntry?: any): any {
  const merged: any = { ...newLine }
  const preserveKeys = [
    'documents',
    'doc_acceptance', 'doc_whr', 'doc_mcl_transfer', 'doc_screening_cert',
    'screening_details', 'screening_status', 'screening_pieces_screened',
    'scans', 'holds', 'hold', 'on_hand', 'drop_off_time',
    'transport_company', 'transport_status', 'transport_docs',
    'split', 'split_from',
    'warehouse_status', 'docs_in_drive',
  ]
  for (const k of preserveKeys) {
    if (oldLine[k] !== undefined) merged[k] = oldLine[k]
  }
  const existingMoveLog = Array.isArray(oldLine.move_log) ? oldLine.move_log : []
  merged.move_log = moveLogEntry ? [...existingMoveLog, moveLogEntry] : existingMoveLog
  return merged
}

// ─── Types ──────────────────────────────────────────────────────────────────

type FlightDoc = AirfreightFlight & { id: string }
type BookingDoc = AirfreightBooking & { id: string }

/** Flat row that represents a single AWB line for display/editing */
interface BookingRow {
  rowId: string
  bookingId: string
  awbIndex: number
  flightId: string
  // Flight-level (inherited)
  flightNumber: string
  etd: string
  cutoff: string
  destination: string
  deliverTo: string
  airline: string
  flightStatus: 'booked' | 'terminado' | 'dispatched'
  // Booking-level
  clientId: string
  clientName: string
  // AWB-level
  awb1st: string
  awb2nd: string
  uldType: string
  pieces: number
  chargeableWeight: number
  pickupFrom: string
  readyForPickup: string
  lastDayFree: string
  holdBg: string
  holdBox: string
  lb: boolean
  dg: boolean
  notes: string
  editedAt?: string
  editedBy?: string
  docsStatus: 'none' | 'partial' | 'client_complete' | 'complete'
  // On Hand / Dispatched (per-AWB). Syncs with Transportation (on_hand/drop_off_time)
  // and with flight-level dispatch (all lines dispatched ⇒ flight dispatched).
  onHand: boolean
  warehouseStatus: string | null  // D=Documented, R=Received, B=Built, L=Loaded, T=Tendered
  dispatched: boolean
  dispatchedAt?: string | null
  dispatchedBy?: string | null
  booking: BookingDoc
  flight: FlightDoc
}

type SortKey = 'etd' | 'last_day_free' | 'ready' | 'flight_number'
type SortDir = 'asc' | 'desc'

/** Editable field keys */
type EditableField =
  | 'flightNumber' | 'etd' | 'cutoff' | 'destination' | 'deliverTo'
  | 'awb1st' | 'awb2nd' | 'uldType' | 'pieces' | 'chargeableWeight'
  | 'pickupFrom' | 'readyForPickup' | 'lastDayFree'
  | 'holdBg' | 'holdBox' | 'lb' | 'dg' | 'notes'

const INHERITED_FIELDS: EditableField[] = ['etd', 'cutoff', 'destination', 'deliverTo']

/** Max AWB rows per page (flights are never split across pages) */
const PAGE_SIZE = 25

// ─── Helpers ────────────────────────────────────────────────────────────────

function hasDocFile(d?: AirfreightDocumentFile) {
  return !!(d && d.url)
}

function computeDocsStatus(line: AwbSecondLeg): BookingRow['docsStatus'] {
  // Per-slot model: status driven by individual document slots in line.documents
  const docs = (line.documents || {}) as Record<string, AirfreightDocumentFile | undefined>
  const needsBonded = line.loc_bond !== 'L'
  const slots: string[] = ['doc_hawb']
  if (needsBonded) slots.push('doc_7512')
  // Count how many slots have a file
  const filled = slots.filter(k => !!(docs[k]?.url)).length
  if (filled === slots.length) return 'complete'
  if (filled > 0) return 'client_complete'
  return 'none'
}

function fmtDateInput(iso: string): string {
  if (!iso) return ''
  return iso.slice(0, 10)
}

function fmtDateTimeShort(iso: string): string {
  if (!iso) return '—'
  const [d, t] = iso.split('T')
  const [y, m, day] = (d || '').split('-')
  if (!y || !m || !day) return iso
  const short = `${m}/${day}/${y.slice(2)}`
  if (!t) return short
  return `${short} ${t.slice(0, 5)}`
}

/** Full year variant (MM/DD/YYYY [HH:MM]). Returns '' for empty input. */
function fmtDateTimeFull(iso: string): string {
  if (!iso) return ''
  const [d, t] = iso.split('T')
  const [y, m, day] = (d || '').split('-')
  if (!y || !m || !day) return ''
  const base = `${m}/${day}/${y}`
  if (!t) return base
  return `${base} ${t.slice(0, 5)}`
}

function fmtDateTimeLocal(iso: string): string {
  if (!iso) return ''
  const [d, t] = iso.split('T')
  if (!d) return ''
  return `${d}T${(t || '00:00').slice(0, 5)}`
}

function makeEmptyLine(): AwbSecondLeg {
  return {
    awb_number: '',
    pieces: 0,
    weight: 0,
    chargeable_weight: 0,
    uld_type: 'LOOSE',
    battery: false,
    ddgg: false,
    hold: false,
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function AirfreightBookingList() {
  const { user, isAdmin, isSuperAgent, isAgent, isCounter, isBodega, isClient, clientId } = useAuth()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const flightFilter = searchParams.get('flight') || ''
  const isMcl = isAdmin || isSuperAgent || isAgent || isCounter || isBodega

  const [flights, setFlights] = useState<FlightDoc[]>([])
  const [bookings, setBookings] = useState<BookingDoc[]>([])
  const [loading, setLoading] = useState(true)

  // Filters
  const defaultFrom = new Date(); defaultFrom.setDate(defaultFrom.getDate() - 10)
  const [etdFrom, setEtdFrom] = useState(defaultFrom.toLocaleDateString('en-CA'))
  const [etdTo, setEtdTo] = useState('')
  const [clientFilter, setClientFilter] = useState('')
  const [awbSearch, setAwbSearch] = useState('')

  // Status filter — server-side on flights query.
  // 'booked' by default to bound the listener. Persisted in localStorage.
  type FlightStatusFilter = 'booked' | 'terminado' | 'dispatched' | 'all'
  const [flightStatusFilter, setFlightStatusFilter] = useState<FlightStatusFilter>(() => {
    if (typeof window === 'undefined') return 'booked'
    const stored = window.localStorage.getItem('mcl.bookingList.flightStatusFilter') as FlightStatusFilter | null
    if (stored === 'booked' || stored === 'terminado' || stored === 'dispatched' || stored === 'all') return stored
    return 'booked'
  })
  useEffect(() => {
    try { window.localStorage.setItem('mcl.bookingList.flightStatusFilter', flightStatusFilter) } catch {}
  }, [flightStatusFilter])

  // Sorting
  const [sortKey, setSortKey] = useState<SortKey>('etd')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  // Inline edit / dirty state
  // dirtyRows[rowId][field] = new value (pending save)
  const [dirtyRows, setDirtyRows] = useState<Record<string, Partial<Record<EditableField, any>>>>({})
  const [, setSavingRow] = useState<string | null>(null)
  const [savingAll, setSavingAll] = useState(false)

  // Pagination
  const [currentPage, setCurrentPage] = useState(0)

  // Booking lock — starts locked on entry, user clicks "Open Booking" to edit
  const [bookingLocked, setBookingLocked] = useState(true)

  // Bulk prompt for inherited field edits
  const [bulkPrompt, setBulkPrompt] = useState<{
    rowId: string
    field: EditableField
    newValue: any
    flightId: string
    count: number
  } | null>(null)

  // Multi-select
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set())
  const [bulkFlightModal, setBulkFlightModal] = useState(false)
  const [bulkTargetFlight, setBulkTargetFlight] = useState('')

  // Delete confirm
  const [deleteConfirm, setDeleteConfirm] = useState<BookingRow | null>(null)

  // Docs mini-panel
  const [expandedDocsRow, setExpandedDocsRow] = useState<string | null>(null)
  const [uploadingDoc, setUploadingDoc] = useState<string | null>(null)
  const pendingUploadRef = useRef<{ row: BookingRow; key: string } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Excel upload (ecommerce)
  const [clients, setClients] = useState<AirfreightClient[]>([])
  const [uploadModalOpen, setUploadModalOpen] = useState(false)
  const [uploadSelectedClientId, setUploadSelectedClientId] = useState('')
  const [uploadingExcel, setUploadingExcel] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const excelInputRef = useRef<HTMLInputElement>(null)
  // Post-upload summary modal (shown after successful upload with counts + moved/deleted/duplicates)
  type UploadMoveInfo = { awb: string; fromFlight: string; toFlight: string }
  const [uploadSummary, setUploadSummary] = useState<{
    flightsCreated: number
    flightsUpdated: number
    bookingsCreated: number
    bookingsUpdated: number
    totalAwbs: number
    moves: UploadMoveInfo[]
    bookingsDeleted: number
    flightsDeleted: number
    inExcelDupes: string[]
    crossClientConflicts: string[]
  } | null>(null)

  // Notification drawer for unseen modifications
  const [notifDrawerOpen, setNotifDrawerOpen] = useState(false)

  // ── Load data ──
  useEffect(() => {
    if (isClient && !clientId) {
      setFlights([]); setBookings([]); setLoading(false)
      return
    }

    // SOL-14: Separate flights and bookings into independent listeners
    const flightsConstraints: any[] = [orderBy('flight_datetime', 'asc')]
    if (etdFrom) {
      flightsConstraints.unshift(where('flight_datetime', '>=', new Date(etdFrom + 'T00:00:00').toISOString()))
    }
    if (etdTo) {
      flightsConstraints.push(where('flight_datetime', '<=', new Date(etdTo + 'T23:59:59').toISOString()))
    }
    const flightsQuery = query(collection(db, 'airfreight_flights'), ...flightsConstraints)

    const unsubFlights = onSnapshot(flightsQuery, (fSnap) => {
      setFlights(fSnap.docs.map(d => ({ ...(d.data() as AirfreightFlight), id: d.id })))
    }, (err) => {
      console.error('Flights listener error:', err)
      setFlights([])
    })

    let bookingsQuery = query(
      collection(db, 'airfreight_bookings'),
      where('booking_type', 'in', ['ecommerce', 'simple']),
    )
    if (isClient && clientId) {
      bookingsQuery = query(
        collection(db, 'airfreight_bookings'),
        where('booking_type', 'in', ['ecommerce', 'simple']),
        where('client_id', '==', clientId),
      )
    }

    const unsubBookings = onSnapshot(bookingsQuery, (bSnap) => {
      setBookings(bSnap.docs.map(d => ({ ...(d.data() as AirfreightBooking), id: d.id })))
      setLoading(false)
    }, (err) => {
      console.error('Bookings listener error:', err)
      setBookings([]); setLoading(false)
    })

    return () => {
      unsubFlights()
      unsubBookings()
    }
  }, [isClient, clientId, etdFrom, etdTo])

  // Subscribe to ecommerce clients (for Excel upload modal)
  useEffect(() => {
    const q = query(collection(db, 'airfreight_clients'), where('booking_type', '==', 'ecommerce'))
    const unsub = onSnapshot(q, snap => {
      const list = snap.docs.map(d => ({ ...(d.data() as AirfreightClient), id: d.id }))
      // Client users: keep only their own client
      const filtered = isClient && clientId ? list.filter(c => c.id === clientId) : list
      setClients(filtered.filter(c => c.active !== false).sort((a, b) => a.name.localeCompare(b.name)))
    })
    return () => unsub()
  }, [isClient, clientId])

  // ── Flatten bookings → rows ──
  const allRows: BookingRow[] = useMemo(() => {
    const rows: BookingRow[] = []
    for (const b of bookings) {
      const flight = flights.find(f => f.id === b.flight_id)
      if (!flight) continue
      if (b.booking_type === 'simple') {
        // Simple booking: data at document level, no awb_lines
        const bAny = b as any
        rows.push({
          rowId: `${b.id}:0`,
          bookingId: b.id,
          awbIndex: 0,
          flightId: flight.id,
          flightNumber: flight.flight_number || '',
          etd: flight.flight_datetime || '',
          cutoff: flight.cutoff_datetime || '',
          destination: (flight.destinations && flight.destinations[0]) || bAny.destination_id || b.destination_custom || '',
          deliverTo: b.deliver_to || '',
          airline: flight.airline || '',
          flightStatus: (flight.flight_status || (flight.dispatched_at ? 'dispatched' : 'booked')) as any,
          clientId: b.client_id,
          clientName: b.client_name || '',
          awb1st: bAny.awb_1st_leg || '',
          awb2nd: bAny.awb_2nd_leg || '',
          uldType: bAny.uld_type || 'LOOSE',
          pieces: bAny.pieces || 0,
          chargeableWeight: bAny.chargeable_weight || 0,
          pickupFrom: bAny.pickup_from || '',
          readyForPickup: bAny.ready_for_pickup || '',
          lastDayFree: bAny.last_day_free || '',
          holdBg: bAny.hold === true ? (bAny.holds?.[0]?.bag || '') : bAny.hold === 'pending' ? 'Pending' : 'NO HOLD',
          holdBox: bAny.hold === true ? (bAny.holds?.[0]?.box || '') : bAny.hold === 'pending' ? 'Pending' : 'NO HOLD',
          lb: !!bAny.battery,
          dg: !!bAny.ddgg,
          notes: bAny.notes || '',
          editedAt: bAny.edited_at,
          editedBy: bAny.edited_by,
          docsStatus: computeDocsStatus(bAny),
          onHand: !!bAny.on_hand,
          warehouseStatus: bAny.warehouse_status || null,
          dispatched: !!bAny.dispatched,
          dispatchedAt: bAny.dispatched_at ?? null,
          dispatchedBy: bAny.dispatched_by ?? null,
          booking: b,
          flight,
        })
      } else {
        const lines = b.awb_lines || []
        lines.forEach((line, idx) => {
          rows.push({
            rowId: `${b.id}:${idx}`,
            bookingId: b.id,
            awbIndex: idx,
            flightId: flight.id,
            flightNumber: flight.flight_number || '',
            etd: flight.flight_datetime || '',
            cutoff: flight.cutoff_datetime || '',
            destination: (flight.destinations && flight.destinations[0]) || b.destination_custom || '',
            deliverTo: b.deliver_to || '',
            airline: flight.airline || '',
            flightStatus: (flight.flight_status || (flight.dispatched_at ? 'dispatched' : 'booked')) as any,
            clientId: b.client_id,
            clientName: b.client_name || '',
            awb1st: line.awb_number || '',
            awb2nd: line.awb_2nd_leg || '',
            uldType: line.uld_type || 'LOOSE',
            pieces: line.pieces || 0,
            chargeableWeight: line.chargeable_weight || 0,
            pickupFrom: line.pickup_from || '',
            readyForPickup: line.ready_for_pickup || '',
            lastDayFree: line.last_day_free || '',
            holdBg: line.hold === true ? (line.holds?.[0]?.bag || '') : line.hold === 'pending' ? 'Pending' : 'NO HOLD',
            holdBox: line.hold === true ? (line.holds?.[0]?.box || '') : line.hold === 'pending' ? 'Pending' : 'NO HOLD',
            lb: !!line.battery,
            dg: !!line.ddgg,
            notes: (line as any).notes || '',
            editedAt: (line as any).edited_at,
            editedBy: (line as any).edited_by,
            docsStatus: computeDocsStatus(line),
            onHand: !!line.on_hand,
            warehouseStatus: (line as any).warehouse_status || null,
            dispatched: !!(line as any).dispatched,
            dispatchedAt: (line as any).dispatched_at ?? null,
            dispatchedBy: (line as any).dispatched_by ?? null,
            booking: b,
            flight,
          })
        })
      }
    }
    return rows
  }, [flights, bookings])

  const allClientNames = useMemo(
    () => [...new Set(allRows.map(r => r.clientName).filter(Boolean))].sort(),
    [allRows],
  )

  const filteredRows = useMemo(() => {
    return allRows.filter(r => {
      // AWB search — bypasses all other filters to find the AWB anywhere
      if (awbSearch.trim()) {
        const q = awbSearch.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
        const a1 = (r.awb1st || '').toLowerCase().replace(/[^a-z0-9]/g, '')
        const a2 = (r.awb2nd || '').toLowerCase().replace(/[^a-z0-9]/g, '')
        return a1.includes(q) || a2.includes(q)
      }
      // Flight pre-filter via ?flight=ID URL param — bypasses date/client/status filters
      if (flightFilter) {
        return r.flightId === flightFilter
      }
      // Draft rows (no flight_number yet) always bypass date/status filters so they stay visible at top
      const isDraft = !r.flightNumber
      if (!isDraft) {
        const etdDate = r.etd.slice(0, 10)
        if (etdFrom && etdDate < etdFrom) return false
        if (etdTo && etdDate > etdTo) return false
        // Client-side status filter (derived in listener with legacy fallback)
        if (flightStatusFilter !== 'all' && r.flightStatus !== flightStatusFilter) return false
      }
      if (clientFilter && r.clientName !== clientFilter) return false
      return true
    })
  }, [allRows, etdFrom, etdTo, clientFilter, flightFilter, flightStatusFilter, awbSearch])

  // Unseen modifications: bookings with modified_seen === false and change_count > 0
  const unseenBookings = useMemo(() => {
    const seen = new Set<string>()
    const result: { bookingId: string; clientName: string; flightNumber: string; changeCount: number; lastChange: ChangeLogEntry | null }[] = []
    for (const b of bookings) {
      if (seen.has(b.id)) continue
      seen.add(b.id)
      if (b.modified_seen === false && (b.change_count || 0) > 0) {
        const lastEntry = (b.change_log || []).length > 0 ? b.change_log[b.change_log.length - 1] : null
        result.push({
          bookingId: b.id,
          clientName: b.client_name || '',
          flightNumber: b.flight_number || '—',
          changeCount: b.change_count || 0,
          lastChange: lastEntry,
        })
      }
    }
    return result
  }, [bookings])

  const unseenBookingIds = useMemo(() => new Set(unseenBookings.map(u => u.bookingId)), [unseenBookings])

  async function markBookingSeen(bookingId: string) {
    try {
      await updateDoc(doc(db, 'airfreight_bookings', bookingId), { modified_seen: true })
    } catch (err) { console.error('Error marking seen:', err) }
  }

  async function markAllSeen() {
    for (const u of unseenBookings) {
      await markBookingSeen(u.bookingId)
    }
  }

  // Merge dirty values into a row for rendering
  function mergeDirty(r: BookingRow): BookingRow {
    const dirty = dirtyRows[r.rowId]
    if (!dirty) return r
    return { ...r, ...(dirty as any) }
  }

  const groupedRows = useMemo(() => {
    const groups = new Map<string, BookingRow[]>()
    for (const r of filteredRows) {
      if (!groups.has(r.flightId)) groups.set(r.flightId, [])
      groups.get(r.flightId)!.push(r)
    }

    for (const [, rows] of groups) {
      rows.sort((a, b) => {
        let cmp = 0
        if (sortKey === 'last_day_free') {
          cmp = (a.lastDayFree || '').localeCompare(b.lastDayFree || '')
        } else if (sortKey === 'ready') {
          cmp = (a.readyForPickup || '').localeCompare(b.readyForPickup || '')
        } else {
          cmp = a.awbIndex - b.awbIndex
        }
        return sortDir === 'asc' ? cmp : -cmp
      })
    }

    const sortedGroupEntries = Array.from(groups.entries()).sort(([, aRows], [, bRows]) => {
      const a = aRows[0], b = bRows[0]
      // Draft rows (no flight_number yet) always float to the top
      const aDraft = !a.flightNumber
      const bDraft = !b.flightNumber
      if (aDraft && !bDraft) return -1
      if (!aDraft && bDraft) return 1
      let cmp = 0
      if (sortKey === 'flight_number') {
        cmp = (a.flightNumber || '').localeCompare(b.flightNumber || '')
      } else {
        cmp = (a.etd || '').localeCompare(b.etd || '')
      }
      return sortDir === 'asc' ? cmp : -cmp
    })

    return sortedGroupEntries
  }, [filteredRows, sortKey, sortDir])

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  // ── Pagination: bin-pack flights into pages of up to PAGE_SIZE data rows ──
  // A flight that doesn't fit in the current page starts a new page. Flights
  // larger than PAGE_SIZE get their own page (and may exceed the limit).
  const pages = useMemo(() => {
    const result: [string, BookingRow[]][][] = []
    let currentPageGroups: [string, BookingRow[]][] = []
    let currentCount = 0
    for (const [flightId, rows] of groupedRows) {
      if (currentCount + rows.length > PAGE_SIZE && currentCount > 0) {
        result.push(currentPageGroups)
        currentPageGroups = []
        currentCount = 0
      }
      currentPageGroups.push([flightId, rows])
      currentCount += rows.length
    }
    if (currentPageGroups.length > 0) result.push(currentPageGroups)
    return result
  }, [groupedRows])

  // Clamp current page if pages shrink due to filter changes
  useEffect(() => {
    if (currentPage > 0 && currentPage >= pages.length) {
      setCurrentPage(Math.max(0, pages.length - 1))
    }
  }, [pages, currentPage])

  // Reset to first page when filters/sort change
  useEffect(() => {
    setCurrentPage(0)
  }, [etdFrom, etdTo, clientFilter, sortKey, sortDir, flightFilter])

  const displayedPage = pages[Math.min(currentPage, Math.max(0, pages.length - 1))] || []

  // ── Warn on tab close/refresh with unsaved changes ──
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (Object.keys(dirtyRows).length > 0) {
        e.preventDefault()
        e.returnValue = ''
        return ''
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirtyRows])

  function clearFlightFilter() {
    const next = new URLSearchParams(searchParams)
    next.delete('flight')
    setSearchParams(next, { replace: true })
  }

  // Resolve the filtered flight (if any) to display its number in the chip
  const filteredFlightLabel = useMemo(() => {
    if (!flightFilter) return ''
    const f = flights.find(fl => fl.id === flightFilter)
    return f?.flight_number || '(unknown flight)'
  }, [flights, flightFilter])

  function sortArrow(key: SortKey) {
    if (sortKey !== key) return <span className="text-gray-300 ml-0.5">↕</span>
    return <span className="text-mcl-blue ml-0.5">{sortDir === 'asc' ? '▲' : '▼'}</span>
  }

  // ── Edit / dirty state ──

  function setDirty(rowId: string, field: EditableField, value: any) {
    setDirtyRows(prev => ({
      ...prev,
      [rowId]: { ...(prev[rowId] || {}), [field]: value },
    }))
  }

  function isDirty(rowId: string, field: EditableField): boolean {
    return dirtyRows[rowId]?.[field] !== undefined
  }

  function discardRow(rowId: string) {
    setDirtyRows(prev => {
      const next = { ...prev }
      delete next[rowId]
      return next
    })
  }

  function discardAll() {
    setDirtyRows({})
  }

  async function saveAll() {
    const ids = Object.keys(dirtyRows)
    if (ids.length === 0) return
    setSavingAll(true)
    try {
      for (const rowId of ids) {
        const row = allRows.find(r => r.rowId === rowId)
        if (!row) continue
        try {
          await saveRow(row)
        } catch (e) {
          console.error('Error saving row', rowId, e)
        }
      }
    } finally {
      setSavingAll(false)
    }
  }

  // ── Save a single row ──
  async function saveRow(r: BookingRow) {
    const dirty = dirtyRows[r.rowId]
    if (!dirty) return
    setSavingRow(r.rowId)
    try {
      // If Flight# changed, handle separately (row may move bookings)
      if (dirty.flightNumber !== undefined && dirty.flightNumber !== r.flightNumber) {
        await handleFlightNumberChange(r, dirty.flightNumber)
        discardRow(r.rowId)
        return
      }

      // If inherited fields changed, handle via bulk prompt (should be handled earlier)
      const inheritedChanged = INHERITED_FIELDS.some(f => dirty[f] !== undefined)
      if (inheritedChanged) {
        // Trigger bulk prompt for the first inherited change
        for (const f of INHERITED_FIELDS) {
          if (dirty[f] !== undefined) {
            const count = allRows.filter(row => row.flightId === r.flightId).length
            setBulkPrompt({ rowId: r.rowId, field: f, newValue: dirty[f], flightId: r.flightId, count })
            break
          }
        }
        return
      }

      // AWB-level fields: update the awb_lines[awbIndex] of the booking
      const bookingRef = doc(db, 'airfreight_bookings', r.bookingId)
      const bookingSnap = await getDocs(query(collection(db, 'airfreight_bookings'), where('__name__', '==', r.bookingId)))
      const currentBooking = bookingSnap.docs[0]?.data() as AirfreightBooking | undefined
      if (!currentBooking) throw new Error('Booking not found')

      // HAL-17: Duplicate AWB validation
      const newAwbs: string[] = []
      if (dirty.awb1st !== undefined) newAwbs.push(normalizeAwb(String(dirty.awb1st)))
      if (dirty.awb2nd !== undefined) newAwbs.push(normalizeAwb(String(dirty.awb2nd)))
      for (const norm of newAwbs.filter(Boolean)) {
        const dupSnap = await getDocs(query(
          collection(db, 'airfreight_bookings'),
          where('awb_numbers_normalized', 'array-contains', norm),
        ))
        const dupes = dupSnap.docs.filter(d => d.id !== r.bookingId)
        if (dupes.length > 0) {
          alert(`AWB ${norm} ya existe en otro booking. No se puede duplicar.`)
          return
        }
        // Also check within the same booking's other lines
        const otherLines = (currentBooking.awb_lines || []).filter((_: any, i: number) => i !== r.awbIndex)
        const conflict = otherLines.some((ol: any) =>
          normalizeAwb(ol.awb_number) === norm || normalizeAwb(ol.awb_2nd_leg) === norm,
        )
        if (conflict) {
          alert(`AWB ${norm} ya existe en otra línea del mismo booking.`)
          return
        }
      }

      const lines = [...(currentBooking.awb_lines || [])]
      const line = { ...lines[r.awbIndex] } as AwbSecondLeg
      if (dirty.awb1st !== undefined) line.awb_number = String(dirty.awb1st)
      if (dirty.awb2nd !== undefined) line.awb_2nd_leg = String(dirty.awb2nd)
      if (dirty.uldType !== undefined) line.uld_type = String(dirty.uldType)
      if (dirty.pieces !== undefined) line.pieces = Number(dirty.pieces) || 0
      if (dirty.chargeableWeight !== undefined) line.chargeable_weight = Number(dirty.chargeableWeight) || 0
      if (dirty.pickupFrom !== undefined) line.pickup_from = String(dirty.pickupFrom)
      if (dirty.readyForPickup !== undefined) line.ready_for_pickup = String(dirty.readyForPickup)
      if (dirty.lastDayFree !== undefined) line.last_day_free = String(dirty.lastDayFree)
      if (dirty.lb !== undefined) line.battery = !!dirty.lb
      if (dirty.dg !== undefined) line.ddgg = !!dirty.dg
      if (dirty.notes !== undefined) (line as any).notes = String(dirty.notes)
      if (dirty.holdBg !== undefined || dirty.holdBox !== undefined) {
        const bgVal = dirty.holdBg !== undefined ? String(dirty.holdBg) : r.holdBg
        const boxVal = dirty.holdBox !== undefined ? String(dirty.holdBox) : r.holdBox
        if (bgVal === 'NO HOLD' && boxVal === 'NO HOLD') {
          line.hold = false
          line.holds = []
        } else if (bgVal === 'Pending' || boxVal === 'Pending') {
          line.hold = 'pending'
        } else {
          line.hold = true
          line.holds = [{ bag: bgVal, box: boxVal }]
        }
      }
      ;(line as any).edited_at = new Date().toISOString()
      ;(line as any).edited_by = user?.email || ''

      // Audit log: record changed fields
      const changedFields = Object.keys(dirty).filter(k => dirty[k] !== undefined)
      if (changedFields.length > 0) {
        const auditEntry = mkAudit('field_changed', user?.email || '', changedFields.join(', '))
        line.audit_log = [...(line.audit_log || []), auditEntry]
      }

      lines[r.awbIndex] = line
      await updateDoc(bookingRef, { awb_lines: stripUndefined(lines), ...awbIndexField({ booking_type: 'ecommerce', awb_lines: lines }) } as any)

      // Sync holds collection if hold fields changed on this row
      if (dirty.holdBg !== undefined || dirty.holdBox !== undefined) {
        const flight = flights.find(f => f.id === r.flightId)
        await syncHoldsToCollection(r.flightId, flight)
      }

      discardRow(r.rowId)
    } catch (e) {
      console.error('Error saving row:', e)
      alert('Save error: ' + (e as Error).message)
    } finally {
      setSavingRow(null)
    }
  }

  // ── Flight# change handler ──
  async function handleFlightNumberChange(r: BookingRow, newFlightNumber: string) {
    // Check if another flight already has this number (real move scenario)
    const targetFlight = flights.find(f => f.id !== r.flightId && (f.flight_number || '') === newFlightNumber)

    if (!targetFlight) {
      // No other flight has this number — just update the current flight's flight_number
      await updateDoc(doc(db, 'airfreight_flights', r.flightId), { flight_number: newFlightNumber })
      // Also update flight_number on all bookings of this flight
      const flightBookings = bookings.filter(b => b.flight_id === r.flightId)
      await Promise.all(flightBookings.map(b =>
        updateDoc(doc(db, 'airfreight_bookings', b.id!), { flight_number: newFlightNumber })
      ))
      return
    }

    // Another flight already has this number — move AWB to that flight
    const targetFlightId = targetFlight.id

    // ── GUARDA G2: No mover AWBs de vuelo Built ──
    const srcFlight = flights.find(f => f.id === r.flightId)
    if (srcFlight && (srcFlight as any).flight_status === 'built') {
      alert('No se puede mover AWBs de un vuelo en estado Built.')
      return
    }

    // ── GUARDA G1: No mover si piezas asignadas a ULD ──
    const awb1st = normalizeAwb(r.awb1st)
    const awb2nd = normalizeAwb(r.awb2nd)
    const drSnap = await getDocs(query(
      collection(db, 'airfreight_doc_receptions'),
      where('booking_id', '==', r.bookingId),
    ))
    const matchedDrs = drSnap.docs.filter(d => {
      const dr = d.data()
      const drAwb1 = normalizeAwb(dr.awb_number)
      const drAwb2 = normalizeAwb(dr.awb_2nd_leg)
      return (awb1st && (drAwb1 === awb1st || drAwb2 === awb1st)) ||
             (awb2nd && (drAwb1 === awb2nd || drAwb2 === awb2nd))
    })
    for (const drDoc of matchedDrs) {
      const ppSnap = await getDocs(query(
        collection(db, 'airfreight_physical_pieces'),
        where('doc_reception_id', '==', drDoc.id),
      ))
      const hasUld = ppSnap.docs.some(p => p.data().uld_id)
      if (hasUld) {
        alert('No se puede mover: la AWB tiene piezas asignadas a un ULD. Desasígnelas primero.')
        return
      }
    }

    // Find or create target booking (same client + target flight + ecommerce)
    const targetBookings = bookings.filter(b => b.flight_id === targetFlightId && b.client_id === r.clientId)
    let targetBookingId: string
    if (targetBookings.length > 0) {
      targetBookingId = targetBookings[0].id
    } else {
      const newBooking: Omit<AirfreightBooking, 'id'> = {
        flight_id: targetFlightId,
        booking_type: 'ecommerce',
        client_id: r.clientId,
        client_name: r.clientName,
        agent_name: r.booking.agent_name || null,
        status: 'submitted',
        created_by: user?.email || '',
        created_at: new Date().toISOString(),
        change_count: 0,
        modified_seen: false,
        change_log: [],
        airline: r.airline || '',
        destination_id: '',
        destination_custom: r.destination || '',
        awb_lines: [],
      }
      const newBookingRef = await addDoc(collection(db, 'airfreight_bookings'), newBooking as any)
      targetBookingId = newBookingRef.id
    }

    // ── FIX: Mover doc_receptions al nuevo vuelo/booking ANTES del cascade ──
    for (const drDoc of matchedDrs) {
      await updateDoc(doc(db, 'airfreight_doc_receptions', drDoc.id), {
        flight_id: targetFlightId,
        booking_id: targetBookingId,
      })
    }

    // Remove line from source booking
    const srcBooking = bookings.find(b => b.id === r.bookingId)
    if (!srcBooking) return
    const srcLines = [...(srcBooking.awb_lines || [])]
    const [movedLine] = srcLines.splice(r.awbIndex, 1)
    if (!movedLine) return

    // Append line to target booking
    const tgtBooking = bookings.find(b => b.id === targetBookingId)
    const tgtLines = tgtBooking ? [...(tgtBooking.awb_lines || []), movedLine] : [movedLine]

    // Write both
    const writes: Promise<void>[] = []
    if (srcLines.length === 0) {
      writes.push(cascadeDeleteBooking(r.bookingId).then(() => deleteDoc(doc(db, 'airfreight_bookings', r.bookingId))))
    } else {
      writes.push(updateDoc(doc(db, 'airfreight_bookings', r.bookingId), { awb_lines: srcLines, ...awbIndexField({ booking_type: 'ecommerce', awb_lines: srcLines }) } as any))
    }
    writes.push(updateDoc(doc(db, 'airfreight_bookings', targetBookingId), { awb_lines: tgtLines, ...awbIndexField({ booking_type: 'ecommerce', awb_lines: tgtLines }) } as any))
    await Promise.all(writes)

    // Sync holds on both source and target flights (the moved line may carry hold data)
    const tgtFlight = flights.find(f => f.id === targetFlightId)
    const syncOps: Promise<void>[] = [syncHoldsToCollection(r.flightId, srcFlight)]
    if (targetFlightId !== r.flightId) {
      syncOps.push(syncHoldsToCollection(targetFlightId, tgtFlight))
    }
    await Promise.all(syncOps)
  }

  // ── Apply bulk prompt (update flight + related bookings) ──
  async function applyBulkInherited(prompt: NonNullable<typeof bulkPrompt>) {
    const { field, newValue, flightId } = prompt
    try {
      if (field === 'etd') {
        await updateDoc(doc(db, 'airfreight_flights', flightId), { flight_datetime: newValue })
      } else if (field === 'cutoff') {
        await updateDoc(doc(db, 'airfreight_flights', flightId), { cutoff_datetime: newValue })
      } else if (field === 'destination') {
        await updateDoc(doc(db, 'airfreight_flights', flightId), { destinations: [newValue] })
      } else if (field === 'deliverTo') {
        // Update deliver_to on all bookings of this flight
        const bks = bookings.filter(b => b.flight_id === flightId)
        await Promise.all(bks.map(b => updateDoc(doc(db, 'airfreight_bookings', b.id), { deliver_to: newValue } as any)))
      }
      // Clear dirty for this field on all rows of this flight (avoid stale dirty state)
      setDirtyRows(prev => {
        const next = { ...prev }
        for (const rowId of Object.keys(next)) {
          const r = allRows.find(rr => rr.rowId === rowId)
          if (r?.flightId === flightId) {
            const copy = { ...next[rowId] }
            delete copy[field]
            if (Object.keys(copy).length === 0) delete next[rowId]
            else next[rowId] = copy
          }
        }
        return next
      })
    } catch (e) {
      console.error('Error applying bulk:', e)
      alert('Error: ' + (e as Error).message)
    } finally {
      setBulkPrompt(null)
    }
  }

  // ── Sync holds to airfreight_holds collection ──
  // Keeps the holds collection in sync with line.hold / line.holds data on each booking.
  // Must be called whenever a hold is added, changed, or removed (including row moves/deletes).
  async function syncHoldsToCollection(fId: string, fl?: AirfreightFlight & { id: string }) {
    try {
      // 1. Get all bookings for this flight
      const bSnap = await getDocs(query(collection(db, 'airfreight_bookings'), where('flight_id', '==', fId)))
      const bks = bSnap.docs.map(d => ({ ...d.data() as AirfreightBooking, id: d.id }))

      // 2. Collect all hold items from bookings
      const desiredHolds: { booking_id: string; client_id: string; client_name: string; awb: string; bag: string; box: string }[] = []

      for (const b of bks) {
        if ((b.booking_type === 'mawb' || b.booking_type === 'ecommerce' || b.booking_type === 'export') && b.awb_lines) {
          for (const line of b.awb_lines) {
            if (line.hold === true && line.holds && line.holds.length > 0) {
              for (const hi of line.holds) {
                desiredHolds.push({
                  booking_id: b.id!,
                  client_id: b.client_id,
                  client_name: b.client_name,
                  awb: line.awb_number,
                  bag: hi.bag,
                  box: hi.box,
                })
              }
            }
          }
        } else if (b.hold && b.holds && b.holds.length > 0) {
          for (const hi of b.holds) {
            desiredHolds.push({
              booking_id: b.id!,
              client_id: b.client_id,
              client_name: b.client_name,
              awb: b.awb_1st_leg || '',
              bag: hi.bag,
              box: hi.box,
            })
          }
        }
      }

      // 3. Get existing holds for this flight
      const hSnap = await getDocs(query(collection(db, 'airfreight_holds'), where('flight_id', '==', fId)))
      const existingHolds = hSnap.docs.map(d => ({ ...d.data() as AirfreightHold, id: d.id }))

      const holdOps: Promise<unknown>[] = []
      const flightDate = fl?.flight_datetime ? fl.flight_datetime.slice(0, 10) : ''
      const flightNumber = fl?.flight_number || ''
      const now = new Date().toISOString()

      // 4. Create new holds (that don't exist yet)
      for (const dh of desiredHolds) {
        const exists = existingHolds.find(eh =>
          eh.booking_id === dh.booking_id && eh.bag === dh.bag && eh.box === dh.box
        )
        if (!exists) {
          holdOps.push(addDoc(collection(db, 'airfreight_holds'), {
            booking_id: dh.booking_id,
            flight_id: fId,
            flight_number: flightNumber,
            flight_date: flightDate,
            client_id: dh.client_id,
            client_name: dh.client_name,
            awb_number: dh.awb,
            bag: dh.bag,
            box: dh.box,
            status: 'informed',
            created_at: now,
          }))
        }
      }

      // 5. Mark removed holds as completed
      for (const eh of existingHolds) {
        if (eh.status === 'completed') continue
        const stillExists = desiredHolds.find(dh =>
          dh.booking_id === eh.booking_id && dh.bag === eh.bag && dh.box === eh.box
        )
        if (!stillExists) {
          holdOps.push(updateDoc(doc(db, 'airfreight_holds', eh.id), {
            status: 'completed',
            updated_at: now,
          }))
        }
      }

      if (holdOps.length > 0) await Promise.all(holdOps)
    } catch (err) {
      console.error('Error syncing holds:', err)
    }
  }

  // ── OH / Dispatched toggles (per-AWB, MCL only, ecommerce) ───────────────
  //
  // OH toggles line.on_hand + drop_off_time. Bidirectional sync with the
  // Transportation screen (which edits the same fields on the same line).
  //
  // Dispatched marks the AWB as handed to the airline. When all AWBs across
  // ALL bookings of a flight (ecommerce + MAWB) are dispatched, the flight
  // auto-transitions booked → dispatched. MAWB lines never get dispatched=true
  // from this screen (BookingList is ecommerce-only), so a flight that has
  // MAWB bookings will never auto-transition from here — Dashboard keeps
  // managing MAWB transitions.

  async function toggleOnHand(r: BookingRow) {
    if (!isMcl) return
    try {
      const srcBooking = bookings.find(b => b.id === r.bookingId)
      if (!srcBooking) return
      const lines = [...(srcBooking.awb_lines || [])]
      const line: any = { ...lines[r.awbIndex] }
      const wasOnHand = !!line.on_hand
      line.on_hand = !wasOnHand
      if (!wasOnHand) {
        // Turning ON: stamp drop_off_time + advance transport cycle to on_hand
        line.drop_off_time = new Date().toISOString()
        line.transport_status = 'on_hand'
      } else {
        // Turning OFF: clear drop_off_time + roll back cycle (if still on_hand)
        line.drop_off_time = null
        if (line.transport_status === 'on_hand') {
          line.transport_status = 'picked_up'
        }
      }
      const auditEntry = mkAudit(
        wasOnHand ? 'on_hand_off' : 'on_hand_on',
        user?.email || '',
        wasOnHand ? 'On Hand desactivado' : 'On Hand activado',
      )
      line.audit_log = [...(line.audit_log || []), auditEntry]
      lines[r.awbIndex] = line
      await updateDoc(doc(db, 'airfreight_bookings', r.bookingId), { awb_lines: stripUndefined(lines) } as any)
    } catch (e) {
      console.error('Error toggling OH:', e)
      alert('OH update error: ' + (e as Error).message)
    }
  }

  async function toggleDispatched(r: BookingRow) {
    if (!isMcl) return
    try {
      const srcBooking = bookings.find(b => b.id === r.bookingId)
      if (!srcBooking) return
      const isSimple = srcBooking.booking_type === 'simple'

      if (isSimple) {
        // Simple booking: dispatched fields at document level
        const wasDispatched = !!(srcBooking as any).dispatched
        const auditEntry = mkAudit(
          wasDispatched ? 'undispatched' : 'dispatched',
          user?.email || '',
          wasDispatched ? 'AWB desmarcado como despachado' : 'AWB marcado como despachado',
        )
        const updateData: Record<string, any> = {
          dispatched: !wasDispatched,
          dispatched_at: wasDispatched ? null : new Date().toISOString(),
          dispatched_by: wasDispatched ? null : (user?.email || ''),
          audit_log: [...((srcBooking as any).audit_log || []), auditEntry],
        }
        await updateDoc(doc(db, 'airfreight_bookings', r.bookingId), updateData)

        // Billing
        try {
          if (!wasDispatched) {
            await calculateAirfreightCharges(
              srcBooking, null, null,
              new Date().toISOString(), user?.email || '',
            )
          } else {
            await undoDispatchCharges(r.bookingId)
          }
        } catch (billingErr) {
          console.error('Billing charge error:', billingErr)
          alert('Warning: Status changed but billing charges failed. Please notify accounting.')
        }
      } else {
        // Ecommerce/MAWB: dispatched fields inside awb_lines
        const lines = [...(srcBooking.awb_lines || [])]
        const line: any = { ...lines[r.awbIndex] }
        const wasDispatched = !!line.dispatched
        line.dispatched = !wasDispatched
        if (!wasDispatched) {
          line.dispatched_at = new Date().toISOString()
          line.dispatched_by = user?.email || ''
        } else {
          line.dispatched_at = null
          line.dispatched_by = null
        }
        const auditEntry = mkAudit(
          wasDispatched ? 'undispatched' : 'dispatched',
          user?.email || '',
          wasDispatched ? 'AWB desmarcado como despachado' : 'AWB marcado como despachado',
        )
        line.audit_log = [...(line.audit_log || []), auditEntry]
        lines[r.awbIndex] = line
        await updateDoc(doc(db, 'airfreight_bookings', r.bookingId), { awb_lines: stripUndefined(lines) } as any)

        // Billing
        try {
          const isMawb = srcBooking.booking_type === 'mawb'
          if (!wasDispatched) {
            if (isMawb) {
              const allDispatched = lines.every((l: any) => l.dispatched === true)
              if (allDispatched) {
                const totalCw = lines.reduce((s: number, l: any) => s + (l.chargeable_weight || 0), 0)
                const bookingForBilling = { ...srcBooking, chargeable_weight: totalCw }
                await calculateAirfreightCharges(
                  bookingForBilling, null, null,
                  new Date().toISOString(), user?.email || '',
                )
              }
            } else {
              await calculateAirfreightCharges(
                srcBooking, line as AwbSecondLeg, r.awbIndex,
                new Date().toISOString(), user?.email || '',
              )
            }
          } else {
            if (isMawb) {
              await undoDispatchCharges(r.bookingId)
            } else {
              const billingUnitId = `${r.bookingId}__${r.awbIndex}`
              await undoDispatchCharges(billingUnitId)
            }
          }
        } catch (billingErr) {
          console.error('Billing charge error:', billingErr)
          alert('Warning: Status changed but billing charges failed. Please notify accounting.')
        }
      }

      // After the write, re-evaluate flight-level status.
      await maybeAutoTransitionFlight(r.flightId, !r.dispatched)
    } catch (e) {
      console.error('Error toggling Dispatched:', e)
      alert('Dispatch update error: ' + (e as Error).message)
    }
  }

  // Re-evaluate flight status after a Dispatched toggle. Queries ALL bookings
  // of the flight (not just the in-memory ecommerce state) so we respect
  // MAWB bookings too. Rules:
  //   - Just turned ON → if every line in every booking has dispatched=true,
  //     flight transitions to 'dispatched' (stamps dispatched_at).
  //   - Just turned OFF → if flight was 'dispatched', revert to 'booked' and
  //     clear dispatched_at. Other AWBs keep their individual dispatched
  //     flags (per product decision D6.b: leave dispatched fields as they
  //     were on reopen).
  async function maybeAutoTransitionFlight(flightId: string, afterDispatchedOn: boolean) {
    try {
      const bSnap = await getDocs(query(
        collection(db, 'airfreight_bookings'),
        where('flight_id', '==', flightId),
      ))
      const bks = bSnap.docs.map(d => d.data() as AirfreightBooking)

      let total = 0
      let dispatchedCount = 0
      for (const b of bks) {
        if (b.booking_type === 'simple') {
          total++
          if ((b as any).dispatched === true) dispatchedCount++
        } else {
          const ls = (b.awb_lines || []) as any[]
          for (const l of ls) {
            total++
            if (l.dispatched === true) dispatchedCount++
          }
        }
      }

      const flight = flights.find(f => f.id === flightId)
      const currentStatus = flight?.flight_status || (flight?.dispatched_at ? 'dispatched' : 'booked')
      const flightRef = doc(db, 'airfreight_flights', flightId)

      if (afterDispatchedOn) {
        const allDispatched = total > 0 && dispatchedCount === total
        if (allDispatched && currentStatus !== 'dispatched') {
          await updateDoc(flightRef, {
            flight_status: 'dispatched',
            dispatched_at: new Date().toISOString(),
          } as any)
        }
      } else {
        if (currentStatus === 'dispatched') {
          await updateDoc(flightRef, {
            flight_status: 'booked',
            dispatched_at: null,
          } as any)
        }
      }
    } catch (e) {
      console.error('Error in maybeAutoTransitionFlight:', e)
    }
  }

  // ── Open upload modal ──
  function openUploadModal() {
    setUploadError('')
    // Pre-select client if there's only one option (client user, or single ecommerce client)
    if (clients.length === 1) {
      setUploadSelectedClientId(clients[0].id || '')
    } else {
      setUploadSelectedClientId('')
    }
    setUploadModalOpen(true)
  }

  function closeUploadModal() {
    if (uploadingExcel) return
    setUploadModalOpen(false)
    setUploadError('')
    setUploadSelectedClientId('')
    if (excelInputRef.current) excelInputRef.current.value = ''
  }

  // ── Excel upload (ecommerce) ──
  // Ported from AirfreightBookingNew.handleEcommerceExcelUpload.
  // Differences: takes activeClient as param (no global state), uses local error state,
  // does not navigate after success (BookingList already shows the result via onSnapshot).
  async function handleEcommerceExcelUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''

    const activeClient = clients.find(c => c.id === uploadSelectedClientId)
    if (!activeClient) {
      setUploadError('Select a client before uploading the Excel')
      return
    }

    setUploadingExcel(true)
    setUploadError('')
    try {
      const data = await file.arrayBuffer()
      const wb = XLSX.read(data, { type: 'array', cellDates: false })
      // Try "Ejemplo" sheet first, otherwise use first sheet with data
      const sheetName = wb.SheetNames.find(n => n.toLowerCase().includes('ejemplo')) || wb.SheetNames[0]
      const ws = wb.Sheets[sheetName]
      const rawRows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

      // ── Detect header row by matching known column names ──
      let headerRowIdx = -1
      let colMap: Record<string, number> = {}

      const HEADER_ALIASES: [string, string[]][] = [
        ['flight_number', ['flight number', 'flight#', 'flight #', 'vuelo', 'numero de vuelo']],
        ['awb_1st', ['1st leg awb', '1st leg', 'awb 1st leg', '1st awb']],
        ['awb_2nd', ['2nd leg awb', '2nd leg', 'awb 2nd leg', '2nd awb']],
        ['uld', ['uld', 'uld type']],
        ['pieces', ['pcs', 'pieces', 'piezas']],
        ['cw', ['cw', 'chw', 'chargeable', 'chargeable wt', 'chargeable weight']],
        ['pickup_from', ['pick up from', 'pickup from', 'pick-up from']],
        ['ready', ['ready for pick up', 'ready for pickup', 'ready']],
        ['last_day_free', ['last day free', 'last free day']],
        ['deliver_to', ['deliver to', 'airline']],
        ['destination', ['dest', 'dest.', 'destination', 'destino']],
        ['cutoff', ['cutoff', 'cut off', 'cutoff time', 'cut-off']],
        ['etd', ['etd', 'departure']],
        ['hold_bg', ['hold bg#', 'hold bg #', 'hold bg', 'bag#', 'bag #', 'bg#', 'bg #']],
        ['hold_box', ['hold box#', 'hold box #', 'hold box', 'box#', 'box #']],
        ['battery', ['battery', 'bateria', 'lithium', 'lb', 'lithium battery']],
        ['dg', ['dg', 'dangerous', 'ddgg', 'dangerous goods', 'hazmat']],
      ]

      for (let i = 0; i < Math.min(rawRows.length, 20); i++) {
        const row = rawRows[i]
        let matchCount = 0
        const tempMap: Record<string, number> = {}
        for (let j = 0; j < row.length; j++) {
          const cell = String(row[j] ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
          if (!cell) continue
          for (const [key, aliases] of HEADER_ALIASES) {
            if (key in tempMap) continue
            if (aliases.some(a => cell === a || cell.includes(a))) {
              tempMap[key] = j
              matchCount++
              break
            }
          }
        }
        if (matchCount >= 3) {
          headerRowIdx = i
          colMap = tempMap
          break
        }
      }

      if (headerRowIdx < 0) { setUploadError('Header row not found in Excel'); return }

      // ── Parse date helper for mixed formats ──
      function parseEcomDate(raw: any): string {
        if (raw === null || raw === undefined || raw === '') return ''
        if (typeof raw === 'number') {
          const d = new Date((raw - 25569) * 86400000)
          if (raw % 1 !== 0) {
            const hh = String(d.getUTCHours()).padStart(2, '0')
            const mm = String(d.getUTCMinutes()).padStart(2, '0')
            return `${d.toISOString().slice(0, 10)}T${hh}:${mm}:00`
          }
          return d.toISOString().slice(0, 10)
        }
        const s = String(raw).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
        if (!s || /^[a-z]/i.test(s)) return s

        function parseTime(t: string): string {
          const tk = t.trim().toLowerCase()
          const rangeMatch = tk.match(/(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
          if (rangeMatch) {
            let hr = parseInt(rangeMatch[3])
            const min = rangeMatch[4] || '00'
            const ampm = rangeMatch[5]?.toLowerCase()
            if (ampm === 'pm' && hr < 12) hr += 12
            if (ampm === 'am' && hr === 12) hr = 0
            return `${String(hr).padStart(2, '0')}:${min}`
          }
          const timeMatch = tk.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
          if (timeMatch) {
            let hr = parseInt(timeMatch[1])
            const min = timeMatch[2] || '00'
            const ampm = timeMatch[3]?.toLowerCase()
            if (ampm === 'pm' && hr < 12) hr += 12
            if (ampm === 'am' && hr === 12) hr = 0
            return `${String(hr).padStart(2, '0')}:${min}`
          }
          return ''
        }

        if (!s.includes('/') && /^\d{1,2}\s*-\s*\d{1,2}\s*(am|pm)/i.test(s)) {
          const t = parseTime(s)
          return t ? `T${t}:00` : s
        }

        // Time before date: "02:00 4/18" or "02:00 - 4/18/2026"
        const timeFirstRe = /^(\d{1,2}:\d{2})\s*[-]?\s*(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/
        const timeFirstMatch = s.match(timeFirstRe)
        if (timeFirstMatch) {
          const timeParsed = parseTime(timeFirstMatch[1])
          const mm = timeFirstMatch[2].padStart(2, '0')
          const dd = timeFirstMatch[3].padStart(2, '0')
          const yearRaw = timeFirstMatch[4]
          const datePart = yearRaw
            ? `${yearRaw.length === 2 ? '20' + yearRaw : yearRaw}-${mm}-${dd}`
            : `${mm}/${dd}`
          return timeParsed ? `${datePart}T${timeParsed}:00` : datePart
        }

        const dateRe = /(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/
        const dateMatch = s.match(dateRe)

        if (dateMatch) {
          const mm = dateMatch[1].padStart(2, '0')
          const dd = dateMatch[2].padStart(2, '0')
          const yearRaw = dateMatch[3]
          const datePart = yearRaw
            ? `${yearRaw.length === 2 ? '20' + yearRaw : yearRaw}-${mm}-${dd}`
            : `${mm}/${dd}`

          const afterDate = s.slice(dateMatch.index! + dateMatch[0].length)
          const timeParsed = afterDate ? parseTime(afterDate) : ''

          return timeParsed ? `${datePart}T${timeParsed}:00` : datePart
        }

        if (s.includes('T')) return s
        return s
      }

      const col = (r: any[], key: string) => key in colMap ? String(r[colMap[key]] ?? '').trim() : ''
      const colRaw = (r: any[], key: string) => key in colMap ? r[colMap[key]] : ''

      const dataRows = rawRows.slice(headerRowIdx + 1).filter(r => {
        const awb1 = col(r, 'awb_1st')
        const awb2 = col(r, 'awb_2nd')
        const fn = col(r, 'flight_number')
        return (awb1 || awb2) && fn
      })

      if (dataRows.length === 0) {
        setUploadError('No valid data rows in Excel. Each row needs at least an AWB and a Flight Number.')
        return
      }

      // ── Group rows by Flight Number + Airline + ETD date + Destination ──
      // 1 flight = 1 destination (business rule). Including destination in the
      // key also prevents "pending" rows (empty flight_number) from collapsing
      // into a single group across different destinations.
      const flightGroups = new Map<string, any[][]>()
      for (const r of dataRows) {
        const fn = col(r, 'flight_number')
        const airline = col(r, 'deliver_to')
        const etd = parseEcomDate(colRaw(r, 'etd'))
        const destination = col(r, 'destination').toUpperCase()
        const groupKey = `${fn}__${airline}__${etd.slice(0, 10)}__${destination}`
        if (!flightGroups.has(groupKey)) flightGroups.set(groupKey, [])
        flightGroups.get(groupKey)!.push(r)
      }

      const now = new Date().toISOString()
      const createdBy = user?.email || user?.uid || ''

      // ── Build AWB index from current in-memory bookings state ──
      // Map<normalizedAwbNumber, Array<{bookingId, flightId, clientId, lineIndex, line}>>
      type AwbIndexEntry = {
        bookingId: string
        flightId: string
        clientId: string
        lineIndex: number
        line: any
      }
      const awbIndex = new Map<string, AwbIndexEntry[]>()
      for (const b of bookings) {
        const lines = (b.awb_lines || []) as any[]
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          const key = normalizeAwb(line?.awb_number)
          if (!key) continue
          if (!awbIndex.has(key)) awbIndex.set(key, [])
          awbIndex.get(key)!.push({
            bookingId: b.id,
            flightId: b.flight_id,
            clientId: b.client_id,
            lineIndex: i,
            line,
          })
        }
      }

      // ── Tracking for summary + cleanup ──
      // cleanupByBooking: bookingId -> Set<lineIndex> to remove in cleanup phase
      const cleanupByBooking = new Map<string, Set<number>>()
      const moves: UploadMoveInfo[] = []
      const inExcelSeen = new Set<string>()
      const inExcelDupes: string[] = []
      const crossClientConflicts: string[] = []
      let flightsCreated = 0
      let flightsUpdated = 0
      let bookingsCreated = 0
      let bookingsUpdated = 0
      let totalAwbs = 0

      for (const [, groupRows] of flightGroups) {
        const firstGroupRow = groupRows[0]
        const flightNumber = col(firstGroupRow, 'flight_number').trim().toUpperCase()
        const etdRaw = parseEcomDate(colRaw(firstGroupRow, 'etd'))
        const cutoffRaw = parseEcomDate(colRaw(firstGroupRow, 'cutoff'))
        const deliverTo = col(firstGroupRow, 'deliver_to')

        // Single destination per group (business rule: 1 flight = 1 destination).
        // We still use a Set for safety but it should always have <= 1 element.
        const dests = new Set<string>()
        for (const r of groupRows) {
          const d = col(r, 'destination').toUpperCase()
          if (d) dests.add(d)
        }
        const groupDestination = Array.from(dests)[0] || ''

        // Match on flight_number + ETD date + destination.
        // Including destination prevents pending rows (empty flight_number)
        // going to different destinations from collapsing into one flight.
        let matchedFlight = flights.find(f =>
          (f.flight_number || '').trim().toUpperCase() === flightNumber &&
          (f.flight_datetime || '').startsWith(etdRaw.slice(0, 10)) &&
          (f.destinations || []).includes(groupDestination)
        )

        if (!matchedFlight) {
          const flightData: any = {
            airline: deliverTo || 'Unknown',
            flight_number: flightNumber || null,
            flight_datetime: etdRaw || now,
            cutoff_datetime: cutoffRaw || null,
            destinations: Array.from(dests),
            status: 'open',
            flight_status: 'booked',
            created_by: createdBy,
            created_at: now,
          }
          const docRef = await addDoc(collection(db, 'airfreight_flights'), flightData)
          matchedFlight = { ...flightData, id: docRef.id } as AirfreightFlight & { id: string }
          flightsCreated++
        } else {
          const existingDests = new Set(matchedFlight.destinations || [])
          const newDests = Array.from(dests).filter(d => !existingDests.has(d))
          const updates: Record<string, any> = {}
          if (newDests.length > 0) {
            updates.destinations = [...(matchedFlight.destinations || []), ...newDests]
          }
          if (cutoffRaw) {
            updates.cutoff_datetime = cutoffRaw
          }
          if (deliverTo && deliverTo !== matchedFlight.airline) {
            updates.airline = deliverTo
          }
          if (Object.keys(updates).length > 0) {
            await updateDoc(doc(db, 'airfreight_flights', matchedFlight.id), updates)
            matchedFlight = { ...matchedFlight, ...updates }
          }
          flightsUpdated++
        }

        // Find target booking BEFORE building lines so we can distinguish
        // same-booking preservation from cross-booking move
        const existingBookingSnap = await getDocs(query(
          collection(db, 'airfreight_bookings'),
          where('flight_id', '==', matchedFlight.id),
          where('client_id', '==', activeClient.id || ''),
          where('booking_type', '==', 'ecommerce'),
        ))
        const existingBooking = existingBookingSnap.docs[0]
        const targetBookingId = existingBooking?.id || null

        // Build awb_lines with preservation/merge logic
        const awbLines = groupRows.map(r => {
          const holdBg = col(r, 'hold_bg')
          const holdBox = col(r, 'hold_box')
          const holdBgLower = holdBg.toLowerCase()
          const isNoHold = holdBgLower === 'no hold' || holdBgLower === 'no' || holdBgLower === 'n/a' || holdBg === '—' || holdBg === '-' || holdBg === '0'
          const isPending = !holdBg || holdBgLower === 'pending' || holdBgLower === 'pendiente'
          const hasHold = holdBg && !isNoHold && !isPending
          const batteryVal = col(r, 'battery')
          const dgVal = col(r, 'dg')

          const holdItems: { bag: string; box: string }[] = []
          if (hasHold) {
            holdItems.push({ bag: holdBg, box: holdBox || '' })
          }

          const holdValue: boolean | 'pending' = hasHold ? true : isNoHold ? false : 'pending'

          const baseLine: any = {
            awb_number: col(r, 'awb_1st'),
            awb_2nd_leg: col(r, 'awb_2nd') || null,
            pieces: Number(col(r, 'pieces')) || 0,
            weight: 0,
            chargeable_weight: Number(col(r, 'cw')) || 0,
            uld_type: col(r, 'uld') || null,
            pickup_from: col(r, 'pickup_from') || null,
            ready_for_pickup: parseEcomDate(colRaw(r, 'ready')) || null,
            last_day_free: parseEcomDate(colRaw(r, 'last_day_free')) || null,
            battery: isYes(batteryVal),
            ddgg: isYes(dgVal),
            hold: holdValue,
            on_hand: false,
            ...(holdItems.length > 0 ? { holds: holdItems } : {}),
          }

          totalAwbs++

          const normKey = normalizeAwb(baseLine.awb_number)
          if (!normKey) return baseLine

          // In-Excel duplicate check (last-write-wins, but flag for summary)
          if (inExcelSeen.has(normKey)) {
            inExcelDupes.push(baseLine.awb_number)
          } else {
            inExcelSeen.add(normKey)
          }

          // Look up existing occurrences in the system
          const matches = awbIndex.get(normKey) || []
          let mergedLine: any = baseLine

          for (const m of matches) {
            // Cross-client: defensive skip (user confirmed this "can't happen")
            if (m.clientId !== (activeClient.id || '')) {
              crossClientConflicts.push(
                `${baseLine.awb_number} (other client: ${m.clientId})`
              )
              continue
            }

            const isSameTargetBooking = targetBookingId !== null && m.bookingId === targetBookingId

            if (isSameTargetBooking) {
              // Same-flight + same-client overwrite: preserve fields, no cleanup
              // (the booking will be overwritten wholesale in the write step).
              mergedLine = mergePreservedFields(mergedLine, m.line, undefined)
            } else {
              // Cross-booking move (likely different flight, same client).
              const fromFlight = flights.find(f => f.id === m.flightId)
              const fromLabel = fromFlight?.flight_number || '(no number)'
              const toLabel = matchedFlight!.flight_number || '(no number)'
              const moveLogEntry = {
                moved_at: now,
                moved_by: createdBy,
                from_flight_id: m.flightId,
                from_flight_label: fromLabel,
                to_flight_id: matchedFlight!.id,
                to_flight_label: toLabel,
              }
              mergedLine = mergePreservedFields(mergedLine, m.line, moveLogEntry)

              if (!cleanupByBooking.has(m.bookingId)) {
                cleanupByBooking.set(m.bookingId, new Set())
              }
              cleanupByBooking.get(m.bookingId)!.add(m.lineIndex)

              moves.push({
                awb: baseLine.awb_number,
                fromFlight: fromLabel,
                toFlight: toLabel,
              })
            }
          }

          return mergedLine
        })

        const totalPieces = awbLines.reduce((s: number, l: any) => s + (Number(l.pieces) || 0), 0)
        const anyHold = awbLines.some((l: any) => l.hold === true || l.hold === 'pending')

        if (existingBooking) {
          await updateDoc(doc(db, 'airfreight_bookings', existingBooking.id), {
            awb_lines: awbLines,
            pieces: totalPieces,
            hold: anyHold,
            destination_id: Array.from(dests)[0] || '',
            flight_number: matchedFlight.flight_number || null,
            airline: matchedFlight.airline || '',
            change_count: (existingBooking.data().change_count || 0) + 1,
            modified_seen: false,
            ...awbIndexField({ booking_type: 'ecommerce', awb_lines: awbLines }),
          } as any)
          bookingsUpdated++
        } else {
          await addDoc(collection(db, 'airfreight_bookings'), {
            flight_id: matchedFlight.id,
            flight_number: matchedFlight.flight_number || null,
            airline: matchedFlight.airline || '',
            booking_type: 'ecommerce',
            client_id: activeClient.id || '',
            client_name: activeClient.name || '',
            status: 'submitted',
            created_by: createdBy,
            created_at: now,
            change_count: 0,
            modified_seen: true,
            change_log: [],
            documents: {},
            destination_id: Array.from(dests)[0] || '',
            awb_lines: awbLines,
            pieces: totalPieces,
            hold: anyHold,
            on_hand: false,
            ...awbIndexField({ booking_type: 'ecommerce', awb_lines: awbLines }),
          } as any)
          bookingsCreated++
        }

        // Sync holds for this flight
        await syncHoldsToCollection(matchedFlight.id, matchedFlight)
      }

      // ── Cleanup phase: remove moved AWBs from their old bookings ──
      let bookingsDeleted = 0
      const oldFlightsToSync = new Set<string>()
      for (const [oldBookingId, lineIndicesToRemove] of cleanupByBooking) {
        const oldBooking = bookings.find(b => b.id === oldBookingId)
        if (!oldBooking) continue

        const oldLines = (oldBooking.awb_lines || []) as any[]
        const remainingLines = oldLines.filter((_, i) => !lineIndicesToRemove.has(i))

        // Build change_log entry (one per moved AWB)
        const movedAwbFields = Array.from(lineIndicesToRemove).map(i => {
          const movedLine = oldLines[i]
          return {
            field: 'awb_lines',
            label: 'AWB movida',
            old_value: `AWB ${movedLine?.awb_number || '?'} en este vuelo`,
            new_value: 'Reasignada a otro vuelo por upload Excel',
          }
        })
        const newChangeLog = [
          ...((oldBooking.change_log as any[]) || []),
          {
            changed_at: now,
            changed_by: createdBy,
            change_type: 'flight_reassignment' as const,
            fields_changed: movedAwbFields,
          },
        ]

        if (remainingLines.length === 0) {
          // Hard delete + cascade cleanup
          await cascadeDeleteBooking(oldBookingId)
          await deleteDoc(doc(db, 'airfreight_bookings', oldBookingId))
          bookingsDeleted++
        } else {
          const newPieces = remainingLines.reduce((s: number, l: any) => s + (Number(l.pieces) || 0), 0)
          const newHold = remainingLines.some((l: any) => l.hold === true || l.hold === 'pending')
          await updateDoc(doc(db, 'airfreight_bookings', oldBookingId), {
            awb_lines: remainingLines,
            pieces: newPieces,
            hold: newHold,
            change_log: newChangeLog,
            change_count: (oldBooking.change_count || 0) + 1,
            modified_seen: false,
            ...awbIndexField({ booking_type: 'ecommerce', awb_lines: remainingLines }),
          } as any)
        }

        oldFlightsToSync.add(oldBooking.flight_id)
      }

      // Sync holds for each old flight (after cleanup)
      for (const oldFlightId of oldFlightsToSync) {
        const oldFlight = flights.find(f => f.id === oldFlightId)
        if (oldFlight) await syncHoldsToCollection(oldFlightId, oldFlight)
      }

      // ── Delete empty flights ──
      // For each old flight we touched, query Firestore (fresh state after
      // cleanup) to check if any bookings remain. We do NOT filter by
      // booking_type — if ANY booking (ecommerce or MAWB) still exists on
      // the flight, we leave the flight alone. MAWB-safe by construction.
      let flightsDeleted = 0
      for (const oldFlightId of oldFlightsToSync) {
        try {
          const remainingSnap = await getDocs(query(
            collection(db, 'airfreight_bookings'),
            where('flight_id', '==', oldFlightId),
          ))
          if (remainingSnap.empty) {
            await deleteDoc(doc(db, 'airfreight_flights', oldFlightId))
            flightsDeleted++
          }
        } catch (e) {
          console.error('Error deleting empty flight', oldFlightId, e)
        }
      }

      // Success — close upload modal and show summary.
      // onSnapshot will refresh the table automatically.
      setUploadModalOpen(false)
      setUploadSelectedClientId('')
      setUploadSummary({
        flightsCreated,
        flightsUpdated,
        bookingsCreated,
        bookingsUpdated,
        totalAwbs,
        moves,
        bookingsDeleted,
        flightsDeleted,
        inExcelDupes,
        crossClientConflicts,
      })
    } catch (err: any) {
      console.error('Ecommerce Excel upload error:', err)
      setUploadError(`Error processing Excel: ${err?.message || err}`)
    } finally {
      setUploadingExcel(false)
    }
  }

  // ── Add row (per group or global) ──
  async function addRowToGroup(flightId: string) {
    // Find first ecommerce booking for this flight (or this client)
    const flightBookings = bookings.filter(b => b.flight_id === flightId && (!isClient || b.client_id === clientId))
    let targetBookingId: string
    if (flightBookings.length > 0) {
      targetBookingId = flightBookings[0].id
    } else {
      // No booking yet — create one
      const flight = flights.find(f => f.id === flightId)
      if (!flight) return
      const newBooking: Omit<AirfreightBooking, 'id'> = {
        flight_id: flightId,
        booking_type: 'ecommerce',
        client_id: clientId || '',
        client_name: '',
        status: 'submitted',
        created_by: user?.email || '',
        created_at: new Date().toISOString(),
        change_count: 0,
        modified_seen: false,
        change_log: [],
        airline: flight.airline || '',
        destination_id: '',
        destination_custom: (flight.destinations?.[0] || ''),
        awb_lines: [],
      }
      const ref = await addDoc(collection(db, 'airfreight_bookings'), newBooking as any)
      targetBookingId = ref.id
    }
    const targetBooking = bookings.find(b => b.id === targetBookingId)
    const newLines = [...(targetBooking?.awb_lines || []), makeEmptyLine()]
    await updateDoc(doc(db, 'airfreight_bookings', targetBookingId), { awb_lines: newLines, ...awbIndexField({ booking_type: 'ecommerce', awb_lines: newLines }) } as any)
  }

  async function addBlankRow() {
    // Create an orphan row with no flight → we create a placeholder flight with empty flight_number
    // Actually simpler: create a new flight with no number yet. User will set Flight# inline.
    const newFlight: Omit<AirfreightFlight, 'id'> = {
      airline: '',
      flight_datetime: new Date().toISOString(),
      flight_number: '',
      destinations: [],
      status: 'open',
      created_by: user?.email || '',
      created_at: new Date().toISOString(),
      flight_status: 'booked',
    }
    const fRef = await addDoc(collection(db, 'airfreight_flights'), newFlight as any)
    const newBooking: Omit<AirfreightBooking, 'id'> = {
      flight_id: fRef.id,
      booking_type: 'ecommerce',
      client_id: clientId || '',
      client_name: '',
      status: 'submitted',
      created_by: user?.email || '',
      created_at: new Date().toISOString(),
      change_count: 0,
      modified_seen: false,
      change_log: [],
      airline: '',
      destination_id: '',
      awb_lines: [makeEmptyLine()],
      ...awbIndexField({ booking_type: 'ecommerce', awb_lines: [makeEmptyLine()] }),
    }
    await addDoc(collection(db, 'airfreight_bookings'), newBooking as any)
  }

  // ── Delete row (hard delete + Storage cleanup) ──
  async function deleteRow(r: BookingRow) {
    try {
      // Collect all Storage files on this line
      const line = r.booking.awb_lines?.[r.awbIndex]
      if (line?.documents) {
        for (const [, d] of Object.entries(line.documents)) {
          if (d && (d as AirfreightDocumentFile).url) {
            try {
              const url = (d as AirfreightDocumentFile).url
              // Extract path from download URL
              const match = url.match(/\/o\/([^?]+)/)
              if (match) {
                const path = decodeURIComponent(match[1])
                await deleteObject(fbStorageRef(storage, path))
              }
            } catch (e) {
              console.warn('Failed to delete file:', e)
            }
          }
        }
        const ccsfFiles = (line.documents as any).doc_ccsf_files as AirfreightDocumentFile[] | undefined
        if (ccsfFiles) {
          for (const f of ccsfFiles) {
            try {
              const match = f.url.match(/\/o\/([^?]+)/)
              if (match) {
                const path = decodeURIComponent(match[1])
                await deleteObject(fbStorageRef(storage, path))
              }
            } catch (e) { console.warn('Failed to delete ccsf:', e) }
          }
        }
      }

      // Remove line from booking
      const srcBooking = bookings.find(b => b.id === r.bookingId)
      if (!srcBooking) return
      const lines = [...(srcBooking.awb_lines || [])]
      lines.splice(r.awbIndex, 1)

      let flightDeleted = false
      if (lines.length === 0) {
        await cascadeDeleteBooking(r.bookingId)
        await deleteDoc(doc(db, 'airfreight_bookings', r.bookingId))
        // If flight has no more bookings, delete flight too
        const siblingBookings = bookings.filter(b => b.flight_id === r.flightId && b.id !== r.bookingId)
        if (siblingBookings.length === 0) {
          await deleteDoc(doc(db, 'airfreight_flights', r.flightId))
          flightDeleted = true
        }
      } else {
        await updateDoc(doc(db, 'airfreight_bookings', r.bookingId), { awb_lines: stripUndefined(lines) } as any)
      }

      // Sync holds collection if the deleted line had holds
      // (also closes any orphan holds on the flight, even if the flight itself was deleted)
      const hadHold = line && (line.hold === true || line.hold === 'pending')
      if (hadHold || flightDeleted) {
        const flight = flightDeleted ? undefined : flights.find(f => f.id === r.flightId)
        await syncHoldsToCollection(r.flightId, flight)
      }
    } catch (e) {
      console.error('Error deleting row:', e)
      alert('Delete error: ' + (e as Error).message)
    } finally {
      setDeleteConfirm(null)
    }
  }

  // ── Multi-select bulk flight change ──
  async function applyBulkFlightChange() {
    if (!bulkTargetFlight || selectedRows.size === 0) return
    try {
      // Pre-resolve or create the target flight ONCE to avoid duplicates
      let targetFlightId: string
      const existingFlight = flights.find(f => (f.flight_number || '') === bulkTargetFlight)
      if (existingFlight) {
        targetFlightId = existingFlight.id
      } else {
        // Use first selected row's data as template for the new flight
        const firstRow = allRows.find(rr => selectedRows.has(rr.rowId))
        const newFlight: Omit<AirfreightFlight, 'id'> = {
          airline: firstRow?.airline || '',
          flight_datetime: firstRow?.etd || new Date().toISOString(),
          flight_number: bulkTargetFlight,
          destinations: firstRow?.destination ? [firstRow.destination] : [],
          cutoff_datetime: firstRow?.cutoff || undefined,
          status: 'open',
          created_by: user?.email || '',
          created_at: new Date().toISOString(),
          flight_status: 'booked',
        }
        const newFlightRef = await addDoc(collection(db, 'airfreight_flights'), newFlight as any)
        targetFlightId = newFlightRef.id
      }

      // Move each selected AWB to the pre-resolved flight
      for (const rowId of selectedRows) {
        const r = allRows.find(rr => rr.rowId === rowId)
        if (!r) continue
        if (r.flightId === targetFlightId) continue

        // Find or create target booking (same client + target flight)
        const tgtBookingInMemory = bookings.find(b => b.flight_id === targetFlightId && b.client_id === r.clientId)
        let targetBookingId: string
        if (tgtBookingInMemory) {
          targetBookingId = tgtBookingInMemory.id
        } else {
          // Check if a previous iteration already created one (not yet in state)
          const snap = await getDocs(query(
            collection(db, 'airfreight_bookings'),
            where('flight_id', '==', targetFlightId),
            where('client_id', '==', r.clientId),
            where('booking_type', '==', 'ecommerce'),
          ))
          if (!snap.empty) {
            targetBookingId = snap.docs[0].id
          } else {
            const newBooking: Omit<AirfreightBooking, 'id'> = {
              flight_id: targetFlightId,
              booking_type: 'ecommerce',
              client_id: r.clientId,
              client_name: r.clientName,
              agent_name: r.booking.agent_name || null,
              status: 'submitted',
              created_by: user?.email || '',
              created_at: new Date().toISOString(),
              change_count: 0,
              modified_seen: false,
              change_log: [],
              airline: r.airline || '',
              destination_id: '',
              destination_custom: r.destination || '',
              awb_lines: [],
            }
            const ref = await addDoc(collection(db, 'airfreight_bookings'), newBooking as any)
            targetBookingId = ref.id
          }
        }

        // Remove line from source booking
        const srcBooking = bookings.find(b => b.id === r.bookingId)
        if (!srcBooking) continue
        const srcLines = [...(srcBooking.awb_lines || [])]
        const [movedLine] = srcLines.splice(r.awbIndex, 1)
        if (!movedLine) continue

        // Read target booking lines fresh from Firestore (may have been updated by previous iteration)
        const tgtSnap = await getDocs(query(collection(db, 'airfreight_bookings'), where('__name__', '==', targetBookingId)))
        const tgtData = tgtSnap.docs[0]?.data()
        const tgtLines = [...((tgtData?.awb_lines as any[]) || []), movedLine]

        // Write both
        const writes: Promise<void>[] = []
        if (srcLines.length === 0) {
          writes.push(cascadeDeleteBooking(r.bookingId).then(() => deleteDoc(doc(db, 'airfreight_bookings', r.bookingId))))
        } else {
          writes.push(updateDoc(doc(db, 'airfreight_bookings', r.bookingId), { awb_lines: srcLines } as any))
        }
        writes.push(updateDoc(doc(db, 'airfreight_bookings', targetBookingId), { awb_lines: tgtLines } as any))
        await Promise.all(writes)
      }

      // Sync holds
      const affectedFlights = new Set<string>()
      for (const rowId of selectedRows) {
        const r = allRows.find(rr => rr.rowId === rowId)
        if (r) { affectedFlights.add(r.flightId); affectedFlights.add(targetFlightId) }
      }
      for (const fId of affectedFlights) {
        const fl = flights.find(f => f.id === fId)
        await syncHoldsToCollection(fId, fl)
      }

      setSelectedRows(new Set())
      setBulkFlightModal(false)
      setBulkTargetFlight('')
    } catch (e) {
      console.error('Bulk change error:', e)
      alert('Error: ' + (e as Error).message)
    }
  }

  // ── Document per-slot upload/delete (ecommerce) ──
  // Each document type has its own slot in line.documents.{key}.
  // Synced bidirectionally with AWB Log and AirfreightDocs.
  async function handleDocFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || [])
    const ctx = pendingUploadRef.current
    if (files.length === 0 || !ctx) { if (fileInputRef.current) fileInputRef.current.value = ''; return }
    const { row, key } = ctx
    setUploadingDoc(`${row.rowId}:${key}`)
    try {
      const srcBooking = bookings.find(b => b.id === row.bookingId)
      if (!srcBooking) return
      const lines = [...(srcBooking.awb_lines || [])]
      const line: any = { ...lines[row.awbIndex] }

      const uploadOne = async (file: File): Promise<AirfreightDocumentFile> => {
        const ext = file.name.split('.').pop() || 'pdf'
        const path = storagePath({
          flightNumber: row.flightNumber,
          flightDate: row.etd,
          airline: row.airline,
          clientName: row.clientName,
          awbNumber: row.awb1st,
          filename: `${key}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`,
        })
        const sRef = fbStorageRef(storage, path)
        await uploadBytes(sRef, file)
        const url = await getDownloadURL(sRef)
        return {
          url,
          filename: file.name,
          version: 1,
          uploaded_by: user?.email || '',
          uploaded_at: new Date().toISOString(),
          modified_seen: false,
          history: [],
        }
      }

      // Single-file slot → line.documents.{key}
      const docFile = await uploadOne(files[0])
      line.documents = { ...(line.documents || {}) }
      ;(line.documents as any)[key] = docFile

      const auditEntry = mkAudit('doc_uploaded', user?.email || '', `${key}: ${files[0].name}`, key)
      line.audit_log = [...(line.audit_log || []), auditEntry]
      lines[row.awbIndex] = line
      await updateDoc(doc(db, 'airfreight_bookings', row.bookingId), { awb_lines: stripUndefined(lines) } as any)
    } catch (err) {
      console.error('Upload error:', err)
      alert('Upload error: ' + (err as Error).message)
    } finally {
      setUploadingDoc(null)
      pendingUploadRef.current = null
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  function triggerUpload(row: BookingRow, key: string) {
    pendingUploadRef.current = { row, key }
    fileInputRef.current?.click()
  }

  async function deleteDocFromRow(row: BookingRow, key: string) {
    if (!confirm('Eliminar este documento?')) return
    try {
      const srcBooking = bookings.find(b => b.id === row.bookingId)
      if (!srcBooking) return
      const lines = [...(srcBooking.awb_lines || [])]
      const line: any = { ...lines[row.awbIndex] }

      line.documents = { ...(line.documents || {}) }
      const d = (line.documents as any)[key] as AirfreightDocumentFile | undefined
      if (d) {
        try {
          const match = d.url.match(/\/o\/([^?]+)/)
          if (match) await deleteObject(fbStorageRef(storage, decodeURIComponent(match[1])))
        } catch {}
        delete (line.documents as any)[key]
      }

      const auditEntry = mkAudit('doc_deleted', user?.email || '', `Documento eliminado: ${key}`, key)
      line.audit_log = [...(line.audit_log || []), auditEntry]
      lines[row.awbIndex] = line
      await updateDoc(doc(db, 'airfreight_bookings', row.bookingId), { awb_lines: stripUndefined(lines) } as any)
    } catch (e) {
      console.error('Delete doc error:', e)
      alert('Error: ' + (e as Error).message)
    }
  }

  // ─── UI helpers ───────────────────────────────────────────────────────────

  function cellBg(rowId: string, field: EditableField): string {
    return isDirty(rowId, field) ? 'bg-[#FFF8E1]' : ''
  }

  // Text input cell — marks dirty on blur; actual save happens via "Guardar" button
  function TextCell({ r, field, value, locked, mono, type, extraClass }: {
    r: BookingRow; field: EditableField; value: string; locked: boolean
    mono?: boolean; type?: string
    extraClass?: string
  }) {
    const [local, setLocal] = useState(value)
    useEffect(() => { setLocal(value) }, [value])
    return (
      <input
        type={type || 'text'}
        value={local}
        disabled={locked}
        onChange={e => setLocal(e.target.value)}
        onBlur={() => {
          if (local !== value) setDirty(r.rowId, field, local)
        }}
        className={`w-full bg-transparent px-1 py-0.5 text-xs border-0 focus:outline-none focus:ring-1 focus:ring-mcl-blue/40 rounded ${mono ? 'font-mono' : ''} ${cellBg(r.rowId, field)} ${locked ? 'text-gray-400' : ''} ${extraClass || ''}`}
      />
    )
  }

  function NumCell({ r, field, value, locked }: { r: BookingRow; field: EditableField; value: number; locked: boolean }) {
    const [local, setLocal] = useState(String(value))
    useEffect(() => { setLocal(String(value)) }, [value])
    return (
      <input
        type="number"
        value={local}
        disabled={locked}
        onChange={e => setLocal(e.target.value)}
        onBlur={() => {
          const newVal = Number(local) || 0
          if (newVal !== value) setDirty(r.rowId, field, newVal)
        }}
        className={`w-full bg-transparent px-1 py-0.5 text-xs text-right border-0 focus:outline-none focus:ring-1 focus:ring-mcl-blue/40 rounded tabular-nums ${cellBg(r.rowId, field)} ${locked ? 'text-gray-400' : ''}`}
      />
    )
  }

  function DateCell({ r, field, value, locked }: { r: BookingRow; field: EditableField; value: string; locked: boolean }) {
    const local = fmtDateInput(value)
    return (
      <input
        type="date"
        value={local}
        disabled={locked}
        onChange={e => {
          const v = e.target.value
          setDirty(r.rowId, field, v)
          // For inherited fields, trigger the bulk prompt (flight-wide changes commit immediately on confirm)
          if (INHERITED_FIELDS.includes(field)) {
            const count = allRows.filter(row => row.flightId === r.flightId).length
            setBulkPrompt({ rowId: r.rowId, field, newValue: v, flightId: r.flightId, count })
          }
        }}
        className={`w-full bg-transparent px-1 py-0.5 text-xs border-0 focus:outline-none focus:ring-1 focus:ring-mcl-blue/40 rounded font-mono ${cellBg(r.rowId, field)} ${locked ? 'text-gray-400' : ''}`}
      />
    )
  }

  function DateTimeCell({ r, field, value, locked }: { r: BookingRow; field: EditableField; value: string; locked: boolean }) {
    const local = fmtDateTimeLocal(value)
    return (
      <input
        type="datetime-local"
        value={local}
        disabled={locked}
        onChange={e => {
          const v = e.target.value ? `${e.target.value}:00` : ''
          setDirty(r.rowId, field, v)
          if (INHERITED_FIELDS.includes(field)) {
            const count = allRows.filter(row => row.flightId === r.flightId).length
            setBulkPrompt({ rowId: r.rowId, field, newValue: v, flightId: r.flightId, count })
          }
        }}
        className={`w-full bg-transparent px-1 py-0.5 text-xs border-0 focus:outline-none focus:ring-1 focus:ring-mcl-blue/40 rounded font-mono ${cellBg(r.rowId, field)} ${locked ? 'text-gray-400' : ''}`}
      />
    )
  }

  // ── Docs mini panel — per-slot (synced with AWB Log & AirfreightDocs) ──
  function DocsPanel({ row }: { row: BookingRow }) {
    const line = row.booking.awb_lines?.[row.awbIndex] as any
    if (!line) return null
    const docs = (line.documents || {}) as Record<string, AirfreightDocumentFile | undefined>
    const canEdit = !bookingLocked

    // Build slot list based on line properties (mirrors AirfreightDocs getSlots)
    const slots: { key: string; label: string; condition?: boolean }[] = [
      { key: 'doc_7512', label: '7512', condition: line.loc_bond !== 'L' },
      { key: 'doc_hawb', label: 'AWB' },
      { key: 'doc_do_tsa', label: 'DO / TSA' },
      { key: 'doc_manifesto', label: 'Manifiesto' },
      { key: 'doc_import_awb', label: 'Import AWB' },
      { key: 'doc_lb_checklist', label: 'LB Checklist', condition: !!line.battery },
    ]

    const visibleSlots = slots.filter(s => s.condition !== false)

    return (
      <tr className="bg-blue-50/50 border-b border-blue-100">
        <td colSpan={21} className="px-4 py-3">
          <div className="text-[11px] font-bold text-gray-500 uppercase tracking-wide mb-2">
            Documents · {row.awb1st || '—'}
          </div>
          <div className="flex flex-wrap gap-3 items-start">
            {visibleSlots.map(slot => {
              const d = docs[slot.key]
              const isUploading = uploadingDoc === `${row.rowId}:${slot.key}`
              return (
                <div key={slot.key} className="border border-gray-200 rounded-lg p-2 bg-white min-w-[160px]">
                  <div className="text-[10px] font-bold text-gray-500 uppercase mb-1">{slot.label}</div>
                  {d?.url ? (
                    <div className="flex items-center gap-1 text-[10px] group">
                      <a href={d.url} target="_blank" rel="noreferrer" className="text-mcl-blue hover:underline truncate max-w-[140px]" title={d.filename}>
                        {d.filename}
                      </a>
                      {canEdit && (
                        <button
                          onClick={() => deleteDocFromRow(row, slot.key)}
                          className="text-red-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Eliminar"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ) : canEdit ? (
                    <button
                      onClick={() => triggerUpload(row, slot.key)}
                      disabled={isUploading}
                      className="text-[10px] text-mcl-blue hover:text-blue-700 font-semibold disabled:opacity-50"
                    >
                      {isUploading ? 'Subiendo…' : '+ Upload'}
                    </button>
                  ) : (
                    <span className="text-[10px] text-gray-300">—</span>
                  )}
                </div>
              )
            })}
          </div>
        </td>
      </tr>
    )
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <Layout title="Booking List">
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" />
        </div>
      </Layout>
    )
  }

  const totalRows = filteredRows.length

  return (
    <Layout title="Booking List">
      <input ref={fileInputRef} type="file" multiple accept=".pdf,.jpg,.jpeg,.png" className="hidden" onChange={handleDocFileSelected} />
      <div className="space-y-3">
        {/* Booking lock banner */}
        <div className={`rounded-xl border px-4 py-2 flex items-center justify-between gap-3 ${
          bookingLocked ? 'bg-gray-50 border-gray-200' : 'bg-amber-50 border-amber-300'
        }`}>
          {bookingLocked ? (
            <>
              <span className="text-gray-600 font-medium text-sm flex items-center gap-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
                Booking locked — {totalRows} AWB{totalRows !== 1 ? 's' : ''}
              </span>
              <button
                onClick={() => setBookingLocked(false)}
                className="text-xs bg-mcl-blue text-white px-4 py-1.5 rounded-lg hover:bg-blue-900 transition-colors font-semibold"
              >
                Open Booking
              </button>
            </>
          ) : (
            <>
              <span className="text-amber-800 font-medium text-sm">
                Edit mode — changes are not saved until you click "Save"
              </span>
              <span className="text-amber-600 text-xs">
                {Object.keys(dirtyRows).length > 0
                  ? `${Object.keys(dirtyRows).length} unsaved change${Object.keys(dirtyRows).length !== 1 ? 's' : ''}`
                  : 'No pending changes'}
              </span>
            </>
          )}
        </div>

        {/* Filters */}
        <div className="bg-white rounded-xl border border-gray-200 p-3 flex flex-wrap items-center gap-2">
          {flightFilter && (
            <span className="inline-flex items-center gap-1.5 bg-mcl-blue/10 border border-mcl-blue/30 text-mcl-blue text-xs font-semibold px-2.5 py-1 rounded-full">
              Flight: {filteredFlightLabel}
              <button
                onClick={clearFlightFilter}
                title="Clear flight filter"
                className="hover:bg-mcl-blue/20 rounded-full w-4 h-4 flex items-center justify-center leading-none"
              >
                ✕
              </button>
            </span>
          )}
          <label className={`text-xs ${flightFilter ? 'text-gray-300' : 'text-gray-500'}`}>Status</label>
          <select
            value={flightStatusFilter}
            onChange={e => setFlightStatusFilter(e.target.value as FlightStatusFilter)}
            disabled={!!flightFilter}
            title="Filter loaded flights"
            className="border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-mcl-blue/30 disabled:bg-gray-50 disabled:text-gray-300"
          >
            <option value="booked">Booked</option>
            <option value="terminado">Completed</option>
            <option value="dispatched">Dispatched</option>
            <option value="all">All</option>
          </select>
          <span className="text-gray-300 mx-1">|</span>
          <label className={`text-xs ${flightFilter ? 'text-gray-300' : 'text-gray-500'}`}>ETD From</label>
          <input type="date" value={etdFrom} onChange={e => setEtdFrom(e.target.value)}
            disabled={!!flightFilter}
            className="border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-mcl-blue/30 disabled:bg-gray-50 disabled:text-gray-300" />
          <label className={`text-xs ${flightFilter ? 'text-gray-300' : 'text-gray-500'}`}>To</label>
          <input type="date" value={etdTo} onChange={e => setEtdTo(e.target.value)}
            disabled={!!flightFilter}
            className="border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-mcl-blue/30 disabled:bg-gray-50 disabled:text-gray-300" />
          {isMcl && allClientNames.length > 1 && (
            <>
              <span className="text-gray-300 mx-1">|</span>
              <select value={clientFilter} onChange={e => setClientFilter(e.target.value)}
                disabled={!!flightFilter}
                className="border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-mcl-blue/30 disabled:bg-gray-50 disabled:text-gray-300">
                <option value="">All clients</option>
                {allClientNames.map(name => <option key={name} value={name}>{name}</option>)}
              </select>
            </>
          )}
          <span className="text-gray-300 mx-1">|</span>
          <div className="relative">
            <input
              type="text"
              value={awbSearch}
              onChange={e => { setAwbSearch(e.target.value); setCurrentPage(0) }}
              placeholder="Buscar AWB..."
              className="border border-gray-200 rounded-lg pl-7 pr-2 py-1 text-xs w-36 focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
            />
            <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            {awbSearch && (
              <button onClick={() => setAwbSearch('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs">✕</button>
            )}
          </div>
          <div className="flex-1" />
          {/* Notification bell */}
          {isMcl && unseenBookings.length > 0 && (
            <button
              onClick={() => setNotifDrawerOpen(true)}
              className="relative px-2 py-1.5 text-xs rounded-lg bg-orange-50 border border-orange-200 text-orange-600 hover:bg-orange-100 transition-colors"
              title={`${unseenBookings.length} booking(s) with unseen changes`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              </svg>
              <span className="absolute -top-1.5 -right-1.5 bg-orange-500 text-white text-[9px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                {unseenBookings.length}
              </span>
            </button>
          )}
          <span className="text-xs text-gray-400">
            {totalRows} AWB{totalRows === 1 ? '' : 's'}
            {pages.length > 1 && ` · Page ${Math.min(currentPage, pages.length - 1) + 1}/${pages.length}`}
          </span>
          {Object.keys(dirtyRows).length > 0 && (
            <button
              onClick={discardAll}
              disabled={savingAll}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-50"
              title="Discard all unsaved changes"
            >
              Discard
            </button>
          )}
          <button
            onClick={saveAll}
            disabled={savingAll || Object.keys(dirtyRows).length === 0}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-amber-500 text-white hover:bg-amber-600 disabled:bg-gray-200 disabled:text-gray-400"
            title={Object.keys(dirtyRows).length > 0 ? `${Object.keys(dirtyRows).length} unsaved change(s)` : 'No pending changes'}
          >
            {savingAll ? 'Saving...' : `Save${Object.keys(dirtyRows).length > 0 ? ` (${Object.keys(dirtyRows).length})` : ''}`}
          </button>
          <button
            onClick={openUploadModal}
            disabled={bookingLocked || clients.length === 0}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-gray-200 disabled:text-gray-400 flex items-center gap-1.5"
            title={clients.length === 0 ? 'No ecommerce clients available' : 'Upload Booking Excel'}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            Upload Excel
          </button>
          <button
            onClick={addBlankRow}
            disabled={bookingLocked}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-mcl-blue text-white hover:bg-blue-900 disabled:bg-gray-200 disabled:text-gray-400"
          >
            + New entry
          </button>
          <button
            onClick={() => navigate('/airfreight/transportation')}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200"
          >
            Transportation
          </button>
          <button
            onClick={() => navigate('/airfreight')}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200"
          >
            Dashboard
          </button>
        </div>

        {/* Bulk actions bar */}
        {selectedRows.size > 0 && (
          <div className="bg-mcl-blue/10 border border-mcl-blue/30 rounded-xl px-3 py-2 flex items-center gap-3">
            <span className="text-xs font-semibold text-mcl-blue">{selectedRows.size} selected</span>
            <button
              onClick={() => setBulkFlightModal(true)}
              className="px-3 py-1 text-xs font-semibold rounded-lg bg-mcl-blue text-white hover:bg-blue-900"
            >
              Change Flight#
            </button>
            <button
              onClick={() => setSelectedRows(new Set())}
              className="px-3 py-1 text-xs text-gray-500 hover:text-gray-700"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Table */}
        {totalRows === 0 ? (
          <div className="text-center py-16 text-gray-400 bg-white rounded-xl border border-gray-100">
            <div className="text-4xl mb-3">📋</div>
            <p className="text-sm">No AWBs in selected range</p>
            <button onClick={addBlankRow} className="mt-4 px-4 py-2 text-xs font-semibold rounded-lg bg-mcl-blue text-white hover:bg-blue-900">
              + Add first row
            </button>
          </div>
        ) : (
          <>
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="overflow-auto max-h-[calc(100vh-200px)] md:max-h-[calc(100vh-260px)]">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-[11px] font-bold text-gray-500 uppercase tracking-wide border-b border-gray-200 sticky top-0 z-20 shadow-[0_1px_0_rgb(229,231,235)]">
                  <tr>
                    <th className="px-2 py-2 w-8"></th>
                    <th className="px-1 py-2 w-16 text-center" title="OH / Dispatched">Status</th>
                    <th className="px-2 py-2 w-8" title="Docs">🗎</th>
                    <th className="px-2 py-2 cursor-pointer select-none min-w-[90px]" onClick={() => toggleSort('flight_number')}>
                      Flight # {sortArrow('flight_number')}
                    </th>
                    <th className="px-2 py-2 cursor-pointer select-none min-w-[140px]" onClick={() => toggleSort('etd')}>
                      ETD {sortArrow('etd')}
                    </th>
                    <th className="px-2 py-2 min-w-[110px]">1st Leg AWB</th>
                    <th className="px-2 py-2 min-w-[110px]">2nd Leg AWB</th>
                    <th className="px-2 py-2 min-w-[70px]">ULD</th>
                    <th className="px-2 py-2 text-right min-w-[70px]">PCs</th>
                    <th className="px-2 py-2 text-right min-w-[90px]">CW</th>
                    <th className="px-2 py-2 min-w-[90px]">Pick Up</th>
                    <th className="px-2 py-2 cursor-pointer select-none min-w-[100px]" onClick={() => toggleSort('ready')}>
                      Ready {sortArrow('ready')}
                    </th>
                    <th className="px-2 py-2 cursor-pointer select-none min-w-[100px]" onClick={() => toggleSort('last_day_free')}>
                      LDF {sortArrow('last_day_free')}
                    </th>
                    <th className="px-2 py-2 w-14">Dest.</th>
                    <th className="px-2 py-2 min-w-[140px]">CutOff</th>
                    <th className="px-2 py-2 min-w-[80px]">HOLD BG#</th>
                    <th className="px-2 py-2 min-w-[80px]">HOLD BOX#</th>
                    <th className="px-2 py-2 text-center w-8">LB</th>
                    <th className="px-2 py-2 text-center w-8">DG</th>
                    <th className="px-2 py-2 min-w-[120px]">Notes</th>
                    <th className="px-2 py-2 w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {displayedPage.map(([flightId, rows]) => {
                    const firstRow = rows[0]
                    return (
                      <Fragment key={flightId}>
                        {/* Flight group header — purple row */}
                        <tr className="bg-purple-600 border-b border-purple-700">
                          <td colSpan={21} className="px-3 py-1.5">
                            <div className="flex items-center justify-between gap-4 text-[11px] text-white">
                              <div className="flex items-center gap-x-3 gap-y-1 flex-wrap min-w-0">
                                <span className="font-bold tracking-wide">
                                  {firstRow.flightNumber || '(flight without number)'}
                                </span>
                                <span className="text-purple-300">·</span>
                                <span>
                                  <span className="text-purple-200 mr-1">ETD</span>
                                  {fmtDateTimeFull(firstRow.etd)}
                                </span>
                                <span className="text-purple-300">·</span>
                                <span>
                                  <span className="text-purple-200 mr-1">COT</span>
                                  {fmtDateTimeFull(firstRow.cutoff)}
                                </span>
                                <span className="text-purple-300">·</span>
                                <span>
                                  <span className="text-purple-200 mr-1">DEST</span>
                                  {firstRow.destination || ''}
                                </span>
                                <span className="text-purple-300">·</span>
                                <span className="text-purple-100">
                                  {rows.length} AWB{rows.length !== 1 ? 's' : ''}
                                </span>
                              </div>
                              {(!isClient || firstRow.flightStatus !== 'dispatched') && (
                                <button
                                  onClick={() => addRowToGroup(flightId)}
                                  disabled={bookingLocked}
                                  className="text-white hover:text-purple-100 font-semibold whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                  + Add AWB
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                        {rows.map(origRow => {
                          const r = mergeDirty(origRow)
                          // AWB-level dispatched lock: individual AWB or whole flight dispatched.
                          // Non-MCL users can never edit a locked/dispatched row.
                          const awbLocked = r.dispatched || r.flightStatus === 'dispatched'
                          const locked = bookingLocked || (awbLocked && !isMcl)
                          const rowIsDirty = !!dirtyRows[r.rowId]
                          const isUnseen = isMcl && unseenBookingIds.has(r.bookingId)
                          const groupBg = rowIsDirty ? 'bg-amber-50' : isUnseen ? 'bg-orange-50/50' : 'bg-white'
                          const borderClass = rowIsDirty ? 'border-amber-300' : 'border-gray-100'
                          const docsColor =
                            r.docsStatus === 'complete' ? 'bg-green-700'
                            : r.docsStatus === 'client_complete' ? 'bg-green-400'
                            : r.docsStatus === 'partial' ? 'bg-yellow-400'
                            : 'bg-gray-300'
                          return (
                            <Fragment key={r.rowId}>
                              <tr className={`${groupBg} border-b ${borderClass} ${locked ? 'opacity-60' : ''} ${isUnseen ? 'border-l-2 border-l-orange-400' : ''}`}>
                                <td className="px-2 py-1 text-center">
                                  <input type="checkbox" disabled={locked}
                                    checked={selectedRows.has(r.rowId)}
                                    onChange={e => {
                                      setSelectedRows(prev => {
                                        const next = new Set(prev)
                                        if (e.target.checked) next.add(r.rowId); else next.delete(r.rowId)
                                        return next
                                      })
                                    }} />
                                </td>
                                <td className="px-1 py-1">
                                  {/* OH / Warehouse Status / Dispatched */}
                                  <div className="flex items-center justify-center gap-1">
                                    {(() => {
                                      const ohOn = r.onHand
                                      const ws = r.warehouseStatus
                                      const dispatchedOn = r.dispatched || r.flightStatus === 'dispatched'
                                      const canEditOH = isMcl && !dispatchedOn
                                      const canEditDispatched = isMcl
                                      const wsColors: Record<string, string> = {
                                        D: 'bg-blue-500 text-white border-blue-600',
                                        R: 'bg-teal-500 text-white border-teal-600',
                                        B: 'bg-purple-500 text-white border-purple-600',
                                        L: 'bg-amber-500 text-white border-amber-600',
                                        T: 'bg-emerald-500 text-white border-emerald-600',
                                      }
                                      const wsTitles: Record<string, string> = {
                                        D: 'Documented',
                                        R: 'Received',
                                        B: 'Built (Distributed)',
                                        L: 'Loaded (DO)',
                                        T: 'Tendered',
                                      }
                                      return (
                                        <>
                                          <button
                                            onClick={() => canEditOH && toggleOnHand(origRow)}
                                            disabled={!canEditOH}
                                            title={ohOn ? 'On Hand — click to undo' : (canEditOH ? 'Mark On Hand' : 'On Hand')}
                                            className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-[9px] font-bold border transition-colors ${
                                              ohOn
                                                ? 'bg-emerald-500 text-white border-emerald-600'
                                                : 'bg-gray-100 text-gray-400 border-gray-300'
                                            } ${canEditOH ? 'hover:opacity-80 cursor-pointer' : 'cursor-default'}`}
                                          >
                                            OH
                                          </button>
                                          {ws ? (
                                            <span
                                              title={wsTitles[ws] || ws}
                                              className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-[9px] font-bold border ${wsColors[ws] || 'bg-gray-300 text-white border-gray-400'}`}
                                            >
                                              {ws}
                                            </span>
                                          ) : (
                                            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full text-[9px] font-bold border bg-gray-100 text-gray-300 border-gray-200">W</span>
                                          )}
                                          <button
                                            onClick={() => canEditDispatched && toggleDispatched(origRow)}
                                            disabled={!canEditDispatched}
                                            title={dispatchedOn ? `Dispatched${r.dispatchedBy ? ' by ' + r.dispatchedBy : ''} — click to reopen` : (canEditDispatched ? 'Mark Dispatched' : 'Dispatched')}
                                            className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-[9px] font-bold border transition-colors ${
                                              dispatchedOn
                                                ? 'bg-emerald-500 text-white border-emerald-600'
                                                : 'bg-gray-100 text-gray-400 border-gray-300'
                                            } ${canEditDispatched ? 'hover:opacity-80 cursor-pointer' : 'cursor-default'}`}
                                          >
                                            D
                                          </button>
                                        </>
                                      )
                                    })()}
                                  </div>
                                </td>
                                <td className="px-2 py-1 text-center">
                                  <button
                                    onClick={() => setExpandedDocsRow(expandedDocsRow === r.rowId ? null : r.rowId)}
                                    title="Documents"
                                    className="inline-block"
                                  >
                                    <span className={`inline-block w-3.5 h-3.5 rounded-full ${docsColor}`} />
                                  </button>
                                </td>
                                <td className="px-1 py-0.5">
                                  <TextCell r={r} field="flightNumber" value={r.flightNumber} locked={locked} mono />
                                </td>
                                <td className="px-1 py-0.5">
                                  <DateTimeCell r={r} field="etd" value={r.etd} locked={locked} />
                                </td>
                                <td className="px-1 py-0.5">
                                  <TextCell r={r} field="awb1st" value={r.awb1st} locked={locked} mono />
                                </td>
                                <td className="px-1 py-0.5">
                                  <TextCell r={r} field="awb2nd" value={r.awb2nd} locked={locked} mono />
                                </td>
                                <td className="px-1 py-0.5">
                                  <TextCell r={r} field="uldType" value={r.uldType} locked={locked} />
                                </td>
                                <td className="px-1 py-0.5">
                                  <NumCell r={r} field="pieces" value={r.pieces} locked={locked} />
                                </td>
                                <td className="px-1 py-0.5">
                                  <NumCell r={r} field="chargeableWeight" value={r.chargeableWeight} locked={locked} />
                                </td>
                                <td className="px-1 py-0.5">
                                  <TextCell r={r} field="pickupFrom" value={r.pickupFrom} locked={locked} />
                                </td>
                                <td className="px-1 py-0.5">
                                  <DateCell r={r} field="readyForPickup" value={r.readyForPickup} locked={locked} />
                                </td>
                                <td className="px-1 py-0.5">
                                  <DateCell r={r} field="lastDayFree" value={r.lastDayFree} locked={locked} />
                                </td>
                                <td className="px-1 py-0.5">
                                  <TextCell r={r} field="destination" value={r.destination} locked={locked} />
                                </td>
                                <td className="px-1 py-0.5">
                                  <DateTimeCell r={r} field="cutoff" value={r.cutoff} locked={locked} />
                                </td>
                                <td className="px-1 py-0.5">
                                  <TextCell r={r} field="holdBg" value={r.holdBg} locked={locked} />
                                </td>
                                <td className="px-1 py-0.5">
                                  <TextCell r={r} field="holdBox" value={r.holdBox} locked={locked} />
                                </td>
                                <td className="px-1 py-0.5 text-center">
                                  <input type="checkbox" disabled={locked} checked={r.lb}
                                    onChange={e => setDirty(r.rowId, 'lb', e.target.checked)} />
                                </td>
                                <td className="px-1 py-0.5 text-center">
                                  <input type="checkbox" disabled={locked} checked={r.dg}
                                    onChange={e => setDirty(r.rowId, 'dg', e.target.checked)} />
                                </td>
                                <td className="px-1 py-0.5">
                                  <TextCell r={r} field="notes" value={r.notes} locked={locked} />
                                </td>
                                <td className="px-2 py-1 text-center">
                                  {!locked && (
                                    <button onClick={() => setDeleteConfirm(r)} className="text-gray-300 hover:text-red-500" title="Delete">🗑</button>
                                  )}
                                  {r.editedAt && (
                                    <span title={`Edited ${fmtDateTimeShort(r.editedAt)} by ${r.editedBy || ''}`} className="text-[10px] text-amber-500 ml-1">◆</span>
                                  )}
                                </td>
                              </tr>
                              {expandedDocsRow === r.rowId && <DocsPanel row={origRow} />}
                            </Fragment>
                          )
                        })}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination controls */}
          {pages.length > 1 && (
            <div className="flex items-center justify-center gap-1.5 pt-1">
              <button
                onClick={() => setCurrentPage(p => Math.max(0, p - 1))}
                disabled={currentPage === 0}
                className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-white border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ←
              </button>
              {pages.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setCurrentPage(i)}
                  className={`min-w-[28px] px-2 py-1 text-xs font-semibold rounded-lg border ${
                    currentPage === i
                      ? 'bg-mcl-blue text-white border-mcl-blue'
                      : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {i + 1}
                </button>
              ))}
              <button
                onClick={() => setCurrentPage(p => Math.min(pages.length - 1, p + 1))}
                disabled={currentPage >= pages.length - 1}
                className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-white border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                →
              </button>
            </div>
          )}
          </>
        )}
      </div>

      {/* Bulk prompt (inherited field update) */}
      {bulkPrompt && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl shadow-xl p-5 max-w-md w-full">
            <h3 className="text-lg font-bold text-gray-800 mb-2">Apply change to flight</h3>
            <p className="text-sm text-gray-600 mb-4">
              This field is shared across the entire flight. Apply the change to all <b>{bulkPrompt.count}</b> rows of the flight?
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  // Revert dirty
                  setDirtyRows(prev => {
                    const next = { ...prev }
                    if (next[bulkPrompt.rowId]) {
                      const copy = { ...next[bulkPrompt.rowId] }
                      delete copy[bulkPrompt.field]
                      if (Object.keys(copy).length === 0) delete next[bulkPrompt.rowId]
                      else next[bulkPrompt.rowId] = copy
                    }
                    return next
                  })
                  setBulkPrompt(null)
                }}
                className="px-4 py-2 text-sm rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200"
              >
                Cancel
              </button>
              <button
                onClick={() => applyBulkInherited(bulkPrompt)}
                className="px-4 py-2 text-sm font-semibold rounded-lg bg-mcl-blue text-white hover:bg-blue-900"
              >
                Apply to entire flight
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Excel upload modal */}
      {uploadModalOpen && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl shadow-xl p-5 max-w-md w-full">
            <h3 className="text-lg font-bold text-gray-800 mb-2">Upload Booking Excel</h3>
            <p className="text-xs text-gray-500 mb-4">
              The system groups rows by <b>Flight # + ETD</b>, creates or updates the flight and replaces AWB lines for the selected client's booking.
            </p>

            <label className="block text-xs font-semibold text-gray-600 mb-1">Client</label>
            <select
              value={uploadSelectedClientId}
              onChange={e => setUploadSelectedClientId(e.target.value)}
              disabled={uploadingExcel || clients.length === 1}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-mcl-blue/30 disabled:bg-gray-50"
            >
              <option value="">— Select a client —</option>
              {clients.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>

            <label className="block text-xs font-semibold text-gray-600 mb-1">Excel File</label>
            <input
              ref={excelInputRef}
              type="file"
              accept=".xlsx,.xls"
              disabled={uploadingExcel || !uploadSelectedClientId}
              onChange={handleEcommerceExcelUpload}
              className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 file:mr-3 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-mcl-blue file:text-white hover:file:bg-blue-900 disabled:opacity-50 disabled:cursor-not-allowed"
            />

            {uploadError && (
              <div className="mt-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {uploadError}
              </div>
            )}
            {uploadingExcel && (
              <div className="mt-3 text-xs text-mcl-blue bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 flex items-center gap-2">
                <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                  <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" className="opacity-75" />
                </svg>
                Processing Excel...
              </div>
            )}

            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={closeUploadModal}
                disabled={uploadingExcel}
                className="px-4 py-2 text-sm rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-50"
              >
                {uploadingExcel ? 'Processing...' : 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Post-upload summary modal */}
      {uploadSummary && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl p-5 max-w-lg w-full max-h-[85vh] overflow-y-auto">
            <h3 className="text-lg font-bold text-gray-800 mb-3">Upload Result</h3>

            {/* Counts */}
            <div className="grid grid-cols-2 gap-2 text-xs mb-4">
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                <div className="text-emerald-700 font-semibold">Flights</div>
                <div className="text-emerald-900">
                  {uploadSummary.flightsCreated} created · {uploadSummary.flightsUpdated} updated
                </div>
              </div>
              <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                <div className="text-blue-700 font-semibold">Bookings</div>
                <div className="text-blue-900">
                  {uploadSummary.bookingsCreated} created · {uploadSummary.bookingsUpdated} updated
                </div>
              </div>
              <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 col-span-2">
                <div className="text-gray-700 font-semibold">Total AWBs processed</div>
                <div className="text-gray-900">{uploadSummary.totalAwbs}</div>
              </div>
            </div>

            {/* Moves */}
            {uploadSummary.moves.length > 0 && (
              <div className="mb-3">
                <div className="text-xs font-semibold text-amber-800 mb-1">
                  🔄 {uploadSummary.moves.length} AWB{uploadSummary.moves.length === 1 ? '' : 's'} moved from another flight
                </div>
                <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-[11px] text-amber-900 max-h-32 overflow-y-auto space-y-0.5">
                  {uploadSummary.moves.map((m, i) => (
                    <div key={i} className="font-mono">
                      <b>{m.awb}</b>: {m.fromFlight} → {m.toFlight}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Bookings deleted */}
            {uploadSummary.bookingsDeleted > 0 && (
              <div className="mb-3">
                <div className="text-xs font-semibold text-gray-700 mb-1">
                  🗑️ {uploadSummary.bookingsDeleted} old booking{uploadSummary.bookingsDeleted === 1 ? '' : 's'} deleted (no AWBs remaining)
                </div>
              </div>
            )}

            {/* Flights deleted */}
            {uploadSummary.flightsDeleted > 0 && (
              <div className="mb-3">
                <div className="text-xs font-semibold text-gray-700 mb-1">
                  ✈️ {uploadSummary.flightsDeleted} flight{uploadSummary.flightsDeleted === 1 ? '' : 's'} deleted (no bookings remaining)
                </div>
              </div>
            )}

            {/* In-Excel duplicates */}
            {uploadSummary.inExcelDupes.length > 0 && (
              <div className="mb-3">
                <div className="text-xs font-semibold text-orange-800 mb-1">
                  ⚠️ {uploadSummary.inExcelDupes.length} AWB{uploadSummary.inExcelDupes.length === 1 ? '' : 's'} duplicated in the Excel
                </div>
                <div className="bg-orange-50 border border-orange-200 rounded-lg px-3 py-2 text-[11px] text-orange-900 max-h-32 overflow-y-auto">
                  {uploadSummary.inExcelDupes.map((a, i) => (
                    <div key={i} className="font-mono">{a}</div>
                  ))}
                  <div className="mt-1 text-orange-700 italic">
                    Last occurrence wins. Check the Excel if this was unintentional.
                  </div>
                </div>
              </div>
            )}

            {/* Cross-client conflicts (should never happen per business rules) */}
            {uploadSummary.crossClientConflicts.length > 0 && (
              <div className="mb-3">
                <div className="text-xs font-semibold text-red-800 mb-1">
                  ❌ {uploadSummary.crossClientConflicts.length} cross-client conflict{uploadSummary.crossClientConflicts.length === 1 ? '' : 's'}
                </div>
                <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-[11px] text-red-900 max-h-32 overflow-y-auto">
                  {uploadSummary.crossClientConflicts.map((c, i) => (
                    <div key={i} className="font-mono">{c}</div>
                  ))}
                  <div className="mt-1 text-red-700 italic">
                    These AWBs belong to other clients. They were ignored — review manually.
                  </div>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => setUploadSummary(null)}
                className="px-4 py-2 text-sm font-semibold rounded-lg bg-mcl-blue text-white hover:bg-blue-900"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl shadow-xl p-5 max-w-md w-full">
            <h3 className="text-lg font-bold text-gray-800 mb-2">Delete AWB</h3>
            <p className="text-sm text-gray-600 mb-4">
              Delete AWB <b className="font-mono">{deleteConfirm.awb1st || '(no number)'}</b>?
              This action cannot be undone and will also delete associated documents.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-4 py-2 text-sm rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteRow(deleteConfirm)}
                className="px-4 py-2 text-sm font-semibold rounded-lg bg-red-500 text-white hover:bg-red-600"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk flight change modal */}
      {bulkFlightModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl shadow-xl p-5 max-w-md w-full">
            <h3 className="text-lg font-bold text-gray-800 mb-2">Move to another flight</h3>
            <p className="text-sm text-gray-600 mb-3">
              Move <b>{selectedRows.size}</b> AWB{selectedRows.size === 1 ? '' : 's'} to flight:
            </p>
            <input
              type="text"
              value={bulkTargetFlight}
              onChange={e => setBulkTargetFlight(e.target.value)}
              placeholder="Ej. QT4091"
              list="flight-list"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-4"
            />
            <datalist id="flight-list">
              {[...new Set(allRows.map(r => r.flightNumber).filter(Boolean))].map(fn => (
                <option key={fn} value={fn} />
              ))}
            </datalist>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setBulkFlightModal(false); setBulkTargetFlight('') }}
                className="px-4 py-2 text-sm rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200"
              >
                Cancel
              </button>
              <button
                onClick={applyBulkFlightChange}
                disabled={!bulkTargetFlight}
                className="px-4 py-2 text-sm font-semibold rounded-lg bg-mcl-blue text-white hover:bg-blue-900 disabled:opacity-50"
              >
                Move
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Notification drawer — unseen modifications */}
      {notifDrawerOpen && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black/30" onClick={() => setNotifDrawerOpen(false)} />
          <div className="relative bg-white w-full max-w-md shadow-xl flex flex-col h-full">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50">
              <h3 className="text-sm font-bold text-gray-800">Unseen changes ({unseenBookings.length})</h3>
              <div className="flex items-center gap-2">
                {unseenBookings.length > 0 && (
                  <button onClick={markAllSeen} className="text-[10px] text-mcl-blue hover:underline">
                    Mark all as seen
                  </button>
                )}
                <button onClick={() => setNotifDrawerOpen(false)} className="text-gray-400 hover:text-gray-600 text-lg leading-none">&times;</button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {unseenBookings.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-8">No pending changes to review</p>
              ) : (
                unseenBookings.map(u => (
                  <div key={u.bookingId} className="bg-orange-50 border border-orange-200 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-semibold text-gray-800">{u.clientName}</span>
                      <span className="text-[10px] text-gray-400 font-mono">{u.flightNumber}</span>
                    </div>
                    {u.lastChange && (
                      <div className="text-[11px] text-gray-600 mb-2">
                        <span className="font-medium">{u.lastChange.changed_by}</span>
                        <span className="text-gray-400"> — {new Date(u.lastChange.changed_at).toLocaleString('en', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                        {u.lastChange.fields_changed.map((f, i) => (
                          <div key={i} className="mt-0.5">
                            <span className="font-medium">{f.label}:</span>{' '}
                            {f.old_value && <span className="line-through text-gray-400">{f.old_value}</span>}
                            {f.old_value && ' → '}
                            <span>{f.new_value}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-orange-600">{u.changeCount} change{u.changeCount !== 1 ? 's' : ''}</span>
                      <button
                        onClick={() => markBookingSeen(u.bookingId)}
                        className="text-[10px] text-mcl-blue hover:underline"
                      >
                        Mark as seen
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}
