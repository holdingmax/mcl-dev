/**
 * WS Billing — automatic charge calculation using ws_rate_schedule + ws_client_rate_overrides
 */
import { collection, query, getDocs, where, orderBy } from 'firebase/firestore'
import { db } from './firebase'
import type { WSRateSchedule, WSClientRateOverride, WSServiceOrder } from '../types'

interface RateWithOverride extends WSRateSchedule {
  effectivePrice: number
  effectiveMin: number | null
}

// ── Load rates + client overrides, merge into effective rates ──
export async function loadEffectiveRates(clientId: string): Promise<RateWithOverride[]> {
  const ratesSnap = await getDocs(query(collection(db, 'ws_rate_schedule'), orderBy('sort_order')))
  const rates = ratesSnap.docs.map(d => ({ id: d.id, ...d.data() } as WSRateSchedule)).filter(r => r.active)

  const ovSnap = await getDocs(query(collection(db, 'ws_client_rate_overrides'), where('client_id', '==', clientId)))
  const ovMap: Record<string, WSClientRateOverride> = {}
  ovSnap.docs.forEach(d => { const o = { id: d.id, ...d.data() } as WSClientRateOverride; ovMap[o.rate_id] = o })

  return rates
    .filter(r => {
      const ov = ovMap[r.id!]
      if (ov && ov.active === false) return false // disabled for this client
      return true
    })
    .map(r => {
      const ov = ovMap[r.id!]
      return {
        ...r,
        effectivePrice: (ov?.price != null) ? ov.price : r.price,
        effectiveMin: (ov?.minimum_charge != null) ? ov.minimum_charge : r.minimum_charge,
      }
    })
}

// ── Find rate matching service_type + cargo_mode ──
function findRate(rates: RateWithOverride[], serviceType: string, cargoMode: string, unit?: string): RateWithOverride | null {
  // Prefer exact cargo_mode match, then fallback to ALL
  const mode = cargoMode || 'LOC' // default to LOC if undefined
  return rates.find(r =>
    r.service_type === serviceType
    && (r.cargo_mode === mode || r.cargo_mode === 'ALL')
    && (unit ? r.unit === unit : true)
  ) || rates.find(r =>
    r.service_type === serviceType
    && r.cargo_mode === 'ALL'
    && (unit ? r.unit === unit : true)
  ) || null
}

// ── Cargo data needed for calculations ──
export interface CargoData {
  pieces: number
  weight_kg: number
  pallets: number
  cbm: number
  storageDays: number
  hasAwb: boolean
  hasDg: boolean
  isSpecialCargo: boolean
}

export interface ChargeResult {
  service_type: string
  description: string
  amount: number
  rate_id: string | null
  storage_days?: number | null
  qty?: number | null
  rate_price?: number | null
  rate_unit?: string | null
  detail?: string | null
}

// ── Calculate In/Out charge ──
function calcInOut(rate: RateWithOverride, cargo: CargoData): number {
  const palletCharge = cargo.pallets * rate.effectivePrice
  if (rate.compare_logic === 'max' && rate.compare_price) {
    const cbmCharge = cargo.cbm * rate.compare_price
    return Math.max(palletCharge, cbmCharge)
  }
  return palletCharge
}

// ── Calculate Storage charge ──
function calcStorage(rate: RateWithOverride, cargo: CargoData): number {
  const { pallets, storageDays } = cargo

  // Bonded: flat fee + overage after free days
  if (rate.free_days != null && rate.overage_price != null) {
    const base = pallets * rate.effectivePrice
    const extraDays = Math.max(0, storageDays - rate.free_days)
    const overage = extraDays * pallets * rate.overage_price
    return base + overage
  }

  // Local: per cycle
  if (rate.cycle_days) {
    const cycles = Math.ceil(storageDays / rate.cycle_days)
    return cycles * pallets * rate.effectivePrice
  }

  return pallets * rate.effectivePrice
}

