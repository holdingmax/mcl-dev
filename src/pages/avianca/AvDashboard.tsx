import { useState, useEffect, useMemo } from 'react'
import { collection, getDocs, query, orderBy, where, addDoc, deleteDoc, updateDoc, doc, writeBatch } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import { useNavigate } from 'react-router-dom'
import Layout from '../../components/Layout'
import type { AvFlight } from '../../types'
import { logAvEvent } from '../../lib/avLog'
import { useAvCan } from '../../lib/avPermissions'

export default function AvDashboard() {
  const { user } = useAuth()
  const { canAv } = useAvCan()
  const navigate = useNavigate()
  const [flights, setFlights] = useState<(AvFlight & { id: string })[]>([])
  const [loading, setLoading] = useState(true)
  const [showNewModal, setShowNewModal] = useState(false)
  const [newFlight, setNewFlight] = useState({ flight_number: '', etd_date: '', etd_time: '', destination: '' })
  const [creating, setCreating] = useState(false)

  // Edit modal
  const [editFlight, setEditFlight] = useState<(AvFlight & { id: string }) | null>(null)
  const [editForm, setEditForm] = useState({ flight_number: '', etd_date: '', etd_time: '', destination: '' })
  const [savingEdit, setSavingEdit] = useState(false)

  // Delete
  const [deleteTarget, setDeleteTarget] = useState<(AvFlight & { id: string }) | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Status inline change
  const [statusMenuId, setStatusMenuId] = useState<string | null>(null)

  // Filters
  const [filterDest, setFilterDest] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterSearch, setFilterSearch] = useState('')

  useEffect(() => { loadFlights() }, [])

  async function loadFlights() {
    setLoading(true)
    const snap = await getDocs(query(collection(db, 'av_flights'), orderBy('etd', 'desc')))
    setFlights(snap.docs.map(d => ({ id: d.id, ...d.data() } as AvFlight & { id: string })))
    setLoading(false)
  }

  async function createFlight() {
    if (!newFlight.flight_number || !newFlight.etd_date || !newFlight.destination) return
    setCreating(true)
    const etd = newFlight.etd_time ? `${newFlight.etd_date}T${newFlight.etd_time}` : `${newFlight.etd_date}T00:00`
    const flight: Omit<AvFlight, 'id'> = {
      flight_number: newFlight.flight_number.toUpperCase(),
      etd,
      destination: newFlight.destination.toUpperCase(),
      origin: 'MIA',
      status: 'booked',
      total_awbs: 0,
      total_pieces: 0,
      total_gross_kg: 0,
      total_chw_kg: 0,
      has_dg: false,
      has_lb: false,
      screening_complete: false,
      created_at: new Date().toISOString(),
      created_by: user?.email || '',
    }
    const ref = await addDoc(collection(db, 'av_flights'), flight)
    logAvEvent(ref.id, '-', 'flight_created', `Vuelo ${flight.flight_number} — ${flight.destination} — ETD ${etd}`, user?.email || '')
    setShowNewModal(false)
    setNewFlight({ flight_number: '', etd_date: '', etd_time: '', destination: '' })
    setCreating(false)
    navigate(`/avianca/flight/${ref.id}`)
  }

  // ── Edit flight ──
  function openEdit(f: AvFlight & { id: string }, e: React.MouseEvent) {
    e.stopPropagation()
    const [datePart, timePart] = (f.etd || '').split('T')
    setEditForm({
      flight_number: f.flight_number,
      etd_date: datePart || '',
      etd_time: timePart?.slice(0, 5) || '',
      destination: f.destination,
    })
    setEditFlight(f)
  }

  async function saveEdit() {
    if (!editFlight || !editForm.flight_number || !editForm.etd_date || !editForm.destination) return
    setSavingEdit(true)
    const etd = editForm.etd_time ? `${editForm.etd_date}T${editForm.etd_time}` : `${editForm.etd_date}T00:00`
    const updates = {
      flight_number: editForm.flight_number.toUpperCase(),
      etd,
      destination: editForm.destination.toUpperCase(),
      updated_at: new Date().toISOString(),
    }
    await updateDoc(doc(db, 'av_flights', editFlight.id), updates)
    logAvEvent(editFlight.id, '-', 'flight_edited', `Vuelo ${updates.flight_number} — ${updates.destination} — ETD ${etd}`, user?.email || '')
    setFlights(prev => prev.map(f => f.id === editFlight.id ? { ...f, ...updates } : f))
    setEditFlight(null)
    setSavingEdit(false)
  }

  // ── Delete flight ──
  function openDelete(f: AvFlight & { id: string }, e: React.MouseEvent) {
    e.stopPropagation()
    setDeleteTarget(f)
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    // Delete child AWBs and pallet tags
    const [awbSnap, ptSnap] = await Promise.all([
      getDocs(query(collection(db, 'av_flight_awbs'), where('flight_id', '==', deleteTarget.id))),
      getDocs(query(collection(db, 'av_pallet_tags'), where('flight_id', '==', deleteTarget.id))),
    ])
    const batch = writeBatch(db)
    awbSnap.docs.forEach(d => batch.delete(d.ref))
    ptSnap.docs.forEach(d => batch.delete(d.ref))
    batch.delete(doc(db, 'av_flights', deleteTarget.id))
    await batch.commit()
    logAvEvent(deleteTarget.id, '-', 'flight_deleted', `Vuelo ${deleteTarget.flight_number} eliminado`, user?.email || '')
    setFlights(prev => prev.filter(f => f.id !== deleteTarget.id))
    setDeleteTarget(null)
    setDeleting(false)
  }

  async function changeFlightStatus(flightId: string, newStatus: string) {
    const f = flights.find(fl => fl.id === flightId)
    if (!f || f.status === newStatus) { setStatusMenuId(null); return }
    await updateDoc(doc(db, 'av_flights', flightId), { status: newStatus, updated_at: new Date().toISOString() })
    logAvEvent(flightId, '-', 'status_changed', `${f.status} → ${newStatus} (manual)`, user?.email || '')
    setFlights(prev => prev.map(fl => fl.id === flightId ? { ...fl, status: newStatus as AvFlight['status'] } : fl))
    setStatusMenuId(null)
  }

  const destinations = useMemo(() => {
    const set = new Set(flights.map(f => f.destination))
    return Array.from(set).sort()
  }, [flights])

  const filtered = useMemo(() => {
    let result = flights
    if (filterDest) result = result.filter(f => f.destination === filterDest)
    if (filterStatus) result = result.filter(f => f.status === filterStatus)
    if (filterSearch) {
      const q = filterSearch.toLowerCase()
      result = result.filter(f =>
        f.flight_number.toLowerCase().includes(q) ||
        f.destination.toLowerCase().includes(q)
      )
    }
    return result
  }, [flights, filterDest, filterStatus, filterSearch])

  const statusBadge = (s: string) => {
    const map: Record<string, string> = {
      booked: 'bg-gray-100 text-gray-600',
      in_progress: 'bg-yellow-100 text-yellow-700',
      completed: 'bg-green-100 text-green-700',
      dispatched: 'bg-blue-100 text-blue-700',
    }
    const labels: Record<string, string> = {
      booked: 'Booked',
      in_progress: 'In Progress',
      completed: 'Completed',
      dispatched: 'Dispatched',
    }
    return <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${map[s] || ''}`}>{labels[s] || s}</span>
  }

  if (loading) return <Layout title="Avianca Cargo"><div className="flex justify-center py-20"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" /></div></Layout>

  return (
    <Layout title="Avianca Cargo" backTo="/select">
      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center mb-6">
        {canAv('create_flight') && (
          <button onClick={() => setShowNewModal(true)} className="bg-mcl-blue text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-900">
            + Nuevo Vuelo
          </button>
        )}
        <input
          type="text"
          placeholder="Buscar vuelo..."
          value={filterSearch}
          onChange={e => setFilterSearch(e.target.value)}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-56 focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
        />
        <select value={filterDest} onChange={e => setFilterDest(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
          <option value="">Destino</option>
          {destinations.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm">
          <option value="">Status</option>
          <option value="booked">Booked</option>
          <option value="in_progress">In Progress</option>
          <option value="completed">Completed</option>
          <option value="dispatched">Dispatched</option>
        </select>
        {(filterDest || filterStatus || filterSearch) && (
          <button onClick={() => { setFilterDest(''); setFilterStatus(''); setFilterSearch('') }} className="text-xs text-red-500 hover:underline">Limpiar</button>
        )}
      </div>

      <p className="text-xs text-gray-400 mb-3">{filtered.length} vuelos</p>

      {/* Flight Table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 uppercase text-[10px]">
            <tr>
              <th className="text-left px-4 py-3 font-semibold">Flight</th>
              <th className="text-left px-3 py-3 font-semibold">ETD</th>
              <th className="text-center px-3 py-3 font-semibold">Dest</th>
              <th className="text-right px-3 py-3 font-semibold">AWBs</th>
              <th className="text-right px-3 py-3 font-semibold">PCS</th>
              <th className="text-right px-3 py-3 font-semibold">KG</th>
              <th className="text-right px-3 py-3 font-semibold">CHW</th>
              <th className="text-center px-3 py-3 font-semibold">DG</th>
              <th className="text-center px-3 py-3 font-semibold">LB</th>
              <th className="text-center px-3 py-3 font-semibold">SCR</th>
              <th className="text-center px-3 py-3 font-semibold">Status</th>
              <th className="text-center px-3 py-3 font-semibold w-20"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(f => (
              <tr
                key={f.id}
                onClick={() => navigate(`/avianca/flight/${f.id}`)}
                className="border-t border-gray-100 hover:bg-blue-50/50 cursor-pointer transition-colors"
              >
                <td className="px-4 py-3 font-semibold text-gray-800">{f.flight_number}</td>
                <td className="px-3 py-3 text-gray-600">{f.etd?.slice(0, 16).replace('T', ' ')}</td>
                <td className="px-3 py-3 text-center font-semibold">{f.destination}</td>
                <td className="px-3 py-3 text-right font-mono">{f.total_awbs}</td>
                <td className="px-3 py-3 text-right font-mono">{f.total_pieces.toLocaleString()}</td>
                <td className="px-3 py-3 text-right font-mono">{f.total_gross_kg.toLocaleString()}</td>
                <td className="px-3 py-3 text-right font-mono">{f.total_chw_kg.toLocaleString()}</td>
                <td className="px-3 py-3 text-center">{f.has_dg ? <span className="text-red-600 font-bold">!</span> : <span className="text-gray-300">—</span>}</td>
                <td className="px-3 py-3 text-center">{f.has_lb ? <span className="text-amber-600 font-bold">!</span> : <span className="text-gray-300">—</span>}</td>
                <td className="px-3 py-3 text-center">{f.screening_complete ? <span className="text-green-600 font-bold">✓</span> : <span className="text-gray-300">✗</span>}</td>
                <td className="px-3 py-3 text-center" onClick={e => e.stopPropagation()}>
                  {canAv('edit_flight') ? (
                    <select
                      value={f.status}
                      onChange={e => changeFlightStatus(f.id, e.target.value)}
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-mcl-blue/30 ${
                        f.status === 'booked' ? 'bg-gray-100 text-gray-600' :
                        f.status === 'in_progress' ? 'bg-yellow-100 text-yellow-700' :
                        f.status === 'completed' ? 'bg-green-100 text-green-700' :
                        'bg-blue-100 text-blue-700'
                      }`}
                    >
                      <option value="booked">BOOKED</option>
                      <option value="in_progress">IN PROGRESS</option>
                      <option value="completed">COMPLETED</option>
                      <option value="dispatched">DISPATCHED</option>
                    </select>
                  ) : statusBadge(f.status)}
                </td>
                {canAv('edit_flight') && (
                  <td className="px-3 py-3 text-center">
                    <div className="flex items-center justify-center gap-2">
                      <button
                        onClick={e => openEdit(f, e)}
                        className="text-gray-400 hover:text-mcl-blue transition-colors"
                        title="Editar vuelo"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                      </button>
                      <button
                        onClick={e => openDelete(f, e)}
                        className="text-gray-400 hover:text-red-500 transition-colors"
                        title="Eliminar vuelo"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={12} className="text-center py-12 text-gray-400">No hay vuelos</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* New Flight Modal */}
      {showNewModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowNewModal(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-gray-100">
              <h3 className="font-bold text-gray-800 text-lg">Nuevo Vuelo</h3>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Numero de Vuelo</label>
                <input
                  type="text"
                  placeholder="AV-705"
                  value={newFlight.flight_number}
                  onChange={e => setNewFlight(p => ({ ...p, flight_number: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                  autoFocus
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Fecha ETD</label>
                  <input
                    type="date"
                    value={newFlight.etd_date}
                    onChange={e => setNewFlight(p => ({ ...p, etd_date: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Hora ETD</label>
                  <input
                    type="time"
                    value={newFlight.etd_time}
                    onChange={e => setNewFlight(p => ({ ...p, etd_time: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Destino</label>
                <input
                  type="text"
                  placeholder="BOG"
                  value={newFlight.destination}
                  onChange={e => setNewFlight(p => ({ ...p, destination: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm uppercase focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                  maxLength={3}
                />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
              <button onClick={() => setShowNewModal(false)} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">Cancelar</button>
              <button
                onClick={createFlight}
                disabled={creating || !newFlight.flight_number || !newFlight.etd_date || !newFlight.destination}
                className="bg-mcl-blue text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-900 disabled:opacity-50"
              >
                {creating ? 'Creando...' : 'Crear Vuelo'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Flight Modal */}
      {editFlight && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setEditFlight(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-gray-100">
              <h3 className="font-bold text-gray-800 text-lg">Editar Vuelo</h3>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Numero de Vuelo</label>
                <input
                  type="text"
                  value={editForm.flight_number}
                  onChange={e => setEditForm(p => ({ ...p, flight_number: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                  autoFocus
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Fecha ETD</label>
                  <input
                    type="date"
                    value={editForm.etd_date}
                    onChange={e => setEditForm(p => ({ ...p, etd_date: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Hora ETD</label>
                  <input
                    type="time"
                    value={editForm.etd_time}
                    onChange={e => setEditForm(p => ({ ...p, etd_time: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Destino</label>
                <input
                  type="text"
                  value={editForm.destination}
                  onChange={e => setEditForm(p => ({ ...p, destination: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm uppercase focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                  maxLength={3}
                />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
              <button onClick={() => setEditFlight(null)} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">Cancelar</button>
              <button
                onClick={saveEdit}
                disabled={savingEdit || !editForm.flight_number || !editForm.etd_date || !editForm.destination}
                className="bg-mcl-blue text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-900 disabled:opacity-50"
              >
                {savingEdit ? 'Guardando...' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Flight Confirmation */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setDeleteTarget(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-5 text-center">
              <div className="text-3xl mb-3">⚠️</div>
              <h3 className="font-bold text-gray-800 text-lg mb-2">Eliminar Vuelo</h3>
              <p className="text-sm text-gray-500 mb-1">
                Se eliminara el vuelo <strong>{deleteTarget.flight_number}</strong> con todos sus AWBs y Pallet Tags.
              </p>
              <p className="text-xs text-red-500 font-semibold">Esta accion no se puede deshacer.</p>
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
              <button onClick={() => setDeleteTarget(null)} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">Cancelar</button>
              <button
                onClick={confirmDelete}
                disabled={deleting}
                className="bg-red-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? 'Eliminando...' : 'Eliminar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}
