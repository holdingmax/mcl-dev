import { useState, useEffect } from 'react'
import {
  collection, query, orderBy, onSnapshot, addDoc, updateDoc, deleteDoc, doc,
} from 'firebase/firestore'
import { db } from '../../lib/firebase'
import Layout from '../../components/Layout'

// ── Types ──────────────────────────────────────────────────────────────────────

const ULD_CONFS = ['MD', 'LD', 'ESP'] as const
const ULD_TYPES = ['AKE', 'DQF', 'PMC', 'PAG', 'PLA', 'ALF', 'FQA'] as const

const CONF_LABELS: Record<string, { label: string; cls: string }> = {
  MD: { label: 'Main Deck', cls: 'bg-purple-50 text-purple-700' },
  LD: { label: 'Lower Deck', cls: 'bg-blue-50 text-blue-700' },
  ESP: { label: 'Especial', cls: 'bg-amber-50 text-amber-700' },
}

interface UldType {
  id: string
  conf: string       // MD / LD / ESP
  type: string       // AKE, DQF, PMC, etc.
  max_weight_kg: number
  tara_kg: number
  created_at: string
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function AirfreightUldTypes() {
  const [uldTypes, setUldTypes] = useState<UldType[]>([])
  const [loading, setLoading] = useState(true)

  // Form
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [conf, setConf] = useState<string>('MD')
  const [type, setType] = useState<string>('')
  const [maxWeight, setMaxWeight] = useState('')
  const [tara, setTara] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const q = query(collection(db, 'uld_types'), orderBy('conf', 'asc'))
    const unsub = onSnapshot(q, (snap) => {
      setUldTypes(snap.docs.map(d => ({ id: d.id, ...d.data() } as UldType)))
      setLoading(false)
    })
    return unsub
  }, [])

  function resetForm() {
    setShowForm(false)
    setEditingId(null)
    setConf('MD')
    setType('')
    setMaxWeight('')
    setTara('')
  }

  function startEdit(u: UldType) {
    setEditingId(u.id)
    setConf(u.conf)
    setType(u.type)
    setMaxWeight(String(u.max_weight_kg))
    setTara(String(u.tara_kg))
    setShowForm(true)
  }

  async function handleSave() {
    if (!type.trim() || !maxWeight || !tara) return
    setSaving(true)
    try {
      const data = {
        conf,
        type: type.trim().toUpperCase(),
        max_weight_kg: parseFloat(maxWeight) || 0,
        tara_kg: parseFloat(tara) || 0,
      }
      if (editingId) {
        await updateDoc(doc(db, 'uld_types', editingId), data)
      } else {
        await addDoc(collection(db, 'uld_types'), {
          ...data,
          created_at: new Date().toISOString(),
        })
      }
      resetForm()
    } catch (err: any) {
      alert('Error: ' + (err.message || err))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(u: UldType) {
    if (!confirm(`Eliminar ULD type ${u.conf} - ${u.type}?`)) return
    await deleteDoc(doc(db, 'uld_types', u.id))
  }

  // Group by conf
  const grouped = ULD_CONFS.map(c => ({
    conf: c,
    ...CONF_LABELS[c],
    items: uldTypes.filter(u => u.conf === c),
  }))

  return (
    <Layout title="ULD Types" backTo="/airfreight/admin">
      <div className="max-w-3xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-bold text-gray-800">Configuracion de ULD Types</h2>
            <p className="text-sm text-gray-500">Define tipos de ULD con su configuracion, peso maximo y tara</p>
          </div>
          <button
            onClick={() => { resetForm(); setShowForm(true) }}
            className="px-4 py-2 bg-blue-800 text-white text-sm font-semibold rounded-lg hover:bg-blue-900 transition-colors"
          >
            + Nuevo Tipo
          </button>
        </div>

        {/* Form */}
        {showForm && (
          <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
            <h3 className="font-semibold text-gray-800 mb-4">
              {editingId ? 'Editar ULD Type' : 'Nuevo ULD Type'}
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">CONF</label>
                <select
                  value={conf}
                  onChange={e => setConf(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-800"
                >
                  {ULD_CONFS.map(c => (
                    <option key={c} value={c}>{c} - {CONF_LABELS[c].label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">TYPE</label>
                <input
                  list="uld-type-options"
                  value={type}
                  onChange={e => setType(e.target.value.toUpperCase())}
                  placeholder="Ej: AKE"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-800"
                />
                <datalist id="uld-type-options">
                  {ULD_TYPES.map(t => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Max Weight (kg)</label>
                <input
                  type="number"
                  value={maxWeight}
                  onChange={e => setMaxWeight(e.target.value)}
                  placeholder="0"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-blue-800"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Tara (kg)</label>
                <input
                  type="number"
                  value={tara}
                  onChange={e => setTara(e.target.value)}
                  placeholder="0"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-blue-800"
                />
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              <button
                onClick={handleSave}
                disabled={saving || !type.trim() || !maxWeight || !tara}
                className="px-4 py-2 bg-blue-800 text-white text-sm font-semibold rounded-lg hover:bg-blue-900 disabled:opacity-50 transition-colors"
              >
                {saving ? 'Guardando...' : editingId ? 'Actualizar' : 'Guardar'}
              </button>
              <button
                onClick={resetForm}
                className="px-4 py-2 border border-gray-200 text-gray-600 text-sm rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        {/* List grouped by CONF */}
        {loading ? (
          <div className="text-center py-12 text-gray-400">Cargando...</div>
        ) : uldTypes.length === 0 && !showForm ? (
          <div className="text-center py-12 text-gray-400">
            <p className="text-sm">No hay tipos de ULD configurados</p>
            <p className="text-xs mt-1">Crea el primero con el boton de arriba</p>
          </div>
        ) : (
          <div className="space-y-6">
            {grouped.filter(g => g.items.length > 0).map(g => (
              <div key={g.conf}>
                <div className="flex items-center gap-2 mb-3">
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${g.cls}`}>
                    {g.conf}
                  </span>
                  <span className="text-sm text-gray-500">{g.label}</span>
                </div>
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="text-left px-4 py-2.5 font-medium text-gray-600">Type</th>
                        <th className="text-right px-4 py-2.5 font-medium text-gray-600">Max Weight (kg)</th>
                        <th className="text-right px-4 py-2.5 font-medium text-gray-600">Tara (kg)</th>
                        <th className="text-right px-4 py-2.5 font-medium text-gray-600">Net Capacity (kg)</th>
                        <th className="px-4 py-2.5 w-20"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {g.items.map(u => (
                        <tr key={u.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3 font-mono font-bold text-gray-800">{u.type}</td>
                          <td className="px-4 py-3 text-right font-mono">{u.max_weight_kg.toLocaleString()}</td>
                          <td className="px-4 py-3 text-right font-mono">{u.tara_kg.toLocaleString()}</td>
                          <td className="px-4 py-3 text-right font-mono font-semibold text-blue-800">
                            {(u.max_weight_kg - u.tara_kg).toLocaleString()}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex gap-1 justify-end">
                              <button
                                onClick={() => startEdit(u)}
                                className="p-1.5 text-gray-400 hover:text-blue-800 rounded"
                                title="Editar"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                                </svg>
                              </button>
                              <button
                                onClick={() => handleDelete(u)}
                                className="p-1.5 text-gray-400 hover:text-red-600 rounded"
                                title="Eliminar"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  )
}
