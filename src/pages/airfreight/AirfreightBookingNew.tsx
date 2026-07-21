import { useState, useEffect, useRef, Fragment, ChangeEvent } from 'react'
import { useNavigate, useSearchParams, Navigate } from 'react-router-dom'
import {
  collection, addDoc, getDocs, getDoc, updateDoc, deleteDoc,
  doc, query, where, limit, orderBy,
} from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import { AirfreightFlight, AirfreightClient, AirfreightDestination, AirfreightBooking, AirfreightHold, AirRateSchedule, AirBillingCharge } from '../../types'
import Layout from '../../components/Layout'
import { fmtNum } from '../../lib/utils'
import { addManualAirCharge, deleteManualAirCharge } from '../../lib/airBilling'
import { awbIndexField, updateAwbIndex } from '../../lib/bookingAwbIndex'
import * as XLSX from 'xlsx'

// ─── Constants ────────────────────────────────────────────────────────────────

const ULD_TYPES = ['LOOSE', 'BUP']

/** Check if an Excel cell value means "yes" (Y, YES, Yes, SI, Si, X, TRUE, 1) */
function isYes(val: string): boolean {
  const v = val.trim().toUpperCase()
  return v === 'Y' || v === 'YES' || v === 'SI' || v === 'X' || v === 'TRUE' || v === '1'
}

const AIRLINES = [
  'American Airlines', 'United Airlines', 'Delta Air Lines', 'LATAM',
  'Avianca', 'Copa Airlines', 'Amerijet', 'Atlas Air', 'Otra',
]

const DEFAULT_AIRPORTS = [
  { code: 'PTY', name: 'Ciudad de Panamá' },
  { code: 'GUA', name: 'Ciudad de Guatemala' },
  { code: 'SAL', name: 'San Salvador' },
  { code: 'SJO', name: 'San José, Costa Rica' },
  { code: 'MGA', name: 'Managua' },
  { code: 'TGU', name: 'Tegucigalpa' },
  { code: 'BZE', name: 'Belice' },
  { code: 'SDQ', name: 'Santo Domingo' },
  { code: 'SJU', name: 'San Juan, Puerto Rico' },
  { code: 'HAV', name: 'La Habana' },
  { code: 'POS', name: 'Port of Spain' },
  { code: 'CUR', name: 'Curazao' },
  { code: 'MBJ', name: 'Montego Bay' },
  { code: 'BOG', name: 'Bogotá' },
  { code: 'MDE', name: 'Medellín' },
  { code: 'CLO', name: 'Cali' },
  { code: 'CTG', name: 'Cartagena' },
  { code: 'BAQ', name: 'Barranquilla' },
  { code: 'CCS', name: 'Caracas' },
  { code: 'MAR', name: 'Maracaibo' },
  { code: 'UIO', name: 'Quito' },
  { code: 'GYE', name: 'Guayaquil' },
  { code: 'LIM', name: 'Lima' },
  { code: 'VVI', name: 'Santa Cruz de la Sierra' },
  { code: 'LPB', name: 'La Paz' },
  { code: 'SCL', name: 'Santiago' },
  { code: 'ANF', name: 'Antofagasta' },
  { code: 'EZE', name: 'Buenos Aires (Ezeiza)' },
  { code: 'AEP', name: 'Buenos Aires (Aeroparque)' },
  { code: 'COR', name: 'Córdoba' },
  { code: 'MDZ', name: 'Mendoza' },
  { code: 'MVD', name: 'Montevideo' },
  { code: 'ASU', name: 'Asunción' },
  { code: 'GRU', name: 'São Paulo (Guarulhos)' },
  { code: 'GIG', name: 'Río de Janeiro' },
  { code: 'BSB', name: 'Brasilia' },
  { code: 'FOR', name: 'Fortaleza' },
  { code: 'REC', name: 'Recife' },
  { code: 'SSA', name: 'Salvador de Bahía' },
]

// ─── Types ────────────────────────────────────────────────────────────────────

interface MawbGroup {
  key: string
  mawbNumber: string
  firestoreId?: string  // Firestore booking ID when loaded from DB
}

interface BookingRow {
  _id: number
  lineNumber: string
  clientId: string
  clientName: string
  isMawbClient: boolean
  destination: string
  awb1: string
  awb2: string
  mawbGroupKey: string    // '' = unassigned, or key from MawbGroup
  slacs: string
  uldType: string
  uldAirline: string
  locBond: string
  labelColor: boolean
  pieces: string
  weight: string
  chargeableWeight: string
  pickupFrom: string
  pickupDate: string
  lastDayFree: string
  battery: boolean
  ddgg: boolean
  hold: boolean | 'pending'
  split: boolean
  splitFrom?: string        // awb_number of original line (for split-created lines)
  onHand: boolean
  docCount: number          // populated from existing booking docs
  isRefLine: boolean        // reference-only line (e.g. Merflex trackings)
  trackingRefs: string      // newline-separated tracking numbers
  // Edit mode tracking
  firestoreId?: string      // Firestore doc ID for simple bookings
  firestoreGroupId?: string // Firestore doc ID for the MAWB booking this row belongs to
  _migratedDocs?: Record<string, any>       // documents migrated from MAWB awb_line on ungroup
  _migratedScreening?: Record<string, any>  // screening data migrated from MAWB awb_line on ungroup
  _migratedTransport?: Record<string, any>  // transport data migrated from MAWB awb_line on ungroup
}

function fmtAwb(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 11)
  if (digits.length <= 3) return digits
  return `${digits.slice(0, 3)}-${digits.slice(3)}`
}

