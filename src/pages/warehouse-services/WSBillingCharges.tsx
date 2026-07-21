import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { collection, query, getDocs, orderBy, doc, getDoc, updateDoc, deleteDoc, addDoc, limit, where, runTransaction, writeBatch } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import Layout from '../../components/Layout'
import { calculatePOSCharges, calculateTransportCharge, loadEffectiveRates } from '../../lib/wsBilling'
import type { CargoData } from '../../lib/wsBilling'
import type { WSServiceOrder, WarehouseReceipt, WSRateSchedule } from '../../types'

interface WSCharge {
  id: string
  so_id: string
  so_number: string
  client_id: string
  client_name: string
  service_type: string
  description: string
  amount: number
  currency: string
  status: string
  rate_id: string | null
  storage_days?: number | null
  qty?: number | null
  rate_price?: number | null
  rate_unit?: string | null
  detail?: string | null
  created_at: string
  created_by: string
  do_id?: string
  do_number?: string
}

interface SOGroup {
  so_id: string
  so_number: string
  charges: WSCharge[]
  total: number
}

interface ClientBlock {
  client_id: string
  client_name: string
  soGroups: SOGroup[]
  total: number
  allPending: boolean
}

function fmtUSD(n: number) { return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }

const SERVICE_LABELS: Record<string, string> = {
  in_out: 'In/Out',
  storage: 'Storage',
  screening_k9: 'K9 Screening',
  screening_xray: 'X-Ray Screening',
  screening_manual: 'Screening Special',
  transport: 'Transport',
  dg_inspection: 'DG Acceptance',
  repack: 'Repack',
  bonded_fee: 'Bonded Fee',
  handling_storage_fee: 'Handling & Storage Fee',
  manual: 'Cargo Manual',
  breakdown_bup: 'Breakdown BUP',
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  invoiced: 'bg-blue-100 text-blue-700',
  paid: 'bg-green-100 text-green-700',
  invalidated: 'bg-red-100 text-red-600',
}

