import { useState, useEffect, useMemo } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { collection, query, orderBy, onSnapshot, where, deleteDoc, doc, getDocs, updateDoc, getDoc, runTransaction, writeBatch, limit } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import { AirfreightFlight, AirfreightBooking, AirfreightDocumentFile, AwbSecondLeg } from '../../types'
import { calculateAirfreightCharges, undoDispatchChargesForFlight, voidAirInvoice, checkBillingReviewNeeded, flagInvoiceForReview } from '../../lib/airBilling'
import Layout from '../../components/Layout'
import { fmtNum } from '../../lib/utils'
import { useSyncAlerts, alertsByFlight, SyncAlert } from '../../lib/useSyncAlerts'
import { FlightAlertPopup } from '../../components/SyncAlertPopup'

type FlightRow = AirfreightFlight & {
  id: string
  bookings: (AirfreightBooking & { id: string })[]
  totalAwbs: number
  totalPieces: number
  totalWeight: number
  totalChw: number
  clientNames: string[]
  holdStatus: 'none' | 'pending_info' | 'pending' | 'complete'
  hasDG: boolean
  hasLB: boolean
  hasDist: boolean
  clientDocsUploaded: number
  clientDocsTotal: number
  mclDocsUploaded: number
  mclDocsTotal: number
}

function hasDoc(d?: AirfreightDocumentFile) {
  return !!(d && d.url)
}

function aggregateFlight(
  flight: AirfreightFlight & { id: string },
  bookings: (AirfreightBooking & { id: string })[],
): FlightRow {
  let totalAwbs = 0
  let totalPieces = 0
  let totalWeight = 0
  let totalChw = 0
  const clientSet = new Set<string>()

  let anyHoldTrue = false
  let anyHoldPending = false
  let allHoldsHavePhoto = true
  let hasDG = false
  let hasLB = false
  let clientDocsUploaded = 0
  let clientDocsTotal = 0
  let mclDocsUploaded = 0
  let mclDocsTotal = 0

  // Flight-level docs: DO/TSA is client doc
  // DO/TSA may be stored as doc_do_tsa (single) or doc_do_tsa_files (array)
  clientDocsTotal += 1
  const doTsaFiles = (flight as any).doc_do_tsa_files as AirfreightDocumentFile[] | undefined
  if (hasDoc(flight.doc_do_tsa) || (doTsaFiles && doTsaFiles.length > 0)) clientDocsUploaded++

  for (const b of bookings) {
    clientSet.add(b.client_name || b.client_id)

    if (b.booking_type === 'mawb' || b.booking_type === 'ecommerce' || b.booking_type === 'export') {
      const lines = b.awb_lines || []
      totalAwbs += lines.length
      totalPieces += lines.reduce((s, l) => s + (Number(l.pieces) || 0), 0)
      totalWeight += lines.reduce((s, l) => s + (Number(l.weight) || 0), 0)
      totalChw += lines.reduce((s, l) => s + (Number(l.chargeable_weight) || 0), 0)

      if (b.booking_type === 'mawb') {
        // MAWB-level: Draft (client), Final (client)
        clientDocsTotal += 2
        if (hasDoc(b.documents?.doc_mawb_draft)) clientDocsUploaded++
        if (hasDoc(b.documents?.doc_mawb_def)) clientDocsUploaded++
        // MAWB-level: LB Checklist (MCL) — always 1 per MAWB booking
        mclDocsTotal++
        const lbFiles = (b.documents as any)?.doc_lb_checklist_files as AirfreightDocumentFile[] | undefined
        if (hasDoc(b.documents?.doc_lb_checklist) || (lbFiles && lbFiles.length > 0)) mclDocsUploaded++
      }

      for (const leg of lines) {
        if (leg.hold === true) {
          anyHoldTrue = true
          const holds = leg.holds || []
          if (holds.length === 0 || holds.some(h => !h.photo)) allHoldsHavePhoto = false
        } else if (leg.hold === 'pending') {
          anyHoldPending = true
        }
        if (leg.ddgg) hasDG = true
        if (leg.battery) hasLB = true

        // Sub-AWB: 7512 (client), HAWB (client)
        clientDocsTotal += 2
        if (hasDoc(leg.documents?.doc_7512)) clientDocsUploaded++
        if (hasDoc(leg.documents?.doc_hawb)) clientDocsUploaded++
        // Ecommerce: LB Checklist per AWB (MCL) + CCSF per AWB (MCL)
        if (b.booking_type === 'ecommerce') {
          if (leg.battery) {
            mclDocsTotal++
            if (hasDoc(leg.documents?.doc_lb_checklist)) mclDocsUploaded++
          }
          mclDocsTotal++
          const ccsfFiles = (leg.documents as any)?.doc_ccsf_files as AirfreightDocumentFile[] | undefined
          if (hasDoc((leg.documents as any)?.doc_ccsf) || (ccsfFiles && ccsfFiles.length > 0)) mclDocsUploaded++
        }
      }
    } else {
      totalAwbs += 1
      totalPieces += Number(b.pieces) || 0
      totalWeight += Number(b.weight) || 0
      totalChw += Number(b.chargeable_weight) || 0

      if (b.hold === true) {
        anyHoldTrue = true
        const holds = b.holds || []
        if (holds.length === 0 || holds.some(h => !h.photo)) allHoldsHavePhoto = false
      } else if (b.hold === 'pending') {
        anyHoldPending = true
      }
      if (b.ddgg) hasDG = true
      if (b.battery) hasLB = true

      // Simple: 7512 (client), AWB Draft (client), AWB Final (client), LB Checklist (MCL)
      clientDocsTotal += 3
      if (hasDoc(b.documents?.doc_7512)) clientDocsUploaded++
      if (hasDoc(b.documents?.doc_mawb_draft)) clientDocsUploaded++
      if (hasDoc(b.documents?.doc_mawb_def)) clientDocsUploaded++
      if (b.battery) {
        mclDocsTotal++
        if (hasDoc(b.documents?.doc_lb_checklist)) mclDocsUploaded++
      }
    }
  }

  return {
    ...flight,
    bookings,
    totalAwbs,
    totalPieces,
    totalWeight: Math.round(totalWeight * 10) / 10,
    totalChw: Math.round(totalChw * 10) / 10,
    clientNames: Array.from(clientSet),
    holdStatus: anyHoldTrue
      ? (allHoldsHavePhoto ? 'complete' as const : 'pending' as const)
      : anyHoldPending ? 'pending_info' as const : 'none' as const,
    hasDG,
    hasLB,
    hasDist: hasDoc(flight.doc_distribucion) || (((flight as any).doc_distribucion_files as AirfreightDocumentFile[] | undefined)?.length || 0) > 0,
    clientDocsUploaded,
    clientDocsTotal,
    mclDocsUploaded,
    mclDocsTotal,
  }
}

function fmtEtd(dateStr: string) {
  if (!dateStr) return '—'
  // Parse string directly — no Date object, no timezone shift
  const [datePart, timePart] = dateStr.split('T')
  const [yyyy, mm, dd] = (datePart || '').split('-')
  if (!yyyy || !mm || !dd) return dateStr
  const yy = yyyy.slice(2)
  if (!timePart) return `${mm}/${dd}/${yy}`
  return `${mm}/${dd}/${yy} ${timePart.slice(0, 5)}`
}

