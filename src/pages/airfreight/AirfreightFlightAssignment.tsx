import React, { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { collection, query, getDocs, getDoc, orderBy, doc, updateDoc, addDoc, where, writeBatch } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import Layout from '../../components/Layout'
import { fmtNum } from '../../lib/utils'
import { AirfreightFlight, AirfreightBooking } from '../../types'
import { computeAwbNumbersNormalized } from '../../lib/awbNormalize'

// ── Types ──────────────────────────────────────────────────────────────────────

interface DocReception {
  id: string
  awb_number: string
  awb_2nd_leg: string | null
  mawb_number: string | null
  client_name: string
  destination: string
  pieces: number
  weight: number
  chargeable_weight: number
  flight_id: string | null
  flight_number: string
  booking_id: string | null
  agent_name: string | null
  status: string // pending_physical | in_physical | complete
  warehouse_number: string | null
  cargo_type: 'loose' | 'bup'
  has_battery?: boolean
  has_dg?: boolean
  warehouse_type: string
  created_at: string
}

interface FlightOption {
  id: string
  flight_number: string
  airline: string
  destinations: string[]
  flight_datetime: string
  flight_status?: string
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function fmtDateTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' +
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
}


// ── Component ──────────────────────────────────────────────────────────────────

export default function AirfreightFlightAssignment() {
  const navigate = useNavigate()
  const { user } = useAuth()

  const [loading, setLoading] = useState(true)
  const [docRecs, setDocRecs] = useState<DocReception[]>([])
  const [flights, setFlights] = useState<FlightOption[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [lockedIds, setLockedIds] = useState<Set<string>>(new Set()) // AWBs with pieces in ULDs

  // Filters
  const [search, setSearch] = useState('')
  const [filterClient, setFilterClient] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterFlight, setFilterFlight] = useState('')
  const [filterDest, setFilterDest] = useState('')

  // Action bar
  const [flightDropdownOpen, setFlightDropdownOpen] = useState(false)
  const [flightSearch, setFlightSearch] = useState('')
  const [assigning, setAssigning] = useState(false)

  // New flight modal
  const [newFlightModal, setNewFlightModal] = useState(false)
  const [nfNumber, setNfNumber] = useState('')
  const [nfAirline, setNfAirline] = useState('')
  const [nfDest, setNfDest] = useState('')
  const [nfDate, setNfDate] = useState(new Date().toLocaleDateString('en-CA'))
  const [nfSaving, setNfSaving] = useState(false)

  // Client map for booking creation
  const [clientNameToId, setClientNameToId] = useState<Map<string, string>>(new Map())

  // Toast
  const [toast, setToast] = useState('')

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(''), 3000)
  }

  // ── Load data ─────────────────────────────────────────────────────────────

  useEffect(() => {
    ;(async () => {
      try {
        const [drSnap, flSnap, clSnap] = await Promise.all([
          getDocs(query(collection(db, 'airfreight_doc_receptions'), orderBy('created_at', 'desc'))),
          getDocs(query(collection(db, 'airfreight_flights'), orderBy('flight_datetime', 'desc'))),
          getDocs(query(collection(db, 'airfreight_clients'), where('active', '==', true))),
        ])

        // Build client name → id map
        const cMap = new Map<string, string>()
        clSnap.docs.forEach(d => { const data = d.data(); if (data.name) cMap.set(data.name, d.id) })
        setClientNameToId(cMap)

        const drs: DocReception[] = drSnap.docs.map(d => ({ ...d.data() as any, id: d.id }))
        setDocRecs(drs)

        const fls: FlightOption[] = flSnap.docs.map(d => {
          const data = d.data() as any
          return {
            id: d.id,
            flight_number: data.flight_number || '',
            airline: data.airline || '',
            destinations: data.destinations || [],
            flight_datetime: data.flight_datetime || '',
            flight_status: data.flight_status || 'booked',
          }
        })
        setFlights(fls)

        // Check which doc_receptions have pieces in ULDs (locked)
        const piecesSnap = await getDocs(collection(db, 'airfreight_physical_pieces'))
        const lockedDocRecIds = new Set<string>()
        piecesSnap.forEach(d => {
          const p = d.data()
          if (p.uld_id) lockedDocRecIds.add(p.doc_reception_id)
        })
        setLockedIds(lockedDocRecIds)
      } catch (err) {
        console.error('Error loading data:', err)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  // ── Derived data ──────────────────────────────────────────────────────────

  const clients = useMemo(() => [...new Set(docRecs.map(d => d.client_name).filter(Boolean))].sort(), [docRecs])
  const destinations = useMemo(() => [...new Set(docRecs.map(d => d.destination).filter(Boolean))].sort(), [docRecs])

  const filtered = useMemo(() => {
    return docRecs.filter(d => {
      if (search) {
        const q = search.toLowerCase()
        const awb = (d.awb_2nd_leg || d.awb_number || '').toLowerCase()
        if (!awb.includes(q) && !(d.client_name || '').toLowerCase().includes(q)) return false
      }
      if (filterClient && d.client_name !== filterClient) return false
      if (filterStatus === 'D' && d.status === 'complete') return false
      if (filterStatus === 'R' && d.status !== 'complete') return false
      if (filterFlight === 'none' && d.flight_id) return false
      if (filterFlight === 'assigned' && !d.flight_id) return false
      if (filterFlight && filterFlight !== 'none' && filterFlight !== 'assigned' && d.flight_id !== filterFlight) return false
      if (filterDest && d.destination !== filterDest) return false
      return true
    })
  }, [docRecs, search, filterClient, filterStatus, filterFlight, filterDest])

  const stats = useMemo(() => {
    const total = docRecs.length
    const noFlight = docRecs.filter(d => !d.flight_id).length
    const withFlight = docRecs.filter(d => !!d.flight_id).length
    const activeFlights = new Set(docRecs.filter(d => d.flight_id).map(d => d.flight_id)).size
    return { total, noFlight, withFlight, activeFlights }
  }, [docRecs])

  const selectedEntries = filtered.filter(d => selected.has(d.id))
  const selectedPcs = selectedEntries.reduce((s, d) => s + d.pieces, 0)
  const selectedKg = selectedEntries.reduce((s, d) => s + d.weight, 0)

  // Flights for dropdown (exclude dispatched)
  const availableFlights = useMemo(() => {
    const q = flightSearch.toLowerCase()
    return flights
      .filter(f => f.flight_status !== 'dispatched')
      .filter(f => !q || f.flight_number.toLowerCase().includes(q) || f.airline.toLowerCase().includes(q) || f.destinations.join(' ').toLowerCase().includes(q))
  }, [flights, flightSearch])

  // ── Selection ─────────────────────────────────────────────────────────────

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    const selectable = filtered.filter(d => !lockedIds.has(d.id))
    if (selected.size === selectable.length && selectable.length > 0) {
      setSelected(new Set())
    } else {
      setSelected(new Set(selectable.map(d => d.id)))
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  function normalizeAwb(val: string | null | undefined): string {
    return (val || '').replace(/[^A-Z0-9]/gi, '').toUpperCase()
  }

  /** Try to find a booking for a doc reception that has booking_id: null */
  async function resolveBookingForDr(dr: DocReception): Promise<{ bookingId: string; awbIndex: number } | null> {
    if (dr.booking_id) return null // already linked
    const awb = normalizeAwb(dr.awb_number) || normalizeAwb(dr.awb_2nd_leg)
    if (!awb) return null
    const bSnap = await getDocs(collection(db, 'airfreight_bookings'))
    for (const bDoc of bSnap.docs) {
      const bk = bDoc.data() as AirfreightBooking
      if (bk.booking_type === 'simple') {
        if (normalizeAwb(bk.awb_2nd_leg) === awb || normalizeAwb(bk.awb_1st_leg) === awb) {
          return { bookingId: bDoc.id, awbIndex: 0 }
        }
      } else {
        const lines = bk.awb_lines || []
        for (let i = 0; i < lines.length; i++) {
          if (normalizeAwb(lines[i].awb_number) === awb || normalizeAwb(lines[i].awb_2nd_leg) === awb) {
            return { bookingId: bDoc.id, awbIndex: i }
          }
        }
      }
    }
    return null
  }

  /** Mark AWB line as documented in the booking */
  async function markBookingDocumented(bookingId: string, awbIdx: number) {
    try {
      const bRef = doc(db, 'airfreight_bookings', bookingId)
      const bSnap = await getDoc(bRef)
      if (!bSnap.exists()) return
      const bk = bSnap.data() as AirfreightBooking
      if (bk.booking_type === 'simple') {
        await updateDoc(bRef, { warehouse_status: 'D' })
      } else {
        const lines = [...(bk.awb_lines || [])]
        if (lines[awbIdx]) {
          lines[awbIdx] = { ...lines[awbIdx], warehouse_status: 'D' }
          await updateDoc(bRef, { awb_lines: lines })
        }
      }
    } catch (err) {
      console.error('Error marking booking documented:', err)
    }
  }

  /** Create a simple booking for a doc reception that has no booking */
  function buildAutoBookingData(dr: DocReception, flightId: string, flightNumber: string, airline: string): Record<string, any> {
    const awb1 = dr.awb_number || dr.awb_2nd_leg || ''
    const awb2 = dr.awb_2nd_leg || null
    const awbLine = {
      awb_number: awb1,
      awb_2nd_leg: awb2 || null,
      pieces: dr.pieces || 0,
      weight: dr.weight || 0,
      chargeable_weight: dr.chargeable_weight || 0,
      uld_type: dr.cargo_type === 'bup' ? 'BUP' : 'LOOSE',
      battery: dr.has_battery || false,
      ddgg: dr.has_dg || false,
      hold: false,
      on_hand: false,
      pickup_from: null,
      ready_for_pickup: null,
      last_day_free: null,
      docs_in_drive: false,
    }
    const bookingData = {
      booking_type: 'ecommerce',
      flight_id: flightId,
      flight_number: flightNumber,
      airline: airline,
      client_id: clientNameToId.get(dr.client_name) || '',
      client_name: dr.client_name,
      agent_name: dr.agent_name || null,
      status: 'submitted',
      created_by: user?.email || '',
      created_at: new Date().toISOString(),
      change_count: 0,
      modified_seen: true,
      change_log: [],
      documents: {},
      destination_id: dr.destination || '',
      awb_lines: [awbLine],
      pieces: awbLine.pieces,
      hold: false,
      on_hand: false,
    }
    bookingData.awb_numbers_normalized = computeAwbNumbersNormalized(bookingData)
    return bookingData
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  async function assignToFlight(flightId: string) {
    if (selected.size === 0) return
    const fl = flights.find(f => f.id === flightId)
    if (!fl) return
    const flightNumber = fl.flight_number || ''
    const flightDests = (fl.destinations || []).map(d => d.toUpperCase())

    // Check destination mismatch
    const mismatched = selectedEntries.filter(d => d.destination && !flightDests.includes(d.destination.toUpperCase()))
    if (mismatched.length > 0) {
      const awbList = mismatched.map(d => `${d.awb_2nd_leg || d.awb_number} (${d.destination})`).join('\n')
      const ok = window.confirm(
        `Destino no corresponde con vuelo ${flightNumber} (${flightDests.join(',')}):\n\n${awbList}\n\n¿Asignar de todas formas?`
      )
      if (!ok) return
    }

    setAssigning(true)
    try {
      // For each selected, update flight + resolve booking if missing
      const drWithoutBooking = selectedEntries.filter(d => !d.booking_id)
      let bookingResolutions: Map<string, { bookingId: string; awbIndex: number }> = new Map()

      // Resolve bookings for unlinked doc receptions (single query, reuse for all)
      if (drWithoutBooking.length > 0) {
        const bSnap = await getDocs(collection(db, 'airfreight_bookings'))
        for (const dr of drWithoutBooking) {
          const awb = normalizeAwb(dr.awb_number) || normalizeAwb(dr.awb_2nd_leg)
          if (!awb) continue
          for (const bDoc of bSnap.docs) {
            const bk = bDoc.data() as AirfreightBooking
            if (bk.booking_type === 'simple') {
              if (normalizeAwb(bk.awb_2nd_leg) === awb || normalizeAwb(bk.awb_1st_leg) === awb) {
                bookingResolutions.set(dr.id, { bookingId: bDoc.id, awbIndex: 0 })
                break
              }
            } else {
              const lines = bk.awb_lines || []
              let found = false
              for (let i = 0; i < lines.length; i++) {
                if (normalizeAwb(lines[i].awb_number) === awb || normalizeAwb(lines[i].awb_2nd_leg) === awb) {
                  bookingResolutions.set(dr.id, { bookingId: bDoc.id, awbIndex: i })
                  found = true
                  break
                }
              }
              if (found) break
            }
          }
        }
      }

      // Auto-create simple bookings for doc receptions without any booking match
      for (const dr of drWithoutBooking) {
        if (bookingResolutions.has(dr.id)) continue // already resolved
        const bookingData = buildAutoBookingData(dr, flightId, flightNumber, fl.airline || '')
        const bookingRef = await addDoc(collection(db, 'airfreight_bookings'), bookingData)
        bookingResolutions.set(dr.id, { bookingId: bookingRef.id, awbIndex: 0 })
      }

      const batch = writeBatch(db)
      for (const drId of selected) {
        const update: any = { flight_id: flightId, flight_number: flightNumber }
        const resolved = bookingResolutions.get(drId)
        if (resolved) {
          update.booking_id = resolved.bookingId
          update.awb_index = resolved.awbIndex
        }
        batch.update(doc(db, 'airfreight_doc_receptions', drId), update)
      }
      await batch.commit()

      // Mark newly linked bookings as documented
      for (const [, resolved] of bookingResolutions) {
        await markBookingDocumented(resolved.bookingId, resolved.awbIndex)
      }

      // Update local state
      setDocRecs(prev => prev.map(d => {
        if (!selected.has(d.id)) return d
        const resolved = bookingResolutions.get(d.id)
        return {
          ...d,
          flight_id: flightId,
          flight_number: flightNumber,
          booking_id: resolved?.bookingId || d.booking_id,
        }
      }))
      showToast(`${selected.size} AWB${selected.size > 1 ? 's' : ''} asignadas a ${flightNumber}`)
      setSelected(new Set())
      setFlightDropdownOpen(false)
    } catch (err: any) {
      alert('Error: ' + err.message)
    } finally {
      setAssigning(false)
    }
  }

  async function removeFromFlight() {
    if (selected.size === 0) return
    setAssigning(true)
    try {
      // Check if any selected AWBs have pieces assigned to ULDs
      const lockedAwbs: string[] = []
      for (const drId of selected) {
        if (lockedIds.has(drId)) {
          const dr = docRecs.find(d => d.id === drId)
          lockedAwbs.push(dr?.awb_2nd_leg || dr?.awb_number || drId)
        }
      }
      if (lockedAwbs.length > 0) {
        alert(`No se puede quitar del vuelo — las siguientes AWBs tienen piezas en ULDs:\n\n${lockedAwbs.join('\n')}\n\nDesbloquéalas primero.`)
        setAssigning(false)
        return
      }
      const batch = writeBatch(db)
      for (const drId of selected) {
        batch.update(doc(db, 'airfreight_doc_receptions', drId), {
          flight_id: null,
          flight_number: '',
        })
      }
      await batch.commit()
      setDocRecs(prev => prev.map(d =>
        selected.has(d.id) ? { ...d, flight_id: null, flight_number: '' } : d
      ))
      showToast(`${selected.size} AWB${selected.size > 1 ? 's' : ''} removidas del vuelo`)
      setSelected(new Set())
    } catch (err: any) {
      alert('Error: ' + err.message)
    } finally {
      setAssigning(false)
    }
  }

  async function unlockAwb(drId: string) {
    if (!confirm('Desbloquear AWB? Se quitarán las piezas de los ULDs y podrás reasignarla.')) return
    try {
      // Remove uld_id from all physical pieces of this doc_reception
      const pSnap = await getDocs(query(
        collection(db, 'airfreight_physical_pieces'),
        where('doc_reception_id', '==', drId),
      ))
      if (pSnap.size > 0) {
        const batch = writeBatch(db)
        pSnap.docs.forEach(d => batch.update(d.ref, { uld_id: null }))
        await batch.commit()
      }
      // Also reset warehouse_status on booking if linked
      const dr = docRecs.find(d => d.id === drId)
      if (dr?.booking_id) {
        const bRef = doc(db, 'airfreight_bookings', dr.booking_id)
        const bSnap = await getDoc(bRef)
        if (bSnap.exists()) {
          const bk = bSnap.data() as any
          if (bk.booking_type === 'simple') {
            await updateDoc(bRef, { warehouse_status: 'R' })
          } else if (bk.awb_lines) {
            const lines = [...bk.awb_lines]
            const awb = dr.awb_number || ''
            const idx = lines.findIndex((l: any) => l.awb_number === awb || l.awb_2nd_leg === awb)
            if (idx >= 0) {
              lines[idx] = { ...lines[idx], warehouse_status: 'R' }
              await updateDoc(bRef, { awb_lines: lines })
            }
          }
        }
      }
      // Update local state
      setLockedIds(prev => { const next = new Set(prev); next.delete(drId); return next })
      showToast('AWB desbloqueada — puedes reasignarla')
    } catch (err: any) {
      alert('Error: ' + err.message)
    }
  }

  async function createFlightAndAssign() {
    if (!nfNumber.trim() || !nfAirline.trim() || !nfDest.trim()) return
    const flightDest = nfDest.trim().toUpperCase()

    // Check destination mismatch before creating
    if (selected.size > 0) {
      const mismatched = selectedEntries.filter(d => d.destination && d.destination.toUpperCase() !== flightDest)
      if (mismatched.length > 0) {
        const awbList = mismatched.map(d => `${d.awb_2nd_leg || d.awb_number} (${d.destination})`).join('\n')
        const ok = window.confirm(
          `Destino no corresponde con vuelo ${nfNumber.trim().toUpperCase()} (${flightDest}):\n\n${awbList}\n\n¿Crear vuelo y asignar de todas formas?`
        )
        if (!ok) return
      }
    }

    setNfSaving(true)
    try {
      const newFlight = {
        flight_number: nfNumber.trim().toUpperCase(),
        airline: nfAirline.trim(),
        destinations: [flightDest],
        flight_datetime: new Date(nfDate + 'T00:00:00').toISOString(),
        status: 'open',
        flight_status: 'booked',
        created_by: user?.email || '',
        created_at: new Date().toISOString(),
      }
      const ref = await addDoc(collection(db, 'airfreight_flights'), newFlight)
      const flightOption: FlightOption = { ...newFlight, id: ref.id }
      setFlights(prev => [flightOption, ...prev])

      // Assign selected AWBs + resolve bookings
      if (selected.size > 0) {
        const drWithoutBooking = selectedEntries.filter(d => !d.booking_id)
        let bookingResolutions: Map<string, { bookingId: string; awbIndex: number }> = new Map()

        if (drWithoutBooking.length > 0) {
          const bSnap = await getDocs(collection(db, 'airfreight_bookings'))
          for (const dr of drWithoutBooking) {
            const awb = normalizeAwb(dr.awb_number) || normalizeAwb(dr.awb_2nd_leg)
            if (!awb) continue
            for (const bDoc of bSnap.docs) {
              const bk = bDoc.data() as AirfreightBooking
              if (bk.booking_type === 'simple') {
                if (normalizeAwb(bk.awb_2nd_leg) === awb || normalizeAwb(bk.awb_1st_leg) === awb) {
                  bookingResolutions.set(dr.id, { bookingId: bDoc.id, awbIndex: 0 })
                  break
                }
              } else {
                const lines = bk.awb_lines || []
                let found = false
                for (let i = 0; i < lines.length; i++) {
                  if (normalizeAwb(lines[i].awb_number) === awb || normalizeAwb(lines[i].awb_2nd_leg) === awb) {
                    bookingResolutions.set(dr.id, { bookingId: bDoc.id, awbIndex: i })
                    found = true
                    break
                  }
                }
                if (found) break
              }
            }
          }
        }

        // Auto-create simple bookings for doc receptions without any booking match
        for (const dr of drWithoutBooking) {
          if (bookingResolutions.has(dr.id)) continue
          const bookingData = buildAutoBookingData(dr, ref.id, newFlight.flight_number, newFlight.airline)
          const bookingRef = await addDoc(collection(db, 'airfreight_bookings'), bookingData)
          bookingResolutions.set(dr.id, { bookingId: bookingRef.id, awbIndex: 0 })
        }

        const promises = Array.from(selected).map(drId => {
          const update: any = { flight_id: ref.id, flight_number: newFlight.flight_number }
          const resolved = bookingResolutions.get(drId)
          if (resolved) {
            update.booking_id = resolved.bookingId
            update.awb_index = resolved.awbIndex
          }
          return updateDoc(doc(db, 'airfreight_doc_receptions', drId), update)
        })
        await Promise.all(promises)

        for (const [, resolved] of bookingResolutions) {
          await markBookingDocumented(resolved.bookingId, resolved.awbIndex)
        }

        setDocRecs(prev => prev.map(d => {
          if (!selected.has(d.id)) return d
          const resolved = bookingResolutions.get(d.id)
          return {
            ...d,
            flight_id: ref.id,
            flight_number: newFlight.flight_number,
            booking_id: resolved?.bookingId || d.booking_id,
          }
        }))
      }

      showToast(`Vuelo ${newFlight.flight_number} creado${selected.size > 0 ? ` y ${selected.size} AWBs asignadas` : ''}`)
      setSelected(new Set())
      setNewFlightModal(false)
      setNfNumber(''); setNfAirline(''); setNfDest(''); setNfDate(new Date().toLocaleDateString('en-CA'))
    } catch (err: any) {
      alert('Error: ' + err.message)
    } finally {
      setNfSaving(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Layout title="Asignacion de Vuelos" backTo="/airfreight">
      <div className="max-w-7xl mx-auto space-y-4">

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-white rounded-xl border border-gray-200 p-3 sm:p-4">
            <p className="text-xs text-gray-400 mb-1">Total en bodega</p>
            <p className="text-2xl font-black text-gray-800">{stats.total}</p>
            <p className="text-xs text-gray-500">AWBs recibidas</p>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-3 sm:p-4">
            <p className="text-xs text-gray-400 mb-1">Sin vuelo</p>
            <p className="text-2xl font-black text-amber-600">{stats.noFlight}</p>
            <p className="text-xs text-amber-500">Pendientes de asignar</p>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-3 sm:p-4">
            <p className="text-xs text-gray-400 mb-1">Con vuelo</p>
            <p className="text-2xl font-black text-[#1e3a5f]">{stats.withFlight}</p>
            <p className="text-xs text-blue-500">Asignadas a vuelos</p>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-3 sm:p-4">
            <p className="text-xs text-gray-400 mb-1">Vuelos activos</p>
            <p className="text-2xl font-black text-gray-800">{stats.activeFlights}</p>
            <p className="text-xs text-gray-500">Con guias pendientes</p>
          </div>
        </div>

        {/* Filters */}
        <div className="bg-white rounded-xl border border-gray-200 p-3 sm:p-4">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <div className="relative flex-1 min-w-[180px]">
              <svg className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
              </svg>
              <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Buscar AWB o cliente..." className="w-full border border-gray-200 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-[#1e3a5f]" />
            </div>
            <select value={filterClient} onChange={e => setFilterClient(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-600">
              <option value="">Todos los clientes</option>
              {clients.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-600">
              <option value="">Todos los estados</option>
              <option value="D">Documentada (D)</option>
              <option value="R">Recibida (R)</option>
            </select>
            <select value={filterFlight} onChange={e => setFilterFlight(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-600">
              <option value="">Todos</option>
              <option value="none">Sin vuelo</option>
              <option value="assigned">Con vuelo</option>
              {flights.filter(f => docRecs.some(d => d.flight_id === f.id)).map(f => (
                <option key={f.id} value={f.id}>{f.flight_number} - {f.destinations.join(',')}</option>
              ))}
            </select>
            <select value={filterDest} onChange={e => setFilterDest(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-600">
              <option value="">Todos destinos</option>
              {destinations.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
        </div>

        {/* Action bar */}
        {selected.size > 0 && (
          <div className="bg-[#1e3a5f] rounded-xl px-4 sm:px-5 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-white text-sm font-medium">{selected.size} AWB{selected.size > 1 ? 's' : ''} seleccionadas</span>
              <span className="text-white/50 hidden sm:inline">|</span>
              <span className="text-white/70 text-xs hidden sm:inline">{selectedPcs} pzas / {fmtNum(selectedKg)} kg</span>
            </div>
            <div className="flex items-center gap-2">
              {/* Assign to flight */}
              <div className="relative">
                <button onClick={() => { setFlightDropdownOpen(!flightDropdownOpen); setFlightSearch('') }}
                  disabled={assigning}
                  className="bg-white text-[#1e3a5f] px-3 sm:px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-50 flex items-center gap-1.5 disabled:opacity-50">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/>
                  </svg>
                  <span className="hidden sm:inline">Asignar a vuelo</span>
                  <span className="sm:hidden">Asignar</span>
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/>
                  </svg>
                </button>
                {flightDropdownOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setFlightDropdownOpen(false)} />
                    <div className="absolute right-0 top-full mt-2 w-80 bg-white rounded-xl border border-gray-200 shadow-2xl z-50 overflow-hidden">
                      <div className="p-3 border-b border-gray-100">
                        <input type="text" value={flightSearch} onChange={e => setFlightSearch(e.target.value)}
                          placeholder="Buscar vuelo..." className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#1e3a5f]" autoFocus />
                      </div>
                      <div className="max-h-60 overflow-y-auto">
                        {availableFlights.length === 0 && (
                          <p className="text-center py-4 text-sm text-gray-400">No hay vuelos</p>
                        )}
                        {availableFlights.map(f => {
                          const awbCount = docRecs.filter(d => d.flight_id === f.id).length
                          return (
                            <button key={f.id} onClick={() => assignToFlight(f.id)}
                              className="w-full text-left px-4 py-3 hover:bg-blue-50 border-b border-gray-50 flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className="text-base font-black text-gray-800">{f.flight_number}</span>
                                <span className="text-xs font-bold text-[#1e3a5f] bg-blue-100 px-1.5 py-0.5 rounded">{f.destinations.join(',')}</span>
                                <span className="text-xs text-gray-400">{f.airline}</span>
                              </div>
                              <div className="text-right">
                                <p className="text-xs text-gray-500">{fmtDate(f.flight_datetime)}</p>
                                <p className="text-[10px] text-gray-400">{awbCount} AWBs</p>
                              </div>
                            </button>
                          )
                        })}
                      </div>
                      <div className="border-t border-gray-200">
                        <button onClick={() => { setFlightDropdownOpen(false); setNewFlightModal(true) }}
                          className="w-full text-left px-4 py-3 hover:bg-amber-50 flex items-center gap-2 text-amber-700">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
                          </svg>
                          <span className="text-sm font-semibold">Crear vuelo nuevo</span>
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
              {/* Remove from flight */}
              <button onClick={removeFromFlight} disabled={assigning}
                className="bg-white/20 text-white px-3 sm:px-4 py-2 rounded-lg text-sm font-medium hover:bg-white/30 flex items-center gap-1.5 disabled:opacity-50">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"/>
                </svg>
                <span className="hidden sm:inline">Quitar vuelo</span>
              </button>
              {/* Deselect */}
              <button onClick={() => setSelected(new Set())} className="text-white/60 hover:text-white px-2 py-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
                </svg>
              </button>
            </div>
          </div>
        )}

        {/* AWB Table */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#1e3a5f]" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20 text-gray-400 text-sm">No se encontraron AWBs</div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-3 py-2.5 text-left w-10">
                      <input type="checkbox"
                        checked={selected.size > 0 && selected.size === filtered.filter(d => !lockedIds.has(d.id)).length}
                        onChange={toggleSelectAll}
                        className="rounded border-gray-300 text-[#1e3a5f] cursor-pointer" />
                    </th>
                    <th className="px-3 py-2.5 text-left font-medium text-gray-600 text-xs">AWB</th>
                    <th className="px-3 py-2.5 text-left font-medium text-gray-600 text-xs">Cliente</th>
                    <th className="px-3 py-2.5 text-left font-medium text-gray-600 text-xs">Destino</th>
                    <th className="px-3 py-2.5 text-center font-medium text-gray-600 text-xs">Piezas</th>
                    <th className="px-3 py-2.5 text-right font-medium text-gray-600 text-xs hidden sm:table-cell">Peso (kg)</th>
                    <th className="px-3 py-2.5 text-center font-medium text-gray-600 text-xs hidden sm:table-cell">Almacen</th>
                    <th className="px-3 py-2.5 text-center font-medium text-gray-600 text-xs">WH</th>
                    <th className="px-3 py-2.5 text-left font-medium text-gray-600 text-xs">Vuelo Actual</th>
                    <th className="px-3 py-2.5 text-left font-medium text-gray-600 text-xs hidden sm:table-cell">Origen</th>
                    <th className="px-3 py-2.5 text-left font-medium text-gray-600 text-xs hidden sm:table-cell">Fecha Rec.</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.map(d => {
                    const isLocked = lockedIds.has(d.id)
                    const whStatus = d.status === 'complete' ? 'R' : 'D'
                    const awbDisplay = d.awb_2nd_leg || d.awb_number || ''
                    return (
                      <tr key={d.id}
                        className={`hover:bg-blue-50/30 transition-colors ${isLocked ? 'bg-gray-50/50' : ''}`}>
                        <td className="px-3 py-2.5">
                          {isLocked ? (
                            <input type="checkbox" disabled className="rounded border-gray-200 text-gray-300 cursor-not-allowed" />
                          ) : (
                            <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggleSelect(d.id)}
                              className="rounded border-gray-300 text-[#1e3a5f] cursor-pointer" />
                          )}
                        </td>
                        <td className={`px-3 py-2.5 font-mono font-bold ${isLocked ? 'text-gray-400' : 'text-[#1e3a5f]'}`}>
                          {awbDisplay}
                        </td>
                        <td className={`px-3 py-2.5 ${isLocked ? 'text-gray-400' : 'text-gray-700'}`}>{d.client_name || '—'}</td>
                        <td className="px-3 py-2.5">
                          <span className={`font-bold ${isLocked ? 'text-gray-400' : 'text-gray-800'}`}>{d.destination}</span>
                        </td>
                        <td className={`px-3 py-2.5 text-center ${isLocked ? 'text-gray-400' : 'text-gray-700'}`}>{d.pieces}</td>
                        <td className={`px-3 py-2.5 text-right font-mono hidden sm:table-cell ${isLocked ? 'text-gray-400' : 'text-gray-700'}`}>{fmtNum(d.weight)}</td>
                        <td className="px-3 py-2.5 text-center hidden sm:table-cell">
                          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                            d.warehouse_type === 'bonded' ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'
                          }`}>{d.warehouse_type === 'bonded' ? 'Bonded' : 'Local'}</span>
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          {isLocked ? (
                            <span title="Build-up (en distribucion)" className="w-6 h-6 rounded-full bg-purple-100 text-purple-700 text-[10px] font-bold inline-flex items-center justify-center cursor-help">B</span>
                          ) : whStatus === 'R' ? (
                            <span title="Recibida (recepcion fisica completa)" className="w-6 h-6 rounded-full bg-teal-100 text-teal-700 text-[10px] font-bold inline-flex items-center justify-center cursor-help">R</span>
                          ) : (
                            <span title="Documentada (pendiente recepcion fisica)" className="w-6 h-6 rounded-full bg-blue-100 text-blue-700 text-[10px] font-bold inline-flex items-center justify-center cursor-help">D</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          {d.flight_id ? (
                            <div className="flex items-center gap-1.5">
                              <span className={`text-sm font-black ${isLocked ? 'text-gray-400' : 'text-gray-800'}`}>{d.flight_number}</span>
                              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${isLocked ? 'text-gray-400 bg-gray-100' : 'text-[#1e3a5f] bg-blue-100'}`}>{d.destination}</span>
                              {isLocked && (
                                <button
                                  onClick={() => unlockAwb(d.id)}
                                  title="Desbloquear — quitar de distribucion"
                                  className="text-gray-400 hover:text-red-500 transition-colors"
                                >
                                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
                                  </svg>
                                </button>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs bg-amber-100 text-amber-700 px-2 py-1 rounded-lg font-medium">Sin vuelo</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 hidden sm:table-cell">
                          {d.booking_id ? (
                            <span className="text-xs bg-green-50 text-green-600 px-2 py-0.5 rounded-full">Booking</span>
                          ) : (
                            <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">Sin booking</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-gray-500 hidden sm:table-cell">{fmtDateTime(d.created_at)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* New Flight Modal */}
        {newFlightModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4">
              <div className="p-6 border-b border-gray-100">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-bold text-gray-800">Crear Vuelo Nuevo</h3>
                  <button onClick={() => setNewFlightModal(false)} className="text-gray-400 hover:text-gray-600">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
                    </svg>
                  </button>
                </div>
                {selected.size > 0 && (
                  <p className="text-xs text-gray-400 mt-1">{selected.size} AWB{selected.size > 1 ? 's' : ''} se asignaran automaticamente</p>
                )}
              </div>
              <div className="p-6 space-y-4">
                <div>
                  <label className="block text-xs text-gray-500 mb-1 font-medium">Numero de vuelo *</label>
                  <input type="text" value={nfNumber} onChange={e => setNfNumber(e.target.value)}
                    placeholder="Ej: CM801" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:outline-none focus:border-[#1e3a5f]" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1 font-medium">Carrier *</label>
                    <input type="text" value={nfAirline} onChange={e => setNfAirline(e.target.value)}
                      placeholder="Ej: LATAM" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-[#1e3a5f]" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1 font-medium">Destino *</label>
                    <input type="text" value={nfDest} onChange={e => setNfDest(e.target.value)}
                      placeholder="Ej: BOG" className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-[#1e3a5f]" />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1 font-medium">Fecha del vuelo *</label>
                  <input type="date" value={nfDate} onChange={e => setNfDate(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-[#1e3a5f]" />
                </div>
                {/* Preview selected AWBs */}
                {selectedEntries.length > 0 && (
                  <div className="bg-gray-50 rounded-lg p-3">
                    <p className="text-xs text-gray-500 font-medium mb-2">AWBs que se asignaran:</p>
                    <div className="space-y-1 max-h-32 overflow-y-auto">
                      {selectedEntries.map(d => (
                        <div key={d.id} className="flex items-center justify-between text-xs">
                          <span className="font-mono text-gray-700">{d.awb_2nd_leg || d.awb_number}</span>
                          <span className="text-gray-400">{d.pieces} pzas / {fmtNum(d.weight)} kg</span>
                        </div>
                      ))}
                      <div className="border-t border-gray-200 pt-1 mt-1 flex items-center justify-between text-xs font-medium">
                        <span className="text-gray-700">Total</span>
                        <span className="text-gray-700">{selectedPcs} pzas / {fmtNum(selectedKg)} kg</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
              <div className="p-6 border-t border-gray-100 flex gap-3">
                <button onClick={() => setNewFlightModal(false)}
                  className="flex-1 px-4 py-3 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">
                  Cancelar
                </button>
                <button onClick={createFlightAndAssign} disabled={nfSaving || !nfNumber.trim() || !nfAirline.trim() || !nfDest.trim()}
                  className="flex-1 px-4 py-3 bg-[#1e3a5f] text-white rounded-lg text-sm font-semibold hover:bg-blue-900 disabled:opacity-50">
                  {nfSaving ? 'Creando...' : selected.size > 0 ? 'Crear y Asignar' : 'Crear Vuelo'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Toast */}
        {toast && (
          <div className="fixed bottom-6 right-6 bg-gray-800 text-white px-5 py-3 rounded-xl shadow-2xl text-sm flex items-center gap-3 z-50 animate-fade-in">
            <svg className="w-5 h-5 text-green-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/>
            </svg>
            {toast}
          </div>
        )}
      </div>
    </Layout>
  )
}
