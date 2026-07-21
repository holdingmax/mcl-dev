import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  collection, query, where, getDocs, getDoc, addDoc, updateDoc, deleteDoc, doc, onSnapshot, orderBy, writeBatch,
} from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import { AirfreightFlight } from '../../types'
import Layout from '../../components/Layout'
import { generateDistributionPdf, generatePalletControlPdf, uploadDistributionPdf, generatePalletTagPdf, generatePalletTagDocPdf, PalletTagDocData } from '../../lib/buildupPdf'
import { fmtNum } from '../../lib/utils'
import BarcodeContinuousScanner from '../../components/BarcodeContinuousScanner'

// ── Types ──────────────────────────────────────────────────────────────────────

interface DocReception {
  id: string
  awb_number: string
  awb_2nd_leg: string | null
  mawb_number: string | null
  client_name: string
  agent_name?: string | null
  destination: string
  pieces: number
  weight: number
  chargeable_weight: number
  flight_id: string | null
  flight_number: string
  booking_id: string | null
  status: string
  warehouse_number: string | null
  cargo_type: 'loose' | 'bup'
  uld_number: string | null
}

interface PhysicalPiece {
  id: string
  doc_reception_id: string
  awb_number: string
  warehouse_number: string
  piece_number: number
  weight_kg: number
  length_cm: number | null
  width_cm: number | null
  height_cm: number | null
  vol_weight_kg: number | null
  packing_type: string
  condition: string
  barcode: string
  // Build-up assignment
  uld_id?: string | null
  dist_comment?: string | null
}

interface UldType {
  id: string
  conf: string
  type: string
  max_weight_kg: number
  tara_kg: number
}

interface BuildupUld {
  id: string
  flight_id: string
  uld_number: string
  conf: string        // MD / LD / ESP
  type: string        // AKE, PMC, etc.
  max_weight_kg: number
  tara_kg: number
  status: 'open' | 'closed'
  destination: string
  created_at: string
  awb_numbers?: string[]
}

interface AwbForBuildup {
  reception: DocReception
  pieces: PhysicalPiece[]
  assignedCount: number
  totalPieces: number
  forceClosed: boolean
  forceClosedBy?: string
  forceClosedAt?: string
  holdStatus?: false | 'pending' | true  // HAL-21: from booking awb_line
}

// ── Helpers ────────────────────────────────────────────────────────────────────


const CONF_COLORS: Record<string, string> = {
  MD: 'bg-purple-100 text-purple-700 border-purple-200',
  LD: 'bg-blue-100 text-blue-700 border-blue-200',
  ESP: 'bg-amber-100 text-amber-700 border-amber-200',
}

// ── Mobile quantity assigner (for groups of identical pieces) ─────────────────

function MobileQtyAssign({ max, onAssign }: { max: number; onAssign: (qty: number, comment?: string) => void }) {
  const [raw, setRaw] = useState(String(max))
  const [showComment, setShowComment] = useState(false)
  const [comment, setComment] = useState('')
  const parsed = parseInt(raw) || 0
  const valid = parsed >= 1 && parsed <= max
  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center gap-3">
        <input type="text" inputMode="numeric" value={raw}
          onChange={e => setRaw(e.target.value.replace(/\D/g, ''))}
          className="w-20 h-12 border-2 border-gray-300 rounded-xl text-center font-mono font-bold text-lg focus:outline-none focus:border-[#1e3a5f]" />
        <button onClick={() => valid && onAssign(parsed, comment || undefined)} disabled={!valid}
          className="flex-1 h-12 rounded-xl bg-[#1e3a5f] text-white text-base font-bold active:bg-blue-900 shadow disabled:opacity-50">
          Assign {parsed}
        </button>
      </div>
      {!showComment ? (
        <button onClick={() => setShowComment(true)} className="flex items-center gap-1.5 text-sm text-gray-400">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>
          Add comment
        </button>
      ) : (
        <textarea rows={2} value={comment} onChange={e => setComment(e.target.value)}
          placeholder="Write a comment..."
          className="w-full border-2 border-gray-300 rounded-xl px-3 py-2.5 text-base focus:border-[#1e3a5f] focus:outline-none resize-none" />
      )}
    </div>
  )
}

