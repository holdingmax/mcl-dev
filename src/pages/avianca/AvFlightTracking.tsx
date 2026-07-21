import React, { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { doc, getDoc, updateDoc, deleteDoc, addDoc, setDoc, collection, getDocs, query, where, writeBatch } from 'firebase/firestore'
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage, auth } from '../../lib/firebase'
import Layout from '../../components/Layout'
import type { AvFlight, AvFlightAwb, AvPalletTag, AvDeliveryOrder, DeliveryTracking } from '../../types'
import { logAvEvent } from '../../lib/avLog'
import { useAvCan } from '../../lib/avPermissions'
import { buildAvLbChecklistHtml, LB_DEFAULTS, QUESTIONS, type LbAnswer, type LbChecklistAnswers } from '../../lib/avLbChecklistPdf'

type AwbWithId = AvFlightAwb & { id: string }
type PtWithId = AvPalletTag & { id: string }

export default function AvFlightTracking() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { canAv } = useAvCan()
  const [flight, setFlight] = useState<(AvFlight & { id: string }) | null>(null)
  const [awbs, setAwbs] = useState<AwbWithId[]>([])
  const [palletTags, setPalletTags] = useState<PtWithId[]>([])
  const [loading, setLoading] = useState(true)

  // Add AWB inline
  const [showAddAwb, setShowAddAwb] = useState(false)
  const [newAwbNumber, setNewAwbNumber] = useState('')
  const [addingAwb, setAddingAwb] = useState(false)
  const addAwbRef = useRef<HTMLInputElement>(null)

  // Edit AWB modal
  const [editingAwb, setEditingAwb] = useState<AwbWithId | null>(null)
  const [editForm, setEditForm] = useState<Partial<AvFlightAwb>>({})
  const [savingEdit, setSavingEdit] = useState(false)

  // Doc upload
  const [uploadingDocFor, setUploadingDocFor] = useState<string | null>(null)
  const [uploadingDgFor, setUploadingDgFor] = useState<string | null>(null)

  // Pallet tag upload
  const [uploadingPalletTag, setUploadingPalletTag] = useState(false)
  const palletTagInputRef = useRef<HTMLInputElement>(null)

  // Delete flight
  const [showDeleteFlight, setShowDeleteFlight] = useState(false)
  const [deletingFlight, setDeletingFlight] = useState(false)

  // Remove AWB (soft-delete)
  const [removingAwb, setRemovingAwb] = useState<AwbWithId | null>(null)
  const [removalReason, setRemovalReason] = useState<'hold' | 'flight_change' | 'client_cancel' | 'other'>('hold')
  const [removalDetail, setRemovalDetail] = useState('')
  const [savingRemoval, setSavingRemoval] = useState(false)

  // Flight notes
  const [showNotes, setShowNotes] = useState(false)
  const [notes, setNotes] = useState<{ text: string; author: string; created_at: string }[]>([])
  const [newNote, setNewNote] = useState('')
  const [savingNote, setSavingNote] = useState(false)

  // Move AWB to another flight
  const [moveAwb, setMoveAwb] = useState<AwbWithId | null>(null)
  const [availableFlights, setAvailableFlights] = useState<{ id: string; flight_number: string; flight_date: string; destination: string }[]>([])
  const [selectedFlightId, setSelectedFlightId] = useState('')
  const [movingAwb, setMovingAwb] = useState(false)

  // Modules dropdown
  const [showModulesMenu, setShowModulesMenu] = useState(false)
  const [showStatusMenu, setShowStatusMenu] = useState(false)

  // CM (Check Manifest) mini-menu
  const [cmMenuAwbId, setCmMenuAwbId] = useState<string | null>(null)

  // Edit Pallet Tag modal
  const [editingPt, setEditingPt] = useState<PtWithId | null>(null)
  const [ptEditForm, setPtEditForm] = useState<{ pallet_number: string; screened: boolean; lines: { awb_number: string; pieces: number; weight_kg: number }[] }>({ pallet_number: '', screened: false, lines: [] })
  const [savingPtEdit, setSavingPtEdit] = useState(false)

  // Manual Pallet Tag creation
  const [manualPtAwb, setManualPtAwb] = useState<AwbWithId | null>(null)
  const [manualPtForm, setManualPtForm] = useState<{ pallet_number: string; screened: boolean; lines: { awb_number: string; pieces: number; weight_kg: number }[] }>({ pallet_number: '', screened: false, lines: [] })
  const [savingManualPt, setSavingManualPt] = useState(false)

  // Delivery Orders + Tracking
  const [avDos, setAvDos] = useState<(AvDeliveryOrder & { id: string })[]>([])
  const [trackingMap, setTrackingMap] = useState<Record<string, DeliveryTracking>>({})

  // LB Checklist modal
  const [lbAwb, setLbAwb] = useState<AwbWithId | null>(null)
  const [lbAnswers, setLbAnswers] = useState<LbChecklistAnswers>({ ...LB_DEFAULTS })
  const [lbLoading, setLbLoading] = useState(false)
  const [lbSaving, setLbSaving] = useState(false)



  useEffect(() => {
    if (id) loadFlight(id)
  }, [id])

  // Auto-reload every 5s when AWBs are pending/processing AI
  useEffect(() => {
    const hasPending = awbs.some(a => a.ai_status === 'pending' || a.ai_status === 'processing')
      || palletTags.some(pt => pt.ai_status === 'pending' || pt.ai_status === 'processing')
    if (!hasPending || !id) return
    const interval = setInterval(() => loadFlight(id), 5000)
    return () => clearInterval(interval)
  }, [awbs, id])

  useEffect(() => {
    if (showAddAwb) addAwbRef.current?.focus()
  }, [showAddAwb])

  async function loadFlight(flightId: string) {
    setLoading(true)
    const [flightSnap, awbSnap, ptSnap, doSnap] = await Promise.all([
      getDoc(doc(db, 'av_flights', flightId)),
      getDocs(query(collection(db, 'av_flight_awbs'), where('flight_id', '==', flightId))),
      getDocs(query(collection(db, 'av_pallet_tags'), where('flight_id', '==', flightId))),
      getDocs(query(collection(db, 'av_delivery_orders'), where('flight_id', '==', flightId))),
    ])
    if (!flightSnap.exists()) { navigate('/avianca'); return }
    const flightData = { id: flightSnap.id, ...flightSnap.data() } as AvFlight & { id: string }
    setFlight(flightData)
    setNotes((flightData as any).notes || [])
    const loadedAwbs = awbSnap.docs.map(d => ({ id: d.id, ...d.data() } as AwbWithId)).sort((a, b) => a.awb_number.localeCompare(b.awb_number))
    const loadedPts = ptSnap.docs.map(d => ({ id: d.id, ...d.data() } as PtWithId)).sort((a, b) => a.pallet_number.localeCompare(b.pallet_number))

    // Reconcile screened_pcs from pallet tags (fix stale data)
    for (const awb of loadedAwbs) {
      let totalInPallets = 0
      let screenedPcs = 0
      for (const pt of loadedPts) {
        const line = pt.lines?.find(l => l.awb_number === awb.awb_number)
        if (!line) continue
        totalInPallets += line.pieces || 0
        if (pt.screened) screenedPcs += line.pieces || 0
      }
      const totalPcs = awb.pieces || 0
      let screeningStatus: 'pending' | 'partial' | 'complete' = 'pending'
      if (screenedPcs > 0 && screenedPcs >= totalPcs) screeningStatus = 'complete'
      else if (screenedPcs > 0) screeningStatus = 'partial'
      if (awb.screened_pcs !== screenedPcs || awb.total_pcs_in_pallets !== totalInPallets || awb.screening_status !== screeningStatus) {
        awb.screened_pcs = screenedPcs
        awb.total_pcs_in_pallets = totalInPallets
        awb.screening_status = screeningStatus
        updateDoc(doc(db, 'av_flight_awbs', awb.id), { screened_pcs: screenedPcs, total_pcs_in_pallets: totalInPallets, screening_status: screeningStatus }).catch(() => {})
      }
    }

    setAwbs(loadedAwbs)
    setPalletTags(loadedPts)
    const doList = doSnap.docs.map(d => ({ id: d.id, ...d.data() } as AvDeliveryOrder & { id: string }))
    setAvDos(doList)
    // Load tracking data
    const tMap: Record<string, DeliveryTracking> = {}
    for (const doItem of doList) {
      if (doItem.tracking_id) {
        try {
          const tSnap = await getDoc(doc(db, 'delivery_tracking', doItem.tracking_id))
          if (tSnap.exists()) tMap[doItem.do_number] = tSnap.data() as DeliveryTracking
        } catch { /* ignore */ }
      }
    }
    setTrackingMap(tMap)
    setLoading(false)
  }

  async function updateHeader(field: string, value: string) {
    if (!flight) return
    await updateDoc(doc(db, 'av_flights', flight.id), { [field]: value, updated_at: new Date().toISOString() })
    setFlight(prev => prev ? { ...prev, [field]: value } : null)
  }

  // ── Auto-advance: only moves forward, never back ──
  function computeAutoStatus(currentStatus: string, allAwbs: AwbWithId[]): string {
    const order = ['booked', 'in_progress', 'completed', 'dispatched']
    const idx = order.indexOf(currentStatus)
    const activeAwbs = allAwbs.filter(a => a.status !== 'removed')
    let s = currentStatus
    if (idx < 1 && activeAwbs.length > 0) s = 'in_progress'
    if (order.indexOf(s) === 1 && activeAwbs.length > 0 && activeAwbs.every(a => a.screening_status === 'complete')) s = 'completed'
    if (order.indexOf(s) === 2 && avDos.length > 0 && avDos.every(d => d.status === 'dispatched')) s = 'dispatched'
    return s
  }

  // ── Force flight status (manual click) ──
  async function forceFlightStatus(newStatus: string) {
    if (!flight || newStatus === flight.status) { setShowStatusMenu(false); return }
    const oldLabel = statusLabel[flight.status] || flight.status
    await updateDoc(doc(db, 'av_flights', flight.id), { status: newStatus, updated_at: new Date().toISOString() })
    logAvEvent(flight.id, '-', 'status_changed', `${oldLabel} → ${statusLabel[newStatus]} (manual)`, auth.currentUser?.email || '')
    setFlight(prev => prev ? { ...prev, status: newStatus as AvFlight['status'] } : null)
    setShowStatusMenu(false)
  }

  // ── Recalculate flight totals ──
  async function recalcFlightTotals(currentAwbs: AwbWithId[]) {
    if (!flight) return
    const totals: Record<string, any> = {
      total_awbs: currentAwbs.length,
      total_pieces: currentAwbs.reduce((s, a) => s + (a.pieces || 0), 0),
      total_gross_kg: currentAwbs.reduce((s, a) => s + (a.gross_weight_kg || 0), 0),
      total_chw_kg: currentAwbs.reduce((s, a) => s + (a.chw_kg || 0), 0),
      has_dg: currentAwbs.some(a => a.dg),
      has_lb: currentAwbs.some(a => a.lb),
      updated_at: new Date().toISOString(),
    }
    // Auto-advance flight status
    const newStatus = computeAutoStatus(flight.status, currentAwbs)
    if (newStatus !== flight.status) {
      totals.status = newStatus
      logAvEvent(flight.id, '-', 'status_changed', `${statusLabel[flight.status]} → ${statusLabel[newStatus]} (auto)`, auth.currentUser?.email || '')
    }
    await updateDoc(doc(db, 'av_flights', flight.id), totals)
    setFlight(prev => prev ? { ...prev, ...totals } : null)
  }

  // ── Add AWB (number only) ──
  async function addAwb() {
    if (!flight || !newAwbNumber.trim()) return
    setAddingAwb(true)
    const now = new Date().toISOString()
    const newAwb: Omit<AvFlightAwb, 'id'> = {
      flight_id: flight.id,
      awb_number: newAwbNumber.trim().toUpperCase(),
      iac: '',
      pieces: 0,
      gross_weight_kg: 0,
      chw_kg: 0,
      dg: false,
      dg_codes: [],
      lb: false,
      lb_detail: '',
      total_pcs_in_pallets: 0,
      screened_pcs: 0,
      screening_status: 'pending',
      created_at: now,
    }
    const ref = await addDoc(collection(db, 'av_flight_awbs'), newAwb)
    const updated = [...awbs, { id: ref.id, ...newAwb }].sort((a, b) => a.awb_number.localeCompare(b.awb_number))
    setAwbs(updated)
    await recalcFlightTotals(updated)
    logAvEvent(flight.id, newAwb.awb_number, 'awb_created', 'Creada manualmente', auth.currentUser?.email || '')
    setNewAwbNumber('')
    setAddingAwb(false)
    addAwbRef.current?.focus()
  }

  // ── Edit AWB (manual correction) ──
  function openEditAwb(awb: AwbWithId) {
    setEditForm({
      awb_number: awb.awb_number,
      iac: awb.iac,
      pieces: awb.pieces,
      gross_weight_kg: awb.gross_weight_kg,
      chw_kg: awb.chw_kg,
      dg: awb.dg,
      dg_codes: awb.dg_codes || [],
      lb: awb.lb,
      lb_detail: awb.lb_detail || '',
      shipper_name: awb.shipper_name || '',
      consignee_name: awb.consignee_name || '',
      agent_name: awb.agent_name || '',
      shipper_phone: awb.shipper_phone || '',
    })
    setEditingAwb(awb)
  }

  async function saveEditAwb() {
    if (!editingAwb) return
    setSavingEdit(true)
    const updates: Partial<AvFlightAwb> = {
      awb_number: (editForm.awb_number || '').trim().toUpperCase(),
      iac: editForm.iac || '',
      pieces: Number(editForm.pieces) || 0,
      gross_weight_kg: Number(editForm.gross_weight_kg) || 0,
      chw_kg: Number(editForm.chw_kg) || 0,
      dg: editForm.dg || false,
      dg_codes: editForm.dg ? (editForm.dg_codes || []) : [],
      lb: editForm.lb || false,
      lb_detail: editForm.lb ? (editForm.lb_detail || '') : '',
      shipper_name: editForm.shipper_name || '',
      consignee_name: editForm.consignee_name || '',
      agent_name: editForm.agent_name || '',
      shipper_phone: editForm.shipper_phone || '',
      updated_at: new Date().toISOString(),
    }
    await updateDoc(doc(db, 'av_flight_awbs', editingAwb.id), updates)
    const updated = awbs.map(a => a.id === editingAwb.id ? { ...a, ...updates } : a)
    setAwbs(updated)
    await recalcFlightTotals(updated)
    if (flight) logAvEvent(flight.id, updates.awb_number || editingAwb.awb_number, 'awb_edited', `Pcs: ${updates.pieces}, Gross: ${updates.gross_weight_kg} kg, CHW: ${updates.chw_kg} kg`, auth.currentUser?.email || '')
    setEditingAwb(null)
    setSavingEdit(false)
  }

  // ── Edit Pallet Tag ──
  function openEditPt(pt: PtWithId) {
    setPtEditForm({
      pallet_number: pt.pallet_number,
      screened: pt.screened || false,
      lines: (pt.lines || []).map(l => ({ awb_number: l.awb_number, pieces: l.pieces, weight_kg: l.weight_kg })),
    })
    setEditingPt(pt)
  }

  async function saveEditPt() {
    if (!editingPt) return
    setSavingPtEdit(true)
    const newLines = ptEditForm.lines.map(l => ({ awb_number: l.awb_number, pieces: Number(l.pieces) || 0, weight_kg: Number(l.weight_kg) || 0 }))
    const totalPieces = newLines.reduce((s, l) => s + l.pieces, 0)
    const totalWeightKg = newLines.reduce((s, l) => s + l.weight_kg, 0)
    const newPalletNumber = ptEditForm.pallet_number.replace(/\s/g, '').toUpperCase()
    const updates = {
      pallet_number: newPalletNumber,
      lines: newLines,
      total_pieces: totalPieces,
      total_weight_kg: totalWeightKg,
      screened: ptEditForm.screened,
      updated_at: new Date().toISOString(),
    }
    await updateDoc(doc(db, 'av_pallet_tags', editingPt.id), updates)
    const updatedPts = palletTags.map(p => p.id === editingPt.id ? { ...p, ...updates } : p)
    setPalletTags(updatedPts)

    // Recalculate total_pcs_in_pallets AND screened_pcs for affected AWBs
    const affectedAwbs = new Set(newLines.map(l => l.awb_number))
    editingPt.lines?.forEach(l => affectedAwbs.add(l.awb_number))
    const screeningUpdates: Record<string, 'pending' | 'partial' | 'complete'> = {}
    for (const awbNum of affectedAwbs) {
      const awb = awbs.find(a => a.awb_number === awbNum)
      if (!awb) continue
      let totalInPallets = 0
      let screenedPcs = 0
      for (const pt of updatedPts) {
        const line = pt.lines?.find(l => l.awb_number === awbNum)
        if (!line) continue
        totalInPallets += line.pieces || 0
        if (pt.screened) screenedPcs += line.pieces || 0
      }
      const totalPcs = awb.pieces || 0
      let screeningStatus: 'pending' | 'partial' | 'complete' = 'pending'
      if (screenedPcs > 0 && screenedPcs >= totalPcs) screeningStatus = 'complete'
      else if (screenedPcs > 0) screeningStatus = 'partial'
      screeningUpdates[awb.id] = screeningStatus
      await updateDoc(doc(db, 'av_flight_awbs', awb.id), { total_pcs_in_pallets: totalInPallets, screened_pcs: screenedPcs, screening_status: screeningStatus })
      setAwbs(prev => prev.map(a => a.id === awb.id ? { ...a, total_pcs_in_pallets: totalInPallets, screened_pcs: screenedPcs, screening_status: screeningStatus } : a))
    }

    // Auto-advance flight status after screening changes
    if (flight) {
      const effectiveAwbs = awbs.map(a => screeningUpdates[a.id] ? { ...a, screening_status: screeningUpdates[a.id] } : a)
      const advancedStatus = computeAutoStatus(flight.status, effectiveAwbs)
      if (advancedStatus !== flight.status) {
        await updateDoc(doc(db, 'av_flights', flight.id), { status: advancedStatus, updated_at: new Date().toISOString() })
        setFlight(prev => prev ? { ...prev, status: advancedStatus as AvFlight['status'] } : null)
        logAvEvent(flight.id, '-', 'status_changed', `${statusLabel[flight.status]} → ${statusLabel[advancedStatus]} (auto)`, auth.currentUser?.email || '')
      }
    }

    if (flight) {
      const awbList = newLines.map(l => l.awb_number).join(', ')
      logAvEvent(flight.id, awbList, 'pallet_tag_edited', `ULD: ${newPalletNumber} — ${totalPieces} pcs, ${totalWeightKg.toLocaleString()} kg`, auth.currentUser?.email || '')
    }
    setEditingPt(null)
    setSavingPtEdit(false)
  }

  // ── Manual Pallet Tag ──
  function openManualPt(awb: AwbWithId) {
    setManualPtForm({
      pallet_number: '',
      screened: false,
      lines: [{ awb_number: awb.awb_number, pieces: 0, weight_kg: 0 }],
    })
    setManualPtAwb(awb)
  }

  async function saveManualPt() {
    if (!manualPtAwb || !flight) return
    const trimmedPallet = manualPtForm.pallet_number.replace(/\s/g, '').toUpperCase()
    if (!trimmedPallet) return
    setSavingManualPt(true)
    try {
      const newLines = manualPtForm.lines
        .filter(l => l.awb_number.trim())
        .map(l => ({ awb_number: l.awb_number.trim(), pieces: Number(l.pieces) || 0, weight_kg: Number(l.weight_kg) || 0 }))
      const totalPieces = newLines.reduce((s, l) => s + l.pieces, 0)
      const totalWeightKg = newLines.reduce((s, l) => s + l.weight_kg, 0)
      const now = new Date().toISOString()
      const docRef = await addDoc(collection(db, 'av_pallet_tags'), {
        flight_id: flight.id,
        pallet_number: trimmedPallet,
        destination: flight.destination || '',
        date: now.slice(0, 10),
        lines: newLines,
        total_pieces: totalPieces,
        total_weight_kg: totalWeightKg,
        screened: manualPtForm.screened,
        source: 'manual',
        created_at: now,
        uploaded_by: auth.currentUser?.email || '',
      })
      const newPt: PtWithId = {
        id: docRef.id,
        flight_id: flight.id,
        pallet_number: trimmedPallet,
        destination: flight.destination || '',
        date: now.slice(0, 10),
        lines: newLines,
        total_pieces: totalPieces,
        total_weight_kg: totalWeightKg,
        screened: manualPtForm.screened,
        source: 'manual',
        created_at: now,
        uploaded_by: auth.currentUser?.email || '',
      } as PtWithId
      const updatedPts = [...palletTags, newPt]
      setPalletTags(updatedPts)

      // Recalculate totals for affected AWBs
      const manualScreeningUpdates: Record<string, 'pending' | 'partial' | 'complete'> = {}
      for (const line of newLines) {
        const awb = awbs.find(a => a.awb_number === line.awb_number)
        if (!awb) continue
        let totalInPallets = 0
        let screenedPcs = 0
        for (const pt of updatedPts) {
          const pl = pt.lines?.find(l => l.awb_number === line.awb_number)
          if (!pl) continue
          totalInPallets += pl.pieces || 0
          if (pt.screened) screenedPcs += pl.pieces || 0
        }
        const totalPcs = awb.pieces || 0
        let screeningStatus: 'pending' | 'partial' | 'complete' = 'pending'
        if (screenedPcs > 0 && screenedPcs >= totalPcs) screeningStatus = 'complete'
        else if (screenedPcs > 0) screeningStatus = 'partial'
        manualScreeningUpdates[awb.id] = screeningStatus
        await updateDoc(doc(db, 'av_flight_awbs', awb.id), { total_pcs_in_pallets: totalInPallets, screened_pcs: screenedPcs, screening_status: screeningStatus })
        setAwbs(prev => prev.map(a => a.id === awb.id ? { ...a, total_pcs_in_pallets: totalInPallets, screened_pcs: screenedPcs, screening_status: screeningStatus } : a))
      }

      // Auto-advance flight status after screening changes
      const effectiveAwbs = awbs.map(a => manualScreeningUpdates[a.id] ? { ...a, screening_status: manualScreeningUpdates[a.id] } : a)
      const advancedStatus = computeAutoStatus(flight.status, effectiveAwbs)
      if (advancedStatus !== flight.status) {
        await updateDoc(doc(db, 'av_flights', flight.id), { status: advancedStatus, updated_at: new Date().toISOString() })
        setFlight(prev => prev ? { ...prev, status: advancedStatus as AvFlight['status'] } : null)
        logAvEvent(flight.id, '-', 'status_changed', `${statusLabel[flight.status]} → ${statusLabel[advancedStatus]} (auto)`, auth.currentUser?.email || '')
      }

      const awbList = newLines.map(l => l.awb_number).join(', ')
      logAvEvent(flight.id, awbList, 'manual_position_created', `ULD: ${trimmedPallet} — ${totalPieces} pcs, ${totalWeightKg.toLocaleString()} kg`, auth.currentUser?.email || '')
      setManualPtAwb(null)
    } catch (err) {
      console.error('Error creating manual pallet tag:', err)
      alert('Error al crear posición manual')
    }
    setSavingManualPt(false)
  }

  // ── Remove AWB (hard delete) ──
  async function removeAwb() {
    if (!removingAwb || !flight) return
    setSavingRemoval(true)
    const billable = removalReason === 'hold' || removalReason === 'client_cancel'
    const reasonLabels: Record<string, string> = { hold: 'Carga en HOLD', flight_change: 'Cambio de vuelo', client_cancel: 'Cancelada por cliente', other: 'Otro' }
    // Hard delete the AWB document
    await deleteDoc(doc(db, 'av_flight_awbs', removingAwb.id))
    setAwbs(prev => prev.filter(a => a.id !== removingAwb.id))
    const activeAwbs = awbs.filter(a => a.id !== removingAwb.id && a.status !== 'removed')
    await recalcFlightTotals(activeAwbs)
    const detail = `${reasonLabels[removalReason]}${removalDetail ? ': ' + removalDetail : ''}${billable ? ' (billable)' : ' (no billable)'}`
    logAvEvent(flight.id, removingAwb.awb_number, 'awb_removed', detail, auth.currentUser?.email || '')
    setRemovingAwb(null)
    setRemovalDetail('')
    setSavingRemoval(false)
  }

  // ── Move AWB to another flight ──
  async function openMoveModal(awb: AwbWithId) {
    setMoveAwb(awb)
    setSelectedFlightId('')
    // Load available flights (exclude current)
    const snap = await getDocs(query(collection(db, 'av_flights'), where('status', 'in', ['booked', 'in_progress', 'completed'])))
    const flights = snap.docs
      .map(d => ({ id: d.id, ...d.data() } as { id: string; flight_number: string; flight_date: string; destination: string; status: string }))
      .filter(f => f.id !== id)
      .sort((a, b) => (b.flight_date || '').localeCompare(a.flight_date || ''))
    setAvailableFlights(flights)
  }

  async function handleMoveAwb() {
    if (!moveAwb || !selectedFlightId || !flight) return
    setMovingAwb(true)
    try {
      const targetFlightSnap = await getDoc(doc(db, 'av_flights', selectedFlightId))
      if (!targetFlightSnap.exists()) { alert('Vuelo destino no encontrado'); setMovingAwb(false); return }

      const now = new Date().toISOString()

      // Update AWB: new flight_id, reactivate, reset screening
      await updateDoc(doc(db, 'av_flight_awbs', moveAwb.id), {
        flight_id: selectedFlightId,
        status: 'active',
        removal_reason: '',
        removal_reason_detail: `Movida desde ${flight.flight_number}`,
        removed_at: '',
        removed_by: '',
        billable: false,
        total_pcs_in_pallets: 0,
        screened_pcs: 0,
        screening_status: 'pending',
        updated_at: now,
      })

      // Remove from local state
      setAwbs(prev => prev.filter(a => a.id !== moveAwb.id))

      // Recalc source flight totals
      const remainingActive = awbs.filter(a => a.id !== moveAwb.id && a.status !== 'removed')
      await recalcFlightTotals(remainingActive)

      // Recalc target flight totals — include the moved AWB directly
      // (the updateDoc above may not be reflected yet in a query)
      const targetAwbsSnap = await getDocs(query(collection(db, 'av_flight_awbs'), where('flight_id', '==', selectedFlightId)))
      const targetAwbsData = targetAwbsSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(a => a.status !== 'removed')
      // Ensure moved AWB is counted even if query hasn't caught up
      const movedAlreadyIncluded = targetAwbsData.some(a => a.id === moveAwb.id)
      if (!movedAlreadyIncluded) {
        targetAwbsData.push({ ...moveAwb, flight_id: selectedFlightId, status: 'active' } as any)
      }
      await updateDoc(doc(db, 'av_flights', selectedFlightId), {
        total_awbs: targetAwbsData.length,
        total_pieces: targetAwbsData.reduce((s, a: any) => s + (a.pieces || 0), 0),
        total_gross_kg: targetAwbsData.reduce((s, a: any) => s + (a.gross_weight_kg || 0), 0),
        total_chw_kg: targetAwbsData.reduce((s, a: any) => s + (a.chw_kg || 0), 0),
        has_dg: targetAwbsData.some((a: any) => a.dg),
        has_lb: targetAwbsData.some((a: any) => a.lb),
        updated_at: now,
      })

      const targetFlight = targetFlightSnap.data()
      logAvEvent(flight.id, moveAwb.awb_number, 'awb_moved_out', `Movida a ${targetFlight.flight_number}`, auth.currentUser?.email || '')
      logAvEvent(selectedFlightId, moveAwb.awb_number, 'awb_moved_in', `Movida desde ${flight.flight_number}`, auth.currentUser?.email || '')

      setMoveAwb(null)
    } catch (err: any) {
      console.error('Error moving AWB:', err)
      alert(`Error al mover AWB: ${err.message}`)
    }
    setMovingAwb(false)
  }

  // ── Add flight note ──
  async function addNote() {
    if (!flight || !newNote.trim()) return
    setSavingNote(true)
    const note = { text: newNote.trim(), author: auth.currentUser?.email || '', created_at: new Date().toISOString() }
    const updatedNotes = [...notes, note]
    await updateDoc(doc(db, 'av_flights', flight.id), { notes: updatedNotes, updated_at: new Date().toISOString() })
    setNotes(updatedNotes)
    setNewNote('')
    setSavingNote(false)
    logAvEvent(flight.id, '-', 'flight_note', newNote.trim(), auth.currentUser?.email || '')
  }

  // ── Upload AWB docs (fire-and-forget AI processing) ──
  async function handleAwbDocUpload(awbId: string, file: File) {
    if (!flight) return
    setUploadingDocFor(awbId)
    const path = `avianca/${flight.id}/awbs/${awbId}_${Date.now()}_${file.name}`
    const sRef = storageRef(storage, path)
    await uploadBytes(sRef, file)
    const url = await getDownloadURL(sRef)

    // Update AWB doc with URL and set ai_status to 'pending' to trigger Cloud Function
    await updateDoc(doc(db, 'av_flight_awbs', awbId), {
      doc_awb_url: url,
      doc_awb_filename: file.name,
      ai_status: 'pending',
      updated_at: new Date().toISOString(),
    })
    const awb = awbs.find(a => a.id === awbId)
    setAwbs(prev => prev.map(a => a.id === awbId ? { ...a, doc_awb_url: url, doc_awb_filename: file.name, ai_status: 'pending' } as AwbWithId : a))
    setUploadingDocFor(null)
    if (awb) logAvEvent(flight.id, awb.awb_number, 'doc_uploaded', file.name, auth.currentUser?.email || '')
  }

  // ── Upload DG checklist doc ──
  async function handleDgDocUpload(awbId: string, file: File) {
    if (!flight) return
    setUploadingDgFor(awbId)
    const path = `avianca/${flight.id}/dg/${awbId}_${Date.now()}_${file.name}`
    const sRef = storageRef(storage, path)
    await uploadBytes(sRef, file)
    const url = await getDownloadURL(sRef)

    const awb = awbs.find(a => a.id === awbId)
    const pcs = awb?.pieces || 0
    await updateDoc(doc(db, 'av_flight_awbs', awbId), {
      doc_dg_url: url,
      doc_dg_filename: file.name,
      screening_status: 'complete',
      screened_pcs: pcs,
      updated_at: new Date().toISOString(),
    })
    setAwbs(prev => prev.map(a => a.id === awbId ? { ...a, doc_dg_url: url, doc_dg_filename: file.name, screening_status: 'complete' as const, screened_pcs: pcs } : a))
    setUploadingDgFor(null)
    // Auto-advance flight status
    const effectiveDgAwbs = awbs.map(a => a.id === awbId ? { ...a, screening_status: 'complete' as const } : a)
    const dgAdvanced = computeAutoStatus(flight.status, effectiveDgAwbs)
    if (dgAdvanced !== flight.status) {
      await updateDoc(doc(db, 'av_flights', flight.id), { status: dgAdvanced, updated_at: new Date().toISOString() })
      setFlight(prev => prev ? { ...prev, status: dgAdvanced as AvFlight['status'] } : null)
      logAvEvent(flight.id, '-', 'status_changed', `${statusLabel[flight.status]} → ${statusLabel[dgAdvanced]} (auto)`, auth.currentUser?.email || '')
    }
    if (awb) logAvEvent(flight.id, awb.awb_number, 'dg_doc_uploaded', file.name, auth.currentUser?.email || '')
  }

  // ── Upload Pallet Tag (image/PDF → AI extraction) ──
  async function handlePalletTagUpload(file: File) {
    if (!flight || !auth.currentUser) return
    setUploadingPalletTag(true)
    const path = `avianca/${flight.id}/pallet-tags/${Date.now()}_${file.name}`
    const sRef = storageRef(storage, path)
    await uploadBytes(sRef, file)
    const url = await getDownloadURL(sRef)

    const now = new Date().toISOString()
    await addDoc(collection(db, 'av_pallet_tags'), {
      flight_id: flight.id,
      pallet_number: '',
      destination: flight.destination || '',
      date: '',
      lines: [],
      total_pieces: 0,
      total_weight_kg: 0,
      total_weight_kg: 0,
      screened: false,
      doc_url: url,
      doc_filename: file.name,
      ai_status: 'pending',
      created_at: now,
      uploaded_by: auth.currentUser.email || '',
    })
    setUploadingPalletTag(false)
    logAvEvent(flight.id, '-', 'pallet_tag_uploaded', `Archivo: ${file.name}`, auth.currentUser?.email || '')
    if (id) loadFlight(id)
  }

  // ── Delete flight ──
  async function handleDeleteFlight() {
    if (!flight) return
    setDeletingFlight(true)
    const batch = writeBatch(db)
    awbs.forEach(a => batch.delete(doc(db, 'av_flight_awbs', a.id)))
    palletTags.forEach(pt => batch.delete(doc(db, 'av_pallet_tags', pt.id)))
    batch.delete(doc(db, 'av_flights', flight.id))
    await batch.commit()
    logAvEvent(flight.id, '-', 'flight_deleted', `Vuelo ${flight.flight_number} eliminado con ${awbs.length} AWBs`, auth.currentUser?.email || '')
    navigate('/avianca')
  }

  // ── LB Checklist ──
  async function openLbChecklist(awb: AwbWithId) {
    // Show modal instantly with defaults (Q8 dynamic: YES if phone exists)
    const defaults = { ...LB_DEFAULTS, 8: (awb.shipper_phone ? 'yes' : 'na') as LbAnswer }
    setLbAnswers(defaults)
    setLbAwb(awb)
    setLbLoading(false)
    // Load saved answers in background using deterministic ID
    const docId = `${flight!.id}_${awb.awb_number.replace(/[^a-zA-Z0-9]/g, '')}`
    getDoc(doc(db, 'av_lb_checklists', docId))
      .then(snap => { if (snap.exists()) setLbAnswers(snap.data().answers as LbChecklistAnswers) })
      .catch(() => {})
  }

  async function saveLbAndPrint() {
    if (!lbAwb || !flight) return
    // Open window immediately in user gesture context
    const win = window.open('', '_blank')
    if (!win) { alert('Popup bloqueado.'); return }
    // Generate and display immediately (all data already in memory)
    const html = buildAvLbChecklistHtml({ awb: lbAwb, answers: lbAnswers, flightNumber: flight.flight_number, destination: flight.destination })
    win.document.write(html)
    win.document.close()
    win.document.title = `LB Checklist ${lbAwb.awb_number}`
    setLbAwb(null)
    // Save to Firestore in background (fire-and-forget)
    const docId = `${flight.id}_${lbAwb.awb_number.replace(/[^a-zA-Z0-9]/g, '')}`
    setDoc(doc(db, 'av_lb_checklists', docId), {
      flight_id: flight.id,
      awb_number: lbAwb.awb_number,
      awb_id: lbAwb.id,
      answers: lbAnswers,
      generated_by: auth.currentUser?.email || '',
      generated_at: new Date().toISOString(),
    }, { merge: true }).catch(() => {})
    logAvEvent(flight.id, lbAwb.awb_number, 'lb_checklist_generated', `Checklist LB generado`, auth.currentUser?.email || '')
  }

  const statusColor: Record<string, string> = {
    booked: 'bg-gray-400',
    in_progress: 'bg-yellow-500',
    completed: 'bg-green-500',
    dispatched: 'bg-blue-500',
  }
  const statusLabel: Record<string, string> = {
    booked: 'Booked',
    in_progress: 'In Progress',
    completed: 'Completed',
    dispatched: 'Dispatched',
  }

  if (loading || !flight) return <Layout title="Flight Tracking" backTo="/avianca"><div className="flex justify-center py-20"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" /></div></Layout>

  return (
    <Layout title="Flight Tracking" backTo="/avianca">
      {/* Header */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 mb-6">
        <div className="flex flex-wrap gap-6 items-center">
          <div>
            <label className="text-[10px] font-semibold text-gray-400 uppercase">Vuelo</label>
            <input
              type="text"
              value={flight.flight_number}
              onChange={e => setFlight(prev => prev ? { ...prev, flight_number: e.target.value } : null)}
              onBlur={e => updateHeader('flight_number', e.target.value.toUpperCase())}
              className="block text-xl font-bold text-gray-800 border-b border-transparent hover:border-gray-300 focus:border-mcl-blue focus:outline-none w-40 bg-transparent"
            />
          </div>
          <div>
            <label className="text-[10px] font-semibold text-gray-400 uppercase">ETD</label>
            <input
              type="datetime-local"
              value={flight.etd?.slice(0, 16)}
              onChange={e => { updateHeader('etd', e.target.value); setFlight(prev => prev ? { ...prev, etd: e.target.value } : null) }}
              className="block text-sm text-gray-700 border-b border-transparent hover:border-gray-300 focus:border-mcl-blue focus:outline-none bg-transparent"
            />
          </div>
          <div>
            <label className="text-[10px] font-semibold text-gray-400 uppercase">Destino</label>
            <input
              type="text"
              value={flight.destination}
              onChange={e => setFlight(prev => prev ? { ...prev, destination: e.target.value.toUpperCase() } : null)}
              onBlur={e => updateHeader('destination', e.target.value.toUpperCase())}
              className="block text-sm font-semibold text-gray-700 border-b border-transparent hover:border-gray-300 focus:border-mcl-blue focus:outline-none w-16 uppercase bg-transparent"
              maxLength={3}
            />
          </div>
          <div className="ml-auto flex items-center gap-3">
            {/* Modules dropdown */}
            <div className="relative">
              <button
                onClick={() => setShowModulesMenu(!showModulesMenu)}
                className="bg-gray-100 text-gray-700 px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-gray-200 flex items-center gap-1.5"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
                Modulos
              </button>
              {showModulesMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowModulesMenu(false)} />
                  <div className="absolute right-0 mt-1 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-20 w-48">
                    <button
                      onClick={() => { navigate(`/avianca/flight/${id}/screening`); setShowModulesMenu(false) }}
                      className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                    >
                      <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                      Screening
                    </button>
                    <button
                      onClick={() => { navigate(`/avianca/flight/${id}/delivery-orders`); setShowModulesMenu(false) }}
                      className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                    >
                      <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                      Delivery Orders
                    </button>
                    <button
                      onClick={() => { navigate(`/avianca/flight/${id}/manifest`); setShowModulesMenu(false) }}
                      className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                    >
                      <svg className="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                      Check Manifest
                    </button>
                  </div>
                </>
              )}
            </div>
            <div className="relative">
              <button
                onClick={() => canAv('edit_flight') && setShowStatusMenu(!showStatusMenu)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg ${canAv('edit_flight') ? 'hover:bg-gray-100 cursor-pointer' : ''}`}
                title={canAv('edit_flight') ? 'Click para cambiar status' : ''}
              >
                <span className={`inline-block w-2.5 h-2.5 rounded-full ${statusColor[flight.status]}`} />
                <span className="text-sm font-semibold text-gray-600">{statusLabel[flight.status]}</span>
                {canAv('edit_flight') && <svg className="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>}
              </button>
              {showStatusMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowStatusMenu(false)} />
                  <div className="absolute right-0 mt-1 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-20 w-40">
                    {(['booked', 'in_progress', 'completed', 'dispatched'] as const).map(s => (
                      <button
                        key={s}
                        onClick={() => forceFlightStatus(s)}
                        className={`w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2 ${s === flight.status ? 'font-bold text-mcl-blue' : 'text-gray-700'}`}
                      >
                        <span className={`inline-block w-2 h-2 rounded-full ${statusColor[s]}`} />
                        {statusLabel[s]}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            {canAv('edit_flight') && (
              <button
                onClick={() => setShowDeleteFlight(true)}
                className="text-red-400 hover:text-red-600 text-xs transition-colors"
                title="Eliminar vuelo"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* AWBs Section */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide">AWBs <span className="text-gray-400 font-normal">({awbs.filter(a => a.status !== 'removed').length})</span></h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowNotes(!showNotes)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 ${notes.length > 0 ? 'bg-amber-100 text-amber-700 hover:bg-amber-200' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" /></svg>
              Notas{notes.length > 0 ? ` (${notes.length})` : ''}
            </button>
            {canAv('add_awb') && !showAddAwb && (
              <button onClick={() => setShowAddAwb(true)} className="bg-mcl-blue text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-blue-900">
                + Agregar AWB
              </button>
            )}
            {canAv('upload_pt') && <label className={`bg-green-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-green-700 flex items-center gap-1.5 cursor-pointer ${uploadingPalletTag ? 'opacity-50 pointer-events-none' : ''}`}>
              {uploadingPalletTag ? (
                <div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-white" />
              ) : (
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
              )}
              {uploadingPalletTag ? 'Subiendo...' : 'Subir Pallet Tag'}
              <input
                ref={palletTagInputRef}
                type="file"
                accept="image/*,.pdf"
                className="hidden"
                onChange={e => {
                  const file = e.target.files?.[0]
                  if (file) handlePalletTagUpload(file)
                  e.target.value = ''
                }}
              />
            </label>}
          </div>
        </div>

        {/* Notes panel */}
        {showNotes && (
          <div className="mb-4 bg-amber-50 rounded-lg border border-amber-200 p-4">
            <h3 className="text-xs font-bold text-amber-800 uppercase mb-3">Notas del vuelo</h3>
            {notes.length > 0 && (
              <div className="space-y-2 mb-3 max-h-48 overflow-y-auto">
                {notes.map((n, i) => (
                  <div key={i} className="bg-white rounded-lg px-3 py-2 border border-amber-100">
                    <p className="text-sm text-gray-800">{n.text}</p>
                    <p className="text-[10px] text-gray-400 mt-1">{n.author} — {new Date(n.created_at).toLocaleString()}</p>
                  </div>
                ))}
              </div>
            )}
            {canAv('create_flight') && (
              <div className="flex gap-2">
                <input
                  type="text" value={newNote} onChange={e => setNewNote(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && newNote.trim()) addNote() }}
                  placeholder="Escribir comentario..."
                  className="flex-1 border border-amber-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300 bg-white"
                />
                <button onClick={addNote} disabled={savingNote || !newNote.trim()}
                  className="bg-amber-600 text-white px-4 py-2 rounded-lg text-xs font-medium hover:bg-amber-700 disabled:opacity-50">
                  {savingNote ? '...' : 'Agregar'}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Inline add AWB */}
        {showAddAwb && (
          <div className="flex items-center gap-2 mb-4 bg-blue-50 rounded-lg p-3">
            <input
              ref={addAwbRef}
              type="text"
              placeholder="729-12345678"
              value={newAwbNumber}
              onChange={e => {
                let v = e.target.value.replace(/[^0-9-]/g, '')
                // Auto-insert dash after 3 digits
                if (v.length === 3 && !v.includes('-') && newAwbNumber.length < v.length) v += '-'
                setNewAwbNumber(v)
              }}
              onKeyDown={e => { if (e.key === 'Enter' && newAwbNumber.trim()) addAwb() }}
              className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-mcl-blue/30 bg-white"
              disabled={addingAwb}
            />
            <button
              onClick={addAwb}
              disabled={addingAwb || !newAwbNumber.trim()}
              className="bg-mcl-blue text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-900 disabled:opacity-50"
            >
              {addingAwb ? '...' : 'Agregar'}
            </button>
            <button
              onClick={() => { setShowAddAwb(false); setNewAwbNumber('') }}
              className="text-gray-400 hover:text-gray-600 text-sm"
            >
              Cerrar
            </button>
          </div>
        )}

        {(() => {
          const activeAwbs = awbs.filter(a => a.status !== 'removed')
          const removedAwbs = awbs.filter(a => a.status === 'removed')
          return (<>
        {activeAwbs.length === 0 && !showAddAwb ? (
          <p className="text-center text-gray-400 py-8 text-sm">No hay AWBs cargadas. Agrega la primera guia.</p>
        ) : activeAwbs.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead className="bg-gray-50 text-gray-500 uppercase text-[10px]">
                <tr>
                  <th className="text-center px-2 py-2 font-semibold border-b border-gray-200">SCR</th>
                  <th className="text-left px-2 py-2 font-semibold border-b border-gray-200">AWB</th>
                  <th className="text-center px-2 py-2 font-semibold border-b border-gray-200">DOCS</th>
                  <th className="text-center px-2 py-2 font-semibold border-b border-gray-200">CM</th>
                  <th className="text-left px-2 py-2 font-semibold border-b border-gray-200">IAC</th>
                  <th className="text-right px-2 py-2 font-semibold border-b border-gray-200">PCS</th>
                  <th className="text-right px-2 py-2 font-semibold border-b border-gray-200">GROSS</th>
                  <th className="text-right px-2 py-2 font-semibold border-b border-gray-200">CHW</th>
                  <th className="text-center px-2 py-2 font-semibold border-b border-gray-200">DG/LB</th>
                  <th className="text-center px-2 py-2 font-semibold border-b border-gray-200 w-8"></th>
                  <th className="text-left px-2 py-2 font-semibold border-b border-gray-200 bg-blue-50/50">ULD</th>
                  <th className="text-right px-2 py-2 font-semibold border-b border-gray-200 bg-blue-50/50">PCS</th>
                  <th className="text-right px-2 py-2 font-semibold border-b border-gray-200 bg-blue-50/50">KG</th>
                  <th className="text-center px-2 py-2 font-semibold border-b border-gray-200 bg-blue-50/50">SCR</th>
                  <th className="text-left px-2 py-2 font-semibold border-b border-gray-200 bg-blue-50/50">DO</th>
                  <th className="text-center px-2 py-2 font-semibold border-b border-gray-200 bg-blue-50/50">LOADED</th>
                  <th className="text-center px-2 py-2 font-semibold border-b border-gray-200 bg-blue-50/50">ARR</th>
                  <th className="text-center px-2 py-2 font-semibold border-b border-gray-200 bg-blue-50/50">UNLOAD</th>
                  <th className="text-center px-2 py-2 font-semibold border-b border-gray-200 w-14"></th>
                </tr>
              </thead>
              <tbody>
                {activeAwbs.map(awb => {
                  const awbPallets = palletTags.filter(pt => pt.lines?.some(l => l.awb_number === awb.awb_number))
                  const rowCount = Math.max(1, awbPallets.length)

                  // AWB-level cells (rendered only on first row, with rowSpan)
                  const awbCells = (
                    <>
                      <td className="px-2 py-2 text-center border-t border-gray-200 align-top" rowSpan={rowCount}>
                        {awb.screening_status === 'complete' && <span className="text-green-600 font-bold">✓</span>}
                        {awb.screening_status === 'partial' && <span className="text-amber-500 font-bold">{awb.screened_pcs}/{awb.pieces}</span>}
                        {awb.screening_status === 'pending' && <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-2 py-2 font-mono font-semibold text-gray-800 border-t border-gray-200 align-top" rowSpan={rowCount}>
                        {awb.awb_number}
                      </td>
                      <td className="px-2 py-2 text-center border-t border-gray-200 align-top" rowSpan={rowCount}>
                        {uploadingDocFor === awb.id ? (
                          <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-mcl-blue inline-block" />
                        ) : awb.doc_awb_url ? (
                          <span
                            className="inline-block w-2.5 h-2.5 rounded-full bg-green-500 cursor-pointer"
                            title={awb.doc_awb_filename || 'Ver documento'}
                            onClick={() => window.open(awb.doc_awb_url, '_blank')}
                          />
                        ) : (
                          <label className="cursor-pointer" title="Subir documento AWB">
                            <span className="inline-block w-2.5 h-2.5 rounded-full bg-gray-300 hover:bg-mcl-blue transition-colors" />
                            <input
                              type="file"
                              accept=".pdf"
                              className="hidden"
                              onChange={e => {
                                const file = e.target.files?.[0]
                                if (file) handleAwbDocUpload(awb.id, file)
                                e.target.value = ''
                              }}
                            />
                          </label>
                        )}
                      </td>
                      {/* CM (Check Manifest) */}
                      <td className="px-2 py-2 text-center border-t border-gray-200 align-top relative" rowSpan={rowCount}>
                        {awb.manifest_status === 'clear' || awb.manifest_status === 'resolved' ? (
                          <span className="inline-block w-2.5 h-2.5 rounded-full bg-green-500" title={awb.manifest_status === 'resolved' ? 'Resuelto' : 'Clear'} />
                        ) : awb.manifest_status === 'flagged' ? (
                          <span
                            className="inline-block w-2.5 h-2.5 rounded-full bg-amber-400 cursor-pointer"
                            title="DG keyword detectado"
                            onClick={() => navigate(`/avianca/flight/${id}/manifest?awb=${awb.id}`)}
                          />
                        ) : awb.manifest_status === 'na' ? (
                          <span className="inline-block w-2.5 h-2.5 rounded-full bg-gray-300" title="No aplica" />
                        ) : (
                          <>
                            <span
                              className="inline-block w-2.5 h-2.5 rounded-full border border-gray-800 bg-white cursor-pointer hover:bg-gray-100"
                              title="Check Manifest"
                              onClick={() => setCmMenuAwbId(cmMenuAwbId === awb.id ? null : awb.id)}
                            />
                            {cmMenuAwbId === awb.id && (
                              <>
                                <div className="fixed inset-0 z-10" onClick={() => setCmMenuAwbId(null)} />
                                <div className="absolute left-1/2 -translate-x-1/2 mt-1 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-20 w-32">
                                  <button
                                    onClick={() => { setCmMenuAwbId(null); navigate(`/avianca/flight/${id}/manifest?awb=${awb.id}`) }}
                                    className="w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                                  >
                                    Subir MAN
                                  </button>
                                  <button
                                    onClick={async () => {
                                      setCmMenuAwbId(null)
                                      await updateDoc(doc(db, 'av_flight_awbs', awb.id), { manifest_status: 'na', updated_at: new Date().toISOString() })
                                      setAwbs(prev => prev.map(a => a.id === awb.id ? { ...a, manifest_status: 'na' } as AwbWithId : a))
                                    }}
                                    className="w-full text-left px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-50"
                                  >
                                    No Aplica
                                  </button>
                                </div>
                              </>
                            )}
                          </>
                        )}
                      </td>
                      <td className="px-2 py-2 text-gray-600 border-t border-gray-200 align-top" rowSpan={rowCount}>
                        {awb.ai_status === 'pending' && <span className="text-amber-500 text-[10px]" title="Esperando AI...">⏳</span>}
                        {awb.ai_status === 'processing' && <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-amber-500 inline-block" title="AI procesando..." />}
                        {awb.ai_status === 'failed' && <span className="text-red-500 cursor-help" title={awb.ai_error || 'Error'}>⚠</span>}
                        {awb.ai_status === 'needs_review' && <span className="text-amber-600 cursor-help" title="Revisar datos">👁</span>}
                        {(!awb.ai_status || awb.ai_status === 'complete') && (awb.iac || <span className="text-gray-300">—</span>)}
                      </td>
                      <td className="px-2 py-2 text-right font-mono border-t border-gray-200 align-top" rowSpan={rowCount}>{awb.pieces || <span className="text-gray-300">—</span>}</td>
                      <td className="px-2 py-2 text-right font-mono border-t border-gray-200 align-top" rowSpan={rowCount}>{awb.gross_weight_kg ? awb.gross_weight_kg.toLocaleString() : <span className="text-gray-300">—</span>}</td>
                      <td className="px-2 py-2 text-right font-mono border-t border-gray-200 align-top" rowSpan={rowCount}>{awb.chw_kg ? awb.chw_kg.toLocaleString() : <span className="text-gray-300">—</span>}</td>
                      <td className="px-2 py-2 text-center border-t border-gray-200 align-top" rowSpan={rowCount}>
                        {awb.lb ? (
                          <span className="text-amber-600 font-bold" title={awb.lb_detail}>LB</span>
                        ) : awb.dg ? (
                          uploadingDgFor === awb.id ? (
                            <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-red-500 inline-block" title="Subiendo DG..." />
                          ) : awb.doc_dg_url ? (
                            <span className="text-green-600 font-bold cursor-pointer" title={`DG OK — ${awb.doc_dg_filename || 'Ver documento'}`} onClick={() => window.open(awb.doc_dg_url, '_blank')}>✓</span>
                          ) : (
                            <label className="cursor-pointer" title="Subir checklist DG">
                              <span className="text-red-500 font-bold hover:text-red-700">⚠</span>
                              <input type="file" accept=".pdf,image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleDgDocUpload(awb.id, f); e.target.value = '' }} />
                            </label>
                          )
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-center border-t border-gray-200 align-top" rowSpan={rowCount}>
                        {awb.lb && (
                          <button onClick={() => openLbChecklist(awb)} className="text-amber-600 hover:text-amber-800 cursor-pointer" title="Checklist LB">
                            <svg className="w-3.5 h-3.5 inline" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>
                          </button>
                        )}
                      </td>
                    </>
                  )

                  // ULD-level cell renderer
                  const uldCells = (pt?: PtWithId) => {
                    if (!pt) return (
                      <>
                        <td className={`px-2 py-2 bg-blue-50/30 ${canAv('manual_position') ? 'text-blue-400 cursor-pointer hover:text-blue-700 hover:underline' : 'text-gray-300'}`}
                          onClick={canAv('manual_position') ? () => openManualPt(awb) : undefined}
                          title={canAv('manual_position') ? 'Agregar posición manual' : undefined}
                        >{canAv('manual_position') ? '+ Agregar' : '—'}</td>
                        <td className="px-2 py-2 text-right text-gray-300 bg-blue-50/30">—</td>
                        <td className="px-2 py-2 text-right text-gray-300 bg-blue-50/30">—</td>
                        <td className="px-2 py-2 text-center text-gray-300 bg-blue-50/30">—</td>
                        <td className="px-2 py-2 text-gray-300 bg-blue-50/30">—</td>
                        <td className="px-2 py-2 text-center text-gray-300 bg-blue-50/30">—</td>
                        <td className="px-2 py-2 text-center text-gray-300 bg-blue-50/30">—</td>
                        <td className="px-2 py-2 text-center text-gray-300 bg-blue-50/30">—</td>
                      </>
                    )
                    const line = pt.lines?.find(l => l.awb_number === awb.awb_number)
                    // Find DO that contains this pallet tag
                    const doForUld = avDos.find(d => d.uld_numbers.includes(pt.pallet_number))
                    const tracking = doForUld ? trackingMap[doForUld.do_number] : null
                    const fmtTime = (ts?: string) => ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null
                    return (
                      <>
                        <td className={`px-2 py-2 font-mono bg-blue-50/30 ${canAv('edit_pt') ? 'text-blue-800 cursor-pointer hover:underline' : 'text-gray-700'}`} onClick={canAv('edit_pt') ? () => openEditPt(pt) : undefined} title={canAv('edit_pt') ? 'Editar Pallet Tag' : undefined}>{pt.pallet_number}</td>
                        <td className="px-2 py-2 text-right font-mono bg-blue-50/30">{line?.pieces || 0}</td>
                        <td className="px-2 py-2 text-right font-mono bg-blue-50/30">{line?.weight_kg || 0}</td>
                        <td className="px-2 py-2 text-center bg-blue-50/30">
                          {pt.screened ? <span className="text-green-600 font-bold">✓</span> : <span className="text-red-400">✗</span>}
                        </td>
                        <td className="px-2 py-2 font-mono text-blue-600 bg-blue-50/30 text-[10px]">{doForUld?.do_number || <span className="text-gray-300">—</span>}</td>
                        <td className="px-2 py-2 text-center bg-blue-50/30">
                          {tracking?.milestones?.truck_loaded
                            ? <span className="text-green-600 text-[10px]" title={tracking.milestones.truck_loaded.timestamp}>{fmtTime(tracking.milestones.truck_loaded.timestamp)}</span>
                            : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-2 py-2 text-center bg-blue-50/30">
                          {tracking?.milestones?.arrival_airline
                            ? <span className="text-green-600 text-[10px]" title={tracking.milestones.arrival_airline.timestamp}>{fmtTime(tracking.milestones.arrival_airline.timestamp)}</span>
                            : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-2 py-2 text-center bg-blue-50/30">
                          {tracking?.milestones?.unload_end
                            ? <span className="text-green-600 text-[10px]" title={tracking.milestones.unload_end.timestamp}>{fmtTime(tracking.milestones.unload_end.timestamp)}</span>
                            : <span className="text-gray-300">—</span>}
                        </td>
                      </>
                    )
                  }

                  // Actions cell (rendered only on first row, with rowSpan)
                  const actionCell = !canAv('edit_awb') ? null : (
                    <td className="px-2 py-2 text-center border-t border-gray-200 align-top" rowSpan={rowCount}>
                      <div className="flex items-center justify-center gap-1">
                        <button onClick={() => openEditAwb(awb)} className="text-gray-400 hover:text-mcl-blue" title="Editar">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                        </button>
                        {canAv('delete_awb') && (
                        <button onClick={() => { setRemovingAwb(awb); setRemovalReason('hold'); setRemovalDetail('') }} className="text-gray-400 hover:text-red-500" title="Dar de baja">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                        )}
                      </div>
                    </td>
                  )

                  if (awbPallets.length === 0) {
                    return (
                      <tr key={awb.id} className="hover:bg-gray-50">
                        {awbCells}
                        {uldCells()}
                        {actionCell}
                      </tr>
                    )
                  }

                  return (
                    <React.Fragment key={awb.id}>
                      {awbPallets.map((pt, idx) => (
                        <tr key={`${awb.id}-${pt.id}`} className="hover:bg-gray-50">
                          {idx === 0 && awbCells}
                          {uldCells(pt)}
                          {idx === 0 && actionCell}
                        </tr>
                      ))}
                    </React.Fragment>
                  )
                })}
              </tbody>
              {activeAwbs.length > 0 && (
                <tfoot className="bg-gray-50 font-semibold text-xs text-gray-600 border-t-2 border-gray-300">
                  {(() => {
                    // Sum pallet tag pieces/kg from lines matching active AWBs only
                    const activeAwbNumbers = new Set(activeAwbs.map(a => a.awb_number))
                    let ptPcs = 0, ptKg = 0
                    for (const pt of palletTags) {
                      for (const line of (pt.lines || [])) {
                        if (activeAwbNumbers.has(line.awb_number)) {
                          ptPcs += line.pieces || 0
                          ptKg += line.weight_kg || 0
                        }
                      }
                    }
                    return (
                      <tr>
                        <td className="px-2 py-2" />
                        <td className="px-2 py-2">TOTAL</td>
                        <td className="px-2 py-2" />
                        <td className="px-2 py-2" />
                        <td className="px-2 py-2" />
                        <td className="px-2 py-2 text-right font-mono">{activeAwbs.reduce((s, a) => s + (a.pieces || 0), 0) || ''}</td>
                        <td className="px-2 py-2 text-right font-mono">{activeAwbs.reduce((s, a) => s + (a.gross_weight_kg || 0), 0) ? activeAwbs.reduce((s, a) => s + (a.gross_weight_kg || 0), 0).toLocaleString() : ''}</td>
                        <td className="px-2 py-2 text-right font-mono">{activeAwbs.reduce((s, a) => s + (a.chw_kg || 0), 0) ? activeAwbs.reduce((s, a) => s + (a.chw_kg || 0), 0).toLocaleString() : ''}</td>
                        <td className="px-2 py-2" />{/* DG/LB */}
                        <td className="px-2 py-2" />{/* LB icon */}
                        <td className="px-2 py-2 bg-blue-50/30" />{/* ULD */}
                        <td className="px-2 py-2 text-right font-mono bg-blue-50/30">{ptPcs || ''}</td>
                        <td className="px-2 py-2 text-right font-mono bg-blue-50/30">{ptKg ? ptKg.toLocaleString() : ''}</td>
                        <td className="px-2 py-2 bg-blue-50/30" />{/* SCR */}
                        <td className="px-2 py-2 bg-blue-50/30" />{/* DO */}
                        <td className="px-2 py-2 bg-blue-50/30" />{/* LOADED */}
                        <td className="px-2 py-2 bg-blue-50/30" />{/* ARR */}
                        <td className="px-2 py-2 bg-blue-50/30" />{/* UNLOAD */}
                        <td className="px-2 py-2" />{/* actions */}
                      </tr>
                    )
                  })()}
                </tfoot>
              )}
            </table>
          </div>
        )}

        {/* Removed AWBs are hard-deleted — removal history tracked in av_awb_logs */}
        </>)
        })()}
      </div>

      {/* Pallet Tags Section */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 mb-6">
        <div className="mb-4">
          <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide">Pallet Tags <span className="text-gray-400 font-normal">({palletTags.length})</span></h2>
        </div>
        {palletTags.length === 0 ? (
          <p className="text-center text-gray-400 py-8 text-sm">No hay Pallet Tags subidos. La info extraida aparecera en las columnas ULD de la tabla de AWBs.</p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {palletTags.map(pt => (
              <div key={pt.id} className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2 text-xs border border-gray-200">
                {pt.ai_status === 'pending' && <span className="text-amber-500">⏳</span>}
                {pt.ai_status === 'processing' && <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-amber-500" />}
                {pt.ai_status === 'failed' && <span className="text-red-500 cursor-help" title={pt.ai_error || 'Error'}>⚠</span>}
                {pt.ai_status === 'complete' && <span className="text-green-600 font-bold">✓</span>}
                <span className="font-mono font-semibold text-gray-700">{pt.pallet_number || 'procesando...'}</span>
                {pt.total_pieces > 0 && <span className="text-gray-400">{pt.total_pieces} pcs</span>}
                {pt.doc_url && (
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-full bg-green-500 cursor-pointer"
                    title="Ver documento"
                    onClick={() => window.open(pt.doc_url, '_blank')}
                  />
                )}
                {canAv('edit_pt') && <button
                  onClick={async () => {
                    if (confirm(`Eliminar Pallet Tag ${pt.pallet_number || pt.id}?`)) {
                      await deleteDoc(doc(db, 'av_pallet_tags', pt.id))
                      if (flight) {
                        const awbList = (pt.lines || []).map(l => l.awb_number).join(', ')
                        logAvEvent(flight.id, awbList || '-', 'pallet_tag_deleted', `ULD: ${pt.pallet_number || pt.id} — ${pt.total_pieces || 0} pcs`, auth.currentUser?.email || '')
                      }
                      const remainingPts = palletTags.filter(p => p.id !== pt.id)
                      setPalletTags(remainingPts)
                      // Recalculate screening status for AWBs that had lines in this pallet
                      const affectedAwbNumbers = new Set((pt.lines || []).map(l => l.awb_number))
                      for (const awbNum of affectedAwbNumbers) {
                        const awb = awbs.find(a => a.awb_number === awbNum)
                        if (!awb) continue
                        let totalInPallets = 0
                        let screenedPcs = 0
                        for (const rpt of remainingPts) {
                          const line = rpt.lines?.find(l => l.awb_number === awbNum)
                          if (!line) continue
                          totalInPallets += line.pieces || 0
                          if (rpt.screened) screenedPcs += line.pieces || 0
                        }
                        const totalPcs = awb.pieces || 0
                        let screeningStatus: 'pending' | 'partial' | 'complete' = 'pending'
                        if (screenedPcs > 0 && screenedPcs >= totalPcs) screeningStatus = 'complete'
                        else if (screenedPcs > 0) screeningStatus = 'partial'
                        await updateDoc(doc(db, 'av_flight_awbs', awb.id), { total_pcs_in_pallets: totalInPallets, screened_pcs: screenedPcs, screening_status: screeningStatus })
                        setAwbs(prev => prev.map(a => a.id === awb.id ? { ...a, total_pcs_in_pallets: totalInPallets, screened_pcs: screenedPcs, screening_status: screeningStatus } : a))
                      }
                    }
                  }}
                  className="text-gray-400 hover:text-red-500 ml-1"
                  title="Eliminar"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Remove AWB Modal (soft-delete) ── */}
      {removingAwb && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setRemovingAwb(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-gray-100">
              <h3 className="font-bold text-gray-800 text-lg">Dar de baja AWB</h3>
              <p className="text-xs text-gray-400 mt-1">AWB <strong className="text-gray-700">{removingAwb.awb_number}</strong> — {removingAwb.pieces} pcs, {removingAwb.gross_weight_kg?.toLocaleString()} kg</p>
            </div>
            <div className="px-6 py-5 space-y-3">
              <label className="text-xs font-semibold text-gray-500 uppercase block">Razon de eliminacion</label>
              {([
                ['hold', 'Carga en HOLD', true],
                ['client_cancel', 'Cancelada por cliente', true],
                ['flight_change', 'Cambio de vuelo', false],
                ['other', 'Otro', false],
              ] as [string, string, boolean][]).map(([val, label, bill]) => (
                <label key={val} className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="removal_reason" value={val}
                    checked={removalReason === val}
                    onChange={() => setRemovalReason(val as any)}
                    className="text-mcl-blue focus:ring-mcl-blue" />
                  <span className="text-sm text-gray-700">{label}</span>
                  <span className={`text-[10px] font-semibold ${bill ? 'text-amber-600' : 'text-gray-400'}`}>
                    {bill ? '(se factura)' : '(no se factura)'}
                  </span>
                </label>
              ))}
              {removalReason === 'other' && (
                <input type="text" value={removalDetail} onChange={e => setRemovalDetail(e.target.value)}
                  placeholder="Describir razon..."
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30 mt-2" />
              )}
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
              <button onClick={() => setRemovingAwb(null)} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">Cancelar</button>
              <button onClick={removeAwb} disabled={savingRemoval || (removalReason === 'other' && !removalDetail.trim())}
                className="bg-red-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50">
                {savingRemoval ? 'Guardando...' : 'Dar de baja'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit AWB Modal ── */}
      {editingAwb && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setEditingAwb(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-gray-100">
              <h3 className="font-bold text-gray-800 text-lg">Editar AWB</h3>
              <p className="text-xs text-gray-400 mt-1">Corregir datos extraidos por IA o agregar manualmente</p>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Numero de AWB</label>
                <input
                  type="text"
                  value={editForm.awb_number || ''}
                  onChange={e => setEditForm(p => ({ ...p, awb_number: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Shipper</label>
                  <input type="text" value={editForm.shipper_name || ''} onChange={e => setEditForm(p => ({ ...p, shipper_name: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Consignee</label>
                  <input type="text" value={editForm.consignee_name || ''} onChange={e => setEditForm(p => ({ ...p, consignee_name: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Agent / Representante</label>
                  <input type="text" value={editForm.agent_name || ''} onChange={e => setEditForm(p => ({ ...p, agent_name: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Telefono Shipper</label>
                  <input type="text" value={editForm.shipper_phone || ''} onChange={e => setEditForm(p => ({ ...p, shipper_phone: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">IAC</label>
                  <input type="text" value={editForm.iac || ''} onChange={e => setEditForm(p => ({ ...p, iac: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Piezas</label>
                  <input type="number" min={0} value={editForm.pieces || ''} onChange={e => setEditForm(p => ({ ...p, pieces: Number(e.target.value) }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Gross Weight (kg)</label>
                  <input type="number" min={0} step={0.01} value={editForm.gross_weight_kg || ''} onChange={e => setEditForm(p => ({ ...p, gross_weight_kg: Number(e.target.value) }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">CHW (kg)</label>
                  <input type="number" min={0} step={0.01} value={editForm.chw_kg || ''} onChange={e => setEditForm(p => ({ ...p, chw_kg: Number(e.target.value) }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
                </div>
              </div>
              <div className="flex items-center gap-6">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={editForm.dg || false} onChange={e => setEditForm(p => ({ ...p, dg: e.target.checked }))}
                    className="rounded border-gray-300 text-red-600 focus:ring-red-500" />
                  <span className="text-sm font-semibold text-red-600">Dangerous Goods</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={editForm.lb || false} onChange={e => setEditForm(p => ({ ...p, lb: e.target.checked }))}
                    className="rounded border-gray-300 text-amber-600 focus:ring-amber-500" />
                  <span className="text-sm font-semibold text-amber-600">Lithium Batteries</span>
                </label>
              </div>
              {editForm.dg && (
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">DG Codes (separados por coma)</label>
                  <input type="text" placeholder="UN3481, UN3091" value={(editForm.dg_codes || []).join(', ')}
                    onChange={e => setEditForm(p => ({ ...p, dg_codes: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
                </div>
              )}
              {editForm.lb && (
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Detalle LB</label>
                  <input type="text" placeholder="ELI Section II" value={editForm.lb_detail || ''}
                    onChange={e => setEditForm(p => ({ ...p, lb_detail: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
              <button onClick={() => setEditingAwb(null)} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">Cancelar</button>
              <button onClick={saveEditAwb} disabled={savingEdit}
                className="bg-mcl-blue text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-900 disabled:opacity-50">
                {savingEdit ? 'Guardando...' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Move AWB to another flight Modal ── */}
      {moveAwb && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => !movingAwb && setMoveAwb(null)}>
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold text-gray-800 text-lg mb-1">Mover AWB a otro vuelo</h3>
            <p className="text-sm text-gray-500 mb-4">
              <span className="font-mono font-semibold text-gray-700">{moveAwb.awb_number}</span> — {moveAwb.pieces} pcs, {moveAwb.gross_weight_kg?.toLocaleString()} kg
            </p>

            <label className="block text-xs font-semibold text-gray-600 mb-1">Vuelo destino</label>
            {availableFlights.length === 0 ? (
              <p className="text-sm text-gray-400 py-4 text-center">Cargando vuelos...</p>
            ) : (
              <select
                value={selectedFlightId}
                onChange={e => setSelectedFlightId(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-4"
              >
                <option value="">Seleccionar vuelo...</option>
                {availableFlights.map(f => (
                  <option key={f.id} value={f.id}>
                    {f.flight_number} — {f.flight_date} — {f.destination}
                  </option>
                ))}
              </select>
            )}

            <div className="flex justify-end gap-2 mt-2">
              <button onClick={() => setMoveAwb(null)} disabled={movingAwb} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Cancelar</button>
              <button
                onClick={handleMoveAwb}
                disabled={!selectedFlightId || movingAwb}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {movingAwb ? 'Moviendo...' : 'Mover AWB'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit Pallet Tag Modal ── */}
      {editingPt && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setEditingPt(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-gray-100">
              <h3 className="font-bold text-gray-800 text-lg">Editar Pallet Tag</h3>
              <p className="text-xs text-gray-400 mt-1">Corregir ULD, piezas y peso por AWB</p>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">ULD (Pallet Number)</label>
                <input
                  type="text"
                  value={ptEditForm.pallet_number}
                  onChange={e => setPtEditForm(p => ({ ...p, pallet_number: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={ptEditForm.screened} onChange={e => setPtEditForm(p => ({ ...p, screened: e.target.checked }))}
                  className="rounded border-gray-300 text-green-600 focus:ring-green-500" />
                <span className={`text-sm font-semibold ${ptEditForm.screened ? 'text-green-600' : 'text-gray-400'}`}>Screened</span>
                {!editingPt?.screened && ptEditForm.screened && <span className="text-[10px] text-amber-600">(forzado manual)</span>}
              </label>
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase block mb-2">Lineas por AWB</label>
                <div className="space-y-2">
                  <div className="grid grid-cols-[1fr_80px_100px] gap-2 text-[10px] font-semibold text-gray-400 uppercase px-1">
                    <span>AWB</span><span className="text-right">PCS</span><span className="text-right">KG</span>
                  </div>
                  {ptEditForm.lines.map((line, idx) => (
                    <div key={idx} className="grid grid-cols-[1fr_80px_100px] gap-2">
                      <input
                        type="text" value={line.awb_number} readOnly
                        className="border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono bg-gray-50 text-gray-500"
                      />
                      <input
                        type="number" min={0} value={line.pieces}
                        onChange={e => {
                          const lines = [...ptEditForm.lines]
                          lines[idx] = { ...lines[idx], pieces: Number(e.target.value) }
                          setPtEditForm(p => ({ ...p, lines }))
                        }}
                        className="border border-gray-200 rounded-lg px-2 py-2 text-sm font-mono text-right focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                      />
                      <input
                        type="number" min={0} step={0.01} value={line.weight_kg}
                        onChange={e => {
                          const lines = [...ptEditForm.lines]
                          lines[idx] = { ...lines[idx], weight_kg: Number(e.target.value) }
                          setPtEditForm(p => ({ ...p, lines }))
                        }}
                        className="border border-gray-200 rounded-lg px-2 py-2 text-sm font-mono text-right focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
              <button onClick={() => setEditingPt(null)} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">Cancelar</button>
              <button onClick={saveEditPt} disabled={savingPtEdit}
                className="bg-mcl-blue text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-900 disabled:opacity-50">
                {savingPtEdit ? 'Guardando...' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Manual Pallet Tag Modal ── */}
      {manualPtAwb && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setManualPtAwb(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-gray-100">
              <h3 className="font-bold text-gray-800 text-lg">Agregar Posición Manual</h3>
              <p className="text-xs text-gray-400 mt-1">Asignar ULD o BLK con piezas y peso</p>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">ULD / Posición</label>
                <input
                  type="text"
                  placeholder="Ej: BLK, PMC12345QT..."
                  value={manualPtForm.pallet_number}
                  onChange={e => setManualPtForm(p => ({ ...p, pallet_number: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={manualPtForm.screened} onChange={e => setManualPtForm(p => ({ ...p, screened: e.target.checked }))}
                  className="rounded border-gray-300 text-green-600 focus:ring-green-500" />
                <span className={`text-sm font-semibold ${manualPtForm.screened ? 'text-green-600' : 'text-gray-400'}`}>Screened</span>
              </label>
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase block mb-2">Lineas por AWB</label>
                <div className="space-y-2">
                  <div className="grid grid-cols-[1fr_80px_100px_32px] gap-2 text-[10px] font-semibold text-gray-400 uppercase px-1">
                    <span>AWB</span><span className="text-right">PCS</span><span className="text-right">KG</span><span />
                  </div>
                  {manualPtForm.lines.map((line, idx) => (
                    <div key={idx} className="grid grid-cols-[1fr_80px_100px_32px] gap-2">
                      <input
                        type="text" value={line.awb_number}
                        onChange={e => {
                          const lines = [...manualPtForm.lines]
                          lines[idx] = { ...lines[idx], awb_number: e.target.value }
                          setManualPtForm(p => ({ ...p, lines }))
                        }}
                        className="border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                      />
                      <input
                        type="number" min={0} value={line.pieces}
                        onChange={e => {
                          const lines = [...manualPtForm.lines]
                          lines[idx] = { ...lines[idx], pieces: Number(e.target.value) }
                          setManualPtForm(p => ({ ...p, lines }))
                        }}
                        className="border border-gray-200 rounded-lg px-2 py-2 text-sm font-mono text-right focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                      />
                      <input
                        type="number" min={0} step={0.01} value={line.weight_kg}
                        onChange={e => {
                          const lines = [...manualPtForm.lines]
                          lines[idx] = { ...lines[idx], weight_kg: Number(e.target.value) }
                          setManualPtForm(p => ({ ...p, lines }))
                        }}
                        className="border border-gray-200 rounded-lg px-2 py-2 text-sm font-mono text-right focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                      />
                      {manualPtForm.lines.length > 1 && (
                        <button onClick={() => setManualPtForm(p => ({ ...p, lines: p.lines.filter((_, i) => i !== idx) }))}
                          className="text-red-400 hover:text-red-600 text-lg leading-none">×</button>
                      )}
                    </div>
                  ))}
                  <button
                    onClick={() => setManualPtForm(p => ({ ...p, lines: [...p.lines, { awb_number: '', pieces: 0, weight_kg: 0 }] }))}
                    className="text-xs text-blue-600 hover:text-blue-800 font-medium mt-1"
                  >+ Agregar línea</button>
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
              <button onClick={() => setManualPtAwb(null)} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">Cancelar</button>
              <button onClick={saveManualPt} disabled={savingManualPt || !manualPtForm.pallet_number.trim()}
                className="bg-mcl-blue text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-900 disabled:opacity-50">
                {savingManualPt ? 'Guardando...' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete Flight Confirmation ── */}
      {showDeleteFlight && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowDeleteFlight(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-5 text-center">
              <div className="text-3xl mb-3">⚠️</div>
              <h3 className="font-bold text-gray-800 text-lg mb-2">Eliminar Vuelo</h3>
              <p className="text-sm text-gray-500 mb-1">
                Se eliminara el vuelo <strong>{flight.flight_number}</strong> con {awbs.length} AWBs y {palletTags.length} Pallet Tags.
              </p>
              <p className="text-xs text-red-500 font-semibold">Esta accion no se puede deshacer.</p>
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
              <button onClick={() => setShowDeleteFlight(false)} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">Cancelar</button>
              <button onClick={handleDeleteFlight} disabled={deletingFlight}
                className="bg-red-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50">
                {deletingFlight ? 'Eliminando...' : 'Eliminar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* LB Checklist Modal */}
      {lbAwb && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setLbAwb(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-gray-800 text-lg">Checklist LB</h3>
                <p className="text-xs text-gray-500 font-mono">{lbAwb.awb_number}</p>
              </div>
              <span className="text-[10px] font-bold text-red-700 bg-red-50 px-2 py-1 rounded">LITHIUM BATTERIES</span>
            </div>
            {lbLoading ? (
              <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-mcl-blue" /></div>
            ) : (
              <div className="px-6 py-4">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-gray-50 text-[10px] text-gray-500 uppercase">
                      <th className="px-2 py-1.5 text-center w-8">#</th>
                      <th className="px-2 py-1.5 text-left">Item</th>
                      <th className="px-2 py-1.5 text-center w-14">YES</th>
                      <th className="px-2 py-1.5 text-center w-14">NO</th>
                      <th className="px-2 py-1.5 text-center w-14">N/A</th>
                    </tr>
                  </thead>
                  <tbody>
                    {QUESTIONS.map(group => (
                      <React.Fragment key={group.section + (group.partLabel || '')}>
                        {!group.section.startsWith('__') && (
                          <tr><td colSpan={5} className="bg-gray-200 font-bold text-[10px] px-2 py-1.5 uppercase text-gray-700">{group.section}</td></tr>
                        )}
                        {group.partLabel && (
                          <tr><td colSpan={5} className="bg-blue-50 text-[10px] font-semibold px-2 py-1 text-gray-500">{group.partLabel}</td></tr>
                        )}
                        {group.items.map(q => (
                          <tr key={q.num} className="border-t border-gray-100 hover:bg-gray-50">
                            <td className="px-2 py-1.5 text-center font-bold text-gray-600">{q.num}</td>
                            <td className="px-2 py-1.5 text-gray-700">{q.text}</td>
                            <td className="px-2 py-1.5 text-center">
                              <input type="radio" name={`lb-q-${q.num}`} checked={lbAnswers[q.num] === 'yes'} onChange={() => setLbAnswers(prev => ({ ...prev, [q.num]: 'yes' }))} className="accent-green-600" />
                            </td>
                            <td className="px-2 py-1.5 text-center">
                              <input type="radio" name={`lb-q-${q.num}`} checked={lbAnswers[q.num] === 'no'} onChange={() => setLbAnswers(prev => ({ ...prev, [q.num]: 'no' }))} className="accent-red-600" />
                            </td>
                            <td className="px-2 py-1.5 text-center">
                              {q.hasNa ? (
                                <input type="radio" name={`lb-q-${q.num}`} checked={lbAnswers[q.num] === 'na'} onChange={() => setLbAnswers(prev => ({ ...prev, [q.num]: 'na' }))} className="accent-gray-500" />
                              ) : <span className="text-gray-300">—</span>}
                            </td>
                          </tr>
                        ))}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between">
              <div className="text-[10px] text-gray-400">
                {Object.values(lbAnswers).some(v => v === 'no')
                  ? <span className="text-red-600 font-bold">Tiene respuestas NO — el documento saldra como REJECTED</span>
                  : <span className="text-green-600 font-bold">Todas las respuestas OK — ACCEPTED</span>}
              </div>
              <div className="flex gap-3">
                <button onClick={() => setLbAwb(null)} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">Cancelar</button>
                <button onClick={saveLbAndPrint} disabled={lbSaving || lbLoading}
                  className="bg-red-700 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-red-800 disabled:opacity-50 flex items-center gap-2">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4H7v4a2 2 0 002 2zm0-16h6a2 2 0 012 2v2H7V5a2 2 0 012-2z"/></svg>
                  {lbSaving ? 'Guardando...' : 'Guardar y Generar'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}
