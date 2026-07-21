import { Fragment, useEffect, useState } from 'react'
import { useNavigate, Navigate } from 'react-router-dom'
import Layout from '../../components/Layout'
import { useAuth } from '../../contexts/AuthContext'
import { db } from '../../lib/firebase'
import {
  collection, getDocs, addDoc, updateDoc, deleteDoc,
  doc, query, orderBy, where
} from 'firebase/firestore'
import type { AirRateSchedule, AirRateCategory, AirRateUnit, AirfreightClient } from '../../types'
import { fmtUSD } from '../../lib/utils'

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<AirRateCategory, string> = {
  handling:        'Handling',
  screening:       'Screening',
  dangerous_goods: 'Dangerous Goods',
  value_added:     'Value Added',
  transportation:  'Transportation',
  storage:         'Storage',
}

const CATEGORY_ORDER: AirRateCategory[] = ['handling', 'screening', 'dangerous_goods', 'value_added', 'transportation', 'storage']

const UNIT_LABELS: Record<AirRateUnit, string> = {
  per_kg:            '/ KG',
  per_awb:           '/ AWB',
  per_box:           '/ Box',
  per_pallet:        '/ Pallet',
  per_uld:           '/ ULD',
  per_hour:          '/ Hora',
  per_oversize_unit: '/ Unidad',
  flat:              'Fijo',
}

const INITIAL_RATES: Omit<AirRateSchedule, 'id'>[] = [
  { name: 'Break Down Air Pallets', category: 'handling', unit: 'per_kg', price: 0.06, currency: 'USD', minimum_charge: null, free_period_days: null, included_qty: null, overage_price: null, active: true, sort_order: 10 },
  { name: 'DG Physical Acceptance', category: 'dangerous_goods', unit: 'per_awb', price: 50, currency: 'USD', minimum_charge: null, free_period_days: null, included_qty: null, overage_price: null, active: true, sort_order: 200 },
  { name: 'DG Documentary Compliance', category: 'dangerous_goods', unit: 'per_awb', price: 60, currency: 'USD', minimum_charge: null, free_period_days: null, included_qty: null, overage_price: null, active: true, sort_order: 210 },
  { name: 'RePack Temu Boxes', category: 'value_added', unit: 'per_box', price: 12, currency: 'USD', minimum_charge: null, free_period_days: null, included_qty: null, overage_price: null, active: true, sort_order: 300 },
  { name: 'Wrapping', category: 'value_added', unit: 'per_pallet', price: 20, currency: 'USD', minimum_charge: null, free_period_days: null, included_qty: null, overage_price: null, active: true, sort_order: 310 },
  { name: 'Sunday Opening Fee', category: 'value_added', unit: 'flat', price: 400, currency: 'USD', minimum_charge: null, free_period_days: null, included_qty: null, overage_price: null, active: true, sort_order: 320 },
  { name: 'Bonded Fee', category: 'value_added', unit: 'flat', price: 60, currency: 'USD', minimum_charge: null, free_period_days: null, included_qty: null, overage_price: null, active: true, sort_order: 330 },
  { name: 'Wooden Pallets', category: 'handling', unit: 'flat', price: 5, currency: 'USD', minimum_charge: null, free_period_days: null, included_qty: null, overage_price: null, active: true, sort_order: 20 },
]

// ── Component ─────────────────────────────────────────────────────────────────