// Formats a UTC ISO timestamp (e.g. flight.dispatched_at) as Miami
// (America/New_York) wall-clock time so operators always see local East
// Coast hours regardless of the browser's timezone.
function fmtTimestamp(iso: string) {
  const dt = new Date(iso)
  if (isNaN(dt.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(dt)
  const get = (t: string) => parts.find(p => p.type === t)?.value || ''
  let hh = get('hour')
  if (hh === '24') hh = '00'
  return `${get('month')}/${get('day')} ${hh}:${get('minute')}`
}

export default function AirfreightDashboard() {
  const { user, isAdmin, isAccounting, isSuperAgent, isAgent, isCounter, isBodega, isClient, isDistribuidor, isSoporteIT, clientId, hasSeaAccess, isEcommerceClient, isViewer } = useAuth()
  const navigate = useNavigate()
  // Both clients and viewers are scoped to a single client_id
  const isClientScoped = isClient || isViewer

  const [rawFlights, setRawFlights] = useState<(AirfreightFlight & { id: string })[]>([])
  const [rawDraftFlights, setRawDraftFlights] = useState<(AirfreightFlight & { id: string })[]>([])
  const [rawBookings, setRawBookings] = useState<(AirfreightBooking & { id: string })[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set(['booked', 'in_progress', 'terminado', 'built']))
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [statusDropdownOpen, setStatusDropdownOpen] = useState(false)

  // Date range filter — default last 10 days
  const defaultFrom = new Date(); defaultFrom.setDate(defaultFrom.getDate() - 10)
  const [dateFrom, setDateFrom] = useState(defaultFrom.toLocaleDateString('en-CA'))
  const [dateTo, setDateTo] = useState('')
  const [clientFilter, setClientFilter] = useState('')

  const canEdit = isAdmin || isSuperAgent || isAgent || isCounter || isClient
  const isMcl = isAdmin || isSuperAgent || isAgent || isCounter || isBodega || isDistribuidor || isSoporteIT

  const [transportEnabled, setTransportEnabled] = useState(false)
  const [modulesOpen, setModulesOpen] = useState(false)

  // Sync alerts
  const syncAlerts = useSyncAlerts()
  const flightAlertMap = alertsByFlight(syncAlerts)

  // Dist vs Booking match check
  const [distMatchMap, setDistMatchMap] = useState<Map<string, { status: 'check' | 'warning' | 'loading', message?: string }>>(new Map())
  const [syncPopupFlightId, setSyncPopupFlightId] = useState<string | null>(null)

  // Check if client has transportation enabled
  useEffect(() => {
    if (!isClient || !clientId) return
    getDoc(doc(db, 'airfreight_clients', clientId)).then(snap => {
      if (snap.exists()) setTransportEnabled(!!snap.data().transportation_enabled)
    })
  }, [isClient, clientId])

  useEffect(() => {
    // Clients / viewers without a linked client_id cannot query bookings — show empty state
    if (isClientScoped && !clientId) {
      setFlights([])
      setLoading(false)
      return
    }

    // SOL-14: Separate flights and bookings into independent listeners
    const flightsConstraints: any[] = [orderBy('flight_datetime', 'asc')]
    if (dateFrom) {
      flightsConstraints.unshift(where('flight_datetime', '>=', new Date(dateFrom + 'T00:00:00').toISOString()))
    }
    if (dateTo) {
      flightsConstraints.push(where('flight_datetime', '<=', new Date(dateTo + 'T23:59:59').toISOString()))
    }
    const flightsQuery = query(collection(db, 'airfreight_flights'), ...flightsConstraints)

    const unsubFlights = onSnapshot(flightsQuery, (fSnap) => {
      setRawFlights(fSnap.docs.map(d => ({ ...d.data() as AirfreightFlight, id: d.id })))
    }, (err) => {
      console.error('Flights listener error:', err)
      setRawFlights([])
    })

    // Draft flights listener (flights without confirmed ETD)
    const draftsQuery = query(collection(db, 'airfreight_flights'), where('status', '==', 'draft'))
    const unsubDrafts = onSnapshot(draftsQuery, (dSnap) => {
      setRawDraftFlights(dSnap.docs.map(d => ({ ...d.data() as AirfreightFlight, id: d.id })))
    }, () => setRawDraftFlights([]))

    let bookingsQuery = query(collection(db, 'airfreight_bookings'), orderBy('created_at', 'desc'), limit(2000))
    if (isClientScoped && clientId) {
      bookingsQuery = query(
        collection(db, 'airfreight_bookings'),
        where('client_id', '==', clientId),
        orderBy('created_at', 'desc'),
        limit(2000),
      )
    }

    const unsubBookings = onSnapshot(bookingsQuery, (bSnap) => {
      setRawBookings(bSnap.docs.map(d => ({ ...d.data() as AirfreightBooking, id: d.id })))
      setLoading(false)
    }, (err) => {
      console.error('Bookings listener error:', err)
      setRawBookings([])
      setLoading(false)
    })

    return () => {
      unsubFlights()
      unsubDrafts()
      unsubBookings()
    }
  }, [isClientScoped, clientId, dateFrom, dateTo])

  // SOL-14: Derive FlightRow[] from raw state
  const flights = useMemo(() => {
    return rawFlights
      .map(f => aggregateFlight(f, rawBookings.filter(b => b.flight_id === f.id)))
      .filter(f => !isClientScoped || f.bookings.length > 0)
  }, [rawFlights, rawBookings, isClientScoped])

  // Draft flights (no confirmed ETD) — shown separately at bottom
  const draftFlights = useMemo(() => {
    const mainIds = new Set(rawFlights.map(f => f.id))
    return rawDraftFlights
      .filter(f => !mainIds.has(f.id))
      .map(f => aggregateFlight(f, rawBookings.filter(b => b.flight_id === f.id)))
      .filter(f => !isClientScoped || f.bookings.length > 0)
  }, [rawDraftFlights, rawFlights, rawBookings, isClientScoped])

  // Dist vs Booking match: AWB + weight comparison for built/dispatched flights
  useEffect(() => {
    const distFlights = flights.filter(f => f.hasDist && ['built', 'dispatched'].includes(f.flight_status || ''))
    if (distFlights.length === 0) { setDistMatchMap(new Map()); return }

    setDistMatchMap(prev => {
      const next = new Map(prev)
      for (const f of distFlights) next.set(f.id, { status: 'loading' })
      return next
    })

    const normalize = (s: string) => (s || '').replace(/[-\s]/g, '').trim().toUpperCase()

    async function checkFlight(flight: FlightRow): Promise<{ status: 'check' | 'warning', message?: string }> {
      try {
        const drSnap = await getDocs(query(
          collection(db, 'airfreight_doc_receptions'),
          where('flight_id', '==', flight.id),
        ))

        // --- Dist side: awb_number = 2nd leg ---
        const distAwbs = new Set<string>()
        let distGross = 0
        drSnap.docs.forEach(d => {
          const data = d.data()
          const n = normalize(data.awb_number || '')
          if (n) distAwbs.add(n)
          distGross += Number(data.weight) || 0
        })

        // --- Booking side: distributed AWB = awb_2nd_leg (ecommerce/mawb) or awb_1st_leg (simple) ---
        const bookingAwbs = new Map<string, number>() // normalized awb → gross weight
        let bookingGross = 0
        for (const b of flight.bookings) {
          if (b.booking_type === 'simple') {
            const awb = normalize(b.awb_2nd_leg || b.awb_1st_leg || '')
            const w = Number(b.weight) || 0
            if (awb) bookingAwbs.set(awb, w)
            bookingGross += w
          } else {
            const lines = (b.awb_lines || []) as AwbSecondLeg[]
            for (const line of lines) {
              const awb = normalize(line.awb_2nd_leg || line.awb_number || '')
              const w = Number(line.weight) || 0
              if (awb) bookingAwbs.set(awb, w)
              bookingGross += w
            }
          }
        }

        if (distAwbs.size === 0 && bookingAwbs.size === 0) return { status: 'check' }

        // --- AWB match ---
        const missingFromDist: string[] = [] // in booking but not in dist
        const extraInDist: string[] = []     // in dist but not in booking
        let missingWeight = 0

        for (const [awb, w] of bookingAwbs) {
          if (!distAwbs.has(awb)) {
            missingFromDist.push(awb)
            missingWeight += w
          }
        }
        for (const awb of distAwbs) {
          if (!bookingAwbs.has(awb)) extraInDist.push(awb)
        }

        // --- Weight match (±10 kg tolerance) ---
        const weightDiff = Math.abs(bookingGross - distGross)
        const weightOk = weightDiff <= 10

        const awbOk = missingFromDist.length === 0 && extraInDist.length === 0

        if (awbOk && weightOk) return { status: 'check' }

        // Build message
        const parts: string[] = []
        if (missingFromDist.length > 0) {
          const kg = fmtNum(Math.round(missingWeight))
          parts.push(`missing ${missingFromDist.length} AWB · ${kg} kg`)
        }
        if (extraInDist.length > 0) {
          parts.push(`${extraInDist.length} extra AWB in dist`)
        }
        if (!weightOk && awbOk) {
          parts.push(`weight diff ${fmtNum(Math.round(weightDiff))} kg`)
        }
        return { status: 'warning', message: parts.join(' | ') }
      } catch (err) {
        console.error('Dist match check failed for', flight.id, err)
        return { status: 'warning', message: 'check failed' }
      }
    }

    let cancelled = false
    Promise.all(distFlights.map(async f => ({ id: f.id, result: await checkFlight(f) }))).then(results => {
      if (cancelled) return
      setDistMatchMap(prev => {
        const next = new Map(prev)
        for (const r of results) next.set(r.id, r.result)
        return next
      })
    })
    return () => { cancelled = true }
  }, [flights])

  // Derive unique client names for the filter dropdown
  const allClientNames = [...new Set(flights.flatMap(f => f.clientNames))].sort()

  const filtered = flights.filter(f => {
    // Date range filter (based on flight ETD date)
    const etdDate = (f.flight_datetime || '').slice(0, 10)
    if (dateFrom && etdDate < dateFrom) return false
    if (dateTo && etdDate > dateTo) return false
    // Client filter (MCL only)
    if (clientFilter && !f.clientNames.includes(clientFilter)) return false
    // Status filter
    if (statusFilter.size === 0) return true
    const fs = f.flight_status || (f.dispatched_at ? 'dispatched' : 'booked')
    return statusFilter.has(fs)
  })

  async function handleDeleteFlight(flightId: string) {
    setDeleting(true)
    try {
      const bSnap = await getDocs(query(collection(db, 'airfreight_bookings'), where('flight_id', '==', flightId)))
      const ops = bSnap.docs.map(d => deleteDoc(doc(db, 'airfreight_bookings', d.id)))
      ops.push(deleteDoc(doc(db, 'airfreight_flights', flightId)))
      await Promise.all(ops)
    } finally {
      setDeleting(false)
      setConfirmDeleteId(null)
    }
  }

  async function handleCycleStatus(flight: FlightRow) {
    const ref = doc(db, 'airfreight_flights', flight.id)
    const current = flight.flight_status || (flight.dispatched_at ? 'dispatched' : 'booked')
    if (current === 'booked' || current === 'in_progress') {
      await updateDoc(ref, { flight_status: 'terminado' })
    } else if (current === 'terminado' || current === 'built') {
      if (!confirm('Confirm flight closure? Once closed (Dispatched) it can no longer be edited.')) return
      const now = new Date().toISOString()
      const stampBy = user?.email || ''

      // ── Identify undistributed AWBs (0 pieces in ULDs) ──────────────────
      // Get doc_receptions assigned to this flight
      const drSnap = await getDocs(query(collection(db, 'airfreight_doc_receptions'),
        where('flight_id', '==', flight.id)))

      // For each doc_reception, check if it has any pieces in ULDs
      const distributedDocRecIds = new Set<string>()
      for (const dr of drSnap.docs) {
        const ppSnap = await getDocs(query(collection(db, 'airfreight_physical_pieces'),
          where('doc_reception_id', '==', dr.id)))
        const hasUldPiece = ppSnap.docs.some(p => !!p.data().uld_id)
        if (hasUldPiece) distributedDocRecIds.add(dr.id)
      }

      // Build lookup: awb (lowercase) → doc_reception_id
      const drByAwb = new Map<string, string>()
      for (const dr of drSnap.docs) {
        const drd = dr.data()
        const awbKey = (drd.awb_2nd_leg || drd.awb_number || '').toLowerCase()
        if (awbKey) drByAwb.set(awbKey, dr.id)
      }

      // Find ecommerce bookings and identify undistributed AWB lines
      const bSnapPre = await getDocs(query(collection(db, 'airfreight_bookings'), where('flight_id', '==', flight.id)))
      const undistributedAwbs: { bookingId: string; lineIndex: number; awb: string; pieces: number }[] = []

      for (const bDoc of bSnapPre.docs) {
        const data = bDoc.data() as any
        if (data.booking_type !== 'ecommerce') continue
        const lines = data.awb_lines as any[] | undefined
        if (!lines) continue

        for (let i = 0; i < lines.length; i++) {
          const l = lines[i]
          const awb = l.awb_2nd_leg || l.awb_number || ''
          const drId = drByAwb.get(awb.toLowerCase())
          if (drId && !distributedDocRecIds.has(drId)) {
            undistributedAwbs.push({ bookingId: bDoc.id, lineIndex: i, awb, pieces: l.pieces || 0 })
          } else if (!drId) {
            // No doc_reception found — AWB was never physically received, treat as undistributed
            undistributedAwbs.push({ bookingId: bDoc.id, lineIndex: i, awb, pieces: l.pieces || 0 })
          }
        }
      }

      // If there are undistributed AWBs, ask for confirmation to release them
      if (undistributedAwbs.length > 0) {
        const awbList = undistributedAwbs.map(a => `  ${a.awb} (${a.pieces} pcs)`).join('\n')
        const releaseOk = confirm(
          `Este vuelo tiene ${undistributedAwbs.length} AWB(s) sin distribuir (0 piezas en ULDs):\n\n${awbList}\n\nEstas guías serán liberadas del vuelo y quedarán como "Sin vuelo" para reasignación.\n\n¿Continuar con el despacho?`
        )
        if (!releaseOk) return
      }

      // ── Release undistributed AWBs from bookings ────────────────────────
      if (undistributedAwbs.length > 0) {
        // Group by booking
        const byBooking = new Map<string, number[]>()
        for (const u of undistributedAwbs) {
          if (!byBooking.has(u.bookingId)) byBooking.set(u.bookingId, [])
          byBooking.get(u.bookingId)!.push(u.lineIndex)
        }

        for (const [bkId, lineIndexes] of byBooking) {
          const bRef = doc(db, 'airfreight_bookings', bkId)
          await runTransaction(db, async (t) => {
            const snap = await t.get(bRef)
            if (!snap.exists()) return
            const data = snap.data() as any
            const lines = data.awb_lines as any[] | undefined
            if (!lines) return
            const keepLines = lines.filter((_: any, i: number) => !lineIndexes.includes(i))
            t.update(bRef, { awb_lines: keepLines })
          })
        }

        // Release doc_receptions: set flight_id = null
        const releaseBatch = writeBatch(db)
        for (const u of undistributedAwbs) {
          const drSnap = await getDocs(query(collection(db, 'airfreight_doc_receptions'),
            where('booking_id', '==', u.bookingId)))
          for (const dr of drSnap.docs) {
            const drd = dr.data()
            const drAwb = (drd.awb_2nd_leg || drd.awb_number || '').toLowerCase()
            if (drAwb === u.awb.toLowerCase()) {
              releaseBatch.update(doc(db, 'airfreight_doc_receptions', dr.id), {
                flight_id: null,
                flight_number: '',
                booking_id: null,
              })
            }
          }
        }
        await releaseBatch.commit()
      }

      // ── Dispatch flight ─────────────────────────────────────────────────
      await updateDoc(ref, { flight_status: 'dispatched', dispatched_at: now })

      // Stamp drop_off_time on all on_hand AWBs + mark dispatched=true on all
      // remaining ECOMMERCE AWB lines. MAWB bookings are NOT touched.
      try {
        const bSnap = await getDocs(query(collection(db, 'airfreight_bookings'), where('flight_id', '==', flight.id)))
        for (const bDoc of bSnap.docs) {
          const bRef = doc(db, 'airfreight_bookings', bDoc.id)
          await runTransaction(db, async (t) => {
            const snap = await t.get(bRef)
            if (!snap.exists()) return
            const data = snap.data() as any
            if (data.booking_type === 'simple') {
              const updates: Record<string, any> = {}
              if (data.on_hand && !data.drop_off_time) updates.drop_off_time = now
              if (!data.dispatched) {
                updates.dispatched = true
                updates.dispatched_at = now
                updates.dispatched_by = stampBy
              }
              if (Object.keys(updates).length > 0) t.update(bRef, updates)
              return
            }
            const lines = data.awb_lines as any[] | undefined
            if (!lines) return
            const isEcommerce = data.booking_type === 'ecommerce'
            let changed = false
            const updated = lines.map((l: any) => {
              let next = l
              if (l.on_hand && !l.drop_off_time) {
                next = { ...next, drop_off_time: now }
                changed = true
              }
              if (isEcommerce && l.dispatched !== true) {
                next = { ...next, dispatched: true, dispatched_at: now, dispatched_by: stampBy }
                changed = true
              }
              return next
            })
            if (changed) t.update(bRef, { awb_lines: updated })
          })
        }
      } catch (e) { console.error('Error stamping drop_off_time/dispatched:', e) }

      // Clean up any existing auto charges then generate fresh ones
      // (only remaining distributed AWBs will be in the bookings at this point)
      try {
        await undoDispatchChargesForFlight(flight.id)
        const bSnap2 = await getDocs(query(collection(db, 'airfreight_bookings'), where('flight_id', '==', flight.id)))
        for (const bDoc of bSnap2.docs) {
          const booking = { id: bDoc.id, ...bDoc.data() } as AirfreightBooking & { id: string }
          const lines = (booking.awb_lines || []) as AwbSecondLeg[]
          const isMawb = booking.booking_type === 'mawb'

          if (booking.booking_type === 'simple') {
            await calculateAirfreightCharges(booking, null, null, now, stampBy)
          } else if (isMawb) {
            const totalCw = lines.reduce((s, l) => s + (l.chargeable_weight || 0), 0)
            const bookingForBilling = { ...booking, chargeable_weight: totalCw }
            await calculateAirfreightCharges(bookingForBilling, null, null, now, stampBy)
          } else {
            for (let i = 0; i < lines.length; i++) {
              await calculateAirfreightCharges(booking, lines[i], i, now, stampBy)
            }
          }
        }
      } catch (e) { console.error('Error generating billing charges:', e) }

      // Check if existing invoices need review after re-dispatch
      try {
        const bSnap3 = await getDocs(query(collection(db, 'airfreight_bookings'), where('flight_id', '==', flight.id)))
        const allBookings = bSnap3.docs.map(d => ({ id: d.id, ...d.data() } as AirfreightBooking & { id: string }))
        const reviews = await checkBillingReviewNeeded(flight.id, allBookings)
        for (const { invoiceId, details } of reviews) {
          if (details.length > 0) {
            await flagInvoiceForReview(invoiceId, details)
          }
        }
      } catch (e) { console.error('Error checking billing review:', e) }
    } else {
      // dispatched → back to booked
      if (!canEdit) {
        alert('No tienes permisos para reabrir un vuelo cerrado.')
        return
      }
      if (!confirm('Reabrir este vuelo?')) return

      // Admin/Accounting can choose to also void invoice + delete charges
      let reopenMode: 'operativo' | 'billing' = 'operativo'
      if (isAdmin || isAccounting) {
        const voidBilling = confirm('¿Tambien quieres anular la factura y recalcular cargos?\n\nAceptar = Reopen billing (anula factura)\nCancelar = Reopen operativo (mantiene factura)')
        if (voidBilling) reopenMode = 'billing'
      }

      if (reopenMode === 'billing') {
        // Void all non-voided invoices for this flight
        try {
          const invSnap = await getDocs(query(collection(db, 'air_invoices'), where('flight_id', '==', flight.id)))
          for (const invDoc of invSnap.docs) {
            const inv = invDoc.data()
            if (inv.status !== 'voided') {
              await voidAirInvoice(invDoc.id)
            }
          }
          await undoDispatchChargesForFlight(flight.id)
        } catch (e) { console.error('Error voiding invoices/charges:', e) }
      }
      // Operativo mode: don't touch billing at all

      await updateDoc(ref, {
        flight_status: 'booked',
        dispatched_at: null,
        reopened_by: user?.email || '',
        reopened_at: new Date().toISOString(),
      })
    }
  }

  if (loading) {
    return (
      <Layout title="Flight Operations Board">
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" />
        </div>
      </Layout>
    )
  }

  return (
    <Layout title="Flight Operations Board" backTo={hasSeaAccess ? '/select' : undefined}>
      <div className="space-y-4">
        <div className="flex items-center gap-2 flex-wrap">
          {/* Status multi-select dropdown */}
          <div className="relative">
            <button
              onClick={() => setStatusDropdownOpen(prev => !prev)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-200 bg-white hover:border-gray-300 transition-colors"
            >
              <span className="text-gray-700">Status</span>
              {statusFilter.size > 0 && statusFilter.size < 5 && (
                <span className="bg-mcl-blue text-white text-[10px] font-bold w-4 h-4 rounded-full flex items-center justify-center">{statusFilter.size}</span>
              )}
              <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform ${statusDropdownOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {statusDropdownOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setStatusDropdownOpen(false)} />
                <div className="absolute left-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 min-w-[160px] py-1">
                  {[
                    { key: 'booked', label: 'Booked' },
                    { key: 'in_progress', label: 'In Progress' },
                    { key: 'terminado', label: 'Terminado' },
                    { key: 'built', label: 'Built' },
                    { key: 'dispatched', label: 'Dispatched' },
                  ].map(s => (
                    <label
                      key={s.key}
                      className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={statusFilter.has(s.key)}
                        onChange={() => setStatusFilter(prev => {
                          const next = new Set(prev)
                          if (next.has(s.key)) next.delete(s.key)
                          else next.add(s.key)
                          return next
                        })}
                        className="rounded border-gray-300 text-mcl-blue focus:ring-mcl-blue/30"
                      />
                      <span className="text-sm text-gray-700">{s.label}</span>
                    </label>
                  ))}
                  <div className="border-t border-gray-100 mt-1 pt-1 px-3 pb-1">
                    <button
                      onClick={() => { setStatusFilter(new Set()); setStatusDropdownOpen(false) }}
                      className="text-xs text-gray-400 hover:text-gray-600"
                    >
                      Clear all
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
          <label className="text-xs text-gray-500">From</label>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            className="border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
          <label className="text-xs text-gray-500">To</label>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            className="border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
          {isMcl && allClientNames.length > 1 && (
            <select
              value={clientFilter}
              onChange={e => setClientFilter(e.target.value)}
              className="border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
            >
              <option value="">All clients</option>
              {allClientNames.map(name => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          )}
          <div className="flex-1" />
          <div className="flex gap-1.5 items-center">
            {!isViewer && (
              <div className="relative">
                <button
                  onClick={() => setModulesOpen(prev => !prev)}
                  className="px-3 py-1.5 bg-gray-600 text-white text-xs font-medium rounded-md hover:bg-gray-700 transition-colors flex items-center gap-1.5"
                >
                  Modulos
                  <svg className={`w-3.5 h-3.5 transition-transform ${modulesOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {modulesOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setModulesOpen(false)} />
                    <div className="absolute left-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 min-w-[180px] py-1">
                      {!isDistribuidor && (
                        <Link to="/airfreight/flight-assignment" onClick={() => setModulesOpen(false)}
                          className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">Vuelos</Link>
                      )}
                      {!isDistribuidor && (
                        <Link to="/airfreight/uld" onClick={() => setModulesOpen(false)}
                          className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">ULD Control</Link>
                      )}
                      {isMcl && (
                        <Link to="/airfreight/buildup" onClick={() => setModulesOpen(false)}
                          className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">Build-up / Distribucion</Link>
                      )}
                      {!isDistribuidor && (
                        <Link to="/airfreight/holds" onClick={() => setModulesOpen(false)}
                          className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">Holds</Link>
                      )}
                      {!isDistribuidor && (isMcl || transportEnabled) && (
                        <Link to="/airfreight/transportation" onClick={() => setModulesOpen(false)}
                          className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">Transport</Link>
                      )}
                      {!isDistribuidor && isMcl && (
                        <Link to="/airfreight/screening" onClick={() => setModulesOpen(false)}
                          className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">Screening</Link>
                      )}
                      {isMcl && (
                        <>
                          <div className="border-t border-gray-100 my-1" />
                          <Link to="/airfreight/do-from-uld" onClick={() => setModulesOpen(false)}
                            className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">New DO</Link>
                          <a href="/edit-do" target="_blank" rel="noopener noreferrer" onClick={() => setModulesOpen(false)}
                            className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">Edit DO</a>
                          {!isDistribuidor && (
                            <>
                              <Link to="/airfreight/doc-reception" onClick={() => setModulesOpen(false)}
                                className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">Rec. Documental</Link>
                              <Link to="/airfreight/physical-reception" onClick={() => setModulesOpen(false)}
                                className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">Rec. Fisica</Link>
                            </>
                          )}
                        </>
                      )}
                      {isClient && (
                        <>
                          <div className="border-t border-gray-100 my-1" />
                          <Link to="/airfreight/doc-reception" onClick={() => setModulesOpen(false)}
                            className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">Rec. Documental</Link>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
            {!isViewer && (isEcommerceClient || isMcl) && (
              <Link
                to="/airfreight/booking-list"
                className="hidden sm:inline-block px-3 py-1.5 bg-mcl-blue text-white text-xs font-medium rounded-md hover:bg-blue-900 transition-colors"
              >
                Multi AWB Booking
              </Link>
            )}
            {!isViewer && canEdit && !isEcommerceClient && (
              <Link
                to="/airfreight/bookings/new"
                className="hidden sm:inline-block px-3 py-1.5 bg-mcl-blue text-white text-xs font-medium rounded-md hover:bg-blue-900 transition-colors"
              >
                + New Transit Booking
              </Link>
            )}
            {!isViewer && canEdit && !isEcommerceClient && (
              <Link
                to="/airfreight/bookings/export"
                className="hidden sm:inline-block px-3 py-1.5 bg-mcl-blue text-white text-xs font-medium rounded-md hover:bg-blue-900 transition-colors"
              >
                + New Export Booking
              </Link>
            )}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="text-center py-16 text-gray-400 bg-white rounded-xl border border-gray-100">
            <div className="text-4xl mb-3">✈️</div>
            <p className="text-sm">No flights matching selected filters</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-xs font-bold text-gray-500 uppercase tracking-wide border-b border-gray-200">
                    {!isClientScoped && <th className="px-2 py-2 text-left">Client</th>}
                    <th className="px-2 py-2 text-left">Airline</th>
                    <th className="px-2 py-2 text-left">Flight</th>
                    <th className="px-2 py-2 text-left">ETD</th>
                    <th className="px-2 py-2 text-left">Dest</th>
                    <th className="px-2 py-2 text-center">AWBs</th>
                    <th className="px-2 py-2 text-center">PCS</th>
                    <th className="px-2 py-2 text-center hidden sm:table-cell">KG</th>
                    <th className="px-2 py-2 text-center">CHW</th>
                    <th className="px-1 py-2 text-center">HOLDS</th>
                    <th className="px-1 py-2 text-center">DG</th>
                    <th className="px-1 py-2 text-center">LB</th>
                    <th className="px-1 py-2 text-center hidden sm:table-cell">SYNC</th>
                    <th className="px-1 py-2 text-center hidden sm:table-cell">DOCs</th>
                    <th className="px-1 py-2 text-center hidden sm:table-cell">DIST</th>
                    <th className="px-2 py-2 text-center">Status</th>
                    <th className="px-1 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.map(flight => {
                    const clientLabel = flight.clientNames.length === 0
                      ? <span className="text-gray-300">—</span>
                      : flight.clientNames.length === 1
                        ? <span className="font-medium text-gray-800">{flight.clientNames[0]}</span>
                        : <span className="text-gray-600">{flight.clientNames[0]}<span className="text-gray-400 text-xs ml-1">+{flight.clientNames.length - 1}</span></span>

                    const isEmpty = flight.was_modified && flight.bookings.length === 0

                    // DOCs status color
                    const clientComplete = flight.clientDocsTotal > 0 && flight.clientDocsUploaded === flight.clientDocsTotal
                    const mclComplete = flight.mclDocsTotal === 0 || flight.mclDocsUploaded === flight.mclDocsTotal
                    const anyUploaded = flight.clientDocsUploaded > 0 || flight.mclDocsUploaded > 0
                    const docsColor = clientComplete && mclComplete
                      ? 'bg-green-700'        // verde oscuro: todos completos
                      : clientComplete
                        ? 'bg-green-400'       // verde claro: cliente completo, falta MCL
                        : anyUploaded
                          ? 'bg-yellow-400'    // amarillo: parcial
                          : 'bg-gray-300'      // gris: nada

                    const flightStatus = flight.flight_status || (flight.dispatched_at ? 'dispatched' : 'booked')
                    const statusStyle = flightStatus === 'dispatched'
                      ? 'bg-green-100 text-green-700'
                      : flightStatus === 'built'
                        ? 'bg-purple-100 text-purple-700'
                        : flightStatus === 'terminado'
                          ? 'bg-orange-100 text-orange-700'
                          : flightStatus === 'in_progress'
                            ? 'bg-yellow-100 text-yellow-700'
                            : 'bg-blue-100 text-blue-700'
                    const statusLabel = flightStatus === 'dispatched' ? 'Dispatched' : flightStatus === 'built' ? 'Built' : flightStatus === 'terminado' ? 'Terminado' : flightStatus === 'in_progress' ? 'In Progress' : 'Booked'

                    const isDispatched = flightStatus === 'dispatched'
                    const locked = isDispatched && !canEdit

                    return (
                      <tr
                        key={flight.id}
                        className={`transition-colors group ${locked || isViewer ? 'opacity-60' : 'cursor-pointer'} ${isEmpty ? 'opacity-30' : locked || isViewer ? '' : 'hover:bg-blue-50/30'}`}
                        onClick={() => {
                          if (isViewer) return  // viewers cannot open booking edit page
                          if (locked) { alert('Este vuelo está cerrado (Dispatched). Haz click en el status para reabrirlo.'); return }
                          const hasExport = flight.bookings.some(b => b.booking_type === 'export')
                          navigate(hasExport ? `/airfreight/bookings/export?flight=${flight.id}` : `/airfreight/bookings/new?flight=${flight.id}`)
                        }}
                      >
                        {!isClientScoped && <td className="px-2 py-2">{clientLabel}</td>}
                        <td className="px-2 py-2">
                          <div className="flex items-center gap-1">
                            <span className="text-gray-700 font-medium text-xs">{flight.airline}</span>
                            {flight.was_modified && (
                              <span title="Flight modified" className="text-orange-500 text-xs">⚠️</span>
                            )}
                            {flight.from_modification && (
                              <span className="text-xs font-bold px-1 py-0.5 rounded bg-green-100 text-green-700">NEW</span>
                            )}
                            {flight.booking_updated && (
                              <span
                                title={isMcl ? 'Click to dismiss' : 'Booking updated'}
                                className={`text-xs font-bold px-1 py-0.5 rounded bg-amber-100 text-amber-700 ${isMcl ? 'cursor-pointer hover:bg-amber-200' : ''}`}
                                onClick={isMcl ? async (e) => {
                                  e.stopPropagation()
                                  await updateDoc(doc(db, 'airfreight_flights', flight.id!), { booking_updated: false })
                                } : undefined}
                              >UPDATED</span>
                            )}
                          </div>
                        </td>
                        <td className="px-2 py-2 font-mono text-xs text-gray-500">
                          {flight.flight_number ? `#${flight.flight_number}` : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-2 py-2 text-gray-600 font-mono text-xs whitespace-nowrap">
                          {fmtEtd(flight.flight_datetime)}
                          {flight.cutoff_datetime && (
                            <span className="block text-[10px] text-orange-500">CutOff {fmtEtd(flight.cutoff_datetime)}</span>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex flex-wrap gap-0.5">
                            {flight.destinations?.map(d => (
                              <span key={d} className="text-xs font-mono font-semibold bg-mcl-blue/10 text-mcl-blue px-1 py-0.5 rounded">
                                {d}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-2 py-2 text-center tabular-nums text-gray-700 text-xs">
                          {flight.totalAwbs > 0 ? flight.totalAwbs : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-2 py-2 text-center tabular-nums text-gray-700 text-xs">
                          {flight.totalPieces > 0 ? fmtNum(flight.totalPieces, 0) : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-2 py-2 text-center tabular-nums text-gray-700 text-xs hidden sm:table-cell">
                          {flight.totalWeight > 0 ? fmtNum(flight.totalWeight, 0) : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-2 py-2 text-center tabular-nums text-gray-700 text-xs">
                          {flight.totalChw > 0 ? fmtNum(flight.totalChw, 0) : <span className="text-gray-300">—</span>}
                        </td>
                        {/* HOLDS */}
                        <td className="px-1 py-2 text-center">
                          {flight.holdStatus === 'complete'
                            ? <span className="inline-block w-3.5 h-3.5 rounded-full bg-green-500" title="Holds complete" />
                            : flight.holdStatus === 'pending'
                            ? <span className="inline-block w-3.5 h-3.5 rounded-full bg-red-500" title="Holds pending" />
                            : flight.holdStatus === 'pending_info'
                            ? <span className="inline-block w-3.5 h-3.5 rounded-full bg-yellow-400" title="Hold pending confirmation" />
                            : <span className="inline-block w-3.5 h-3.5 rounded-full bg-gray-200" />
                          }
                        </td>
                        {/* DG */}
                        <td className="px-1 py-2 text-center">
                          {flight.hasDG
                            ? <span className="inline-block w-3.5 h-3.5 rounded-full bg-orange-500" title="Dangerous Goods" />
                            : <span className="inline-block w-3.5 h-3.5 rounded-full bg-gray-200" />
                          }
                        </td>
                        {/* LB */}
                        <td className="px-1 py-2 text-center">
                          {flight.hasLB
                            ? <span className="inline-block w-3.5 h-3.5 rounded-full bg-yellow-500" title="Lithium Battery" />
                            : <span className="inline-block w-3.5 h-3.5 rounded-full bg-gray-200" />
                          }
                        </td>
                        {/* SYNC alerts */}
                        <td className="px-1 py-2 text-center hidden sm:table-cell" onClick={e => e.stopPropagation()}>
                          {(() => {
                            const flightNum = flight.flight_number || ''
                            const flightAlerts = flightAlertMap.get(flightNum) || []
                            const pendingAlerts = flightAlerts.filter(a => a.status === 'pending')
                            if (pendingAlerts.length === 0) {
                              return <span className="inline-block w-3.5 h-3.5 rounded-full bg-gray-200" />
                            }
                            return (
                              <button
                                onClick={() => setSyncPopupFlightId(flight.id)}
                                title={`${pendingAlerts.length} alerta(s) sync pendiente(s)`}
                              >
                                <span className="relative inline-flex items-center justify-center w-5 h-5">
                                  <span className="inline-block w-3.5 h-3.5 rounded-full bg-amber-500 animate-pulse" />
                                  <span className="absolute -top-1 -right-1 bg-red-600 text-white text-[8px] font-bold w-3.5 h-3.5 rounded-full flex items-center justify-center">
                                    {pendingAlerts.length}
                                  </span>
                                </span>
                              </button>
                            )
                          })()}
                        </td>
                        {/* DOCs */}
                        <td className="px-1 py-2 text-center hidden sm:table-cell">
                          <span
                            className={`inline-block w-3.5 h-3.5 rounded-full ${docsColor}`}
                            title={`Client: ${flight.clientDocsUploaded}/${flight.clientDocsTotal} · MCL: ${flight.mclDocsUploaded}/${flight.mclDocsTotal}`}
                          />
                        </td>
                        {/* DIST */}
                        <td className="px-1 py-2 text-center hidden sm:table-cell" onClick={e => e.stopPropagation()}>
                          {isMcl ? (
                            <button
                              onClick={() => navigate(`/airfreight/buildup?flight=${flight.id}`)}
                              className={`inline-block w-3.5 h-3.5 rounded-full cursor-pointer hover:ring-2 hover:ring-offset-1 hover:ring-blue-400 ${
                                flight.hasDist
                                  ? (flightStatus === 'built' || flightStatus === 'dispatched') ? 'bg-green-500' : 'bg-yellow-400'
                                  : 'bg-gray-200'
                              }`}
                              title={flight.hasDist
                                ? (flightStatus === 'built' || flightStatus === 'dispatched') ? 'Distribution closed — click to open' : 'Distribution in progress — click to open'
                                : 'No distribution — click to open'}
                            />
                          ) : (
                            <span
                              className={`inline-block w-3.5 h-3.5 rounded-full ${
                                flight.hasDist
                                  ? (flightStatus === 'built' || flightStatus === 'dispatched') ? 'bg-green-500' : 'bg-yellow-400'
                                  : 'bg-gray-200'
                              }`}
                              title={flight.hasDist
                                ? (flightStatus === 'built' || flightStatus === 'dispatched') ? 'Distribution closed' : 'Distribution in progress'
                                : 'No distribution'}
                            />
                          )}
                        </td>
                        {/* Status: Booked → Terminado → Dispatched */}
                        <td className="px-2 py-2 text-center" onClick={e => e.stopPropagation()}>
                          {isMcl ? (
                            <button
                              onClick={() => handleCycleStatus(flight)}
                              className={`text-xs px-2 py-0.5 rounded-full font-semibold transition-colors hover:opacity-80 ${statusStyle}`}
                              title={
                                flightStatus === 'dispatched'
                                  ? `Dispatched ${fmtTimestamp(flight.dispatched_at!)}` + ((flight as any).reopened_by ? `\nLast reopened by: ${(flight as any).reopened_by} (${fmtTimestamp((flight as any).reopened_at)})` : '')
                                  : (flight as any).reopened_by
                                    ? `Reopened by: ${(flight as any).reopened_by} (${fmtTimestamp((flight as any).reopened_at)})\nClick to advance`
                                    : `Click to advance`
                              }
                            >
                              {statusLabel}
                            </button>
                          ) : (
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusStyle}`}>
                              {statusLabel}
                            </span>
                          )}
                          {flightStatus === 'dispatched' && flight.dispatched_at && (
                            <div className="text-[10px] text-gray-400 mt-0.5">{fmtTimestamp(flight.dispatched_at)}</div>
                          )}
                          {(() => {
                            const match = distMatchMap.get(flight.id)
                            if (!match || match.status === 'loading') return null
                            return (
                              <span
                                className={`inline-block ml-1 text-xs font-bold ${match.status === 'check' ? 'text-green-600' : 'text-yellow-500'}`}
                                title={match.status === 'check' ? 'Dist OK' : match.message || 'Mismatch'}
                              >
                                {match.status === 'check' ? '✓' : '⚠'}
                              </span>
                            )
                          })()}
                        </td>
                        <td className="px-1 py-2 text-right" onClick={e => e.stopPropagation()}>
                          <div className={`${isViewer ? '' : 'opacity-0 group-hover:opacity-100'} transition-opacity flex items-center justify-end gap-1`}>
                            {flight.bookings.length > 0 && (
                              <button
                                onClick={() => navigate(`/airfreight/docs?flight=${flight.id}`)}
                                className="text-xs bg-mcl-blue text-white px-2.5 py-1 rounded-lg hover:bg-blue-900 transition-colors whitespace-nowrap font-semibold"
                              >
                                Docs
                              </button>
                            )}
                            {isMcl && flight.bookings.length > 0 && (
                              <button
                                onClick={() => navigate(`/airfreight/flight-tracking?flight=${flight.id}`)}
                                title="Seguimiento operacional"
                                className="hover:opacity-80 transition-opacity px-0.5 py-0.5"
                              >
                                <svg viewBox="0 0 36 36" className="w-5 h-5" fill="none" xmlns="http://www.w3.org/2000/svg">
                                  {/* Avion */}
                                  <path d="M4 20 L12 16 L16 6 L18 6 L15 16 L22 13 L24 10 L26 10 L23.5 15 L26 15 C27 15 27.5 15.5 27.5 16 C27.5 16.5 27 17 26 17 L23.5 17 L26 22 L24 22 L22 19 L15 16 L18 26 L16 26 L12 16 Z" fill="#16a34a" stroke="#15803d" strokeWidth="0.5"/>
                                  {/* Circulo paquete/MCL */}
                                  <circle cx="27" cy="27" r="8" fill="white" stroke="#1e3a5f" strokeWidth="1.5"/>
                                  <rect x="23.5" y="23.5" width="7" height="5" rx="0.5" fill="none" stroke="#1e3a5f" strokeWidth="0.8"/>
                                  <line x1="27" y1="23.5" x2="27" y2="28.5" stroke="#1e3a5f" strokeWidth="0.5"/>
                                  <line x1="23.5" y1="26" x2="30.5" y2="26" stroke="#1e3a5f" strokeWidth="0.5"/>
                                  <text x="27" y="33" textAnchor="middle" fill="#c8102e" fontSize="3.5" fontWeight="bold" fontFamily="Arial,sans-serif">MCL</text>
                                </svg>
                              </button>
                            )}
                            {canEdit && !isClient && (
                              <button
                                onClick={() => setConfirmDeleteId(flight.id)}
                                title="Delete flight"
                                className="text-xs text-gray-300 hover:text-red-500 transition-colors px-1.5 py-1"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                  {/* ── Draft flights (no confirmed ETD) ── */}
                  {draftFlights.length > 0 && (
                    <>
                      <tr>
                        <td colSpan={isClientScoped ? 17 : 18} className="px-0 py-0">
                          <div className="border-t-2 border-dashed border-gray-300 my-0" />
                        </td>
                      </tr>
                      <tr className="bg-gray-100">
                        <td colSpan={isClientScoped ? 17 : 18} className="px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                          Pending ETD — {draftFlights.length} flight{draftFlights.length !== 1 ? 's' : ''} without confirmed schedule
                        </td>
                      </tr>
                      {draftFlights.map(flight => {
                        const clientLabel = flight.clientNames.length === 0
                          ? <span className="text-gray-300">—</span>
                          : <span className="text-gray-500">{flight.clientNames[0]}{flight.clientNames.length > 1 ? <span className="text-gray-400 text-xs ml-1">+{flight.clientNames.length - 1}</span> : ''}</span>

                        return (
                          <tr
                            key={flight.id}
                            className="bg-gray-50 hover:bg-gray-100 transition-colors cursor-pointer opacity-70"
                            onClick={() => {
                              const hasExport = flight.bookings.some(b => b.booking_type === 'export')
                              navigate(hasExport ? `/airfreight/bookings/export?flight=${flight.id}` : `/airfreight/bookings/new?flight=${flight.id}`)
                            }}
                          >
                            {!isClientScoped && <td className="px-2 py-2 text-xs">{clientLabel}</td>}
                            <td className="px-2 py-2 text-xs text-gray-500">{flight.airline}</td>
                            <td className="px-2 py-2 font-mono text-xs text-gray-400">
                              {flight.flight_number ? `#${flight.flight_number}` : '—'}
                            </td>
                            <td className="px-2 py-2 text-xs italic text-gray-400">Pending</td>
                            <td className="px-2 py-2">
                              <div className="flex flex-wrap gap-0.5">
                                {flight.destinations?.map(d => (
                                  <span key={d} className="text-xs font-mono bg-gray-200 text-gray-500 px-1 py-0.5 rounded">{d}</span>
                                ))}
                              </div>
                            </td>
                            <td className="px-2 py-2 text-center text-xs text-gray-500">{flight.totalAwbs || '—'}</td>
                            <td className="px-2 py-2 text-center text-xs text-gray-500">{flight.totalPieces ? fmtNum(flight.totalPieces, 0) : '—'}</td>
                            <td className="px-2 py-2 text-center text-xs text-gray-500 hidden sm:table-cell">{flight.totalWeight ? fmtNum(flight.totalWeight, 0) : '—'}</td>
                            <td className="px-2 py-2 text-center text-xs text-gray-500">{flight.totalChw ? fmtNum(flight.totalChw, 0) : '—'}</td>
                            <td className="px-1 py-2 text-center"><span className="inline-block w-2.5 h-2.5 rounded-full bg-gray-300" /></td>
                            <td className="px-1 py-2 text-center"><span className="inline-block w-2.5 h-2.5 rounded-full bg-gray-300" /></td>
                            <td className="px-1 py-2 text-center"><span className="inline-block w-2.5 h-2.5 rounded-full bg-gray-300" /></td>
                            <td className="px-1 py-2 text-center hidden sm:table-cell"><span className="inline-block w-2.5 h-2.5 rounded-full bg-gray-300" /></td>
                            <td className="px-1 py-2 text-center hidden sm:table-cell"><span className="inline-block w-2.5 h-2.5 rounded-full bg-gray-300" /></td>
                            <td className="px-1 py-2 text-center hidden sm:table-cell"><span className="inline-block w-2.5 h-2.5 rounded-full bg-gray-300" /></td>
                            <td className="px-2 py-2 text-center">
                              <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-gray-200 text-gray-500">Draft</span>
                            </td>
                            <td className="px-1 py-2" />
                          </tr>
                        )
                      })}
                    </>
                  )}
                </tbody>
                {filtered.length > 1 && (
                  <tfoot>
                    <tr className="bg-gray-50 border-t-2 border-gray-200 text-xs font-bold text-gray-600">
                      {!isClientScoped && <td className="px-2 py-2" />}
                      <td className="px-2 py-2" colSpan={4}>
                        TOTAL — {filtered.length} flight{filtered.length !== 1 ? 's' : ''}
                      </td>
                      <td className="px-2 py-2 text-center">{fmtNum(filtered.reduce((s, f) => s + f.totalAwbs, 0), 0) || '—'}</td>
                      <td className="px-2 py-2 text-center">{fmtNum(filtered.reduce((s, f) => s + f.totalPieces, 0), 0) || '—'}</td>
                      <td className="px-2 py-2 text-center">{fmtNum(filtered.reduce((s, f) => s + f.totalWeight, 0), 0) || '—'}</td>
                      <td className="px-2 py-2 text-center">{fmtNum(filtered.reduce((s, f) => s + f.totalChw, 0), 0) || '—'}</td>
                      <td className="px-1 py-2" colSpan={8} />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        )}
      </div>

      {/* ── Sync Alert Popup (flight level) ── */}
      {syncPopupFlightId && (() => {
        const fl = flights.find(f => f.id === syncPopupFlightId)
        if (!fl) return null
        const flightNum = fl.flight_number || ''
        const flightAlerts = flightAlertMap.get(flightNum) || []
        if (flightAlerts.length === 0) return null
        return (
          <FlightAlertPopup
            flightNumber={flightNum}
            airline={fl.airline}
            dest={fl.destinations?.join(', ') || ''}
            etd={fmtEtd(fl.flight_datetime)}
            totalAwbs={fl.totalAwbs}
            alerts={flightAlerts}
            onClose={() => setSyncPopupFlightId(null)}
          />
        )
      })()}

      {/* ── Delete confirmation modal ── */}
      {confirmDeleteId && (() => {
        const fl = flights.find(f => f.id === confirmDeleteId)
        return (
          <>
            <div className="fixed inset-0 bg-black/30 z-40" onClick={() => !deleting && setConfirmDeleteId(null)} />
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6 space-y-4">
                <h3 className="font-semibold text-gray-800">Delete flight?</h3>
                <p className="text-sm text-gray-500">
                  Are you sure you want to delete <span className="font-medium text-gray-700">{fl?.airline}{fl?.flight_number ? ` #${fl.flight_number}` : ''}</span>?
                  {fl && fl.bookings.length > 0 && (
                    <span className="block mt-1 text-red-500 font-medium">
                      This will also delete {fl.bookings.length} booking{fl.bookings.length !== 1 ? 's' : ''} associated with this flight.
                    </span>
                  )}
                </p>
                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={() => setConfirmDeleteId(null)}
                    disabled={deleting}
                    className="text-sm px-4 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => handleDeleteFlight(confirmDeleteId)}
                    disabled={deleting}
                    className="text-sm px-4 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50"
                  >
                    {deleting ? 'Deleting...' : 'Delete'}
                  </button>
                </div>
              </div>
            </div>
          </>
        )
      })()}
    </Layout>
  )
}