export default function WSBillingCharges() {
  const navigate = useNavigate()
  const { isAdmin, isAccounting, user } = useAuth()
  const [charges, setCharges] = useState<WSCharge[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [filterClient, setFilterClient] = useState('')
  const [filterStatus, setFilterStatus] = useState<string>('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  // Edit charge
  const [editCharge, setEditCharge] = useState<WSCharge | null>(null)
  const [editAmount, setEditAmount] = useState('')
  const [recalculating, setRecalculating] = useState(false)
  // Invoice selection
  const [selectedSOs, setSelectedSOs] = useState<Set<string>>(new Set())
  const [invoicing, setInvoicing] = useState(false)
  const invoicingRef = useRef(false)
  // Add manual charge
  const [addChargeTarget, setAddChargeTarget] = useState<SOGroup | null>(null)
  const [addChargeClientId, setAddChargeClientId] = useState('')
  const [rateOptions, setRateOptions] = useState<(WSRateSchedule & { effectivePrice: number; effectiveMin: number | null })[]>([])
  const [acRateId, setAcRateId] = useState('')
  const [acDescription, setAcDescription] = useState('')
  const [acUnit, setAcUnit] = useState('KG')
  const [acQty, setAcQty] = useState('')
  const [acRate, setAcRate] = useState('')
  const [acSaving, setAcSaving] = useState(false)

  useEffect(() => { loadCharges() }, [])

  async function loadCharges() {
    setLoading(true)
    try {
      const snap = await getDocs(query(collection(db, 'ws_billing_charges'), orderBy('created_at', 'desc'), limit(2000)))
      setCharges(snap.docs.map(d => ({ id: d.id, ...d.data() } as WSCharge)))
    } catch (e) { console.error(e) }
    setLoading(false)
  }

  function toggleExpand(key: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  // ── Delete charge ──
  async function handleDelete(charge: WSCharge) {
    if (!confirm(`Eliminar cargo "${charge.description}" (${fmtUSD(charge.amount)})?\n\nEsta accion no se puede deshacer.`)) return
    try {
      await deleteDoc(doc(db, 'ws_billing_charges', charge.id))
      await loadCharges()
    } catch (e) { alert('Error: ' + String(e)) }
  }

  // ── Save edited charge ──
  async function handleSaveEdit() {
    if (!editCharge) return
    const amt = parseFloat(editAmount)
    if (isNaN(amt) || amt < 0) { alert('Monto invalido'); return }
    try {
      await updateDoc(doc(db, 'ws_billing_charges', editCharge.id), { amount: amt })
      setEditCharge(null)
      await loadCharges()
    } catch (e) { alert('Error: ' + String(e)) }
  }

  // ── Open add manual charge modal ──
  async function openAddCharge(soGroup: SOGroup, clientId: string) {
    setAddChargeTarget(soGroup)
    setAddChargeClientId(clientId)
    setAcRateId('')
    setAcDescription('')
    setAcUnit('KG')
    setAcQty('')
    setAcRate('')
    try {
      const rates = await loadEffectiveRates(clientId)
      setRateOptions(rates)
    } catch { setRateOptions([]) }
  }

  function onSelectRate(rateId: string) {
    setAcRateId(rateId)
    const r = rateOptions.find(x => x.id === rateId)
    if (r) {
      setAcDescription(r.name)
      setAcRate(String(r.effectivePrice))
      const unitMap: Record<string, string> = { per_kg: 'KG', per_pallet: 'PALLET', per_piece: 'PIECE', per_cbm: 'CBM', per_awb: 'AWB', per_uld: 'ULD', per_wr: 'WR', per_label: 'LABEL', flat: 'FLAT', per_day_pallet: 'DAY/PALLET' }
      setAcUnit(unitMap[r.unit] || r.unit.toUpperCase())
    }
  }

  async function handleSaveAddCharge() {
    if (!addChargeTarget) return
    const qty = parseFloat(acQty)
    const rate = parseFloat(acRate)
    if (!acDescription.trim()) { alert('Ingrese una descripcion'); return }
    if (isNaN(qty) || qty <= 0) { alert('Cantidad invalida'); return }
    if (isNaN(rate) || rate < 0) { alert('Tarifa invalida'); return }
    const amount = Math.round(qty * rate * 100) / 100
    setAcSaving(true)
    try {
      const ch = addChargeTarget.charges[0]
      await addDoc(collection(db, 'ws_billing_charges'), {
        so_id: addChargeTarget.so_id,
        so_number: addChargeTarget.so_number,
        client_id: ch?.client_id || addChargeClientId,
        client_name: ch?.client_name || '',
        service_type: 'manual',
        description: acDescription.trim(),
        amount,
        currency: 'USD',
        status: 'pending',
        rate_id: acRateId || null,
        qty,
        rate_price: rate,
        rate_unit: acUnit.toLowerCase(),
        detail: `${qty} ${acUnit} x $${rate}`,
        created_at: new Date().toISOString(),
        created_by: user?.email || 'manual',
      })
      setAddChargeTarget(null)
      await loadCharges()
    } catch (e) { alert('Error: ' + String(e)) }
    setAcSaving(false)
  }

  // ── Helper: build cargo data from SO + WR ──
  async function buildCargoForSO(order: WSServiceOrder): Promise<CargoData> {
    let wrData: WarehouseReceipt | null = null
    if (order.wr_id) {
      const wrSnap = await getDoc(doc(db, 'warehouse_receipts', order.wr_id))
      if (wrSnap.exists()) wrData = { id: wrSnap.id, ...wrSnap.data() } as WarehouseReceipt
    }
    const storageDays = order.received_at
      ? Math.max(1, Math.ceil((new Date(order.pod_at || order.completed_at || Date.now()).getTime() - new Date(order.received_at).getTime()) / 86400000))
      : 1
    // For breakdown_bup, billing uses CHW (received_weight_kg) from breakdown AWBs
    let weightKg = wrData?.total_weight_kg || order.declared_weight
    if (order.breakdown_awbs?.length) {
      const chwSum = order.breakdown_awbs.reduce((s, a) => s + (a.received_weight_kg || 0), 0)
      if (chwSum > 0) weightKg = chwSum
      else {
        const grossSum = order.breakdown_awbs.reduce((s, a) => s + (a.weight_kg || 0), 0)
        if (grossSum > 0) weightKg = grossSum
      }
    }
    return {
      pieces: wrData?.total_qty || order.declared_pieces,
      weight_kg: weightKg,
      pallets: wrData?.total_qty || order.declared_pieces,
      cbm: wrData?.total_cbm || 0,
      storageDays,
      hasAwb: !!order.awb_number,
      hasDg: (order.service_items || []).some(i => i.type === 'dg_inspection'),
      isSpecialCargo: order.cargo_type === 'SPECIAL',
    }
  }

  // ── Recalculate pending charges + generate missing charges ──
  async function handleRecalculate() {
    if (!confirm('Recalcular cargos pendientes y generar cargos faltantes de SOs completadas?')) return

    setRecalculating(true)
    let updated = 0
    let created = 0
    let errors = 0

    // ── Part 1: Recalculate existing pending charges ──
    const pendingCharges = charges.filter(c => c.status === 'pending')
    const bySO = new Map<string, WSCharge[]>()
    for (const ch of pendingCharges) {
      if (!bySO.has(ch.so_id)) bySO.set(ch.so_id, [])
      bySO.get(ch.so_id)!.push(ch)
    }

    for (const [soId, soCharges] of bySO) {
      try {
        const soSnap = await getDoc(doc(db, 'warehouse_service_orders', soId))
        if (!soSnap.exists()) { errors++; continue }
        const order = { id: soSnap.id, ...soSnap.data() } as WSServiceOrder
        const cargo = await buildCargoForSO(order)
        const posResults = await calculatePOSCharges(order, cargo)

        for (const ch of soCharges) {
          if (ch.service_type === 'transport') {
            // Try charge's do_id first, then SO's do_id, then query by so_id
            let doData: any = null
            const doIdToTry = ch.do_id || (order as any).do_id
            if (doIdToTry) {
              const doSnap = await getDoc(doc(db, 'ws_delivery_orders', doIdToTry))
              if (doSnap.exists()) doData = doSnap.data()
            }
            if (!doData) {
              const doQuery = await getDocs(query(collection(db, 'ws_delivery_orders'), where('so_id', '==', soId), limit(1)))
              if (!doQuery.empty) doData = doQuery.docs[0].data()
            }
            if (doData) {
              const result = await calculateTransportCharge(order, doData.transport_type || 'loose', doData.extra_stops || 0, doData.trucking_company || '', doData.driver_name || '')
              await updateDoc(doc(db, 'ws_billing_charges', ch.id), { amount: result.amount, description: result.description, rate_id: result.rate_id, qty: result.qty || null, rate_price: result.rate_price || null, rate_unit: result.rate_unit || null, detail: result.detail || null })
              updated++
            }
          } else {
            const match = posResults.find(r => r.service_type === ch.service_type)
            if (match) {
              await updateDoc(doc(db, 'ws_billing_charges', ch.id), { amount: match.amount, description: match.description, rate_id: match.rate_id, ...(match.storage_days != null ? { storage_days: match.storage_days } : {}), qty: match.qty || null, rate_price: match.rate_price || null, rate_unit: match.rate_unit || null, detail: match.detail || null })
              updated++
            }
          }
        }
      } catch (e) {
        console.error(`Error recalculating SO ${soId}:`, e)
        errors++
      }
    }

    // ── Part 2: Find completed/billed SOs that have missing charges ──
    try {
      const soSnap = await getDocs(query(collection(db, 'warehouse_service_orders'), where('global_status', 'in', ['completed', 'billed'])))
      const allChargesSnap = await getDocs(query(collection(db, 'ws_billing_charges')))
      const chargesBySO = new Map<string, Set<string>>()
      for (const d of allChargesSnap.docs) {
        const data = d.data()
        if (data.status === 'invalidated') continue
        if (!chargesBySO.has(data.so_id)) chargesBySO.set(data.so_id, new Set())
        chargesBySO.get(data.so_id)!.add(data.service_type)
      }

      for (const d of soSnap.docs) {
        const order = { id: d.id, ...d.data() } as WSServiceOrder
        const existingTypes = chargesBySO.get(order.id!) || new Set()

        const cargo = await buildCargoForSO(order)
        const now = new Date().toISOString()

        // Generate missing non-transport charges
        const posResults = await calculatePOSCharges(order, cargo)
        for (const ch of posResults) {
          if (!existingTypes.has(ch.service_type)) {
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
              created_by: 'system-recalc',
            })
            created++
          }
        }

        // Generate missing transport charge if SO has a completed DO
        if (!existingTypes.has('transport') && order.do_id) {
          try {
            const doSnap = await getDoc(doc(db, 'ws_delivery_orders', order.do_id))
            if (doSnap.exists()) {
              const doData = doSnap.data()
              const result = await calculateTransportCharge(order, doData.transport_type || 'loose', doData.extra_stops || 0, doData.trucking_company || '', doData.driver_name || '')
              await addDoc(collection(db, 'ws_billing_charges'), {
                so_id: order.id,
                so_number: order.so_number,
                client_id: order.client_id,
                client_name: order.client_name,
                service_type: 'transport',
                description: result.description,
                amount: result.amount,
                currency: 'USD',
                status: 'pending',
                rate_id: result.rate_id,
                qty: result.qty || null,
                rate_price: result.rate_price || null,
                rate_unit: result.rate_unit || null,
                detail: result.detail || null,
                do_id: order.do_id,
                do_number: order.do_number || doData.do_number || '',
                created_at: now,
                created_by: 'system-recalc',
              })
              created++
            }
          } catch (_) { /* skip */ }
        }
      }
    } catch (e) {
      console.error('Error generating missing charges:', e)
      errors++
    }

    setRecalculating(false)
    alert(`Recalculo completado:\n- ${updated} cargo(s) actualizados\n- ${created} cargo(s) nuevos generados\n- ${errors} error(es)`)
    await loadCharges()
  }

  // ── Toggle SO selection ──
  function toggleSO(soId: string) {
    setSelectedSOs(prev => {
      const next = new Set(prev)
      next.has(soId) ? next.delete(soId) : next.add(soId)
      return next
    })
  }

  function toggleAllClientSOs(soGroups: SOGroup[], allSelected: boolean) {
    setSelectedSOs(prev => {
      const next = new Set(prev)
      for (const g of soGroups) {
        const allPending = g.charges.every(c => c.status === 'pending')
        if (!allPending) continue
        if (allSelected) next.delete(g.so_id)
        else next.add(g.so_id)
      }
      return next
    })
  }

  // ── Generate invoices for selected SOs of a client ──
  async function handleInvoice(block: ClientBlock) {
    // Reentrance guard — useRef is synchronous, prevents race from rapid clicks
    if (invoicingRef.current) return
    invoicingRef.current = true
    setInvoicing(true)
    setSelectedSOs(new Set()) // Clear selection immediately to prevent re-click

    const selectedGroups = block.soGroups.filter(g => selectedSOs.has(g.so_id) && g.charges.every(c => c.status === 'pending'))
    if (selectedGroups.length === 0) {
      alert('Selecciona al menos una SO con cargos pendientes')
      invoicingRef.current = false
      setInvoicing(false)
      return
    }
    if (!confirm(`Generar ${selectedGroups.length} factura(s) para ${block.client_name}?\n\nCada SO genera una factura independiente.`)) {
      invoicingRef.current = false
      setInvoicing(false)
      return
    }

    let created = 0
    try {
      for (const soGroup of selectedGroups) {
        const seqRef = doc(db, 'config', 'ws_invoice_sequence')

        // Atomic transaction: verify charges are pending + get invoice number + create invoice + update charges
        // Firestore rule: ALL reads must happen BEFORE any write
        await runTransaction(db, async (tx) => {
          // ── READS (all reads first) ──
          const chargeRefs = soGroup.charges.map(c => doc(db, 'ws_billing_charges', c.id))
          const chargeDocs = await Promise.all(chargeRefs.map(r => tx.get(r)))
          const seqSnap = await tx.get(seqRef)
          const soRef = doc(db, 'warehouse_service_orders', soGroup.so_id)
          const soSnap = await tx.get(soRef)
          const clientRef = doc(db, 'warehouse_service_clients', block.client_id)
          let clientData: any = null
          try {
            const clientSnap = await tx.get(clientRef)
            if (clientSnap.exists()) clientData = clientSnap.data()
          } catch (_) { /* skip */ }

          // ── VALIDATE ──
          for (const cd of chargeDocs) {
            if (!cd.exists()) throw new Error(`Charge ${cd.id} no existe`)
            if (cd.data().status !== 'pending') {
              throw new Error(`Charge ${cd.id} ya no está pendiente (status: ${cd.data().status}). Posible factura duplicada evitada.`)
            }
          }

          // ── WRITES (all writes after reads) ──
          const last = seqSnap.exists() ? (seqSnap.data().last_num || 0) : 0
          const next = last + 1
          tx.set(seqRef, { last_num: next })
          const invoiceNumber = `WS-INV-${String(next).padStart(4, '0')}`

          const now = new Date().toISOString()
          const total = soGroup.charges.reduce((s, c) => s + c.amount, 0)
          const soData = soSnap.exists() ? soSnap.data() : null

          const invoiceRef = doc(collection(db, 'ws_invoices'))
          tx.set(invoiceRef, {
            invoice_number: invoiceNumber,
            so_id: soGroup.so_id,
            so_number: soGroup.so_number,
            client_id: block.client_id,
            client_name: block.client_name,
            client_address: clientData?.billing_address || clientData?.address || '',
            client_legal_name: clientData?.company_legal_name || block.client_name,
            awb_number: soData?.awb_number || null,
            wr_number: soData?.wr_number || null,
            cargo_type: soData?.cargo_type || null,
            cargo_mode: soData?.cargo_mode || null,
            reference: soData?.reference || null,
            received_at: soData?.received_at || null,
            completed_at: soData?.completed_at || soData?.pod_at || null,
            charges: soGroup.charges.map(c => ({
              id: c.id,
              service_type: c.service_type,
              description: c.description,
              amount: c.amount,
              storage_days: c.storage_days || null,
            })),
            charge_ids: soGroup.charges.map(c => c.id),
            subtotal: total,
            discount: 0,
            total,
            currency: 'USD',
            payment_terms: clientData?.payment_terms_label || 'Net 30',
            payment_terms_days: clientData?.payment_terms_days || 30,
            due_date: (() => {
              const serviceDate = soData?.completed_at || soData?.pod_at || soData?.received_at || now
              const d = new Date(serviceDate)
              d.setDate(d.getDate() + (clientData?.payment_terms_days || 30))
              return d.toISOString()
            })(),
            status: 'issued',
            issued_at: now,
            created_at: now,
            created_by: user?.email || 'system',
          })

          // 5. Update all charges to invoiced
          for (const chargeRef of chargeRefs) {
            tx.update(chargeRef, {
              status: 'invoiced',
              invoice_id: invoiceRef.id,
              invoice_number: invoiceNumber,
            })
          }

          // 6. Update SO status to billed
          if (soSnap.exists()) {
            tx.update(soRef, {
              global_status: 'billed',
              billed_at: now,
            })
          }
        })

        created++
      }
      alert(`${created} factura(s) generada(s) exitosamente`)
      await loadCharges()
    } catch (e) {
      console.error('Error generating invoices:', e)
      alert('Error: ' + String(e))
      await loadCharges() // Reload to show actual DB state
    } finally {
      invoicingRef.current = false
      setInvoicing(false)
    }
  }

  // ── Filtering ──
  const activeCharges = charges.filter(c => {
    if (filterStatus && c.status !== filterStatus) return false
    if (!filterStatus && c.status === 'invalidated') return false // hide invalidated by default
    if (filterClient && c.client_id !== filterClient) return false
    if (dateFrom && c.created_at < dateFrom) return false
    if (dateTo && c.created_at > dateTo + 'T23:59:59') return false
    if (search) {
      const s = search.toLowerCase()
      if (!c.so_number.toLowerCase().includes(s) && !c.client_name.toLowerCase().includes(s) && !c.description.toLowerCase().includes(s) && !(c.do_number || '').toLowerCase().includes(s)) return false
    }
    return true
  })

  // ── Build client blocks ──
  const clientMap = new Map<string, ClientBlock>()
  for (const c of activeCharges) {
    const key = c.client_id || 'unknown'
    if (!clientMap.has(key)) {
      clientMap.set(key, { client_id: key, client_name: c.client_name || 'Unknown', soGroups: [], total: 0, allPending: true })
    }
    const block = clientMap.get(key)!
    let soGroup = block.soGroups.find(g => g.so_id === c.so_id)
    if (!soGroup) {
      soGroup = { so_id: c.so_id, so_number: c.so_number, charges: [], total: 0 }
      block.soGroups.push(soGroup)
    }
    soGroup.charges.push(c)
    soGroup.total += c.amount
    block.total += c.amount
    if (c.status !== 'pending') block.allPending = false
  }

  const clientBlocks = [...clientMap.values()].sort((a, b) => a.client_name.localeCompare(b.client_name))
  const grandTotal = clientBlocks.reduce((s, b) => s + b.total, 0)

  // Client filter options
  const clientOptions = [...new Set(charges.map(c => c.client_name).filter(Boolean))].sort()
  const clientIdMap = new Map<string, string>()
  for (const c of charges) if (c.client_id && c.client_name) clientIdMap.set(c.client_name, c.client_id)

  if (!isAdmin && !isAccounting) {
    return (
      <Layout title="Billing Charges" backTo="/warehouse-services/admin">
        <p className="text-center text-gray-500 mt-10">Access restricted to Admin / Accounting</p>
      </Layout>
    )
  }

  return (
    <Layout title="WS Billing Charges" backTo="/warehouse-services/admin">
      <div className="max-w-6xl mx-auto space-y-4">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar SO, cliente, descripcion..."
            className="flex-1 min-w-[200px] border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
          />
          <select value={filterClient} onChange={e => setFilterClient(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
            <option value="">Todos los clientes</option>
            {clientOptions.map(name => <option key={name} value={clientIdMap.get(name) || ''}>{name}</option>)}
          </select>
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
            <option value="">Activos</option>
            <option value="pending">Pending</option>
            <option value="invoiced">Invoiced</option>
            <option value="paid">Paid</option>
            <option value="invalidated">Invalidated</option>
          </select>
          <div className="flex items-center gap-1 text-sm text-gray-500">
            Desde
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm" />
            Hasta
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm" />
          </div>
        </div>

        {/* Summary bar */}
        <div className="bg-[#0a1929] text-white rounded-xl px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <span className="text-sm">
              {clientBlocks.length} cliente{clientBlocks.length !== 1 ? 's' : ''} &middot; {activeCharges.length} cargo{activeCharges.length !== 1 ? 's' : ''}
            </span>
            <button
              onClick={handleRecalculate}
              disabled={recalculating}
              className="text-xs bg-amber-500 hover:bg-amber-600 text-white font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50 transition-colors"
            >
              {recalculating ? 'Recalculando...' : 'Recalcular / Generar Faltantes'}
            </button>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/warehouse-services')}
              className="text-xs bg-white/10 hover:bg-white/20 text-white font-semibold px-3 py-1.5 rounded-lg transition-colors"
            >
              Service Orders
            </button>
            <button
              onClick={() => navigate('/warehouse-services/billing/invoices')}
              className="text-xs bg-blue-500 hover:bg-blue-600 text-white font-semibold px-3 py-1.5 rounded-lg transition-colors"
            >
              Invoices
            </button>
            <span className="text-lg font-bold">Total: {fmtUSD(grandTotal)} USD</span>
          </div>
        </div>

        {loading ? (
          <p className="text-center text-gray-400 py-10">Loading...</p>
        ) : clientBlocks.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
            <p className="text-gray-400">No hay cargos registrados</p>
          </div>
        ) : (
          <div className="space-y-4">
            {clientBlocks.map(block => {
              const blockKey = block.client_id
              const isBlockExpanded = expanded.has(blockKey)

              return (
                <div key={blockKey} className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
                  {/* Client header */}
                  <div
                    className="px-5 py-3 flex items-center justify-between cursor-pointer hover:bg-gray-50 transition-colors"
                    onClick={() => toggleExpand(blockKey)}
                  >
                    <div className="flex items-center gap-3">
                      <span className="font-bold text-gray-800">{block.client_name}</span>
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${block.allPending ? 'bg-yellow-100 text-yellow-700' : 'bg-blue-100 text-blue-700'}`}>
                        {block.allPending ? 'PENDING' : 'MIXED'}
                      </span>
                      <span className="text-xs text-gray-400">{block.soGroups.length} SO{block.soGroups.length !== 1 ? 's' : ''}</span>
                    </div>
                    <div className="flex items-center gap-4">
                      {/* Facturar button — only when expanded and has selected SOs */}
                      {isBlockExpanded && block.soGroups.some(g => selectedSOs.has(g.so_id)) && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleInvoice(block) }}
                          disabled={invoicing}
                          className="text-xs bg-green-600 hover:bg-green-700 text-white font-semibold px-4 py-1.5 rounded-lg disabled:opacity-50 transition-colors"
                        >
                          {invoicing ? 'Generando...' : `Facturar (${block.soGroups.filter(g => selectedSOs.has(g.so_id)).length})`}
                        </button>
                      )}
                      <span className="text-lg font-bold text-green-700">{fmtUSD(block.total)}</span>
                      <svg className={`w-5 h-5 text-gray-400 transition-transform ${isBlockExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                  </div>

                  {/* SO groups inside client */}
                  {isBlockExpanded && (
                    <div className="border-t border-gray-100">
                      {/* Select all row */}
                      {block.soGroups.some(g => g.charges.every(c => c.status === 'pending')) && (
                        <div className="px-8 py-1.5 flex items-center gap-2 bg-gray-50/50 border-b border-gray-100">
                          <input
                            type="checkbox"
                            checked={block.soGroups.filter(g => g.charges.every(c => c.status === 'pending')).every(g => selectedSOs.has(g.so_id))}
                            onChange={() => {
                              const pendingGroups = block.soGroups.filter(g => g.charges.every(c => c.status === 'pending'))
                              const allSelected = pendingGroups.every(g => selectedSOs.has(g.so_id))
                              toggleAllClientSOs(block.soGroups, allSelected)
                            }}
                            className="w-4 h-4 rounded border-gray-300 text-mcl-blue focus:ring-mcl-blue/30"
                            onClick={(e) => e.stopPropagation()}
                          />
                          <span className="text-xs text-gray-400">Seleccionar todas las pendientes</span>
                        </div>
                      )}
                      {block.soGroups.map(soGroup => {
                        const soKey = `${blockKey}:${soGroup.so_id}`
                        const isSoExpanded = expanded.has(soKey)
                        const soAllPending = soGroup.charges.every(c => c.status === 'pending')

                        return (
                          <div key={soGroup.so_id} className="border-b border-gray-50 last:border-b-0">
                            {/* SO row */}
                            <div
                              className="px-8 py-2.5 flex items-center justify-between cursor-pointer hover:bg-gray-50 transition-colors"
                              onClick={() => toggleExpand(soKey)}
                            >
                              <div className="flex items-center gap-3">
                                {soAllPending && (
                                  <input
                                    type="checkbox"
                                    checked={selectedSOs.has(soGroup.so_id)}
                                    onChange={() => toggleSO(soGroup.so_id)}
                                    onClick={(e) => e.stopPropagation()}
                                    className="w-4 h-4 rounded border-gray-300 text-mcl-blue focus:ring-mcl-blue/30"
                                  />
                                )}
                                <span className="font-mono text-sm font-semibold text-mcl-blue">{soGroup.so_number}</span>
                                <span className="text-xs text-gray-400">{soGroup.charges.length} cargo{soGroup.charges.length !== 1 ? 's' : ''}</span>
                                {soGroup.charges.some(c => c.status === 'invoiced') && (
                                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">Invoiced</span>
                                )}
                              </div>
                              <div className="flex items-center gap-3">
                                <span className="font-semibold text-sm">{fmtUSD(soGroup.total)}</span>
                                <svg className={`w-4 h-4 text-gray-400 transition-transform ${isSoExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                </svg>
                              </div>
                            </div>

                            {/* Charge detail rows */}
                            {isSoExpanded && (
                              <div className="bg-gray-50/50">
                                <table className="w-full text-sm">
                                  <thead>
                                    <tr className="text-xs text-gray-400 uppercase">
                                      <th className="text-left pl-12 pr-2 py-1.5 font-medium">Servicio</th>
                                      <th className="text-left px-2 py-1.5 font-medium">Detalle</th>
                                      <th className="text-right px-2 py-1.5 font-medium">Monto</th>
                                      <th className="text-center px-2 py-1.5 font-medium">Status</th>
                                      <th className="text-center px-2 py-1.5 font-medium w-20">Acciones</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {soGroup.charges.map(ch => (
                                      <tr key={ch.id} className="border-t border-gray-100 hover:bg-white/80">
                                        <td className="pl-12 pr-2 py-2 font-medium text-gray-700">
                                          {SERVICE_LABELS[ch.service_type] || ch.service_type}
                                        </td>
                                        <td className="px-2 py-2 text-xs">
                                          {ch.detail ? (
                                            <span className="font-mono text-gray-700">{ch.detail}</span>
                                          ) : (
                                            <span className="text-gray-400">{ch.description}</span>
                                          )}
                                        </td>
                                        <td className="px-2 py-2 text-right font-mono font-semibold">{fmtUSD(ch.amount)}</td>
                                        <td className="px-2 py-2 text-center">
                                          <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[ch.status] || 'bg-gray-100 text-gray-600'}`}>
                                            {ch.status}
                                          </span>
                                        </td>
                                        <td className="px-2 py-2 text-center">
                                          {ch.status === 'pending' && (
                                            <div className="flex items-center justify-center gap-1">
                                              <button
                                                onClick={(e) => { e.stopPropagation(); setEditCharge(ch); setEditAmount(String(ch.amount)) }}
                                                className="text-gray-400 hover:text-mcl-blue p-1"
                                                title="Editar monto"
                                              >
                                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                                              </button>
                                              <button
                                                onClick={(e) => { e.stopPropagation(); handleDelete(ch) }}
                                                className="text-gray-400 hover:text-red-500 p-1"
                                                title="Eliminar"
                                              >
                                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                              </button>
                                            </div>
                                          )}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                                <div className="px-12 py-2 flex items-center gap-2">
                                  <button
                                    onClick={(e) => { e.stopPropagation(); openAddCharge(soGroup, block.client_id) }}
                                    className="text-xs bg-mcl-blue/10 hover:bg-mcl-blue/20 text-mcl-blue font-semibold px-3 py-1.5 rounded-lg transition-colors"
                                  >
                                    + Agregar Cargo
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Edit charge modal */}
      {editCharge && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => setEditCharge(null)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h3 className="font-bold text-gray-800">Editar Cargo</h3>
            <div>
              <p className="text-xs text-gray-400 mb-1">{editCharge.so_number} &mdash; {SERVICE_LABELS[editCharge.service_type] || editCharge.service_type}</p>
              <p className="text-sm text-gray-600 mb-3">{editCharge.description}</p>
              <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Monto (USD)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={editAmount}
                onChange={e => setEditAmount(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setEditCharge(null)} className="text-sm text-gray-500 hover:text-gray-700 px-4 py-2">Cancelar</button>
              <button onClick={handleSaveEdit} className="text-sm bg-mcl-blue hover:bg-blue-900 text-white font-semibold px-5 py-2 rounded-lg">Guardar</button>
            </div>
          </div>
        </div>
      )}

      {/* Add manual charge modal */}
      {addChargeTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => setAddChargeTarget(null)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
            <div>
              <h3 className="font-bold text-gray-800">Agregar Cargo Manual</h3>
              <p className="text-xs text-gray-400">{addChargeTarget.so_number}</p>
            </div>

            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Nombre del Cargo</label>
              <select
                value={acRateId}
                onChange={e => onSelectRate(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30 mb-2"
              >
                <option value="">Seleccionar del tarifario...</option>
                {rateOptions.map(r => (
                  <option key={r.id} value={r.id!}>{r.name} — ${r.effectivePrice}/{r.unit}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Descripcion</label>
              <input
                value={acDescription}
                onChange={e => setAcDescription(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                placeholder="Descripcion del cargo"
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Unidad</label>
                <select
                  value={acUnit}
                  onChange={e => setAcUnit(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                >
                  {['KG', 'PALLET', 'PIECE', 'CBM', 'AWB', 'ULD', 'WR', 'LABEL', 'FLAT', 'DAY/PALLET'].map(u => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Cantidad</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={acQty}
                  onChange={e => setAcQty(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-right font-mono focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Tarifa</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={acRate}
                  onChange={e => setAcRate(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-right font-mono focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                />
              </div>
            </div>

            {acQty && acRate && !isNaN(parseFloat(acQty)) && !isNaN(parseFloat(acRate)) && (
              <div className="text-right text-sm font-mono font-bold text-green-700">
                Total: {fmtUSD(Math.round(parseFloat(acQty) * parseFloat(acRate) * 100) / 100)}
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => setAddChargeTarget(null)} className="text-sm text-gray-500 hover:text-gray-700 px-4 py-2">Cancelar</button>
              <button
                onClick={handleSaveAddCharge}
                disabled={acSaving}
                className="text-sm bg-mcl-blue hover:bg-blue-900 text-white font-semibold px-5 py-2 rounded-lg disabled:opacity-50"
              >
                {acSaving ? 'Guardando...' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}
