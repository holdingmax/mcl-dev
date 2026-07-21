import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useMatch, Link } from 'react-router-dom'
import Layout from '../components/Layout'
import { db } from '../lib/firebase'
import {
  collection, getDocs, query, where, doc, getDoc,
  addDoc, updateDoc, limit,
} from 'firebase/firestore'
import { WarehouseReceipt, WRLine, Dispatch, DispatchLineAllocation, NAVIERAS, CONTAINER_SIZES, InventoryDocument } from '../types'
import { useAuth } from '../contexts/AuthContext'
import { calculateDispatchCharges } from '../lib/billing'
import { toTitleCase, fmtNum } from '../lib/utils'

interface AvailableWR extends WarehouseReceipt {
  lines: WRLine[]
  totalQty: number
  totalCBM: number
  totalKG: number
  /** Remaining qty/cbm/kg after subtracting other dispatches' partial allocations */
  remainingLines?: Map<string, { remaining: number; total: number }>
}

function getStorageTag(createdAt: string) {
  const created = new Date(createdAt)
  const createdDay = new Date(created.getFullYear(), created.getMonth(), created.getDate())
  const today = new Date()
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const daysIn = Math.round((todayDay.getTime() - createdDay.getTime()) / (1000 * 60 * 60 * 24))
  const free = 21 - daysIn
  if (free > 15) return { text: `${free}d libres`, cls: 'bg-green-100 text-green-700' }
  if (free > 0)  return { text: `${free}d libres`, cls: 'bg-yellow-100 text-yellow-700' }
  return { text: `+${Math.abs(free)}d storage`, cls: 'bg-red-100 text-red-700' }
}

function formatGateOutDate(iso?: string) {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}

