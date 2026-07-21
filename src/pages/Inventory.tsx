import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import Layout from '../components/Layout'
import { db } from '../lib/firebase'
import { collection, getDocs, query, where, doc, getDoc, updateDoc, addDoc, deleteDoc, limit } from 'firebase/firestore'
import { WarehouseReceipt, WRLine, SkuLine, Consignee, RateSchedule, InventoryDocument, getDocSemaphore } from '../types'
import { formatWRDate, toTitleCase, fmtNum, fmtUSD } from '../lib/utils'
import { exportInventory } from '../lib/exportInventory'
import { useAuth } from '../contexts/AuthContext'

function PhotoModal({ urls, onClose }: { urls: string[]; onClose: () => void }) {
  const [idx, setIdx] = useState(0)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl max-w-lg w-full max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <p className="text-sm font-semibold text-gray-700">Fotos ({idx + 1}/{urls.length})</p>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-hidden flex items-center justify-center p-4 min-h-[300px]">
          <img src={urls[idx]} alt={`Foto ${idx + 1}`} className="max-w-full max-h-[60vh] object-contain rounded-lg" />
        </div>
        {urls.length > 1 && (
          <div className="flex items-center justify-center gap-4 px-4 py-3 border-t border-gray-100">
            <button onClick={() => setIdx(i => Math.max(0, i - 1))} disabled={idx === 0}
              className="px-3 py-1 rounded-lg bg-gray-100 text-gray-600 text-sm font-medium disabled:opacity-30 hover:bg-gray-200">
              Anterior
            </button>
            <button onClick={() => setIdx(i => Math.min(urls.length - 1, i + 1))} disabled={idx === urls.length - 1}
              className="px-3 py-1 rounded-lg bg-gray-100 text-gray-600 text-sm font-medium disabled:opacity-30 hover:bg-gray-200">
              Siguiente
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

const UNIT_LABELS: Record<string, string> = {
  per_pallet:  '/ Pallet',
  per_cbm:     '/ CBM',
  per_kg:      '/ KG',
  flat:        'Fijo',
  per_report:  '/ Reporte',
  per_label:   '/ Label',
  per_wr:      '/ WR',
}

interface OptionalCharge {
  id: string
  charge_name: string
  unit: string
  qty: number
  unit_price: number
  total: number
  currency: string
}

function getStorageTag(createdAt: string, freeDaysTotal: number) {
  const created = new Date(createdAt)
  const createdDay = new Date(created.getFullYear(), created.getMonth(), created.getDate())
  const today = new Date()
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const daysIn = Math.round((todayDay.getTime() - createdDay.getTime()) / (1000 * 60 * 60 * 24))
  const free = freeDaysTotal - daysIn
  const yellowThreshold = Math.ceil(freeDaysTotal * 0.7)
  if (free > yellowThreshold) return { text: `${free}d libres`, cls: 'bg-green-100 text-green-700' }
  if (free > 0)  return { text: `${free}d libres`, cls: 'bg-yellow-100 text-yellow-700' }
  return { text: `+${Math.abs(free)}d storage`, cls: 'bg-red-100 text-red-700' }
}

interface InventoryWR extends WarehouseReceipt {
  lines: WRLine[]
  skuLines?: SkuLine[]
}

export default function Inventory() {
  const navigate = useNavigate()
  const { isClient, isAdmin, isAccounting, clientId: authClientId, canViewCharges } = useAuth()
  const [items, setItems]       = useState<InventoryWR[]>([])
  const [loading, setLoading]   = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [docMap, setDocMap]     = useState<Map<string, InventoryDocument>>(new Map())
  const [clientFreeDays, setClientFreeDays] = useState<Map<string, { loc: number; bond: number }>>(new Map())

  const [filterCountry,  setFilterCountry]  = useState('')
  const [filterVendor,   setFilterVendor]   = useState('')
  const [filterConsignee, setFilterConsignee] = useState('')
  const [filterClient,   setFilterClient]   = useState('')
  const [filterStatus,   setFilterStatus]   = useState('')
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  useEffect(() => { loadInventory() }, [])

  async function loadInventory() {
    setLoading(true)
    try {
      const constraints: any[] = [where('physical_status', '==', 'complete')]
      if (isClient && authClientId) {
        constraints.push(where('client_id', '==', authClientId))
      }
      const q    = query(collection(db, 'warehouse_receipts'), ...constraints, limit(1000))
      const snap = await getDocs(q)

      const wrs = (snap.docs.map(d => ({ id: d.id, ...d.data() })) as WarehouseReceipt[])
        .filter(wr => wr.source !== 'warehouse_services')

      // Load lines + consignees in parallel
      const full = await Promise.all(wrs.map(async wr => {
        const [linesSnap, skuSnap] = await Promise.all([
          getDocs(collection(db, 'warehouse_receipts', wr.id!, 'lines')),
          wr.has_sku_lines ? getDocs(collection(db, 'warehouse_receipts', wr.id!, 'sku_lines')) : Promise.resolve(null),
        ])
        const lines = linesSnap.docs
          .map(d => ({ id: d.id, ...d.data() }) as WRLine)
          .sort((a, b) => (a.line_order ?? 0) - (b.line_order ?? 0))
        const skuLines = skuSnap ? skuSnap.docs.map(d => ({ id: d.id, ...d.data() }) as SkuLine) : []

        if (wr.consignee_id && !wr.consignee) {
          try {
            const cs = await getDoc(doc(db, 'consignees', wr.consignee_id))
            if (cs.exists()) wr.consignee = { id: cs.id, ...cs.data() } as Consignee
          } catch { /* ignore */ }
        } else if (!wr.consignee_id && wr.consignee_name) {
          wr.consignee = { id: '', name: wr.consignee_name, full_address: '', notify_to: wr.notify_to || '' }
        }

        return { ...wr, lines, skuLines } as InventoryWR
      }))

      // Sort newest first
      full.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
      setItems(full)

      // Load client free storage days
      try {
        const clientIds = [...new Set(full.map(w => w.client_id).filter(Boolean))] as string[]
        const fdMap = new Map<string, { loc: number; bond: number }>()
        await Promise.all(clientIds.map(async cid => {
          const cfgSnap = await getDoc(doc(db, 'client_billing_config', cid))
          if (cfgSnap.exists()) {
            const cfg = cfgSnap.data()
            fdMap.set(cid, { loc: cfg.free_days_loc ?? 21, bond: cfg.free_days_bond ?? 5 })
          }
        }))
        setClientFreeDays(fdMap)
      } catch { /* ignore */ }

      // Load inventory_documents for semaphore
      try {
        const idConstraints: any[] = []
        if (isClient && authClientId) idConstraints.push(where('client_id', '==', authClientId))
        const idSnap = await getDocs(query(collection(db, 'inventory_documents'), ...idConstraints))
        const dm = new Map<string, InventoryDocument>()
        for (const d of idSnap.docs) {
          const data = { id: d.id, ...d.data() } as InventoryDocument
          dm.set(data.wr_id, data)
        }
        setDocMap(dm)
      } catch { /* ignore */ }
    } catch (e) { console.error(e) }
    setLoading(false)
  }

  // Derive filter options from data
  const countries  = [...new Set(items.map(i => i.to_port).filter(Boolean))].sort()
  const vendors    = [...new Set(items.map(i => i.company_name).filter(Boolean))].sort()
  const consignees = [...new Set(items.map(i => i.consignee?.name).filter(Boolean))].sort() as string[]
  const clientNames = [...new Set(items.map(i => i.client_name).filter(Boolean))].sort() as string[]

  const filtered = items.filter(i => {
    if (i.dispatch_status === 'dispatched') return false
    if (filterStatus === 'warehouse' && i.dispatch_status === 'reserved') return false
    if (filterStatus === 'reserved' && i.dispatch_status !== 'reserved') return false
    if (filterCountry  && i.to_port !== filterCountry) return false
    if (filterVendor   && i.company_name !== filterVendor) return false
    if (filterConsignee && i.consignee?.name !== filterConsignee) return false
    if (filterClient   && i.client_name !== filterClient) return false
    if (dateFrom || dateTo) {
      const d = i.created_at?.slice(0, 10) ?? ''
      if (dateFrom && d < dateFrom) return false
      if (dateTo && d > dateTo) return false
    }
    if (search) {
      const s = search.toLowerCase()
      if (!i.wr_number?.toLowerCase().includes(s) &&
          !i.po_number?.toLowerCase().includes(s) &&
          !i.company_name?.toLowerCase().includes(s)) return false
    }
    return true
  })

  const totalPieces = filtered.reduce((s, i) => s + i.lines.reduce((ls, l) => ls + (l.qty || 0), 0), 0)
  const totalCBM    = filtered.reduce((s, i) => s + i.lines.reduce((ls, l) => ls + (l.cbm || 0), 0), 0)
  const totalKG     = filtered.reduce((s, i) => s + i.lines.reduce((ls, l) => ls + (l.weight_kg || 0), 0), 0)

  // Per-country breakdown
  const countryStats = new Map<string, { cbm: number; kg: number; wrs: number }>()
  for (const i of filtered) {
    const country = i.to_port || 'Sin destino'
    const prev = countryStats.get(country) || { cbm: 0, kg: 0, wrs: 0 }
    prev.wrs += 1
    for (const l of i.lines) {
      prev.cbm += l.cbm || 0
      prev.kg += l.weight_kg || 0
    }
    countryStats.set(country, prev)
  }
  const countrySorted = [...countryStats.entries()].sort((a, b) => b[1].cbm - a[1].cbm)

  function toggleExpand(id: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const [exporting, setExporting] = useState(false)
  const [photoUrls, setPhotoUrls] = useState<string[] | null>(null)

  const [editingDateId, setEditingDateId]       = useState<string | null>(null)
  const [editingDateValue, setEditingDateValue] = useState('')

  // ── Optional services modal ───────────────────────────────────────────
  const [optionalModal,    setOptionalModal]    = useState<InventoryWR | null>(null)
  const [optionalRates,    setOptionalRates]    = useState<RateSchedule[]>([])
  const [existingOptionals,setExistingOptionals]= useState<OptionalCharge[]>([])
  const [selectedRateId,   setSelectedRateId]   = useState('')
  const [optionalQty,      setOptionalQty]      = useState(1)
  const [loadingOptional,  setLoadingOptional]  = useState(false)
  const [savingOptional,   setSavingOptional]   = useState(false)

  async function openOptionalModal(wr: InventoryWR) {
    setOptionalModal(wr)
    setSelectedRateId('')
    setOptionalQty(1)
    setLoadingOptional(true)
    try {
      const [ratesSnap, chargesSnap] = await Promise.all([
        getDocs(query(collection(db, 'rate_schedule'), where('billing_event', '==', 'optional'))),
        getDocs(query(collection(db, 'billing_charges'), where('wr_id', '==', wr.id))),
      ])
      const rates = ratesSnap.docs
        .map(d => ({ id: d.id, ...d.data() }) as RateSchedule)
        .filter(r => r.active)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      const optionals = chargesSnap.docs
        .map(d => ({ id: d.id, ...d.data() }) as any)
        .filter(c => c.billing_event === 'optional') as OptionalCharge[]
      setOptionalRates(rates)
      setExistingOptionals(optionals)
    } catch (e) { console.error(e) }
    setLoadingOptional(false)
  }

  async function saveOptionalCharge() {
    if (!optionalModal || !selectedRateId) return
    const rate = optionalRates.find(r => r.id === selectedRateId)
    if (!rate) return
    setSavingOptional(true)
    try {
      const wr = optionalModal
      // Apply client override if exists
      let price = rate.price
      if (wr.client_id) {
        const ovSnap = await getDocs(
          query(collection(db, 'client_billing_rates'), where('client_id', '==', wr.client_id))
        )
        const override = ovSnap.docs.map(d => d.data()).find(o => o.rate_id === rate.id)
        if (override) {
          if (!override.active) { setSavingOptional(false); return }
          price = override.price
        }
      }
      const total = optionalQty * price
      const ref = await addDoc(collection(db, 'billing_charges'), {
        billing_event: 'optional',
        wr_id:        wr.id,
        wr_number:    wr.wr_number || '',
        po_number:    wr.po_number || '',
        client_id:    wr.client_id || null,
        client_name:  wr.client_name || '',
        cargo_type:   wr.cargo_type || 'LOC',
        charge_name:  rate.name,
        unit:         rate.unit,
        qty:          optionalQty,
        unit_price:   price,
        total,
        currency:     rate.currency,
        status:       'pending',
        created_at:   new Date().toISOString(),
      })
      setExistingOptionals(prev => [...prev, {
        id: ref.id, charge_name: rate.name, unit: rate.unit,
        qty: optionalQty, unit_price: price, total, currency: rate.currency,
      }])
      setSelectedRateId('')
      setOptionalQty(1)
    } catch (e) { console.error(e) }
    setSavingOptional(false)
  }

  async function deleteOptionalCharge(chargeId: string) {
    try {
      await deleteDoc(doc(db, 'billing_charges', chargeId))
      setExistingOptionals(prev => prev.filter(c => c.id !== chargeId))
    } catch (e) { console.error(e) }
  }

  async function saveDateEdit(itemId: string) {
    if (!editingDateValue) { setEditingDateId(null); return }
    try {
      const original = items.find(i => i.id === itemId)?.created_at
      const originalTime = original ? original.slice(10) : 'T00:00:00.000Z'
      const iso = editingDateValue + originalTime
      await updateDoc(doc(db, 'warehouse_receipts', itemId), { created_at: iso })
      setItems(prev => prev.map(i => i.id === itemId ? { ...i, created_at: iso } : i))
    } catch (e) { console.error(e) }
    setEditingDateId(null)
  }

  async function handleExport() {
    setExporting(true)
    const dateLabel = new Date().toISOString().slice(0, 10)
    await exportInventory(filtered, dateLabel)
    setExporting(false)
  }

  const selectClass = 'border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-mcl-blue/30 bg-white'

  return (
    <Layout title="Inventario en Bodega" backTo={isClient ? undefined : "/sea"}
      headerRight={isClient ? (
        <div className="flex items-center gap-2">
          <Link to="/dispatches" className="text-xs bg-[#1E3A5F] text-white px-3 py-1.5 rounded-lg hover:bg-blue-900 transition-colors font-medium">
            Consolidados
          </Link>
          {canViewCharges && (
            <Link to="/billing/charges" className="text-xs bg-emerald-600 text-white px-3 py-1.5 rounded-lg hover:bg-emerald-700 transition-colors font-medium">
              Cargos WR
            </Link>
          )}
        </div>
      ) : undefined}
    >
      <div className="flex justify-end gap-2 mb-3">
        <button
          onClick={() => navigate('/inventory-documents')}
          className="flex items-center gap-2 bg-amber-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-amber-700 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          Documentos
        </button>
        <button
          onClick={() => navigate('/gate-out-history')}
          className="flex items-center gap-2 bg-gray-500 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-gray-600 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          Historial Gate Out
        </button>
        {!isClient && (
          <button
            onClick={() => navigate('/dispatches/new')}
            className="flex items-center gap-2 bg-[#1E3A5F] text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-900 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10" />
            </svg>
            Nuevo Consolidado
          </button>
        )}
        <button
          onClick={handleExport}
          disabled={filtered.length === 0 || exporting}
          className="flex items-center gap-2 bg-[#1A4D2E] text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-green-900 transition-colors disabled:opacity-40"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          {exporting ? 'Generando...' : 'Descargar Excel'}
        </button>
      </div>
      {/* Filters */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
          <input
            type="text"
            placeholder="Buscar WR, PO, Vendor..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className={selectClass + ' w-full'}
          />
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className={selectClass}>
            <option value="">Todos los estados</option>
            <option value="warehouse">En bodega</option>
            <option value="reserved">Reservados</option>
          </select>
          <select value={filterClient} onChange={e => setFilterClient(e.target.value)} className={selectClass}>
            <option value="">Todos los clientes</option>
            {clientNames.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={filterCountry} onChange={e => setFilterCountry(e.target.value)} className={selectClass}>
            <option value="">Todos los países</option>
            {countries.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={filterVendor} onChange={e => setFilterVendor(e.target.value)} className={selectClass}>
            <option value="">Todos los vendors</option>
            {vendors.map(v => <option key={v} value={v}>{toTitleCase(v)}</option>)}
          </select>
          <select value={filterConsignee} onChange={e => setFilterConsignee(e.target.value)} className={selectClass}>
            <option value="">Todos los consignees</option>
            {consignees.map(c => <option key={c} value={c}>{toTitleCase(c)}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <label className="text-xs text-gray-500">Desde</label>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className={selectClass} />
          <label className="text-xs text-gray-500">Hasta</label>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className={selectClass} />
          {(dateFrom || dateTo) && (
            <button onClick={() => { setDateFrom(''); setDateTo('') }}
              className="text-xs text-gray-400 hover:text-gray-600 underline">Limpiar</button>
          )}
        </div>
        {(filterCountry || filterVendor || filterConsignee || filterClient || filterStatus || search) && (
          <button
            onClick={() => { setFilterCountry(''); setFilterVendor(''); setFilterConsignee(''); setFilterClient(''); setFilterStatus(''); setSearch(''); setDateFrom(''); setDateTo('') }}
            className="mt-2 text-xs text-gray-400 hover:text-gray-600 underline"
          >
            Limpiar filtros
          </button>
        )}
      </div>

      {/* Totals */}
      <div className="flex gap-3 mb-4">
        {/* Grand totals */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 flex-1">
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-3 text-center">
            <p className="text-xs text-gray-400 uppercase tracking-wide">WRs</p>
            <p className="text-2xl font-bold text-mcl-blue">{filtered.length}</p>
          </div>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-3 text-center">
            <p className="text-xs text-gray-400 uppercase tracking-wide">Piezas</p>
            <p className="text-2xl font-bold text-mcl-blue">{fmtNum(totalPieces)}</p>
          </div>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-3 text-center">
            <p className="text-xs text-gray-400 uppercase tracking-wide">CBM</p>
            <p className="text-2xl font-bold text-mcl-blue">{fmtNum(totalCBM, 4)}</p>
          </div>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-3 text-center hidden sm:block">
            <p className="text-xs text-gray-400 uppercase tracking-wide">Peso KG</p>
            <p className="text-2xl font-bold text-mcl-blue">{fmtNum(totalKG)}</p>
          </div>
        </div>
        {/* Per-country breakdown */}
        {countrySorted.length > 1 && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-3 hidden sm:block shrink-0" style={{ minWidth: '220px' }}>
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-1.5">Por destino</p>
            <div className="space-y-1 max-h-28 overflow-y-auto">
              {countrySorted.map(([country, stats]) => (
                <div key={country} className="flex items-center justify-between text-xs gap-3">
                  <span className="font-semibold text-gray-600 truncate">{country}</span>
                  <div className="flex gap-3 shrink-0">
                    <span className="text-mcl-blue font-mono">{fmtNum(stats.cbm, 4)} <span className="text-gray-400">cbm</span></span>
                    <span className="text-gray-500 font-mono">{fmtNum(stats.kg)} <span className="text-gray-400">kg</span></span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue mx-auto" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-gray-400">No hay carga en inventario con los filtros seleccionados.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="px-2 py-2 w-5"></th>
                  <th className="text-left px-2 py-2 font-semibold text-gray-600 text-xs uppercase">WR #</th>
                  <th className="text-left px-2 py-2 font-semibold text-gray-600 text-xs uppercase">PO #</th>
                  <th className="text-left px-2 py-2 font-semibold text-gray-600 text-xs uppercase hidden sm:table-cell">Cliente</th>
                  <th className="text-left px-2 py-2 font-semibold text-gray-600 text-xs uppercase hidden sm:table-cell">Consignee</th>
                  <th className="text-left px-2 py-2 font-semibold text-gray-600 text-xs uppercase hidden md:table-cell">Vendor</th>
                  <th className="text-center px-2 py-2 font-semibold text-gray-600 text-xs uppercase">País</th>
                  <th className="text-center px-1 py-2 font-semibold text-gray-600 text-xs uppercase hidden sm:table-cell">Tipo</th>
                  <th className="text-right px-2 py-2 font-semibold text-gray-600 text-xs uppercase">Pzas</th>
                  <th className="text-right px-2 py-2 font-semibold text-gray-600 text-xs uppercase hidden sm:table-cell">CBM</th>
                  <th className="text-right px-2 py-2 font-semibold text-gray-600 text-xs uppercase hidden sm:table-cell">KG</th>
                  <th className="text-left px-2 py-2 font-semibold text-gray-600 text-xs uppercase hidden lg:table-cell">F. Entrada</th>
                  <th className="text-center px-1 py-2 font-semibold text-gray-600 text-xs uppercase hidden md:table-cell">Storage</th>
                  <th className="text-center px-1 py-2 font-semibold text-gray-600 text-xs uppercase hidden sm:table-cell">Docs</th>
                  <th className="px-1 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(item => {
                  const isOpen   = expanded.has(item.id!)
                  const wrPieces = item.lines.reduce((s, l) => s + (l.qty || 0), 0)
                  const wrCBM    = item.lines.reduce((s, l) => s + (l.cbm || 0), 0)
                  const wrKG     = item.lines.reduce((s, l) => s + (l.weight_kg || 0), 0)

                  return (
                    <>
                      <tr
                        key={item.id}
                        className="border-t border-gray-50 hover:bg-gray-50 cursor-pointer transition-colors"
                        onClick={() => toggleExpand(item.id!)}
                      >
                        <td className="px-2 py-2 text-gray-400">
                          <svg className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        </td>
                        <td className="px-2 py-2 font-mono font-semibold text-mcl-blue text-xs">{item.wr_number}</td>
                        <td className="px-2 py-2 text-gray-700 text-xs whitespace-nowrap">
                          {(isAdmin || isAccounting) ? (
                            <button
                              type="button"
                              onClick={async (e) => {
                                e.stopPropagation()
                                const newVal = !item.uploaded_to_client
                                await updateDoc(doc(db, 'warehouse_receipts', item.id!), { uploaded_to_client: newVal })
                                setItems(prev => prev.map(w => w.id === item.id ? { ...w, uploaded_to_client: newVal } : w))
                              }}
                              className="inline-flex items-center gap-1.5"
                              title={item.uploaded_to_client ? 'Subido al cliente' : 'Pendiente de subir'}
                            >
                              <span className={`inline-block w-2.5 h-2.5 rounded-full ${item.uploaded_to_client ? 'bg-green-500' : 'bg-gray-300'}`} />
                              {item.po_number}
                            </button>
                          ) : (
                            <span className="inline-flex items-center gap-1.5">
                              <span className={`inline-block w-2.5 h-2.5 rounded-full ${item.uploaded_to_client ? 'bg-green-500' : 'bg-gray-300'}`} />
                              {item.po_number}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-gray-600 text-xs hidden sm:table-cell max-w-[120px] truncate">{item.client_name || '—'}</td>
                        <td className="px-2 py-2 text-gray-600 text-xs hidden sm:table-cell max-w-[120px] truncate">{toTitleCase(item.consignee?.name) || '—'}</td>
                        <td className="px-2 py-2 text-gray-600 text-xs hidden md:table-cell max-w-[120px] truncate">{toTitleCase(item.company_name)}</td>
                        <td className="px-2 py-2 text-center">
                          <span className="inline-block bg-mcl-blue/10 text-mcl-blue text-xs font-bold px-1.5 py-0.5 rounded">{item.to_port}</span>
                        </td>
                        <td className="px-1 py-2 text-center hidden sm:table-cell">
                          {item.cargo_type && (
                            <span className={`text-xs font-bold px-1 py-0.5 rounded ${item.cargo_type === 'BOND' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>
                              {item.cargo_type}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right font-semibold text-gray-700 text-xs">{fmtNum(wrPieces)}</td>
                        <td className="px-2 py-2 text-right text-gray-500 font-mono text-xs hidden sm:table-cell">{fmtNum(wrCBM, 4)}</td>
                        <td className="px-2 py-2 text-right text-gray-500 text-xs hidden sm:table-cell">{fmtNum(wrKG, 1)}</td>
                        <td
                          className="px-2 py-2 text-gray-400 text-xs hidden lg:table-cell"
                          onClick={e => e.stopPropagation()}
                        >
                          {editingDateId === item.id ? (
                            <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                              <input
                                type="date"
                                value={editingDateValue}
                                onChange={e => setEditingDateValue(e.target.value)}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') saveDateEdit(item.id!)
                                  if (e.key === 'Escape') setEditingDateId(null)
                                }}
                                autoFocus
                                className="border border-mcl-blue rounded px-1 py-0.5 text-xs text-gray-700 focus:outline-none focus:ring-1 focus:ring-mcl-blue/50"
                              />
                              <button
                                onClick={() => saveDateEdit(item.id!)}
                                className="w-5 h-5 rounded-full bg-green-500 hover:bg-green-600 text-white flex items-center justify-center flex-shrink-0"
                                title="Guardar"
                              >
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                                </svg>
                              </button>
                              <button
                                onClick={() => setEditingDateId(null)}
                                className="w-5 h-5 rounded-full bg-gray-300 hover:bg-gray-400 text-white flex items-center justify-center flex-shrink-0"
                                title="Cancelar"
                              >
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1 group/date">
                              <span>{item.created_at ? formatWRDate(item.created_at) : '—'}</span>
                              {!isClient && (
                                <button
                                  onClick={e => {
                                    e.stopPropagation()
                                    if (!item.created_at) return
                                    const d = new Date(item.created_at)
                                    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
                                    setEditingDateValue(local)
                                    setEditingDateId(item.id!)
                                  }}
                                  className="w-5 h-5 rounded-full bg-mcl-blue/10 hover:bg-mcl-blue text-mcl-blue hover:text-white flex items-center justify-center flex-shrink-0 opacity-0 group-hover/date:opacity-100 transition-opacity"
                                  title="Editar fecha"
                                >
                                  <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                                  </svg>
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="px-1 py-2 text-center hidden md:table-cell">
                          {item.created_at && (() => {
                            const isBond = item.cargo_type === 'BOND'
                            const clientCfg = item.client_id ? clientFreeDays.get(item.client_id) : undefined
                            const freeDays = clientCfg ? (isBond ? clientCfg.bond : clientCfg.loc) : (isBond ? 5 : 21)
                            const tag = getStorageTag(item.created_at, freeDays)
                            return <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap ${tag.cls}`}>{tag.text}</span>
                          })()}
                        </td>
                        <td className="px-1 py-2 text-center hidden sm:table-cell">
                          {(() => {
                            const invDoc = docMap.get(item.id!)
                            const sem = getDocSemaphore(invDoc)
                            const cls = sem === 'blue' ? 'bg-blue-500' : sem === 'yellow' ? 'bg-yellow-400' : 'bg-gray-300'
                            return <div className={`w-3 h-3 rounded-full mx-auto ${cls}`}
                              title={sem === 'blue' ? 'Docs completos' : sem === 'yellow' ? 'Docs parciales' : 'Sin docs'} />
                          })()}
                        </td>
                        <td className="px-1 py-2" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center gap-1">
                            {(() => {
                              const photos: string[] = []
                              for (const line of item.lines) {
                                if (line.photo_urls?.length) photos.push(...line.photo_urls)
                                else if (line.photo_url) photos.push(line.photo_url)
                              }
                              return photos.length > 0 ? (
                                <button
                                  onClick={() => setPhotoUrls(photos)}
                                  className="text-gray-400 hover:text-amber-600 transition-colors relative"
                                  title={`${photos.length} foto(s)`}
                                >
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                  </svg>
                                  {photos.length > 1 && (
                                    <span className="absolute -top-1 -right-1 bg-amber-500 text-white text-[8px] font-bold rounded-full w-3 h-3 flex items-center justify-center">{photos.length}</span>
                                  )}
                                </button>
                              ) : null
                            })()}
                            <Link
                              to={`/wr/${item.id}/print`}
                              className="text-gray-400 hover:text-mcl-blue transition-colors"
                              title="Ver WR"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                              </svg>
                            </Link>
                            {!isClient && (
                              <button
                                onClick={() => openOptionalModal(item)}
                                className="text-gray-400 hover:text-purple-600 transition-colors"
                                title="Servicios opcionales"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                                </svg>
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>

                      {/* Expanded lines */}
                      {isOpen && (
                        <tr key={`${item.id}-lines`} className="border-t border-gray-100">
                          <td colSpan={15} className="px-0 py-0">
                            <div className="bg-blue-50/40 px-6 py-3">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-gray-400 uppercase">
                                    <th className="text-left py-1 pr-4 font-semibold">Línea</th>
                                    <th className="text-left py-1 pr-4 font-semibold">Tipo</th>
                                    <th className="text-right py-1 pr-4 font-semibold">QTY</th>
                                    <th className="text-right py-1 pr-4 font-semibold">CBM</th>
                                    <th className="text-right py-1 pr-4 font-semibold">KG</th>
                                    <th className="text-left py-1 pr-4 font-semibold">Ubicación</th>
                                    <th className="text-left py-1 font-semibold">Notas</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-blue-100">
                                  {item.lines.map((line, li) => (
                                    <tr key={li} className="text-gray-600">
                                      <td className="py-1.5 pr-4 text-gray-400">{line.line_order}</td>
                                      <td className="py-1.5 pr-4">
                                        {line.packing_type}
                                        {line.has_lb && <span className="ml-1 text-blue-600 font-semibold">LB</span>}
                                        {line.is_dg && <span className="ml-1 text-red-600 font-semibold">DG</span>}
                                      </td>
                                      <td className="py-1.5 pr-4 text-right font-semibold text-mcl-blue">{line.qty}</td>
                                      <td className="py-1.5 pr-4 text-right font-mono">{fmtNum(line.cbm, 4)}</td>
                                      <td className="py-1.5 pr-4 text-right">{line.weight_kg ? `${fmtNum(line.weight_kg)} KG` : '—'}</td>
                                      <td className="py-1.5 pr-4 font-semibold text-gray-700">{line.location || '—'}</td>
                                      <td className="py-1.5 text-gray-400">{line.remarks || ''}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {/* ── Photo viewer modal ─────────────────────────────────────── */}
      {photoUrls && <PhotoModal urls={photoUrls} onClose={() => setPhotoUrls(null)} />}

      {/* ── Optional services modal ─────────────────────────────────── */}
      {optionalModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOptionalModal(null)} />
          <div className="relative bg-white rounded-t-2xl sm:rounded-2xl shadow-xl w-full sm:max-w-md max-h-[90vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div>
                <p className="font-bold text-gray-800">Servicios Opcionales</p>
                <p className="text-xs text-gray-400 font-mono">{optionalModal.wr_number} · {optionalModal.po_number}</p>
              </div>
              <button onClick={() => setOptionalModal(null)} className="text-gray-400 hover:text-gray-600">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
              {loadingOptional ? (
                <div className="flex justify-center py-6">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-mcl-blue" />
                </div>
              ) : (
                <>
                  {/* Existing charges */}
                  {existingOptionals.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Cargos agregados</p>
                      <div className="space-y-1">
                        {existingOptionals.map(c => (
                          <div key={c.id} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 text-sm">
                            <div>
                              <span className="font-medium text-gray-700">{c.charge_name}</span>
                              <span className="text-gray-400 text-xs ml-2">{c.qty} {UNIT_LABELS[c.unit] ?? c.unit}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-gray-800">{fmtUSD(c.total)}</span>
                              <button
                                onClick={() => deleteOptionalCharge(c.id)}
                                className="text-gray-300 hover:text-red-500 transition-colors"
                                title="Eliminar"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Add new */}
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Agregar servicio</p>
                    {optionalRates.length === 0 ? (
                      <p className="text-sm text-gray-400">No hay servicios opcionales activos en el tarifario.</p>
                    ) : (
                      <div className="space-y-3">
                        <select
                          value={selectedRateId}
                          onChange={e => setSelectedRateId(e.target.value)}
                          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                        >
                          <option value="">Seleccionar servicio...</option>
                          {optionalRates.map(r => (
                            <option key={r.id} value={r.id!}>{r.name}</option>
                          ))}
                        </select>

                        {selectedRateId && (() => {
                          const rate = optionalRates.find(r => r.id === selectedRateId)!
                          return (
                            <div className="flex items-center gap-3">
                              <div className="flex-1">
                                <label className="block text-xs text-gray-400 mb-1">Cantidad</label>
                                <input
                                  type="number"
                                  min={1}
                                  value={optionalQty}
                                  onChange={e => setOptionalQty(Math.max(1, parseInt(e.target.value) || 1))}
                                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                                />
                              </div>
                              <div className="text-right">
                                <p className="text-xs text-gray-400 mb-1">Cantidad</p>
                                <p className="text-lg font-bold text-mcl-blue">{optionalQty}</p>
                              </div>
                            </div>
                          )
                        })()}

                        <button
                          onClick={saveOptionalCharge}
                          disabled={!selectedRateId || savingOptional}
                          className="w-full bg-purple-600 text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-purple-700 transition-colors disabled:opacity-40"
                        >
                          {savingOptional ? 'Guardando...' : '+ Agregar cargo'}
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}