function newRow(id: number, defaultDest = '', defaultClient?: AirfreightClient & { id: string }): BookingRow {
  return {
    _id: id,
    lineNumber: '',
    clientId: defaultClient?.id || '',
    clientName: defaultClient?.name || '',
    isMawbClient: defaultClient?.booking_type === 'mawb',
    destination: defaultDest,
    awb1: '', awb2: '', mawbGroupKey: '', slacs: '',
    uldType: '', uldAirline: '', locBond: '', labelColor: false,
    pieces: '', weight: '', chargeableWeight: '',
    pickupFrom: '', pickupDate: '', lastDayFree: '',
    battery: false, ddgg: false,
    hold: false, split: false, onHand: false, docCount: 0,
    isRefLine: false, trackingRefs: '',
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AirfreightBookingNew() {
  const { user, loading: authLoading, isAdmin, isSuperAgent, isAgent, isCounter, isClient, clientId, hasAirAccess, isEcommerceClient: isEcommerceUser, canEdit } = useAuth()
  const navigate = useNavigate()

  // Ecommerce clients manage their AWBs from the Booking List screen — block this page
  if (isEcommerceUser) {
    return <Navigate to="/airfreight/booking-list" replace />
  }
  const [searchParams] = useSearchParams()
  const preselectedFlightId = searchParams.get('flight') || ''

  // Meta
  const [flights, setFlights] = useState<(AirfreightFlight & { id: string })[]>([])
  const [clients, setClients] = useState<(AirfreightClient & { id: string })[]>([])
  const [firestoreDestinations, setFirestoreDestinations] = useState<AirfreightDestination[]>([])
  const [loadingMeta, setLoadingMeta] = useState(true)

  // Edit mode — true when opening with an existing flight that has bookings
  const [editMode, setEditMode] = useState(false)
  // Original Firestore IDs loaded at init (to detect deletions)
  const originalSimpleIds = useRef(new Set<string>())
  const originalGroupIds = useRef(new Set<string>())

  // Flight
  const [flightId, setFlightId] = useState(preselectedFlightId)
  const [showNewFlight, setShowNewFlight] = useState(false)
  const [newAirline, setNewAirline] = useState('')
  const [newAirlineOther, setNewAirlineOther] = useState('')
  const [newFlightNumber, setNewFlightNumber] = useState('')
  const [newFlightEtd, setNewFlightEtd] = useState('')
  const [newFlightCutoff, setNewFlightCutoff] = useState('')
  const [newFlightDests, setNewFlightDests] = useState<string[]>([])
  const [destSearch, setDestSearch] = useState('')
  const [destDropdownOpen, setDestDropdownOpen] = useState(false)
  const [creatingFlight, setCreatingFlight] = useState(false)
  const destDropdownRef = useRef<HTMLDivElement>(null)

  // Inline edit of current flight ETD / CutOff
  const [editFlightEtd, setEditFlightEtd] = useState('')
  const [editFlightCutoff, setEditFlightCutoff] = useState('')
  const [editFlightNumber, setEditFlightNumber] = useState('')
  const [editFlightDests, setEditFlightDests] = useState('')
  const [showEditFlight, setShowEditFlight] = useState(false)
  const [savingFlightEdit, setSavingFlightEdit] = useState(false)

  // Modify flight + reassign
  const [showModifyFlight, setShowModifyFlight] = useState(false)
  const [showMoveToExisting, setShowMoveToExisting] = useState(false)
  const [modifyAirline, setModifyAirline] = useState('')
  const [modifyAirlineOther, setModifyAirlineOther] = useState('')
  const [modifyFlightNumber, setModifyFlightNumber] = useState('')
  const [modifyEtd, setModifyEtd] = useState('')
  const [modifyCutoff, setModifyCutoff] = useState('')
  const [modifyingFlight, setModifyingFlight] = useState(false)
  const [reassignMode, setReassignMode] = useState(false)
  const [reassignFlightId, setReassignFlightId] = useState('')
  const [reassignSelectedIds, setReassignSelectedIds] = useState<Set<string>>(new Set())

  // Global client (for MCL staff — applied to all rows)
  const [globalClientId, setGlobalClientId] = useState('')
  const [agentName, setAgentName] = useState('')

  // Rows
  const [rows, setRows] = useState<BookingRow[]>([])
  const counter = useRef(0)

  // MAWB groups
  const [mawbGroups, setMawbGroups] = useState<MawbGroup[]>([])
  const [selectedRowIds, setSelectedRowIds] = useState<Set<number>>(new Set())
  const [assignMawbInput, setAssignMawbInput] = useState('')
  const [assignTargetKey, setAssignTargetKey] = useState<string>('__new__')

  // Excel upload
  const excelInputRef = useRef<HTMLInputElement>(null)
  const [uploadingExcel, setUploadingExcel] = useState(false)

  // Save
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Ref-line (tracking numbers) panel
  const [refPanelRowId, setRefPanelRowId] = useState<number | null>(null)
  const [refPanelText, setRefPanelText] = useState('')

  // Booking lock — locked by default in edit mode
  const [bookingLocked, setBookingLocked] = useState(true)

  // Services modal
  const [showServicesModal, setShowServicesModal] = useState(false)
  const [svcRateSchedules, setSvcRateSchedules] = useState<AirRateSchedule[]>([])
  const [svcClientData, setSvcClientData] = useState<AirfreightClient | null>(null)
  const [svcCharges, setSvcCharges] = useState<AirBillingCharge[]>([])
  const [svcScope, setSvcScope] = useState<'flight' | 'awb'>('awb')
  const [svcAwbKey, setSvcAwbKey] = useState('')       // "bookingId__awbIndex" or "bookingId"
  const [svcServiceName, setSvcServiceName] = useState('')
  const [svcQty, setSvcQty] = useState('1')
  const [svcSaving, setSvcSaving] = useState(false)
  const [svcLoading, setSvcLoading] = useState(false)

  const canCreate = isAdmin || isSuperAgent || isAgent || isCounter || isClient
  const canCreateFlight = true
  const selectedFlight = flights.find(f => f.id === flightId)
  const flightDestinations = selectedFlight?.destinations || []
  const isFlightDispatched = selectedFlight?.flight_status === 'dispatched' || (!selectedFlight?.flight_status && !!selectedFlight?.dispatched_at)
  const canOpenBooking = !isFlightDispatched || canEdit

  const activeClient = isClient
    ? clients.find(c => c.id === clientId)
    : clients.find(c => c.id === globalClientId)
  const isMawbClient = activeClient?.booking_type === 'mawb'
  const isEcommerceClient = activeClient?.booking_type === 'ecommerce'

  const allAirports = (() => {
    const map = new Map<string, { code: string; name: string }>()
    DEFAULT_AIRPORTS.forEach(a => map.set(a.code, a))
    firestoreDestinations.forEach(d => map.set(d.code, { code: d.code, name: d.name }))
    return Array.from(map.values()).sort((a, b) => a.code.localeCompare(b.code))
  })()

  const filteredAirports = destSearch.trim()
    ? allAirports.filter(a =>
        a.code.includes(destSearch.toUpperCase()) ||
        a.name.toLowerCase().includes(destSearch.toLowerCase())
      )
    : allAirports

  useEffect(() => {
    // Wait for auth to resolve so isClient/clientId are correct
    if (authLoading) return
    if (!canCreate || !hasAirAccess) { navigate('/airfreight', { replace: true }); return }
    Promise.all([
      getDocs(query(collection(db, 'airfreight_flights'), orderBy('flight_datetime', 'desc'), limit(500))),
      getDocs(query(collection(db, 'airfreight_clients'), limit(500))),
      getDocs(query(collection(db, 'airfreight_destinations'), limit(200))),
      // If pre-selected flight, load its bookings (clients can only read their own)
      preselectedFlightId
        ? getDocs(query(collection(db, 'airfreight_bookings'),
            where('flight_id', '==', preselectedFlightId),
            ...(isClient && clientId ? [where('client_id', '==', clientId)] : []),
          ))
        : Promise.resolve(null),
      // For clients: load their bookings to know which flights they participate in
      isClient && clientId
        ? getDocs(query(collection(db, 'airfreight_bookings'), where('client_id', '==', clientId)))
        : Promise.resolve(null),
    ]).then(([fSnap, cSnap, dSnap, bSnap, clientBookingsSnap]) => {
      // For clients, build set of flight IDs where they have bookings
      const clientFlightIds = new Set<string>()
      if (clientBookingsSnap) {
        for (const d of clientBookingsSnap.docs) {
          clientFlightIds.add((d.data() as AirfreightBooking).flight_id)
        }
      }
      const flightList = fSnap.docs
        .map(d => ({ ...d.data() as AirfreightFlight, id: d.id }))
        .filter(f => f.status === 'open' || f.id === preselectedFlightId)
        // Clients only see flights where they have bookings
        .filter(f => !isClient || clientFlightIds.has(f.id) || f.id === preselectedFlightId)
        .sort((a, b) => (b.flight_datetime || '').localeCompare(a.flight_datetime || ''))
      const clientList = cSnap.docs
        .map(d => ({ ...d.data() as AirfreightClient, id: d.id }))
        .filter(c => c.active !== false)
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      setFlights(flightList)
      setClients(clientList)
      setFirestoreDestinations(dSnap.docs.map(d => ({ ...d.data() as AirfreightDestination, id: d.id })))

      const ownClient = isClient && clientId ? clientList.find(c => c.id === clientId) : undefined
      if (ownClient) setGlobalClientId(ownClient.id)

      // Load existing bookings into table (edit mode)
      if (preselectedFlightId && bSnap && bSnap.docs.length > 0) {
        setEditMode(true)
        const loadedRows: BookingRow[] = []
        const loadedGroups: MawbGroup[] = []

        // Detect client from first booking (all should be same client)
        const firstBooking = bSnap.docs[0].data() as AirfreightBooking
        const detectedClientId = firstBooking.client_id
        if (!isClient) setGlobalClientId(detectedClientId)
        if (firstBooking.agent_name) setAgentName(firstBooking.agent_name)

        // First pass: collect AWB numbers already covered by MAWB bookings.
        // Simple bookings whose AWB matches are orphans from a previous buggy save.
        // Also dedup MAWB groups — if the same mawb_number appears multiple times,
        // keep only the first and mark the rest for deletion.
        const mawbCoveredAwbs = new Set<string>()
        const seenMawbNumbers = new Map<string, string>() // mawb_number → first doc ID
        const duplicateMawbIds = new Set<string>()
        for (const bDoc of bSnap.docs) {
          const b = bDoc.data() as AirfreightBooking
          if (b.booking_type === 'mawb' || b.booking_type === 'ecommerce') {
            const mNum = (b.mawb_number || '').trim()
            if (mNum && seenMawbNumbers.has(mNum)) {
              // Duplicate MAWB — mark for deletion, skip its AWBs
              duplicateMawbIds.add(bDoc.id)
              continue
            }
            if (mNum) seenMawbNumbers.set(mNum, bDoc.id)
            for (const line of (b.awb_lines || [])) {
              if (line.awb_number) mawbCoveredAwbs.add(line.awb_number.trim())
            }
          }
        }

        // Queue duplicate MAWB docs for deletion on next save
        for (const dupId of duplicateMawbIds) {
          originalGroupIds.current.add(dupId)
        }

        for (const bDoc of bSnap.docs) {
          // Skip duplicate MAWB bookings
          if (duplicateMawbIds.has(bDoc.id)) continue
          const b = bDoc.data() as AirfreightBooking
          if (b.booking_type === 'mawb' || b.booking_type === 'ecommerce') {
            const prefix = b.booking_type === 'ecommerce' ? 'ecom_loaded' : 'mawb_loaded'
            const groupKey = `${prefix}_${bDoc.id}`
            loadedGroups.push({ key: groupKey, mawbNumber: b.mawb_number || '', firestoreId: bDoc.id })
            originalGroupIds.current.add(bDoc.id)

            const allLines = b.awb_lines || []

            // Pre-compute split totals per original AWB
            const splitTotals = new Map<string, { pcs: number; slacs: number; kg: number }>()
            for (const line of allLines) {
              if (!line.split_from) continue
              const scans = (line as any).scans || []
              const prev = splitTotals.get(line.split_from) || { pcs: 0, slacs: 0, kg: 0 }
              prev.pcs += scans.length
              prev.slacs += scans.reduce((s: number, sc: any) => s + (sc.pieces || 0), 0)
              prev.kg += scans.reduce((s: number, sc: any) => s + (sc.weight || 0), 0)
              splitTotals.set(line.split_from, prev)
            }

            for (const awbLine of allLines) {
              counter.current += 1
              const isSplit = !!awbLine.split_from
              const scans = (awbLine as any).scans || []

              let rowPieces: string, rowSlacs: string, rowWeight: string, rowChw: string

              if (isSplit) {
                // Split line: values from scans if available, otherwise from saved fields
                if (scans.length > 0) {
                  rowPieces = scans.length.toString()
                  rowSlacs = scans.reduce((s: number, sc: any) => s + (sc.pieces || 0), 0).toString()
                  const w = scans.reduce((s: number, sc: any) => s + (sc.weight || 0), 0)
                  rowWeight = w ? Math.round(w).toString() : ''
                  rowChw = rowWeight
                } else {
                  rowPieces = awbLine.pieces?.toString() || ''
                  rowSlacs = awbLine.slacs?.toString() || ''
                  rowWeight = awbLine.weight ? Math.round(awbLine.weight).toString() : ''
                  rowChw = awbLine.chargeable_weight ? Math.round(awbLine.chargeable_weight).toString() : ''
                }
              } else {
                // Original line: subtract split totals
                const sub = splitTotals.get(awbLine.awb_number) || { pcs: 0, slacs: 0, kg: 0 }
                const origPcs = (awbLine.pieces || 0) - sub.pcs
                const origSlacs = (awbLine.slacs || 0) - sub.slacs
                const origKg = (awbLine.weight || 0) - sub.kg
                const origChw = (awbLine.chargeable_weight || 0) - sub.kg
                rowPieces = origPcs > 0 ? origPcs.toString() : (awbLine.pieces?.toString() || '')
                rowSlacs = origSlacs > 0 ? origSlacs.toString() : (awbLine.slacs?.toString() || '')
                rowWeight = origKg > 0 ? Math.round(origKg).toString() : (awbLine.weight ? Math.round(awbLine.weight).toString() : '')
                rowChw = origChw > 0 ? Math.round(origChw).toString() : (awbLine.chargeable_weight ? Math.round(awbLine.chargeable_weight).toString() : '')
              }

              loadedRows.push({
                _id: counter.current,
                lineNumber: awbLine.line_number || '',
                clientId: b.client_id,
                clientName: b.client_name,
                isMawbClient: true,
                destination: b.destination_id || '',
                awb1: awbLine.awb_number || '',
                awb2: awbLine.awb_2nd_leg || '',
                mawbGroupKey: groupKey,
                slacs: rowSlacs,
                uldType: awbLine.uld_type || '',
                uldAirline: awbLine.uld_airline || '',
                locBond: awbLine.loc_bond || '',
                labelColor: awbLine.label_color || false,
                pieces: rowPieces,
                weight: rowWeight,
                chargeableWeight: rowChw,
                pickupFrom: awbLine.pickup_from || '',
                pickupDate: awbLine.ready_for_pickup || '',
                lastDayFree: awbLine.last_day_free || '',
                battery: awbLine.battery || false,
                ddgg: awbLine.ddgg || false,
                hold: awbLine.hold === 'pending' ? 'pending' as const : awbLine.hold || false,
                split: awbLine.split || false,
                splitFrom: awbLine.split_from || undefined,
                onHand: (awbLine as any).on_hand || false,
                docCount: Object.values(awbLine.documents || {}).filter(Boolean).length,
                isRefLine: awbLine.is_ref_line || (Array.isArray(awbLine.tracking_refs) && awbLine.tracking_refs.length > 0),
                trackingRefs: (awbLine.tracking_refs || []).join('\n'),
                firestoreGroupId: bDoc.id,
              })
            }
          } else {
            // Skip simple bookings whose AWB is already inside a MAWB group —
            // they are orphans from a previous save. Add to originalSimpleIds so
            // they get deleted automatically on the next save.
            if (b.awb_1st_leg && mawbCoveredAwbs.has(b.awb_1st_leg.trim())) {
              originalSimpleIds.current.add(bDoc.id)
              continue
            }
            counter.current += 1
            originalSimpleIds.current.add(bDoc.id)
            loadedRows.push({
              _id: counter.current,
              lineNumber: (b as any).line_number || '',
              clientId: b.client_id,
              clientName: b.client_name,
              isMawbClient: false,
              destination: b.destination_id || '',
              awb1: b.awb_1st_leg || '',
              awb2: b.awb_2nd_leg || '',
              mawbGroupKey: '',
              slacs: (b as any).slacs?.toString() || '',
              uldType: b.uld_type || '',
              uldAirline: '',
              locBond: '',
              labelColor: false,
              pieces: b.pieces?.toString() || '',
              weight: b.weight?.toString() || '',
              chargeableWeight: b.chargeable_weight?.toString() || '',
              pickupFrom: b.pickup_from || '',
              pickupDate: b.ready_for_pickup || '',
              lastDayFree: b.last_day_free || '',
              battery: b.battery || false,
              ddgg: b.ddgg || false,
              hold: b.hold === 'pending' ? 'pending' as const : b.hold || false,
              split: b.split || false,
              splitFrom: undefined,
              onHand: b.on_hand || false,
              docCount: Object.values(b.documents || {}).filter(Boolean).length,
              isRefLine: (b as any).is_ref_line || (Array.isArray((b as any).tracking_refs) && (b as any).tracking_refs.length > 0),
              trackingRefs: ((b as any).tracking_refs || []).join('\n'),
              firestoreId: bDoc.id,
            })
          }
        }

        setMawbGroups(loadedGroups)
        setRows(loadedRows)
      } else {
        // New booking mode
        const initialFlight = preselectedFlightId ? fSnap.docs.find(d => d.id === preselectedFlightId) : undefined
        const initialDest = initialFlight ? ((initialFlight.data() as AirfreightFlight).destinations?.[0] || '') : ''
        counter.current = 1
        setRows([newRow(1, initialDest, ownClient)])
      }

      setLoadingMeta(false)
    }).catch(err => { console.error('Load error:', err); setLoadingMeta(false) })
  }, [authLoading, isClient, clientId])

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (destDropdownRef.current && !destDropdownRef.current.contains(e.target as Node))
        setDestDropdownOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  function handleFlightChange(fid: string) {
    setFlightId(fid)
    const dest = flights.find(f => f.id === fid)?.destinations?.[0] || ''
    setRows(prev => prev.map(r => ({ ...r, destination: dest })))
    setShowNewFlight(false)
  }

  function handleGlobalClientChange(cId: string) {
    setGlobalClientId(cId)
    const c = clients.find(cl => cl.id === cId)
    const isMawb = c?.booking_type === 'mawb'
    setRows(prev => prev.map(r => ({
      ...r,
      clientId: cId,
      clientName: c?.name || '',
      isMawbClient: isMawb,
      mawbGroupKey: '',
    })))
    setMawbGroups([])
    setSelectedRowIds(new Set())
  }

  // ── New flight ────────────────────────────────────────────────────────────

  function toggleNewFlightDest(code: string) {
    setNewFlightDests(prev => prev.includes(code) ? prev.filter(d => d !== code) : [...prev, code])
  }

  function addCustomDest() {
    const code = destSearch.trim().toUpperCase()
    if (code && !newFlightDests.includes(code)) setNewFlightDests(prev => [...prev, code])
    setDestSearch('')
    setDestDropdownOpen(false)
  }

  // ── Excel upload ─────────────────────────────────────────────────────────
  async function handleExcelUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    // Reset input so same file can be re-selected
    e.target.value = ''

    setUploadingExcel(true)
    setError('')
    try {
      const data = await file.arrayBuffer()
      const wb = XLSX.read(data, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const rawRows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

      // ── Parse header ──
      let flightNumber = ''
      let mawbNumber = ''
      let etdRaw = ''
      let airlineName = ''
      let cutoffRaw = ''
      let destination = ''

      for (let i = 0; i < Math.min(rawRows.length, 15); i++) {
        const row = rawRows[i]
        for (let j = 0; j < row.length - 1; j++) {
          const cell = String(row[j] ?? '').trim().toLowerCase()
          const val = String(row[j + 1] ?? '').trim()
          if (!val) continue
          if (cell.includes('numero de vuelo') || cell === 'numero de vuelo') flightNumber = val
          else if (cell === 'mawb') mawbNumber = val
          else if (cell === 'etd') etdRaw = val
          else if (cell === 'aerolinea') airlineName = val
          else if (cell.includes('cutoff')) cutoffRaw = val
          else if (cell === 'destino') destination = val.toUpperCase()
        }
      }

      // Try to extract destination from column header if not in summary
      if (!destination) {
        for (let i = 0; i < Math.min(rawRows.length, 15); i++) {
          const row = rawRows[i]
          for (let j = 0; j < row.length; j++) {
            const cell = String(row[j] ?? '')
            const match = cell.match(/HAWB.*\((\w{3})\)/i)
            if (match) { destination = match[1].toUpperCase(); break }
          }
          if (destination) break
        }
      }

      if (!airlineName) { setError('No se encontró la aerolínea en el archivo'); return }

      // ── Parse ETD / CutOff dates ──
      function parseExcelDate(raw: string): string {
        if (!raw || !String(raw).trim()) return ''
        const s = String(raw).trim()

        // Already ISO-ish
        if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s

        const months: Record<string, string> = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06', jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' }

        // Extract time from anywhere in the string: "HH:MM" pattern
        const timeMatch = s.match(/(\d{1,2}):(\d{2})/)
        const timePart = timeMatch ? `T${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}:00` : ''

        // Strategy 1: Month name present (Apr 06 / 2026, Apr 6 2026, 06-Apr-2026, etc.)
        const monthName = s.match(/([A-Za-z]{3,9})/)?.[1]?.slice(0, 3).toLowerCase()
        if (monthName && months[monthName]) {
          const mm = months[monthName]
          // Find day and year numbers (exclude the time numbers)
          const withoutTime = s.replace(/\d{1,2}:\d{2}/, '')
          const nums = withoutTime.match(/\d+/g)?.map(Number) || []
          let dd = 0, yyyy = 0
          for (const n of nums) {
            if (n >= 2000) yyyy = n
            else if (n >= 25 && n <= 99) yyyy = 2000 + n
            else if (n >= 1 && n <= 31 && !dd) dd = n
          }
          if (dd && yyyy) {
            return `${yyyy}-${mm}-${String(dd).padStart(2, '0')}${timePart}`
          }
        }

        // Strategy 2: Numeric date MM/DD/YY(YY) or MM-DD-YY(YY)
        const numDate = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/)
        if (numDate) {
          const yyyy = numDate[3].length === 2 ? `20${numDate[3]}` : numDate[3]
          return `${yyyy}-${numDate[1].padStart(2, '0')}-${numDate[2].padStart(2, '0')}${timePart}`
        }

        return ''
      }

      const etdDatetime = parseExcelDate(etdRaw)
      const cutoffDatetime = cutoffRaw ? parseExcelDate(cutoffRaw) : null
      if (!etdDatetime) { setError(`No se pudo interpretar la fecha ETD: "${etdRaw}"`); return }

      // ── Find header row and detect column indices dynamically ──
      let headerRowIdx = -1
      let colNum = -1, colLB = -1, colAwb1 = -1, colAwb2 = -1, colUld = -1
      let colUldAir = -1, colPcs = -1, colSlacs = -1, colWt = -1, colChw = -1
      let colLith = -1, colDdgg = -1, colLabel = -1

      for (let i = 0; i < rawRows.length; i++) {
        const row = rawRows[i]
        for (let j = 0; j < row.length; j++) {
          const cell = String(row[j] ?? '').trim()
          if (cell === '#') {
            headerRowIdx = i
            // Map each column by its header name
            for (let k = 0; k < row.length; k++) {
              const h = String(row[k] ?? '').trim().toLowerCase()
              if (h === '#') colNum = k
              else if (h.includes('local') || h.includes('bonded')) colLB = k
              else if (h.includes('1st') || (h.includes('awb') && h.includes('origen'))) colAwb1 = k
              else if (h.includes('2nd') || h.includes('hawb') || (h.includes('destination') && !h.includes('uld'))) colAwb2 = k
              else if ((h.includes('uld') || h.includes('loose')) && !h.includes('aerolinea') && !h.includes('airline') && !h.includes('pick')) colUld = k
              else if ((h.includes('aerolinea') || h.includes('airline')) && (h.includes('pick') || h.includes('uld'))) colUldAir = k
              else if (h.includes('box') || h === 'pcs' || h === 'pieces') colPcs = k
              else if (h.includes('slac')) colSlacs = k
              else if (h.includes('weight') || h === 'peso') colWt = k
              else if (h.includes('chw') || h.includes('chargeable')) colChw = k
              else if (h.includes('lithium') || h.includes('batteri')) colLith = k
              else if (h.includes('ddgg') || h.includes('dangerous')) colDdgg = k
              else if (h.includes('label')) colLabel = k
            }
            break
          }
        }
        if (headerRowIdx >= 0) break
      }

      if (headerRowIdx < 0) { setError('No se encontró la fila de encabezado (#, Local/Bonded, AWB...)'); return }

      const dataRows = rawRows.slice(headerRowIdx + 1).filter(r => {
        const cellNum = colNum >= 0 ? String(r[colNum] ?? '').trim() : String(r[0] ?? '').trim()
        return cellNum && cellNum.toLowerCase() !== 'total'
      })
      const cleanRows = dataRows.filter(r => {
        const anyVal = r.some((c: any, idx: number) => idx > 0 && String(c ?? '').trim() !== '')
        return anyVal
      })

      if (cleanRows.length === 0) { setError('No se encontraron filas de datos en el archivo'); return }

      // ── Match or create flight ──
      let matchedFlight = flights.find(f =>
        f.flight_number === flightNumber &&
        f.flight_datetime.startsWith(etdDatetime.slice(0, 16))
      )

      if (!matchedFlight) {
        // Create new flight
        const flightData: any = {
          airline: airlineName,
          flight_number: flightNumber || null,
          flight_datetime: etdDatetime,
          cutoff_datetime: cutoffDatetime,
          destinations: destination ? [destination] : [],
          status: 'open',
          created_by: user?.email || user?.uid || '',
          created_at: new Date().toISOString(),
        }
        const docRef = await addDoc(collection(db, 'airfreight_flights'), flightData)
        matchedFlight = { ...flightData, id: docRef.id } as AirfreightFlight & { id: string }
        setFlights(prev => [matchedFlight!, ...prev])
      } else {
        // Add destination if not present
        if (destination && !matchedFlight.destinations?.includes(destination)) {
          const newDests = [...(matchedFlight.destinations || []), destination]
          await updateDoc(doc(db, 'airfreight_flights', matchedFlight.id), { destinations: newDests })
          matchedFlight = { ...matchedFlight, destinations: newDests }
          setFlights(prev => prev.map(f => f.id === matchedFlight!.id ? matchedFlight! : f))
        }
      }

      setFlightId(matchedFlight.id)

      // ── Ensure client is set ──
      if (!activeClient) {
        setError('Selecciona un cliente antes de subir el Excel')
        return
      }

      // ── Parse lines into BookingRows ──
      const newRows: BookingRow[] = []
      let lastParentAwb = ''

      const col = (r: any[], idx: number) => idx >= 0 ? String(r[idx] ?? '').trim() : ''

      for (const r of cleanRows) {
        const lineNum = col(r, colNum)
        const locBond = col(r, colLB).toUpperCase()
        const awb1 = col(r, colAwb1)
        const awb2 = col(r, colAwb2)
        const uldType = col(r, colUld)
        const uldAirline = col(r, colUldAir)
        const pieces = col(r, colPcs)
        const slacs = col(r, colSlacs)
        const weight = col(r, colWt)
        const chw = col(r, colChw)
        const lithium = col(r, colLith).toUpperCase()
        const ddgg = col(r, colDdgg).toUpperCase()
        const labelColor = col(r, colLabel).toUpperCase()

        // Detect split: line number has "-2", "-3" suffix OR awb1 is empty and previous had one
        const isSplitLine = /^.+-\d+$/.test(lineNum) || (!awb1 && !!lastParentAwb)

        counter.current += 1
        const row: BookingRow = {
          _id: counter.current,
          lineNumber: lineNum,
          clientId: activeClient.id || '',
          clientName: activeClient.name || '',
          isMawbClient: true,
          destination: destination || matchedFlight.destinations?.[0] || '',
          awb1: isSplitLine ? '' : awb1,
          awb2: awb2,
          mawbGroupKey: '', // assigned below
          slacs,
          uldType: isSplitLine ? '' : uldType,
          uldAirline: isSplitLine ? '' : uldAirline,
          locBond: (locBond === 'L' || locBond === 'B') ? locBond : '',
          labelColor: isYes(labelColor),
          pieces,
          weight,
          chargeableWeight: chw,
          pickupFrom: '',
          pickupDate: '',
          lastDayFree: '',
          battery: isYes(lithium),
          ddgg: isYes(ddgg),
          hold: false,
          split: false,
          splitFrom: isSplitLine ? lastParentAwb : undefined,
          onHand: false,
          docCount: 0,
          isRefLine: false,
          trackingRefs: '',
        }

        if (!isSplitLine && awb1) {
          lastParentAwb = awb1
        }

        // Mark parent as split if next line is a split of it
        if (isSplitLine && lastParentAwb) {
          const parentIdx = newRows.findIndex(nr => nr.awb1 === lastParentAwb && !nr.splitFrom)
          if (parentIdx >= 0) newRows[parentIdx].split = true
        }

        newRows.push(row)
      }

      // ── Create MAWB group ──
      const groupKey = `mawb_${Date.now()}`
      const assignedRows = newRows.map(r => ({ ...r, mawbGroupKey: groupKey }))

      // ── Merge with existing rows ──
      setRows(prev => {
        // Remove placeholder empty rows (only if they have no data)
        const existing = prev.filter(r => r.awb1 || r.awb2 || r.splitFrom)
        return [...existing, ...assignedRows]
      })

      setMawbGroups(prev => [...prev, { key: groupKey, mawbNumber }])
      setSelectedRowIds(new Set())

    } catch (err: any) {
      console.error('Excel upload error:', err)
      setError(`Error al procesar el archivo Excel: ${err?.message || err}`)
    } finally {
      setUploadingExcel(false)
    }
  }

  async function handleEcommerceExcelUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''

    if (!activeClient) {
      setError('Select a client before uploading the Excel')
      return
    }

    setUploadingExcel(true)
    setError('')
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
            if (key in tempMap) continue  // first match wins — don't overwrite
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

      if (headerRowIdx < 0) { setError('Could not find header row in the Excel file'); return }

      // ── Parse date helper for mixed formats ──
      function parseEcomDate(raw: any): string {
        if (raw === null || raw === undefined || raw === '') return ''
        // Excel serial number (date or datetime)
        if (typeof raw === 'number') {
          const d = new Date((raw - 25569) * 86400000)
          if (raw % 1 !== 0) {
            const hh = String(d.getUTCHours()).padStart(2, '0')
            const mm = String(d.getUTCMinutes()).padStart(2, '0')
            return `${d.toISOString().slice(0, 10)}T${hh}:${mm}:00`
          }
          return d.toISOString().slice(0, 10)
        }
        // Normalize: collapse all whitespace/newlines into single space
        const s = String(raw).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
        if (!s || /^[a-z]/i.test(s)) return s  // "Pending", text — return as-is

        // Helper: parse a time token into "HH:MM"
        // Handles: "20:00", "1:00 PM", "1 PM", "4-5pm" (takes last number of range), "5:00"
        function parseTime(t: string): string {
          const tk = t.trim().toLowerCase()
          const isAm = /am/i.test(tk)
          const isPm = /pm/i.test(tk)
          // Range like "4-5pm" or "4-5am" → take last number
          const rangeMatch = tk.match(/(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
          if (rangeMatch) {
            let hr = parseInt(rangeMatch[3])
            const min = rangeMatch[4] || '00'
            const ampm = rangeMatch[5]?.toLowerCase()
            if (ampm === 'pm' && hr < 12) hr += 12
            if (ampm === 'am' && hr === 12) hr = 0
            return `${String(hr).padStart(2, '0')}:${min}`
          }
          // "1:00 PM", "14:00", "1 PM"
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

        // Pure time range like "4-5pm" or "4-5am" (no date, no slash)
        if (!s.includes('/') && /^\d{1,2}\s*-\s*\d{1,2}\s*(am|pm)/i.test(s)) {
          const t = parseTime(s)
          return t ? `T${t}:00` : s
        }

        // Try to extract a date part: M/D/YYYY, M-D-YYYY, M/D/YY, M-D (no year)
        // Also handles glued format like "4/4/202620:00" → split date from time
        const dateRe = /(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/
        const dateMatch = s.match(dateRe)

        if (dateMatch) {
          const mm = dateMatch[1].padStart(2, '0')
          const dd = dateMatch[2].padStart(2, '0')
          const yearRaw = dateMatch[3]
          const year = yearRaw
            ? (yearRaw.length === 2 ? '20' + yearRaw : yearRaw)
            : String(new Date().getFullYear()) // Infer current year when missing
          const datePart = `${year}-${mm}-${dd}`

          // Extract time from remainder after the date match
          const afterDate = s.slice(dateMatch.index! + dateMatch[0].length)
          const timeParsed = afterDate ? parseTime(afterDate) : ''

          return timeParsed ? `${datePart}T${timeParsed}:00` : datePart
        }

        // Already ISO-ish
        if (s.includes('T')) return s
        return s
      }

      const col = (r: any[], key: string) => key in colMap ? String(r[colMap[key]] ?? '').trim() : ''
      const colRaw = (r: any[], key: string) => key in colMap ? r[colMap[key]] : ''

      // ── Filter out completely blank rows and rows without any AWB ──
      const dataRows = rawRows.slice(headerRowIdx + 1).filter(r => {
        const awb1 = col(r, 'awb_1st')
        const awb2 = col(r, 'awb_2nd')
        const fn = col(r, 'flight_number')
        // Must have at least an AWB (1st or 2nd leg) AND a flight number
        return (awb1 || awb2) && fn
      })

      if (dataRows.length === 0) { setError('No valid data rows found in the Excel file. Each row needs at least an AWB and Flight Number.'); return }

      // ── Group rows by Flight Number + Deliver To (airline) ──
      // Fix D: tolerant grouping — rows with empty airline/etd inherit from
      // the dominant row that shares the same flight_number, preventing
      // phantom flights from being created for incomplete rows.
      const flightGroups = new Map<string, any[][]>()
      const incompleteRowWarnings: string[] = []

      // Pass 1: group by flight_number only to find dominant airline/etd
      const byFlightNumber = new Map<string, any[][]>()
      for (const r of dataRows) {
        const fn = col(r, 'flight_number').toUpperCase()
        if (!byFlightNumber.has(fn)) byFlightNumber.set(fn, [])
        byFlightNumber.get(fn)!.push(r)
      }

      // Pass 2: for each flight_number, determine if there are truly distinct
      // flights (different airlines) or just incomplete rows
      for (const [fn, rows] of byFlightNumber) {
        // Collect non-empty airline and etd values
        const airlineValues: string[] = []
        const etdValues: string[] = []
        for (const r of rows) {
          const a = col(r, 'deliver_to').toUpperCase()
          const e = parseEcomDate(colRaw(r, 'etd'))
          if (a) airlineValues.push(a)
          if (e) etdValues.push(e)
        }
        const uniqueAirlines = new Set(airlineValues)

        if (uniqueAirlines.size <= 1) {
          // All rows belong to the same flight — use dominant values
          const dominantAirline = airlineValues[0] || ''
          const dominantEtd = etdValues[0] || ''
          const groupKey = `${fn}__${dominantAirline}__${dominantEtd.slice(0, 10)}`
          if (!flightGroups.has(groupKey)) flightGroups.set(groupKey, [])
          flightGroups.get(groupKey)!.push(...rows)

          // Track rows that had missing data
          const incomplete = rows.filter(r => !col(r, 'deliver_to') || !parseEcomDate(colRaw(r, 'etd')))
          if (incomplete.length > 0 && dominantAirline) {
            incompleteRowWarnings.push(`${incomplete.length} fila(s) sin airline/ETD asignadas a ${fn} ${dominantAirline}`)
          }
        } else {
          // Multiple real airlines for same flight number — group normally
          for (const r of rows) {
            const airline = col(r, 'deliver_to').toUpperCase()
            const etd = parseEcomDate(colRaw(r, 'etd'))

            if (airline) {
              // Row has airline: group by its own data
              const groupKey = `${fn}__${airline}__${etd.slice(0, 10)}`
              if (!flightGroups.has(groupKey)) flightGroups.set(groupKey, [])
              flightGroups.get(groupKey)!.push(r)
            } else {
              // Row missing airline: assign to the largest airline group
              const largestAirline = [...uniqueAirlines].sort((a, b) => {
                const countA = airlineValues.filter(v => v === a).length
                const countB = airlineValues.filter(v => v === b).length
                return countB - countA
              })[0]
              const fallbackEtd = etd || etdValues[0] || ''
              const groupKey = `${fn}__${largestAirline}__${fallbackEtd.slice(0, 10)}`
              if (!flightGroups.has(groupKey)) flightGroups.set(groupKey, [])
              flightGroups.get(groupKey)!.push(r)
              incompleteRowWarnings.push(`1 fila sin airline asignada a ${fn} ${largestAirline}`)
            }
          }
        }
      }

      if (incompleteRowWarnings.length > 0) {
        console.warn('Excel upload — incomplete rows fixed:', incompleteRowWarnings)
      }

      // ── Save directly to Firestore (one flight + one booking per group) ──
      const now = new Date().toISOString()
      const createdBy = user?.email || user?.uid || ''
      const createdFlightIds: string[] = []
      // Local cache of flights created during this loop (React state is batched)
      const newlyCreatedFlights: (AirfreightFlight & { id: string })[] = []

      for (const [groupKey, groupRows] of flightGroups) {
        // Extract dominant values from groupKey (already resolved by tolerant grouping)
        const [gkFlight, gkAirline, gkEtdDate] = groupKey.split('__')

        // Find the best row for ETD/cutoff (first row with non-empty values)
        const bestEtdRow = groupRows.find(r => parseEcomDate(colRaw(r, 'etd'))) || groupRows[0]
        const bestCutoffRow = groupRows.find(r => parseEcomDate(colRaw(r, 'cutoff'))) || groupRows[0]

        const flightNumber = gkFlight
        const etdRaw = parseEcomDate(colRaw(bestEtdRow, 'etd'))
        const cutoffRaw = parseEcomDate(colRaw(bestCutoffRow, 'cutoff'))
        const deliverTo = gkAirline || col(groupRows.find(r => col(r, 'deliver_to')) || groupRows[0], 'deliver_to')

        // Collect unique destinations
        const dests = new Set<string>()
        for (const r of groupRows) {
          const d = col(r, 'destination').toUpperCase()
          if (d) dests.add(d)
        }

        // ── Match or create flight ──
        // Match on flight_number + ETD date + airline (case-insensitive) so that
        // "AVIANCA" and "AVIANCA PAX LOWER DECK" create separate flights,
        // but re-uploads with minor case changes still match.
        // Check both React state AND locally created flights in this loop.
        const etdDate = etdRaw.slice(0, 10)
        const normalizedAirline = (deliverTo || '').trim().toUpperCase()
        const matchFn = (f: AirfreightFlight & { id: string }) =>
          (f.flight_number || '').trim().toUpperCase() === flightNumber &&
          etdDate !== '' && f.flight_datetime.startsWith(etdDate) &&
          (f.airline || '').trim().toUpperCase() === normalizedAirline
        let matchedFlight = flights.find(matchFn) || newlyCreatedFlights.find(matchFn)

        if (!matchedFlight) {
          const flightData: any = {
            airline: deliverTo || 'Unknown',
            flight_number: flightNumber || null,
            flight_datetime: etdRaw || now,
            cutoff_datetime: cutoffRaw || null,
            destinations: Array.from(dests),
            status: 'open',
            created_by: createdBy,
            created_at: now,
          }
          const docRef = await addDoc(collection(db, 'airfreight_flights'), flightData)
          matchedFlight = { ...flightData, id: docRef.id } as AirfreightFlight & { id: string }
          newlyCreatedFlights.push(matchedFlight)
          setFlights(prev => [matchedFlight!, ...prev])
        } else {
          // Update destinations + cutoff + airline if provided by Excel
          const existingDests = new Set(matchedFlight.destinations || [])
          const newDests = Array.from(dests).filter(d => !existingDests.has(d))
          const updates: Record<string, any> = {}
          if (newDests.length > 0) {
            updates.destinations = [...(matchedFlight.destinations || []), ...newDests]
          }
          if (cutoffRaw) {
            updates.cutoff_datetime = cutoffRaw
          }
          // Airline is now part of matching, no need to update it here
          if (Object.keys(updates).length > 0) {
            await updateDoc(doc(db, 'airfreight_flights', matchedFlight.id), updates)
            matchedFlight = { ...matchedFlight, ...updates }
            setFlights(prev => prev.map(f => f.id === matchedFlight!.id ? matchedFlight! : f))
          }
        }

        createdFlightIds.push(matchedFlight.id)

        // ── Build awb_lines directly ──
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

          return {
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
        })

        const totalPieces = awbLines.reduce((s, l) => s + l.pieces, 0)
        const anyHold = awbLines.some(l => l.hold === true || l.hold === 'pending')

        // ── Find existing booking for same client + flight, or create new ──
        const existingBookingSnap = await getDocs(query(
          collection(db, 'airfreight_bookings'),
          where('flight_id', '==', matchedFlight.id),
          where('client_id', '==', activeClient.id || ''),
          where('booking_type', '==', 'ecommerce'),
        ))
        const existingBooking = existingBookingSnap.docs[0]

        if (existingBooking) {
          // Replace awb_lines and update totals
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
          })
        } else {
          await addDoc(collection(db, 'airfreight_bookings'), {
            flight_id: matchedFlight.id,
            flight_number: matchedFlight.flight_number || null,
            airline: matchedFlight.airline || '',
            booking_type: 'ecommerce',
            client_id: activeClient.id || '',
            client_name: activeClient.name || '',
            agent_name: activeClient.requires_agent ? (agentName || null) : null,
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
          })
        }

        // ── Sync holds for this flight ──
        await syncHoldsToCollection(matchedFlight.id, matchedFlight)
      }

      // Navigate to dashboard after saving
      navigate('/airfreight')

    } catch (err: any) {
      console.error('Ecommerce Excel upload error:', err)
      setError(`Error processing Excel file: ${err?.message || err}`)
    } finally {
      setUploadingExcel(false)
    }
  }

  async function handleCreateFlight() {
    if (!newFlightEtd) { setError('El ETD del vuelo es requerido'); return }
    if (!newAirline) { setError('La aerolínea es requerida'); return }
    if (newFlightDests.length === 0) { setError('Selecciona al menos un destino para el vuelo'); return }
    setCreatingFlight(true)
    setError('')
    try {
      const airlineName = newAirline === 'Otra' ? newAirlineOther : newAirline
      const datetime = `${newFlightEtd}:00`
      const cutoffDt = newFlightCutoff ? `${newFlightCutoff}:00` : null
      const docRef = await addDoc(collection(db, 'airfreight_flights'), {
        airline: airlineName,
        flight_number: newFlightNumber.trim() || null,
        flight_datetime: datetime,
        cutoff_datetime: cutoffDt,
        destinations: newFlightDests,
        status: 'open',
        created_by: user?.email || user?.uid || '',
        created_at: new Date().toISOString(),
      })
      const newFlight: AirfreightFlight & { id: string } = {
        id: docRef.id, airline: airlineName,
        flight_number: newFlightNumber.trim() || undefined,
        flight_datetime: datetime, cutoff_datetime: cutoffDt || undefined,
        destinations: newFlightDests,
        status: 'open', created_by: user?.email || user?.uid || '',
        created_at: new Date().toISOString(),
      }
      setFlights(prev => [newFlight, ...prev])
      setFlightId(docRef.id)
      const dest = newFlightDests[0] || ''
      setRows(prev => prev.map(r => ({ ...r, destination: dest })))
      setShowNewFlight(false)
      setNewAirline(''); setNewAirlineOther(''); setNewFlightNumber('')
      setNewFlightEtd(''); setNewFlightCutoff(''); setNewFlightDests([])
    } catch {
      setError('Error al crear el vuelo')
    } finally {
      setCreatingFlight(false)
    }
  }

  // ── Row helpers ───────────────────────────────────────────────────────────

  function addRow() {
    counter.current += 1
    const last = rows[rows.length - 1]
    const row = newRow(counter.current, flightDestinations[0] || last?.destination || '', activeClient)

    // Ecommerce clients: auto-assign to the existing ecommerce group (or create one)
    if (isEcommerceClient) {
      let ecomGroup = mawbGroups.find(g => g.key.startsWith('ecom_'))
      if (!ecomGroup) {
        const key = `ecom_new_${Date.now()}`
        ecomGroup = { key, mawbNumber: '', firestoreId: undefined as any }
        setMawbGroups(prev => [...prev, ecomGroup!])
      }
      row.mawbGroupKey = ecomGroup.key
    }

    setRows(prev => [...prev, row])
  }

  function addRowToGroup(groupKey: string) {
    counter.current += 1
    const groupRows = rows.filter(r => r.mawbGroupKey === groupKey)
    const lastInGroup = groupRows[groupRows.length - 1]
    const dest = flightDestinations[0] || lastInGroup?.destination || ''
    const row: BookingRow = { ...newRow(counter.current, dest, activeClient), mawbGroupKey: groupKey }
    setRows(prev => {
      const lastIdx = prev.map(r => r.mawbGroupKey === groupKey).lastIndexOf(true)
      const next = [...prev]
      next.splice(lastIdx + 1, 0, row)
      return next
    })
  }

  function removeRow(id: number) {
    setRows(prev => {
      const next = prev.filter(r => r._id !== id)
      const remainingKeys = new Set(next.map(r => r.mawbGroupKey).filter(Boolean))
      setMawbGroups(g => g.filter(mg => remainingKeys.has(mg.key)))
      return next
    })
    setSelectedRowIds(prev => { const s = new Set(prev); s.delete(id); return s })
  }

  function updateRow<K extends keyof BookingRow>(id: number, field: K, value: BookingRow[K]) {
    setRows(prev => prev.map(r => r._id !== id ? r : { ...r, [field]: value }))
  }

  // ── MAWB grouping ─────────────────────────────────────────────────────────

  function toggleRowSelect(id: number) {
    setSelectedRowIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function clearSelection() {
    setSelectedRowIds(new Set())
    setAssignMawbInput('')
    setAssignTargetKey('__new__')
  }

  function handleAssignToMawb() {
    const mawbNum = assignMawbInput.trim()
    if (!mawbNum) return

    const groupKey = assignTargetKey === '__new__' ? `mawb_${Date.now()}` : assignTargetKey

    const updatedRows = rows.map(r =>
      selectedRowIds.has(r._id) ? { ...r, mawbGroupKey: groupKey } : r
    )

    // Remove groups that became empty after reassignment
    const usedKeys = new Set(updatedRows.map(r => r.mawbGroupKey).filter(Boolean))

    setRows(updatedRows)
    setMawbGroups(prev => {
      const withNew = assignTargetKey === '__new__'
        ? [...prev, { key: groupKey, mawbNumber: mawbNum }]
        : prev.map(g => g.key === groupKey ? { ...g, mawbNumber: mawbNum } : g)
      return withNew.filter(mg => usedKeys.has(mg.key))
    })
    clearSelection()
  }

  async function handleUnassignGroup(groupKey: string) {
    const group = mawbGroups.find(g => g.key === groupKey)

    // If group has a Firestore booking, read it to migrate docs/screening/transport to rows
    if (group?.firestoreId) {
      try {
        const snap = await getDoc(doc(db, 'airfreight_bookings', group.firestoreId))
        if (snap.exists()) {
          const bData = snap.data() as any
          const awbLines: any[] = bData.awb_lines || []

          setRows(prev => prev.map(r => {
            if (r.mawbGroupKey !== groupKey) return r
            // Find matching awb_line by awb_number
            const matchedLine = awbLines.find((l: any) =>
              r.isRefLine
                ? l.is_ref_line && l.awb_2nd_leg === (r.awb2.trim() || null)
                : l.awb_number === r.awb1.trim()
            )
            return {
              ...r,
              mawbGroupKey: '',
              _migratedDocs: matchedLine?.documents || undefined,
              _migratedScreening: matchedLine ? {
                screening_status: matchedLine.screening_status,
                screening_pieces_screened: matchedLine.screening_pieces_screened,
                doc_screening_cert: matchedLine.doc_screening_cert,
                screening_details: matchedLine.screening_details,
              } : undefined,
              _migratedTransport: matchedLine ? {
                transport_company: matchedLine.transport_company,
                transport_status: matchedLine.transport_status,
                transport_docs: matchedLine.transport_docs,
                transport_edited_fields: matchedLine.transport_edited_fields,
                drop_off_time: matchedLine.drop_off_time,
                doc_acceptance: matchedLine.doc_acceptance,
                doc_whr: matchedLine.doc_whr,
              } : undefined,
            }
          }))
          setMawbGroups(prev => prev.filter(g => g.key !== groupKey))
          return
        }
      } catch (err) {
        console.error('Error reading MAWB booking for migration:', err)
      }
    }

    // Fallback: no firestoreId or read failed
    setRows(prev => prev.map(r =>
      r.mawbGroupKey === groupKey ? { ...r, mawbGroupKey: '' } : r
    ))
    setMawbGroups(prev => prev.filter(g => g.key !== groupKey))
  }

  // ── Save ──────────────────────────────────────────────────────────────────

  async function handleSave() {
    if (!flightId) { setError('Selecciona o crea un vuelo primero'); return }
    const valid = rows.filter(r => r.clientId && r.destination)
    if (valid.length === 0) { setError('Completa al menos un booking con cliente y destino'); return }

    setSaving(true)
    setError('')
    try {
      const fl = flights.find(f => f.id === flightId)
      const now = new Date().toISOString()
      const createdBy = user?.email || user?.uid || ''

      const baseNew = {
        flight_id: flightId,
        flight_number: fl?.flight_number || null,
        airline: fl?.airline || '',
        status: 'submitted',
        created_by: createdBy,
        created_at: now,
        change_count: 0,
        modified_seen: true,
        change_log: [],
        documents: {},
      }

      const ops: Promise<unknown>[] = []

      // ── Group rows by mawbGroupKey ──
      const groupedRows = new Map<string, BookingRow[]>()
      const simpleRows: BookingRow[] = []
      for (const row of valid) {
        if (row.mawbGroupKey) {
          if (!groupedRows.has(row.mawbGroupKey)) groupedRows.set(row.mawbGroupKey, [])
          groupedRows.get(row.mawbGroupKey)!.push(row)
        } else {
          simpleRows.push(row)
        }
      }

      // ── MAWB groups: update existing or create new ──
      for (const [groupKey, groupRows] of groupedRows) {
        const mawbGroup = mawbGroups.find(g => g.key === groupKey)
        const first = groupRows[0]

        // Preserve scans, holds, and documents from existing Firestore data
        let existingLines: any[] = []
        if (mawbGroup?.firestoreId) {
          const existSnap = await getDoc(doc(db, 'airfreight_bookings', mawbGroup.firestoreId))
          if (existSnap.exists()) {
            existingLines = (existSnap.data() as any).awb_lines || []
          }
        }

        const awbLines = groupRows.map((r) => {
          // Match by awb_number + split_from to preserve scans/holds/docs
          // For ref lines (no awb_number), match by awb_2nd_leg + is_ref_line
          const existing = existingLines.find((el: any) =>
            r.isRefLine
              ? el.is_ref_line && el.awb_2nd_leg === (r.awb2.trim() || null)
              : el.awb_number === r.awb1.trim() && (el.split_from || null) === (r.splitFrom || null)
          ) || {}
          return {
            line_number: r.lineNumber.trim() || null,
            awb_number: r.isRefLine ? '' : r.awb1.trim(),
            awb_2nd_leg: r.awb2.trim() || null,
            is_ref_line: r.isRefLine || false,
            tracking_refs: r.isRefLine ? r.trackingRefs.split('\n').map(s => s.trim()).filter(Boolean) : [],
            pieces: r.pieces ? Number(r.pieces) : 0,
            slacs: r.slacs ? Number(r.slacs) : null,
            weight: r.weight ? Number(r.weight) : 0,
            chargeable_weight: r.chargeableWeight ? Number(r.chargeableWeight) : 0,
            uld_type: r.uldType || null,
            uld_airline: r.uldAirline.trim() || null,
            loc_bond: r.locBond || null,
            label_color: r.labelColor,
            pickup_from: r.pickupFrom.trim() || null,
            ready_for_pickup: r.pickupDate || null,
            last_day_free: r.lastDayFree || null,
            battery: r.battery,
            ddgg: r.ddgg,
            hold: r.hold,
            split: r.split,
            split_from: r.splitFrom || null,
            on_hand: r.onHand,
            // Preserve scan data, holds, documents, and transport fields from Firestore
            ...(existing.scans ? { scans: existing.scans } : {}),
            ...(existing.holds ? { holds: existing.holds } : {}),
            ...(existing.documents ? { documents: existing.documents } : {}),
            ...(existing.transport_company ? { transport_company: existing.transport_company } : {}),
            ...(existing.transport_status ? { transport_status: existing.transport_status } : {}),
            ...(existing.transport_docs ? { transport_docs: existing.transport_docs } : {}),
            ...(existing.transport_edited_fields ? { transport_edited_fields: existing.transport_edited_fields } : {}),
            ...(existing.drop_off_time ? { drop_off_time: existing.drop_off_time } : {}),
            // Preserve warehouse/reception operational fields
            ...(existing.warehouse_status ? { warehouse_status: existing.warehouse_status } : {}),
            ...(existing.doc_reception_id ? { doc_reception_id: existing.doc_reception_id } : {}),
            ...(existing.dispatched != null ? { dispatched: existing.dispatched } : {}),
            ...(existing.dispatched_at ? { dispatched_at: existing.dispatched_at } : {}),
            // Preserve screening fields
            ...(existing.screening_status ? { screening_status: existing.screening_status } : {}),
            ...(existing.screening_date ? { screening_date: existing.screening_date } : {}),
            ...(existing.screening_method ? { screening_method: existing.screening_method } : {}),
            ...(existing.screening_result ? { screening_result: existing.screening_result } : {}),
            ...(existing.screening_pieces_screened ? { screening_pieces_screened: existing.screening_pieces_screened } : {}),
            ...(existing.doc_screening_cert ? { doc_screening_cert: existing.doc_screening_cert } : {}),
            ...(existing.screening_details ? { screening_details: existing.screening_details } : {}),
          }
        })
        const totalPieces = groupRows.reduce((s, r) => s + (Number(r.pieces) || 0), 0)

        const mawbHold = groupRows.some(r => r.hold === true) ? true : groupRows.some(r => r.hold === 'pending') ? 'pending' as const : false
        const mawbOnHand = groupRows.length > 0 && groupRows.every(r => r.onHand)

        const isEcomGroup = groupKey.startsWith('ecom_')
        const bookingType = isEcomGroup ? 'ecommerce' : 'mawb'

        if (mawbGroup?.firestoreId) {
          // Update existing booking (tracked at group level, not row level)
          ops.push(updateDoc(doc(db, 'airfreight_bookings', mawbGroup.firestoreId), {
            ...(isEcomGroup ? {} : { mawb_number: mawbGroup.mawbNumber }),
            destination_id: first.destination,
            awb_lines: awbLines,
            pieces: totalPieces,
            hold: mawbHold,
            on_hand: mawbOnHand,
            ...awbIndexField({ booking_type: bookingType, awb_lines: awbLines }),
          }))
        } else {
          // Create new booking
          ops.push(addDoc(collection(db, 'airfreight_bookings'), {
            ...baseNew,
            booking_type: bookingType,
            client_id: first.clientId,
            client_name: first.clientName,
            agent_name: activeClient?.requires_agent ? (agentName || null) : null,
            destination_id: first.destination,
            ...(isEcomGroup ? {} : { mawb_number: mawbGroup?.mawbNumber || '' }),
            awb_lines: awbLines,
            pieces: totalPieces,
            hold: mawbHold,
            on_hand: mawbOnHand,
            ...awbIndexField({ booking_type: bookingType, awb_lines: awbLines }),
          }))
        }
      }

      // ── Simple rows: update existing or create new ──
      for (const row of simpleRows) {
        if (row.firestoreId) {
          // Update existing simple booking
          const updAwb1 = row.isRefLine ? '' : (row.awb1.trim() || null)
          const updAwb2 = row.awb2.trim() || null
          ops.push(updateDoc(doc(db, 'airfreight_bookings', row.firestoreId), {
            destination_id: row.destination,
            line_number: row.lineNumber.trim() || null,
            awb_1st_leg: updAwb1,
            awb_2nd_leg: updAwb2,
            is_ref_line: row.isRefLine || false,
            tracking_refs: row.isRefLine ? row.trackingRefs.split('\n').map(s => s.trim()).filter(Boolean) : [],
            uld_type: row.uldType || null,
            pieces: row.pieces ? Number(row.pieces) : null,
            weight: row.weight ? Number(row.weight) : null,
            chargeable_weight: row.chargeableWeight ? Number(row.chargeableWeight) : null,
            slacs: row.slacs ? Number(row.slacs) : null,
            pickup_from: row.pickupFrom.trim() || null,
            ready_for_pickup: row.pickupDate || null,
            last_day_free: row.lastDayFree || null,
            battery: row.battery,
            ddgg: row.ddgg,
            hold: row.hold,
            on_hand: row.onHand,
            ...awbIndexField({ booking_type: 'simple', awb_1st_leg: updAwb1 || undefined, awb_2nd_leg: updAwb2 || undefined }),
          }))
        } else {
          // Create new simple booking
          const awb1 = row.isRefLine ? '' : (row.awb1.trim() || null)
          const awb2 = row.awb2.trim() || null
          const newSimple: Record<string, any> = {
            ...baseNew,
            booking_type: 'simple',
            client_id: row.clientId,
            client_name: row.clientName,
            agent_name: activeClient?.requires_agent ? (agentName || null) : null,
            destination_id: row.destination,
            line_number: row.lineNumber.trim() || null,
            awb_1st_leg: awb1,
            awb_2nd_leg: awb2,
            ...awbIndexField({ booking_type: 'simple', awb_1st_leg: awb1 || undefined, awb_2nd_leg: awb2 || undefined }),
            is_ref_line: row.isRefLine || false,
            tracking_refs: row.isRefLine ? row.trackingRefs.split('\n').map(s => s.trim()).filter(Boolean) : [],
            uld_type: row.uldType || null,
            pieces: row.pieces ? Number(row.pieces) : null,
            weight: row.weight ? Number(row.weight) : null,
            chargeable_weight: row.chargeableWeight ? Number(row.chargeableWeight) : null,
            slacs: row.slacs ? Number(row.slacs) : null,
            pickup_from: row.pickupFrom.trim() || null,
            ready_for_pickup: row.pickupDate || null,
            last_day_free: row.lastDayFree || null,
            battery: row.battery,
            ddgg: row.ddgg,
            hold: row.hold,
            on_hand: row.onHand,
          }
          // Migrate documents/screening/transport from ungrouped MAWB line
          if (row._migratedDocs) newSimple.documents = row._migratedDocs
          if (row._migratedScreening) {
            const ms = row._migratedScreening
            if (ms.screening_status) newSimple.screening_status = ms.screening_status
            if (ms.screening_pieces_screened) newSimple.screening_pieces_total = ms.screening_pieces_screened
            if (ms.doc_screening_cert) newSimple.doc_screening_cert = ms.doc_screening_cert
            if (ms.screening_details) newSimple.screening_details = ms.screening_details
          }
          if (row._migratedTransport) {
            const mt = row._migratedTransport
            if (mt.transport_company) newSimple.transport_company = mt.transport_company
            if (mt.transport_status) newSimple.transport_status = mt.transport_status
            if (mt.transport_docs) newSimple.transport_docs = mt.transport_docs
            if (mt.transport_edited_fields) newSimple.transport_edited_fields = mt.transport_edited_fields
            if (mt.drop_off_time) newSimple.drop_off_time = mt.drop_off_time
            if (mt.doc_acceptance) newSimple.doc_acceptance = mt.doc_acceptance
            if (mt.doc_whr) newSimple.doc_whr = mt.doc_whr
          }
          ops.push(addDoc(collection(db, 'airfreight_bookings'), newSimple))
        }
      }

      // ── Delete removed simple bookings ──
      // Only count rows that are still simple (not grouped into a MAWB).
      // Grouped rows with a firestoreId are simple bookings that the user moved
      // into a MAWB — their original simple doc must be deleted.
      const currentSimpleIds = new Set(
        valid.filter(r => r.firestoreId && !r.mawbGroupKey).map(r => r.firestoreId!)
      )
      for (const oid of originalSimpleIds.current) {
        if (!currentSimpleIds.has(oid)) {
          ops.push(deleteDoc(doc(db, 'airfreight_bookings', oid)))
        }
      }

      // ── Delete MAWB bookings whose group was removed or merged elsewhere ──
      const currentGroupFirestoreIds = new Set(
        mawbGroups.filter(g => g.firestoreId).map(g => g.firestoreId!)
      )
      for (const oid of originalGroupIds.current) {
        if (!currentGroupFirestoreIds.has(oid)) {
          ops.push(deleteDoc(doc(db, 'airfreight_bookings', oid)))
        }
      }

      // Flag flight as updated if client modified an existing booking
      if (editMode && flightId) {
        ops.push(updateDoc(doc(db, 'airfreight_flights', flightId), { booking_updated: true }))
      }

      await Promise.all(ops)

      // ── Sync holds to airfreight_holds collection ──
      await syncHoldsToCollection(flightId, fl)

      navigate('/airfreight')
    } catch (err) {
      console.error(err)
      setError('Error al guardar los bookings')
    } finally {
      setSaving(false)
    }
  }

  /** Sync hold items from bookings into airfreight_holds collection */
  async function syncHoldsToCollection(fId: string, fl?: AirfreightFlight & { id: string }) {
    try {
      // 1. Get all bookings for this flight
      const bSnap = await getDocs(query(collection(db, 'airfreight_bookings'), where('flight_id', '==', fId)))
      const bookings = bSnap.docs.map(d => ({ ...d.data() as AirfreightBooking, id: d.id }))

      // 2. Collect all hold items from bookings
      const desiredHolds: { booking_id: string; client_id: string; client_name: string; awb: string; bag: string; box: string }[] = []

      for (const b of bookings) {
        if ((b.booking_type === 'mawb' || b.booking_type === 'ecommerce') && b.awb_lines) {
          for (const line of b.awb_lines) {
            if (line.hold && line.holds && line.holds.length > 0) {
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

  // ── Modify flight + reassign ─────────────────────────────────────────────

  // Returns list of bookings (simple + MAWB groups + ecommerce AWBs) that can be reassigned
  function getReassignableBookings() {
    const items: { id: string; label: string; type: 'simple' | 'mawb' | 'ecommerce'; pieces: number; dest: string }[] = []
    // Simple bookings (rows not in any MAWB group)
    for (const row of rows) {
      if (!row.mawbGroupKey && row.firestoreId) {
        items.push({ id: row.firestoreId, label: row.awb1 || '—', type: 'simple', pieces: Number(row.pieces) || 0, dest: row.destination })
      }
    }
    // MAWB groups and Ecommerce AWBs
    for (const g of mawbGroups) {
      if (!g.firestoreId) continue
      const isEcom = g.key.startsWith('ecom_')
      if (isEcom) {
        // Ecommerce: list each AWB individually (skip splits)
        // Use awb1 (=awb_number in Firestore) as the unique key for matching
        const gRows = rows.filter(r => r.mawbGroupKey === g.key && !r.splitFrom)
        for (let i = 0; i < gRows.length; i++) {
          const row = gRows[i]
          items.push({
            id: `${g.firestoreId}:${row.awb1}`,
            label: row.awb2 || row.awb1 || '—',
            type: 'ecommerce',
            pieces: Number(row.pieces) || 0,
            dest: row.destination,
          })
        }
      } else {
        // MAWB: whole group
        const gRows = rows.filter(r => r.mawbGroupKey === g.key)
        items.push({ id: g.firestoreId, label: `MAWB ${g.mawbNumber}`, type: 'mawb', pieces: gRows.reduce((s, r) => s + (Number(r.pieces) || 0), 0), dest: gRows[0]?.destination || '' })
      }
    }
    return items
  }

  async function handleSaveFlightEdit() {
    if (!flightId || !selectedFlight) return
    setSavingFlightEdit(true)
    try {
      const updates: Record<string, any> = {}
      if (editFlightEtd) {
        updates.flight_datetime = editFlightEtd.includes('T') ? `${editFlightEtd}:00` : editFlightEtd
      }
      // cutoff: allow clearing (empty string → null)
      const cutVal = editFlightCutoff
        ? (editFlightCutoff.includes('T') ? `${editFlightCutoff}:00` : editFlightCutoff)
        : null
      updates.cutoff_datetime = cutVal

      // flight_number
      const newFn = editFlightNumber.trim() || null
      updates.flight_number = newFn

      // destinations
      const newDests = editFlightDests.split(',').map(d => d.trim()).filter(Boolean)
      if (newDests.length > 0) updates.destinations = newDests

      await updateDoc(doc(db, 'airfreight_flights', flightId), updates)
      setFlights(prev => prev.map(f => f.id === flightId ? { ...f, ...updates } : f))

      // Update flight_number + destination_id on all bookings of this flight
      const bSnap = await getDocs(query(collection(db, 'airfreight_bookings'), where('flight_id', '==', flightId)))
      const bookingUpdates: Record<string, any> = { flight_number: newFn }
      if (newDests.length > 0) bookingUpdates.destination_id = newDests[0]
      await Promise.all(bSnap.docs.map(d => updateDoc(doc(db, 'airfreight_bookings', d.id), bookingUpdates)))

      // Update local rows destination
      if (newDests.length > 0) {
        setRows(prev => prev.map(r => ({ ...r, destination: newDests[0] })))
      }

      setShowEditFlight(false)
    } catch (err: any) {
      console.error('Error updating flight:', err)
    } finally {
      setSavingFlightEdit(false)
    }
  }

  async function handleModifyFlight() {
    if (!modifyEtd) { setError('El ETD es requerido'); return }
    if (!modifyAirline) { setError('La aerolínea es requerida'); return }
    setModifyingFlight(true)
    setError('')
    try {
      const airlineName = modifyAirline === 'Otra' ? modifyAirlineOther : modifyAirline
      const modifyCutoffDt = modifyCutoff ? `${modifyCutoff}:00` : null
      const docRef = await addDoc(collection(db, 'airfreight_flights'), {
        airline: airlineName,
        flight_number: modifyFlightNumber.trim() || null,
        flight_datetime: `${modifyEtd}:00`,
        cutoff_datetime: modifyCutoffDt,
        destinations: selectedFlight?.destinations || [],
        status: 'open',
        created_by: user?.email || user?.uid || '',
        created_at: new Date().toISOString(),
        from_modification: true,
      })
      setReassignFlightId(docRef.id)
      setShowModifyFlight(false)
      setReassignMode(true)
      // Pre-select all bookings
      setReassignSelectedIds(new Set(getReassignableBookings().map(b => b.id)))
    } catch {
      setError('Error al crear el vuelo nuevo')
    } finally {
      setModifyingFlight(false)
    }
  }

  async function handleConfirmReassign() {
    if (!reassignFlightId || reassignSelectedIds.size === 0) return
    const newFlightId = reassignFlightId
    const fl = flights.find(f => f.id === newFlightId) ?? { flight_number: modifyFlightNumber.trim() || null, airline: modifyAirline === 'Otra' ? modifyAirlineOther : modifyAirline }
    setSaving(true)
    setError('')
    try {
      const ops: Promise<unknown>[] = []

      // Separate ecommerce AWB-level IDs (bookingId:awbNumber) from whole-booking IDs
      const wholeBookingIds: string[] = []
      const ecomAwbsByBooking = new Map<string, Set<string>>()

      for (const id of reassignSelectedIds) {
        if (id.includes(':')) {
          const [bookingId, awbNum] = [id.substring(0, id.indexOf(':')), id.substring(id.indexOf(':') + 1)]
          if (!ecomAwbsByBooking.has(bookingId)) ecomAwbsByBooking.set(bookingId, new Set())
          ecomAwbsByBooking.get(bookingId)!.add(awbNum)
        } else {
          wholeBookingIds.push(id)
        }
      }

      // Move whole bookings (simple + MAWB)
      for (const id of wholeBookingIds) {
        ops.push(updateDoc(doc(db, 'airfreight_bookings', id), {
          flight_id: newFlightId,
          flight_number: (fl as any).flight_number || null,
          airline: (fl as any).airline || '',
        }))
      }

      // Handle ecommerce AWB-level moves: split selected AWBs into a new booking
      for (const [bookingId, selectedAwbs] of ecomAwbsByBooking) {
        const bRef = doc(db, 'airfreight_bookings', bookingId)
        const bSnap = await getDoc(bRef)
        if (!bSnap.exists()) continue
        const bData = bSnap.data() as AirfreightBooking
        const allLines = bData.awb_lines || []

        // Partition: selected AWBs + their splits go to new booking, rest stay
        const movedLines: typeof allLines = []
        const remainingLines: typeof allLines = []
        for (const line of allLines) {
          const awbKey = line.split_from || line.awb_number
          if (selectedAwbs.has(awbKey)) {
            movedLines.push(line)
          } else {
            remainingLines.push(line)
          }
        }

        if (movedLines.length === 0) continue

        if (remainingLines.length === 0) {
          // All AWBs selected — move entire booking
          ops.push(updateDoc(bRef, {
            flight_id: newFlightId,
            flight_number: (fl as any).flight_number || null,
            airline: (fl as any).airline || '',
          }))
        } else {
          // Split: update original booking with remaining lines, create new booking with moved lines
          ops.push(updateDoc(bRef, { awb_lines: remainingLines }))
          // Build new booking explicitly — avoid spreading undefined fields that Firestore rejects
          const rawData = bSnap.data()
          const newBookingData: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(rawData)) {
            if (v !== undefined && k !== 'id') newBookingData[k] = v
          }
          newBookingData.flight_id = newFlightId
          newBookingData.flight_number = (fl as any).flight_number || null
          newBookingData.airline = (fl as any).airline || ''
          newBookingData.awb_lines = movedLines
          newBookingData.created_at = new Date().toISOString()
          newBookingData.change_log = [...(bData.change_log || []), {
            changed_at: new Date().toISOString(),
            changed_by: user?.email || user?.uid || '',
            change_type: 'flight_reassignment',
            fields_changed: [{ field: 'flight_id', label: 'Vuelo', old_value: flightId, new_value: newFlightId }],
          }]
          const newBookingRef = await addDoc(collection(db, 'airfreight_bookings'), newBookingData)
          // F4-FIX: Reconcile doc_reception.booking_id for moved AWBs (B5 compliance)
          const movedAwbNumbers = movedLines.map(l => (l.awb_number || '').replace(/[\s\-]/g, '').toUpperCase()).filter(Boolean)
          const movedAwb2nds = movedLines.map(l => (l.awb_2nd_leg || '').replace(/[\s\-]/g, '').toUpperCase()).filter(Boolean)
          if (movedAwbNumbers.length > 0 || movedAwb2nds.length > 0) {
            const drSnap = await getDocs(query(
              collection(db, 'airfreight_doc_receptions'),
              where('booking_id', '==', bookingId)
            ))
            for (const drDoc of drSnap.docs) {
              const dr = drDoc.data()
              const drAwb1 = (dr.awb_number || '').replace(/[\s\-]/g, '').toUpperCase()
              const drAwb2 = (dr.awb_2nd_leg || '').replace(/[\s\-]/g, '').toUpperCase()
              const matches = movedAwbNumbers.includes(drAwb1) || movedAwbNumbers.includes(drAwb2) ||
                              movedAwb2nds.includes(drAwb1) || movedAwb2nds.includes(drAwb2)
              if (matches) {
                ops.push(updateDoc(drDoc.ref, { booking_id: newBookingRef.id }))
              }
            }
          }
        }
      }

      // Mark original flight as modified
      ops.push(updateDoc(doc(db, 'airfreight_flights', flightId), { was_modified: true }))
      await Promise.all(ops)
      navigate('/airfreight')
    } catch (err) {
      console.error('Reassign error:', err)
      setError('Error al reasignar los bookings')
    } finally {
      setSaving(false)
    }
  }

  // ── Services modal helpers ─────────────────────────────────────────────────

  // Build a list of AWB items from the current rows for the dropdown
  const svcAwbItems: { key: string; label: string; bookingId: string; awbIndex: number | null; row: BookingRow }[] = (() => {
    const items: typeof svcAwbItems = []
    for (const row of rows) {
      if (row.mawbGroupKey) {
        const group = mawbGroups.find(g => g.key === row.mawbGroupKey)
        if (!group?.firestoreId) continue
        const groupRows = rows.filter(r => r.mawbGroupKey === row.mawbGroupKey)
        const idx = groupRows.indexOf(row)
        if (idx < 0) continue
        items.push({
          key: `${group.firestoreId}__${idx}`,
          label: row.awb1 || `Guia #${idx + 1}`,
          bookingId: group.firestoreId,
          awbIndex: idx,
          row,
        })
      } else if (row.firestoreId) {
        items.push({
          key: row.firestoreId,
          label: row.awb1 || `Booking`,
          bookingId: row.firestoreId,
          awbIndex: null,
          row,
        })
      }
    }
    // Deduplicate by key
    const seen = new Set<string>()
    return items.filter(i => { if (seen.has(i.key)) return false; seen.add(i.key); return true })
  })()

  async function openServicesModal() {
    if (!flightId || !globalClientId) {
      alert('Selecciona vuelo y cliente primero')
      return
    }
    setShowServicesModal(true)
    setSvcLoading(true)
    setSvcScope('awb')
    setSvcAwbKey('')
    setSvcServiceName('')
    setSvcQty('1')
    try {
      const [clientSnap, rateSnap, chargesSnap] = await Promise.all([
        getDoc(doc(db, 'airfreight_clients', globalClientId)),
        getDocs(collection(db, 'air_rate_schedule')),
        getDocs(query(
          collection(db, 'air_billing_charges'),
          where('flight_id', '==', flightId),
          where('client_id', '==', globalClientId),
          where('source', '==', 'manual'),
          where('status', '==', 'pending'),
        )),
      ])
      setSvcClientData(clientSnap.exists() ? { id: clientSnap.id, ...clientSnap.data() } as AirfreightClient : null)
      const allRates = rateSnap.docs.map(d => ({ id: d.id, ...d.data() } as AirRateSchedule)).filter(r => r.active)
      setSvcRateSchedules(allRates)
      setSvcCharges(chargesSnap.docs.map(d => ({ id: d.id, ...d.data() } as AirBillingCharge)))
    } catch (err) {
      console.error('Error loading services data:', err)
    } finally {
      setSvcLoading(false)
    }
  }

  async function handleAddService() {
    if (!svcServiceName) { alert('Selecciona un servicio'); return }
    const qty = Number(svcQty) || 1

    setSvcSaving(true)
    try {
      if (svcScope === 'flight') {
        // Flight-level: use the first booking as reference
        const firstItem = svcAwbItems[0]
        if (!firstItem) { alert('No hay bookings guardados'); return }
        const bSnap = await getDoc(doc(db, 'airfreight_bookings', firstItem.bookingId))
        if (!bSnap.exists()) { alert('Booking no encontrado'); return }
        const booking = { id: bSnap.id, ...bSnap.data() } as AirfreightBooking
        await addManualAirCharge({
          booking,
          awbLine: null,
          awbIndex: null,
          scope: 'flight',
          serviceName: svcServiceName,
          qty,
          userEmail: user?.email || '',
          rateSchedules: svcRateSchedules,
        })
      } else {
        // AWB-level
        if (!svcAwbKey) { alert('Selecciona una guia'); return }
        const item = svcAwbItems.find(i => i.key === svcAwbKey)
        if (!item) { alert('Guia no encontrada'); return }
        const bSnap = await getDoc(doc(db, 'airfreight_bookings', item.bookingId))
        if (!bSnap.exists()) { alert('Booking no encontrado'); return }
        const booking = { id: bSnap.id, ...bSnap.data() } as AirfreightBooking
        const awbLine = item.awbIndex !== null ? (booking.awb_lines?.[item.awbIndex] || null) : null
        await addManualAirCharge({
          booking,
          awbLine,
          awbIndex: item.awbIndex,
          scope: 'awb',
          serviceName: svcServiceName,
          qty,
          userEmail: user?.email || '',
          rateSchedules: svcRateSchedules,
        })
      }
      // Reload charges
      const chargesSnap = await getDocs(query(
        collection(db, 'air_billing_charges'),
        where('flight_id', '==', flightId),
        where('client_id', '==', globalClientId),
        where('source', '==', 'manual'),
        where('status', '==', 'pending'),
      ))
      setSvcCharges(chargesSnap.docs.map(d => ({ id: d.id, ...d.data() } as AirBillingCharge)))
      setSvcServiceName('')
      setSvcQty('1')
    } catch (err) {
      console.error('Error adding service:', err)
      alert('Error al agregar servicio: ' + String(err))
    } finally {
      setSvcSaving(false)
    }
  }

  async function handleDeleteService(chargeId: string) {
    if (!confirm('Eliminar este servicio?')) return
    try {
      await deleteManualAirCharge(chargeId, user?.email || '', isAdmin)
      setSvcCharges(prev => prev.filter(c => c.id !== chargeId))
    } catch (err) {
      alert(String(err))
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (loadingMeta) {
    return (
      <Layout title="Bookings" backTo="/airfreight">
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" />
        </div>
      </Layout>
    )
  }

  const readyCount = rows.filter(r => r.clientId && r.destination).length
  const unassignedRows = rows.filter(r => !r.mawbGroupKey)
  const hasBothSections = mawbGroups.length > 0 && unassignedRows.length > 0
  const selectedCount = selectedRowIds.size

  function printBooking() {
    if (!selectedFlight || rows.length === 0) return
    const win = window.open('', '_blank')
    if (!win) return

    const esc = (s: string) =>
      String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))

    const fmtDt = (iso: string) => {
      if (!iso) return '—'
      const [dp, tp] = iso.split('T')
      const [y, m, d] = (dp || '').split('-')
      if (!y || !m || !d) return iso
      const timePart = tp ? ` ${tp.slice(0, 5)}` : ''
      return `${m}/${d}/${y}${timePart}`
    }

    const printedAt = (() => {
      const d = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    })()

    const flightLine = `${esc(selectedFlight.airline || '')}${selectedFlight.flight_number ? ' #' + esc(selectedFlight.flight_number) : ''}`
    const destinations = (selectedFlight.destinations || []).join(', ')
    const etd = fmtDt(selectedFlight.flight_datetime || '')
    const cutoff = fmtDt(selectedFlight.cutoff_datetime || '')
    const clientName = activeClient?.name || (rows[0]?.clientName) || ''

    const flagsCell = (r: BookingRow) => {
      const parts: string[] = []
      if (r.battery) parts.push('<span title="Lithium Battery">🔋</span>')
      if (r.ddgg) parts.push('<span title="Dangerous Goods">⚠️</span>')
      if (r.locBond) parts.push(`<span class="flag" title="Local/Bonded">${esc(r.locBond)}</span>`)
      if (r.hold === true) parts.push('<span class="flag flag-red" title="Hold">HOLD</span>')
      else if (r.hold === 'pending') parts.push('<span class="flag flag-yellow" title="Hold pending">H?</span>')
      if (r.split) parts.push('<span class="flag flag-blue" title="Split">SPLIT</span>')
      return parts.join(' ')
    }

    const rowHtml = (r: BookingRow, idx: number) => `
      <tr>
        <td class="num">${idx + 1}</td>
        <td>${esc(r.destination)}</td>
        <td class="mono">${esc(r.awb1)}</td>
        <td class="mono muted">${esc(r.awb2) || '—'}</td>
        <td>${esc(r.uldType)}${r.uldAirline ? ' <span class="muted">(' + esc(r.uldAirline) + ')</span>' : ''}</td>
        <td class="num">${esc(r.pieces)}</td>
        <td class="num">${esc(r.slacs) || '—'}</td>
        <td class="num">${esc(r.weight)}</td>
        <td class="num">${esc(r.chargeableWeight)}</td>
        <td class="flags">${flagsCell(r)}</td>
      </tr>`

    const sumN = (arr: BookingRow[], key: 'pieces' | 'slacs' | 'weight' | 'chargeableWeight') =>
      arr.reduce((s, r) => s + (Number(r[key]) || 0), 0)

    const groupBlock = (title: string, subtitle: string, groupRows: BookingRow[], startIdx: number) => {
      const tp = sumN(groupRows, 'pieces')
      const ts = sumN(groupRows, 'slacs')
      const tw = sumN(groupRows, 'weight')
      const tc = sumN(groupRows, 'chargeableWeight')
      return `
        <tr class="grp">
          <td colspan="10">
            <div class="grp-row">
              <span class="grp-title">${esc(title)}</span>
              <span class="grp-sub">${esc(subtitle)} · ${groupRows.length} AWB${groupRows.length !== 1 ? 's' : ''} · ${fmtNum(tp)} pcs · ${fmtNum(tw, 1)} kg · ${fmtNum(tc, 1)} chw</span>
            </div>
          </td>
        </tr>
        ${groupRows.map((r, i) => rowHtml(r, startIdx + i)).join('')}
      `
    }

    let bodyHtml = ''
    if (isEcommerceClient) {
      bodyHtml = rows.map((r, i) => rowHtml(r, i)).join('')
    } else {
      let runningIdx = 0
      for (const g of mawbGroups) {
        const gRows = rows.filter(r => r.mawbGroupKey === g.key)
        if (gRows.length === 0) continue
        bodyHtml += groupBlock(g.mawbNumber ? `MAWB ${g.mawbNumber}` : 'Direct', g.mawbNumber ? '' : 'sin MAWB', gRows, runningIdx)
        runningIdx += gRows.length
      }
      const loose = rows.filter(r => !r.mawbGroupKey)
      if (loose.length > 0) {
        bodyHtml += groupBlock('Sueltas', 'sin agrupar', loose, runningIdx)
      }
    }

    // Grand totals
    const gTotPcs = sumN(rows, 'pieces')
    const gTotSlacs = sumN(rows, 'slacs')
    const gTotWt = sumN(rows, 'weight')
    const gTotChw = sumN(rows, 'chargeableWeight')

    const title = `Booking · ${flightLine} · ${etd.split(' ')[0]}`

    win.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${esc(title)}</title>
<style>
  @page { size: letter landscape; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #222; margin: 0; padding: 16px; font-size: 11px; }
  .header { display: flex; align-items: flex-start; justify-content: space-between; border-bottom: 2px solid #1a3b5c; padding-bottom: 10px; margin-bottom: 14px; }
  .brand { font-size: 18px; font-weight: 700; color: #1a3b5c; letter-spacing: .5px; }
  .brand-sub { font-size: 10px; color: #888; margin-top: 2px; }
  .meta { text-align: right; font-size: 10px; color: #666; }
  .meta .big { font-size: 14px; color: #1a3b5c; font-weight: 600; }
  .info { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 14px; }
  .info .cell { border: 1px solid #e5e7eb; border-radius: 6px; padding: 6px 10px; }
  .info .lbl { font-size: 9px; text-transform: uppercase; color: #888; letter-spacing: .5px; }
  .info .val { font-size: 12px; color: #222; font-weight: 600; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 10px; }
  thead th { background: #f3f4f6; color: #555; text-transform: uppercase; font-size: 9px; letter-spacing: .5px; padding: 6px 6px; border-bottom: 1.5px solid #cbd5e1; text-align: left; }
  thead th.num { text-align: center; }
  tbody td { padding: 5px 6px; border-bottom: 1px solid #eef0f3; vertical-align: top; }
  tbody td.num { text-align: center; font-variant-numeric: tabular-nums; }
  tbody td.mono { font-family: ui-monospace, Menlo, Consolas, monospace; }
  tbody td.muted { color: #888; }
  tbody td.flags { font-size: 10px; white-space: nowrap; }
  .flag { display: inline-block; padding: 1px 5px; border-radius: 3px; background: #e5e7eb; color: #374151; font-weight: 600; font-size: 9px; }
  .flag-red { background: #fee2e2; color: #b91c1c; }
  .flag-yellow { background: #fef3c7; color: #92400e; }
  .flag-blue { background: #dbeafe; color: #1d4ed8; }
  tr.grp td { background: #ede9fe; color: #5b21b6; padding: 6px 8px; border-top: 2px solid #7c3aed; border-bottom: 1px solid #c4b5fd; }
  tr.grp .grp-title { font-weight: 700; font-size: 11px; font-family: ui-monospace, Menlo, Consolas, monospace; letter-spacing: .5px; }
  tr.grp .grp-sub { color: #7c3aed; font-size: 10px; margin-left: 10px; }
  tfoot td { padding: 8px 6px; border-top: 2px solid #1a3b5c; font-weight: 700; font-size: 11px; background: #f8fafc; }
  tfoot td.num { text-align: center; }
</style>
</head>
<body>
  <div class="header">
    <div>
      <div class="brand">MinCurl Logistics</div>
      <div class="brand-sub">Booking Detail — Air Freight</div>
    </div>
    <div class="meta">
      <div class="big">${esc(flightLine)}</div>
      <div>${esc(destinations)}</div>
      <div>Impreso: ${esc(printedAt)}</div>
    </div>
  </div>

  <div class="info">
    <div class="cell"><div class="lbl">Cliente</div><div class="val">${esc(clientName) || '—'}</div></div>
    <div class="cell"><div class="lbl">Vuelo</div><div class="val">${esc(flightLine)}</div></div>
    <div class="cell"><div class="lbl">Destinos</div><div class="val">${esc(destinations) || '—'}</div></div>
    <div class="cell"><div class="lbl">ETD</div><div class="val">${esc(etd)}</div></div>
    <div class="cell"><div class="lbl">Cut Off</div><div class="val">${esc(cutoff)}</div></div>
  </div>

  <table>
    <thead>
      <tr>
        <th class="num" style="width:28px">#</th>
        <th style="width:50px">DEST</th>
        <th style="width:108px">1ST LEG</th>
        <th style="width:108px">2ND LEG</th>
        <th style="width:90px">ULD</th>
        <th class="num" style="width:40px">PCS</th>
        <th class="num" style="width:48px">SLACS</th>
        <th class="num" style="width:56px">PESO</th>
        <th class="num" style="width:56px">CHW</th>
        <th>FLAGS</th>
      </tr>
    </thead>
    <tbody>
      ${bodyHtml}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="5" style="text-align:right">TOTAL · ${rows.length} guía${rows.length !== 1 ? 's' : ''}</td>
        <td class="num">${fmtNum(gTotPcs)}</td>
        <td class="num">${gTotSlacs > 0 ? fmtNum(gTotSlacs) : '—'}</td>
        <td class="num">${fmtNum(gTotWt, 1)}</td>
        <td class="num">${fmtNum(gTotChw, 1)}</td>
        <td></td>
      </tr>
    </tfoot>
  </table>

  <script>
    window.addEventListener('load', () => { setTimeout(() => window.print(), 250) });
  </script>
</body>
</html>`)
    win.document.close()
  }

  const colHeaders = (
    <tr className="bg-gray-50 text-xs font-bold text-gray-500 uppercase tracking-wide border-b border-gray-200">
      {isMawbClient && <th className="px-2 py-2 w-6"></th>}
      <th className="px-2 py-2 text-left w-6">#</th>
      {!isEcommerceClient && <th className="px-2 py-2 text-left" style={{ width: 56 }}>#INT</th>}
      <th className="px-2 py-2 text-left" style={{ minWidth: 60 }}>DEST</th>
      <th className="px-2 py-2 text-left" style={{ minWidth: 108 }}>1ST LEG</th>
      <th className="px-2 py-2 text-left" style={{ minWidth: 108 }}>2ND LEG</th>
      <th className="px-2 py-2 text-left" style={{ minWidth: 90 }}>ULD</th>
      {isMawbClient && <th className="px-2 py-2 text-left" style={{ minWidth: 72 }}>ULD AIR</th>}
      <th className="px-2 py-2 text-center" style={{ width: 52 }}>PCS</th>
      {isMawbClient && <th className="px-2 py-2 text-center" style={{ width: 64 }}>SLACS</th>}
      {!isEcommerceClient && <th className="px-2 py-2 text-center" style={{ width: 64 }}>PESO</th>}
      <th className="px-2 py-2 text-center" style={{ width: 64 }}>CHW</th>
      {false && !isMawbClient && !isClient && <th className="px-2 py-2 text-left" style={{ minWidth: 96 }}>P.UP FROM</th>}
      {false && !isMawbClient && !isClient && <th className="px-2 py-2 text-center" style={{ minWidth: 108 }}>P.UP DATE</th>}
      {false && !isMawbClient && !isClient && <th className="px-2 py-2 text-center" style={{ minWidth: 108 }}>LD. FREE</th>}
      {isMawbClient && <th className="px-2 py-2 text-center" title="Local / Bonded" style={{ width: 36 }}>L/B</th>}
      <th className="px-2 py-2 text-center" title="Lithium Battery" style={{ width: 28 }}>🔋</th>
      <th className="px-2 py-2 text-center" title="Dangerous Goods" style={{ width: 28 }}>⚠️</th>
      {isMawbClient && <th className="px-2 py-2 text-center" title="Label Color" style={{ width: 36 }}>LABEL</th>}
      <th className="px-2 py-2 text-center" title="Documents status" style={{ width: 36 }}>DOCS</th>
      <th className="px-2 py-2 text-center" title="Upload documents" style={{ width: 36 }}>UP</th>
      <th className="px-2 py-2 text-center" title="Hold" style={{ width: 36 }}>HOLD</th>
      {!isEcommerceClient && <th className="px-2 py-2 text-center" title="Split" style={{ width: 36 }}>SPLIT</th>}
      <th className="px-2 py-2 text-center" title="On Hand (MCL received)" style={{ width: 36 }}>O.H.</th>
      <th className="px-2 py-2" style={{ width: 24 }}></th>
    </tr>
  )

  const totalCols = isMawbClient ? 23 : isEcommerceClient ? 17 : isClient ? 17 : 17

  function renderRow(row: BookingRow, idx: number) {
    const isSelected = selectedRowIds.has(row._id)
    const isGrouped = !!row.mawbGroupKey
    return (
      <tr
        key={row._id}
        className={`group transition-colors ${isSelected ? 'bg-purple-50' : isGrouped ? 'bg-purple-50/20 hover:bg-purple-50/40' : 'hover:bg-gray-50/50'}`}
      >
        {isMawbClient && (
          <td className="px-2 py-1.5 text-center">
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => toggleRowSelect(row._id)}
              className="rounded accent-purple-600 cursor-pointer"
            />
          </td>
        )}

        <td className="px-2 py-1.5 text-xs text-gray-400 font-medium">{idx + 1}</td>

        {!isEcommerceClient && (
          <td className="px-2 py-1.5">
            <input value={row.lineNumber} onChange={e => updateRow(row._id, 'lineNumber', e.target.value)}
              placeholder="#" style={{ width: 50 }}
              className="border border-gray-200 rounded px-1.5 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-mcl-blue/40" />
          </td>
        )}

        <td className="px-2 py-1.5">
          {row.splitFrom ? null : flightDestinations.length > 1 ? (
            <select value={row.destination} onChange={e => updateRow(row._id, 'destination', e.target.value)}
              className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-mcl-blue/40"
              style={{ minWidth: 56 }}>
              <option value="">—</option>
              {flightDestinations.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          ) : (
            <span className="text-xs font-mono font-semibold text-mcl-blue px-1">{row.destination || '—'}</span>
          )}
        </td>

        <td className="px-2 py-1.5">
          {row.splitFrom ? null : row.isRefLine ? (
            <button
              type="button"
              onClick={() => { setRefPanelRowId(row._id); setRefPanelText(row.trackingRefs) }}
              className="border border-amber-200 bg-amber-50 rounded px-1.5 py-1 text-left hover:bg-amber-100 transition-colors cursor-pointer"
              style={{ width: 108 }}
            >
              {row.trackingRefs && row.trackingRefs.split('\n').filter(Boolean).length > 0 ? (
                <div>
                  {row.trackingRefs.split('\n').filter(Boolean).map((ref, i) => (
                    <div key={i} className="text-[9px] font-mono text-amber-800 leading-tight truncate">{ref}</div>
                  ))}
                  <div className="text-[9px] text-amber-500 font-semibold mt-0.5 border-t border-amber-200 pt-0.5">
                    {row.trackingRefs.split('\n').filter(Boolean).length} refs — click editar
                  </div>
                </div>
              ) : (
                <span className="text-[10px] text-amber-600">+ Agregar refs</span>
              )}
            </button>
          ) : (
            <div className="flex items-center gap-0.5">
              <input value={row.awb1} onChange={e => updateRow(row._id, 'awb1', fmtAwb(e.target.value))}
                placeholder="000-00000000" style={{ width: 92 }}
                className="border border-gray-200 rounded px-1.5 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-mcl-blue/40" />
              {isMawbClient && !row.awb1 && (
                <button type="button" title="Línea de referencias (trackings)"
                  onClick={() => updateRow(row._id, 'isRefLine', true)}
                  className="text-gray-300 hover:text-orange-500 transition-colors flex-shrink-0">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h8m-8 6h4" />
                  </svg>
                </button>
              )}
            </div>
          )}
        </td>

        <td className="px-2 py-1.5">
          <input value={row.awb2} onChange={e => updateRow(row._id, 'awb2', fmtAwb(e.target.value))}
            placeholder="000-00000000" style={{ width: 100 }}
            className="border border-gray-200 rounded px-1.5 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-mcl-blue/40" />
        </td>

        <td className="px-2 py-1.5">
          {row.splitFrom ? null : (
            <input value={row.uldType} onChange={e => updateRow(row._id, 'uldType', e.target.value)}
              placeholder="LOOSE / PMC..."
              style={{ width: 84 }}
              className="border border-gray-200 rounded px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-mcl-blue/40" />
          )}
        </td>

        {isMawbClient && (
          <td className="px-2 py-1.5">
            {row.splitFrom ? null : row.uldType && row.uldType.toUpperCase() !== 'LOOSE' ? (
              <input value={row.uldAirline} onChange={e => updateRow(row._id, 'uldAirline', e.target.value)}
                placeholder="Airline"
                style={{ width: 68 }}
                className="border border-gray-200 rounded px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-mcl-blue/40" />
            ) : null}
          </td>
        )}

        <td className="px-2 py-1.5">
            <input type="number" min="0" value={row.pieces}
              onChange={e => updateRow(row._id, 'pieces', e.target.value)}
              style={{ width: 56 }}
              className="border border-gray-200 rounded px-1.5 py-1 text-xs text-center focus:outline-none focus:ring-1 focus:ring-mcl-blue/40 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
        </td>

        {isMawbClient && (
          <td className="px-2 py-1.5">
              <input type="number" min="0" step="1" value={row.slacs}
                onChange={e => updateRow(row._id, 'slacs', e.target.value)}
                style={{ width: 58 }}
                className="border border-gray-200 rounded px-1.5 py-1 text-xs text-center focus:outline-none focus:ring-1 focus:ring-mcl-blue/40 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none" />
          </td>
        )}

        {!isEcommerceClient && (
          <td className="px-2 py-1.5">
              <input type="number" min="0" step="1" value={row.weight}
                onChange={e => updateRow(row._id, 'weight', e.target.value)}
                style={{ width: 60 }}
                className="border border-gray-200 rounded px-1.5 py-1 text-xs text-center focus:outline-none focus:ring-1 focus:ring-mcl-blue/40 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
          </td>
        )}

        <td className="px-2 py-1.5">
            <input type="number" min="0" step="1" value={row.chargeableWeight}
              onChange={e => updateRow(row._id, 'chargeableWeight', e.target.value)}
              style={{ width: 60 }}
              className="border border-gray-200 rounded px-1.5 py-1 text-xs text-center focus:outline-none focus:ring-1 focus:ring-mcl-blue/40 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
        </td>

        {/* Pick Up From, Ready, Last Day Free — moved to Transportation module */}

        {isMawbClient && (
          <td className="px-2 py-1.5 text-center">
            <select value={row.locBond} onChange={e => updateRow(row._id, 'locBond', e.target.value)}
              style={{ width: 36 }}
              className="border border-gray-200 rounded px-0.5 py-1 text-xs text-center focus:outline-none focus:ring-1 focus:ring-mcl-blue/40">
              <option value="">—</option>
              <option value="L">L</option>
              <option value="B">B</option>
            </select>
          </td>
        )}

        <td className="px-2 py-1.5 text-center">
          <input type="checkbox" checked={row.battery}
            onChange={e => updateRow(row._id, 'battery', e.target.checked)} className="rounded" />
        </td>

        <td className="px-2 py-1.5 text-center">
          <input type="checkbox" checked={row.ddgg}
            onChange={e => updateRow(row._id, 'ddgg', e.target.checked)} className="rounded" />
        </td>

        {isMawbClient && (
          <td className="px-2 py-1.5 text-center">
            <input type="checkbox" checked={row.labelColor}
              onChange={e => updateRow(row._id, 'labelColor', e.target.checked)} className="rounded" />
          </td>
        )}

        {/* DOCS — status indicator only (hidden for split lines) */}
        <td className="px-2 py-1.5 text-center">
          {!row.splitFrom && (
            <span
              title={row.docCount > 0 ? `${row.docCount} doc(s)` : 'No docs'}
              className={`inline-block w-4 h-4 rounded-full ${row.docCount > 0 ? 'bg-green-500' : 'bg-gray-200'}`}
            />
          )}
        </td>

        {/* UPLOAD — navigates to docs screen */}
        <td className="px-2 py-1.5 text-center">
          {(() => {
            const mawbGroup     = row.mawbGroupKey ? mawbGroups.find(g => g.key === row.mawbGroupKey) : undefined
            const docsBookingId = row.firestoreId || mawbGroup?.firestoreId
            if (!docsBookingId) {
              return <span className="inline-block w-4 h-4 text-gray-200 opacity-40" title="Save booking first">↑</span>
            }
            return (
              <button
                type="button"
                title="Upload documents"
                onClick={() => {
                  const params = new URLSearchParams({ booking: docsBookingId })
                  if (row.isMawbClient) {
                    if (row.splitFrom && row.awb2) params.set('awb', row.awb2)
                    else if (row.awb1) params.set('awb', row.awb1)
                  }
                  navigate(`/airfreight/docs?${params}`)
                }}
                className="text-gray-300 hover:text-mcl-blue transition-colors"
              >
                <svg className="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
              </button>
            )
          })()}
        </td>

        {/* HOLD — 3-state: gray (false) ↔ yellow (pending). Red (true) via hold entry */}
        <td className="px-2 py-1.5 text-center">
          {!row.splitFrom && (
            <button type="button" onClick={() => {
              // gray → yellow, yellow → gray, red → gray
              if (row.hold === false) updateRow(row._id, 'hold', 'pending')
              else updateRow(row._id, 'hold', false)
            }}
              title={row.hold === 'pending' ? 'Pendiente — click para descartar' : row.hold === true ? 'Hold activo — click para quitar' : 'Sin hold — click para marcar pendiente'}
              className={`inline-block w-4 h-4 rounded-full transition-colors ${
                row.hold === 'pending' ? 'bg-yellow-400 hover:bg-yellow-500' :
                row.hold === true ? 'bg-orange-500 hover:bg-orange-600' :
                'bg-gray-200 hover:bg-yellow-200'
              }`} />
          )}
        </td>

        {/* SPLIT — client toggles (hidden for ecommerce) */}
        {!isEcommerceClient && (
          <td className="px-2 py-1.5 text-center">
            {!row.splitFrom ? (
              <button type="button" onClick={() => {
                const newVal = !row.split
                updateRow(row._id, 'split', newVal)
                if (newVal && row.awb1) {
                  // Create a new split line in the same MAWB group
                  const splitRow: BookingRow = {
                    ...newRow(Date.now()),
                    clientId: row.clientId,
                    clientName: row.clientName,
                    isMawbClient: row.isMawbClient,
                    destination: row.destination,
                    mawbGroupKey: row.mawbGroupKey,
                    splitFrom: row.awb1,
                    firestoreGroupId: row.firestoreGroupId,
                  }
                  setRows(prev => {
                    const idx = prev.findIndex(r => r._id === row._id)
                    const next = [...prev]
                    next.splice(idx + 1, 0, splitRow)
                    return next
                  })
                } else if (!newVal) {
                  // Remove split lines created from this AWB
                  setRows(prev => prev.filter(r => r.splitFrom !== row.awb1))
                }
              }}
                title={row.split ? 'Split activo' : 'Sin split'}
                className={`inline-block w-4 h-4 rounded-full transition-colors ${row.split ? 'bg-purple-500' : 'bg-gray-200 hover:bg-purple-200'}`} />
            ) : (
              <span className="text-[10px] text-purple-400" title={`Split de ${row.splitFrom}`}>✂️</span>
            )}
          </td>
        )}

        {/* ON HAND — MCL-only toggle (hidden for split lines) */}
        <td className="px-2 py-1.5 text-center">
          {!row.splitFrom && (
            <button type="button"
              onClick={() => { if (!isClient) updateRow(row._id, 'onHand', !row.onHand) }}
              title={row.onHand ? 'On Hand' : 'No recibido'}
              className={`inline-block w-4 h-4 rounded-full transition-colors ${row.onHand ? 'bg-green-500' : isClient ? 'bg-gray-200 cursor-default' : 'bg-gray-200 hover:bg-green-200'}`} />
          )}
        </td>

        <td className="px-2 py-1.5 text-center">
          {rows.length > 1 && (
            <button type="button" onClick={() => removeRow(row._id)}
              className="text-gray-300 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100">×</button>
          )}
        </td>
      </tr>
    )
  }

  return (
    <Layout
      title={editMode ? 'Booking List' : 'Nuevo Booking'}
      backTo="/airfreight"
    >
      <div className="space-y-4">

        {/* Edit mode banner */}
        {editMode && (
          <div className={`rounded-lg px-4 py-2.5 flex items-center justify-between text-sm border ${bookingLocked ? 'bg-gray-50 border-gray-300' : 'bg-amber-50 border-amber-200'}`}>
            {bookingLocked ? (
              <>
                <span className="text-gray-600 font-medium flex items-center gap-2">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                  Booking bloqueado — {rows.length} fila{rows.length !== 1 ? 's' : ''}
                </span>
                {canOpenBooking ? (
                  <button
                    onClick={() => setBookingLocked(false)}
                    className="text-xs bg-mcl-blue text-white px-4 py-1.5 rounded-lg hover:bg-blue-900 transition-colors font-semibold"
                  >
                    Open Booking
                  </button>
                ) : (
                  <span className="text-xs text-gray-400">Vuelo cerrado (Dispatched)</span>
                )}
              </>
            ) : (
              <>
                <span className="text-amber-800 font-medium">
                  Modo edición — los cambios reemplazarán los bookings existentes de este vuelo
                </span>
                <span className="text-amber-600 text-xs">{rows.length} fila{rows.length !== 1 ? 's' : ''} cargada{rows.length !== 1 ? 's' : ''}</span>
              </>
            )}
          </div>
        )}

        {/* ── FLIGHT ── */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-700">Vuelo</span>
            <div className="flex items-center gap-3">
              {canCreateFlight && !showNewFlight && !editMode && (
                <button onClick={() => { setShowNewFlight(true); setFlightId('') }}
                  className="text-xs text-mcl-blue hover:underline font-medium">
                  + Crear vuelo nuevo
                </button>
              )}
              {selectedFlight && rows.length > 0 && (
                <button
                  type="button"
                  onClick={printBooking}
                  title="Imprimir booking"
                  className="text-xs bg-white border border-gray-300 text-gray-600 hover:border-mcl-blue hover:text-mcl-blue px-3 py-1 rounded-lg transition-colors font-medium flex items-center gap-1.5"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                  </svg>
                  Print
                </button>
              )}
              {(isMawbClient || isEcommerceClient) && (
                <>
                  <input ref={excelInputRef} type="file" accept=".xlsx,.xls" className="hidden"
                    onChange={isEcommerceClient ? handleEcommerceExcelUpload : handleExcelUpload} />
                  <button
                    onClick={() => excelInputRef.current?.click()}
                    disabled={uploadingExcel}
                    className="text-xs bg-green-600 text-white px-3 py-1 rounded-lg hover:bg-green-700 transition-colors font-medium disabled:opacity-50"
                  >
                    {uploadingExcel ? 'Processing...' : isEcommerceClient ? '📄 Upload Booking' : '📄 Subir Excel'}
                  </button>
                </>
              )}
              {editMode && !showModifyFlight && !showMoveToExisting && !reassignMode && (
                <>
                  <button onClick={() => setShowModifyFlight(true)}
                    className="text-xs text-orange-600 hover:underline font-medium">
                    ✏️ Mover AWB a nuevo Vuelo
                  </button>
                  <button onClick={() => setShowMoveToExisting(true)}
                    className="text-xs text-blue-600 hover:underline font-medium">
                    ↗️ Mover a vuelo existente
                  </button>
                </>
              )}
              {showNewFlight && (
                <button onClick={() => setShowNewFlight(false)} className="text-xs text-gray-400 hover:underline">Cancelar</button>
              )}
              {(showModifyFlight || showMoveToExisting) && (
                <button onClick={() => { setShowModifyFlight(false); setShowMoveToExisting(false); setModifyAirline(''); setModifyFlightNumber(''); setModifyEtd(''); setReassignFlightId('') }}
                  className="text-xs text-gray-400 hover:underline">Cancelar</button>
              )}
            </div>
          </div>

          {!showNewFlight && (
            <div className="flex items-start gap-3 flex-wrap">
              <div className="flex-1 min-w-48">
                <label className="block text-xs text-gray-400 mb-1">VUELO</label>
                {editMode ? (
                  <div className="px-3 py-2 text-sm text-gray-700 bg-gray-50 rounded-lg border border-gray-200">
                    {selectedFlight
                      ? `${selectedFlight.airline}${selectedFlight.flight_number ? ` #${selectedFlight.flight_number}` : ''} · ${selectedFlight.destinations?.join(', ')}`
                      : flightId}
                  </div>
                ) : (
                  <select value={flightId} onChange={e => handleFlightChange(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30">
                    <option value="">Seleccionar vuelo existente...</option>
                    {flights.map(f => {
                      const [dp] = (f.flight_datetime || '').split('T')
                      const [, mm, dd] = (dp || '').split('-')
                      const dateLabel = mm && dd ? `${mm}/${dd}` : dp
                      return (
                        <option key={f.id} value={f.id}>
                          {f.airline}{f.flight_number ? ` #${f.flight_number}` : ''} · {dateLabel} · {f.destinations?.join(', ')}
                        </option>
                      )
                    })}
                  </select>
                )}
              </div>

              {!isClient && (
                <div className="min-w-44">
                  <label className="block text-xs text-gray-400 mb-1">CLIENTE</label>
                  {editMode ? (
                    <div className="px-3 py-2 text-sm text-gray-700 bg-gray-50 rounded-lg border border-gray-200">
                      {activeClient?.name || globalClientId || '—'}
                    </div>
                  ) : (
                    <select value={globalClientId} onChange={e => handleGlobalClientChange(e.target.value)}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30">
                      <option value="">Seleccionar cliente...</option>
                      {clients.map(c => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  )}
                </div>
              )}

              {activeClient?.requires_agent && (
                <div className="min-w-44">
                  <label className="block text-xs text-gray-400 mb-1">AGENT</label>
                  <input type="text" value={agentName} onChange={e => setAgentName(e.target.value)}
                    placeholder="Nombre del agente"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
                </div>
              )}

              {selectedFlight && (
                <div className="flex items-center justify-between gap-2 flex-wrap pt-5">
                  <div className="flex items-center gap-2 flex-wrap">
                    {selectedFlight.destinations?.map(d => (
                      <span key={d} className="text-xs bg-mcl-blue/10 text-mcl-blue font-mono font-semibold px-2 py-0.5 rounded-full">{d}</span>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    {editMode && !showEditFlight && (
                      <button type="button" onClick={() => {
                        const fd = selectedFlight.flight_datetime || ''
                        setEditFlightEtd(fd.includes('T') ? fd.slice(0, 16) : fd)
                        const cd = selectedFlight.cutoff_datetime || ''
                        setEditFlightCutoff(cd.includes('T') ? cd.slice(0, 16) : cd)
                        setEditFlightNumber(selectedFlight.flight_number || '')
                        setEditFlightDests((selectedFlight.destinations || []).join(', '))
                        setShowEditFlight(true)
                      }}
                        className="text-xs bg-orange-50 text-orange-600 hover:bg-orange-100 px-3 py-1.5 rounded-lg font-medium transition-colors">
                        Editar Vuelo
                      </button>
                    )}
                    {editMode && !isClient && (
                      <button
                        type="button"
                        onClick={openServicesModal}
                        className="text-xs bg-emerald-50 text-emerald-600 hover:bg-emerald-100 px-3 py-1.5 rounded-lg font-medium transition-colors flex items-center gap-1.5"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                        </svg>
                        Servicios
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => navigate(`/airfreight/docs?flight=${flightId}`)}
                      className="text-xs bg-blue-50 text-blue-600 hover:bg-blue-100 px-3 py-1.5 rounded-lg font-medium transition-colors flex items-center gap-1.5"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                      </svg>
                      Upload Documents
                    </button>
                  </div>
                </div>
              )}

              {/* Inline edit flight */}
              {showEditFlight && selectedFlight && (
                <div className="border border-orange-200 bg-orange-50/40 rounded-xl p-4 mt-3 space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">NRO. VUELO</label>
                      <input value={editFlightNumber} onChange={e => setEditFlightNumber(e.target.value)}
                        placeholder="AA 1234" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">DESTINO</label>
                      <input value={editFlightDests} onChange={e => setEditFlightDests(e.target.value)}
                        placeholder="BOG, EZE" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">ETD</label>
                      <input type="datetime-local" value={editFlightEtd} onChange={e => setEditFlightEtd(e.target.value)}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">CUTOFF</label>
                      <input type="datetime-local" value={editFlightCutoff} onChange={e => setEditFlightCutoff(e.target.value)}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white" />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={handleSaveFlightEdit} disabled={savingFlightEdit}
                      className="text-xs bg-green-600 text-white px-4 py-1.5 rounded-lg font-medium hover:bg-green-700 disabled:opacity-50">
                      {savingFlightEdit ? 'Guardando...' : 'Guardar'}
                    </button>
                    <button type="button" onClick={() => setShowEditFlight(false)}
                      className="text-xs text-gray-500 hover:underline">Cancelar</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {showNewFlight && (
            <div className="border border-blue-100 bg-blue-50/40 rounded-xl p-4 space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-xs text-gray-500 mb-1">AEROLÍNEA *</label>
                  <select value={newAirline} onChange={e => setNewAirline(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white">
                    <option value="">Seleccionar...</option>
                    {AIRLINES.map(a => <option key={a} value={a}>{a}</option>)}
                  </select>
                  {newAirline === 'Otra' && (
                    <input value={newAirlineOther} onChange={e => setNewAirlineOther(e.target.value)}
                      placeholder="Nombre aerolínea" className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white" />
                  )}
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">NRO. VUELO</label>
                  <input value={newFlightNumber} onChange={e => setNewFlightNumber(e.target.value)}
                    placeholder="AA 1234" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white" />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs text-gray-500 mb-1">ETD *</label>
                  <input type="datetime-local" value={newFlightEtd} onChange={e => setNewFlightEtd(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white" />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs text-gray-500 mb-1">CUTOFF</label>
                  <input type="datetime-local" value={newFlightCutoff} onChange={e => setNewFlightCutoff(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white" />
                </div>
                <div className="sm:col-span-3">
                  <label className="block text-xs text-gray-500 mb-1">DESTINOS *</label>
                  <div ref={destDropdownRef} className="relative">
                    <button type="button" onClick={() => setDestDropdownOpen(o => !o)}
                      className="w-full flex items-center justify-between border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-500 bg-white hover:border-gray-300">
                      <span>{newFlightDests.length === 0 ? 'Seleccionar...' : newFlightDests.join(', ')}</span>
                      <svg className={`w-4 h-4 transition-transform ${destDropdownOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    {destDropdownOpen && (
                      <div className="absolute z-20 mt-1 w-full bg-white border border-gray-200 rounded-xl shadow-lg">
                        <div className="p-2 border-b border-gray-100">
                          <input autoFocus value={destSearch} onChange={e => setDestSearch(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); filteredAirports.length === 1 ? toggleNewFlightDest(filteredAirports[0].code) : filteredAirports.length === 0 && destSearch.trim() && addCustomDest() } }}
                            placeholder="Buscar código o ciudad..."
                            className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none" />
                        </div>
                        <ul className="max-h-48 overflow-y-auto py-1">
                          {filteredAirports.map(a => (
                            <li key={a.code}>
                              <button type="button" onClick={() => toggleNewFlightDest(a.code)}
                                className={`w-full flex items-center justify-between px-4 py-2 text-sm hover:bg-gray-50 ${newFlightDests.includes(a.code) ? 'bg-blue-50 text-mcl-blue' : 'text-gray-700'}`}>
                                <span>
                                  <span className="font-mono font-semibold w-10 inline-block">{a.code}</span>
                                  <span className="text-gray-400 text-xs ml-1">{a.name}</span>
                                </span>
                                {newFlightDests.includes(a.code) && (
                                  <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                  </svg>
                                )}
                              </button>
                            </li>
                          ))}
                          {filteredAirports.length === 0 && destSearch.trim() && (
                            <li>
                              <button type="button" onClick={addCustomDest} className="w-full px-4 py-2 text-sm text-left text-mcl-blue hover:bg-blue-50">
                                + Agregar "<span className="font-mono font-semibold">{destSearch.trim().toUpperCase()}</span>"
                              </button>
                            </li>
                          )}
                        </ul>
                      </div>
                    )}
                  </div>
                  {newFlightDests.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {newFlightDests.map(d => (
                        <span key={d} className="flex items-center gap-1 bg-mcl-blue/10 text-mcl-blue text-xs px-2 py-0.5 rounded-full font-mono font-semibold">
                          {d}
                          <button type="button" onClick={() => toggleNewFlightDest(d)} className="hover:text-red-500 font-sans">×</button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex justify-end">
                <button type="button" onClick={handleCreateFlight} disabled={creatingFlight}
                  className="px-5 py-2 bg-mcl-blue text-white text-sm font-semibold rounded-lg hover:bg-blue-900 disabled:opacity-50">
                  {creatingFlight ? 'Creando vuelo...' : 'Confirmar vuelo'}
                </button>
              </div>
            </div>
          )}

          {/* ── MODIFY FLIGHT FORM ── */}
          {showModifyFlight && (
            <div className="border border-orange-100 bg-orange-50/40 rounded-xl p-4 space-y-3">
              <p className="text-xs font-semibold text-orange-700 uppercase tracking-wide">Nuevo vuelo — destino heredado: {selectedFlight?.destinations?.join(', ')}</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-1">
                  <label className="block text-xs text-gray-500 mb-1">AEROLÍNEA *</label>
                  <select value={modifyAirline} onChange={e => setModifyAirline(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white">
                    <option value="">Seleccionar...</option>
                    {AIRLINES.map(a => <option key={a} value={a}>{a}</option>)}
                  </select>
                  {modifyAirline === 'Otra' && (
                    <input value={modifyAirlineOther} onChange={e => setModifyAirlineOther(e.target.value)}
                      placeholder="Nombre aerolínea" className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white" />
                  )}
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">NRO. VUELO</label>
                  <input value={modifyFlightNumber} onChange={e => setModifyFlightNumber(e.target.value)}
                    placeholder="AA 1234" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">ETD *</label>
                  <input type="datetime-local" value={modifyEtd} onChange={e => setModifyEtd(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">CUTOFF</label>
                  <input type="datetime-local" value={modifyCutoff} onChange={e => setModifyCutoff(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white" />
                </div>
              </div>
              <div className="flex justify-end">
                <button type="button" onClick={handleModifyFlight} disabled={modifyingFlight}
                  className="px-5 py-2 bg-orange-600 text-white text-sm font-semibold rounded-lg hover:bg-orange-700 disabled:opacity-50">
                  {modifyingFlight ? 'Creando...' : 'Crear vuelo y seleccionar guías'}
                </button>
              </div>
            </div>
          )}

          {/* ── MOVE TO EXISTING FLIGHT ── */}
          {showMoveToExisting && (
            <div className="border border-blue-100 bg-blue-50/40 rounded-xl p-4 space-y-3">
              <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide">Mover guías a vuelo existente</p>
              <div>
                <label className="block text-xs text-gray-500 mb-1">SELECCIONAR VUELO DESTINO</label>
                <select value={reassignFlightId} onChange={e => setReassignFlightId(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white">
                  <option value="">Seleccionar vuelo...</option>
                  {flights
                    .filter(f => {
                      if (f.id === flightId) return false
                      const fs = f.flight_status || ((f as any).dispatched_at ? 'dispatched' : 'booked')
                      return fs !== 'dispatched'
                    })
                    .map(f => {
                      const [dp] = (f.flight_datetime || '').split('T')
                      const [, mm, dd] = (dp || '').split('-')
                      const dateLabel = mm && dd ? `${mm}/${dd}` : dp
                      return (
                        <option key={f.id} value={f.id}>
                          {f.airline}{f.flight_number ? ` #${f.flight_number}` : ''} · {dateLabel} · {f.destinations?.join(', ')}
                        </option>
                      )
                    })}
                </select>
              </div>
              <div className="flex justify-end">
                <button type="button" disabled={!reassignFlightId}
                  onClick={() => {
                    setShowMoveToExisting(false)
                    setReassignMode(true)
                    setReassignSelectedIds(new Set(getReassignableBookings().map(b => b.id)))
                  }}
                  className="px-5 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50">
                  Seleccionar guías
                </button>
              </div>
            </div>
          )}

          {/* ── REASSIGN MODE ── */}
          {reassignMode && (() => {
            const bookings = getReassignableBookings()
            const allSelected = bookings.length > 0 && bookings.every(b => reassignSelectedIds.has(b.id))
            const targetFlight = flights.find(f => f.id === reassignFlightId)
            const targetLabel = targetFlight
              ? `${targetFlight.airline}${targetFlight.flight_number ? ' #' + targetFlight.flight_number : ''}`
              : 'vuelo nuevo'
            return (
              <div className="border border-orange-200 bg-orange-50 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-orange-800">Selecciona las guías a mover a {targetLabel}</p>
                  <button type="button"
                    onClick={() => setReassignSelectedIds(allSelected ? new Set() : new Set(bookings.map(b => b.id)))}
                    className="text-xs text-orange-700 hover:underline font-medium">
                    {allSelected ? 'Deseleccionar todos' : 'Seleccionar todos'}
                  </button>
                </div>
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {bookings.map(b => (
                    <label key={b.id} className="flex items-center gap-3 px-3 py-2 bg-white rounded-lg border border-gray-100 cursor-pointer hover:border-orange-200">
                      <input type="checkbox" checked={reassignSelectedIds.has(b.id)}
                        onChange={() => setReassignSelectedIds(prev => {
                          const s = new Set(prev)
                          s.has(b.id) ? s.delete(b.id) : s.add(b.id)
                          return s
                        })}
                        className="rounded accent-orange-600" />
                      <span className="font-mono text-xs font-semibold text-gray-700 flex-1">{b.label}</span>
                      <span className="text-xs text-gray-400">{b.dest}</span>
                      {b.pieces > 0 && <span className="text-xs text-gray-400">{b.pieces} pcs</span>}
                    </label>
                  ))}
                </div>
                <div className="flex items-center justify-between pt-1">
                  <button type="button" onClick={() => { setReassignMode(false); setReassignFlightId(''); setReassignSelectedIds(new Set()) }}
                    className="text-xs text-gray-400 hover:underline">Cancelar</button>
                  <button type="button" onClick={handleConfirmReassign}
                    disabled={saving || reassignSelectedIds.size === 0}
                    className="px-5 py-2 bg-orange-600 text-white text-sm font-semibold rounded-lg hover:bg-orange-700 disabled:opacity-50">
                    {saving ? 'Moviendo...' : `Mover ${reassignSelectedIds.size} guía${reassignSelectedIds.size !== 1 ? 's' : ''} a ${targetLabel}`}
                  </button>
                </div>
              </div>
            )
          })()}
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {/* ── TABLE ── */}
        <div className={`bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden ${editMode && bookingLocked ? 'pointer-events-none opacity-60 select-none' : ''}`}>
          <div className="overflow-x-auto">
            <table className="text-sm border-collapse" style={{ minWidth: '100%' }}>
              <thead>{colHeaders}</thead>
              <tbody>

                {/* ── MAWB GROUPS (hidden for ecommerce — shown as flat list) ── */}
                {isEcommerceClient
                  ? rows.map((row, idx) => renderRow(row, idx))
                  : <>
                    {mawbGroups.map(group => {
                      const groupRows = rows.filter(r => r.mawbGroupKey === group.key)
                      const totalPcs = groupRows.reduce((s, r) => s + (Number(r.pieces) || 0), 0)
                      const totalWt = groupRows.reduce((s, r) => s + (Number(r.weight) || 0), 0)
                      const totalChw = groupRows.reduce((s, r) => s + (Number(r.chargeableWeight) || 0), 0)
                      return (
                        <Fragment key={group.key}>
                          <tr className="bg-purple-600">
                            <td colSpan={totalCols} className="px-4 py-2">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                  <span className="text-white font-bold text-sm tracking-widest font-mono">
                                    {group.mawbNumber ? `MAWB ${group.mawbNumber}` : 'Direct'}
                                  </span>
                                  <span className="text-purple-200 text-xs">
                                    {groupRows.length} AWB{groupRows.length !== 1 ? 's' : ''}
                                    {totalPcs > 0 ? ` · ${totalPcs} pcs` : ''}
                                    {totalWt > 0 ? ` · ${fmtNum(totalWt, 1)} kg` : ''}
                                    {totalChw > 0 ? ` · ${fmtNum(totalChw, 1)} chw` : ''}
                                  </span>
                                </div>
                                <button type="button" onClick={() => handleUnassignGroup(group.key)}
                                  className="text-purple-300 hover:text-white text-xs transition-colors">
                                  Desagrupar
                                </button>
                              </div>
                            </td>
                          </tr>
                          {groupRows.map((row, idx) => renderRow(row, idx))}
                          <tr className="bg-purple-50/30">
                            <td colSpan={totalCols} className="px-4 py-1.5">
                              <button type="button" onClick={() => addRowToGroup(group.key)}
                                className="text-xs text-purple-600 hover:text-purple-800 font-medium flex items-center gap-1">
                                <span className="text-base leading-none">+</span> Add row to {group.mawbNumber ? `MAWB ${group.mawbNumber}` : 'Direct'}
                              </button>
                            </td>
                          </tr>
                        </Fragment>
                      )
                    })}

                    {/* ── SEPARATOR ── */}
                    {hasBothSections && (
                      <tr>
                        <td colSpan={totalCols} className="p-0">
                          <div className="border-t-2 border-dashed border-gray-200 my-0.5" />
                        </td>
                      </tr>
                    )}

                    {/* ── UNASSIGNED ROWS ── */}
                    {unassignedRows.map((row, idx) => renderRow(row, idx))}
                  </>
                }

              </tbody>
              {/* ── TOTALS ROW ── */}
              {rows.length > 0 && (() => {
                const totPcs = rows.reduce((s, r) => s + (Number(r.pieces) || 0), 0)
                const totSlacs = rows.reduce((s, r) => s + (Number(r.slacs) || 0), 0)
                const totWt = rows.reduce((s, r) => s + (Number(r.weight) || 0), 0)
                const totChw = rows.reduce((s, r) => s + (Number(r.chargeableWeight) || 0), 0)
                const totAwbs = rows.filter(r => !r.splitFrom).length
                // Count cols before PCS
                const preColsMawb = 8 // checkbox + # + #INT + DEST + 1ST + 2ND + ULD + ULD AIR
                const preColsEcom = 5 // # + DEST + 1ST + 2ND + ULD
                const preColsSimple = 6 // # + #INT + DEST + 1ST + 2ND + ULD
                const preColsClient = 6
                const preCols = isMawbClient ? preColsMawb : isEcommerceClient ? preColsEcom : isClient ? preColsClient : preColsSimple
                return (
                  <tr className="bg-[#1A4D2E] text-white font-semibold text-xs">
                    <td colSpan={preCols} className="px-4 py-2 text-right uppercase tracking-wide">
                      Total ({totAwbs} AWBs)
                    </td>
                    <td className="px-2 py-2 text-center tabular-nums">{fmtNum(totPcs)}</td>
                    {isMawbClient && <td className="px-2 py-2 text-center tabular-nums">{fmtNum(totSlacs)}</td>}
                    {!isEcommerceClient && <td className="px-2 py-2 text-center tabular-nums">{fmtNum(totWt)}</td>}
                    <td className="px-2 py-2 text-center tabular-nums">{fmtNum(totChw)}</td>
                    <td colSpan={isMawbClient ? 10 : isEcommerceClient ? 7 : isClient ? 7 : 7} />
                  </tr>
                )
              })()}
            </table>
          </div>

          <div className="px-4 py-3 border-t border-gray-100">
            <button type="button" onClick={addRow}
              className="text-sm text-mcl-blue hover:text-blue-900 font-medium flex items-center gap-1">
              <span className="text-lg leading-none">+</span> Agregar fila
            </button>
          </div>
        </div>

        {/* ── MAWB ASSIGN BAR (not for ecommerce) ── */}
        {isMawbClient && !isEcommerceClient && selectedCount > 0 && !(editMode && bookingLocked) && (
          <div className="sticky bottom-4 z-30">
            <div className="bg-purple-700 rounded-xl shadow-2xl px-5 py-4 flex flex-wrap items-end gap-4">
              <div className="text-white font-semibold text-sm shrink-0">
                {selectedCount} AWB{selectedCount !== 1 ? 's' : ''} seleccionada{selectedCount !== 1 ? 's' : ''}
              </div>
              <div className="flex items-end gap-3 flex-wrap flex-1">
                {mawbGroups.length > 0 && (
                  <div>
                    <label className="block text-purple-300 text-xs mb-1">ASIGNAR A</label>
                    <select value={assignTargetKey}
                      onChange={e => {
                        setAssignTargetKey(e.target.value)
                        if (e.target.value !== '__new__') {
                          const g = mawbGroups.find(mg => mg.key === e.target.value)
                          if (g) setAssignMawbInput(g.mawbNumber)
                        } else {
                          setAssignMawbInput('')
                        }
                      }}
                      className="border border-purple-400 bg-purple-800 text-white rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-purple-300">
                      <option value="__new__">+ Nueva MAWB</option>
                      {mawbGroups.map(g => (
                        <option key={g.key} value={g.key}>{g.mawbNumber ? `MAWB ${g.mawbNumber}` : 'Direct'}</option>
                      ))}
                    </select>
                  </div>
                )}
                <div>
                  <label className="block text-purple-300 text-xs mb-1">NRO. MAWB</label>
                  <input value={assignMawbInput} onChange={e => setAssignMawbInput(fmtAwb(e.target.value))}
                    placeholder="000-00000000"
                    className="border border-purple-400 bg-purple-800 text-white placeholder-purple-400 rounded-lg px-3 py-2 text-xs font-mono w-36 focus:outline-none focus:ring-2 focus:ring-purple-300" />
                </div>
                <button type="button" onClick={handleAssignToMawb} disabled={!assignMawbInput.trim()}
                  className="px-5 py-2 bg-white text-purple-700 font-bold text-xs rounded-lg hover:bg-purple-50 disabled:opacity-40 transition-colors">
                  Agrupar bajo MAWB
                </button>
              </div>
              <button type="button" onClick={clearSelection} className="text-purple-300 hover:text-white text-xs transition-colors shrink-0">
                Cancelar
              </button>
            </div>
          </div>
        )}

        {/* ── Footer ── */}
        <div className="flex items-center justify-between gap-3">
          <button type="button" onClick={() => navigate('/airfreight')}
            className="px-5 py-2.5 border border-gray-200 text-gray-600 rounded-lg text-sm font-medium hover:bg-gray-50">
            Cancelar
          </button>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400">{readyCount} booking{readyCount !== 1 ? 's' : ''} listo{readyCount !== 1 ? 's' : ''}</span>
            <button type="button" onClick={handleSave} disabled={saving || (editMode && bookingLocked)}
              className="px-6 py-2.5 bg-mcl-blue text-white rounded-lg text-sm font-semibold hover:bg-blue-900 transition-colors disabled:opacity-50">
              {saving
                ? 'Guardando...'
                : editMode
                  ? 'Actualizar bookings'
                  : `Guardar${readyCount > 0 ? ` ${readyCount} booking${readyCount !== 1 ? 's' : ''}` : ''}`}
            </button>
          </div>
        </div>
      </div>

      {/* ── Services Modal ──────────────────────────────────────────────────── */}
      {showServicesModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowServicesModal(false)} />
          <div className="relative bg-white rounded-xl shadow-xl max-w-lg w-full mx-4 max-h-[85vh] overflow-y-auto p-6 space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-gray-800">Servicios Manuales</h2>
              <button onClick={() => setShowServicesModal(false)} className="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
            </div>

            {svcLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-mcl-blue" />
              </div>
            ) : (
              <>
                {/* Scope toggle */}
                <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
                  <button
                    type="button"
                    onClick={() => setSvcScope('awb')}
                    className={`flex-1 text-xs font-semibold py-2 rounded-md transition-colors ${svcScope === 'awb' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}
                  >
                    Por guia
                  </button>
                  <button
                    type="button"
                    onClick={() => setSvcScope('flight')}
                    className={`flex-1 text-xs font-semibold py-2 rounded-md transition-colors ${svcScope === 'flight' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}
                  >
                    Al vuelo
                  </button>
                </div>

                {/* AWB selector (only for 'awb' scope) */}
                {svcScope === 'awb' && (
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Guia</label>
                    <select
                      value={svcAwbKey}
                      onChange={e => setSvcAwbKey(e.target.value)}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                    >
                      <option value="">Seleccionar guia...</option>
                      {svcAwbItems.map(item => (
                        <option key={item.key} value={item.key}>{item.label}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Service + Qty */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2">
                    <label className="block text-xs text-gray-500 mb-1">Servicio</label>
                    <select
                      value={svcServiceName}
                      onChange={e => setSvcServiceName(e.target.value)}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                    >
                      <option value="">Seleccionar...</option>
                      {svcRateSchedules.map(r => (
                        <option key={r.id} value={r.name}>{r.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Qty</label>
                    <input
                      type="number"
                      min="1"
                      value={svcQty}
                      onChange={e => setSvcQty(e.target.value)}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                    />
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleAddService}
                  disabled={svcSaving}
                  className="w-full py-2 bg-emerald-600 text-white text-sm font-semibold rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                >
                  {svcSaving ? 'Agregando...' : 'Agregar Servicio'}
                </button>

                {/* Existing manual charges */}
                {svcCharges.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold text-gray-500 mb-2">Servicios asignados ({svcCharges.length})</h3>
                    <div className="space-y-1.5 max-h-48 overflow-y-auto">
                      {svcCharges.map(c => (
                        <div key={c.id} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2">
                          <div className="flex-1 min-w-0">
                            <span className="text-sm text-gray-800 font-medium">{c.charge_name}</span>
                            <span className="text-xs text-gray-400 ml-2">x{c.qty}</span>
                            <span className="text-xs text-gray-400 ml-2">
                              {c.scope === 'flight' ? 'Vuelo' : c.awb_1st_leg || `AWB #${(c.awb_index ?? 0) + 1}`}
                            </span>
                          </div>
                          {(c.added_by === user?.email || isAdmin) && (
                            <button
                              type="button"
                              onClick={() => handleDeleteService(c.id!)}
                              className="text-gray-300 hover:text-red-500 transition-colors ml-2 text-sm shrink-0"
                            >
                              &times;
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {svcCharges.length === 0 && !svcLoading && (
                  <p className="text-xs text-gray-400 text-center py-2">No hay servicios manuales asignados</p>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Tracking references modal ──────────────────────────────── */}
      {refPanelRowId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setRefPanelRowId(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-gray-800">Referencias / Trackings</h3>
                <p className="text-xs text-gray-500 mt-0.5">Pegar los números (uno por línea)</p>
              </div>
              <button type="button" onClick={() => {
                updateRow(refPanelRowId, 'isRefLine', false)
                updateRow(refPanelRowId, 'trackingRefs', '')
                setRefPanelRowId(null)
              }} className="text-xs text-red-400 hover:text-red-600 mr-2" title="Volver a AWB normal">
                Quitar
              </button>
            </div>
            <div className="px-5 py-4">
              <textarea
                rows={12}
                value={refPanelText}
                onChange={e => setRefPanelText(e.target.value)}
                placeholder={"871206000237\n871206000248\n871206000259\n..."}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-mcl-blue/30 resize-none"
              />
              <p className="text-xs text-gray-400 mt-1">{refPanelText.split('\n').filter(s => s.trim()).length} referencias</p>
            </div>
            <div className="px-5 py-3 border-t border-gray-100">
              <button
                type="button"
                onClick={() => {
                  updateRow(refPanelRowId, 'trackingRefs', refPanelText)
                  setRefPanelRowId(null)
                }}
                className="w-full bg-mcl-blue text-white font-semibold py-2.5 rounded-xl hover:bg-blue-800 transition-colors"
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}
