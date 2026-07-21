import { db } from './firebase'
import {
  collection, getDocs, doc, getDoc, addDoc, query, where,
  writeBatch, runTransaction, updateDoc,
} from 'firebase/firestore'
import type {
  AirBillingCharge, AirCargoType, AirfreightClient, AirfreightClientBilling,
  AirfreightBooking, AwbSecondLeg, AirRateSchedule, BillingReviewDetail,
} from '../types'

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Strip noise prefixes and expand known abbreviations for airline matching */
function normalizeAirline(name: string): string {
  let n = name.toUpperCase().trim()
  // Remove common prefixes: "AGI - BUP", "AGI-BUP", "AGI BUP"
  n = n.replace(/^(AGI[\s\-]*BUP)[\s\-]+/, '')
  // Remove BUP/LOOSE/PAX/CAO/ARG tags anywhere
  n = n.replace(/[\s\-]*(BUP|LOOSE|PAX|CAO|ARG)[\s\-]*/g, ' ')
  // Expand known abbreviations
  n = n.replace(/\bAER\b/g, 'AEROLINEAS')
  // Remove dashes, collapse whitespace
  n = n.replace(/[\-]+/g, ' ').replace(/\s+/g, ' ')
  return n.trim()
}

/** Check if two airline names refer to the same airline */
function airlineMatches(a: string, b: string): boolean {
  const na = normalizeAirline(a)
  const nb = normalizeAirline(b)
  return na.includes(nb) || nb.includes(na)
}

export function determineCargoType(awbLine: AwbSecondLeg): AirCargoType {
  const uld = (awbLine.uld_type || '').trim().toUpperCase()
  if (uld && uld !== 'LOOSE') return 'BUP'
  return 'LOOSE'
}

/**
 * Detect whether "deliver_to" points to an airline (vs a physical address).
 * If deliver_to is empty → assume airline delivery.
 * If deliver_to looks like a physical address → NOT airline.
 * If deliver_to matches airline name or known keywords → airline.
 */
export function isDeliverToAirline(
  deliverTo: string | undefined,
  bookingAirline: string | undefined,
): boolean {
  // No deliver_to specified → assume airline delivery
  if (!deliverTo || !deliverTo.trim()) return true

  const dt = deliverTo.toUpperCase().trim()

  // Detect physical address patterns (numbers + street keywords)
  const addressPatterns = /\d+\s+(NW|NE|SW|SE|N|S|E|W)\s+|AVE|AVENUE|STREET|ST\b|BLVD|DRIVE|DR\b|ROAD|RD\b|LANE|LN\b|WAY|COURT|CT\b|WAREHOUSE|BLDG|SUITE|STE\b|FLOOR|FL\s+\d|#\d/i
  if (addressPatterns.test(dt)) return false

  // If booking has an airline, check if deliver_to contains the airline name
  if (bookingAirline) {
    const alNorm = normalizeAirline(bookingAirline)
    // Extract first word of airline (e.g., "AVIANCA" from "AVIANCA - PAX")
    const alFirst = alNorm.split(/[\s\-]+/)[0]
    if (alFirst.length >= 3 && normalizeAirline(dt).includes(alFirst)) return true
  }

  // Known airline keywords in deliver_to
  const airlineKeywords = ['AVIANCA', 'LATAM', 'AMERICAN AIRLINES', 'COPA', 'ATLAS AIR', 'POLAR AIR', 'ABX AIR', 'SKY LEASE', 'MASAIR', 'EMIRATES', 'TURKISH', 'QATAR', 'AIR FRANCE', 'KLM', 'LUFTHANSA', 'DHL', 'FEDEX', 'UPS', 'AEROLINEAS']
  if (airlineKeywords.some(kw => dt.includes(kw))) return true

  // If it doesn't match any airline pattern → assume address delivery
  return false
}

// ── Load client with billing config ─────────────────────────────────────────

export async function loadClient(clientId: string): Promise<(AirfreightClient & { id: string }) | null> {
  const snap = await getDoc(doc(db, 'airfreight_clients', clientId))
  if (!snap.exists()) return null
  return { id: snap.id, ...snap.data() } as AirfreightClient & { id: string }
}

// ── Resolve ALL-IN rate ─────────────────────────────────────────────────────

function resolveAllInRate(
  b: AirfreightClientBilling,
  airline: string,
): number {
  // Flat rate overrides composition (e.g., Merflex $0.17)
  if (b.all_in_flat_rate != null && b.all_in_flat_rate > 0) {
    return b.all_in_flat_rate
  }

  // Compose: Handling BUP + Screening + Drop Off BUP
  let handlingBup = b.handling_bup_rate || 0
  const override = (b.handling_bup_overrides || []).find(o =>
    airlineMatches(airline, o.airline)
  )
  if (override) handlingBup = override.rate
  return handlingBup + (b.screening_rate || 0) + (b.drop_off_bup_rate || 0)
}

