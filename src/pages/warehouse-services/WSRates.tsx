import { useState, useEffect, useMemo } from 'react'
import { collection, query, getDocs, addDoc, updateDoc, deleteDoc, doc, orderBy, where } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import Layout from '../../components/Layout'
import type { WSRateSchedule, WSClientRateOverride, WSClient } from '../../types'

const UNIT_LABELS: Record<string, string> = {
  per_pallet: '/pallet', per_cbm: '/CBM', per_kg: '/kg', per_piece: '/piece',
  per_awb: '/AWB', per_wr: '/WR', per_uld: '/ULD', per_label: '/label',
  per_day_pallet: '/day/pallet', flat: 'flat',
}

const BILLING_LABELS: Record<string, string> = { auto: 'Auto', optional: 'Optional' }
const CARGO_LABELS: Record<string, string> = { LOC: 'Local', BOND: 'Bonded', ALL: 'All' }

const SEED_RATES: Omit<WSRateSchedule, 'id'>[] = [
  { name: 'In/Out Cargo (Bonded)', billing_event: 'auto', service_type: 'in_out', cargo_mode: 'BOND', unit: 'per_pallet', price: 25, currency: 'USD', minimum_charge: null, free_days: null, overage_price: null, cycle_days: null, compare_unit: 'per_cbm', compare_price: 15, compare_logic: 'max', extra_stop_surcharge: null, active: true, sort_order: 1, remarks: 'Se cobra el mayor entre pallet ($25) y CBM ($15)' },
  { name: 'In/Out Cargo (Local)', billing_event: 'auto', service_type: 'in_out', cargo_mode: 'LOC', unit: 'per_pallet', price: 18, currency: 'USD', minimum_charge: null, free_days: null, overage_price: null, cycle_days: null, compare_unit: 'per_cbm', compare_price: 15, compare_logic: 'max', extra_stop_surcharge: null, active: true, sort_order: 2, remarks: 'Se cobra el mayor entre pallet ($18) y CBM ($15)' },
  { name: 'Storage (Bonded)', billing_event: 'auto', service_type: 'storage', cargo_mode: 'BOND', unit: 'per_pallet', price: 20, currency: 'USD', minimum_charge: null, free_days: 5, overage_price: 3, cycle_days: null, compare_unit: null, compare_price: null, compare_logic: null, extra_stop_surcharge: null, active: true, sort_order: 3, remarks: '$20 al ingreso, 5 dias incluidos, luego $3/dia por pallet' },
  { name: 'Storage (Local)', billing_event: 'auto', service_type: 'storage', cargo_mode: 'LOC', unit: 'per_pallet', price: 20, currency: 'USD', minimum_charge: null, free_days: null, overage_price: null, cycle_days: 30, compare_unit: null, compare_price: null, compare_logic: null, extra_stop_surcharge: null, active: true, sort_order: 4, remarks: '$20/pallet cada ciclo de 30 dias' },
  { name: 'K9 Screening', billing_event: 'auto', service_type: 'screening_k9', cargo_mode: 'ALL', unit: 'per_kg', price: 0.07, currency: 'USD', minimum_charge: 120, free_days: null, overage_price: null, cycle_days: null, compare_unit: null, compare_price: null, compare_logic: null, extra_stop_surcharge: null, active: true, sort_order: 5, remarks: '$0.07/kg, minimo $120' },
  { name: 'X-Ray Screening (General)', billing_event: 'auto', service_type: 'screening_xray', cargo_mode: 'ALL', unit: 'per_kg', price: 0.15, currency: 'USD', minimum_charge: 120, free_days: null, overage_price: null, cycle_days: null, compare_unit: null, compare_price: null, compare_logic: null, extra_stop_surcharge: null, active: true, sort_order: 6, remarks: '$0.15/kg, minimo $120' },
  { name: 'Screening Special Cargo', billing_event: 'auto', service_type: 'screening_manual', cargo_mode: 'ALL', unit: 'per_kg', price: 0.20, currency: 'USD', minimum_charge: 160, free_days: null, overage_price: null, cycle_days: null, compare_unit: 'per_piece', compare_price: 20, compare_logic: 'sum', extra_stop_surcharge: null, active: true, sort_order: 7, remarks: '$0.20/kg + $20/pieza In/Out, minimo $160 combinado' },
  { name: 'DG Physical Acceptance / In&Out', billing_event: 'auto', service_type: 'dg_inspection', cargo_mode: 'ALL', unit: 'per_awb', price: 50, currency: 'USD', minimum_charge: null, free_days: null, overage_price: null, cycle_days: null, compare_unit: null, compare_price: null, compare_logic: null, extra_stop_surcharge: null, active: true, sort_order: 8, remarks: '$50/AWB — reemplaza In/Out si SO tiene AWB' },
  { name: 'BUP/ULD Transportation', billing_event: 'auto', service_type: 'transport', cargo_mode: 'ALL', unit: 'per_uld', price: 50, currency: 'USD', minimum_charge: 180, free_days: null, overage_price: null, cycle_days: null, compare_unit: null, compare_price: null, compare_logic: null, extra_stop_surcharge: 40, active: true, sort_order: 9, remarks: '$50/ULD, minimo $180, +$40 por parada extra' },
  { name: 'Transport Loose Cargo', billing_event: 'auto', service_type: 'transport', cargo_mode: 'ALL', unit: 'per_kg', price: 0.04, currency: 'USD', minimum_charge: 120, free_days: null, overage_price: null, cycle_days: null, compare_unit: null, compare_price: null, compare_logic: null, extra_stop_surcharge: 40, active: true, sort_order: 10, remarks: '$0.04/kg, minimo $120, +$40 por parada extra' },
  { name: 'Bonded Fee', billing_event: 'auto', service_type: 'bonded_fee', cargo_mode: 'BOND', unit: 'per_wr', price: 60, currency: 'USD', minimum_charge: null, free_days: null, overage_price: null, cycle_days: null, compare_unit: null, compare_price: null, compare_logic: null, extra_stop_surcharge: null, active: true, sort_order: 11, remarks: '$60 por cada Warehouse Receipt de carga Bonded' },
  { name: 'DG Documentary Compliance', billing_event: 'optional', service_type: 'dg_documentary', cargo_mode: 'ALL', unit: 'per_awb', price: 90, currency: 'USD', minimum_charge: null, free_days: null, overage_price: null, cycle_days: null, compare_unit: null, compare_price: null, compare_logic: null, extra_stop_surcharge: null, active: true, sort_order: 12, remarks: '$90 por AWB — Shipper Declaration' },
  { name: 'Labeling', billing_event: 'optional', service_type: 'labeling', cargo_mode: 'ALL', unit: 'per_label', price: 1.00, currency: 'USD', minimum_charge: null, free_days: null, overage_price: null, cycle_days: null, compare_unit: null, compare_price: null, compare_logic: null, extra_stop_surcharge: null, active: true, sort_order: 13, remarks: '$1 por etiqueta' },
  { name: 'Wrapping', billing_event: 'optional', service_type: 'wrapping', cargo_mode: 'ALL', unit: 'per_pallet', price: 20, currency: 'USD', minimum_charge: null, free_days: null, overage_price: null, cycle_days: null, compare_unit: null, compare_price: null, compare_logic: null, extra_stop_surcharge: null, active: true, sort_order: 14, remarks: '$20 por pallet' },
  { name: 'Order Preparation', billing_event: 'optional', service_type: 'order_preparation', cargo_mode: 'LOC', unit: 'per_pallet', price: 45, currency: 'USD', minimum_charge: null, free_days: null, overage_price: null, cycle_days: null, compare_unit: null, compare_price: null, compare_logic: null, extra_stop_surcharge: null, active: true, sort_order: 15, remarks: 'Incluye pallet, wrapping, fleje, labor — solo Local' },
]