// ── Calculate Screening charge ──
function calcScreening(rate: RateWithOverride, cargo: CargoData): { amount: number; appliedMin: boolean } {
  // Special cargo (sum logic): per_kg + per_piece
  if (rate.compare_logic === 'sum' && rate.compare_price) {
    const kgCharge = cargo.weight_kg * rate.effectivePrice
    const pieceCharge = cargo.pieces * rate.compare_price
    const subtotal = kgCharge + pieceCharge
    if (rate.effectiveMin && subtotal < rate.effectiveMin) {
      return { amount: rate.effectiveMin, appliedMin: true }
    }
    return { amount: subtotal, appliedMin: false }
  }

  // Regular screening: per_kg with minimum
  const charge = cargo.weight_kg * rate.effectivePrice
  if (rate.effectiveMin && charge < rate.effectiveMin) {
    return { amount: rate.effectiveMin, appliedMin: true }
  }
  return { amount: charge, appliedMin: false }
}

// ── Calculate Transport charge ──
function calcTransport(rate: RateWithOverride, cargo: CargoData, extraStops: number): { amount: number; appliedMin: boolean } {
  let charge: number
  if (rate.unit === 'per_uld') {
    charge = cargo.pieces * rate.effectivePrice
  } else {
    charge = cargo.weight_kg * rate.effectivePrice
  }
  // Apply minimum
  let appliedMin = false
  if (rate.effectiveMin && charge < rate.effectiveMin) {
    charge = rate.effectiveMin
    appliedMin = true
  }
  // Extra stops surcharge
  if (rate.extra_stop_surcharge && extraStops > 0) {
    charge += extraStops * rate.extra_stop_surcharge
  }
  return { amount: charge, appliedMin }
}