// ── Calculate charges on dispatch ───────────────────────────────────────────

export async function calculateAirfreightCharges(
  booking: AirfreightBooking,
  awbLine: AwbSecondLeg | null,
  awbIndex: number | null,
  dispatchedAt: string,
  userEmail: string,
): Promise<void> {
  const client = await loadClient(booking.client_id)
  if (!client?.billing?.auto_charges_enabled) return

  const b = client.billing
  const isPerAwb = awbLine !== null && awbIndex !== null
  const billingUnitId = isPerAwb ? `${booking.id}__${awbIndex}` : booking.id!
  const cargoType: AirCargoType = awbLine ? determineCargoType(awbLine) : 'LOOSE'
  const useGross = b.billing_weight_source === 'gross'
  const cw = awbLine
    ? (useGross ? awbLine.weight : awbLine.chargeable_weight) || 0
    : (useGross ? (booking.weight || 0) : (booking.chargeable_weight || 0))
  const pieces = awbLine ? awbLine.pieces : (booking.pieces || 0)
  const weight = awbLine ? awbLine.weight : (booking.weight || 0)
  const airline = booking.airline || ''

  // Detect deliver_to scenario — check both deliver_to AND airline fields for address patterns
  const toAirline = isDeliverToAirline(booking.deliver_to || airline, airline)

  const base = {
    booking_id: booking.id!,
    flight_id: booking.flight_id,
    awb_index: awbIndex,
    billing_unit_id: billingUnitId,
    scope: 'awb' as const,
    awb_1st_leg: awbLine?.awb_number || booking.awb_1st_leg || null,
    awb_2nd_leg: awbLine?.awb_2nd_leg || booking.awb_2nd_leg || null,
    mawb_number: booking.mawb_number || null,
    booking_type: booking.booking_type,
    cargo_type: cargoType,
    pieces,
    weight,
    chargeable_weight: cw,
    client_id: booking.client_id,
    client_name: booking.client_name,
    airline,
    flight_number: booking.flight_number || '',
    source: 'auto' as const,
    added_by: userEmail,
    rate_id: null,
    invoice_id: null,
    status: 'pending' as const,
    dispatched_at: dispatchedAt,
    created_at: new Date().toISOString(),
    created_by: userEmail,
    currency: 'USD',
    minimum_charge_applied: false,
  }

  const charges: Omit<AirBillingCharge, 'id'>[] = []

  // ALL-IN vs Handling Loose / Drop Off Loose are mutually exclusive:
  //   - ALL-IN fires when deliver_to = airline OR flat rate is set
  //   - Handling Loose + Drop Off Loose fire ONLY when deliver_to = address AND no flat rate
  const hasAllIn = toAirline || (b.all_in_flat_rate != null && b.all_in_flat_rate > 0)

  // 1. ALL-IN (Handling BUP + Screening + Drop Off BUP)
  if (hasAllIn) {
    const allInRate = resolveAllInRate(b, airline)
    if (allInRate > 0) {
      charges.push({
        ...base,
        charge_name: 'BUILD UP + K9 SCREENING + DROP OFF',
        description: 'BUILD UP + K9 SCREENING + DROP OFF',
        unit: 'KG',
        qty: cw,
        rate: allInRate,
        total: cw * allInRate,
      })
    }
  }

  // 2. Handling Loose — deliver to address, NO flat rate (separate line)
  if (!hasAllIn && b.handling_loose_enabled && (b.handling_loose_rate || 0) > 0) {
    charges.push({
      ...base,
      charge_name: 'HANDLING LOOSE',
      description: 'HANDLING LOOSE',
      unit: 'KG',
      qty: cw,
      rate: b.handling_loose_rate!,
      total: cw * b.handling_loose_rate!,
    })
  }

  // 3. Drop Off Loose — deliver to address, NO flat rate (separate line)
  if (!hasAllIn && b.drop_off_loose_enabled && (b.drop_off_loose_rate || 0) > 0) {
    charges.push({
      ...base,
      charge_name: 'DROP OFF LOOSE',
      description: 'DROP OFF LOOSE',
      unit: 'KG',
      qty: cw,
      rate: b.drop_off_loose_rate!,
      total: cw * b.drop_off_loose_rate!,
    })
  }

  // 4. Pick Up Loose — ALL LOOSE cargo (accounting can delete if client self-delivered)
  if (b.pickup_loose_enabled && cargoType === 'LOOSE' && (b.pickup_loose_rate || 0) > 0) {
    charges.push({
      ...base,
      charge_name: 'PICK UP',
      description: 'PICK UP',
      unit: 'KG',
      qty: cw,
      rate: b.pickup_loose_rate!,
      total: cw * b.pickup_loose_rate!,
    })
  }

  // 5. BUP Pick Up — BUP cargo, flat per AWB (independent of deliver_to)
  if (b.bup_pickup_enabled && cargoType === 'BUP' && (b.bup_pickup_rate || 0) > 0) {
    charges.push({
      ...base,
      charge_name: 'PICK UP - BUP',
      description: 'PICK UP - BUP',
      unit: 'QTY',
      qty: 1,
      rate: b.bup_pickup_rate!,
      total: b.bup_pickup_rate!,
    })
  }

  // 6. Breakdown — BUP cargo (independent of deliver_to)
  if (b.breakdown_enabled && cargoType === 'BUP' && (b.breakdown_rate || 0) > 0) {
    charges.push({
      ...base,
      charge_name: 'BREAKDOWN',
      description: 'BREAKDOWN',
      unit: 'KG',
      qty: cw,
      rate: b.breakdown_rate!,
      total: cw * b.breakdown_rate!,
    })
  }

  // 7. Wooden Pallets — LOOSE cargo (independent of deliver_to)
  if (b.wooden_pallets_enabled && cargoType === 'LOOSE' && (b.wooden_pallet_rate || 0) > 0) {
    const palletQty = Math.round(pieces / 16)
    if (palletQty > 0) {
      charges.push({
        ...base,
        charge_name: 'WOODEN PALLET',
        description: 'WOODEN PALLET',
        unit: 'QTY',
        qty: palletQty,
        rate: b.wooden_pallet_rate!,
        total: palletQty * b.wooden_pallet_rate!,
      })
    }
  }

  // 8. Build Up Wooden Pallets — specific airlines only (independent of deliver_to/cargo)
  if (
    b.buildup_wp_enabled &&
    (b.buildup_wp_rate || 0) > 0 &&
    (b.buildup_wp_airlines || []).some(a => airlineMatches(airline, a))
  ) {
    const divisor = b.buildup_wp_divisor || 1500
    const multiplier = b.buildup_wp_multiplier || 4
    const bupPalletQty = Math.round((cw / divisor) * multiplier)
    if (bupPalletQty > 0) {
      charges.push({
        ...base,
        charge_name: 'BUILD UP WOODEN PALLET',
        description: 'BUILD UP WOODEN PALLET',
        unit: 'QTY',
        qty: bupPalletQty,
        rate: b.buildup_wp_rate!,
        total: bupPalletQty * b.buildup_wp_rate!,
      })
    }
  }

  // Write all charges in batches (max 500 per Firestore batch)
  const colRef = collection(db, 'air_billing_charges')
  for (let i = 0; i < charges.length; i += 500) {
    const batch = writeBatch(db)
    const slice = charges.slice(i, i + 500)
    for (const charge of slice) {
      batch.set(doc(colRef), charge)
    }
    await batch.commit()
  }
  console.info('BILLING_BATCH', { collection: 'air_billing_charges', count: charges.length, success: true })
}

