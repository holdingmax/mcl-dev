import { db } from './firebase'
import {
  collection, getDocs, doc, getDoc, addDoc, query, where, writeBatch
} from 'firebase/firestore'
import { WarehouseReceipt, WRLine, RateSchedule, Dispatch } from '../types'

type InOutLogic = 'max' | 'cbm_only' | 'pallet_only'

interface ClientRateOverride {
  id?: string
  client_id: string
  rate_id: string | null
  rate_name: string
  billing_event: string
  unit: string
  price: number
  active: boolean
  cargo_type: string
  is_custom?: boolean
}

export async function calculateReceptionCharges(
  wr: WarehouseReceipt,
  lines: WRLine[],
  totals: { total_qty: number; total_cbm: number; total_weight_kg: number }
): Promise<void> {
  const cargoType = wr.cargo_type || 'LOC'
  const clientId = wr.client_id || null

  // 1. Load all active general reception rates
  const ratesSnap = await getDocs(
    query(
      collection(db, 'rate_schedule'),
      where('billing_event', '==', 'reception'),
      where('active', '==', true)
    )
  )
  const allReceptionRates = ratesSnap.docs.map(d => ({ id: d.id, ...d.data() })) as RateSchedule[]
  // Keep only rates matching this cargo type or 'BOTH'
  const applicableRates = allReceptionRates.filter(
    r => r.cargo_type === cargoType || r.cargo_type === 'BOTH'
  )

  // 2. Load client config and overrides
  let inoutLogic: InOutLogic = 'max'
  let clientOverrides: ClientRateOverride[] = []

  if (clientId) {
    const [overridesSnap, configSnap] = await Promise.all([
      getDocs(query(collection(db, 'client_billing_rates'), where('client_id', '==', clientId))),
      getDoc(doc(db, 'client_billing_config', clientId))
    ])
    clientOverrides = overridesSnap.docs
      .map(d => ({ id: d.id, ...d.data() })) as ClientRateOverride[]
    if (configSnap.exists()) {
      inoutLogic = (configSnap.data().inout_logic as InOutLogic) || 'max'
    }
  }

  function getEffectivePrice(rate: RateSchedule): number {
    const override = clientOverrides.find(o => o.rate_id === rate.id && o.active)
    return override !== undefined ? override.price : rate.price
  }

  // 3. Count pallets (SKIDs) and get CBM
  const skidCount = lines
    .filter(l => l.packing_type === 'SKID')
    .reduce((sum, l) => sum + (l.qty || 0), 0)
  const totalCbm = totals.total_cbm

  // 4. Identify the two In/Out rates
  const unloadingRate = applicableRates.find(r => r.name === 'Unloading')
  const inoutRateName = cargoType === 'BOND' ? 'In/Out Cargo BOND' : 'In/Out Cargo'
  const inoutRate = applicableRates.find(r => r.name === inoutRateName)

  type ChargeRow = {
    billing_event: 'reception'
    charge_name: string
    unit: string
    qty: number
    unit_price: number
    total: number
    currency: string
  }
  const charges: ChargeRow[] = []

  // 5. Apply In/Out logic
  const unloadingPrice = unloadingRate ? getEffectivePrice(unloadingRate) : 12
  const inoutPrice     = inoutRate     ? getEffectivePrice(inoutRate)     : (cargoType === 'BOND' ? 20 : 15)
  const cbmAmount      = totalCbm   * unloadingPrice
  const palletAmount   = skidCount  * inoutPrice
  const currency       = unloadingRate?.currency ?? 'USD'

  if (inoutLogic === 'cbm_only') {
    charges.push({
      billing_event: 'reception',
      charge_name: unloadingRate?.name ?? 'Unloading',
      unit: 'per_cbm',
      qty: totalCbm,
      unit_price: unloadingPrice,
      total: cbmAmount,
      currency,
    })
  } else if (inoutLogic === 'pallet_only') {
    charges.push({
      billing_event: 'reception',
      charge_name: inoutRate?.name ?? inoutRateName,
      unit: 'per_pallet',
      qty: skidCount,
      unit_price: inoutPrice,
      total: palletAmount,
      currency: inoutRate?.currency ?? 'USD',
    })
  } else {
    // 'max': charge whichever is greater
    if (cbmAmount >= palletAmount) {
      charges.push({
        billing_event: 'reception',
        charge_name: unloadingRate?.name ?? 'Unloading',
        unit: 'per_cbm',
        qty: totalCbm,
        unit_price: unloadingPrice,
        total: cbmAmount,
        currency,
      })
    } else {
      charges.push({
        billing_event: 'reception',
        charge_name: inoutRate?.name ?? inoutRateName,
        unit: 'per_pallet',
        qty: skidCount,
        unit_price: inoutPrice,
        total: palletAmount,
        currency: inoutRate?.currency ?? 'USD',
      })
    }
  }

  // 6. Apply all other active reception rates (not Unloading / In/Out — handled above)
  const handledNames = new Set(['Unloading', 'In/Out Cargo', 'In/Out Cargo BOND'])
  for (const rate of applicableRates) {
    if (handledNames.has(rate.name)) continue
    // Labelling Fee has price 0 → skip unless client has an active override with price > 0
    const effectivePrice = getEffectivePrice(rate)
    if (effectivePrice === 0) continue

    charges.push({
      billing_event: 'reception',
      charge_name: rate.name,
      unit: rate.unit,
      qty: 1,
      unit_price: effectivePrice,
      total: effectivePrice,
      currency: rate.currency,
    })
  }

  // 7. Client-exclusive custom reception rates
  for (const custom of clientOverrides) {
    if (!custom.is_custom) continue
    if (custom.billing_event !== 'reception') continue
    if (!custom.active) continue
    if (custom.cargo_type !== cargoType && custom.cargo_type !== 'BOTH') continue
    charges.push({
      billing_event: 'reception',
      charge_name: custom.rate_name,
      unit: custom.unit,
      qty: 1,
      unit_price: custom.price,
      total: custom.price,
      currency: 'USD',
    })
  }

  // 8. Delete any existing reception charges for this WR (idempotent re-calculation)
  const existingSnap = await getDocs(
    query(
      collection(db, 'billing_charges'),
      where('wr_id', '==', wr.id),
      where('billing_event', '==', 'reception')
    )
  )
  if (!existingSnap.empty) {
    const batch = writeBatch(db)
    existingSnap.docs.forEach(d => batch.delete(d.ref))
    await batch.commit()
  }

  // 9. Save new charges in batch
  const now = new Date().toISOString()
  const colRef = collection(db, 'billing_charges')
  for (let i = 0; i < charges.length; i += 500) {
    const batch = writeBatch(db)
    const slice = charges.slice(i, i + 500)
    for (const charge of slice) {
      batch.set(doc(colRef), {
        ...charge,
        wr_id: wr.id,
        wr_number: wr.wr_number || '',
        po_number: wr.po_number || '',
        client_id: clientId,
        client_name: wr.client_name || '',
        cargo_type: cargoType,
        status: 'pending',
        created_at: now,
      })
    }
    await batch.commit()
  }
  console.info('BILLING_BATCH', { collection: 'billing_charges', event: 'reception', count: charges.length, success: true })
}

