import { useState, useEffect, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  collection, query, orderBy, onSnapshot, doc, updateDoc, getDoc, where,
} from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import {
  AirfreightBooking, AirfreightFlight, AirfreightClient,
  AirfreightDocumentFile, AwbSecondLeg, TruckingVendor,
} from '../../types'
import Layout from '../../components/Layout'
import { AwbAlertPopup } from '../../components/SyncAlertPopup'
import { useSyncAlerts, alertsByAwb } from '../../lib/useSyncAlerts'
import { storagePath, fmtNum } from '../../lib/utils'

// ── Types ──────────────────────────────────────────────────────────────────────

type TransportStatus = 'pending' | 'picked_up' | 'on_hand'

interface TransportRow {
  bookingId: string
  awbIndex: number
  flightNumber: string
  flightDate: string
  flightId: string
  clientId: string
  clientName: string
  agentName?: string | null
  awbNumber: string
  uldType: string
  awb2ndLeg: string
  pieces: number
  chargeableWeight: number
  grossWeight: number
  pickupFrom: string
  readyForPickup: string
  lastDayFree: string
  transportCompany: string
  transportCompanyNotes: string
  transportStatus: TransportStatus
  transportDocs: AirfreightDocumentFile[]
  dropOffTime: string
  editedFields: string[]
  warehouseStatus: string  // 'D' = documented, 'R' = received
  docsInDrive: boolean
  // Tracking agent fields
  trackingStatus: string
  trackingEta: string
  trackingFlight: string
  trackingLegs: { station: string; status: string; label: string; time: string; flight?: string; uld?: string }[]
}

const STATUS_LABELS: Record<TransportStatus, string> = {
  pending: 'Pending',
  picked_up: 'Picked Up',
  on_hand: 'On Hand',
}

const STATUS_CYCLE: TransportStatus[] = ['pending', 'picked_up', 'on_hand']

const IMPORT_DOC_TYPES = [
  { key: 'import_1f_files', label: '1F / 7512' },
  { key: 'import_release_files', label: 'Release Form' },
  { key: 'import_payment_files', label: 'Payment' },
] as const

type ImportDocKey = typeof IMPORT_DOC_TYPES[number]['key']

function fmtDate(iso: string) {
  if (!iso) return '—'
  const [dp] = iso.split('T')
  const [yyyy, mm, dd] = (dp || '').split('-')
  if (!yyyy || !mm || !dd) return iso
  return `${mm}/${dd}/${yyyy.slice(2)}`
}

const MONTH_SHORT = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']

function fmtEtd(iso: string) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  const dd = String(d.getDate()).padStart(2, '0')
  const mon = MONTH_SHORT[d.getMonth()]
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${dd} ${mon} ${hh}:${mm}`
}

function etdPriority(iso: string): { label: string; color: string } {
  if (!iso) return { label: '—', color: 'bg-gray-100 text-gray-400' }
  const etd = new Date(iso)
  if (isNaN(etd.getTime())) return { label: '—', color: 'bg-gray-100 text-gray-400' }
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const tomorrowStart = new Date(todayStart.getTime() + 86_400_000)
  const dayAfterStart = new Date(todayStart.getTime() + 2 * 86_400_000)
  if (etd < tomorrowStart) return { label: 'Urgent', color: 'bg-red-100 text-red-700' }
  if (etd < dayAfterStart) return { label: 'Priority', color: 'bg-yellow-100 text-yellow-700' }
  return { label: 'Normal', color: 'bg-green-100 text-green-700' }
}

interface DocEntry { label: string; url: string; filename: string }

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
    <h1 style="font-size:16px;color:#1a3b5c;margin-bottom:16px;">${title} — ${docs.length} document${docs.length > 1 ? 's' : ''}</h1>
    ${embedHtml}
  </body></html>`)
  win.document.close()
}