// ── Add manual charge (agent assigns service + qty; accounting fills rate) ───

export async function addManualAirCharge(opts: {
  booking: AirfreightBooking
  awbLine: AwbSecondLeg | null
  awbIndex: number | null
  scope: 'awb' | 'flight'
  serviceName: string
  qty: number
  userEmail: string
  rateSchedules?: AirRateSchedule[]
}): Promise<string> {
  const { booking, awbLine, awbIndex, scope, serviceName, qty, userEmail, rateSchedules } = opts
  const billingUnitId = awbIndex !== null ? `${booking.id}__${awbIndex}` : booking.id!
  const cargoType: AirCargoType = awbLine ? determineCargoType(awbLine) : 'LOOSE'
  // Check client billing weight source
  const client = await loadClient(booking.client_id)
  const useGross = client?.billing?.billing_weight_source === 'gross'
  // For flight-level charges on ecommerce bookings, sum weight from all AWB lines
  let cw = awbLine
    ? (useGross ? awbLine.weight : awbLine.chargeable_weight) || 0
    : (useGross ? (booking.weight || 0) : (booking.chargeable_weight || 0))
  if (!cw && scope === 'flight' && booking.awb_lines?.length) {
    cw = (booking.awb_lines as AwbSecondLeg[]).reduce((s, l) => s + ((useGross ? l.weight : l.chargeable_weight) || 0), 0)
  }

  // Auto-resolve rate from rate schedule
  const schedule = (rateSchedules || []).find(r => r.name === serviceName && r.active)
  let rate = 0
  let unit = ''
  let resolvedQty = qty
  let total = 0
  let minimumApplied = false

  if (schedule) {
    rate = schedule.price || 0
    unit = schedule.unit || ''
    // For per_kg services, qty = chargeable weight
    if (unit === 'per_kg') {
      resolvedQty = cw
    }
    total = resolvedQty * rate
    // Apply minimum charge if configured
    if (schedule.minimum_charge && total > 0 && total < schedule.minimum_charge) {
      total = schedule.minimum_charge
      minimumApplied = true
    }
  }

  const charge: Omit<AirBillingCharge, 'id'> = {
    booking_id: booking.id!,
    flight_id: booking.flight_id,
    awb_index: awbIndex,
    billing_unit_id: billingUnitId,
    scope,
    awb_1st_leg: awbLine?.awb_number || booking.awb_1st_leg || null,
    awb_2nd_leg: awbLine?.awb_2nd_leg || booking.awb_2nd_leg || null,
    mawb_number: booking.mawb_number || null,
    booking_type: booking.booking_type,
    cargo_type: cargoType,
    pieces: awbLine ? awbLine.pieces : (booking.pieces || 0),
    weight: awbLine ? awbLine.weight : (booking.weight || 0),
    chargeable_weight: cw,
    charge_name: serviceName,
    description: serviceName,
    unit,
    qty: resolvedQty,
    rate,
    total,
    currency: 'USD',
    minimum_charge_applied: minimumApplied,
    client_id: booking.client_id,
    client_name: booking.client_name,
    airline: booking.airline || '',
    flight_number: booking.flight_number || '',
    source: 'manual',
    added_by: userEmail,
    rate_id: schedule?.id || null,
    invoice_id: null,
    status: 'pending',
    dispatched_at: null,
    created_at: new Date().toISOString(),
    created_by: userEmail,
  }

  const ref = await addDoc(collection(db, 'air_billing_charges'), charge)
  return ref.id
}

