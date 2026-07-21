import { useEffect, useState } from 'react'
import Layout from '../components/Layout'
import { db } from '../lib/firebase'
import { fmtUSD } from '../lib/utils'
import {
  collection, getDocs, addDoc, updateDoc, deleteDoc, setDoc,
  doc, query, orderBy, where
} from 'firebase/firestore'
import { RateSchedule, Client } from '../types'

const UNIT_LABELS: Record<string, string> = {
  per_cbm:       '/ CBM',
  per_pallet:    '/ Pallet',
  per_kg:        '/ KG',
  flat:          'Fijo',
  per_day_pallet:'/ Pallet/Día',
  per_container: '/ Contenedor',
  per_bl:        '/ BL',
  per_report:    '/ Reporte',
  per_wr:        '/ WR',
  per_lbs:       '/ Lb',
  per_label:     '/ Label',
}

type InOutLogic = 'max' | 'cbm_only' | 'pallet_only'

interface ClientBillingConfig {
  inout_logic: InOutLogic
  free_days_loc: number
  free_days_bond: number
}

interface ClientRateOverride {
  id?: string
  client_id: string
  client_name: string
  rate_id: string | null       // null = tarifa exclusiva del cliente
  rate_name: string
  billing_event: string
  unit: string
  price: number
  active: boolean
  cargo_type: string
  remarks?: string
  is_custom?: boolean          // true = exclusiva del cliente
}

const INITIAL_RATES: Omit<RateSchedule, 'id'>[] = [
  { name: 'Unloading', billing_event: 'reception', unit: 'per_cbm', price: 12, currency: 'USD', cargo_type: 'BOTH', active: true, remarks: 'Receiving Charges — aplica a LOC y BOND', sort_order: 10 },
  { name: 'In/Out Cargo', billing_event: 'reception', unit: 'per_pallet', price: 15, currency: 'USD', cargo_type: 'LOC', active: true, remarks: 'Se cobra el mayor entre CBM×$12 y Pallets×$15', sort_order: 20 },
  { name: 'Labelling Fee', billing_event: 'reception', unit: 'per_label', price: 0, currency: 'USD', cargo_type: 'LOC', active: true, remarks: 'If Requested', sort_order: 30 },
  { name: "Loading 20' Forklift", billing_event: 'dispatch', unit: 'per_container', price: 325, currency: 'USD', cargo_type: 'LOC', container_size: '20', loading_type: 'forklift', active: true, remarks: 'Forklift Loading', sort_order: 100 },
  { name: "Loading 40' Forklift", billing_event: 'dispatch', unit: 'per_container', price: 450, currency: 'USD', cargo_type: 'LOC', container_size: '40', loading_type: 'forklift', active: true, remarks: 'Forklift Loading', sort_order: 110 },
  { name: "Loading 20' By Hand", billing_event: 'dispatch', unit: 'per_container', price: 475, currency: 'USD', cargo_type: 'LOC', container_size: '20', loading_type: 'by_hand', active: true, remarks: 'Manual Loading', sort_order: 120 },
  { name: "Loading 40' By Hand", billing_event: 'dispatch', unit: 'per_container', price: 600, currency: 'USD', cargo_type: 'LOC', container_size: '40', loading_type: 'by_hand', active: true, remarks: 'Manual Loading', sort_order: 130 },
  { name: "Drayage 20'", billing_event: 'dispatch', unit: 'per_container', price: 550, currency: 'USD', cargo_type: 'LOC', container_size: '20', active: true, remarks: 'All-In Rate to Port Everglades', sort_order: 140 },
  { name: "Drayage 40'", billing_event: 'dispatch', unit: 'per_container', price: 550, currency: 'USD', cargo_type: 'LOC', container_size: '40', active: true, remarks: 'All-In Rate to Port Everglades', sort_order: 150 },
  { name: 'Export Docs Fee', billing_event: 'dispatch', unit: 'per_bl', price: 115, currency: 'USD', cargo_type: 'LOC', active: true, remarks: 'Booking + Coordination + SED + Final BOL + Transmisión', sort_order: 160 },
  { name: 'Storage LOC', billing_event: 'dispatch', unit: 'per_day_pallet', price: 3, currency: 'USD', cargo_type: 'LOC', active: true, remarks: '21 días libres consecutivos (1er mes)', sort_order: 170 },
  { name: 'Drayage Hazmat', billing_event: 'dispatch', unit: 'per_container', price: 100, currency: 'USD', cargo_type: 'LOC', active: true, remarks: 'Aplica si hay DG/Hazmat', sort_order: 180 },
  { name: 'Palletizing', billing_event: 'optional', unit: 'per_pallet', price: 35, currency: 'USD', cargo_type: 'LOC', active: true, remarks: 'If Applicable, certified pallet included', sort_order: 200 },
  { name: 'Shrink Wrapping', billing_event: 'optional', unit: 'per_pallet', price: 20, currency: 'USD', cargo_type: 'LOC', active: true, remarks: 'If Applicable', sort_order: 210 },
  { name: 'Wood Pallet', billing_event: 'optional', unit: 'per_pallet', price: 13, currency: 'USD', cargo_type: 'LOC', active: true, remarks: 'If Applicable', sort_order: 220 },
  { name: 'Plastic Pallet Exchange', billing_event: 'optional', unit: 'per_pallet', price: 35, currency: 'USD', cargo_type: 'LOC', active: true, remarks: 'If Applicable', sort_order: 230 },
  { name: 'Pallet Break Down', billing_event: 'optional', unit: 'per_pallet', price: 35, currency: 'USD', cargo_type: 'LOC', active: true, remarks: 'If Applicable', sort_order: 240 },
  { name: 'Wrapping Adicional', billing_event: 'optional', unit: 'per_pallet', price: 10, currency: 'USD', cargo_type: 'LOC', active: true, remarks: 'If Applicable', sort_order: 250 },
  { name: 'Inventory Report', billing_event: 'optional', unit: 'per_report', price: 300, currency: 'USD', cargo_type: 'LOC', active: true, remarks: '1 Free per Year', sort_order: 260 },
  { name: 'In/Out Cargo BOND', billing_event: 'reception', unit: 'per_pallet', price: 20, currency: 'USD', cargo_type: 'BOND', active: true, remarks: 'Se cobra el mayor entre Pallets×$20 o CBM×$12', sort_order: 40 },
  { name: 'Bonded Fee', billing_event: 'reception', unit: 'per_wr', price: 50, currency: 'USD', cargo_type: 'BOND', active: true, remarks: 'Por cada Warehouse Receipt', sort_order: 50 },
  { name: 'Storage BOND', billing_event: 'dispatch', unit: 'per_day_pallet', price: 15, currency: 'USD', cargo_type: 'BOND', active: true, remarks: '5 días libres con contenedor; $15/pallet + $3/día a partir del 6to día', sort_order: 190 },
  { name: 'Storage BOND Oversize', billing_event: 'dispatch', unit: 'per_day_pallet', price: 25, currency: 'USD', cargo_type: 'BOND', active: true, remarks: 'Carga >48"×40"×65"; $25/pallet + $3/día a partir del 6to día', sort_order: 195 },
]

