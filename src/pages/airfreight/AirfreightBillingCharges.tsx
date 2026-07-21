import { useEffect, useState, useRef, useMemo } from 'react'
import Layout from '../../components/Layout'
import { db, auth } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import {
  AirBillingCharge, AirfreightClient, AirInvoice,
  AirRateSchedule, AirfreightFlight, AirfreightBooking,
} from '../../types'
import {
  generateAirInvoice, addManualAirCharge, voidAirInvoice, unlockAirInvoice, resealAirInvoice, loadClient, dismissBillingReview, recalculateAutoCharges,
} from '../../lib/airBilling'
import { fmtNum, fmtUSD } from '../../lib/utils'
import {
  collection, getDocs, query, where, orderBy, doc, updateDoc, deleteDoc, limit,
} from 'firebase/firestore'
import html2pdf from 'html2pdf.js'
import { exportExpressLineExcel } from '../../lib/exportExpressLineInvoice'
import { httpsCallable, getFunctions } from 'firebase/functions'
import { getApp } from 'firebase/app'

// ── Types ──────────────────────────────────────────────────────────────────────

interface AwbRow {
  billing_unit_id: string
  awb_1st_leg: string | null
  awb_2nd_leg: string | null
  mawb_number: string | null
  cargo_type: string
  charges: AirBillingCharge[]
  total: number
}

interface FlightClientGroup {
  key: string
  flight_id: string
  client_id: string
  client_name: string
  airline: string
  flight_number: string
  flight: AirfreightFlight | null
  charges: AirBillingCharge[]
  awbRows: AwbRow[]
  chargeNames: string[]
  total: number
  invoice: AirInvoice | null
  profile: AirfreightClient | null
}

