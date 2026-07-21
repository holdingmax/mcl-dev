import { useState, useEffect } from 'react'
import { collection, query, where, getDocs, doc, updateDoc, orderBy, Timestamp } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { DeliveryOrder, AwbEntry } from '../types'

export default function MobileEditDO() {
  const [view, setView] = useState<'list' | 'edit'>('list')
  const [dos, setDos] = useState<(DeliveryOrder & { id: string })[]>([])
  const [loading, setLoading] = useState(true)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<(DeliveryOrder & { id: string })[]>([])
  const [searching, setSearching] = useState(false)

  // Edit state
  const [editDo, setEditDo] = useState<(DeliveryOrder & { id: string }) | null>(null)
  const [editUlds, setEditUlds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState('')

  // Load today's DOs
  useEffect(() => {
    ;(async () => {
      try {
        const today = new Date()
        const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString()
        const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).toISOString()
        const snap = await getDocs(query(
          collection(db, 'delivery_orders'),
          where('created_at', '>=', startOfDay),
          where('created_at', '<', endOfDay),
        ))
        const list = snap.docs
          .map(d => ({ ...d.data() as DeliveryOrder, id: d.id }))
          .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
        setDos(list)
      } catch (err) {
        console.error('Error loading DOs:', err)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  // Search DOs across all dates
  async function handleSearch() {
    const q = searchQuery.trim().toLowerCase()
    if (!q) { setSearchResults([]); return }
    setSearching(true)
    try {
      const snap = await getDocs(collection(db, 'delivery_orders'))
      const results = snap.docs
        .map(d => ({ ...d.data() as DeliveryOrder, id: d.id }))
        .filter(d => {
          const text = [
            d.do_number,
            ...(d.awb_entries || []).map(e => e.awb_number),
            ...(d.awb_entries || []).map(e => e.client_name),
            d.driver_name,
            d.trucking_company,
          ].join(' ').toLowerCase()
          return text.includes(q)
        })
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
        .slice(0, 20)
      setSearchResults(results)
    } catch (err) {
      console.error('Search error:', err)
    } finally {
      setSearching(false)
    }
  }

  function openEdit(doItem: DeliveryOrder & { id: string }) {
    setEditDo(doItem)
    setEditUlds(doItem.ulds_loaded && doItem.ulds_loaded.length > 0 ? [...doItem.ulds_loaded] : [''])
    setView('edit')
  }

  function goBack() {
    setView('list')
    setEditDo(null)
    // Reload today's DOs to reflect changes
    ;(async () => {
      try {
        const today = new Date()
        const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString()
        const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).toISOString()
        const snap = await getDocs(query(
          collection(db, 'delivery_orders'),
          where('created_at', '>=', startOfDay),
          where('created_at', '<', endOfDay),
        ))
        const list = snap.docs
          .map(d => ({ ...d.data() as DeliveryOrder, id: d.id }))
          .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
        setDos(list)
      } catch {}
    })()
  }

  async function handleSave() {
    if (!editDo) return
    setSaving(true)
    try {
      const cleanUlds = editUlds.map(u => u.trim().toUpperCase()).filter(Boolean)
      await updateDoc(doc(db, 'delivery_orders', editDo.id), {
        ulds_loaded: cleanUlds,
        updated_at: new Date().toISOString(),
      })
      setToast('ULDs actualizados')
      setTimeout(() => { setToast(''); goBack() }, 1200)
    } catch (err) {
      alert('Error al guardar: ' + (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  function fmtDate(iso: string) {
    try {
      const d = new Date(iso)
      return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`
    } catch { return iso }
  }

  const todayLabel = fmtDate(new Date().toISOString())
  const displayList = searchOpen && searchQuery.trim() ? searchResults : dos

  // ── LIST VIEW ──
  if (view === 'list') {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col">
        <div className="bg-[#1e3a5f] text-white px-4 py-3.5 text-center sticky top-0 z-10">
          <h1 className="text-base font-bold">Edit Delivery Order</h1>
          <div className="text-[11px] text-white/60 mt-0.5">Selecciona una DO para editar ULDs</div>
        </div>
        <div className="flex-1 p-3">
          {/* Today label */}
          {!searchOpen && (
            <div className="flex items-center gap-1.5 mb-2 text-[11px] font-bold text-gray-500 uppercase tracking-wide">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
              Hoy — {todayLabel}
              <span className="ml-auto font-normal text-gray-400">{dos.length} DOs</span>
            </div>
          )}

          {/* Loading */}
          {loading && <div className="text-center text-sm text-gray-400 py-8">Cargando...</div>}

          {/* DO cards */}
          {!loading && displayList.map(d => (
            <DOCard key={d.id} doItem={d} onTap={() => openEdit(d)} />
          ))}

          {!loading && displayList.length === 0 && (
            <div className="text-center py-10 text-gray-400">
              <div className="text-3xl mb-2">&#128196;</div>
              <div className="text-sm">{searchOpen ? 'No se encontraron DOs' : 'No hay DOs de hoy'}</div>
            </div>
          )}

          {/* Search toggle / bar */}
          {!searchOpen ? (
            <button
              onClick={() => setSearchOpen(true)}
              className="w-full flex items-center justify-center gap-1.5 border border-gray-300 rounded-lg py-2.5 text-xs text-gray-500 mt-2"
            >
              <span>&#128269;</span> Buscar DO de otra fecha
            </button>
          ) : (
            <div className="flex items-center gap-2 bg-white border border-[#1e3a5f] rounded-lg px-3 py-2.5 mb-2 mt-2">
              <input
                autoFocus
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                placeholder="DO#, AWB, cliente..."
                className="flex-1 text-sm outline-none"
              />
              {searching ? (
                <span className="text-xs text-gray-400">...</span>
              ) : (
                <button onClick={handleSearch} className="text-[#1e3a5f] font-bold text-xs px-2">Buscar</button>
              )}
              <button
                onClick={() => { setSearchOpen(false); setSearchQuery(''); setSearchResults([]) }}
                className="text-gray-400 text-lg leading-none"
              >&times;</button>
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── EDIT VIEW ──
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <div className="bg-[#1e3a5f] text-white px-4 py-3.5 text-center sticky top-0 z-10 relative">
        <button onClick={goBack} className="absolute left-3 top-1/2 -translate-y-1/2 text-white text-xl bg-transparent border-none cursor-pointer">&larr;</button>
        <h1 className="text-base font-bold font-mono">{editDo?.do_number}</h1>
        <div className="text-[11px] text-white/60 mt-0.5">Editar ULDs</div>
      </div>
      <div className="flex-1 p-3">
        {/* AWBs read-only */}
        <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">AWBs en esta DO</div>
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-3">
          {(editDo?.awb_entries || []).map((e, i) => (
            <div key={i} className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-50 last:border-b-0">
              {e.frozen_pc === 'C' ? (
                <span className="w-[18px] h-[18px] rounded-full bg-green-500 text-[9px] font-extrabold text-white flex items-center justify-center flex-shrink-0">C</span>
              ) : e.frozen_pc === 'P' ? (
                <span className="w-[18px] h-[18px] rounded-full bg-amber-400 text-[9px] font-extrabold text-white flex items-center justify-center flex-shrink-0">P</span>
              ) : (
                <span className="w-[18px] h-[18px] rounded-full bg-gray-200 text-[9px] font-bold text-gray-500 flex items-center justify-center flex-shrink-0">&ndash;</span>
              )}
              <div>
                <div className="font-mono font-bold text-[13px] text-[#1e3a5f]">{e.awb_number || e.awb_1st_leg}</div>
                <div className="text-[11px] text-gray-500">{e.client_name} &bull; {e.destination}</div>
              </div>
            </div>
          ))}
        </div>

        {/* ULDs editable */}
        <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">ULDs Loaded</div>
        {editUlds.map((uld, i) => (
          <div key={i} className="flex items-center gap-2 bg-white rounded-xl border border-gray-200 px-3 py-2.5 mb-1.5">
            <input
              value={uld}
              onChange={e => {
                const next = [...editUlds]
                next[i] = e.target.value
                setEditUlds(next)
              }}
              placeholder="ULD number"
              className="flex-1 border border-gray-200 rounded-lg px-2.5 py-2 text-sm font-mono font-bold uppercase focus:outline-none focus:border-[#1e3a5f] focus:ring-2 focus:ring-[#1e3a5f]/15"
            />
            <button
              onClick={() => setEditUlds(editUlds.filter((_, j) => j !== i))}
              className="w-8 h-8 rounded-lg bg-red-50 border border-red-200 text-red-600 text-base flex items-center justify-center flex-shrink-0"
            >&times;</button>
          </div>
        ))}
        <button
          onClick={() => setEditUlds([...editUlds, ''])}
          className="w-full bg-gray-50 border-2 border-dashed border-gray-300 rounded-xl py-2.5 text-xs font-semibold text-[#1e3a5f] mb-3"
        >+ Agregar ULD</button>

        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full bg-[#1e3a5f] text-white font-bold rounded-xl py-3.5 text-sm disabled:opacity-50 mt-1"
        >
          {saving ? 'Guardando...' : 'Guardar Cambios'}
        </button>
        <button onClick={goBack} className="w-full text-gray-400 text-xs py-3 mt-1">Cancelar</button>
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 bg-emerald-800 text-white px-5 py-2.5 rounded-xl text-sm font-semibold shadow-lg z-50 animate-pulse">
          {toast}
        </div>
      )}
    </div>
  )
}

// ── DO Card Component ──
function DOCard({ doItem, onTap }: { doItem: DeliveryOrder & { id: string }; onTap: () => void }) {
  const entries = doItem.awb_entries || []
  const ulds = (doItem.ulds_loaded || []).filter(u => u.trim())
  const clients = [...new Set(entries.map(e => e.client_name).filter(Boolean))]

  function fmtDate(iso: string) {
    try {
      const d = new Date(iso)
      return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`
    } catch { return '' }
  }

  return (
    <div onClick={onTap} className="bg-white rounded-xl border border-gray-200 p-3.5 mb-2.5 active:ring-2 active:ring-[#1e3a5f] cursor-pointer">
      <div className="flex items-center justify-between mb-2">
        <span className="font-mono font-extrabold text-[15px] text-[#1e3a5f]">{doItem.do_number}</span>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
          doItem.status === 'complete' ? 'bg-green-100 text-green-800' :
          doItem.driver_name ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-600'
        }`}>
          {doItem.status === 'complete' ? 'Complete' : doItem.driver_name ? 'Pending' : 'Draft'}
        </span>
      </div>
      <div className="text-[11px] text-gray-500 mb-1.5">
        {entries.map((e, i) => (
          <span key={i}>
            {i > 0 && ', '}
            <span className="font-mono font-semibold text-gray-700">{e.awb_number || e.awb_1st_leg}</span>
          </span>
        ))}
      </div>
      {ulds.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {ulds.map((u, i) => (
            <span key={i} className="bg-gray-50 border border-gray-200 rounded px-1.5 py-0.5 text-[10px] font-mono font-semibold text-[#1e3a5f]">{u}</span>
          ))}
        </div>
      )}
      <div className="text-[10px] text-gray-400">
        {clients.join(', ')} &bull; {doItem.trucking_company || '—'} &bull; {doItem.driver_name || '—'}
      </div>
    </div>
  )
}
