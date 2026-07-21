import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { doc, onSnapshot, updateDoc, getDoc, collection, getDocs, deleteDoc, query, where, addDoc } from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import Layout from '../../components/Layout'
import type { WSServiceOrder, WSServiceItem, WSGlobalStatus, WSServiceItemStatus, WSCargoType, WSCargoMode, WSDocFile, WarehouseReceipt, DeliveryOrder, WSDeliveryTracking, WSDeliveryOrder } from '../../types'
import { buildCcsfPdfBuffer } from '../../lib/deliveryOrder'
import { calculatePOSCharges, calculateTransportCharge } from '../../lib/wsBilling'
import type { CargoData } from '../../lib/wsBilling'
import { createWSDeliveryOrder, buildMilestoneKeys } from '../../lib/wsTransportTracking'

const STATUS_LABELS: Record<WSGlobalStatus, string> = {
  requested: 'Requested',
  checked_in: 'Check-in',
  received: 'Received',
  in_progress: 'In Progress',
  completed: 'Completed',
  billed: 'Billed',
}

const STATUS_COLORS: Record<WSGlobalStatus, string> = {
  requested: 'bg-gray-100 text-gray-700',
  checked_in: 'bg-yellow-100 text-yellow-800',
  received: 'bg-blue-100 text-blue-800',
  in_progress: 'bg-orange-100 text-orange-800',
  completed: 'bg-green-100 text-green-800',
  billed: 'bg-purple-100 text-purple-800',
}

const SERVICE_LABELS: Record<string, string> = {
  screening_k9: 'Screening K9',
  screening_xray: 'Screening X-Ray',
  screening_manual: 'Screening Manual',
  transport: 'Transport',
  storage: 'Storage',
  in_out: 'In/Out',
  repack: 'Repack',
  dg_inspection: 'DG Inspection',
  handling_storage_fee: 'Handling & Storage Fee',
  breakdown_bup: 'Breakdown BUP',
}

const ITEM_STATUS_LABELS: Record<WSServiceItemStatus, string> = {
  pending: 'Pending',
  scheduled: 'Scheduled',
  in_progress: 'In Progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  fail: 'Failed',
}

const ITEM_STATUS_COLORS: Record<WSServiceItemStatus, string> = {
  pending: 'bg-gray-100 text-gray-600',
  scheduled: 'bg-blue-100 text-blue-700',
  in_progress: 'bg-orange-100 text-orange-700',
  completed: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-600',
  fail: 'bg-red-200 text-red-800',
}

const CARGO_TYPES: { value: WSCargoType; label: string }[] = [
  { value: 'GENERAL', label: 'General' },
  { value: 'SPECIAL', label: 'Special Cargo' },
  { value: 'DG', label: 'Dangerous Goods' },
  { value: 'PERISHABLE', label: 'Perishable' },
  { value: 'OVERSIZE', label: 'Oversize' },
  { value: 'OTHER', label: 'Other' },
]

const SERVICE_OPTIONS: { type: string; label: string; group: string }[] = [
  { type: 'screening_k9', label: 'Screening K9', group: 'Screening' },
  { type: 'screening_xray', label: 'Screening X-Ray', group: 'Screening' },
  { type: 'screening_manual', label: 'Screening Manual', group: 'Screening' },
  { type: 'transport', label: 'Transport', group: 'Transport' },
  { type: 'storage', label: 'Storage', group: 'Warehouse' },
  { type: 'in_out', label: 'In/Out', group: 'Warehouse' },
  { type: 'repack', label: 'Repack', group: 'Warehouse' },
  { type: 'dg_inspection', label: 'DG Inspection', group: 'Warehouse' },
  { type: 'breakdown_bup', label: 'Breakdown BUP', group: 'Warehouse' },
]

function deriveGlobalStatus(order: WSServiceOrder): WSGlobalStatus {
  if (order.global_status === 'billed') return 'billed'
  // If POS confirmed → completed (regardless of item statuses)
  if (order.pod_at) return 'completed'
  const items = order.service_items
  if (items.length === 0) return order.global_status
  const allDone = items.every(i => i.status === 'completed' || i.status === 'cancelled' || i.status === 'fail')
  if (allDone) return 'completed'
  const anyInProgress = items.some(i => i.status === 'in_progress' || i.status === 'scheduled')
  const anyCompleted = items.some(i => i.status === 'completed')
  if (anyInProgress || anyCompleted) return 'in_progress'
  if (order.received_at) return 'received'
  if (order.checked_in_at) return 'checked_in'
  return 'requested'
}

function getDocSlots(order: WSServiceOrder) {
  const base: { key: string; label: string }[] = [
    { key: 'doc_pl', label: 'Packing List' },
    { key: 'doc_inv', label: 'Commercial Invoice' },
    { key: 'doc_sds', label: 'SDS' },
    { key: 'doc_bl', label: 'Bill of Lading' },
  ]
  if (order.cargo_mode === 'BOND') {
    base.push({ key: 'doc_7512', label: '7512' })
  }
  if (order.awb_number) {
    base.push(
      { key: 'doc_tsa_letter', label: 'TSA Letter' },
      { key: 'doc_do', label: 'Delivery Order' },
      { key: 'doc_awb', label: 'AWB' },
    )
    if (order.cargo_type === 'DG') {
      base.push({ key: 'doc_shipper_dg', label: 'Shipper Declaration DDGG' })
    }
    // LB checklist: show if any service item has battery-related needs or always for safety
    base.push({ key: 'doc_lb_checklist', label: 'LB Checklist' })
    // CCSF Final: if SO has screening service
    if (order.service_items.some(s => s.type.startsWith('screening_') || s.type === 'dg_inspection')) {
      base.push({ key: 'doc_ccsf_final', label: 'CCSF Final' })
    }
  }
  return base
}

