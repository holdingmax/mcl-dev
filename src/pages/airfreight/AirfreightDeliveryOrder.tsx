import React, { useState, useEffect, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { doc, getDoc, collection, query, where, getDocs, deleteDoc, orderBy, onSnapshot } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import { AirfreightBooking, AirfreightFlight, AirfreightClient, DeliveryOrder, AwbEntry, AwbSecondLeg, TruckingVendor } from '../../types'
import type { DocSetsConfig, SetDocEntry } from './AirfreightDocSets'
import Layout from '../../components/Layout'
import {
  saveDeliveryOrder, loadDeliveryOrder, loadDeliveryOrderById, loadAllDOsForKey,
  buildDoHtml, buildCcsfHtml, buildLbChecklistHtml,
  openPrintableHtml,
  buildCcsfPdfBuffer, buildCcssspPdfBuffer, buildLbChecklistPdfBuffer,
  buildPerAwbDoData,
  fetchPdfAsArrayBuffer, extractPenultimatePage,
  buildSetCounter, buildSetDriver, buildSetEnvelope,
  buildSetCounterMawb, buildSetDriverMawb, buildSetEnvelopeMawb,
  buildSetCounterExport, buildSetDriverExport, buildSetEnvelopeExport,
  buildSetFromConfig,
} from '../../lib/deliveryOrder'
import {
  generateDriverPin, linkDriverToDeliveryOrder, createDeliveryTracking,
} from '../../lib/driverTracking'
import { generatePalletTagDocPdf, PalletTagDocData } from '../../lib/buildupPdf'
import { DriverQueueEntry } from '../../types'
import { fmtNum } from '../../lib/utils'

// Vendors are now loaded from Firestore (see useEffect below)

// ── Types for the AWB selection modal ─────────────────────────────────────

interface AvailableAwb {
  bookingId: string
  booking: AirfreightBooking
  flight: AirfreightFlight | null
  awbIndex: number
  awbNumber: string
  awb1stLeg: string
  clientName: string
  clientId: string
  airline: string
  flightNumber: string
  destination: string
  pieces: number
  weight: number
  hasBattery: boolean
}

export default function AirfreightDeliveryOrder() {
  const { bookingId, awbIndex: awbIndexStr, doDocId } = useParams<{ bookingId: string; awbIndex: string; doDocId: string }>()
  const awbIndex = Number(awbIndexStr ?? 0)
  const navigate = useNavigate()
  const { user } = useAuth()

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState(false)

  // Existing DOs detection (for creating additional DOs for same AWB)
  const [existingDOs, setExistingDOs] = useState<(DeliveryOrder & { id: string })[]>([])
  const [forceNew, setForceNew] = useState(false)

  // DO form state
  const [doId, setDoId] = useState<string | null>(null)
  const [doNumber, setDoNumber] = useState('')
  const [doCreatedAt, setDoCreatedAt] = useState<string | null>(null)
  const [awbEntries, setAwbEntries] = useState<AwbEntry[]>([])
  const [truckingCompany, setTruckingCompany] = useState('')
  const [truckingCustom, setTruckingCustom] = useState('')
  const [driverName, setDriverName] = useState('')
  const [custodyMethod, setCustodyMethod] = useState<'seal' | 'escort' | 'locked_vehicle'>('seal')
  const [sealNumber, setSealNumber] = useState('')
  const [escortName, setEscortName] = useState('')
  const [uldsLoaded, setUldsLoaded] = useState<string[]>([''])
  const [mclAgent, setMclAgent] = useState('')
  const [ccsfType, setCcsfType] = useState<'originated' | 'on_behalf'>('originated')
  const [acceptedFor, setAcceptedFor] = useState<'CAO' | 'PAX'>('CAO')

  // Set checkboxes
  const [setCounter, setSetCounter] = useState(true)
  const [setDriverFlag, setSetDriverFlag] = useState(true)
  const [setEnvelope, setSetEnvelope] = useState(true)
  const [generatedSets, setGeneratedSets] = useState<Map<string, string>>(new Map()) // key: "idx-type", value: blob URL

  // Per-AWB selection for CCSF and Sets
  const [ccsfSelected, setCcsfSelected] = useState<Set<number>>(new Set())
  const [setsSelected, setSetsSelected] = useState<Set<number>>(new Set())

  // Modal state
  const [modalOpen, setModalOpen] = useState(false)
  const [availableAwbs, setAvailableAwbs] = useState<AvailableAwb[]>([])
  const [modalLoading, setModalLoading] = useState(false)
  const [modalSearch, setModalSearch] = useState('')
  const [modalChecked, setModalChecked] = useState<Set<string>>(new Set()) // "bookingId::awbIndex"
  const [doByAwbKeyMap, setDoByAwbKeyMap] = useState<Map<string, string[]>>(new Map())

  // MAWB child AWB lines cache (bookingId → AwbSecondLeg[])
  const [mawbLinesCache, setMawbLinesCache] = useState<Map<string, AwbSecondLeg[]>>(new Map())
  const [mawbExpanded, setMawbExpanded] = useState<Set<number>>(new Set())

  // Driver queue modal
  const [driverQueueModal, setDriverQueueModal] = useState(false)
  const [driverQueueEntries, setDriverQueueEntries] = useState<(DriverQueueEntry & { id: string })[]>([])
  const [driverQueueLoading, setDriverQueueLoading] = useState(false)
  const [selectedQueueId, setSelectedQueueId] = useState<string | null>(null)
  const [driverPin, setDriverPin] = useState('')

  // P/C badge: totalPieces / assignedToUld per AWB number
  const [pcMap, setPcMap] = useState<Map<string, { total: number; inUld: number; inThisAndPrevious: number }>>(new Map())

  // Client cache for CCSSSP
  const [clientsCache, setClientsCache] = useState<Map<string, AirfreightClient>>(new Map())
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'airfreight_clients'), snap => {
      const map = new Map<string, AirfreightClient>()
      snap.docs.forEach(d => map.set(d.id, { ...d.data() as AirfreightClient, id: d.id }))
      setClientsCache(map)
    })
    return unsub
  }, [])

  // Vendors from Firestore
  const [vendors, setVendors] = useState<(TruckingVendor & { id: string })[]>([])
  useEffect(() => {
    return onSnapshot(query(collection(db, 'vendors'), orderBy('name')), snap => {
      setVendors(snap.docs.map(d => ({ ...d.data() as TruckingVendor, id: d.id })))
    })
  }, [])
  const truckingOptions = useMemo(() => vendors.filter(v => v.status === 'active').map(v => v.name), [vendors])

  // Load P/C data when AWB entries or ULDs change
  // P/C considers pieces in THIS DO's ULDs + ULDs of DOs created BEFORE this one
  useEffect(() => {
    if (awbEntries.length === 0) { setPcMap(new Map()); return }
    const awbNumbers = [...new Set(awbEntries.map(e => e.awb_number).filter(Boolean))]
    if (awbNumbers.length === 0) return
    const uldStrings = uldsLoaded.filter(u => u.trim())
    ;(async () => {
      // Resolve buildup ULD doc IDs for the ULDs in this DO
      const flightIds = [...new Set(awbEntries.map(e => e.flight_id).filter(Boolean))]
      // Cache all buildup_ulds for these flights (reused for previous DOs too)
      const allBuildupUlds = new Map<string, { uld_number: string; type: string }>()
      for (const fid of flightIds) {
        const uldSnap = await getDocs(query(collection(db, 'buildup_ulds'), where('flight_id', '==', fid)))
        for (const d of uldSnap.docs) {
          allBuildupUlds.set(d.id, d.data() as { uld_number: string; type: string })
        }
      }

      const norm = (s: string) => s.replace(/[\s\-]/g, '').toUpperCase()

      // Resolve THIS DO's ULD numbers to buildup_uld IDs
      const doUldIds = new Set<string>()
      if (uldStrings.length > 0) {
        for (const [id, u] of allBuildupUlds) {
          const combined = norm(`${u.type}${u.uld_number}`)
          const numOnly = norm(u.uld_number)
          if (uldStrings.some(s => { const ns = norm(s); return ns === combined || ns === numOnly })) {
            doUldIds.add(id)
          }
        }
      }

      // Resolve ULD IDs from DOs created BEFORE this one (for cumulative P/C)
      const previousDoUldIds = new Set<string>()
      if (doCreatedAt) {
        // Get all AWB keys in this DO to find related DOs
        const awbKeys = awbEntries.map(e => `${e.booking_id}::${e.awb_index}`)
        for (const key of awbKeys) {
          const prevSnap = await getDocs(query(
            collection(db, 'delivery_orders'),
            where('awb_keys', 'array-contains', key),
          ))
          for (const d of prevSnap.docs) {
            if (d.id === doId) continue // skip this DO
            const prevDo = d.data() as DeliveryOrder
            if (!prevDo.created_at || prevDo.created_at >= doCreatedAt) continue // skip posterior DOs
            // Resolve this previous DO's ULD numbers
            for (const uldStr of (prevDo.ulds_loaded || [])) {
              for (const [id, u] of allBuildupUlds) {
                const combined = norm(`${u.type}${u.uld_number}`)
                const numOnly = norm(u.uld_number)
                const ns = norm(uldStr)
                if (ns === combined || ns === numOnly) {
                  previousDoUldIds.add(id)
                }
              }
            }
          }
        }
      }

      // Combined set: this DO's ULDs + previous DOs' ULDs
      const validUldIds = new Set([...doUldIds, ...previousDoUldIds])

      // For MAWB entries, resolve ALL HAWB numbers from booking because
      // physical pieces store awb_2nd_leg (HAWB), not the mawb_number.
      // C/P is computed at MAWB level: ALL HAWBs must be counted, not just selected ones.
      const mawbHawbMap = new Map<string, string[]>()
      for (const entry of awbEntries) {
        if (entry.booking_type === 'mawb' && entry.booking_id) {
          try {
            const bSnap = await getDoc(doc(db, 'airfreight_bookings', entry.booking_id))
            if (bSnap.exists()) {
              const bData = bSnap.data()
              const lines = bData.awb_lines || []
              const hawbs = lines
                .map((l: any) => l.awb_2nd_leg || l.awb_number || '')
                .filter(Boolean)
              if (hawbs.length > 0) mawbHawbMap.set(entry.awb_number, hawbs)
            }
          } catch { /* ignore */ }
        }
      }

      const map = new Map<string, { total: number; inUld: number; inThisAndPrevious: number }>()
      for (const awb of awbNumbers) {
        const queryAwbs = mawbHawbMap.get(awb) || [awb]
        let total = 0, inThisDo = 0, inThisAndPrevious = 0
        for (const qAwb of queryAwbs) {
          const pSnap = await getDocs(query(collection(db, 'airfreight_physical_pieces'), where('awb_number', '==', qAwb)))
          pSnap.forEach(d => {
            total++
            const uldId = d.data().uld_id
            if (uldId && doUldIds.has(uldId)) inThisDo++
            if (uldId && validUldIds.has(uldId)) inThisAndPrevious++
          })
        }
        map.set(awb, { total, inUld: inThisDo, inThisAndPrevious })
      }
      setPcMap(map)
    })()
  }, [awbEntries, uldsLoaded, doCreatedAt, doId])

  const isNewMode = bookingId === 'new' || (!bookingId && !doDocId)

  // Helper to populate form from a loaded DO
  function populateFromDO(existing: DeliveryOrder & { id: string }, refreshedEntries: AwbEntry[]) {
    setDoId(existing.id)
    setDoNumber(existing.do_number)
    setDoCreatedAt(existing.created_at || null)
    setAwbEntries(refreshedEntries)
    setTruckingCompany(truckingOptions.includes(existing.trucking_company) ? existing.trucking_company : (existing.trucking_company ? '__custom__' : ''))
    setTruckingCustom(truckingOptions.includes(existing.trucking_company) ? '' : existing.trucking_company)
    setDriverName(existing.driver_name)
    setCustodyMethod(existing.custody_method)
    setSealNumber(existing.seal_number)
    setEscortName(existing.escort_name)
    setUldsLoaded(existing.ulds_loaded.length > 0 ? existing.ulds_loaded : [''])
    setMclAgent(existing.mcl_agent)
    setCcsfType(existing.ccsf_screening_type)
    setAcceptedFor(existing.accepted_for)
    setDriverPin(existing.driver_pin || '')
    setSelectedQueueId(existing.driver_queue_id || null)
    const indices = new Set(existing.awb_entries.map((_: AwbEntry, i: number) => i))
    setCcsfSelected(indices)
    setSetsSelected(new Set(indices))
  }

  // ── Load existing DO or create from initial AWB ──
  useEffect(() => {
    if (isNewMode) {
      setLoading(false)
      return
    }

    ;(async () => {
      try {
        // ── Mode 1: Load by Firestore doc ID ──
        if (doDocId) {
          const existing = await loadDeliveryOrderById(doDocId)
          if (existing) {
            const refreshedEntries = await Promise.all((existing.awb_entries || []).map(async (entry: AwbEntry) => {
              try {
                const bSnap = await getDoc(doc(db, 'airfreight_bookings', entry.booking_id))
                if (!bSnap.exists()) return entry
                const bk = bSnap.data() as AirfreightBooking
                if (entry.booking_type === 'mawb') {
                  return { ...entry, has_battery: (bk.awb_lines || []).some((l: AwbSecondLeg) => !!l.battery) }
                }
                const line = bk.awb_lines?.[entry.awb_index]
                return line ? { ...entry, has_battery: !!line.battery } : entry
              } catch { return entry }
            }))
            populateFromDO(existing, refreshedEntries)
          }
          setLoading(false)
          return
        }

        // ── Mode 2: Load by bookingId + awbIndex ──
        if (!bookingId) { setLoading(false); return }

        // Check ALL existing DOs for this AWB key
        const allDOs = await loadAllDOsForKey(bookingId, awbIndex)
        setExistingDOs(allDOs)

        // If there are existing DOs and user hasn't chosen "create new", load the first one
        if (allDOs.length > 0 && !forceNew) {
          const existing = allDOs[0]
          const refreshedEntries = await Promise.all((existing.awb_entries || []).map(async (entry: AwbEntry) => {
            try {
              const bSnap = await getDoc(doc(db, 'airfreight_bookings', entry.booking_id))
              if (!bSnap.exists()) return entry
              const bk = bSnap.data() as AirfreightBooking
              if (entry.booking_type === 'mawb') {
                return { ...entry, has_battery: (bk.awb_lines || []).some((l: AwbSecondLeg) => !!l.battery) }
              }
              const line = bk.awb_lines?.[entry.awb_index]
              return line ? { ...entry, has_battery: !!line.battery } : entry
            } catch { return entry }
          }))
          populateFromDO(existing, refreshedEntries)
        } else {
          // No existing DO — create initial entry from booking + flight
          const bSnap = await getDoc(doc(db, 'airfreight_bookings', bookingId))
          if (!bSnap.exists()) { setLoading(false); return }
          const b = { ...bSnap.data() as AirfreightBooking, id: bSnap.id }

          const fSnap = await getDoc(doc(db, 'airfreight_flights', b.flight_id))
          const f = fSnap.exists() ? { ...fSnap.data() as AirfreightFlight, id: fSnap.id } : null

          if (b.booking_type === 'mawb') {
            // MAWB booking — entry at MAWB level, all child AWBs selected by default
            const allIndices = (b.awb_lines || []).map((_: AwbSecondLeg, i: number) => i)
            const totalPieces = (b.awb_lines || []).reduce((sum: number, l: AwbSecondLeg) => sum + (l.pieces || 0), 0)
            const totalWeight = (b.awb_lines || []).reduce((sum: number, l: AwbSecondLeg) => sum + (l.chargeable_weight || 0), 0)
            const hasBattery = (b.awb_lines || []).some((l: AwbSecondLeg) => !!l.battery)
            const entry: AwbEntry = {
              booking_id: bookingId,
              booking_type: 'mawb',
              awb_index: 0,
              awb_number: b.mawb_number || '',
              awb_1st_leg: b.mawb_number || '',
              client_name: b.client_name || '',
              agent_name: b.agent_name || null,
              client_id: b.client_id || '',
              flight_number: f?.flight_number || '',
              flight_id: b.flight_id,
              airline: b.airline || f?.airline || '',
              destination: b.destination_id || '',
              deliver_to: b.airline || f?.airline || '',
              pieces: totalPieces,
              weight: totalWeight,
              has_battery: hasBattery,
              selected_hawb_indices: allIndices,
            }
            setAwbEntries([entry])
            setCcsfSelected(new Set([0]))
            setSetsSelected(new Set([0]))
          } else if (b.booking_type === 'simple') {
            // Simple booking — AWB at booking level, no awb_lines
            const entry: AwbEntry = {
              booking_id: bookingId,
              booking_type: 'ecommerce', // treat as ecommerce for DO generation
              awb_index: 0,
              awb_number: b.awb_2nd_leg || b.awb_1st_leg || '',
              awb_1st_leg: b.awb_1st_leg || '',
              client_name: b.client_name || '',
              agent_name: b.agent_name || null,
              client_id: b.client_id || '',
              flight_number: f?.flight_number || '',
              flight_id: b.flight_id,
              airline: b.airline || f?.airline || '',
              destination: b.destination_id || '',
              deliver_to: b.airline || f?.airline || '',
              pieces: b.pieces || 0,
              weight: b.chargeable_weight || 0,
              has_battery: !!(b as any).battery,
            }
            setAwbEntries([entry])
            setCcsfSelected(new Set([0]))
            setSetsSelected(new Set([0]))
          } else if (b.awb_lines && awbIndex >= 0 && awbIndex < b.awb_lines.length) {
            const line = b.awb_lines[awbIndex]
            const entry: AwbEntry = {
              booking_id: bookingId,
              booking_type: b.booking_type === 'export' ? 'export' : 'ecommerce',
              awb_index: awbIndex,
              awb_number: line.awb_2nd_leg || line.awb_number || '',
              awb_1st_leg: line.awb_number || '',
              client_name: b.client_name || '',
              agent_name: b.agent_name || null,
              client_id: b.client_id || '',
              flight_number: f?.flight_number || '',
              flight_id: b.flight_id,
              airline: b.airline || f?.airline || '',
              destination: b.destination_id || '',
              deliver_to: b.airline || f?.airline || '',
              pieces: line.pieces || 0,
              weight: line.chargeable_weight || 0,
              has_battery: !!line.battery,
            }
            setAwbEntries([entry])
            setCcsfSelected(new Set([0]))
            setSetsSelected(new Set([0]))
          }
        }
      } catch (err) {
        console.error('Error loading DO data:', err)
      } finally {
        setLoading(false)
      }
    })()
  }, [bookingId, awbIndex, doDocId, forceNew])

  function buildDoData(): DeliveryOrder {
    const effectiveTrucking = truckingCompany === '__custom__' ? truckingCustom : truckingCompany

    // For new DOs (forceNew), build incremental awb_keys
    let finalEntries = awbEntries
    if (forceNew && !doId && existingDOs.length > 0 && finalEntries.length > 0) {
      const doIndex = existingDOs.length // next incremental index
      finalEntries = finalEntries.map(e => ({
        ...e,
        awb_index_do: doIndex, // track which DO index this is
      }))
    }

    // Build awb_keys: for new additional DOs, append ::N to distinguish from first DO
    const awb_keys_built = finalEntries.map(e => {
      const baseKey = `${e.booking_id}::${e.awb_index}`
      if (forceNew && !doId && existingDOs.length > 0) {
        return `${baseKey}::${existingDOs.length}`
      }
      return baseKey
    })

    return {
      id: doId || undefined,
      do_number: doNumber,
      date: new Date().toISOString(),
      status: 'draft',
      created_at: doCreatedAt || new Date().toISOString(),
      created_by: (user as any)?.email || '',
      awb_entries: finalEntries,
      awb_keys: awb_keys_built,
      trucking_company: effectiveTrucking,
      driver_name: driverName,
      custody_method: custodyMethod,
      seal_number: sealNumber,
      escort_name: escortName,
      ulds_loaded: uldsLoaded.filter(u => u.trim() !== ''),
      mcl_agent: mclAgent,
      ccsf_screening_type: ccsfType,
      accepted_for: acceptedFor,
      driver_pin: driverPin || undefined,
      driver_queue_id: selectedQueueId,
      tracking_id: null,
    }
  }

  async function handleSave() {
    setSaving(true)
    try {
      // Generate PIN if not yet generated
      let pin = driverPin
      if (!pin) {
        pin = generateDriverPin()
        setDriverPin(pin)
      }

      const data = buildDoData()
      data.driver_pin = pin

      // Freeze P/C status for each AWB entry at save time
      // Uses inThisAndPrevious (pieces in THIS DO's ULDs + ULDs of DOs created before this one)
      for (const entry of data.awb_entries) {
        const pc = pcMap.get(entry.awb_number)
        if (pc && pc.total > 0 && pc.inUld > 0) {
          // C = pieces in this DO + previous DOs complete the AWB
          // P = this DO contributes but AWB not yet complete with previous DOs
          entry.frozen_pc = pc.inThisAndPrevious >= pc.total ? 'C' : 'P'
        } else {
          entry.frozen_pc = null
        }
      }

      const id = await saveDeliveryOrder(data)
      setDoId(id)
      let finalDoNumber = doNumber
      if (!doNumber) {
        // Reload to get the auto-assigned DO number
        const firstEntry = awbEntries[0]
        if (firstEntry) {
          const reloaded = await loadDeliveryOrder(firstEntry.booking_id, firstEntry.awb_index)
          if (reloaded) {
            setDoNumber(reloaded.do_number)
            finalDoNumber = reloaded.do_number
          }
        } else {
          // Fallback: read directly from the saved doc
          const savedSnap = await getDoc(doc(db, 'delivery_orders', id))
          if (savedSnap.exists()) {
            const savedNum = (savedSnap.data() as any).do_number || ''
            setDoNumber(savedNum)
            finalDoNumber = savedNum
          }
        }
      }

      // Create delivery_tracking if this is the first save with a PIN
      if (pin && id && finalDoNumber) {
        const airline = awbEntries[0]?.airline || ''
        const effectiveTrucking = truckingCompany === '__custom__' ? truckingCustom : truckingCompany
        try {
          // Check if tracking already exists for this DO
          const existingTrack = await getDocs(query(
            collection(db, 'delivery_tracking'),
            where('do_id', '==', id),
          ))
          if (existingTrack.empty) {
            const matchedVendor = vendors.find(v => v.name === effectiveTrucking)
            await createDeliveryTracking({
              do_id: id,
              do_number: finalDoNumber,
              driver_pin: pin,
              driver_name: driverName,
              vendor_id: matchedVendor?.id || null,
              vendor_name: effectiveTrucking,
              driver_plate: null,
              driver_queue_id: selectedQueueId,
              airline,
            })
            console.log('Tracking created for', finalDoNumber, 'PIN:', pin)
          } else {
            console.log('Tracking already exists:', existingTrack.docs.map(d => ({ id: d.id, ...d.data() })))
          }

          // Link queue entry if selected
          if (selectedQueueId) {
            await linkDriverToDeliveryOrder(selectedQueueId, id)
          }
        } catch (err) {
          console.error('Error creating delivery_tracking:', err)
          alert('Delivery Order guardada, pero hubo un error creando el tracking del driver: ' + (err as Error).message)
        }
      }

      alert('Delivery Order guardada correctamente')
    } catch (err) {
      console.error('Save error:', err)
      alert('Error al guardar: ' + (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function handleViewDO() {
    const data = buildDoData()
    openPrintableHtml(buildDoHtml(data), `DO ${data.do_number || 'Draft'}`)

    // Also generate Pallet Tag Doc PDF for ULDs in this DO
    const uldNumbers = (data.ulds_loaded || []).filter(u => u.trim())
    if (uldNumbers.length > 0) {
      try {
        const flightIds = [...new Set(awbEntries.map(e => e.flight_id).filter(Boolean))]
        const tagDocs: PalletTagDocData[] = []

        for (const fid of flightIds) {
          const uldSnap = await getDocs(query(
            collection(db, 'buildup_ulds'),
            where('flight_id', '==', fid),
          ))
          const matchedUlds = uldSnap.docs
            .map(d => ({ id: d.id, ...d.data() } as { id: string; uld_number: string; type: string; conf: string; destination: string; flight_id: string }))
            .filter(u => {
              const norm = (s: string) => s.replace(/[\s\-]/g, '').toUpperCase()
              const combined = norm(`${u.type}${u.uld_number}`)
              const numOnly = norm(u.uld_number)
              return uldNumbers.some(s => { const ns = norm(s); return ns === combined || ns === numOnly })
            })

          if (matchedUlds.length === 0) continue

          const flightSnap = await getDoc(doc(db, 'airfreight_flights', fid))
          const flight = flightSnap.exists() ? flightSnap.data() as AirfreightFlight : null

          const recSnap = await getDocs(query(
            collection(db, 'airfreight_doc_receptions'),
            where('flight_id', '==', fid),
          ))
          const receptions = recSnap.docs.map(d => ({ id: d.id, ...d.data() }))

          for (const uld of matchedUlds) {
            const piecesSnap = await getDocs(query(
              collection(db, 'airfreight_physical_pieces'),
              where('uld_id', '==', uld.id),
            ))
            const pieces = piecesSnap.docs.map(d => d.data() as { awb_number: string; weight_kg: number; dist_comment?: string })

            // Group by AWB
            const awbMap = new Map<string, { awb: string; pieces: number; weightKg: number; comments: string[] }>()
            for (const p of pieces) {
              const rec = receptions.find(r => (r as any).awb_number === p.awb_number)
              const key = (rec as any)?.awb_2nd_leg || p.awb_number
              if (!awbMap.has(key)) awbMap.set(key, { awb: key, pieces: 0, weightKg: 0, comments: [] })
              const entry = awbMap.get(key)!
              entry.pieces++
              entry.weightKg += p.weight_kg
              if (p.dist_comment && !entry.comments.includes(p.dist_comment)) entry.comments.push(p.dist_comment)
            }

            // Build note lines (grouped by MAWB if applicable)
            const noteMap = new Map<string, { label: string; count: number; comments: string[] }>()
            for (const p of pieces) {
              const rec = receptions.find(r => (r as any).awb_number === p.awb_number)
              const mawb = (rec as any)?.mawb_number
              const key = mawb || (rec as any)?.awb_2nd_leg || p.awb_number
              if (!noteMap.has(key)) noteMap.set(key, { label: key, count: 0, comments: [] })
              const n = noteMap.get(key)!
              n.count++
              if (p.dist_comment && !n.comments.includes(p.dist_comment)) n.comments.push(p.dist_comment)
            }
            const noteLines = Array.from(noteMap.values()).map(n => {
              let line = `${n.label} - ${n.count} pcs`
              if (n.comments.length > 0) line += ` ${n.comments.join(', ')}`
              return line
            })

            tagDocs.push({
              uldNumber: `${uld.type} ${uld.uld_number}`,
              flightNumber: flight?.flight_number || '',
              flightDate: flight?.flight_datetime || '',
              destination: uld.destination,
              position: uld.conf,
              totalWeightKg: pieces.reduce((s, p) => s + p.weight_kg, 0),
              awbLines: Array.from(awbMap.values()).map(a => ({
                awb: a.awb,
                pieces: a.pieces,
                weightKg: a.weightKg,
                remark: a.comments.join(', '),
              })),
              noteLines,
              userEmail: user?.email || '',
            })
          }
        }

        if (tagDocs.length > 0) {
          const blob = generatePalletTagDocPdf(tagDocs)
          const url = URL.createObjectURL(blob)
          window.open(url, '_blank')
        }
      } catch (err) {
        console.warn('Could not generate pallet tag PDF for DO:', err)
      }
    }
  }

  function handleGenerateCcsf() {
    const data = buildDoData()
    const selected = Array.from(ccsfSelected).sort()
    if (selected.length === 0) { alert('Selecciona al menos una AWB para CCSF.'); return }
    for (const idx of selected) {
      const entry = awbEntries[idx]
      if (!entry) continue
      const perAwb = buildPerAwbDoData(data, entry)
      openPrintableHtml(buildCcsfHtml(perAwb), `CCSF ${entry.awb_number}`)
    }
  }

  async function handleGenerateCcsssp() {
    const data = buildDoData()
    const selected = Array.from(ccsfSelected).sort()
    if (selected.length === 0) { alert('Selecciona al menos una AWB para CCSSSP.'); return }

    // Group by client_id to generate one CCSSSP per client
    const byClient = new Map<string, { entry: AwbEntry; idx: number }[]>()
    for (const idx of selected) {
      const entry = awbEntries[idx]
      if (!entry) continue
      const clientId = entry.client_id
      if (!byClient.has(clientId)) byClient.set(clientId, [])
      byClient.get(clientId)!.push({ entry, idx })
    }

    for (const [clientId, entries] of byClient) {
      let client = clientsCache.get(clientId)
      // Fallback: if client_id is empty or not found, try matching by client_name
      if (!client && entries[0].entry.client_name) {
        for (const [id, c] of clientsCache) {
          if (c.name?.toLowerCase() === entries[0].entry.client_name.toLowerCase()) {
            client = c
            break
          }
        }
      }
      if (!client?.ccsssp_tsa_number) {
        alert(`El cliente "${entries[0].entry.client_name}" no tiene configurado CCSSSP (TSA#). Configuralo en Administracion > Clientes.`)
        continue
      }
      const clientInfo = {
        company_name: client.ccsssp_company_name || client.name,
        short_name: client.ccsssp_short_name || client.ccsssp_company_name || client.name,
        tsa_number: client.ccsssp_tsa_number,
        address: client.ccsssp_address,
        phone: client.ccsssp_phone,
        email: client.ccsssp_email,
        logo_url: client.ccsssp_logo_url,
        logo_right_url: client.ccsssp_logo_right_url,
        format: client.ccsssp_format,
        rep_name: client.ccsssp_rep_name,
        signature_url: client.ccsssp_signature_url,
      }
      for (const { entry } of entries) {
        const perAwb = buildPerAwbDoData(data, entry)
        const buffer = await buildCcssspPdfBuffer(perAwb, clientInfo)
        const blob = new Blob([buffer], { type: 'application/pdf' })
        const url = URL.createObjectURL(blob)
        window.open(url, '_blank')
      }
    }
  }

  async function handleGenerateSets() {
    const selected = Array.from(setsSelected).sort()
    if (selected.length === 0) { alert('Selecciona al menos una AWB para sets.'); return }
    if (!setCounter && !setDriverFlag && !setEnvelope) {
      alert('Selecciona al menos un set para generar.')
      return
    }
    setGenerating(true)
    try {
      // Load doc sets config from Firestore (fallback to null = use hardcoded)
      let docSetsConfig: DocSetsConfig | null = null
      try {
        const cfgSnap = await getDoc(doc(db, 'settings', 'doc_sets'))
        if (cfgSnap.exists()) docSetsConfig = cfgSnap.data() as DocSetsConfig
      } catch {}

      // Auto-save first
      const data = buildDoData()
      const id = await saveDeliveryOrder(data)
      setDoId(id)
      if (!doNumber) {
        const firstEntry = awbEntries[0]
        if (firstEntry) {
          const reloaded = await loadDeliveryOrder(firstEntry.booking_id, firstEntry.awb_index)
          if (reloaded) setDoNumber(reloaded.do_number)
        } else {
          const savedSnap = await getDoc(doc(db, 'delivery_orders', id))
          if (savedSnap.exists()) setDoNumber((savedSnap.data() as any).do_number || '')
        }
      }
      const newUrls = new Map(generatedSets)

      for (const idx of selected) {
        const entry = awbEntries[idx]
        if (!entry) continue
        const perAwb = buildPerAwbDoData(data, entry)

        // Build CCSF + CCSSSP + LB buffers
        const ccsfBuffer = await buildCcsfPdfBuffer(perAwb)
        let ccssspBuffer: ArrayBuffer | null = null
        const client = clientsCache.get(entry.client_id) ||
          [...clientsCache.values()].find(c => c.name?.toLowerCase() === entry.client_name?.toLowerCase())
        if (client?.ccsssp_tsa_number) {
          const clientInfo = {
            company_name: client.ccsssp_company_name || client.name,
            short_name: client.ccsssp_short_name || client.ccsssp_company_name || client.name,
            tsa_number: client.ccsssp_tsa_number,
            address: client.ccsssp_address,
            phone: client.ccsssp_phone,
            email: client.ccsssp_email,
            logo_url: client.ccsssp_logo_url,
            logo_right_url: client.ccsssp_logo_right_url,
            format: client.ccsssp_format,
            rep_name: client.ccsssp_rep_name,
            signature_url: client.ccsssp_signature_url,
          }
          ccssspBuffer = await buildCcssspPdfBuffer(perAwb, clientInfo)
        }
        const lbBuffer = entry.has_battery ? await buildLbChecklistPdfBuffer(perAwb) : null

        if (entry.booking_type === 'mawb') {
          // ── MAWB set generation ──
          let doTsaBuffer: ArrayBuffer | null = null
          let manifestoBuffer: ArrayBuffer | null = null
          let mawbBuffer: ArrayBuffer | null = null
          const childDocs: { doc7512Buffer: ArrayBuffer | null; hawbBuffer: ArrayBuffer | null; copy5Buffer: ArrayBuffer | null }[] = []

          try {
            const bSnap = await getDoc(doc(db, 'airfreight_bookings', entry.booking_id))
            if (bSnap.exists()) {
              const bk = bSnap.data() as AirfreightBooking
              const bkDocs = bk.documents as Record<string, any> | undefined

              const doTsaUrl = bkDocs?.doc_do_tsa?.url
              if (doTsaUrl) { try { doTsaBuffer = await fetchPdfAsArrayBuffer(doTsaUrl) } catch {} }
              const manifestoUrl = bkDocs?.doc_manifesto?.url
              if (manifestoUrl) { try { manifestoBuffer = await fetchPdfAsArrayBuffer(manifestoUrl) } catch {} }
              const mawbUrl = bkDocs?.doc_mawb_def?.url || bkDocs?.doc_mawb_draft?.url
              if (mawbUrl) { try { mawbBuffer = await fetchPdfAsArrayBuffer(mawbUrl) } catch {} }

              const selectedIndices = entry.selected_hawb_indices || []
              for (const ci of selectedIndices) {
                const line = bk.awb_lines?.[ci]
                let d7512: ArrayBuffer | null = null
                let hawb: ArrayBuffer | null = null
                let c5: ArrayBuffer | null = null
                if (line) {
                  const lineDocs = line.documents as Record<string, any> | undefined
                  const url7512 = lineDocs?.doc_7512?.url
                  if (url7512) { try { d7512 = await fetchPdfAsArrayBuffer(url7512) } catch {} }
                  const urlHawb = lineDocs?.doc_hawb?.url
                  if (urlHawb) {
                    try {
                      hawb = await fetchPdfAsArrayBuffer(urlHawb)
                      c5 = await extractPenultimatePage(hawb)
                    } catch {}
                  }
                }
                childDocs.push({ doc7512Buffer: d7512, hawbBuffer: hawb, copy5Buffer: c5 })
              }
            }
          } catch (err) {
            console.warn('Error fetching MAWB docs for', entry.awb_number, err)
          }

          const mawbSetDocs = { ccsfBuffer, ccssspBuffer, lbBuffer, doTsaBuffer, manifestoBuffer, mawbBuffer, childDocs }

          if (setCounter) {
            const buf = await buildSetCounterMawb(mawbSetDocs)
            newUrls.set(`${idx}-counter`, URL.createObjectURL(new Blob([buf], { type: 'application/pdf' })))
          }
          if (setDriverFlag) {
            const buf = await buildSetDriverMawb(mawbSetDocs)
            newUrls.set(`${idx}-driver`, URL.createObjectURL(new Blob([buf], { type: 'application/pdf' })))
          }
          if (setEnvelope) {
            const buf = await buildSetEnvelopeMawb(mawbSetDocs)
            newUrls.set(`${idx}-envelope`, URL.createObjectURL(new Blob([buf], { type: 'application/pdf' })))
          }

        } else if (entry.booking_type === 'export') {
          // ── Export set generation ──
          let doBuffer: ArrayBuffer | null = null
          let tsaLetterBuffer: ArrayBuffer | null = null
          let doc7512Buffer: ArrayBuffer | null = null
          let hawbBuffer: ArrayBuffer | null = null
          let copy5Buffer: ArrayBuffer | null = null
          let manifestoBuffer: ArrayBuffer | null = null

          try {
            const bSnap = await getDoc(doc(db, 'airfreight_bookings', entry.booking_id))
            if (bSnap.exists()) {
              const bk = bSnap.data() as AirfreightBooking
              // Find line by AWB number first, fall back to index
              const line = (bk.awb_lines || []).find(l =>
                (l.awb_2nd_leg || l.awb_number) === entry.awb_number ||
                l.awb_number === entry.awb_1st_leg
              ) || bk.awb_lines?.[entry.awb_index]
              if (line) {
                const lineDocs = line.documents as Record<string, any> | undefined
                const doUrl = lineDocs?.doc_do_tsa?.url
                if (doUrl) { try { doBuffer = await fetchPdfAsArrayBuffer(doUrl) } catch {} }
                const tsaUrl = lineDocs?.doc_tsa_letter?.url
                if (tsaUrl) { try { tsaLetterBuffer = await fetchPdfAsArrayBuffer(tsaUrl) } catch {} }
                const doc7512Url = lineDocs?.doc_7512?.url
                if (doc7512Url) { try { doc7512Buffer = await fetchPdfAsArrayBuffer(doc7512Url) } catch {} }
                const hawbUrl = lineDocs?.doc_hawb?.url
                if (hawbUrl) {
                  try {
                    hawbBuffer = await fetchPdfAsArrayBuffer(hawbUrl)
                    copy5Buffer = await extractPenultimatePage(hawbBuffer)
                  } catch {}
                }
              }
              const fSnap = await getDoc(doc(db, 'airfreight_flights', bk.flight_id))
              if (fSnap.exists()) {
                const fl = fSnap.data() as AirfreightFlight
                const manifestoUrl = fl.doc_manifesto?.url
                if (manifestoUrl) { try { manifestoBuffer = await fetchPdfAsArrayBuffer(manifestoUrl) } catch {} }
              }
            }
          } catch (err) {
            console.warn('Error fetching export docs for AWB', entry.awb_number, err)
          }

          const exportDocs = { ccsfBuffer, ccssspBuffer, lbBuffer, doBuffer, tsaLetterBuffer, doc7512Buffer, hawbBuffer, copy5Buffer, manifestoBuffer }

          if (setCounter) {
            const buf = await buildSetCounterExport(exportDocs)
            newUrls.set(`${idx}-counter`, URL.createObjectURL(new Blob([buf], { type: 'application/pdf' })))
          }
          if (setDriverFlag) {
            const buf = await buildSetDriverExport(exportDocs)
            newUrls.set(`${idx}-driver`, URL.createObjectURL(new Blob([buf], { type: 'application/pdf' })))
          }
          if (setEnvelope) {
            const buf = await buildSetEnvelopeExport(exportDocs)
            newUrls.set(`${idx}-envelope`, URL.createObjectURL(new Blob([buf], { type: 'application/pdf' })))
          }

        } else {
          // ── Ecommerce set generation ──
          let doTsaBuffer: ArrayBuffer | null = null
          let doc7512Buffer: ArrayBuffer | null = null
          let hawbBuffer: ArrayBuffer | null = null
          let copy5Buffer: ArrayBuffer | null = null
          let manifestoBuffer: ArrayBuffer | null = null

          try {
            const bSnap = await getDoc(doc(db, 'airfreight_bookings', entry.booking_id))
            if (bSnap.exists()) {
              const bk = bSnap.data() as AirfreightBooking
              // Find line by AWB number first, fall back to index
              const line = (bk.awb_lines || []).find(l =>
                (l.awb_2nd_leg || l.awb_number) === entry.awb_number ||
                l.awb_number === entry.awb_1st_leg
              ) || bk.awb_lines?.[entry.awb_index]
              if (line) {
                const lineDocs = line.documents as Record<string, any> | undefined
                const doc7512Url = lineDocs?.doc_7512?.url
                if (doc7512Url) { try { doc7512Buffer = await fetchPdfAsArrayBuffer(doc7512Url) } catch {} }
                const hawbUrl = lineDocs?.doc_hawb?.url
                if (hawbUrl) {
                  try {
                    hawbBuffer = await fetchPdfAsArrayBuffer(hawbUrl)
                    copy5Buffer = await extractPenultimatePage(hawbBuffer)
                  } catch {}
                }
                // DO/TSA: check line-level first
                const lineDoTsaUrl = lineDocs?.doc_do_tsa?.url
                if (lineDoTsaUrl) { try { doTsaBuffer = await fetchPdfAsArrayBuffer(lineDoTsaUrl) } catch {} }
                // Manifesto: check line-level
                const lineManifestoUrl = lineDocs?.doc_manifesto?.url
                if (lineManifestoUrl) { try { manifestoBuffer = await fetchPdfAsArrayBuffer(lineManifestoUrl) } catch {} }
              } else {
                // Simple booking: no awb_lines — read docs from booking.documents
                const bkDocs = bk.documents as Record<string, any> | undefined
                const doc7512Url = bkDocs?.doc_7512?.url
                if (doc7512Url) { try { doc7512Buffer = await fetchPdfAsArrayBuffer(doc7512Url) } catch {} }
                const hawbUrl = bkDocs?.doc_hawb?.url || bkDocs?.doc_mawb_def?.url || bkDocs?.doc_mawb_draft?.url
                if (hawbUrl) {
                  try {
                    hawbBuffer = await fetchPdfAsArrayBuffer(hawbUrl)
                    copy5Buffer = await extractPenultimatePage(hawbBuffer)
                  } catch {}
                }
                const bkDoTsaUrl = bkDocs?.doc_do_tsa?.url
                if (bkDoTsaUrl) { try { doTsaBuffer = await fetchPdfAsArrayBuffer(bkDoTsaUrl) } catch {} }
                const bkManifestoUrl = bkDocs?.doc_manifesto?.url
                if (bkManifestoUrl) { try { manifestoBuffer = await fetchPdfAsArrayBuffer(bkManifestoUrl) } catch {} }
              }

              const fSnap = await getDoc(doc(db, 'airfreight_flights', bk.flight_id))
              if (fSnap.exists()) {
                const fl = fSnap.data() as AirfreightFlight
                // DO/TSA: fallback to flight-level (legacy simple or MAWB)
                if (!doTsaBuffer) {
                  const flDoTsaUrl = fl.doc_do_tsa?.url
                  if (flDoTsaUrl) { try { doTsaBuffer = await fetchPdfAsArrayBuffer(flDoTsaUrl) } catch {} }
                }
                if (!manifestoBuffer) {
                  const manifestoUrl = fl.doc_manifesto?.url
                  if (manifestoUrl) { try { manifestoBuffer = await fetchPdfAsArrayBuffer(manifestoUrl) } catch {} }
                }
              }
            }
          } catch (err) {
            console.warn('Error fetching docs for AWB', entry.awb_number, err)
          }

          const setDocs = { ccsfBuffer, ccssspBuffer, lbBuffer, doTsaBuffer, doc7512Buffer, hawbBuffer, copy5Buffer, manifestoBuffer }

          // Build buffers map for config-driven builder
          const buffersMap: Record<string, ArrayBuffer | null> = {
            ccsf: ccsfBuffer, ccsssp: ccssspBuffer, do_tsa: doTsaBuffer,
            lb: lbBuffer, '7512': doc7512Buffer, hawb: hawbBuffer,
            copy5: copy5Buffer, manifesto: manifestoBuffer,
          }

          if (setCounter) {
            const buf = docSetsConfig?.counter
              ? await buildSetFromConfig(docSetsConfig.counter, buffersMap)
              : await buildSetCounter(setDocs)
            newUrls.set(`${idx}-counter`, URL.createObjectURL(new Blob([buf], { type: 'application/pdf' })))
          }
          if (setDriverFlag) {
            const buf = docSetsConfig?.driver
              ? await buildSetFromConfig(docSetsConfig.driver, buffersMap)
              : await buildSetDriver(setDocs)
            newUrls.set(`${idx}-driver`, URL.createObjectURL(new Blob([buf], { type: 'application/pdf' })))
          }
          if (setEnvelope) {
            const buf = docSetsConfig?.envelope
              ? await buildSetFromConfig(docSetsConfig.envelope, buffersMap)
              : await buildSetEnvelope(setDocs)
            newUrls.set(`${idx}-envelope`, URL.createObjectURL(new Blob([buf], { type: 'application/pdf' })))
          }
        }
      }
      setGeneratedSets(newUrls)
    } catch (err) {
      console.error('Set generation error:', err)
      alert('Error generando sets: ' + (err as Error).message)
    } finally {
      setGenerating(false)
    }
  }

  // ── Modal: Load available AWBs ──
  async function openAddAwbModal() {
    setModalOpen(true)
    setModalSearch('')
    setModalChecked(new Set())
    setModalLoading(true)
    try {
      // Load ecommerce + mawb + export + simple bookings
      const bQ1 = query(collection(db, 'airfreight_bookings'), where('booking_type', '==', 'ecommerce'))
      const bQ2 = query(collection(db, 'airfreight_bookings'), where('booking_type', '==', 'mawb'))
      const bQ3 = query(collection(db, 'airfreight_bookings'), where('booking_type', '==', 'export'))
      const bQ4 = query(collection(db, 'airfreight_bookings'), where('booking_type', '==', 'simple'))
      const [bSnap1, bSnap2, bSnap3, bSnap4] = await Promise.all([getDocs(bQ1), getDocs(bQ2), getDocs(bQ3), getDocs(bQ4)])
      const allDocs = [...bSnap1.docs, ...bSnap2.docs, ...bSnap3.docs, ...bSnap4.docs]
      const results: AvailableAwb[] = []
      // Keys already in THIS DO (to avoid duplicates within same DO)
      const existingKeys = new Set(awbEntries.map(e => `${e.booking_id}::${e.awb_index}`))

      // Load existing DOs to show badges
      const doSnap = await getDocs(collection(db, 'delivery_orders'))
      const doByAwbKey = new Map<string, string[]>() // awbKey → DO numbers
      for (const d of doSnap.docs) {
        const doData = d.data() as DeliveryOrder
        const doNum = doData.do_number || d.id.slice(0, 6)
        for (const key of (doData.awb_keys || [])) {
          if (!doByAwbKey.has(key)) doByAwbKey.set(key, [])
          doByAwbKey.get(key)!.push(doNum)
        }
      }

      // Cache flights
      const flightCache = new Map<string, AirfreightFlight | null>()
      const today = new Date().toLocaleDateString('en-CA')

      for (const bDoc of allDocs) {
        const bk = { ...bDoc.data() as AirfreightBooking, id: bDoc.id }

        // Load flight if not cached
        if (!flightCache.has(bk.flight_id)) {
          const fSnap = await getDoc(doc(db, 'airfreight_flights', bk.flight_id))
          flightCache.set(bk.flight_id, fSnap.exists() ? { ...fSnap.data() as AirfreightFlight, id: fSnap.id } : null)
        }
        const fl = flightCache.get(bk.flight_id) || null

        // Filter by flight status: terminado or booked, dispatched only if today
        const flightStatus = fl?.flight_status || 'booked'
        if (flightStatus === 'dispatched') {
          const dispatchedAt = fl?.dispatched_at || ''
          if (dispatchedAt.slice(0, 10) !== today) continue
        }

        if (bk.booking_type === 'simple') {
          // Simple booking: AWB at booking level, no awb_lines
          const key = `${bDoc.id}::0`
          if (existingKeys.has(key)) continue
          results.push({
            bookingId: bDoc.id,
            booking: bk,
            flight: fl,
            awbIndex: 0,
            awbNumber: (bk as any).awb_2nd_leg || (bk as any).awb_1st_leg || '',
            awb1stLeg: (bk as any).awb_1st_leg || '',
            clientName: bk.client_name || '',
            clientId: bk.client_id || '',
            airline: bk.airline || fl?.airline || '',
            flightNumber: fl?.flight_number || '',
            destination: bk.destination_id || '',
            pieces: bk.pieces || 0,
            weight: (bk as any).chargeable_weight || 0,
            hasBattery: !!(bk as any).battery,
          })
        } else if (bk.booking_type === 'mawb') {
          // MAWB: show as single entry at booking level
          const key = `${bDoc.id}::0`
          if (existingKeys.has(key)) continue
          const totalPieces = (bk.awb_lines || []).reduce((sum, l) => sum + (l.pieces || 0), 0)
          const totalWeight = (bk.awb_lines || []).reduce((sum, l) => sum + (l.chargeable_weight || 0), 0)
          results.push({
            bookingId: bDoc.id,
            booking: bk,
            flight: fl,
            awbIndex: 0,
            awbNumber: bk.mawb_number || '',
            awb1stLeg: bk.mawb_number || '',
            clientName: bk.client_name || '',
            clientId: bk.client_id || '',
            airline: bk.airline || fl?.airline || '',
            flightNumber: fl?.flight_number || '',
            destination: bk.destination_id || '',
            pieces: totalPieces,
            weight: totalWeight,
            hasBattery: (bk.awb_lines || []).some(l => !!l.battery),
          })
        } else {
          // Ecommerce/export: show per-AWB line
          if (!bk.awb_lines || bk.awb_lines.length === 0) continue
          for (let i = 0; i < bk.awb_lines.length; i++) {
            const line = bk.awb_lines[i]
            const key = `${bDoc.id}::${i}`
            if (existingKeys.has(key)) continue
            results.push({
              bookingId: bDoc.id,
              booking: bk,
              flight: fl,
              awbIndex: i,
              awbNumber: line.awb_2nd_leg || line.awb_number || '',
              awb1stLeg: line.awb_number || '',
              clientName: bk.client_name || '',
              clientId: bk.client_id || '',
              airline: bk.airline || fl?.airline || '',
              flightNumber: fl?.flight_number || '',
              destination: bk.destination_id || '',
              pieces: line.pieces || 0,
              weight: line.chargeable_weight || 0,
              hasBattery: !!line.battery,
            })
          }
        }
      }

      // Attach DO badges info to results
      setAvailableAwbs(results)
      setDoByAwbKeyMap(doByAwbKey)
    } catch (err) {
      console.error('Error loading available AWBs:', err)
    } finally {
      setModalLoading(false)
    }
  }

  const filteredModal = useMemo(() => {
    if (!modalSearch.trim()) return availableAwbs
    const q = modalSearch.toLowerCase()
    return availableAwbs.filter(a =>
      a.awbNumber.toLowerCase().includes(q) ||
      a.clientName.toLowerCase().includes(q) ||
      a.awb1stLeg.toLowerCase().includes(q)
    )
  }, [availableAwbs, modalSearch])

  function toggleModalCheck(key: string) {
    setModalChecked(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function handleAddSelected() {
    const newEntries: AwbEntry[] = []
    for (const key of modalChecked) {
      const awb = availableAwbs.find(a => `${a.bookingId}::${a.awbIndex}` === key)
      if (!awb) continue
      const bType = awb.booking.booking_type === 'mawb' ? 'mawb' : awb.booking.booking_type === 'export' ? 'export' : 'ecommerce'
      newEntries.push({
        booking_id: awb.bookingId,
        booking_type: bType,
        awb_index: awb.awbIndex,
        awb_number: awb.awbNumber,
        awb_1st_leg: awb.awb1stLeg,
        client_name: awb.clientName,
        agent_name: awb.booking.agent_name || null,
        client_id: awb.clientId,
        flight_number: awb.flightNumber,
        flight_id: awb.flight?.id || awb.booking.flight_id,
        airline: awb.airline,
        destination: awb.destination,
        deliver_to: awb.airline,
        pieces: awb.pieces,
        weight: awb.weight,
        has_battery: awb.hasBattery,
        ...(bType === 'mawb' ? { selected_hawb_indices: (awb.booking.awb_lines || []).map((_, i) => i) } : {}),
      })
    }
    if (newEntries.length === 0) { setModalOpen(false); return }
    const updated = [...awbEntries, ...newEntries]
    setAwbEntries(updated)
    // Select new entries for CCSF/Sets
    const allIndices = new Set(updated.map((_, i) => i))
    setCcsfSelected(allIndices)
    setSetsSelected(new Set(allIndices))
    setModalOpen(false)
  }

  async function loadDriverQueue() {
    setDriverQueueLoading(true)
    try {
      const snap = await getDocs(collection(db, 'driver_queue'))
      const entries = snap.docs
        .map(d => ({ ...d.data() as DriverQueueEntry, id: d.id }))
        .filter(e => e.status !== 'expired' && new Date(e.expires_at) > new Date())
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      setDriverQueueEntries(entries)
    } catch (err) {
      console.error('Error loading driver queue:', err)
    } finally {
      setDriverQueueLoading(false)
    }
  }

  async function openDriverQueueModal() {
    setDriverQueueModal(true)
    await loadDriverQueue()
  }

  async function handleDeleteQueueEntry(entryId: string) {
    if (!confirm('Eliminar driver de la cola?')) return
    try {
      await deleteDoc(doc(db, 'driver_queue', entryId))
      await loadDriverQueue()
    } catch (err: any) {
      alert('Error al eliminar: ' + err.message)
    }
  }

  function selectDriverFromQueue(entry: DriverQueueEntry & { id: string }) {
    setDriverName(entry.driver_name)
    const effectiveCompany = entry.vendor_name || ''
    if (truckingOptions.includes(effectiveCompany)) {
      setTruckingCompany(effectiveCompany)
      setTruckingCustom('')
    } else if (effectiveCompany) {
      setTruckingCompany('__custom__')
      setTruckingCustom(effectiveCompany)
    }
    setSelectedQueueId(entry.id)
    setDriverQueueModal(false)
  }

  async function toggleMawbExpanded(entryIdx: number) {
    const entry = awbEntries[entryIdx]
    if (!entry || entry.booking_type !== 'mawb') return
    const next = new Set(mawbExpanded)
    if (next.has(entryIdx)) { next.delete(entryIdx); setMawbExpanded(next); return }
    next.add(entryIdx)
    setMawbExpanded(next)
    // Load lines if not cached
    if (!mawbLinesCache.has(entry.booking_id)) {
      try {
        const bSnap = await getDoc(doc(db, 'airfreight_bookings', entry.booking_id))
        if (bSnap.exists()) {
          const bk = bSnap.data() as AirfreightBooking
          setMawbLinesCache(prev => new Map(prev).set(entry.booking_id, bk.awb_lines || []))
        }
      } catch (err) {
        console.error('Error loading MAWB lines:', err)
      }
    }
  }

  function toggleHawbSelection(entryIdx: number, hawbIdx: number) {
    setAwbEntries(prev => {
      const updated = [...prev]
      const entry = { ...updated[entryIdx] }
      const current = entry.selected_hawb_indices || []
      if (current.includes(hawbIdx)) {
        entry.selected_hawb_indices = current.filter(i => i !== hawbIdx)
      } else {
        entry.selected_hawb_indices = [...current, hawbIdx].sort((a, b) => a - b)
      }
      updated[entryIdx] = entry
      return updated
    })
  }

  function removeEntry(idx: number) {
    const updated = awbEntries.filter((_, i) => i !== idx)
    setAwbEntries(updated)
    // Rebuild selection sets
    const allIndices = new Set(updated.map((_, i) => i))
    setCcsfSelected(allIndices)
    setSetsSelected(new Set(allIndices))
  }

  function renderAwbModal() {
    return (
      <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
          <div className="flex items-center justify-between p-4 border-b border-gray-200">
            <h3 className="text-sm font-bold text-gray-800">Agregar AWBs</h3>
            <button onClick={() => setModalOpen(false)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
          </div>
          <div className="p-4 border-b border-gray-100">
            <input
              value={modalSearch}
              onChange={e => setModalSearch(e.target.value)}
              placeholder="Buscar por AWB, cliente..."
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
              autoFocus
            />
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {modalLoading ? (
              <div className="flex items-center justify-center py-10">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-mcl-blue" />
              </div>
            ) : filteredModal.length === 0 ? (
              <div className="text-center py-10 text-gray-400 text-sm">No hay AWBs disponibles</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-500 uppercase">
                    <th className="px-2 py-1 w-8"></th>
                    <th className="px-2 py-1 text-left">AWB</th>
                    <th className="px-2 py-1 text-left">Cliente</th>
                    <th className="px-2 py-1 text-left">Vuelo</th>
                    <th className="px-2 py-1 text-left">Destino</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredModal.map(a => {
                    const key = `${a.bookingId}::${a.awbIndex}`
                    const existingDos = doByAwbKeyMap.get(key) || []
                    return (
                      <tr key={key} className="border-t border-gray-100 hover:bg-gray-50 cursor-pointer" onClick={() => toggleModalCheck(key)}>
                        <td className="px-2 py-1.5 text-center">
                          <input type="checkbox" checked={modalChecked.has(key)} onChange={e => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); toggleModalCheck(key) }} className="accent-mcl-blue" />
                        </td>
                        <td className="px-2 py-1.5">
                          <span className="font-mono font-bold">{a.awbNumber || a.awb1stLeg}</span>
                          {existingDos.length > 0 && (
                            <span className="ml-1.5 inline-flex gap-0.5">
                              {existingDos.map((doNum, di) => (
                                <span key={di} className="text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 font-semibold">{doNum}</span>
                              ))}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1.5">{a.clientName}</td>
                        <td className="px-2 py-1.5">{a.flightNumber}</td>
                        <td className="px-2 py-1.5">{a.destination}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
          <div className="flex items-center justify-between p-4 border-t border-gray-200">
            <span className="text-xs text-gray-500">{modalChecked.size} seleccionada{modalChecked.size !== 1 ? 's' : ''}</span>
            <div className="flex gap-2">
              <button onClick={() => setModalOpen(false)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Cancelar</button>
              <button
                onClick={handleAddSelected}
                disabled={modalChecked.size === 0}
                className="px-4 py-2 text-sm font-semibold bg-mcl-blue text-white rounded-lg hover:bg-mcl-blue/90 disabled:opacity-50"
              >
                Agregar seleccionadas
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <Layout title="Delivery Order" backTo="/airfreight/delivery-orders">
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" />
        </div>
      </Layout>
    )
  }

  if (awbEntries.length === 0 && !isNewMode) {
    return (
      <Layout title="Delivery Order" backTo="/airfreight/delivery-orders">
        <div className="text-center py-20 text-gray-400">Booking o AWB no encontrado</div>
      </Layout>
    )
  }

  if (awbEntries.length === 0 && isNewMode) {
    return (
      <Layout title="Delivery Order" backTo="/airfreight/delivery-orders">
        <div className="max-w-5xl mx-auto space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-gray-800">Nueva Delivery Order</h2>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-8 text-center space-y-3">
            <p className="text-sm text-gray-500">Selecciona las AWBs para esta Delivery Order</p>
            <button
              onClick={openAddAwbModal}
              className="px-4 py-2 bg-mcl-blue text-white text-sm font-semibold rounded-lg hover:bg-mcl-blue/90 transition-colors"
            >
              Seleccionar AWBs
            </button>
          </div>
        </div>
        {/* Modal rendered here too */}
        {modalOpen && renderAwbModal()}
      </Layout>
    )
  }

  return (
    <Layout title="Delivery Order" backTo="/airfreight/delivery-orders">
      <div className="max-w-5xl mx-auto space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-gray-800">Delivery Order</h2>
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/airfreight/delivery-orders')}
              className="text-xs font-semibold text-mcl-blue border border-mcl-blue/30 rounded-lg px-3 py-1 hover:bg-mcl-blue/5 transition-colors"
            >
              Ver todas las DOs
            </button>
            {doNumber && (
              <span className="text-xs font-bold bg-mcl-blue text-white px-3 py-1 rounded-full">{doNumber}</span>
            )}
          </div>
        </div>

        {/* Existing DOs banner — shown when navigating from booking and DOs already exist */}
        {existingDOs.length > 0 && !doDocId && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-amber-800">
                  {existingDOs.length} DO{existingDOs.length > 1 ? 's' : ''} existente{existingDOs.length > 1 ? 's' : ''} para esta AWB
                </p>
                <div className="flex flex-wrap gap-2 mt-1.5">
                  {existingDOs.map(d => (
                    <button
                      key={d.id}
                      onClick={() => navigate(`/airfreight/delivery-order/doc/${d.id}`)}
                      className={`text-xs font-mono px-2 py-1 rounded border transition-colors ${
                        doId === d.id
                          ? 'bg-mcl-blue text-white border-mcl-blue'
                          : 'bg-white text-gray-700 border-gray-300 hover:border-mcl-blue hover:text-mcl-blue'
                      }`}
                    >
                      {d.do_number} — {d.trucking_company || '?'}
                    </button>
                  ))}
                </div>
              </div>
              {!forceNew && (
                <button
                  onClick={() => { setForceNew(true); setDoId(null); setDoNumber(''); setDriverPin(''); setDriverName(''); setTruckingCompany(''); setTruckingCustom(''); setSealNumber(''); setEscortName(''); setUldsLoaded(['']); setMclAgent(user?.email?.split('@')[0] || '') }}
                  className="text-xs bg-mcl-blue hover:bg-blue-900 text-white font-semibold px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                >
                  + Nueva DO
                </button>
              )}
              {forceNew && (
                <span className="text-xs font-semibold text-green-700 bg-green-100 px-2 py-1 rounded-full">Creando nueva</span>
              )}
            </div>
          </div>
        )}

        {/* AWB Table — compact */}
        <div className="bg-white rounded-xl border border-gray-200 p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">AWBs en esta DO</span>
            <button onClick={openAddAwbModal} className="text-xs font-semibold text-mcl-blue hover:underline">+ Agregar</button>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-50 text-[10px] text-gray-500 uppercase">
                <th className="px-2 py-1.5 text-left">AWB</th>
                <th className="px-2 py-1.5 text-left">Cliente</th>
                <th className="px-2 py-1.5 text-left">Deliver To</th>
                <th className="px-2 py-1.5 text-left">Destino</th>
                <th className="px-2 py-1.5 text-left">Vuelo</th>
                <th className="px-2 py-1.5 w-6"></th>
              </tr>
            </thead>
            <tbody>
              {awbEntries.map((e, i) => (
                <React.Fragment key={`${e.booking_id}::${e.awb_index}`}>
                  <tr className="border-t border-gray-100">
                    <td className="px-2 py-1 font-mono font-bold">
                      {e.booking_type === 'mawb' && (
                        <button onClick={() => toggleMawbExpanded(i)} className="text-purple-500 mr-1 text-[10px] font-bold">{mawbExpanded.has(i) ? '▼' : '▶'}</button>
                      )}
                      {e.awb_number || e.awb_1st_leg}
                      {(() => {
                        // Use frozen status if saved, otherwise compute live
                        if (e.frozen_pc === 'C') return <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-green-500 text-[8px] font-bold text-white" title="Completo (congelado)">C</span>
                        if (e.frozen_pc === 'P') return <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-amber-400 text-[8px] font-bold text-white" title="Parcial (congelado)">P</span>
                        const pc = pcMap.get(e.awb_number)
                        if (!pc || pc.total === 0) return <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-gray-200 text-[8px] font-bold text-gray-500" title="Sin piezas fisicas">&ndash;</span>
                        if (pc.inUld > 0 && pc.inThisAndPrevious >= pc.total) return <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-green-500 text-[8px] font-bold text-white" title={`${pc.inUld}/${pc.total} este DO · ${pc.inThisAndPrevious}/${pc.total} acumulado`}>C</span>
                        if (pc.inUld > 0) return <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-amber-400 text-[8px] font-bold text-white" title={`${pc.inUld}/${pc.total} este DO · ${pc.inThisAndPrevious}/${pc.total} acumulado`}>P</span>
                        return <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-gray-200 text-[8px] font-bold text-gray-500" title="0 en ULD">&ndash;</span>
                      })()}
                      {e.booking_type === 'mawb' && (
                        <span className="ml-1.5 text-[9px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded font-semibold">MAWB</span>
                      )}
                    </td>
                    <td className="px-2 py-1">{e.client_name}</td>
                    <td className="px-2 py-1">{e.deliver_to}</td>
                    <td className="px-2 py-1">{e.destination}</td>
                    <td className="px-2 py-1">{e.flight_number}</td>
                    <td className="px-2 py-1 text-center">
                      {awbEntries.length > 1 && (
                        <button onClick={() => removeEntry(i)} className="text-red-400 hover:text-red-600 leading-none">&times;</button>
                      )}
                    </td>
                  </tr>
                  {/* MAWB HAWB selector */}
                  {e.booking_type === 'mawb' && mawbExpanded.has(i) && (() => {
                    const lines = mawbLinesCache.get(e.booking_id) || []
                    const selectedIndices = e.selected_hawb_indices || []
                    return (
                      <tr>
                        <td colSpan={6} className="px-2 py-1.5 bg-purple-50/50">
                          <div className="text-[10px] font-semibold text-purple-600 uppercase mb-1">
                            HAWBs en este camión ({selectedIndices.length}/{lines.length})
                            <button onClick={() => {
                              const allSelected = selectedIndices.length === lines.length
                              setAwbEntries(prev => {
                                const updated = [...prev]
                                updated[i] = { ...updated[i], selected_hawb_indices: allSelected ? [] : lines.map((_, idx) => idx) }
                                return updated
                              })
                            }} className="ml-2 text-purple-500 hover:text-purple-700 font-normal">{selectedIndices.length === lines.length ? 'Deseleccionar todas' : 'Seleccionar todas'}</button>
                          </div>
                          {lines.length === 0 ? (
                            <div className="text-[10px] text-gray-400">Cargando...</div>
                          ) : (
                            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                              {lines.map((line, li) => (
                                <label key={li} className="flex items-center gap-1.5 text-[11px] cursor-pointer hover:bg-purple-50 rounded px-1">
                                  <input
                                    type="checkbox"
                                    checked={selectedIndices.includes(li)}
                                    onChange={() => toggleHawbSelection(i, li)}
                                    className="accent-purple-600"
                                  />
                                  <span className="font-mono font-semibold">{line.awb_2nd_leg || line.awb_number}</span>
                                  <span className="text-gray-400">{line.pieces}pcs {fmtNum(line.chargeable_weight)}kg</span>
                                </label>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })()}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>

        {/* Transport Form — 2 column grid */}
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            {/* Trucking Company */}
            <div>
              <label className="block text-[10px] font-semibold text-gray-500 uppercase mb-0.5">Trucking Company</label>
              <div className="flex gap-1">
                <select
                  value={truckingCompany}
                  onChange={e => setTruckingCompany(e.target.value)}
                  className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs flex-1 focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                >
                  <option value="">Seleccionar...</option>
                  {truckingOptions.map(o => <option key={o} value={o}>{o}</option>)}
                  <option value="__custom__">Otro...</option>
                </select>
                {truckingCompany === '__custom__' && (
                  <input value={truckingCustom} onChange={e => setTruckingCustom(e.target.value)} placeholder="Nombre" className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs flex-1 focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
                )}
              </div>
            </div>
            {/* Driver Name */}
            <div>
              <label className="block text-[10px] font-semibold text-gray-500 uppercase mb-0.5">Driver Name</label>
              <div className="flex gap-1">
                <input value={driverName} onChange={e => setDriverName(e.target.value)} className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
                <button onClick={openDriverQueueModal} type="button" className="text-[10px] font-semibold text-mcl-blue border border-mcl-blue/30 rounded-lg px-2 py-1 hover:bg-mcl-blue/5 whitespace-nowrap">Cola</button>
              </div>
              {selectedQueueId && <span className="text-[10px] text-green-600 mt-0.5 block">Driver de cola seleccionado</span>}
            </div>
            {/* Driver PIN */}
            {driverPin && (
              <div>
                <label className="block text-[10px] font-semibold text-gray-500 uppercase mb-0.5">Driver PIN</label>
                <div className="text-lg font-mono font-bold text-mcl-blue tracking-[0.3em] bg-blue-50 border border-blue-200 rounded-lg px-3 py-1.5 text-center">{driverPin}</div>
              </div>
            )}
            {/* Chain of Custody */}
            <div>
              <label className="block text-[10px] font-semibold text-gray-500 uppercase mb-0.5">Chain of Custody</label>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                <label className="flex items-center gap-1 text-xs">
                  <input type="radio" name="custody" checked={custodyMethod === 'seal'} onChange={() => setCustodyMethod('seal')} className="accent-mcl-blue" />
                  Seal
                  {custodyMethod === 'seal' && (
                    <input value={sealNumber} onChange={e => setSealNumber(e.target.value)} placeholder="#" className="ml-1 border border-gray-200 rounded px-1.5 py-0.5 text-xs w-24 focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
                  )}
                </label>
                <label className="flex items-center gap-1 text-xs">
                  <input type="radio" name="custody" checked={custodyMethod === 'escort'} onChange={() => setCustodyMethod('escort')} className="accent-mcl-blue" />
                  Escort
                  {custodyMethod === 'escort' && (
                    <input value={escortName} onChange={e => setEscortName(e.target.value)} placeholder="Name" className="ml-1 border border-gray-200 rounded px-1.5 py-0.5 text-xs w-24 focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
                  )}
                </label>
                <label className="flex items-center gap-1 text-xs">
                  <input type="radio" name="custody" checked={custodyMethod === 'locked_vehicle'} onChange={() => setCustodyMethod('locked_vehicle')} className="accent-mcl-blue" />
                  Locked
                </label>
              </div>
            </div>
            {/* MCL Agent */}
            <div>
              <label className="block text-[10px] font-semibold text-gray-500 uppercase mb-0.5">MCL Agent</label>
              <input value={mclAgent} onChange={e => setMclAgent(e.target.value)} className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
            </div>
            {/* ULDs Loaded — full width */}
            <div className="col-span-2">
              <label className="block text-[10px] font-semibold text-gray-500 uppercase mb-0.5">ULDs Loaded</label>
              <div className="flex flex-wrap gap-1.5">
                {uldsLoaded.map((uld, i) => (
                  <input key={i} value={uld} onChange={e => { const next = [...uldsLoaded]; next[i] = e.target.value; setUldsLoaded(next) }} placeholder={`ULD ${i + 1}`} className="border border-gray-200 rounded px-2 py-1 text-xs w-24 focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
                ))}
                {uldsLoaded.length < 10 && (
                  <button onClick={() => setUldsLoaded([...uldsLoaded, ''])} className="text-[10px] text-mcl-blue font-semibold hover:underline px-1 py-1">+ ULD</button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Actions row: Save + View DO */}
        <div className="flex gap-2">
          <button onClick={handleSave} disabled={saving} className="flex-1 bg-mcl-blue text-white font-semibold rounded-lg py-2 text-xs hover:bg-mcl-blue/90 transition-colors disabled:opacity-50">
            {saving ? 'Guardando...' : 'Guardar DO'}
          </button>
          <button onClick={handleViewDO} className="flex-1 border-2 border-mcl-blue text-mcl-blue font-semibold rounded-lg py-2 text-xs hover:bg-mcl-blue/5 transition-colors">
            Ver / Imprimir DO
          </button>
        </div>

        {/* CCSF + Document Sets — side by side */}
        <div className="grid grid-cols-2 gap-3">
          {/* CCSF */}
          <div className="bg-white rounded-xl border border-gray-200 p-3 space-y-2">
            <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100 pb-1">CCSF</div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-gray-500 font-semibold">Screening:</span>
                <label className="flex items-center gap-1 text-xs"><input type="radio" name="ccsf" checked={ccsfType === 'originated'} onChange={() => setCcsfType('originated')} className="accent-mcl-blue" />Originated</label>
                <label className="flex items-center gap-1 text-xs"><input type="radio" name="ccsf" checked={ccsfType === 'on_behalf'} onChange={() => setCcsfType('on_behalf')} className="accent-mcl-blue" />On behalf</label>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-gray-500 font-semibold">Accepted:</span>
                <label className="flex items-center gap-1 text-xs"><input type="radio" name="accepted" checked={acceptedFor === 'CAO'} onChange={() => setAcceptedFor('CAO')} className="accent-mcl-blue" />CAO</label>
                <label className="flex items-center gap-1 text-xs"><input type="radio" name="accepted" checked={acceptedFor === 'PAX'} onChange={() => setAcceptedFor('PAX')} className="accent-mcl-blue" />PAX</label>
              </div>
            </div>
            <div className="space-y-0.5">
              {awbEntries.map((e, i) => (
                <label key={i} className="flex items-center gap-1.5 text-xs">
                  <input type="checkbox" checked={ccsfSelected.has(i)} onChange={() => { setCcsfSelected(prev => { const next = new Set(prev); if (next.has(i)) next.delete(i); else next.add(i); return next }) }} className="accent-mcl-blue" />
                  {e.awb_number || e.awb_1st_leg} <span className="text-gray-400">({e.client_name})</span>
                </label>
              ))}
            </div>
            <button onClick={handleGenerateCcsf} className="w-full border border-gray-300 text-gray-700 font-semibold rounded-lg py-1.5 text-xs hover:bg-gray-50 transition-colors">
              Generar CCSF
            </button>
            <button onClick={handleGenerateCcsssp} className="w-full border border-amber-300 text-amber-700 font-semibold rounded-lg py-1.5 text-xs hover:bg-amber-50 transition-colors">
              Generar CCSSSP
            </button>
          </div>

          {/* Document Sets */}
          <div className="bg-white rounded-xl border border-gray-200 p-3 space-y-2">
            <div className="flex items-center justify-between border-b border-gray-100 pb-1">
              <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Document Sets</span>
              <label className="flex items-center gap-1 text-[10px] text-gray-400">
                <input type="checkbox" checked={setsSelected.size === awbEntries.length} onChange={() => { if (setsSelected.size === awbEntries.length) setSetsSelected(new Set()); else setSetsSelected(new Set(awbEntries.map((_, i) => i))) }} className="accent-mcl-blue" />
                Todos
              </label>
            </div>
            <div className="space-y-0.5">
              {awbEntries.map((e, i) => (
                <label key={i} className="flex items-center gap-1.5 text-xs">
                  <input type="checkbox" checked={setsSelected.has(i)} onChange={() => { setSetsSelected(prev => { const next = new Set(prev); if (next.has(i)) next.delete(i); else next.add(i); return next }) }} className="accent-mcl-blue" />
                  {e.awb_number || e.awb_1st_leg} <span className="text-gray-400">({e.client_name})</span>
                </label>
              ))}
            </div>
            <div className="flex gap-3">
              <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={setCounter} onChange={e => setSetCounter(e.target.checked)} className="accent-mcl-blue" />Counter</label>
              <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={setDriverFlag} onChange={e => setSetDriverFlag(e.target.checked)} className="accent-mcl-blue" />Driver</label>
              <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={setEnvelope} onChange={e => setSetEnvelope(e.target.checked)} className="accent-mcl-blue" />Envelope</label>
            </div>
            {/* Generated set results */}
            {generatedSets.size > 0 && (
              <div className="border border-gray-100 rounded-lg p-2 space-y-1.5 bg-gray-50">
                {awbEntries.map((e, i) => {
                  const hasCounter = generatedSets.has(`${i}-counter`)
                  const hasDriver = generatedSets.has(`${i}-driver`)
                  const hasEnvelope = generatedSets.has(`${i}-envelope`)
                  if (!hasCounter && !hasDriver && !hasEnvelope) return null
                  return (
                    <div key={i} className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] font-mono font-bold text-gray-600 min-w-[100px]">{e.awb_number || e.awb_1st_leg}</span>
                      {hasCounter && <button onClick={() => window.open(generatedSets.get(`${i}-counter`)!, '_blank')} className="text-[10px] font-semibold px-2 py-0.5 rounded bg-mcl-blue text-white hover:bg-mcl-blue/90">Counter</button>}
                      {hasDriver && <button onClick={() => window.open(generatedSets.get(`${i}-driver`)!, '_blank')} className="text-[10px] font-semibold px-2 py-0.5 rounded bg-amber-500 text-white hover:bg-amber-600">Driver</button>}
                      {hasEnvelope && <button onClick={() => window.open(generatedSets.get(`${i}-envelope`)!, '_blank')} className="text-[10px] font-semibold px-2 py-0.5 rounded bg-purple-500 text-white hover:bg-purple-600">Envelope</button>}
                    </div>
                  )
                })}
              </div>
            )}
            <button onClick={handleGenerateSets} disabled={generating} className="w-full bg-emerald-600 text-white font-semibold rounded-lg py-1.5 text-xs hover:bg-emerald-700 transition-colors disabled:opacity-50">
              {generating ? 'Generando...' : 'Generar Sets'}
            </button>
          </div>
        </div>
      </div>

      {/* ── Modal: Add AWB ── */}
      {modalOpen && renderAwbModal()}

      {/* ── Modal: Driver Queue ── */}
      {driverQueueModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[70vh] flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h3 className="text-sm font-bold text-gray-800">Seleccionar Driver de Cola</h3>
              <button onClick={() => setDriverQueueModal(false)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {driverQueueLoading ? (
                <div className="flex items-center justify-center py-10">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-mcl-blue" />
                </div>
              ) : driverQueueEntries.length === 0 ? (
                <div className="text-center py-10 text-gray-400 text-sm">No hay drivers en cola</div>
              ) : (
                <div className="space-y-2">
                  {driverQueueEntries.map(entry => (
                    <div key={entry.id} className="flex items-center gap-2">
                      <button
                        onClick={() => entry.status === 'waiting' && selectDriverFromQueue(entry)}
                        disabled={entry.status !== 'waiting'}
                        className={`flex-1 text-left border rounded-lg p-3 transition-colors ${
                          entry.status === 'waiting'
                            ? 'bg-gray-50 hover:bg-blue-50 border-gray-200 hover:border-mcl-blue cursor-pointer'
                            : 'bg-gray-50 border-gray-200 opacity-50 cursor-not-allowed'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="text-sm font-semibold">{entry.driver_name}</div>
                            <div className="text-xs text-gray-500">{entry.vendor_name || 'Sin empresa'} {entry.plate ? `| ${entry.plate}` : ''}</div>
                          </div>
                          {entry.status === 'linked' && (
                            <span className="text-[10px] bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-semibold">Linked</span>
                          )}
                        </div>
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteQueueEntry(entry.id!) }}
                        className="text-red-400 hover:text-red-600 p-2 hover:bg-red-50 rounded-lg transition-colors"
                        title="Eliminar"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}
