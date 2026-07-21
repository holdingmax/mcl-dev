import { useState, useEffect, useMemo, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  collection, query, where, getDocs, addDoc, doc, getDoc, updateDoc, deleteDoc,
  onSnapshot, orderBy, runTransaction,
} from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import { PACKING_TYPES } from '../../types'
import Layout from '../../components/Layout'
import { fmtNum } from '../../lib/utils'

// ── Types ────────────────────────────────────────────────────────────────────

interface DocReception {
  id: string
  awb_number: string
  mawb_number: string | null
  awb_1st_leg: string | null
  awb_2nd_leg: string | null
  client_name: string
  agent_name?: string | null
  shipper_name: string
  consignee_name: string
  destination: string
  pieces: number
  weight: number
  chargeable_weight: number
  uld_number: string | null
  cargo_type: 'loose' | 'bup'
  warehouse_type: 'bonded' | 'local'
  flight_number: string
  status: 'pending_physical' | 'in_physical' | 'complete'
  booking_id: string | null
  flight_id: string | null
  warehouse_number: string | null
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
  condition: 'ok' | 'damaged'
  notes: string
  barcode: string
  created_at: string
  created_by: string
  uld_id?: string | null
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Propagate warehouse_status = 'R' to the booking's awb_line when physical
 * reception is complete. Doc reception sets 'D'; physical reception upgrades to 'R'.
 */
async function markBookingReceived(rec: DocReception, physicalWeight?: number) {
  if (!rec.booking_id) return
  try {
    const bRef = doc(db, 'airfreight_bookings', rec.booking_id)
    await runTransaction(db, async (t) => {
      const bSnap = await t.get(bRef)
      if (!bSnap.exists()) return
      const bk = bSnap.data() as any
      if (bk.booking_type === 'simple') {
        const updates: Record<string, any> = { warehouse_status: 'R', on_hand: true }
        if (physicalWeight != null) updates.weight = physicalWeight
        t.update(bRef, updates)
      } else if (bk.awb_lines) {
        const lines = [...bk.awb_lines]
        const awb = rec.awb_number || ''
        const awb2 = rec.awb_2nd_leg || ''
        const awb1 = rec.awb_1st_leg || ''
        const idx = lines.findIndex((l: any) =>
          (awb && (l.awb_number === awb || l.awb_2nd_leg === awb)) ||
          (awb1 && l.awb_number === awb1) ||
          (awb2 && l.awb_2nd_leg === awb2)
        )
        if (idx >= 0) {
          lines[idx] = { ...lines[idx], warehouse_status: 'R', on_hand: true }
          // Physical reception weight is DEFINITIVE — overwrites documentary weight (0 resets it)
          if (physicalWeight != null) lines[idx].weight = physicalWeight
          t.update(bRef, { awb_lines: lines })
        }
      }
    })
  } catch (err) {
    console.error('Error marking booking as received:', err)
  }
}

const IN_TO_CM = 2.54

function toCm(val: number, unit: 'cm' | 'in'): number {
  return unit === 'in' ? Math.round(val * IN_TO_CM * 100) / 100 : val
}
function fromCm(val: number, unit: 'cm' | 'in'): number {
  return unit === 'in' ? Math.round(val / IN_TO_CM * 100) / 100 : val
}

function calcVolWeight(l: number | null, w: number | null, h: number | null): number | null {
  if (!l || !w || !h) return null
  return Math.round((l * w * h) / 6000 * 100) / 100
}

function padBarcode(warehouseNo: string, pieceNum: number, totalPieces: number): string {
  const digits = totalPieces >= 100 ? 3 : 2
  return warehouseNo + String(pieceNum).padStart(digits, '0')
}


// ── Generate next warehouse number via Firestore transaction ─────────────────

async function getNextWarehouseNumber(): Promise<string> {
  const seqRef = doc(db, 'config', 'air_warehouse_sequence')
  const nextNum = await runTransaction(db, async (tx) => {
    const snap = await tx.get(seqRef)
    const current = snap.exists() ? (snap.data().current || 0) : 0
    const next = current + 1
    tx.set(seqRef, { current: next })
    return next
  })
  return String(nextNum).padStart(10, '0')
}

// ── Label print ──────────────────────────────────────────────────────────────

function buildLabelStyles() {
  return `
  @page { size: 12cm 15cm; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; margin: 0; padding: 0; }
  .label {
    width: 12cm; height: 15cm; padding: .35cm .4cm; display: flex; flex-direction: column;
    justify-content: space-between; page-break-after: always; overflow: hidden;
  }
  .header { display: flex; justify-content: space-between; align-items: center;
    border-bottom: 2px solid #000; padding-bottom: 5px; }
  .logo { font-weight: 900; font-size: 18px; letter-spacing: 1px; }
  .header-right { font-size: 11px; text-align: right; line-height: 1.3; }
  .dest { text-align: center; font-size: 62px; font-weight: 900; letter-spacing: 3px;
    padding: 6px 0; border-bottom: 1.5px solid #000; }
  .mid { display: flex; justify-content: space-between; align-items: center;
    padding: 6px 0; border-bottom: 1px solid #000; }
  .mid-label { font-size: 10px; color: #555; text-transform: uppercase; letter-spacing: 0.5px; }
  .wh-val { font-size: 15px; font-weight: 700; font-family: monospace; }
  .piece-box { border: 2px solid #000; padding: 2px 8px; font-size: 22px;
    font-weight: 900; font-family: monospace; text-align: center; }
  .parties { padding: 5px 0; border-bottom: 1px solid #000; }
  .party-row { font-size: 11px; line-height: 1.5; }
  .party-row b { font-weight: 700; }
  .awb-section { display: flex; align-items: baseline; justify-content: center;
    gap: 0; padding: 4px 0; border-bottom: 1px solid #000; }
  .awb-small { font-size: 17px; font-family: monospace; font-weight: 600; }
  .awb-big { font-size: 56px; font-weight: 900; font-family: monospace; letter-spacing: 2px; line-height: 1; }
  .info-row { display: flex; justify-content: space-between; font-size: 11px; padding: 3px 0; }
  .info-row b { font-weight: 700; }
  .barcode-area { text-align: center; padding-top: 4px; flex-shrink: 0; }
  .barcode-text { font-family: monospace; font-size: 12px; letter-spacing: 1px; margin-top: 2px; }
  @media print { body { margin: 0; } }
`
}

function buildLabelHtml(piece: PhysicalPiece, reception: DocReception) {
  const awbDisplay = reception.awb_2nd_leg || reception.awb_number
  const awbParts = awbDisplay.split('-')
  const awbPrefix = awbParts[0] || ''
  const awbSuffix = awbParts[1] || ''
  const last4 = awbSuffix.slice(-4)
  const awbSmall = awbPrefix + '-' + awbSuffix.slice(0, awbSuffix.length - 4)
  const now = new Date()
  const dateStr = now.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' })
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  const pieceDigits = reception.pieces >= 100 ? 3 : 2

  return `
<div class="label">
  <div class="header">
    <div class="logo">MINCURL</div>
    <div class="header-right">${reception.agent_name ? `CLIENT: ${reception.client_name}<br>` : ''}FROM: MIA<br>${dateStr} ${timeStr}</div>
  </div>
  <div class="dest">${reception.destination || '---'}</div>
  <div class="mid">
    <div>
      <div class="mid-label">Warehouse No.</div>
      <div class="wh-val">${piece.warehouse_number}</div>
    </div>
    <div>
      <div class="mid-label">Piece</div>
      <div class="piece-box">${String(piece.piece_number).padStart(pieceDigits, '0')}</div>
    </div>
  </div>
  <div class="parties">
    <div class="party-row">AGENT: <b>${reception.agent_name || reception.client_name}</b></div>
    <div class="party-row">SHIPPER: <b>${reception.shipper_name}</b></div>
    <div class="party-row">CONSIGNEE: <b>${reception.consignee_name}</b></div>
  </div>
  <div class="awb-section">
    <span class="awb-small">${awbSmall}</span><span class="awb-big">${last4}</span>
  </div>
  <div class="info-row">
    <span>PCS: <b>${reception.pieces}</b></span>
    <span>WT: <b>${fmtNum(piece.weight_kg, 1)} KG</b></span>
  </div>
  <div class="barcode-area">
    <svg class="bc" data-barcode="${piece.barcode}"></svg>
    <div class="barcode-text">${piece.barcode}</div>
  </div>
</div>`
}

function printLabel(piece: PhysicalPiece, reception: DocReception) {
  const w = window.open('', '_blank', 'width=520,height=700')
  if (!w) return
  w.document.write(`<!DOCTYPE html>
<html><head><title>Label</title><style>${buildLabelStyles()}</style></head><body>
${buildLabelHtml(piece, reception)}
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
<script>
  document.querySelectorAll('.bc').forEach(el => {
    try { JsBarcode(el, el.dataset.barcode, { format: "CODE128", width: 2.2, height: 90, displayValue: false }); } catch(e) {}
  });
  setTimeout(() => window.print(), 500);
<\/script>
</body></html>`)
  w.document.close()
}

function printAllLabels(pieces: PhysicalPiece[], reception: DocReception) {
  if (pieces.length === 0) return
  const labelsHtml = pieces.map(p => buildLabelHtml(p, reception)).join('\n')

  const w = window.open('', '_blank', 'width=520,height=700')
  if (!w) return
  w.document.write(`<!DOCTYPE html>
<html><head><title>Labels</title><style>${buildLabelStyles()}</style></head><body>
${labelsHtml}
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
<script>
  document.querySelectorAll('.bc').forEach(el => {
    try { JsBarcode(el, el.dataset.barcode, { format: "CODE128", width: 2.2, height: 90, displayValue: false }); } catch(e) {}
  });
  setTimeout(() => window.print(), 500);
<\/script>
</body></html>`)
  w.document.close()
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function AirfreightPhysicalReception() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { user, isDistribuidor } = useAuth()

  // AWB search
  const [awbSearch, setAwbSearch] = useState(searchParams.get('awb') || '')
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')

  // Loaded reception
  const [reception, setReception] = useState<DocReception | null>(null)
  const [pieces, setPieces] = useState<PhysicalPiece[]>([])
  const [loadingPieces, setLoadingPieces] = useState(false)

  // Mode
  const [mode, setMode] = useState<'piece' | 'all'>('piece')
  const [dimUnit, setDimUnit] = useState<'cm' | 'in'>('in')

  // Piece form
  const [qty, setQty] = useState(1)
  const [weight, setWeight] = useState('')
  const [length, setLength] = useState('')
  const [width, setWidth] = useState('')
  const [height, setHeight] = useState('')
  const [packingType, setPackingType] = useState('SKID')
  const [condition, setCondition] = useState<'ok' | 'damaged'>('ok')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  // Receive All form
  const [raLength, setRaLength] = useState('')
  const [raWidth, setRaWidth] = useState('')
  const [raHeight, setRaHeight] = useState('')
  const [raPackingType, setRaPackingType] = useState('SKID')
  const [raSaving, setRaSaving] = useState(false)

  // Edit mode
  const [editDimUnit, setEditDimUnit] = useState<'cm' | 'in'>('in')
  const [editingPiece, setEditingPiece] = useState<PhysicalPiece | null>(null)

  // Mobile: show pieces list toggle
  const [showPiecesList, setShowPiecesList] = useState(false)

  const weightRef = useRef<HTMLInputElement>(null)

  // Auto-load by ID or AWB param
  useEffect(() => {
    const idParam = searchParams.get('id')
    if (idParam) {
      loadByDocId(idParam)
    } else if (awbSearch) {
      handleSearch()
    }
  }, []) // eslint-disable-line

  // Listen to pieces when reception is loaded
  useEffect(() => {
    if (!reception) return
    setLoadingPieces(true)
    // Simple query without orderBy to avoid composite index requirement
    const q = query(
      collection(db, 'airfreight_physical_pieces'),
      where('doc_reception_id', '==', reception.id),
    )
    const unsub = onSnapshot(q, (snap) => {
      const list = snap.docs
        .map(d => ({ id: d.id, ...d.data() } as PhysicalPiece))
        .sort((a, b) => b.piece_number - a.piece_number)
      setPieces(list)
      setLoadingPieces(false)
    }, (err) => {
      console.error('Physical pieces listener error:', err)
      setLoadingPieces(false)
    })
    return unsub
  }, [reception?.id])

  // Derived
  const receivedCount = pieces.length
  const declaredCount = reception?.pieces || 0
  const pendingCount = Math.max(0, declaredCount - receivedCount)
  const progressPct = declaredCount > 0 ? Math.round((receivedCount / declaredCount) * 100) : 0
  const nextPieceNumber = receivedCount + 1
  const isComplete = receivedCount >= declaredCount && declaredCount > 0

  // Sync status to 'complete' if pieces received >= declared but Firestore status is behind
  useEffect(() => {
    if (isComplete && reception && reception.status !== 'complete') {
      updateDoc(doc(db, 'airfreight_doc_receptions', reception.id), {
        status: 'complete',
        warehouse_status: 'R',
      }).then(() => {
        setReception(prev => prev ? { ...prev, status: 'complete' } : prev)
        const totalPhysicalWeight = pieces.reduce((s, p) => s + p.weight_kg, 0)
        markBookingReceived(reception, totalPhysicalWeight)
      }).catch(err => console.error('Error syncing complete status:', err))
    }
  }, [isComplete, reception?.id, reception?.status])

  const summary = useMemo(() => {
    const totalWeight = pieces.reduce((s, p) => s + p.weight_kg, 0)
    const totalVol = pieces.reduce((s, p) => {
      if (p.length_cm && p.width_cm && p.height_cm) {
        return s + (p.length_cm * p.width_cm * p.height_cm) / 1000000
      }
      return s
    }, 0)
    const okCount = pieces.filter(p => p.condition === 'ok').length
    const damagedCount = pieces.filter(p => p.condition === 'damaged').length
    return { totalWeight, totalVol, okCount, damagedCount }
  }, [pieces])

  // Group identical pieces visually
  const groupedPieces = useMemo(() => {
    const groups: { key: string; pieces: PhysicalPiece[]; count: number; representative: PhysicalPiece }[] = []
    const map = new Map<string, PhysicalPiece[]>()
    for (const p of pieces) {
      const k = `${p.weight_kg}|${p.length_cm}|${p.width_cm}|${p.height_cm}|${p.packing_type}|${p.condition}`
      if (!map.has(k)) map.set(k, [])
      map.get(k)!.push(p)
    }
    for (const [key, grp] of map) {
      groups.push({ key, pieces: grp, count: grp.length, representative: grp[0] })
    }
    return groups
  }, [pieces])

  // Receive All: weight per piece
  const raWeightPerPiece = pendingCount > 0 && reception
    ? Math.round(((reception.weight - summary.totalWeight) / pendingCount) * 100) / 100
    : 0
  const raTotalRemainingWeight = reception ? Math.max(0, reception.weight - summary.totalWeight) : 0

  const volWeight = calcVolWeight(
    length ? toCm(parseFloat(length), dimUnit) : null,
    width ? toCm(parseFloat(width), dimUnit) : null,
    height ? toCm(parseFloat(height), dimUnit) : null,
  )

  async function loadByDocId(docId: string) {
    setSearching(true)
    setSearchError('')
    try {
      const snap = await getDoc(doc(db, 'airfreight_doc_receptions', docId))
      if (!snap.exists()) {
        setSearchError('Recepcion documental no encontrada.')
        return
      }
      const docData = { id: snap.id, ...snap.data() } as DocReception
      setReception(docData)
      setAwbSearch(docData.awb_2nd_leg || docData.awb_number)
      if (docData.status === 'pending_physical') {
        await updateDoc(doc(db, 'airfreight_doc_receptions', docData.id), { status: 'in_physical' })
        setReception(prev => prev ? { ...prev, status: 'in_physical' } : prev)
      }
      // Assign warehouse number if needed
      if (!docData.warehouse_number) {
        const wn = await getNextWarehouseNumber()
        await updateDoc(doc(db, 'airfreight_doc_receptions', docData.id), { warehouse_number: wn })
        setReception(prev => prev ? { ...prev, warehouse_number: wn } : prev)
      }
    } catch (err: any) {
      console.error(err)
      setSearchError('Error al cargar recepcion.')
    } finally {
      setSearching(false)
    }
  }

  async function handleSearch() {
    const search = awbSearch.trim()
    if (!search) return
    setSearching(true)
    setSearchError('')
    setReception(null)
    setPieces([])

    try {
      // Search doc receptions by awb_number or awb_2nd_leg
      const q1 = query(collection(db, 'airfreight_doc_receptions'), where('awb_number', '==', search))
      const q2 = query(collection(db, 'airfreight_doc_receptions'), where('awb_2nd_leg', '==', search))
      const [snap1, snap2] = await Promise.all([getDocs(q1), getDocs(q2)])

      const results = [...snap1.docs, ...snap2.docs]
      // Deduplicate
      const seen = new Set<string>()
      const unique = results.filter(d => {
        if (seen.has(d.id)) return false
        seen.add(d.id)
        return true
      })

      if (unique.length === 0) {
        setSearchError('No se encontro recepcion documental para esta guia. Debe existir una recepcion documental antes de iniciar la recepcion fisica.')
        return
      }

      const docData = { id: unique[0].id, ...unique[0].data() } as DocReception

      // If status is complete, still allow viewing
      setReception(docData)

      // Update status to in_physical if pending
      if (docData.status === 'pending_physical') {
        await updateDoc(doc(db, 'airfreight_doc_receptions', docData.id), { status: 'in_physical' })
        setReception(prev => prev ? { ...prev, status: 'in_physical' } : prev)
      }
    } catch (err: any) {
      setSearchError(err.message || 'Error buscando recepcion')
    } finally {
      setSearching(false)
    }
  }

  // Query Firestore for the real current piece count to avoid duplicates
  async function getRealPieceCount(receptionId: string): Promise<number> {
    const snap = await getDocs(query(
      collection(db, 'airfreight_physical_pieces'),
      where('doc_reception_id', '==', receptionId),
    ))
    return snap.size
  }

  async function handleRegisterPiece() {
    if (!reception || !weight || saving) return
    const count = Math.max(1, Math.min(qty, pendingCount))
    const wkgCheck = parseFloat(weight) || 0
    // Sanity check: warn if total projected weight far exceeds declared CHW
    if (reception.chargeable_weight > 0 && wkgCheck > 0) {
      const projectedTotal = wkgCheck * count + summary.totalWeight
      if (projectedTotal > reception.chargeable_weight * 1.5) {
        if (!confirm(
          `ADVERTENCIA: El peso total proyectado (${fmtNum(projectedTotal, 1)} kg) supera significativamente el CHW declarado (${fmtNum(reception.chargeable_weight)} kg).\n\n` +
          `Ingresaste ${fmtNum(wkgCheck, 2)} kg por pieza. ¿Es correcto?`
        )) return
      }
    }
    setSaving(true)

    try {
      // Get or create warehouse number
      let warehouseNo = reception.warehouse_number
      if (!warehouseNo) {
        warehouseNo = await getNextWarehouseNumber()
        await updateDoc(doc(db, 'airfreight_doc_receptions', reception.id), { warehouse_number: warehouseNo })
        setReception(prev => prev ? { ...prev, warehouse_number: warehouseNo } : prev)
      }

      // Get real count from Firestore to avoid duplicate piece numbers
      const realCount = await getRealPieceCount(reception.id)
      const startPiece = realCount + 1

      const lcm = length ? toCm(parseFloat(length), dimUnit) : null
      const wcm = width ? toCm(parseFloat(width), dimUnit) : null
      const hcm = height ? toCm(parseFloat(height), dimUnit) : null
      const vw = calcVolWeight(lcm, wcm, hcm)
      const wkg = parseFloat(weight) || 0
      const now = new Date().toISOString()
      const createdBy = user?.email || ''
      const newPieces: PhysicalPiece[] = []

      for (let i = 0; i < count; i++) {
        const pieceNum = startPiece + i
        const barcode = padBarcode(warehouseNo!, pieceNum, declaredCount)

        const pieceData = {
          doc_reception_id: reception.id,
          awb_number: reception.awb_2nd_leg || reception.awb_number,
          awb_1st_leg: reception.awb_number || '',
          warehouse_number: warehouseNo,
          piece_number: pieceNum,
          weight_kg: wkg,
          length_cm: lcm,
          width_cm: wcm,
          height_cm: hcm,
          vol_weight_kg: vw,
          packing_type: packingType,
          condition,
          notes,
          barcode,
          created_at: now,
          created_by: createdBy,
        }

        const docRef = await addDoc(collection(db, 'airfreight_physical_pieces'), pieceData)
        newPieces.push({ id: docRef.id, ...pieceData } as PhysicalPiece)
      }

      // Check if complete
      const totalAfter = realCount + count
      if (totalAfter >= declaredCount) {
        await updateDoc(doc(db, 'airfreight_doc_receptions', reception.id), {
          status: 'complete',
          warehouse_status: 'R',
        })
        setReception(prev => prev ? { ...prev, status: 'complete' } : prev)
        const allPieces = [...pieces, ...newPieces]
        const totalPhysicalWeight = allPieces.reduce((s, p) => s + p.weight_kg, 0)
        await markBookingReceived(reception, totalPhysicalWeight)
      }

      // Reset form
      setQty(1)
      setWeight('')
      setLength('')
      setWidth('')
      setHeight('')
      setCondition('ok')
      setNotes('')
      weightRef.current?.focus()
    } catch (err: any) {
      alert('Error registrando carga: ' + (err.message || err))
    } finally {
      setSaving(false)
    }
  }

  async function handleReceiveAll() {
    if (!reception || pendingCount <= 0 || raSaving) return
    if (!raLength || !raWidth || !raHeight) {
      alert('Debe ingresar las dimensiones promedio')
      return
    }
    if (!confirm(`Registrar ${pendingCount} piezas con dimension promedio ${raLength}x${raWidth}x${raHeight} ${dimUnit} y peso ${fmtNum(raWeightPerPiece)} kg cada una?`)) return
    // Sanity check: warn if total weight far exceeds declared CHW
    if (reception.chargeable_weight > 0 && raWeightPerPiece > 0) {
      const projectedTotal = raWeightPerPiece * pendingCount + summary.totalWeight
      if (projectedTotal > reception.chargeable_weight * 1.5) {
        if (!confirm(
          `ADVERTENCIA: El peso total proyectado (${fmtNum(projectedTotal, 1)} kg) supera significativamente el CHW declarado (${fmtNum(reception.chargeable_weight)} kg).\n\n` +
          `Peso por pieza calculado: ${fmtNum(raWeightPerPiece, 2)} kg. ¿Es correcto?`
        )) return
      }
    }

    setRaSaving(true)
    try {
      let warehouseNo = reception.warehouse_number
      if (!warehouseNo) {
        warehouseNo = await getNextWarehouseNumber()
        await updateDoc(doc(db, 'airfreight_doc_receptions', reception.id), { warehouse_number: warehouseNo })
        setReception(prev => prev ? { ...prev, warehouse_number: warehouseNo } : prev)
      }

      // Get real count from Firestore to avoid duplicate piece numbers
      const realCount = await getRealPieceCount(reception.id)
      const realPending = Math.max(0, declaredCount - realCount)
      if (realPending <= 0) {
        alert('Todas las piezas ya fueron registradas')
        setRaSaving(false)
        return
      }

      const l = toCm(parseFloat(raLength), dimUnit)
      const w = toCm(parseFloat(raWidth), dimUnit)
      const h = toCm(parseFloat(raHeight), dimUnit)
      const vw = calcVolWeight(l, w, h)
      const newPieces: PhysicalPiece[] = []

      let weightAssigned = 0
      for (let i = 0; i < realPending; i++) {
        const pieceNum = realCount + 1 + i
        const barcode = padBarcode(warehouseNo!, pieceNum, declaredCount)
        const isLast = i === realPending - 1
        const pieceWeight = isLast
          ? Math.round((raTotalRemainingWeight - weightAssigned) * 100) / 100
          : raWeightPerPiece
        weightAssigned += pieceWeight

        const pieceData = {
          doc_reception_id: reception.id,
          awb_number: reception.awb_2nd_leg || reception.awb_number,
          awb_1st_leg: reception.awb_number || '',
          warehouse_number: warehouseNo,
          piece_number: pieceNum,
          weight_kg: pieceWeight,
          length_cm: l,
          width_cm: w,
          height_cm: h,
          vol_weight_kg: vw,
          packing_type: raPackingType,
          condition: 'ok' as const,
          notes: 'Receive All',
          barcode,
          created_at: new Date().toISOString(),
          created_by: user?.email || '',
        }

        const docRef = await addDoc(collection(db, 'airfreight_physical_pieces'), pieceData)
        newPieces.push({ id: docRef.id, ...pieceData })
      }

      // Mark complete
      await updateDoc(doc(db, 'airfreight_doc_receptions', reception.id), {
        status: 'complete',
        warehouse_status: 'R',
      })
      setReception(prev => prev ? { ...prev, status: 'complete' } : prev)
      const allPieces = [...pieces, ...newPieces]
      const totalPhysicalWeight = allPieces.reduce((s: number, p: any) => s + p.weight_kg, 0)
      await markBookingReceived(reception, totalPhysicalWeight)

      setRaLength('')
      setRaWidth('')
      setRaHeight('')
    } catch (err: any) {
      alert('Error en Receive All: ' + (err.message || err))
    } finally {
      setRaSaving(false)
    }
  }

  // Track which group is being edited (all piece IDs in that group)
  const [editingGroupIds, setEditingGroupIds] = useState<string[]>([])
  const [editingGroupQty, setEditingGroupQty] = useState<number>(0)

  async function handleUpdatePiece() {
    if (!editingPiece || !reception || saving) return
    // Sanity check: warn if new weight far exceeds declared CHW
    if (reception.chargeable_weight > 0 && editingPiece.weight_kg > 0) {
      const groupCount = editingGroupIds.length || 1
      const otherWeight = summary.totalWeight - (pieces.find(p => p.id === editingPiece!.id)?.weight_kg || 0) * groupCount
      const projectedTotal = editingPiece.weight_kg * groupCount + otherWeight
      if (projectedTotal > reception.chargeable_weight * 1.5) {
        if (!confirm(
          `ADVERTENCIA: El peso total proyectado (${fmtNum(projectedTotal, 1)} kg) supera significativamente el CHW declarado (${fmtNum(reception.chargeable_weight)} kg).\n\n` +
          `Peso por pieza: ${fmtNum(editingPiece.weight_kg, 2)} kg. ¿Es correcto?`
        )) return
      }
    }
    setSaving(true)
    try {
      const updateData = {
        weight_kg: editingPiece.weight_kg,
        length_cm: editingPiece.length_cm,
        width_cm: editingPiece.width_cm,
        height_cm: editingPiece.height_cm,
        vol_weight_kg: calcVolWeight(editingPiece.length_cm, editingPiece.width_cm, editingPiece.height_cm),
        packing_type: editingPiece.packing_type,
        condition: editingPiece.condition,
        notes: editingPiece.notes ?? '',
      }

      const originalCount = editingGroupIds.length || 1
      const newCount = editingGroupQty != null ? editingGroupQty : originalCount

      // ── Reducir piezas ──
      if (newCount < originalCount) {
        const toRemove = originalCount - newCount
        // Get all pieces in the group sorted by piece_number DESC (remove highest first)
        const groupPieces = pieces
          .filter(p => editingGroupIds.includes(p.id))
          .sort((a, b) => b.piece_number - a.piece_number)
        const piecesToRemove = groupPieces.slice(0, toRemove)

        // Check if any piece to remove is assigned to a ULD
        const inUld = piecesToRemove.filter(p => p.uld_id)
        if (inUld.length > 0) {
          alert(`No se pueden eliminar ${inUld.length} pieza(s) porque estan asignadas a un ULD. Desasignalas primero desde Build-up.`)
          setSaving(false)
          return
        }

        if (!confirm(`¿Eliminar ${toRemove} pieza(s) de este grupo? Esta accion no se puede deshacer.`)) {
          setSaving(false)
          return
        }

        // Delete pieces
        await Promise.all(piecesToRemove.map(p =>
          deleteDoc(doc(db, 'airfreight_physical_pieces', p.id))
        ))

        // Update remaining pieces in the group
        const remainingIds = editingGroupIds.filter(id => !piecesToRemove.some(p => p.id === id))
        await Promise.all(remainingIds.map(id =>
          updateDoc(doc(db, 'airfreight_physical_pieces', id), updateData)
        ))

        // Check if status needs to revert from complete to in_physical
        const newTotal = pieces.length - toRemove
        if (newTotal < declaredCount && reception.status === 'complete') {
          await updateDoc(doc(db, 'airfreight_doc_receptions', reception.id), {
            status: 'in_physical',
          })
          setReception(prev => prev ? { ...prev, status: 'in_physical' } : prev)
        }
        // If ALL pieces removed, reset weight in booking to 0
        if (newTotal <= 0 && reception.booking_id) {
          await markBookingReceived(reception, 0)
        }

      // ── Aumentar piezas ──
      } else if (newCount > originalCount) {
        const toAdd = newCount - originalCount
        let warehouseNo = reception.warehouse_number
        if (!warehouseNo) {
          warehouseNo = await getNextWarehouseNumber()
          await updateDoc(doc(db, 'airfreight_doc_receptions', reception.id), { warehouse_number: warehouseNo })
          setReception(prev => prev ? { ...prev, warehouse_number: warehouseNo } : prev)
        }

        const realCount = await getRealPieceCount(reception.id)
        const now = new Date().toISOString()
        const createdBy = user?.email || ''

        for (let i = 0; i < toAdd; i++) {
          const pieceNum = realCount + 1 + i
          const barcode = padBarcode(warehouseNo!, pieceNum, Math.max(declaredCount, realCount + toAdd))
          await addDoc(collection(db, 'airfreight_physical_pieces'), {
            doc_reception_id: reception.id,
            awb_number: editingPiece.awb_number,
            warehouse_number: warehouseNo,
            piece_number: pieceNum,
            weight_kg: editingPiece.weight_kg,
            length_cm: editingPiece.length_cm,
            width_cm: editingPiece.width_cm,
            height_cm: editingPiece.height_cm,
            vol_weight_kg: calcVolWeight(editingPiece.length_cm, editingPiece.width_cm, editingPiece.height_cm),
            packing_type: editingPiece.packing_type,
            condition: editingPiece.condition,
            notes: editingPiece.notes ?? '',
            barcode,
            created_at: now,
            created_by: createdBy,
          })
        }

        // Update existing pieces in the group with new field values
        await Promise.all(editingGroupIds.map(id =>
          updateDoc(doc(db, 'airfreight_physical_pieces', id), updateData)
        ))

        // Check if now complete
        const newTotal = realCount + toAdd
        if (newTotal >= declaredCount && reception.status !== 'complete') {
          await updateDoc(doc(db, 'airfreight_doc_receptions', reception.id), {
            status: 'complete',
            warehouse_status: 'R',
          })
          setReception(prev => prev ? { ...prev, status: 'complete' } : prev)
          const allWeight = pieces.reduce((s, p) => s + p.weight_kg, 0) + (editingPiece.weight_kg * toAdd)
          await markBookingReceived(reception, allWeight)
        }

      // ── Sin cambio de cantidad ──
      } else {
        const idsToUpdate = editingGroupIds.length > 0 ? editingGroupIds : [editingPiece.id]
        await Promise.all(idsToUpdate.map(id =>
          updateDoc(doc(db, 'airfreight_physical_pieces', id), updateData)
        ))
      }

      setEditingPiece(null)
      setEditingGroupIds([])
      setEditingGroupQty(0)
      setEditDimUnit('in')
    } catch (err: any) {
      alert('Error actualizando pieza: ' + (err.message || err))
    } finally {
      setSaving(false)
    }
  }

  function openWarehouseReceiptFromPhysical() {
    if (!reception) return
    const r = reception
    const awb = r.awb_2nd_leg || r.awb_number
    const warehouseNo = r.warehouse_number || '-'
    const totalWeight = pieces.reduce((s, p) => s + p.weight_kg, 0)
    const totalVolWeight = pieces.reduce((s, p) => {
      return s + ((p.length_cm || 0) * (p.width_cm || 0) * (p.height_cm || 0)) / 6000
    }, 0)
    const totalCBM = pieces.reduce((s, p) => {
      return s + ((p.length_cm || 0) * (p.width_cm || 0) * (p.height_cm || 0)) / 1_000_000
    }, 0)

    // Group pieces
    const grpMap = new Map<string, PhysicalPiece[]>()
    for (const p of pieces) {
      const k = `${p.weight_kg}|${p.length_cm}|${p.width_cm}|${p.height_cm}|${p.packing_type}|${p.condition}`
      if (!grpMap.has(k)) grpMap.set(k, [])
      grpMap.get(k)!.push(p)
    }
    const piecesRows = Array.from(grpMap.values()).map(grp => {
      const p = grp[0], count = grp.length
      const vwPer = ((p.length_cm || 0) * (p.width_cm || 0) * (p.height_cm || 0)) / 6000
      return `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:center;font-weight:600">${count}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right">${fmtNum(p.weight_kg * count)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:center">${fmtNum((p.length_cm||0)/2.54,1)} x ${fmtNum((p.width_cm||0)/2.54,1)} x ${fmtNum((p.height_cm||0)/2.54,1)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right">${fmtNum(vwPer * count)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:center">${p.packing_type || '-'}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:center">${p.condition === 'damaged' ? '<span style="color:#dc2626">Damaged</span>' : 'OK'}</td>
      </tr>`
    }).join('')

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Warehouse Receipt - ${awb}</title>
<style>
  @page { size: A4; margin: 15mm; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1f2937; margin: 0; padding: 20px; font-size: 12px; }
  .header { display: flex; align-items: center; justify-content: space-between; border-bottom: 3px solid #1e3a5f; padding-bottom: 15px; margin-bottom: 20px; }
  .logo-area { display: flex; align-items: center; gap: 12px; }
  .logo-box { width: 50px; height: 50px; background: #1e3a5f; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: white; font-weight: 800; font-size: 14px; letter-spacing: 1px; }
  .company-name { font-size: 22px; font-weight: 700; color: #1e3a5f; letter-spacing: 1px; }
  .company-sub { font-size: 10px; color: #6b7280; margin-top: 2px; }
  .doc-title { font-size: 18px; font-weight: 700; color: #1e3a5f; text-align: right; }
  .doc-number { font-size: 13px; color: #6b7280; text-align: right; margin-top: 4px; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
  .info-box { border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px; }
  .info-box h3 { font-size: 11px; text-transform: uppercase; color: #6b7280; margin: 0 0 10px; letter-spacing: 0.5px; }
  .info-row { display: flex; justify-content: space-between; margin-bottom: 6px; }
  .info-label { color: #6b7280; font-size: 11px; }
  .info-value { font-weight: 600; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  thead th { background: #1e3a5f; color: white; padding: 8px 10px; text-align: left; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
  .totals { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 20px; }
  .total-box { background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; text-align: center; }
  .total-box .label { font-size: 10px; text-transform: uppercase; color: #6b7280; margin-bottom: 4px; }
  .total-box .value { font-size: 18px; font-weight: 700; color: #1e3a5f; }
  .footer { margin-top: 30px; padding-top: 15px; border-top: 2px solid #e5e7eb; display: flex; justify-content: space-between; }
  .sign-box { width: 200px; text-align: center; }
  .sign-line { border-top: 1px solid #9ca3af; margin-top: 50px; padding-top: 6px; font-size: 10px; color: #6b7280; }
  .stamp { position: absolute; top: 200px; right: 60px; font-size: 48px; font-weight: 800; color: rgba(34,197,94,0.15); transform: rotate(-15deg); letter-spacing: 4px; }
  @media print { body { padding: 0; } .no-print { display: none; } }
</style></head><body>
  <div class="no-print" style="text-align:right;margin-bottom:10px">
    <button onclick="window.print()" style="padding:8px 20px;background:#1e3a5f;color:white;border:none;border-radius:6px;cursor:pointer;font-size:13px">Imprimir</button>
  </div>
  <div class="stamp">RECEIVED</div>
  <div class="header">
    <div class="logo-area">
      <div class="logo-box">MCL</div>
      <div><div class="company-name">MINCURL LOGISTICS</div><div class="company-sub">Warehouse Management System</div></div>
    </div>
    <div>
      <div class="doc-title">WAREHOUSE RECEIPT</div>
      <div class="doc-number">WR-${warehouseNo}</div>
      <div class="doc-number">${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' })}</div>
    </div>
  </div>
  <div class="info-grid">
    <div class="info-box">
      <h3>Shipment Information</h3>
      <div class="info-row"><span class="info-label">AWB Number</span><span class="info-value">${awb}</span></div>
      <div class="info-row"><span class="info-label">Flight</span><span class="info-value">${r.flight_number || '-'}</span></div>
      <div class="info-row"><span class="info-label">Cargo Type</span><span class="info-value">${r.cargo_type === 'bup' ? 'BUP' + (r.uld_number ? ' - ' + r.uld_number : '') : 'Loose'}</span></div>
      <div class="info-row"><span class="info-label">Warehouse</span><span class="info-value">${r.warehouse_type === 'bonded' ? 'Bonded' : 'Local'}</span></div>
      <div class="info-row"><span class="info-label">Destination</span><span class="info-value">${r.destination || '-'}</span></div>
      <div class="info-row"><span class="info-label">Declared Pieces</span><span class="info-value">${r.pieces}</span></div>
      <div class="info-row"><span class="info-label">Declared Weight</span><span class="info-value">${fmtNum(r.weight)} kg</span></div>
    </div>
    <div class="info-box">
      <h3>Parties</h3>
      <div class="info-row"><span class="info-label">Client</span><span class="info-value">${r.client_name || '-'}</span></div>
      <div class="info-row"><span class="info-label">Shipper</span><span class="info-value">${r.shipper_name || '-'}</span></div>
      <div class="info-row"><span class="info-label">Consignee</span><span class="info-value">${r.consignee_name || '-'}</span></div>
    </div>
  </div>
  <h3 style="font-size:13px;color:#1e3a5f;margin-bottom:10px">Piece Detail</h3>
  <table>
    <thead><tr>
      <th style="text-align:center">Qty</th>
      <th style="text-align:right">Weight (kg)</th>
      <th style="text-align:center">Dimensions (in)</th>
      <th style="text-align:right">Vol Wt (kg)</th>
      <th style="text-align:center">Packing</th>
      <th style="text-align:center">Condition</th>
    </tr></thead>
    <tbody>${piecesRows}</tbody>
  </table>
  <div class="totals">
    <div class="total-box"><div class="label">Total Pieces</div><div class="value">${pieces.length} / ${r.pieces}</div></div>
    <div class="total-box"><div class="label">Gross Weight</div><div class="value">${fmtNum(totalWeight)} kg</div></div>
    <div class="total-box"><div class="label">Vol. Weight</div><div class="value">${fmtNum(totalVolWeight)} kg</div></div>
    <div class="total-box"><div class="label">Total CBM</div><div class="value">${fmtNum(totalCBM, 4)} m&sup3;</div></div>
  </div>
  <div class="footer">
    <div class="sign-box"><div class="sign-line">Received By (Warehouse)</div></div>
    <div class="sign-box"><div class="sign-line">Delivered By (Driver)</div></div>
  </div>
  <div style="text-align:center;margin-top:20px;font-size:9px;color:#9ca3af">Generated by MINCURL WMS</div>
</body></html>`

    const win = window.open('', '_blank')
    if (win) { win.document.write(html); win.document.close() }
  }

  // ── Search screen ──────────────────────────────────────────────────────────

  if (!reception) {
    return (
      <Layout title="Recepcion Fisica" backTo="/airfreight/doc-reception">
        <div className="max-w-lg mx-auto px-4 py-12">
          <div className="bg-white rounded-xl border border-gray-200 p-8">
            <h2 className="text-lg font-bold text-gray-800 mb-1">Buscar AWB</h2>
            <p className="text-sm text-gray-500 mb-6">Ingrese el numero de guia para iniciar la recepcion fisica</p>

            <div className="flex gap-2">
              <input
                type="text"
                value={awbSearch}
                onChange={e => setAwbSearch(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                placeholder="Ej: 057-12345678"
                className="flex-1 border border-gray-200 rounded-lg px-4 py-3 text-sm font-mono focus:outline-none focus:border-blue-800"
                autoFocus
              />
              <button
                onClick={handleSearch}
                disabled={searching || !awbSearch.trim()}
                className="px-6 py-3 bg-blue-800 text-white rounded-lg font-semibold text-sm hover:bg-blue-900 disabled:opacity-50 transition-colors"
              >
                {searching ? 'Buscando...' : 'Buscar'}
              </button>
            </div>

            {searchError && (
              <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
                {searchError}
              </div>
            )}
          </div>
        </div>
      </Layout>
    )
  }

  // ── Reception screen (responsive) ─────────────────────────────────────────

  const awbDisplay = reception.awb_2nd_leg || reception.awb_number
  const statusBadge = reception.status === 'complete'
    ? <span className="text-xs bg-green-50 text-green-700 px-2 py-0.5 rounded-full font-medium">Completo</span>
    : reception.status === 'in_physical'
      ? <span className="text-xs bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full font-medium">En Recepcion</span>
      : <span className="text-xs bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full font-medium">Pendiente</span>

  return (
    <Layout title="Recepcion Fisica" backTo="/airfreight/doc-reception">
      <div className="max-w-6xl mx-auto px-4 py-4 lg:py-6">

        {/* ── Mobile header with progress ── */}
        <div className="lg:hidden mb-4">
          <div className="flex items-center justify-between mb-2">
            <div>
              <p className="font-mono font-semibold text-blue-800">{awbDisplay}</p>
              <p className="text-xs text-gray-500">{reception.client_name}</p>
            </div>
            <div className="text-right">
              <p className="text-lg font-bold">{receivedCount}/{declaredCount}</p>
              <p className="text-xs text-gray-400">piezas</p>
            </div>
          </div>
          <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
            <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${progressPct}%` }} />
          </div>
        </div>

        {/* ── Desktop AWB info bar ── */}
        <div className="hidden lg:flex bg-white rounded-xl border border-gray-200 p-4 mb-6 items-center gap-6 flex-wrap">
          <div>
            <p className="text-xs text-gray-400">AWB</p>
            <p className="font-mono font-semibold text-gray-800">{awbDisplay}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400">Cliente</p>
            <p className="text-sm font-medium text-gray-700">{reception.client_name}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400">Destino</p>
            <p className="text-sm font-bold text-gray-800">{reception.destination || '-'}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400">Tipo</p>
            <p className="text-sm font-medium text-gray-700">{reception.cargo_type === 'bup' ? 'BUP' : 'Loose'}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400">Declaradas</p>
            <p className="text-sm font-bold text-gray-800">{declaredCount}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400">Recibidas</p>
            <p className="text-sm font-bold text-green-600">{receivedCount} / {declaredCount}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400">Peso recibido</p>
            <p className="text-sm font-bold text-green-600">{fmtNum(summary.totalWeight, 1)} / {fmtNum(reception.weight, 1)} kg</p>
          </div>
          {reception.warehouse_number && (
            <div>
              <p className="text-xs text-gray-400">Warehouse No.</p>
              <div className="flex items-center gap-2">
                <p className="text-sm font-mono font-bold text-blue-800">{reception.warehouse_number}</p>
                {isComplete && (
                  <button
                    onClick={() => openWarehouseReceiptFromPhysical()}
                    className="text-gray-400 hover:text-red-600 transition-colors"
                    title="Ver Warehouse Receipt PDF"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          )}
          <div className="ml-auto flex items-center gap-3">
            {statusBadge}
            <div className="w-32">
              <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${progressPct}%` }} />
              </div>
              <p className="text-xs text-gray-400 mt-1 text-right">{progressPct}%</p>
            </div>
          </div>
        </div>

        {/* ── Mode toggle ── */}
        {!isDistribuidor && !isComplete && (
          <div className="flex items-center gap-3 mb-4 lg:mb-6">
            <div className="flex bg-white border border-gray-200 rounded-lg overflow-hidden">
              <button
                onClick={() => setMode('piece')}
                className={`px-4 py-2.5 text-sm font-medium transition-colors ${mode === 'piece' ? 'bg-blue-800 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
              >
                Pieza por Pieza
              </button>
              <button
                onClick={() => setMode('all')}
                className={`px-4 py-2.5 text-sm font-medium transition-colors ${mode === 'all' ? 'bg-blue-800 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
              >
                Receive All
              </button>
            </div>
            <div className="flex bg-white border border-gray-200 rounded-lg overflow-hidden ml-2">
              <button
                onClick={() => setDimUnit('cm')}
                className={`px-3 py-2 text-xs font-medium transition-colors ${dimUnit === 'cm' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:bg-gray-50'}`}
              >
                cm
              </button>
              <button
                onClick={() => setDimUnit('in')}
                className={`px-3 py-2 text-xs font-medium transition-colors ${dimUnit === 'in' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:bg-gray-50'}`}
              >
                in
              </button>
            </div>
            {mode === 'all' && <p className="text-xs text-gray-400 hidden lg:block">Registra todas las piezas pendientes con peso/dim promedio</p>}
          </div>
        )}

        {/* ── Receive All panel ── */}
        {!isDistribuidor && mode === 'all' && !isComplete && (
          <div className="bg-white rounded-xl border-2 border-amber-200 p-4 lg:p-5 mb-4 lg:mb-6">
            <h3 className="font-semibold text-gray-800 mb-1">Receive All - {pendingCount} piezas restantes</h3>
            <p className="text-xs text-gray-400 mb-4">Peso por pieza: <span className="font-mono font-bold text-gray-700">{fmtNum(raWeightPerPiece)} kg</span> ({fmtNum(raTotalRemainingWeight)} / {pendingCount})</p>

            <div className="grid grid-cols-3 gap-3 max-w-md mb-4">
              <div>
                <input
                  type="number"
                  inputMode="numeric"
                  placeholder="Largo"
                  value={raLength}
                  onChange={e => setRaLength(e.target.value)}
                  className="w-full border-2 border-gray-200 rounded-lg px-3 py-3 text-lg font-mono text-center focus:outline-none focus:border-blue-800"
                />
                <p className="text-[10px] text-gray-400 text-center mt-1">Largo ({dimUnit})</p>
              </div>
              <div>
                <input
                  type="number"
                  inputMode="numeric"
                  placeholder="Ancho"
                  value={raWidth}
                  onChange={e => setRaWidth(e.target.value)}
                  className="w-full border-2 border-gray-200 rounded-lg px-3 py-3 text-lg font-mono text-center focus:outline-none focus:border-blue-800"
                />
                <p className="text-[10px] text-gray-400 text-center mt-1">Ancho ({dimUnit})</p>
              </div>
              <div>
                <input
                  type="number"
                  inputMode="numeric"
                  placeholder="Alto"
                  value={raHeight}
                  onChange={e => setRaHeight(e.target.value)}
                  className="w-full border-2 border-gray-200 rounded-lg px-3 py-3 text-lg font-mono text-center focus:outline-none focus:border-blue-800"
                />
                <p className="text-[10px] text-gray-400 text-center mt-1">Alto ({dimUnit})</p>
              </div>
            </div>

            {/* Packing type */}
            <div className="mb-4">
              <label className="block text-xs text-gray-500 mb-1 font-medium">Tipo de pieza</label>
              <div className="flex flex-wrap gap-2 max-w-md">
                {PACKING_TYPES.map(t => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setRaPackingType(t)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg border-2 transition-colors ${raPackingType === t ? 'border-amber-500 bg-amber-50 text-amber-800' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
                  >{t}</button>
                ))}
              </div>
            </div>

            {/* Preview totals */}
            {raLength && raWidth && raHeight && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
                <p className="text-xs text-amber-700 font-medium mb-1">Resumen de {pendingCount} piezas:</p>
                <div className="flex gap-4 text-sm font-mono text-amber-800">
                  <span>Peso: {fmtNum(raWeightPerPiece * pendingCount, 1)} kg</span>
                  {(() => {
                    const lCm = toCm(parseFloat(raLength), dimUnit)
                    const wCm = toCm(parseFloat(raWidth), dimUnit)
                    const hCm = toCm(parseFloat(raHeight), dimUnit)
                    const vwUnit = calcVolWeight(lCm, wCm, hCm)
                    const cbmUnit = (lCm * wCm * hCm) / 1000000
                    return <>
                      {vwUnit !== null && <span>Vol.Wt: {fmtNum(vwUnit * pendingCount)} kg</span>}
                      <span>CBM: {fmtNum(cbmUnit * pendingCount, 4)} m³</span>
                    </>
                  })()}
                </div>
              </div>
            )}

            <button
              onClick={handleReceiveAll}
              disabled={raSaving}
              className="bg-amber-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-amber-700 transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              {raSaving ? 'Registrando...' : `Registrar ${pendingCount} piezas`}
            </button>
          </div>
        )}

        {/* ── Main content: Desktop 2-col / Mobile stacked ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">

          {/* ── Left: Piece Entry Form (desktop) / Card (mobile) ── */}
          {!isDistribuidor && (mode === 'piece' && !isComplete || editingPiece) && (
            <div className="lg:col-span-1">
              <div className="bg-white rounded-xl border border-gray-200 p-5 lg:sticky lg:top-4">
                <h3 className="font-semibold text-gray-800 mb-4">
                  {editingPiece
                    ? editingGroupIds.length > 1
                      ? `Editando ${editingGroupIds.length} Piezas`
                      : 'Editando Pieza'
                    : 'Ingresar Carga'}
                </h3>

                <div className="space-y-4">
                  {/* Quantity — new pieces */}
                  {!editingPiece && (
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Cantidad de piezas</label>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setQty(q => Math.max(1, q - 1))}
                          className="w-10 h-10 rounded-lg border border-gray-200 text-lg font-bold text-gray-600 hover:bg-gray-50 flex items-center justify-center"
                        >-</button>
                        <input
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={pendingCount}
                          value={qty}
                          onChange={e => {
                            const v = parseInt(e.target.value) || 1
                            setQty(Math.max(1, Math.min(v, pendingCount)))
                          }}
                          className="w-20 border-2 border-gray-200 rounded-lg px-2 py-2 text-lg font-mono text-center focus:outline-none focus:border-blue-800"
                        />
                        <button
                          type="button"
                          onClick={() => setQty(q => Math.min(q + 1, pendingCount))}
                          className="w-10 h-10 rounded-lg border border-gray-200 text-lg font-bold text-gray-600 hover:bg-gray-50 flex items-center justify-center"
                        >+</button>
                        <span className="text-xs text-gray-400 ml-1">/ {pendingCount} pendientes</span>
                      </div>
                    </div>
                  )}

                  {/* Quantity — edit existing group */}
                  {editingPiece && editingGroupIds.length > 0 && (
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Cantidad de piezas</label>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setEditingGroupQty(q => Math.max(0, q - 1))}
                          className="w-10 h-10 rounded-lg border border-gray-200 text-lg font-bold text-gray-600 hover:bg-gray-50 flex items-center justify-center"
                        >-</button>
                        <input
                          type="number"
                          inputMode="numeric"
                          min={0}
                          value={editingGroupQty}
                          onChange={e => {
                            const v = parseInt(e.target.value)
                            setEditingGroupQty(Math.max(0, isNaN(v) ? 0 : v))
                          }}
                          className="w-20 border-2 border-gray-200 rounded-lg px-2 py-2 text-lg font-mono text-center focus:outline-none focus:border-blue-800"
                        />
                        <button
                          type="button"
                          onClick={() => setEditingGroupQty(q => q + 1)}
                          className="w-10 h-10 rounded-lg border border-gray-200 text-lg font-bold text-gray-600 hover:bg-gray-50 flex items-center justify-center"
                        >+</button>
                        {editingGroupQty !== editingGroupIds.length && (
                          <span className="text-xs text-amber-600 ml-1">
                            {editingGroupQty < editingGroupIds.length
                              ? `−${editingGroupIds.length - editingGroupQty}`
                              : `+${editingGroupQty - editingGroupIds.length}`}
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Weight */}
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Peso por pieza (kg) *</label>
                    {(() => {
                      const currentWt = editingPiece ? editingPiece.weight_kg : (parseFloat(weight) || 0)
                      const chw = reception?.chargeable_weight || 0
                      const pcs = reception?.pieces || 1
                      const expectedPerPiece = chw > 0 ? chw / pcs : 0
                      const isOverweight = chw > 0 && currentWt > 0 && currentWt > expectedPerPiece * 1.5
                      return (
                        <>
                          <input
                            ref={weightRef}
                            type="number"
                            step="0.01"
                            inputMode="decimal"
                            placeholder="0.00"
                            value={editingPiece ? editingPiece.weight_kg || '' : weight}
                            onChange={e => editingPiece
                              ? setEditingPiece({ ...editingPiece, weight_kg: parseFloat(e.target.value) || 0 })
                              : setWeight(e.target.value)
                            }
                            className={`w-full border-2 rounded-xl px-4 py-3 lg:py-2.5 text-xl lg:text-lg font-mono text-center focus:outline-none ${
                              isOverweight ? 'border-orange-400 bg-orange-50 focus:border-orange-600' : 'border-gray-200 focus:border-blue-800'
                            }`}
                          />
                          {chw > 0 && (
                            <p className={`text-xs mt-1 ${isOverweight ? 'text-orange-600 font-semibold' : 'text-gray-400'}`}>
                              Ref: CHW/pieza = {fmtNum(expectedPerPiece, 1)} kg · CHW total = {fmtNum(chw)} kg
                              {isOverweight && ' — Peso inusualmente alto'}
                            </p>
                          )}
                        </>
                      )
                    })()}
                  </div>

                  {/* Dimensions + unit toggle for edit mode */}
                  {editingPiece && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500">Dimensiones</span>
                      <div className="ml-auto flex border border-gray-200 rounded-lg overflow-hidden">
                        <button type="button" onClick={() => setEditDimUnit('in')}
                          className={`px-3 py-1 text-xs font-medium transition-colors ${editDimUnit === 'cm' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:bg-gray-50'}`}>cm</button>
                        <button type="button" onClick={() => setEditDimUnit('in')}
                          className={`px-3 py-1 text-xs font-medium transition-colors ${editDimUnit === 'in' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:bg-gray-50'}`}>in</button>
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Largo</label>
                      <input
                        type="number"
                        inputMode="numeric"
                        placeholder="L"
                        value={editingPiece ? (editingPiece.length_cm ? fromCm(editingPiece.length_cm, editDimUnit) : '') : length}
                        onChange={e => editingPiece
                          ? setEditingPiece({ ...editingPiece, length_cm: e.target.value ? toCm(parseFloat(e.target.value), editDimUnit) : null })
                          : setLength(e.target.value)
                        }
                        className="w-full border border-gray-200 rounded-lg px-2 py-2.5 text-sm focus:outline-none focus:border-blue-800 text-center font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Ancho</label>
                      <input
                        type="number"
                        inputMode="numeric"
                        placeholder="A"
                        value={editingPiece ? (editingPiece.width_cm ? fromCm(editingPiece.width_cm, editDimUnit) : '') : width}
                        onChange={e => editingPiece
                          ? setEditingPiece({ ...editingPiece, width_cm: e.target.value ? toCm(parseFloat(e.target.value), editDimUnit) : null })
                          : setWidth(e.target.value)
                        }
                        className="w-full border border-gray-200 rounded-lg px-2 py-2.5 text-sm focus:outline-none focus:border-blue-800 text-center font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Alto</label>
                      <input
                        type="number"
                        inputMode="numeric"
                        placeholder="H"
                        value={editingPiece ? (editingPiece.height_cm ? fromCm(editingPiece.height_cm, editDimUnit) : '') : height}
                        onChange={e => editingPiece
                          ? setEditingPiece({ ...editingPiece, height_cm: e.target.value ? toCm(parseFloat(e.target.value), editDimUnit) : null })
                          : setHeight(e.target.value)
                        }
                        className="w-full border border-gray-200 rounded-lg px-2 py-2.5 text-sm focus:outline-none focus:border-blue-800 text-center font-mono"
                      />
                    </div>
                  </div>

                  {/* Vol Weight + totals preview */}
                  {!editingPiece && volWeight !== null && (
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Vol. Weight{qty > 1 ? ' (por pieza)' : ''}</label>
                      <p className="text-sm text-gray-600 font-mono bg-gray-50 rounded-lg px-3 py-2">{fmtNum(volWeight)} kg</p>
                    </div>
                  )}
                  {!editingPiece && qty > 1 && weight && (
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                      <p className="text-xs text-blue-700 font-medium mb-1">Resumen de {qty} piezas:</p>
                      <div className="flex gap-4 text-sm font-mono text-blue-800">
                        <span>Peso: {fmtNum((parseFloat(weight) || 0) * qty, 1)} kg</span>
                        {volWeight !== null && <span>Vol: {fmtNum(volWeight * qty)} kg</span>}
                        {volWeight !== null && (() => {
                          const lCm = length ? toCm(parseFloat(length), dimUnit) : 0
                          const wCm = width ? toCm(parseFloat(width), dimUnit) : 0
                          const hCm = height ? toCm(parseFloat(height), dimUnit) : 0
                          const cbm = (lCm * wCm * hCm) / 1000000 * qty
                          return <span>CBM: {fmtNum(cbm, 4)} m³</span>
                        })()}
                      </div>
                    </div>
                  )}

                  {/* Packing Type */}
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Tipo de pieza</label>
                    {/* Mobile: grid of radio cards. Desktop: dropdown */}
                    <div className="lg:hidden grid grid-cols-3 gap-2">
                      {PACKING_TYPES.map(t => (
                        <label key={t} className="cursor-pointer">
                          <input
                            type="radio"
                            name="ptype"
                            value={t}
                            checked={(editingPiece ? editingPiece.packing_type : packingType) === t}
                            onChange={() => editingPiece
                              ? setEditingPiece({ ...editingPiece, packing_type: t })
                              : setPackingType(t)
                            }
                            className="peer hidden"
                          />
                          <div className="border-2 border-gray-200 peer-checked:border-blue-800 peer-checked:bg-blue-50 rounded-lg py-2 text-center text-xs font-medium transition-all">{t}</div>
                        </label>
                      ))}
                    </div>
                    <select
                      value={editingPiece ? editingPiece.packing_type : packingType}
                      onChange={e => editingPiece
                        ? setEditingPiece({ ...editingPiece, packing_type: e.target.value })
                        : setPackingType(e.target.value)
                      }
                      className="hidden lg:block w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-800"
                    >
                      {PACKING_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>

                  {/* Condition */}
                  <div>
                    <label className="block text-xs text-gray-500 mb-2">Condicion</label>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="cursor-pointer">
                        <input
                          type="radio"
                          name="cond"
                          value="ok"
                          checked={(editingPiece ? editingPiece.condition : condition) === 'ok'}
                          onChange={() => editingPiece
                            ? setEditingPiece({ ...editingPiece, condition: 'ok' })
                            : setCondition('ok')
                          }
                          className="peer hidden"
                        />
                        <div className="border-2 border-gray-200 peer-checked:border-green-500 peer-checked:bg-green-50 rounded-xl py-3 text-center transition-all">
                          <svg className="w-5 h-5 mx-auto text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                          <span className="text-sm font-medium text-green-700">OK</span>
                        </div>
                      </label>
                      <label className="cursor-pointer">
                        <input
                          type="radio"
                          name="cond"
                          value="damaged"
                          checked={(editingPiece ? editingPiece.condition : condition) === 'damaged'}
                          onChange={() => editingPiece
                            ? setEditingPiece({ ...editingPiece, condition: 'damaged' })
                            : setCondition('damaged')
                          }
                          className="peer hidden"
                        />
                        <div className="border-2 border-gray-200 peer-checked:border-red-500 peer-checked:bg-red-50 rounded-xl py-3 text-center transition-all">
                          <svg className="w-5 h-5 mx-auto text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                          </svg>
                          <span className="text-sm font-medium text-red-700">Danada</span>
                        </div>
                      </label>
                    </div>
                  </div>

                  {/* Notes */}
                  <div>
                    <input
                      type="text"
                      placeholder="Nota rapida (opcional)..."
                      value={editingPiece ? editingPiece.notes : notes}
                      onChange={e => editingPiece
                        ? setEditingPiece({ ...editingPiece, notes: e.target.value })
                        : setNotes(e.target.value)
                      }
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-800"
                    />
                  </div>

                  {/* Action button */}
                  {editingPiece ? (
                    <div className="flex gap-2">
                      <button
                        onClick={() => { setEditingPiece(null); setEditingGroupIds([]); setEditingGroupQty(0); setEditDimUnit('in') }}
                        className="flex-1 border border-gray-200 py-3 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
                      >
                        Cancelar
                      </button>
                      <button
                        onClick={handleUpdatePiece}
                        disabled={saving}
                        className="flex-1 bg-blue-800 text-white py-3 rounded-lg font-semibold hover:bg-blue-900 disabled:opacity-50 transition-colors"
                      >
                        {saving ? 'Guardando...' : 'Actualizar'}
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={handleRegisterPiece}
                      disabled={saving || !weight}
                      className="w-full bg-green-600 text-white py-3 lg:py-2.5 rounded-xl lg:rounded-lg font-bold lg:font-semibold text-lg lg:text-sm hover:bg-green-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      {saving ? 'Registrando...' : qty > 1 ? `Registrar ${qty} piezas` : 'Registrar y Generar Barcode'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── Right: Pieces List ── */}
          <div className={!isDistribuidor && ((mode === 'piece' && !isComplete) || editingPiece) ? 'lg:col-span-2' : 'lg:col-span-3'}>

            {/* Mobile toggle for pieces list */}
            <button
              onClick={() => setShowPiecesList(!showPiecesList)}
              className="lg:hidden w-full text-left text-xs text-gray-500 font-medium mb-2 flex items-center justify-between"
            >
              <span>Piezas registradas ({receivedCount})</span>
              <svg className={`w-4 h-4 transition-transform ${showPiecesList ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {/* Mobile: collapsed list (last 3) */}
            {!showPiecesList && (
              <div className="lg:hidden space-y-2 mb-4">
                {groupedPieces.slice(0, 3).map(g => (
                  <div key={g.key} className="bg-white rounded-lg border border-gray-100 px-3 py-2 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-bold text-blue-800">{g.count}x</span>
                      <span className="text-sm font-mono">{fmtNum(g.representative.weight_kg, 1)}kg</span>
                      {g.representative.length_cm && g.representative.width_cm && g.representative.height_cm && (
                        <span className="text-xs text-gray-400">{g.representative.length_cm}x{g.representative.width_cm}x{g.representative.height_cm}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-medium ${g.representative.condition === 'ok' ? 'text-green-600' : 'text-red-600'}`}>
                        {g.representative.condition === 'ok' ? 'OK' : 'Danada'}
                      </span>
                      <button
                        onClick={() => { setEditingPiece(g.representative); setEditingGroupIds(g.pieces.map(x => x.id)); setEditingGroupQty(g.pieces.length) }}
                        className="p-1 text-gray-400 hover:text-blue-800"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
                {groupedPieces.length > 3 && (
                  <button
                    onClick={() => setShowPiecesList(true)}
                    className="w-full text-center text-xs text-blue-800 font-medium py-1"
                  >
                    Ver todas ({pieces.length})
                  </button>
                )}
              </div>
            )}

            {/* Desktop: always show full list. Mobile: show when toggled */}
            <div className={`${showPiecesList ? '' : 'hidden lg:block'}`}>
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                  <h3 className="font-semibold text-gray-700 text-sm">Piezas Recibidas ({receivedCount})</h3>
                  <div className="flex items-center gap-3">
                    {pieces.length > 0 && (
                      <button
                        onClick={() => printAllLabels(pieces, reception)}
                        className="text-xs text-blue-800 hover:underline font-medium flex items-center gap-1"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                        </svg>
                        Print ALL
                      </button>
                    )}
                  </div>
                </div>

                {loadingPieces ? (
                  <div className="p-8 text-center text-gray-400">Cargando piezas...</div>
                ) : pieces.length === 0 ? (
                  <div className="p-8 text-center text-gray-400">No hay piezas registradas aun</div>
                ) : (
                  <div className="divide-y divide-gray-100 max-h-[600px] overflow-y-auto">
                    {groupedPieces.map(g => {
                      const p = g.representative
                      const pieceNums = g.pieces.map(x => x.piece_number).sort((a, b) => a - b)
                      const rangeLabel = g.count === 1
                        ? `#${pieceNums[0]}`
                        : `#${pieceNums[0]}-#${pieceNums[pieceNums.length - 1]}`
                      return (
                        <div key={g.key} className="px-4 py-3 flex items-center gap-4 hover:bg-gray-50">
                          <div className="text-center min-w-[48px]">
                            <span className="text-sm font-bold text-blue-800">{g.count}</span>
                            <p className="text-[10px] text-gray-400">{g.count === 1 ? 'pieza' : 'piezas'}</p>
                            <p className="text-[9px] text-gray-300 font-mono">{rangeLabel}</p>
                          </div>
                          <div className="flex-1 grid gap-2 text-sm" style={{ gridTemplateColumns: '1fr 1fr 2fr 1fr 1fr' }}>
                            <div>
                              <p className="text-xs text-gray-400">Tipo</p>
                              <p className="font-medium">{p.packing_type}</p>
                            </div>
                            <div>
                              <p className="text-xs text-gray-400">Peso c/u</p>
                              <p className="font-mono font-medium">{fmtNum(p.weight_kg, 1)} kg</p>
                            </div>
                            <div>
                              <p className="text-xs text-gray-400">Dim (LxAxH) in</p>
                              <p className="font-mono whitespace-nowrap">
                                {p.length_cm && p.width_cm && p.height_cm
                                  ? `${fmtNum(p.length_cm / 2.54, 1)} x ${fmtNum(p.width_cm / 2.54, 1)} x ${fmtNum(p.height_cm / 2.54, 1)}`
                                  : '-'}
                              </p>
                            </div>
                            <div>
                              <p className="text-xs text-gray-400">Vol. Wt c/u</p>
                              <p className="font-mono">{p.vol_weight_kg ? `${fmtNum(p.vol_weight_kg)} kg` : '-'}</p>
                            </div>
                            <div>
                              <p className="text-xs text-gray-400">Condicion</p>
                              <p className={`font-medium ${p.condition === 'ok' ? 'text-green-600' : 'text-red-600'}`}>
                                {p.condition === 'ok' ? 'OK' : 'Danada'}
                              </p>
                            </div>
                          </div>
                          {!isDistribuidor && (
                            <button
                              onClick={() => {
                                setEditingPiece(p)
                                setEditingGroupIds(g.pieces.map(x => x.id))
                                setEditingGroupQty(g.pieces.length)
                              }}
                              className="p-1.5 text-gray-400 hover:text-blue-800 hover:bg-blue-50 rounded-lg transition-colors"
                              title={g.count === 1 ? 'Editar pieza' : `Editar ${g.count} piezas`}
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                              </svg>
                            </button>
                          )}
                          <button
                            onClick={() => {
                              if (g.count === 1) {
                                printLabel(p, reception)
                              } else {
                                printAllLabels(g.pieces, reception)
                              }
                            }}
                            className="p-1.5 text-gray-400 hover:text-blue-800 hover:bg-blue-50 rounded-lg transition-colors"
                            title={g.count === 1 ? 'Imprimir etiqueta' : `Imprimir ${g.count} etiquetas`}
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                            </svg>
                          </button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Summary */}
              {pieces.length > 0 && (
                <div className="mt-4 bg-white rounded-xl border border-gray-200 p-4">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
                    <div>
                      <p className="text-lg font-bold text-gray-800">{fmtNum(summary.totalWeight, 1)}</p>
                      <p className="text-xs text-gray-400">Peso total (kg)</p>
                    </div>
                    <div>
                      <p className="text-lg font-bold text-gray-800">{fmtNum(summary.totalVol, 4)}</p>
                      <p className="text-xs text-gray-400">Vol. total (m3)</p>
                    </div>
                    <div>
                      <p className="text-lg font-bold text-gray-800">{summary.okCount}</p>
                      <p className="text-xs text-gray-400">Piezas OK</p>
                    </div>
                    <div>
                      <p className="text-lg font-bold text-red-600">{summary.damagedCount}</p>
                      <p className="text-xs text-gray-400">Piezas danadas</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="mt-4 flex justify-between items-center gap-3">
                <button
                  onClick={() => {
                    setReception(null)
                    setPieces([])
                    setAwbSearch('')
                  }}
                  className="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
                >
                  Buscar otra AWB
                </button>
                {isComplete && (
                  <span className="text-sm font-semibold text-green-700 flex items-center gap-1">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Recepcion completa
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </Layout>
  )
}
