import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { collection, query, orderBy, getDocs, addDoc, updateDoc, deleteDoc, doc } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import Layout from '../../components/Layout'

interface Entry {
  id: string
  type: 'shipper' | 'consignee'
  client_name: string
  full_name: string
  short_name: string
}

export default function AirfreightShippersConsignees() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [entries, setEntries] = useState<Entry[]>([])
  const [tab, setTab] = useState<'consignee' | 'shipper'>('consignee')
  const [saving, setSaving] = useState(false)

  // Inline editing
  const [editId, setEditId] = useState<string | null>(null)
  const [editClient, setEditClient] = useState('')
  const [editFull, setEditFull] = useState('')
  const [editShort, setEditShort] = useState('')

  // New row
  const [newClient, setNewClient] = useState('')
  const [newFull, setNewFull] = useState('')
  const [newShort, setNewShort] = useState('')

  // Client names for dropdown
  const [clientNames, setClientNames] = useState<string[]>([])

  useEffect(() => {
    ;(async () => {
      try {
        const [scSnap, clSnap] = await Promise.all([
          getDocs(query(collection(db, 'airfreight_shippers_consignees'), orderBy('short_name'))),
          getDocs(query(collection(db, 'airfreight_clients'), orderBy('name'))),
        ])
        setEntries(scSnap.docs.map(d => ({ ...d.data() as any, id: d.id })))
        setClientNames(clSnap.docs.map(d => (d.data() as any).name || '').filter(Boolean))
      } catch (err) {
        console.error('Error loading:', err)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const filtered = entries.filter(e => e.type === tab)

  async function handleAdd() {
    if (!newFull.trim() || !newShort.trim()) return
    setSaving(true)
    try {
      const data = { type: tab, client_name: newClient.trim(), full_name: newFull.trim(), short_name: newShort.trim() }
      const ref = await addDoc(collection(db, 'airfreight_shippers_consignees'), data)
      setEntries(prev => [...prev, { ...data, id: ref.id }])
      setNewClient('')
      setNewFull('')
      setNewShort('')
    } catch (err: any) {
      alert('Error: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleSaveEdit() {
    if (!editId || !editFull.trim() || !editShort.trim()) return
    setSaving(true)
    try {
      await updateDoc(doc(db, 'airfreight_shippers_consignees', editId), {
        client_name: editClient.trim(),
        full_name: editFull.trim(),
        short_name: editShort.trim(),
      })
      setEntries(prev => prev.map(e => e.id === editId ? { ...e, client_name: editClient.trim(), full_name: editFull.trim(), short_name: editShort.trim() } : e))
      setEditId(null)
    } catch (err: any) {
      alert('Error: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm('Eliminar este registro?')) return
    try {
      await deleteDoc(doc(db, 'airfreight_shippers_consignees', id))
      setEntries(prev => prev.filter(e => e.id !== id))
    } catch (err: any) {
      alert('Error: ' + err.message)
    }
  }

  function startEdit(e: Entry) {
    setEditId(e.id)
    setEditClient(e.client_name || '')
    setEditFull(e.full_name)
    setEditShort(e.short_name)
  }

  return (
    <Layout title="Shippers / Consignees" backTo="/airfreight/clients">
      <div className="max-w-5xl mx-auto space-y-4">
        {/* Tabs */}
        <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1 w-fit">
          <button onClick={() => { setTab('consignee'); setEditId(null) }}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${tab === 'consignee' ? 'bg-white text-[#1e3a5f] shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
            Consignees ({entries.filter(e => e.type === 'consignee').length})
          </button>
          <button onClick={() => { setTab('shipper'); setEditId(null) }}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${tab === 'shipper' ? 'bg-white text-[#1e3a5f] shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
            Shippers ({entries.filter(e => e.type === 'shipper').length})
          </button>
        </div>

        {/* Table */}
        {loading ? (
          <div className="flex justify-center py-10"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#1e3a5f]" /></div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-3 py-2.5 text-left font-medium text-gray-600 text-xs w-[15%]">Cliente</th>
                  <th className="px-3 py-2.5 text-left font-medium text-gray-600 text-xs w-[45%]">Nombre Completo</th>
                  <th className="px-3 py-2.5 text-left font-medium text-gray-600 text-xs w-[20%]">Nombre Sistema</th>
                  <th className="px-3 py-2.5 text-center font-medium text-gray-600 text-xs w-[20%]">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map(e => (
                  <tr key={e.id} className="hover:bg-blue-50/30">
                    {editId === e.id ? (
                      <>
                        <td className="px-2 py-1.5">
                          <input type="text" list="client-list" value={editClient} onChange={ev => setEditClient(ev.target.value)}
                            className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#1e3a5f]" />
                        </td>
                        <td className="px-2 py-1.5">
                          <textarea value={editFull} onChange={ev => setEditFull(ev.target.value)}
                            rows={2} className="w-full border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:border-[#1e3a5f] resize-none" />
                        </td>
                        <td className="px-2 py-1.5">
                          <input type="text" value={editShort} onChange={ev => setEditShort(ev.target.value)}
                            className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm font-semibold focus:outline-none focus:border-[#1e3a5f]" />
                        </td>
                        <td className="px-2 py-1.5 text-center">
                          <div className="flex items-center justify-center gap-2">
                            <button onClick={handleSaveEdit} disabled={saving}
                              className="text-xs font-semibold text-green-600 hover:text-green-800">Guardar</button>
                            <button onClick={() => setEditId(null)}
                              className="text-xs font-semibold text-gray-400 hover:text-gray-600">Cancelar</button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="px-3 py-2.5 text-gray-700 font-medium">{e.client_name || '—'}</td>
                        <td className="px-3 py-2.5 text-gray-700 text-xs leading-snug">{e.full_name}</td>
                        <td className="px-3 py-2.5 font-semibold text-gray-800">{e.short_name}</td>
                        <td className="px-3 py-2.5 text-center">
                          <div className="flex items-center justify-center gap-3">
                            <button onClick={() => startEdit(e)}
                              className="text-xs font-semibold text-[#1e3a5f] hover:underline">Editar</button>
                            <button onClick={() => handleDelete(e.id)}
                              className="text-xs font-semibold text-red-400 hover:text-red-600">Eliminar</button>
                          </div>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
                {/* New row */}
                <tr className="bg-green-50/30">
                  <td className="px-2 py-1.5">
                    <input type="text" list="client-list" value={newClient} onChange={e => setNewClient(e.target.value)}
                      placeholder="Cliente..."
                      className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#1e3a5f]" />
                  </td>
                  <td className="px-2 py-1.5">
                    <textarea value={newFull} onChange={e => setNewFull(e.target.value)}
                      placeholder={`Nombre completo del ${tab === 'consignee' ? 'consignee' : 'shipper'}...`}
                      rows={2} className="w-full border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:border-[#1e3a5f] resize-none" />
                  </td>
                  <td className="px-2 py-1.5">
                    <input type="text" value={newShort} onChange={e => setNewShort(e.target.value)}
                      placeholder="Nombre corto..."
                      className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#1e3a5f]"
                      onKeyDown={e => { if (e.key === 'Enter') handleAdd() }} />
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    <button onClick={handleAdd} disabled={saving || !newFull.trim() || !newShort.trim()}
                      className="px-3 py-1.5 bg-[#1e3a5f] text-white text-xs font-semibold rounded-lg hover:bg-blue-900 disabled:opacity-50">
                      + Agregar
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
      <datalist id="client-list">
        {clientNames.map(c => <option key={c} value={c} />)}
      </datalist>
    </Layout>
  )
}