// ── Calculate all charges for POS completion (non-transport services) ──
export async function calculatePOSCharges(
  order: WSServiceOrder,
  cargo: CargoData,
): Promise<ChargeResult[]> {
  const rates = await loadEffectiveRates(order.client_id)
  const cargoMode = order.cargo_mode // 'LOC' | 'BOND'
  console.log('[POS Billing] client:', order.client_id, 'cargoMode:', cargoMode, 'rates loaded:', rates.length, 'services:', (order.service_items || []).map(i => i.type))
  if (rates.length > 0) console.log('[POS Billing] rate types:', rates.map(r => `${r.service_type}/${r.cargo_mode}`))
  else console.warn('[POS Billing] NO RATES FOUND — check ws_rate_schedule collection')
  console.log('[POS Billing] cargo:', JSON.stringify(cargo))
  const charges: ChargeResult[] = []

  for (const item of (order.service_items || [])) {
    if (item.type === 'transport') continue // billed via DO
    if (item.type === 'handling_storage_fee') continue // manual charge only
    if (item.status === 'cancelled' || item.status === 'fail') continue

    let amount = 0
    let rate: RateWithOverride | null = null
    let description = ''
    let chargeQty: number | null = null
    let chargeRate: number | null = null
    let chargeUnit: string | null = null
    let chargeDetail: string | null = null

    switch (item.type) {
      case 'in_out': {
        // If SO has DG + AWB, DG Acceptance replaces In/Out
        if (cargo.hasDg && cargo.hasAwb) {
          description = 'In/Out — Replaced by DG Acceptance'
          break // amount stays 0, skip — DG Acceptance handles it
        }
        // Special Cargo screening includes In/Out in its formula (per_piece component)
        if (cargo.isSpecialCargo) {
          description = 'In/Out — Included in Screening Special Cargo'
          break // amount stays 0, skip
        }
        rate = findRate(rates, 'in_out', cargoMode)
        if (rate) {
          amount = calcInOut(rate, cargo)
          description = `In/Out Cargo — ${cargo.pallets} pallet${cargo.pallets !== 1 ? 's' : ''}`
          if (rate.compare_logic === 'max') {
            const cbmCharge = cargo.cbm * (rate.compare_price || 0)
            const palletCharge = cargo.pallets * rate.effectivePrice
            if (palletCharge >= cbmCharge) {
              description += ' (pallet)'
              chargeQty = cargo.pallets; chargeRate = rate.effectivePrice; chargeUnit = 'per_pallet'
              chargeDetail = `${cargo.pallets} plt x $${rate.effectivePrice}`
            } else {
              description += ` (CBM: ${cargo.cbm.toFixed(2)})`
              chargeQty = cargo.cbm; chargeRate = rate.compare_price || 0; chargeUnit = 'per_cbm'
              chargeDetail = `${cargo.cbm.toFixed(2)} cbm x $${rate.compare_price}`
            }
          } else {
            chargeQty = cargo.pallets; chargeRate = rate.effectivePrice; chargeUnit = 'per_pallet'
            chargeDetail = `${cargo.pallets} plt x $${rate.effectivePrice}`
          }
        }
        break
      }

      case 'storage': {
        rate = findRate(rates, 'storage', cargoMode)
        if (rate) {
          amount = calcStorage(rate, cargo)
          description = `Storage — ${cargo.pallets} pallet${cargo.pallets !== 1 ? 's' : ''} x ${cargo.storageDays} day${cargo.storageDays !== 1 ? 's' : ''}`
          chargeQty = cargo.pallets; chargeRate = rate.effectivePrice; chargeUnit = 'per_pallet'
          if (rate.free_days != null && rate.overage_price != null) {
            const extraDays = Math.max(0, cargo.storageDays - rate.free_days)
            chargeDetail = `${cargo.pallets} plt x $${rate.effectivePrice} + ${extraDays}d overage x ${cargo.pallets} plt x $${rate.overage_price}`
          } else if (rate.cycle_days) {
            const cycles = Math.ceil(cargo.storageDays / rate.cycle_days)
            chargeDetail = `${cycles} cycle${cycles > 1 ? 's' : ''} x ${cargo.pallets} plt x $${rate.effectivePrice}`
          } else {
            chargeDetail = `${cargo.pallets} plt x $${rate.effectivePrice}`
          }
        }
        break
      }

      case 'screening_k9':
      case 'screening_xray':
      case 'screening_manual': {
        // Special cargo always uses screening_manual rate (Special Cargo tariff)
        const screeningType = cargo.isSpecialCargo ? 'screening_manual' : item.type
        rate = findRate(rates, screeningType, cargoMode)
        if (rate) {
          const result = calcScreening(rate, cargo)
          amount = result.amount
          description = `${rate.name} — ${cargo.weight_kg.toFixed(1)} kg`
          chargeQty = cargo.weight_kg; chargeRate = rate.effectivePrice; chargeUnit = 'per_kg'
          if (rate.compare_logic === 'sum' && rate.compare_price) {
            description += ` + ${cargo.pieces} pcs`
            chargeDetail = `${cargo.weight_kg.toFixed(1)} kg x $${rate.effectivePrice} + ${cargo.pieces} pcs x $${rate.compare_price}`
          } else {
            chargeDetail = `${cargo.weight_kg.toFixed(1)} kg x $${rate.effectivePrice}`
          }
          if (result.appliedMin) {
            description += ' (minimum charge)'
            chargeDetail += ` (min $${rate.effectiveMin})`
          }
        }
        break
      }

      case 'dg_inspection': {
        rate = findRate(rates, 'dg_inspection', cargoMode)
        if (rate) {
          if (cargo.hasAwb) {
            amount = rate.effectivePrice
            description = `DG Physical Acceptance — per AWB (replaces In/Out)`
          } else {
            amount = rate.effectivePrice
            description = `DG Physical Acceptance — per SO`
          }
          chargeQty = 1; chargeRate = rate.effectivePrice; chargeUnit = cargo.hasAwb ? 'per_awb' : 'per_so'
          chargeDetail = `1 x $${rate.effectivePrice}`
        }
        break
      }

      case 'breakdown_bup': {
        rate = findRate(rates, 'breakdown_bup', cargoMode)
        if (rate) {
          amount = cargo.weight_kg * rate.effectivePrice
          description = `Breakdown BUP — ${cargo.weight_kg.toFixed(1)} kg`
          chargeQty = cargo.weight_kg; chargeRate = rate.effectivePrice; chargeUnit = 'per_kg'
          chargeDetail = `${cargo.weight_kg.toFixed(1)} kg x $${rate.effectivePrice}`
        }
        break
      }

      case 'repack': {
        // No rate defined for repack in auto mode — will be 0 unless added
        description = 'Repack'
        break
      }

      default:
        description = item.type
    }

    // Skip In/Out when replaced by DG Acceptance or absorbed by Special Cargo screening
    if (item.type === 'in_out' && ((cargo.hasDg && cargo.hasAwb) || cargo.isSpecialCargo)) continue

    charges.push({
      service_type: item.type,
      description,
      amount: Math.round(amount * 100) / 100,
      rate_id: rate?.id || null,
      storage_days: item.type === 'storage' ? cargo.storageDays : null,
      qty: chargeQty,
      rate_price: chargeRate,
      rate_unit: chargeUnit,
      detail: chargeDetail,
    })
  }

  return charges
}