function formulaLabel(r: WSRateSchedule) {
  if (r.compare_unit && r.compare_price) {
    if (r.compare_logic === 'sum')
      return <span className="text-amber-700 font-mono">${r.price}{UNIT_LABELS[r.unit]} <b>+</b> ${r.compare_price}{UNIT_LABELS[r.compare_unit] || ''}</span>
    return <span className="text-blue-700 font-mono">max(${r.price}{UNIT_LABELS[r.unit]}, ${r.compare_price}{UNIT_LABELS[r.compare_unit] || ''})</span>
  }
  return <span className="text-gray-400 font-mono">${r.price}{UNIT_LABELS[r.unit]}</span>
}

function detailChips(r: WSRateSchedule) {
  const parts = [
    r.free_days ? `${r.free_days}d free` : null,
    r.overage_price ? `+$${r.overage_price}/day` : null,
    r.cycle_days ? `${r.cycle_days}d cycle` : null,
    r.extra_stop_surcharge ? `+$${r.extra_stop_surcharge}/stop` : null,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(', ') : (r.remarks?.slice(0, 40) || '—')
}

export default function WSRates() {
  const { isAdmin, isAccounting, userRole } = useAuth()
  const canEditRates = (userRole === 'admin') || isAccounting
  const [rates, setRates] = useState<WSRateSchedule[]>([])
  const [clients, setClients] = useState<WSClient[]>([])
  const [overrides, setOverrides] = useState<WSClientRateOverride[]>([])
  const [loading, setLoading] = useState(true)
  const [seeding, setSeeding] = useState(false)

  // View mode
  const [viewMode, setViewMode] = useState<'general' | 'client'>('general')
  const [selectedClientId, setSelectedClientId] = useState('')

  // General edit
  const [editId, setEditId] = useState<string | null>(null)
  const [editData, setEditData] = useState<Partial<WSRateSchedule>>({})
  // Add new rate
  const [showAddRate, setShowAddRate] = useState(false)
  const [newRate, setNewRate] = useState<Partial<WSRateSchedule>>({
    name: '', billing_event: 'optional', service_type: 'labeling', cargo_mode: 'ALL',
    unit: 'per_piece', price: 0, currency: 'USD', minimum_charge: null,
    free_days: null, overage_price: null, cycle_days: null,
    compare_unit: null, compare_price: null, compare_logic: null,
    extra_stop_surcharge: null, active: true, sort_order: 99, remarks: '',
  })

  // Client override edits (local state before save)
  const [dirtyOverrides, setDirtyOverrides] = useState<Record<string, { price: string; min: string; active: boolean }>>({})
  const [savingOverrides, setSavingOverrides] = useState(false)

  async function loadRates() {
    const snap = await getDocs(query(collection(db, 'ws_rate_schedule'), orderBy('sort_order')))
    setRates(snap.docs.map(d => ({ id: d.id, ...d.data() } as WSRateSchedule)))
    setLoading(false)
  }

  async function loadClients() {
    const snap = await getDocs(query(collection(db, 'warehouse_service_clients'), orderBy('name')))
    setClients(snap.docs.map(d => ({ id: d.id, ...d.data() } as WSClient)).filter(c => c.active !== false))
  }

  async function loadOverrides(clientId: string) {
    if (!clientId) { setOverrides([]); return }
    const snap = await getDocs(query(collection(db, 'ws_client_rate_overrides'), where('client_id', '==', clientId)))
    setOverrides(snap.docs.map(d => ({ id: d.id, ...d.data() } as WSClientRateOverride)))
  }

  useEffect(() => { loadRates(); loadClients() }, [])

  useEffect(() => {
    if (selectedClientId) {
      loadOverrides(selectedClientId)
      setDirtyOverrides({})
    }
  }, [selectedClientId])

  // Build override map: rate_id -> override
  const overrideMap = useMemo(() => {
    const m: Record<string, WSClientRateOverride> = {}
    overrides.forEach(o => { m[o.rate_id] = o })
    return m
  }, [overrides])

  const overrideCount = overrides.filter(o => o.active !== false || o.price !== null || o.minimum_charge !== null).length

  // ── General view handlers ──
  async function handleSeed() {
    if (!confirm('This will add all default rates. Continue?')) return
    setSeeding(true)
    for (const rate of SEED_RATES) await addDoc(collection(db, 'ws_rate_schedule'), rate)
    await loadRates()
    setSeeding(false)
  }

  async function handleMigrate() {
    let count = 0
    for (const r of rates) {
      if (r.compare_logic === undefined) {
        let logic: 'max' | 'sum' | null = null
        if (r.service_type === 'in_out' && r.compare_unit) logic = 'max'
        if (r.service_type === 'screening_manual' && r.compare_unit) logic = 'sum'
        await updateDoc(doc(db, 'ws_rate_schedule', r.id!), { compare_logic: logic })
        count++
      }
    }
    if (count > 0) { await loadRates(); alert(`Migrated ${count} rates.`) }
    else alert('All rates already migrated.')
  }

  function startEdit(r: WSRateSchedule) {
    setEditId(r.id!)
    setEditData({ price: r.price, minimum_charge: r.minimum_charge, free_days: r.free_days, overage_price: r.overage_price, cycle_days: r.cycle_days, compare_price: r.compare_price, extra_stop_surcharge: r.extra_stop_surcharge, active: r.active, remarks: r.remarks })
  }

  async function handleSaveGeneral() {
    if (!editId) return
    await updateDoc(doc(db, 'ws_rate_schedule', editId), editData)
    setEditId(null); setEditData({}); await loadRates()
  }

  async function toggleActiveGeneral(r: WSRateSchedule) {
    await updateDoc(doc(db, 'ws_rate_schedule', r.id!), { active: !r.active })
    await loadRates()
  }

  async function handleAddRate() {
    if (!newRate.name?.trim()) { alert('Name is required'); return }
    if (!newRate.price && newRate.price !== 0) { alert('Price is required'); return }
    const maxSort = rates.length > 0 ? Math.max(...rates.map(r => r.sort_order)) : 0
    await addDoc(collection(db, 'ws_rate_schedule'), {
      ...newRate,
      name: newRate.name!.trim(),
      sort_order: maxSort + 1,
      remarks: newRate.remarks || '',
    })
    setShowAddRate(false)
    setNewRate({
      name: '', billing_event: 'optional', service_type: 'labeling', cargo_mode: 'ALL',
      unit: 'per_piece', price: 0, currency: 'USD', minimum_charge: null,
      free_days: null, overage_price: null, cycle_days: null,
      compare_unit: null, compare_price: null, compare_logic: null,
      extra_stop_surcharge: null, active: true, sort_order: 99, remarks: '',
    })
    await loadRates()
  }

  async function handleDeleteRate(r: WSRateSchedule) {
    if (!confirm(`Delete rate "${r.name}"? This cannot be undone.`)) return
    await deleteDoc(doc(db, 'ws_rate_schedule', r.id!))
    await loadRates()
  }

  // ── Client view handlers ──
  function getDirty(rateId: string) {
    return dirtyOverrides[rateId] || null
  }

  function setDirty(rateId: string, field: 'price' | 'min' | 'active', value: string | boolean) {
    setDirtyOverrides(prev => {
      const existing = prev[rateId] || {
        price: overrideMap[rateId]?.price?.toString() ?? '',
        min: overrideMap[rateId]?.minimum_charge?.toString() ?? '',
        active: overrideMap[rateId]?.active ?? true,
      }
      return { ...prev, [rateId]: { ...existing, [field]: value } }
    })
  }

  function getEffective(rateId: string, rate: WSRateSchedule) {
    const dirty = dirtyOverrides[rateId]
    const ov = overrideMap[rateId]
    const price = dirty ? dirty.price : (ov?.price?.toString() ?? '')
    const min = dirty ? dirty.min : (ov?.minimum_charge?.toString() ?? '')
    const active = dirty ? dirty.active : (ov?.active ?? true)
    return { price, min, active }
  }

  function getStatus(rateId: string, rate: WSRateSchedule): 'override' | 'disabled' | 'general' {
    const { price, min, active } = getEffective(rateId, rate)
    if (!active) return 'disabled'
    if (price || min) return 'override'
    return 'general'
  }

  function getDiscount(rateId: string, rate: WSRateSchedule): string | null {
    const { price } = getEffective(rateId, rate)
    const p = parseFloat(price)
    if (!p || !rate.price || p >= rate.price) return null
    const pct = ((rate.price - p) / rate.price * 100).toFixed(0)
    return `-${pct}%`
  }

  async function handleSaveClientOverrides() {
    if (!selectedClientId) return
    setSavingOverrides(true)
    const clientName = clients.find(c => c.id === selectedClientId)?.name || ''
    const now = new Date().toISOString()

    for (const [rateId, dirty] of Object.entries(dirtyOverrides)) {
      const existing = overrideMap[rateId]
      const priceVal = dirty.price ? parseFloat(dirty.price) : null
      const minVal = dirty.min ? parseFloat(dirty.min) : null
      const hasData = priceVal !== null || minVal !== null || !dirty.active

      if (existing) {
        if (!hasData && dirty.active) {
          // Remove override — back to general
          await deleteDoc(doc(db, 'ws_client_rate_overrides', existing.id!))
        } else {
          await updateDoc(doc(db, 'ws_client_rate_overrides', existing.id!), {
            price: priceVal, minimum_charge: minVal, active: dirty.active, updated_at: now,
          })
        }
      } else if (hasData) {
        const rate = rates.find(r => r.id === rateId)
        await addDoc(collection(db, 'ws_client_rate_overrides'), {
          client_id: selectedClientId,
          client_name: clientName,
          rate_id: rateId,
          rate_name: rate?.name || '',
          price: priceVal,
          minimum_charge: minVal,
          active: dirty.active,
          created_at: now,
          updated_at: now,
        })
      }
    }

    await loadOverrides(selectedClientId)
    setDirtyOverrides({})
    setSavingOverrides(false)
  }

  async function handleResetClient() {
    if (!selectedClientId || !confirm('Remove all overrides for this client?')) return
    for (const ov of overrides) {
      await deleteDoc(doc(db, 'ws_client_rate_overrides', ov.id!))
    }
    await loadOverrides(selectedClientId)
    setDirtyOverrides({})
  }

  if (!isAdmin && !isAccounting) {
    return (
      <Layout title="Rates" backTo="/warehouse-services/admin">
        <p className="text-center text-gray-500 mt-10">Access restricted to Admin / Accounting</p>
      </Layout>
    )
  }

  const hasDirty = Object.keys(dirtyOverrides).length > 0

  return (
    <Layout title="WS Rate Schedule" backTo="/warehouse-services/admin">
      <div className="space-y-4">
        {/* ── Top bar ── */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm text-gray-500">{rates.length} rates</p>
          <div className="flex items-center gap-3">
            {/* View toggle */}
            <div className="flex rounded-lg border border-gray-200 overflow-hidden">
              <button
                onClick={() => { setViewMode('general'); setEditId(null) }}
                className={`px-3 py-1.5 text-xs font-semibold transition-colors ${viewMode === 'general' ? 'bg-mcl-blue text-white' : 'bg-gray-50 text-gray-400 hover:text-gray-600'}`}
              >General</button>
              <button
                onClick={() => { setViewMode('client'); setEditId(null) }}
                className={`px-3 py-1.5 text-xs font-semibold transition-colors ${viewMode === 'client' ? 'bg-mcl-blue text-white' : 'bg-gray-50 text-gray-400 hover:text-gray-600'}`}
              >Client View</button>
            </div>
            {viewMode === 'client' && (
              <select
                value={selectedClientId}
                onChange={e => setSelectedClientId(e.target.value)}
                className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm min-w-[180px]"
              >
                <option value="">Select client...</option>
                {clients.map(c => <option key={c.id} value={c.id!}>{c.name}</option>)}
              </select>
            )}
            {viewMode === 'general' && canEditRates && rates.length === 0 && (
              <button onClick={handleSeed} disabled={seeding}
                className="text-xs bg-mcl-blue hover:bg-blue-900 text-white font-semibold px-4 py-2 rounded-lg disabled:opacity-50">
                {seeding ? 'Seeding...' : 'Load Default Rates'}
              </button>
            )}
            {viewMode === 'general' && canEditRates && rates.length > 0 && rates.some(r => (r as any).compare_logic === undefined) && (
              <button onClick={handleMigrate} className="text-xs bg-amber-500 hover:bg-amber-600 text-white font-semibold px-4 py-2 rounded-lg">
                Migrate
              </button>
            )}
            {viewMode === 'general' && canEditRates && (
              <button onClick={() => setShowAddRate(true)} className="text-xs bg-mcl-blue hover:bg-blue-900 text-white font-semibold px-4 py-2 rounded-lg">
                + Add Rate
              </button>
            )}
          </div>
        </div>

        {/* ── Legend for client view ── */}
        {viewMode === 'client' && selectedClientId && (
          <div className="flex items-center gap-4 text-[10px] text-gray-500 bg-gray-50 rounded-lg px-4 py-2">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-blue-100 border border-blue-300 inline-block" /> Override</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-gray-50 border border-gray-200 inline-block" /> General</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-50 border border-red-200 inline-block" /> Disabled</span>
            <span className="ml-auto text-amber-600 font-semibold">
              {clients.find(c => c.id === selectedClientId)?.name} — {overrideCount} override{overrideCount !== 1 ? 's' : ''}
            </span>
          </div>
        )}

        {/* ── Table ── */}
        {loading ? (
          <p className="text-center text-gray-400 py-10">Loading...</p>
        ) : rates.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
            <p className="text-gray-400">No rates configured. Click "Load Default Rates" to start.</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-3 py-2 font-medium text-gray-600">Name</th>
                  <th className="text-center px-2 py-2 font-medium text-gray-600">Type</th>
                  <th className="text-center px-2 py-2 font-medium text-gray-600">Cargo</th>
                  <th className="text-right px-2 py-2 font-medium text-gray-600">
                    {viewMode === 'client' ? 'General' : 'Price'}
                  </th>
                  {viewMode === 'client' && selectedClientId && (
                    <>
                      <th className="text-right px-2 py-2 font-medium text-gray-600">Client Price</th>
                      <th className="text-right px-2 py-2 font-medium text-gray-600">Client Min</th>
                      <th className="text-center px-2 py-2 font-medium text-gray-600">Status</th>
                    </>
                  )}
                  {viewMode === 'general' && (
                    <>
                      <th className="text-center px-2 py-2 font-medium text-gray-600">Unit</th>
                      <th className="text-right px-2 py-2 font-medium text-gray-600">Min</th>
                      <th className="text-left px-2 py-2 font-medium text-gray-600">Formula</th>
                      <th className="text-left px-2 py-2 font-medium text-gray-600">Details</th>
                      <th className="text-center px-2 py-2 font-medium text-gray-600">Active</th>
                      <th className="text-center px-2 py-2 font-medium text-gray-600">Actions</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rates.map(r => {
                  // ── GENERAL VIEW ──
                  if (viewMode === 'general') {
                    const isEditing = editId === r.id
                    return (
                      <tr key={r.id} className={`hover:bg-gray-50 ${!r.active ? 'opacity-50' : ''}`}>
                        <td className="px-3 py-2 font-medium text-gray-800">{r.name}</td>
                        <td className="px-2 py-2 text-center">
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${r.billing_event === 'auto' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                            {BILLING_LABELS[r.billing_event]}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-center text-xs text-gray-500">{CARGO_LABELS[r.cargo_mode]}</td>
                        <td className="px-2 py-2 text-right font-mono">
                          {isEditing ? (
                            <input type="number" step="0.01" value={editData.price ?? ''} onChange={e => setEditData(d => ({ ...d, price: parseFloat(e.target.value) || 0 }))}
                              className="w-20 border rounded px-1 py-0.5 text-right text-xs" />
                          ) : `$${r.price.toFixed(2)}`}
                        </td>
                        <td className="px-2 py-2 text-center text-xs text-gray-500">{UNIT_LABELS[r.unit] || r.unit}</td>
                        <td className="px-2 py-2 text-right font-mono text-xs">
                          {isEditing ? (
                            <input type="number" step="1" value={editData.minimum_charge ?? ''} onChange={e => setEditData(d => ({ ...d, minimum_charge: e.target.value ? parseFloat(e.target.value) : null }))}
                              className="w-16 border rounded px-1 py-0.5 text-right text-xs" placeholder="—" />
                          ) : r.minimum_charge ? `$${r.minimum_charge}` : '—'}
                        </td>
                        <td className="px-2 py-2 text-xs">{formulaLabel(r)}</td>
                        <td className="px-2 py-2 text-xs text-gray-400 max-w-[180px] truncate" title={r.remarks}>{detailChips(r)}</td>
                        <td className="px-2 py-2 text-center">
                          <button onClick={() => toggleActiveGeneral(r)}>
                            <span className={`inline-block w-3 h-3 rounded-full cursor-pointer ${r.active ? 'bg-green-500' : 'bg-gray-300'}`} />
                          </button>
                        </td>
                        <td className="px-2 py-2 text-center">
                          {isEditing ? (
                            <div className="flex gap-1 justify-center">
                              <button onClick={handleSaveGeneral} className="text-[10px] bg-green-600 text-white px-2 py-0.5 rounded">Save</button>
                              <button onClick={() => { setEditId(null); setEditData({}) }} className="text-[10px] bg-gray-300 text-gray-700 px-2 py-0.5 rounded">Cancel</button>
                            </div>
                          ) : (
                            <div className="flex gap-1 justify-center">
                              <button onClick={() => startEdit(r)} className="text-[10px] text-mcl-blue hover:underline">Edit</button>
                              <button onClick={() => handleDeleteRate(r)} className="text-[10px] text-red-400 hover:text-red-600 hover:underline">Del</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  }

                  // ── CLIENT VIEW ──
                  if (!selectedClientId) {
                    return (
                      <tr key={r.id} className="hover:bg-gray-50">
                        <td className="px-3 py-2 font-medium text-gray-800">{r.name}</td>
                        <td className="px-2 py-2 text-center">
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${r.billing_event === 'auto' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                            {BILLING_LABELS[r.billing_event]}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-center text-xs text-gray-500">{CARGO_LABELS[r.cargo_mode]}</td>
                        <td className="px-2 py-2 text-right font-mono text-gray-400">${r.price.toFixed(2)}{UNIT_LABELS[r.unit]}</td>
                      </tr>
                    )
                  }

                  const status = getStatus(r.id!, r)
                  const disc = getDiscount(r.id!, r)
                  const eff = getEffective(r.id!, r)
                  const rowBg = status === 'override' ? 'bg-blue-50/40' : status === 'disabled' ? 'bg-red-50/30 opacity-60' : ''

                  return (
                    <tr key={r.id} className={`hover:bg-gray-50/60 ${rowBg}`}>
                      <td className="px-3 py-2 font-medium text-gray-800">{r.name}</td>
                      <td className="px-2 py-2 text-center">
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${r.billing_event === 'auto' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                          {BILLING_LABELS[r.billing_event]}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-center text-xs text-gray-500">{CARGO_LABELS[r.cargo_mode]}</td>
                      <td className="px-2 py-2 text-right font-mono text-gray-400">${r.price.toFixed(2)}{UNIT_LABELS[r.unit]}</td>
                      {/* Client Price */}
                      <td className="px-2 py-2 text-right">
                        {status === 'disabled' ? (
                          <span className="text-xs text-gray-300">N/A</span>
                        ) : (
                          <div className="inline-flex items-center gap-1">
                            <input
                              type="number" step="0.01"
                              value={eff.price}
                              onChange={e => setDirty(r.id!, 'price', e.target.value)}
                              placeholder="—"
                              className={`w-20 border rounded px-2 py-0.5 text-right text-xs font-mono ${eff.price ? 'border-blue-300 bg-blue-50 text-blue-700 font-bold' : 'border-gray-200 text-gray-300'}`}
                            />
                            {disc && <span className="text-[9px] text-green-600 font-bold">{disc}</span>}
                          </div>
                        )}
                      </td>
                      {/* Client Min */}
                      <td className="px-2 py-2 text-right">
                        {status === 'disabled' ? (
                          <span className="text-xs text-gray-300">N/A</span>
                        ) : (
                          <input
                            type="number" step="1"
                            value={eff.min}
                            onChange={e => setDirty(r.id!, 'min', e.target.value)}
                            placeholder="—"
                            className={`w-16 border rounded px-2 py-0.5 text-right text-xs font-mono ${eff.min ? 'border-blue-300 bg-blue-50 text-blue-700 font-bold' : 'border-gray-200 text-gray-300'}`}
                          />
                        )}
                      </td>
                      {/* Status badge + toggle */}
                      <td className="px-2 py-2 text-center">
                        <button
                          onClick={() => setDirty(r.id!, 'active', !eff.active)}
                          className={`text-[9px] font-bold px-2 py-0.5 rounded-full cursor-pointer ${
                            status === 'override' ? 'bg-blue-100 text-blue-700'
                            : status === 'disabled' ? 'bg-red-100 text-red-600'
                            : 'bg-gray-100 text-gray-500'
                          }`}
                        >
                          {status === 'override' ? 'OVERRIDE' : status === 'disabled' ? 'DISABLED' : 'GENERAL'}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            {/* ── Client view footer ── */}
            {viewMode === 'client' && selectedClientId && (
              <div className="px-4 py-3 border-t border-gray-100 flex justify-between items-center">
                <button onClick={handleResetClient} className="text-xs text-red-400 hover:text-red-600">
                  Reset All to General
                </button>
                <button
                  onClick={handleSaveClientOverrides}
                  disabled={!hasDirty || savingOverrides}
                  className="text-xs bg-mcl-blue hover:bg-blue-900 text-white font-semibold px-5 py-2 rounded-lg disabled:opacity-50"
                >
                  {savingOverrides ? 'Saving...' : 'Save Client Rates'}
                </button>
              </div>
            )}
          </div>
        )}

        {viewMode === 'client' && !selectedClientId && (
          <p className="text-center text-gray-400 py-6 text-sm">Select a client to view/edit their rate overrides.</p>
        )}
      </div>

      {/* Add Rate Modal */}
      {showAddRate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowAddRate(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <h3 className="font-bold text-gray-800 text-lg">Add New Rate</h3>

            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Name *</label>
              <input
                value={newRate.name || ''}
                onChange={e => setNewRate(d => ({ ...d, name: e.target.value }))}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                placeholder="e.g. Wood Pallets"
                autoFocus
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Billing</label>
                <select value={newRate.billing_event} onChange={e => setNewRate(d => ({ ...d, billing_event: e.target.value as 'auto' | 'optional' }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm">
                  <option value="auto">Auto</option>
                  <option value="optional">Optional</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Service Type</label>
                <select value={newRate.service_type} onChange={e => setNewRate(d => ({ ...d, service_type: e.target.value as any }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm">
                  {['in_out','storage','screening_k9','screening_xray','screening_manual','transport','dg_inspection','bonded_fee','dg_documentary','labeling','wrapping','order_preparation','handling_storage_fee','manual'].map(t => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Cargo Mode</label>
                <select value={newRate.cargo_mode} onChange={e => setNewRate(d => ({ ...d, cargo_mode: e.target.value as 'LOC' | 'BOND' | 'ALL' }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm">
                  <option value="ALL">All</option>
                  <option value="LOC">Local</option>
                  <option value="BOND">Bonded</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Unit *</label>
                <select value={newRate.unit} onChange={e => setNewRate(d => ({ ...d, unit: e.target.value as any }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm">
                  {Object.entries(UNIT_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v} ({k})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Price *</label>
                <input type="number" step="0.01" min="0"
                  value={newRate.price ?? ''}
                  onChange={e => setNewRate(d => ({ ...d, price: parseFloat(e.target.value) || 0 }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-right font-mono focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Minimum</label>
                <input type="number" step="1" min="0"
                  value={newRate.minimum_charge ?? ''}
                  onChange={e => setNewRate(d => ({ ...d, minimum_charge: e.target.value ? parseFloat(e.target.value) : null }))}
                  placeholder="—"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-right font-mono focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                />
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Remarks</label>
              <input
                value={newRate.remarks || ''}
                onChange={e => setNewRate(d => ({ ...d, remarks: e.target.value }))}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                placeholder="Description or notes about this rate"
              />
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => setShowAddRate(false)} className="text-sm text-gray-500 hover:text-gray-700 px-4 py-2">Cancel</button>
              <button onClick={handleAddRate} className="text-sm bg-mcl-blue hover:bg-blue-900 text-white font-semibold px-5 py-2 rounded-lg">
                Add Rate
              </button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}
