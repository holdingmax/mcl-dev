import { useState, useEffect, useRef, ChangeEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  collection, addDoc, getDocs, getDoc, updateDoc, deleteDoc,
  doc, query, where, limit, orderBy,
} from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import { AirfreightFlight, AirfreightClient, AirfreightDestination, AirfreightBooking, AwbSecondLeg, AirRateSchedule, AirBillingCharge } from '../../types'
import Layout from '../../components/Layout'
import { fmtNum } from '../../lib/utils'
import { addManualAirCharge, deleteManualAirCharge } from '../../lib/airBilling'
import { awbIndexField } from '../../lib/bookingAwbIndex'
import * as XLSX from 'xlsx'

// ─── Constants ────────────────────────────────────────────────────────────────

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

const CARGO_SUB_TYPES = [
  { value: 'bonded', label: 'Bonded' },
  { value: 'local', label: 'Local' },
  { value: 'bonded_local', label: 'Bonded + Local' },
]

function isYes(val: string): boolean {
  const v = val.trim().toUpperCase()
  return v === 'Y' || v === 'YES' || v === 'SI' || v === 'X' || v === 'TRUE' || v === '1'
}

function fmtAwb(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 11)
  if (digits.length <= 3) return digits
  return `${digits.slice(0, 3)}-${digits.slice(3)}`
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExportRow {
  _id: number
  destination: string
  awbNumber: string         // HAWB / AWB number
  pieces: string
  grossWeight: string       // GW
  volumeWeight: string      // VW
  chargeableWeight: string  // CHW
  battery: boolean
  ddgg: boolean
  cargoSubType: string      // bonded | local | bonded_local
  onHand: boolean
  docCount: number
}