const STATUS_BADGE: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  invoiced: 'bg-blue-100 text-blue-700',
  generated: 'bg-blue-100 text-blue-700',
  sent: 'bg-green-100 text-green-700',
  paid: 'bg-green-100 text-green-700',
  voided: 'bg-red-100 text-red-700',
  draft: 'bg-gray-100 text-gray-600',
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function AirfreightBillingCharges() {
  const { isBilling, isClient, clientId, user, isAdmin, isAccounting, gmailToken, refreshGmailToken } = useAuth()

  // Data
  const [charges, setCharges] = useState<AirBillingCharge[]>([])
  const [invoices, setInvoices] = useState<AirInvoice[]>([])
  const [profiles, setProfiles] = useState<AirfreightClient[]>([])
  const [flights, setFlights] = useState<AirfreightFlight[]>([])
  const [rateSchedule, setRateSchedule] = useState<AirRateSchedule[]>([])
  const [bookings, setBookings] = useState<(AirfreightBooking & { id: string })[]>([])
  const [recalcFlags, setRecalcFlags] = useState<Set<string>>(new Set()) // keys: flight_id__client_id
  const [loading, setLoading] = useState(true)

  // Filters
  const [filterClient, setFilterClient] = useState('')
  const [filterFlight, setFilterFlight] = useState('')
  const [filterAwb, setFilterAwb] = useState('')
  const [filterStatus, setFilterStatus] = useState<'all' | 'pending' | 'invoiced'>('all')
  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')

  // UI
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [sendingMail, setSendingMail] = useState<string | null>(null)

  // Modals
  const [manualModal, setManualModal] = useState<FlightClientGroup | null>(null)
  const [manualAwb, setManualAwb] = useState('')
  const [manualRateName, setManualRateName] = useState('')
  const [manualDesc, setManualDesc] = useState('')
  const [manualUnit, setManualUnit] = useState('KG')
  const [manualQty, setManualQty] = useState('')
  const [manualRate, setManualRate] = useState('')

  const [editCharge, setEditCharge] = useState<AirBillingCharge | null>(null)
  const [editQty, setEditQty] = useState('')
  const [editRate, setEditRate] = useState('')
  const [editCw, setEditCw] = useState('')
  const [editUnit, setEditUnit] = useState('')

  // Invoice adjustment modal
  const [adjGroup, setAdjGroup] = useState<FlightClientGroup | null>(null)
  const [adjKind, setAdjKind] = useState<'discount' | 'surcharge' | ''>('')
  const [adjCalc, setAdjCalc] = useState<'percent' | 'amount'>('percent')
  const [adjValue, setAdjValue] = useState('')
  const [adjNote, setAdjNote] = useState('')
  const [invoiceNote, setInvoiceNote] = useState('')

  // CHW Verification
  const [chwVerified, setChwVerified] = useState<Record<string, { docChw: number | null; status: 'loading' | 'ok' | 'mismatch' | 'error' }>>({})
  const [chwEditing, setChwEditing] = useState<Record<string, string>>({}) // billing_unit_id → input value
  const [chwSaving, setChwSaving] = useState<string | null>(null)

  // PDF
  const [pdfGroup, setPdfGroup] = useState<FlightClientGroup | null>(null)
  const [pdfMawbLines, setPdfMawbLines] = useState<any[]>([])
  const invoicePdfRef = useRef<HTMLDivElement>(null)

  // Cross Check
  const [crossCheckLoading, setCrossCheckLoading] = useState(false)
  const [crossCheckReport, setCrossCheckReport] = useState<any>(null)
  const [crossCheckError, setCrossCheckError] = useState('')
  const [crossCheckExpanded, setCrossCheckExpanded] = useState<'noBilling' | 'billingNoInv' | 'flightMis' | 'awbMis' | null>('noBilling')

  // ── Data loading ─────────────────────────────────────────────────────────────

  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
    setLoading(true)
    try {
      const [chargesSnap, invoicesSnap, profilesSnap, flightsSnap, ratesSnap, bookingsSnap] = await Promise.all([
        getDocs(
          isClient && clientId
            ? query(collection(db, 'air_billing_charges'), where('client_id', '==', clientId), orderBy('created_at', 'desc'), limit(3000))
            : query(collection(db, 'air_billing_charges'), orderBy('created_at', 'desc'), limit(3000))
        ),
        getDocs(query(collection(db, 'air_invoices'), orderBy('created_at', 'desc'), limit(1000))),
        getDocs(collection(db, 'airfreight_clients')),
        getDocs(query(collection(db, 'airfreight_flights'), orderBy('flight_datetime', 'desc'), limit(500))),
        getDocs(collection(db, 'air_rate_schedule')),
        getDocs(query(collection(db, 'airfreight_bookings'), orderBy('created_at', 'desc'), limit(2000))),
      ])

      setCharges(chargesSnap.docs.map(d => ({ id: d.id, ...d.data() } as AirBillingCharge)))
      setInvoices(invoicesSnap.docs.map(d => ({ id: d.id, ...d.data() } as AirInvoice)))
      setProfiles(profilesSnap.docs.map(d => ({ id: d.id, ...d.data() } as AirfreightClient)))
      setFlights(flightsSnap.docs.map(d => ({ id: d.id, ...d.data() } as AirfreightFlight)))
      setRateSchedule(ratesSnap.docs.map(d => ({ id: d.id, ...d.data() } as AirRateSchedule)).filter(r => r.active))
      setBookings(bookingsSnap.docs.map(d => ({ id: d.id, ...d.data() } as AirfreightBooking & { id: string })))

      // Load recalc flags separately (collection may not exist yet)
      try {
        const recalcSnap = await getDocs(collection(db, 'air_billing_recalc_flags'))
        setRecalcFlags(new Set(recalcSnap.docs.map(d => d.id)))
      } catch { setRecalcFlags(new Set()) }
    } catch (e) {
      console.error('Error loading billing data', e)
    }
    setLoading(false)
  }

  // ── Grouped data ─────────────────────────────────────────────────────────────

  const flightMap = useMemo(() => {
    const m = new Map<string, AirfreightFlight>()
    flights.forEach(f => { if (f.id) m.set(f.id, f) })
    return m
  }, [flights])

  const invoiceMap = useMemo(() => {
    const m = new Map<string, AirInvoice>()
    invoices.forEach(inv => {
      const key = `${inv.flight_id}__${inv.client_id}`
      // Keep the most recent non-voided, or the latest one
      const existing = m.get(key)
      if (!existing || (existing.status === 'voided' && inv.status !== 'voided')) {
        m.set(key, inv)
      }
    })
    return m
  }, [invoices])

  const profileMap = useMemo(() => {
    const m = new Map<string, AirfreightClient>()
    profiles.forEach(p => {
      if (p.active && p.id) m.set(p.id, p)
    })
    return m
  }, [profiles])

  const bookingMap = useMemo(() => {
    const m = new Map<string, AirfreightBooking & { id: string }>()
    bookings.forEach(b => m.set(b.id, b))
    return m
  }, [bookings])

  // Get AWB doc URL for a billing row
  function getAwbDocUrl(row: AwbRow): string | null {
    const charge = row.charges[0]
    if (!charge) return null
    const booking = bookingMap.get(charge.booking_id)
    if (!booking) return null

    // MAWB: booking-level doc_mawb_def/draft
    if (booking.booking_type === 'mawb') {
      const doc = booking.documents?.doc_mawb_def || booking.documents?.doc_mawb_draft
      return doc?.url || null
    }
    // ecommerce / simple with awb_lines: try line-level doc_hawb first
    if (charge.awb_index != null && charge.awb_index >= 0 && booking.awb_lines?.[charge.awb_index]) {
      const line = booking.awb_lines[charge.awb_index]
      if (line.documents?.doc_hawb?.url) return line.documents.doc_hawb.url
    }
    // Fallback: booking-level doc_mawb_def/draft (simple bookings store AWB Final here)
    const mawbDoc = booking.documents?.doc_mawb_def || booking.documents?.doc_mawb_draft
    if (mawbDoc?.url) return mawbDoc.url
    // Last resort: booking-level doc_hawb
    return (booking.documents as any)?.doc_hawb?.url || null
  }

  const groups: FlightClientGroup[] = useMemo(() => {
    // Apply filters on charges
    let filtered = charges
    if (filterClient) filtered = filtered.filter(c => c.client_id === filterClient)
    if (filterFlight) filtered = filtered.filter(c => c.flight_id === filterFlight)
    if (filterAwb) {
      const q = filterAwb.toLowerCase().replace(/[^0-9a-z]/g, '')
      filtered = filtered.filter(c =>
        (c.awb_1st_leg || '').replace(/[^0-9a-z]/gi, '').toLowerCase().includes(q)
        || (c.awb_2nd_leg || '').replace(/[^0-9a-z]/gi, '').toLowerCase().includes(q)
        || (c.mawb_number || '').replace(/[^0-9a-z]/gi, '').toLowerCase().includes(q)
      )
    }
    if (filterStatus === 'pending') filtered = filtered.filter(c => c.status === 'pending')
    if (filterStatus === 'invoiced') filtered = filtered.filter(c => c.status === 'invoiced')
    if (filterDateFrom) filtered = filtered.filter(c => {
      const etd = flightMap.get(c.flight_id)?.flight_datetime || ''
      return etd >= filterDateFrom
    })
    if (filterDateTo) filtered = filtered.filter(c => {
      const etd = flightMap.get(c.flight_id)?.flight_datetime || ''
      return etd <= filterDateTo + 'T23:59:59'
    })

    // Group by flight_id + client_id
    const map = new Map<string, AirBillingCharge[]>()
    for (const c of filtered) {
      const key = `${c.flight_id}__${c.client_id}`
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(c)
    }

    const result: FlightClientGroup[] = []
    for (const [key, groupCharges] of map) {
      const first = groupCharges[0]
      const flight = flightMap.get(first.flight_id) || null
      const invoice = invoiceMap.get(key) || null
      const profile = profileMap.get(first.client_id) || null

      // Build AWB rows
      const awbMap = new Map<string, AirBillingCharge[]>()
      for (const c of groupCharges) {
        if (!awbMap.has(c.billing_unit_id)) awbMap.set(c.billing_unit_id, [])
        awbMap.get(c.billing_unit_id)!.push(c)
      }

      // Unique charge names across all charges in this group
      const chargeNamesSet = new Set<string>()
      groupCharges.forEach(c => chargeNamesSet.add(c.charge_name))
      const chargeNames = Array.from(chargeNamesSet).sort()

      const awbRows: AwbRow[] = []
      for (const [buid, bCharges] of awbMap) {
        const sample = bCharges[0]
        awbRows.push({
          billing_unit_id: buid,
          awb_1st_leg: sample.awb_1st_leg,
          awb_2nd_leg: sample.awb_2nd_leg,
          mawb_number: sample.mawb_number || null,
          cargo_type: sample.cargo_type,
          charges: bCharges,
          total: bCharges.reduce((s, c) => s + c.total, 0),
        })
      }

      result.push({
        key,
        flight_id: first.flight_id,
        client_id: first.client_id,
        client_name: first.client_name,
        airline: first.airline,
        flight_number: first.flight_number,
        flight,
        charges: groupCharges,
        awbRows,
        chargeNames,
        total: groupCharges.reduce((s, c) => s + c.total, 0),
        invoice,
        profile,
      })
    }

    // Sort by flight date desc
    result.sort((a, b) => {
      const da = a.flight?.flight_datetime || ''
      const db2 = b.flight?.flight_datetime || ''
      return db2.localeCompare(da)
    })

    return result
  }, [charges, flightMap, invoiceMap, profileMap, filterClient, filterFlight, filterAwb, filterStatus, filterDateFrom, filterDateTo])

  // ── Restore cached CHW verifications from bookings ──────────────────────────

  useEffect(() => {
    if (!groups.length || !bookingMap.size) return
    const cached: Record<string, { docChw: number | null; status: 'ok' | 'mismatch' }> = {}
    for (const g of groups) {
      for (const row of g.awbRows) {
        if (chwVerified[row.billing_unit_id]) continue // already verified this session
        const charge = row.charges[0]
        if (!charge) continue
        const booking = bookingMap.get(charge.booking_id)
        if (!booking) continue
        let verifiedChw: number | undefined
        if (charge.awb_index != null && charge.awb_index >= 0 && booking.awb_lines?.[charge.awb_index]) {
          verifiedChw = (booking.awb_lines[charge.awb_index] as any).verified_chw
        } else {
          verifiedChw = (booking as any).verified_chw
        }
        if (verifiedChw != null) {
          const billingChw = row.charges.find(c => c.unit === 'KG')?.qty || 0
          const match = Math.abs(verifiedChw - billingChw) <= 0.5
          cached[row.billing_unit_id] = { docChw: verifiedChw, status: match ? 'ok' : 'mismatch' }
        }
      }
    }
    if (Object.keys(cached).length > 0) {
      setChwVerified(prev => ({ ...cached, ...prev }))
    }
  }, [groups, bookingMap])

  // ── Unique client and flight lists for filters ───────────────────────────────

  const clientOptions = useMemo(() => {
    const m = new Map<string, string>()
    charges.forEach(c => m.set(c.client_id, c.client_name))
    return Array.from(m.entries()).sort((a, b) => a[1].localeCompare(b[1]))
  }, [charges])

  const flightOptions = useMemo(() => {
    const m = new Map<string, string>()
    charges.forEach(c => m.set(c.flight_id, `${c.airline} ${c.flight_number}`))
    return Array.from(m.entries()).sort((a, b) => a[1].localeCompare(b[1]))
  }, [charges])

  // ── Actions ──────────────────────────────────────────────────────────────────

  function getGroupStatus(g: FlightClientGroup): string {
    if (g.invoice) return g.invoice.status
    const allInvoiced = g.charges.every(c => c.status === 'invoiced')
    if (allInvoiced) return 'invoiced'
    return 'pending'
  }

  function handleGenerateInvoice(g: FlightClientGroup) {
    setAdjGroup(g)
    setAdjKind('')
    setAdjCalc('percent')
    setAdjValue('')
    setAdjNote('')
    setInvoiceNote('')
  }

  async function confirmGenerateInvoice() {
    if (!adjGroup) return
    const g = adjGroup
    setBusyAction(g.key)
    try {
      const adjustment = adjKind
        ? {
            kind: adjKind as 'discount' | 'surcharge',
            calc: adjCalc as 'percent' | 'amount',
            value: parseFloat(adjValue) || 0,
            note: adjNote,
          }
        : undefined
      await generateAirInvoice(g.client_id, g.flight_id, user?.email || '', adjustment, invoiceNote.trim() || undefined)
      setAdjGroup(null)
      await loadData()
    } catch (e) {
      console.error(e)
      alert('Error generando factura: ' + String(e))
    }
    setBusyAction(null)
  }

  async function handleUnlockInvoice(g: FlightClientGroup) {
    if (!g.invoice) return
    if (!confirm(`Desbloquear factura ${g.invoice.invoice_number} para editar cargos? Los cargos volveran a pendiente. El numero de factura se mantiene.`)) return
    setBusyAction(g.key)
    try {
      await unlockAirInvoice(g.invoice.id!)
      await loadData()
    } catch (e) {
      console.error(e)
      alert('Error desbloqueando factura: ' + String(e))
    }
    setBusyAction(null)
  }

  async function handleResealInvoice(g: FlightClientGroup) {
    if (!g.invoice || g.invoice.status !== 'draft') return
    if (!confirm(`Cerrar factura ${g.invoice.invoice_number} con los cargos actuales?`)) return
    setBusyAction(g.key)
    try {
      await resealAirInvoice(g.invoice.id!, g.client_id, g.flight_id, user?.email || '')
      await loadData()
    } catch (e) {
      console.error(e)
      alert('Error cerrando factura: ' + String(e))
    }
    setBusyAction(null)
  }

  async function handleVoidInvoice(g: FlightClientGroup) {
    if (!g.invoice) return
    if (!confirm(`Anular factura ${g.invoice.invoice_number}? Los cargos volveran a estado pendiente.`)) return
    setBusyAction(g.key)
    try {
      await voidAirInvoice(g.invoice.id!)
      await loadData()
    } catch (e) {
      console.error(e)
      alert('Error anulando factura: ' + String(e))
    }
    setBusyAction(null)
  }

  // ── Manual charge ────────────────────────────────────────────────────────────

  function openManualModal(g: FlightClientGroup) {
    setManualModal(g)
    setManualAwb(g.awbRows[0]?.billing_unit_id || '')
    setManualRateName('')
    setManualDesc('')
    setManualUnit('KG')
    setManualQty('')
    setManualRate('')
  }

  async function handleSaveManualCharge() {
    if (!manualModal) return
    const g = manualModal
    const awbRow = g.awbRows.find(r => r.billing_unit_id === manualAwb)
    if (!awbRow) { alert('Selecciona un AWB.'); return }
    const qtyVal = parseFloat(manualQty)
    const rateVal = parseFloat(manualRate)
    if (!manualRateName || isNaN(qtyVal) || isNaN(rateVal) || qtyVal <= 0 || rateVal <= 0) {
      alert('Completa todos los campos correctamente.')
      return
    }

    setBusyAction('manual')
    try {
      // Find the matching booking charge to get booking info
      const sample = awbRow.charges[0]
      const bookingSnap = await getDocs(
        query(collection(db, 'airfreight_bookings'), where('__name__', '==', sample.booking_id))
      )
      const booking = bookingSnap.empty ? null : { id: bookingSnap.docs[0].id, ...bookingSnap.docs[0].data() } as any

      if (!booking) { alert('No se encontro el booking asociado.'); return }

      // Determine awb index
      const awbIndex = sample.awb_index
      let awbLine = null
      if (awbIndex !== null && booking.awb_lines) {
        awbLine = booking.awb_lines[awbIndex] || null
      }

      await addManualAirCharge({
        booking,
        awbLine,
        awbIndex,
        scope: awbIndex !== null ? 'awb' : 'flight',
        serviceName: manualRateName,
        qty: qtyVal,
        userEmail: user?.email || '',
        rateSchedules: rateSchedule,
      })
      setManualModal(null)
      await loadData()
    } catch (e) {
      console.error(e)
      alert('Error agregando cargo: ' + String(e))
    }
    setBusyAction(null)
  }

  // ── Edit charge ──────────────────────────────────────────────────────────────

  function openEditCharge(c: AirBillingCharge) {
    if (c.status !== 'pending' || !isBilling) return
    setEditCharge(c)
    setEditQty(String(c.qty))
    setEditRate(String(c.rate))
    setEditCw(String(c.chargeable_weight || ''))
    setEditUnit(c.unit || '')
  }

  async function handleSaveEditCharge() {
    if (!editCharge) return
    const qtyVal = parseFloat(editQty)
    const rateVal = parseFloat(editRate)
    if (isNaN(qtyVal) || isNaN(rateVal)) return
    setBusyAction('edit')
    try {
      const updates: Record<string, unknown> = {
        qty: qtyVal,
        rate: rateVal,
        total: qtyVal * rateVal,
      }
      if (editUnit) updates.unit = editUnit
      const cwVal = parseFloat(editCw)
      if (!isNaN(cwVal)) updates.chargeable_weight = cwVal
      await updateDoc(doc(db, 'air_billing_charges', editCharge.id!), updates)
      setEditCharge(null)
      await loadData()
    } catch (e) {
      console.error(e)
      alert('Error editando cargo: ' + String(e))
    }
    setBusyAction(null)
  }

  async function handleDeleteCharge(c: AirBillingCharge) {
    if (c.status !== 'pending' || !isBilling) return
    if (!confirm(`Eliminar cargo "${c.charge_name}" de ${fmtUSD(c.total)}?`)) return
    setBusyAction('delete')
    try {
      await deleteDoc(doc(db, 'air_billing_charges', c.id!))
      await loadData()
    } catch (e) {
      console.error(e)
      alert('Error eliminando cargo: ' + String(e))
    }
    setBusyAction(null)
  }

  async function handleRecalculate(g: FlightClientGroup) {
    if (!confirm(`Recalcular cargos automáticos para ${g.client_name}?\nEsto eliminará los auto-charges pendientes y los regenerará con las tarifas actuales del cliente.`)) return
    setBusyAction(g.key + '_recalc')
    try {
      const count = await recalculateAutoCharges(g.flight_id, g.client_id, user?.email || '')
      // Clear recalc flag if exists
      if (recalcFlags.has(g.key)) {
        try { await deleteDoc(doc(db, 'air_billing_recalc_flags', g.key)) } catch {}
        setRecalcFlags(prev => { const n = new Set(prev); n.delete(g.key); return n })
      }
      await loadData()
      alert(`Cargos recalculados: ${count} AWB(s) procesadas`)
    } catch (e) {
      console.error(e)
      alert('Error recalculando: ' + String(e))
    }
    setBusyAction(null)
  }

  // ── PDF generation ───────────────────────────────────────────────────────────

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
      margin: 10,
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'mm', format: 'letter', orientation: 'portrait' },
    }).from(el).outputPdf('blob')
  }

  async function handleDownloadPdf(g: FlightClientGroup) {
    if (!g.invoice) return
    setBusyAction(g.key)

    // Load individual AWB lines for MAWB bookings (for PDF page 2 detail)
    try {
      const bSnap = await getDocs(
        query(collection(db, 'airfreight_bookings'), where('flight_id', '==', g.flight_id), where('client_id', '==', g.client_id))
      )
      const lines: any[] = []
      for (const bDoc of bSnap.docs) {
        const bData = bDoc.data()
        const awbLines = (bData.awb_lines || []) as any[]
        for (const line of awbLines) {
          lines.push({
            agent: g.client_name,
            flight: `${g.airline} ${g.flight_number}`,
            awb_number: line.awb_2nd_leg || line.awb_number || '-',
            pieces: line.pieces || 0,
            weight: line.chargeable_weight || line.weight || 0,
            date: g.flight?.flight_datetime?.slice(0, 10) || g.invoice?.date || '',
            mawb_number: bData.mawb_number || null,
          })
        }
      }
      setPdfMawbLines(lines)
    } catch (e) {
      console.error('Error loading AWB lines for PDF:', e)
      setPdfMawbLines([])
    }

    setPdfGroup(g)
    await new Promise(r => setTimeout(r, 800))
    try {
      const el = invoicePdfRef.current
      if (!el) throw new Error('PDF element not ready')
      await html2pdf().set({
        margin: 10,
        filename: `Invoice_${g.invoice.invoice_number}.pdf`,
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'mm', format: 'letter', orientation: 'portrait' },
      }).from(el).save()
    } catch (e) {
      console.error(e)
      alert('Error generando PDF: ' + String(e))
    }
    setPdfGroup(null)
    setBusyAction(null)
  }

  // ── Send email ───────────────────────────────────────────────────────────────

  async function handleSendEmail(g: FlightClientGroup) {
    if (!g.invoice) { alert('Genera la factura primero.'); return }
    const profile = g.profile
    const billingContacts = profile?.billing?.billing_contacts || profile?.contacts || []
    if (!profile || billingContacts.length === 0) {
      alert('No se encontraron contactos de facturacion. Configura los contactos del cliente primero.')
      return
    }
    const emails = billingContacts.map(c => c.email).filter(Boolean)
    if (emails.length === 0) { alert('No hay emails de contacto configurados.'); return }
    if (!confirm(`Enviar factura ${g.invoice.invoice_number} a:\n${emails.join('\n')}\n\nContinuar?`)) return

    setSendingMail(g.key)
    try {
      let token = gmailToken
      if (!token) token = await refreshGmailToken()
      if (!token) {
        alert('No se pudo autorizar Gmail. Permite los popups e intenta de nuevo.')
        setSendingMail(null)
        return
      }

      // Load AWB lines for PDF page 2
      try {
        const bSnap = await getDocs(
          query(collection(db, 'airfreight_bookings'), where('flight_id', '==', g.flight_id), where('client_id', '==', g.client_id))
        )
        const mLines: any[] = []
        for (const bDoc of bSnap.docs) {
          const bData = bDoc.data()
          for (const line of (bData.awb_lines || []) as any[]) {
            mLines.push({
              agent: g.client_name,
              flight: `${g.airline} ${g.flight_number}`,
              awb_number: line.awb_2nd_leg || line.awb_number || '-',
              pieces: line.pieces || 0,
              weight: line.chargeable_weight || line.weight || 0,
              date: g.flight?.flight_datetime?.slice(0, 10) || g.invoice?.date || '',
              mawb_number: bData.mawb_number || null,
            })
          }
        }
        setPdfMawbLines(mLines)
      } catch (_e) { setPdfMawbLines([]) }

      // Render hidden invoice
      setPdfGroup(g)
      await new Promise(r => setTimeout(r, 800))

      const pdfBlob = await generatePdfFromRef()
      const pdfBase64 = await blobToBase64(pdfBlob)
      setPdfGroup(null)

      // Build MIME
      const inv = g.invoice!
      const boundary = 'MCL_BOUNDARY_' + Date.now()
      const to = emails.join(', ')
      const subject = `Invoice ${inv.invoice_number} - MinCurl Logistics`
      const bodyText = [
        'Dear customer,',
        '',
        `Please find attached invoice ${inv.invoice_number}.`,
        '',
        `Flight: ${g.airline} ${g.flight_number}`,
        `Reference: ${inv.reference}`,
        `Total: $${inv.total.toFixed(2)} USD`,
        '',
        'Best regards,',
        'MinCurl Logistics Corp',
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

      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw }),
      })
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}))
        throw new Error(errBody?.error?.message || `Gmail API error ${res.status}`)
      }

      // Update status
      await updateDoc(doc(db, 'air_invoices', inv.id!), { status: 'sent', sent_at: new Date().toISOString() })
      await loadData()
      alert(`Factura ${inv.invoice_number} enviada a: ${emails.join(', ')}`)
    } catch (e) {
      console.error(e)
      setPdfGroup(null)
      alert('Error enviando mail: ' + String(e))
    }
    setSendingMail(null)
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function getCw(row: AwbRow): number {
    // Sum qty from per_kg charges to infer CW, or use the first charge's qty
    const kgCharge = row.charges.find(c => c.unit === 'KG')
    return kgCharge ? kgCharge.qty : 0
  }

  // ── CHW Verification ────────────────────────────────────────────────────────

  async function verifyRowChw(row: AwbRow, weightType?: 'chw' | 'gross') {
    const docUrl = getAwbDocUrl(row)
    if (!docUrl) return
    const charge = row.charges[0]
    if (!charge) return

    const key = row.billing_unit_id
    setChwVerified(prev => ({ ...prev, [key]: { docChw: null, status: 'loading' } }))

    try {
      const token = await auth.currentUser?.getIdToken()
      if (!token) throw new Error('Not authenticated')
      const resp = await fetch('/api/verifyAwbChw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          pdfUrl: docUrl,
          bookingId: charge.booking_id,
          awbIndex: charge.awb_index,
          weightType: weightType || 'chw',
        }),
      })
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}))
        throw new Error(errData.error || `HTTP ${resp.status}`)
      }
      const data = await resp.json() as { chw: number | null; cached: boolean }
      const billingChw = getCw(row)
      if (data.chw == null) {
        setChwVerified(prev => ({ ...prev, [key]: { docChw: null, status: 'error' } }))
      } else {
        const tolerance = 0.5
        const match = Math.abs(data.chw - billingChw) <= tolerance
        setChwVerified(prev => ({ ...prev, [key]: { docChw: data.chw, status: match ? 'ok' : 'mismatch' } }))
      }
    } catch (err: any) {
      console.error('CHW verify error:', err)
      setChwVerified(prev => ({ ...prev, [key]: { docChw: null, status: 'error' } }))
    }
  }

  async function verifyGroupChw(g: FlightClientGroup) {
    const wt = g.profile?.billing?.billing_weight_source === 'gross' ? 'gross' : 'chw'
    const rowsWithDoc = g.awbRows.filter(r => getAwbDocUrl(r) != null)
    for (const row of rowsWithDoc) {
      if (chwVerified[row.billing_unit_id]?.status === 'ok' || chwVerified[row.billing_unit_id]?.status === 'mismatch') continue
      await verifyRowChw(row, wt)
    }
  }

  // Save corrected weight: sync booking + all billing charges for this AWB
  async function saveCorrectChw(row: AwbRow, newChwStr: string, useGross?: boolean) {
    const newChw = parseFloat(newChwStr)
    if (isNaN(newChw) || newChw <= 0) return
    const charge = row.charges[0]
    if (!charge) return
    const key = row.billing_unit_id
    const weightField = useGross ? 'weight' : 'chargeable_weight'
    setChwSaving(key)
    try {
      const booking = bookingMap.get(charge.booking_id)
      // 1. Update booking weight field
      if (booking) {
        if (charge.awb_index != null && charge.awb_index >= 0 && booking.awb_lines?.[charge.awb_index]) {
          const lines = [...booking.awb_lines]
          lines[charge.awb_index] = { ...lines[charge.awb_index], [weightField]: newChw }
          await updateDoc(doc(db, 'airfreight_bookings', charge.booking_id), { awb_lines: lines })
        } else {
          await updateDoc(doc(db, 'airfreight_bookings', charge.booking_id), { [weightField]: newChw })
        }
      }
      // 2. Update all billing charges for this billing_unit_id
      for (const c of row.charges) {
        if (!c.id) continue
        const updates: Record<string, unknown> = { [weightField]: newChw }
        if (c.unit === 'KG') {
          updates.qty = newChw
          updates.total = Math.round(newChw * c.rate * 100) / 100
        }
        await updateDoc(doc(db, 'air_billing_charges', c.id), updates)
      }
      // Clear editing state and mark as OK
      setChwEditing(prev => { const n = { ...prev }; delete n[key]; return n })
      setChwVerified(prev => ({ ...prev, [key]: { docChw: newChw, status: 'ok' } }))
      await loadData()
    } catch (e) {
      console.error('Error syncing CHW:', e)
      alert('Error al sincronizar CHW: ' + String(e))
    }
    setChwSaving(null)
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <Layout title="Air Billing Charges" backTo="/airfreight/admin">
        <div className="flex justify-center items-center py-32">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" />
        </div>
      </Layout>
    )
  }

  return (
    <Layout title="Air Billing Charges" backTo="/airfreight/admin">
      {/* Filters bar */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 mb-6">
        <div className="flex gap-2 items-end">
          <div className="min-w-[150px]">
            <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-1">Cliente</label>
            <select value={filterClient} onChange={e => setFilterClient(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-mcl-blue/30">
              <option value="">Todos</option>
              {clientOptions.map(([id, name]) => (
                <option key={id} value={id}>{name}</option>
              ))}
            </select>
          </div>
          <div className="min-w-[150px]">
            <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-1">Vuelo</label>
            <select value={filterFlight} onChange={e => setFilterFlight(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-mcl-blue/30">
              <option value="">Todos</option>
              {flightOptions.map(([id, label]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </div>
          <div className="min-w-[120px]">
            <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-1">AWB</label>
            <input type="text" value={filterAwb} onChange={e => setFilterAwb(e.target.value)}
              placeholder="AWB..."
              className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-mcl-blue/30 font-mono" />
          </div>
          <div className="min-w-[100px]">
            <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-1">Estado</label>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as any)}
              className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-mcl-blue/30">
              <option value="all">Todos</option>
              <option value="pending">Pendiente</option>
              <option value="invoiced">Facturado</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-1">Desde</label>
            <input type="date" value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
          </div>
          <div>
            <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-1">Hasta</label>
            <input type="date" value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
          </div>
          {(filterClient || filterFlight || filterAwb || filterStatus !== 'all' || filterDateFrom || filterDateTo) && (
            <button onClick={() => { setFilterClient(''); setFilterFlight(''); setFilterAwb(''); setFilterStatus('all'); setFilterDateFrom(''); setFilterDateTo('') }}
              className="text-[10px] text-red-500 hover:text-red-700 underline pb-1">
              Limpiar
            </button>
          )}
          <div className="flex-1" />
          {/* KPI: pending $ since May 2025 (unfiltered) */}
          {(() => {
            let pendingTotal = 0
            for (const c of charges) {
              if (c.status !== 'pending') continue
              const fd = flightMap.get(c.flight_id)?.flight_datetime || ''
              if (fd >= '2026-05-01') pendingTotal += c.total
            }
            return (
              <div className="flex items-end gap-3">
                <div className="bg-yellow-50 border-2 border-yellow-300 rounded-xl px-5 py-2 text-center min-w-[140px]">
                  <div className="text-[10px] uppercase tracking-wide text-yellow-600 font-semibold mb-0.5">Por Facturar</div>
                  <div className="text-2xl font-extrabold text-yellow-700 leading-tight">{fmtUSD(pendingTotal, 0)}</div>
                </div>
                <button
                  onClick={async () => {
                    setCrossCheckLoading(true)
                    setCrossCheckError('')
                    setCrossCheckReport(null)
                    try {
                      const fn = httpsCallable(getFunctions(getApp(), 'us-east1'), 'crossCheckManual')
                      const res = await fn({})
                      const data = res.data as any
                      if (data.error) setCrossCheckError(data.error)
                      else setCrossCheckReport(data)
                    } catch (err: any) {
                      setCrossCheckError(err.message || 'Error ejecutando cross check')
                    }
                    setCrossCheckLoading(false)
                  }}
                  disabled={crossCheckLoading}
                  className="px-4 py-2 bg-mcl-blue text-white text-xs font-semibold rounded-lg hover:bg-mcl-blue/90 transition-colors disabled:opacity-50 whitespace-nowrap"
                >
                  {crossCheckLoading ? 'Procesando...' : 'Cross Check'}
                </button>
              </div>
            )
          })()}
        </div>
      </div>

      {/* Cross Check Modal */}
      {(crossCheckReport || crossCheckError) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { setCrossCheckReport(null); setCrossCheckError('') }}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-[1100px] w-full mx-4 max-h-[85vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b bg-gray-50">
              <div>
                <h2 className="text-lg font-bold text-gray-800">Cross Check — Billing vs Planilla</h2>
                {crossCheckReport && <p className="text-xs text-gray-500 mt-0.5">{crossCheckReport.client_name} · {crossCheckReport.month} · {new Date(crossCheckReport.run_at).toLocaleString()}</p>}
              </div>
              <button onClick={() => { setCrossCheckReport(null); setCrossCheckError('') }} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">&times;</button>
            </div>

            {crossCheckError ? (
              <div className="p-8 text-center text-red-600">{crossCheckError}</div>
            ) : crossCheckReport && (
              <div className="overflow-y-auto flex-1 p-6 space-y-5">
                {/* Summary KPIs */}
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
                  {[
                    { label: 'En Planilla', value: crossCheckReport.total_in_sheet, color: 'text-gray-700 bg-gray-50 border-gray-200' },
                    { label: 'Excluidas (ETD)', value: crossCheckReport.total_excluded_etd, color: 'text-gray-500 bg-gray-50 border-gray-200' },
                    { label: 'Analizadas', value: crossCheckReport.total_analyzed, color: 'text-blue-700 bg-blue-50 border-blue-200' },
                    { label: 'Facturadas', value: crossCheckReport.total_invoiced, color: 'text-green-700 bg-green-50 border-green-200' },
                    { label: 'Billing sin Invoice', value: crossCheckReport.total_billing_no_invoice, color: 'text-yellow-700 bg-yellow-50 border-yellow-300' },
                    { label: 'Sin Billing', value: crossCheckReport.total_no_billing, color: 'text-red-700 bg-red-50 border-red-300' },
                  ].map(kpi => (
                    <div key={kpi.label} className={`rounded-xl border-2 px-3 py-2 text-center ${kpi.color}`}>
                      <div className="text-[9px] uppercase tracking-wide font-semibold mb-0.5">{kpi.label}</div>
                      <div className="text-xl font-extrabold leading-tight">{kpi.value}</div>
                    </div>
                  ))}
                </div>

                {/* No Billing table */}
                {crossCheckReport.no_billing?.length > 0 && (
                  <div>
                    <button onClick={() => setCrossCheckExpanded(crossCheckExpanded === 'noBilling' ? null : 'noBilling')}
                      className="flex items-center gap-2 text-sm font-bold text-red-700 mb-2 hover:underline">
                      <span className="inline-block w-3 h-3 rounded-full bg-red-500" />
                      Sin Billing ({crossCheckReport.no_billing.length})
                      <span className="text-xs text-gray-400">{crossCheckExpanded === 'noBilling' ? '▼' : '▶'}</span>
                    </button>
                    {crossCheckExpanded === 'noBilling' && <CrossCheckTable rows={crossCheckReport.no_billing} />}
                  </div>
                )}

                {/* Billing no invoice table */}
                {crossCheckReport.billing_no_invoice?.length > 0 && (
                  <div>
                    <button onClick={() => setCrossCheckExpanded(crossCheckExpanded === 'billingNoInv' ? null : 'billingNoInv')}
                      className="flex items-center gap-2 text-sm font-bold text-yellow-700 mb-2 hover:underline">
                      <span className="inline-block w-3 h-3 rounded-full bg-yellow-500" />
                      Billing sin Invoice ({crossCheckReport.billing_no_invoice.length})
                      <span className="text-xs text-gray-400">{crossCheckExpanded === 'billingNoInv' ? '▼' : '▶'}</span>
                    </button>
                    {crossCheckExpanded === 'billingNoInv' && <CrossCheckTable rows={crossCheckReport.billing_no_invoice} />}
                  </div>
                )}

                {/* Flight mismatches */}
                {crossCheckReport.flight_mismatches?.length > 0 && (
                  <div>
                    <button onClick={() => setCrossCheckExpanded(crossCheckExpanded === 'flightMis' ? null : 'flightMis')}
                      className="flex items-center gap-2 text-sm font-bold text-orange-700 mb-2 hover:underline">
                      <span className="inline-block w-3 h-3 rounded-full bg-orange-400" />
                      Flight Mismatch ({crossCheckReport.flight_mismatches.length})
                      <span className="text-xs text-gray-400">{crossCheckExpanded === 'flightMis' ? '▼' : '▶'}</span>
                    </button>
                    {crossCheckExpanded === 'flightMis' && (
                      <div className="overflow-x-auto rounded-lg border border-orange-200">
                        <table className="w-full text-xs">
                          <thead><tr className="bg-orange-50 text-orange-800">
                            <th className="px-3 py-2 text-left">AWB 1st</th>
                            <th className="px-3 py-2 text-left">AWB 2nd</th>
                            <th className="px-3 py-2 text-left">Flight (Planilla)</th>
                            <th className="px-3 py-2 text-left">Flight (Invoice)</th>
                          </tr></thead>
                          <tbody>
                            {crossCheckReport.flight_mismatches.map((m: any, i: number) => (
                              <tr key={i} className="border-t border-orange-100 hover:bg-orange-50/50">
                                <td className="px-3 py-1.5 font-mono">{m.awb1st}</td>
                                <td className="px-3 py-1.5 font-mono">{m.awb2nd}</td>
                                <td className="px-3 py-1.5 font-semibold">{m.sheetFlight}</td>
                                <td className="px-3 py-1.5 font-semibold text-orange-600">{m.invoiceFlight}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                {/* AWB 2nd leg mismatches */}
                {crossCheckReport.awb_mismatches?.length > 0 && (
                  <div>
                    <button onClick={() => setCrossCheckExpanded(crossCheckExpanded === 'awbMis' ? null : 'awbMis')}
                      className="flex items-center gap-2 text-sm font-bold text-purple-700 mb-2 hover:underline">
                      <span className="inline-block w-3 h-3 rounded-full bg-purple-400" />
                      AWB 2nd Leg Mismatch ({crossCheckReport.awb_mismatches.length})
                      <span className="text-xs text-gray-400">{crossCheckExpanded === 'awbMis' ? '▼' : '▶'}</span>
                    </button>
                    {crossCheckExpanded === 'awbMis' && (
                      <div className="overflow-x-auto rounded-lg border border-purple-200">
                        <table className="w-full text-xs">
                          <thead><tr className="bg-purple-50 text-purple-800">
                            <th className="px-3 py-2 text-left">AWB 1st</th>
                            <th className="px-3 py-2 text-left">2nd Leg (Planilla)</th>
                            <th className="px-3 py-2 text-left">2nd Leg (Invoice)</th>
                            <th className="px-3 py-2 text-left">Flight (Invoice)</th>
                          </tr></thead>
                          <tbody>
                            {crossCheckReport.awb_mismatches.map((m: any, i: number) => (
                              <tr key={i} className="border-t border-purple-100 hover:bg-purple-50/50">
                                <td className="px-3 py-1.5 font-mono">{m.awb1st}</td>
                                <td className="px-3 py-1.5 font-mono">{m.sheet2ndLeg}</td>
                                <td className="px-3 py-1.5 font-mono text-purple-600 font-semibold">{m.invoice2ndLeg}</td>
                                <td className="px-3 py-1.5">{m.invoiceFlight}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                {/* All green */}
                {crossCheckReport.total_no_billing === 0 && crossCheckReport.total_billing_no_invoice === 0 && crossCheckReport.total_flight_mismatch === 0 && crossCheckReport.total_awb_mismatch === 0 && (
                  <div className="text-center py-8 text-green-600 font-semibold">
                    Todas las AWBs analizadas estan facturadas. Sin discrepancias.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Summary */}
      <div className="mb-4 text-sm text-gray-500">
        {groups.length} grupo{groups.length !== 1 ? 's' : ''} &middot; {charges.length} cargo{charges.length !== 1 ? 's' : ''} &middot; Total: {fmtUSD(groups.reduce((s, g) => s + g.total, 0))}
      </div>

      {groups.length === 0 && (
        <div className="text-center py-20 text-gray-400">No se encontraron cargos.</div>
      )}

      {/* Group cards */}
      <div className="space-y-4">
        {groups.map(g => {
          const isExpanded = expandedKey === g.key
          const status = getGroupStatus(g)
          const hasPending = g.charges.some(c => c.status === 'pending')
          const hasInvoice = !!g.invoice && g.invoice.status !== 'voided'

          return (
            <div key={g.key} className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
              {/* Header */}
              <div
                className="px-5 py-4 flex items-center justify-between cursor-pointer hover:bg-gray-50 transition-colors"
                onClick={() => setExpandedKey(isExpanded ? null : g.key)}
              >
                <div className="flex items-center gap-4">
                  {recalcFlags.has(g.key) && (
                    <span title="Datos modificados desde validación — recalcular billing" className="flex-shrink-0 text-amber-500 animate-pulse">
                      <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                      </svg>
                    </span>
                  )}
                  <svg className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                    fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  <div>
                    <div className="font-bold text-gray-800 text-sm">
                      {g.airline} {g.flight_number}
                      {(() => {
                        const isMawb = g.charges.some(c => c.booking_type === 'mawb')
                        if (isMawb) {
                          const mawbs = [...new Set(g.awbRows.map(r => r.mawb_number).filter(Boolean))]
                          return mawbs.length > 0 ? <span className="ml-2 font-normal text-xs text-gray-500">MAWB {mawbs.join(' / ')}</span> : null
                        }
                        // ecommerce/simple: first 2nd leg + x Others
                        const legs = g.awbRows.map(r => r.awb_2nd_leg).filter(Boolean) as string[]
                        if (legs.length > 0) {
                          return <span className="ml-2 font-normal text-xs text-gray-500">{legs[0]}{legs.length > 1 ? ` + ${legs.length - 1} others` : ''}</span>
                        }
                        return null
                      })()}
                    </div>
                    <div className="text-[11px] text-gray-500 mt-0.5">
                      {g.client_name}
                      {g.flight && (
                        <span className="ml-2 text-gray-400">{g.flight.flight_datetime?.slice(0, 10)}</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${STATUS_BADGE[status] || 'bg-gray-100 text-gray-600'}`}>
                    {status === 'pending' ? 'Pendiente' : status === 'draft' ? 'Editando' : status === 'generated' ? 'Facturado' : status === 'sent' ? 'Enviado' : status === 'paid' ? 'Pagado' : status === 'voided' ? 'Anulado' : status}
                  </span>
                  {g.invoice?.billing_review_needed && (
                    <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-orange-100 text-orange-700 animate-pulse">
                      Revisar
                    </span>
                  )}
                  {g.invoice && (
                    <span className="text-xs text-gray-400 font-mono">{g.invoice.invoice_number}</span>
                  )}
                  <span className="font-bold text-gray-800">{fmtUSD(g.total)}</span>
                </div>
              </div>

              {/* Expanded detail */}
              {isExpanded && (
                <div className="border-t border-gray-100">
                  {/* Actions bar */}
                  {isBilling && (
                    <div className="px-5 py-3 bg-gray-50 flex flex-wrap gap-2 items-center">
                      <button onClick={e => { e.stopPropagation(); openManualModal(g) }}
                        disabled={!!busyAction}
                        className="bg-mcl-blue text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-blue-700 disabled:opacity-50">
                        + Agregar Cargo
                      </button>
                      {hasPending && (
                        <button onClick={e => { e.stopPropagation(); handleRecalculate(g) }}
                          disabled={!!busyAction}
                          className="bg-orange-500 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-orange-600 disabled:opacity-50">
                          {busyAction === g.key + '_recalc' ? 'Recalculando...' : 'Recalcular Tarifas'}
                        </button>
                      )}
                      {g.awbRows.some(r => getAwbDocUrl(r)) && (
                        <button onClick={e => { e.stopPropagation(); verifyGroupChw(g) }}
                          disabled={g.awbRows.some(r => chwVerified[r.billing_unit_id]?.status === 'loading')}
                          className="bg-indigo-500 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-indigo-600 disabled:opacity-50">
                          {g.awbRows.some(r => chwVerified[r.billing_unit_id]?.status === 'loading') ? 'Verificando...' : g.profile?.billing?.billing_weight_source === 'gross' ? 'Validar GW' : 'Validar CHW'}
                        </button>
                      )}
                      {hasPending && !hasInvoice && (
                        <button onClick={e => { e.stopPropagation(); handleGenerateInvoice(g) }}
                          disabled={!!busyAction}
                          className="bg-green-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-green-700 disabled:opacity-50">
                          {busyAction === g.key ? 'Generando...' : 'Generar Factura'}
                        </button>
                      )}
                      {g.client_name === 'Express Line' && !hasInvoice && (
                        <button onClick={e => { e.stopPropagation(); exportExpressLineExcel(g as any) }}
                          className="bg-emerald-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-emerald-700">
                          Generar Excel
                        </button>
                      )}
                      {hasInvoice && (
                        <>
                          <button onClick={e => { e.stopPropagation(); handleDownloadPdf(g) }}
                            disabled={!!busyAction}
                            className="bg-gray-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-gray-700 disabled:opacity-50">
                            {busyAction === g.key ? 'Generando PDF...' : 'Descargar PDF'}
                          </button>
                          {g.client_name === 'Express Line' && (
                            <button onClick={e => { e.stopPropagation(); exportExpressLineExcel(g as any) }}
                              className="bg-emerald-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-emerald-700">
                              Generar Excel
                            </button>
                          )}
                          {g.invoice!.status === 'draft' && (
                            <button onClick={e => { e.stopPropagation(); handleResealInvoice(g) }}
                              disabled={!!busyAction}
                              className="bg-green-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-green-700 disabled:opacity-50">
                              Cerrar Factura
                            </button>
                          )}
                          {g.invoice!.status !== 'voided' && g.invoice!.status !== 'draft' && (
                            <button onClick={e => { e.stopPropagation(); handleUnlockInvoice(g) }}
                              disabled={!!busyAction}
                              className="bg-yellow-500 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-yellow-600 disabled:opacity-50">
                              Editar Factura
                            </button>
                          )}
                          {g.invoice!.status !== 'voided' && (
                            <button onClick={e => { e.stopPropagation(); handleVoidInvoice(g) }}
                              disabled={!!busyAction}
                              className="bg-red-500 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-red-600 disabled:opacity-50">
                              Anular Factura
                            </button>
                          )}
                          <button onClick={e => { e.stopPropagation(); handleSendEmail(g) }}
                            disabled={!!busyAction || sendingMail === g.key}
                            className="bg-blue-500 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-blue-600 disabled:opacity-50">
                            {sendingMail === g.key ? 'Enviando...' : 'Enviar Email'}
                          </button>
                        </>
                      )}
                    </div>
                  )}

                  {/* Billing review alert */}
                  {g.invoice?.billing_review_needed && (
                    <div className="mx-5 my-3 p-4 bg-orange-50 border border-orange-200 rounded-lg">
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-bold text-orange-800 text-sm">Cambios detectados desde la ultima factura</span>
                        {isBilling && (
                          <button
                            onClick={async (e) => {
                              e.stopPropagation()
                              await dismissBillingReview(g.invoice!.id!, user?.email || '')
                              await loadData()
                            }}
                            className="text-xs bg-orange-600 text-white px-3 py-1 rounded hover:bg-orange-700">
                            Marcar como revisado
                          </button>
                        )}
                      </div>
                      <ul className="text-xs text-orange-700 space-y-1">
                        {(g.invoice.billing_review_details || []).map((d, i) => (
                          <li key={i}>• {d.description}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Express Line detail table */}
                  <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50 sticky top-0 z-10">
                        <tr>
                          <th className="text-left px-2 py-2 font-semibold text-gray-500 uppercase text-[10px]">AIRLINE</th>
                          <th className="text-left px-2 py-2 font-semibold text-gray-500 uppercase text-[10px]">1st LEG<br/>AWB#</th>
                          <th className="text-left px-2 py-2 font-semibold text-gray-500 uppercase text-[10px]">2nd LEG<br/>AWB#</th>
                          <th className="px-1 py-2 w-6" title="Ver documento AWB" />
                          <th className="text-right px-2 py-2 font-semibold text-gray-500 uppercase text-[10px]">{g.profile?.billing?.billing_weight_source === 'gross' ? 'GW' : 'CW'}</th>
                          {g.chargeNames.map(cn => (
                            <th key={cn} className="text-right px-2 py-2 font-semibold text-gray-500 uppercase text-[10px] max-w-[100px]">{cn}</th>
                          ))}
                          <th className="text-right px-2 py-2 font-semibold text-gray-500 uppercase text-[10px]">TOTAL</th>
                          <th className="text-center px-2 py-2 font-semibold text-gray-500 uppercase text-[10px]">TYPE</th>
                          <th className="text-center px-2 py-2 font-semibold text-gray-500 uppercase text-[10px] w-12">{g.profile?.billing?.billing_weight_source === 'gross' ? 'GW' : 'CHW'}<br/>CHECK</th>
                          {isBilling && (
                            <th className="px-2 py-2 w-10" />
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {g.awbRows.map((row, idx) => (
                          <tr key={row.billing_unit_id} className="border-b border-gray-100 hover:bg-gray-50">
                            <td className="px-3 py-2 text-gray-700 whitespace-nowrap">{g.airline}</td>
                            <td className="px-3 py-2 text-gray-700 font-mono whitespace-nowrap">{row.awb_1st_leg || (row.mawb_number ? `MAWB ${row.mawb_number}` : '-')}</td>
                            <td className="px-3 py-2 text-gray-700 font-mono whitespace-nowrap">{row.awb_2nd_leg || '-'}</td>
                            <td className="px-1 py-2 text-center">
                              {(() => {
                                const docUrl = getAwbDocUrl(row)
                                return docUrl ? (
                                  <button
                                    onClick={() => window.open(docUrl, '_blank')}
                                    className="inline-block w-2.5 h-2.5 rounded-full bg-green-500 hover:bg-green-600 transition-colors cursor-pointer"
                                    title="Ver AWB"
                                  />
                                ) : (
                                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-gray-300" title="Sin documento" />
                                )
                              })()}
                            </td>
                            <td className="px-3 py-2 text-right text-gray-600 font-mono whitespace-nowrap">
                              {(() => {
                                const v = chwVerified[row.billing_unit_id]
                                const isEditing = chwEditing[row.billing_unit_id] != null
                                const isMismatch = v?.status === 'mismatch'
                                if (isMismatch || isEditing) {
                                  const defaultVal = String(v?.docChw ?? getCw(row))
                                  const val = chwEditing[row.billing_unit_id] ?? defaultVal
                                  const saving = chwSaving === row.billing_unit_id
                                  return (
                                    <span className="inline-flex items-center gap-1">
                                      <input
                                        type="number"
                                        step="0.01"
                                        className="w-24 px-1 py-0.5 text-right font-mono text-xs border border-amber-400 rounded bg-amber-50 focus:outline-none focus:ring-1 focus:ring-amber-500"
                                        value={val}
                                        onChange={e => setChwEditing(prev => ({ ...prev, [row.billing_unit_id]: e.target.value }))}
                                        onKeyDown={e => {
                                          if (e.key === 'Enter') saveCorrectChw(row, val, g.profile?.billing?.billing_weight_source === 'gross')
                                          else if (e.key === 'Escape') setChwEditing(prev => { const n = { ...prev }; delete n[row.billing_unit_id]; return n })
                                        }}
                                        disabled={saving}
                                      />
                                      <button
                                        onClick={() => saveCorrectChw(row, val, g.profile?.billing?.billing_weight_source === 'gross')}
                                        disabled={saving}
                                        className="p-0.5 text-green-600 hover:text-green-800 hover:bg-green-50 rounded disabled:opacity-50"
                                        title={g.profile?.billing?.billing_weight_source === 'gross' ? 'Guardar GW corregido' : 'Guardar CHW corregido'}
                                      >
                                        {saving
                                          ? <div className="animate-spin w-3.5 h-3.5 border-2 border-green-400 border-t-transparent rounded-full" />
                                          : <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                        }
                                      </button>
                                    </span>
                                  )
                                }
                                return fmtNum(getCw(row))
                              })()}
                            </td>
                            {g.chargeNames.map(cn => {
                              const charge = row.charges.find(c => c.charge_name === cn)
                              return (
                                <td
                                  key={cn}
                                  className={`px-3 py-2 text-right font-mono whitespace-nowrap ${
                                    charge && charge.status === 'pending' && isBilling
                                      ? 'cursor-pointer hover:bg-yellow-50 text-gray-800'
                                      : 'text-gray-600'
                                  }`}
                                  onClick={() => charge && openEditCharge(charge)}
                                  title={charge ? `${charge.qty} x ${charge.rate} = ${charge.total.toFixed(2)}` : ''}
                                >
                                  {charge ? charge.rate.toFixed(2) : '-'}
                                </td>
                              )
                            })}
                            <td className="px-3 py-2 text-right font-bold text-gray-800 whitespace-nowrap">{fmtUSD(row.total)}</td>
                            <td className="px-3 py-2 text-center whitespace-nowrap">
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                row.cargo_type === 'BUP' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-600'
                              }`}>
                                {row.cargo_type}
                              </span>
                            </td>
                            <td className="px-2 py-2 text-center">
                              {(() => {
                                const docUrl = getAwbDocUrl(row)
                                const v = chwVerified[row.billing_unit_id]
                                if (v?.status === 'loading') {
                                  return <div className="animate-spin inline-block w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full" />
                                }
                                if (v?.status === 'ok') {
                                  return (
                                    <span className="text-green-600 font-bold" title={`Doc: ${v.docChw} kg | Billing: ${fmtNum(getCw(row))} kg`}>
                                      ✓
                                    </span>
                                  )
                                }
                                if (v?.status === 'mismatch') {
                                  return (
                                    <span className="text-amber-600 font-bold cursor-help" title={`Doc: ${v.docChw} kg | Billing: ${fmtNum(getCw(row))} kg — MISMATCH`}>
                                      ⚠
                                    </span>
                                  )
                                }
                                if (v?.status === 'error') {
                                  return <span className="text-red-400 text-xs" title="Error al verificar">✗</span>
                                }
                                return docUrl ? (
                                  <button
                                    onClick={() => verifyRowChw(row, g.profile?.billing?.billing_weight_source === 'gross' ? 'gross' : 'chw')}
                                    className="p-0.5 text-blue-500 hover:text-blue-700 hover:bg-blue-50 rounded transition-colors"
                                    title={g.profile?.billing?.billing_weight_source === 'gross' ? 'Verificar GW vs documento AWB' : 'Verificar CHW vs documento AWB'}
                                  >
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                  </button>
                                ) : (
                                  <span className="inline-block w-4 h-4 text-gray-300" title="Sin documento AWB">—</span>
                                )
                              })()}
                            </td>
                            {isBilling && (
                              <td className="px-2 py-2">
                                {row.charges.some(c => c.status === 'pending' && c.source === 'manual') && (
                                  <button
                                    onClick={() => {
                                      const manual = row.charges.find(c => c.status === 'pending' && c.source === 'manual')
                                      if (manual) handleDeleteCharge(manual)
                                    }}
                                    className="p-1 text-red-400 hover:text-red-600 hover:bg-red-50 rounded opacity-0 group-hover:opacity-100"
                                    title="Eliminar cargo manual"
                                  >
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                    </svg>
                                  </button>
                                )}
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="bg-gray-50 border-t-2 border-gray-200">
                        <tr>
                          <td colSpan={4} className="px-3 py-2 text-xs font-bold text-gray-600 uppercase">TOTALES</td>
                          <td className="px-3 py-2 text-right font-bold text-gray-600 font-mono">
                            {fmtNum(g.awbRows.reduce((s, r) => s + getCw(r), 0))}
                          </td>
                          {g.chargeNames.map(cn => {
                            const colTotal = g.charges.filter(c => c.charge_name === cn).reduce((s, c) => s + c.total, 0)
                            return (
                              <td key={cn} className="px-3 py-2 text-right font-bold text-gray-600 font-mono">{fmtUSD(colTotal)}</td>
                            )
                          })}
                          <td className="px-3 py-2 text-right font-bold text-mcl-blue font-mono">{fmtUSD(g.total)}</td>
                          <td />
                          <td />
                          {isBilling && <td />}
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* ── Manual charge modal ──────────────────────────────────────────────── */}
      {manualModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setManualModal(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-gray-100">
              <h3 className="font-bold text-gray-800">Agregar Cargo Manual</h3>
              <p className="text-xs text-gray-400 mt-1">{manualModal.client_name} - {manualModal.airline} {manualModal.flight_number}</p>
            </div>
            <div className="px-6 py-4 space-y-3">
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">AWB</label>
                <select value={manualAwb} onChange={e => setManualAwb(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30">
                  {manualModal.awbRows.map(r => (
                    <option key={r.billing_unit_id} value={r.billing_unit_id}>
                      {r.awb_2nd_leg || r.awb_1st_leg || r.mawb_number || r.billing_unit_id}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Nombre del Cargo</label>
                {rateSchedule.length > 0 ? (
                  <select value={manualRateName} onChange={e => {
                    setManualRateName(e.target.value)
                    const matched = rateSchedule.find(r => r.name === e.target.value)
                    if (matched) {
                      setManualRate(String(matched.price))
                      setManualDesc(matched.remarks || matched.name)
                      const unitMap: Record<string, string> = {
                        per_kg: 'KG', per_awb: 'AWB', per_box: 'BOX', per_pallet: 'PALLET',
                        per_uld: 'ULD', per_hour: 'HOUR', per_oversize_unit: 'UNIT', flat: 'FLAT',
                      }
                      setManualUnit(unitMap[matched.unit] || 'KG')
                    }
                  }}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30">
                    <option value="">Seleccionar del tarifario...</option>
                    {rateSchedule.map(r => (
                      <option key={r.id} value={r.name}>{r.name}</option>
                    ))}
                  </select>
                ) : (
                  <input type="text" value={manualRateName} onChange={e => setManualRateName(e.target.value)}
                    placeholder="Nombre del cargo"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
                )}
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Descripcion</label>
                <input type="text" value={manualDesc} onChange={e => setManualDesc(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Unidad</label>
                  <select value={manualUnit} onChange={e => setManualUnit(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30">
                    {['KG', 'AWB', 'BOX', 'PALLET', 'ULD', 'HOUR', 'UNIT', 'FLAT', 'QTY'].map(u => (
                      <option key={u} value={u}>{u}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Cantidad</label>
                  <input type="number" step="any" min="0" value={manualQty} onChange={e => setManualQty(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Tarifa</label>
                  <input type="number" step="any" min="0" value={manualRate} onChange={e => setManualRate(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
                </div>
              </div>
              {(parseFloat(manualQty) > 0 && parseFloat(manualRate) > 0) && (
                <div className="bg-gray-50 rounded-lg p-3 flex justify-between text-sm">
                  <span className="text-gray-600">Total</span>
                  <span className="font-bold text-gray-800">{fmtUSD(parseFloat(manualQty) * parseFloat(manualRate))}</span>
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
              <button onClick={() => setManualModal(null)} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">Cancelar</button>
              <button onClick={handleSaveManualCharge} disabled={busyAction === 'manual'}
                className="bg-mcl-blue text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
                {busyAction === 'manual' ? 'Guardando...' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit charge modal ────────────────────────────────────────────────── */}
      {editCharge && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setEditCharge(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-gray-100">
              <h3 className="font-bold text-gray-800">Editar Cargo</h3>
              <p className="text-xs text-gray-400 mt-1">{editCharge.charge_name}</p>
            </div>
            <div className="px-6 py-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Cantidad</label>
                  <input type="number" step="any" min="0" value={editQty} onChange={e => setEditQty(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Tarifa</label>
                  <input type="number" step="any" min="0" value={editRate} onChange={e => setEditRate(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Weight (kg)</label>
                  <input type="number" step="any" min="0" value={editCw} onChange={e => setEditCw(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Unidad</label>
                  <select value={editUnit} onChange={e => setEditUnit(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30">
                    {['KG', 'AWB', 'BOX', 'PALLET', 'ULD', 'HOUR', 'UNIT', 'FLAT', 'QTY'].map(u => (
                      <option key={u} value={u}>{u}</option>
                    ))}
                  </select>
                </div>
              </div>
              {(parseFloat(editQty) > 0 && parseFloat(editRate) > 0) && (
                <div className="bg-gray-50 rounded-lg p-3 flex justify-between text-sm">
                  <span className="text-gray-600">Nuevo total</span>
                  <span className="font-bold text-gray-800">{fmtUSD(parseFloat(editQty) * parseFloat(editRate))}</span>
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex justify-between">
              <button
                onClick={() => { handleDeleteCharge(editCharge); setEditCharge(null) }}
                disabled={busyAction === 'delete' || editCharge.status !== 'pending'}
                className="px-4 py-2 text-sm text-red-500 hover:text-red-700 hover:bg-red-50 rounded-lg disabled:opacity-30 disabled:cursor-not-allowed"
                title={editCharge.status !== 'pending' ? 'Solo se pueden eliminar cargos pendientes' : 'Eliminar este cargo'}
              >
                Eliminar
              </button>
              <div className="flex gap-3">
                <button onClick={() => setEditCharge(null)} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">Cancelar</button>
                <button onClick={handleSaveEditCharge} disabled={busyAction === 'edit'}
                  className="bg-mcl-blue text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
                  {busyAction === 'edit' ? 'Guardando...' : 'Guardar'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Invoice adjustment modal ───────────────────────────────────────────── */}
      {adjGroup && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setAdjGroup(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-gray-100">
              <h3 className="font-bold text-gray-800">Generar Factura</h3>
              <p className="text-xs text-gray-400 mt-1">{adjGroup.client_name} — {adjGroup.airline} {adjGroup.flight_number}</p>
            </div>
            <div className="px-6 py-4 space-y-4">
              <div className="bg-gray-50 rounded-lg p-3 flex justify-between text-sm">
                <span className="text-gray-600">Subtotal</span>
                <span className="font-bold text-gray-800">{fmtUSD(adjGroup.total)}</span>
              </div>

              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase block mb-2">Ajuste (opcional)</label>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setAdjKind(adjKind === 'discount' ? '' : 'discount')}
                    className={`flex-1 text-xs font-semibold py-2 rounded-lg border transition-colors ${adjKind === 'discount' ? 'bg-red-50 border-red-300 text-red-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}>
                    Descuento
                  </button>
                  <button type="button" onClick={() => setAdjKind(adjKind === 'surcharge' ? '' : 'surcharge')}
                    className={`flex-1 text-xs font-semibold py-2 rounded-lg border transition-colors ${adjKind === 'surcharge' ? 'bg-green-50 border-green-300 text-green-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}>
                    Recargo
                  </button>
                </div>
              </div>

              {adjKind && (
                <div className="space-y-3">
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setAdjCalc('percent')}
                      className={`px-3 py-1.5 text-xs rounded-lg border ${adjCalc === 'percent' ? 'bg-mcl-blue text-white border-mcl-blue' : 'border-gray-200 text-gray-500'}`}>
                      %
                    </button>
                    <button type="button" onClick={() => setAdjCalc('amount')}
                      className={`px-3 py-1.5 text-xs rounded-lg border ${adjCalc === 'amount' ? 'bg-mcl-blue text-white border-mcl-blue' : 'border-gray-200 text-gray-500'}`}>
                      $
                    </button>
                    <input type="number" step="any" min="0" placeholder={adjCalc === 'percent' ? 'Porcentaje' : 'Monto'}
                      value={adjValue} onChange={e => setAdjValue(e.target.value)}
                      className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
                  </div>
                  <input type="text" placeholder="Nota (opcional)" value={adjNote} onChange={e => setAdjNote(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />

                  {parseFloat(adjValue) > 0 && (
                    <div className="bg-gray-50 rounded-lg p-3 text-sm space-y-1">
                      {(() => {
                        const sub = adjGroup.total
                        let adj = adjCalc === 'percent' ? sub * (parseFloat(adjValue) / 100) : parseFloat(adjValue)
                        if (adjKind === 'discount') adj = -Math.abs(adj)
                        else adj = Math.abs(adj)
                        return (
                          <>
                            <div className="flex justify-between"><span className="text-gray-500">Ajuste</span><span className={adj < 0 ? 'text-red-600' : 'text-green-600'}>{adj < 0 ? '-' : '+'}${Math.abs(adj).toFixed(2)}</span></div>
                            <div className="flex justify-between font-bold"><span className="text-gray-700">Total</span><span>{fmtUSD(sub + adj)}</span></div>
                          </>
                        )
                      })()}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="px-6 pb-4">
              <label className="text-xs font-semibold text-gray-500 uppercase block mb-2">Nota en factura (opcional)</label>
              <textarea
                value={invoiceNote}
                onChange={e => setInvoiceNote(e.target.value)}
                placeholder="Texto libre que aparecerá en la factura..."
                rows={2}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30 resize-none"
              />
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
              <button onClick={() => setAdjGroup(null)} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">Cancelar</button>
              <button onClick={confirmGenerateInvoice} disabled={!!busyAction}
                className="bg-green-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50">
                {busyAction ? 'Generando...' : 'Generar Factura'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Hidden invoice for PDF generation ────────────────────────────────── */}
      {pdfGroup && pdfGroup.invoice && (() => {
        const inv = pdfGroup.invoice!
        const profile = pdfGroup.profile

        // Consolidated lines: group charges by charge_name
        const consolidated = new Map<string, { charge_name: string; qty: number; unit: string; rate: number; total: number }>()
        for (const c of pdfGroup.charges) {
          const existing = consolidated.get(c.charge_name)
          if (existing) {
            existing.qty += c.qty
            existing.total += c.total
          } else {
            consolidated.set(c.charge_name, {
              charge_name: c.charge_name,
              qty: c.qty,
              unit: c.unit,
              rate: c.rate,
              total: c.total,
            })
          }
        }
        const consolidatedLines = Array.from(consolidated.values())

        return (
          <div style={{ position: 'fixed', left: '-9999px', top: 0, width: '210mm' }}>
            <div ref={invoicePdfRef} style={{ fontFamily: 'Arial, Helvetica, sans-serif', color: '#333', background: '#fff' }}>
              {/* PAGE 1 — Consolidated Invoice */}
              <div style={{ padding: '20px' }}>
                {/* Header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                  <div>
                    <img src="/logo.png" style={{ height: '100px', margin: '-10px 0' }} alt="MinCurl Logistics" crossOrigin="anonymous" />
                    <div style={{ fontSize: '10px', color: '#666', marginTop: '2px' }}>MINCURL LOGISTICS CORP &mdash; MIAMI, FLORIDA 33122</div>
                  </div>
                  <div style={{ fontSize: '32px', fontWeight: 900, color: '#e53e3e', textAlign: 'right' }}>INVOICE</div>
                </div>

                {/* Bill-to and invoice details */}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '15px' }}>
                  <div style={{ background: '#f7f7f7', border: '1px solid #ddd', borderRadius: '4px', padding: '12px', width: '48%', whiteSpace: 'pre-line', fontSize: '11px', lineHeight: 1.5 }}>
                    <div style={{ fontSize: '10px', fontWeight: 700, color: '#e53e3e', marginBottom: '4px' }}>Bill To</div>
                    {inv.bill_to_name}{'\n'}{inv.bill_to_address}
                  </div>
                  <div style={{ width: '48%' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <tbody>
                        {[
                          ['INVOICE #', inv.invoice_number],
                          ['ACCOUNT No.', inv.account_number],
                          ['DATE', inv.date],
                          ['DUE DATE', inv.due_date],
                          ['TERMS', inv.payment_terms_label],
                          ['REFERENCE', inv.reference],
                        ].map(([label, val]) => (
                          <tr key={label}>
                            <td style={{ padding: '4px 8px', fontSize: '11px', border: '1px solid #ddd', fontWeight: 700, background: '#f7f7f7', width: '40%' }}>{label}</td>
                            <td style={{ padding: '4px 8px', fontSize: '11px', border: '1px solid #ddd' }}>{val}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Charges table */}
                <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '10px' }}>
                  <thead>
                    <tr>
                      {['DESCRIPTION', 'QTY', 'UNIT', 'RATE', 'AMOUNT'].map((h, i) => (
                        <th key={h} style={{ background: '#e2e8f0', padding: '8px 10px', fontSize: '10px', textTransform: 'uppercase' as const, textAlign: i === 0 ? 'left' : i === 2 ? 'center' : 'right', borderBottom: '2px solid #cbd5e0' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {consolidatedLines.map((line, i) => (
                      <tr key={i}>
                        <td style={{ padding: '6px 10px', borderBottom: '1px solid #eee', fontSize: '11px' }}>{line.charge_name}</td>
                        <td style={{ padding: '6px 10px', borderBottom: '1px solid #eee', fontSize: '11px', textAlign: 'right' }}>
                          {line.qty % 1 === 0 ? line.qty : line.qty.toFixed(4)}
                        </td>
                        <td style={{ padding: '6px 10px', borderBottom: '1px solid #eee', fontSize: '11px', textAlign: 'center' }}>{line.unit}</td>
                        <td style={{ padding: '6px 10px', borderBottom: '1px solid #eee', fontSize: '11px', textAlign: 'right' }}>${line.rate.toFixed(2)}</td>
                        <td style={{ padding: '6px 10px', borderBottom: '1px solid #eee', fontSize: '11px', textAlign: 'right', fontWeight: 600 }}>${line.total.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* Totals */}
                <div style={{ marginTop: 0, textAlign: 'right' }}>
                  <table style={{ marginLeft: 'auto', borderCollapse: 'collapse' }}>
                    <tbody>
                      <tr><td style={{ padding: '4px 12px', fontSize: '12px' }}>SubTotal</td><td style={{ padding: '4px 12px', fontSize: '12px' }}>${inv.subtotal.toFixed(2)}</td></tr>
                      {inv.adjustment_amount !== 0 && (
                        <tr style={{ color: inv.adjustment_amount < 0 ? '#e53e3e' : '#2f855a' }}>
                          <td style={{ padding: '4px 12px', fontSize: '12px' }}>
                            {inv.adjustment_kind === 'discount' ? 'Descuento' : 'Recargo'}
                            {inv.adjustment_note && <span style={{ fontSize: '9px', color: '#888' }}> &mdash; {inv.adjustment_note}</span>}
                          </td>
                          <td style={{ padding: '4px 12px', fontSize: '12px' }}>
                            {inv.adjustment_amount < 0 ? '-' : '+'}${Math.abs(inv.adjustment_amount).toFixed(2)}
                          </td>
                        </tr>
                      )}
                      <tr><td style={{ padding: '4px 12px', fontSize: '12px' }}>Tax</td><td style={{ padding: '4px 12px', fontSize: '12px' }}>$0.00</td></tr>
                      <tr>
                        <td style={{ padding: '4px 12px', fontSize: '14px', fontWeight: 900, borderTop: '2px solid #333' }}>TOTAL</td>
                        <td style={{ padding: '4px 12px', fontSize: '14px', fontWeight: 900, borderTop: '2px solid #333' }}>${inv.total.toFixed(2)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* Invoice note */}
                {inv.note && (
                  <div style={{ marginTop: '15px', padding: '10px', backgroundColor: '#f9f9f9', border: '1px solid #ddd', borderRadius: '4px', fontSize: '10px', color: '#333', lineHeight: 1.5 }}>
                    <strong>NOTE:</strong> {inv.note}
                  </div>
                )}

                {/* Bank details */}
                <div style={{ marginTop: '20px', fontSize: '9px', color: '#666', lineHeight: 1.6, borderTop: '1px solid #ddd', paddingTop: '10px' }}>
                  <strong style={{ color: '#333' }}>BANK DETAILS:</strong><br />
                  BANK NAME: JP MORGAN CHASE<br />
                  ROUTING NUMBER: 267084131<br />
                  ACCOUNT NUMBER: 818777270<br />
                  SWIFT: CHASUS33<br />
                  Name: MinCurl Logistics Corp
                </div>

                <div style={{ textAlign: 'center', marginTop: '15px', fontSize: '9px', color: '#999' }}>ORIGINAL</div>
              </div>

              {/* PAGE 2 — AWB Detail */}
              <div style={{ pageBreakBefore: 'always', padding: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                  <div>
                    <img src="/logo.png" style={{ height: '80px', margin: '-10px 0' }} alt="MinCurl Logistics" crossOrigin="anonymous" />
                  </div>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: '#333' }}>REFERENCE: {inv.reference}</div>
                </div>

                {/* Use pdfMawbLines (loaded from bookings) if available, otherwise fall back to awbRows */}
                {(() => {
                  const lines = pdfMawbLines.length > 0 ? pdfMawbLines : pdfGroup.awbRows.map(row => {
                    const sample = row.charges[0]
                    return {
                      agent: pdfGroup.client_name,
                      flight: `${pdfGroup.airline} ${pdfGroup.flight_number}`,
                      awb_number: row.awb_2nd_leg || row.awb_1st_leg || '-',
                      pieces: (sample as any)?.pieces || 0,
                      weight: (sample as any)?.weight || getCw(row),
                      date: pdfGroup.flight?.flight_datetime?.slice(0, 10) || inv.date,
                      mawb_number: (sample as any)?.mawb_number || null,
                    }
                  })

                  // Group by MAWB number if present
                  const mawbGroups = new Map<string, typeof lines>()
                  for (const line of lines) {
                    const key = line.mawb_number || '__none__'
                    if (!mawbGroups.has(key)) mawbGroups.set(key, [])
                    mawbGroups.get(key)!.push(line)
                  }

                  return Array.from(mawbGroups.entries()).map(([mawb, groupLines], gi) => (
                    <div key={gi} style={{ marginBottom: '20px' }}>
                      {mawb !== '__none__' && (
                        <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '8px', color: '#333' }}>MAWB {mawb}</div>
                      )}
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                          <tr>
                            {['AGENT', 'FLIGHT', 'AWB N\u00B0', 'PIECES', 'WEIGHT', 'DATE'].map(h => (
                              <th key={h} style={{ background: '#e2e8f0', padding: '8px 10px', fontSize: '10px', textTransform: 'uppercase' as const, textAlign: h === 'PIECES' || h === 'WEIGHT' ? 'right' : 'left', borderBottom: '2px solid #cbd5e0' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {groupLines.map((line, i) => (
                            <tr key={i}>
                              <td style={{ padding: '6px 10px', borderBottom: '1px solid #eee', fontSize: '11px' }}>{line.agent}</td>
                              <td style={{ padding: '6px 10px', borderBottom: '1px solid #eee', fontSize: '11px' }}>{line.flight}</td>
                              <td style={{ padding: '6px 10px', borderBottom: '1px solid #eee', fontSize: '11px' }}>{line.awb_number}</td>
                              <td style={{ padding: '6px 10px', borderBottom: '1px solid #eee', fontSize: '11px', textAlign: 'right' }}>{fmtNum(line.pieces)}</td>
                              <td style={{ padding: '6px 10px', borderBottom: '1px solid #eee', fontSize: '11px', textAlign: 'right' }}>{fmtNum(line.weight)}</td>
                              <td style={{ padding: '6px 10px', borderBottom: '1px solid #eee', fontSize: '11px' }}>{line.date}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr style={{ fontWeight: 700, borderTop: '2px solid #cbd5e0' }}>
                            <td colSpan={3} style={{ padding: '8px 10px', fontSize: '11px' }}>TOTAL</td>
                            <td style={{ padding: '8px 10px', fontSize: '11px', textAlign: 'right' }}>
                              {fmtNum(groupLines.reduce((s, l) => s + l.pieces, 0))}
                            </td>
                            <td style={{ padding: '8px 10px', fontSize: '11px', textAlign: 'right' }}>
                              {fmtNum(groupLines.reduce((s, l) => s + l.weight, 0))}
                            </td>
                            <td />
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  ))
                })()}
              </div>
            </div>
          </div>
        )
      })()}
    </Layout>
  )
}

// ── Cross Check AWB Table ──────────────────────────────────────────────────

function CrossCheckTable({ rows }: { rows: any[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-gray-50 text-gray-600">
            <th className="px-3 py-2 text-left">Flight #</th>
            <th className="px-3 py-2 text-left">AWB 1st Leg</th>
            <th className="px-3 py-2 text-left">AWB 2nd Leg</th>
            <th className="px-3 py-2 text-left">ULD</th>
            <th className="px-3 py-2 text-right">PCS</th>
            <th className="px-3 py-2 text-right">CW</th>
            <th className="px-3 py-2 text-left">Pickup From</th>
            <th className="px-3 py-2 text-left">Deliver To</th>
            <th className="px-3 py-2 text-center">Dest</th>
            <th className="px-3 py-2 text-left">ETD</th>
            <th className="px-3 py-2 text-left">Cutoff</th>
            <th className="px-3 py-2 text-left">On Hand Date</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r: any, i: number) => (
            <tr key={i} className="border-t border-gray-100 hover:bg-gray-50/50">
              <td className="px-3 py-1.5 font-semibold">{r.flight}</td>
              <td className="px-3 py-1.5 font-mono">{r.awb1st}</td>
              <td className="px-3 py-1.5 font-mono text-gray-500">{r.awb2nd}</td>
              <td className="px-3 py-1.5">{r.uld}</td>
              <td className="px-3 py-1.5 text-right">{r.pcs}</td>
              <td className="px-3 py-1.5 text-right">{r.cw}</td>
              <td className="px-3 py-1.5">{r.pickupFrom}</td>
              <td className="px-3 py-1.5">{r.deliverTo}</td>
              <td className="px-3 py-1.5 text-center">{r.dest}</td>
              <td className="px-3 py-1.5">{(r.etd || '').slice(0, 10)}</td>
              <td className="px-3 py-1.5">{(r.cutoff || '').slice(0, 16)}</td>
              <td className="px-3 py-1.5">{r.onHandDate}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