export default function DispatchNew() {
  const { id }    = useParams<{ id: string }>()
  const navigate  = useNavigate()
  const { user, canEdit, isClient, clientId }  = useAuth()
  const isConfirm = Boolean(useMatch('/dispatches/:id/confirm'))
  const isEdit    = Boolean(useMatch('/dispatches/:id/edit'))
  const [viewMode, setViewMode] = useState(false) // true = read-only

  // ── Booking fields ──────────────────────────────────────────────────
  const [bookingRequestLI, setBookingRequestLI] = useState('')
  const [bookingNumber,    setBookingNumber]    = useState('')
  const [containerNumber,  setContainerNumber]  = useState('')
  const [containerSize,    setContainerSize]    = useState('40')
  const [naviera,          setNaviera]          = useState('MSC')
  const [navieraOther,     setNavieraOther]     = useState('')
  const [transportCompany, setTransportCompany] = useState('')
  const [scheduledAt,      setScheduledAt]      = useState('')
  const [selectedWRIds,    setSelectedWRIds]    = useState<Set<string>>(new Set())

  const [loadingType, setLoadingType] = useState<'forklift' | 'by_hand' | null>('forklift')
  const [hasDrayage,  setHasDrayage]  = useState(true)
  const [hasHazmat,   setHasHazmat]   = useState(false)

  const isLCL = containerSize === 'LCL'

  // ── Gate-out fields ──────────────────────────────────────────────────
  const [existingDispatch,  setExistingDispatch]  = useState<Dispatch | null>(null)
  const [sealNumber,        setSealNumber]        = useState('')
  const [driverName,        setDriverName]        = useState('')
  const [driverLicense,     setDriverLicense]     = useState('')
  const [photoFile,         setPhotoFile]         = useState<File | null>(null)
  const [sealPhotoFile,     setSealPhotoFile]     = useState<File | null>(null)
  const [containerPhotoFile,setContainerPhotoFile]= useState<File | null>(null)
  const photoInputRef          = useRef<HTMLInputElement>(null)
  const sealPhotoInputRef      = useRef<HTMLInputElement>(null)
  const containerPhotoInputRef = useRef<HTMLInputElement>(null)

  // ── Available WRs ────────────────────────────────────────────────────
  const [availableWRs, setAvailableWRs] = useState<AvailableWR[]>([])
  const [loadingWRs,   setLoadingWRs]   = useState(false)

  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState('')
  // Map po_number → schedule (from inventory_documents)
  const [scheduleByPO, setScheduleByPO] = useState<Record<string, string>>({})

  // ── Partial allocation state ────────────────────────────────────────
  // Map: wrId → Map<lineId, { qty, note }>
  const [partialAllocations, setPartialAllocations] = useState<Map<string, Map<string, { qty: number; note: string }>>>(new Map())
  // Which WR is open in the partial panel (null = closed)
  const [partialPanelWR, setPartialPanelWR] = useState<AvailableWR | null>(null)
  // Temp state for the panel being edited
  const [panelAllocations, setPanelAllocations] = useState<Map<string, { qty: number; note: string }>>(new Map())

  useEffect(() => {
    if (isConfirm) loadDispatch()
    else if (isEdit) loadDispatchForEdit()
    else             loadAvailableWRs()
  }, [id])

  async function loadDispatch() {
    const snap = await getDoc(doc(db, 'dispatches', id!))
    if (snap.exists()) {
      const d = { id: snap.id, ...snap.data() } as Dispatch
      setExistingDispatch(d)
      // Load schedules for WR IDs
      loadSchedules(d.wr_ids || [])
    }
  }

  async function loadSchedules(wrIds: string[]) {
    if (wrIds.length === 0) return
    try {
      const batches: string[][] = []
      for (let i = 0; i < wrIds.length; i += 30) {
        batches.push(wrIds.slice(i, i + 30))
      }
      const poMap: Record<string, string> = {}
      await Promise.all(batches.map(async batch => {
        const constraints = [
          where('wr_id', 'in', batch),
          ...(isClient && clientId ? [where('client_id', '==', clientId)] : []),
        ]
        const invSnap = await getDocs(query(
          collection(db, 'inventory_documents'),
          ...constraints
        ))
        invSnap.docs.forEach(d => {
          const data = d.data() as InventoryDocument
          if (data.schedule && data.po_number) {
            poMap[data.po_number] = data.schedule
          }
        })
      }))
      setScheduleByPO(poMap)
    } catch (e) { console.warn('schedule load error', e) }
  }

  async function loadDispatchForEdit() {
    const snap = await getDoc(doc(db, 'dispatches', id!))
    if (snap.exists()) {
      const d = { id: snap.id, ...snap.data() } as Dispatch
      setExistingDispatch(d)
      setBookingRequestLI(d.booking_request_li || '')
      setBookingNumber(d.booking_number || '')
      setContainerNumber(d.container_number || '')
      setContainerSize(d.container_size || '40')
      setNaviera(d.naviera || 'MSC')
      setNavieraOther(d.naviera_other || '')
      setTransportCompany(d.transport_company || '')
      setScheduledAt(d.scheduled_at ? d.scheduled_at.slice(0, 16) : '')
      setSelectedWRIds(new Set(d.wr_ids || []))
      setLoadingType(d.container_size === 'LCL' ? null : (d.loading_type || 'forklift'))
      setHasDrayage(d.drayage !== undefined ? d.drayage : true)
      setHasHazmat(d.hazmat || false)
      // Restore partial allocations
      if (d.line_allocations && d.line_allocations.length > 0) {
        const pMap = new Map<string, Map<string, { qty: number; note: string }>>()
        for (const alloc of d.line_allocations) {
          if (!pMap.has(alloc.wr_id)) pMap.set(alloc.wr_id, new Map())
          pMap.get(alloc.wr_id)!.set(alloc.wr_line_id, { qty: alloc.allocated_qty, note: alloc.note || '' })
        }
        setPartialAllocations(pMap)
      }
      setViewMode(true) // Open in read-only mode
      loadSchedules(d.wr_ids || [])
      await loadAvailableWRs(d.wr_ids || [])
      return
    }
    await loadAvailableWRs([])
  }

  async function loadAvailableWRs(ownWrIds: string[] = []) {
    setLoadingWRs(true)
    try {
      const q    = query(
        collection(db, 'warehouse_receipts'),
        where('physical_status', '==', 'complete'),
        limit(1000),
      )
      const snap = await getDocs(q)
      const wrs  = (snap.docs
        .map(d => ({ id: d.id, ...d.data() })) as WarehouseReceipt[])
        .filter(wr => wr.source !== 'warehouse_services')

      // Filter out already dispatched or reserved (but keep WRs belonging to current dispatch AND partial WRs)
      const ownSet = new Set(ownWrIds)
      const pending = wrs.filter(w =>
        !w.dispatch_status || w.dispatch_status === 'partial' || ownSet.has(w.id!)
      )

      // Load existing dispatches with partial allocations to compute remaining quantities
      const dispatchSnap = await getDocs(query(collection(db, 'dispatches'), limit(2000)))
      const allDispatches = dispatchSnap.docs.map(d => ({ id: d.id, ...d.data() })) as Dispatch[]
      // Build map: wrId → lineId → total allocated qty across other dispatches
      const allocatedMap = new Map<string, Map<string, number>>()
      for (const disp of allDispatches) {
        if (isEdit && disp.id === id) continue // skip current dispatch when editing
        if (!disp.line_allocations) continue
        for (const alloc of disp.line_allocations) {
          if (!allocatedMap.has(alloc.wr_id)) allocatedMap.set(alloc.wr_id, new Map())
          const lineMap = allocatedMap.get(alloc.wr_id)!
          lineMap.set(alloc.wr_line_id, (lineMap.get(alloc.wr_line_id) || 0) + alloc.allocated_qty)
        }
      }

      const full = await Promise.all(pending.map(async wr => {
        const linesSnap = await getDocs(collection(db, 'warehouse_receipts', wr.id!, 'lines'))
        const lines = linesSnap.docs.map(d => ({ id: d.id, ...d.data() }) as WRLine)
        // Compute remaining quantities for partial WRs
        const wrAllocated = allocatedMap.get(wr.id!)
        const remainingLines = new Map<string, { remaining: number; total: number }>()
        if (wrAllocated) {
          for (const line of lines) {
            if (!line.id) continue
            const used = wrAllocated.get(line.id) || 0
            remainingLines.set(line.id, { remaining: Math.max(0, (line.qty || 0) - used), total: line.qty || 0 })
          }
        }
        const hasPartials = remainingLines.size > 0
        return {
          ...wr,
          lines,
          totalQty: hasPartials
            ? lines.reduce((s, l) => s + (remainingLines.get(l.id!)?.remaining ?? (l.qty || 0)), 0)
            : lines.reduce((s, l) => s + (l.qty || 0), 0),
          totalCBM: hasPartials
            ? lines.reduce((s, l) => {
                const rem = remainingLines.get(l.id!)
                return s + (rem ? ((l.cbm || 0) * rem.remaining / rem.total) : (l.cbm || 0))
              }, 0)
            : lines.reduce((s, l) => s + (l.cbm || 0), 0),
          totalKG: hasPartials
            ? lines.reduce((s, l) => {
                const rem = remainingLines.get(l.id!)
                return s + (rem ? ((l.weight_kg || 0) * rem.remaining / rem.total) : (l.weight_kg || 0))
              }, 0)
            : lines.reduce((s, l) => s + (l.weight_kg || 0), 0),
          remainingLines: hasPartials ? remainingLines : undefined,
        } as AvailableWR
      }))

      full.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
      setAvailableWRs(full)
    } catch (e) { console.error(e) }
    setLoadingWRs(false)
  }

  // Group by destination → PO → WRs
  const byDest = availableWRs.reduce<Record<string, Record<string, AvailableWR[]>>>((acc, wr) => {
    const dest = wr.to_port || '(sin destino)'
    const po   = wr.po_number || '(sin PO)'
    if (!acc[dest])     acc[dest] = {}
    if (!acc[dest][po]) acc[dest][po] = []
    acc[dest][po].push(wr)
    return acc
  }, {})

  // Flat PO → WRs map used for toggle logic
  const byPO = availableWRs.reduce<Record<string, AvailableWR[]>>((acc, wr) => {
    const po = wr.po_number || '(sin PO)'
    if (!acc[po]) acc[po] = []
    acc[po].push(wr)
    return acc
  }, {})

  function togglePO(po: string) {
    const ids = (byPO[po] || []).map(w => w.id!)
    const allSelected = ids.every(id => selectedWRIds.has(id))
    setSelectedWRIds(prev => {
      const next = new Set(prev)
      if (allSelected) ids.forEach(id => next.delete(id))
      else             ids.forEach(id => next.add(id))
      return next
    })
  }

  function toggleDest(dest: string) {
    const ids = Object.values(byDest[dest] || {}).flat().map(w => w.id!)
    const allSelected = ids.every(id => selectedWRIds.has(id))
    setSelectedWRIds(prev => {
      const next = new Set(prev)
      if (allSelected) ids.forEach(id => next.delete(id))
      else             ids.forEach(id => next.add(id))
      return next
    })
  }

  const selectedWRs = availableWRs.filter(w => selectedWRIds.has(w.id!))

  // Helper: get effective qty/cbm/kg for a WR considering partial allocations
  function getEffectiveTotals(wr: AvailableWR) {
    const allocs = partialAllocations.get(wr.id!)
    if (!allocs) return { qty: wr.totalQty, cbm: wr.totalCBM, kg: wr.totalKG }
    // WR has partial allocations: only count explicitly allocated lines
    let qty = 0, cbm = 0, kg = 0
    for (const line of wr.lines) {
      const a = allocs.get(line.id!)
      if (!a || a.qty <= 0) continue
      qty += a.qty
      const ratio = (line.qty || 0) > 0 ? a.qty / line.qty : 0
      cbm += (line.cbm || 0) * ratio
      kg += (line.weight_kg || 0) * ratio
    }
    return { qty, cbm, kg }
  }

  const totalQtySel = selectedWRs.reduce((s, w) => s + getEffectiveTotals(w).qty, 0)
  const totalCBMSel = selectedWRs.reduce((s, w) => s + getEffectiveTotals(w).cbm, 0)
  const totalKGSel  = selectedWRs.reduce((s, w) => s + getEffectiveTotals(w).kg, 0)

  // ── Partial panel helpers ──────────────────────────────────────────
  function openPartialPanel(wr: AvailableWR) {
    const existing = partialAllocations.get(wr.id!)
    if (existing) {
      setPanelAllocations(new Map(existing))
    } else {
      // Default: all available qty per line
      const m = new Map<string, { qty: number; note: string }>()
      for (const line of wr.lines) {
        if (!line.id) continue
        const avail = wr.remainingLines?.get(line.id)?.remaining ?? line.qty ?? 0
        m.set(line.id, { qty: avail, note: '' })
      }
      setPanelAllocations(m)
    }
    setPartialPanelWR(wr)
  }

  function confirmPartialPanel() {
    if (!partialPanelWR) return
    const wrId = partialPanelWR.id!
    // Check if all lines are fully allocated → treat as full WR (no partial)
    const isFullAllocation = partialPanelWR.lines.every(l => {
      const a = panelAllocations.get(l.id!)
      const avail = partialPanelWR.remainingLines?.get(l.id!)?.remaining ?? l.qty ?? 0
      return a && a.qty >= avail
    })
    setPartialAllocations(prev => {
      const next = new Map(prev)
      if (isFullAllocation) {
        next.delete(wrId) // full allocation, no need to store partials
      } else {
        next.set(wrId, new Map(panelAllocations))
      }
      return next
    })
    // Also select this WR
    setSelectedWRIds(prev => {
      const next = new Set(prev)
      next.add(wrId)
      return next
    })
    setPartialPanelWR(null)
  }

  function isPartialWR(wrId: string) {
    return partialAllocations.has(wrId)
  }

  async function handleBooking(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (selectedWRIds.size === 0) { setError('Selecciona al menos un WR para despachar.'); return }
    if (!scheduledAt) { setError('Ingresa la fecha/hora programada.'); return }

    setSaving(true)
    try {
      const wrNums      = selectedWRs.map(w => w.wr_number || '')
      const poNums      = [...new Set(selectedWRs.map(w => w.po_number || ''))]
      const cons        = [...new Set(selectedWRs.map(w => w.consignee?.name || w.company_name || '').filter(Boolean))]
      const dests       = [...new Set(selectedWRs.map(w => w.to_port || '').filter(Boolean))]
      const clientNames = [...new Set(selectedWRs.map(w => w.client_name || '').filter(Boolean))]
      const clientIds   = [...new Set(selectedWRs.map(w => w.client_id || '').filter(Boolean))]

      // Build line_allocations from partialAllocations
      const lineAllocations: DispatchLineAllocation[] = []
      for (const [wrId, lineMap] of partialAllocations) {
        if (!selectedWRIds.has(wrId)) continue
        const wr = availableWRs.find(w => w.id === wrId)
        if (!wr) continue
        for (const [lineId, alloc] of lineMap) {
          const line = wr.lines.find(l => l.id === lineId)
          if (!line || alloc.qty <= 0) continue
          const ratio = (line.qty || 0) > 0 ? alloc.qty / line.qty : 0
          lineAllocations.push({
            wr_id: wrId,
            wr_line_id: lineId,
            allocated_qty: alloc.qty,
            total_qty: line.qty || 0,
            cbm: Math.round((line.cbm || 0) * ratio * 1000) / 1000,
            weight_kg: Math.round((line.weight_kg || 0) * ratio * 100) / 100,
            ...(alloc.note ? { note: alloc.note } : {}),
          })
        }
      }

      const dispatchData: Omit<Dispatch, 'id'> = {
        booking_request_li: bookingRequestLI || undefined,
        booking_number:    bookingNumber,
        container_number:  isLCL ? '' : containerNumber,
        container_size:    containerSize,
        naviera,
        ...(naviera === 'Otra' && navieraOther ? { naviera_other: navieraOther } : {}),
        transport_company: transportCompany,
        scheduled_at:      scheduledAt,
        wr_ids:            [...selectedWRIds],
        wr_numbers:        wrNums,
        po_numbers:        poNums,
        consignees:        cons,
        destinations:      dests,
        total_qty:         totalQtySel,
        total_cbm:         totalCBMSel,
        total_kg:          totalKGSel,
        status:            'booked',
        client_names:      clientNames,
        client_ids:        clientIds,
        created_at:        new Date().toISOString(),
        created_by:        user?.email || '',
        loading_type:      isLCL ? null : loadingType || 'forklift',
        drayage:           isLCL ? false : hasDrayage,
        hazmat:            hasHazmat,
        ...(lineAllocations.length > 0 ? { line_allocations: lineAllocations } : {}),
      }

      // Determine which WRs are partial: a WR is partial if total allocated pieces
      // is less than the WR's total pieces (covers both partial lines AND skipped lines)
      const partialWrIds = new Set<string>()
      for (const wrId of selectedWRIds) {
        if (!partialAllocations.has(wrId)) continue
        const wr = availableWRs.find(w => w.id === wrId)
        if (!wr) continue
        const allocatedTotal = lineAllocations
          .filter(a => a.wr_id === wrId)
          .reduce((s, a) => s + a.allocated_qty, 0)
        if (allocatedTotal < wr.totalQty) {
          partialWrIds.add(wrId)
        }
      }

      // Store partial WR IDs in dispatch for gate out to use
      dispatchData.partial_wr_ids = [...partialWrIds]

      if (isEdit) {
        // Get old WR IDs to diff
        const oldSnap = await getDoc(doc(db, 'dispatches', id!))
        const oldData = oldSnap.exists() ? oldSnap.data() : {}
        const oldIds: string[] = oldData.wr_ids || []
        const newIds = [...selectedWRIds]

        // Only update booking-level fields, preserve gate out data and status
        const bookingUpdate: Record<string, any> = {
          booking_request_li: bookingRequestLI || null,
          booking_number:    bookingNumber,
          container_number:  isLCL ? '' : containerNumber,
          container_size:    containerSize,
          naviera,
          ...(naviera === 'Otra' && navieraOther ? { naviera_other: navieraOther } : {}),
          transport_company: transportCompany,
          scheduled_at:      scheduledAt,
          wr_ids:            [...selectedWRIds],
          wr_numbers:        wrNums,
          po_numbers:        poNums,
          consignees:        cons,
          destinations:      dests,
          total_qty:         totalQtySel,
          total_cbm:         totalCBMSel,
          total_kg:          totalKGSel,
          client_names:      clientNames,
          client_ids:        clientIds,
          loading_type:      isLCL ? null : loadingType || 'forklift',
          drayage:           isLCL ? false : hasDrayage,
          hazmat:            hasHazmat,
          line_allocations:  lineAllocations.length > 0 ? lineAllocations : null,
          partial_wr_ids:    [...partialWrIds],
        }
        await updateDoc(doc(db, 'dispatches', id!), bookingUpdate)

        // Clear reserved on removed WRs, set on added/partial WRs
        const removed = oldIds.filter(i => !selectedWRIds.has(i))
        const added   = newIds.filter(i => !oldIds.includes(i))
        await Promise.all([
          ...removed.map(wrId => updateDoc(doc(db, 'warehouse_receipts', wrId), { dispatch_status: null })),
          ...added.map(wrId => updateDoc(doc(db, 'warehouse_receipts', wrId), {
            dispatch_status: partialWrIds.has(wrId) ? 'partial' : 'reserved',
          })),
        ])
      } else {
        await addDoc(collection(db, 'dispatches'), dispatchData)
        // Mark WRs as reserved or partial
        await Promise.all([...selectedWRIds].map(wrId =>
          updateDoc(doc(db, 'warehouse_receipts', wrId), {
            dispatch_status: partialWrIds.has(wrId) ? 'partial' : 'reserved',
          })
        ))
      }
      navigate('/dispatches')
    } catch (e: any) {
      setError(e.message || 'Error al guardar.')
    }
    setSaving(false)
  }

  async function handleGateOut(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const isRedispatch = (existingDispatch?.return_events || []).length > 0

    if (!isRedispatch && !sealNumber) { setError('Ingresa el número de sello.'); return }
    if (!isRedispatch && !sealPhotoFile) { setError('Toma la foto del sello.'); return }
    if (!isRedispatch && !containerPhotoFile) { setError('Toma la foto del contenedor.'); return }

    setSaving(true)
    try {
      async function toBase64(file: File): Promise<string> {
        return new Promise((resolve, reject) => {
          const img = new Image()
          const url = URL.createObjectURL(file)
          img.onload = () => {
            const MAX = 700
            let { width, height } = img
            if (width > MAX || height > MAX) {
              if (width > height) { height = Math.round(height * MAX / width); width = MAX }
              else { width = Math.round(width * MAX / height); height = MAX }
            }
            const canvas = document.createElement('canvas')
            canvas.width = width; canvas.height = height
            canvas.getContext('2d')!.drawImage(img, 0, 0, width, height)
            URL.revokeObjectURL(url)
            resolve(canvas.toDataURL('image/jpeg', 0.75))
          }
          img.onerror = reject
          img.src = url
        })
      }

      const gateOutAt = new Date().toISOString()
      const useSeal = isRedispatch ? (existingDispatch!.seal_number || '') : sealNumber

      if (isRedispatch) {
        // Re-dispatch: update driver info + optional driver photo, keep seal/container photos
        const driverPhotoB64 = photoFile ? await toBase64(photoFile) : ''
        const updateData: Record<string, any> = {
          gate_driver_name:    driverName,
          gate_driver_license: driverLicense,
          gate_out_at:         gateOutAt,
          status:              'gate_out',
        }
        if (driverPhotoB64) updateData.gate_driver_photo_url = driverPhotoB64
        await updateDoc(doc(db, 'dispatches', id!), updateData)
      } else {
        // First dispatch: full gate out data
        const [driverPhotoB64, sealPhotoB64, containerPhotoB64] = await Promise.all([
          photoFile          ? toBase64(photoFile)          : Promise.resolve(''),
          sealPhotoFile      ? toBase64(sealPhotoFile)      : Promise.resolve(''),
          containerPhotoFile ? toBase64(containerPhotoFile) : Promise.resolve(''),
        ])

        await updateDoc(doc(db, 'dispatches', id!), {
          seal_number:           sealNumber,
          seal_photo_url:        sealPhotoB64      || null,
          container_photo_url:   containerPhotoB64 || null,
          gate_driver_name:      driverName,
          gate_driver_license:   driverLicense,
          gate_driver_photo_url: driverPhotoB64    || null,
          gate_out_at:           gateOutAt,
          status:                'gate_out',
        })
      }

      // Mark WRs as dispatched (or keep 'partial' if partially allocated)
      if (existingDispatch?.wr_ids?.length) {
        const partialWrIdsGate = new Set<string>(existingDispatch.partial_wr_ids || [])
        await Promise.all(existingDispatch.wr_ids.map(wrId =>
          updateDoc(doc(db, 'warehouse_receipts', wrId), {
            dispatch_status:          partialWrIdsGate.has(wrId) ? 'partial' : 'dispatched',
            container_number:         existingDispatch.container_number,
            dispatched_at:            gateOutAt,
            dispatch_booking_number:  existingDispatch.booking_number,
            dispatch_seal_number:     useSeal,
            dispatch_driver_name:     driverName,
          })
        ))
      }

      // Calculate dispatch billing charges only on first dispatch (not re-dispatch)
      if (existingDispatch && !isRedispatch) {
        try {
          await calculateDispatchCharges(existingDispatch, gateOutAt)
        } catch (billingErr) {
          console.error('Dispatch billing error:', billingErr)
          alert('Warning: Dispatch saved but billing charges failed to generate. Please notify accounting to review this dispatch.')
        }
      }

      navigate('/dispatches')
    } catch (e: any) {
      setError(e.message || 'Error al guardar.')
    }
    setSaving(false)
  }

  // ── Gate-out form / view ────────────────────────────────────────────
  if (isConfirm) {
    const d = existingDispatch
    const isRedispatch = (d?.return_events || []).length > 0
    const isAlreadyGateOut = d?.status === 'gate_out'

    return (
      <Layout title={isAlreadyGateOut ? 'Detalle Gate Out' : isRedispatch ? 'Re-Despacho Gate Out' : 'Confirmar Gate Out'} backTo="/dispatches">
        {!d ? (
          <div className="p-8 text-center text-gray-400">Cargando...</div>
        ) : isAlreadyGateOut ? (
          /* ── Read-only view of completed gate out ── */
          <div className="max-w-lg mx-auto space-y-4">
            <div className="bg-white rounded-xl border border-green-200 shadow-sm p-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="inline-flex items-center gap-1 bg-green-100 text-green-700 text-xs px-2 py-0.5 rounded-full font-medium">✓ Gate Out</span>
                <span className="text-xs text-gray-400">{formatGateOutDate(d.gate_out_at)}</span>
              </div>
              <p className="font-bold text-mcl-blue font-mono text-lg">{d.container_size === 'LCL' ? 'LCL' : `${d.container_number || '—'} · ${d.container_size}'`}</p>
              <p className="text-sm text-gray-600">{d.naviera === 'Otra' ? d.naviera_other : d.naviera}</p>
              <p className="text-xs text-gray-500 mt-1">Booking: <span className="font-semibold">{d.booking_number}</span></p>
              <p className="text-xs text-gray-400 mt-0.5">WRs: {d.wr_numbers?.join(', ')}</p>
              <p className="text-xs text-gray-400">POs: {d.po_numbers?.join(', ')}</p>
              {d.po_numbers?.some(po => scheduleByPO[po]) && (
                <p className="text-xs text-gray-400">Schedule: {d.po_numbers.map(po => scheduleByPO[po] || '—').join(', ')}</p>
              )}
            </div>

            <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 space-y-3">
              <h3 className="font-semibold text-gray-700 text-sm">Datos Gate Out</h3>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p className="text-xs text-gray-400 uppercase">Sello</p>
                  <p className="font-semibold text-gray-700">{d.seal_number || '—'}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400 uppercase">Chofer</p>
                  <p className="font-semibold text-gray-700">{d.gate_driver_name || '—'}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400 uppercase">Licencia</p>
                  <p className="font-semibold text-gray-700">{d.gate_driver_license || '—'}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400 uppercase">Transporte</p>
                  <p className="font-semibold text-gray-700">{d.transport_company || '—'}</p>
                </div>
              </div>

              {/* Photos */}
              <div className="space-y-3 pt-2">
                {d.seal_photo_url && (
                  <div>
                    <p className="text-xs text-gray-400 uppercase mb-1">Foto Sello</p>
                    <img src={d.seal_photo_url} alt="Sello" className="rounded-lg border border-gray-200 max-h-48 object-contain" />
                  </div>
                )}
                {d.container_photo_url && (
                  <div>
                    <p className="text-xs text-gray-400 uppercase mb-1">Foto Contenedor</p>
                    <img src={d.container_photo_url} alt="Contenedor" className="rounded-lg border border-gray-200 max-h-48 object-contain" />
                  </div>
                )}
                {d.gate_driver_photo_url && (
                  <div>
                    <p className="text-xs text-gray-400 uppercase mb-1">Foto Licencia Chofer</p>
                    <img src={d.gate_driver_photo_url} alt="Licencia" className="rounded-lg border border-gray-200 max-h-48 object-contain" />
                  </div>
                )}
              </div>
            </div>

            {/* Totals */}
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
              <h3 className="font-semibold text-gray-700 text-sm mb-2">Carga</h3>
              <div className="flex flex-wrap gap-4 text-sm">
                <span className="text-gray-500">Piezas: <strong>{fmtNum(d.total_qty)}</strong></span>
                <span className="text-gray-500">CBM: <strong>{fmtNum(d.total_cbm, 4)}</strong></span>
                <span className="text-gray-500">KG: <strong>{fmtNum(d.total_kg, 1)}</strong></span>
              </div>
            </div>
          </div>
        ) : (
          /* ── Gate out form (not yet dispatched) ── */
          <div className="max-w-lg mx-auto">
            {/* Summary */}
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 mb-6">
              <p className="text-xs text-gray-400 uppercase tracking-wide mb-2">Consolidado</p>
              <p className="font-bold text-mcl-blue font-mono">{d.container_size === 'LCL' ? 'LCL' : `${d.container_number || '—'} · ${d.container_size}'`} <span className="text-gray-800 text-base">Booking: {d.booking_number || '—'}</span></p>
              <p className="text-sm text-gray-600">{d.naviera === 'Otra' ? d.naviera_other : d.naviera}</p>
              {d.booking_request_li && <p className="text-xs text-gray-400 mt-1">Booking Request LI: {d.booking_request_li}</p>}
              <p className="text-xs text-gray-400 mt-1">WRs: {d.wr_numbers?.join(', ')}</p>
              {d.po_numbers?.some(po => scheduleByPO[po]) && (
                <p className="text-xs text-gray-400">Schedule: {d.po_numbers.map(po => scheduleByPO[po] || '—').join(', ')}</p>
              )}
              {isRedispatch && (
                <div className="mt-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <p className="text-xs text-amber-700 font-semibold">Re-consolidado #{d.return_events!.length + 1}</p>
                  <p className="text-xs text-amber-600">Sello y fotos del consolidado anterior se mantienen.</p>
                  {d.seal_number && (
                    <p className="text-xs text-gray-500 mt-1">Sello: <span className="font-semibold">{d.seal_number}</span></p>
                  )}
                </div>
              )}
            </div>

            <form onSubmit={handleGateOut} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 space-y-4">
              <h3 className="font-semibold text-gray-700 text-sm">Datos Gate Out</h3>

              {!isRedispatch && (
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Número de Sello *</label>
                  <div className="flex gap-2">
                    <input
                      required
                      type="text"
                      value={sealNumber}
                      onChange={e => setSealNumber(e.target.value)}
                      placeholder="Ej: MCL-00123"
                      className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                    />
                    <input ref={sealPhotoInputRef} type="file" accept="image/*" capture="environment"
                      onChange={e => setSealPhotoFile(e.target.files?.[0] || null)} className="hidden" />
                    <button type="button" onClick={() => sealPhotoInputRef.current?.click()}
                      title="Foto del sello"
                      className={`flex-shrink-0 flex items-center gap-1 border rounded-lg px-3 py-2 text-sm transition-colors ${sealPhotoFile ? 'border-green-400 bg-green-50 text-green-600' : 'border-gray-200 text-gray-400 hover:bg-gray-50'}`}>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                      {sealPhotoFile ? '✓' : 'Foto'}
                    </button>
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Nombre del Chofer</label>
                <input
                  type="text"
                  value={driverName}
                  onChange={e => setDriverName(e.target.value)}
                  placeholder="Nombre completo"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Número de Licencia</label>
                <input
                  type="text"
                  value={driverLicense}
                  onChange={e => setDriverLicense(e.target.value)}
                  placeholder="Número de licencia"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Foto Licencia del Chofer</label>
                <input ref={photoInputRef} type="file" accept="image/*" capture="environment"
                  onChange={e => setPhotoFile(e.target.files?.[0] || null)} className="hidden" />
                <button type="button" onClick={() => photoInputRef.current?.click()}
                  className={`flex items-center gap-2 border rounded-lg px-3 py-2 text-sm transition-colors ${photoFile ? 'border-green-400 bg-green-50 text-green-600' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  {photoFile ? `✓ ${photoFile.name}` : 'Tomar / Adjuntar Foto'}
                </button>
              </div>

              {!isRedispatch && (
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Foto del Contenedor</label>
                  <input ref={containerPhotoInputRef} type="file" accept="image/*" capture="environment"
                    onChange={e => setContainerPhotoFile(e.target.files?.[0] || null)} className="hidden" />
                  <button type="button" onClick={() => containerPhotoInputRef.current?.click()}
                    className={`flex items-center gap-2 border rounded-lg px-3 py-2 text-sm transition-colors ${containerPhotoFile ? 'border-green-400 bg-green-50 text-green-600' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    {containerPhotoFile ? `✓ ${containerPhotoFile.name}` : 'Tomar / Adjuntar Foto'}
                  </button>
                </div>
              )}

              {error && <p className="text-red-500 text-sm">{error}</p>}

              <button
                type="submit"
                disabled={saving}
                className="w-full bg-orange-500 text-white font-semibold py-3 rounded-xl hover:bg-orange-600 transition-colors disabled:opacity-50"
              >
                {saving ? 'Guardando...' : isRedispatch ? 'Confirmar Re-Despacho' : 'Confirmar Gate Out'}
              </button>
            </form>
          </div>
        )}
      </Layout>
    )
  }

  // ── Booking form ─────────────────────────────────────────────────────
  const isReadOnly = isEdit && viewMode
  const inputClass = `w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30 ${isReadOnly ? 'bg-gray-50 text-gray-500 cursor-not-allowed' : 'bg-white'}`
  const labelClass = 'block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1'

  return (
    <Layout title={isEdit ? (isReadOnly ? 'Ver Consolidado' : 'Editar Consolidado') : 'Nuevo Consolidado'} backTo="/dispatches">
      {/* Abrir Consolidado button */}
      {isReadOnly && canEdit && (
        <div className="max-w-2xl mx-auto mb-4">
          <button
            type="button"
            onClick={() => setViewMode(false)}
            className="flex items-center gap-2 bg-mcl-blue text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-800 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            Abrir Consolidado
          </button>
        </div>
      )}
      <form onSubmit={handleBooking} className="space-y-5 max-w-2xl mx-auto">

        {/* Container info */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <h3 className="font-semibold text-gray-700 text-sm mb-4">Información del Contenedor</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Booking Request LI</label>
              <input value={bookingRequestLI} onChange={e => setBookingRequestLI(e.target.value)}
                placeholder="Ej: MCL-2026-001" className={inputClass} disabled={isReadOnly} />
            </div>
            <div>
              <label className={labelClass}>Booking # Naviera *</label>
              <input required value={bookingNumber} onChange={e => setBookingNumber(e.target.value)}
                placeholder="Ej: 30179215" className={inputClass} disabled={isReadOnly} />
            </div>
            <div>
              <label className={labelClass}>Número de Contenedor</label>
              <input value={isLCL ? '' : containerNumber} onChange={e => setContainerNumber(e.target.value.toUpperCase())}
                placeholder={isLCL ? 'N/A (LCL)' : 'Ej: MSCU1234567'} className={inputClass} disabled={isReadOnly || isLCL} />
            </div>
            <div>
              <label className={labelClass}>Tamaño</label>
              <select value={containerSize} onChange={e => {
                const v = e.target.value
                setContainerSize(v)
                if (v === 'LCL') {
                  setLoadingType(null)
                  setHasDrayage(false)
                  setHasHazmat(false)
                  setContainerNumber('')
                } else if (containerSize === 'LCL') {
                  setLoadingType('forklift')
                  setHasDrayage(true)
                }
              }} className={inputClass} disabled={isReadOnly}>
                {CONTAINER_SIZES.map(s => <option key={s} value={s}>{s === 'LCL' ? 'LCL' : s + "'"}</option>)}
              </select>
            </div>
            <div>
              <label className={labelClass}>Naviera</label>
              <select value={naviera} onChange={e => setNaviera(e.target.value)} className={inputClass} disabled={isReadOnly}>
                {NAVIERAS.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
              {naviera === 'Otra' && (
                <input value={navieraOther} onChange={e => setNavieraOther(e.target.value)}
                  placeholder="Especificar naviera" className={inputClass + ' mt-2'} disabled={isReadOnly} />
              )}
            </div>
            <div>
              <label className={labelClass}>Empresa de Transporte</label>
              <input value={transportCompany} onChange={e => setTransportCompany(e.target.value)}
                placeholder="Nombre del transportista" className={inputClass} disabled={isReadOnly} />
            </div>
            <div>
              <label className={labelClass}>Fecha/Hora Programada *</label>
              <input required type="datetime-local" value={scheduledAt} onChange={e => setScheduledAt(e.target.value)}
                className={inputClass} disabled={isReadOnly} />
            </div>
          </div>
        </div>

        {/* Billing options */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <h3 className="font-semibold text-gray-700 text-sm mb-4">Opciones de Facturación</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {/* Loading type */}
            <div>
              <label className={labelClass}>Tipo de Carga</label>
              <div className="flex rounded-lg overflow-hidden border border-gray-200 h-[38px]">
                <button type="button" onClick={() => !isReadOnly && !isLCL && setLoadingType('forklift')}
                  className={`flex-1 text-xs font-semibold transition-colors ${isLCL ? 'bg-gray-100 text-gray-300 cursor-not-allowed' : loadingType === 'forklift' ? 'bg-mcl-blue text-white' : 'bg-white text-gray-400 hover:bg-gray-50'} ${isReadOnly ? 'cursor-not-allowed opacity-70' : ''}`}
                  disabled={isLCL}>
                  Forklift
                </button>
                <button type="button" onClick={() => !isReadOnly && !isLCL && setLoadingType('by_hand')}
                  className={`flex-1 text-xs font-semibold border-l border-gray-200 transition-colors ${isLCL ? 'bg-gray-100 text-gray-300 cursor-not-allowed' : loadingType === 'by_hand' ? 'bg-mcl-blue text-white' : 'bg-white text-gray-400 hover:bg-gray-50'} ${isReadOnly ? 'cursor-not-allowed opacity-70' : ''}`}
                  disabled={isLCL}>
                  By Hand
                </button>
              </div>
              {isLCL && <p className="text-[10px] text-gray-400 mt-1">No aplica para LCL</p>}
            </div>
            {/* Drayage */}
            <div>
              <label className={labelClass}>Drayage</label>
              <div className="flex rounded-lg overflow-hidden border border-gray-200 h-[38px]">
                <button type="button" onClick={() => !isReadOnly && !isLCL && setHasDrayage(true)}
                  className={`flex-1 text-xs font-semibold transition-colors ${isLCL ? 'bg-gray-100 text-gray-300 cursor-not-allowed' : hasDrayage ? 'bg-mcl-blue text-white' : 'bg-white text-gray-400 hover:bg-gray-50'} ${isReadOnly ? 'cursor-not-allowed opacity-70' : ''}`}
                  disabled={isLCL}>
                  Aplica
                </button>
                <button type="button" onClick={() => { if (!isReadOnly && !isLCL) { setHasDrayage(false); setHasHazmat(false) } }}
                  className={`flex-1 text-xs font-semibold border-l border-gray-200 transition-colors ${isLCL ? 'bg-gray-100 text-gray-300 cursor-not-allowed' : !hasDrayage ? 'bg-gray-500 text-white' : 'bg-white text-gray-400 hover:bg-gray-50'} ${isReadOnly ? 'cursor-not-allowed opacity-70' : ''}`}
                  disabled={isLCL}>
                  No Aplica
                </button>
              </div>
              {isLCL && <p className="text-[10px] text-gray-400 mt-1">No aplica para LCL</p>}
            </div>
            {/* Hazmat */}
            <div>
              <label className={labelClass}>Hazmat / DG</label>
              <div className="flex rounded-lg overflow-hidden border border-gray-200 h-[38px]">
                <button type="button" onClick={() => !isReadOnly && setHasHazmat(false)}
                  className={`flex-1 text-xs font-semibold transition-colors ${!hasHazmat ? 'bg-mcl-blue text-white' : 'bg-white text-gray-400 hover:bg-gray-50'} ${isReadOnly ? 'cursor-not-allowed opacity-70' : ''}`}
                  disabled={!hasDrayage}>
                  No
                </button>
                <button type="button" onClick={() => !isReadOnly && setHasHazmat(true)}
                  className={`flex-1 text-xs font-semibold border-l border-gray-200 transition-colors ${hasHazmat ? 'bg-red-500 text-white' : 'bg-white text-gray-400 hover:bg-gray-50'} disabled:opacity-40 ${isReadOnly ? 'cursor-not-allowed opacity-70' : ''}`}
                  disabled={!hasDrayage}>
                  Sí (+$100)
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* WR Selection */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <h3 className="font-semibold text-gray-700 text-sm mb-3">Selección de Carga</h3>

          {loadingWRs ? (
            <div className="py-6 text-center">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-mcl-blue mx-auto" />
            </div>
          ) : availableWRs.length === 0 ? (
            <p className="text-sm text-gray-400 py-4 text-center">No hay WRs disponibles para despachar.</p>
          ) : (
            <div className="space-y-4">
              {Object.entries(byDest).sort().map(([dest, poMap]) => {
                const destWRs    = Object.values(poMap).flat()
                const allDestSel = destWRs.every(w => selectedWRIds.has(w.id!))
                const someDestSel= destWRs.some(w => selectedWRIds.has(w.id!))

                return (
                  <div key={dest}>
                    {/* Destination header */}
                    <div
                      className={`flex items-center gap-2 mb-1.5 select-none ${isReadOnly ? 'cursor-default' : 'cursor-pointer'}`}
                      onClick={() => !isReadOnly && toggleDest(dest)}
                    >
                      <input
                        type="checkbox"
                        checked={allDestSel}
                        ref={el => { if (el) el.indeterminate = !allDestSel && someDestSel }}
                        onChange={() => !isReadOnly && toggleDest(dest)}
                        onClick={e => e.stopPropagation()}
                        className="w-4 h-4 accent-mcl-blue"
                        disabled={isReadOnly}
                      />
                      <span className="text-xs font-bold uppercase tracking-widest text-mcl-blue bg-mcl-blue/10 px-2 py-0.5 rounded">{dest}</span>
                      <span className="text-xs text-gray-400">{destWRs.reduce((s,w)=>s+w.totalQty,0)} pzas · {fmtNum(destWRs.reduce((s,w)=>s+w.totalCBM,0), 4)} CBM</span>
                    </div>

                    {/* One row per PO */}
                    <div className="border border-gray-100 rounded-lg divide-y divide-gray-50 overflow-hidden">
                      {Object.entries(poMap).sort().map(([po, wrs]) => {
                        const allSel  = wrs.every(w => selectedWRIds.has(w.id!))
                        const someSel = wrs.some(w => selectedWRIds.has(w.id!))
                        const anyPartial = wrs.some(w => isPartialWR(w.id!))
                        const anyRemainingPartial = wrs.some(w => w.remainingLines && w.remainingLines.size > 0)
                        // Show effective totals (considering partials in this dispatch)
                        const poPieces = wrs.reduce((s, w) => s + (selectedWRIds.has(w.id!) ? getEffectiveTotals(w).qty : w.totalQty), 0)
                        const poCBM    = wrs.reduce((s, w) => s + (selectedWRIds.has(w.id!) ? getEffectiveTotals(w).cbm : w.totalCBM), 0)
                        const vendor    = toTitleCase(wrs[0]?.company_name) || '—'
                        const consignee = toTitleCase(wrs[0]?.consignee?.name) || '—'
                        const schedule  = scheduleByPO[po] || ''
                        const oldestCreated = wrs.reduce((oldest, w) => {
                          const ca = w.created_at || ''
                          return ca && ca < oldest ? ca : oldest
                        }, wrs[0]?.created_at || '')
                        const storageTag = oldestCreated ? getStorageTag(oldestCreated) : null

                        return (
                          <div
                            key={po}
                            className={`flex items-center gap-3 px-3 py-2.5 transition-colors ${isReadOnly ? 'cursor-default' : 'cursor-pointer hover:bg-gray-50'} ${allSel ? 'bg-mcl-blue/5' : ''}`}
                            onClick={() => !isReadOnly && togglePO(po)}
                          >
                            <input
                              type="checkbox"
                              checked={allSel}
                              ref={el => { if (el) el.indeterminate = !allSel && someSel }}
                              onChange={() => !isReadOnly && togglePO(po)}
                              onClick={e => e.stopPropagation()}
                              className="w-4 h-4 accent-mcl-blue flex-shrink-0"
                              disabled={isReadOnly}
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-semibold text-sm text-gray-800">{po}</span>
                                <span className="text-xs text-gray-400 hidden sm:inline">·</span>
                                <span className="text-xs text-gray-500 truncate hidden sm:inline">{vendor}</span>
                                <span className="text-xs text-gray-300 hidden sm:inline">→</span>
                                <span className="text-xs text-gray-600 font-medium truncate hidden sm:inline">{consignee}</span>
                                {schedule && <span className="text-[10px] font-mono text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded">Sch: {schedule}</span>}
                                {storageTag && <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${storageTag.cls}`}>{storageTag.text}</span>}
                                {anyPartial && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-orange-100 text-orange-700">PARCIAL</span>}
                                {anyRemainingPartial && !anyPartial && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">PARCIAL PREVIO</span>}
                              </div>
                              <div className="sm:hidden text-xs text-gray-400 mt-0.5 truncate">{vendor} → {consignee}</div>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              {!isReadOnly && (
                                <button
                                  type="button"
                                  title="Parcializar"
                                  onClick={e => { e.stopPropagation(); openPartialPanel(wrs[0]) }}
                                  className="p-1 rounded hover:bg-orange-50 text-gray-400 hover:text-orange-600 transition-colors"
                                >
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12M8 12h8m-8 5h4M4 7v0m0 5v0m0 5v0" />
                                  </svg>
                                </button>
                              )}
                              <div className="text-xs text-gray-400 text-right">
                                <span className="font-semibold text-gray-600">{Math.round(poPieces)} pzas</span>
                                <span className="ml-2">{fmtNum(poCBM, 4)} CBM</span>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Selection totals */}
          {selectedWRIds.size > 0 && (
            <div className="mt-4 pt-3 border-t border-gray-100 flex flex-wrap gap-4 text-sm">
              <span className="text-gray-500">POs: <strong className="text-mcl-blue">{[...new Set(selectedWRs.map(w => w.po_number))].length}</strong></span>
              <span className="text-gray-500">Piezas: <strong className="text-gray-700">{fmtNum(totalQtySel)}</strong></span>
              <span className="text-gray-500">CBM: <strong className="text-gray-700">{fmtNum(totalCBMSel, 4)}</strong></span>
              <span className="text-gray-500">KG: <strong className="text-gray-700">{fmtNum(totalKGSel, 1)}</strong></span>
            </div>
          )}
        </div>

        {error && <p className="text-red-500 text-sm text-center">{error}</p>}

        {!isReadOnly && (
          <button
            type="submit"
            disabled={saving || selectedWRIds.size === 0}
            className="w-full bg-mcl-blue text-white font-semibold py-3 rounded-xl hover:bg-blue-800 transition-colors disabled:opacity-50"
          >
            {saving ? 'Guardando...' : isEdit ? 'Guardar Cambios' : 'Crear Reserva de Consolidación'}
          </button>
        )}

        {isEdit && existingDispatch && (
          <Link
            to={`/dispatches/${id}/confirm`}
            className="block w-full text-center bg-orange-500 text-white font-semibold py-3 rounded-xl hover:bg-orange-600 transition-colors"
          >
            {existingDispatch.status === 'gate_out' ? 'Ver Gate Out' : 'Confirmar Gate Out'}
          </Link>
        )}
      </form>

      {/* ── Partial allocation modal ────────────────────────────────── */}
      {partialPanelWR && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setPartialPanelWR(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="px-5 py-4 border-b border-gray-100">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-bold text-gray-800">Parcializar PO</h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {partialPanelWR.po_number} — {partialPanelWR.wr_number || partialPanelWR.id}
                  </p>
                </div>
                <button type="button" onClick={() => setPartialPanelWR(null)} className="text-gray-400 hover:text-gray-600">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Lines */}
            <div className="flex-1 overflow-y-auto px-5 py-3 space-y-3">
              {partialPanelWR.lines.map((line, idx) => {
                if (!line.id) return null
                const avail = partialPanelWR.remainingLines?.get(line.id)?.remaining ?? line.qty ?? 0
                const alloc = panelAllocations.get(line.id)
                const qty = alloc?.qty ?? 0
                const note = alloc?.note ?? ''
                return (
                  <div key={line.id} className="border border-gray-100 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-gray-500">#{idx + 1}</span>
                        <span className="text-sm font-semibold text-gray-700">{line.packing_type}</span>
                        {line.has_lb && <span className="text-[10px] bg-yellow-100 text-yellow-700 px-1 rounded">LB</span>}
                        {line.is_dg && <span className="text-[10px] bg-red-100 text-red-700 px-1 rounded">DG</span>}
                      </div>
                      <span className="text-xs text-gray-400">
                        {avail < (line.qty || 0)
                          ? <>{avail} disponible de {line.qty}</>
                          : <>{line.qty} pza{(line.qty || 0) !== 1 ? 's' : ''}</>
                        }
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-gray-500 mb-2">
                      {line.cbm != null && <span>{fmtNum(line.cbm, 4)} CBM</span>}
                      {line.weight_kg != null && <span>{fmtNum(line.weight_kg, 1)} kg</span>}
                      {line.location && <span>Loc: {line.location}</span>}
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-gray-500 whitespace-nowrap">Enviar:</label>
                        <input
                          type="number"
                          min={0}
                          max={avail}
                          value={qty}
                          onChange={e => {
                            const v = Math.min(Math.max(0, parseInt(e.target.value) || 0), avail)
                            setPanelAllocations(prev => {
                              const next = new Map(prev)
                              next.set(line.id!, { qty: v, note: next.get(line.id!)?.note || '' })
                              return next
                            })
                          }}
                          className="w-16 border border-gray-200 rounded px-2 py-1 text-sm text-center focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                        />
                        <span className="text-xs text-gray-400">/ {avail}</span>
                      </div>
                      <input
                        type="text"
                        placeholder="Nota (SKUs, detalle...)"
                        value={note}
                        onChange={e => {
                          setPanelAllocations(prev => {
                            const next = new Map(prev)
                            next.set(line.id!, { qty: next.get(line.id!)?.qty || 0, note: e.target.value })
                            return next
                          })
                        }}
                        className="flex-1 border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                      />
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Footer with totals and confirm */}
            <div className="px-5 py-4 border-t border-gray-100">
              {(() => {
                let tQty = 0, tCbm = 0, tKg = 0
                for (const line of partialPanelWR.lines) {
                  const a = panelAllocations.get(line.id!)
                  if (!a || a.qty <= 0) continue
                  const ratio = (line.qty || 0) > 0 ? a.qty / line.qty : 0
                  tQty += a.qty
                  tCbm += (line.cbm || 0) * ratio
                  tKg += (line.weight_kg || 0) * ratio
                }
                return (
                  <div className="flex items-center justify-between mb-3 text-sm">
                    <span className="text-gray-500">Seleccionado:</span>
                    <span className="font-semibold text-gray-700">{tQty} pzas · {fmtNum(tCbm, 4)} CBM · {fmtNum(tKg, 1)} kg</span>
                  </div>
                )
              })()}
              <button
                type="button"
                onClick={confirmPartialPanel}
                className="w-full bg-orange-500 text-white font-semibold py-2.5 rounded-xl hover:bg-orange-600 transition-colors"
              >
                Confirmar Parcialización
              </button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}