// ── Delete a manual charge ──────────────────────────────────────────────────

export async function deleteManualAirCharge(chargeId: string, userEmail: string, isAccounting: boolean): Promise<void> {
  const snap = await getDoc(doc(db, 'air_billing_charges', chargeId))
  if (!snap.exists()) return
  const charge = snap.data() as AirBillingCharge
  if (charge.source !== 'manual') throw new Error('Solo se pueden eliminar cargos manuales')
  if (charge.status !== 'pending') throw new Error('Solo se pueden eliminar cargos pendientes')
  if (!isAccounting && charge.added_by !== userEmail) throw new Error('Solo puedes eliminar cargos que tu agregaste')
  const batch = writeBatch(db)
  batch.delete(snap.ref)
  await batch.commit()
}

// ── Update charge (accounting only) ─────────────────────────────────────────

export async function updateAirCharge(chargeId: string, updates: {
  rate?: number
  qty?: number
  unit?: string
  chargeable_weight?: number
}): Promise<void> {
  const snap = await getDoc(doc(db, 'air_billing_charges', chargeId))
  if (!snap.exists()) return
  const current = snap.data() as AirBillingCharge
  if (current.status !== 'pending') throw new Error('Solo se pueden editar cargos pendientes')

  const newRate = updates.rate ?? current.rate
  const newQty = updates.qty ?? current.qty
  const patch: Record<string, unknown> = {}
  if (updates.rate !== undefined) patch.rate = updates.rate
  if (updates.qty !== undefined) patch.qty = updates.qty
  if (updates.unit !== undefined) patch.unit = updates.unit
  if (updates.chargeable_weight !== undefined) patch.chargeable_weight = updates.chargeable_weight
  patch.total = newQty * newRate

  await updateDoc(doc(db, 'air_billing_charges', chargeId), patch)
}

// ── Load charges for a flight+client ────────────────────────────────────────

export async function loadChargesForFlight(
  clientId: string,
  flightId: string,
): Promise<AirBillingCharge[]> {
  const snap = await getDocs(
    query(
      collection(db, 'air_billing_charges'),
      where('client_id', '==', clientId),
      where('flight_id', '==', flightId),
    )
  )
  return snap.docs.map(d => ({ id: d.id, ...d.data() })) as AirBillingCharge[]
}

// ── Load manual charges for a booking ───────────────────────────────────────

export async function loadManualChargesForBooking(bookingId: string): Promise<AirBillingCharge[]> {
  const snap = await getDocs(
    query(
      collection(db, 'air_billing_charges'),
      where('booking_id', '==', bookingId),
      where('source', '==', 'manual'),
      where('status', '==', 'pending'),
    )
  )
  return snap.docs.map(d => ({ id: d.id, ...d.data() })) as AirBillingCharge[]
}

