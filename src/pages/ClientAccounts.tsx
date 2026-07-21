import { useState, useEffect } from 'react'
import Layout from '../components/Layout'
import { db } from '../lib/firebase'
import { collection, query, orderBy, onSnapshot, where, updateDoc, deleteDoc, doc, getDocs } from 'firebase/firestore'
import { useAuth } from '../contexts/AuthContext'
import { Client, UserRole, ModuleAccess } from '../types'
import { generateSecurePassword } from '../lib/passwordGen'

interface UserDoc {
  id: string
  email: string
  name?: string
  role: UserRole
  module_access: ModuleAccess[]
  client_id?: string | null
  can_view_charges?: boolean
  created_at?: string
}

export default function ClientAccounts() {
  const { createClientAccount } = useAuth()
  const [clients, setClients] = useState<Client[]>([])
  const [users, setUsers] = useState<UserDoc[]>([])
  const [loading, setLoading] = useState(true)

  // Create user
  const [creatingForClientId, setCreatingForClientId] = useState<string | null>(null)
  const [newEmail, setNewEmail] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newName, setNewName] = useState('')
  // Always seafreight from this page
  const [creatingUser, setCreatingUser] = useState(false)
  const [createUserError, setCreateUserError] = useState('')
  const [passwordCopied, setPasswordCopied] = useState(false)

  // Edit user
  const [editingUser, setEditingUser] = useState<UserDoc | null>(null)
  const [editUserName, setEditUserName] = useState('')
  const [editUserClientId, setEditUserClientId] = useState('')
  const [editCanViewCharges, setEditCanViewCharges] = useState(false)
  const [savingUser, setSavingUser] = useState(false)

  // Delete user
  const [confirmDeleteUser, setConfirmDeleteUser] = useState<UserDoc | null>(null)
  const [deletingUser, setDeletingUser] = useState(false)

  useEffect(() => {
    // Load clients
    getDocs(query(collection(db, 'clients'), orderBy('name'))).then(snap => {
      setClients(snap.docs.map(d => ({ id: d.id, ...d.data() })) as Client[])
      setLoading(false)
    })

    // Realtime listener for seafreight client users only
    const qUsers = query(
      collection(db, 'user_roles'),
      where('role', '==', 'client'),
      where('module_access', 'array-contains', 'seafreight')
    )
    const unsub = onSnapshot(qUsers, snap => {
      setUsers(snap.docs.map(d => ({ ...d.data() as UserDoc, id: d.id })))
    })
    return () => unsub()
  }, [])

  // ── Create user ─────────────────────────────────────────────────────────

  function openCreateUser(clientId: string) {
    setCreatingForClientId(clientId)
    setNewEmail(''); setNewPassword(generateSecurePassword(12)); setNewName(''); setCreateUserError('')
    setPasswordCopied(false)
  }

  function regeneratePassword() {
    setNewPassword(generateSecurePassword(12))
    setPasswordCopied(false)
  }

  async function copyPasswordToClipboard() {
    try {
      await navigator.clipboard.writeText(newPassword)
      setPasswordCopied(true)
      setTimeout(() => setPasswordCopied(false), 2000)
    } catch {
      setCreateUserError('No se pudo copiar al portapapeles')
    }
  }

  async function handleCreateUser(e: React.FormEvent) {
    e.preventDefault()
    if (!newEmail || !newPassword || !newName || !creatingForClientId) {
      setCreateUserError('Todos los campos son requeridos'); return
    }
    setCreatingUser(true); setCreateUserError('')
    try {
      await createClientAccount(newEmail, newPassword, {
        module_access: ['seafreight'],
        client_id: creatingForClientId,
        name: newName,
      })
      setCreatingForClientId(null)
    } catch (err: any) {
      setCreateUserError(err.message || 'Error al crear la cuenta')
    } finally { setCreatingUser(false) }
  }

  // ── Edit user ───────────────────────────────────────────────────────────

  function openEditUser(u: UserDoc) {
    setEditingUser(u)
    setEditUserName(u.name || '')
    setEditUserClientId(u.client_id || '')
    setEditCanViewCharges(!!u.can_view_charges)
  }

  async function handleSaveUser() {
    if (!editingUser) return
    setSavingUser(true)
    try {
      await updateDoc(doc(db, 'user_roles', editingUser.id), {
        name: editUserName.trim() || editingUser.email,
        client_id: editUserClientId || null,
        can_view_charges: editCanViewCharges,
      })
      setEditingUser(null)
    } catch (err) { console.error(err) }
    setSavingUser(false)
  }

  async function handleDeleteUser() {
    if (!confirmDeleteUser) return
    setDeletingUser(true)
    try {
      await deleteDoc(doc(db, 'user_roles', confirmDeleteUser.id))
      setConfirmDeleteUser(null)
    } catch (err) { console.error(err) }
    setDeletingUser(false)
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  function getUsersForClient(clientId: string) {
    return users.filter(u => u.client_id === clientId)
  }

  return (
    <Layout title="Cuentas de Acceso" backTo="/billing">
      <div className="max-w-3xl mx-auto space-y-4">

        {loading ? (
          <div className="flex justify-center p-8"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" /></div>
        ) : clients.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-100 p-8 text-center text-gray-400">
            No hay clientes registrados.
          </div>
        ) : (
          <>
            {clients.map(c => {
              const clientUsers = getUsersForClient(c.id!)
              return (
                <div key={c.id} className="bg-white rounded-xl shadow-sm border border-gray-100">
                  <div className="px-5 py-4 flex items-center justify-between">
                    <h3 className="font-semibold text-gray-800">{c.name}</h3>
                    <button onClick={() => openCreateUser(c.id!)}
                      className="text-xs bg-mcl-blue text-white px-3 py-1.5 rounded-lg hover:bg-blue-900 transition-colors font-medium">
                      + Crear cuenta
                    </button>
                  </div>

                  <div className="border-t border-gray-100 px-5 py-3 bg-gray-50/50 rounded-b-xl">
                    {clientUsers.length === 0 ? (
                      <p className="text-xs text-gray-400">Sin cuentas vinculadas</p>
                    ) : (
                      <div className="space-y-2">
                        {clientUsers.map(u => (
                          <div key={u.id} className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
                              <span className="text-sm text-gray-700 truncate">{u.name || u.email}</span>
                              <span className="text-xs text-gray-400 truncate hidden sm:inline">{u.email}</span>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <button
                                onClick={async () => {
                                  const newVal = !u.can_view_charges
                                  await updateDoc(doc(db, 'user_roles', u.id), { can_view_charges: newVal })
                                }}
                                className={`text-[10px] px-1.5 py-0.5 rounded font-medium transition-colors ${u.can_view_charges ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-gray-100 text-gray-400 hover:bg-gray-200'}`}
                                title={u.can_view_charges ? 'Cargos WR: activado — click para desactivar' : 'Cargos WR: desactivado — click para activar'}
                              >
                                {u.can_view_charges ? '$ Cargos' : '$ Cargos'}
                              </button>
                              <button onClick={() => openEditUser(u)}
                                className="text-xs text-mcl-blue hover:underline">Editar</button>
                              <button onClick={() => setConfirmDeleteUser(u)}
                                className="text-xs text-gray-400 hover:text-red-500">Eliminar</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </>
        )}
      </div>

      {/* ── Create user modal ──────────────────────────────────────────────── */}
      {creatingForClientId && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <form onSubmit={handleCreateUser} className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 space-y-4">
            <h3 className="font-bold text-gray-800">Crear cuenta de acceso</h3>
            <p className="text-xs text-gray-500">
              Cliente: <strong>{clients.find(c => c.id === creatingForClientId)?.name}</strong>
            </p>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Nombre</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={newName} onChange={e => setNewName(e.target.value)} placeholder="Nombre del usuario" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Email</label>
              <input type="email" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={newEmail} onChange={e => setNewEmail(e.target.value)} placeholder="usuario@empresa.com" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Contraseña temporal</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newPassword}
                  readOnly
                  className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono bg-gray-50 select-all"
                />
                <button
                  type="button"
                  onClick={copyPasswordToClipboard}
                  className={`px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${passwordCopied ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
                  title="Copiar al portapapeles"
                >
                  {passwordCopied ? '✓ Copiado' : 'Copiar'}
                </button>
                <button
                  type="button"
                  onClick={regeneratePassword}
                  className="px-3 py-2 rounded-lg text-xs font-semibold bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors"
                  title="Generar otra contraseña"
                >
                  Regenerar
                </button>
              </div>
              <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5 mt-2">
                Entrega esta contraseña al usuario. Deberá cambiarla en su primer inicio de sesión.
              </p>
            </div>
            {createUserError && <p className="text-xs text-red-500">{createUserError}</p>}
            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => setCreatingForClientId(null)} className="flex-1 border border-gray-300 text-gray-700 px-4 py-2 rounded-lg text-sm hover:bg-gray-50">Cancelar</button>
              <button type="submit" disabled={creatingUser} className="flex-1 bg-mcl-blue text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-900 disabled:opacity-50">
                {creatingUser ? 'Creando...' : 'Crear cuenta'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Edit user modal ────────────────────────────────────────────────── */}
      {editingUser && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 space-y-4">
            <h3 className="font-bold text-gray-800">Editar cuenta</h3>
            <p className="text-xs text-gray-500">{editingUser.email}</p>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Nombre</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={editUserName} onChange={e => setEditUserName(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Cliente vinculado</label>
              <select className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={editUserClientId} onChange={e => setEditUserClientId(e.target.value)}>
                <option value="">Sin vincular</option>
                {clients.map(cl => <option key={cl.id} value={cl.id}>{cl.name}</option>)}
              </select>
            </div>
            <div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={editCanViewCharges} onChange={e => setEditCanViewCharges(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-300 text-mcl-blue focus:ring-mcl-blue/30" />
                <span className="text-sm text-gray-700">Puede ver Cargos por WR</span>
              </label>
              <p className="text-xs text-gray-400 mt-1 ml-6">Acceso a la pantalla de cargos de facturación</p>
            </div>
            <div className="flex gap-3 pt-2">
              <button onClick={() => setEditingUser(null)} className="flex-1 border border-gray-300 text-gray-700 px-4 py-2 rounded-lg text-sm hover:bg-gray-50">Cancelar</button>
              <button onClick={handleSaveUser} disabled={savingUser} className="flex-1 bg-mcl-blue text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-900 disabled:opacity-50">
                {savingUser ? 'Guardando...' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete user confirm ────────────────────────────────────────────── */}
      {confirmDeleteUser && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h3 className="font-bold text-gray-800">Eliminar cuenta</h3>
            <p className="text-sm text-gray-600">
              ¿Eliminar la cuenta de <strong>{confirmDeleteUser.name || confirmDeleteUser.email}</strong>?
            </p>
            <div className="flex gap-3 pt-2">
              <button onClick={() => setConfirmDeleteUser(null)} className="flex-1 border border-gray-300 text-gray-700 px-4 py-2 rounded-lg text-sm hover:bg-gray-50">Cancelar</button>
              <button onClick={handleDeleteUser} disabled={deletingUser} className="flex-1 bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-red-700 disabled:opacity-50">
                {deletingUser ? 'Eliminando...' : 'Eliminar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}
