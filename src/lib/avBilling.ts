import { doc, getDoc, setDoc, addDoc, collection, query, where, getDocs, runTransaction } from 'firebase/firestore'
import { db } from './firebase'
import type { AvBillingConfig, AvBracket, AvInvoice, AvFlight, AvFlightAwb } from '../types'

// ── Config ────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: AvBillingConfig = {
  mode: 'flat',
  flat_rate: 0.20,
  brackets: [
    { min_kg: 0, max_kg: 600000, rate_per_kg: 0.195 },
    { min_kg: 600000, max_kg: 800000, rate_per_kg: 0.185 },
    { min_kg: 800000, max_kg: 1000000, rate_per_kg: 0.175 },
    { min_kg: 1000000, max_kg: 999999999, rate_per_kg: 0.165 },
  ],
  updated_at: '',
  updated_by: '',
}

export async function getAvBillingConfig(): Promise<AvBillingConfig> {
  const snap = await getDoc(doc(db, 'av_billing_config', 'default'))
  if (snap.exists()) return snap.data() as AvBillingConfig
  return DEFAULT_CONFIG
}

export async function saveAvBillingConfig(config: AvBillingConfig): Promise<void> {
  await setDoc(doc(db, 'av_billing_config', 'default'), config)
}

// ── Invoice Sequence ──────────────────────────────────────────────────────────

async function getNextAvInvoiceNumber(): Promise<string> {
  const seqRef = doc(db, 'config', 'av_invoice_sequence')
  const next = await runTransaction(db, async (tx) => {
    const snap = await tx.get(seqRef)
    const last = snap.exists() ? (snap.data().last_num || 0) : 0
    const n = last + 1
    tx.set(seqRef, { last_num: n }, { merge: true })
    return n
  })
  return `AV-INV-${String(next).padStart(5, '0')}`
}

// ── Bracket Calculation ───────────────────────────────────────────────────────

export function calculateBrackets(totalKg: number, brackets: AvBracket[]): { bracket_label: string; kg_in_bracket: number; rate: number; subtotal: number }[] {
  const sorted = [...brackets].sort((a, b) => a.min_kg - b.min_kg)
  let remaining = totalKg
  const result: { bracket_label: string; kg_in_bracket: number; rate: number; subtotal: number }[] = []

  for (const b of sorted) {
    if (remaining <= 0) break
    const capacity = b.max_kg - b.min_kg
    const kgInBracket = Math.min(remaining, capacity)
    result.push({
      bracket_label: `${(b.min_kg / 1000).toFixed(0)}K - ${b.max_kg >= 999999999 ? '∞' : (b.max_kg / 1000).toFixed(0) + 'K'}`,
      kg_in_bracket: kgInBracket,
      rate: b.rate_per_kg,
      subtotal: Math.round(kgInBracket * b.rate_per_kg * 100) / 100,
    })
    remaining -= kgInBracket
  }

  return result
}

// ── Generate Flat Invoice (per flight) ────────────────────────────────────────

export async function generateFlatInvoice(flightId: string, userEmail: string): Promise<string> {
  const config = await getAvBillingConfig()

  // Check if invoice already exists for this flight
  const existingSnap = await getDocs(query(
    collection(db, 'av_invoices'),
    where('flight_id', '==', flightId),
    where('mode', '==', 'flat'),
  ))
  const activeInvoice = existingSnap.docs.find(d => (d.data() as AvInvoice).status !== 'void')
  if (activeInvoice) {
    throw new Error('Ya existe una factura activa para este vuelo')
  }

  // Load flight + AWBs
  const flightSnap = await getDoc(doc(db, 'av_flights', flightId))
  if (!flightSnap.exists()) throw new Error('Vuelo no encontrado')
  const flight = flightSnap.data() as AvFlight

  const awbSnap = await getDocs(query(collection(db, 'av_flight_awbs'), where('flight_id', '==', flightId)))
  const awbs = awbSnap.docs.map(d => d.data() as AvFlightAwb).sort((a, b) => a.awb_number.localeCompare(b.awb_number))

  if (awbs.length === 0) throw new Error('El vuelo no tiene AWBs')

  const rate = config.flat_rate
  const lines = awbs.map(a => ({
    flight_number: flight.flight_number,
    awb_number: a.awb_number,
    gross_weight_kg: a.gross_weight_kg,
    rate,
    total: Math.round(a.gross_weight_kg * rate * 100) / 100,
  }))

  const totalKg = lines.reduce((s, l) => s + l.gross_weight_kg, 0)
  const subtotal = lines.reduce((s, l) => s + l.total, 0)
  const now = new Date().toISOString()
  const invoiceNumber = await getNextAvInvoiceNumber()

  const invoice: Omit<AvInvoice, 'id'> = {
    invoice_number: invoiceNumber,
    mode: 'flat',
    flight_id: flightId,
    flight_number: flight.flight_number,
    flights: [{ flight_id: flightId, flight_number: flight.flight_number, date: flight.etd, total_kg: totalKg }],
    lines,
    total_kg: totalKg,
    subtotal: Math.round(subtotal * 100) / 100,
    bracket_breakdown: [],
    flat_rate: rate,
    total: Math.round(subtotal * 100) / 100,
    status: 'draft',
    date: now,
    created_at: now,
    created_by: userEmail,
  }

  const ref = await addDoc(collection(db, 'av_invoices'), invoice)
  return ref.id
}