// ── Load rate schedule (manual service catalog) ─────────────────────────────

export async function loadRateSchedule(): Promise<AirRateSchedule[]> {
  const snap = await getDocs(collection(db, 'air_rate_schedule'))
  return snap.docs.map(d => ({ id: d.id, ...d.data() })) as AirRateSchedule[]
}

// ── Undo dispatch charges (auto only) ───────────────────────────────────────

export async function undoDispatchCharges(billingUnitId: string): Promise<void> {
  const snap = await getDocs(
    query(
      collection(db, 'air_billing_charges'),
      where('billing_unit_id', '==', billingUnitId),
      where('source', '==', 'auto'),
      where('status', '==', 'pending'),
    )
  )
  if (snap.empty) return
  const batch = writeBatch(db)
  snap.docs.forEach(d => batch.delete(d.ref))
  await batch.commit()
}

// ── Undo ALL auto charges for an entire flight (used when reopening) ────────

export async function undoDispatchChargesForFlight(flightId: string): Promise<void> {
  const snap = await getDocs(
    query(
      collection(db, 'air_billing_charges'),
      where('flight_id', '==', flightId),
      where('source', '==', 'auto'),
      where('status', '==', 'pending'),
    )
  )
  if (snap.empty) return
  // Firestore batch limit is 500
  const docs = snap.docs
  for (let i = 0; i < docs.length; i += 500) {
    const batch = writeBatch(db)
    docs.slice(i, i + 500).forEach(d => batch.delete(d.ref))
    await batch.commit()
  }
}

// ── Recalculate auto charges for a flight+client (without re-dispatching) ──

export async function recalculateAutoCharges(
  flightId: string,
  clientId: string,
  userEmail: string,
): Promise<number> {
  // 1. Delete existing auto pending charges for this flight+client
  const existingSnap = await getDocs(
    query(
      collection(db, 'air_billing_charges'),
      where('flight_id', '==', flightId),
      where('client_id', '==', clientId),
      where('source', '==', 'auto'),
      where('status', '==', 'pending'),
    )
  )
  if (!existingSnap.empty) {
    for (let i = 0; i < existingSnap.docs.length; i += 500) {
      const batch = writeBatch(db)
      existingSnap.docs.slice(i, i + 500).forEach(d => batch.delete(d.ref))
      await batch.commit()
    }
  }

  // 2. Re-calculate from current booking data + current client billing config
  const bSnap = await getDocs(
    query(collection(db, 'airfreight_bookings'), where('flight_id', '==', flightId), where('client_id', '==', clientId))
  )
  // SOL-11: Parallelize billing calculations
  const now = new Date().toISOString()
  const tasks: Promise<void>[] = []
  for (const bDoc of bSnap.docs) {
    const booking = { id: bDoc.id, ...bDoc.data() } as AirfreightBooking & { id: string }
    const lines = (booking.awb_lines || []) as AwbSecondLeg[]
    if (booking.booking_type === 'simple') {
      tasks.push(calculateAirfreightCharges(booking, null, null, now, userEmail))
    } else if (booking.booking_type === 'mawb') {
      const totalCw = lines.reduce((s, l) => s + (l.chargeable_weight || 0), 0)
      const totalGw = lines.reduce((s, l) => s + (l.weight || 0), 0)
      tasks.push(calculateAirfreightCharges({ ...booking, chargeable_weight: totalCw, weight: totalGw }, null, null, now, userEmail))
    } else {
      for (let i = 0; i < lines.length; i++) {
        tasks.push(calculateAirfreightCharges(booking, lines[i], i, now, userEmail))
      }
    }
  }
  await Promise.all(tasks)
  return tasks.length
}

// ── Generate invoice number ─────────────────────────────────────────────────

async function getNextInvoiceNumber(): Promise<string> {
  const seqRef = doc(db, 'config', 'air_invoice_sequence')
  const num = await runTransaction(db, async (tx) => {
    const snap = await tx.get(seqRef)
    const last = snap.exists() ? (snap.data().last_num || 0) : 31030
    const next = last + 1
    tx.set(seqRef, { last_num: next })
    return next
  })
  return 'C' + String(num).padStart(10, '0')
}

// ── Generate invoice ────────────────────────────────────────────────────────