export default function WSOrderDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user, canEdit, isAdmin, isSuperAgent, isAccounting, isAgent } = useAuth()

  const [order, setOrder] = useState<WSServiceOrder | null>(null)
  const [loading, setLoading] = useState(true)

  // WR physical data
  const [wrData, setWrData] = useState<WarehouseReceipt | null>(null)

  // Check-in panel state
  const [showCheckIn, setShowCheckIn] = useState(false)
  const [ciPieces, setCiPieces] = useState('')
  const [ciWeight, setCiWeight] = useState('')
  const [ciCargoType, setCiCargoType] = useState<WSCargoType>('GENERAL')
  const [ciCargoMode, setCiCargoMode] = useState<WSCargoMode>('LOC')
  const [ciCargoDesc, setCiCargoDesc] = useState('')
  const [ciAwb, setCiAwb] = useState('')
  const [ciReference, setCiReference] = useState('')
  const [ciDriverName, setCiDriverName] = useState('')
  const [ciDriverLicense, setCiDriverLicense] = useState('')
  const [ciSaving, setCiSaving] = useState(false)

  // Edit mode
  const [editing, setEditing] = useState(false)
  const [edAwb, setEdAwb] = useState('')
  const [edReference, setEdReference] = useState('')
  const [edPieces, setEdPieces] = useState('')
  const [edWeight, setEdWeight] = useState('')
  const [edCargoType, setEdCargoType] = useState<WSCargoType>('GENERAL')
  const [edCargoMode, setEdCargoMode] = useState<WSCargoMode>('LOC')
  const [edCargoDesc, setEdCargoDesc] = useState('')
  const [edNotes, setEdNotes] = useState('')
  const [edDriverName, setEdDriverName] = useState('')
  const [edDriverLicense, setEdDriverLicense] = useState('')
  const [edServices, setEdServices] = useState<Set<string>>(new Set())
  const [edSaving, setEdSaving] = useState(false)
  // Transport-only edit
  const [edTransportType, setEdTransportType] = useState<'bup' | 'loose'>('loose')
  const [edBupCount, setEdBupCount] = useState('')
  const [edUldNumbers, setEdUldNumbers] = useState<string[]>([])
  const [edPickupFrom, setEdPickupFrom] = useState('')
  const [edDeliverTo, setEdDeliverTo] = useState('')
  const [edExtraStops, setEdExtraStops] = useState<string[]>([])
  const [edCargoLines, setEdCargoLines] = useState<{ id: string; awb: string; reference: string; pieces: number; weight_kg: number; note: string }[]>([])

  // Service item edit
  const [editingItemId, setEditingItemId] = useState<string | null>(null)
  const [eiStatus, setEiStatus] = useState<WSServiceItemStatus>('pending')
  const [eiNotes, setEiNotes] = useState('')
  const [eiMethod, setEiMethod] = useState<'k9' | 'xray' | 'manual' | null>(null)
  const [eiLocation, setEiLocation] = useState('')
  const [eiPickupFrom, setEiPickupFrom] = useState('')
  const [eiDeliverTo, setEiDeliverTo] = useState('')
  const [eiScheduledAt, setEiScheduledAt] = useState('')
  const [eiSaving, setEiSaving] = useState(false)

  // Document upload
  const [uploading, setUploading] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [uploadDocKey, setUploadDocKey] = useState('')
  const [dragOverSlot, setDragOverSlot] = useState<string | null>(null)

  // Fee-only billing
  const [feeCharges, setFeeCharges] = useState<any[]>([])
  const [feeAmount, setFeeAmount] = useState('')
  const [feeDesc, setFeeDesc] = useState('')
  const [feeSaving, setFeeSaving] = useState(false)

  // CCSF generation
  const [showCcsf, setShowCcsf] = useState(false)
  const [ccsfTruckingSelect, setCcsfTruckingSelect] = useState('CO-Transportation')
  const [ccsfTrucking, setCcsfTrucking] = useState('')
  const [ccsfDriver, setCcsfDriver] = useState('')
  const [ccsfCustody, setCcsfCustody] = useState<'seal' | 'escort' | 'locked_vehicle'>('seal')
  const [ccsfSeal, setCcsfSeal] = useState('')
  const [ccsfEscort, setCcsfEscort] = useState('')
  const [ccsfAgent, setCcsfAgent] = useState(user?.email?.split('@')[0]?.replace('.', ' ') || '')
  const [ccsfGenerating, setCcsfGenerating] = useState(false)

  // POD (Proof of Delivery)
  const [showPod, setShowPod] = useState(false)
  const [podReceiver, setPodReceiver] = useState('')
  const [podReceiverId, setPodReceiverId] = useState('')
  const [podNotes, setPodNotes] = useState('')
  const [podPhoto, setPodPhoto] = useState('')
  const [podSaving, setPodSaving] = useState(false)

  // Manual delivery close (transport-only, when driver didn't use app)
  const [showManualClose, setShowManualClose] = useState(false)
  const [mcDeliveredBy, setMcDeliveredBy] = useState('')
  const [mcReceivedBy, setMcReceivedBy] = useState('')
  const [mcReceivedId, setMcReceivedId] = useState('')
  const [mcDeliveredAt, setMcDeliveredAt] = useState('')
  const [mcNotes, setMcNotes] = useState('')
  const [mcSaving, setMcSaving] = useState(false)

  // WS Transport-Only: DO creation
  const [showWsDo, setShowWsDo] = useState(false)
  const [wsTruckingSelect, setWsTruckingSelect] = useState('CO-Transportation')
  const [wsTrucking, setWsTrucking] = useState('')
  const [wsDriverName, setWsDriverName] = useState('')
  const [wsCustody, setWsCustody] = useState('')
  const [wsSealNumber, setWsSealNumber] = useState('')
  const [wsDoCreating, setWsDoCreating] = useState(false)
  // WS DO + Tracking live data
  const [wsDoData, setWsDoData] = useState<WSDeliveryOrder | null>(null)
  const [wsTrackingData, setWsTrackingData] = useState<WSDeliveryTracking | null>(null)
  // Driver queue for WS DO
  const [wsDriverQueue, setWsDriverQueue] = useState<{ id: string; driver_name: string; vendor_name: string; plate: string | null; status: string }[]>([])
  const [wsShowQueue, setWsShowQueue] = useState(false)

  useEffect(() => {
    if (!id) return
    const unsub = onSnapshot(doc(db, 'warehouse_service_orders', id), snap => {
      if (snap.exists()) {
        const o = { id: snap.id, ...snap.data() } as WSServiceOrder
        // Auto-repair: if status is inconsistent with derived status, fix it
        const derived = deriveGlobalStatus(o)
        if (derived !== o.global_status) {
          updateDoc(doc(db, 'warehouse_service_orders', id), { global_status: derived }).catch(() => {})
        }
        setOrder(o)
      } else {
        setOrder(null)
      }
      setLoading(false)
    })
    return unsub
  }, [id])

  // Load fee charges for fee-only SOs
  useEffect(() => {
    if (!order?.id || !order.fee_only) return
    getDocs(query(collection(db, 'ws_billing_charges'), where('so_id', '==', order.id))).then(snap => {
      setFeeCharges(snap.docs.filter(d => d.data().status !== 'invalidated').map(d => ({ id: d.id, ...d.data() })))
    })
  }, [order?.id, order?.fee_only])

  // Load WR when order has wr_id
  useEffect(() => {
    if (!order?.wr_id) { setWrData(null); return }
    getDoc(doc(db, 'warehouse_receipts', order.wr_id)).then(snap => {
      if (snap.exists()) setWrData({ id: snap.id, ...snap.data() } as WarehouseReceipt)
    })
  }, [order?.wr_id])

  // Load WS DO + tracking for transport-only orders
  useEffect(() => {
    if (!order?.transport_only || !order.do_ids?.length) { setWsDoData(null); setWsTrackingData(null); return }
    const doId = order.do_ids[0]
    const unsub1 = onSnapshot(doc(db, 'ws_delivery_orders', doId), snap => {
      if (snap.exists()) setWsDoData({ id: snap.id, ...snap.data() } as WSDeliveryOrder)
    })
    let unsub2 = () => {}
    // Listen to tracking
    getDoc(doc(db, 'ws_delivery_orders', doId)).then(snap => {
      if (!snap.exists()) return
      const doData = snap.data()
      if (doData.tracking_id) {
        unsub2 = onSnapshot(doc(db, 'ws_delivery_tracking', doData.tracking_id), tSnap => {
          if (tSnap.exists()) setWsTrackingData({ id: tSnap.id, ...tSnap.data() } as WSDeliveryTracking)
        })
      }
    })
    return () => { unsub1(); unsub2() }
  }, [order?.transport_only, order?.do_ids?.length])

  // Sync DO status from tracking (driver can only write to tracking, MCL side syncs the DO)
  useEffect(() => {
    if (!wsTrackingData || !wsDoData) return
    const tStatus = wsTrackingData.status
    let doStatus: string | null = null
    let extra: Record<string, any> = {}
    if (tStatus === 'in_progress' && wsDoData.status === 'active') {
      doStatus = 'in_transit'
    } else if (tStatus === 'completed' && wsDoData.status !== 'delivered') {
      doStatus = 'delivered'
      extra.delivered_at = wsTrackingData.milestones?.delivered?.timestamp || new Date().toISOString()
    }
    if (doStatus) {
      updateDoc(doc(db, 'ws_delivery_orders', wsDoData.id), { status: doStatus, ...extra }).catch(() => {})
    }
    // Also sync transport service item to completed when tracking is done
    if (tStatus === 'completed' && order?.id) {
      const transportItem = order.service_items.find(i => i.type === 'transport')
      if (transportItem && transportItem.status !== 'completed' && transportItem.status !== 'cancelled') {
        const deliveredAt = wsTrackingData.milestones?.delivered?.timestamp || new Date().toISOString()
        const updatedItems = order.service_items.map(item => {
          if (item.type === 'transport' && item.status !== 'completed' && item.status !== 'cancelled') {
            return { ...item, status: 'completed' as const, completed_at: deliveredAt, completed_by: 'driver-tracking' }
          }
          return item
        })
        updateDoc(doc(db, 'warehouse_service_orders', order.id), { service_items: updatedItems }).catch(() => {})
      }
    }
  }, [wsTrackingData?.status, wsDoData?.status])

  // Auto-generate POS when driver completes delivery via tracking
  useEffect(() => {
    if (!order?.id || !order.transport_only) return
    if (order.pod_at) return // POS already exists
    if (!wsTrackingData || wsTrackingData.status !== 'completed') return
    if (!wsTrackingData.milestones?.delivered) return

    const deliveredMs = wsTrackingData.milestones.delivered as { timestamp: string; gps?: any; photo_urls?: string[] }
    const deliveredAt = deliveredMs.timestamp || new Date().toISOString()
    const receiverName = wsTrackingData.receiver_name || wsTrackingData.driver_name || 'Driver'
    const photoUrls = wsTrackingData.delivery_photo_urls || deliveredMs.photo_urls || []

    // Complete in_out/storage items
    const updatedItems = order.service_items.map(item => {
      if ((item.type === 'in_out' || item.type === 'storage' || item.type === 'transport') && item.status !== 'completed' && item.status !== 'cancelled') {
        return { ...item, status: 'completed' as const, completed_at: deliveredAt, completed_by: 'driver-tracking' }
      }
      return item
    })

    // Update SO with POS data
    updateDoc(doc(db, 'warehouse_service_orders', order.id), {
      pod_receiver: receiverName,
      pod_receiver_id: wsTrackingData.receiver_id || null,
      pod_notes: wsTrackingData.delivery_notes || null,
      pod_photo_url: photoUrls[0] || null,
      pod_at: deliveredAt,
      pod_by: 'auto-tracking',
      completed_at: deliveredAt,
      global_status: 'completed',
      service_items: updatedItems,
    }).then(async () => {
      // Generate billing charges
      const now = new Date().toISOString()
      const storageDays = order.received_at
        ? Math.max(1, Math.ceil((Date.now() - new Date(order.received_at).getTime()) / 86400000))
        : 1
      // For breakdown_bup, billing uses CHW (received_weight_kg) from breakdown AWBs
      let _wkg = wrData?.total_weight_kg || order.declared_weight
      if (order.breakdown_awbs?.length) {
        const chwSum = order.breakdown_awbs.reduce((s: number, a: any) => s + (a.received_weight_kg || 0), 0)
        if (chwSum > 0) _wkg = chwSum
        else { const gSum = order.breakdown_awbs.reduce((s: number, a: any) => s + (a.weight_kg || 0), 0); if (gSum > 0) _wkg = gSum }
      }
      const cargo: CargoData = {
        pieces: wrData?.total_qty || order.declared_pieces,
        weight_kg: _wkg,
        pallets: wrData?.total_qty || order.declared_pieces,
        cbm: wrData?.total_cbm || 0,
        storageDays,
        hasAwb: !!order.awb_number,
        hasDg: (order.service_items || []).some(i => i.type === 'dg_inspection'),
        isSpecialCargo: order.cargo_type === 'SPECIAL',
      }

      const allCharges: { service_type: string; description: string; amount: number; rate_id: string | null; storage_days?: number | null }[] = []

      try {
        // Non-transport charges (in/out, storage, screening, etc.)
        const posCharges = await calculatePOSCharges(order, cargo)
        allCharges.push(...posCharges)
      } catch (e) {
        console.error('Auto-POS billing error:', e)
      }

      // Transport charge (for transport-only orders)
      if (order.transport_only && wsDoData) {
        try {
          const transportType = ((order as any).transport_type || wsDoData.transport_type || 'loose') as 'bup' | 'loose'
          const extraStops = ((order as any).extra_stops || wsDoData.extra_stops || []).length
          const tCharge = await calculateTransportCharge(
            order,
            transportType,
            extraStops,
            wsDoData.trucking_company || '',
            wsDoData.driver_name || '',
          )
          if (tCharge.amount > 0) allCharges.push(tCharge)
        } catch (e) {
          console.error('Auto-POS transport billing error:', e)
        }
      }

      // Write all charges
      for (const ch of allCharges) {
        await addDoc(collection(db, 'ws_billing_charges'), {
          so_id: order.id,
          so_number: order.so_number,
          client_id: order.client_id,
          client_name: order.client_name,
          service_type: ch.service_type,
          description: ch.description,
          amount: ch.amount,
          currency: 'USD',
          status: 'pending',
          rate_id: ch.rate_id,
          storage_days: ch.storage_days || null,
          qty: ch.qty || null,
          rate_price: ch.rate_price || null,
          rate_unit: ch.rate_unit || null,
          detail: ch.detail || null,
          created_at: now,
          created_by: 'auto-tracking',
        })
      }
    }).catch(() => {})
  }, [wsTrackingData?.status, order?.pod_at, order?.id])

  // ── Permission helpers ──
  const isBilled = order?.global_status === 'billed'
  const canEditOrder = isBilled ? (isAdmin || isSuperAgent || isAccounting) : canEdit
  const canHardDelete = isAdmin || isSuperAgent
  const canSoftDelete = canEdit // agents + admin + super

  // ── Check-in ──
  function openCheckIn() {
    if (!order) return
    setCiPieces(String(order.declared_pieces || ''))
    setCiWeight(String(order.declared_weight || ''))
    setCiCargoType(order.cargo_type || 'GENERAL')
    setCiCargoMode(order.cargo_mode || 'LOC')
    setCiCargoDesc(order.cargo_description || '')
    setCiAwb(order.awb_number || '')
    setCiReference(order.reference || '')
    setCiDriverName(order.driver_name || '')
    setCiDriverLicense(order.driver_license || '')
    setShowCheckIn(true)
  }

  async function confirmCheckIn() {
    if (!order?.id || !canEdit) return
    setCiSaving(true)
    const now = new Date().toISOString()
    await updateDoc(doc(db, 'warehouse_service_orders', order.id), {
      global_status: 'checked_in',
      checked_in_at: now,
      counter_agent: user?.email || null,
      declared_pieces: parseInt(ciPieces) || order.declared_pieces,
      declared_weight: parseFloat(ciWeight) || order.declared_weight,
      cargo_type: ciCargoType,
      cargo_mode: ciCargoMode,
      cargo_description: ciCargoDesc.trim(),
      awb_number: ciAwb.trim() || null,
      reference: ciReference.trim() || null,
      driver_name: ciDriverName.trim() || null,
      driver_license: ciDriverLicense.trim() || null,
    })
    setCiSaving(false)
    setShowCheckIn(false)
  }

  // ── Edit mode ──
  function openEdit() {
    if (!order) return
    setEdAwb(order.awb_number || '')
    setEdReference(order.reference || '')
    setEdPieces(String(order.declared_pieces || ''))
    setEdWeight(String(order.declared_weight || ''))
    setEdCargoType(order.cargo_type || 'GENERAL')
    setEdCargoMode(order.cargo_mode || 'LOC')
    setEdCargoDesc(order.cargo_description || '')
    setEdNotes(order.notes || '')
    setEdDriverName(order.driver_name || '')
    setEdDriverLicense(order.driver_license || '')
    setEdServices(new Set(order.service_items.map(s => s.type)))
    // Transport-only fields
    if (order.transport_only) {
      setEdTransportType((order as any).transport_type || 'loose')
      setEdBupCount(String((order as any).bup_count || ''))
      setEdUldNumbers((order as any).uld_numbers || [])
      setEdPickupFrom((order as any).pickup_from || '')
      setEdDeliverTo((order as any).deliver_to || '')
      setEdExtraStops((order as any).extra_stops || [])
      setEdCargoLines((order as any).cargo_lines || [])
    }
    setEditing(true)
  }

  function toggleEditService(type: string) {
    if (!order) return
    // Don't allow removing completed/in-progress services
    const existing = order.service_items.find(s => s.type === type)
    if (existing && (existing.status === 'completed' || existing.status === 'in_progress' || existing.status === 'fail')) return
    setEdServices(prev => {
      const next = new Set(prev)
      if (next.has(type)) {
        next.delete(type)
      } else {
        if (type.startsWith('screening_')) {
          for (const t of next) { if (t.startsWith('screening_')) next.delete(t) }
        }
        next.add(type)
      }
      return next
    })
  }

  async function saveEdit() {
    if (!order?.id) return
    setEdSaving(true)
    // Build updated service items: keep existing items that are still selected, add new ones
    const updatedItems: WSServiceItem[] = []
    for (const type of edServices) {
      const existing = order.service_items.find(s => s.type === type)
      if (existing) {
        updatedItems.push(existing)
      } else {
        const screeningMethod = type === 'screening_k9' ? 'k9' as const
          : type === 'screening_xray' ? 'xray' as const
          : type === 'screening_manual' ? 'manual' as const
          : null
        updatedItems.push({
          id: `srv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: type as WSServiceItem['type'],
          status: 'pending',
          started_at: null,
          completed_at: null,
          completed_by: null,
          notes: '',
          location: null,
          pickup_from: null,
          deliver_to: null,
          scheduled_at: null,
          do_id: null,
          method: screeningMethod,
          inspection_log_id: null,
          cert_url: null,
          report_pdf_url: null,
        })
      }
    }

    if (order.transport_only) {
      const totalPcs = edCargoLines.reduce((s, l) => s + (l.pieces || 0), 0)
      const totalKg = edCargoLines.reduce((s, l) => s + (l.weight_kg || 0), 0)
      const awbs = edCargoLines.map(l => l.awb).filter(Boolean).join(', ')
      await updateDoc(doc(db, 'warehouse_service_orders', order.id), {
        transport_type: edTransportType,
        bup_count: edTransportType === 'bup' ? (parseInt(edBupCount) || null) : null,
        uld_numbers: edTransportType === 'bup' ? edUldNumbers.filter(Boolean) : [],
        pickup_from: edPickupFrom.trim() || null,
        deliver_to: edDeliverTo.trim() || null,
        extra_stops: edExtraStops.filter(s => s.trim()),
        cargo_lines: edCargoLines,
        declared_pieces: totalPcs,
        declared_weight: totalKg,
        awb_number: awbs || null,
        cargo_type: edCargoType,
        cargo_mode: edCargoMode,
        cargo_description: edCargoDesc.trim(),
        notes: edNotes.trim() || null,
        service_items: updatedItems,
      })
    } else {
      await updateDoc(doc(db, 'warehouse_service_orders', order.id), {
        awb_number: edAwb.trim() || null,
        reference: edReference.trim() || null,
        declared_pieces: parseInt(edPieces) || order.declared_pieces,
        declared_weight: parseFloat(edWeight) || order.declared_weight,
        cargo_type: edCargoType,
        cargo_mode: edCargoMode,
        cargo_description: edCargoDesc.trim(),
        notes: edNotes.trim() || null,
        driver_name: edDriverName.trim() || null,
        driver_license: edDriverLicense.trim() || null,
        service_items: updatedItems,
      })
    }
    setEdSaving(false)
    setEditing(false)
  }

  // ── Delete ──
  async function handleDelete() {
    if (!order?.id) return
    if (canHardDelete) {
      const msg = `PERMANENTLY DELETE order ${order.so_number}?\n\nThis action cannot be undone. The SO and all its data will be deleted.`
      if (!confirm(msg)) return
      await deleteDoc(doc(db, 'warehouse_service_orders', order.id))
      navigate('/warehouse-services')
    } else if (canSoftDelete) {
      if (!confirm(`Cancel order ${order.so_number}?`)) return
      await updateDoc(doc(db, 'warehouse_service_orders', order.id), {
        deleted_at: new Date().toISOString(),
        deleted_by: user?.email || 'unknown',
      })
      navigate('/warehouse-services')
    }
  }

  // ── Service item status ──
  async function updateServiceItemStatus(itemId: string, newStatus: WSServiceItemStatus) {
    if (!order?.id || !canEdit) return
    const now = new Date().toISOString()
    const updatedItems = order.service_items.map(item => {
      if (item.id !== itemId) return item
      return {
        ...item,
        status: newStatus,
        started_at: newStatus === 'in_progress' && !item.started_at ? now : item.started_at,
        completed_at: (newStatus === 'completed' || newStatus === 'fail') ? now : item.completed_at,
        completed_by: (newStatus === 'completed' || newStatus === 'fail') ? (user?.email || null) : item.completed_by,
      }
    })
    const tempOrder = { ...order, service_items: updatedItems }
    const newGlobal = deriveGlobalStatus(tempOrder)
    const update: Record<string, unknown> = { service_items: updatedItems, global_status: newGlobal }
    if (newGlobal === 'completed' && !order.completed_at) update.completed_at = now
    await updateDoc(doc(db, 'warehouse_service_orders', order.id), update)
  }

  // ── Service item inline edit ──
  function openItemEdit(item: WSServiceItem) {
    setEditingItemId(item.id)
    setEiStatus(item.status)
    setEiNotes(item.notes || '')
    setEiMethod(item.method || null)
    setEiLocation(item.location || '')
    setEiPickupFrom(item.pickup_from || '')
    setEiDeliverTo(item.deliver_to || '')
    setEiScheduledAt(item.scheduled_at || '')
  }

  async function saveItemEdit() {
    if (!order?.id || !editingItemId) return
    if (!confirm('¿Está seguro de que desea modificar este servicio?')) return
    setEiSaving(true)
    const now = new Date().toISOString()
    const updatedItems = order.service_items.map(item => {
      if (item.id !== editingItemId) return item
      const statusChanged = item.status !== eiStatus
      return {
        ...item,
        status: eiStatus,
        notes: eiNotes,
        method: item.type.startsWith('screening_') ? eiMethod : item.method,
        location: eiLocation || null,
        pickup_from: item.type === 'transport' ? (eiPickupFrom || null) : item.pickup_from,
        deliver_to: item.type === 'transport' ? (eiDeliverTo || null) : item.deliver_to,
        scheduled_at: eiScheduledAt || null,
        started_at: statusChanged && eiStatus === 'in_progress' && !item.started_at ? now : item.started_at,
        completed_at: statusChanged && (eiStatus === 'completed' || eiStatus === 'fail') ? now : (eiStatus !== 'completed' && eiStatus !== 'fail') ? null : item.completed_at,
        completed_by: statusChanged && (eiStatus === 'completed' || eiStatus === 'fail') ? (user?.email || null) : (eiStatus !== 'completed' && eiStatus !== 'fail') ? null : item.completed_by,
      }
    })
    const tempOrder = { ...order, service_items: updatedItems }
    const newGlobal = deriveGlobalStatus(tempOrder)
    const update: Record<string, unknown> = { service_items: updatedItems, global_status: newGlobal }
    if (newGlobal === 'completed' && !order.completed_at) update.completed_at = now
    await updateDoc(doc(db, 'warehouse_service_orders', order.id), update)
    setEditingItemId(null)
    setEiSaving(false)
  }

  // ── Document upload ──
  function triggerUpload(docKey: string) {
    setUploadDocKey(docKey)
    fileInputRef.current?.click()
  }

  async function uploadFiles(files: File[], docKey: string) {
    if (!order?.id || files.length === 0) return
    setUploading(docKey)
    try {
      const newFiles: WSDocFile[] = []
      for (const file of files) {
        const storagePath = `ws_documents/${order.id}/${docKey}/${file.name}`
        const storageRef = ref(storage, storagePath)
        await uploadBytes(storageRef, file)
        const url = await getDownloadURL(storageRef)
        newFiles.push({
          id: `doc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          key: docKey,
          url,
          storage_path: storagePath,
          filename: file.name,
          uploaded_at: new Date().toISOString(),
          uploaded_by: user?.email || 'unknown',
        })
      }
      const currentDocs = order.documents || []
      await updateDoc(doc(db, 'warehouse_service_orders', order.id), {
        documents: [...currentDocs, ...newFiles],
      })
    } catch (err) {
      alert('Error uploading file: ' + (err instanceof Error ? err.message : String(err)))
    }
    setUploading(null)
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files || files.length === 0 || !uploadDocKey) return
    await uploadFiles(Array.from(files), uploadDocKey)
    e.target.value = ''
  }

  function handleDocDrop(e: React.DragEvent, docKey: string) {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer.files.length > 0) {
      uploadFiles(Array.from(e.dataTransfer.files), docKey)
    }
  }

  async function removeDoc(fileId: string) {
    if (!order?.id) return
    if (!confirm('Delete this document?')) return
    const updated = (order.documents || []).filter(d => d.id !== fileId)
    await updateDoc(doc(db, 'warehouse_service_orders', order.id), { documents: updated })
  }

  // ── CCSF generation ──
  const hasScreening = order?.service_items.some(s => s.type.startsWith('screening_') || s.type === 'dg_inspection') || false

  async function generateCcsf() {
    if (!order) return
    setCcsfGenerating(true)
    try {
      const doData: DeliveryOrder = {
        do_number: '',
        date: new Date().toISOString(),
        status: 'complete',
        created_at: new Date().toISOString(),
        created_by: user?.email || '',
        awb_entries: [],
        awb_keys: [],
        trucking_company: ccsfTruckingSelect === 'Other' ? ccsfTrucking.trim() : ccsfTruckingSelect,
        driver_name: ccsfDriver.trim(),
        custody_method: ccsfCustody,
        seal_number: ccsfCustody === 'seal' ? ccsfSeal.trim() : '',
        escort_name: ccsfCustody === 'escort' ? ccsfEscort.trim() : '',
        ulds_loaded: [],
        mcl_agent: ccsfAgent.trim() || user?.email || '',
        ccsf_screening_type: 'originated',
        accepted_for: 'CAO',
        awb_number: order.awb_number || '',
      }
      const buffer = await buildCcsfPdfBuffer(doData)
      const blob = new Blob([buffer], { type: 'application/pdf' })
      const filename = `CCSF_${order.so_number}${order.awb_number ? '_' + order.awb_number : ''}.pdf`

      // Upload to Storage and save URL in SO
      const storageRef = ref(storage, `ws_ccsf/${order.id}/${filename}`)
      await uploadBytes(storageRef, blob)
      const downloadUrl = await getDownloadURL(storageRef)
      await updateDoc(doc(db, 'warehouse_service_orders', order.id!), { ccsf_url: downloadUrl })

      // Also download locally
      const localUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = localUrl
      a.download = filename
      a.click()
      URL.revokeObjectURL(localUrl)
      setShowCcsf(false)
    } catch (err) {
      alert('Error generating CCSF: ' + (err instanceof Error ? err.message : String(err)))
    }
    setCcsfGenerating(false)
  }

  // ── POD helpers ──
  function podToBase64(file: File, maxPx = 700, quality = 0.75): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const img = new Image()
        img.onload = () => {
          const canvas = document.createElement('canvas')
          let w = img.width, h = img.height
          if (w > maxPx || h > maxPx) {
            if (w > h) { h = Math.round(h * maxPx / w); w = maxPx }
            else { w = Math.round(w * maxPx / h); h = maxPx }
          }
          canvas.width = w; canvas.height = h
          canvas.getContext('2d')!.drawImage(img, 0, 0, w, h)
          resolve(canvas.toDataURL('image/jpeg', quality))
        }
        img.onerror = reject
        img.src = reader.result as string
      }
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  async function handlePodPhotoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const b64 = await podToBase64(file)
    setPodPhoto(b64)
    e.target.value = ''
  }

  const posReady = (() => {
    if (!order) return false
    if (order.pod_at) return false
    // Transport-only: POS ready when delivery is completed
    if (order.transport_only) {
      return wsDoData?.status === 'delivered'
    }
    if (!order.received_at) return false
    // All non-auto, non-transport services must be completed/cancelled/fail
    const manualItems = order.service_items.filter(i => i.type !== 'in_out' && i.type !== 'storage' && i.type !== 'transport')
    if (manualItems.length > 0 && !manualItems.every(i => i.status === 'completed' || i.status === 'cancelled' || i.status === 'fail')) return false
    // If there's a transport, it must already have a DO (completed via DO)
    const transportItem = order.service_items.find(i => i.type === 'transport')
    if (transportItem && transportItem.status !== 'completed' && transportItem.status !== 'cancelled') return false
    return true
  })()

  async function confirmPos() {
    if (!order?.id || !podReceiver.trim()) return
    setPodSaving(true)
    const now = new Date().toISOString()

    // Complete in_out and storage items that are in_progress
    const updatedItems = order.service_items.map(item => {
      if ((item.type === 'in_out' || item.type === 'storage') && (item.status === 'in_progress' || item.status === 'pending')) {
        return { ...item, status: 'completed' as const, completed_at: now, completed_by: user?.email || null }
      }
      return item
    })

    await updateDoc(doc(db, 'warehouse_service_orders', order.id), {
      pod_receiver: podReceiver.trim(),
      pod_receiver_id: podReceiverId.trim() || null,
      pod_notes: podNotes.trim() || null,
      pod_photo_url: podPhoto || null,
      pod_at: now,
      pod_by: user?.email || null,
      completed_at: now,
      global_status: 'completed',
      service_items: updatedItems,
    })

    // Generate billing charges using rate schedule
    const storageDays = order.received_at
      ? Math.max(1, Math.ceil((Date.now() - new Date(order.received_at).getTime()) / 86400000))
      : 1

    // For breakdown_bup, billing uses CHW (received_weight_kg) from breakdown AWBs
    let _wkg2 = wrData?.total_weight_kg || order.declared_weight
    if (order.breakdown_awbs?.length) {
      const chwSum = order.breakdown_awbs.reduce((s: number, a: any) => s + (a.received_weight_kg || 0), 0)
      if (chwSum > 0) _wkg2 = chwSum
      else { const gSum = order.breakdown_awbs.reduce((s: number, a: any) => s + (a.weight_kg || 0), 0); if (gSum > 0) _wkg2 = gSum }
    }
    const cargo: CargoData = {
      pieces: wrData?.total_qty || order.declared_pieces,
      weight_kg: _wkg2,
      pallets: wrData?.total_qty || order.declared_pieces,
      cbm: wrData?.total_cbm || 0,
      storageDays,
      hasAwb: !!order.awb_number,
      hasDg: (order.service_items || []).some(i => i.type === 'dg_inspection'),
      isSpecialCargo: order.cargo_type === 'SPECIAL',
    }

    try {
      const allCharges: { service_type: string; description: string; amount: number; rate_id: string | null; storage_days?: number | null }[] = []
      const posCharges = await calculatePOSCharges(order, cargo)
      allCharges.push(...posCharges)

      // Transport charge for transport-only orders
      if (order.transport_only && wsDoData) {
        const tType = ((order as any).transport_type || wsDoData.transport_type || 'loose') as 'bup' | 'loose'
        const eStops = ((order as any).extra_stops || wsDoData.extra_stops || []).length
        const tCharge = await calculateTransportCharge(order, tType, eStops, wsDoData.trucking_company || '', wsDoData.driver_name || '')
        if (tCharge.amount > 0) allCharges.push(tCharge)
      }

      for (const ch of allCharges) {
        await addDoc(collection(db, 'ws_billing_charges'), {
          so_id: order.id,
          so_number: order.so_number,
          client_id: order.client_id,
          client_name: order.client_name,
          service_type: ch.service_type,
          description: ch.description,
          amount: ch.amount,
          currency: 'USD',
          status: 'pending',
          rate_id: ch.rate_id,
          storage_days: ch.storage_days || null,
          qty: ch.qty || null,
          rate_price: ch.rate_price || null,
          rate_unit: ch.rate_unit || null,
          detail: ch.detail || null,
          created_at: now,
          created_by: user?.email || '',
        })
      }
    } catch (e) {
      console.error('Error calculating POS charges:', e)
    }

    setPodSaving(false)
    setShowPod(false)
  }

  // Manual delivery close: DO assigned but driver didn't use the app
  const canManualClose = (() => {
    if (!order || !order.transport_only) return false
    if (order.pod_at) return false // already closed
    if (!wsDoData) return false // no DO assigned
    if (wsDoData.status === 'delivered') return false // already delivered via tracking
    return true
  })()

  async function confirmManualClose() {
    if (!order?.id || !mcDeliveredBy.trim() || !mcReceivedBy.trim()) return
    setMcSaving(true)
    const deliveredAt = mcDeliveredAt
      ? new Date(mcDeliveredAt).toISOString()
      : new Date().toISOString()

    // Mark transport item as completed
    const updatedItems = order.service_items.map(item => {
      if (item.type === 'transport' && item.status !== 'completed' && item.status !== 'cancelled') {
        return { ...item, status: 'completed' as const, completed_at: deliveredAt, completed_by: user?.email || 'manual' }
      }
      return item
    })

    // Update SO with POD data
    await updateDoc(doc(db, 'warehouse_service_orders', order.id), {
      pod_receiver: mcReceivedBy.trim(),
      pod_receiver_id: mcReceivedId.trim() || null,
      pod_notes: mcNotes.trim() || null,
      pod_photo_url: null,
      pod_at: deliveredAt,
      pod_by: user?.email || null,
      completed_at: deliveredAt,
      global_status: 'completed',
      service_items: updatedItems,
    })

    // Update DO to delivered
    if (wsDoData) {
      await updateDoc(doc(db, 'ws_delivery_orders', wsDoData.id), {
        status: 'delivered',
        delivered_at: deliveredAt,
      }).catch(() => {})
    }

    // Update tracking to completed if exists
    if (wsDoData?.tracking_id) {
      await updateDoc(doc(db, 'ws_delivery_tracking', wsDoData.tracking_id), {
        status: 'completed',
        'milestones.delivered': {
          timestamp: deliveredAt,
          gps: { lat: 0, lng: 0 },
          manual: true,
        },
        receiver_name: mcReceivedBy.trim(),
        receiver_id: mcReceivedId.trim() || null,
        delivery_notes: mcNotes.trim() || null,
      }).catch(() => {})
    }

    // Generate billing charges
    const now = new Date().toISOString()
    const storageDays = order.received_at
      ? Math.max(1, Math.ceil((Date.now() - new Date(order.received_at).getTime()) / 86400000))
      : 1
    // For breakdown_bup, billing uses CHW (received_weight_kg) from breakdown AWBs
    let _wkg3 = wrData?.total_weight_kg || order.declared_weight
    if (order.breakdown_awbs?.length) {
      const chwSum = order.breakdown_awbs.reduce((s: number, a: any) => s + (a.received_weight_kg || 0), 0)
      if (chwSum > 0) _wkg3 = chwSum
      else { const gSum = order.breakdown_awbs.reduce((s: number, a: any) => s + (a.weight_kg || 0), 0); if (gSum > 0) _wkg3 = gSum }
    }
    const cargo: CargoData = {
      pieces: wrData?.total_qty || order.declared_pieces,
      weight_kg: _wkg3,
      pallets: wrData?.total_qty || order.declared_pieces,
      cbm: wrData?.total_cbm || 0,
      storageDays,
      hasAwb: !!order.awb_number,
      hasDg: (order.service_items || []).some(i => i.type === 'dg_inspection'),
      isSpecialCargo: order.cargo_type === 'SPECIAL',
    }
    try {
      const allCharges: { service_type: string; description: string; amount: number; rate_id: string | null; storage_days?: number | null }[] = []
      const posCharges = await calculatePOSCharges(order, cargo)
      allCharges.push(...posCharges)
      // Transport charge
      if (wsDoData) {
        const tType = ((order as any).transport_type || wsDoData.transport_type || 'loose') as 'bup' | 'loose'
        const eStops = ((order as any).extra_stops || wsDoData.extra_stops || []).length
        const tCharge = await calculateTransportCharge(order, tType, eStops, wsDoData.trucking_company || '', mcDeliveredBy.trim())
        if (tCharge.amount > 0) allCharges.push(tCharge)
      }
      for (const ch of allCharges) {
        await addDoc(collection(db, 'ws_billing_charges'), {
          so_id: order.id,
          so_number: order.so_number,
          client_id: order.client_id,
          client_name: order.client_name,
          service_type: ch.service_type,
          description: ch.description,
          amount: ch.amount,
          currency: 'USD',
          status: 'pending',
          rate_id: ch.rate_id,
          storage_days: ch.storage_days || null,
          qty: ch.qty || null,
          rate_price: ch.rate_price || null,
          rate_unit: ch.rate_unit || null,
          detail: ch.detail || null,
          created_at: now,
          created_by: user?.email || '',
        })
      }
    } catch (e) {
      console.error('Manual close billing error:', e)
    }

    setMcSaving(false)
    setShowManualClose(false)
  }

  // ── WS Driver Queue ──
  async function loadWsDriverQueue() {
    const snap = await getDocs(query(collection(db, 'driver_queue'), where('status', '==', 'waiting')))
    const now = new Date()
    const entries = snap.docs
      .map(d => ({ id: d.id, ...d.data() } as any))
      .filter((e: any) => e.status === 'waiting' && new Date(e.expires_at) > now)
    setWsDriverQueue(entries)
    setWsShowQueue(true)
  }

  function selectDriverFromQueue(entry: { id: string; driver_name: string; vendor_name: string }) {
    setWsDriverName(entry.driver_name)
    if (['CO-Transportation', 'GEO Transport'].includes(entry.vendor_name)) {
      setWsTruckingSelect(entry.vendor_name)
      setWsTrucking('')
    } else if (entry.vendor_name) {
      setWsTruckingSelect('Other')
      setWsTrucking(entry.vendor_name)
    }
    setWsShowQueue(false)
  }

  // ── WS DO creation ──
  async function createWsDo() {
    if (!order?.id || !order.transport_only) return
    setWsDoCreating(true)
    try {
      const truckingCompany = wsTruckingSelect === 'Other' ? wsTrucking.trim() : wsTruckingSelect
      const result = await createWSDeliveryOrder({
        so_id: order.id,
        so_number: order.so_number,
        client_id: order.client_id,
        client_name: order.client_name,
        pickup_from: (order as any).pickup_from || '',
        deliver_to: (order as any).deliver_to || '',
        extra_stops: (order as any).extra_stops || [],
        transport_type: order.transport_type || 'loose',
        bup_count: order.bup_count || null,
        uld_numbers: (order as any).uld_numbers || [],
        total_pieces: order.declared_pieces,
        total_weight: order.declared_weight,
        trucking_company: truckingCompany,
        driver_name: wsDriverName.trim(),
        driver_id: null,
        custody_method: wsCustody.trim() || null,
        seal_number: wsSealNumber.trim() || null,
        mcl_agent: user?.email?.split('@')[0]?.replace('.', ' ') || '',
        created_by: user?.email || 'unknown',
      })

      // Update SO with DO reference
      await updateDoc(doc(db, 'warehouse_service_orders', order.id), {
        do_ids: [result.doId],
        do_id: result.doId,
        do_number: result.doNumber,
      })

      // Update transport service item to in_progress
      const updatedItems = order.service_items.map(item => {
        if (item.type === 'transport' && item.status === 'pending') {
          return { ...item, status: 'in_progress' as const, started_at: new Date().toISOString() }
        }
        return item
      })
      await updateDoc(doc(db, 'warehouse_service_orders', order.id), {
        service_items: updatedItems,
        global_status: 'in_progress',
      })

      setShowWsDo(false)
      alert(`DO creada: ${result.doNumber}\nPIN del driver: ${result.pin}`)
    } catch (e) {
      alert('Error creating DO: ' + (e instanceof Error ? e.message : String(e)))
    }
    setWsDoCreating(false)
  }

  const isTransportOnly = !!order?.transport_only
  const isFeeOnly = !!order?.fee_only

  // ── Render ──
  const inputClass = 'w-full border border-gray-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30'

  if (loading) return <Layout title="Service Order" backTo="/warehouse-services"><div className="text-center py-20 text-gray-400">Loading...</div></Layout>
  if (!order) return <Layout title="Service Order" backTo="/warehouse-services"><div className="text-center py-20 text-gray-400">Order not found</div></Layout>

  const docSlots = getDocSlots(order)

  return (
    <Layout title={order.so_number} backTo="/warehouse-services">
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
        {/* Header card */}
        <div className="bg-white rounded-xl shadow-sm border p-6">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-xl font-bold text-gray-800 font-mono">{order.so_number}</h2>
              <p className="text-sm text-gray-500 mt-1">{order.client_name}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className={`text-xs font-semibold px-3 py-1.5 rounded-full ${STATUS_COLORS[order.global_status]}`}>
                {STATUS_LABELS[order.global_status]}
              </span>
              {canEditOrder && !editing && (
                <button onClick={openEdit} className="text-xs text-gray-400 hover:text-mcl-blue px-2 py-1" title="Edit">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                </button>
              )}
              {(canSoftDelete || canHardDelete) && (
                <button onClick={handleDelete} className="text-xs text-gray-400 hover:text-red-500 px-2 py-1" title={canHardDelete ? 'Delete' : 'Cancel'}>
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                </button>
              )}
            </div>
          </div>

          {/* ── View mode ── */}
          {!editing && (
            <>
              {isFeeOnly ? (
                <div className="mt-4 text-sm text-gray-600">
                  {order.reference && <p><span className="text-xs text-gray-400 uppercase">Reference: </span>{order.reference}</p>}
                  {order.cargo_description && <p className="mt-1"><span className="text-xs text-gray-400 uppercase">Description: </span>{order.cargo_description}</p>}
                  {order.notes && (
                    <div className="mt-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                      <span className="text-xs font-bold text-amber-700 uppercase">Notes: </span>
                      <span className="text-gray-700">{order.notes}</span>
                    </div>
                  )}
                </div>
              ) : (
              <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-5 text-sm">
                <div>
                  <div className="text-xs text-gray-400 uppercase">AWB</div>
                  <div className="font-mono">{isTransportOnly
                    ? ((order as any).cargo_lines?.map((l: any) => l.awb).filter(Boolean).join(', ') || '—')
                    : (order.awb_number || '—')}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-400 uppercase">Reference</div>
                  <div>{isTransportOnly
                    ? ((order as any).cargo_lines?.map((l: any) => l.ref).filter(Boolean).join(', ') || '—')
                    : (order.reference || '—')}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-400 uppercase">Pieces</div>
                  <div>{order.declared_pieces}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-400 uppercase">Weight</div>
                  <div>{order.declared_weight ? `${order.declared_weight} kg` : '—'}</div>
                </div>
              </div>

              <div className="mt-3 text-sm">
                <span className="text-xs text-gray-400 uppercase">Cargo: </span>
                {order.cargo_description && <span className="text-gray-700">{order.cargo_description}</span>}
                <span className="text-xs ml-2 bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">{order.cargo_type}</span>
                {order.cargo_mode && (
                  <span className={`text-xs ml-1 px-1.5 py-0.5 rounded ${order.cargo_mode === 'BOND' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}>
                    {order.cargo_mode === 'BOND' ? 'Bonded' : 'Local'}
                  </span>
                )}
              </div>

              {/* Notes */}
              {order.notes && (
                <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm">
                  <span className="text-xs font-bold text-amber-700 uppercase">Notes: </span>
                  <span className="text-gray-700">{order.notes}</span>
                </div>
              )}

              {/* WR inline */}
              {wrData && (
                <div className="mt-3 flex items-center gap-3 text-sm bg-gray-50 rounded-lg px-3 py-2">
                  <span className="text-xs text-gray-400 uppercase font-semibold">WR:</span>
                  <span className="font-mono font-bold text-mcl-blue">{wrData.wr_number}</span>
                  <span className="text-xs text-gray-500">{wrData.total_qty} pcs</span>
                  <span className="text-xs text-gray-500">{wrData.total_weight_kg ? `${wrData.total_weight_kg} kg` : ''}</span>
                  <span className="text-xs text-gray-500">{wrData.total_cbm ? `${Number(wrData.total_cbm).toFixed(3)} CBM` : ''}</span>
                </div>
              )}

              {/* Transport-Only info */}
              {isTransportOnly && (
                <div className="mt-3 p-3 bg-emerald-50 border border-emerald-200 rounded-lg space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-emerald-700 uppercase">Transport Only</span>
                    <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full font-semibold">
                      {order.transport_type === 'bup' ? 'BUP' : 'LOOSE'}
                    </span>
                    {order.transport_type === 'bup' && order.bup_count && (
                      <span className="text-xs text-emerald-600">{order.bup_count} BUP</span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs text-gray-600">
                    <div><span className="text-gray-400">From:</span> {(order as any).pickup_from || '—'}</div>
                    <div><span className="text-gray-400">To:</span> {(order as any).deliver_to || '—'}</div>
                  </div>
                  {(order as any).extra_stops?.length > 0 && (
                    <div className="text-xs text-gray-500">
                      Extra stops: {(order as any).extra_stops.join(' → ')}
                    </div>
                  )}
                  {(order as any).uld_numbers?.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {(order as any).uld_numbers.map((uld: string, i: number) => (
                        <span key={i} className="text-[10px] bg-blue-50 text-blue-700 border border-blue-200 px-1.5 py-0.5 rounded-full font-mono">{uld}</span>
                      ))}
                    </div>
                  )}
                  {order.cargo_lines && order.cargo_lines.length > 0 && (
                    <div>
                      <div className="text-[10px] text-gray-400 uppercase font-semibold mb-1">Cargo Lines</div>
                      <table className="w-full text-xs">
                        <thead><tr className="text-gray-400"><th className="text-left pr-2">AWB</th><th className="text-left pr-2">Ref</th><th className="text-right pr-2">Pcs</th><th className="text-right pr-2">Kg</th><th className="text-left">Note</th></tr></thead>
                        <tbody>
                          {order.cargo_lines.map(line => (
                            <tr key={line.id} className="text-gray-600">
                              <td className="pr-2 font-mono">{line.awb || '—'}</td>
                              <td className="pr-2">{line.reference || '—'}</td>
                              <td className="text-right pr-2">{line.pieces}</td>
                              <td className="text-right pr-2">{line.weight_kg}</td>
                              <td>{line.note || ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {/* WS DO info or Create button */}
                  {wsDoData ? (
                    <div className="p-2 bg-white rounded-lg border border-emerald-200">
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="font-mono font-bold text-emerald-700 text-sm">{wsDoData.do_number}</span>
                          <span className={`ml-2 text-xs px-2 py-0.5 rounded-full font-semibold ${
                            wsDoData.status === 'delivered' ? 'bg-green-100 text-green-700' :
                            wsDoData.status === 'in_transit' ? 'bg-orange-100 text-orange-700' :
                            'bg-gray-100 text-gray-600'
                          }`}>
                            {wsDoData.status}
                          </span>
                        </div>
                        <div className="text-xs text-gray-500">PIN: <span className="font-mono font-bold text-gray-800">{wsDoData.driver_pin}</span></div>
                      </div>
                      <div className="text-xs text-gray-500 mt-1">
                        Driver: {wsDoData.driver_name || '—'} &bull; {wsDoData.trucking_company}
                      </div>
                      {/* Tracking milestones */}
                      {wsTrackingData && (
                        <div className="mt-2 space-y-1">
                          {buildMilestoneKeys(wsTrackingData.extra_stops || []).map(m => {
                            const done = wsTrackingData.milestones && (wsTrackingData.milestones as Record<string, any>)[m.key]
                            return (
                              <div key={m.key} className="flex items-center gap-2 text-xs">
                                <div className={`w-2 h-2 rounded-full ${done ? 'bg-green-500' : 'bg-gray-300'}`} />
                                <span className={done ? 'text-green-700 font-semibold' : 'text-gray-400'}>{m.label}</span>
                                {m.address && <span className="text-gray-400">({m.address})</span>}
                                {done && <span className="text-green-600 text-[10px]">{new Date(done.timestamp).toLocaleTimeString()}</span>}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowWsDo(true)}
                      className="text-xs bg-emerald-600 hover:bg-emerald-700 text-white font-semibold px-4 py-2 rounded-lg transition-colors"
                    >
                      Create Delivery Order
                    </button>
                  )}
                </div>
              )}

              {/* ── Documents bar ── */}
              <div className="mt-3 p-3 bg-gray-50/80 border border-gray-200 rounded-lg">
                <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Documents</div>
                <div className="flex flex-wrap gap-2">
                  {/* WR */}
                  {(() => {
                    const hasWr = !!order.wr_id && !!wrData
                    return (
                      <div className={`inline-flex items-center rounded-md border text-xs font-semibold overflow-hidden ${hasWr ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-gray-50 text-gray-300 border-gray-200'}`}>
                        <button
                          onClick={() => hasWr && navigate(`/wr/${order.wr_id}/print`)}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 ${hasWr ? 'hover:bg-blue-100 cursor-pointer' : 'cursor-not-allowed'}`}
                          disabled={!hasWr}
                          title={hasWr ? 'View Warehouse Receipt' : 'No WR yet'}
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                          Warehouse Receipt
                        </button>
                        {hasWr && (
                          <button
                            onClick={async () => {
                              if (['completed', 'billed'].includes(order.global_status)) {
                                if (!confirm('Esto re-abrirá la orden y los cargos de facturación existentes serán invalidados. ¿Continuar?')) return
                                await updateDoc(doc(db, 'warehouse_service_orders', order.id!), { global_status: 'in_progress' })
                                const chargesSnap = await getDocs(query(collection(db, 'ws_billing_charges'), where('so_id', '==', order.id)))
                                for (const c of chargesSnap.docs) {
                                  await updateDoc(c.ref, { status: 'invalidated', invalidated_at: new Date().toISOString() })
                                }
                              }
                              navigate(`/warehouse-services/reception/${order.id}`)
                            }}
                            className="inline-flex items-center px-2 py-1.5 border-l border-blue-200 hover:bg-blue-100"
                            title="Edit WR"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                          </button>
                        )}
                      </div>
                    )
                  })()}

                  {/* DO */}
                  {(() => {
                    const hasDo = !!(order as any).do_id
                    return (
                      <div className={`inline-flex items-center rounded-md border text-xs font-semibold overflow-hidden ${hasDo ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-gray-50 text-gray-300 border-gray-200'}`}>
                        <button
                          onClick={() => hasDo && navigate(`/warehouse-services/delivery-order/${(order as any).do_id}`)}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 ${hasDo ? 'hover:bg-blue-100 cursor-pointer' : 'cursor-not-allowed'}`}
                          disabled={!hasDo}
                          title={hasDo ? 'View Delivery Order' : 'No DO created'}
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>
                          Delivery Order
                        </button>
                        {hasDo && (
                          <button
                            onClick={() => navigate(`/warehouse-services/delivery-order/new?edit=${(order as any).do_id}`)}
                            className="inline-flex items-center px-2 py-1.5 border-l border-blue-200 hover:bg-blue-100"
                            title="Edit DO"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                          </button>
                        )}
                      </div>
                    )
                  })()}

                  {/* POS / POD */}
                  {(() => {
                    const hasPos = !!order.pod_at
                    const docLabel = order.transport_only ? 'Proof of Delivery' : 'Proof of Service'
                    return (
                      <div className={`inline-flex items-center rounded-md border text-xs font-semibold overflow-hidden ${hasPos ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-gray-50 text-gray-300 border-gray-200'}`}>
                        <button
                          onClick={() => hasPos && navigate(`/warehouse-services/pos/${order.id}`)}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 ${hasPos ? 'hover:bg-blue-100 cursor-pointer' : 'cursor-not-allowed'}`}
                          disabled={!hasPos}
                          title={hasPos ? `View ${docLabel}` : `${docLabel} not confirmed`}
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                          {docLabel}
                        </button>
                      </div>
                    )
                  })()}

                  {/* Screening Certificate */}
                  {(() => {
                    const screeningItem = order.service_items.find(s => (s.type.startsWith('screening_') || s.type === 'dg_inspection') && (s.report_pdf_url || s.cert_url))
                    const hasCert = !!screeningItem
                    return (
                      <div className={`inline-flex items-center rounded-md border text-xs font-semibold overflow-hidden ${hasCert ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-gray-50 text-gray-300 border-gray-200'}`}>
                        <button
                          onClick={() => hasCert && window.open(screeningItem!.report_pdf_url || screeningItem!.cert_url || '', '_blank')}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 ${hasCert ? 'hover:bg-blue-100 cursor-pointer' : 'cursor-not-allowed'}`}
                          disabled={!hasCert}
                          title={hasCert ? 'View Screening Certificate' : 'Screening not completed'}
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
                          Screening Certificate
                        </button>
                      </div>
                    )
                  })()}

                  {/* CCSF */}
                  {(() => {
                    const hasCcsf = !!(order as any).ccsf_url
                    const canGenerate = hasScreening && !!order.awb_number
                    if (!hasCcsf && !canGenerate) return null
                    return (
                      <div className={`inline-flex items-center rounded-md border text-xs font-semibold overflow-hidden ${hasCcsf ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-gray-50 text-gray-300 border-gray-200'}`}>
                        <button
                          onClick={() => hasCcsf ? window.open((order as any).ccsf_url, '_blank') : undefined}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 ${hasCcsf ? 'hover:bg-blue-100 cursor-pointer' : 'cursor-not-allowed'}`}
                          disabled={!hasCcsf}
                          title={hasCcsf ? 'View CCSF' : 'CCSF not generated yet'}
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 2h8l4 4v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6l4-4z" /></svg>
                          CCSF
                        </button>
                      </div>
                    )
                  })()}

                </div>
              </div>
              </>
              )}
            </>
          )}

          {/* ── Edit mode ── */}
          {editing && isTransportOnly && (
            <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-lg space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-bold text-blue-800">Edit Transport Order</h4>
                <button onClick={() => setEditing(false)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
              </div>
              {/* Cargo Type / Mode */}
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Cargo Type</label>
                  <select value={edCargoType} onChange={e => setEdCargoType(e.target.value as WSCargoType)} className={inputClass}>
                    {CARGO_TYPES.map(ct => <option key={ct.value} value={ct.value}>{ct.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Mode</label>
                  <div className="flex gap-1 mt-0.5">
                    {(['LOC', 'BOND'] as WSCargoMode[]).map(m => (
                      <button key={m} type="button" onClick={() => setEdCargoMode(m)} className={`text-xs px-2.5 py-1.5 rounded border transition-colors ${edCargoMode === m ? 'bg-mcl-blue text-white border-mcl-blue' : 'bg-white text-gray-600 border-gray-200'}`}>
                        {m === 'LOC' ? 'Local' : 'Bond'}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Transport Type</label>
                  <div className="flex gap-1 mt-0.5">
                    {(['loose', 'bup'] as const).map(t => (
                      <button key={t} type="button" onClick={() => setEdTransportType(t)} className={`text-xs px-2.5 py-1.5 rounded border transition-colors uppercase ${edTransportType === t ? 'bg-emerald-700 text-white border-emerald-700' : 'bg-white text-gray-600 border-gray-200'}`}>
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              {/* BUP details */}
              {edTransportType === 'bup' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">BUP Count</label>
                    <input type="number" min="1" value={edBupCount} onChange={e => setEdBupCount(e.target.value)} className={inputClass} />
                  </div>
                  <div>
                    <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">ULD Numbers</label>
                    <input
                      value={edUldNumbers.join(', ')}
                      onChange={e => setEdUldNumbers(e.target.value.split(',').map(s => s.trim()))}
                      placeholder="ULD1, ULD2, ..."
                      className={inputClass}
                    />
                  </div>
                </div>
              )}
              {/* Cargo description */}
              <div>
                <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Cargo Description</label>
                <input value={edCargoDesc} onChange={e => setEdCargoDesc(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Notes</label>
                <textarea value={edNotes} onChange={e => setEdNotes(e.target.value)} rows={2} className={inputClass + ' resize-none'} placeholder="Special instructions..." />
              </div>
              {/* Route */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Pickup From</label>
                  <input value={edPickupFrom} onChange={e => setEdPickupFrom(e.target.value)} className={inputClass} />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Deliver To</label>
                  <input value={edDeliverTo} onChange={e => setEdDeliverTo(e.target.value)} className={inputClass} />
                </div>
              </div>
              {/* Extra Stops */}
              <div>
                <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Extra Stops</label>
                {edExtraStops.map((stop, i) => (
                  <div key={i} className="flex gap-2 mb-1">
                    <input value={stop} onChange={e => { const arr = [...edExtraStops]; arr[i] = e.target.value; setEdExtraStops(arr) }} placeholder={`Stop ${i + 1}`} className={`flex-1 ${inputClass}`} />
                    <button type="button" onClick={() => setEdExtraStops(prev => prev.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-600 text-xs px-1">&times;</button>
                  </div>
                ))}
                <button type="button" onClick={() => setEdExtraStops(prev => [...prev, ''])} className="text-xs text-mcl-blue hover:underline">+ Add Stop</button>
              </div>
              {/* Cargo Lines */}
              <div>
                <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-1">Cargo Lines</label>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-400">
                      <th className="text-left pb-1">AWB</th>
                      <th className="text-left pb-1">Ref</th>
                      <th className="text-right pb-1 w-20">Pcs</th>
                      <th className="text-right pb-1 w-20">Kg</th>
                      <th className="text-left pb-1">Note</th>
                      <th className="w-6"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {edCargoLines.map((line, i) => (
                      <tr key={line.id} className="border-t border-gray-200">
                        <td className="py-1 pr-1"><input value={line.awb} onChange={e => { const arr = [...edCargoLines]; arr[i] = { ...arr[i], awb: e.target.value }; setEdCargoLines(arr) }} className={inputClass} /></td>
                        <td className="py-1 pr-1"><input value={line.reference} onChange={e => { const arr = [...edCargoLines]; arr[i] = { ...arr[i], reference: e.target.value }; setEdCargoLines(arr) }} className={inputClass} /></td>
                        <td className="py-1 pr-1"><input type="number" min="0" value={line.pieces} onChange={e => { const arr = [...edCargoLines]; arr[i] = { ...arr[i], pieces: parseInt(e.target.value) || 0 }; setEdCargoLines(arr) }} className={`${inputClass} text-right`} /></td>
                        <td className="py-1 pr-1"><input type="number" min="0" step="0.1" value={line.weight_kg} onChange={e => { const arr = [...edCargoLines]; arr[i] = { ...arr[i], weight_kg: parseFloat(e.target.value) || 0 }; setEdCargoLines(arr) }} className={`${inputClass} text-right`} /></td>
                        <td className="py-1 pr-1"><input value={line.note} onChange={e => { const arr = [...edCargoLines]; arr[i] = { ...arr[i], note: e.target.value }; setEdCargoLines(arr) }} className={inputClass} /></td>
                        <td className="py-1"><button type="button" onClick={() => setEdCargoLines(prev => prev.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-600">&times;</button></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-gray-300 font-semibold">
                      <td colSpan={2} className="py-1 text-right text-gray-500">Totals:</td>
                      <td className="py-1 text-right">{edCargoLines.reduce((s, l) => s + (l.pieces || 0), 0)}</td>
                      <td className="py-1 text-right">{edCargoLines.reduce((s, l) => s + (l.weight_kg || 0), 0)}</td>
                      <td colSpan={2}></td>
                    </tr>
                  </tfoot>
                </table>
                <button type="button" onClick={() => setEdCargoLines(prev => [...prev, { id: `cl_${Date.now()}`, awb: '', reference: '', pieces: 0, weight_kg: 0, note: '' }])} className="text-xs text-mcl-blue hover:underline mt-1">+ Add Line</button>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => setEditing(false)} className="text-xs text-gray-500 px-3 py-1.5">Cancel</button>
                <button onClick={saveEdit} disabled={edSaving} className="bg-mcl-blue hover:bg-blue-900 text-white text-sm font-semibold px-5 py-2 rounded-lg transition-colors disabled:opacity-50">
                  {edSaving ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </div>
          )}
          {editing && !isTransportOnly && (
            <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-lg space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-bold text-blue-800">Edit Order</h4>
                <button onClick={() => setEditing(false)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">AWB</label>
                  <input value={edAwb} onChange={e => setEdAwb(e.target.value)} className={inputClass} />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Reference</label>
                  <input value={edReference} onChange={e => setEdReference(e.target.value)} className={inputClass} />
                </div>
              </div>
              <div className="grid grid-cols-4 gap-3">
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Pieces</label>
                  <input type="number" min="1" value={edPieces} onChange={e => setEdPieces(e.target.value)} className={inputClass} />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Weight (kg)</label>
                  <input type="number" min="0" step="0.1" value={edWeight} onChange={e => setEdWeight(e.target.value)} className={inputClass} />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Cargo Type</label>
                  <select value={edCargoType} onChange={e => setEdCargoType(e.target.value as WSCargoType)} className={inputClass}>
                    {CARGO_TYPES.map(ct => <option key={ct.value} value={ct.value}>{ct.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Mode</label>
                  <div className="flex gap-1 mt-0.5">
                    {(['LOC', 'BOND'] as WSCargoMode[]).map(m => (
                      <button key={m} type="button" onClick={() => setEdCargoMode(m)} className={`text-xs px-2.5 py-1.5 rounded border transition-colors ${edCargoMode === m ? 'bg-mcl-blue text-white border-mcl-blue' : 'bg-white text-gray-600 border-gray-200'}`}>
                        {m === 'LOC' ? 'Local' : 'Bond'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div>
                <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Cargo description</label>
                <input value={edCargoDesc} onChange={e => setEdCargoDesc(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Notes</label>
                <textarea value={edNotes} onChange={e => setEdNotes(e.target.value)} rows={2} className={inputClass + ' resize-none'} placeholder="Special instructions..." />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Driver</label>
                  <input value={edDriverName} onChange={e => setEdDriverName(e.target.value)} className={inputClass} />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">License</label>
                  <input value={edDriverLicense} onChange={e => setEdDriverLicense(e.target.value)} className={inputClass} />
                </div>
              </div>
              {/* Edit services */}
              <div>
                <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-1">Services</label>
                <div className="space-y-2">
                  {['Screening', 'Transport', 'Warehouse'].map(group => (
                    <div key={group}>
                      <div className="text-[10px] font-bold text-gray-400 uppercase mb-1">{group}</div>
                      <div className="flex flex-wrap gap-1.5">
                        {SERVICE_OPTIONS.filter(s => s.group === group).map(s => {
                          const active = edServices.has(s.type)
                          const existing = order.service_items.find(si => si.type === s.type)
                          const locked = existing && (existing.status === 'completed' || existing.status === 'in_progress' || existing.status === 'fail')
                          return (
                            <button
                              key={s.type}
                              type="button"
                              onClick={() => !locked && toggleEditService(s.type)}
                              disabled={!!locked}
                              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                                active
                                  ? locked ? 'bg-green-100 text-green-700 border-green-300 cursor-not-allowed' : 'bg-mcl-blue text-white border-mcl-blue'
                                  : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                              } ${locked ? 'opacity-70 cursor-not-allowed' : ''}`}
                            >
                              {s.label}{locked ? ' (locked)' : ''}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => setEditing(false)} className="text-xs text-gray-500 px-3 py-1.5">Cancel</button>
                <button onClick={saveEdit} disabled={edSaving} className="bg-mcl-blue hover:bg-blue-900 text-white text-sm font-semibold px-5 py-2 rounded-lg transition-colors disabled:opacity-50">
                  {edSaving ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </div>
          )}

          {/* Action buttons */}
          {canEdit && !editing && (
            <div className="mt-4 pt-4 border-t border-gray-100 flex gap-3 flex-wrap">
              {!isTransportOnly && order.global_status === 'requested' && (
                <button
                  onClick={openCheckIn}
                  className="bg-yellow-500 hover:bg-yellow-600 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
                >
                  Check-in
                </button>
              )}
              {!isTransportOnly && (['checked_in', 'received', 'in_progress'].includes(order.global_status)) && (
                <button
                  onClick={() => navigate(`/warehouse-services/reception/${order.id}`)}
                  className="bg-mcl-blue hover:bg-blue-900 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
                >
                  {order.wr_id ? 'Edit Reception' : 'Physical Reception'}
                </button>
              )}
              {!isTransportOnly && order.wr_id && (
                <button
                  onClick={() => navigate('/warehouse-services/locate')}
                  className="bg-gray-600 hover:bg-gray-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
                >
                  Locate
                </button>
              )}
              {order.received_at && order.service_items.some(s => (s.type.startsWith('screening_') || s.type === 'dg_inspection') && s.status !== 'completed' && s.status !== 'cancelled' && s.status !== 'fail') && (
                <button
                  onClick={() => navigate(`/warehouse-services/screening/${order.id}`)}
                  className="bg-green-600 hover:bg-green-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
                >
                  Run Screening
                </button>
              )}
              {hasScreening && order.awb_number && (
                <button
                  onClick={() => setShowCcsf(true)}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
                >
                  Generate CCSF
                </button>
              )}
              {posReady && (
                <button
                  onClick={() => setShowPod(true)}
                  className="bg-green-600 hover:bg-green-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
                >
                  {order.transport_only ? 'Generate POD (Manual)' : 'Generate POS'}
                </button>
              )}
              {canManualClose && (
                <button
                  onClick={() => {
                    setMcDeliveredBy(wsDoData?.driver_name || '')
                    setMcReceivedBy('')
                    setMcReceivedId('')
                    setMcDeliveredAt('')
                    setMcNotes('')
                    setShowManualClose(true)
                  }}
                  className="bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
                >
                  Close Delivery (Manual)
                </button>
              )}
            </div>
          )}

          {/* CCSF generation panel */}
          {showCcsf && (
            <div className="mt-4 p-4 bg-indigo-50 border border-indigo-200 rounded-lg space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-bold text-indigo-800">Generate CCSF Certificate</h4>
                <button onClick={() => setShowCcsf(false)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
              </div>
              {order.awb_number && (
                <div className="text-xs text-gray-500">AWB: <span className="font-mono font-semibold text-gray-700">{order.awb_number}</span></div>
              )}
              <div>
                <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">MCL Agent</label>
                <input value={ccsfAgent} onChange={e => setCcsfAgent(e.target.value)} placeholder="Agent name" className={inputClass} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Trucking Company</label>
                  <select value={ccsfTruckingSelect} onChange={e => { setCcsfTruckingSelect(e.target.value); if (e.target.value !== 'Other') setCcsfTrucking('') }} className={inputClass}>
                    {['CO-Transportation', 'GEO Transport', 'Other'].map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  {ccsfTruckingSelect === 'Other' && (
                    <input value={ccsfTrucking} onChange={e => setCcsfTrucking(e.target.value)} placeholder="Company name" className={inputClass + ' mt-1'} />
                  )}
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Driver</label>
                  <input value={ccsfDriver} onChange={e => setCcsfDriver(e.target.value)} placeholder="Driver name" className={inputClass} />
                </div>
              </div>
              <div>
                <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-1">Custody Method</label>
                <div className="flex gap-2">
                  {([['seal', 'Seal'], ['escort', 'Escort'], ['locked_vehicle', 'Locked Vehicle']] as const).map(([val, lbl]) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setCcsfCustody(val)}
                      className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                        ccsfCustody === val ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
              </div>
              {ccsfCustody === 'seal' && (
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Seal Number</label>
                  <input value={ccsfSeal} onChange={e => setCcsfSeal(e.target.value)} placeholder="Ej: 10171619" className={inputClass} />
                </div>
              )}
              {ccsfCustody === 'escort' && (
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Escort Name</label>
                  <input value={ccsfEscort} onChange={e => setCcsfEscort(e.target.value)} className={inputClass} />
                </div>
              )}
              <div className="flex justify-end pt-2">
                <button
                  onClick={generateCcsf}
                  disabled={ccsfGenerating}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold px-5 py-2 rounded-lg transition-colors disabled:opacity-50"
                >
                  {ccsfGenerating ? 'Generating...' : 'Download CCSF'}
                </button>
              </div>
            </div>
          )}

          {/* POS panel */}
          {showPod && (
            <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded-lg space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-bold text-green-800">Generate Proof of Service</h4>
                <button onClick={() => setShowPod(false)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Receiver Name *</label>
                  <input value={podReceiver} onChange={e => setPodReceiver(e.target.value)} placeholder="Full name" className={inputClass} />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Receiver ID / License</label>
                  <input value={podReceiverId} onChange={e => setPodReceiverId(e.target.value)} placeholder="Optional" className={inputClass} />
                </div>
              </div>
              <div>
                <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Notes</label>
                <textarea value={podNotes} onChange={e => setPodNotes(e.target.value)} rows={2} placeholder="Optional notes" className={inputClass} />
              </div>
              <div>
                <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Photo</label>
                <input type="file" accept="image/*" onChange={handlePodPhotoUpload} className="text-xs text-gray-600" />
                {podPhoto && (
                  <div className="mt-2 relative inline-block">
                    <img src={podPhoto} alt="POD" className="h-20 rounded border" />
                    <button onClick={() => setPodPhoto('')} className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] w-4 h-4 rounded-full flex items-center justify-center">x</button>
                  </div>
                )}
              </div>
              <div className="flex justify-end pt-2">
                <button
                  onClick={confirmPos}
                  disabled={podSaving || !podReceiver.trim()}
                  className="bg-green-600 hover:bg-green-700 text-white text-sm font-semibold px-5 py-2 rounded-lg transition-colors disabled:opacity-50"
                >
                  {podSaving ? 'Saving...' : 'Confirm POS'}
                </button>
              </div>
            </div>
          )}

          {/* Manual delivery close panel */}
          {showManualClose && (
            <div className="mt-4 p-4 bg-amber-50 border border-amber-200 rounded-lg space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-bold text-amber-800">Close Delivery (Manual)</h4>
                <button onClick={() => setShowManualClose(false)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
              </div>
              <p className="text-xs text-amber-700">Use this when the driver did not complete the delivery through the app.</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Delivered By (Driver) *</label>
                  <input value={mcDeliveredBy} onChange={e => setMcDeliveredBy(e.target.value)} placeholder="Driver name" className={inputClass} />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Delivery Date & Time</label>
                  <input type="datetime-local" value={mcDeliveredAt} onChange={e => setMcDeliveredAt(e.target.value)} className={inputClass} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Received By *</label>
                  <input value={mcReceivedBy} onChange={e => setMcReceivedBy(e.target.value)} placeholder="Receiver name" className={inputClass} />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Receiver ID / License</label>
                  <input value={mcReceivedId} onChange={e => setMcReceivedId(e.target.value)} placeholder="Optional" className={inputClass} />
                </div>
              </div>
              <div>
                <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Notes</label>
                <textarea value={mcNotes} onChange={e => setMcNotes(e.target.value)} rows={2} placeholder="Optional notes" className={inputClass} />
              </div>
              <div className="flex justify-end pt-2">
                <button
                  onClick={confirmManualClose}
                  disabled={mcSaving || !mcDeliveredBy.trim() || !mcReceivedBy.trim()}
                  className="bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold px-5 py-2 rounded-lg transition-colors disabled:opacity-50"
                >
                  {mcSaving ? 'Closing...' : 'Confirm Delivery'}
                </button>
              </div>
            </div>
          )}

          {/* Check-in validation panel */}
          {showCheckIn && (
            <div className="mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-bold text-yellow-800">Validate data before Check-in</h4>
                <button onClick={() => setShowCheckIn(false)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">AWB</label>
                  <input value={ciAwb} onChange={e => setCiAwb(e.target.value)} placeholder="045-12345678" className={inputClass} />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Reference</label>
                  <input value={ciReference} onChange={e => setCiReference(e.target.value)} className={inputClass} />
                </div>
              </div>
              <div className="grid grid-cols-4 gap-3">
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Pieces</label>
                  <input type="number" min="1" value={ciPieces} onChange={e => setCiPieces(e.target.value)} className={inputClass} />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Weight (kg)</label>
                  <input type="number" min="0" step="0.1" value={ciWeight} onChange={e => setCiWeight(e.target.value)} className={inputClass} />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Cargo Type</label>
                  <select value={ciCargoType} onChange={e => setCiCargoType(e.target.value as WSCargoType)} className={inputClass}>
                    {CARGO_TYPES.map(ct => <option key={ct.value} value={ct.value}>{ct.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Mode</label>
                  <div className="flex gap-1 mt-0.5">
                    {(['LOC', 'BOND'] as WSCargoMode[]).map(m => (
                      <button key={m} type="button" onClick={() => setCiCargoMode(m)} className={`text-xs px-2.5 py-1.5 rounded border transition-colors ${ciCargoMode === m ? 'bg-mcl-blue text-white border-mcl-blue' : 'bg-white text-gray-600 border-gray-200'}`}>
                        {m === 'LOC' ? 'Local' : 'Bond'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div>
                <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Cargo description</label>
                <input value={ciCargoDesc} onChange={e => setCiCargoDesc(e.target.value)} className={inputClass} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Driver</label>
                  <input value={ciDriverName} onChange={e => setCiDriverName(e.target.value)} placeholder="Driver name" className={inputClass} />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">License</label>
                  <input value={ciDriverLicense} onChange={e => setCiDriverLicense(e.target.value)} placeholder="FL-123456" className={inputClass} />
                </div>
              </div>
              <div className="flex justify-end pt-2">
                <button onClick={confirmCheckIn} disabled={ciSaving} className="bg-yellow-500 hover:bg-yellow-600 text-white text-sm font-semibold px-5 py-2 rounded-lg transition-colors disabled:opacity-50">
                  {ciSaving ? 'Saving...' : 'Confirm Check-in'}
                </button>
              </div>
            </div>
          )}

          {/* WS DO creation panel */}
          {showWsDo && isTransportOnly && (
            <div className="mt-4 p-4 bg-emerald-50 border border-emerald-200 rounded-lg space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-bold text-emerald-800">Create Delivery Order</h4>
                <button onClick={() => setShowWsDo(false)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Trucking Company</label>
                  <select value={wsTruckingSelect} onChange={e => { setWsTruckingSelect(e.target.value); if (e.target.value !== 'Other') setWsTrucking('') }} className={inputClass}>
                    {['CO-Transportation', 'GEO Transport', 'Other'].map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  {wsTruckingSelect === 'Other' && (
                    <input value={wsTrucking} onChange={e => setWsTrucking(e.target.value)} placeholder="Company name" className={inputClass + ' mt-1'} />
                  )}
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Driver Name</label>
                  <div className="flex gap-1">
                    <input value={wsDriverName} onChange={e => setWsDriverName(e.target.value)} placeholder="Driver name" className={inputClass + ' flex-1'} />
                    <button type="button" onClick={loadWsDriverQueue} className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-2 py-1 rounded whitespace-nowrap">Cola</button>
                  </div>
                </div>
              </div>
              {/* Driver Queue picker */}
              {wsShowQueue && (
                <div className="p-3 bg-white border border-gray-200 rounded-lg space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-gray-600 uppercase">Driver Queue</span>
                    <button onClick={() => setWsShowQueue(false)} className="text-xs text-gray-400 hover:text-gray-600">Close</button>
                  </div>
                  {wsDriverQueue.length === 0 ? (
                    <div className="text-xs text-gray-400 text-center py-2">No hay drivers en cola</div>
                  ) : (
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {wsDriverQueue.map(entry => (
                        <button
                          key={entry.id}
                          onClick={() => selectDriverFromQueue(entry)}
                          className="w-full text-left p-2 rounded hover:bg-emerald-50 border border-gray-100 flex items-center justify-between"
                        >
                          <div>
                            <div className="text-sm font-semibold text-gray-800">{entry.driver_name}</div>
                            <div className="text-xs text-gray-500">{entry.vendor_name}{entry.plate ? ` — ${entry.plate}` : ''}</div>
                          </div>
                          <span className="text-xs text-emerald-600 font-semibold">Seleccionar</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Custody Method (optional)</label>
                  <input value={wsCustody} onChange={e => setWsCustody(e.target.value)} placeholder="e.g. Seal, Escort" className={inputClass} />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-0.5">Seal # (optional)</label>
                  <input value={wsSealNumber} onChange={e => setWsSealNumber(e.target.value)} placeholder="10171619" className={inputClass} />
                </div>
              </div>
              <div className="text-xs text-gray-500 bg-white/60 p-2 rounded">
                Route: {(order as any).pickup_from || '?'} &rarr; {(order as any).extra_stops?.length > 0 ? (order as any).extra_stops.join(' → ') + ' → ' : ''}{(order as any).deliver_to || '?'}
              </div>
              <div className="flex justify-end pt-2">
                <button
                  onClick={createWsDo}
                  disabled={wsDoCreating || !wsDriverName.trim()}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold px-5 py-2 rounded-lg transition-colors disabled:opacity-50"
                >
                  {wsDoCreating ? 'Creating...' : 'Create DO + Generate PIN'}
                </button>
              </div>
            </div>
          )}
        </div>



        {/* Fee-only Billing Section */}
        {isFeeOnly && (
          <div className="bg-white rounded-xl shadow-sm border p-6">
            <h3 className="text-sm font-bold text-gray-700 mb-4 uppercase">Billing Charges</h3>
            {feeCharges.length > 0 ? (
              <div className="space-y-2 mb-4">
                {feeCharges.map(ch => (
                  <div key={ch.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                    <div>
                      <span className="text-sm font-semibold text-gray-800">{ch.description}</span>
                      <span className={`ml-2 text-[10px] px-2 py-0.5 rounded-full font-bold ${ch.status === 'pending' ? 'bg-yellow-100 text-yellow-700' : ch.status === 'invoiced' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
                        {ch.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-bold text-gray-800 font-mono">${Number(ch.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                      {ch.status === 'pending' && (
                        <button
                          onClick={async () => {
                            if (!confirm(`Eliminar cargo "${ch.description}"?`)) return
                            await deleteDoc(doc(db, 'ws_billing_charges', ch.id))
                            setFeeCharges(prev => prev.filter(c => c.id !== ch.id))
                          }}
                          className="text-red-400 hover:text-red-600 p-1"
                          title="Eliminar"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                <div className="text-right text-sm font-bold text-mcl-blue pt-2 border-t">
                  Total: ${feeCharges.reduce((s, c) => s + Number(c.amount), 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-400 mb-4">No charges yet. Add a manual charge below.</p>
            )}
            {order.global_status !== 'billed' && (
              <div className="flex items-end gap-3 p-3 bg-blue-50 rounded-lg">
                <div className="flex-1">
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-1">Description</label>
                  <input
                    value={feeDesc}
                    onChange={e => setFeeDesc(e.target.value)}
                    placeholder="Handling & Storage Fee"
                    className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                  />
                </div>
                <div className="w-32">
                  <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-1">Amount (USD)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={feeAmount}
                    onChange={e => setFeeAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm text-right font-mono focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                  />
                </div>
                <button
                  disabled={feeSaving || !feeAmount || !feeDesc.trim()}
                  onClick={async () => {
                    const amt = parseFloat(feeAmount)
                    if (isNaN(amt) || amt <= 0) { alert('Ingrese un monto valido'); return }
                    setFeeSaving(true)
                    try {
                      const now = new Date().toISOString()
                      const ref = await addDoc(collection(db, 'ws_billing_charges'), {
                        so_id: order.id,
                        so_number: order.so_number,
                        client_id: order.client_id,
                        client_name: order.client_name,
                        service_type: 'handling_storage_fee',
                        description: feeDesc.trim(),
                        amount: amt,
                        currency: 'USD',
                        status: 'pending',
                        rate_id: null,
                        created_at: now,
                        created_by: user?.email || 'unknown',
                      })
                      setFeeCharges(prev => [...prev, { id: ref.id, so_id: order.id, so_number: order.so_number, client_id: order.client_id, client_name: order.client_name, service_type: 'handling_storage_fee', description: feeDesc.trim(), amount: amt, currency: 'USD', status: 'pending', created_at: now }])
                      setFeeAmount('')
                      setFeeDesc('')
                    } catch (e) { alert('Error: ' + String(e)) }
                    setFeeSaving(false)
                  }}
                  className="bg-mcl-blue text-white text-sm font-semibold px-4 py-1.5 rounded-lg hover:bg-blue-900 disabled:opacity-50 transition-colors whitespace-nowrap"
                >
                  {feeSaving ? 'Saving...' : 'Add Charge'}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Timeline */}
        {!isFeeOnly && (
        <div className="bg-white rounded-xl shadow-sm border p-6">
          <h3 className="text-sm font-bold text-gray-700 mb-4 uppercase">Timeline</h3>
          <div className="space-y-3">
            {(order.fee_only ? [
              { label: 'SO Created', date: order.created_at, by: order.created_by },
              { label: 'Completed', date: order.completed_at, by: null },
              { label: 'Billed', date: order.billed_at, by: null },
            ] : order.transport_only ? [
              { label: 'SO Created', date: order.created_at, by: order.created_by },
              { label: 'DO Assigned', date: wsDoData?.created_at || null, by: wsDoData ? `${wsDoData.do_number} — ${wsDoData.driver_name}` : null },
              { label: 'Delivered', date: wsDoData?.delivered_at || null, by: wsTrackingData?.receiver_name || null },
              { label: 'Completed', date: order.completed_at, by: null, pod: order.pod_at ? order.pod_receiver : null, pos: !!order.pod_at },
            ] : [
              { label: 'SO Created', date: order.created_at, by: order.created_by },
              { label: 'Check-in', date: order.checked_in_at, by: order.counter_agent },
              { label: 'Received', date: order.received_at, by: null },
              { label: 'Completed', date: order.completed_at, by: null, pod: order.pod_at ? order.pod_receiver : null, pos: !!order.pod_at },
            ]).map((step, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className={`w-3 h-3 rounded-full ${step.date ? 'bg-green-500' : 'bg-gray-200'}`} />
                <div className="flex-1">
                  <span className={`text-sm ${step.date ? 'text-gray-800 font-semibold' : 'text-gray-400'}`}>{step.label}</span>
                  {step.date && (
                    <span className="text-xs text-gray-400 ml-2">
                      {new Date(step.date).toLocaleString('es-CL')}
                      {step.by && ` — ${step.by}`}
                      {'pod' in step && step.pod && ` — POS: ${step.pod}`}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
        )}

        {/* Services */}
        {!isFeeOnly && (
        <div className="bg-white rounded-xl shadow-sm border p-6">
          <h3 className="text-sm font-bold text-gray-700 mb-4 uppercase">Services</h3>
          <div className="space-y-3">
            {order.service_items.map(item => (
              <div key={item.id} className="p-3 bg-gray-50 rounded-lg">
                {editingItemId === item.id ? (
                  /* ── Full edit panel ── */
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-gray-800">{SERVICE_LABELS[item.type] || item.type}</span>
                        <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-medium">EDITING</span>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => setEditingItemId(null)} className="text-xs text-gray-500 hover:text-gray-700 border border-gray-300 px-3 py-1.5 rounded-lg">Cancel</button>
                        <button onClick={saveItemEdit} disabled={eiSaving} className="text-xs bg-mcl-blue text-white px-4 py-1.5 rounded-lg hover:bg-blue-900 disabled:opacity-50 font-semibold">
                          {eiSaving ? 'Saving...' : 'Save'}
                        </button>
                      </div>
                    </div>

                    {/* Status */}
                    <div>
                      <label className="text-[10px] text-gray-500 uppercase block mb-1">Status</label>
                      <div className="flex gap-2 flex-wrap">
                        {(['pending', 'in_progress', 'completed', 'cancelled', 'fail'] as WSServiceItemStatus[]).map(st => (
                          <button
                            key={st}
                            type="button"
                            onClick={() => setEiStatus(st)}
                            className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${eiStatus === st ? ITEM_STATUS_COLORS[st] + ' border-current font-bold' : 'bg-white text-gray-500 border-gray-200'}`}
                          >
                            {ITEM_STATUS_LABELS[st]}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Type-specific fields */}
                    {item.type === 'transport' && (
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-[10px] text-gray-500 uppercase block mb-1">Pickup From</label>
                          <input value={eiPickupFrom} onChange={e => setEiPickupFrom(e.target.value)} className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs w-full focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
                        </div>
                        <div>
                          <label className="text-[10px] text-gray-500 uppercase block mb-1">Deliver To</label>
                          <input value={eiDeliverTo} onChange={e => setEiDeliverTo(e.target.value)} className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs w-full focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
                        </div>
                      </div>
                    )}
                    {item.type.startsWith('screening_') && (
                      <div>
                        <label className="text-[10px] text-gray-500 uppercase block mb-1">Method</label>
                        <select value={eiMethod || ''} onChange={e => setEiMethod((e.target.value || null) as any)} className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs w-full focus:outline-none focus:ring-2 focus:ring-mcl-blue/30">
                          <option value="">—</option>
                          <option value="k9">K9</option>
                          <option value="xray">X-Ray</option>
                          <option value="manual">Manual</option>
                        </select>
                      </div>
                    )}
                    <div>
                      <label className="text-[10px] text-gray-500 uppercase block mb-1">Location</label>
                      <input value={eiLocation} onChange={e => setEiLocation(e.target.value)} className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs w-full focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
                    </div>
                    <div>
                      <label className="text-[10px] text-gray-500 uppercase block mb-1">Notes</label>
                      <textarea value={eiNotes} onChange={e => setEiNotes(e.target.value)} rows={2} className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs w-full focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
                    </div>
                  </div>
                ) : (
                  /* ── Read-only view ── */
                  <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className={`text-xs font-semibold px-2 py-1 rounded-full ${ITEM_STATUS_COLORS[item.status]}`}>
                    {ITEM_STATUS_LABELS[item.status]}
                  </span>
                  <div>
                    <div className="text-sm font-semibold text-gray-800">
                      {SERVICE_LABELS[item.type] || item.type}
                      {canEditOrder && (
                        <button onClick={() => openItemEdit(item)} className="ml-2 text-gray-400 hover:text-mcl-blue inline-flex align-middle" title="Edit">
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                        </button>
                      )}
                    </div>
                    {item.type === 'transport' && (item.pickup_from || item.deliver_to) && (
                      <div className="text-xs text-gray-400">
                        {item.pickup_from && `From: ${item.pickup_from}`}
                        {item.pickup_from && item.deliver_to && ' -> '}
                        {item.deliver_to && `To: ${item.deliver_to}`}
                      </div>
                    )}
                    {item.type === 'transport' && order.do_number && (
                      <div className="text-xs text-mcl-blue font-mono font-semibold">DO: {order.do_number}</div>
                    )}
                    {item.location && <div className="text-xs text-gray-400">Location: {item.location}</div>}
                    {item.notes && <div className="text-xs text-gray-400">Notes: {item.notes}</div>}
                    {item.completed_at && (
                      <div className="text-xs text-gray-400">
                        {new Date(item.completed_at).toLocaleString('es-CL')}
                        {item.completed_by && ` — ${item.completed_by}`}
                      </div>
                    )}
                    {(item.report_pdf_url || item.cert_url) && (
                      <a
                        href={item.report_pdf_url || item.cert_url || ''}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-mcl-blue hover:underline mt-1"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        {item.report_pdf_url ? 'View Report' : 'View Certificate'}
                      </a>
                    )}
                  </div>
                </div>
                {canEdit && item.status !== 'completed' && item.status !== 'cancelled' && item.status !== 'fail' && (() => {
                  // in_out and storage are automatic — no manual buttons
                  const isAutomatic = item.type === 'in_out' || item.type === 'storage'
                  if (isAutomatic) {
                    if (!order.received_at && item.status === 'pending') {
                      return (
                        <span className="text-[10px] text-gray-400 bg-gray-100 px-2 py-1 rounded">
                          Auto on reception
                        </span>
                      )
                    }
                    return null
                  }
                  // Transport is managed via Delivery Orders
                  if (item.type === 'transport') {
                    if ((item.status === 'pending' || item.status === 'in_progress') && !order.do_id) {
                      return (
                        <button
                          onClick={() => navigate(`/warehouse-services/delivery-order/new?so=${order.id}`)}
                          className="text-xs bg-blue-100 hover:bg-blue-200 text-blue-700 px-2 py-1 rounded transition-colors"
                        >
                          Create DO
                        </button>
                      )
                    }
                    if (order.do_id) {
                      return (
                        <button
                          onClick={() => navigate(`/warehouse-services/delivery-order/${order.do_id}`)}
                          className="text-xs bg-blue-50 hover:bg-blue-100 text-blue-600 px-2 py-1 rounded transition-colors font-mono"
                        >
                          {order.do_number || 'View DO'}
                        </button>
                      )
                    }
                    return null
                  }
                  const needsReception = !order.received_at
                  if (needsReception) {
                    return (
                      <span className="text-[10px] text-amber-600 bg-amber-50 border border-amber-200 px-2 py-1 rounded">
                        Requires physical reception
                      </span>
                    )
                  }
                  return (
                    <div className="flex gap-1">
                      {item.status === 'pending' && (
                        <button
                          onClick={() => updateServiceItemStatus(item.id, 'in_progress')}
                          className="text-xs bg-orange-100 hover:bg-orange-200 text-orange-700 px-2 py-1 rounded transition-colors"
                        >
                          Start
                        </button>
                      )}
                      {(item.status === 'in_progress' || item.status === 'scheduled') && (
                        <>
                          <button
                            onClick={() => updateServiceItemStatus(item.id, 'completed')}
                            className="text-xs bg-green-100 hover:bg-green-200 text-green-700 px-2 py-1 rounded transition-colors"
                          >
                            Complete
                          </button>
                          {(item.type.startsWith('screening_') || item.type === 'dg_inspection') && (
                            <button
                              onClick={() => updateServiceItemStatus(item.id, 'fail')}
                              className="text-xs bg-red-100 hover:bg-red-200 text-red-700 px-2 py-1 rounded transition-colors"
                            >
                              Fail
                            </button>
                          )}
                        </>
                      )}
                      <button
                        onClick={() => updateServiceItemStatus(item.id, 'cancelled')}
                        className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-500 px-2 py-1 rounded transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  )
                })()}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
        )}

        {/* Documents */}
        {!isFeeOnly && (
        <div className="bg-white rounded-xl shadow-sm border p-6">
          <h3 className="text-sm font-bold text-gray-700 mb-4 uppercase">Documents</h3>
          <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileUpload} accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls,.csv,.doc,.docx" multiple />

          {/* Transport-only: single upload block */}
          {isTransportOnly ? (
            <div>
              <div
                className={`p-4 rounded-lg border-2 border-dashed transition-colors ${dragOverSlot === 'transport_docs' ? 'bg-blue-50 border-mcl-blue' : 'bg-gray-50 border-gray-200'}`}
                onDragOver={canEdit ? (e) => { e.preventDefault(); e.stopPropagation(); setDragOverSlot('transport_docs') } : undefined}
                onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setDragOverSlot(null) }}
                onDrop={canEdit ? (e) => { setDragOverSlot(null); handleDocDrop(e, 'transport_docs') } : undefined}
              >
                <div className="text-center">
                  <svg className="w-8 h-8 mx-auto text-gray-300 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
                  <div className="text-xs text-gray-500 mb-2">Drag & drop files here or</div>
                  {canEdit && (
                    <button
                      onClick={() => triggerUpload('transport_docs')}
                      disabled={uploading === 'transport_docs'}
                      className="text-xs bg-mcl-blue hover:bg-blue-900 text-white font-semibold px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
                    >
                      {uploading === 'transport_docs' ? 'Uploading...' : 'Upload Documents'}
                    </button>
                  )}
                </div>
              </div>
              {/* File list */}
              {(() => {
                const allDocs = (order.documents || []).filter(d => d.key === 'transport_docs')
                if (allDocs.length === 0) return null
                return (
                  <div className="mt-3 space-y-1.5">
                    {allDocs.map(f => (
                      <div key={f.id} className="flex items-center gap-3 p-2 bg-gray-50 rounded-lg">
                        <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                        <a href={f.url} target="_blank" rel="noopener noreferrer" className="text-sm text-mcl-blue hover:underline truncate flex-1">
                          {f.filename}
                        </a>
                        <span className="text-[10px] text-gray-400 whitespace-nowrap">{new Date(f.uploaded_at).toLocaleDateString('es-CL')}</span>
                        <a href={f.url} download className="text-gray-400 hover:text-mcl-blue" title="Download">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                        </a>
                        {canEdit && (
                          <button onClick={() => removeDoc(f.id)} className="text-gray-400 hover:text-red-500" title="Delete">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )
              })()}
            </div>
          ) : (
            /* Normal SO: individual doc slots */
            <div className="space-y-2">
              {docSlots.map(slot => {
                const files = (order.documents || []).filter(d => d.key === slot.key)
                const isDragOver = dragOverSlot === slot.key
                return (
                  <div
                    key={slot.key}
                    className={`flex items-center justify-between p-3 rounded-lg transition-colors ${isDragOver ? 'bg-blue-50 border-2 border-dashed border-mcl-blue' : 'bg-gray-50'}`}
                    onDragOver={canEdit ? (e) => { e.preventDefault(); e.stopPropagation(); setDragOverSlot(slot.key) } : undefined}
                    onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setDragOverSlot(null) }}
                    onDrop={canEdit ? (e) => { setDragOverSlot(null); handleDocDrop(e, slot.key) } : undefined}
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-gray-700">{slot.label}</span>
                        {files.length > 0 && (
                          <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-semibold">
                            {files.length}
                          </span>
                        )}
                      </div>
                      {isDragOver && files.length === 0 && (
                        <div className="text-xs text-mcl-blue mt-1">Drop files here...</div>
                      )}
                      {files.map(f => (
                        <div key={f.id} className="flex items-center gap-2 mt-1">
                          <a href={f.url} target="_blank" rel="noopener noreferrer" className="text-xs text-mcl-blue hover:underline truncate max-w-[200px]">
                            {f.filename}
                          </a>
                          <span className="text-[10px] text-gray-400">{new Date(f.uploaded_at).toLocaleDateString('es-CL')}</span>
                          {canEdit && (
                            <button onClick={() => removeDoc(f.id)} className="text-[10px] text-red-400 hover:text-red-600">x</button>
                          )}
                        </div>
                      ))}
                    </div>
                    {canEdit && (
                      <button
                        onClick={() => triggerUpload(slot.key)}
                        disabled={uploading === slot.key}
                        className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-3 py-1.5 rounded transition-colors disabled:opacity-50"
                      >
                        {uploading === slot.key ? 'Uploading...' : '+ Upload'}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
        )}

        {/* Cross references */}
        {!isFeeOnly && (
        <div className="bg-white rounded-xl shadow-sm border p-6">
          <h3 className="text-sm font-bold text-gray-700 mb-4 uppercase">References</h3>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-xs text-gray-400 uppercase">Warehouse Receipt</div>
              {wrData ? (
                <span className="font-mono font-bold text-mcl-blue">{wrData.wr_number}</span>
              ) : (
                <span className="text-gray-400">Pending</span>
              )}
            </div>
            <div>
              <div className="text-xs text-gray-400 uppercase">Driver</div>
              <div>{order.driver_name || '—'}</div>
              {order.driver_license && <div className="text-xs text-gray-400">{order.driver_license}</div>}
            </div>
          </div>
        </div>
        )}
      </div>
    </Layout>
  )
}