export default function BillingRates() {
  const [rates, setRates]       = useState<RateSchedule[]>([])
  const [clients, setClients]   = useState<Client[]>([])
  const [loading, setLoading]   = useState(true)
  const [mainTab, setMainTab]   = useState<'general' | 'client'>('general')
  const [rateTab, setRateTab]   = useState<'reception' | 'dispatch' | 'optional'>('reception')

  // General rate editing
  const [editingId, setEditingId]   = useState<string | null>(null)
  const [editPrice, setEditPrice]   = useState('')
  const [editActive, setEditActive] = useState(true)
  const [seeding, setSeeding]       = useState(false)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newRate, setNewRate]       = useState<Partial<RateSchedule>>({
    billing_event: 'reception', unit: 'per_pallet', currency: 'USD', cargo_type: 'LOC', active: true, price: 0,
  })

  // Client overrides
  const [selectedClientId, setSelectedClientId]   = useState('')
  const [clientOverrides, setClientOverrides]      = useState<ClientRateOverride[]>([])
  const [loadingOverrides, setLoadingOverrides]    = useState(false)
  const [inoutLogic, setInoutLogic]               = useState<InOutLogic>('max')
  const [freeDaysLoc, setFreeDaysLoc]             = useState(21)
  const [freeDaysBond, setFreeDaysBond]           = useState(5)
  const [savingConfig, setSavingConfig]           = useState(false)
  const [editingOverrideId, setEditingOverrideId]  = useState<string | null>(null)  // rate_id being overridden
  const [overridePrice, setOverridePrice]          = useState('')
  const [overrideActive, setOverrideActive]        = useState(true)
  const [showAddCustom, setShowAddCustom]          = useState(false)
  const [newCustomRate, setNewCustomRate]          = useState<Partial<ClientRateOverride>>({
    billing_event: 'reception', unit: 'per_pallet', cargo_type: 'LOC', active: true, price: 0,
  })
  const [saving, setSaving] = useState(false)

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    try {
      const [rSnap, cSnap] = await Promise.all([
        getDocs(query(collection(db, 'rate_schedule'), orderBy('sort_order'))),
        getDocs(query(collection(db, 'clients'), orderBy('name'))),
      ])
      const loadedRates = rSnap.docs.map(d => ({ id: d.id, ...d.data() })) as RateSchedule[]
      // One-time migration: Unloading should be BOTH (LOC + BOND)
      for (const r of loadedRates) {
        if (r.name === 'Unloading' && r.cargo_type === 'LOC') {
          await updateDoc(doc(db, 'rate_schedule', r.id!), { cargo_type: 'BOTH' })
          r.cargo_type = 'BOTH'
        }
      }
      setRates(loadedRates)
      setClients(cSnap.docs.map(d => ({ id: d.id, ...d.data() })) as Client[])
    } catch (e) { console.error(e) }
    setLoading(false)
  }

  async function loadClientOverrides(clientId: string) {
    if (!clientId) { setClientOverrides([]); return }
    setLoadingOverrides(true)
    try {
      const [overridesSnap, configSnap] = await Promise.all([
        getDocs(query(collection(db, 'client_billing_rates'), where('client_id', '==', clientId))),
        getDocs(query(collection(db, 'client_billing_config'), where('__name__', '==', clientId))),
      ])
      setClientOverrides(overridesSnap.docs.map(d => ({ id: d.id, ...d.data() })) as ClientRateOverride[])
      if (!configSnap.empty) {
        const cfg = configSnap.docs[0].data() as ClientBillingConfig
        setInoutLogic(cfg.inout_logic || 'max')
        setFreeDaysLoc(cfg.free_days_loc ?? 21)
        setFreeDaysBond(cfg.free_days_bond ?? 5)
      } else {
        setInoutLogic('max')
        setFreeDaysLoc(21)
        setFreeDaysBond(5)
      }
    } catch (e) { console.error(e) }
    setLoadingOverrides(false)
  }

  async function saveInoutLogic(logic: InOutLogic) {
    if (!selectedClientId) return
    setInoutLogic(logic)
    setSavingConfig(true)
    try {
      await setDoc(doc(db, 'client_billing_config', selectedClientId), { inout_logic: logic }, { merge: true })
    } catch (e) { console.error(e) }
    setSavingConfig(false)
  }

  async function saveFreeDays(loc: number, bond: number) {
    if (!selectedClientId) return
    setFreeDaysLoc(loc)
    setFreeDaysBond(bond)
    setSavingConfig(true)
    try {
      await setDoc(doc(db, 'client_billing_config', selectedClientId), { free_days_loc: loc, free_days_bond: bond }, { merge: true })
    } catch (e) { console.error(e) }
    setSavingConfig(false)
  }

  function handleClientChange(id: string) {
    setSelectedClientId(id)
    setEditingOverrideId(null)
    setShowAddCustom(false)
    loadClientOverrides(id)
  }

  // ── General rates ─────────────────────────────────────────────────────

  async function seedRates() {
    setSeeding(true)
    try {
      await Promise.all(INITIAL_RATES.map(r => addDoc(collection(db, 'rate_schedule'), r)))
      await loadAll()
    } catch (e) { console.error(e) }
    setSeeding(false)
  }

  async function saveGeneralEdit(rate: RateSchedule) {
    setSaving(true)
    try {
      await updateDoc(doc(db, 'rate_schedule', rate.id!), {
        price: parseFloat(editPrice) || 0, active: editActive,
      })
      setRates(prev => prev.map(r => r.id === rate.id
        ? { ...r, price: parseFloat(editPrice) || 0, active: editActive } : r))
      setEditingId(null)
    } catch (e) { console.error(e) }
    setSaving(false)
  }

  async function addGeneralRate() {
    if (!newRate.name?.trim()) return
    setSaving(true)
    try {
      const maxOrder = rates.length > 0 ? Math.max(...rates.map(r => r.sort_order || 0)) + 10 : 10
      const ref = await addDoc(collection(db, 'rate_schedule'), { ...newRate, sort_order: maxOrder })
      setRates(prev => [...prev, { id: ref.id, ...newRate } as RateSchedule])
      setShowAddForm(false)
      setNewRate({ billing_event: 'reception', unit: 'per_pallet', currency: 'USD', cargo_type: 'LOC', active: true, price: 0 })
    } catch (e) { console.error(e) }
    setSaving(false)
  }

  // ── Client overrides ──────────────────────────────────────────────────

  function getOverride(rateId: string) {
    return clientOverrides.find(o => o.rate_id === rateId)
  }

  async function saveOverride(rate: RateSchedule) {
    if (!selectedClientId) return
    setSaving(true)
    const client = clients.find(c => c.id === selectedClientId)
    try {
      const existing = getOverride(rate.id!)
      const data: Omit<ClientRateOverride, 'id'> = {
        client_id:     selectedClientId,
        client_name:   client?.name || '',
        rate_id:       rate.id!,
        rate_name:     rate.name,
        billing_event: rate.billing_event,
        unit:          rate.unit,
        price:         parseFloat(overridePrice) || 0,
        active:        overrideActive,
        cargo_type:    rate.cargo_type,
        remarks:       rate.remarks,
        is_custom:     false,
      }
      if (existing?.id) {
        await updateDoc(doc(db, 'client_billing_rates', existing.id), data)
        setClientOverrides(prev => prev.map(o => o.id === existing.id ? { ...o, ...data } : o))
      } else {
        const ref = await addDoc(collection(db, 'client_billing_rates'), data)
        setClientOverrides(prev => [...prev, { id: ref.id, ...data }])
      }
      setEditingOverrideId(null)
    } catch (e) { console.error(e) }
    setSaving(false)
  }

  async function removeOverride(rateId: string) {
    const existing = getOverride(rateId)
    if (!existing?.id) return
    setSaving(true)
    try {
      await deleteDoc(doc(db, 'client_billing_rates', existing.id))
      setClientOverrides(prev => prev.filter(o => o.id !== existing.id))
    } catch (e) { console.error(e) }
    setSaving(false)
  }

  async function addCustomRate() {
    if (!newCustomRate.rate_name?.trim() || !selectedClientId) return
    const client = clients.find(c => c.id === selectedClientId)
    setSaving(true)
    try {
      const data: Omit<ClientRateOverride, 'id'> = {
        client_id:     selectedClientId,
        client_name:   client?.name || '',
        rate_id:       null,
        rate_name:     newCustomRate.rate_name || '',
        billing_event: newCustomRate.billing_event || 'reception',
        unit:          newCustomRate.unit || 'per_pallet',
        price:         newCustomRate.price || 0,
        active:        newCustomRate.active ?? true,
        cargo_type:    newCustomRate.cargo_type || 'LOC',
        remarks:       newCustomRate.remarks || '',
        is_custom:     true,
      }
      const ref = await addDoc(collection(db, 'client_billing_rates'), data)
      setClientOverrides(prev => [...prev, { id: ref.id, ...data }])
      setShowAddCustom(false)
      setNewCustomRate({ billing_event: 'reception', unit: 'per_pallet', cargo_type: 'LOC', active: true, price: 0 })
    } catch (e) { console.error(e) }
    setSaving(false)
  }

  async function removeCustomRate(overrideId: string) {
    setSaving(true)
    try {
      await deleteDoc(doc(db, 'client_billing_rates', overrideId))
      setClientOverrides(prev => prev.filter(o => o.id !== overrideId))
    } catch (e) { console.error(e) }
    setSaving(false)
  }

  // ── Render helpers ────────────────────────────────────────────────────

  const inputClass = 'border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-mcl-blue/30'
  const tabRates   = rates.filter(r => r.billing_event === rateTab)
  const customRates = clientOverrides.filter(o => o.is_custom)
  const selectedClient = clients.find(c => c.id === selectedClientId)

  const rateTabs: Array<{ key: typeof rateTab; label: string }> = [
    { key: 'reception', label: 'Recepción' },
    { key: 'dispatch',  label: 'Consolidado'  },
    { key: 'optional',  label: 'Opcionales'},
  ]

  return (
    <Layout title="Tarifario" backTo="/billing">
      <div className="max-w-5xl mx-auto">
        {loading ? (
          <div className="p-8 text-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue mx-auto" /></div>
        ) : rates.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-12 text-center">
            <p className="text-gray-400 mb-4">No hay tarifas configuradas.</p>
            <button onClick={seedRates} disabled={seeding}
              className="bg-mcl-blue text-white px-6 py-2.5 rounded-lg text-sm font-semibold hover:bg-blue-900 transition-colors disabled:opacity-50">
              {seeding ? 'Inicializando...' : 'Inicializar Tarifario 2026'}
            </button>
          </div>
        ) : (
          <>
            {/* Main tabs */}
            <div className="flex gap-1 mb-5 bg-white rounded-xl border border-gray-100 shadow-sm p-1 w-fit">
              <button onClick={() => setMainTab('general')}
                className={`px-5 py-2 rounded-lg text-sm font-semibold transition-colors ${mainTab === 'general' ? 'bg-mcl-blue text-white' : 'text-gray-500 hover:bg-gray-50'}`}>
                Tarifario General
              </button>
              <button onClick={() => setMainTab('client')}
                className={`px-5 py-2 rounded-lg text-sm font-semibold transition-colors ${mainTab === 'client' ? 'bg-mcl-blue text-white' : 'text-gray-500 hover:bg-gray-50'}`}>
                Por Cliente
              </button>
            </div>

            {/* ── GENERAL ── */}
            {mainTab === 'general' && (
              <>
                <div className="flex gap-1 mb-4 bg-white rounded-xl border border-gray-100 shadow-sm p-1 w-fit">
                  {rateTabs.map(t => (
                    <button key={t.key} onClick={() => setRateTab(t.key)}
                      className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${rateTab === t.key ? 'bg-mcl-blue/10 text-mcl-blue' : 'text-gray-500 hover:bg-gray-50'}`}>
                      {t.label}
                      <span className="ml-2 text-xs rounded-full px-1.5 py-0.5 bg-gray-100 text-gray-400">
                        {rates.filter(r => r.billing_event === t.key).length}
                      </span>
                    </button>
                  ))}
                </div>

                <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden mb-4">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-100">
                      <tr>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Concepto</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase hidden sm:table-cell">Unidad</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase hidden md:table-cell">Tipo</th>
                        <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Tarifa</th>
                        <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Activo</th>
                        <th className="px-4 py-3 w-20"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {tabRates.map(rate => (
                        <tr key={rate.id} className={`hover:bg-gray-50 transition-colors ${!rate.active ? 'opacity-40' : ''}`}>
                          <td className="px-4 py-3">
                            <div className="font-medium text-gray-800">{rate.name}</div>
                            {rate.remarks && <div className="text-xs text-gray-400 mt-0.5">{rate.remarks}</div>}
                          </td>
                          <td className="px-4 py-3 text-gray-500 text-xs hidden sm:table-cell">{UNIT_LABELS[rate.unit] || rate.unit}</td>
                          <td className="px-4 py-3 hidden md:table-cell">
                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${rate.cargo_type === 'BOND' ? 'bg-amber-100 text-amber-700' : rate.cargo_type === 'BOTH' ? 'bg-purple-50 text-purple-700' : 'bg-blue-50 text-mcl-blue'}`}>
                              {rate.cargo_type === 'BOTH' ? 'LOC/BOND' : rate.cargo_type}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            {editingId === rate.id ? (
                              <input type="number" step="0.01" value={editPrice} onChange={e => setEditPrice(e.target.value)}
                                className={inputClass + ' w-24 text-right'} autoFocus />
                            ) : (
                              <span className="font-mono font-semibold text-gray-700">
                                {rate.price === 0 ? '—' : fmtUSD(rate.price)}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-center">
                            {editingId === rate.id ? (
                              <input type="checkbox" checked={editActive} onChange={e => setEditActive(e.target.checked)} className="w-4 h-4 accent-mcl-blue" />
                            ) : (
                              <span className={`inline-block w-2 h-2 rounded-full ${rate.active ? 'bg-green-400' : 'bg-gray-300'}`} />
                            )}
                          </td>
                          <td className="px-4 py-3 text-right">
                            {editingId === rate.id ? (
                              <div className="flex gap-1 justify-end">
                                <button onClick={() => saveGeneralEdit(rate)} disabled={saving}
                                  className="w-7 h-7 rounded-full bg-green-500 hover:bg-green-600 text-white flex items-center justify-center">
                                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                                </button>
                                <button onClick={() => setEditingId(null)}
                                  className="w-7 h-7 rounded-full bg-gray-200 hover:bg-gray-300 text-gray-600 flex items-center justify-center">
                                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
                                </button>
                              </div>
                            ) : (
                              <button onClick={() => { setEditingId(rate.id!); setEditPrice(String(rate.price)); setEditActive(rate.active) }}
                                className="w-7 h-7 rounded-full bg-gray-100 hover:bg-mcl-blue hover:text-white text-gray-400 flex items-center justify-center transition-colors">
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {showAddForm ? (
                  <div className="bg-white rounded-xl border border-mcl-blue/30 shadow-sm p-4">
                    <h3 className="text-sm font-semibold text-gray-700 mb-3">Nueva Tarifa General</h3>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-3">
                      <div className="col-span-2">
                        <label className="block text-xs text-gray-500 mb-1">Nombre *</label>
                        <input value={newRate.name || ''} onChange={e => setNewRate(p => ({ ...p, name: e.target.value }))}
                          className={inputClass + ' w-full'} placeholder="Nombre del concepto" />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Evento</label>
                        <select value={newRate.billing_event} onChange={e => setNewRate(p => ({ ...p, billing_event: e.target.value as any }))} className={inputClass + ' w-full'}>
                          <option value="reception">Recepción</option>
                          <option value="dispatch">Consolidado</option>
                          <option value="optional">Opcional</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Unidad</label>
                        <select value={newRate.unit} onChange={e => setNewRate(p => ({ ...p, unit: e.target.value as any }))} className={inputClass + ' w-full'}>
                          {Object.entries(UNIT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Tarifa (USD)</label>
                        <input type="number" step="0.01" value={newRate.price || 0}
                          onChange={e => setNewRate(p => ({ ...p, price: parseFloat(e.target.value) || 0 }))} className={inputClass + ' w-full'} />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Tipo de Carga</label>
                        <select value={newRate.cargo_type} onChange={e => setNewRate(p => ({ ...p, cargo_type: e.target.value as any }))} className={inputClass + ' w-full'}>
                          <option value="LOC">LOC</option>
                          <option value="BOND">BOND</option>
                          <option value="BOTH">AMBOS</option>
                        </select>
                      </div>
                      <div className="col-span-2 sm:col-span-3 lg:col-span-4">
                        <label className="block text-xs text-gray-500 mb-1">Observaciones</label>
                        <input value={newRate.remarks || ''} onChange={e => setNewRate(p => ({ ...p, remarks: e.target.value }))}
                          className={inputClass + ' w-full'} placeholder="Notas opcionales" />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={addGeneralRate} disabled={saving || !newRate.name?.trim()}
                        className="bg-mcl-blue text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-900 disabled:opacity-50">
                        {saving ? 'Guardando...' : 'Agregar'}
                      </button>
                      <button onClick={() => setShowAddForm(false)}
                        className="border border-gray-200 text-gray-500 px-4 py-2 rounded-lg text-sm hover:bg-gray-50">
                        Cancelar
                      </button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => setShowAddForm(true)}
                    className="flex items-center gap-2 border border-dashed border-gray-300 text-gray-400 hover:border-mcl-blue hover:text-mcl-blue px-4 py-2.5 rounded-xl text-sm transition-colors w-full justify-center">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                    Agregar Nueva Tarifa General
                  </button>
                )}
              </>
            )}

            {/* ── POR CLIENTE ── */}
            {mainTab === 'client' && (
              <>
                {/* Client selector */}
                <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 mb-4">
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Seleccionar Cliente</label>
                  <select
                    className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30 bg-white w-full sm:w-80"
                    value={selectedClientId}
                    onChange={e => handleClientChange(e.target.value)}
                  >
                    <option value="">— Seleccionar cliente —</option>
                    {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>

                {/* In/Out logic — only show when client is selected */}
                {selectedClientId && !loadingOverrides && (
                  <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 mb-4">
                    <div className="flex items-center justify-between flex-wrap gap-3">
                      <div>
                        <p className="text-sm font-semibold text-gray-700">Lógica de cobro In/Out</p>
                        <p className="text-xs text-gray-400 mt-0.5">Define cómo se calcula el cargo de recepción (Unloading vs In/Out Cargo)</p>
                      </div>
                      <div className="flex rounded-lg overflow-hidden border border-gray-200">
                        {([
                          { key: 'max',          label: 'Mayor de CBM o Pallet', desc: 'MAX($12×CBM, $15×Pallets)' },
                          { key: 'cbm_only',     label: 'Siempre Unloading',     desc: '$12 × CBM' },
                          { key: 'pallet_only',  label: 'Siempre In/Out',        desc: '$15 × Pallets' },
                        ] as const).map((opt, i) => (
                          <button
                            key={opt.key}
                            type="button"
                            disabled={savingConfig}
                            onClick={() => saveInoutLogic(opt.key)}
                            title={opt.desc}
                            className={`px-4 py-2 text-xs font-semibold transition-colors ${i > 0 ? 'border-l border-gray-200' : ''} ${inoutLogic === opt.key ? 'bg-mcl-blue text-white' : 'bg-white text-gray-400 hover:bg-gray-50'} disabled:opacity-60`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <p className="text-xs text-gray-400 mt-2">
                      {inoutLogic === 'max'         && '→ Se cobra el mayor entre Unloading (CBM×tarifa) e In/Out (Pallets×tarifa)'}
                      {inoutLogic === 'cbm_only'    && '→ Solo se cobra Unloading por CBM, sin importar la cantidad de pallets'}
                      {inoutLogic === 'pallet_only' && '→ Solo se cobra In/Out por pallet, sin importar los CBM'}
                    </p>
                  </div>
                )}

                {/* Free storage days — only show when client is selected */}
                {selectedClientId && !loadingOverrides && (
                  <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 mb-4">
                    <div className="flex items-center justify-between flex-wrap gap-3">
                      <div>
                        <p className="text-sm font-semibold text-gray-700">Días Free de Storage</p>
                        <p className="text-xs text-gray-400 mt-0.5">Días sin cargo de almacenaje por tipo de carga (default: LOC 21, BOND 5)</p>
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-gray-500">LOC</span>
                          <input
                            type="number" min={0} value={freeDaysLoc}
                            onChange={e => setFreeDaysLoc(parseInt(e.target.value) || 0)}
                            onBlur={() => saveFreeDays(freeDaysLoc, freeDaysBond)}
                            disabled={savingConfig}
                            className="w-16 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-center font-mono focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                          />
                          <span className="text-xs text-gray-400">días</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-gray-500">BOND</span>
                          <input
                            type="number" min={0} value={freeDaysBond}
                            onChange={e => setFreeDaysBond(parseInt(e.target.value) || 0)}
                            onBlur={() => saveFreeDays(freeDaysLoc, freeDaysBond)}
                            disabled={savingConfig}
                            className="w-16 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-center font-mono focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                          />
                          <span className="text-xs text-gray-400">días</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {!selectedClientId ? (
                  <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-10 text-center text-gray-400 text-sm">
                    Seleccioná un cliente para ver y editar sus tarifas diferenciadas.
                  </div>
                ) : loadingOverrides ? (
                  <div className="p-8 text-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-mcl-blue mx-auto" /></div>
                ) : (
                  <>
                    {/* Override table — general rates with client customizations */}
                    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden mb-4">
                      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                        <div>
                          <p className="text-sm font-semibold text-gray-700">Tarifas de <span className="text-mcl-blue">{selectedClient?.name}</span></p>
                          <p className="text-xs text-gray-400 mt-0.5">Las filas resaltadas tienen tarifa diferenciada. Las demás aplican el tarifario general.</p>
                        </div>
                      </div>
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 border-b border-gray-100">
                          <tr>
                            <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Concepto</th>
                            <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase hidden sm:table-cell">Evento</th>
                            <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase">General</th>
                            <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Cliente</th>
                            <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Activo</th>
                            <th className="px-4 py-3 w-24"></th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                          {rates.map(rate => {
                            const override = getOverride(rate.id!)
                            const isEditing = editingOverrideId === rate.id
                            const hasOverride = !!override

                            return (
                              <tr key={rate.id} className={`transition-colors ${hasOverride ? 'bg-blue-50/50' : 'hover:bg-gray-50'}`}>
                                <td className="px-4 py-3">
                                  <div className="flex items-center gap-2">
                                    <span className="font-medium text-gray-800">{rate.name}</span>
                                    {hasOverride && (
                                      <span className="text-xs bg-mcl-blue text-white px-1.5 py-0.5 rounded font-semibold">CUSTOM</span>
                                    )}
                                  </div>
                                  <div className="text-xs text-gray-400">{UNIT_LABELS[rate.unit]}</div>
                                </td>
                                <td className="px-4 py-3 hidden sm:table-cell">
                                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${rate.cargo_type === 'BOND' ? 'bg-amber-100 text-amber-700' : rate.cargo_type === 'BOTH' ? 'bg-purple-50 text-purple-700' : 'bg-blue-50 text-mcl-blue'}`}>
                                    {rate.cargo_type === 'BOTH' ? 'LOC/BOND' : rate.cargo_type}
                                  </span>
                                </td>
                                <td className="px-4 py-3 text-right font-mono text-gray-400 text-xs">
                                  {rate.price === 0 ? '—' : fmtUSD(rate.price)}
                                </td>
                                <td className="px-4 py-3 text-right">
                                  {isEditing ? (
                                    <input type="number" step="0.01" value={overridePrice}
                                      onChange={e => setOverridePrice(e.target.value)}
                                      className={inputClass + ' w-24 text-right'} autoFocus />
                                  ) : (
                                    <span className={`font-mono font-semibold ${hasOverride ? 'text-mcl-blue' : 'text-gray-300'}`}>
                                      {hasOverride ? fmtUSD(override!.price) : '—'}
                                    </span>
                                  )}
                                </td>
                                <td className="px-4 py-3 text-center">
                                  {isEditing ? (
                                    <input type="checkbox" checked={overrideActive} onChange={e => setOverrideActive(e.target.checked)} className="w-4 h-4 accent-mcl-blue" />
                                  ) : (
                                    <span className={`inline-block w-2 h-2 rounded-full ${hasOverride ? (override!.active ? 'bg-green-400' : 'bg-red-300') : 'bg-gray-200'}`} />
                                  )}
                                </td>
                                <td className="px-4 py-3 text-right">
                                  {isEditing ? (
                                    <div className="flex gap-1 justify-end">
                                      <button onClick={() => saveOverride(rate)} disabled={saving}
                                        className="w-7 h-7 rounded-full bg-green-500 hover:bg-green-600 text-white flex items-center justify-center">
                                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                                      </button>
                                      <button onClick={() => setEditingOverrideId(null)}
                                        className="w-7 h-7 rounded-full bg-gray-200 hover:bg-gray-300 text-gray-600 flex items-center justify-center">
                                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
                                      </button>
                                    </div>
                                  ) : (
                                    <div className="flex gap-1 justify-end">
                                      <button
                                        onClick={() => { setEditingOverrideId(rate.id!); setOverridePrice(String(override?.price ?? rate.price)); setOverrideActive(override?.active ?? rate.active) }}
                                        className="w-7 h-7 rounded-full bg-gray-100 hover:bg-mcl-blue hover:text-white text-gray-400 flex items-center justify-center transition-colors"
                                        title="Editar tarifa para este cliente">
                                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                                      </button>
                                      {hasOverride && (
                                        <button onClick={() => removeOverride(rate.id!)} disabled={saving}
                                          className="w-7 h-7 rounded-full bg-gray-100 hover:bg-red-100 hover:text-red-500 text-gray-300 flex items-center justify-center transition-colors"
                                          title="Quitar override — vuelve al tarifario general">
                                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                        </button>
                                      )}
                                    </div>
                                  )}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>

                    {/* Custom (client-exclusive) rates */}
                    {customRates.length > 0 && (
                      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden mb-4">
                        <div className="px-4 py-3 border-b border-gray-100">
                          <p className="text-sm font-semibold text-gray-700">Tarifas exclusivas de <span className="text-mcl-blue">{selectedClient?.name}</span></p>
                          <p className="text-xs text-gray-400 mt-0.5">Conceptos adicionales no incluidos en el tarifario general.</p>
                        </div>
                        <table className="w-full text-sm">
                          <thead className="bg-gray-50 border-b border-gray-100">
                            <tr>
                              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Concepto</th>
                              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase hidden sm:table-cell">Unidad</th>
                              <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Tarifa</th>
                              <th className="px-4 py-3 w-16"></th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-50">
                            {customRates.map(cr => (
                              <tr key={cr.id} className="hover:bg-gray-50">
                                <td className="px-4 py-3">
                                  <div className="font-medium text-gray-800">{cr.rate_name}</div>
                                  <div className="text-xs text-gray-400">{cr.billing_event} · {cr.cargo_type}</div>
                                </td>
                                <td className="px-4 py-3 text-xs text-gray-500 hidden sm:table-cell">{UNIT_LABELS[cr.unit] || cr.unit}</td>
                                <td className="px-4 py-3 text-right font-mono font-semibold text-gray-700">
                                  {cr.price === 0 ? '—' : fmtUSD(cr.price)}
                                </td>
                                <td className="px-4 py-3 text-right">
                                  <button onClick={() => removeCustomRate(cr.id!)} disabled={saving}
                                    className="w-7 h-7 rounded-full bg-gray-100 hover:bg-red-100 hover:text-red-500 text-gray-300 flex items-center justify-center transition-colors ml-auto">
                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* Add client-exclusive rate */}
                    {showAddCustom ? (
                      <div className="bg-white rounded-xl border border-mcl-blue/30 shadow-sm p-4">
                        <h3 className="text-sm font-semibold text-gray-700 mb-3">Nueva tarifa exclusiva para {selectedClient?.name}</h3>
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-3">
                          <div className="col-span-2">
                            <label className="block text-xs text-gray-500 mb-1">Nombre *</label>
                            <input value={newCustomRate.rate_name || ''} onChange={e => setNewCustomRate(p => ({ ...p, rate_name: e.target.value }))}
                              className={inputClass + ' w-full'} placeholder="Nombre del concepto" />
                          </div>
                          <div>
                            <label className="block text-xs text-gray-500 mb-1">Evento</label>
                            <select value={newCustomRate.billing_event} onChange={e => setNewCustomRate(p => ({ ...p, billing_event: e.target.value }))} className={inputClass + ' w-full'}>
                              <option value="reception">Recepción</option>
                              <option value="dispatch">Consolidado</option>
                              <option value="optional">Opcional</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs text-gray-500 mb-1">Unidad</label>
                            <select value={newCustomRate.unit} onChange={e => setNewCustomRate(p => ({ ...p, unit: e.target.value }))} className={inputClass + ' w-full'}>
                              {Object.entries(UNIT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs text-gray-500 mb-1">Tarifa (USD)</label>
                            <input type="number" step="0.01" value={newCustomRate.price || 0}
                              onChange={e => setNewCustomRate(p => ({ ...p, price: parseFloat(e.target.value) || 0 }))} className={inputClass + ' w-full'} />
                          </div>
                          <div>
                            <label className="block text-xs text-gray-500 mb-1">Tipo de Carga</label>
                            <select value={newCustomRate.cargo_type} onChange={e => setNewCustomRate(p => ({ ...p, cargo_type: e.target.value }))} className={inputClass + ' w-full'}>
                              <option value="LOC">LOC</option>
                              <option value="BOND">BOND</option>
                              <option value="BOTH">AMBOS</option>
                            </select>
                          </div>
                          <div className="col-span-2 sm:col-span-3 lg:col-span-4">
                            <label className="block text-xs text-gray-500 mb-1">Observaciones</label>
                            <input value={newCustomRate.remarks || ''} onChange={e => setNewCustomRate(p => ({ ...p, remarks: e.target.value }))}
                              className={inputClass + ' w-full'} placeholder="Notas opcionales" />
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <button onClick={addCustomRate} disabled={saving || !newCustomRate.rate_name?.trim()}
                            className="bg-mcl-blue text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-900 disabled:opacity-50">
                            {saving ? 'Guardando...' : 'Agregar'}
                          </button>
                          <button onClick={() => setShowAddCustom(false)}
                            className="border border-gray-200 text-gray-500 px-4 py-2 rounded-lg text-sm hover:bg-gray-50">
                            Cancelar
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button onClick={() => setShowAddCustom(true)}
                        className="flex items-center gap-2 border border-dashed border-gray-300 text-gray-400 hover:border-mcl-blue hover:text-mcl-blue px-4 py-2.5 rounded-xl text-sm transition-colors w-full justify-center">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                        Agregar tarifa exclusiva para {selectedClient?.name}
                      </button>
                    )}
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
    </Layout>
  )
}
