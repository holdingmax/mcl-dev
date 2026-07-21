import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  collection, query, orderBy, onSnapshot, addDoc, updateDoc, doc,
} from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import { AirfreightDestination } from '../../types'
import Layout from '../../components/Layout'

export default function AirfreightDestinations() {
  const { isAdmin } = useAuth()
  const navigate = useNavigate()
  const [destinations, setDestinations] = useState<(AirfreightDestination & { id: string })[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Partial<AirfreightDestination & { id?: string }> | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!isAdmin) { navigate('/airfreight'); return }
    const q = query(collection(db, 'airfreight_destinations'), orderBy('sort_order'))
    return onSnapshot(q, snap => {
      setDestinations(snap.docs.map(d => ({ ...d.data() as AirfreightDestination, id: d.id })))
      setLoading(false)
    })
  }, [isAdmin])

  async function handleSave() {
    if (!editing?.code?.trim() || !editing?.name?.trim()) return
    setSaving(true)
    const data = {
      code: editing.code.trim().toUpperCase(),
      name: editing.name.trim(),
      active: editing.active ?? true,
      sort_order: editing.sort_order ?? destinations.length,
    }
    try {
      if (editing.id) {
        await updateDoc(doc(db, 'airfreight_destinations', editing.id), data)
      } else {
        await addDoc(collection(db, 'airfreight_destinations'), data)
      }
      setEditing(null)
    } finally {
      setSaving(false)
    }
  }

  async function toggleActive(d: AirfreightDestination & { id: string }) {
    await updateDoc(doc(db, 'airfreight_destinations', d.id), { active: !d.active })
  }

  return (
    <Layout title="Destinos" backTo="/airfreight">
      <div className="max-w-xl mx-auto space-y-5">
        <div className="flex justify-between items-center">
          <h2 className="font-semibold text-gray-800">Destinos ({destinations.length})</h2>
          <button
            onClick={() => setEditing({ active: true, sort_order: destinations.length })}
            className="px-4 py-2 bg-mcl-blue text-white text-sm font-semibold rounded-lg hover:bg-blue-900"
          >
            + Nuevo destino
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-10"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" /></div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm divide-y divide-gray-100">
            {destinations.map(dest => (
              <div key={dest.id} className={`flex items-center justify-between px-5 py-3 ${!dest.active ? 'opacity-50' : ''}`}>
                <div className="flex items-center gap-3">
                  <span className="font-mono font-semibold text-gray-700 w-10">{dest.code}</span>
                  <span className="text-sm text-gray-600">{dest.name}</span>
                </div>
                <div className="flex gap-3">
                  <button onClick={() => setEditing({ ...dest })} className="text-xs text-mcl-blue hover:underline">Editar</button>
                  <button onClick={() => toggleActive(dest)} className="text-xs text-gray-400 hover:underline">
                    {dest.active ? 'Desactivar' : 'Activar'}
                  </button>
                </div>
              </div>
            ))}
            {destinations.length === 0 && (
              <div className="text-center py-10 text-sm text-gray-400">Sin destinos configurados</div>
            )}
          </div>
        )}
      </div>

      {/* Modal */}
      {editing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4">
            <h3 className="text-lg font-semibold text-gray-800">{editing.id ? 'Editar destino' : 'Nuevo destino'}</h3>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Código (IATA) *</label>
              <input
                value={editing.code || ''}
                onChange={e => setEditing({ ...editing, code: e.target.value })}
                placeholder="ej. MIA, BOG"
                maxLength={5}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm uppercase"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Nombre *</label>
              <input
                value={editing.name || ''}
                onChange={e => setEditing({ ...editing, name: e.target.value })}
                placeholder="ej. Bogotá, Colombia"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Orden</label>
              <input
                type="number"
                value={editing.sort_order ?? 0}
                onChange={e => setEditing({ ...editing, sort_order: Number(e.target.value) })}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
              />
            </div>

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setEditing(null)}
                className="flex-1 border border-gray-200 text-gray-600 rounded-lg py-2.5 text-sm hover:bg-gray-50"
              >
                Cancelar
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 bg-mcl-blue text-white rounded-lg py-2.5 text-sm font-semibold hover:bg-blue-900 disabled:opacity-50"
              >
                {saving ? 'Guardando...' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}