function lfdColor(lastDayFree: string, isOnHand: boolean): string {
  if (isOnHand || !lastDayFree) return ''
  const lfd = new Date(lastDayFree)
  if (isNaN(lfd.getTime())) return ''
  const hoursLeft = (lfd.getTime() - Date.now()) / 3_600_000
  if (hoursLeft < 24) return 'bg-red-200'
  if (hoursLeft < 48) return 'bg-yellow-200'
  return ''
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function AirfreightTransportation() {
  const { user, isAdmin, isSuperAgent, isAgent, isCounter, isBodega, isClient, clientId } = useAuth()
  const navigate = useNavigate()
  const isMcl = isAdmin || isSuperAgent || isAgent || isCounter || isBodega

  const [rawFlights, setRawFlights] = useState<(AirfreightFlight & { id: string })[]>([])
  const [rawBookings, setRawBookings] = useState<(AirfreightBooking & { id: string })[]>([])
  const [clients, setClients] = useState<(AirfreightClient & { id: string })[]>([])
  const [vendors, setVendors] = useState<(TruckingVendor & { id: string })[]>([])
  // bookingsMap is derived via useMemo below (SOL-14)
  const [loading, setLoading] = useState(true)

  // Auto-refresh for LFD semaphore (every hour)
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 3_600_000)
    return () => clearInterval(id)
  }, [])

  // Filters
  const [filterClient, setFilterClient] = useState('')
  const [filterStatus, setFilterStatus] = useState<'all' | 'pending' | 'on_hand'>('all')
  const [filterUldType, setFilterUldType] = useState<'' | 'BUP' | 'LOOSE'>('')
  const [searchText, setSearchText] = useState('')
  // Date range — default last 2 days
  const defaultTransFrom = new Date(); defaultTransFrom.setDate(defaultTransFrom.getDate() - 2)
  const [dateFrom, setDateFrom] = useState(defaultTransFrom.toLocaleDateString('en-CA'))
  const [dateTo, setDateTo] = useState('')

  // Inline edits
  const [editingCellKey, setEditingCellKey] = useState<string | null>(null)
  const [editingCellVal, setEditingCellVal] = useState('')

  // AWB selection for pickup order
  const [selectedAwbs, setSelectedAwbs] = useState<Set<string>>(new Set()) // key = bookingId-awbIndex

  // Sync alerts
  const syncAlerts = useSyncAlerts()
  const awbAlertMap = alertsByAwb(syncAlerts)
  const [alertPopupAwb, setAlertPopupAwb] = useState<string | null>(null)

  // Doc drawer
  const [drawerBookingIds, setDrawerBookingIds] = useState<string[] | null>(null)
  const [drawerTitle, setDrawerTitle] = useState('')
  const [uploadingSection, setUploadingSection] = useState<string | null>(null)
  const drawerFileRef = useRef<HTMLInputElement>(null)
  const pendingDrawerUpload = useRef<{ bookingIds: string[]; docKey: ImportDocKey } | null>(null)

  useEffect(() => {
    const cQ = query(collection(db, 'airfreight_clients'), orderBy('name'))
    const unsubClients = onSnapshot(cQ, snap => {
      const all = snap.docs.map(d => ({ ...d.data() as AirfreightClient, id: d.id }))
      setClients(all.filter(c => c.active !== false))
    })
    const vQ = query(collection(db, 'vendors'), orderBy('name'))
    const unsubVendors = onSnapshot(vQ, snap => {
      setVendors(snap.docs.map(d => ({ ...d.data() as TruckingVendor, id: d.id })).filter(v => v.status === 'active'))
    })
    return () => { unsubClients(); unsubVendors() }
  }, [])

  // SOL-14: Independent listeners for flights and bookings
  useEffect(() => {
    const flightsConstraints: any[] = [orderBy('flight_datetime', 'desc')]
    if (dateFrom) {
      flightsConstraints.unshift(where('flight_datetime', '>=', new Date(dateFrom + 'T00:00:00').toISOString()))
    }
    if (dateTo) {
      flightsConstraints.push(where('flight_datetime', '<=', new Date(dateTo + 'T23:59:59').toISOString()))
    }
    const fQ = query(collection(db, 'airfreight_flights'), ...flightsConstraints)

    const unsubFlights = onSnapshot(fQ, fSnap => {
      setRawFlights(fSnap.docs.map(d => ({ ...d.data() as AirfreightFlight, id: d.id })))
    })

    const bQ = isClient && clientId
      ? query(collection(db, 'airfreight_bookings'), where('client_id', '==', clientId))
      : query(collection(db, 'airfreight_bookings'), orderBy('created_at', 'desc'))

    const unsubBookings = onSnapshot(bQ, bSnap => {
      setRawBookings(bSnap.docs.map(d => ({ ...d.data() as AirfreightBooking, id: d.id })))
      setLoading(false)
    })

    return () => { unsubFlights(); unsubBookings() }
  }, [isClient, clientId, dateFrom, dateTo])

  // SOL-14: Derive transport rows + bookingsMap from raw state
  const { rows, bookingsMap } = useMemo(() => {
    const transportClientIds = new Set(clients.filter(c => c.transportation_enabled).map(c => c.id!))
    const flightMap = new Map(rawFlights.map(f => [f.id!, f]))
    const transportRows: TransportRow[] = []
    const bMap = new Map<string, AirfreightBooking & { id: string }>()

    for (const b of rawBookings) {
      bMap.set(b.id!, b)

      const isEcommerce = b.booking_type === 'ecommerce'
      const isTransportClient = transportClientIds.has(b.client_id)
      if (!isEcommerce && !isTransportClient) continue

      const flight = flightMap.get(b.flight_id)
      if (!flight) continue

      if ((b.booking_type === 'mawb' || b.booking_type === 'ecommerce') && b.awb_lines) {
        b.awb_lines.forEach((line, idx) => {
          transportRows.push({
            bookingId: b.id!,
            awbIndex: idx,
            flightNumber: flight.flight_number || '',
            flightDate: flight.flight_datetime || '',
            flightId: flight.id!,
            clientId: b.client_id,
            clientName: b.client_name,
            agentName: b.agent_name || null,
            awbNumber: line.awb_number || '',
            uldType: line.uld_type || 'LOOSE',
            awb2ndLeg: line.awb_2nd_leg || '',
            pieces: line.pieces || 0,
            chargeableWeight: line.chargeable_weight || 0,
            grossWeight: line.weight || 0,
            pickupFrom: line.pickup_from || '',
            readyForPickup: line.ready_for_pickup || '',
            lastDayFree: line.last_day_free || '',
            transportCompany: line.transport_company || '',
            transportCompanyNotes: (line as any).transport_company_notes || '',
            transportStatus: (line.transport_status as TransportStatus) || 'pending',
            transportDocs: line.transport_docs || [],
            dropOffTime: line.drop_off_time || '',
            editedFields: (line as any).transport_edited_fields || [],
            warehouseStatus: (line as any).warehouse_status || '',
            docsInDrive: !!(line as any).docs_in_drive,
            trackingStatus: (line as any).tracking_status || '',
            trackingEta: (line as any).tracking_eta || '',
            trackingFlight: (line as any).tracking_inbound_flight || '',
            trackingLegs: (line as any).tracking_legs || [],
          })
        })
      } else if (b.booking_type === 'simple') {
        transportRows.push({
          bookingId: b.id!,
          awbIndex: -1,
          flightNumber: flight.flight_number || '',
          flightDate: flight.flight_datetime || '',
          flightId: flight.id!,
          clientId: b.client_id,
          clientName: b.client_name,
          agentName: b.agent_name || null,
          awbNumber: b.awb_1st_leg || '',
          uldType: b.uld_type || 'LOOSE',
          awb2ndLeg: b.awb_2nd_leg || '',
          pieces: b.pieces || 0,
          chargeableWeight: b.chargeable_weight || 0,
          grossWeight: b.weight || 0,
          pickupFrom: b.pickup_from || '',
          readyForPickup: b.ready_for_pickup || '',
          lastDayFree: b.last_day_free || '',
          transportCompany: (b as any).transport_company || '',
          transportCompanyNotes: (b as any).transport_company_notes || '',
          transportStatus: ((b as any).transport_status as TransportStatus) || 'pending',
          transportDocs: (b as any).transport_docs || [],
          dropOffTime: (b as any).drop_off_time || '',
          editedFields: (b as any).transport_edited_fields || [],
          warehouseStatus: (b as any).warehouse_status || '',
          docsInDrive: !!(b as any).docs_in_drive,
          trackingStatus: '',
          trackingEta: '',
          trackingFlight: '',
          trackingLegs: [],
        })
      }
    }
    return { rows: transportRows, bookingsMap: bMap }
  }, [rawFlights, rawBookings, clients])

  // ── Filtering ──

  const filtered = rows.filter(r => {
    // Date range filter (Ready for Pickup date)
    const rd = (r.readyForPickup || '').slice(0, 10)
    if (dateFrom && rd && rd < dateFrom) return false
    if (dateTo && rd && rd > dateTo) return false
    if (filterClient && r.clientId !== filterClient) return false
    if (filterStatus === 'pending' && (r.warehouseStatus === 'D' || r.warehouseStatus === 'R')) return false
    if (filterStatus === 'on_hand' && r.warehouseStatus !== 'D' && r.warehouseStatus !== 'R') return false
    if (filterUldType) {
      const uld = (r.uldType || '').toUpperCase()
      if (filterUldType === 'BUP' && uld !== 'BUP') return false
      if (filterUldType === 'LOOSE' && (uld === 'BUP' || uld === 'B')) return false
    }
    if (searchText) {
      const s = searchText.toLowerCase()
      if (!r.awbNumber.toLowerCase().includes(s) &&
          !r.awb2ndLeg.toLowerCase().includes(s) &&
          !r.clientName.toLowerCase().includes(s) &&
          !(r.agentName || '').toLowerCase().includes(s) &&
          !r.flightNumber.toLowerCase().includes(s) &&
          !r.transportCompany.toLowerCase().includes(s) &&
          !r.pickupFrom.toLowerCase().includes(s)) return false
    }
    return true
  })

  // ── Sort by Last Day Free ASC ──

  const sortedRows = [...filtered].sort((a, b) => {
    const aLfd = a.lastDayFree || '9999'
    const bLfd = b.lastDayFree || '9999'
    return aLfd.localeCompare(bLfd)
  })

  // ── Firestore helpers ──

  async function updateAwbLine(row: TransportRow, updates: Partial<AwbSecondLeg>) {
    const snap = await getDoc(doc(db, 'airfreight_bookings', row.bookingId))
    if (!snap.exists()) { console.warn('updateAwbLine: booking not found', row.bookingId); return }
    const data = snap.data() as AirfreightBooking
    if (row.awbIndex >= 0 && data.awb_lines) {
      if (row.awbIndex >= data.awb_lines.length) {
        console.warn('updateAwbLine: awbIndex out of bounds', row.awbIndex, 'lines:', data.awb_lines.length)
        return
      }
      const lines = [...data.awb_lines]
      lines[row.awbIndex] = { ...lines[row.awbIndex], ...updates }
      await updateDoc(doc(db, 'airfreight_bookings', row.bookingId), { awb_lines: lines })
    } else {
      const topLevel: Record<string, unknown> = {}
      if ('pickup_from' in updates) topLevel.pickup_from = updates.pickup_from
      if ('ready_for_pickup' in updates) topLevel.ready_for_pickup = updates.ready_for_pickup
      if ('last_day_free' in updates) topLevel.last_day_free = updates.last_day_free
      if ('on_hand' in updates) topLevel.on_hand = updates.on_hand
      if ('drop_off_time' in updates) topLevel.drop_off_time = updates.drop_off_time
      if ('transport_company' in updates) topLevel.transport_company = updates.transport_company
      if ('transport_company_notes' in updates) topLevel.transport_company_notes = (updates as any).transport_company_notes
      if ('transport_status' in updates) topLevel.transport_status = updates.transport_status
      if ('transport_edited_fields' in updates) topLevel.transport_edited_fields = (updates as any).transport_edited_fields
      if (Object.keys(topLevel).length > 0) {
        await updateDoc(doc(db, 'airfreight_bookings', row.bookingId), topLevel)
      }
    }
  }

  // ── Generic inline cell edit ──

  function startCellEdit(row: TransportRow, field: string, currentVal: string, defaultVal?: string) {
    setEditingCellKey(`${row.bookingId}-${row.awbIndex}-${field}`)
    setEditingCellVal(currentVal || defaultVal || '')
  }

  async function saveCellEdit(row: TransportRow, field: string) {
    setEditingCellKey(null)
    const val = editingCellVal.trim()

    // ── Weight (Gross Weight) inline edit ──
    if (field === 'weight') {
      const numVal = parseFloat(val)
      if (!val) return  // empty → no save
      if (isNaN(numVal) || numVal < 0) return
      if (row.chargeableWeight > 0 && numVal > row.chargeableWeight) {
        alert(`GW (${numVal}) cannot exceed CHW (${row.chargeableWeight})`)
        return
      }
      const oldWeight = row.grossWeight || 0
      if (numVal === oldWeight) return
      // Write weight + audit_log entry
      const snap = await getDoc(doc(db, 'airfreight_bookings', row.bookingId))
      if (!snap.exists()) return
      const data = snap.data() as AirfreightBooking
      if (row.awbIndex >= 0 && data.awb_lines) {
        const lines = [...data.awb_lines]
        if (row.awbIndex >= lines.length) return
        const line = { ...lines[row.awbIndex] }
        const auditEntry = {
          action: 'field_changed',
          field: 'weight',
          old_value: String(oldWeight),
          new_value: String(numVal),
          user: user?.email || '',
          at: new Date().toISOString(),
        }
        line.weight = numVal
        line.audit_log = [...(line.audit_log || []), auditEntry]
        lines[row.awbIndex] = line
        await updateDoc(doc(db, 'airfreight_bookings', row.bookingId), { awb_lines: lines })
      } else {
        // Simple booking — top-level weight
        await updateDoc(doc(db, 'airfreight_bookings', row.bookingId), { weight: numVal })
      }
      return
    }

    const firestoreField = field === 'company' ? 'transport_company'
      : field === 'pickupFrom' ? 'pickup_from'
      : field === 'ready' ? 'ready_for_pickup'
      : field === 'lastDay' ? 'last_day_free' : ''
    if (!firestoreField) return
    const oldVal = field === 'company' ? (row.transportCompany || '')
      : field === 'pickupFrom' ? (row.pickupFrom || '')
      : field === 'ready' ? (row.readyForPickup || '')
      : (row.lastDayFree || '')
    if (val === oldVal) return
    const editedSet = new Set(row.editedFields)
    editedSet.add(field)
    await updateAwbLine(row, {
      [firestoreField]: val || null,
      transport_edited_fields: Array.from(editedSet),
    } as any)
  }

  // ── Doc drawer helpers ──

  function getImportDocs(bookingIds: string[], docKey: ImportDocKey): AirfreightDocumentFile[] {
    for (const bid of bookingIds) {
      const b = bookingsMap.get(bid)
      if (b) {
        const files = (b as any)[docKey] as AirfreightDocumentFile[] | undefined
        if (files && files.length > 0) return files
      }
    }
    return []
  }

  function getTotalDocCount(bookingIds: string[]): number {
    let total = 0
    for (const { key } of IMPORT_DOC_TYPES) {
      total += getImportDocs(bookingIds, key).length
    }
    return total
  }

  function collectGroupDocs(bookingIds: string[]): DocEntry[] {
    const entries: DocEntry[] = []
    for (const { key, label } of IMPORT_DOC_TYPES) {
      const files = getImportDocs(bookingIds, key)
      files.forEach((f, i) => {
        entries.push({
          label: `${label}${files.length > 1 ? ` (${i + 1})` : ''}`,
          url: f.url,
          filename: f.filename,
        })
      })
    }
    return entries
  }

  function printDocs(bookingIds: string[], title: string) {
    const docs = collectGroupDocs(bookingIds)
    openDocsViewer(docs, title)
  }

  function triggerDrawerUpload(bookingIds: string[], docKey: ImportDocKey) {
    pendingDrawerUpload.current = { bookingIds, docKey }
    drawerFileRef.current?.click()
  }

  async function handleDrawerFile(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    const ctx = pendingDrawerUpload.current
    if (!files || files.length === 0 || !ctx || !user) return
    const fileList = Array.from(files)
    e.target.value = ''
    setUploadingSection(ctx.docKey)
    try {
      const newDocs: AirfreightDocumentFile[] = []
      const bk = bookingsMap.get(ctx.bookingIds[0])
      for (const file of fileList) {
        const path = storagePath({ flightNumber: bk?.flight_number, flightDate: '', airline: bk?.airline, clientName: bk?.client_name, mawbNumber: bk?.mawb_number, filename: `import_${ctx.docKey}_${Date.now()}_${file.name}` })
        const storageRef = ref(storage, path)
        await uploadBytes(storageRef, file)
        const url = await getDownloadURL(storageRef)
        newDocs.push({
          url,
          filename: file.name,
          version: 1,
          uploaded_at: new Date().toISOString(),
          uploaded_by: user.email || user.uid || '',
          modified_seen: true,
          history: [],
        })
      }
      for (const bid of ctx.bookingIds) {
        const snap = await getDoc(doc(db, 'airfreight_bookings', bid))
        if (!snap.exists()) continue
        const existing = (snap.data() as any)[ctx.docKey] as AirfreightDocumentFile[] | undefined
        const merged = [...(existing || []), ...newDocs]
        await updateDoc(doc(db, 'airfreight_bookings', bid), {
          [ctx.docKey]: merged,
        })
        // Optimistic update so drawer shows files immediately
        setRawBookings(prev => prev.map(b => b.id === bid ? { ...b, [ctx.docKey]: merged } as any : b))
      }
    } catch (err) {
      console.error('Import doc upload error:', err)
    } finally {
      setUploadingSection(null)
    }
  }

  async function handleDeleteDoc(bookingIds: string[], docKey: ImportDocKey, fileIndex: number) {
    try {
      for (const bid of bookingIds) {
        const snap = await getDoc(doc(db, 'airfreight_bookings', bid))
        if (!snap.exists()) continue
        const existing = (snap.data() as any)[docKey] as AirfreightDocumentFile[] | undefined
        if (!existing) continue
        const updated = existing.filter((_, i) => i !== fileIndex)
        await updateDoc(doc(db, 'airfreight_bookings', bid), {
          [docKey]: updated,
        })
        // Optimistic update
        setRawBookings(prev => prev.map(b => b.id === bid ? { ...b, [docKey]: updated } as any : b))
      }
    } catch (err) {
      console.error('Delete doc error:', err)
    }
  }

  // ── Render ──

  if (loading) {
    return (
      <Layout title="Transportation" backTo="/airfreight">
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" />
        </div>
      </Layout>
    )
  }

  // Selection helpers
  function toggleAwbSelection(row: TransportRow) {
    const key = `${row.bookingId}-${row.awbIndex}`
    setSelectedAwbs(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  function selectAllVisible() {
    const keys = sortedRows.map(r => `${r.bookingId}-${r.awbIndex}`)
    setSelectedAwbs(new Set(keys))
  }

  function deselectAll() { setSelectedAwbs(new Set()) }

  function handleCreatePickupOrder() {
    const selected = sortedRows.filter(r => selectedAwbs.has(`${r.bookingId}-${r.awbIndex}`))
    if (selected.length === 0) return
    // Store selected AWBs in sessionStorage for the pickup order page
    sessionStorage.setItem('pickup_order_awbs', JSON.stringify(selected.map(r => ({
      bookingId: r.bookingId, awbIndex: r.awbIndex, awbNumber: r.awbNumber,
      awb2ndLeg: r.awb2ndLeg, pieces: r.pieces, grossWeight: r.grossWeight, chargeableWeight: r.chargeableWeight,
      clientName: r.clientName, clientId: r.clientId, flightNumber: r.flightNumber,
      pickupFrom: r.pickupFrom, uldType: r.uldType, transportCompany: r.transportCompany,
    }))))
    navigate('/airfreight/pickup-order/new')
  }

  return (
    <Layout title="Transportation" backTo="/airfreight">
      <div className="space-y-4">
        {/* Filters + Today's Pickup Summary */}
        <div className="flex items-start gap-4 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap flex-1">
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
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as any)}
              className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30">
              <option value="all">All Status</option>
              <option value="pending">Pending</option>
              <option value="on_hand">On Hand</option>
            </select>
            <select value={filterUldType} onChange={e => setFilterUldType(e.target.value as any)}
              className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30">
              <option value="">Bup / Lo</option>
              <option value="BUP">Bup</option>
              <option value="LOOSE">Loose</option>
            </select>
            <input
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              placeholder="Search AWB, client, flight..."
              className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30 min-w-[200px]"
            />
            <span className="text-gray-300 mx-0.5">|</span>
            <label className="text-xs text-gray-500">From</label>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              className="border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
            <label className="text-xs text-gray-500">To</label>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              className="border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
          </div>

          {/* Today's Pickup Summary */}
          {(() => {
            const todayStr = new Date().toLocaleDateString('en-CA')
            const todayPending = rows.filter(r => {
              const lfd = (r.lastDayFree || '').slice(0, 10)
              if (lfd !== todayStr) return false
              return r.warehouseStatus !== 'D' && r.warehouseStatus !== 'R'
            })
            const bupCount = todayPending.filter(r => {
              const uld = (r.uldType || '').toUpperCase()
              return uld === 'BUP' || uld === 'B'
            }).length
            const looseCount = todayPending.length - bupCount
            return (
              <div className="bg-white border-2 border-mcl-blue rounded-xl px-5 py-2.5 text-center min-w-[220px] shadow-sm">
                <div className="text-[10px] uppercase tracking-widest text-gray-400 font-semibold mb-0.5">Pickup Today</div>
                <div className="text-3xl font-extrabold text-mcl-blue leading-tight">{todayPending.length}</div>
                <div className="flex justify-center gap-3 mt-1">
                  <span className="text-xs font-bold text-blue-700">BUP {bupCount}</span>
                  <span className="text-xs text-gray-300">|</span>
                  <span className="text-xs font-bold text-amber-600">LOOSE {looseCount}</span>
                </div>
              </div>
            )
          })()}
        </div>

        {/* Selection toolbar */}
        {selectedAwbs.size > 0 && (
          <div className="flex items-center gap-3 bg-blue-50 border border-blue-200 rounded-lg px-4 py-2">
            <span className="text-sm font-medium text-blue-800">{selectedAwbs.size} AWB(s) selected</span>
            <button onClick={handleCreatePickupOrder}
              className="bg-mcl-blue text-white px-4 py-1.5 rounded-lg text-xs font-semibold hover:bg-blue-900 transition-colors">
              Create Pickup Order
            </button>
            <button onClick={deselectAll} className="text-xs text-blue-600 hover:underline">Clear</button>
          </div>
        )}

        {sortedRows.length === 0 ? (
          <div className="text-center py-16 text-gray-400 bg-white rounded-xl border border-gray-100">
            <p className="text-sm">No transportation records found</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm table-fixed">
                <thead>
                  <tr className="bg-gray-50 text-xs font-bold text-gray-500 uppercase tracking-wide border-b border-gray-200">
                    <th className="px-1 py-2 w-[28px]">
                      <input
                        type="checkbox"
                        checked={selectedAwbs.size === sortedRows.length && sortedRows.length > 0}
                        onChange={e => e.target.checked ? selectAllVisible() : deselectAll()}
                        className="w-3.5 h-3.5 rounded border-gray-300 text-mcl-blue focus:ring-mcl-blue/30"
                      />
                    </th>
                    <th className="px-0.5 py-2 w-[24px]"></th>
                    <th className="px-1 py-2 text-center w-[40px]">St</th>
                    <th className="px-1 py-2 text-center w-[38px]">Doc</th>
                    <th className="px-1 py-2 text-left w-[62px]">Flight</th>
                    <th className="px-1 py-2 text-center w-[38px]">Trk</th>
                    <th className="px-1 py-2 text-left w-[82px]">ETA</th>
                    {isMcl && <th className="px-1 py-2 text-left w-[85px]">Client</th>}
                    <th className="px-1 py-2 text-left w-[100px]">AWB#</th>
                    <th className="px-1 py-2 text-left w-[100px]">2nd Leg</th>
                    <th className="px-1 py-2 text-right w-[35px]">PCs</th>
                    <th className="px-1 py-2 text-right w-[52px]">GW</th>
                    <th className="px-1 py-2 text-right w-[48px]">CHW</th>
                    <th className="px-1 py-2 text-left w-[75px]">Pickup</th>
                    <th className="px-1 py-2 text-left w-[68px]">Ready</th>
                    <th className="px-1 py-2 text-left w-[68px]">LFD</th>
                    <th className="px-1 py-2 text-left w-[130px]">Transport Co.</th>
                    <th className="px-1 py-2 text-left w-[85px]">ETD</th>
                    <th className="px-1 py-2 text-center w-[58px]">Prior.</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((row, i) => {
                    const rowKey = `${row.bookingId}-${row.awbIndex}-${i}`
                    const cellBase = `${row.bookingId}-${row.awbIndex}`
                    const isOnHand = row.transportStatus === 'on_hand'
                    const isSelected = selectedAwbs.has(cellBase)

                    const renderInlineCell = (field: string, value: string, displayValue: string, defaultVal?: string, extraClass?: string) => {
                      const isEditing = editingCellKey === `${cellBase}-${field}`
                      const isDate = field === 'ready' || field === 'lastDay'
                      const modified = row.editedFields.includes(field)
                      if (isEditing) {
                        return (
                          <input
                            autoFocus
                            type={isDate ? 'date' : 'text'}
                            value={editingCellVal}
                            onChange={e => setEditingCellVal(e.target.value)}
                            onBlur={() => saveCellEdit(row, field)}
                            onKeyDown={e => { if (e.key === 'Enter') saveCellEdit(row, field); if (e.key === 'Escape') setEditingCellKey(null) }}
                            className={`w-full border border-mcl-blue rounded px-1.5 py-0.5 text-xs focus:outline-none ${extraClass || ''}`}
                          />
                        )
                      }
                      return (
                        <span
                          onClick={() => startCellEdit(row, field, value, defaultVal)}
                          className={`cursor-pointer hover:text-mcl-blue hover:underline transition-colors inline-flex items-center gap-1 ${extraClass || ''}`}
                        >
                          {displayValue || defaultVal || '—'}
                          {modified && <span className="text-orange-500" title="Modified">⚠</span>}
                        </span>
                      )
                    }

                    const ws = row.warehouseStatus
                    const statusBadge = ws === 'R'
                      ? <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-100 text-green-700 text-[10px] font-bold" title="Received (Physical)">R</span>
                      : ws === 'D'
                      ? <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-700 text-[10px] font-bold" title="Documented">D</span>
                      : <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 text-gray-400 text-[10px] font-bold" title="Pending">—</span>

                    return (
                      <tr key={rowKey} className={`hover:bg-blue-50/30 transition-colors border-b border-gray-100 ${isSelected ? 'bg-blue-50/50' : ''}`}>
                        <td className="px-1 py-1.5 text-center">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleAwbSelection(row)}
                            className="w-3.5 h-3.5 rounded border-gray-300 text-mcl-blue focus:ring-mcl-blue/30"
                          />
                        </td>
                        <td className="px-0.5 py-1.5 text-center">
                          {(() => {
                            const awbKey = row.awb2ndLeg || row.awbNumber
                            const alerts = (awbAlertMap.get(awbKey) || []).filter(a => a.status === 'pending')
                            if (alerts.length === 0) return null
                            const isCritical = alerts.some(a => a.alert_type === 'built_change' || a.alert_type === 'dispatched_change')
                            return (
                              <button
                                onClick={e => { e.stopPropagation(); setAlertPopupAwb(awbKey) }}
                                title={isCritical ? 'Alerta critica: guia distribuida/despachada' : 'Alerta: cambios detectados'}
                                className={`${isCritical ? 'text-red-500 hover:text-red-700' : 'text-amber-500 hover:text-amber-700'} transition-colors`}
                              >
                                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                                  <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
                                </svg>
                              </button>
                            )
                          })()}
                        </td>
                        <td className="px-1 py-1.5 text-center">{statusBadge}</td>
                        <td className="px-1 py-1.5 text-center">
                          {row.docsInDrive
                            ? <span className="inline-block px-1 py-0.5 rounded text-[10px] font-bold bg-green-100 text-green-700">YES</span>
                            : <span className="inline-block px-1 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-400">NO</span>
                          }
                        </td>
                        <td className="px-1 py-1.5 font-mono text-xs text-gray-600">
                          {row.flightNumber ? `#${row.flightNumber}` : '—'}
                        </td>
                        {/* Tracking Status Badge */}
                        <td className="px-1 py-1.5 text-center">
                          {row.trackingStatus ? (() => {
                            const trkColors: Record<string, string> = {
                              BKD: 'bg-blue-100 text-blue-600',
                              RCS: 'bg-blue-100 text-blue-600',
                              DEP: 'bg-indigo-100 text-indigo-700',
                              ARR: 'bg-amber-100 text-amber-700',
                              RCF: 'bg-emerald-100 text-emerald-700',
                              NFD: 'bg-emerald-100 text-emerald-700',
                              DLV: 'bg-green-200 text-green-800',
                            }
                            const cls = trkColors[row.trackingStatus] || 'bg-gray-100 text-gray-500'
                            const isDep = row.trackingStatus === 'DEP'
                            return (
                              <div className="relative group">
                                <span
                                  className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-[9px] font-bold cursor-help ${cls} ${isDep ? 'animate-pulse' : ''}`}
                                >
                                  {row.trackingStatus}
                                </span>
                                {/* Tooltip */}
                                <div className="hidden group-hover:block absolute z-50 left-0 top-8 bg-gray-900 text-white text-[10px] rounded-lg px-3 py-2 w-[230px] shadow-xl">
                                  <div className={`font-bold mb-1 ${
                                    row.trackingStatus === 'DEP' ? 'text-indigo-300' :
                                    row.trackingStatus === 'ARR' ? 'text-amber-300' :
                                    ['RCF','NFD'].includes(row.trackingStatus) ? 'text-emerald-300' :
                                    row.trackingStatus === 'DLV' ? 'text-green-300' : 'text-blue-300'
                                  }`}>
                                    {row.trackingStatus === 'BKD' ? 'Booked' :
                                     row.trackingStatus === 'DEP' ? 'In Transit' :
                                     row.trackingStatus === 'ARR' ? 'Arrived at MIA' :
                                     row.trackingStatus === 'RCF' ? 'Received from Flight' :
                                     row.trackingStatus === 'NFD' ? 'Ready for Pickup' :
                                     row.trackingStatus === 'DLV' ? 'Delivered' : row.trackingStatus}
                                  </div>
                                  {row.trackingFlight && <div className="text-white font-semibold mb-1">Flight: {row.trackingFlight}</div>}
                                  {row.trackingLegs.map((leg, li) => (
                                    <div key={li} className={leg.status === row.trackingStatus ? 'text-yellow-200' : ''}>
                                      {leg.station} <span className="text-gray-400">{leg.status}</span> {leg.time}
                                    </div>
                                  ))}
                                  {row.trackingLegs.length === 0 && <div className="text-gray-400">No milestone details</div>}
                                </div>
                              </div>
                            )
                          })() : (
                            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 text-gray-400 text-[9px] font-bold">—</span>
                          )}
                        </td>
                        {/* Tracking ETA */}
                        <td className="px-1 py-1.5 text-xs">
                          {row.trackingEta ? (() => {
                            const etaColors: Record<string, string> = {
                              BKD: 'text-blue-600', RCS: 'text-blue-600',
                              DEP: 'text-indigo-700 font-semibold', ARR: 'text-amber-700 font-semibold',
                              RCF: 'text-emerald-700 font-semibold', NFD: 'text-emerald-700 font-semibold',
                              DLV: 'text-green-800', '': 'text-gray-500',
                            }
                            return <span className={etaColors[row.trackingStatus] || 'text-gray-500'}>{row.trackingEta}</span>
                          })() : <span className="text-gray-400">—</span>}
                        </td>
                        {isMcl && <td className="px-1 py-1.5 text-gray-700 font-medium text-xs truncate">{row.agentName || row.clientName}</td>}
                        <td className="px-1 py-1.5 font-mono text-xs text-gray-800">
                          <span className="flex items-center gap-1">
                            {(() => {
                              const isBup = row.uldType && row.uldType.toUpperCase() !== 'LOOSE'
                              return (
                                <span
                                  className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-[9px] font-bold flex-shrink-0 ${
                                    isBup ? 'bg-mcl-blue text-white' : 'bg-gray-200 text-gray-400'
                                  }`}
                                  title={row.uldType || 'LOOSE'}
                                >
                                  {isBup ? 'B' : 'L'}
                                </span>
                              )
                            })()}
                            {row.awbNumber || '—'}
                          </span>
                        </td>
                        <td className="px-1 py-1.5 font-mono text-xs text-gray-500">{row.awb2ndLeg || '—'}</td>
                        <td className="px-1 py-1.5 text-xs text-gray-600 text-right">{row.pieces || '—'}</td>
                        <td className="px-1 py-1.5 text-xs text-right font-mono">
                          {(() => {
                            const cellKey = `${cellBase}-weight`
                            const isEditingGw = editingCellKey === cellKey
                            if (isEditingGw) {
                              return (
                                <input
                                  autoFocus
                                  type="text"
                                  inputMode="decimal"
                                  value={editingCellVal}
                                  onChange={e => { if (/^\d*\.?\d*$/.test(e.target.value)) setEditingCellVal(e.target.value) }}
                                  onBlur={() => saveCellEdit(row, 'weight')}
                                  onKeyDown={e => { if (e.key === 'Enter') saveCellEdit(row, 'weight'); if (e.key === 'Escape') setEditingCellKey(null) }}
                                  className="w-full border border-mcl-blue rounded px-1.5 py-0.5 text-xs text-right focus:outline-none"
                                />
                              )
                            }
                            return (
                              <span
                                onClick={() => { setEditingCellKey(cellKey); setEditingCellVal(row.grossWeight ? String(row.grossWeight) : '') }}
                                className="cursor-pointer hover:text-mcl-blue hover:underline transition-colors text-gray-600"
                              >
                                {row.grossWeight ? Math.round(row.grossWeight).toLocaleString() : '—'}
                              </span>
                            )
                          })()}
                        </td>
                        <td className="px-1 py-1.5 text-xs text-gray-600 text-right font-mono">{row.chargeableWeight ? Math.round(row.chargeableWeight).toLocaleString() : '—'}</td>
                        <td className="px-1 py-1.5 text-xs text-gray-600">
                          {renderInlineCell('pickupFrom', row.pickupFrom, row.pickupFrom)}
                        </td>
                        <td className="px-1 py-1.5 text-xs text-gray-600">
                          {renderInlineCell('ready', row.readyForPickup, fmtDate(row.readyForPickup))}
                        </td>
                        <td className={`px-1 py-1.5 text-xs text-gray-600 overflow-hidden ${lfdColor(row.lastDayFree, isOnHand)}`}>
                          {renderInlineCell('lastDay', row.lastDayFree, fmtDate(row.lastDayFree))}
                        </td>
                        <td className="px-1 py-1.5 text-xs">
                          {(() => {
                            const vendorNames = vendors.map(v => v.name)
                            const isCustom = row.transportCompany && !vendorNames.includes(row.transportCompany)
                            const selectVal = isCustom ? '__other__' : (row.transportCompany || '')
                            const isEditingCustom = editingCellKey === `${cellBase}-companyCustom`
                            return (
                              <div className="flex flex-col gap-1">
                                <select
                                  value={selectVal}
                                  onChange={async (e) => {
                                    const val = e.target.value
                                    if (val === '__other__') {
                                      setEditingCellKey(`${cellBase}-companyCustom`)
                                      setEditingCellVal('')
                                      return
                                    }
                                    const editedSet = new Set(row.editedFields)
                                    editedSet.add('company')
                                    await updateAwbLine(row, {
                                      transport_company: val || null,
                                      transport_edited_fields: Array.from(editedSet),
                                    } as any)
                                  }}
                                  className="w-full border border-gray-200 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-mcl-blue/30 bg-white"
                                >
                                  <option value="">—</option>
                                  {vendors.map(v => (
                                    <option key={v.id} value={v.name}>{v.name}</option>
                                  ))}
                                  <option value="__other__">Other...</option>
                                </select>
                                {(isCustom || isEditingCustom) && (
                                  <input
                                    autoFocus={isEditingCustom}
                                    value={isEditingCustom ? editingCellVal : row.transportCompany}
                                    onChange={e => setEditingCellVal(e.target.value)}
                                    onBlur={async () => {
                                      setEditingCellKey(null)
                                      const val = editingCellVal.trim()
                                      if (!val) return
                                      const editedSet = new Set(row.editedFields)
                                      editedSet.add('company')
                                      await updateAwbLine(row, {
                                        transport_company: val,
                                        transport_edited_fields: Array.from(editedSet),
                                      } as any)
                                    }}
                                    onKeyDown={e => {
                                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                                      if (e.key === 'Escape') setEditingCellKey(null)
                                    }}
                                    placeholder="Company name"
                                    className="w-full border border-mcl-blue rounded px-1.5 py-0.5 text-xs focus:outline-none"
                                  />
                                )}
                              </div>
                            )
                          })()}
                        </td>
                        <td className="px-1 py-1.5 text-xs font-medium text-gray-700 whitespace-nowrap">{fmtEtd(row.flightDate)}</td>
                        {(() => {
                          const hasReception = ws === 'D' || ws === 'R'
                          if (hasReception) {
                            return <td className="px-1 py-1.5 text-center"><span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-400">—</span></td>
                          }
                          const p = etdPriority(row.flightDate)
                          return (
                            <td className="px-1 py-1.5 text-center">
                              <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold ${p.color}`}>{p.label}</span>
                            </td>
                          )
                        })()}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* ── Sync Alert Popup (AWB level) ── */}
      {alertPopupAwb && (() => {
        const alerts = (awbAlertMap.get(alertPopupAwb) || []).filter(a => a.status === 'pending')
        if (alerts.length === 0) return null
        return <AwbAlertPopup alerts={alerts} onClose={() => setAlertPopupAwb(null)} />
      })()}

      {/* Hidden file input for drawer uploads (multi-file) */}
      <input ref={drawerFileRef} type="file" multiple className="hidden" onChange={handleDrawerFile} />

      {/* ── Doc Drawer (right panel) ── */}
      {drawerBookingIds && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black/30" onClick={() => setDrawerBookingIds(null)} />
          <div className="relative w-full max-w-md bg-white shadow-2xl flex flex-col overflow-hidden animate-slide-in-right">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 bg-gray-50">
              <p className="text-sm font-bold text-gray-800">{drawerTitle || 'Documents'}</p>
              <button onClick={() => setDrawerBookingIds(null)} className="text-gray-400 hover:text-gray-600">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Doc sections */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
              {IMPORT_DOC_TYPES.map(({ key, label }) => {
                const files = getImportDocs(drawerBookingIds, key)
                const isUploading = uploadingSection === key
                return (
                  <div key={key}>
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-xs font-bold text-gray-700 uppercase tracking-wide">{label}</h4>
                      {files.length > 0 && (
                        <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-medium">
                          {files.length} file{files.length !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                    {files.length > 0 && (
                      <div className="space-y-1.5 mb-2">
                        {files.map((f, fi) => (
                          <div key={fi} className="flex items-center gap-2 p-2 bg-gray-50 rounded-lg group">
                            <svg className="w-4 h-4 text-mcl-blue shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                            </svg>
                            <a href={f.url} target="_blank" rel="noopener noreferrer"
                              className="text-xs text-mcl-blue hover:underline truncate flex-1" title={f.filename}>
                              {f.filename}
                            </a>
                            <span className="text-[10px] text-gray-400 shrink-0">{fmtDate(f.uploaded_at)}</span>
                            <button
                              onClick={() => handleDeleteDoc(drawerBookingIds, key, fi)}
                              className="text-red-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                              title="Delete"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <button
                      onClick={() => triggerDrawerUpload(drawerBookingIds, key)}
                      disabled={isUploading}
                      className="w-full border border-dashed border-gray-300 text-gray-500 rounded-lg py-2 text-xs font-medium hover:border-mcl-blue hover:text-mcl-blue transition-colors disabled:opacity-50"
                    >
                      {isUploading ? 'Uploading...' : '+ Upload'}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes slide-in-right {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        .animate-slide-in-right {
          animation: slide-in-right 0.2s ease-out;
        }
      `}</style>
    </Layout>
  )
}