// ── Free storage days per cargo type (defaults, overridable per client) ─────
const DEFAULT_FREE_DAYS_LOC  = 21
const DEFAULT_FREE_DAYS_BOND = 5

async function loadClientFreeDays(clientId: string): Promise<{ loc: number; bond: number }> {
  try {
    const snap = await getDoc(doc(db, 'client_billing_config', clientId))
    if (snap.exists()) {
      const data = snap.data()
      return {
        loc: data.free_days_loc ?? DEFAULT_FREE_DAYS_LOC,
        bond: data.free_days_bond ?? DEFAULT_FREE_DAYS_BOND,
      }
    }
  } catch (e) { console.error('Error loading client free days', e) }
  return { loc: DEFAULT_FREE_DAYS_LOC, bond: DEFAULT_FREE_DAYS_BOND }
}

function daysBetween(from: string, to: string): number {
  const msPerDay = 1000 * 60 * 60 * 24
  return Math.max(0, Math.floor((new Date(to).getTime() - new Date(from).getTime()) / msPerDay))
}

// Cache de overrides por client_id para evitar múltiples fetches
async function loadClientOverrides(clientId: string): Promise<ClientRateOverride[]> {
  const snap = await getDocs(
    query(collection(db, 'client_billing_rates'), where('client_id', '==', clientId))
  )
  return snap.docs.map(d => ({ id: d.id, ...d.data() })) as ClientRateOverride[]
}

// Devuelve el precio efectivo respetando overrides del cliente.
// Retorna null si el override desactiva la tarifa.
function effectiveDispatchPrice(
  rate: RateSchedule,
  overrides: ClientRateOverride[]
): number | null {
  const override = overrides.find(o => o.rate_id === rate.id)
  if (override) {
    if (!override.active) return null   // tarifa desactivada para este cliente
    return override.price               // precio personalizado (puede ser 0 → se omite)
  }
  return rate.price                     // tarifa general
}

