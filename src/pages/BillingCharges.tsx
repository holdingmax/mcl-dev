import { useEffect, useState, useRef } from 'react'
import Layout from '../components/Layout'
import { db } from '../lib/firebase'
import { fmtNum, fmtUSD, formatWRDate } from '../lib/utils'
import { collection, getDocs, query, orderBy, where, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, limit } from 'firebase/firestore'
import { Dispatch, WarehouseReceipt, BillingProfile } from '../types'
import { useAuth } from '../contexts/AuthContext'
import html2pdf from 'html2pdf.js'

interface BillingCharge {
  id: string
  wr_id: string | null
  wr_number: string
  po_number: string
  dispatch_id?: string
  client_id: string | null
  client_name: string
  billing_event: string
  charge_name: string
  unit: string
  qty: number
  unit_price: number
  total: number
  currency: string
  cargo_type: string
  status: string
  created_at: string
}

const UNIT_LABELS: Record<string, string> = {
  per_cbm: '/ CBM', per_pallet: '/ Pallet', per_kg: '/ KG', flat: 'Fijo',
  per_day_pallet: '/ Pallet/Día', per_container: '/ Contenedor', per_bl: '/ BL',
  per_report: '/ Reporte', per_wr: '/ WR', per_lbs: '/ Lb', per_label: '/ Label',
}

interface InvoiceRecord {
  id: string
  invoice_number: string
  dispatch_id: string
  adjustment_kind: 'discount' | 'surcharge' | null
  adjustment_calc: 'percent' | 'amount' | null
  adjustment_value: number
  adjustment_amount: number
  adjustment_note: string
  subtotal: number
  total: number
  status: string
  date?: string
  due_date?: string
}

interface DispatchBlock {
  dispatch: Dispatch
  dispatchCharges: BillingCharge[]  // container-level charges
  wrGroups: WRChargeGroup[]
  total: number
}

interface WRChargeGroup {
  wr_id: string
  wr_number: string
  po_number: string
  client_name: string
  cargo_type: string
  reception_date: string
  destination: string
  charges: BillingCharge[]
  total: number
}