export async function generateAirInvoice(
  clientId: string,
  flightId: string,
  userEmail: string,
  adjustment?: {
    kind: 'discount' | 'surcharge' | null
    calc: 'percent' | 'amount' | null
    value: number
    note: string
  },
  invoiceNote?: string,
): Promise<string | null> {
  const chargesSnap = await getDocs(
    query(
      collection(db, 'air_billing_charges'),
      where('client_id', '==', clientId),
      where('flight_id', '==', flightId),
      where('status', '==', 'pending'),
    )
  )
  if (chargesSnap.empty) return null

  const charges = chargesSnap.docs.map(d => ({ id: d.id, ...d.data() })) as AirBillingCharge[]
  const subtotal = charges.reduce((s, c) => s + c.total, 0)

  let adjustmentAmount = 0
  if (adjustment?.kind && adjustment.calc && adjustment.value) {
    if (adjustment.calc === 'percent') {
      adjustmentAmount = subtotal * (adjustment.value / 100)
    } else {
      adjustmentAmount = adjustment.value
    }
    if (adjustment.kind === 'discount') adjustmentAmount = -Math.abs(adjustmentAmount)
    else adjustmentAmount = Math.abs(adjustmentAmount)
  }

  const total = subtotal + adjustmentAmount
  const invoiceNumber = await getNextInvoiceNumber()

  const client = await loadClient(clientId)
  const b = client?.billing
  const firstCharge = charges[0]

  const isMawb = charges.some(c => c.booking_type === 'mawb')
  // Reference: MAWB → all unique MAWB numbers + flight; ecommerce/simple → flight number
  let reference = ''
  if (isMawb) {
    const mawbs = [...new Set(charges.map(c => c.mawb_number).filter(Boolean))]
    reference = `MAWB ${mawbs.join(' / ')} - ${firstCharge.airline} ${firstCharge.flight_number}`
  } else {
    reference = `${firstCharge.airline} ${firstCharge.flight_number}`
  }

  // Service date = earliest of flight ETD and first dispatch timestamp
  let serviceDate = new Date().toISOString().split('T')[0]
  try {
    const flightSnap = await getDoc(doc(db, 'airfreight_flights', flightId))
    if (flightSnap.exists()) {
      const flightData = flightSnap.data()
      const etd = (flightData.flight_datetime || '').split('T')[0]
      const dispatched = charges
        .map(c => (c.dispatched_at || '').split('T')[0])
        .filter(Boolean)
        .sort()[0]
      if (etd && dispatched) serviceDate = etd < dispatched ? etd : dispatched
      else if (etd) serviceDate = etd
      else if (dispatched) serviceDate = dispatched
    }
  } catch { /* fallback to today */ }

  const now = new Date().toISOString()
  const termsDays = b?.payment_terms_days || 30
  const dueDate = new Date(new Date(serviceDate).getTime() + termsDays * 86400000).toISOString().split('T')[0]

  const invoice = {
    invoice_number: invoiceNumber,
    client_id: clientId,
    client_name: firstCharge.client_name,
    flight_id: flightId,
    flight_number: firstCharge.flight_number,
    airline: firstCharge.airline,
    bill_to_name: b?.company_legal_name || firstCharge.client_name,
    bill_to_address: b?.billing_address || '',
    account_number: b?.account_number || '',
    reference,
    charge_ids: charges.map(c => c.id!),
    line_count: charges.length,
    subtotal,
    tax: 0,
    adjustment_kind: adjustment?.kind || null,
    adjustment_calc: adjustment?.calc || null,
    adjustment_value: adjustment?.value || 0,
    adjustment_amount: adjustmentAmount,
    adjustment_note: adjustment?.note || '',
    total,
    note: invoiceNote || null,
    currency: 'USD',
    date: serviceDate,
    due_date: dueDate,
    payment_terms_label: b?.payment_terms_label || `N${termsDays}`,
    status: 'generated' as const,
    pdf_url: null,
    sent_at: null,
    paid_at: null,
    created_at: now,
    created_by: userEmail,
  }

  const invRef = await addDoc(collection(db, 'air_invoices'), invoice)

  const batch = writeBatch(db)
  for (const c of charges) {
    batch.update(doc(db, 'air_billing_charges', c.id!), {
      invoice_id: invRef.id,
      status: 'invoiced',
    })
  }
  await batch.commit()

  return invRef.id
}

// ── Void invoice ────────────────────────────────────────────────────────────

export async function voidAirInvoice(invoiceId: string): Promise<void> {
  const invSnap = await getDoc(doc(db, 'air_invoices', invoiceId))
  if (!invSnap.exists()) return
  const inv = invSnap.data()
  await updateDoc(doc(db, 'air_invoices', invoiceId), { status: 'voided' })

  const chargeIds: string[] = inv.charge_ids || []
  const batch = writeBatch(db)
  for (const cid of chargeIds) {
    batch.update(doc(db, 'air_billing_charges', cid), { invoice_id: null, status: 'pending' })
  }
  await batch.commit()
}

