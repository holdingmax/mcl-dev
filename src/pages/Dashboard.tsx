import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Layout from '../components/Layout'
import { db } from '../lib/firebase'
import { collection, query, orderBy, limit, getDocs, doc, deleteDoc, writeBatch, where } from 'firebase/firestore'
import { WarehouseReceipt } from '../types'
import { formatWRDate, toTitleCase } from '../lib/utils'
import { useAuth } from '../contexts/AuthContext'

export default function Dashboard() {
  const { user, isAdmin, isSuperAgent, canEdit, isClient, clientId } = useAuth()
  const [receipts, setReceipts] = useState<WarehouseReceipt[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterClient, setFilterClient] = useState('')
  const [filterDest, setFilterDest] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  useEffect(() => {
    fetchReceipts()
  }, [])

  async function deleteWR(id: string, wrNumber: string) {
    if (!confirm(`¿Eliminar el WR ${wrNumber}? Esta acción no se puede deshacer.`)) return
    const linesSnap = await getDocs(collection(db, 'warehouse_receipts', id, 'lines'))
    const batch = writeBatch(db)
    linesSnap.docs.forEach(d => batch.delete(d.ref))
    batch.delete(doc(db, 'warehouse_receipts', id))
    await batch.commit()
    setReceipts(prev => prev.filter(r => r.id !== id))
  }

  async function fetchReceipts() {
    setLoading(true)
    const constraints: any[] = [orderBy('created_at', 'desc'), limit(100)]
    if (isClient && clientId) {
      constraints.unshift(where('client_id', '==', clientId))
    }
    const q = query(collection(db, 'warehouse_receipts'), ...constraints)
    const snapshot = await getDocs(q)
    const data = (snapshot.docs.map(d => ({ id: d.id, ...d.data() })) as WarehouseReceipt[])
      .filter(wr => wr.source !== 'warehouse_services')
    setReceipts(data)
    setLoading(false)
  }

  // Derive unique client names and destinations for filters
  const clientNames = [...new Set(receipts.map(r => r.client_name).filter(Boolean))].sort()
  const destinations = [...new Set(receipts.map(r => r.to_port).filter(Boolean))].sort()

  // Compute status key for filtering
  function getStatusKey(r: WarehouseReceipt): string {
    if (r.dispatch_status === 'dispatched') return 'dispatched'
    if (r.dispatch_status === 'reserved') return 'reserved'
    if (r.physical_status === 'complete') return 'complete'
    if (r.counter_status === 'complete' && r.physical_status === 'pending') return 'physical_pending'
    return 'draft'
  }

  const filtered = receipts.filter(r => {
    if (search) {
      const s = search.toLowerCase()
      if (!r.wr_number?.toLowerCase().includes(s) &&
          !r.po_number?.toLowerCase().includes(s) &&
          !r.company_name?.toLowerCase().includes(s) &&
          !r.client_name?.toLowerCase().includes(s)) return false
    }
    if (filterStatus) {
      if (getStatusKey(r) !== filterStatus) return false
    } else {
      if (getStatusKey(r) === 'dispatched') return false
    }
    if (filterClient && r.client_name !== filterClient) return false
    if (filterDest && r.to_port !== filterDest) return false
    if (dateFrom || dateTo) {
      const d = r.created_at?.slice(0, 10) ?? ''
      if (dateFrom && d < dateFrom) return false
      if (dateTo && d > dateTo) return false
    }
    return true
  })

  const pendingPhysical = receipts.filter(r => r.physical_status === 'pending').length

  return (
    <Layout title="Dashboard" backTo="/select">
      {/* Stats */}
      <div className="grid grid-cols-4 sm:grid-cols-4 lg:grid-cols-7 gap-2 sm:gap-4 mb-4 sm:mb-6">
        <div className="bg-white rounded-xl shadow-sm p-2 sm:p-4 border border-gray-100">
          <p className="text-[10px] sm:text-xs text-gray-500 uppercase tracking-wide leading-tight">Total WRs</p>
          <p className="text-xl sm:text-3xl font-bold text-mcl-blue mt-0.5 sm:mt-1">{receipts.length}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm p-2 sm:p-4 border border-orange-100">
          <p className="text-[10px] sm:text-xs text-orange-500 uppercase tracking-wide leading-tight">Pendientes</p>
          <p className="text-xl sm:text-3xl font-bold text-orange-500 mt-0.5 sm:mt-1">{pendingPhysical}</p>
        </div>
        {canEdit && (
          <div className="bg-mcl-blue rounded-xl shadow-sm p-2 sm:p-4 flex items-center justify-center">
            <Link to="/counter/new" className="text-white font-semibold text-center">
              <div className="text-lg sm:text-3xl leading-none mb-0.5 sm:mb-1">+</div>
              <div className="text-[10px] sm:text-sm leading-tight">Nuevo WR</div>
            </Link>
          </div>
        )}
        <div className="bg-[#1A4D2E] rounded-xl shadow-sm p-2 sm:p-4 flex items-center justify-center">
          <Link to="/inventory" className="text-white font-semibold text-center">
            <div className="text-base sm:text-2xl leading-none mb-0.5 sm:mb-1">📦</div>
            <div className="text-[10px] sm:text-sm leading-tight">Inventario</div>
          </Link>
        </div>
        <div className="bg-[#1E3A5F] rounded-xl shadow-sm p-2 sm:p-4 flex items-center justify-center">
          <Link to="/dispatches" className="text-white font-semibold text-center">
            <div className="text-base sm:text-2xl leading-none mb-0.5 sm:mb-1">🚢</div>
            <div className="text-[10px] sm:text-sm leading-tight">Consolidados</div>
          </Link>
        </div>
        {!isClient && (
          <div className="bg-[#4A1D96] rounded-xl shadow-sm p-2 sm:p-4 flex items-center justify-center">
            <Link to="/locate" className="text-white font-semibold text-center">
              <div className="text-base sm:text-2xl leading-none mb-0.5 sm:mb-1">📡</div>
              <div className="text-[10px] sm:text-sm leading-tight">Ubicar</div>
            </Link>
          </div>
        )}
      </div>

      {/* Search + Filters */}
      <div className="mb-4 space-y-2">
        <input
          type="text"
          placeholder="Buscar por WR, PO, empresa o cliente..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full border border-gray-200 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
        />
        <div className="flex flex-wrap gap-2">
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-600 focus:outline-none focus:ring-1 focus:ring-mcl-blue/30">
            <option value="">Todos los status</option>
            <option value="draft">Borrador</option>
            <option value="physical_pending">Físico pendiente</option>
            <option value="complete">Completo</option>
            <option value="reserved">Reservado</option>
            <option value="dispatched">Gate Out</option>
          </select>
          <select value={filterClient} onChange={e => setFilterClient(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-600 focus:outline-none focus:ring-1 focus:ring-mcl-blue/30">
            <option value="">Todos los clientes</option>
            {clientNames.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={filterDest} onChange={e => setFilterDest(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-600 focus:outline-none focus:ring-1 focus:ring-mcl-blue/30">
            <option value="">Todos los destinos</option>
            {destinations.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-gray-400">Desde</label>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs text-gray-600 focus:outline-none focus:ring-1 focus:ring-mcl-blue/30" />
            <label className="text-xs text-gray-400">Hasta</label>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs text-gray-600 focus:outline-none focus:ring-1 focus:ring-mcl-blue/30" />
          </div>
          {(filterStatus || filterClient || filterDest || dateFrom || dateTo) && (
            <button type="button" onClick={() => { setFilterStatus(''); setFilterClient(''); setFilterDest(''); setDateFrom(''); setDateTo('') }}
              className="text-xs text-gray-400 hover:text-gray-600 px-2 py-1.5">
              Limpiar filtros
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-400">Cargando...</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-gray-400">
            {search ? 'Sin resultados' : 'No hay WRs aún. Crea el primero.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase">WR #</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase">PO</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase hidden sm:table-cell">Cliente</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase hidden sm:table-cell">Shipper/Vendor</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase hidden sm:table-cell">Destino</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase hidden md:table-cell">Fecha</th>
                  <th className="text-center px-4 py-3 font-semibold text-gray-600 text-xs uppercase">Recepción</th>
                  <th className="text-center px-4 py-3 font-semibold text-gray-600 text-xs uppercase">Status</th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-600 text-xs uppercase">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map(r => (
                  <tr key={r.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-mono font-semibold text-mcl-blue text-xs">{r.wr_number}</td>
                    <td className="px-4 py-3 text-gray-700">
                      <div className="flex items-center gap-2">
                        <span>{r.po_number}</span>
                        {r.cargo_type && (
                          <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${r.cargo_type === 'BOND' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>
                            {r.cargo_type}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600 text-xs hidden sm:table-cell">{r.client_name || '—'}</td>
                    <td className="px-4 py-3 text-gray-600 hidden sm:table-cell max-w-[160px] truncate">{toTitleCase(r.company_name)}</td>
                    <td className="px-4 py-3 text-xs hidden sm:table-cell">
                      {r.to_port ? (
                        <span className="bg-mcl-blue/10 text-mcl-blue font-bold px-2 py-0.5 rounded">{r.to_port}</span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs hidden md:table-cell">
                      {r.created_at ? formatWRDate(r.created_at) : '—'}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <StatusBadge counterStatus={r.counter_status} physicalStatus={r.physical_status} />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <DispatchStatusBadge dispatchStatus={r.dispatch_status} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {!isClient && canEdit && r.counter_status === 'complete' && r.physical_status === 'pending' && (
                          <Link
                            to={`/reception/${r.id}`}
                            className="text-xs bg-orange-50 text-orange-600 border border-orange-200 px-2 py-1 rounded-md hover:bg-orange-100 transition-colors whitespace-nowrap"
                          >
                            Recepción Física
                          </Link>
                        )}
                        {!isClient && canEdit && (
                          <Link
                            to={`/counter/${r.id}/edit`}
                            className="text-xs bg-blue-50 text-mcl-blue border border-blue-200 px-2 py-1 rounded-md hover:bg-blue-100 transition-colors"
                          >
                            Editar
                          </Link>
                        )}
                        {r.physical_status === 'complete' && (
                          <Link
                            to={`/wr/${r.id}/print`}
                            className="text-xs bg-green-50 text-green-700 border border-green-200 px-2 py-1 rounded-md hover:bg-green-100 transition-colors"
                          >
                            Imprimir WR
                          </Link>
                        )}
                        {!isClient && r.counter_status === 'complete' && (
                          <Link
                            to={`/reception/${r.id}`}
                            className="text-xs text-gray-400 hover:text-gray-600 px-1"
                            title="Ver"
                          >
                            Ver
                          </Link>
                        )}
                        {(isAdmin || isSuperAgent) && (
                          <button
                            onClick={() => deleteWR(r.id!, r.wr_number || '')}
                            className="text-xs text-red-400 hover:text-red-600 px-1 transition-colors"
                            title="Eliminar"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Layout>
  )
}

function DispatchStatusBadge({ dispatchStatus }: { dispatchStatus?: string }) {
  if (dispatchStatus === 'dispatched') {
    return <span className="inline-flex items-center gap-1 bg-green-100 text-green-700 text-xs px-2 py-0.5 rounded-full font-medium">✓ Gate Out</span>
  }
  if (dispatchStatus === 'reserved') {
    return <span className="inline-flex items-center gap-1 bg-amber-100 text-amber-700 text-xs px-2 py-0.5 rounded-full font-medium">🔒 Reservado</span>
  }
  return <span className="inline-flex items-center gap-1 bg-blue-50 text-mcl-blue text-xs px-2 py-0.5 rounded-full font-medium">✓ Recibido</span>
}

function StatusBadge({ counterStatus, physicalStatus }: { counterStatus: string; physicalStatus: string }) {
  if (physicalStatus === 'complete') {
    return <span className="inline-flex items-center gap-1 bg-green-100 text-green-700 text-xs px-2 py-0.5 rounded-full font-medium">✓ Completo</span>
  }
  if (counterStatus === 'complete') {
    return <span className="inline-flex items-center gap-1 bg-orange-100 text-orange-600 text-xs px-2 py-0.5 rounded-full font-medium">⏳ Físico pendiente</span>
  }
  return <span className="inline-flex items-center gap-1 bg-gray-100 text-gray-500 text-xs px-2 py-0.5 rounded-full">Borrador</span>
}
