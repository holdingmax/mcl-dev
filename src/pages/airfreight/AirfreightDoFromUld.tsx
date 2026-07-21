import React, { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { collection, query, where, getDocs, doc, getDoc } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import Layout from '../../components/Layout'
import { saveDeliveryOrder, getNextDoNumber } from '../../lib/deliveryOrder'
import { DeliveryOrder, AwbEntry } from '../../types'

// ── Types ──────────────────────────────────────────────────────────────────────

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
}

interface PhysicalPiece {
  id: string
  doc_reception_id: string
  awb_number: string
  warehouse_number: string
  piece_number: number
  weight_kg: number
  uld_id?: string | null
  dist_comment?: string | null
}

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
  status: string
  warehouse_number: string | null
}

interface FlightInfo {
  id: string
  flight_number: string
  airline: string
  destination: string
  etd: string
}

interface ResolvedUld {
  uld: BuildupUld
  flight: FlightInfo | null
  awbs: {
    awb_number: string
    awb_1st_leg: string
    client_name: string
    client_id: string
    destination: string
    pieces: number
    weight_kg: number
    booking_id: string | null
    booking_type: 'ecommerce' | 'mawb' | 'export'
    flight_id: string | null
    flight_number: string
    airline: string
    has_battery: boolean
    mawb_number: string | null
  }[]
  totalPieces: number
  totalKg: number
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function AirfreightDoFromUld() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const inputRef = useRef<HTMLInputElement>(null)