function newExportRow(id: number, defaultDest = ''): ExportRow {
  return {
    _id: id,
    destination: defaultDest,
    awbNumber: '',
    pieces: '',
    grossWeight: '',
    volumeWeight: '',
    chargeableWeight: '',
    battery: false,
    ddgg: false,
    cargoSubType: '',
    onHand: false,
    docCount: 0,
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AirfreightExportBooking() {
  const { user, loading: authLoading, isAdmin, isSuperAgent, isAgent, isCounter, isClient, clientId, hasAirAccess, canEdit } = useAuth()
  const navigate = useNavigate()

  const [searchParams] = useSearchParams()
  const preselectedFlightId = searchParams.get('flight') || ''

  // Meta
  const [flights, setFlights] = useState<(AirfreightFlight & { id: string })[]>([])
  const [clients, setClients] = useState<(AirfreightClient & { id: string })[]>([])
  const [firestoreDestinations, setFirestoreDestinations] = useState<AirfreightDestination[]>([])
  const [loadingMeta, setLoadingMeta] = useState(true)

  // Edit mode
  const [editMode, setEditMode] = useState(false)
  const [existingBookingId, setExistingBookingId] = useState<string | null>(null)

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

  // Client
  const [globalClientId, setGlobalClientId] = useState('')

  // Rows
  const [rows, setRows] = useState<ExportRow[]>([])
  const counter = useRef(0)

  // Excel upload
  const excelInputRef = useRef<HTMLInputElement>(null)
  const [uploadingExcel, setUploadingExcel] = useState(false)

  // Save
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Booking lock
  const [bookingLocked, setBookingLocked] = useState(true)

  // Inline edit flight
  const [editFlightEtd, setEditFlightEtd] = useState('')
  const [editFlightCutoff, setEditFlightCutoff] = useState('')
  const [editFlightNumber, setEditFlightNumber] = useState('')
  const [editFlightDests, setEditFlightDests] = useState('')
  const [showEditFlight, setShowEditFlight] = useState(false)
  const [savingFlightEdit, setSavingFlightEdit] = useState(false)

  // Modify flight / reassign
  const [showModifyFlight, setShowModifyFlight] = useState(false)
  const [modifyAirline, setModifyAirline] = useState('')
  const [modifyAirlineOther, setModifyAirlineOther] = useState('')
  const [modifyFlightNumber, setModifyFlightNumber] = useState('')
  const [modifyEtd, setModifyEtd] = useState('')
  const [modifyCutoff, setModifyCutoff] = useState('')
  const [modifyingFlight, setModifyingFlight] = useState(false)
  const [reassignMode, setReassignMode] = useState(false)
  const [reassignFlightId, setReassignFlightId] = useState('')
  const [reassignConfirmed, setReassignConfirmed] = useState(false)

  // Services modal
  const [showServicesModal, setShowServicesModal] = useState(false)
  const [svcScope, setSvcScope] = useState<'awb' | 'flight'>('awb')
  const [svcAwbKey, setSvcAwbKey] = useState('')
  const [svcServiceName, setSvcServiceName] = useState('')
  const [svcQty, setSvcQty] = useState('1')
  const [svcRateSchedules, setSvcRateSchedules] = useState<AirRateSchedule[]>([])
  const [svcCharges, setSvcCharges] = useState<AirBillingCharge[]>([])
  const [svcLoading, setSvcLoading] = useState(false)
  const [svcSaving, setSvcSaving] = useState(false)

  const canCreate = isAdmin || isSuperAgent || isAgent || isCounter || isClient
  const selectedFlight = flights.find(f => f.id === flightId)
  const flightDestinations = selectedFlight?.destinations || []
  const isFlightDispatched = selectedFlight?.flight_status === 'dispatched' || (!selectedFlight?.flight_status && !!selectedFlight?.dispatched_at)
  const canOpenBooking = !isFlightDispatched || canEdit

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

  // ── Load meta ──
  useEffect(() => {
    if (authLoading) return
    if (!canCreate || !hasAirAccess) { navigate('/airfreight', { replace: true }); return }
    const bookingsQuery = preselectedFlightId
      ? (isClient && clientId
          ? getDocs(query(collection(db, 'airfreight_bookings'),
              where('flight_id', '==', preselectedFlightId),
              where('booking_type', '==', 'export'),
              where('client_id', '==', clientId),
            ))
          : getDocs(query(collection(db, 'airfreight_bookings'),
              where('flight_id', '==', preselectedFlightId),
              where('booking_type', '==', 'export'),
            )))
      : Promise.resolve(null)
    Promise.all([
      getDocs(query(collection(db, 'airfreight_flights'), orderBy('flight_datetime', 'desc'), limit(500))),
      getDocs(query(collection(db, 'airfreight_clients'), limit(500))),
      getDocs(query(collection(db, 'airfreight_destinations'), limit(200))),
      bookingsQuery,
    ]).then(([fSnap, cSnap, dSnap, bSnap]) => {
      const flightList = fSnap.docs
        .map(d => ({ ...d.data() as AirfreightFlight, id: d.id }))
        .filter(f => f.status === 'open' || f.id === preselectedFlightId)
        .sort((a, b) => (b.flight_datetime || '').localeCompare(a.flight_datetime || ''))
      const clientList = cSnap.docs
        .map(d => ({ ...d.data() as AirfreightClient, id: d.id }))
        .filter(c => c.active !== false)
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      setFlights(flightList)
      setClients(clientList)
      setFirestoreDestinations(dSnap.docs.map(d => ({ ...d.data() as AirfreightDestination, id: d.id })))

      // Auto-set client for client users
      if (isClient && clientId) setGlobalClientId(clientId)

      // Load existing export bookings into table (edit mode)
      if (preselectedFlightId && bSnap && bSnap.docs.length > 0) {
        // For clients, only load their own booking
        const bDoc = isClient && clientId
          ? bSnap.docs.find(d => (d.data() as AirfreightBooking).client_id === clientId) || bSnap.docs[0]
          : bSnap.docs[0]
        const b = bDoc.data() as AirfreightBooking
        setEditMode(true)
        setExistingBookingId(bDoc.id)
        setGlobalClientId(b.client_id)

        const loadedRows: ExportRow[] = []
        for (const line of (b.awb_lines || [])) {
          counter.current += 1
          loadedRows.push({
            _id: counter.current,
            destination: line.destination || b.destination_id || '',
            awbNumber: line.awb_number || '',
            pieces: line.pieces?.toString() || '',
            grossWeight: line.weight ? Math.round(line.weight).toString() : '',
            volumeWeight: line.volume_weight ? Math.round(line.volume_weight).toString() : '',
            chargeableWeight: line.chargeable_weight ? Math.round(line.chargeable_weight).toString() : '',
            battery: !!line.battery,
            ddgg: !!line.ddgg,
            cargoSubType: line.cargo_sub_type || '',
            onHand: !!line.on_hand,
            docCount: Object.values(line.documents || {}).filter(Boolean).length + (line.doc_whr ? 1 : 0),
          })
        }
        if (loadedRows.length === 0) {
          counter.current += 1
          loadedRows.push(newExportRow(counter.current))
        }
        setRows(loadedRows)
      } else {
        counter.current += 1
        setRows([newExportRow(counter.current)])
        setBookingLocked(false)
      }
      setLoadingMeta(false)
    }).catch(err => {
      console.error('Error loading export booking data:', err)
      setError('Error al cargar datos')
      setLoadingMeta(false)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading])

  // Close destination dropdown on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (destDropdownRef.current && !destDropdownRef.current.contains(e.target as Node)) setDestDropdownOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Auto-fill empty destinations when flight changes
  useEffect(() => {
    if (!flightDestinations.length) return
    const defaultDest = flightDestinations[0]
    setRows(prev => {
      const needsUpdate = prev.some(r => !r.destination)
      if (!needsUpdate) return prev
      return prev.map(r => r.destination ? r : { ...r, destination: defaultDest })
    })
  }, [flightId, flightDestinations.length])

  // ── Row helpers ──
  function addRow() {
    counter.current += 1
    setRows(prev => [...prev, newExportRow(counter.current, flightDestinations[0] || '')])
  }

  function removeRow(id: number) {
    setRows(prev => {
      const next = prev.filter(r => r._id !== id)
      if (next.length === 0) {
        counter.current += 1
        return [newExportRow(counter.current)]
      }
      return next
    })
  }

  function updateRow(id: number, field: keyof ExportRow, value: any) {
    setRows(prev => prev.map(r => r._id === id ? { ...r, [field]: value } : r))
  }

  // ── Flight creation ──
  async function createFlight() {
    const airline = newAirline === 'Otra' ? newAirlineOther.trim() : newAirline
    if (!airline || !newFlightEtd) { setError('Completa aerolínea y ETD'); return }
    setCreatingFlight(true)
    try {
      const ref = await addDoc(collection(db, 'airfreight_flights'), {
        airline,
        flight_number: newFlightNumber.trim() || null,
        flight_datetime: newFlightEtd,
        cutoff_datetime: newFlightCutoff || null,
        destinations: newFlightDests,
        status: 'open',
        created_by: user?.email || '',
        created_at: new Date().toISOString(),
      })
      const newFlight = {
        id: ref.id,
        airline,
        flight_number: newFlightNumber.trim() || undefined,
        flight_datetime: newFlightEtd,
        cutoff_datetime: newFlightCutoff || undefined,
        destinations: newFlightDests,
        status: 'open' as const,
        created_by: user?.email || '',
        created_at: new Date().toISOString(),
      } as AirfreightFlight & { id: string }
      setFlights(prev => [newFlight, ...prev])
      setFlightId(ref.id)
      setShowNewFlight(false)
      setNewAirline('')
      setNewAirlineOther('')
      setNewFlightNumber('')
      setNewFlightEtd('')
      setNewFlightCutoff('')
      setNewFlightDests([])
    } catch (e) {
      setError('Error creating flight')
    } finally {
      setCreatingFlight(false)
    }
  }

  // ── Edit flight (ETD / CutOff / flight_number) ──
  async function handleSaveFlightEdit() {
    if (!flightId || !editFlightEtd) return
    setSavingFlightEdit(true)
    try {
      const newFn = editFlightNumber.trim() || null
      const newDests = editFlightDests.split(',').map(d => d.trim()).filter(Boolean)
      const updates: Record<string, any> = {
        flight_datetime: editFlightEtd,
        cutoff_datetime: editFlightCutoff || null,
        flight_number: newFn,
      }
      if (newDests.length > 0) updates.destinations = newDests
      await updateDoc(doc(db, 'airfreight_flights', flightId), updates)
      setFlights(prev => prev.map(f =>
        f.id === flightId ? { ...f, ...updates } as any : f
      ))
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
    } catch (e) {
      setError('Error al guardar datos del vuelo')
    } finally {
      setSavingFlightEdit(false)
    }
  }

  // ── Modify flight ──
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
      setReassignConfirmed(false)
    } catch {
      setError('Error al crear el vuelo nuevo')
    } finally {
      setModifyingFlight(false)
    }
  }

  async function handleConfirmReassign() {
    if (!reassignFlightId || !existingBookingId) return
    setSaving(true)
    setError('')
    try {
      const newFl = { flight_number: modifyFlightNumber.trim() || null, airline: modifyAirline === 'Otra' ? modifyAirlineOther : modifyAirline }
      await updateDoc(doc(db, 'airfreight_bookings', existingBookingId), {
        flight_id: reassignFlightId,
        flight_number: newFl.flight_number,
        airline: newFl.airline || '',
      })
      navigate(`/airfreight/bookings/export?flight=${reassignFlightId}`)
      window.location.reload()
    } catch {
      setError('Error al mover booking')
    } finally {
      setSaving(false)
    }
  }

  // ── Services modal ──
  const svcAwbItems: { key: string; label: string; awbIndex: number }[] = (() => {
    if (!existingBookingId) return []
    return rows.map((r, idx) => ({
      key: `${existingBookingId}__${idx}`,
      label: r.awbNumber || `Guia #${idx + 1}`,
      awbIndex: idx,
    }))
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
      const [rateSnap, chargesSnap] = await Promise.all([
        getDocs(collection(db, 'air_rate_schedule')),
        getDocs(query(
          collection(db, 'air_billing_charges'),
          where('flight_id', '==', flightId),
          where('client_id', '==', globalClientId),
          where('source', '==', 'manual'),
          where('status', '==', 'pending'),
        )),
      ])
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
    if (!existingBookingId) { alert('Guarda el booking primero'); return }
    const qty = Number(svcQty) || 1
    setSvcSaving(true)
    try {
      const bSnap = await getDoc(doc(db, 'airfreight_bookings', existingBookingId))
      if (!bSnap.exists()) { alert('Booking no encontrado'); return }
      const booking = { id: bSnap.id, ...bSnap.data() } as AirfreightBooking

      if (svcScope === 'flight') {
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
        if (!svcAwbKey) { alert('Selecciona una guia'); return }
        const item = svcAwbItems.find(i => i.key === svcAwbKey)
        if (!item) { alert('Guia no encontrada'); return }
        const awbLine = booking.awb_lines?.[item.awbIndex] || null
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

  // ── Print ──
  function printBooking() {
    if (!selectedFlight || rows.length === 0) return
    const win = window.open('', '_blank')
    if (!win) return

    const esc = (s: string) =>
      String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))

    const fmtDt = (iso: string) => {
      if (!iso) return '—'
      const [dp, tp] = (iso || '').split('T')
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
    const clientName = clients.find(c => c.id === globalClientId)?.name || ''

    const flagsCell = (r: ExportRow) => {
      const parts: string[] = []
      if (r.battery) parts.push('<span title="Lithium Battery">🔋</span>')
      if (r.ddgg) parts.push('<span title="Dangerous Goods">⚠️</span>')
      if (r.cargoSubType) {
        const label = CARGO_SUB_TYPES.find(t => t.value === r.cargoSubType)?.label || r.cargoSubType
        parts.push(`<span class="flag">${esc(label)}</span>`)
      }
      return parts.join(' ')
    }

    const rowsHtml = rows.map((r, i) => `
      <tr>
        <td class="num">${i + 1}</td>
        <td>${esc(r.destination)}</td>
        <td class="mono">${esc(r.awbNumber)}</td>
        <td class="num">${esc(r.pieces)}</td>
        <td class="num">${r.grossWeight ? fmtNum(Number(r.grossWeight), 1) : '—'}</td>
        <td class="num">${r.volumeWeight ? fmtNum(Number(r.volumeWeight), 1) : '—'}</td>
        <td class="num">${r.chargeableWeight ? fmtNum(Number(r.chargeableWeight), 1) : '—'}</td>
        <td class="flags">${flagsCell(r)}</td>
        <td class="num">${r.onHand ? 'YES' : '—'}</td>
      </tr>`).join('')

    const title = `Export Booking · ${flightLine} · ${(etd || '').split(' ')[0]}`

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
  tbody td.flags { font-size: 10px; white-space: nowrap; }
  .flag { display: inline-block; padding: 1px 5px; border-radius: 3px; background: #e5e7eb; color: #374151; font-weight: 600; font-size: 9px; }
  tfoot td { padding: 8px 6px; border-top: 2px solid #1a3b5c; font-weight: 700; font-size: 11px; background: #f8fafc; }
  tfoot td.num { text-align: center; }
</style>
</head>
<body>
  <div class="header">
    <div>
      <div class="brand">MinCurl Logistics</div>
      <div class="brand-sub">Export Booking Detail — Air Freight</div>
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
        <th style="width:120px">AWB #</th>
        <th class="num" style="width:48px">PCS</th>
        <th class="num" style="width:56px">GW</th>
        <th class="num" style="width:56px">VW</th>
        <th class="num" style="width:56px">CHW</th>
        <th>FLAGS</th>
        <th class="num" style="width:40px">O.H.</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="3" style="text-align:right">TOTAL · ${rows.length} guia${rows.length !== 1 ? 's' : ''}</td>
        <td class="num">${fmtNum(totals.pieces)}</td>
        <td class="num">${fmtNum(totals.gw, 1)}</td>
        <td class="num">${fmtNum(totals.vw, 1)}</td>
        <td class="num">${fmtNum(totals.chw, 1)}</td>
        <td></td>
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

  // ── Excel upload ──
  function parseExcelRow(row: any) {
    const gw = Number(row['GW'] || row['GROSS WEIGHT'] || row['WEIGHT'] || 0)
    const vw = Number(row['VW'] || row['VOLUME WEIGHT'] || row['VOL WEIGHT'] || 0)
    const chw = Number(row['CHW'] || row['CHARGEABLE WEIGHT'] || row['CW'] || 0) || Math.max(gw, vw)
    counter.current += 1
    return {
      _id: counter.current,
      destination: String(row['DEST'] || row['DESTINATION'] || row['DST'] || '').trim().toUpperCase(),
      awbNumber: fmtAwb(String(row['AWB'] || row['AWB#'] || row['AWB NUMBER'] || row['HAWB'] || '')),
      pieces: String(row['PCS'] || row['PIECES'] || row['QTY'] || ''),
      grossWeight: gw ? Math.round(gw).toString() : '',
      volumeWeight: vw ? Math.round(vw).toString() : '',
      chargeableWeight: chw ? Math.round(chw).toString() : '',
      battery: isYes(String(row['BATTERY'] || row['LB'] || row['BAT'] || '')),
      ddgg: isYes(String(row['DG'] || row['DDGG'] || row['DANGEROUS'] || '')),
      cargoSubType: (() => {
        const t = String(row['TYPE'] || row['CARGO TYPE'] || '').trim().toLowerCase()
        if (t.includes('bonded') && t.includes('local')) return 'bonded_local'
        if (t.includes('bonded') || t === 'b') return 'bonded'
        if (t.includes('local') || t === 'l') return 'local'
        return ''
      })(),
      onHand: false,
      docCount: 0,
      // Extra fields for bulk mode
      _flight: String(row['FLIGHT'] || row['FLIGHT NUMBER'] || row['FLIGHT#'] || row['VUELO'] || '').trim(),
      _etd: String(row['ETD'] || row['DEPARTURE'] || row['FECHA'] || '').trim(),
      _airline: String(row['AIRLINE'] || row['AEROLINEA'] || '').trim(),
    }
  }

  /** Parse ETD date string from Excel. Returns ISO datetime at 02:00 local. */
  function parseEtdToDatetime(raw: string): string {
    // Try various date formats
    let d: Date | null = null
    // YYYY-MM-DD or YYYY/MM/DD
    const isoMatch = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
    if (isoMatch) {
      d = new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]))
    }
    // MM/DD/YYYY or MM-DD-YYYY
    if (!d) {
      const usMatch = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/)
      if (usMatch) d = new Date(Number(usMatch[3]), Number(usMatch[1]) - 1, Number(usMatch[2]))
    }
    // Mon/DD e.g. "Apr/07" or "Mar/03" — assume current year
    if (!d) {
      const monMatch = raw.match(/^([A-Za-z]{3})[-/](\d{1,2})/)
      if (monMatch) {
        const months: Record<string, number> = {
          jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
          jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
        }
        const mi = months[monMatch[1].toLowerCase()]
        if (mi !== undefined) d = new Date(new Date().getFullYear(), mi, Number(monMatch[2]))
      }
    }
    // Excel serial number
    if (!d && /^\d{5}/.test(raw)) {
      const serial = Number(raw)
      if (serial > 40000 && serial < 60000) {
        d = new Date((serial - 25569) * 86400000)
      }
    }
    if (!d || isNaN(d.getTime())) return ''
    // ETD at 02:00
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}T02:00:00`
  }

  /** Given ETD date string, compute cutoff: day before at 20:00 */
  function cutoffFromEtd(etdDatetime: string): string {
    const d = new Date(etdDatetime)
    d.setDate(d.getDate() - 1)
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}T20:00:00`
  }

  /** Detect airline from flight number prefix */
  function detectAirline(flightNum: string): string {
    const prefix = flightNum.slice(0, 2).toUpperCase()
    if (prefix === 'XL') return 'LATAM'
    if (prefix === 'AV') return 'Avianca'
    if (prefix === 'AA') return 'American Airlines'
    if (prefix === 'UA') return 'United Airlines'
    if (prefix === 'CM') return 'Copa Airlines'
    if (prefix === 'DL') return 'Delta Air Lines'
    return ''
  }

  function handleExcelUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadingExcel(true)
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const wb = XLSX.read(ev.target?.result, { type: 'binary' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const data = XLSX.utils.sheet_to_json<any>(ws, { defval: '' })
        if (data.length === 0) { setError('Excel vacío'); return }

        const parsed = data.map(parseExcelRow)
        const hasFlight = parsed.some(r => r._flight)

        if (hasFlight && globalClientId) {
          // Bulk mode: create flights + bookings automatically
          handleBulkUpload(parsed)
        } else {
          // Single-flight mode (original behavior)
          setRows(parsed)
        }
      } catch (err) {
        setError('Error al leer el Excel')
      } finally {
        setUploadingExcel(false)
        if (excelInputRef.current) excelInputRef.current.value = ''
      }
    }
    reader.readAsBinaryString(file)
  }

  async function handleBulkUpload(parsed: (ExportRow & { _flight: string; _etd: string; _airline: string })[]) {
    if (!globalClientId) { setError('Selecciona un cliente antes de subir el Excel'); return }
    const client = clients.find(c => c.id === globalClientId)
    const createdBy = user?.email || user?.uid || ''
    const now = new Date().toISOString()

    // Group by flight number + ETD date
    const groups = new Map<string, typeof parsed>()
    for (const row of parsed) {
      if (!row.awbNumber || !row._flight) continue
      const etdDt = parseEtdToDatetime(row._etd)
      if (!etdDt) continue
      const groupKey = `${row._flight}__${etdDt.slice(0, 10)}`
      if (!groups.has(groupKey)) groups.set(groupKey, [])
      groups.get(groupKey)!.push(row)
    }

    if (groups.size === 0) { setError('No se encontraron filas válidas con vuelo y AWB'); return }

    // Load all existing flights to check for duplicates
    const existingFlightsSnap = await getDocs(collection(db, 'airfreight_flights'))
    const existingFlights = existingFlightsSnap.docs.map(d => ({ id: d.id, ...d.data() as AirfreightFlight }))

    setSaving(true)
    setError('')
    try {
      let createdFlights = 0
      let createdBookings = 0
      let updatedBookings = 0

      for (const [, groupRows] of groups) {
        const firstRow = groupRows[0]
        const flightNum = firstRow._flight
        const airline = firstRow._airline || detectAirline(flightNum)
        const etdDatetime = parseEtdToDatetime(firstRow._etd)
        if (!etdDatetime) continue

        const etdDate = etdDatetime.slice(0, 10)

        // Check if flight already exists (same flight_number + same date)
        let flightDocId: string | null = null
        const existing = existingFlights.find(f =>
          f.flight_number === flightNum &&
          (f.flight_datetime || '').slice(0, 10) === etdDate
        )

        if (existing) {
          flightDocId = existing.id
          // Add destination if missing
          const dests = new Set(existing.destinations || [])
          for (const r of groupRows) { if (r.destination) dests.add(r.destination) }
          const newDests = [...dests]
          if (newDests.length > (existing.destinations || []).length) {
            await updateDoc(doc(db, 'airfreight_flights', flightDocId), { destinations: newDests })
          }
        } else {
          // Create new flight
          const cutoffDatetime = cutoffFromEtd(etdDatetime)
          const flightRef = await addDoc(collection(db, 'airfreight_flights'), {
            airline,
            flight_number: flightNum,
            flight_datetime: etdDatetime,
            cutoff_datetime: cutoffDatetime,
            destinations: [...new Set(groupRows.map(r => r.destination).filter(Boolean))],
            status: 'open',
            created_by: createdBy,
            created_at: now,
          })
          flightDocId = flightRef.id
          // Add to local list so subsequent groups can find it
          existingFlights.push({
            id: flightDocId,
            flight_number: flightNum,
            flight_datetime: etdDatetime,
            airline,
            destinations: [...new Set(groupRows.map(r => r.destination).filter(Boolean))],
          } as any)
          createdFlights++
        }

        // Build AWB lines
        const awbLines: AwbSecondLeg[] = groupRows.map(r => ({
          awb_number: r.awbNumber.trim(),
          destination: r.destination || groupRows[0].destination || '',
          pieces: r.pieces ? Number(r.pieces) : 0,
          weight: r.grossWeight ? Number(r.grossWeight) : 0,
          volume_weight: r.volumeWeight ? Number(r.volumeWeight) : 0,
          chargeable_weight: r.chargeableWeight ? Number(r.chargeableWeight) : 0,
          battery: r.battery,
          ddgg: r.ddgg,
          cargo_sub_type: (r.cargoSubType || null) as any,
          on_hand: false,
        }))

        const totalPieces = awbLines.reduce((s, l) => s + (l.pieces || 0), 0)

        // Check if booking already exists for this client + flight
        const existingBookingSnap = await getDocs(query(
          collection(db, 'airfreight_bookings'),
          where('flight_id', '==', flightDocId),
          where('client_id', '==', globalClientId),
          where('booking_type', '==', 'export'),
        ))

        if (existingBookingSnap.docs.length > 0) {
          // Update existing booking — merge AWB lines (avoid duplicating same AWB)
          const existingBooking = existingBookingSnap.docs[0]
          const existingLines = (existingBooking.data().awb_lines || []) as AwbSecondLeg[]
          const existingAwbs = new Set(existingLines.map(l => l.awb_number))
          const newLines = awbLines.filter(l => !existingAwbs.has(l.awb_number))
          if (newLines.length > 0) {
            const merged = [...existingLines, ...newLines]
            const mergedPieces = merged.reduce((s, l) => s + (l.pieces || 0), 0)
            await updateDoc(doc(db, 'airfreight_bookings', existingBooking.id), {
              awb_lines: merged,
              pieces: mergedPieces,
              ...awbIndexField({ booking_type: 'export', awb_lines: merged }),
            })
            updatedBookings++
          }
        } else {
          // Create new booking
          await addDoc(collection(db, 'airfreight_bookings'), {
            flight_id: flightDocId,
            flight_number: flightNum,
            airline,
            status: 'submitted',
            created_by: createdBy,
            created_at: now,
            change_count: 0,
            modified_seen: true,
            change_log: [],
            documents: {},
            booking_type: 'export',
            client_id: globalClientId,
            client_name: client?.name || '',
            destination_id: awbLines[0]?.destination || '',
            awb_lines: awbLines,
            pieces: totalPieces,
            ...awbIndexField({ booking_type: 'export', awb_lines: awbLines }),
          })
          createdBookings++
        }
      }

      const parts: string[] = []
      if (createdFlights > 0) parts.push(`${createdFlights} vuelo(s) creado(s)`)
      if (createdBookings > 0) parts.push(`${createdBookings} booking(s) creado(s)`)
      if (updatedBookings > 0) parts.push(`${updatedBookings} booking(s) actualizado(s)`)
      alert(`Bulk upload completo: ${parts.join(', ') || 'sin cambios (datos ya existentes)'}`)
      navigate('/airfreight')
    } catch (err) {
      console.error('Bulk upload error:', err)
      setError('Error en bulk upload: ' + (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  // ── Save ──
  async function handleSave() {
    if (!flightId) { setError('Selecciona o crea un vuelo primero'); return }
    if (!globalClientId) { setError('Selecciona un cliente'); return }
    const valid = rows.filter(r => r.destination && r.awbNumber)
    if (valid.length === 0) { setError('Completa al menos una línea con destino y AWB'); return }

    setSaving(true)
    setError('')
    try {
      const fl = flights.find(f => f.id === flightId)
      const client = clients.find(c => c.id === globalClientId)
      const now = new Date().toISOString()
      const createdBy = user?.email || user?.uid || ''

      // Preserve existing data (docs, scans, etc.)
      let existingLines: any[] = []
      if (existingBookingId) {
        const existSnap = await getDoc(doc(db, 'airfreight_bookings', existingBookingId))
        if (existSnap.exists()) {
          existingLines = (existSnap.data() as any).awb_lines || []
        }
      }

      const awbLines: AwbSecondLeg[] = valid.map((r) => {
        const existing = existingLines.find((el: any) => el.awb_number === r.awbNumber.trim()) || {}
        return {
          awb_number: r.awbNumber.trim(),
          destination: r.destination,
          pieces: r.pieces ? Number(r.pieces) : 0,
          weight: r.grossWeight ? Number(r.grossWeight) : 0,
          volume_weight: r.volumeWeight ? Number(r.volumeWeight) : 0,
          chargeable_weight: r.chargeableWeight ? Number(r.chargeableWeight) : 0,
          battery: r.battery,
          ddgg: r.ddgg,
          cargo_sub_type: (r.cargoSubType || null) as any,
          on_hand: r.onHand,
          // Preserve existing data
          ...(existing.documents ? { documents: existing.documents } : {}),
          ...(existing.doc_whr ? { doc_whr: existing.doc_whr } : {}),
          ...(existing.dispatched !== undefined ? { dispatched: existing.dispatched } : {}),
          ...(existing.dispatched_at ? { dispatched_at: existing.dispatched_at } : {}),
          ...(existing.dispatched_by ? { dispatched_by: existing.dispatched_by } : {}),
          ...(existing.audit_log ? { audit_log: existing.audit_log } : {}),
        }
      })

      const totalPieces = valid.reduce((s, r) => s + (Number(r.pieces) || 0), 0)

      if (existingBookingId) {
        await updateDoc(doc(db, 'airfreight_bookings', existingBookingId), {
          client_id: globalClientId,
          client_name: client?.name || '',
          destination_id: valid[0].destination,
          awb_lines: awbLines,
          pieces: totalPieces,
          ...awbIndexField({ booking_type: 'export', awb_lines: awbLines }),
        })
      } else {
        await addDoc(collection(db, 'airfreight_bookings'), {
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
          booking_type: 'export',
          client_id: globalClientId,
          client_name: client?.name || '',
          destination_id: valid[0].destination,
          awb_lines: awbLines,
          pieces: totalPieces,
          ...awbIndexField({ booking_type: 'export', awb_lines: awbLines }),
        })
      }

      navigate('/airfreight')
    } catch (err) {
      console.error(err)
      setError('Error al guardar el booking')
    } finally {
      setSaving(false)
    }
  }

  // ── Totals ──
  const totals = rows.reduce((acc, r) => ({
    pieces: acc.pieces + (Number(r.pieces) || 0),
    gw: acc.gw + (Number(r.grossWeight) || 0),
    vw: acc.vw + (Number(r.volumeWeight) || 0),
    chw: acc.chw + (Number(r.chargeableWeight) || 0),
  }), { pieces: 0, gw: 0, vw: 0, chw: 0 })

  if (authLoading || loadingMeta) {
    return (
      <Layout title="New Export Booking" backTo="/airfreight">
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-mcl-blue" />
        </div>
      </Layout>
    )
  }

  const locked = editMode && bookingLocked

  return (
    <Layout title="New Export Booking" backTo="/airfreight">
      <div className="space-y-4">
        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* ── Lock bar (edit mode) ── */}
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
                  <button onClick={() => setBookingLocked(false)}
                    className="text-xs bg-mcl-blue text-white px-4 py-1.5 rounded-lg hover:bg-blue-900 transition-colors font-semibold">
                    Open Booking
                  </button>
                ) : (
                  <span className="text-xs text-gray-400">Vuelo cerrado (Dispatched)</span>
                )}
              </>
            ) : (
              <>
                <span className="text-amber-800 font-medium">
                  Modo edición — los cambios reemplazarán el booking existente
                </span>
                <span className="text-amber-600 text-xs">{rows.length} fila{rows.length !== 1 ? 's' : ''}</span>
              </>
            )}
          </div>
        )}

        {/* ── Flight + Client + Actions ── */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-700">Vuelo</span>
            <div className="flex items-center gap-3">
              {!editMode && !showNewFlight && (
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
              {editMode && !showModifyFlight && !reassignMode && (
                <button onClick={() => setShowModifyFlight(true)}
                  className="text-xs text-orange-600 hover:underline font-medium">
                  Mover AWB a nuevo Vuelo
                </button>
              )}
              {showNewFlight && (
                <button onClick={() => setShowNewFlight(false)} className="text-xs text-gray-400 hover:underline">Cancelar</button>
              )}
              {showModifyFlight && (
                <button onClick={() => { setShowModifyFlight(false); setModifyAirline(''); setModifyFlightNumber(''); setModifyEtd('') }}
                  className="text-xs text-gray-400 hover:underline">Cancelar</button>
              )}
            </div>
          </div>

          {showNewFlight ? (
            <div className="space-y-3 border border-blue-100 rounded-lg p-3 bg-blue-50/30">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Aerolínea</label>
                  <select value={newAirline} onChange={e => setNewAirline(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm">
                    <option value="">Seleccionar...</option>
                    {AIRLINES.map(a => <option key={a} value={a}>{a}</option>)}
                  </select>
                  {newAirline === 'Otra' && (
                    <input value={newAirlineOther} onChange={e => setNewAirlineOther(e.target.value)}
                      placeholder="Nombre" className="mt-1 w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm" />
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Vuelo #</label>
                  <input value={newFlightNumber} onChange={e => setNewFlightNumber(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">ETD</label>
                  <input type="datetime-local" value={newFlightEtd} onChange={e => setNewFlightEtd(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Cut Off</label>
                  <input type="datetime-local" value={newFlightCutoff} onChange={e => setNewFlightCutoff(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm" />
                </div>
              </div>
              <div ref={destDropdownRef} className="relative">
                <label className="block text-xs font-medium text-gray-600 mb-1">Destinos</label>
                <div className="flex flex-wrap gap-1 mb-1">
                  {newFlightDests.map(d => (
                    <span key={d} className="bg-blue-100 text-blue-800 text-xs px-2 py-0.5 rounded-full flex items-center gap-1">
                      {d}
                      <button onClick={() => setNewFlightDests(prev => prev.filter(x => x !== d))} className="text-blue-400 hover:text-blue-700">×</button>
                    </span>
                  ))}
                </div>
                <input
                  value={destSearch}
                  onChange={e => { setDestSearch(e.target.value); setDestDropdownOpen(true) }}
                  onFocus={() => setDestDropdownOpen(true)}
                  placeholder="Buscar destino..."
                  className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm"
                />
                {destDropdownOpen && (
                  <div className="absolute z-10 mt-1 w-full max-h-40 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg">
                    {filteredAirports.filter(a => !newFlightDests.includes(a.code)).map(a => (
                      <button key={a.code} onClick={() => { setNewFlightDests(prev => [...prev, a.code]); setDestSearch(''); setDestDropdownOpen(false) }}
                        className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50">
                        {a.code} — {a.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <button onClick={createFlight} disabled={creatingFlight}
                  className="text-xs bg-mcl-blue text-white px-4 py-2 rounded-lg hover:bg-blue-900 disabled:opacity-50">
                  {creatingFlight ? 'Creando...' : 'Crear vuelo'}
                </button>
                <button onClick={() => setShowNewFlight(false)}
                  className="text-xs border border-gray-200 px-4 py-2 rounded-lg text-gray-600 hover:bg-gray-50">
                  Cancelar
                </button>
              </div>
            </div>
          ) : (
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
                  <select value={flightId} onChange={e => setFlightId(e.target.value)}
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

              <div className="min-w-44">
                <label className="block text-xs text-gray-400 mb-1">CLIENTE</label>
                {editMode ? (
                  <div className="px-3 py-2 text-sm text-gray-700 bg-gray-50 rounded-lg border border-gray-200">
                    {clients.find(c => c.id === globalClientId)?.name || globalClientId || '—'}
                  </div>
                ) : (
                  <select value={globalClientId} onChange={e => setGlobalClientId(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30">
                    <option value="">Seleccionar cliente...</option>
                    {clients.map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                )}
              </div>

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
                <div className="w-full border border-orange-200 bg-orange-50/40 rounded-xl p-4 mt-3 space-y-3">
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
                  {modifyingFlight ? 'Creando...' : 'Crear vuelo y mover booking'}
                </button>
              </div>
            </div>
          )}

          {/* ── REASSIGN MODE ── */}
          {reassignMode && (
            <div className="border border-orange-200 bg-orange-50 rounded-xl p-4 space-y-3">
              <p className="text-sm font-semibold text-orange-800">Mover este booking export al vuelo nuevo?</p>
              <div className="flex items-center gap-3 px-3 py-2 bg-white rounded-lg border border-gray-100">
                <span className="font-mono text-xs font-semibold text-gray-700 flex-1">
                  {clients.find(c => c.id === globalClientId)?.name || '—'} · {rows.length} guia{rows.length !== 1 ? 's' : ''}
                </span>
                <span className="text-xs text-gray-400">{fmtNum(totals.pieces)} pcs · {fmtNum(totals.chw)} chw</span>
              </div>
              <div className="flex items-center justify-between pt-1">
                <button type="button" onClick={() => { setReassignMode(false); setReassignFlightId('') }}
                  className="text-xs text-gray-400 hover:underline">Cancelar</button>
                <button type="button" onClick={handleConfirmReassign}
                  disabled={saving}
                  className="px-5 py-2 bg-orange-600 text-white text-sm font-semibold rounded-lg hover:bg-orange-700 disabled:opacity-50">
                  {saving ? 'Moviendo...' : 'Mover al vuelo nuevo'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── Action bar: + Agregar línea, Subir Excel ── */}
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={addRow} disabled={locked}
            className="text-xs bg-green-600 text-white px-3 py-1.5 rounded-lg hover:bg-green-700 disabled:opacity-50">
            + Agregar línea
          </button>
          <input ref={excelInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleExcelUpload} />
          <button
            onClick={() => excelInputRef.current?.click()}
            disabled={locked || uploadingExcel}
            className="text-xs bg-green-600 text-white px-3 py-1.5 rounded-lg hover:bg-green-700 disabled:opacity-50"
          >
            {uploadingExcel ? 'Procesando...' : 'Subir Excel'}
          </button>
          <div className="flex-1" />
          <span className="text-xs text-gray-400">
            {rows.filter(r => r.awbNumber).length} líneas
          </span>
        </div>

        {/* ── Table ── */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-50 text-gray-500 uppercase tracking-wide">
                <th className="px-2 py-2 text-center" style={{ width: 28 }}>#</th>
                <th className="px-2 py-2 text-center">DEST</th>
                <th className="px-2 py-2 text-center">AWB #</th>
                <th className="px-2 py-2 text-center">PCS</th>
                <th className="px-2 py-2 text-center">GW</th>
                <th className="px-2 py-2 text-center">VW</th>
                <th className="px-2 py-2 text-center">CHW</th>
                <th className="px-2 py-2 text-center" title="Lithium Battery" style={{ width: 28 }}>🔋</th>
                <th className="px-2 py-2 text-center" title="Dangerous Goods" style={{ width: 28 }}>⚠️</th>
                <th className="px-2 py-2 text-center">TYPE</th>
                <th className="px-2 py-2 text-center" title="Documents" style={{ width: 28 }}>DOCS</th>
                <th className="px-2 py-2 text-center" title="Upload" style={{ width: 28 }}>UP</th>
                <th className="px-2 py-2 text-center" style={{ width: 28 }}>O.H.</th>
                <th className="px-2 py-2" style={{ width: 28 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => (
                <tr key={r._id} className="border-t border-gray-50 hover:bg-gray-50/50">
                  <td className="px-1 py-1.5 text-center text-gray-400" style={{ width: 28 }}>{idx + 1}</td>
                  <td className="px-1 py-1.5 text-center" style={{ width: 70 }}>
                    <select
                      value={r.destination}
                      onChange={e => updateRow(r._id, 'destination', e.target.value)}
                      disabled={locked}
                      className="w-full border border-gray-200 rounded px-1 py-1 text-xs text-center"
                    >
                      <option value="">—</option>
                      {allAirports.map(a => (
                        <option key={a.code} value={a.code}>{a.code}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-1 py-1.5 text-center">
                    <input
                      value={r.awbNumber}
                      onChange={e => updateRow(r._id, 'awbNumber', fmtAwb(e.target.value))}
                      disabled={locked}
                      placeholder="000-00000000"
                      className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs font-mono text-center"
                    />
                  </td>
                  <td className="px-1 py-1.5 text-center" style={{ width: 65 }}>
                    <input
                      type="number"
                      value={r.pieces}
                      onChange={e => updateRow(r._id, 'pieces', e.target.value)}
                      disabled={locked}
                      className="w-full border border-gray-200 rounded px-1 py-1 text-xs text-center"
                    />
                  </td>
                  <td className="px-1 py-1.5 text-center" style={{ width: 75 }}>
                    <input
                      type="number"
                      value={r.grossWeight}
                      onChange={e => updateRow(r._id, 'grossWeight', e.target.value)}
                      disabled={locked}
                      className="w-full border border-gray-200 rounded px-1 py-1 text-xs text-center"
                    />
                  </td>
                  <td className="px-1 py-1.5 text-center" style={{ width: 75 }}>
                    <input
                      type="number"
                      value={r.volumeWeight}
                      onChange={e => updateRow(r._id, 'volumeWeight', e.target.value)}
                      disabled={locked}
                      className="w-full border border-gray-200 rounded px-1 py-1 text-xs text-center"
                    />
                  </td>
                  <td className="px-1 py-1.5 text-center" style={{ width: 75 }}>
                    <input
                      type="number"
                      value={r.chargeableWeight}
                      onChange={e => updateRow(r._id, 'chargeableWeight', e.target.value)}
                      disabled={locked}
                      className="w-full border border-gray-200 rounded px-1 py-1 text-xs text-center"
                    />
                  </td>
                  <td className="px-1 py-1.5 text-center" style={{ width: 28 }}>
                    <input
                      type="checkbox"
                      checked={r.battery}
                      onChange={e => updateRow(r._id, 'battery', e.target.checked)}
                      disabled={locked}
                      className="rounded"
                    />
                  </td>
                  <td className="px-1 py-1.5 text-center" style={{ width: 28 }}>
                    <input
                      type="checkbox"
                      checked={r.ddgg}
                      onChange={e => updateRow(r._id, 'ddgg', e.target.checked)}
                      disabled={locked}
                      className="rounded"
                    />
                  </td>
                  <td className="px-1 py-1.5 text-center">
                    <select
                      value={r.cargoSubType}
                      onChange={e => updateRow(r._id, 'cargoSubType', e.target.value)}
                      disabled={locked}
                      className="w-full border border-gray-200 rounded px-1 py-1 text-xs text-center"
                    >
                      <option value="">—</option>
                      {CARGO_SUB_TYPES.map(t => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </select>
                  </td>
                  {/* DOCS indicator */}
                  <td className="px-1 py-1.5 text-center" style={{ width: 28 }}>
                    <span
                      title={r.docCount > 0 ? `${r.docCount} doc(s)` : 'No docs'}
                      className={`inline-block w-4 h-4 rounded-full ${r.docCount > 0 ? 'bg-green-500' : 'bg-gray-200'}`}
                    />
                  </td>
                  {/* UPLOAD — navigate to docs page */}
                  <td className="px-1 py-1.5 text-center" style={{ width: 28 }}>
                    <button
                      type="button"
                      title={existingBookingId ? 'Upload documents' : 'Guarda el booking primero'}
                      disabled={!existingBookingId}
                      onClick={() => {
                        if (!existingBookingId) return
                        const params = new URLSearchParams({ booking: existingBookingId })
                        if (r.awbNumber) params.set('awb', r.awbNumber)
                        navigate(`/airfreight/docs?${params}`)
                      }}
                      className={existingBookingId ? 'text-gray-400 hover:text-mcl-blue transition-colors' : 'text-gray-200 cursor-not-allowed'}
                    >
                      <svg className="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                      </svg>
                    </button>
                  </td>
                  {/* O.H. */}
                  <td className="px-1 py-1.5 text-center" style={{ width: 28 }}>
                    <button
                      onClick={() => !locked && updateRow(r._id, 'onHand', !r.onHand)}
                      disabled={locked}
                      className={`w-5 h-5 rounded-full border-2 ${r.onHand ? 'bg-green-500 border-green-500' : 'bg-white border-gray-300'}`}
                    />
                  </td>
                  <td className="px-1 py-1.5 text-center" style={{ width: 28 }}>
                    <button
                      onClick={() => removeRow(r._id)}
                      disabled={locked}
                      className="text-red-400 hover:text-red-600 disabled:opacity-30"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
              {/* Totals */}
              <tr className="border-t-2 border-gray-200 bg-gray-50 font-semibold">
                <td className="px-2 py-2 text-center" colSpan={3}>TOTAL</td>
                <td className="px-2 py-2 text-center">{fmtNum(totals.pieces)}</td>
                <td className="px-2 py-2 text-center">{fmtNum(totals.gw)}</td>
                <td className="px-2 py-2 text-center">{fmtNum(totals.vw)}</td>
                <td className="px-2 py-2 text-center">{fmtNum(totals.chw)}</td>
                <td colSpan={7}></td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* ── Save ── */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => navigate('/airfreight')}
            className="text-sm px-4 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
          >
            Cancelar
          </button>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400">
              {rows.filter(r => r.destination && r.awbNumber).length} booking{rows.filter(r => r.destination && r.awbNumber).length !== 1 ? 's' : ''} listo{rows.filter(r => r.destination && r.awbNumber).length !== 1 ? 's' : ''}
            </span>
            <button
              onClick={handleSave}
              disabled={saving || locked}
              className="text-sm px-6 py-2 rounded-lg bg-mcl-blue text-white hover:bg-blue-900 disabled:opacity-50"
            >
              {saving ? 'Guardando...' : editMode ? 'Actualizar bookings' : 'Guardar bookings'}
            </button>
          </div>
        </div>
      </div>

      {/* ── Services Modal ── */}
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
    </Layout>
  )
}