function MobileQtyReduce({ current, onReduce }: { current: number; onReduce: (newQty: number) => void }) {
  const [raw, setRaw] = useState(String(current))
  const parsed = parseInt(raw) || 0
  const diff = current - parsed
  const valid = parsed >= 0 && parsed < current
  return (
    <div className="mt-1 mb-1 flex items-center gap-2 pl-6">
      <button onClick={() => setRaw(String(Math.max(0, parsed - 1)))}
        className="w-8 h-8 rounded-lg border border-red-200 text-red-500 font-bold active:bg-red-50">-</button>
      <input type="text" inputMode="numeric" value={raw}
        onChange={e => setRaw(e.target.value.replace(/\D/g, ''))}
        className="w-14 h-8 border border-red-200 rounded-lg text-center font-mono font-bold text-sm focus:outline-none focus:border-red-400" />
      <button onClick={() => setRaw(String(Math.min(current, parsed + 1)))}
        className="w-8 h-8 rounded-lg border border-red-200 text-red-500 font-bold active:bg-red-50">+</button>
      <span className="text-[10px] text-gray-400">/ {current}</span>
      {valid && (
        <button onClick={() => onReduce(parsed)}
          className="flex-1 h-8 rounded-lg bg-red-500 text-white text-[11px] font-bold active:bg-red-600">
          Quitar {diff}
        </button>
      )}
    </div>
  )
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function AirfreightBuildup() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { user } = useAuth()

  // Responsive detection
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768)
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Step 1: Flight selection
  const [flights, setFlights] = useState<(AirfreightFlight & { id: string })[]>([])
  const [flightClients, setFlightClients] = useState<Record<string, string[]>>({}) // flightId → client names
  const [flightSearch, setFlightSearch] = useState('')
  const [loadingFlights, setLoadingFlights] = useState(true)
  const [selectedFlight, setSelectedFlight] = useState<(AirfreightFlight & { id: string }) | null>(null)

  // Step 2: Build-up data
  const [awbs, setAwbs] = useState<AwbForBuildup[]>([])
  const [ulds, setUlds] = useState<BuildupUld[]>([])
  const [uldTypes, setUldTypes] = useState<UldType[]>([])
  const [loadingData, setLoadingData] = useState(false)

  // Create ULD form
  const [showCreateUld, setShowCreateUld] = useState(false)
  const [newUldConf, setNewUldConf] = useState<string>('MD')
  const [newUldTypeId, setNewUldTypeId] = useState('')
  const [newUldNumber, setNewUldNumber] = useState('')
  const [newUldDest, setNewUldDest] = useState('')
  const [creatingSaving, setCreatingSaving] = useState(false)

  // Assign modal (desktop)
  const [assignModal, setAssignModal] = useState<{ uld: BuildupUld } | null>(null)
  const [assignMode, setAssignMode] = useState<'bulk' | 'barcode'>('bulk')
  const [assignAwbId, setAssignAwbId] = useState('')
  const [assignQty, setAssignQty] = useState('')
  const [assignBarcode, setAssignBarcode] = useState('')
  const [assignComment, setAssignComment] = useState('')
  const [assigning, setAssigning] = useState(false)

  // Expanded AWB rows in ULD cards (to adjust quantity)
  const [expandedUldAwb, setExpandedUldAwb] = useState<string | null>(null) // "uldId|awb"
  const [editAwbQty, setEditAwbQty] = useState<number>(0)
  const [editGroupComment, setEditGroupComment] = useState('')

  // Inline ULD editing (CONF + TYPE + Number)
  const [editingUldId, setEditingUldId] = useState<string | null>(null)
  const [editUldConf, setEditUldConf] = useState('')
  const [editUldType, setEditUldType] = useState('')
  const [editUldNumber, setEditUldNumber] = useState('')

  // Mobile-specific state
  const [mobileUld, setMobileUld] = useState<BuildupUld | null>(null) // selected ULD for mobile detail
  const [mobileTab, setMobileTab] = useState<'pieza' | 'barcode' | 'wr'>('pieza')
  const [mobileBarcode, setMobileBarcode] = useState('')
  const [mobileWrInput, setMobileWrInput] = useState('')
  const [mobileWrResults, setMobileWrResults] = useState<PhysicalPiece[]>([])
  const [mobileFeedback, setMobileFeedback] = useState<{ type: 'success' | 'warning' | 'error'; msg: string; detail: string } | null>(null)
  const [mobileAwbView, setMobileAwbView] = useState(false) // AWB → ULDs reverse view

  // Continuous barcode scanner
  const [continuousScanUld, setContinuousScanUld] = useState<{ id: string; number: string } | null>(null)

  // Close Distribution
  const [showCloseDistDialog, setShowCloseDistDialog] = useState(false)
  const [closingDist, setClosingDist] = useState(false)

  // Load flights that have doc_receptions with physical reception started OR bookings with on_hand AWBs
  useEffect(() => {
    async function loadFlights() {
      // 1. Get receptions that have physical reception in progress or complete
      const recSnap = await getDocs(query(
        collection(db, 'airfreight_doc_receptions'),
        where('status', 'in', ['in_physical', 'complete']),
      ))
      const flightIds = new Set<string>()
      const clientsByFlight: Record<string, Set<string>> = {}
      recSnap.docs.forEach(d => {
        const data = d.data()
        const fid = data.flight_id
        if (fid) {
          flightIds.add(fid)
          if (!clientsByFlight[fid]) clientsByFlight[fid] = new Set()
          if (data.client_name) clientsByFlight[fid].add(data.client_name)
        }
      })

      // 2. Also include flights from bookings with on_hand AWBs (e.g. created by sheet sync agent)
      const bkSnap = await getDocs(query(
        collection(db, 'airfreight_bookings'),
        where('status', 'in', ['submitted', 'onhand']),
      ))
      for (const bDoc of bkSnap.docs) {
        const bk = bDoc.data()
        const fid = bk.flight_id
        if (!fid) continue
        // Check if any AWB line has on_hand: true
        let hasOnHand = false
        if (bk.booking_type === 'simple') {
          hasOnHand = !!bk.on_hand
        } else if (bk.awb_lines) {
          hasOnHand = bk.awb_lines.some((l: any) => l.on_hand)
        }
        if (hasOnHand) {
          flightIds.add(fid)
          if (!clientsByFlight[fid]) clientsByFlight[fid] = new Set()
          if (bk.client_name) clientsByFlight[fid].add(bk.client_name)
        }
      }

      const clientsMap: Record<string, string[]> = {}
      for (const [fid, clients] of Object.entries(clientsByFlight)) {
        clientsMap[fid] = Array.from(clients)
      }
      setFlightClients(clientsMap)

      if (flightIds.size === 0) {
        setFlights([])
        setLoadingFlights(false)
        return
      }

      // Load those flights
      const flightSnap = await getDocs(query(
        collection(db, 'airfreight_flights'),
        orderBy('flight_datetime', 'desc'),
      ))
      // Only show flights with ETD >= yesterday (today - 1 day)
      const yesterday = new Date()
      yesterday.setDate(yesterday.getDate() - 1)
      const yesterdayStr = yesterday.toLocaleDateString('en-CA')

      const allFlights = flightSnap.docs
        .map(d => ({ id: d.id, ...d.data() } as AirfreightFlight & { id: string }))
        .filter(f => flightIds.has(f.id) && (f.flight_datetime || '') >= yesterdayStr)

      setFlights(allFlights)
      setLoadingFlights(false)

      // Auto-select if flight_id in URL
      const fParam = searchParams.get('flight')
      if (fParam) {
        const found = allFlights.find(f => f.id === fParam)
        if (found) setSelectedFlight(found)
      }
    }
    loadFlights()
  }, [])

  // Load ULD types
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'uld_types'), snap => {
      setUldTypes(snap.docs.map(d => ({ id: d.id, ...d.data() } as UldType)))
    })
    return unsub
  }, [])

  // Load build-up data when flight is selected
  useEffect(() => {
    if (!selectedFlight) return
    setLoadingData(true)

    async function loadData() {
      const flightId = selectedFlight!.id

      // 1. Get doc receptions for this flight with physical reception started or complete
      const recSnap = await getDocs(query(
        collection(db, 'airfreight_doc_receptions'),
        where('flight_id', '==', flightId),
        where('status', 'in', ['in_physical', 'complete']),
      ))
      const receptions = recSnap.docs.map(d => ({ id: d.id, ...d.data() } as DocReception))

      // 2. Get all physical pieces for these receptions (parallel)
      const piecesResults = await Promise.all(
        receptions.map(rec =>
          getDocs(query(
            collection(db, 'airfreight_physical_pieces'),
            where('doc_reception_id', '==', rec.id),
          ))
        )
      )
      const awbList: AwbForBuildup[] = receptions.map((rec, idx) => {
        const pieces = piecesResults[idx].docs.map(d => ({ id: d.id, ...d.data() } as PhysicalPiece))
        const assignedCount = pieces.filter(p => p.uld_id).length
        return {
          reception: rec,
          pieces,
          assignedCount,
          totalPieces: pieces.length,
          forceClosed: !!(rec as any).force_closed,
          forceClosedBy: (rec as any).force_closed_by,
          forceClosedAt: (rec as any).force_closed_at,
        }
      })
      setAwbs(awbList)
      setLoadingData(false)
    }
    loadData()

    // Listen to ULDs for this flight
    const uldQ = query(
      collection(db, 'buildup_ulds'),
      where('flight_id', '==', selectedFlight.id),
    )
    const unsub = onSnapshot(uldQ, snap => {
      setUlds(snap.docs.map(d => ({ id: d.id, ...d.data() } as BuildupUld))
        .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || '')))
    })
    return unsub
  }, [selectedFlight?.id])

  // Derived
  const allPieces = useMemo(() => awbs.flatMap(a => a.pieces), [awbs])
  const unassignedPieces = useMemo(() => allPieces.filter(p => !p.uld_id), [allPieces])
  const totalWeight = allPieces.reduce((s, p) => s + p.weight_kg, 0)
  const assignedWeight = allPieces.filter(p => p.uld_id).reduce((s, p) => s + p.weight_kg, 0)

  // ULD id → number lookup for scanner display
  const uldLookup = useMemo(() => {
    const map = new Map<string, string>()
    ulds.forEach(u => map.set(u.id, u.uld_number))
    return map
  }, [ulds])

  // Continuous scanner: assign piece by updating Firestore directly
  async function handleContinuousScanAssign(pieceId: string, sourceUldId?: string) {
    if (!continuousScanUld) return
    await updateDoc(doc(db, 'airfreight_physical_pieces', pieceId), { uld_id: continuousScanUld.id })
    const affected = [continuousScanUld.id]
    if (sourceUldId) affected.push(sourceUldId)
    refreshAwbData(affected)
  }

  // Pieces per ULD
  function getUldPieces(uldId: string) {
    return allPieces.filter(p => p.uld_id === uldId)
  }
  function getUldWeight(uldId: string) {
    return getUldPieces(uldId).reduce((s, p) => s + p.weight_kg, 0)
  }
  function getUldAwbs(uldId: string) {
    const pieces = getUldPieces(uldId)
    const awbMap = new Map<string, { awb: string; count: number; weight: number }>()
    for (const p of pieces) {
      const key = p.awb_number
      if (!awbMap.has(key)) awbMap.set(key, { awb: key, count: 0, weight: 0 })
      const entry = awbMap.get(key)!
      entry.count++
      entry.weight += p.weight_kg
    }
    return Array.from(awbMap.values())
  }

  // ── Create ULD ─────────────────────────────────────────────────────────────

  async function handleCreateUld() {
    if (!selectedFlight || !newUldNumber.trim() || !newUldTypeId) return
    setCreatingSaving(true)
    try {
      const uldType = uldTypes.find(t => t.id === newUldTypeId)!
      await addDoc(collection(db, 'buildup_ulds'), {
        flight_id: selectedFlight.id,
        uld_number: newUldNumber.trim().toUpperCase(),
        conf: uldType.conf,
        type: uldType.type,
        max_weight_kg: uldType.max_weight_kg,
        tara_kg: uldType.tara_kg,
        status: 'open',
        destination: newUldDest || selectedFlight.destinations?.[0] || '',
        created_at: new Date().toISOString(),
        created_by: user?.email || '',
      })
      // First ULD → set flight status to in_progress
      const currentStatus = selectedFlight.flight_status || 'booked'
      if (ulds.length === 0 && currentStatus === 'booked') {
        await updateDoc(doc(db, 'airfreight_flights', selectedFlight.id), { flight_status: 'in_progress' })
      }
      setShowCreateUld(false)
      setNewUldNumber('')
      setNewUldTypeId('')
      setNewUldDest('')
    } catch (err: any) {
      alert('Error: ' + (err.message || err))
    } finally {
      setCreatingSaving(false)
    }
  }

  // ── Close / Re-open Distribution ────────────────────────────────────────────

  const flightStatus = selectedFlight?.flight_status || 'booked'
  const isBuilt = flightStatus === 'built'

  // AWBs with incomplete or zero pieces assigned (for close dist dialog)
  const incompleteAwbs = awbs.filter(a => a.assignedCount > 0 && a.assignedCount < a.totalPieces)
  const zeroAwbs = awbs.filter(a => a.assignedCount === 0)

  async function handleCloseDistribution() {
    if (!selectedFlight) return
    setClosingDist(true)
    try {
      await updateDoc(doc(db, 'airfreight_flights', selectedFlight.id), {
        flight_status: 'built',
        built_at: new Date().toISOString(),
        built_by: user?.email || '',
      })
      // Update local state
      setSelectedFlight({ ...selectedFlight, flight_status: 'built' } as any)
      setShowCloseDistDialog(false)
    } catch (err: any) {
      alert('Error: ' + (err.message || err))
    } finally {
      setClosingDist(false)
    }
  }

  async function handleReopenDistribution() {
    if (!selectedFlight) return
    if (!confirm('Re-open distribution? Status will change back to In Progress.')) return
    await updateDoc(doc(db, 'airfreight_flights', selectedFlight.id), {
      flight_status: 'in_progress',
      reopened_by: user?.email || '',
      reopened_at: new Date().toISOString(),
    })
    setSelectedFlight({ ...selectedFlight, flight_status: 'in_progress' } as any)
  }

  // ── PDF helpers ────────────────────────────────────────────────────────────

  function getPdfData() {
    if (!selectedFlight) return null
    const pdfAwbs = awbs.map(a => ({
      awb_number: a.reception.awb_number,
      awb_2nd_leg: a.reception.awb_2nd_leg,
      mawb_number: a.reception.mawb_number,
      client_name: a.reception.client_name,
      agent_name: a.reception.agent_name,
      destination: a.reception.destination,
      pieces_declared: a.reception.pieces,
      chargeable_weight: a.reception.chargeable_weight,
    }))
    const pdfPieces = allPieces.map(p => ({
      awb_number: p.awb_number,
      weight_kg: p.weight_kg,
      packing_type: p.packing_type,
      uld_id: p.uld_id || null,
      comment: p.dist_comment || '',
    }))
    const pdfUlds = ulds.map(u => ({
      id: u.id,
      uld_number: u.uld_number,
      conf: u.conf,
      type: u.type,
      destination: u.destination,
    }))
    return { flight: selectedFlight, awbs: pdfAwbs, pieces: pdfPieces, ulds: pdfUlds }
  }

  function handleDownloadDistPdf() {
    const data = getPdfData()
    if (!data) return
    const blob = generateDistributionPdf(data.flight, data.awbs, data.pieces, data.ulds, user?.email || '')
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `Distribution_${selectedFlight?.flight_number || 'flight'}.pdf`
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleDownloadPalletPdf() {
    const data = getPdfData()
    if (!data) return
    const blob = generatePalletControlPdf(data.flight, data.awbs, data.pieces, data.ulds, user?.email || '')
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `PalletControl_${selectedFlight?.flight_number || 'flight'}.pdf`
    a.click()
    URL.revokeObjectURL(url)
  }

  function buildTagData(uldList: BuildupUld[]) {
    if (!selectedFlight) return []
    return uldList.map(u => {
      const pieces = getUldPieces(u.id)
      const netWeight = pieces.reduce((s, p) => s + p.weight_kg, 0)

      // Build note lines: group by MAWB or AWB
      const noteMap = new Map<string, { label: string; count: number; comments: string[] }>()
      for (const p of pieces) {
        const awbData = awbs.find(a => a.reception.awb_number === p.awb_number)
        const mawb = awbData?.reception.mawb_number
        // If MAWB exists, use MAWB as key; otherwise use AWB
        const key = mawb || (awbData?.reception.awb_2nd_leg || p.awb_number)
        if (!noteMap.has(key)) noteMap.set(key, { label: key, count: 0, comments: [] })
        const entry = noteMap.get(key)!
        entry.count++
        if (p.dist_comment && !entry.comments.includes(p.dist_comment)) {
          entry.comments.push(p.dist_comment)
        }
      }
      const noteLines = Array.from(noteMap.values()).map(n => {
        let line = `${n.label} (${n.count} pcs)`
        if (n.comments.length > 0) line += ` - ${n.comments.join(', ')}`
        return line
      })

      // Extract airline code from flight number (first letters before digits)
      const airlineCode = (selectedFlight.flight_number || '').replace(/[0-9\s].*/g, '') || selectedFlight.airline?.substring(0, 2) || ''

      return {
        airlineCode,
        airlineName: selectedFlight.airline || '',
        uldNumber: `${u.type}${u.uld_number}`,
        destination: u.destination || (selectedFlight.destinations || [])[0] || '',
        position: u.conf,
        netWeightKg: netWeight,
        tareWeightKg: u.tara_kg || 0,
        loadedAt: 'MIA',
        flightNumber: selectedFlight.flight_number || '',
        flightDate: selectedFlight.flight_datetime,
        noteLines,
        userEmail: user?.email || '',
      }
    })
  }

  async function handlePrintTag(uld: BuildupUld) {
    const tags = buildTagData([uld])
    if (tags.length === 0) return
    const blob = await generatePalletTagPdf(tags)
    const url = URL.createObjectURL(blob)
    const w = window.open(url, '_blank')
    if (w) w.onafterprint = () => URL.revokeObjectURL(url)
  }

  async function handlePrintAllTags() {
    const closed = ulds.filter(u => u.status === 'closed')
    if (closed.length === 0) return
    const tags = buildTagData(closed)
    if (tags.length === 0) return
    const blob = await generatePalletTagPdf(tags)
    const url = URL.createObjectURL(blob)
    const w = window.open(url, '_blank')
    if (w) w.onafterprint = () => URL.revokeObjectURL(url)
  }

  // ── Pallet Tag Document (letter-size PDF) ──
  function buildTagDocData(uldList: BuildupUld[]): PalletTagDocData[] {
    if (!selectedFlight) return []
    return uldList.map(u => {
      const pieces = getUldPieces(u.id)

      // Group pieces by AWB
      const awbMap = new Map<string, { awb: string; pieces: number; weightKg: number; comments: string[] }>()
      for (const p of pieces) {
        const awbData = awbs.find(a => a.reception.awb_number === p.awb_number)
        const key = awbData?.reception.awb_2nd_leg || p.awb_number
        if (!awbMap.has(key)) awbMap.set(key, { awb: key, pieces: 0, weightKg: 0, comments: [] })
        const entry = awbMap.get(key)!
        entry.pieces++
        entry.weightKg += p.weight_kg
        if (p.dist_comment && !entry.comments.includes(p.dist_comment)) entry.comments.push(p.dist_comment)
      }
      const awbLines = Array.from(awbMap.values()).map(a => ({
        awb: a.awb,
        pieces: a.pieces,
        weightKg: a.weightKg,
        remark: a.comments.join(', '),
      }))

      // Note lines (same logic as tag)
      const noteMap = new Map<string, { label: string; count: number; comments: string[] }>()
      for (const p of pieces) {
        const awbData = awbs.find(a => a.reception.awb_number === p.awb_number)
        const mawb = awbData?.reception.mawb_number
        const key = mawb || (awbData?.reception.awb_2nd_leg || p.awb_number)
        if (!noteMap.has(key)) noteMap.set(key, { label: key, count: 0, comments: [] })
        const entry = noteMap.get(key)!
        entry.count++
        if (p.dist_comment && !entry.comments.includes(p.dist_comment)) entry.comments.push(p.dist_comment)
      }
      const noteLines = Array.from(noteMap.values()).map(n => {
        let line = `${n.label} - ${n.count} pcs`
        if (n.comments.length > 0) line += ` ${n.comments.join(', ')}`
        return line
      })

      return {
        uldNumber: `${u.type} ${u.uld_number}`,
        flightNumber: selectedFlight.flight_number || '',
        flightDate: selectedFlight.flight_datetime,
        destination: u.destination || (selectedFlight.destinations || [])[0] || '',
        position: u.conf,
        totalWeightKg: pieces.reduce((s, p) => s + p.weight_kg, 0),
        awbLines,
        noteLines,
        userEmail: user?.email || '',
      }
    })
  }

  function handleDownloadTagDoc(uld: BuildupUld) {
    const docs = buildTagDocData([uld])
    if (docs.length === 0) return
    const blob = generatePalletTagDocPdf(docs)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `PalletTag_${uld.type}${uld.uld_number}.pdf`
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleDownloadAllTagDocs() {
    const closed = ulds.filter(u => u.status === 'closed')
    if (closed.length === 0) return
    const docs = buildTagDocData(closed)
    if (docs.length === 0) return
    const blob = generatePalletTagDocPdf(docs)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `PalletTags_${selectedFlight?.flight_number || 'flight'}.pdf`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Background upload of distribution PDF after piece changes
  const uploadPdfInBackground = useCallback(() => {
    if (!selectedFlight || ulds.length === 0) return
    const data = getPdfData()
    if (!data || !data.pieces.some(p => p.uld_id)) return
    // Fire and forget — don't block UI
    uploadDistributionPdf(data.flight, data.awbs, data.pieces, data.ulds, user?.email || '')
      .catch(err => console.error('Background PDF upload failed:', err))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFlight, awbs, allPieces, ulds, user?.email])

  // Auto-upload when pieces/ULDs change
  useEffect(() => {
    if (!selectedFlight || ulds.length === 0 || !allPieces.some(p => p.uld_id)) return
    const timer = setTimeout(uploadPdfInBackground, 2000) // debounce 2s
    return () => clearTimeout(timer)
  }, [allPieces, ulds, uploadPdfInBackground, selectedFlight])

  // ── Toggle ULD status ──────────────────────────────────────────────────────

  async function toggleUldStatus(uld: BuildupUld) {
    const newStatus = uld.status === 'open' ? 'closed' : 'open'
    await updateDoc(doc(db, 'buildup_ulds', uld.id), { status: newStatus })
  }

  async function handleDeleteUld(uld: BuildupUld) {
    const uldPieces = getUldPieces(uld.id)
    if (uldPieces.length > 0) {
      if (!confirm(`Este ULD tiene ${uldPieces.length} piezas asignadas. Se desasignaran. Continuar?`)) return
      // Unassign all pieces
      await Promise.all(uldPieces.map(p =>
        updateDoc(doc(db, 'airfreight_physical_pieces', p.id), { uld_id: null })
      ))
    } else {
      if (!confirm(`Eliminar ULD ${uld.uld_number}?`)) return
    }
    await deleteDoc(doc(db, 'buildup_ulds', uld.id))
  }

  // ── Edit ULD (CONF + TYPE + Number) ───────────────────────────────────────

  function startEditUld(u: BuildupUld) {
    setEditingUldId(u.id)
    setEditUldConf(u.conf)
    setEditUldType(u.type)
    setEditUldNumber(u.uld_number)
  }

  async function handleSaveUld(uldId: string) {
    if (!editUldNumber.trim() || !editUldType) return
    const matchingType = uldTypes.find(t => t.conf === editUldConf && t.type === editUldType)
    const updates: any = {
      uld_number: editUldNumber.trim().toUpperCase(),
      conf: editUldConf,
      type: editUldType,
    }
    if (matchingType) {
      updates.max_weight_kg = matchingType.max_weight_kg
      updates.tara_kg = matchingType.tara_kg
    }
    await updateDoc(doc(db, 'buildup_ulds', uldId), updates)
    setEditingUldId(null)
  }

  // ── Reduce AWB quantity in ULD ──────────────────────────────────────────

  async function handleReduceAwbQty(uldId: string, awbNumber: string, newQty: number) {
    const piecesInUld = allPieces
      .filter(p => p.uld_id === uldId && p.awb_number === awbNumber)
      .sort((a, b) => b.piece_number - a.piece_number) // highest piece_number first
    const currentQty = piecesInUld.length
    if (newQty >= currentQty || newQty < 0) return
    const toRemove = piecesInUld.slice(0, currentQty - newQty)
    await Promise.all(toRemove.map(p =>
      updateDoc(doc(db, 'airfreight_physical_pieces', p.id), { uld_id: null })
    ))
    refreshAwbData([uldId])
    setExpandedUldAwb(null)
  }

  // ── Reduce AWB quantity in ULD by type+weight (mobile) ─────────────────────

  async function handleReduceAwbQtyByType(uldId: string, awbNumber: string, packingType: string, weightKg: number, newQty: number) {
    const piecesInUld = allPieces
      .filter(p => p.uld_id === uldId && p.awb_number === awbNumber && p.packing_type === packingType && Math.abs(p.weight_kg - weightKg) < 0.01)
      .sort((a, b) => b.piece_number - a.piece_number)
    const currentQty = piecesInUld.length
    if (newQty >= currentQty || newQty < 0) return
    const toRemove = piecesInUld.slice(0, currentQty - newQty)
    await Promise.all(toRemove.map(p =>
      updateDoc(doc(db, 'airfreight_physical_pieces', p.id), { uld_id: null })
    ))
    refreshAwbData([uldId])
  }

  // ── Assign pieces ──────────────────────────────────────────────────────────

  async function handleAssignBulk() {
    if (!assignModal || !assignAwbId || !assignQty) return
    setAssigning(true)
    try {
      const qty = parseInt(assignQty)
      const awbData = awbs.find(a => a.reception.id === assignAwbId)
      if (!awbData) return

      // Get unassigned pieces for this AWB
      const available = awbData.pieces.filter(p => !p.uld_id).sort((a, b) => a.piece_number - b.piece_number)
      const toAssign = available.slice(0, qty)

      const update: Record<string, any> = { uld_id: assignModal.uld.id }
      if (assignComment.trim()) update.dist_comment = assignComment.trim()
      await Promise.all(toAssign.map(p =>
        updateDoc(doc(db, 'airfreight_physical_pieces', p.id), update)
      ))

      // Refresh AWB data
      refreshAwbData([assignModal.uld.id])
      setAssignAwbId('')
      setAssignQty('')
      setAssignComment('')
    } catch (err: any) {
      alert('Error: ' + (err.message || err))
    } finally {
      setAssigning(false)
    }
  }

  async function handleAssignBarcode() {
    if (!assignModal || !assignBarcode.trim()) return
    setAssigning(true)
    try {
      const barcode = assignBarcode.trim()
      const piece = allPieces.find(p => p.barcode === barcode)
      if (!piece) {
        alert('Barcode no encontrado en este vuelo')
        setAssigning(false)
        return
      }
      const sourceUldId = piece.uld_id
      if (sourceUldId && sourceUldId !== assignModal.uld.id) {
        const currentUld = ulds.find(u => u.id === sourceUldId)
        if (!confirm(`Esta pieza ya esta en ULD ${currentUld?.uld_number || '?'}. Moverla?`)) {
          setAssigning(false)
          return
        }
      }
      await updateDoc(doc(db, 'airfreight_physical_pieces', piece.id), { uld_id: assignModal.uld.id })
      const affected = [assignModal.uld.id]
      if (sourceUldId && sourceUldId !== assignModal.uld.id) affected.push(sourceUldId)
      refreshAwbData(affected)
      setAssignBarcode('')
    } catch (err: any) {
      alert('Error: ' + (err.message || err))
    } finally {
      setAssigning(false)
    }
  }

  async function handleUnassignPiece(pieceId: string) {
    const piece = allPieces.find(p => p.id === pieceId)
    const sourceUldId = piece?.uld_id
    await updateDoc(doc(db, 'airfreight_physical_pieces', pieceId), { uld_id: null })
    refreshAwbData(sourceUldId ? [sourceUldId] : undefined)
  }

  async function refreshAwbData(affectedUldIds?: string[]) {
    if (!selectedFlight) return
    const recSnap = await getDocs(query(
      collection(db, 'airfreight_doc_receptions'),
      where('flight_id', '==', selectedFlight.id),
      where('status', 'in', ['in_physical', 'complete']),
    ))
    const receptions = recSnap.docs.map(d => ({ id: d.id, ...d.data() } as DocReception))
    // HAL-21: Load booking hold status for each doc_reception
    const bookingCache: Record<string, any> = {}
    const awbList: AwbForBuildup[] = []
    for (const rec of receptions) {
      const pSnap = await getDocs(query(
        collection(db, 'airfreight_physical_pieces'),
        where('doc_reception_id', '==', rec.id),
      ))
      const pieces = pSnap.docs.map(d => ({ id: d.id, ...d.data() } as PhysicalPiece))
      // Resolve hold status from booking
      let holdStatus: false | 'pending' | true = false
      if (rec.booking_id) {
        if (!bookingCache[rec.booking_id]) {
          const bSnap = await getDoc(doc(db, 'airfreight_bookings', rec.booking_id))
          bookingCache[rec.booking_id] = bSnap.exists() ? bSnap.data() : null
        }
        const bk = bookingCache[rec.booking_id]
        if (bk) {
          if (bk.booking_type === 'simple') {
            holdStatus = bk.hold || false
          } else if (bk.awb_lines) {
            const opAwb = rec.awb_2nd_leg || rec.awb_number
            const line = bk.awb_lines.find((l: any) =>
              l.awb_number === opAwb || l.awb_2nd_leg === opAwb || l.awb_number === rec.awb_number,
            )
            if (line) holdStatus = line.hold || false
          }
        }
      }
      awbList.push({
        reception: rec,
        pieces,
        assignedCount: pieces.filter(p => p.uld_id).length,
        totalPieces: pieces.length,
        forceClosed: !!(rec as any).force_closed,
        forceClosedBy: (rec as any).force_closed_by,
        forceClosedAt: (rec as any).force_closed_at,
        holdStatus,
      })
    }

    // Update awb_numbers on affected ULDs from fresh piece data
    if (affectedUldIds?.length) {
      const allFreshPieces = awbList.flatMap(a => a.pieces)
      const validIds = affectedUldIds.filter(id => id && ulds.some(u => u.id === id))
      await Promise.all(validIds.map(id => {
        const awbSet = new Set<string>()
        for (const p of allFreshPieces) {
          if (p.uld_id === id) awbSet.add(p.awb_number)
        }
        return updateDoc(doc(db, 'buildup_ulds', id), { awb_numbers: [...awbSet].sort() })
      }))
    }

    setAwbs(awbList)
  }

  // ── Force close AWB ────────────────────────────────────────────────────────

  async function handleForceClose(awb: AwbForBuildup) {
    const pending = awb.totalPieces - awb.assignedCount
    if (!confirm(`Cierre forzado de ${awb.reception.awb_2nd_leg || awb.reception.awb_number}.\n${pending} pieza(s) sin distribuir quedaran registradas como faltante.\nContinuar?`)) return
    await updateDoc(doc(db, 'airfreight_doc_receptions', awb.reception.id), {
      force_closed: true,
      force_closed_by: user?.email || '',
      force_closed_at: new Date().toISOString(),
      force_closed_pending: pending,
    })
    refreshAwbData()
  }

  // ── Mobile: assign by WR# (last 5 digits) ─────────────────────────────────

  function handleMobileWrSearch() {
    if (!mobileWrInput.trim()) return
    const suffix = mobileWrInput.trim()
    const matches = allPieces.filter(p => p.warehouse_number.endsWith(suffix))
    setMobileWrResults(matches)
  }

  async function handleMobileAssignPiece(pieceId: string, uldId: string, comment?: string) {
    const piece = allPieces.find(p => p.id === pieceId)
    if (!piece) return
    // (hold restriction removed)
    if (piece.uld_id === uldId) {
      setMobileFeedback({ type: 'error', msg: 'Ya asignada', detail: 'Esta pieza ya esta en este ULD' })
      return
    }
    const sourceUldId = piece.uld_id
    if (sourceUldId && sourceUldId !== uldId) {
      const currentUld = ulds.find(u => u.id === sourceUldId)
      if (!confirm(`Esta pieza esta en ${currentUld?.type} ${currentUld?.uld_number}. Moverla?`)) return
    }
    const update: Record<string, any> = { uld_id: uldId }
    if (comment) update.dist_comment = comment
    await updateDoc(doc(db, 'airfreight_physical_pieces', pieceId), update)
    setMobileFeedback({ type: 'success', msg: 'Pieza asignada', detail: `${piece.packing_type} | ...${piece.warehouse_number.slice(-5)} | ${fmtNum(piece.weight_kg)} kg` })
    const affected = [uldId]
    if (sourceUldId && sourceUldId !== uldId) affected.push(sourceUldId)
    refreshAwbData(affected)
    setMobileWrInput('')
    setMobileWrResults([])
  }

  async function handleMobileAssignBarcode(uldId: string) {
    if (!mobileBarcode.trim()) return
    const piece = allPieces.find(p => p.barcode === mobileBarcode.trim())
    if (!piece) {
      setMobileFeedback({ type: 'error', msg: 'No encontrado', detail: 'Barcode no existe en este vuelo' })
      setMobileBarcode('')
      return
    }
    // (hold restriction removed)
    if (piece.uld_id === uldId) {
      setMobileFeedback({ type: 'error', msg: 'Ya asignada', detail: 'Esta pieza ya esta en este ULD' })
      setMobileBarcode('')
      return
    }
    const sourceUldId = piece.uld_id
    if (sourceUldId && sourceUldId !== uldId) {
      const currentUld = ulds.find(u => u.id === sourceUldId)
      if (!confirm(`Esta pieza esta en ${currentUld?.type} ${currentUld?.uld_number}. Moverla?`)) {
        setMobileBarcode('')
        return
      }
    }
    await updateDoc(doc(db, 'airfreight_physical_pieces', piece.id), { uld_id: uldId })
    setMobileFeedback({ type: 'success', msg: 'Pieza asignada', detail: `${piece.packing_type} | ...${piece.warehouse_number.slice(-5)} | ${fmtNum(piece.weight_kg)} kg` })
    const affected = [uldId]
    if (sourceUldId && sourceUldId !== uldId) affected.push(sourceUldId)
    refreshAwbData(affected)
    setMobileBarcode('')
  }

  async function handleMobileAssignByType(uldId: string, awbNumber: string, packingType: string, weightKg: number, qty: number, comment?: string) {
    // (hold restriction removed)
    const available = allPieces
      .filter(p => !p.uld_id && p.awb_number === awbNumber && p.packing_type === packingType && Math.abs(p.weight_kg - weightKg) < 0.01)
      .sort((a, b) => a.piece_number - b.piece_number)
    const toAssign = available.slice(0, qty)
    if (toAssign.length === 0) return
    const update: Record<string, any> = { uld_id: uldId }
    if (comment) update.dist_comment = comment
    await Promise.all(toAssign.map(p =>
      updateDoc(doc(db, 'airfreight_physical_pieces', p.id), update)
    ))
    refreshAwbData([uldId])
  }

  async function handleSaveGroupComment(pieces: PhysicalPiece[], comment: string) {
    const val = comment.trim() || null
    await Promise.all(pieces.map(p =>
      updateDoc(doc(db, 'airfreight_physical_pieces', p.id), { dist_comment: val })
    ))
    refreshAwbData()
  }

  // Group pieces by type+weight for mobile "Por Pieza" tab
  const getPieceGroups = useCallback((pieces: PhysicalPiece[]) => {
    const groups = new Map<string, { type: string; weight: number; dims: string; pieces: PhysicalPiece[] }>()
    for (const p of pieces) {
      const dims = (p.length_cm && p.width_cm && p.height_cm) ? `${p.length_cm}x${p.width_cm}x${p.height_cm}` : ''
      const key = `${p.packing_type}|${p.weight_kg.toFixed(1)}|${dims}`
      if (!groups.has(key)) groups.set(key, { type: p.packing_type, weight: p.weight_kg, dims, pieces: [] })
      groups.get(key)!.pieces.push(p)
    }
    return Array.from(groups.values())
  }, [])

  // ── Flight selection screen ────────────────────────────────────────────────

  if (!selectedFlight) {
    const filteredFlights = flights.filter(f => {
      if (!flightSearch) return true
      const s = flightSearch.toLowerCase()
      return (f.flight_number || '').toLowerCase().includes(s) ||
        f.airline.toLowerCase().includes(s) ||
        (f.destinations || []).join(' ').toLowerCase().includes(s)
    })

    return (
      <Layout title="ULD Build-up" backTo="/airfreight">
        <div className="max-w-3xl mx-auto px-4 py-6">
          <h2 className="text-lg font-bold text-gray-800 mb-1">Seleccionar Vuelo</h2>
          <p className="text-sm text-gray-500 mb-6">Vuelos con AWBs que completaron recepcion fisica</p>

          <input
            type="text"
            placeholder="Buscar vuelo..."
            value={flightSearch}
            onChange={e => setFlightSearch(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-4 py-3 text-sm mb-4 focus:outline-none focus:border-blue-800"
          />

          {loadingFlights ? (
            <div className="text-center py-12 text-gray-400">Cargando vuelos...</div>
          ) : filteredFlights.length === 0 ? (
            <div className="text-center py-12 text-gray-400">No hay vuelos con recepciones fisicas completas</div>
          ) : (
            <div className="space-y-2">
              {filteredFlights.map(f => {
                const clients = flightClients[f.id] || []
                return (
                  <button
                    key={f.id}
                    onClick={() => setSelectedFlight(f)}
                    className="w-full bg-white rounded-xl border border-gray-200 p-4 text-left hover:border-blue-800 hover:shadow-md transition-all active:bg-blue-50"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <div>
                        <span className="font-bold text-gray-800">{f.flight_number || 'Sin numero'}</span>
                        <span className="text-gray-400 mx-2">|</span>
                        <span className="text-sm text-gray-600">{f.airline}</span>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-gray-400">
                          {new Date(f.flight_datetime).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })}
                        </p>
                        <p className="text-xs font-medium text-blue-800">{(f.destinations || []).join(', ')}</p>
                      </div>
                    </div>
                    {clients.length > 0 && (
                      <p className="text-xs text-gray-500">{clients.join(', ')}</p>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </Layout>
    )
  }

  // ── Build-up screen ────────────────────────────────────────────────────────

  const openUlds = ulds.filter(u => u.status === 'open')
  const closedUlds = ulds.filter(u => u.status === 'closed')

  // ── MOBILE RENDER ─────────────────────────────────────────────────────────

  if (isMobile) {
    // Mobile: Pantalla 2 — ULD detail with 3 tabs
    if (mobileUld) {
      const mu = ulds.find(u => u.id === mobileUld.id) || mobileUld
      const muPieces = getUldPieces(mu.id)
      const muWeight = getUldWeight(mu.id)
      const muAwbs = getUldAwbs(mu.id)
      const confCls = CONF_COLORS[mu.conf] || 'bg-gray-100 text-gray-700'

      // Edit ULD mode
      if (editingUldId === mu.id) {
        return (
          <div className="min-h-screen bg-white flex flex-col">
            <div className="bg-[#1e3a5f] text-white px-4 py-3 flex items-center gap-3">
              <button onClick={() => setEditingUldId(null)} className="p-1 -ml-1 opacity-60">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7"/></svg>
              </button>
              <p className="text-sm font-bold">Editar ULD</p>
            </div>
            <div className="flex-1 px-4 py-6 space-y-6">
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase mb-2">Configuracion</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['MD', 'LD', 'ESP'] as const).map(c => (
                    <button key={c} onClick={() => { setEditUldConf(c); setEditUldType('') }}
                      className={`py-4 rounded-xl border-2 font-bold text-sm text-center ${editUldConf === c
                        ? c === 'MD' ? 'border-purple-400 bg-purple-50 text-purple-700' : c === 'LD' ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-amber-400 bg-amber-50 text-amber-700'
                        : 'border-gray-200 text-gray-400'}`}
                    >{c === 'MD' ? 'Main Deck' : c === 'LD' ? 'Lower Deck' : 'Especial'}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase mb-2">Tipo</label>
                <div className="grid grid-cols-3 gap-2">
                  {uldTypes.filter(t => t.conf === editUldConf).map(t => (
                    <button key={t.id} onClick={() => setEditUldType(t.type)}
                      className={`py-3 rounded-xl border-2 font-bold text-sm text-center ${editUldType === t.type ? 'border-[#1e3a5f] bg-blue-50 text-[#1e3a5f]' : 'border-gray-200 text-gray-400'}`}
                    >{t.type}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase mb-2">Numero de ULD</label>
                <input type="text" value={editUldNumber} onChange={e => setEditUldNumber(e.target.value)}
                  className="w-full border-2 border-gray-200 rounded-xl px-4 py-3.5 text-xl font-mono font-bold text-center tracking-wider focus:outline-none focus:border-[#1e3a5f]" />
                {editUldType && editUldNumber.trim() && (
                  <p className="text-center text-sm font-mono font-bold text-[#1e3a5f] mt-2">{editUldType} {editUldNumber.trim().toUpperCase()}</p>
                )}
              </div>
            </div>
            <div className="border-t border-gray-200 px-4 py-3 flex gap-2">
              <button onClick={() => handleSaveUld(mu.id)} disabled={!editUldType || !editUldNumber.trim()}
                className="flex-1 py-3.5 bg-[#1e3a5f] text-white text-sm font-bold rounded-xl disabled:opacity-50">Guardar</button>
              <button onClick={() => setEditingUldId(null)}
                className="px-6 py-3.5 border border-gray-200 text-gray-600 text-sm rounded-xl">Cancelar</button>
            </div>
          </div>
        )
      }

      return (
        <div className="min-h-screen bg-gray-100 flex flex-col">
          {/* Header */}
          <div className="bg-[#1e3a5f] text-white px-4 py-3 sticky top-0 z-20">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button onClick={() => setMobileUld(null)} className="p-1 -ml-1 opacity-60">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7"/></svg>
                </button>
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${confCls}`}>{mu.conf}</span>
                    <span className="text-sm font-bold font-mono">{mu.type} {mu.uld_number}</span>
                  </div>
                  <p className="text-[10px] opacity-60">{mu.destination} | {selectedFlight?.flight_number}</p>
                </div>
              </div>
              <button onClick={() => { startEditUld(mu) }} className="text-[10px] opacity-60 border border-white/30 rounded px-2 py-1">Editar</button>
            </div>
            {/* ULD totals big */}
            <p className="text-lg font-bold mt-2">{muPieces.length} pcs | {fmtNum(muWeight)} kg</p>
          </div>

          {/* Tabs */}
          <div className="bg-white flex border-b border-gray-200 sticky top-[88px] z-10">
            {(['pieza', 'barcode', 'wr'] as const).map(t => (
              <button key={t} onClick={() => { setMobileTab(t); setMobileFeedback(null) }}
                className={`flex-1 py-3 text-xs text-center border-b-2 ${mobileTab === t ? 'border-[#1e3a5f] text-[#1e3a5f] font-bold' : 'border-transparent text-gray-400'}`}
              >{t === 'pieza' ? 'Por Pieza' : t === 'barcode' ? 'Por Barcode' : 'Por WR#'}</button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto pb-28">

            {/* ── Tab: Por Pieza ── */}
            {mobileTab === 'pieza' && (<>
              {/* Column headers */}
              <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-200">
                <span className="text-xs font-bold text-gray-400 uppercase">AWB</span>
                <div className="flex items-center gap-6">
                  <span className="w-14 text-center text-xs font-bold text-gray-400 uppercase">In ULD</span>
                  <span className="w-16 text-center text-xs font-bold text-gray-400 uppercase">Total</span>
                </div>
              </div>
              {awbs.map(a => {
              const awbLabel = a.reception.awb_2nd_leg || a.reception.awb_number
              const availablePieces = a.pieces.filter(p => !p.uld_id)
              const inThisUld = a.pieces.filter(p => p.uld_id === mu.id)
              const availableGroups = getPieceGroups(availablePieces)
              const inThisGroups = getPieceGroups(inThisUld)
              const clientShort = a.reception.client_name?.length > 12 ? a.reception.client_name.slice(0, 12) + '.' : a.reception.client_name

              return (
                <details key={a.reception.id} className="border-b border-gray-200 bg-white">
                  <summary className="px-4 py-3 flex items-center justify-between cursor-pointer list-none">
                    <div className="flex items-center gap-2 min-w-0">
                      <svg className="w-4 h-4 text-gray-400 flex-shrink-0 transition-transform [details[open]>&]:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7"/></svg>
                      <div className="min-w-0">
                        <span className="font-mono font-bold text-base text-[#1e3a5f]">{awbLabel}</span>
                        <span className="text-xs text-gray-400 ml-1">{clientShort}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-6 flex-shrink-0">
                      <span className={`w-14 text-center text-base font-bold ${inThisUld.length > 0 ? 'text-[#1e3a5f]' : 'text-gray-300'}`}>{inThisUld.length}</span>
                      <span className={`w-16 text-center text-sm ${a.assignedCount >= a.totalPieces ? 'text-green-600 font-medium' : 'text-gray-500'}`}>{a.assignedCount}/{a.totalPieces}</span>
                    </div>
                  </summary>
                  <div className="px-4 pb-4">
                    {/* Available pieces grouped by type+weight */}
                    {availableGroups.length > 0 && (
                      <>
                        <p className="text-xs font-bold text-gray-400 uppercase mb-2 mt-1">Available ({availablePieces.length})</p>
                        {availableGroups.map((g, gi) => {
                          const isMultiple = g.pieces.length > 1
                          return (
                            <div key={gi} className="bg-gray-50 border border-gray-200 rounded-xl p-4 mb-3">
                              <div className="flex items-center gap-3 mb-3">
                                <div className="w-14 h-14 bg-white border-2 border-gray-300 rounded-xl flex flex-col items-center justify-center">
                                  <span className="text-xs font-bold text-gray-600">{g.type}</span>
                                  <span className="text-base font-black text-[#1e3a5f]">{g.pieces.length}</span>
                                </div>
                                <div>
                                  {isMultiple ? (
                                    <p className="text-base font-bold text-gray-800">{g.pieces.length} {g.type} available</p>
                                  ) : (
                                    <p className="text-base font-mono font-bold text-gray-800">{g.pieces[0].warehouse_number.slice(-5)}</p>
                                  )}
                                  <p className="text-sm text-gray-500">{fmtNum(g.weight)} kg{isMultiple ? ' ea' : ''}{g.dims ? ` | ${g.dims}` : ''}</p>
                                </div>
                              </div>
                              {isMultiple ? (
                                <MobileQtyAssign key={gi} max={g.pieces.length}
                                  onAssign={(qty, comment) => handleMobileAssignByType(mu.id, a.reception.awb_number, g.type, g.weight, qty, comment)} />
                              ) : (
                                <div className="flex items-center gap-3">
                                  <input type="text" readOnly value="1"
                                    className="w-20 h-12 border-2 border-gray-300 rounded-xl text-center font-mono font-bold text-lg bg-white" />
                                  <button onClick={() => handleMobileAssignPiece(g.pieces[0].id, mu.id)}
                                    className="flex-1 h-12 rounded-xl bg-[#1e3a5f] text-white text-base font-bold active:bg-blue-900 shadow">
                                    Assign 1
                                  </button>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </>
                    )}

                    {/* Pieces in this ULD — tap group to expand comment + reduce */}
                    {inThisUld.length > 0 && (
                      <>
                        <p className="text-xs font-bold text-green-700 uppercase mt-3 mb-2">In this ULD ({inThisUld.length})</p>
                        <div className="bg-green-50 border border-green-200 rounded-xl overflow-hidden">
                          {inThisGroups.map((g, gi) => {
                            const groupKey = `${mu.id}|${a.reception.awb_number}|${g.type}|${g.weight}`
                            const isGroupExpanded = expandedUldAwb === groupKey
                            const groupComment = g.pieces[0]?.dist_comment || ''
                            const hasComment = g.pieces.some(p => p.dist_comment)
                            return (
                              <div key={gi} className={isGroupExpanded ? 'bg-green-100/60' : ''}>
                                <button onClick={() => {
                                  if (isGroupExpanded) { setExpandedUldAwb(null) }
                                  else { setExpandedUldAwb(groupKey); setEditAwbQty(g.pieces.length); setEditGroupComment(groupComment) }
                                }} className={`w-full flex items-center justify-between px-4 py-3 ${gi > 0 ? 'border-t border-green-100' : ''}`}>
                                  <div className="flex items-center gap-3">
                                    <span className="bg-green-100 text-green-800 text-xs font-bold px-2 py-1 rounded-lg">{g.type}</span>
                                    <span className="text-base font-bold text-gray-800">{g.pieces.length}</span>
                                    <span className="text-sm text-gray-500">| {fmtNum(g.weight)} kg ea</span>
                                    {hasComment && !isGroupExpanded && (
                                      <span className="text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full truncate max-w-[120px]">{groupComment}</span>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <svg className={`w-5 h-5 text-gray-300 transition-transform ${isGroupExpanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                    </svg>
                                  </div>
                                </button>
                                {isGroupExpanded && (
                                  <div className="px-4 pb-3 space-y-2">
                                    <div className="flex items-center gap-2">
                                      <input type="text" value={editGroupComment} onChange={e => setEditGroupComment(e.target.value)}
                                        placeholder="Add comment..."
                                        className="flex-1 border border-green-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-blue-500" />
                                      <button onClick={() => { handleSaveGroupComment(g.pieces, editGroupComment); setExpandedUldAwb(null) }}
                                        className="px-3 py-1.5 bg-blue-600 text-white text-xs font-bold rounded-lg active:bg-blue-700">
                                        {editGroupComment !== groupComment ? 'Save' : 'OK'}
                                      </button>
                                    </div>
                                    <MobileQtyReduce current={g.pieces.length}
                                      onReduce={(newQty) => {
                                        handleReduceAwbQtyByType(mu.id, a.reception.awb_number, g.type, g.weight, newQty)
                                        setExpandedUldAwb(null)
                                      }} />
                                  </div>
                                )}
                              </div>
                            )
                          })}
                          <div className="px-4 py-2 bg-green-100/50 border-t border-green-200">
                            <span className="text-sm font-bold text-green-700">{inThisUld.length} pcs | {fmtNum(inThisUld.reduce((s, p) => s + p.weight_kg, 0))} kg</span>
                          </div>
                        </div>
                      </>
                    )}

                    {a.forceClosed && (
                      <p className="text-xs text-amber-600 font-medium mt-2">Cierre forzado</p>
                    )}
                  </div>
                </details>
              )
            })}</>)}

            {/* ── Tab: Por Barcode ── */}
            {mobileTab === 'barcode' && (
              <div>
                <div className="bg-white px-4 py-4 border-b border-gray-200">
                  <label className="block text-xs font-semibold text-gray-500 mb-2">Escanear o digitar barcode</label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setContinuousScanUld({ id: mu.id, number: mu.uld_number })}
                      className="px-3 py-3 bg-green-600 text-white rounded-xl active:bg-green-700 shadow shrink-0"
                      title="Escaneo continuo con camara"
                    >
                      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                    </button>
                    <input type="text" value={mobileBarcode} onChange={e => setMobileBarcode(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleMobileAssignBarcode(mu.id)}
                      placeholder="Escanear barcode..." autoFocus
                      className="flex-1 border-2 border-gray-200 rounded-xl px-4 py-3 text-lg font-mono focus:outline-none focus:border-[#1e3a5f]" />
                    <button onClick={() => handleMobileAssignBarcode(mu.id)}
                      className="px-4 py-3 bg-[#1e3a5f] text-white font-bold rounded-xl active:bg-blue-900 shadow text-sm">OK</button>
                  </div>
                </div>

                {/* Feedback */}
                {mobileFeedback && (
                  <div className={`mx-4 mt-3 rounded-xl p-3 flex items-center gap-3 border ${
                    mobileFeedback.type === 'success' ? 'bg-green-50 border-green-200' :
                    mobileFeedback.type === 'warning' ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200'}`}>
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${
                      mobileFeedback.type === 'success' ? 'bg-green-100' : mobileFeedback.type === 'warning' ? 'bg-amber-100' : 'bg-red-100'}`}>
                      {mobileFeedback.type === 'success' ? (
                        <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/></svg>
                      ) : (
                        <svg className="w-6 h-6 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
                      )}
                    </div>
                    <div>
                      <p className={`text-sm font-bold ${mobileFeedback.type === 'success' ? 'text-green-800' : mobileFeedback.type === 'warning' ? 'text-amber-800' : 'text-red-800'}`}>{mobileFeedback.msg}</p>
                      <p className={`text-[11px] ${mobileFeedback.type === 'success' ? 'text-green-600' : mobileFeedback.type === 'warning' ? 'text-amber-600' : 'text-red-600'}`}>{mobileFeedback.detail}</p>
                    </div>
                  </div>
                )}

                {/* Pieces in this ULD */}
                <div className="px-4 mt-4">
                  <p className="text-[10px] font-bold text-gray-400 uppercase mb-2">Piezas en este ULD ({muPieces.length})</p>
                  {muPieces.length > 0 && (
                    <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
                      {muPieces.sort((a, b) => b.piece_number - a.piece_number).slice(0, 20).map(p => (
                        <div key={p.id} className="flex items-center justify-between px-3 py-2">
                          <div className="text-xs">
                            <span className="font-bold text-gray-700 font-mono">{p.warehouse_number.slice(-5)}</span>
                            <span className="text-gray-400 ml-1">{p.packing_type} | {fmtNum(p.weight_kg)} kg</span>
                          </div>
                          <button onClick={() => handleUnassignPiece(p.id)} className="text-[10px] text-red-400 font-medium active:text-red-600">Quitar</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Tab: Por WR# ── */}
            {mobileTab === 'wr' && (
              <div>
                <div className="bg-white px-4 py-4 border-b border-gray-200">
                  <label className="block text-xs font-semibold text-gray-500 mb-1">Ultimos 5 digitos del Warehouse No.</label>
                  <p className="text-[10px] text-gray-400 mb-2">Lee el numero en la etiqueta de la pieza</p>
                  <div className="flex gap-2">
                    <input type="text" maxLength={5} value={mobileWrInput}
                      onChange={e => setMobileWrInput(e.target.value.replace(/\D/g, ''))}
                      onKeyDown={e => e.key === 'Enter' && handleMobileWrSearch()}
                      placeholder="00142"
                      className="flex-1 border-2 border-gray-200 rounded-xl px-4 py-3 text-2xl font-mono font-bold text-center tracking-[0.3em] focus:outline-none focus:border-[#1e3a5f]" />
                    <button onClick={handleMobileWrSearch}
                      className="px-5 py-3 bg-[#1e3a5f] text-white font-bold rounded-xl active:bg-blue-900 shadow text-sm">OK</button>
                  </div>
                </div>

                {/* Feedback */}
                {mobileFeedback && (
                  <div className={`mx-4 mt-3 rounded-xl p-3 flex items-center gap-3 border ${
                    mobileFeedback.type === 'success' ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${
                      mobileFeedback.type === 'success' ? 'bg-green-100' : 'bg-red-100'}`}>
                      <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/></svg>
                    </div>
                    <div>
                      <p className={`text-sm font-bold ${mobileFeedback.type === 'success' ? 'text-green-800' : 'text-red-800'}`}>{mobileFeedback.msg}</p>
                      <p className={`text-[11px] ${mobileFeedback.type === 'success' ? 'text-green-600' : 'text-red-600'}`}>{mobileFeedback.detail}</p>
                    </div>
                  </div>
                )}

                {/* Search results */}
                {mobileWrResults.length === 0 && mobileWrInput.length === 5 && (
                  <div className="mx-4 mt-3 bg-red-50 border border-red-200 rounded-xl p-3 flex items-center gap-3">
                    <svg className="w-5 h-5 text-red-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
                    <p className="text-sm text-red-700">Sin resultados para "{mobileWrInput}"</p>
                  </div>
                )}
                {mobileWrResults.length === 1 && (
                  <div className="mx-4 mt-3 bg-white rounded-xl border border-gray-200 overflow-hidden">
                    <div className="px-4 py-3 bg-blue-50 border-b border-blue-100">
                      <p className="text-xs font-bold text-[#1e3a5f]">Pieza encontrada</p>
                    </div>
                    {mobileWrResults.map(p => {
                      const awb = awbs.find(a => a.reception.awb_number === p.awb_number)
                      return (
                        <div key={p.id} className="px-4 py-3">
                          <div className="flex items-center justify-between mb-3">
                            <div>
                              <p className="font-mono font-bold text-lg text-gray-800">{p.warehouse_number}</p>
                              <p className="text-xs text-gray-500">{p.awb_number} | {awb?.reception.client_name}</p>
                            </div>
                            <div className="w-14 h-14 bg-gray-50 border border-gray-200 rounded-lg flex flex-col items-center justify-center">
                              <span className="text-[10px] font-bold text-gray-700">{p.packing_type}</span>
                              <span className="text-[9px] text-gray-500">#{String(p.piece_number).padStart(2, '0')}</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-4 text-xs text-gray-500 mb-3">
                            <span>Peso: <b className="text-gray-800">{fmtNum(p.weight_kg)} kg</b></span>
                            {p.length_cm && <span>Dim: <b className="text-gray-800">{p.length_cm}x{p.width_cm}x{p.height_cm}</b></span>}
                          </div>
                          {p.uld_id === mu.id ? (
                            <p className="text-sm text-green-600 font-medium text-center py-2">Ya esta en este ULD</p>
                          ) : (
                            <button onClick={() => handleMobileAssignPiece(p.id, mu.id)}
                              className="w-full py-3 bg-[#1e3a5f] text-white text-sm font-bold rounded-xl active:bg-blue-900 shadow">
                              Asignar a {mu.type} {mu.uld_number}
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
                {mobileWrResults.length > 1 && (
                  <div className="mx-4 mt-3 bg-white rounded-xl border border-amber-200 overflow-hidden">
                    <div className="px-4 py-3 bg-amber-50 border-b border-amber-100">
                      <p className="text-xs font-bold text-amber-700">{mobileWrResults.length} coincidencias</p>
                    </div>
                    <div className="divide-y divide-gray-100">
                      {mobileWrResults.map(p => {
                        const awb = awbs.find(a => a.reception.awb_number === p.awb_number)
                        return (
                          <button key={p.id} onClick={() => handleMobileAssignPiece(p.id, mu.id)}
                            className="w-full px-4 py-3 text-left active:bg-blue-50 flex items-center justify-between">
                            <div>
                              <p className="font-mono font-bold text-sm text-gray-800">{p.warehouse_number}</p>
                              <p className="text-[11px] text-gray-500">{p.awb_number} | {p.packing_type} | {fmtNum(p.weight_kg)} kg | {awb?.reception.client_name}</p>
                            </div>
                            <span className="text-xs text-[#1e3a5f] font-bold">Asignar</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Fixed bottom */}
          <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 px-4 py-3 z-20">
            <button onClick={() => { toggleUldStatus(mu); setMobileUld(null) }}
              className="w-full py-3 bg-green-600 text-white text-sm font-bold rounded-xl active:bg-green-700">
              {mu.status === 'open' ? 'Cerrar ULD' : 'Re-abrir ULD'}
            </button>
          </div>

          {/* ── Continuous Barcode Scanner (mobile) ── */}
          <BarcodeContinuousScanner
            open={!!continuousScanUld}
            onClose={() => setContinuousScanUld(null)}
            allPieces={allPieces}
            targetUldId={continuousScanUld?.id || ''}
            targetUldNumber={continuousScanUld?.number || ''}
            onPieceAssigned={handleContinuousScanAssign}
            uldLookup={uldLookup}
          />
        </div>
      )
    }

    // Mobile: Create ULD fullscreen
    if (showCreateUld) {
      return (
        <div className="min-h-screen bg-white flex flex-col">
          <div className="bg-[#1e3a5f] text-white px-4 py-3 flex items-center gap-3">
            <button onClick={() => setShowCreateUld(false)} className="p-1 -ml-1 opacity-60">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7"/></svg>
            </button>
            <div>
              <p className="text-sm font-bold">Nuevo ULD</p>
              <p className="text-[10px] opacity-60">{selectedFlight?.flight_number} | {selectedFlight?.airline}</p>
            </div>
          </div>
          <div className="flex-1 px-4 py-6 space-y-6">
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase mb-2">Configuracion</label>
              <div className="grid grid-cols-3 gap-2">
                {(['MD', 'LD', 'ESP'] as const).map(c => (
                  <button key={c} onClick={() => { setNewUldConf(c); setNewUldTypeId('') }}
                    className={`py-4 rounded-xl border-2 font-bold text-sm text-center ${newUldConf === c
                      ? c === 'MD' ? 'border-purple-400 bg-purple-50 text-purple-700' : c === 'LD' ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-amber-400 bg-amber-50 text-amber-700'
                      : 'border-gray-200 text-gray-400'}`}
                  >{c === 'MD' ? 'Main Deck' : c === 'LD' ? 'Lower Deck' : 'Especial'}</button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase mb-2">Tipo</label>
              <div className="grid grid-cols-3 gap-2">
                {uldTypes.filter(t => t.conf === newUldConf).map(t => (
                  <button key={t.id} onClick={() => setNewUldTypeId(t.id)}
                    className={`py-3 rounded-xl border-2 font-bold text-sm text-center ${newUldTypeId === t.id ? 'border-[#1e3a5f] bg-blue-50 text-[#1e3a5f]' : 'border-gray-200 text-gray-400'}`}
                  >{t.type}</button>
                ))}
                {uldTypes.filter(t => t.conf === newUldConf).length === 0 && (
                  <p className="text-xs text-gray-400 col-span-3 py-2">Sin tipos para {newUldConf}. Admin &gt; ULD Types.</p>
                )}
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase mb-2">Numero de ULD</label>
              <input type="text" value={newUldNumber} onChange={e => setNewUldNumber(e.target.value)}
                placeholder="Ej: 1234LA"
                className="w-full border-2 border-gray-200 rounded-xl px-4 py-3.5 text-xl font-mono font-bold text-center tracking-wider focus:outline-none focus:border-[#1e3a5f]" />
              {newUldTypeId && newUldNumber.trim() && (
                <p className="text-center text-sm font-mono font-bold text-[#1e3a5f] mt-2">
                  {uldTypes.find(t => t.id === newUldTypeId)?.type} {newUldNumber.trim().toUpperCase()}
                </p>
              )}
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase mb-2">Destino</label>
              <div className="flex flex-wrap gap-2">
                {(selectedFlight?.destinations || []).map(d => (
                  <button key={d} onClick={() => setNewUldDest(d)}
                    className={`px-4 py-3 rounded-xl border-2 font-bold text-sm ${newUldDest === d ? 'border-[#1e3a5f] bg-blue-50 text-[#1e3a5f]' : 'border-gray-200 text-gray-400'}`}
                  >{d}</button>
                ))}
              </div>
            </div>
          </div>
          <div className="border-t border-gray-200 px-4 py-3">
            <button onClick={handleCreateUld} disabled={creatingSaving || !newUldNumber.trim() || !newUldTypeId}
              className="w-full py-3.5 bg-green-600 text-white text-sm font-bold rounded-xl active:bg-green-700 disabled:opacity-50 shadow-lg">
              {creatingSaving ? 'Creando...' : 'Crear ULD'}
            </button>
          </div>
        </div>
      )
    }

    // Mobile: Pantalla 1 — ULD list
    return (
      <div className="min-h-screen bg-gray-100 flex flex-col">
        {/* Header */}
        <div className="bg-[#1e3a5f] text-white px-4 py-3 sticky top-0 z-20">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              <button onClick={() => setSelectedFlight(null)} className="p-1 -ml-1 opacity-60">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7"/></svg>
              </button>
              <div>
                <p className="text-sm font-bold">{selectedFlight.flight_number} <span className="font-normal opacity-60">| {selectedFlight.airline}</span></p>
              </div>
            </div>
            <span className="text-xs opacity-60">{new Date(selectedFlight.flight_datetime).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })}</span>
          </div>
          <div className="flex items-center gap-4 text-[11px] mt-1">
            <span className="opacity-70">AWBs: <b className="text-white">{awbs.length}</b></span>
            <span className="opacity-70">Piezas: <b className="text-white">{allPieces.length - unassignedPieces.length} / {allPieces.length}</b></span>
            <span className="opacity-70">Peso: <b className="text-white">{fmtNum(assignedWeight)} / {fmtNum(totalWeight)} kg</b></span>
          </div>
          <div className="h-1 bg-white/20 rounded-full mt-2 overflow-hidden">
            <div className="h-full bg-[#c9a84c] rounded-full" style={{ width: `${allPieces.length > 0 ? Math.round(((allPieces.length - unassignedPieces.length) / allPieces.length) * 100) : 0}%` }} />
          </div>
        </div>

        {/* View toggle: ULDs vs AWB→ULDs */}
        <div className="bg-white border-b border-gray-200 px-4 py-2 flex items-center gap-2">
          <button onClick={() => setMobileAwbView(false)}
            className={`flex-1 py-2 text-xs font-bold rounded-lg text-center ${!mobileAwbView ? 'bg-[#1e3a5f] text-white' : 'text-gray-400'}`}>
            ULDs
          </button>
          <button onClick={() => setMobileAwbView(true)}
            className={`flex-1 py-2 text-xs font-bold rounded-lg text-center ${mobileAwbView ? 'bg-[#1e3a5f] text-white' : 'text-gray-400'}`}>
            AWB → ULDs
          </button>
        </div>

        {/* ULD list / AWB→ULDs view */}
        <div className="flex-1 overflow-y-auto px-4 pt-3 pb-24 space-y-3">
          {loadingData ? (
            <div className="text-center py-12 text-gray-400">Cargando...</div>
          ) : mobileAwbView ? (
            /* AWB → ULDs reverse view */
            <>
              {awbs.map(a => {
                const awbLabel = a.reception.awb_2nd_leg || a.reception.awb_number
                const pct = a.totalPieces > 0 ? Math.round((a.assignedCount / a.totalPieces) * 100) : 0
                // Group assigned pieces by ULD
                const byUld: Record<string, { uld: BuildupUld; count: number; weight: number }> = {}
                a.pieces.filter(p => p.uld_id).forEach(p => {
                  if (!byUld[p.uld_id!]) {
                    const u = ulds.find(u => u.id === p.uld_id)
                    if (u) byUld[p.uld_id!] = { uld: u, count: 0, weight: 0 }
                  }
                  if (byUld[p.uld_id!]) {
                    byUld[p.uld_id!].count++
                    byUld[p.uld_id!].weight += p.weight_kg
                  }
                })
                const uldEntries = Object.values(byUld)
                return (
                  <div key={a.reception.id} className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
                    <div className="flex items-center justify-between mb-1">
                      <div>
                        <span className="font-mono font-bold text-sm text-[#1e3a5f]">{awbLabel}</span>
                        <span className="text-[10px] text-gray-400 ml-1.5">{a.reception.client_name}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${a.assignedCount >= a.totalPieces ? 'bg-green-500' : 'bg-blue-500'}`} style={{ width: `${pct}%` }} />
                        </div>
                        <span className={`text-xs ${a.assignedCount >= a.totalPieces ? 'text-green-600 font-medium' : 'text-gray-500'}`}>
                          {a.assignedCount}/{a.totalPieces}
                        </span>
                      </div>
                    </div>
                    {uldEntries.length > 0 ? (
                      <div className="mt-2 space-y-1">
                        {uldEntries.map(e => {
                          const cls = CONF_COLORS[e.uld.conf] || 'bg-gray-100 text-gray-700'
                          return (
                            <div key={e.uld.id} className="flex items-center justify-between text-[11px] text-gray-500">
                              <div className="flex items-center gap-1.5">
                                <span className={`text-[9px] font-bold px-1 py-0.5 rounded ${cls}`}>{e.uld.conf}</span>
                                <span className="font-mono font-bold text-gray-700">{e.uld.type} {e.uld.uld_number}</span>
                                <span className="text-gray-400">{e.uld.destination}</span>
                              </div>
                              <span>{e.count} pcs | {fmtNum(e.weight)} kg</span>
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <p className="text-[10px] text-gray-400 mt-1">Sin piezas asignadas</p>
                    )}
                  </div>
                )
              })}
            </>
          ) : (
            <>
              {openUlds.length > 0 && (
                <>
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Abiertos ({openUlds.length})</p>
                  {openUlds.map(u => {
                    const pieces = getUldPieces(u.id)
                    const weight = getUldWeight(u.id)
                    const ua = getUldAwbs(u.id)
                    const cls = CONF_COLORS[u.conf] || 'bg-gray-100 text-gray-700'
                    return (
                      <button key={u.id} onClick={() => { setMobileUld(u); setMobileTab('pieza'); setMobileFeedback(null) }}
                        className="w-full bg-white rounded-xl border border-gray-200 p-4 text-left active:bg-blue-50 transition-colors shadow-sm">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${cls}`}>{u.conf}</span>
                            <span className="font-mono font-bold text-base text-gray-800">{u.type} {u.uld_number}</span>
                          </div>
                          <span className="text-xs text-gray-400">{u.destination}</span>
                        </div>
                        <div className="flex items-center justify-between text-[11px] text-gray-500">
                          <span>{ua.length} AWBs | {pieces.length} piezas</span>
                          <span className="font-bold text-gray-600">{fmtNum(weight)} kg</span>
                        </div>
                        {ua.length > 0 && (
                          <div className="mt-2 space-y-0.5">
                            {ua.map(a => (
                              <div key={a.awb} className="flex justify-between text-[10px] text-gray-400">
                                <span className="font-mono">{a.awb}</span>
                                <span>{a.count} pcs | {fmtNum(a.weight)} kg</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </button>
                    )
                  })}
                </>
              )}

              {closedUlds.length > 0 && (
                <>
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mt-4">Cerrados ({closedUlds.length})</p>
                  {closedUlds.map(u => {
                    const pieces = getUldPieces(u.id)
                    const weight = getUldWeight(u.id)
                    const cls = CONF_COLORS[u.conf] || 'bg-gray-100 text-gray-700'
                    return (
                      <div key={u.id} onClick={() => { setMobileUld(u); setMobileTab('pieza'); setMobileFeedback(null) }}
                        className="w-full bg-gray-50 rounded-xl border border-gray-200 p-4 opacity-70">
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2">
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${cls}`}>{u.conf}</span>
                            <span className="font-mono font-bold text-sm text-gray-800">{u.type} {u.uld_number}</span>
                            <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-medium">Cerrado</span>
                          </div>
                        </div>
                        <p className="text-[10px] text-gray-400">{u.destination} | {pieces.length} pcs | {fmtNum(weight)} kg</p>
                      </div>
                    )
                  })}
                </>
              )}

              {ulds.length === 0 && !loadingData && (
                <div className="text-center py-12 text-gray-400 text-sm">
                  <p>No hay ULDs creados</p>
                </div>
              )}
            </>
          )}
        </div>

        {/* Fixed bottom */}
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 px-4 py-3 z-20">
          {isBuilt ? (
            <button onClick={handleReopenDistribution}
              className="w-full py-3.5 bg-amber-500 text-white text-sm font-bold rounded-xl active:bg-amber-600 shadow-lg flex items-center justify-center gap-1.5">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
              Re-open Distribution
            </button>
          ) : (
            <div className="flex gap-2">
              {ulds.length > 0 && (
                <button onClick={() => setShowCloseDistDialog(true)}
                  className="flex-1 py-3.5 bg-green-600 text-white text-sm font-bold rounded-xl active:bg-green-700 shadow-lg flex items-center justify-center gap-1.5">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                  Close Dist.
                </button>
              )}
              <button onClick={() => { setShowCreateUld(true); setNewUldDest(selectedFlight.destinations?.[0] || '') }}
                className={`${ulds.length > 0 ? 'flex-1' : 'w-full'} py-3.5 bg-[#1e3a5f] text-white text-sm font-bold rounded-xl active:bg-blue-900 shadow-lg`}>
                + Crear ULD
              </button>
            </div>
          )}
        </div>

      {/* ── Close Distribution Dialog (mobile) ── */}
      {showCloseDistDialog && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={() => !closingDist && setShowCloseDistDialog(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6">
              <div className="flex items-start gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                  <svg className="w-6 h-6 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"/></svg>
                </div>
                <div>
                  <h3 className="font-bold text-gray-800 mb-1">Close Distribution</h3>
                  <p className="text-sm text-gray-600">
                    {incompleteAwbs.length === 0 && zeroAwbs.length === 0
                      ? 'All AWBs are fully distributed. Confirm to close.'
                      : 'Review before closing:'}
                  </p>
                </div>
              </div>

              {incompleteAwbs.length > 0 && (
                <div className="bg-amber-50 rounded-lg p-3 mb-3">
                  <p className="text-[10px] font-bold text-amber-600 uppercase mb-1">Incomplete</p>
                  {incompleteAwbs.map(a => (
                    <div key={a.reception.id} className="flex items-center justify-between text-sm">
                      <span className="font-mono font-bold text-gray-700">{a.reception.awb_2nd_leg || a.reception.awb_number}</span>
                      <span className="text-amber-700 font-medium">{a.assignedCount}/{a.totalPieces} pcs</span>
                    </div>
                  ))}
                </div>
              )}

              {zeroAwbs.length > 0 && (
                <div className="bg-red-50 rounded-lg p-3 mb-3">
                  <p className="text-[10px] font-bold text-red-600 uppercase mb-1">Not distributed (0 pieces)</p>
                  {zeroAwbs.map(a => (
                    <div key={a.reception.id} className="flex items-center justify-between text-sm">
                      <span className="font-mono font-bold text-gray-700">{a.reception.awb_2nd_leg || a.reception.awb_number}</span>
                      <span className="text-red-600 font-medium">0/{a.totalPieces} pcs</span>
                    </div>
                  ))}
                </div>
              )}

              {(incompleteAwbs.length > 0 || zeroAwbs.length > 0) && (
                <p className="text-sm text-gray-500 mb-4">Incomplete AWBs will stay. Undistributed AWBs will remain on the flight but with 0 pieces assigned.</p>
              )}

              <div className="flex gap-2">
                <button
                  onClick={handleCloseDistribution}
                  disabled={closingDist}
                  className="flex-1 py-2.5 bg-green-600 text-white text-sm font-bold rounded-lg active:bg-green-700 disabled:opacity-50"
                >
                  {closingDist ? 'Closing...' : 'Confirm & Close'}
                </button>
                <button
                  onClick={() => setShowCloseDistDialog(false)}
                  disabled={closingDist}
                  className="flex-1 py-2.5 border border-gray-200 text-gray-600 text-sm rounded-lg active:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </>
      )}
      </div>
    )
  }

  // ── DESKTOP RENDER ────────────────────────────────────────────────────────

  return (
    <Layout title="ULD Build-up" onBack={() => setSelectedFlight(null)}>
      <div className="max-w-7xl mx-auto px-4 py-4">

        {/* Flight context bar */}
        <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4 flex flex-wrap items-center gap-6">
          <div>
            <p className="text-xs text-gray-400">Vuelo</p>
            <p className="font-bold text-gray-800">{selectedFlight.flight_number || '-'}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400">Aerolinea</p>
            <p className="text-sm text-gray-700">{selectedFlight.airline}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400">Fecha</p>
            <p className="text-sm text-gray-700">
              {new Date(selectedFlight.flight_datetime).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-400">Destinos</p>
            <p className="text-sm text-gray-700">{(selectedFlight.destinations || []).join(', ')}</p>
          </div>
          <div className="border-l border-gray-200 pl-6">
            <p className="text-xs text-gray-400">AWBs</p>
            <p className="text-sm font-bold text-blue-800">{awbs.length}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400">Piezas</p>
            <p className="text-sm font-bold text-blue-800">{allPieces.length - unassignedPieces.length} / {allPieces.length}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400">Peso asignado</p>
            <p className="text-sm font-bold text-blue-800">{fmtNum(assignedWeight)} / {fmtNum(totalWeight)} kg</p>
          </div>
          <div className="ml-auto flex gap-2 items-center">
            {/* PDF buttons (icon-only) — visible when ULDs exist */}
            {ulds.length > 0 && (
              <>
                <button onClick={handleDownloadDistPdf} className="w-8 h-8 rounded-lg border border-gray-200 text-gray-500 hover:text-blue-700 hover:border-blue-300 flex items-center justify-center" title="Distribution PDF">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                </button>
                <button onClick={handleDownloadPalletPdf} className="w-8 h-8 rounded-lg border border-gray-200 text-gray-500 hover:text-blue-700 hover:border-blue-300 flex items-center justify-center" title="Pallet Control PDF">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/></svg>
                </button>
                {closedUlds.length > 0 && (
                  <>
                    <button onClick={handleDownloadAllTagDocs} className="w-8 h-8 rounded-lg border border-gray-200 text-gray-500 hover:text-blue-700 hover:border-blue-300 flex items-center justify-center" title="Download All Pallet Tag Docs">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                    </button>
                    <button onClick={handlePrintAllTags} className="w-8 h-8 rounded-lg border border-gray-200 text-gray-500 hover:text-blue-700 hover:border-blue-300 flex items-center justify-center" title="Print All Pallet Tags">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/></svg>
                    </button>
                  </>
                )}
                <div className="w-px h-6 bg-gray-200" />
              </>
            )}
            {/* Close Dist / Re-open */}
            {isBuilt ? (
              <button
                onClick={handleReopenDistribution}
                className="px-3 py-1.5 bg-amber-500 text-white text-xs font-semibold rounded-lg hover:bg-amber-600 flex items-center gap-1.5"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
                Re-open
              </button>
            ) : ulds.length > 0 ? (
              <button
                onClick={() => setShowCloseDistDialog(true)}
                className="px-3 py-1.5 bg-green-600 text-white text-xs font-semibold rounded-lg hover:bg-green-700 flex items-center gap-1.5"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                Close Dist.
              </button>
            ) : null}
            <button
              onClick={() => { setShowCreateUld(true); setNewUldDest(selectedFlight.destinations?.[0] || '') }}
              className="px-3 py-1.5 bg-blue-800 text-white text-xs font-semibold rounded-lg hover:bg-blue-900"
            >
              + Crear ULD
            </button>
            <button
              onClick={() => setSelectedFlight(null)}
              className="px-3 py-1.5 border border-gray-200 text-gray-600 text-xs rounded-lg hover:bg-gray-50"
            >
              Cambiar vuelo
            </button>
          </div>
        </div>

        {/* Create ULD form */}
        {showCreateUld && (
          <div className="bg-white rounded-xl border border-blue-200 p-5 mb-4">
            <h3 className="font-semibold text-gray-800 mb-3">Nuevo ULD</h3>
            {/* CONF selector */}
            <div className="mb-4">
              <label className="block text-xs text-gray-500 mb-1.5">Configuracion</label>
              <div className="flex gap-2">
                {(['MD', 'LD', 'ESP'] as const).map(c => (
                  <button
                    key={c}
                    onClick={() => { setNewUldConf(c); setNewUldTypeId('') }}
                    className={`px-4 py-2 text-sm font-semibold rounded-lg border transition-colors ${
                      newUldConf === c
                        ? CONF_COLORS[c] + ' border-current'
                        : 'border-gray-200 text-gray-400 hover:bg-gray-50'
                    }`}
                  >
                    {c === 'MD' ? 'Main Deck' : c === 'LD' ? 'Lower Deck' : 'Especial'}
                  </button>
                ))}
              </div>
            </div>
            {/* TYPE selector */}
            <div className="mb-4">
              <label className="block text-xs text-gray-500 mb-1.5">Tipo</label>
              <div className="flex flex-wrap gap-2">
                {uldTypes.filter(t => t.conf === newUldConf).map(t => (
                  <button
                    key={t.id}
                    onClick={() => setNewUldTypeId(t.id)}
                    className={`px-4 py-2 text-sm font-semibold rounded-lg border transition-colors ${
                      newUldTypeId === t.id
                        ? 'bg-blue-800 text-white border-blue-800'
                        : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {t.type}
                  </button>
                ))}
                {uldTypes.filter(t => t.conf === newUldConf).length === 0 && (
                  <p className="text-xs text-gray-400 py-2">Sin tipos configurados para {newUldConf}. Agrega en Admin &gt; ULD Types.</p>
                )}
              </div>
            </div>
            {/* Number + Dest */}
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Numero</label>
                <input
                  type="text"
                  value={newUldNumber}
                  onChange={e => setNewUldNumber(e.target.value)}
                  placeholder="Ej: 1234LA"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-blue-800"
                />
                {newUldTypeId && newUldNumber.trim() && (
                  <p className="text-xs text-blue-800 font-mono font-bold mt-1">
                    {uldTypes.find(t => t.id === newUldTypeId)?.type} {newUldNumber.trim().toUpperCase()}
                  </p>
                )}
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Destino</label>
                <input
                  type="text"
                  value={newUldDest}
                  onChange={e => setNewUldDest(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-800"
                />
              </div>
              <div className="flex items-end gap-2">
                <button
                  onClick={handleCreateUld}
                  disabled={creatingSaving || !newUldNumber.trim() || !newUldTypeId}
                  className="px-4 py-2 bg-blue-800 text-white text-sm font-semibold rounded-lg hover:bg-blue-900 disabled:opacity-50"
                >
                  {creatingSaving ? 'Creando...' : 'Crear'}
                </button>
                <button
                  onClick={() => setShowCreateUld(false)}
                  className="px-4 py-2 border border-gray-200 text-gray-600 text-sm rounded-lg hover:bg-gray-50"
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        )}

        {loadingData ? (
          <div className="text-center py-12 text-gray-400">Cargando datos de vuelo...</div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

            {/* Left: AWBs disponibles */}
            <div className="lg:col-span-1">
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
                  <h3 className="font-semibold text-gray-700 text-sm">AWBs en vuelo ({awbs.length})</h3>
                </div>
                <div className="divide-y divide-gray-100 max-h-[calc(100vh-280px)] overflow-y-auto">
                  {awbs.length === 0 ? (
                    <div className="p-6 text-center text-gray-400 text-sm">No hay AWBs con recepcion fisica</div>
                  ) : awbs.map(a => {
                    const awbLabel = a.reception.awb_2nd_leg || a.reception.awb_number
                    const pending = a.totalPieces - a.assignedCount
                    const pct = a.totalPieces > 0 ? Math.round((a.assignedCount / a.totalPieces) * 100) : 0
                    const isFullyAssigned = a.assignedCount >= a.totalPieces
                    return (
                      <div key={a.reception.id} className={`px-4 py-3 ${isFullyAssigned || a.forceClosed ? 'bg-green-50/50' : ''}`}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-mono font-bold text-blue-800">{awbLabel}</span>
                          <span className="text-xs text-gray-500">{a.reception.client_name}</span>
                        </div>
                        <div className="flex items-center gap-2 mb-1">
                          <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                            <div className="h-full bg-blue-600 rounded-full" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-xs text-gray-500">{a.assignedCount}/{a.totalPieces}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-gray-400">{a.reception.destination} | {fmtNum(a.pieces.reduce((s, p) => s + p.weight_kg, 0))} kg</span>
                          {a.forceClosed ? (
                            <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full font-medium">
                              Cierre forzado
                            </span>
                          ) : !isFullyAssigned && a.assignedCount > 0 ? (
                            <button
                              onClick={() => handleForceClose(a)}
                              className="text-[10px] text-amber-600 hover:text-amber-800 font-medium"
                            >
                              Cierre forzado ({pending} pend.)
                            </button>
                          ) : isFullyAssigned ? (
                            <span className="text-[10px] text-green-600 font-medium">Completa</span>
                          ) : null}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>

            {/* Right: ULD Kanban */}
            <div className="lg:col-span-2">
              {ulds.length === 0 ? (
                <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-400">
                  <p className="text-sm">No hay ULDs creados para este vuelo</p>
                  <button
                    onClick={() => { setShowCreateUld(true); setNewUldDest(selectedFlight.destinations?.[0] || '') }}
                    className="mt-3 px-4 py-2 bg-blue-800 text-white text-sm rounded-lg hover:bg-blue-900"
                  >
                    + Crear primer ULD
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Open ULDs */}
                  {openUlds.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">Abiertos ({openUlds.length})</h4>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {openUlds.map(u => {
                          const pieces = getUldPieces(u.id)
                          const weight = getUldWeight(u.id)
                          const netCapacity = u.max_weight_kg - u.tara_kg
                          const weightPct = netCapacity > 0 ? Math.min(100, Math.round((weight / netCapacity) * 100)) : 0
                          const uldAwbs = getUldAwbs(u.id)
                          const confCls = CONF_COLORS[u.conf] || 'bg-gray-100 text-gray-700'

                          return (
                            <div key={u.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                              {editingUldId === u.id ? (
                                /* ── Inline ULD editor: CONF + TYPE + Number ── */
                                <div className="px-4 py-3 border-b border-blue-200 bg-blue-50/30 space-y-2">
                                  <div className="flex gap-1">
                                    {(['MD', 'LD', 'ESP'] as const).map(c => (
                                      <button key={c} onClick={() => { setEditUldConf(c); setEditUldType('') }}
                                        className={`px-2 py-1 text-[10px] font-bold rounded border transition-colors ${editUldConf === c ? CONF_COLORS[c] + ' border-current' : 'border-gray-200 text-gray-400'}`}
                                      >{c === 'MD' ? 'Main Deck' : c === 'LD' ? 'Lower Deck' : 'Especial'}</button>
                                    ))}
                                  </div>
                                  <div className="flex flex-wrap gap-1">
                                    {uldTypes.filter(t => t.conf === editUldConf).map(t => (
                                      <button key={t.id} onClick={() => setEditUldType(t.type)}
                                        className={`px-2 py-1 text-[10px] font-bold rounded border transition-colors ${editUldType === t.type ? 'bg-blue-800 text-white border-blue-800' : 'border-gray-200 text-gray-600'}`}
                                      >{t.type}</button>
                                    ))}
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <input type="text" value={editUldNumber} onChange={e => setEditUldNumber(e.target.value)}
                                      onKeyDown={e => { if (e.key === 'Enter') handleSaveUld(u.id); if (e.key === 'Escape') setEditingUldId(null) }}
                                      placeholder="Numero" className="flex-1 border border-gray-200 rounded px-2 py-1 text-sm font-mono font-bold focus:outline-none focus:border-blue-800" />
                                    <button onClick={() => handleSaveUld(u.id)} disabled={!editUldType || !editUldNumber.trim()}
                                      className="px-3 py-1 bg-blue-800 text-white text-xs font-semibold rounded hover:bg-blue-900 disabled:opacity-50">Guardar</button>
                                    <button onClick={() => setEditingUldId(null)}
                                      className="px-3 py-1 border border-gray-200 text-gray-600 text-xs rounded hover:bg-gray-50">Cancelar</button>
                                  </div>
                                </div>
                              ) : (
                                <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                                  <div className="flex items-center gap-2 cursor-pointer" onClick={() => startEditUld(u)} title="Click para editar ULD">
                                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${confCls}`}>{u.conf}</span>
                                    <span className="font-mono font-bold text-sm text-gray-800 hover:text-blue-800">{u.type} {u.uld_number}</span>
                                  </div>
                                  <div className="flex items-center gap-1">
                                    <button onClick={() => setAssignModal({ uld: u })} className="p-1 text-blue-800 hover:bg-blue-50 rounded text-xs font-medium" title="Asignar piezas">+ Asignar</button>
                                    <button onClick={() => toggleUldStatus(u)} className="p-1 text-gray-400 hover:text-green-600 rounded" title="Cerrar ULD">
                                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                                    </button>
                                    <button onClick={() => handleDeleteUld(u)} className="p-1 text-gray-400 hover:text-red-600 rounded" title="Eliminar ULD">
                                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                    </button>
                                  </div>
                                </div>
                              )}
                              {/* Summary line */}
                              <div className="px-4 py-2">
                                <div className="flex items-center justify-between text-xs text-gray-500">
                                  <span>{u.destination}</span>
                                  <span className="font-bold text-gray-600">{pieces.length} pzas | {fmtNum(weight)} kg</span>
                                </div>
                              </div>
                              {/* AWBs in this ULD — click to adjust quantity */}
                              <div className="px-4 pb-3">
                                {uldAwbs.length === 0 ? (
                                  <p className="text-xs text-gray-300 py-2">Sin piezas asignadas</p>
                                ) : (
                                  <div className="space-y-0.5">
                                    {uldAwbs.map(a => {
                                      const expandKey = `${u.id}|${a.awb}`
                                      const isExpanded = expandedUldAwb === expandKey
                                      return (
                                        <div key={a.awb}>
                                          <button
                                            onClick={() => {
                                              if (isExpanded) { setExpandedUldAwb(null) }
                                              else { setExpandedUldAwb(expandKey); setEditAwbQty(a.count) }
                                            }}
                                            className="w-full flex items-center justify-between text-xs py-1.5 hover:bg-gray-50 rounded px-1 -mx-1 transition-colors"
                                          >
                                            <span className="font-mono text-gray-700 flex items-center gap-1">
                                              <svg className={`w-3 h-3 text-gray-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                              </svg>
                                              {a.awb}
                                            </span>
                                            <span className="text-gray-500">{a.count} pcs | {fmtNum(a.weight)} kg</span>
                                          </button>
                                          {isExpanded && (
                                            <div className="ml-4 mb-1 flex items-center gap-2 py-1">
                                              <span className="text-[11px] text-gray-500">Piezas en este ULD:</span>
                                              <input
                                                type="number"
                                                value={editAwbQty}
                                                onChange={e => setEditAwbQty(Math.max(0, parseInt(e.target.value) || 0))}
                                                min={0}
                                                max={a.count}
                                                className="w-16 border border-gray-200 rounded px-2 py-0.5 text-xs font-mono text-center focus:outline-none focus:border-blue-800"
                                                autoFocus
                                              />
                                              <span className="text-[11px] text-gray-400">/ {a.count}</span>
                                              {editAwbQty < a.count && (
                                                <button
                                                  onClick={() => handleReduceAwbQty(u.id, a.awb, editAwbQty)}
                                                  className="px-2 py-0.5 bg-red-50 text-red-600 text-[11px] font-medium rounded border border-red-200 hover:bg-red-100"
                                                >
                                                  Quitar {a.count - editAwbQty}
                                                </button>
                                              )}
                                            </div>
                                          )}
                                        </div>
                                      )
                                    })}
                                  </div>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Closed ULDs */}
                  {closedUlds.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">Cerrados ({closedUlds.length})</h4>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {closedUlds.map(u => {
                          const pieces = getUldPieces(u.id)
                          const weight = getUldWeight(u.id)
                          const confCls = CONF_COLORS[u.conf] || 'bg-gray-100 text-gray-700'
                          const uldAwbs = getUldAwbs(u.id)

                          return (
                            <div key={u.id} className="bg-gray-50 rounded-xl border border-gray-200 overflow-hidden opacity-80">
                              <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${confCls}`}>{u.conf}</span>
                                  <span className="font-mono font-bold text-sm text-gray-800">{u.type} {u.uld_number}</span>
                                  <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-medium">Cerrado</span>
                                </div>
                                <div className="flex items-center gap-1">
                                  <button
                                    onClick={() => handleDownloadTagDoc(u)}
                                    className="p-1 text-gray-400 hover:text-blue-600 rounded"
                                    title="Download Pallet Tag Doc"
                                  >
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                    </svg>
                                  </button>
                                  <button
                                    onClick={() => handlePrintTag(u)}
                                    className="p-1 text-gray-400 hover:text-blue-600 rounded"
                                    title="Print Pallet Tag"
                                  >
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                                    </svg>
                                  </button>
                                  <button
                                    onClick={() => toggleUldStatus(u)}
                                    className="p-1 text-gray-400 hover:text-amber-600 rounded text-xs"
                                    title="Re-abrir ULD"
                                  >
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                                    </svg>
                                  </button>
                                </div>
                              </div>
                              <div className="px-4 py-2">
                                <p className="text-xs text-gray-500">{u.destination} | {pieces.length} pcs | {fmtNum(weight)} kg</p>
                                {uldAwbs.map(a => (
                                  <div key={a.awb} className="flex items-center justify-between text-xs mt-1">
                                    <span className="font-mono text-gray-600">{a.awb}</span>
                                    <span className="text-gray-400">{a.count} pcs</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Assign Modal */}
        {assignModal && (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl max-w-lg w-full p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-bold text-gray-800">
                  Asignar piezas a {assignModal.uld.uld_number}
                </h3>
                <button onClick={() => setAssignModal(null)} className="text-gray-400 hover:text-gray-600">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Mode toggle */}
              <div className="flex bg-gray-100 rounded-lg p-0.5 mb-4">
                <button
                  onClick={() => setAssignMode('bulk')}
                  className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${assignMode === 'bulk' ? 'bg-white shadow text-blue-800' : 'text-gray-500'}`}
                >
                  Por Cantidad
                </button>
                <button
                  onClick={() => setAssignMode('barcode')}
                  className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${assignMode === 'barcode' ? 'bg-white shadow text-blue-800' : 'text-gray-500'}`}
                >
                  Por Barcode
                </button>
              </div>

              {assignMode === 'bulk' ? (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">AWB</label>
                    <select
                      value={assignAwbId}
                      onChange={e => { setAssignAwbId(e.target.value); setAssignQty('') }}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-800"
                    >
                      <option value="">Seleccionar AWB...</option>
                      {awbs.filter(a => a.pieces.some(p => !p.uld_id)).map(a => {
                        const avail = a.pieces.filter(p => !p.uld_id).length
                        return (
                          <option key={a.reception.id} value={a.reception.id}>
                            {a.reception.awb_2nd_leg || a.reception.awb_number} — {avail} disponibles
                          </option>
                        )
                      })}
                    </select>
                  </div>
                  {assignAwbId && (
                    <>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Cantidad de piezas</label>
                        <input
                          type="number"
                          value={assignQty}
                          onChange={e => setAssignQty(e.target.value)}
                          min="1"
                          max={awbs.find(a => a.reception.id === assignAwbId)?.pieces.filter(p => !p.uld_id).length || 0}
                          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-blue-800"
                        />
                        <p className="text-xs text-gray-400 mt-1">
                          Disponibles: {awbs.find(a => a.reception.id === assignAwbId)?.pieces.filter(p => !p.uld_id).length || 0}
                        </p>
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Comment (optional)</label>
                        <input
                          type="text"
                          value={assignComment}
                          onChange={e => setAssignComment(e.target.value)}
                          placeholder="e.g. ELI, 131-12345678..."
                          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-800"
                        />
                      </div>
                    </>
                  )}
                  <button
                    onClick={handleAssignBulk}
                    disabled={assigning || !assignAwbId || !assignQty}
                    className="w-full py-2 bg-blue-800 text-white text-sm font-semibold rounded-lg hover:bg-blue-900 disabled:opacity-50"
                  >
                    {assigning ? 'Asignando...' : 'Asignar'}
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Escanear o ingresar barcode</label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setContinuousScanUld({ id: assignModal!.uld.id, number: assignModal!.uld.uld_number })}
                        className="px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 flex items-center gap-1 shrink-0"
                        title="Escaneo continuo con camara"
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                            d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                      </button>
                      <input
                        type="text"
                        value={assignBarcode}
                        onChange={e => setAssignBarcode(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleAssignBarcode()}
                        placeholder="Escanear barcode..."
                        className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-blue-800"
                        autoFocus
                      />
                      <button
                        onClick={handleAssignBarcode}
                        disabled={assigning || !assignBarcode.trim()}
                        className="px-4 py-2 bg-blue-800 text-white text-sm font-semibold rounded-lg hover:bg-blue-900 disabled:opacity-50"
                      >
                        {assigning ? '...' : 'Asignar'}
                      </button>
                    </div>
                  </div>
                  {/* Show already assigned pieces in this ULD */}
                  <div className="max-h-40 overflow-y-auto">
                    {getUldPieces(assignModal.uld.id).map(p => (
                      <div key={p.id} className="flex items-center justify-between text-xs py-1 border-b border-gray-50">
                        <span className="font-mono">{p.barcode}</span>
                        <button
                          onClick={() => handleUnassignPiece(p.id)}
                          className="text-red-400 hover:text-red-600"
                        >
                          Quitar
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Close Distribution Dialog ── */}
      {showCloseDistDialog && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={() => !closingDist && setShowCloseDistDialog(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6">
              <div className="flex items-start gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                  <svg className="w-6 h-6 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"/></svg>
                </div>
                <div>
                  <h3 className="font-bold text-gray-800 mb-1">Close Distribution</h3>
                  <p className="text-sm text-gray-600">
                    {incompleteAwbs.length === 0 && zeroAwbs.length === 0
                      ? 'All AWBs are fully distributed. Confirm to close.'
                      : 'Review before closing:'}
                  </p>
                </div>
              </div>

              {incompleteAwbs.length > 0 && (
                <div className="bg-amber-50 rounded-lg p-3 mb-3">
                  <p className="text-[10px] font-bold text-amber-600 uppercase mb-1">Incomplete</p>
                  {incompleteAwbs.map(a => (
                    <div key={a.reception.id} className="flex items-center justify-between text-sm">
                      <span className="font-mono font-bold text-gray-700">{a.reception.awb_2nd_leg || a.reception.awb_number}</span>
                      <span className="text-amber-700 font-medium">{a.assignedCount}/{a.totalPieces} pcs</span>
                    </div>
                  ))}
                </div>
              )}

              {zeroAwbs.length > 0 && (
                <div className="bg-red-50 rounded-lg p-3 mb-3">
                  <p className="text-[10px] font-bold text-red-600 uppercase mb-1">Not distributed (0 pieces)</p>
                  {zeroAwbs.map(a => (
                    <div key={a.reception.id} className="flex items-center justify-between text-sm">
                      <span className="font-mono font-bold text-gray-700">{a.reception.awb_2nd_leg || a.reception.awb_number}</span>
                      <span className="text-red-600 font-medium">0/{a.totalPieces} pcs</span>
                    </div>
                  ))}
                </div>
              )}

              {(incompleteAwbs.length > 0 || zeroAwbs.length > 0) && (
                <p className="text-sm text-gray-500 mb-4">Incomplete AWBs will stay. Undistributed AWBs will remain on the flight but with 0 pieces assigned.</p>
              )}

              <div className="flex gap-2">
                <button
                  onClick={handleCloseDistribution}
                  disabled={closingDist}
                  className="flex-1 py-2.5 bg-green-600 text-white text-sm font-bold rounded-lg hover:bg-green-700 disabled:opacity-50"
                >
                  {closingDist ? 'Closing...' : 'Confirm & Close'}
                </button>
                <button
                  onClick={() => setShowCloseDistDialog(false)}
                  disabled={closingDist}
                  className="flex-1 py-2.5 border border-gray-200 text-gray-600 text-sm rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </>
      )}
      {/* ── Continuous Barcode Scanner ── */}
      <BarcodeContinuousScanner
        open={!!continuousScanUld}
        onClose={() => setContinuousScanUld(null)}
        allPieces={allPieces}
        targetUldId={continuousScanUld?.id || ''}
        targetUldNumber={continuousScanUld?.number || ''}
        onPieceAssigned={handleContinuousScanAssign}
        uldLookup={uldLookup}
      />
    </Layout>
  )
}
