import { useState, useEffect, useRef, useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  collection, query, where, getDocs, addDoc, doc, getDoc, updateDoc, orderBy, runTransaction,
} from 'firebase/firestore'
import { ref as fbRef, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import { AirfreightBooking, AirfreightFlight, AwbSecondLeg, AirfreightClient } from '../../types'
import { normalizeAwb, computeAwbNumbersNormalized } from '../../lib/awbNormalize'
import Layout from '../../components/Layout'

interface BookingMatch {
  booking: AirfreightBooking & { id: string }
  flight: AirfreightFlight & { id: string }
  awbLine: AwbSecondLeg
  awbIndex: number
  awb1stLeg: string
  mawbNumber: string | null
}

export default function AirfreightDocReceptionNew() {
  const { id } = useParams()
  const isEdit = !!id
  const navigate = useNavigate()
  const { user } = useAuth()

  // Step 1: AWB search
  const [awbSearch, setAwbSearch] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [bookingMatch, setBookingMatch] = useState<BookingMatch | null>(null)

  // Step 2: Guide data (from booking)
  const [awbNumber, setAwbNumber] = useState('')
  const [mawbNumber, setMawbNumber] = useState('')
  const [awb1stLeg, setAwb1stLeg] = useState('')
  const [awb2ndLeg, setAwb2ndLeg] = useState('')
  const [clientName, setClientName] = useState('')
  const [shipperName, setShipperName] = useState('')
  const [consigneeName, setConsigneeName] = useState('')
  const [destination, setDestination] = useState('')
  const [pieces, setPieces] = useState(0)
  const [weight, setWeight] = useState(0)
  const [chargeableWeight, setChargeableWeight] = useState(0)
  const [uldNumber, setUldNumber] = useState('')
  const [cargoTypeLabel, setCargoTypeLabel] = useState('General')
  const [warehouseType, setWarehouseType] = useState<'bonded' | 'local'>('bonded')
  const [hasLB, setHasLB] = useState(false)
  const [hasDG, setHasDG] = useState(false)
  const [editingGuide, setEditingGuide] = useState(false)
  const [flightNumber, setFlightNumber] = useState('')

  // No-booking mode
  const [noBookingMode, setNoBookingMode] = useState(false)
  const [awbNotFound, setAwbNotFound] = useState(false)
  const [editMissingFlight, setEditMissingFlight] = useState(false)
  const [existingStatus, setExistingStatus] = useState<string | null>(null)
  const [existingFlightId, setExistingFlightId] = useState<string | null>(null)

  // Flight assignment (no-booking mode or edit without flight)
  const [flightOption, setFlightOption] = useState<'existing' | 'new' | 'none'>('none')
  const [flights, setFlights] = useState<(AirfreightFlight & { id: string })[]>([])
  const [selectedFlightId, setSelectedFlightId] = useState('')
  const [newFlightNumber, setNewFlightNumber] = useState('')
  const [newFlightCarrier, setNewFlightCarrier] = useState('')
  const [newFlightDate, setNewFlightDate] = useState('')
  const [newFlightDestination, setNewFlightDestination] = useState('')
  const [clientNames, setClientNames] = useState<string[]>([])
  const [clientsRequiringAgent, setClientsRequiringAgent] = useState<Set<string>>(new Set())
  const [clientIdMap, setClientIdMap] = useState<Map<string, string>>(new Map())
  const [agentName, setAgentName] = useState('')

  // Shipper/Consignee entries (full data for client filtering)
  const [allScEntries, setAllScEntries] = useState<{ type: string; client_name: string; short_name: string }[]>([])
  const [legacyShippers, setLegacyShippers] = useState<string[]>([])
  const [legacyConsignees, setLegacyConsignees] = useState<string[]>([])
  const [shipperMode, setShipperMode] = useState<'select' | 'manual'>('select')
  const [consigneeMode, setConsigneeMode] = useState<'select' | 'manual'>('select')

  // Step 3: Cargo type
  const [cargoType, setCargoType] = useState<'loose' | 'bup'>('loose')
  const [bupNumber, setBupNumber] = useState('')

  // Step 4: Driver
  const [driverName, setDriverName] = useState('')
  const [driverIdNumber, setDriverIdNumber] = useState('')
  const [driverPlate, setDriverPlate] = useState('')
  const [driverCompany, setDriverCompany] = useState('')

  // Step 5: Documents
  const [driverIdFile, setDriverIdFile] = useState<File | null>(null)
  const [driverIdPreview, setDriverIdPreview] = useState<string | null>(null)
  const [awbCopyFile, setAwbCopyFile] = useState<File | null>(null)
  const [awbCopyPreview, setAwbCopyPreview] = useState<string | null>(null)
  const driverIdRef = useRef<HTMLInputElement>(null)
  const awbCopyRef = useRef<HTMLInputElement>(null)

  // Step 6: Observations
  const [observations, setObservations] = useState('')

  // Save state
  const [saving, setSaving] = useState(false)

  // Filtered shippers/consignees by selected client
  const shippers = useMemo(() => {
    const fromSc = allScEntries
      .filter(e => e.type === 'shipper' && (!clientName || !e.client_name || e.client_name === clientName))
      .map(e => e.short_name)
    return [...new Set([...fromSc, ...legacyShippers])].sort()
  }, [allScEntries, legacyShippers, clientName])

  const consignees = useMemo(() => {
    const fromSc = allScEntries
      .filter(e => e.type === 'consignee' && (!clientName || !e.client_name || e.client_name === clientName))
      .map(e => e.short_name)
    return [...new Set([...fromSc, ...legacyConsignees])].sort()
  }, [allScEntries, legacyConsignees, clientName])

  // Load shippers/consignees from airfreight clients
  useEffect(() => {
    loadClientsData()
  }, [])

  useEffect(() => {
    if (isEdit) loadReception()
  }, [id])

  async function loadClientsData() {
    const [snap, scSnap, shipperSnap, consigneeSnap, flightsSnap] = await Promise.all([
      getDocs(query(collection(db, 'airfreight_clients'), where('active', '==', true))),
      getDocs(collection(db, 'airfreight_shippers_consignees')),
      getDocs(collection(db, 'airfreight_shippers')),
      getDocs(collection(db, 'airfreight_consignees')),
      getDocs(query(collection(db, 'airfreight_flights'), where('status', '==', 'open'))),
    ])
    const clients = snap.docs.map(d => ({ ...d.data() as AirfreightClient, id: d.id }))
    setClientNames(clients.map(c => c.name).sort())
    setClientIdMap(new Map(clients.map(c => [c.name, c.id!])))
    setClientsRequiringAgent(new Set(clients.filter(c => c.requires_agent).map(c => c.name)))
    setAllScEntries(scSnap.docs.map(d => {
      const data = d.data() as any
      return { type: data.type || '', client_name: data.client_name || '', short_name: data.short_name || '' }
    }))
    setLegacyShippers(shipperSnap.docs.map(d => d.data().name as string))
    setLegacyConsignees(consigneeSnap.docs.map(d => d.data().name as string))
    setFlights(flightsSnap.docs.map(d => ({ id: d.id, ...d.data() } as AirfreightFlight & { id: string })))
  }

  async function loadReception() {
    const snap = await getDoc(doc(db, 'airfreight_doc_receptions', id!))
    if (!snap.exists()) return
    const data = snap.data()
    setAwbNumber(data.awb_number || '')
    setMawbNumber(data.mawb_number || '')
    setAwb1stLeg(data.awb_1st_leg || '')
    setAwb2ndLeg(data.awb_2nd_leg || '')
    setClientName(data.client_name || '')
    setAgentName(data.agent_name || '')
    setShipperName(data.shipper_name || '')
    setConsigneeName(data.consignee_name || '')
    setDestination(data.destination || '')
    setPieces(data.pieces || 0)
    setWeight(data.weight || 0)
    setChargeableWeight(data.chargeable_weight || 0)
    setUldNumber(data.uld_number || '')
    setCargoTypeLabel(data.cargo_type_label || 'General')
    setWarehouseType(data.warehouse_type || 'bonded')
    setHasLB(data.has_lb || false)
    setHasDG(data.has_dg || false)
    setCargoType(data.cargo_type || 'loose')
    setBupNumber(data.bup_number || '')
    setDriverName(data.driver_name || '')
    setDriverIdNumber(data.driver_id_number || '')
    setDriverPlate(data.driver_plate || '')
    setDriverCompany(data.driver_company || '')
    setObservations(data.observations || '')
    setFlightNumber(data.flight_number || '')
    setExistingStatus(data.status || null)
    setExistingFlightId(data.flight_id || null)
    if (data.driver_id_url) setDriverIdPreview(data.driver_id_url)
    if (data.awb_copy_url) setAwbCopyPreview(data.awb_copy_url)
    // Mark search done
    setAwbSearch(data.awb_number || '')
    // Detect no-booking record
    if (!data.booking_id) {
      setNoBookingMode(true)
      setEditingGuide(true)
      if (data.flight_id) {
        setFlightOption('existing')
        setSelectedFlightId(data.flight_id)
      } else {
        setFlightOption('none')
      }
    } else if (!data.flight_id) {
      // Has booking but no flight — show flight assignment section
      setEditMissingFlight(true)
      setFlightOption('none')
    }
  }

  async function handleSearch() {
    if (!awbSearch.trim()) return
    setSearching(true)
    setSearchError('')
    setBookingMatch(null)
    setNoBookingMode(false)
    setAwbNotFound(false)
    // Reset all fields to avoid stale data from previous search
    setAwbNumber(''); setMawbNumber(''); setAwb1stLeg(''); setAwb2ndLeg('')
    setClientName(''); setShipperName(''); setConsigneeName('')
    setDestination(''); setPieces(0); setWeight(0); setChargeableWeight(0)
    setUldNumber(''); setCargoTypeLabel('General'); setFlightNumber('')
    setCargoType('loose'); setBupNumber('')
    setWarehouseType('bonded'); setHasLB(false); setHasDG(false)
    setDriverName(''); setDriverIdNumber(''); setDriverPlate(''); setDriverCompany('')
    setObservations('')
    setDriverIdFile(null); setDriverIdPreview(null)
    setAwbCopyFile(null); setAwbCopyPreview(null)
    setFlightOption('none'); setSelectedFlightId('')
    setNewFlightNumber(''); setNewFlightCarrier(''); setNewFlightDate(''); setNewFlightDestination('')

    try {
      const normalized = awbSearch.trim().replace(/\s/g, '')
      const normalizedSearch = normalize(normalized)
      const t0 = performance.now()

      // ── Step A: Duplicate check in doc_receptions (indexed query) ──
      const dupSnap = await getDocs(query(
        collection(db, 'airfreight_doc_receptions'),
        where('awb_normalized', '==', normalizedSearch),
      ))
      const existing = dupSnap.docs[0] ? { id: dupSnap.docs[0].id } : undefined

      if (existing) {
        setSearching(false)
        const goEdit = confirm('Esta AWB ya fue recibida documentalmente. ¿Desea editarla?')
        if (goEdit) {
          navigate(`/airfreight/doc-reception/${existing.id}/edit`)
        }
        return
      }

      // ── Step B: Search bookings for this AWB (indexed query) ──
      const bookingsSnap = await getDocs(query(
        collection(db, 'airfreight_bookings'),
        where('awb_numbers_normalized', 'array-contains', normalizedSearch),
      ))
      const candidateBookings = bookingsSnap.docs.map(d => ({ id: d.id, ...d.data() } as AirfreightBooking & { id: string }))

      let found: BookingMatch | null = null

      for (const booking of candidateBookings) {
        if (booking.booking_type === 'simple') {
          // Simple booking: check awb_2nd_leg or awb_1st_leg
          if (normalize(booking.awb_2nd_leg) === normalizedSearch ||
              normalize(booking.awb_1st_leg) === normalizedSearch) {
            const flight = booking.flight_id ? await loadFlight(booking.flight_id) : null
            const flightOrPlaceholder = flight || { id: '', flight_number: '', airline: '', flight_datetime: '', destinations: [], status: 'open' as const } as AirfreightFlight & { id: string }
            found = {
              booking,
              flight: flightOrPlaceholder,
              awbLine: {
                awb_number: booking.awb_2nd_leg || booking.awb_1st_leg || '',
                pieces: booking.pieces || 0,
                weight: booking.weight || 0,
                chargeable_weight: booking.chargeable_weight || 0,
                uld_type: booking.uld_type || null,
              },
              awbIndex: 0,
              awb1stLeg: booking.awb_1st_leg || '',
              mawbNumber: null,
            }
            break
          }
        } else if (booking.booking_type === 'mawb' || booking.booking_type === 'ecommerce' || booking.booking_type === 'export') {
          // MAWB/Ecommerce/Export: search in awb_lines
          const lines = booking.awb_lines || []
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]
            if (normalize(line.awb_number) === normalizedSearch ||
                normalize(line.awb_2nd_leg) === normalizedSearch) {
              const flight = booking.flight_id ? await loadFlight(booking.flight_id) : null
              const flightOrPlaceholder = flight || { id: '', flight_number: '', airline: '', flight_datetime: '', destinations: [], status: 'open' as const } as AirfreightFlight & { id: string }
              found = {
                booking,
                flight: flightOrPlaceholder,
                awbLine: line,
                awbIndex: i,
                awb1stLeg: line.awb_number || '',
                mawbNumber: booking.mawb_number || null,
              }
              break
            }
          }
          if (found) break
        }
      }

      console.info('AWB_SEARCH', {
        awb: normalizedSearch,
        found: !!found,
        candidates: candidateBookings.length,
        time_ms: Math.round(performance.now() - t0),
      })

      if (found) {
        setBookingMatch(found)
        populateFromBooking(found)
      } else {
        setAwbNotFound(true)
      }
    } catch (err) {
      console.error(err)
      setSearchError('Error buscando AWB')
    } finally {
      setSearching(false)
    }
  }

  function formatAwb(raw: string): string {
    const digits = raw.replace(/[^0-9]/g, '').slice(0, 11)
    if (digits.length <= 3) return digits
    return digits.slice(0, 3) + '-' + digits.slice(3)
  }

  function enterNoBookingMode() {
    setAwbNotFound(false)
    setSearchError('')
    setNoBookingMode(true)
    setAwbNumber(awbSearch.trim().replace(/\s/g, ''))
    setEditingGuide(true)
  }

  async function loadFlight(flightId: string) {
    const fSnap = await getDoc(doc(db, 'airfreight_flights', flightId))
    if (!fSnap.exists()) return null
    return { id: fSnap.id, ...fSnap.data() } as AirfreightFlight & { id: string }
  }

  const normalize = normalizeAwb

  function populateFromBooking(match: BookingMatch) {
    const { booking, flight, awbLine, awb1stLeg, mawbNumber: mawb } = match

    // In AwbSecondLeg: awb_number = 1ST LEG, awb_2nd_leg = 2ND LEG
    // The operational guide (AWB Number) = 2nd leg if exists, else awb_number
    const firstLeg = awbLine.awb_number || ''
    const secondLeg = awbLine.awb_2nd_leg || ''
    // For simple bookings, awb_1st_leg/awb_2nd_leg are at booking level
    const leg1 = awb1stLeg || firstLeg
    const leg2 = secondLeg || firstLeg
    // AWB Number = the operational guide (2nd leg, or awb_number if no 2nd leg)
    const operationalAwb = secondLeg || firstLeg

    setAwbNumber(operationalAwb)
    setAwb1stLeg(leg1)
    setAwb2ndLeg(leg2)
    setMawbNumber(mawb || '')
    setClientName(booking.client_name || '')
    // Export lines have per-line destination
    setDestination(awbLine.destination || booking.destination_id || booking.destination_custom || '')
    setPieces(awbLine.pieces || 0)
    setWeight(awbLine.weight || 0)
    setChargeableWeight(awbLine.chargeable_weight || 0)
    setUldNumber(awbLine.uld_type || '')
    setCargoTypeLabel('General')
    setFlightNumber(flight.flight_number || '')
    setHasLB(!!(awbLine.label_color || (awbLine as any).battery))
    setHasDG(!!(awbLine as any).ddgg)

    // Determine cargo type from ULD
    if (awbLine.uld_type && awbLine.uld_type.toUpperCase() !== 'LOOSE') {
      setCargoType('bup')
      setBupNumber(awbLine.uld_type)
    } else {
      setCargoType('loose')
    }

    // Default warehouse type
    const locBond = awbLine.loc_bond
    if (locBond === 'L') setWarehouseType('local')
    else setWarehouseType('bonded')
  }

  async function uploadFile(file: File, folder: string): Promise<string> {
    const path = `airfreight/doc-receptions/${folder}/${Date.now()}_${file.name}`
    const storRef = fbRef(storage, path)
    await uploadBytes(storRef, file)
    return getDownloadURL(storRef)
  }

  async function markBookingDocumented(bookingId: string, awbIdx: number | null) {
    try {
      const bRef = doc(db, 'airfreight_bookings', bookingId)
      await runTransaction(db, async (t) => {
        const bSnap = await t.get(bRef)
        if (!bSnap.exists()) return
        const bk = bSnap.data() as AirfreightBooking
        if (bk.booking_type === 'simple') {
          const updates: Record<string, any> = { warehouse_status: 'D' }
          if (weight > 0) updates.weight = weight
          t.update(bRef, updates)
        } else if (awbIdx != null) {
          const lines = [...(bk.awb_lines || [])]
          if (lines[awbIdx]) {
            lines[awbIdx] = { ...lines[awbIdx], warehouse_status: 'D' }
            if (weight > 0) lines[awbIdx].weight = weight
            t.update(bRef, { awb_lines: lines })
          }
        }
      })
    } catch (err) {
      console.error('Error marking booking as documented:', err)
    }
  }

  async function handleSave() {
    if (!awbNumber && !awb2ndLeg) return
    setSaving(true)
    try {
      // Only upload real files, don't persist blob: URLs
      let driverIdUrl: string | null = null
      let awbCopyUrl: string | null = null
      if (driverIdFile) driverIdUrl = await uploadFile(driverIdFile, 'driver-ids')
      else if (driverIdPreview && !driverIdPreview.startsWith('blob:')) driverIdUrl = driverIdPreview
      if (awbCopyFile) awbCopyUrl = await uploadFile(awbCopyFile, 'awb-copies')
      else if (awbCopyPreview && !awbCopyPreview.startsWith('blob:')) awbCopyUrl = awbCopyPreview

      // If no booking linked, try to find one by AWB number before saving
      let resolvedBookingId: string | null = bookingMatch?.booking.id || null
      let resolvedAwbIndex: number | null = bookingMatch?.awbIndex ?? null
      if (!resolvedBookingId && awbNumber) {
        const normalizedAwb = normalize(awbNumber)
        const bSnap = await getDocs(query(
          collection(db, 'airfreight_bookings'),
          where('awb_numbers_normalized', 'array-contains', normalizedAwb),
        ))
        for (const bDoc of bSnap.docs) {
          const bk = bDoc.data() as AirfreightBooking
          if (bk.booking_type === 'simple') {
            if (normalize(bk.awb_2nd_leg) === normalizedAwb || normalize(bk.awb_1st_leg) === normalizedAwb) {
              resolvedBookingId = bDoc.id
              resolvedAwbIndex = 0
              break
            }
          } else {
            const lines = bk.awb_lines || []
            for (let i = 0; i < lines.length; i++) {
              if (normalize(lines[i].awb_number) === normalizedAwb || normalize(lines[i].awb_2nd_leg) === normalizedAwb) {
                resolvedBookingId = bDoc.id
                resolvedAwbIndex = i
                break
              }
            }
            if (resolvedBookingId) break
          }
        }
      }

      // Determine flight info based on mode
      // In edit mode, preserve existing flight_id unless explicitly changed
      let finalFlightId: string | null = bookingMatch?.flight.id || existingFlightId || null
      let finalFlightNumber: string = flightNumber

      if (noBookingMode || editMissingFlight || (bookingMatch && !bookingMatch.flight.id)) {
        if (flightOption === 'new' && newFlightNumber) {
          const flightDoc = await addDoc(collection(db, 'airfreight_flights'), {
            flight_number: newFlightNumber,
            airline: newFlightCarrier,
            flight_datetime: newFlightDate ? new Date(newFlightDate).toISOString() : new Date().toISOString(),
            destinations: newFlightDestination ? [newFlightDestination] : [],
            status: 'open',
            created_at: new Date().toISOString(),
            created_by: user?.email || '',
          })
          finalFlightId = flightDoc.id
          finalFlightNumber = newFlightNumber
        } else if (flightOption === 'existing' && selectedFlightId) {
          finalFlightId = selectedFlightId
          const selFlight = flights.find(f => f.id === selectedFlightId)
          finalFlightNumber = selFlight?.flight_number || flightNumber
        } else {
          finalFlightId = null
          finalFlightNumber = ''
        }
      }

      // Auto-create simple booking when no booking exists but flight is assigned
      if (!resolvedBookingId && finalFlightId) {
        const awb1 = awbNumber || awb2ndLeg || awb1stLeg || ''
        const awb2 = awb2ndLeg || null
        const selFlight = flights.find(f => f.id === finalFlightId)
        const newBooking: Record<string, any> = {
          booking_type: 'simple',
          flight_id: finalFlightId,
          flight_number: finalFlightNumber || selFlight?.flight_number || '',
          airline: selFlight?.airline || '',
          client_id: clientIdMap.get(clientName) || '',
          client_name: clientName,
          agent_name: clientsRequiringAgent.has(clientName) ? agentName || null : null,
          status: 'submitted',
          created_by: user?.email || '',
          created_at: new Date().toISOString(),
          change_count: 0,
          modified_seen: true,
          change_log: [],
          documents: {},
          destination_id: destination || '',
          awb_1st_leg: awb1,
          awb_2nd_leg: awb2,
          pieces: pieces || null,
          weight: weight || null,
          chargeable_weight: chargeableWeight || null,
          uld_type: cargoType === 'bup' ? 'BUP' : 'LOOSE',
          battery: hasLB,
          ddgg: hasDG,
          warehouse_status: 'D',
          ...(() => {
            const nums = computeAwbNumbersNormalized({ booking_type: 'simple', awb_1st_leg: awb1, awb_2nd_leg: awb2 || undefined })
            return { awb_numbers_normalized: nums }
          })(),
        }
        const bookingRef = await addDoc(collection(db, 'airfreight_bookings'), newBooking)
        resolvedBookingId = bookingRef.id
        resolvedAwbIndex = 0
      }

      // Compute normalized AWB for indexed duplicate-check queries (SOL-8)
      const awbNorm = normalize(awbNumber) || normalize(awb2ndLeg) || normalize(awb1stLeg)

      const payload = {
        awb_number: awbNumber,
        mawb_number: mawbNumber || null,
        awb_1st_leg: awb1stLeg || null,
        awb_2nd_leg: awb2ndLeg || null,
        awb_normalized: awbNorm,
        client_name: clientName,
        agent_name: clientsRequiringAgent.has(clientName) ? agentName || null : null,
        shipper_name: shipperName,
        consignee_name: consigneeName,
        destination,
        pieces,
        weight,
        chargeable_weight: chargeableWeight,
        uld_number: uldNumber || null,
        cargo_type_label: cargoTypeLabel,
        has_lb: hasLB,
        has_dg: hasDG,
        cargo_type: cargoType,
        bup_number: bupNumber || null,
        warehouse_type: warehouseType,
        flight_number: finalFlightNumber,
        driver_name: driverName,
        driver_id_number: driverIdNumber,
        driver_plate: driverPlate,
        driver_company: driverCompany,
        driver_id_url: driverIdUrl || null,
        awb_copy_url: awbCopyUrl || null,
        observations,
        status: isEdit && existingStatus ? existingStatus : 'pending_physical',
        booking_id: resolvedBookingId,
        flight_id: finalFlightId,
        awb_index: resolvedAwbIndex,
      }

      if (isEdit) {
        await updateDoc(doc(db, 'airfreight_doc_receptions', id!), {
          ...payload,
          updated_at: new Date().toISOString(),
        })
        // Sync weight + status to booking (on link or on every edit with booking)
        if (resolvedBookingId) {
          await markBookingDocumented(resolvedBookingId, resolvedAwbIndex)
        }
      } else {
        await addDoc(collection(db, 'airfreight_doc_receptions'), {
          ...payload,
          created_at: new Date().toISOString(),
          created_by: user?.email || '',
        })

        // Mark warehouse_status = 'D' (Documented) on the AWB line in the booking
        if (resolvedBookingId) {
          await markBookingDocumented(resolvedBookingId, resolvedAwbIndex)
        }
      }

      navigate('/airfreight/doc-reception')
    } catch (err: any) {
      console.error('Error saving doc reception:', err)
      alert('Error al guardar: ' + (err?.message || err))
    } finally {
      setSaving(false)
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>, type: 'driverId' | 'awbCopy') {
    const file = e.target.files?.[0]
    if (!file) return
    const url = URL.createObjectURL(file)
    if (type === 'driverId') { setDriverIdFile(file); setDriverIdPreview(url) }
    else { setAwbCopyFile(file); setAwbCopyPreview(url) }
  }

  return (
    <Layout title={isEdit ? 'Editar Recepcion Documental' : 'Nueva Recepcion Documental'} backTo="/airfreight/doc-reception">
      <div className="max-w-3xl mx-auto px-4 py-6">

        {/* Step 1: AWB Lookup */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
          <h2 className="text-base font-semibold text-gray-800 mb-4 flex items-center gap-2">
            <span className="w-6 h-6 rounded-full bg-blue-800 text-white text-xs flex items-center justify-center font-bold">1</span>
            Buscar AWB
          </h2>
          <div className="flex gap-3">
            <input
              type="text"
              placeholder="Ingrese numero de AWB (ej: 057-12345678)"
              value={awbSearch}
              onChange={e => setAwbSearch(formatAwb(e.target.value))}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              maxLength={12}
              className="flex-1 border border-gray-200 rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-blue-800 font-mono"
            />
            <button
              onClick={handleSearch}
              disabled={searching}
              className="bg-blue-800 text-white px-6 py-3 rounded-lg text-sm font-semibold hover:bg-blue-900 transition-colors disabled:opacity-50"
            >
              {searching ? 'Buscando...' : 'Buscar'}
            </button>
          </div>
          {bookingMatch && (
            <div className="mt-3 flex items-center gap-2 text-sm text-green-700 bg-green-50 rounded-lg px-3 py-2">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/>
              </svg>
              AWB encontrada en booking{bookingMatch.flight.flight_number ? ` — Vuelo: ${bookingMatch.flight.flight_number}` : ''} - datos pre-cargados
            </div>
          )}
          {noBookingMode && !isEdit && (
            <div className="mt-3 flex items-center gap-2 text-sm text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
              Recepcion sin booking - complete todos los campos manualmente
            </div>
          )}
          {awbNotFound && !noBookingMode && (
            <div className="mt-3 bg-amber-50 border border-amber-200 rounded-lg p-4">
              <div className="flex items-center gap-2 text-sm text-amber-800 font-medium mb-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"/>
                </svg>
                AWB no encontrada en bookings activos
              </div>
              <p className="text-xs text-amber-600 mb-3">Puede recibir esta AWB sin booking. Debera completar todos los datos manualmente.</p>
              <button
                onClick={enterNoBookingMode}
                className="bg-amber-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-amber-700 transition-colors"
              >
                Recibir sin Booking
              </button>
            </div>
          )}
          {searchError && (
            <div className="mt-3 flex items-center gap-2 text-sm text-red-700 bg-red-50 rounded-lg px-3 py-2">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
              </svg>
              {searchError}
            </div>
          )}
        </div>

        {/* Step 2: Guide Data */}
        {(bookingMatch || isEdit || noBookingMode) && (
          <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
            <h2 className="text-base font-semibold text-gray-800 mb-4 flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-blue-800 text-white text-xs flex items-center justify-center font-bold">2</span>
              Datos de la Guia
              {bookingMatch && (
                <span className="text-xs bg-blue-50 text-blue-800 px-2 py-0.5 rounded-full ml-2">Pre-cargado del booking</span>
              )}
              {noBookingMode && !isEdit && (
                <span className="text-xs bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full ml-2">Sin booking</span>
              )}
              <button
                onClick={() => setEditingGuide(!editingGuide)}
                className="ml-auto text-gray-400 hover:text-blue-800 transition-colors"
                title="Editar datos"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/>
                </svg>
              </button>
            </h2>

            {/* Row 1: AWB & MAWB */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">AWB Number</label>
                <input
                  type="text"
                  value={awbNumber}
                  readOnly={!editingGuide}
                  onChange={e => setAwbNumber(formatAwb(e.target.value))}
                  maxLength={12}
                  className={`w-full border rounded-lg px-3 py-2 text-sm font-mono ${!editingGuide ? 'border-gray-100 bg-gray-50' : 'border-gray-200'}`}
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">MAWB <span className="text-gray-300">(si aplica)</span></label>
                <input
                  type="text"
                  value={mawbNumber}
                  readOnly={!editingGuide}
                  onChange={e => setMawbNumber(formatAwb(e.target.value))}
                  maxLength={12}
                  className={`w-full border rounded-lg px-3 py-2 text-sm font-mono ${!editingGuide ? 'border-gray-100 bg-purple-50 text-purple-800' : 'border-gray-200'}`}
                />
                {mawbNumber && <p className="text-[10px] text-purple-400 mt-1">Agrupador - del booking</p>}
              </div>
            </div>

            {/* Row 2: Legs */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">1st Leg</label>
                <input
                  type="text"
                  value={awb1stLeg}
                  readOnly={!editingGuide}
                  onChange={e => setAwb1stLeg(formatAwb(e.target.value))}
                  maxLength={12}
                  className={`w-full border rounded-lg px-3 py-2 text-sm font-mono ${!editingGuide ? 'border-gray-100 bg-gray-50' : 'border-gray-200'}`}
                />
                <p className="text-[10px] text-gray-400 mt-1">Del booking</p>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">2nd Leg</label>
                <input
                  type="text"
                  value={awb2ndLeg}
                  readOnly={!editingGuide}
                  onChange={e => setAwb2ndLeg(formatAwb(e.target.value))}
                  maxLength={12}
                  className={`w-full border rounded-lg px-3 py-2 text-sm font-mono ${!editingGuide ? 'border-gray-100 bg-amber-50 text-amber-800' : 'border-gray-200'}`}
                />
                <p className="text-[10px] text-amber-500 mt-1">Guia la recepcion fisica y etiquetas</p>
              </div>
            </div>

            {/* Row 3: 3 Companies */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Cliente MCL</label>
                {noBookingMode ? (
                  <>
                    <input
                      type="text"
                      value={clientName}
                      onChange={e => setClientName(e.target.value)}
                      placeholder="Seleccionar o digitar cliente"
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-medium focus:outline-none focus:border-blue-800"
                      list="client-list"
                    />
                    <datalist id="client-list">
                      {clientNames.map(c => <option key={c} value={c} />)}
                    </datalist>
                  </>
                ) : (
                  <input
                    type="text"
                    value={clientName}
                    readOnly
                    className="w-full border border-gray-100 bg-gray-50 rounded-lg px-3 py-2 text-sm font-medium"
                  />
                )}
                <p className="text-[10px] text-gray-400 mt-1">{noBookingMode ? 'Buscar en BD o digitar nuevo' : 'Del booking'}</p>
                {clientsRequiringAgent.has(clientName) && (
                  <div className="mt-2">
                    <label className="block text-xs text-gray-500 mb-1">Agent</label>
                    <input
                      type="text"
                      value={agentName}
                      onChange={e => setAgentName(e.target.value)}
                      placeholder="Nombre del agente"
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-800"
                    />
                  </div>
                )}
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Shipper</label>
                {shipperMode === 'select' ? (
                  <div className="relative">
                    <input
                      type="text"
                      value={shipperName}
                      onChange={e => setShipperName(e.target.value)}
                      placeholder="Buscar o digitar shipper"
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-800 pr-8"
                      list="shipper-list"
                    />
                    <datalist id="shipper-list">
                      {shippers.map(s => <option key={s} value={s} />)}
                    </datalist>
                  </div>
                ) : (
                  <input
                    type="text"
                    value={shipperName}
                    onChange={e => setShipperName(e.target.value)}
                    placeholder="Nombre del shipper"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-800"
                  />
                )}
                <p className="text-[10px] text-gray-400 mt-1">Buscar en BD o digitar nuevo</p>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Consignee</label>
                {consigneeMode === 'select' ? (
                  <div className="relative">
                    <input
                      type="text"
                      value={consigneeName}
                      onChange={e => setConsigneeName(e.target.value)}
                      placeholder="Buscar o digitar consignee"
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-800 pr-8"
                      list="consignee-list"
                    />
                    <datalist id="consignee-list">
                      {consignees.map(c => <option key={c} value={c} />)}
                    </datalist>
                  </div>
                ) : (
                  <input
                    type="text"
                    value={consigneeName}
                    onChange={e => setConsigneeName(e.target.value)}
                    placeholder="Nombre del consignee"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-800"
                  />
                )}
                <p className="text-[10px] text-gray-400 mt-1">Buscar en BD o digitar nuevo</p>
              </div>
            </div>

            {/* Flight info (visible in edit mode) */}
            {isEdit && flightNumber && (
              <div className="mb-4">
                <label className="block text-xs text-gray-500 mb-1">Vuelo</label>
                <input
                  type="text"
                  value={flightNumber}
                  readOnly
                  className="w-full sm:w-1/2 border border-gray-100 bg-gray-50 rounded-lg px-3 py-2 text-sm font-mono font-bold"
                />
              </div>
            )}

            {/* Row 4: Destination, Pieces, Weight, CHW */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Destino</label>
                <input
                  type="text"
                  value={destination}
                  readOnly={!editingGuide}
                  onChange={e => setDestination(e.target.value)}
                  className={`w-full border rounded-lg px-3 py-2 text-sm font-mono font-bold ${!editingGuide ? 'border-gray-100 bg-gray-50' : 'border-gray-200'}`}
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Piezas</label>
                <input
                  type="number"
                  value={pieces}
                  readOnly={!editingGuide}
                  onChange={e => setPieces(Number(e.target.value))}
                  className={`w-full border rounded-lg px-3 py-2 text-sm ${!editingGuide ? 'border-gray-100 bg-gray-50' : 'border-gray-200'}`}
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Peso (kg)</label>
                <input
                  type="number"
                  value={weight}
                  readOnly={!editingGuide}
                  onChange={e => setWeight(Number(e.target.value))}
                  className={`w-full border rounded-lg px-3 py-2 text-sm ${!editingGuide ? 'border-gray-100 bg-gray-50' : 'border-gray-200'}`}
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">CHW (kg)</label>
                <input
                  type="number"
                  value={chargeableWeight}
                  readOnly={!editingGuide}
                  onChange={e => setChargeableWeight(Number(e.target.value))}
                  className={`w-full border rounded-lg px-3 py-2 text-sm ${!editingGuide ? 'border-gray-100 bg-gray-50' : 'border-gray-200'}`}
                />
              </div>
            </div>

            {/* Row 5: ULD, Cargo type, LB/DG, Warehouse */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">ULD</label>
                <input
                  type="text"
                  value={uldNumber}
                  readOnly={!editingGuide}
                  onChange={e => setUldNumber(e.target.value)}
                  className={`w-full border rounded-lg px-3 py-2 text-sm font-mono ${!editingGuide ? 'border-gray-100 bg-gray-50' : 'border-gray-200'}`}
                />
                <p className="text-[10px] text-gray-400 mt-1">Del booking (LOOSE si no tiene)</p>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Tipo carga</label>
                <select
                  value={cargoTypeLabel}
                  onChange={e => setCargoTypeLabel(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-800"
                >
                  <option value="General">General</option>
                  <option value="Courier">Courier</option>
                  <option value="Drums">Drums</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">LB / DG</label>
                <div className="flex gap-3 mt-1">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="checkbox" checked={hasLB} onChange={e => setHasLB(e.target.checked)} className="rounded border-gray-300 text-blue-800 focus:ring-blue-800" />
                    <span className={`text-xs font-medium ${hasLB ? 'text-green-700' : 'text-gray-400'}`}>LB</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="checkbox" checked={hasDG} onChange={e => setHasDG(e.target.checked)} className="rounded border-gray-300 text-amber-600 focus:ring-amber-500" />
                    <span className={`text-xs font-medium ${hasDG ? 'text-amber-700' : 'text-gray-400'}`}>DG</span>
                  </label>
                </div>
              </div>
              <div className="col-span-2">
                <label className="block text-xs text-gray-500 mb-1">Tipo almacen</label>
                <div className="flex gap-2 mt-0.5">
                  <button
                    type="button"
                    onClick={() => setWarehouseType('bonded')}
                    className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${warehouseType === 'bonded' ? 'bg-blue-800 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                  >
                    Bonded
                  </button>
                  <button
                    type="button"
                    onClick={() => setWarehouseType('local')}
                    className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${warehouseType === 'local' ? 'bg-blue-800 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                  >
                    Local
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Step 2.5: Flight Assignment (no-booking mode, booking without flight, or edit missing flight) */}
        {(noBookingMode || editMissingFlight || (bookingMatch && !bookingMatch.flight.id)) && (
          <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
            <h2 className="text-base font-semibold text-gray-800 mb-4 flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-blue-800 text-white text-xs flex items-center justify-center">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/>
                </svg>
              </span>
              Asignacion de Vuelo
            </h2>

            <div className="space-y-3">
              {/* Existing flight */}
              <label className="block cursor-pointer">
                <div className={`border-2 rounded-xl p-4 transition-all ${flightOption === 'existing' ? 'border-blue-800 bg-blue-50' : 'border-gray-200 hover:border-gray-300'}`}>
                  <div className="flex items-center gap-3">
                    <input type="radio" name="flight_option" checked={flightOption === 'existing'} onChange={() => setFlightOption('existing')} className="text-blue-800" />
                    <div>
                      <p className="text-sm font-medium text-gray-800">Vuelo existente</p>
                      <p className="text-xs text-gray-400">Seleccionar de vuelos ya creados</p>
                    </div>
                  </div>
                </div>
              </label>
              {flightOption === 'existing' && (
                <div className="ml-8 border border-gray-200 rounded-lg p-3">
                  <select
                    value={selectedFlightId}
                    onChange={e => {
                      setSelectedFlightId(e.target.value)
                      const f = flights.find(fl => fl.id === e.target.value)
                      if (f) setFlightNumber(f.flight_number || '')
                    }}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-800"
                  >
                    <option value="">Seleccionar vuelo...</option>
                    {flights
                      .filter(f => {
                        // Only future flights (today or later)
                        if (f.flight_datetime) {
                          const fDate = new Date(f.flight_datetime)
                          const today = new Date()
                          today.setHours(0, 0, 0, 0)
                          if (fDate < today) return false
                        }
                        // Match destination if user already filled one
                        if (destination && f.destinations?.length) {
                          const dest = destination.toUpperCase().trim()
                          return f.destinations.some(d => d.toUpperCase().includes(dest))
                        }
                        return true
                      })
                      .sort((a, b) => {
                        const da = a.flight_datetime ? new Date(a.flight_datetime).getTime() : 0
                        const db = b.flight_datetime ? new Date(b.flight_datetime).getTime() : 0
                        return da - db
                      })
                      .map(f => (
                      <option key={f.id} value={f.id}>
                        {f.flight_number} — {(f.destinations || []).join(', ')} — {f.flight_datetime ? new Date(f.flight_datetime).toLocaleDateString() : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* New flight */}
              <label className="block cursor-pointer">
                <div className={`border-2 rounded-xl p-4 transition-all ${flightOption === 'new' ? 'border-blue-800 bg-blue-50' : 'border-gray-200 hover:border-gray-300'}`}>
                  <div className="flex items-center gap-3">
                    <input type="radio" name="flight_option" checked={flightOption === 'new'} onChange={() => setFlightOption('new')} className="text-blue-800" />
                    <div>
                      <p className="text-sm font-medium text-gray-800">Crear vuelo nuevo</p>
                      <p className="text-xs text-gray-400">Definir numero de vuelo, carrier, destino y fecha</p>
                    </div>
                  </div>
                </div>
              </label>
              {flightOption === 'new' && (
                <div className="ml-8 border border-gray-200 rounded-lg p-4 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Numero de vuelo</label>
                      <input type="text" value={newFlightNumber} onChange={e => setNewFlightNumber(e.target.value)} placeholder="Ej: CM801" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-blue-800" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Carrier</label>
                      <input type="text" value={newFlightCarrier} onChange={e => setNewFlightCarrier(e.target.value)} placeholder="Ej: L7" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-800" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Destino</label>
                      <input type="text" value={newFlightDestination} onChange={e => setNewFlightDestination(e.target.value)} placeholder="Ej: BOG" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-800" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Fecha del vuelo</label>
                      <input type="date" value={newFlightDate} onChange={e => setNewFlightDate(e.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-800" />
                    </div>
                  </div>
                </div>
              )}

              {/* No flight */}
              <label className="block cursor-pointer">
                <div className={`border-2 rounded-xl p-4 transition-all ${flightOption === 'none' ? 'border-blue-800 bg-blue-50' : 'border-gray-200 hover:border-gray-300'}`}>
                  <div className="flex items-center gap-3">
                    <input type="radio" name="flight_option" checked={flightOption === 'none'} onChange={() => setFlightOption('none')} className="text-blue-800" />
                    <div>
                      <p className="text-sm font-medium text-gray-800">Sin vuelo</p>
                      <p className="text-xs text-gray-400">Se asignara posteriormente desde Asignacion de Vuelos</p>
                    </div>
                  </div>
                </div>
              </label>
            </div>
          </div>
        )}

        {/* Step 3: Cargo Type */}
        {(bookingMatch || isEdit || noBookingMode) && (
          <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
            <h2 className="text-base font-semibold text-gray-800 mb-4 flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-blue-800 text-white text-xs flex items-center justify-center font-bold">3</span>
              Tipo de Carga
            </h2>

            <div className="flex gap-4 mb-4">
              <label className="flex-1 cursor-pointer">
                <input type="radio" name="cargo_type" value="loose" checked={cargoType === 'loose'} onChange={() => setCargoType('loose')} className="peer hidden" />
                <div className="border-2 border-gray-200 peer-checked:border-blue-800 peer-checked:bg-blue-50 rounded-xl p-4 text-center transition-all">
                  <svg className="w-8 h-8 mx-auto mb-2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
                  </svg>
                  <p className="font-semibold text-sm text-gray-700">Loose</p>
                  <p className="text-xs text-gray-400 mt-1">Piezas sueltas</p>
                </div>
              </label>
              <label className="flex-1 cursor-pointer">
                <input type="radio" name="cargo_type" value="bup" checked={cargoType === 'bup'} onChange={() => setCargoType('bup')} className="peer hidden" />
                <div className="border-2 border-gray-200 peer-checked:border-blue-800 peer-checked:bg-blue-50 rounded-xl p-4 text-center transition-all">
                  <svg className="w-8 h-8 mx-auto mb-2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4"/>
                  </svg>
                  <p className="font-semibold text-sm text-gray-700">BUP</p>
                  <p className="text-xs text-gray-400 mt-1">Built-Up Pallet/Container</p>
                </div>
              </label>
            </div>

            <div className="border border-dashed border-gray-200 rounded-lg p-4 bg-gray-50/50">
              <label className="block text-xs text-gray-500 mb-1">
                Numero ULD/BUP <span className="text-gray-300">(opcional - se requiere en recepcion fisica)</span>
              </label>
              <input
                type="text"
                value={bupNumber}
                onChange={e => setBupNumber(e.target.value)}
                placeholder="Ej: PMC45210CM"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-blue-800"
              />
              <p className="text-xs text-gray-400 mt-2">
                Si el booking tiene el numero de ULD se pre-carga. Si no, counter puede ingresarlo aqui o dejarlo para recepcion fisica (donde es obligatorio).
              </p>
            </div>
          </div>
        )}

        {/* Step 4: Driver Info */}
        {(bookingMatch || isEdit || noBookingMode) && (
          <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
            <h2 className="text-base font-semibold text-gray-800 mb-4 flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-blue-800 text-white text-xs flex items-center justify-center font-bold">4</span>
              Datos del Driver
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Nombre del Driver</label>
                <input
                  type="text"
                  value={driverName}
                  onChange={e => setDriverName(e.target.value)}
                  placeholder="Nombre completo"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-800"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Cedula / ID</label>
                <input
                  type="text"
                  value={driverIdNumber}
                  onChange={e => setDriverIdNumber(e.target.value)}
                  placeholder="Numero de identificacion"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-800"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Placa del vehiculo</label>
                <input
                  type="text"
                  value={driverPlate}
                  onChange={e => setDriverPlate(e.target.value)}
                  placeholder="Ej: ABC-1234"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-800"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Empresa de transporte</label>
                <input
                  type="text"
                  value={driverCompany}
                  onChange={e => setDriverCompany(e.target.value)}
                  placeholder="Nombre de la empresa"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-800"
                />
              </div>
            </div>
          </div>
        )}

        {/* Step 5: Document Upload */}
        {(bookingMatch || isEdit || noBookingMode) && (
          <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
            <h2 className="text-base font-semibold text-gray-800 mb-4 flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-blue-800 text-white text-xs flex items-center justify-center font-bold">5</span>
              Documentos de Recepcion
            </h2>
            <p className="text-xs text-gray-400 mb-4">Fotocopia del ID del driver y copia de la AWB que trae a bodega</p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Driver ID upload */}
              <div
                onClick={() => driverIdRef.current?.click()}
                className="border-2 border-dashed border-gray-200 rounded-xl p-6 text-center hover:border-blue-800 hover:bg-blue-50/30 transition-all cursor-pointer"
              >
                <input ref={driverIdRef} type="file" accept="image/*,.pdf" className="hidden" onChange={e => handleFileSelect(e, 'driverId')} />
                <svg className="w-8 h-8 mx-auto text-gray-300 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                </svg>
                <p className="text-sm font-medium text-gray-600">ID del Driver</p>
                <p className="text-xs text-gray-400 mt-1">Click o arrastrar archivo</p>
              </div>

              {/* AWB Copy upload */}
              <div
                onClick={() => awbCopyRef.current?.click()}
                className="border-2 border-dashed border-gray-200 rounded-xl p-6 text-center hover:border-blue-800 hover:bg-blue-50/30 transition-all cursor-pointer"
              >
                <input ref={awbCopyRef} type="file" accept="image/*,.pdf" className="hidden" onChange={e => handleFileSelect(e, 'awbCopy')} />
                <svg className="w-8 h-8 mx-auto text-gray-300 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                </svg>
                <p className="text-sm font-medium text-gray-600">Copia AWB</p>
                <p className="text-xs text-gray-400 mt-1">Click o arrastrar archivo</p>
              </div>
            </div>

            {/* Upload previews */}
            {driverIdPreview && (
              <div className="mt-3 flex items-center gap-3 bg-green-50 rounded-lg px-3 py-2">
                <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/>
                </svg>
                <span className="text-xs text-green-700">{driverIdFile?.name || 'ID del driver subido'}</span>
                <button onClick={() => { setDriverIdFile(null); setDriverIdPreview(null) }} className="ml-auto text-xs text-red-400 hover:text-red-600">Eliminar</button>
              </div>
            )}
            {awbCopyPreview && (
              <div className="mt-3 flex items-center gap-3 bg-green-50 rounded-lg px-3 py-2">
                <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/>
                </svg>
                <span className="text-xs text-green-700">{awbCopyFile?.name || 'Copia AWB subida'}</span>
                <button onClick={() => { setAwbCopyFile(null); setAwbCopyPreview(null) }} className="ml-auto text-xs text-red-400 hover:text-red-600">Eliminar</button>
              </div>
            )}
          </div>
        )}

        {/* Step 6: Observations */}
        {(bookingMatch || isEdit || noBookingMode) && (
          <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
            <h2 className="text-base font-semibold text-gray-800 mb-4 flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-blue-800 text-white text-xs flex items-center justify-center font-bold">6</span>
              Observaciones
            </h2>
            <textarea
              rows={3}
              value={observations}
              onChange={e => setObservations(e.target.value)}
              placeholder="Notas adicionales sobre la recepcion..."
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-800 resize-none"
            />
          </div>
        )}

        {/* Actions */}
        {(bookingMatch || isEdit || noBookingMode) && (
          <div className="flex justify-end gap-3 pb-8">
            <button
              onClick={() => navigate('/airfreight/doc-reception')}
              className="px-6 py-3 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition-colors"
            >
              Cancelar
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="bg-blue-800 text-white px-8 py-3 rounded-lg text-sm font-semibold hover:bg-blue-900 transition-colors disabled:opacity-50"
            >
              {saving ? 'Guardando...' : isEdit ? 'Actualizar Recepcion' : 'Registrar Recepcion'}
            </button>
          </div>
        )}
      </div>
    </Layout>
  )
}