export default function BillingCharges() {
  const { gmailToken, refreshGmailToken, isClient, clientId, isBilling, canViewCharges } = useAuth()

  // Clients without can_view_charges permission are redirected
  if (isClient && !canViewCharges) {
    return (
      <Layout title="Cargos por WR" backTo="/sea">
        <div className="max-w-5xl mx-auto">
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-10 text-center text-gray-400">
            No tienes acceso a esta pantalla. Contacta al administrador.
          </div>
        </div>
      </Layout>
    )
  }
  const [dispatchBlocks, setDispatchBlocks] = useState<DispatchBlock[]>([])
  const [undispatchedGroups, setUndispatchedGroups] = useState<WRChargeGroup[]>([])
  const [billingProfiles, setBillingProfiles] = useState<(BillingProfile & { id: string })[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [filterClient, setFilterClient] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [generatingInvoice, setGeneratingInvoice] = useState<string | null>(null)
  const [sendingMail, setSendingMail] = useState<string | null>(null)
  // Invoice records indexed by dispatch_id
  const [invoiceMap, setInvoiceMap] = useState<Map<string, InvoiceRecord>>(new Map())
  // Hidden invoice ref for PDF generation
  const invoicePdfRef = useRef<HTMLDivElement>(null)
  const [pdfBlock, setPdfBlock] = useState<DispatchBlock | null>(null)
  // Adjustment modal (discount or surcharge)
  const [adjModal, setAdjModal] = useState<DispatchBlock | null>(null)
  const [adjEditing, setAdjEditing] = useState(false) // true = editing existing invoice
  const [adjKind, setAdjKind] = useState<'discount' | 'surcharge'>('discount')
  const [adjCalc, setAdjCalc] = useState<'percent' | 'amount'>('percent')
  const [adjValue, setAdjValue] = useState('')
  const [adjNote, setAdjNote] = useState('')
  // Edit charge modal
  const [editCharge, setEditCharge] = useState<BillingCharge | null>(null)
  const [editQty, setEditQty] = useState('')
  const [editPrice, setEditPrice] = useState('')

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    try {
      // Client users: filter charges and WRs by their client_id
      // For clients, skip orderBy to avoid needing composite indexes on billing_charges
      const chargesQuery = isClient && clientId
        ? query(collection(db, 'billing_charges'), where('client_id', '==', clientId), limit(2000))
        : query(collection(db, 'billing_charges'), orderBy('created_at', 'desc'), limit(2000))
      const wrsQuery = isClient && clientId
        ? query(collection(db, 'warehouse_receipts'), where('client_id', '==', clientId), orderBy('created_at', 'desc'), limit(1000))
        : query(collection(db, 'warehouse_receipts'), orderBy('created_at', 'desc'), limit(1000))
      const dispatchesQuery = isClient && clientId
        ? query(collection(db, 'dispatches'), where('client_ids', 'array-contains', clientId), orderBy('created_at', 'desc'), limit(1000))
        : query(collection(db, 'dispatches'), orderBy('created_at', 'desc'), limit(1000))

      const baseQueries: Promise<any>[] = [
        getDocs(chargesQuery),
        getDocs(dispatchesQuery),
        getDocs(wrsQuery),
      ]
      // Clients don't need billing profiles or invoices
      if (!isClient) {
        baseQueries.push(
          getDocs(query(collection(db, 'billing_profiles'), orderBy('client_name'), limit(500))),
          getDocs(query(collection(db, 'invoices'), limit(1000))),
        )
      }
      const results = await Promise.all(baseQueries)
      const [chargesSnap, dispatchesSnap, wrsSnap] = results
      const profilesSnap = !isClient ? results[3] : null
      const invoicesSnap = !isClient ? results[4] : null
      setBillingProfiles(profilesSnap ? profilesSnap.docs.map((d: any) => ({ ...d.data() as BillingProfile, id: d.id })) : [])

      // Build invoice map (dispatch_id → invoice)
      const invMap = new Map<string, InvoiceRecord>()
      for (const invDoc of (invoicesSnap ? invoicesSnap.docs : [])) {
        const data = invDoc.data()
        if (data.dispatch_id) {
          invMap.set(data.dispatch_id, {
            id: invDoc.id,
            invoice_number: data.invoice_number || '',
            dispatch_id: data.dispatch_id,
            adjustment_kind: data.adjustment_kind || null,
            adjustment_calc: data.adjustment_calc || null,
            adjustment_value: data.adjustment_value || 0,
            adjustment_amount: data.adjustment_amount || 0,
            adjustment_note: data.adjustment_note || '',
            subtotal: data.subtotal || 0,
            total: data.total || 0,
            status: data.status || 'generated',
            date: data.date || data.created_at || '',
            due_date: data.due_date || '',
          })
        }
      }
      setInvoiceMap(invMap)

      const charges = chargesSnap.docs.map(d => ({ id: d.id, ...d.data() })) as BillingCharge[]
      const dispatches = dispatchesSnap.docs.map(d => ({ id: d.id, ...d.data() })) as Dispatch[]
      const wrs = (wrsSnap.docs.map(d => ({ id: d.id, ...d.data() })) as WarehouseReceipt[])
        .filter(wr => wr.source !== 'warehouse_services')

      // WR lookup maps
      const wrMap = new Map<string, WarehouseReceipt>()
      for (const wr of wrs) if (wr.id) wrMap.set(wr.id, wr)

      // Backfill: MCL users fix charges with missing client_id
      if (!isClient) {
        const missingClientId = charges.filter(c => !c.client_id)
        if (missingClientId.length > 0) {
          // Build dispatch → primary client_id map (from WRs in each dispatch)
          const dispatchClientMap = new Map<string, string>()
          for (const d of dispatches) {
            if (!d.id) continue
            for (const wrId of (d.wr_ids || [])) {
              const wr = wrMap.get(wrId)
              if (wr?.client_id) {
                dispatchClientMap.set(d.id, wr.client_id)
                break
              }
            }
          }

          await Promise.all(missingClientId.map(async (c) => {
            try {
              let resolvedClientId: string | null = null
              if (c.wr_id) {
                // WR-level charge: get client_id from WR
                const wr = wrMap.get(c.wr_id)
                resolvedClientId = wr?.client_id || null
              } else if (c.dispatch_id) {
                // Dispatch-level charge (drayage, loading, etc): get from dispatch's WRs
                resolvedClientId = dispatchClientMap.get(c.dispatch_id) || null
              }
              if (resolvedClientId) {
                await updateDoc(doc(db, 'billing_charges', c.id), { client_id: resolvedClientId })
                c.client_id = resolvedClientId
              }
            } catch (e) { console.warn('backfill billing_charge client_id skip', c.id, e) }
          }))
        }
      }

      // Dispatch lookup
      const dispatchMap = new Map<string, Dispatch>()
      for (const d of dispatches) if (d.id) dispatchMap.set(d.id, d)

      // WR → dispatch mapping
      const wrToDispatch = new Map<string, string>()
      for (const d of dispatches) {
        for (const wrId of (d.wr_ids || [])) {
          wrToDispatch.set(wrId, d.id!)
        }
      }

      // Group charges by WR, and dispatch-level charges by dispatch_id
      const wrCharges = new Map<string, BillingCharge[]>()
      const dispatchLevelCharges = new Map<string, BillingCharge[]>()

      for (const c of charges) {
        if (c.wr_id) {
          if (!wrCharges.has(c.wr_id)) wrCharges.set(c.wr_id, [])
          wrCharges.get(c.wr_id)!.push(c)
        } else if (c.dispatch_id) {
          if (!dispatchLevelCharges.has(c.dispatch_id)) dispatchLevelCharges.set(c.dispatch_id, [])
          dispatchLevelCharges.get(c.dispatch_id)!.push(c)
        }
      }

      // Build WRChargeGroup helper
      function buildWRGroup(wrId: string, charges: BillingCharge[]): WRChargeGroup {
        const wr = wrMap.get(wrId)
        const first = charges[0]
        return {
          wr_id: wrId,
          wr_number: wr?.wr_number || first?.wr_number || '',
          po_number: wr?.po_number || first?.po_number || '',
          client_name: wr?.client_name || first?.client_name || '',
          cargo_type: first?.cargo_type || '',
          reception_date: wr?.created_at || first?.created_at || '',
          destination: wr?.to_port || '',
          charges,
          total: charges.reduce((s, c) => s + c.total, 0),
        }
      }

      // Build dispatch blocks
      const blocks: DispatchBlock[] = []
      const assignedWrIds = new Set<string>()

      for (const d of dispatches) {
        const dCharges = dispatchLevelCharges.get(d.id!) || []
        const groups: WRChargeGroup[] = []

        for (const wrId of (d.wr_ids || [])) {
          const wc = wrCharges.get(wrId)
          if (wc && wc.length > 0) {
            groups.push(buildWRGroup(wrId, wc))
            assignedWrIds.add(wrId)
          }
        }

        if (groups.length > 0 || dCharges.length > 0) {
          const total = groups.reduce((s, g) => s + g.total, 0) + dCharges.reduce((s, c) => s + c.total, 0)
          blocks.push({ dispatch: d, dispatchCharges: dCharges, wrGroups: groups, total })
        }
      }

      // Undispatched WRs with charges
      const undisp: WRChargeGroup[] = []
      for (const [wrId, wc] of wrCharges) {
        if (!assignedWrIds.has(wrId)) {
          undisp.push(buildWRGroup(wrId, wc))
        }
      }
      undisp.sort((a, b) => a.po_number.localeCompare(b.po_number))

      setDispatchBlocks(blocks)
      setUndispatchedGroups(undisp)
    } catch (e) { console.error(e) }
    setLoading(false)
  }

  // ── Delete a single charge ──
  async function handleDeleteCharge(charge: BillingCharge) {
    if (!confirm(`Eliminar cargo "${charge.charge_name}" (${fmtUSD(charge.total)})?\n\nEsta accion no se puede deshacer.`)) return
    try {
      await deleteDoc(doc(db, 'billing_charges', charge.id))
      await loadAll()
    } catch (e) {
      console.error(e)
      alert('Error eliminando cargo: ' + String(e))
    }
  }

  // ── Save edited charge ──
  async function handleSaveEditCharge() {
    if (!editCharge) return
    const qty = parseFloat(editQty)
    const price = parseFloat(editPrice)
    if (isNaN(qty) || isNaN(price) || qty < 0 || price < 0) { alert('Cantidad y precio deben ser numeros validos.'); return }
    try {
      await updateDoc(doc(db, 'billing_charges', editCharge.id), {
        qty,
        unit_price: price,
        total: qty * price,
      })
      setEditCharge(null)
      await loadAll()
    } catch (e) {
      console.error(e)
      alert('Error actualizando cargo: ' + String(e))
    }
  }

  // ── Void an invoice ──
  async function handleVoidInvoice(block: DispatchBlock) {
    const inv = invoiceMap.get(block.dispatch.id!)
    if (!inv) return
    if (!confirm(`Anular factura ${inv.invoice_number}?\n\nSe marcara como VOID y podras generar una nueva.`)) return
    try {
      await updateDoc(doc(db, 'invoices', inv.id), { status: 'voided', voided_at: new Date().toISOString() })
      await updateDoc(doc(db, 'dispatches', block.dispatch.id!), { billing_status: 'pending', invoice_id: null })
      setInvoiceMap(prev => {
        const next = new Map(prev)
        next.delete(block.dispatch.id!)
        return next
      })
    } catch (e) {
      console.error(e)
      alert('Error anulando factura: ' + String(e))
    }
  }

  function toggleExpand(key: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  // Filter helpers
  const allClients = new Set<string>()
  for (const b of dispatchBlocks) for (const g of b.wrGroups) if (g.client_name) allClients.add(g.client_name)
  for (const g of undispatchedGroups) if (g.client_name) allClients.add(g.client_name)
  const clientOptions = [...allClients].sort()

  function matchDateRange(dateStr: string | undefined): boolean {
    if (!dateFrom && !dateTo) return true
    if (!dateStr) return false
    const d = dateStr.slice(0, 10) // YYYY-MM-DD
    if (dateFrom && d < dateFrom) return false
    if (dateTo && d > dateTo) return false
    return true
  }

  function matchSearch(g: WRChargeGroup) {
    if (filterClient && g.client_name !== filterClient) return false
    if (!matchDateRange(g.reception_date)) return false
    if (search) {
      const s = search.toLowerCase()
      return g.po_number.toLowerCase().includes(s) || g.wr_number.toLowerCase().includes(s) || g.client_name.toLowerCase().includes(s)
    }
    return true
  }

  function matchDispatchSearch(b: DispatchBlock) {
    // Date filter on dispatch level
    if (dateFrom || dateTo) {
      const dispDate = b.dispatch.gate_out_at || b.dispatch.created_at
      if (!matchDateRange(dispDate)) return false
    }
    if (search) {
      const s = search.toLowerCase()
      if (b.dispatch.booking_number?.toLowerCase().includes(s) || b.dispatch.container_number?.toLowerCase().includes(s)) return true
    }
    return b.wrGroups.some(matchSearch) || (!search && !filterClient)
  }

  const filteredBlocks = dispatchBlocks.filter(matchDispatchSearch).map(b => ({
    ...b,
    wrGroups: b.wrGroups.filter(matchSearch),
  })).filter(b => b.wrGroups.length > 0 || b.dispatchCharges.length > 0)

  const filteredUndisp = undispatchedGroups.filter(matchSearch)

  const grandTotal = filteredBlocks.reduce((s, b) => s + b.wrGroups.reduce((s2, g) => s2 + g.total, 0) + b.dispatchCharges.reduce((s2, c) => s2 + c.total, 0), 0)
    + filteredUndisp.reduce((s, g) => s + g.total, 0)

  // ── Invoice helpers ─────────────────────────────────────────
  function findProfile(block: DispatchBlock): (BillingProfile & { id: string }) | null {
    const d = block.dispatch
    const clientName = d.client_names?.[0] || block.wrGroups[0]?.client_name || ''
    const dest = d.destinations?.[0] || block.wrGroups[0]?.destination || ''
    // Match by client name + destination
    return billingProfiles.find(p =>
      p.client_name === clientName && p.destinations.includes(dest) && p.active
    ) || billingProfiles.find(p =>
      p.client_name === clientName && p.active
    ) || null
  }

  async function getNextInvoiceNumber(): Promise<string> {
    const ref = doc(db, 'config', 'invoice_sequence')
    const snap = await getDoc(ref)
    const last = snap.exists() ? (snap.data().last_num || 0) : 0
    const next = last + 1
    await setDoc(ref, { last_num: next }, { merge: true })
    return `MCL-${String(next).padStart(7, '0')}`
  }

  function formatInvoiceDate(iso: string): string {
    const d = new Date(iso)
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${String(d.getFullYear()).slice(2)}`
  }

  function addDays(iso: string, days: number): string {
    const d = new Date(iso)
    d.setDate(d.getDate() + days)
    return d.toISOString()
  }

  async function handleGenerateInvoice(block: DispatchBlock, adjustment?: { kind: 'discount' | 'surcharge'; calc: 'percent' | 'amount'; value: number; note: string }, editing?: boolean) {
    const d = block.dispatch
    setGeneratingInvoice(d.id!)
    try {
      const profile = findProfile(block)
      const existingInv = invoiceMap.get(d.id!)
      const invoiceNum = editing && existingInv ? existingInv.invoice_number : await getNextInvoiceNumber()
      const now = new Date().toISOString()
      const dateStr = formatInvoiceDate(now)
      const dueDate = profile
        ? formatInvoiceDate(addDays(
            profile.payment_terms_from === 'service' ? (d.gate_out_at || now) : now,
            profile.payment_terms_days
          ))
        : formatInvoiceDate(addDays(now, 15))
      const terms = profile ? `N${profile.payment_terms_days}` : 'N15'
      const reference = `${d.naviera || ''} — ${d.container_number || ''}, MIA, ${(d.destinations || []).join('/')}, ${d.gate_out_at ? formatInvoiceDate(d.gate_out_at) : dateStr}`

      // Collect all charges
      const allCharges = [
        ...block.wrGroups.flatMap(g => g.charges),
        ...block.dispatchCharges,
      ]
      const subtotal = allCharges.reduce((s, c) => s + c.total, 0)

      // Calculate adjustment (discount or surcharge)
      let adjAmount = 0
      let adjLabel = ''
      let adjSign = 0 // -1 discount, +1 surcharge
      if (adjustment && adjustment.value > 0) {
        const raw = adjustment.calc === 'percent' ? subtotal * adjustment.value / 100 : adjustment.value
        if (adjustment.kind === 'discount') {
          adjAmount = raw
          adjSign = -1
          adjLabel = adjustment.calc === 'percent' ? `Descuento (${adjustment.value}%)` : 'Descuento'
        } else {
          adjAmount = raw
          adjSign = 1
          adjLabel = adjustment.calc === 'percent' ? `Sobre-cargo (${adjustment.value}%)` : 'Sobre-cargo'
        }
      }
      const total = subtotal + adjSign * adjAmount

      // Client data from profile or fallback
      const clientData = profile?.notify_to || d.client_names?.[0] || ''

      const invoiceData = {
        invoice_number: invoiceNum,
        dispatch_id: d.id,
        booking_number: d.booking_number || '',
        container_number: d.container_number || '',
        client_name: d.client_names?.[0] || '',
        profile_id: profile?.id || null,
        date: now,
        due_date: addDays(profile?.payment_terms_from === 'service' ? (d.gate_out_at || now) : now, profile?.payment_terms_days || 15),
        terms,
        subtotal,
        adjustment_kind: adjustment?.kind || null,
        adjustment_calc: adjustment?.calc || null,
        adjustment_value: adjustment?.value || 0,
        adjustment_amount: adjAmount,
        adjustment_note: adjustment?.note || '',
        tax: 0,
        total,
        status: 'generated',
      }

      // Save or update invoice record
      let invoiceDocId: string
      if (editing && existingInv) {
        await updateDoc(doc(db, 'invoices', existingInv.id), { ...invoiceData, updated_at: now })
        invoiceDocId = existingInv.id
      } else {
        const newRef = await addDoc(collection(db, 'invoices'), { ...invoiceData, created_at: now })
        invoiceDocId = newRef.id
      }

      // Update dispatch billing_status
      await updateDoc(doc(db, 'dispatches', d.id!), {
        billing_status: 'invoiced',
        invoice_id: invoiceDocId,
      })

      // Update local state
      setInvoiceMap(prev => {
        const next = new Map(prev)
        next.set(d.id!, {
          id: invoiceDocId,
          invoice_number: invoiceNum,
          dispatch_id: d.id!,
          adjustment_kind: adjustment?.kind || null,
          adjustment_calc: adjustment?.calc || null,
          adjustment_value: adjustment?.value || 0,
          adjustment_amount: adjAmount,
          adjustment_note: adjustment?.note || '',
          subtotal,
          total,
          status: 'generated',
          date: now,
          due_date: addDays(profile?.payment_terms_from === 'service' ? (d.gate_out_at || now) : now, profile?.payment_terms_days || 15),
        })
        return next
      })

      // Generate HTML using shared builder
      const html = buildInvoiceHtml({
        invoiceNum, dateStr, dueDate, terms, total, subtotal,
        clientData, reference, allCharges,
        adjAmount, adjSign, adjLabel, adjNote: adjustment?.note || '',
      })

      const win = window.open('', '_blank')
      if (win) {
        win.document.write(html)
        win.document.close()
        win.onload = () => win.print()
      }
    } catch (e) {
      console.error(e)
      alert('Error generando factura: ' + String(e))
    }
    setGeneratingInvoice(null)
  }

  function buildInvoiceHtml(p: {
    invoiceNum: string; dateStr: string; dueDate: string; terms: string;
    total: number; subtotal: number; clientData: string; reference: string;
    allCharges: BillingCharge[]; adjAmount: number; adjSign: number;
    adjLabel: string; adjNote: string;
  }) {
    const chargeRows = p.allCharges.map(c => `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:11px;">${c.charge_name}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:11px;text-align:right;">${c.qty % 1 === 0 ? c.qty : c.qty.toFixed(4)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:11px;text-align:center;">${UNIT_LABELS[c.unit] || c.unit}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:11px;text-align:right;">$${c.unit_price.toFixed(2)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:11px;text-align:right;font-weight:600;">$${c.total.toFixed(2)}</td>
      </tr>
    `).join('')

    return `<!DOCTYPE html><html><head><title>Invoice ${p.invoiceNum}</title>
<style>
  @page { size: letter; margin: 15mm; }
  body { font-family: Arial, Helvetica, sans-serif; color: #333; margin: 0; padding: 20px; }
  .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
  .logo-section { }
  .logo-img { height: 100px; margin: -10px 0; }
  .logo-subtitle { font-size: 10px; color: #666; margin-top: 2px; }
  .invoice-title { font-size: 32px; font-weight: 900; color: #e53e3e; text-align: right; }
  .info-grid { display: flex; justify-content: space-between; margin-bottom: 15px; }
  .client-box { background: #f7f7f7; border: 1px solid #ddd; border-radius: 4px; padding: 12px; width: 48%; white-space: pre-line; font-size: 11px; line-height: 1.5; }
  .invoice-meta { width: 48%; }
  .invoice-meta table { width: 100%; border-collapse: collapse; }
  .invoice-meta td { padding: 4px 8px; font-size: 11px; border: 1px solid #ddd; }
  .invoice-meta .label { font-weight: 700; background: #f7f7f7; width: 40%; }
  .charges-table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  .charges-table th { background: #e2e8f0; padding: 8px 10px; font-size: 10px; text-transform: uppercase; text-align: left; border-bottom: 2px solid #cbd5e0; }
  .charges-table th:nth-child(n+2) { text-align: right; }
  .charges-table th:nth-child(3) { text-align: center; }
  .totals { margin-top: 0; text-align: right; }
  .totals table { margin-left: auto; border-collapse: collapse; }
  .totals td { padding: 4px 12px; font-size: 12px; }
  .totals .grand { font-size: 14px; font-weight: 900; border-top: 2px solid #333; }
  .bank { margin-top: 20px; font-size: 9px; color: #666; line-height: 1.6; border-top: 1px solid #ddd; padding-top: 10px; }
  .bank strong { color: #333; }
  .ref-box { background: #fff; border: 1px solid #ddd; padding: 6px 10px; font-size: 11px; margin-bottom: 10px; }
  .ref-label { font-weight: 700; font-size: 10px; text-transform: uppercase; }
</style></head><body>
  <div class="header">
    <div class="logo-section">
      <img src="${window.location.origin}/logo.png" class="logo-img" alt="MinCurl Logistics" />
      <div class="logo-subtitle">2323 NW 82nd Ave, Doral, FL, 33122</div>
    </div>
    <div class="invoice-title">INVOICE</div>
  </div>

  <div class="info-grid">
    <div class="client-box">
      <div style="font-size:10px;font-weight:700;color:#e53e3e;margin-bottom:4px;">Datos del Cliente</div>
      ${p.clientData.replace(/\n/g, '<br>')}
    </div>
    <div class="invoice-meta">
      <table>
        <tr><td class="label">N° de Invoice</td><td>${p.invoiceNum}</td></tr>
        <tr><td class="label">DATE</td><td>${p.dateStr}</td></tr>
        <tr><td class="label">DUE DATE</td><td>${p.dueDate}</td></tr>
        <tr><td class="label">TERMS</td><td>${p.terms}</td></tr>
        <tr><td class="label">TOTAL</td><td style="font-weight:700;">$${p.total.toFixed(2)} USD</td></tr>
      </table>
    </div>
  </div>

  <div class="ref-box"><span class="ref-label">REFERENCE</span>&nbsp;&nbsp;${p.reference}${(() => {
    const pos = [...new Set(p.allCharges.map(c => c.po_number).filter(Boolean))]
    return pos.length > 0 ? `<div style="font-size:10px;color:#555;margin-top:3px;"><span style="font-weight:700;font-size:9px;">PO:</span>&nbsp;&nbsp;${pos.join(', ')}</div>` : ''
  })()}</div>

  <table class="charges-table">
    <thead>
      <tr><th>DESCRIPTION</th><th>QTY</th><th>UNIT</th><th>RATE</th><th>AMOUNT</th></tr>
    </thead>
    <tbody>${chargeRows}</tbody>
  </table>

  <div class="totals">
    <table>
      <tr><td>SubTotal</td><td>$${p.subtotal.toFixed(2)}</td></tr>
      ${p.adjAmount > 0 ? `<tr style="color:${p.adjSign < 0 ? '#e53e3e' : '#2f855a'};"><td>${p.adjLabel}${p.adjNote ? ` <span style="font-size:9px;color:#888;">— ${p.adjNote}</span>` : ''}</td><td>${p.adjSign < 0 ? '-' : '+'}$${p.adjAmount.toFixed(2)}</td></tr>` : ''}
      <tr><td>Tax</td><td>$0.00</td></tr>
      <tr class="grand"><td>TOTAL</td><td>$${p.total.toFixed(2)}</td></tr>
    </table>
  </div>

  <div class="bank">
    <strong>BANK DETAILS:</strong><br>
    Bank: Chase<br>
    Wire Transfer Routing Number: 021000021<br>
    ACH Routing Number: 267084131<br>
    Account Number: 671592700<br>
    International Wires / Swift code: CHASUS33<br>
    Name: MinCurl Logistics LLC
  </div>

  <div style="text-align:center;margin-top:15px;font-size:9px;color:#999;">ORIGINAL</div>
</body></html>`
  }

  // Rebuild invoice params from existing invoice record for email sending
  function getInvoiceParams(block: DispatchBlock, inv: InvoiceRecord) {
    const d = block.dispatch
    const profile = findProfile(block)
    const invoiceDate = inv.date || new Date().toISOString()
    const dateStr = formatInvoiceDate(invoiceDate)
    const dueDate = inv.due_date
      ? formatInvoiceDate(inv.due_date)
      : profile
        ? formatInvoiceDate(addDays(
            profile.payment_terms_from === 'service' ? (d.gate_out_at || invoiceDate) : invoiceDate,
            profile.payment_terms_days
          ))
        : formatInvoiceDate(addDays(invoiceDate, 15))
    const terms = profile ? `N${profile.payment_terms_days}` : 'N15'
    const reference = `${d.naviera || ''} — ${d.container_number || ''}, MIA, ${(d.destinations || []).join('/')}, ${d.gate_out_at ? formatInvoiceDate(d.gate_out_at) : dateStr}`
    const allCharges = [
      ...block.wrGroups.flatMap(g => g.charges),
      ...block.dispatchCharges,
    ]
    const subtotal = allCharges.reduce((s, c) => s + c.total, 0)
    const clientData = profile?.notify_to || d.client_names?.[0] || ''

    let adjAmount = inv.adjustment_amount || 0
    let adjSign = 0
    let adjLabel = ''
    if (adjAmount > 0 && inv.adjustment_kind) {
      if (inv.adjustment_kind === 'discount') {
        adjSign = -1
        adjLabel = inv.adjustment_calc === 'percent' && inv.adjustment_value ? `Descuento (${inv.adjustment_value}%)` : 'Descuento'
      } else {
        adjSign = 1
        adjLabel = inv.adjustment_calc === 'percent' && inv.adjustment_value ? `Sobre-cargo (${inv.adjustment_value}%)` : 'Sobre-cargo'
      }
    }
    const total = subtotal + adjSign * adjAmount

    return {
      invoiceNum: inv.invoice_number, dateStr, dueDate, terms, total, subtotal,
      clientData, reference, allCharges, adjAmount, adjSign, adjLabel,
      adjNote: inv.adjustment_note || '',
    }
  }

  function handleViewInvoice(block: DispatchBlock) {
    const inv = invoiceMap.get(block.dispatch.id!)
    if (!inv) return
    const p = getInvoiceParams(block, inv)
    const html = buildInvoiceHtml(p)
    const win = window.open('', '_blank')
    if (win) { win.document.write(html); win.document.close() }
  }

  function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve((reader.result as string).split(',')[1])
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  }

  async function generatePdfFromRef(): Promise<Blob> {
    const el = invoicePdfRef.current
    if (!el) throw new Error('Invoice element not ready')
    return html2pdf().set({
      margin: [8, 8],
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'mm', format: 'letter', orientation: 'portrait' },
    }).from(el).outputPdf('blob')
  }

  async function handleSendInvoice(block: DispatchBlock) {
    const d = block.dispatch
    const inv = invoiceMap.get(d.id!)
    if (!inv) { alert('Genera la factura primero.'); return }

    const profile = findProfile(block)
    if (!profile || profile.contacts.length === 0) {
      alert('No se encontró perfil de facturación con contactos para este consolidado. Configura el perfil primero.')
      return
    }
    const emails = profile.contacts.filter(c => c.active !== false).map(c => c.email).filter(Boolean)
    if (emails.length === 0) { alert('No hay emails de contacto configurados.'); return }
    if (!confirm(`Enviar factura ${inv.invoice_number} a:\n${emails.join('\n')}\n\nContinuar?`)) return

    setSendingMail(d.id!)
    try {
      // 1. Get Gmail token
      let token = gmailToken
      if (!token) token = await refreshGmailToken()
      if (!token) { alert('No se pudo autorizar Gmail. Permite los popups e intenta de nuevo. Si persiste, cierra sesión y entra con tu cuenta Google.'); setSendingMail(null); return }

      // 2. Render hidden invoice and wait for logo to load
      setPdfBlock(block)
      await new Promise(resolve => setTimeout(resolve, 800))

      // 3. Generate PDF from rendered DOM
      const pdfBlob = await generatePdfFromRef()
      const pdfBase64 = await blobToBase64(pdfBlob)
      setPdfBlock(null)

      // 4. Build MIME
      const params = getInvoiceParams(block, inv)
      const boundary = 'MCL_BOUNDARY_' + Date.now()
      const to = emails.join(', ')
      const subject = `Booking ${d.booking_number || ''} / ${d.container_number || ''} / ${(d.destinations || []).join('/')} - Invoice ${inv.invoice_number}`
      const bodyText = [
        'Estimado cliente,',
        '',
        `Adjunto encontrará la factura ${inv.invoice_number} correspondiente al consolidado:`,
        '',
        `Contenedor: ${d.container_number || ''}`,
        `Booking: ${d.booking_number || ''}`,
        `Destino: ${(d.destinations || []).join('/')}`,
        `Total: $${params.total.toFixed(2)} USD`,
        '',
        'Saludos cordiales,',
        'MinCurl Logistics LLC',
        '2323 NW 82nd Ave, Doral, FL, 33122',
      ].join('\r\n')

      const mimeMessage = [
        'MIME-Version: 1.0',
        `To: ${to}`,
        `Subject: ${subject}`,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 7bit',
        '',
        bodyText,
        '',
        `--${boundary}`,
        'Content-Type: application/pdf',
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${inv.invoice_number}.pdf"`,
        '',
        pdfBase64,
        '',
        `--${boundary}--`,
      ].join('\r\n')

      const raw = btoa(unescape(encodeURIComponent(mimeMessage)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

      // 5. Send
      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw }),
      })
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}))
        throw new Error(errBody?.error?.message || `Gmail API error ${res.status}`)
      }

      // 6. Update status
      await updateDoc(doc(db, 'invoices', inv.id), { status: 'sent', sent_at: new Date().toISOString() })
      setInvoiceMap(prev => {
        const next = new Map(prev)
        const existing = next.get(d.id!)
        if (existing) next.set(d.id!, { ...existing, status: 'sent' })
        return next
      })

      alert(`Factura ${inv.invoice_number} enviada a: ${emails.join(', ')}`)
    } catch (e) {
      console.error(e)
      setPdfBlock(null)
      alert('Error enviando mail: ' + String(e))
    }
    setSendingMail(null)
  }

  return (
    <Layout title="Cargos por WR" backTo={isClient ? "/sea" : "/billing"}>
      <div className="max-w-5xl mx-auto">

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3 mb-4 flex-wrap">
          <input type="text" placeholder="Buscar PO, WR, cliente, booking..."
            value={search} onChange={e => setSearch(e.target.value)}
            className="flex-1 min-w-[200px] border border-gray-200 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
          {!isClient && (
            <select value={filterClient} onChange={e => setFilterClient(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30">
              <option value="">Todos los clientes</option>
              {clientOptions.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 whitespace-nowrap">Desde</label>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
            <label className="text-xs text-gray-500 whitespace-nowrap">Hasta</label>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
            {(dateFrom || dateTo) && (
              <button onClick={() => { setDateFrom(''); setDateTo('') }}
                className="text-xs text-gray-400 hover:text-gray-600 px-1">Limpiar</button>
            )}
          </div>
        </div>

        {/* Summary */}
        {!loading && (filteredBlocks.length > 0 || filteredUndisp.length > 0) && (
          <div className="bg-mcl-blue text-white rounded-xl px-5 py-3 mb-4 flex items-center justify-between">
            <span className="text-sm">
              {filteredBlocks.length} consolidado{filteredBlocks.length !== 1 ? 's' : ''}
              {filteredUndisp.length > 0 && <> · {filteredUndisp.length} sin consolidación</>}
            </span>
            <span className="font-bold text-lg">Total: {fmtUSD(grandTotal)} USD</span>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center p-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" />
          </div>
        ) : filteredBlocks.length === 0 && filteredUndisp.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-10 text-center text-gray-400">
            {search || filterClient ? 'Sin resultados' : 'No hay cargos calculados aún.'}
          </div>
        ) : (
          <div className="space-y-4">

            {/* ── Dispatched blocks ── */}
            {filteredBlocks.map(block => {
              const d = block.dispatch
              const blockKey = `dispatch_${d.id}`
              const inv = invoiceMap.get(d.id!)
              const isInvoiced = !!inv
              return (
                <div key={d.id} className={`bg-white rounded-xl border shadow-sm overflow-hidden ${isInvoiced ? 'border-purple-200' : 'border-gray-200'}`}>
                  {/* Dispatch header — blue */}
                  <div className={`border-b px-5 py-3 flex items-center justify-between ${isInvoiced ? 'bg-purple-50 border-purple-100' : 'bg-blue-50 border-blue-100'}`}>
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="text-xs font-bold text-blue-800 uppercase">Consolidado</span>
                      <span className="font-mono font-semibold text-blue-700 text-sm">{d.booking_number || '—'}</span>
                      <span className="font-mono text-xs text-blue-600">{d.container_number} · {d.container_size}'</span>
                      {d.destinations?.map(dest => (
                        <span key={dest} className="text-xs bg-blue-100 text-blue-700 font-bold px-1.5 py-0.5 rounded">{dest}</span>
                      ))}
                      {d.status === 'gate_out' && (
                        <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-medium">Gate Out</span>
                      )}
                      {isInvoiced && (
                        <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded font-bold">
                          Facturado — {inv.invoice_number}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="font-bold text-blue-800 text-sm mr-2">{fmtUSD(isInvoiced ? inv.total : block.total)}</span>
                      {isInvoiced && (
                        <button
                          onClick={e => { e.stopPropagation(); handleViewInvoice(block) }}
                          className="text-xs bg-white text-gray-500 border border-gray-300 px-2.5 py-1 rounded-md hover:bg-gray-50 hover:text-gray-700 transition-colors flex items-center gap-1"
                          title="Ver factura"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                          </svg>
                          Ver Factura
                        </button>
                      )}
                      {!isClient && (<>
                      {isInvoiced ? (<>
                        <button
                          onClick={e => {
                            e.stopPropagation()
                            setAdjModal(block)
                            setAdjEditing(true)
                            setAdjKind(inv.adjustment_kind || 'discount')
                            setAdjCalc(inv.adjustment_calc || 'percent')
                            setAdjValue(inv.adjustment_value ? String(inv.adjustment_value) : '')
                            setAdjNote(inv.adjustment_note || '')
                          }}
                          disabled={generatingInvoice === d.id}
                          className="text-xs bg-white text-gray-500 border border-gray-300 px-2.5 py-1 rounded-md hover:bg-gray-50 hover:text-gray-700 transition-colors disabled:opacity-50 flex items-center gap-1"
                          title="Editar factura"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                          Editar
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); handleVoidInvoice(block) }}
                          className="text-xs bg-white text-gray-500 border border-gray-300 px-2.5 py-1 rounded-md hover:bg-gray-50 hover:text-gray-700 transition-colors flex items-center gap-1"
                          title="Anular factura"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                          </svg>
                          Anular
                        </button>
                      </>) : (
                        <button
                          onClick={e => { e.stopPropagation(); setAdjModal(block); setAdjEditing(false); setAdjKind('discount'); setAdjCalc('percent'); setAdjValue(''); setAdjNote('') }}
                          disabled={generatingInvoice === d.id}
                          className="text-xs bg-white text-gray-500 border border-gray-300 px-2.5 py-1 rounded-md hover:bg-gray-50 hover:text-gray-700 transition-colors disabled:opacity-50 flex items-center gap-1"
                          title="Generar factura PDF"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                          </svg>
                          {generatingInvoice === d.id ? 'Generando...' : 'Facturar'}
                        </button>
                      )}
                      <button
                        onClick={e => { e.stopPropagation(); handleSendInvoice(block) }}
                        disabled={sendingMail === d.id || !isInvoiced}
                        className={`text-xs px-2.5 py-1 rounded-md transition-colors disabled:opacity-50 flex items-center gap-1 ${isInvoiced ? 'bg-white text-gray-500 border border-gray-300 hover:bg-gray-50 hover:text-gray-700' : 'bg-gray-100 text-gray-400 border border-gray-200 cursor-not-allowed'}`}
                        title={isInvoiced ? 'Enviar factura por email' : 'Genera la factura primero'}
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                        </svg>
                        {sendingMail === d.id ? 'Enviando...' : 'Enviar'}
                      </button>
                      </>)}
                    </div>
                  </div>

                  {/* WR charge rows */}
                  {block.wrGroups.map(g => (
                    <div key={g.wr_id}>
                      <button onClick={() => toggleExpand(g.wr_id)}
                        className="w-full flex items-center justify-between px-5 py-3 hover:bg-gray-50 transition-colors text-left border-b border-gray-50">
                        <div className="flex items-center gap-3 flex-1 min-w-0 flex-wrap">
                          <span className="font-mono font-semibold text-gray-700 text-sm w-24 shrink-0">{g.po_number || '—'}</span>
                          <span className="font-mono text-xs text-mcl-blue w-20 shrink-0">{g.wr_number || '—'}</span>
                          <span className="text-xs text-gray-500 shrink-0">{g.reception_date ? formatWRDate(g.reception_date) : '—'}</span>
                          <span className="text-xs text-gray-500 shrink-0">{g.destination || '—'}</span>
                          <span className="text-xs text-gray-400 truncate">{g.client_name}</span>
                          <span className={`text-xs font-bold px-1.5 py-0.5 rounded shrink-0 ${g.cargo_type === 'BOND' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>
                            {g.cargo_type}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <span className="font-semibold text-gray-700 text-sm">{fmtUSD(g.total)}</span>
                          <svg className={`w-4 h-4 text-gray-400 transition-transform ${expanded.has(g.wr_id) ? 'rotate-180' : ''}`}
                            fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        </div>
                      </button>
                      {expanded.has(g.wr_id) && <ChargeTable charges={g.charges} total={g.total} onEdit={isClient ? undefined : c => { setEditCharge(c); setEditQty(String(c.qty)); setEditPrice(String(c.unit_price)) }} onDelete={isClient ? undefined : handleDeleteCharge} />}
                    </div>
                  ))}

                  {/* Dispatch-level charges — gray */}
                  {block.dispatchCharges.length > 0 && (
                    <div>
                      <button onClick={() => toggleExpand(blockKey)}
                        className="w-full flex items-center justify-between px-5 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-left border-b border-gray-100">
                        <div className="flex items-center gap-3">
                          <span className="text-xs font-bold text-gray-500 uppercase">Cargos Consolidado</span>
                          <span className="text-xs text-gray-400">{block.dispatchCharges.length} cargo{block.dispatchCharges.length !== 1 ? 's' : ''}</span>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <span className="font-semibold text-gray-600 text-sm">{fmtUSD(block.dispatchCharges.reduce((s, c) => s + c.total, 0))}</span>
                          <svg className={`w-4 h-4 text-gray-400 transition-transform ${expanded.has(blockKey) ? 'rotate-180' : ''}`}
                            fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        </div>
                      </button>
                      {expanded.has(blockKey) && <ChargeTable charges={block.dispatchCharges} total={block.dispatchCharges.reduce((s, c) => s + c.total, 0)} onEdit={isClient ? undefined : c => { setEditCharge(c); setEditQty(String(c.qty)); setEditPrice(String(c.unit_price)) }} onDelete={isClient ? undefined : handleDeleteCharge} />}
                    </div>
                  )}
                </div>
              )
            })}

            {/* ── Separator ── */}
            {filteredBlocks.length > 0 && filteredUndisp.length > 0 && (
              <div className="flex items-center gap-3 py-2">
                <div className="flex-1 border-t-2 border-gray-300" />
                <span className="text-xs font-bold text-gray-400 uppercase">Sin Consolidación</span>
                <div className="flex-1 border-t-2 border-gray-300" />
              </div>
            )}

            {/* ── Undispatched WRs ── */}
            {filteredUndisp.length > 0 && (
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                {filteredBlocks.length === 0 && (
                  <div className="bg-gray-50 border-b border-gray-200 px-5 py-2">
                    <span className="text-xs font-bold text-gray-400 uppercase">Sin Consolidación</span>
                  </div>
                )}
                {filteredUndisp.map(g => (
                  <div key={g.wr_id}>
                    <button onClick={() => toggleExpand(g.wr_id)}
                      className="w-full flex items-center justify-between px-5 py-3 hover:bg-gray-50 transition-colors text-left border-b border-gray-50">
                      <div className="flex items-center gap-3 flex-1 min-w-0 flex-wrap">
                        <span className="font-mono font-semibold text-gray-700 text-sm w-24 shrink-0">{g.po_number || '—'}</span>
                        <span className="font-mono text-xs text-mcl-blue w-20 shrink-0">{g.wr_number || '—'}</span>
                        <span className="text-xs text-gray-500 shrink-0">{g.reception_date ? formatWRDate(g.reception_date) : '—'}</span>
                        <span className="text-xs text-gray-500 shrink-0">{g.destination || '—'}</span>
                        <span className="text-xs text-gray-400 truncate">{g.client_name}</span>
                        <span className={`text-xs font-bold px-1.5 py-0.5 rounded shrink-0 ${g.cargo_type === 'BOND' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>
                          {g.cargo_type}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className="font-semibold text-gray-700 text-sm">{fmtUSD(g.total)}</span>
                        <svg className={`w-4 h-4 text-gray-400 transition-transform ${expanded.has(g.wr_id) ? 'rotate-180' : ''}`}
                          fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </div>
                    </button>
                    {expanded.has(g.wr_id) && <ChargeTable charges={g.charges} total={g.total} onEdit={isClient ? undefined : c => { setEditCharge(c); setEditQty(String(c.qty)); setEditPrice(String(c.unit_price)) }} onDelete={isClient ? undefined : handleDeleteCharge} />}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Adjustment Modal (Discount / Surcharge) ── */}
      {adjModal && (() => {
        const modalSubtotal = adjModal.wrGroups.reduce((s, g) => s + g.total, 0) + adjModal.dispatchCharges.reduce((s, c) => s + c.total, 0)
        const av = parseFloat(adjValue) || 0
        const previewAdj = adjCalc === 'percent' ? modalSubtotal * av / 100 : av
        const previewTotal = adjKind === 'discount' ? modalSubtotal - previewAdj : modalSubtotal + previewAdj
        return (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setAdjModal(null)}>
            <div className="bg-white rounded-xl shadow-xl w-full max-w-md" onClick={e => e.stopPropagation()}>
              <div className="px-6 py-4 border-b border-gray-100">
                <h3 className="font-bold text-gray-800">{adjEditing ? 'Editar Factura' : 'Generar Factura'}</h3>
                <p className="text-xs text-gray-400 mt-1">
                  {adjModal.dispatch.container_number} — {adjModal.dispatch.booking_number}
                  {adjEditing && invoiceMap.get(adjModal.dispatch.id!) && (
                    <span className="ml-2 text-purple-500 font-medium">{invoiceMap.get(adjModal.dispatch.id!)!.invoice_number}</span>
                  )}
                </p>
              </div>
              <div className="px-6 py-4 space-y-4">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600">Subtotal</span>
                  <span className="font-bold text-gray-800">{fmtUSD(modalSubtotal)} USD</span>
                </div>

                {/* Kind selector */}
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Tipo de ajuste (opcional)</label>
                  <div className="flex rounded-lg border border-gray-200 overflow-hidden">
                    <button onClick={() => setAdjKind('discount')}
                      className={`flex-1 py-2 text-sm font-medium transition-colors ${adjKind === 'discount' ? 'bg-red-50 text-red-700 border-r border-gray-200' : 'text-gray-500 hover:bg-gray-50 border-r border-gray-200'}`}>
                      Descuento
                    </button>
                    <button onClick={() => setAdjKind('surcharge')}
                      className={`flex-1 py-2 text-sm font-medium transition-colors ${adjKind === 'surcharge' ? 'bg-green-50 text-green-700' : 'text-gray-500 hover:bg-gray-50'}`}>
                      Sobre-cargo
                    </button>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Valor</label>
                  <div className="flex gap-2">
                    <select value={adjCalc} onChange={e => setAdjCalc(e.target.value as 'percent' | 'amount')}
                      className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30 w-28">
                      <option value="percent">%</option>
                      <option value="amount">$ Monto</option>
                    </select>
                    <input type="number" step="any" min="0" placeholder={adjCalc === 'percent' ? 'Ej: 10' : 'Ej: 150.00'}
                      value={adjValue} onChange={e => setAdjValue(e.target.value)}
                      className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
                  </div>
                </div>

                {av > 0 && (
                  <div>
                    <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Nota</label>
                    <input type="text" placeholder={adjKind === 'discount' ? 'Ej: Descuento por volumen, cortesía comercial...' : 'Ej: Cargo por almacenaje extendido, DG handling...'}
                      value={adjNote} onChange={e => setAdjNote(e.target.value)}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
                  </div>
                )}

                {av > 0 && (
                  <div className="bg-gray-50 rounded-lg p-3 space-y-1">
                    <div className="flex justify-between text-xs text-gray-500">
                      <span>{adjKind === 'discount' ? 'Descuento' : 'Sobre-cargo'}</span>
                      <span className={adjKind === 'discount' ? 'text-red-500' : 'text-green-600'}>
                        {adjKind === 'discount' ? '-' : '+'}{fmtUSD(previewAdj)}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm font-bold text-gray-800">
                      <span>Total</span>
                      <span>{fmtUSD(previewTotal)} USD</span>
                    </div>
                  </div>
                )}
              </div>
              <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
                <button onClick={() => setAdjModal(null)}
                  className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors">
                  Cancelar
                </button>
                <button
                  onClick={() => {
                    const val = parseFloat(adjValue) || 0
                    const adj = val > 0 ? { kind: adjKind, calc: adjCalc, value: val, note: adjNote } : undefined
                    const isEdit = adjEditing
                    setAdjModal(null)
                    handleGenerateInvoice(adjModal, adj, isEdit)
                  }}
                  disabled={generatingInvoice === adjModal.dispatch.id}
                  className={`text-white px-5 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 flex items-center gap-1.5 ${adjEditing ? 'bg-amber-500 hover:bg-amber-600' : 'bg-blue-600 hover:bg-blue-700'}`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={adjEditing
                      ? "M5 13l4 4L19 7"
                      : "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                    } />
                  </svg>
                  {adjEditing ? 'Guardar y Generar PDF' : 'Generar Factura'}
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* ── Edit Charge Modal ── */}
      {editCharge && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setEditCharge(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-gray-100">
              <h3 className="font-bold text-gray-800">Editar Cargo</h3>
              <p className="text-xs text-gray-400 mt-1">{editCharge.charge_name}</p>
            </div>
            <div className="px-6 py-4 space-y-3">
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Cantidad</label>
                <input type="number" step="any" min="0" value={editQty} onChange={e => setEditQty(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Precio Unitario</label>
                <input type="number" step="any" min="0" value={editPrice} onChange={e => setEditPrice(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
              </div>
              {(parseFloat(editQty) > 0 && parseFloat(editPrice) > 0) && (
                <div className="bg-gray-50 rounded-lg p-3 flex justify-between text-sm">
                  <span className="text-gray-600">Nuevo total</span>
                  <span className="font-bold text-gray-800">{fmtUSD(parseFloat(editQty) * parseFloat(editPrice))}</span>
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
              <button onClick={() => setEditCharge(null)} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">Cancelar</button>
              <button onClick={handleSaveEditCharge} className="bg-mcl-blue text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-700">Guardar</button>
            </div>
          </div>
        </div>
      )}

      {/* Hidden invoice for PDF generation */}
      {pdfBlock && (() => {
        const inv = invoiceMap.get(pdfBlock.dispatch.id!)
        if (!inv) return null
        const p = getInvoiceParams(pdfBlock, inv)
        return (
          <div style={{ position: 'fixed', left: '-9999px', top: 0, width: '210mm' }}>
            <div ref={invoicePdfRef} style={{ fontFamily: 'Arial, Helvetica, sans-serif', color: '#333', padding: '20px', background: '#fff' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                <div>
                  <img src="/logo.png" style={{ height: '100px', margin: '-10px 0' }} alt="MinCurl Logistics" crossOrigin="anonymous" />
                  <div style={{ fontSize: '10px', color: '#666', marginTop: '2px' }}>2323 NW 82nd Ave, Doral, FL, 33122</div>
                </div>
                <div style={{ fontSize: '32px', fontWeight: 900, color: '#e53e3e', textAlign: 'right' }}>INVOICE</div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '15px' }}>
                <div style={{ background: '#f7f7f7', border: '1px solid #ddd', borderRadius: '4px', padding: '12px', width: '48%', whiteSpace: 'pre-line', fontSize: '11px', lineHeight: 1.5 }}>
                  <div style={{ fontSize: '10px', fontWeight: 700, color: '#e53e3e', marginBottom: '4px' }}>Datos del Cliente</div>
                  {p.clientData}
                </div>
                <div style={{ width: '48%' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <tbody>
                      {[
                        ['N° de Invoice', p.invoiceNum],
                        ['DATE', p.dateStr],
                        ['DUE DATE', p.dueDate],
                        ['TERMS', p.terms],
                      ].map(([label, val]) => (
                        <tr key={label}>
                          <td style={{ padding: '4px 8px', fontSize: '11px', border: '1px solid #ddd', fontWeight: 700, background: '#f7f7f7', width: '40%' }}>{label}</td>
                          <td style={{ padding: '4px 8px', fontSize: '11px', border: '1px solid #ddd' }}>{val}</td>
                        </tr>
                      ))}
                      <tr>
                        <td style={{ padding: '4px 8px', fontSize: '11px', border: '1px solid #ddd', fontWeight: 700, background: '#f7f7f7', width: '40%' }}>TOTAL</td>
                        <td style={{ padding: '4px 8px', fontSize: '11px', border: '1px solid #ddd', fontWeight: 700 }}>${p.total.toFixed(2)} USD</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              <div style={{ background: '#fff', border: '1px solid #ddd', padding: '6px 10px', fontSize: '11px', marginBottom: '10px' }}>
                <span style={{ fontWeight: 700, fontSize: '10px', textTransform: 'uppercase' as const }}>REFERENCE</span>&nbsp;&nbsp;{p.reference}
                {(() => {
                  const pos = [...new Set(p.allCharges.map(c => c.po_number).filter(Boolean))]
                  return pos.length > 0 ? <div style={{ fontSize: '10px', color: '#555', marginTop: '3px' }}><span style={{ fontWeight: 700, fontSize: '9px' }}>PO:</span>&nbsp;&nbsp;{pos.join(', ')}</div> : null
                })()}
              </div>

              <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '10px' }}>
                <thead>
                  <tr>
                    {['DESCRIPTION', 'QTY', 'UNIT', 'RATE', 'AMOUNT'].map((h, i) => (
                      <th key={h} style={{ background: '#e2e8f0', padding: '8px 10px', fontSize: '10px', textTransform: 'uppercase' as const, textAlign: i === 0 ? 'left' : i === 2 ? 'center' : 'right', borderBottom: '2px solid #cbd5e0' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {p.allCharges.map((c, i) => (
                    <tr key={i}>
                      <td style={{ padding: '6px 10px', borderBottom: '1px solid #eee', fontSize: '11px' }}>{c.charge_name}</td>
                      <td style={{ padding: '6px 10px', borderBottom: '1px solid #eee', fontSize: '11px', textAlign: 'right' }}>{c.qty % 1 === 0 ? c.qty : c.qty.toFixed(4)}</td>
                      <td style={{ padding: '6px 10px', borderBottom: '1px solid #eee', fontSize: '11px', textAlign: 'center' }}>{UNIT_LABELS[c.unit] || c.unit}</td>
                      <td style={{ padding: '6px 10px', borderBottom: '1px solid #eee', fontSize: '11px', textAlign: 'right' }}>${c.unit_price.toFixed(2)}</td>
                      <td style={{ padding: '6px 10px', borderBottom: '1px solid #eee', fontSize: '11px', textAlign: 'right', fontWeight: 600 }}>${c.total.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div style={{ marginTop: 0, textAlign: 'right' }}>
                <table style={{ marginLeft: 'auto', borderCollapse: 'collapse' }}>
                  <tbody>
                    <tr><td style={{ padding: '4px 12px', fontSize: '12px' }}>SubTotal</td><td style={{ padding: '4px 12px', fontSize: '12px' }}>${p.subtotal.toFixed(2)}</td></tr>
                    {p.adjAmount > 0 && (
                      <tr style={{ color: p.adjSign < 0 ? '#e53e3e' : '#2f855a' }}>
                        <td style={{ padding: '4px 12px', fontSize: '12px' }}>{p.adjLabel}{p.adjNote ? <span style={{ fontSize: '9px', color: '#888' }}> — {p.adjNote}</span> : ''}</td>
                        <td style={{ padding: '4px 12px', fontSize: '12px' }}>{p.adjSign < 0 ? '-' : '+'}${p.adjAmount.toFixed(2)}</td>
                      </tr>
                    )}
                    <tr><td style={{ padding: '4px 12px', fontSize: '12px' }}>Tax</td><td style={{ padding: '4px 12px', fontSize: '12px' }}>$0.00</td></tr>
                    <tr><td style={{ padding: '4px 12px', fontSize: '14px', fontWeight: 900, borderTop: '2px solid #333' }}>TOTAL</td><td style={{ padding: '4px 12px', fontSize: '14px', fontWeight: 900, borderTop: '2px solid #333' }}>${p.total.toFixed(2)}</td></tr>
                  </tbody>
                </table>
              </div>

              <div style={{ marginTop: '20px', fontSize: '9px', color: '#666', lineHeight: 1.6, borderTop: '1px solid #ddd', paddingTop: '10px' }}>
                <strong style={{ color: '#333' }}>BANK DETAILS:</strong><br />
                Bank: Chase<br />
                Wire Transfer Routing Number: 021000021<br />
                ACH Routing Number: 267084131<br />
                Account Number: 671592700<br />
                International Wires / Swift code: CHASUS33<br />
                Name: MinCurl Logistics LLC
              </div>

              <div style={{ textAlign: 'center', marginTop: '15px', fontSize: '9px', color: '#999' }}>ORIGINAL</div>
            </div>
          </div>
        )
      })()}
    </Layout>
  )
}

function ChargeTable({ charges, total, onEdit, onDelete }: {
  charges: BillingCharge[]; total: number;
  onEdit?: (c: BillingCharge) => void; onDelete?: (c: BillingCharge) => void;
}) {
  return (
    <div className="border-t border-gray-100">
      <table className="w-full text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="text-left px-5 py-2 text-xs font-semibold text-gray-500 uppercase">Concepto</th>
            <th className="text-right px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Cantidad</th>
            <th className="text-right px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Precio Unit.</th>
            <th className="text-right px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Total</th>
            {(onEdit || onDelete) && <th className="px-3 py-2 w-20" />}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {charges.map(c => (
            <tr key={c.id} className="hover:bg-gray-50 group">
              <td className="px-5 py-2.5 text-gray-700">{c.charge_name}</td>
              <td className="px-4 py-2.5 text-right text-gray-500 font-mono text-xs">
                {c.qty % 1 === 0 ? c.qty : fmtNum(c.qty, 4)} {UNIT_LABELS[c.unit] ?? c.unit}
              </td>
              <td className="px-4 py-2.5 text-right text-gray-500 font-mono text-xs">{fmtUSD(c.unit_price)}</td>
              <td className="px-4 py-2.5 text-right font-semibold text-gray-800">
                {fmtUSD(c.total)} <span className="text-xs text-gray-400">{c.currency}</span>
              </td>
              {(onEdit || onDelete) && (
                <td className="px-3 py-2.5 text-right">
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-end gap-1">
                    {onEdit && (
                      <button onClick={() => onEdit(c)} className="p-1 text-amber-500 hover:text-amber-700 hover:bg-amber-50 rounded" title="Editar cargo">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                        </svg>
                      </button>
                    )}
                    {onDelete && (
                      <button onClick={() => onDelete(c)} className="p-1 text-red-400 hover:text-red-600 hover:bg-red-50 rounded" title="Eliminar cargo">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    )}
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-gray-50 border-t-2 border-gray-200">
          <tr>
            <td colSpan={onEdit || onDelete ? 4 : 3} className="px-5 py-2.5 text-xs font-bold text-gray-600 uppercase">Subtotal</td>
            <td className="px-5 py-2.5 text-right font-bold text-mcl-blue">{fmtUSD(total)} USD</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