  const [uldInput, setUldInput] = useState('')
  const [resolvedUlds, setResolvedUlds] = useState<ResolvedUld[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [savedDoNumber, setSavedDoNumber] = useState('')
  const [savedDoId, setSavedDoId] = useState('')

  // Focus input on mount
  useEffect(() => { inputRef.current?.focus() }, [])

  // ── Lookup ULD ────────────────────────────────────────────────────────────

  async function handleAddUld() {
    // Strip spaces — user may type "PAG 1234LA" or "PAG1234LA"
    const raw = uldInput.replace(/\s+/g, '').toUpperCase()
    if (!raw) return
    setError('')

    // Check duplicate (compare against type+uld_number without spaces)
    const norm = (s: string) => s.replace(/\s+/g, '').toUpperCase()
    if (resolvedUlds.some(r => norm(r.uld.uld_number) === raw || norm(`${r.uld.type}${r.uld.uld_number}`) === raw)) {
      setError('ULD ya agregado')
      return
    }

    setLoading(true)
    try {
      // Search in buildup_ulds — try exact match on uld_number
      const q1 = query(collection(db, 'buildup_ulds'), where('uld_number', '==', raw))
      let snap = await getDocs(q1)

      // If not found, try stripping type prefix (2, 3 or 4 letter prefix)
      // ULD numbers can have letters too (e.g. "1234LA"), so try all prefix lengths
      if (snap.empty) {
        for (const len of [3, 2, 4]) {
          if (raw.length > len) {
            const remainder = raw.slice(len)
            const q2 = query(collection(db, 'buildup_ulds'), where('uld_number', '==', remainder))
            const s2 = await getDocs(q2)
            if (!s2.empty) {
              // Verify the type prefix matches
              const prefix = raw.slice(0, len)
              const matched = s2.docs.filter(d => (d.data() as any).type?.toUpperCase() === prefix)
              if (matched.length > 0) {
                snap = { ...s2, docs: matched } as any
                break
              }
            }
          }
        }
      }

      if (snap.empty) {
        setError(`ULD "${raw}" no encontrado`)
        setLoading(false)
        return
      }

      // Filter to closed ULDs only
      const closedDocs = snap.docs.filter(d => (d.data() as any).status === 'closed')
      if (closedDocs.length === 0) {
        setError(`ULD "${raw}" no esta cerrado`)
        setLoading(false)
        return
      }

      // Filter out ULDs from dispatched/closed/cancelled flights (reused ULD numbers)
      let activeDocs = closedDocs
      if (closedDocs.length > 1) {
        const filtered = []
        for (const cd of closedDocs) {
          const flightId = (cd.data() as any).flight_id
          if (!flightId) { filtered.push(cd); continue }
          const fSnap = await getDocs(query(collection(db, 'airfreight_flights'), where('__name__', '==', flightId)))
          if (fSnap.empty) { filtered.push(cd); continue }
          const f = fSnap.docs[0].data() as any
          const st = (f.flight_status || f.status || '').toLowerCase()
          if (st === 'dispatched' || st === 'closed' || st === 'cancelled' || f.dispatched_at) continue
          filtered.push(cd)
        }
        activeDocs = filtered.length > 0 ? filtered : closedDocs
      }
      if (activeDocs.length === 0) {
        setError(`ULD "${raw}" solo existe en vuelos despachados`)
        setLoading(false)
        return
      }
      const uldDoc = activeDocs[activeDocs.length - 1]
      const uldData = { ...uldDoc.data(), id: uldDoc.id } as BuildupUld

      // Check duplicate by id
      if (resolvedUlds.some(r => r.uld.id === uldData.id)) {
        setError('ULD ya agregado')
        setLoading(false)
        return
      }

      // Get pieces assigned to this ULD
      const piecesQ = query(
        collection(db, 'airfreight_physical_pieces'),
        where('uld_id', '==', uldData.id),
      )
      const piecesSnap = await getDocs(piecesQ)
      const pieces = piecesSnap.docs.map(d => ({ ...d.data(), id: d.id } as PhysicalPiece))

      // Group pieces by doc_reception_id
      const byDocRec = new Map<string, PhysicalPiece[]>()
      for (const p of pieces) {
        const arr = byDocRec.get(p.doc_reception_id) || []
        arr.push(p)
        byDocRec.set(p.doc_reception_id, arr)
      }

      // Fetch doc receptions + bookings for AWB info
      const docRecIds = Array.from(byDocRec.keys())
      const awbs: ResolvedUld['awbs'] = []
      const bookingCache = new Map<string, any>()

      for (const drId of docRecIds) {
        const drSnap = await getDocs(query(
          collection(db, 'airfreight_doc_receptions'),
          where('__name__', '==', drId),
        ))
        if (!drSnap.empty) {
          const dr = drSnap.docs[0].data() as any
          const pcsInUld = byDocRec.get(drId) || []
          const totalWeight = pcsInUld.reduce((s, p) => s + (p.weight_kg || 0), 0)

          // Fetch booking to get booking_type, client_id, battery
          let bkType: 'ecommerce' | 'mawb' | 'export' = 'ecommerce'
          let clientId = ''
          let hasBattery = false
          const bkId = dr.booking_id || ''
          if (bkId && !bookingCache.has(bkId)) {
            try {
              const { doc: fbDoc, getDoc: fbGetDoc } = await import('firebase/firestore')
              const bSnap = await fbGetDoc(fbDoc(db, 'airfreight_bookings', bkId))
              if (bSnap.exists()) bookingCache.set(bkId, bSnap.data())
            } catch { /* ignore */ }
          }
          const bk = bookingCache.get(bkId)
          if (bk) {
            if (bk.booking_type === 'mawb') bkType = 'mawb'
            else if (bk.booking_type === 'export') bkType = 'export'
            clientId = bk.client_id || ''
            hasBattery = bkType === 'mawb'
              ? (bk.awb_lines || []).some((l: any) => !!l.battery)
              : !!(bk.awb_lines?.[0]?.battery || (bk as any).battery)
          }

          // Determine AWB number based on booking type (match desktop logic)
          let awbNumber: string
          let awb1stLeg: string
          if (bkType === 'mawb') {
            awbNumber = dr.mawb_number || dr.awb_number || ''
            awb1stLeg = dr.mawb_number || dr.awb_number || ''
          } else {
            awbNumber = dr.awb_2nd_leg || dr.awb_number || ''
            awb1stLeg = dr.awb_1st_leg || dr.awb_number || ''
          }

          awbs.push({
            awb_number: awbNumber,
            awb_1st_leg: awb1stLeg,
            client_name: dr.client_name || '',
            client_id: clientId,
            destination: dr.destination || '',
            pieces: pcsInUld.length,
            weight_kg: totalWeight,
            booking_id: bkId || null,
            booking_type: bkType,
            flight_id: dr.flight_id || null,
            flight_number: dr.flight_number || '',
            airline: '',
            has_battery: hasBattery,
            mawb_number: dr.mawb_number || null,
          })
        }
      }

      // Fetch flight info
      let flightInfo: FlightInfo | null = null
      if (uldData.flight_id) {
        const fSnap = await getDocs(query(
          collection(db, 'airfreight_flights'),
          where('__name__', '==', uldData.flight_id),
        ))
        if (!fSnap.empty) {
          const f = fSnap.docs[0].data() as any
          flightInfo = {
            id: fSnap.docs[0].id,
            flight_number: f.flight_number || '',
            airline: f.airline || '',
            destination: f.destination || '',
            etd: f.etd || '',
          }
          // Fill airline on AWBs
          for (const a of awbs) a.airline = f.airline || ''
        }
      }

      const totalPieces = awbs.reduce((s, a) => s + a.pieces, 0)
      const totalKg = awbs.reduce((s, a) => s + a.weight_kg, 0)

      setResolvedUlds(prev => [...prev, { uld: uldData, flight: flightInfo, awbs, totalPieces, totalKg }])
      setUldInput('')
      inputRef.current?.focus()
    } catch (err: any) {
      setError(err.message || 'Error buscando ULD')
    } finally {
      setLoading(false)
    }
  }

  function handleRemoveUld(uldId: string) {
    setResolvedUlds(prev => prev.filter(r => r.uld.id !== uldId))
  }

  // ── Totals ────────────────────────────────────────────────────────────────

  const grandTotalPcs = resolvedUlds.reduce((s, r) => s + r.totalPieces, 0)
  const grandTotalKg = resolvedUlds.reduce((s, r) => s + r.totalKg, 0)
  const uniqueAwbs = new Set(resolvedUlds.flatMap(r => r.awbs.map(a => a.awb_number)))

  // ── Save DO ───────────────────────────────────────────────────────────────

  async function handleSave() {
    if (resolvedUlds.length === 0) return
    setSaving(true)
    setError('')

    try {
      // Build AWB entries — deduplicate AWBs across ULDs
      // For MAWB: multiple DRs (each with its own HAWB/awb_2nd_leg) merge under one mawb_number key.
      // We track the HAWB numbers because physical pieces store those, not the mawb_number.
      const awbMap = new Map<string, { entry: AwbEntry; pcs: number; kg: number; pieceAwbs: Set<string> }>()

      for (const r of resolvedUlds) {
        for (const a of r.awbs) {
          const key = a.awb_number
          if (awbMap.has(key)) {
            const existing = awbMap.get(key)!
            existing.pcs += a.pieces
            existing.kg += a.weight_kg
          } else {
            awbMap.set(key, {
              entry: {
                booking_id: a.booking_id || '',
                booking_type: a.booking_type,
                awb_index: 0,
                awb_number: a.awb_number,
                awb_1st_leg: a.awb_1st_leg,
                client_name: a.client_name,
                client_id: a.client_id,
                flight_number: a.flight_number,
                flight_id: a.flight_id || '',
                airline: a.airline,
                destination: a.destination,
                deliver_to: a.airline,
                pieces: a.pieces,
                weight: a.weight_kg,
                has_battery: a.has_battery,
              },
              pcs: a.pieces,
              kg: a.weight_kg,
              pieceAwbs: new Set<string>(),
            })
          }
        }
      }

      // For MAWB entries, resolve ALL HAWB numbers from the booking.
      // C/P is at MAWB level: must count pieces for ALL HAWBs, not just those in this DO.
      for (const [, v] of awbMap) {
        if (v.entry.booking_type === 'mawb' && v.entry.booking_id) {
          try {
            const bkSnap = await getDoc(doc(db, 'airfreight_bookings', v.entry.booking_id))
            if (bkSnap.exists()) {
              const bkData = bkSnap.data()
              for (const line of (bkData.awb_lines || [])) {
                const hawb = line.awb_2nd_leg || line.awb_number || ''
                if (hawb) v.pieceAwbs.add(hawb)
              }
            }
          } catch { /* ignore */ }
        }
      }

      // Update aggregated pieces/weight
      const awbEntries: AwbEntry[] = []
      const pieceAwbsMap = new Map<string, Set<string>>()
      for (const [key, v] of awbMap) {
        v.entry.pieces = v.pcs
        v.entry.weight = v.kg
        awbEntries.push(v.entry)
        pieceAwbsMap.set(key, v.pieceAwbs)
      }

      // Compute frozen_pc for each AWB entry
      // Uses pieces in THIS DO's ULDs + ULDs of DOs created BEFORE this one
      const doUldIds = new Set(resolvedUlds.map(r => r.uld.id))

      // Since this is a NEW DO being created, there are no "previous DOs" yet at this moment.
      // However, some AWBs may already appear in earlier DOs. Find those DOs and their ULDs.
      const previousDoUldIds = new Set<string>()
      const allAwbKeys = awbEntries.map(e => `${e.booking_id}::${e.awb_index}`)
      for (const key of allAwbKeys) {
        if (!key || key === '::0') continue
        try {
          const prevSnap = await getDocs(query(
            collection(db, 'delivery_orders'),
            where('awb_keys', 'array-contains', key),
          ))
          for (const d of prevSnap.docs) {
            const prevDo = d.data() as DeliveryOrder
            // All existing DOs are "previous" to this new one
            for (const uldStr of (prevDo.ulds_loaded || [])) {
              // Resolve ULD string to buildup_uld IDs
              const normStr = uldStr.replace(/[\s\-]/g, '').toUpperCase()
              for (const r of resolvedUlds) {
                // Use the buildup_ulds from the same flight
                const flightId = r.uld.flight_id
                try {
                  const buSnap = await getDocs(query(collection(db, 'buildup_ulds'), where('flight_id', '==', flightId)))
                  for (const bu of buSnap.docs) {
                    const buData = bu.data() as { uld_number: string; type: string }
                    const combined = `${buData.type}${buData.uld_number}`.replace(/[\s\-]/g, '').toUpperCase()
                    const numOnly = buData.uld_number.replace(/[\s\-]/g, '').toUpperCase()
                    if (normStr === combined || normStr === numOnly) {
                      previousDoUldIds.add(bu.id)
                    }
                  }
                } catch { /* ignore */ }
              }
            }
          }
        } catch { /* ignore */ }
      }
      const validUldIds = new Set([...doUldIds, ...previousDoUldIds])

      for (const entry of awbEntries) {
        try {
          const searchAwbs = pieceAwbsMap.get(entry.awb_number)
          const awbsToQuery = searchAwbs && searchAwbs.size > 0
            ? [...searchAwbs]
            : [entry.awb_number]

          let total = 0, inThisDo = 0, inThisAndPrevious = 0
          // For MAWB auto-selection: track which HAWBs have pieces in this DO's ULDs
          const hawbsInThisDo = new Set<string>()
          for (const awb of awbsToQuery) {
            const pSnap = await getDocs(query(
              collection(db, 'airfreight_physical_pieces'),
              where('awb_number', '==', awb),
            ))
            pSnap.forEach(d => {
              total++
              const uldId = d.data().uld_id
              if (uldId && doUldIds.has(uldId)) {
                inThisDo++
                hawbsInThisDo.add(awb)
              }
              if (uldId && validUldIds.has(uldId)) inThisAndPrevious++
            })
          }
          if (total > 0 && inThisDo > 0) {
            entry.frozen_pc = inThisAndPrevious >= total ? 'C' : 'P'
          } else {
            entry.frozen_pc = null
          }

          // Auto-select HAWBs that have pieces in this DO's ULDs (MAWB only)
          if (entry.booking_type === 'mawb' && entry.booking_id && hawbsInThisDo.size > 0) {
            const bk = bookingCache.get(entry.booking_id)
            if (bk) {
              const lines = bk.awb_lines || []
              const selectedIndices: number[] = []
              lines.forEach((line: any, idx: number) => {
                const hawb = line.awb_2nd_leg || line.awb_number || ''
                if (hawb && hawbsInThisDo.has(hawb)) {
                  selectedIndices.push(idx)
                }
              })
              if (selectedIndices.length > 0) {
                entry.selected_hawb_indices = selectedIndices
              }
            }
          }
        } catch {
          entry.frozen_pc = null
        }
      }

      const uldNumbers = resolvedUlds.map(r => `${r.uld.type}${r.uld.uld_number}`)
      const isMobile = window.innerWidth < 768

      const doData: DeliveryOrder = {
        do_number: '',
        date: new Date().toISOString(),
        status: 'draft',
        created_at: new Date().toISOString(),
        created_by: user?.email || '',
        awb_entries: awbEntries,
        awb_keys: awbEntries.map(e => `${e.booking_id}::${e.awb_index}`),
        trucking_company: '',
        driver_name: '',
        custody_method: 'seal',
        seal_number: '',
        escort_name: '',
        ulds_loaded: uldNumbers,
        mcl_agent: user?.email || '',
        ccsf_screening_type: 'originated',
        accepted_for: 'CAO',
        ...(isMobile ? { origin: 'bodega' } : {}),
      }

      const docId = await saveDeliveryOrder(doData)
      setSavedDoId(docId)
      // Retrieve the DO number from the saved document
      const { doc: fbDoc, getDoc: fbGetDoc } = await import('firebase/firestore')
      const savedSnap = await fbGetDoc(fbDoc(db, 'delivery_orders', docId))
      const savedNum = savedSnap.exists() ? (savedSnap.data().do_number || '') : ''
      setSavedDoNumber(savedNum)
      setSaved(true)
    } catch (err: any) {
      setError(err.message || 'Error guardando DO')
    } finally {
      setSaving(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768

  return (
    <Layout title="New DO from ULDs" backTo="/airfreight">
      <div className="max-w-3xl mx-auto px-3 sm:px-6 py-4 sm:py-6">
        {saved ? (
          /* ── Success screen ── */
          <div className="bg-white rounded-xl border border-green-200 p-6 text-center space-y-4">
            <div className="w-16 h-16 mx-auto bg-green-100 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>
            </div>
            <p className="text-lg font-bold text-gray-800">DO Creada: {savedDoNumber}</p>
            <p className="text-sm text-gray-500">{resolvedUlds.length} ULD{resolvedUlds.length > 1 ? 's' : ''} / {uniqueAwbs.size} AWB{uniqueAwbs.size > 1 ? 's' : ''} / {grandTotalPcs} pcs / {Math.round(grandTotalKg)} kg</p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
              <button onClick={() => navigate(`/airfreight/delivery-order/doc/${savedDoId}`)}
                className="px-5 py-2.5 bg-[#1e3a5f] text-white rounded-lg font-medium hover:bg-blue-900">
                Ver DO
              </button>
              <button onClick={() => { setResolvedUlds([]); setSaved(false); setSavedDoNumber(''); setSavedDoId(''); setUldInput(''); }}
                className="px-5 py-2.5 border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-50">
                Crear Otra
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* ── ULD Input ── */}
            <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4">
              <label className="block text-sm font-medium text-gray-600 mb-2">ULD Number</label>
              <div className="flex gap-2">
                <input
                  ref={inputRef}
                  type="text"
                  value={uldInput}
                  onChange={e => { setUldInput(e.target.value.toUpperCase()); setError('') }}
                  onKeyDown={e => { if (e.key === 'Enter') handleAddUld() }}
                  placeholder="Escanear o escribir ULD..."
                  className="flex-1 h-12 px-4 border-2 border-gray-200 rounded-xl text-lg font-mono focus:outline-none focus:border-[#1e3a5f]"
                />
                <button onClick={handleAddUld} disabled={loading || !uldInput.trim()}
                  className="h-12 px-5 bg-[#1e3a5f] text-white rounded-xl font-medium hover:bg-blue-900 disabled:opacity-50 whitespace-nowrap">
                  {loading ? (
                    <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                  ) : (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/></svg>
                  )}
                </button>
              </div>
              {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
            </div>

            {/* ── Summary bar ── */}
            {resolvedUlds.length > 0 && (
              <div className="grid grid-cols-4 gap-2 mb-4">
                <div className="bg-blue-50 border border-blue-100 rounded-lg p-2 text-center">
                  <div className="text-lg font-bold text-[#1e3a5f]">{resolvedUlds.length}</div>
                  <div className="text-xs text-gray-500">ULDs</div>
                </div>
                <div className="bg-blue-50 border border-blue-100 rounded-lg p-2 text-center">
                  <div className="text-lg font-bold text-[#1e3a5f]">{uniqueAwbs.size}</div>
                  <div className="text-xs text-gray-500">AWBs</div>
                </div>
                <div className="bg-blue-50 border border-blue-100 rounded-lg p-2 text-center">
                  <div className="text-lg font-bold text-[#1e3a5f]">{grandTotalPcs}</div>
                  <div className="text-xs text-gray-500">Piezas</div>
                </div>
                <div className="bg-blue-50 border border-blue-100 rounded-lg p-2 text-center">
                  <div className="text-lg font-bold text-[#1e3a5f]">{Math.round(grandTotalKg)}</div>
                  <div className="text-xs text-gray-500">KG</div>
                </div>
              </div>
            )}

            {/* ── ULD Cards ── */}
            <div className="space-y-3 mb-20">
              {resolvedUlds.map(r => (
                <div key={r.uld.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  {/* ULD header */}
                  <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-100">
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 text-xs font-bold rounded border ${
                        r.uld.conf === 'MD' ? 'bg-purple-100 text-purple-700 border-purple-200' :
                        r.uld.conf === 'LD' ? 'bg-blue-100 text-blue-700 border-blue-200' :
                        'bg-amber-100 text-amber-700 border-amber-200'
                      }`}>{r.uld.conf}</span>
                      <span className="font-mono font-bold text-gray-800">{r.uld.type}{r.uld.uld_number}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      {r.flight && (
                        <span className="text-xs text-gray-500">{r.flight.flight_number}</span>
                      )}
                      <span className="text-sm font-medium text-gray-600">{r.totalPieces} pcs / {Math.round(r.totalKg)} kg</span>
                      <button onClick={() => handleRemoveUld(r.uld.id)} className="text-red-400 hover:text-red-600">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
                      </button>
                    </div>
                  </div>
                  {/* AWBs in this ULD */}
                  <div className="divide-y divide-gray-50">
                    {r.awbs.map((a, i) => (
                      <div key={i} className="px-4 py-2 flex items-center justify-between">
                        <div>
                          <span className="font-mono text-sm text-gray-800">{a.awb_number}</span>
                          <span className="ml-2 text-xs text-gray-400">{a.client_name}</span>
                        </div>
                        <div className="text-sm text-gray-600">
                          {a.pieces} pcs / {Math.round(a.weight_kg)} kg
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              {resolvedUlds.length === 0 && (
                <div className="text-center py-12 text-gray-400">
                  <svg className="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
                  </svg>
                  <p>Escanea o escribe un ULD para comenzar</p>
                </div>
              )}
            </div>

            {/* ── Fixed bottom button ── */}
            {resolvedUlds.length > 0 && (
              <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 p-3 sm:p-4 z-30">
                <div className="max-w-3xl mx-auto">
                  <button onClick={handleSave} disabled={saving}
                    className="w-full h-12 sm:h-11 bg-green-600 text-white rounded-xl font-bold text-base hover:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2">
                    {saving ? (
                      <>
                        <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                        Creando DO...
                      </>
                    ) : (
                      <>Crear DO ({resolvedUlds.length} ULD{resolvedUlds.length > 1 ? 's' : ''} / {uniqueAwbs.size} AWB{uniqueAwbs.size > 1 ? 's' : ''})</>
                    )}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Layout>
  )
}