// ── Generate Bracket Invoice (quincenal) ──────────────────────────────────────

export function getQuincenalPeriods(year: number, month: number): { label: string; start: string; end: string }[] {
  const m = String(month).padStart(2, '0')
  const lastDay = new Date(year, month, 0).getDate()
  return [
    { label: `${year}-${m}-Q1`, start: `${year}-${m}-01`, end: `${year}-${m}-15` },
    { label: `${year}-${m}-Q2`, start: `${year}-${m}-16`, end: `${year}-${m}-${lastDay}` },
  ]
}

export async function generateBracketInvoice(
  periodLabel: string,
  periodStart: string,
  periodEnd: string,
  userEmail: string,
): Promise<string> {
  const config = await getAvBillingConfig()
  if (config.mode !== 'brackets') throw new Error('Modo brackets no esta activo')

  // Check if invoice already exists
  const existingSnap = await getDocs(query(
    collection(db, 'av_invoices'),
    where('period', '==', periodLabel),
    where('mode', '==', 'brackets'),
  ))
  if (!existingSnap.empty) throw new Error(`Ya existe factura para el periodo ${periodLabel}`)

  // Load all flights in period
  const flightsSnap = await getDocs(collection(db, 'av_flights'))
  const allFlights = flightsSnap.docs.map(d => ({ id: d.id, ...d.data() } as AvFlight & { id: string }))
  const periodFlights = allFlights.filter(f => {
    const d = f.etd?.slice(0, 10) || ''
    return d >= periodStart && d <= periodEnd
  })

  if (periodFlights.length === 0) throw new Error('No hay vuelos en este periodo')

  // Load all AWBs for these flights
  const lines: AvInvoice['lines'] = []
  const flightSummaries: AvInvoice['flights'] = []

  for (const f of periodFlights) {
    const awbSnap = await getDocs(query(collection(db, 'av_flight_awbs'), where('flight_id', '==', f.id)))
    const awbs = awbSnap.docs.map(d => d.data() as AvFlightAwb).sort((a, b) => a.awb_number.localeCompare(b.awb_number))
    let flightKg = 0
    for (const a of awbs) {
      flightKg += a.gross_weight_kg
      lines.push({
        flight_number: f.flight_number,
        awb_number: a.awb_number,
        gross_weight_kg: a.gross_weight_kg,
        rate: 0, // will be calculated per bracket
        total: 0,
      })
    }
    flightSummaries.push({ flight_id: f.id, flight_number: f.flight_number, date: f.etd, total_kg: flightKg })
  }

  const totalKg = lines.reduce((s, l) => s + l.gross_weight_kg, 0)

  // Check for Q1 adjustment if this is Q2
  let adjustment = 0
  let adjustmentNote = ''
  const isQ2 = periodLabel.endsWith('-Q2')

  if (isQ2) {
    // Find Q1 invoice for same month
    const q1Label = periodLabel.replace('-Q2', '-Q1')
    const q1Snap = await getDocs(query(
      collection(db, 'av_invoices'),
      where('period', '==', q1Label),
      where('mode', '==', 'brackets'),
    ))
    if (!q1Snap.empty) {
      const q1Invoice = q1Snap.docs[0].data() as AvInvoice
      const q1Kg = q1Invoice.total_kg
      const monthTotalKg = q1Kg + totalKg

      // Recalculate what Q1 should have been with month total knowledge
      const monthBreakdown = calculateBrackets(monthTotalKg, config.brackets)
      const q1Recalc = calculateBrackets(q1Kg, config.brackets)

      // The difference between what Q1 was charged and what it should be
      // with the full month's brackets applied
      const q1OriginalTotal = q1Invoice.subtotal
      const q1RecalcTotal = q1Recalc.reduce((s, b) => s + b.subtotal, 0)

      // If month total pushes into lower brackets, Q1 might have been overcharged
      // But brackets are progressive (higher = cheaper), so more volume = some savings
      // Recalculate: distribute monthTotalKg across brackets, then Q1's share
      const fullMonthTotal = monthBreakdown.reduce((s, b) => s + b.subtotal, 0)
      const avgRate = fullMonthTotal / monthTotalKg
      const q1ShouldBe = Math.round(q1Kg * avgRate * 100) / 100

      if (Math.abs(q1ShouldBe - q1OriginalTotal) > 0.01) {
        adjustment = Math.round((q1ShouldBe - q1OriginalTotal) * 100) / 100
        adjustmentNote = `Ajuste Q1: ${q1Kg.toLocaleString()} kg recalculados con acumulado mensual ${monthTotalKg.toLocaleString()} kg`
      }
    }
  }

  // Calculate bracket breakdown for this period's kg
  // For Q2, use the cumulative month total for bracket placement
  let bracketBreakdown: AvInvoice['bracket_breakdown']
  let subtotal: number

  if (isQ2 && adjustment !== 0) {
    // Q2 with adjustment: calculate on cumulative, subtract Q1
    const q1Label = periodLabel.replace('-Q2', '-Q1')
    const q1Snap = await getDocs(query(collection(db, 'av_invoices'), where('period', '==', q1Label), where('mode', '==', 'brackets')))
    const q1Kg = q1Snap.empty ? 0 : (q1Snap.docs[0].data() as AvInvoice).total_kg
    const monthTotalKg = q1Kg + totalKg
    const monthBreakdown = calculateBrackets(monthTotalKg, config.brackets)
    const q1Breakdown = calculateBrackets(q1Kg, config.brackets)
    const monthTotal = monthBreakdown.reduce((s, b) => s + b.subtotal, 0)
    const q1Total = q1Breakdown.reduce((s, b) => s + b.subtotal, 0)
    subtotal = Math.round((monthTotal - q1Total) * 100) / 100
    bracketBreakdown = monthBreakdown
  } else {
    bracketBreakdown = calculateBrackets(totalKg, config.brackets)
    subtotal = Math.round(bracketBreakdown.reduce((s, b) => s + b.subtotal, 0) * 100) / 100
  }

  // Assign rates to lines (weighted average)
  const avgRate = totalKg > 0 ? subtotal / totalKg : 0
  for (const line of lines) {
    line.rate = Math.round(avgRate * 1000000) / 1000000
    line.total = Math.round(line.gross_weight_kg * avgRate * 100) / 100
  }

  const now = new Date()
  const dueDate = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000)
  const invoiceNumber = await getNextAvInvoiceNumber()

  const invoice: Omit<AvInvoice, 'id'> = {
    invoice_number: invoiceNumber,
    mode: 'brackets',
    period: periodLabel,
    period_start: periodStart,
    period_end: periodEnd,
    due_date: dueDate.toISOString().slice(0, 10),
    flights: flightSummaries,
    lines,
    total_kg: totalKg,
    subtotal,
    bracket_breakdown: bracketBreakdown,
    adjustment: adjustment || undefined,
    adjustment_note: adjustmentNote || undefined,
    total: Math.round((subtotal + adjustment) * 100) / 100,
    status: 'draft',
    date: now.toISOString(),
    created_at: now.toISOString(),
    created_by: userEmail,
  }

  const ref = await addDoc(collection(db, 'av_invoices'), invoice)
  return ref.id
}