export default function AirfreightRates() {
  const { isAdmin, isGerente, isAccounting, userRole } = useAuth()
  const canEditRates = (userRole === 'admin') || isAccounting
  const navigate = useNavigate()

  const [rates, setRates] = useState<AirRateSchedule[]>([])
  const [clients, setClients] = useState<AirfreightClient[]>([])
  const [loading, setLoading] = useState(true)
  const [seeding, setSeeding] = useState(false)
  const [saving, setSaving] = useState(false)

  // Overrides
  const [expandedRateId, setExpandedRateId] = useState<string | null>(null)
  const [overrideClientId, setOverrideClientId] = useState('')
  const [overridePrice, setOverridePrice] = useState('')

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editCategory, setEditCategory] = useState<AirRateCategory>('handling')
  const [editUnit, setEditUnit] = useState<AirRateUnit>('per_kg')
  const [editPrice, setEditPrice] = useState('')
  const [editActive, setEditActive] = useState(true)

  // Add new
  const [showAddForm, setShowAddForm] = useState(false)
  const [newRate, setNewRate] = useState<Partial<AirRateSchedule>>({
    category: 'handling', unit: 'per_kg', currency: 'USD', active: true, price: 0,
    minimum_charge: null, free_period_days: null, included_qty: null, overage_price: null,
  })

  useEffect(() => { loadRates(); loadClients() }, [])

  if (!isAdmin && !isAccounting) {
    return <Navigate to="/airfreight" replace />
  }

  async function loadRates() {
    setLoading(true)
    try {
      const snap = await getDocs(query(collection(db, 'air_rate_schedule'), orderBy('sort_order')))
      setRates(snap.docs.map(d => ({ id: d.id, ...d.data() })) as AirRateSchedule[])
    } catch (e) { console.error(e) }
    setLoading(false)
  }

  async function loadClients() {
    try {
      const snap = await getDocs(query(collection(db, 'airfreight_clients'), where('active', '==', true), orderBy('name')))
      setClients(snap.docs.map(d => ({ id: d.id, ...d.data() })) as AirfreightClient[])
    } catch (e) { console.error(e) }
  }

  async function seedRates() {
    setSeeding(true)
    try {
      await Promise.all(INITIAL_RATES.map(r => addDoc(collection(db, 'air_rate_schedule'), r)))
      await loadRates()
    } catch (e) { console.error(e) }
    setSeeding(false)
  }

  async function saveEdit(rate: AirRateSchedule) {
    setSaving(true)
    try {
      const updates: Partial<AirRateSchedule> = {
        name: editName,
        category: editCategory,
        unit: editUnit,
        price: parseFloat(editPrice) || 0,
        active: editActive,
      }
      await updateDoc(doc(db, 'air_rate_schedule', rate.id!), updates)
      setRates(prev => prev.map(r => r.id === rate.id ? { ...r, ...updates } : r))
      setEditingId(null)
    } catch (e) { console.error(e) }
    setSaving(false)
  }

  async function deleteRate(rateId: string) {
    if (!confirm('Eliminar esta tarifa?')) return
    setSaving(true)
    try {
      await deleteDoc(doc(db, 'air_rate_schedule', rateId))
      setRates(prev => prev.filter(r => r.id !== rateId))
    } catch (e) { console.error(e) }
    setSaving(false)
  }

  async function addRate() {
    if (!newRate.name?.trim()) return
    setSaving(true)
    try {
      const maxOrder = rates.length > 0 ? Math.max(...rates.map(r => r.sort_order || 0)) + 10 : 10
      const data = { ...newRate, sort_order: maxOrder } as Omit<AirRateSchedule, 'id'>
      const ref = await addDoc(collection(db, 'air_rate_schedule'), data)
      setRates(prev => [...prev, { id: ref.id, ...data } as AirRateSchedule])
      setShowAddForm(false)
      setNewRate({ category: 'handling', unit: 'per_kg', currency: 'USD', active: true, price: 0, minimum_charge: null, free_period_days: null, included_qty: null, overage_price: null })
    } catch (e) { console.error(e) }
    setSaving(false)
  }

  async function addOverride(rateId: string) {
    if (!overrideClientId || !overridePrice) return
    const price = parseFloat(overridePrice)
    if (isNaN(price)) return
    setSaving(true)
    try {
      const rate = rates.find(r => r.id === rateId)!
      const overrides = { ...(rate.client_overrides || {}), [overrideClientId]: price }
      await updateDoc(doc(db, 'air_rate_schedule', rateId), { client_overrides: overrides })
      setRates(prev => prev.map(r => r.id === rateId ? { ...r, client_overrides: overrides } : r))
      setOverrideClientId('')
      setOverridePrice('')
    } catch (e) { console.error(e) }
    setSaving(false)
  }

  async function removeOverride(rateId: string, clientId: string) {
    setSaving(true)
    try {
      const rate = rates.find(r => r.id === rateId)!
      const overrides = { ...(rate.client_overrides || {}) }
      delete overrides[clientId]
      await updateDoc(doc(db, 'air_rate_schedule', rateId), { client_overrides: overrides })
      setRates(prev => prev.map(r => r.id === rateId ? { ...r, client_overrides: overrides } : r))
    } catch (e) { console.error(e) }
    setSaving(false)
  }

  function getClientName(clientId: string): string {
    return clients.find(c => c.id === clientId)?.name || clientId
  }

  function startEdit(rate: AirRateSchedule) {
    setEditingId(rate.id!)
    setEditName(rate.name)
    setEditCategory(rate.category)
    setEditUnit(rate.unit)
    setEditPrice(String(rate.price))
    setEditActive(rate.active)
  }

  function formatPrice(price: number) {
    return price === 0 ? '—' : price < 1 ? fmtUSD(price, 3) : fmtUSD(price)
  }

  const inputClass = 'border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-mcl-blue/30'

  return (
    <Layout title="Tarifario Airfreight" backTo="/airfreight/admin">
      <div className="max-w-3xl mx-auto">
        <p className="text-sm text-gray-500 mb-4">Catalogo de servicios manuales — se aplican por guia o por vuelo desde el booking.</p>

        {loading ? (
          <div className="p-8 text-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue mx-auto" /></div>
        ) : rates.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-12 text-center">
            <p className="text-gray-400 mb-4">No hay tarifas configuradas.</p>
            <button onClick={seedRates} disabled={seeding}
              className="bg-mcl-blue text-white px-6 py-2.5 rounded-lg text-sm font-semibold hover:bg-blue-900 transition-colors disabled:opacity-50">
              {seeding ? 'Inicializando...' : 'Inicializar Tarifario'}
            </button>
          </div>
        ) : (
          <>
            {CATEGORY_ORDER.filter(cat => rates.some(r => r.category === cat)).map(cat => {
              const catRates = rates.filter(r => r.category === cat)
              return (
                <div key={cat} className="mb-6">
                  <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-2 flex items-center gap-2">
                    {CATEGORY_LABELS[cat]}
                    <span className="text-xs font-normal text-gray-400 bg-gray-100 rounded-full px-2 py-0.5">{catRates.length}</span>
                  </h2>
                  <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 border-b border-gray-100">
                        <tr>
                          <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">Concepto</th>
                          <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase hidden sm:table-cell">Unidad</th>
                          <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">General</th>
                          <th className="text-center px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase w-16">Activo</th>
                          <th className="px-4 py-2.5 w-24"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {catRates.map(rate => {
                          const overridesCount = Object.keys(rate.client_overrides || {}).length
                          const isExpanded = expandedRateId === rate.id
                          return (
                          <Fragment key={rate.id}>
                          <tr className={`hover:bg-gray-50 transition-colors ${!rate.active ? 'opacity-40' : ''}`}>
                            {editingId === rate.id ? (
                              <>
                                <td className="px-4 py-2">
                                  <input value={editName} onChange={e => setEditName(e.target.value)}
                                    className={inputClass + ' w-full'} />
                                </td>
                                <td className="px-4 py-2 hidden sm:table-cell">
                                  <select value={editUnit} onChange={e => setEditUnit(e.target.value as AirRateUnit)} className={inputClass + ' w-full'}>
                                    {Object.entries(UNIT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                                  </select>
                                </td>
                                <td className="px-4 py-2 text-right">
                                  <input type="number" step="0.001" value={editPrice} onChange={e => setEditPrice(e.target.value)}
                                    className={inputClass + ' w-24 text-right'} />
                                </td>
                                <td className="px-4 py-2 text-center">
                                  <input type="checkbox" checked={editActive} onChange={e => setEditActive(e.target.checked)} className="w-4 h-4 accent-mcl-blue" />
                                </td>
                                <td className="px-4 py-2 text-right">
                                  <div className="flex gap-1 justify-end">
                                    <button onClick={() => saveEdit(rate)} disabled={saving}
                                      className="w-7 h-7 rounded-full bg-green-500 hover:bg-green-600 text-white flex items-center justify-center">
                                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                                    </button>
                                    <button onClick={() => setEditingId(null)}
                                      className="w-7 h-7 rounded-full bg-gray-200 hover:bg-gray-300 text-gray-600 flex items-center justify-center">
                                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
                                    </button>
                                  </div>
                                </td>
                              </>
                            ) : (
                              <>
                                <td className="px-4 py-3">
                                  <span className="font-medium text-gray-800">{rate.name}</span>
                                </td>
                                <td className="px-4 py-3 text-gray-500 text-xs hidden sm:table-cell">{UNIT_LABELS[rate.unit] || rate.unit}</td>
                                <td className="px-4 py-3 text-right">
                                  <span className="font-mono font-semibold text-gray-700">{formatPrice(rate.price)}</span>
                                </td>
                                <td className="px-4 py-3 text-center">
                                  <span className={`inline-block w-2 h-2 rounded-full ${rate.active ? 'bg-green-400' : 'bg-gray-300'}`} />
                                </td>
                                <td className="px-4 py-3 text-right">
                                  <div className="flex gap-1 justify-end">
                                    <button onClick={() => { setExpandedRateId(isExpanded ? null : rate.id!); setOverrideClientId(''); setOverridePrice('') }}
                                      title="Client overrides"
                                      className={`w-7 h-7 rounded-full flex items-center justify-center transition-colors relative ${
                                        isExpanded ? 'bg-mcl-blue text-white' : 'bg-gray-100 hover:bg-amber-500 hover:text-white text-gray-400'
                                      }`}>
                                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-3-3h-1m-3-2a3 3 0 100-6 3 3 0 000 6zm-8 8v-2a3 3 0 00-3-3H5a3 3 0 00-3 3v2h6zm1-10a3 3 0 100-6 3 3 0 000 6z" /></svg>
                                      {overridesCount > 0 && (
                                        <span className="absolute -top-1 -right-1 bg-amber-500 text-white text-[9px] font-bold w-3.5 h-3.5 rounded-full flex items-center justify-center">{overridesCount}</span>
                                      )}
                                    </button>
                                    {canEditRates && (
                                      <button onClick={() => startEdit(rate)}
                                        className="w-7 h-7 rounded-full bg-gray-100 hover:bg-mcl-blue hover:text-white text-gray-400 flex items-center justify-center transition-colors">
                                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                                      </button>
                                    )}
                                    {userRole === 'admin' && (
                                      <button onClick={() => deleteRate(rate.id!)}
                                        className="w-7 h-7 rounded-full bg-gray-100 hover:bg-red-500 hover:text-white text-gray-400 flex items-center justify-center transition-colors">
                                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                      </button>
                                    )}
                                  </div>
                                </td>
                              </>
                            )}
                          </tr>
                          {/* Client overrides panel */}
                          {isExpanded && (
                            <tr>
                              <td colSpan={5} className="px-4 py-3 bg-amber-50/50 border-t border-amber-100">
                                <div className="text-xs font-semibold text-amber-700 mb-2">Overrides por Cliente</div>
                                {Object.entries(rate.client_overrides || {}).length > 0 ? (
                                  <div className="space-y-1.5 mb-3">
                                    {Object.entries(rate.client_overrides || {}).map(([cid, price]) => (
                                      <div key={cid} className="flex items-center gap-3 bg-white rounded-lg px-3 py-1.5 border border-gray-100">
                                        <span className="text-sm text-gray-700 flex-1 font-medium">{getClientName(cid)}</span>
                                        <span className="font-mono text-sm font-semibold text-amber-700">{formatPrice(price)}</span>
                                        <button onClick={() => removeOverride(rate.id!, cid)} disabled={saving}
                                          className="text-gray-300 hover:text-red-500 transition-colors">
                                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                        </button>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <p className="text-xs text-gray-400 mb-3">Sin overrides — todos los clientes usan la tarifa general.</p>
                                )}
                                <div className="flex items-center gap-2">
                                  <select value={overrideClientId} onChange={e => setOverrideClientId(e.target.value)}
                                    className={inputClass + ' flex-1 min-w-0'}>
                                    <option value="">Seleccionar cliente...</option>
                                    {clients.filter(c => !(rate.client_overrides || {})[c.id!]).map(c => (
                                      <option key={c.id} value={c.id!}>{c.name}</option>
                                    ))}
                                  </select>
                                  <input type="number" step="0.001" placeholder="Precio" value={overridePrice}
                                    onChange={e => setOverridePrice(e.target.value)}
                                    className={inputClass + ' w-24 text-right'} />
                                  <button onClick={() => addOverride(rate.id!)} disabled={saving || !overrideClientId || !overridePrice}
                                    className="bg-amber-500 text-white px-3 py-1 rounded-lg text-xs font-semibold hover:bg-amber-600 disabled:opacity-40 whitespace-nowrap">
                                    Agregar
                                  </button>
                                </div>
                              </td>
                            </tr>
                          )}
                          </Fragment>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            })}

            {/* Add new rate */}
            {canEditRates && showAddForm ? (
              <div className="bg-white rounded-xl border border-mcl-blue/30 shadow-sm p-4">
                <h3 className="text-sm font-semibold text-gray-700 mb-3">Nuevo Concepto</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                  <div className="col-span-2">
                    <label className="block text-xs text-gray-500 mb-1">Nombre *</label>
                    <input value={newRate.name || ''} onChange={e => setNewRate(p => ({ ...p, name: e.target.value }))}
                      className={inputClass + ' w-full'} placeholder="Nombre del concepto" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Categoria</label>
                    <select value={newRate.category} onChange={e => setNewRate(p => ({ ...p, category: e.target.value as AirRateCategory }))} className={inputClass + ' w-full'}>
                      {CATEGORY_ORDER.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Unidad</label>
                    <select value={newRate.unit} onChange={e => setNewRate(p => ({ ...p, unit: e.target.value as AirRateUnit }))} className={inputClass + ' w-full'}>
                      {Object.entries(UNIT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Tarifa (USD)</label>
                    <input type="number" step="0.001" value={newRate.price || 0}
                      onChange={e => setNewRate(p => ({ ...p, price: parseFloat(e.target.value) || 0 }))} className={inputClass + ' w-full'} />
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={addRate} disabled={saving || !newRate.name?.trim()}
                    className="bg-mcl-blue text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-900 disabled:opacity-50">
                    {saving ? 'Guardando...' : 'Agregar'}
                  </button>
                  <button onClick={() => setShowAddForm(false)}
                    className="border border-gray-200 text-gray-500 px-4 py-2 rounded-lg text-sm hover:bg-gray-50">Cancelar</button>
                </div>
              </div>
            ) : canEditRates ? (
              <button onClick={() => setShowAddForm(true)}
                className="flex items-center gap-2 border border-dashed border-gray-300 text-gray-400 hover:border-mcl-blue hover:text-mcl-blue px-4 py-2.5 rounded-xl text-sm transition-colors w-full justify-center">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                Agregar Nuevo Concepto
              </button>
            ) : null}
          </>
        )}
      </div>
    </Layout>
  )
}