export async function calculateDispatchCharges(
  dispatch: Dispatch,
  gateOutAt: string
): Promise<void> {
  if (!dispatch.id) return

  // 1. Load all active dispatch rates
  const ratesSnap = await getDocs(
    query(collection(db, 'rate_schedule'), where('billing_event', '==', 'dispatch'), where('active', '==', true))
  )
  const dispatchRates = ratesSnap.docs.map(d => ({ id: d.id, ...d.data() })) as RateSchedule[]

  // Normalize container size: 40HC / 45 → '40', LCL has no loading/drayage
  const isLCL = dispatch.container_size === 'LCL'
  const containerKey = dispatch.container_size === '20' ? '20' : '40'

  // Find rates by name/attributes (LCL skips loading and drayage)
  const loadingRate    = isLCL ? undefined : dispatchRates.find(r => r.name.startsWith('Loading') && r.container_size === containerKey && r.loading_type === dispatch.loading_type)
  const drayageRate    = isLCL ? undefined : dispatchRates.find(r => r.name.startsWith('Drayage') && r.name !== 'Drayage Hazmat' && r.container_size === containerKey)
  const hazmatRate     = dispatchRates.find(r => r.name === 'Drayage Hazmat')
  const exportDocsRate = dispatchRates.find(r => r.name === 'Export Docs Fee')
  const storageLocRate  = dispatchRates.find(r => r.name === 'Storage LOC')
  const storageBondRate = dispatchRates.find(r => r.name === 'Storage BOND')

  // 2. Load WRs first to identify clients
  const wrIds = dispatch.wr_ids || []
  const wrDataMap = new Map<string, WarehouseReceipt>()
  await Promise.all(wrIds.map(async wrId => {
    const snap = await getDoc(doc(db, 'warehouse_receipts', wrId))
    if (snap.exists()) wrDataMap.set(wrId, { id: snap.id, ...snap.data() } as WarehouseReceipt)
  }))

  // Primary client = first WR with a client_id (used for dispatch-level charges)
  const primaryClientId = wrIds.map(id => wrDataMap.get(id)?.client_id).find(c => !!c) || null

  // 3. Load overrides cache + free days per client_id (avoid duplicate fetches)
  const overridesCache = new Map<string, ClientRateOverride[]>()
  const freeDaysCache = new Map<string, { loc: number; bond: number }>()
  const allClientIds = [...new Set(wrIds.map(id => wrDataMap.get(id)?.client_id).filter(Boolean) as string[])]
  await Promise.all(allClientIds.map(async cid => {
    const [overrides, freeDays] = await Promise.all([
      loadClientOverrides(cid),
      loadClientFreeDays(cid),
    ])
    overridesCache.set(cid, overrides)
    freeDaysCache.set(cid, freeDays)
  }))

  const primaryOverrides = primaryClientId ? (overridesCache.get(primaryClientId) ?? []) : []

  type DispatchChargeRow = {
    billing_event: 'dispatch'
    dispatch_id: string
    charge_name: string
    unit: string
    qty: number
    unit_price: number
    total: number
    currency: string
    wr_id?: string
    wr_number?: string
    client_id?: string | null
    client_name?: string
    cargo_type?: string
  }

  const charges: DispatchChargeRow[] = []
  const firstClientName = dispatch.client_names?.[0] || ''

  // Helper to push a dispatch-level charge respecting client overrides
  function pushIfApplicable(rate: RateSchedule, unit: string, overrides: ClientRateOverride[]) {
    const price = effectiveDispatchPrice(rate, overrides)
    if (price === null || price === 0) return  // desactivado o gratuito → no generar cargo
    charges.push({
      billing_event: 'dispatch',
      dispatch_id: dispatch.id!,
      charge_name: rate.name,
      unit,
      qty: 1,
      unit_price: price,
      total: price,
      currency: rate.currency,
      client_id: primaryClientId,
      client_name: firstClientName,
    })
  }

  // 4. Load all WR lines up front (needed for DG check + storage)
  const linesMap = new Map<string, WRLine[]>()
  await Promise.all(wrIds.map(async wrId => {
    const snap = await getDocs(collection(db, 'warehouse_receipts', wrId, 'lines'))
    linesMap.set(wrId, snap.docs.map(d => ({ id: d.id, ...d.data() }) as WRLine))
  }))

  // Build allocation lookup: wrId → lineId → allocated_qty (for partial dispatches)
  const allocMap = new Map<string, Map<string, number>>()
  if (dispatch.line_allocations) {
    for (const alloc of dispatch.line_allocations) {
      if (!allocMap.has(alloc.wr_id)) allocMap.set(alloc.wr_id, new Map())
      allocMap.get(alloc.wr_id)!.set(alloc.wr_line_id, alloc.allocated_qty)
    }
  }

  // Helper: get effective qty for a line considering partial allocations
  function effectiveLineQty(wrId: string, line: WRLine): number {
    const wrAlloc = allocMap.get(wrId)
    if (!wrAlloc || !line.id) return line.qty || 0
    return wrAlloc.get(line.id) ?? line.qty ?? 0
  }

  // Hazmat applies if dispatch.hazmat flag is set OR any included WR line is marked DG
  const hasDGLines = wrIds.some(wrId =>
    (linesMap.get(wrId) ?? []).some(l => l.is_dg && effectiveLineQty(wrId, l) > 0)
  )
  const applyHazmat = (dispatch.hazmat || hasDGLines) && dispatch.drayage

  // 5. Dispatch-level charges (aplican overrides del cliente primario)
  if (loadingRate)    pushIfApplicable(loadingRate,    'per_container', primaryOverrides)
  if (drayageRate && dispatch.drayage)  pushIfApplicable(drayageRate,  'per_container', primaryOverrides)
  if (hazmatRate  && applyHazmat)       pushIfApplicable(hazmatRate,   'per_container', primaryOverrides)
  if (exportDocsRate) pushIfApplicable(exportDocsRate, 'per_bl',        primaryOverrides)

  // 6. Storage — por WR, con overrides del cliente de cada WR
  for (const wrId of wrIds) {
    const wr = wrDataMap.get(wrId)
    if (!wr) continue

    const lines = linesMap.get(wrId) ?? []
    // Use effective qty for partial allocations
    const pallets = lines
      .filter(l => l.packing_type === 'SKID')
      .reduce((s, l) => s + effectiveLineQty(wrId, l), 0)
    if (pallets === 0) continue

    const cargoType   = wr.cargo_type || 'LOC'
    const startDate   = wr.created_at || gateOutAt
    const totalDays   = daysBetween(startDate, gateOutAt)
    const clientFreeDays = wr.client_id ? freeDaysCache.get(wr.client_id) : null
    const freeDays    = cargoType === 'BOND'
      ? (clientFreeDays?.bond ?? DEFAULT_FREE_DAYS_BOND)
      : (clientFreeDays?.loc ?? DEFAULT_FREE_DAYS_LOC)
    const billableDays = Math.max(0, totalDays - freeDays)
    if (billableDays === 0) continue

    const storageRate = cargoType === 'BOND' ? storageBondRate : storageLocRate
    if (!storageRate) continue

    const wrOverrides = wr.client_id ? (overridesCache.get(wr.client_id) ?? []) : []
    const price = effectiveDispatchPrice(storageRate, wrOverrides)
    if (price === null || price === 0) continue

    charges.push({
      billing_event: 'dispatch',
      dispatch_id: dispatch.id,
      charge_name: `${storageRate.name} — ${wr.wr_number || wrId} (${billableDays} días × ${pallets} pallets)`,
      unit: 'per_day_pallet',
      qty: billableDays * pallets,
      unit_price: price,
      total: billableDays * pallets * price,
      currency: storageRate.currency,
      wr_id: wrId,
      wr_number: wr.wr_number || '',
      client_id: wr.client_id || null,
      client_name: wr.client_name || '',
      cargo_type: cargoType,
    })
  }

  // 6. Delete existing dispatch charges (idempotent)
  const existingSnap = await getDocs(
    query(collection(db, 'billing_charges'), where('dispatch_id', '==', dispatch.id))
  )
  if (!existingSnap.empty) {
    const batch = writeBatch(db)
    existingSnap.docs.forEach(d => batch.delete(d.ref))
    await batch.commit()
  }

  // Derive PO label for dispatch-level charges (container/BL charges)
  const dispatchPoLabel = (dispatch.po_numbers || []).join(', ')

  // 7. Save new charges in batch
  const dispColRef = collection(db, 'billing_charges')
  for (let i = 0; i < charges.length; i += 500) {
    const batch = writeBatch(db)
    const slice = charges.slice(i, i + 500)
    for (const charge of slice) {
      const poNumber = charge.wr_id
        ? (wrDataMap.get(charge.wr_id)?.po_number || '')
        : dispatchPoLabel

      batch.set(doc(dispColRef), {
        charge_name:   charge.charge_name,
        unit:          charge.unit,
        qty:           charge.qty,
        unit_price:    charge.unit_price,
        total:         charge.total,
        currency:      charge.currency,
        billing_event: 'dispatch',
        dispatch_id:   charge.dispatch_id,
        wr_id:         charge.wr_id    ?? null,
        wr_number:     charge.wr_number ?? null,
        po_number:     poNumber,
        client_id:     charge.client_id !== undefined ? charge.client_id : null,
        client_name:   charge.client_name ?? firstClientName,
        cargo_type:    charge.cargo_type ?? 'LOC',
        status:        'pending',
        created_at:    gateOutAt,
      })
    }
    await batch.commit()
  }
  console.info('BILLING_BATCH', { collection: 'billing_charges', event: 'dispatch', count: charges.length, success: true })
}
