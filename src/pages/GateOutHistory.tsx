import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Layout from '../components/Layout'
import { db } from '../lib/firebase'
import { collection, getDocs, query, where, doc, getDoc, updateDoc, limit } from 'firebase/firestore'
import { WarehouseReceipt, WRLine, Consignee, Dispatch } from '../types'
import { formatWRDate, toTitleCase, fmtNum } from '../lib/utils'
import { exportGateOut } from '../lib/exportGateOut'
import { useAuth } from '../contexts/AuthContext'

function formatDate(iso?: string) {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`
}

interface InventoryWR extends WarehouseReceipt {
  lines: WRLine[]
}

export default function GateOutHistory() {
  const { isClient, clientId: authClientId } = useAuth()
  const [items, setItems]       = useState<InventoryWR[]>([])
  const [loading, setLoading]   = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const [filterCountry,   setFilterCountry]   = useState('')
  const [filterVendor,    setFilterVendor]    = useState('')
  const [filterConsignee, setFilterConsignee] = useState('')
  const [search,          setSearch]          = useState('')
  const [dateFrom,        setDateFrom]        = useState('')
  const [dateTo,          setDateTo]          = useState('')

  useEffect(() => { loadItems() }, [])

  async function loadItems() {
    setLoading(true)
    try {
      // Repair (best-effort): ensure WRs from gate_out dispatches have dispatch_status = 'dispatched'
      // BUT respect partial_wr_ids — those WRs still have remaining pieces in inventory
      if (!isClient) {
        try {
          const dispSnap = await getDocs(query(collection(db, 'dispatches'), where('status', '==', 'gate_out'), limit(500)))
          const partialWrIdSet = new Set<string>()
          const allGateOutWrIds = new Set<string>()
          for (const d of dispSnap.docs) {
            const data = d.data() as Dispatch
            for (const wrId of (data.wr_ids || [])) allGateOutWrIds.add(wrId)
            for (const wrId of (data.partial_wr_ids || [])) partialWrIdSet.add(wrId)
          }
          await Promise.allSettled([...allGateOutWrIds].map(wrId =>
            updateDoc(doc(db, 'warehouse_receipts', wrId), {
              dispatch_status: partialWrIdSet.has(wrId) ? 'partial' : 'dispatched',
            })
          ))
        } catch (repairErr) { console.warn('repair skipped', repairErr) }
      }

      // Query WRs by dispatch_status, filtered by client_id for clients
      const constraints: any[] = [where('dispatch_status', '==', 'dispatched')]
      if (isClient && authClientId) {
        constraints.push(where('client_id', '==', authClientId))
      }
      const q = query(collection(db, 'warehouse_receipts'), ...constraints, limit(2000))
      const snap = await getDocs(q)
      const wrs  = (snap.docs.map(d => ({ id: d.id, ...d.data() })) as WarehouseReceipt[])
        .filter(wr => wr.source !== 'warehouse_services')

      const full = await Promise.all(wrs.map(async wr => {
        const linesSnap = await getDocs(collection(db, 'warehouse_receipts', wr.id!, 'lines'))
        const lines = linesSnap.docs
          .map(d => ({ id: d.id, ...d.data() }) as WRLine)
          .sort((a, b) => (a.line_order ?? 0) - (b.line_order ?? 0))

        if (wr.consignee_id && !wr.consignee) {
          try {
            const cs = await getDoc(doc(db, 'consignees', wr.consignee_id))
            if (cs.exists()) wr.consignee = { id: cs.id, ...cs.data() } as Consignee
          } catch { /* ignore */ }
        } else if (!wr.consignee_id && wr.consignee_name) {
          wr.consignee = { id: '', name: wr.consignee_name, full_address: '', notify_to: wr.notify_to || '' }
        }

        return { ...wr, lines } as InventoryWR
      }))

      full.sort((a, b) => (b.dispatched_at ?? '').localeCompare(a.dispatched_at ?? ''))
      setItems(full)
    } catch (e) { console.error(e) }
    setLoading(false)
  }

  const countries  = [...new Set(items.map(i => i.to_port).filter(Boolean))].sort()
  const vendors    = [...new Set(items.map(i => i.company_name).filter(Boolean))].sort()
  const consignees = [...new Set(items.map(i => i.consignee?.name).filter(Boolean))].sort() as string[]

  const filtered = items.filter(i => {
    if (filterCountry   && i.to_port !== filterCountry) return false
    if (filterVendor    && i.company_name !== filterVendor) return false
    if (filterConsignee && i.consignee?.name !== filterConsignee) return false
    if (dateFrom && i.dispatched_at && i.dispatched_at < dateFrom) return false
    if (dateTo   && i.dispatched_at && i.dispatched_at > dateTo + 'T23:59:59') return false
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

  function toggleExpand(id: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const [exporting, setExporting] = useState(false)

  async function handleExport() {
    setExporting(true)
    const dateLabel = new Date().toISOString().slice(0, 10)
    await exportGateOut(filtered, dateLabel)
    setExporting(false)
  }

  const hasFilters = filterCountry || filterVendor || filterConsignee || search || dateFrom || dateTo
  const selectClass = 'border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-mcl-blue/30 bg-white'

  return (
    <Layout title="Historial Gate Out" backTo="/inventory">
      <div className="flex justify-end gap-2 mb-3">
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
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-3">
          <input
            type="text"
            placeholder="Buscar WR, PO, Vendor..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className={selectClass + ' w-full'}
          />
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
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 whitespace-nowrap">Gate Out desde</label>
            <input
              type="date"
              value={dateFrom}
              onChange={e => setDateFrom(e.target.value)}
              className={selectClass + ' flex-1'}
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 whitespace-nowrap">hasta</label>
            <input
              type="date"
              value={dateTo}
              onChange={e => setDateTo(e.target.value)}
              className={selectClass + ' flex-1'}
            />
          </div>
        </div>
        {hasFilters && (
          <button
            onClick={() => { setFilterCountry(''); setFilterVendor(''); setFilterConsignee(''); setSearch(''); setDateFrom(''); setDateTo('') }}
            className="text-xs text-gray-400 hover:text-gray-600 underline"
          >
            Limpiar filtros
          </button>
        )}
      </div>

      {/* Totals */}
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-3 mb-4">
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

      {/* Table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue mx-auto" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-gray-400">No hay guías con Gate Out en el período seleccionado.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="px-4 py-3 w-6"></th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase">WR #</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase">PO #</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase hidden sm:table-cell">Cliente</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase hidden sm:table-cell">Consignee</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase hidden md:table-cell">Shipper/Vendor</th>
                  <th className="text-center px-4 py-3 font-semibold text-gray-600 text-xs uppercase">País</th>
                  <th className="text-center px-4 py-3 font-semibold text-gray-600 text-xs uppercase hidden sm:table-cell">Tipo</th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-600 text-xs uppercase">Pzas</th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-600 text-xs uppercase hidden sm:table-cell">CBM</th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-600 text-xs uppercase hidden sm:table-cell">KG</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase hidden lg:table-cell">F. Entrada</th>
                  <th className="text-center px-4 py-3 font-semibold text-gray-600 text-xs uppercase hidden md:table-cell">F. Gate Out</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase hidden lg:table-cell">Contenedor</th>
                  <th className="px-4 py-3"></th>
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
                        <td className="px-4 py-3 text-gray-400">
                          <svg className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        </td>
                        <td className="px-4 py-3 font-mono font-semibold text-mcl-blue text-xs">{item.wr_number}</td>
                        <td className="px-4 py-3 text-gray-700">{item.po_number}</td>
                        <td className="px-4 py-3 text-gray-600 hidden sm:table-cell max-w-[120px] truncate">{item.client_name || '—'}</td>
                        <td className="px-4 py-3 text-gray-600 hidden sm:table-cell max-w-[140px] truncate">{toTitleCase(item.consignee?.name) || '—'}</td>
                        <td className="px-4 py-3 text-gray-600 hidden md:table-cell max-w-[140px] truncate">{toTitleCase(item.company_name)}</td>
                        <td className="px-4 py-3 text-center">
                          <span className="inline-block bg-mcl-blue/10 text-mcl-blue text-xs font-bold px-2 py-0.5 rounded">{item.to_port}</span>
                        </td>
                        <td className="px-4 py-3 text-center hidden sm:table-cell">
                          {item.cargo_type && (
                            <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${item.cargo_type === 'BOND' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>
                              {item.cargo_type}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold text-gray-700">{fmtNum(wrPieces)}</td>
                        <td className="px-4 py-3 text-right text-gray-500 font-mono text-xs hidden sm:table-cell">{fmtNum(wrCBM, 4)}</td>
                        <td className="px-4 py-3 text-right text-gray-500 text-xs hidden sm:table-cell">{fmtNum(wrKG, 1)}</td>
                        <td className="px-4 py-3 text-gray-400 text-xs hidden lg:table-cell">{item.created_at ? formatWRDate(item.created_at) : '—'}</td>
                        <td className="px-4 py-3 text-center hidden md:table-cell">
                          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-700">
                            {formatDate(item.dispatched_at)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500 font-mono hidden lg:table-cell">{item.container_number || '—'}</td>
                        <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                          <Link
                            to={`/wr/${item.id}/print`}
                            className="text-xs text-gray-400 hover:text-mcl-blue transition-colors"
                            title="Ver WR"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                            </svg>
                          </Link>
                        </td>
                      </tr>

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
    </Layout>
  )
}