// ── Calculate transport charge for DO creation ──
export async function calculateTransportCharge(
  order: WSServiceOrder,
  transportType: 'bup' | 'loose',
  extraStops: number,
  truckingCompany: string,
  driverName: string,
): Promise<ChargeResult> {
  const rates = await loadEffectiveRates(order.client_id)

  const unit = transportType === 'bup' ? 'per_uld' : 'per_kg'
  const rate = findRate(rates, 'transport', order.cargo_mode, unit)

  const bupCount = (order as any).bup_count || 0
  let amount = 0
  let description = `Transport — ${truckingCompany} — ${driverName}`

  if (rate) {
    const cargo: CargoData = {
      // For BUP: pieces = bup_count (charge per ULD); For loose: pieces = declared_pieces
      pieces: transportType === 'bup' ? bupCount : order.declared_pieces,
      weight_kg: order.declared_weight,
      pallets: order.declared_pieces,
      cbm: 0,
      storageDays: 0,
      hasAwb: !!order.awb_number,
      hasDg: (order.service_items || []).some(i => i.type === 'dg_inspection'),
      isSpecialCargo: order.cargo_type === 'SPECIAL',
    }
    const result = calcTransport(rate, cargo, extraStops)
    amount = result.amount
    if (transportType === 'bup') {
      description += ` — ${bupCount} BUP`
    }
    description += ` (${rate.name})`
    if (extraStops > 0) description += ` +${extraStops} stop${extraStops > 1 ? 's' : ''}`
    if (result.appliedMin) description += ' (minimum charge)'
  }

  const tQty = rate ? (transportType === 'bup' ? bupCount : order.declared_weight) : null
  const tDetail = rate
    ? (transportType === 'bup'
        ? `${bupCount} ULD x $${rate.effectivePrice}`
        : `${order.declared_weight} kg x $${rate.effectivePrice}`)
      + (extraStops > 0 && rate.extra_stop_surcharge ? ` + ${extraStops} stop x $${rate.extra_stop_surcharge}` : '')
      + (amount === rate?.effectiveMin ? ` (min $${rate.effectiveMin})` : '')
    : null

  return {
    service_type: 'transport',
    description,
    amount: Math.round(amount * 100) / 100,
    rate_id: rate?.id || null,
    qty: tQty,
    rate_price: rate?.effectivePrice || null,
    rate_unit: transportType === 'bup' ? 'per_uld' : 'per_kg',
    detail: tDetail,
  }
}

// ── Calculate bonded fee for WR creation ──
export async function calculateBondedFee(
  clientId: string,
  cargoMode: string,
): Promise<ChargeResult | null> {
  if (cargoMode !== 'BOND') return null

  const rates = await loadEffectiveRates(clientId)
  const rate = findRate(rates, 'bonded_fee', 'BOND')
  if (!rate) return null

  return {
    service_type: 'bonded_fee',
    description: `Bonded Fee — per Warehouse Receipt`,
    amount: Math.round(rate.effectivePrice * 100) / 100,
    rate_id: rate.id || null,
    qty: 1,
    rate_price: rate.effectivePrice,
    rate_unit: 'per_wr',
    detail: `1 x $${rate.effectivePrice}`,
  }
}