// ── Unlock invoice for editing (keeps invoice number, charges go back to pending) ──

export async function unlockAirInvoice(invoiceId: string): Promise<void> {
  const invSnap = await getDoc(doc(db, 'air_invoices', invoiceId))
  if (!invSnap.exists()) return
  const inv = invSnap.data()
  await updateDoc(doc(db, 'air_invoices', invoiceId), { status: 'draft' })

  const chargeIds: string[] = inv.charge_ids || []
  const batch = writeBatch(db)
  for (const cid of chargeIds) {
    batch.update(doc(db, 'air_billing_charges', cid), { invoice_id: null, status: 'pending' })
  }
  await batch.commit()
}

// ── Re-seal a draft invoice: recalculate from current pending charges ────────

export async function resealAirInvoice(
  invoiceId: string,
  clientId: string,
  flightId: string,
  userEmail: string,
): Promise<void> {
  const chargesSnap = await getDocs(
    query(
      collection(db, 'air_billing_charges'),
      where('client_id', '==', clientId),
      where('flight_id', '==', flightId),
      where('status', '==', 'pending'),
    )
  )
  const charges = chargesSnap.docs.map(d => ({ id: d.id, ...d.data() })) as AirBillingCharge[]
  const subtotal = charges.reduce((s, c) => s + c.total, 0)

  const batch = writeBatch(db)
  for (const c of charges) {
    batch.update(doc(db, 'air_billing_charges', c.id!), { invoice_id: invoiceId, status: 'invoiced' })
  }

  batch.update(doc(db, 'air_invoices', invoiceId), {
    charge_ids: charges.map(c => c.id!),
    line_count: charges.length,
    subtotal,
    total: subtotal,
    adjustment_kind: null,
    adjustment_calc: null,
    adjustment_value: 0,
    adjustment_amount: 0,
    adjustment_note: '',
    status: 'generated',
  })

  await batch.commit()
}

// ── Check if invoices need review after re-dispatch ─────────────────────────

