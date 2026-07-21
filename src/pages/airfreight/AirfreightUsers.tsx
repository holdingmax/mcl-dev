import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { collection, query, orderBy, onSnapshot, doc, updateDoc } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import { UserRole, ModuleAccess } from '../../types'
import Layout from '../../components/Layout'

interface UserDoc {
  id: string
  email: string
  name?: string
  role: UserRole
  module_access: ModuleAccess[]
  client_id?: string | null
  created_at?: string
}

const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Admin',
  accounting: 'Contabilidad',
  agent: 'Agente',
  client: 'Cliente',
  counter: 'Counter',
  bodega: 'Bodega',
  super_agent: 'Super Agente',
  viewer: 'Viewer',
  vendor_admin: 'Vendor Admin',
}

const ROLE_COLOR: Record<UserRole, string> = {
  admin: 'bg-red-100 text-red-700',
  accounting: 'bg-yellow-100 text-yellow-700',
  agent: 'bg-blue-100 text-blue-700',
  client: 'bg-green-100 text-green-700',
  counter: 'bg-purple-100 text-purple-700',
  bodega: 'bg-orange-100 text-orange-700',
  super_agent: 'bg-indigo-100 text-indigo-700',
  viewer: 'bg-gray-100 text-gray-700',
  vendor_admin: 'bg-teal-100 text-teal-700',
}

export default function AirfreightUsers() {
  const { isAdmin, createClientAccount } = useAuth()
  const navigate = useNavigate()
  const [users, setUsers] = useState<UserDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [showNewClient, setShowNewClient] = useState(false)

  // New client form
  const [newEmail, setNewEmail] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newName, setNewName] = useState('')
  const [newClientId, setNewClientId] = useState('')
  const [newModules, setNewModules] = useState<ModuleAccess[]>(['airfreight'])
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')

  useEffect(() => {
    if (!isAdmin) { navigate('/airfreight'); return }
    const q = query(collection(db, 'user_roles'), orderBy('created_at', 'desc'))
    return onSnapshot(q, snap => {
      setUsers(snap.docs.map(d => ({ ...d.data() as UserDoc, id: d.id })))
      setLoading(false)
    })
  }, [isAdmin])

  async function handleToggleAirfreight(u: UserDoc) {
    const hasAir = u.module_access.includes('airfreight')
    const updated = hasAir
      ? u.module_access.filter(m => m !== 'airfreight')
      : [...u.module_access, 'airfreight']
    await updateDoc(doc(db, 'user_roles', u.id), { module_access: updated })
  }

  async function handleCreateClient(e: React.FormEvent) {
    e.preventDefault()
    if (!newEmail || !newPassword || !newName) { setCreateError('Todos los campos son requeridos'); return }
    setCreating(true)
    setCreateError('')
    try {
      await createClientAccount(newEmail, newPassword, {
        module_access: newModules,
        client_id: newClientId.trim() || null,
        name: newName,
      })
      setShowNewClient(false)
      setNewEmail(''); setNewPassword(''); setNewName(''); setNewClientId('')
    } catch (err: any) {
      setCreateError(err.message || 'Error al crear la cuenta')
    } finally {
      setCreating(false)
    }
  }

  return (
    <Layout title="Usuarios" backTo="/airfreight">
      <div className="max-w-3xl mx-auto space-y-5">
        <div className="flex justify-between items-center">
          <h2 className="font-semibold text-gray-800">Usuarios ({users.length})</h2>
          <button
            onClick={() => setShowNewClient(true)}
            className="px-4 py-2 bg-mcl-blue text-white text-sm font-semibold rounded-lg hover:bg-blue-900"
          >
            + Cuenta cliente
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-10"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" /></div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm divide-y divide-gray-100">
            {users.map(u => (
              <div key={u.id} className="flex items-center justify-between px-5 py-3 gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm font-medium text-gray-800 truncate">{u.name || u.email}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${ROLE_COLOR[u.role] || 'bg-gray-100 text-gray-500'}`}>
                      {ROLE_LABELS[u.role] || u.role}
                    </span>
                  </div>
                  <p className="text-xs text-gray-400 truncate">{u.email}</p>
                  {u.client_id && <p className="text-xs text-gray-400">Cliente: {u.client_id}</p>}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <div className="flex gap-1">
                    {u.module_access.map(m => (
                      <span key={m} className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">{m === 'seafreight' ? 'SEA' : 'AIR'}</span>
                    ))}
                  </div>
                  {u.role !== 'admin' && (
                    <button
                      onClick={() => handleToggleAirfreight(u)}
                      className="text-xs text-mcl-blue hover:underline"
                    >
                      {u.module_access.includes('airfreight') ? '- Air' : '+ Air'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* New client modal */}
      {showNewClient && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <h3 className="text-lg font-semibold text-gray-800">Crear cuenta de cliente</h3>

            {createError && (
              <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700">{createError}</div>
            )}

            <form onSubmit={handleCreateClient} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Nombre *</label>
                <input value={newName} onChange={e => setNewName(e.target.value)} required
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="Nombre completo" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Email *</label>
                <input type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} required
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="email@empresa.com" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Contraseña *</label>
                <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} required minLength={6}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="Mínimo 6 caracteres" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">ID de cliente airfreight</label>
                <input value={newClientId} onChange={e => setNewClientId(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="ej. express-line" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-2">Módulos de acceso</label>
                <div className="flex gap-4">
                  {(['seafreight', 'airfreight'] as ModuleAccess[]).map(m => (
                    <label key={m} className="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
                      <input
                        type="checkbox"
                        checked={newModules.includes(m)}
                        onChange={e => setNewModules(prev => e.target.checked ? [...prev, m] : prev.filter(x => x !== m))}
                        className="rounded"
                      />
                      {m === 'seafreight' ? 'Sea Freight' : 'Air Freight'}
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowNewClient(false)}
                  className="flex-1 border border-gray-200 text-gray-600 rounded-lg py-2.5 text-sm hover:bg-gray-50">
                  Cancelar
                </button>
                <button type="submit" disabled={creating}
                  className="flex-1 bg-mcl-blue text-white rounded-lg py-2.5 text-sm font-semibold hover:bg-blue-900 disabled:opacity-50">
                  {creating ? 'Creando...' : 'Crear cuenta'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </Layout>
  )
}