export async function checkBillingReviewNeeded(
  flightId: string,
  bookings: (AirfreightBooking & { id: string })[],
): Promise<{ invoiceId: string; details: BillingReviewDetail[] }[]> {
  // Find non-voided invoices for this flight
  const invSnap = await getDocs(
    query(collection(db, 'air_invoices'), where('flight_id', '==', flightId))
  )
  const invoices = invSnap.docs
    .map(d => ({ id: d.id, ...d.data() } as any))
    .filter((inv: any) => inv.status !== 'voided')

  if (invoices.length === 0) return []

  // Load current charges for this flight
  const chgSnap = await getDocs(
    query(collection(db, 'air_billing_charges'), where('flight_id', '==', flightId))
  )
  const currentCharges = chgSnap.docs.map(d => ({ id: d.id, ...d.data() })) as AirBillingCharge[]

  const results: { invoiceId: string; details: BillingReviewDetail[] }[] = []

  for (const inv of invoices) {
    const details: BillingReviewDetail[] = []
    const invoicedChargeIds = new Set<string>(inv.charge_ids || [])

    // Find bookings for this client
    const clientBookings = bookings.filter(b => b.client_id === inv.client_id)

    // 1. Check CW/pieces changes: compare invoiced charges vs current AWB data
    for (const booking of clientBookings) {
      const lines = (booking.awb_lines || []) as AwbSecondLeg[]
      const isMawb = booking.booking_type === 'mawb'

      if (booking.booking_type === 'simple') {
        const invoicedCharge = currentCharges.find(
          c => c.booking_id === booking.id && invoicedChargeIds.has(c.id!) && c.source === 'auto'
        )
        if (invoicedCharge) {
          const currentCw = (booking as any).chargeable_weight || 0
          if (Math.abs(invoicedCharge.chargeable_weight - currentCw) > 0.01) {
            details.push({
              type: 'cw_changed',
              awb_number: (booking as any).awb_2nd_leg || (booking as any).awb_1st_leg || booking.id,
              old_value: invoicedCharge.chargeable_weight,
              new_value: currentCw,
              description: `AWB ${(booking as any).awb_2nd_leg || ''}: CW cambio de ${invoicedCharge.chargeable_weight} a ${currentCw} kg`,
            })
          }
          const currentPcs = (booking as any).pieces || 0
          if (Math.abs(invoicedCharge.pieces - currentPcs) > 0.01) {
            details.push({
              type: 'pieces_changed',
              awb_number: (booking as any).awb_2nd_leg || (booking as any).awb_1st_leg || booking.id,
              old_value: invoicedCharge.pieces,
              new_value: currentPcs,
              description: `AWB ${(booking as any).awb_2nd_leg || ''}: Piezas cambio de ${invoicedCharge.pieces} a ${currentPcs}`,
            })
          }
        }
      } else if (isMawb) {
        const currentTotalCw = lines.reduce((s, l) => s + (l.chargeable_weight || 0), 0)
        const invoicedCharge = currentCharges.find(
          c => c.booking_id === booking.id && invoicedChargeIds.has(c.id!) && c.source === 'auto'
        )
        if (invoicedCharge && Math.abs(invoicedCharge.chargeable_weight - currentTotalCw) > 0.01) {
          details.push({
            type: 'cw_changed',
            awb_number: booking.mawb_number || booking.id,
            old_value: invoicedCharge.chargeable_weight,
            new_value: currentTotalCw,
            description: `MAWB ${booking.mawb_number || ''}: CW cambio de ${invoicedCharge.chargeable_weight} a ${currentTotalCw} kg`,
          })
        }
      } else {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          const buid = `${booking.id}__${i}`
          const invoicedCharge = currentCharges.find(
            c => c.billing_unit_id === buid && invoicedChargeIds.has(c.id!) && c.source === 'auto'
          )
          if (invoicedCharge) {
            if (Math.abs(invoicedCharge.chargeable_weight - (line.chargeable_weight || 0)) > 0.01) {
              details.push({
                type: 'cw_changed',
                awb_number: line.awb_2nd_leg || line.awb_number || buid,
                billing_unit_id: buid,
                old_value: invoicedCharge.chargeable_weight,
                new_value: line.chargeable_weight || 0,
                description: `AWB ${line.awb_2nd_leg || line.awb_number || ''}: CW cambio de ${invoicedCharge.chargeable_weight} a ${line.chargeable_weight || 0} kg`,
              })
            }
            if (Math.abs(invoicedCharge.pieces - (line.pieces || 0)) > 0.01) {
              details.push({
                type: 'pieces_changed',
                awb_number: line.awb_2nd_leg || line.awb_number || buid,
                billing_unit_id: buid,
                old_value: invoicedCharge.pieces,
                new_value: line.pieces || 0,
                description: `AWB ${line.awb_2nd_leg || line.awb_number || ''}: Piezas cambio de ${invoicedCharge.pieces} a ${line.pieces || 0}`,
              })
            }
          }
        }
      }
    }

    // 2. Check for new manual charges not in the invoice
    const newManual = currentCharges.filter(
      c => c.client_id === inv.client_id && c.source === 'manual' && c.status === 'pending' && !invoicedChargeIds.has(c.id!)
    )
    for (const mc of newManual) {
      details.push({
        type: 'new_manual_charge',
        charge_name: mc.charge_name,
        awb_number: mc.awb_1st_leg || mc.awb_2nd_leg || undefined,
        description: `Cargo manual nuevo: ${mc.charge_name} (${mc.qty} × $${mc.rate})`,
      })
    }

    // 3. Check if auto charges were recalculated (new auto charges not in invoice)
    const newAuto = currentCharges.filter(
      c => c.client_id === inv.client_id && c.source === 'auto' && c.status === 'pending' && !invoicedChargeIds.has(c.id!)
    )
    if (newAuto.length > 0) {
      const newTotal = newAuto.reduce((s, c) => s + c.total, 0)
      const oldAutoTotal = currentCharges
        .filter(c => invoicedChargeIds.has(c.id!) && c.source === 'auto')
        .reduce((s, c) => s + c.total, 0)
      details.push({
        type: 'charges_recalculated',
        old_value: oldAutoTotal,
        new_value: newTotal,
        description: `Cargos auto recalculados: total anterior $${oldAutoTotal.toFixed(2)} → nuevo $${newTotal.toFixed(2)}`,
      })
    }

    if (details.length > 0) {
      results.push({ invoiceId: inv.id, details })
    }
  }

  return results
}

// ── Flag invoice for review ─────────────────────────────────────────────────

export async function flagInvoiceForReview(
  invoiceId: string,
  details: BillingReviewDetail[],
): Promise<void> {
  await updateDoc(doc(db, 'air_invoices', invoiceId), {
    billing_review_needed: true,
    billing_review_details: details,
  })
}

// ── Dismiss billing review ──────────────────────────────────────────────────

export async function dismissBillingReview(
  invoiceId: string,
  userEmail: string,
): Promise<void> {
  await updateDoc(doc(db, 'air_invoices', invoiceId), {
    billing_review_needed: false,
    billing_review_dismissed_by: userEmail,
    billing_review_dismissed_at: new Date().toISOString(),
  })
}
