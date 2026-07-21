import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  collection, query, orderBy, onSnapshot, addDoc, updateDoc, deleteDoc, doc, where,
} from 'firebase/firestore'
import { db, functions } from '../../lib/firebase'
import { httpsCallable } from 'firebase/functions'
import { useAuth } from '../../contexts/AuthContext'
import { AirfreightClient, AirfreightClientBilling, AirHandlingOverride, UserRole, ModuleAccess } from '../../types'
import Layout from '../../components/Layout'
import { generateSecurePassword } from '../../lib/passwordGen'

type ClientContact = { name: string; email: string; phone?: string }

interface UserDoc {
  id: string
  email: string
  name?: string
  role: UserRole
  module_access: ModuleAccess[]
  client_id?: string | null
  created_at?: string
}

const EMPTY_CLIENT: Omit<AirfreightClient, 'id'> = {
  name: '',
  booking_type: 'simple',
  contacts: [{ name: '', email: '' }],
  notify_emails: [],
  active: true,
}

export default function AirfreightClients() {
  const { isAdmin, createClientAccount } = useAuth()
  const navigate = useNavigate()
  const [clients, setClients] = useState<(AirfreightClient & { id: string })[]>([])
  const [users, setUsers] = useState<UserDoc[]>([])
  const [seaClientIds, setSeaClientIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<(AirfreightClient & { id?: string }) | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // New user account form
  const [creatingForClientId, setCreatingForClientId] = useState<string | null>(null)
  const [newEmail, setNewEmail] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newName, setNewName] = useState('')
  const [newRole, setNewRole] = useState<'client' | 'viewer'>('client')
  const [creatingUser, setCreatingUser] = useState(false)
  const [createUserError, setCreateUserError] = useState('')
  const [passwordCopied, setPasswordCopied] = useState(false)

  // Edit user
  const [editingUser, setEditingUser] = useState<UserDoc | null>(null)
  const [editUserName, setEditUserName] = useState('')
  const [editUserClientId, setEditUserClientId] = useState('')
  const [savingUser, setSavingUser] = useState(false)

  // Delete user confirm
  const [confirmDeleteUser, setConfirmDeleteUser] = useState<UserDoc | null>(null)
  const [deletingUser, setDeletingUser] = useState(false)

  useEffect(() => {
    if (!isAdmin) { navigate('/airfreight'); return }
    const qClients = query(collection(db, 'airfreight_clients'), orderBy('name'))
    const qUsers = query(collection(db, 'user_roles'), where('role', 'in', ['client', 'viewer']))

    const unsubClients = onSnapshot(qClients, snap => {
      setClients(snap.docs.map(d => ({ ...d.data() as AirfreightClient, id: d.id })))
      setLoading(false)
    })
    const unsubUsers = onSnapshot(qUsers, snap => {
      setUsers(snap.docs.map(d => ({ ...d.data() as UserDoc, id: d.id })))
    })
    // Load seafreight client IDs to avoid showing their users as orphans
    const unsubSea = onSnapshot(collection(db, 'clients'), snap => {
      setSeaClientIds(new Set(snap.docs.map(d => d.id)))
    })
    return () => { unsubClients(); unsubUsers(); unsubSea() }
  }, [isAdmin])

  // ── Client CRUD ─────────────────────────────────────────────────────────

  function openNew() { setEditing({ ...EMPTY_CLIENT }); setError('') }
  function openEdit(client: AirfreightClient & { id: string }) { setEditing({ ...client }); setError('') }

  function updateContact(idx: number, field: keyof ClientContact, value: string) {
    if (!editing) return
    const contacts = [...editing.contacts]
    contacts[idx] = { ...contacts[idx], [field]: value }
    setEditing({ ...editing, contacts })
  }
  function addContact() {
    if (!editing) return
    setEditing({ ...editing, contacts: [...editing.contacts, { name: '', email: '' }] })
  }
  function removeContact(idx: number) {
    if (!editing) return
    setEditing({ ...editing, contacts: editing.contacts.filter((_, i) => i !== idx) })
  }
  function updateNotifyEmails(raw: string) {
    if (!editing) return
    setEditing({ ...editing, notify_emails: raw.split('\n').map(e => e.trim()).filter(Boolean) })
  }

  async function handleSave() {
    if (!editing) return
    if (!editing.name.trim()) { setError('El nombre es requerido'); return }
    setSaving(true); setError('')
    try {
      const data: Record<string, any> = {
        name: editing.name.trim(),
        booking_type: editing.booking_type,
        transportation_enabled: editing.transportation_enabled || false,
        contacts: editing.contacts.filter(c => c.email || c.name),
        notify_emails: editing.notify_emails,
        active: editing.active,
        billing: editing.billing || {},
        created_at: (editing as any).created_at || new Date().toISOString(),
        ccsssp_company_name: editing.ccsssp_company_name || '',
        ccsssp_short_name: editing.ccsssp_short_name || '',
        ccsssp_tsa_number: editing.ccsssp_tsa_number || '',
        ccsssp_address: editing.ccsssp_address || '',
        ccsssp_phone: editing.ccsssp_phone || '',
        ccsssp_email: editing.ccsssp_email || '',
        ccsssp_logo_url: editing.ccsssp_logo_url || '',
        ccsssp_logo_right_url: editing.ccsssp_logo_right_url || '',
        ccsssp_format: editing.ccsssp_format || '',
        ccsssp_rep_name: editing.ccsssp_rep_name || '',
        ccsssp_signature_url: editing.ccsssp_signature_url || '',
      }
      if (editing.id) {
        await updateDoc(doc(db, 'airfreight_clients', editing.id), data)
      } else {
        await addDoc(collection(db, 'airfreight_clients'), data)
      }
      setEditing(null)
    } catch { setError('Error al guardar') }
    finally { setSaving(false) }
  }

  async function toggleActive(client: AirfreightClient & { id: string }) {
    await updateDoc(doc(db, 'airfreight_clients', client.id), { active: !client.active })
  }

  // ── User account creation ───────────────────────────────────────────────

  function openCreateUser(clientId: string) {
    setCreatingForClientId(clientId)
    setNewEmail(''); setNewPassword(generateSecurePassword(12)); setNewName(''); setNewRole('client'); setCreateUserError('')
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
        module_access: ['airfreight'],
        client_id: creatingForClientId,
        name: newName,
        role: newRole,
      })
      setCreatingForClientId(null)
    } catch (err: any) {
      setCreateUserError(err.message || 'Error al crear la cuenta')
    } finally { setCreatingUser(false) }
  }

  // ── User edit/delete ────────────────────────────────────────────────────

  function openEditUser(u: UserDoc) {
    setEditingUser(u)
    setEditUserName(u.name || '')
    setEditUserClientId(u.client_id || '')
  }

  async function handleSaveUser() {
    if (!editingUser) return
    setSavingUser(true)
    try {
      await updateDoc(doc(db, 'user_roles', editingUser.id), {
        name: editUserName.trim() || editingUser.email,
        client_id: editUserClientId || null,
      })
      setEditingUser(null)
    } catch (err) { console.error(err) }
    setSavingUser(false)
  }

  async function handleDeleteUser() {
    if (!confirmDeleteUser) return
    setDeletingUser(true)
    try {
      const deleteFn = httpsCallable(functions, 'deleteClientUser')
      await deleteFn({ uid: confirmDeleteUser.id })
      setConfirmDeleteUser(null)
    } catch (err: any) {
      console.error('Delete user error:', err)
      alert('Error al eliminar: ' + (err.message || String(err)))
    }
    setDeletingUser(false)
  }

  async function toggleUserModule(userId: string, currentAccess: ModuleAccess[], mod: ModuleAccess) {
    const has = currentAccess.includes(mod)
    const newAccess = has ? currentAccess.filter(m => m !== mod) : [...currentAccess, mod]
    if (newAccess.length === 0) { alert('User must have at least one module.'); return }
    try {
      await updateDoc(doc(db, 'user_roles', userId), { module_access: newAccess })
    } catch (err) { console.error(err) }
  }

  // Quick-assign orphan user to a client
  async function assignUserToClient(userId: string, clientId: string) {
    try {
      await updateDoc(doc(db, 'user_roles', userId), { client_id: clientId })
    } catch (err) { console.error(err) }
  }

  // ── Billing helpers ────────────────────────────────────────────────────

  function setBilling(patch: Partial<AirfreightClientBilling>) {
    if (!editing) return
    setEditing({ ...editing, billing: { ...editing.billing, ...patch } })
  }

  function updateHandlingOverride(i: number, patch: Partial<AirHandlingOverride>) {
    if (!editing) return
    const list = [...(editing.billing?.handling_bup_overrides || [])]
    list[i] = { ...list[i], ...patch }
    setBilling({ handling_bup_overrides: list })
  }
  function addHandlingOverride() {
    setBilling({ handling_bup_overrides: [...(editing?.billing?.handling_bup_overrides || []), { airline: '', rate: 0 }] })
  }
  function removeHandlingOverride(i: number) {
    setBilling({ handling_bup_overrides: (editing?.billing?.handling_bup_overrides || []).filter((_, idx) => idx !== i) })
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  function getUsersForClient(clientId: string) {
    return users.filter(u => u.client_id === clientId)
  }

  const clientIds = new Set(clients.map(c => c.id))
  const orphanUsers = users.filter(u => {
    if (!u.client_id) return true // no client assigned at all
    if (clientIds.has(u.client_id)) return false // linked to airfreight client
    if (seaClientIds.has(u.client_id)) return false // linked to seafreight client — not our problem
    return true // client_id doesn't exist anywhere
  })

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <Layout title="Clientes Airfreight" backTo="/airfreight/admin">
      <div className="max-w-3xl mx-auto space-y-5">
        <div className="flex justify-between items-center">
          <h2 className="font-semibold text-gray-800">Clientes ({clients.length})</h2>
          <div className="flex items-center gap-2">
            <button onClick={() => navigate('/airfreight/shippers-consignees')}
              className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-semibold rounded-lg hover:bg-gray-50 transition-colors">
              Shippers / Consignees
            </button>
            <button onClick={openNew}
              className="px-4 py-2 bg-mcl-blue text-white text-sm font-semibold rounded-lg hover:bg-blue-900 transition-colors">
              + Nuevo cliente
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-10"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" /></div>
        ) : (
          <div className="space-y-3">
            {clients.map(client => {
              const clientUsers = getUsersForClient(client.id)
              return (
                <div key={client.id} className={`bg-white rounded-xl border shadow-sm ${!client.active ? 'opacity-60 border-gray-100' : 'border-gray-200'}`}>
                  {/* Client header */}
                  <div className="p-5">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-semibold text-gray-800">{client.name}</h3>
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${client.booking_type === 'mawb' ? 'bg-purple-100 text-purple-700' : client.booking_type === 'ecommerce' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
                            {client.booking_type === 'mawb' ? 'MAWB' : client.booking_type === 'ecommerce' ? 'Ecommerce' : 'Simple'}
                          </span>
                          {client.transportation_enabled && (
                            <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-teal-100 text-teal-700">Transport</span>
                          )}
                          {!client.active && <span className="text-xs text-gray-400">Inactivo</span>}
                        </div>
                        <p className="text-xs text-gray-500">{client.contacts.length} contacto{client.contacts.length !== 1 ? 's' : ''}</p>
                        {client.notify_emails.length > 0 && (
                          <p className="text-xs text-gray-400 mt-0.5">{client.notify_emails.join(', ')}</p>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => openEdit(client)} className="text-xs text-mcl-blue hover:underline">Editar</button>
                        <button onClick={() => toggleActive(client)} className="text-xs text-gray-400 hover:text-gray-600 hover:underline">
                          {client.active ? 'Desactivar' : 'Activar'}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Linked user accounts */}
                  <div className="border-t border-gray-100 px-5 py-3 bg-gray-50/50 rounded-b-xl">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Cuentas de acceso</span>
                      <button onClick={() => openCreateUser(client.id)}
                        className="text-xs text-mcl-blue hover:underline font-medium">
                        + Crear cuenta
                      </button>
                    </div>
                    {clientUsers.length === 0 ? (
                      <p className="text-xs text-gray-400">Sin cuentas vinculadas</p>
                    ) : (
                      <div className="space-y-1.5">
                        {clientUsers.map(u => (
                          <div key={u.id} className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
                              <span className="text-sm text-gray-700 truncate">{u.name || u.email}</span>
                              <span className="text-xs text-gray-400 truncate hidden sm:inline">{u.email}</span>
                              {u.role === 'viewer' && (
                                <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide">
                                  Viewer
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              {(['airfreight', 'seafreight', 'warehouse_services'] as const).map(m => {
                                const active = u.module_access.includes(m)
                                const label = m === 'seafreight' ? 'SEA' : m === 'airfreight' ? 'AIR' : 'WS'
                                return (
                                  <button
                                    key={m}
                                    onClick={() => toggleUserModule(u.id, u.module_access, m)}
                                    className={`text-[10px] px-1.5 py-0.5 rounded font-semibold cursor-pointer transition-colors ${
                                      active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-400 line-through'
                                    }`}
                                    title={active ? `Disable ${label}` : `Enable ${label}`}
                                  >
                                    {label}
                                  </button>
                                )
                              })}
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

            {/* Orphan users — client accounts without a valid client link */}
            {orphanUsers.length > 0 && (
              <div className="bg-amber-50 rounded-xl border border-amber-200 shadow-sm p-5">
                <h3 className="text-sm font-semibold text-amber-800 mb-1">Cuentas sin cliente vinculado</h3>
                <p className="text-xs text-amber-600 mb-3">Estas cuentas de cliente no estan asociadas a ningun cliente. Asignalas o eliminalas.</p>
                <div className="space-y-2">
                  {orphanUsers.map(u => (
                    <div key={u.id} className="flex items-center justify-between gap-3 bg-white rounded-lg border border-amber-100 px-4 py-2.5">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-gray-800 truncate">{u.name || u.email}</div>
                        <div className="text-xs text-gray-400 truncate">{u.email}{u.client_id ? ` (client_id: ${u.client_id})` : ''}</div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <select
                          className="text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-mcl-blue/30"
                          defaultValue=""
                          onChange={e => { if (e.target.value) assignUserToClient(u.id, e.target.value) }}>
                          <option value="">Asignar a...</option>
                          {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                        <button onClick={() => openEditUser(u)}
                          className="text-xs text-mcl-blue hover:underline">Editar</button>
                        <button onClick={() => setConfirmDeleteUser(u)}
                          className="text-xs text-red-500 hover:underline">Eliminar</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Edit/Create Client Modal ── */}
      {editing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="p-6 space-y-4">
              <h3 className="text-lg font-semibold text-gray-800">{editing.id ? 'Editar cliente' : 'Nuevo cliente'}</h3>

              {error && <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700">{error}</div>}

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Nombre *</label>
                <input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="Nombre del cliente" />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Tipo de booking</label>
                <div className="flex gap-3 flex-wrap">
                  {([['simple', 'Simple (AWB)'], ['mawb', 'MAWB'], ['ecommerce', 'Ecommerce w/o MAWB']] as const).map(([t, label]) => (
                    <label key={t} className="flex items-center gap-2 cursor-pointer">
                      <input type="radio" checked={editing.booking_type === t}
                        onChange={() => setEditing({ ...editing, booking_type: t as 'simple' | 'mawb' | 'ecommerce' })} />
                      <span className="text-sm text-gray-700">{label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={editing.transportation_enabled || false}
                    onChange={e => setEditing({ ...editing, transportation_enabled: e.target.checked })} />
                  <span className="text-sm text-gray-700">Transportation enabled</span>
                </label>
              </div>

              {/* ── CCSSSP Info ── */}
              <div className="border border-gray-200 rounded-xl p-4 space-y-3">
                <h4 className="text-sm font-semibold text-gray-700">CCSSSP (Security Program)</h4>
                <p className="text-[10px] text-gray-400">Datos para generar el documento CCSSSP del cliente. Dejar vacio si no aplica.</p>
                <div className="grid grid-cols-2 gap-3">
                  <input placeholder="Nombre header (ej: EXPRESS LINE CORPORATION)" value={editing.ccsssp_company_name || ''} onChange={e => setEditing({ ...editing, ccsssp_company_name: e.target.value })} className="col-span-2 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                  <input placeholder="Nombre en texto (ej: EXPRESS LINE CORP.)" value={editing.ccsssp_short_name || ''} onChange={e => setEditing({ ...editing, ccsssp_short_name: e.target.value })} className="col-span-2 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                  <input placeholder="TSA # (ej: WP9403041)" value={editing.ccsssp_tsa_number || ''} onChange={e => setEditing({ ...editing, ccsssp_tsa_number: e.target.value })} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                  <input placeholder="Direccion" value={editing.ccsssp_address || ''} onChange={e => setEditing({ ...editing, ccsssp_address: e.target.value })} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                  <input placeholder="Telefono" value={editing.ccsssp_phone || ''} onChange={e => setEditing({ ...editing, ccsssp_phone: e.target.value })} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                  <input placeholder="Email" value={editing.ccsssp_email || ''} onChange={e => setEditing({ ...editing, ccsssp_email: e.target.value })} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                  <input placeholder="Logo izquierdo URL (Firebase Storage)" value={editing.ccsssp_logo_url || ''} onChange={e => setEditing({ ...editing, ccsssp_logo_url: e.target.value })} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                  <input placeholder="Logo derecho URL (ej: C-TPAT)" value={editing.ccsssp_logo_right_url || ''} onChange={e => setEditing({ ...editing, ccsssp_logo_right_url: e.target.value })} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                  <select value={editing.ccsssp_format || ''} onChange={e => setEditing({ ...editing, ccsssp_format: e.target.value })} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-600">
                    <option value="">Formato: Express Line (default)</option>
                    <option value="merflex">Formato: Merflex</option>
                  </select>
                  <input placeholder="Representante fijo (ej: Carlos Villegas)" value={editing.ccsssp_rep_name || ''} onChange={e => setEditing({ ...editing, ccsssp_rep_name: e.target.value })} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                  <input placeholder="Firma URL (Firebase Storage)" value={editing.ccsssp_signature_url || ''} onChange={e => setEditing({ ...editing, ccsssp_signature_url: e.target.value })} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                </div>
              </div>

              {/* ── Billing Info ── */}
              <div className="border border-gray-200 rounded-xl p-4 space-y-3">
                <h4 className="text-sm font-semibold text-gray-700">Facturacion</h4>
                <div className="grid grid-cols-2 gap-3">
                  <input placeholder="Razon social" value={editing.billing?.company_legal_name || ''} onChange={e => setBilling({ company_legal_name: e.target.value })} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                  <input placeholder="Account #" value={editing.billing?.account_number || ''} onChange={e => setBilling({ account_number: e.target.value })} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                  <input placeholder="Direccion" value={editing.billing?.billing_address || ''} onChange={e => setBilling({ billing_address: e.target.value })} className="col-span-2 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                  <input placeholder="Tax ID" value={editing.billing?.tax_id || ''} onChange={e => setBilling({ tax_id: e.target.value })} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-1">Plazo de pago (dias)</label>
                    <input type="number" placeholder="15" value={editing.billing?.payment_terms_days || ''} onChange={e => setBilling({ payment_terms_days: Number(e.target.value), payment_terms_label: `N${e.target.value}` })} className="w-24 border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                    {(editing.billing?.payment_terms_days || 0) > 0 && <span className="ml-2 text-xs text-gray-400">→ {editing.billing?.payment_terms_label}</span>}
                  </div>
                </div>
              </div>

              {/* ── Auto Charges ── */}
              <div className="border border-gray-200 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-gray-700">Auto Charges</h4>
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="checkbox" checked={editing.billing?.auto_charges_enabled || false} onChange={e => setBilling({ auto_charges_enabled: e.target.checked })} className="rounded" />
                    Habilitado
                  </label>
                </div>

                {editing.billing?.auto_charges_enabled && (
                  <>
                    {/* ALL-IN: Handling BUP + Screening + Drop Off BUP */}
                    <div className="bg-blue-50 rounded-lg p-3 space-y-2">
                      <h5 className="text-xs font-semibold text-blue-800">ALL-IN (Handling BUP + Screening + Drop Off BUP)</h5>
                      <p className="text-[10px] text-blue-600">Aplica cuando deliver to = airline. Se muestra como una sola linea en factura.</p>
                      <div>
                        <label className="flex items-center gap-2 text-xs text-gray-600 mb-1 cursor-pointer">
                          <input type="checkbox" checked={(editing.billing?.all_in_flat_rate ?? null) !== null && (editing.billing?.all_in_flat_rate ?? 0) > 0} onChange={e => setBilling({ all_in_flat_rate: e.target.checked ? 0.17 : null })} className="rounded" />
                          Tarifa plana (mismo rate para todo)
                        </label>
                      </div>

                      {(editing.billing?.all_in_flat_rate ?? null) !== null && (editing.billing?.all_in_flat_rate ?? 0) >= 0 ? (
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">Rate plano ($/kg)</label>
                          <input type="number" step="0.01" value={editing.billing?.all_in_flat_rate || 0} onChange={e => setBilling({ all_in_flat_rate: Number(e.target.value) })} className="w-32 border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                        </div>
                      ) : (
                        <>
                          <div className="grid grid-cols-3 gap-2">
                            <div><label className="block text-[10px] text-gray-500">Handling BUP ($/kg)</label><input type="number" step="0.001" value={editing.billing?.handling_bup_rate || ''} onChange={e => setBilling({ handling_bup_rate: Number(e.target.value) })} className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm" /></div>
                            <div><label className="block text-[10px] text-gray-500">Screening ($/kg)</label><input type="number" step="0.001" value={editing.billing?.screening_rate || ''} onChange={e => setBilling({ screening_rate: Number(e.target.value) })} className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm" /></div>
                            <div><label className="block text-[10px] text-gray-500">Drop Off BUP ($/kg)</label><input type="number" step="0.001" value={editing.billing?.drop_off_bup_rate || ''} onChange={e => setBilling({ drop_off_bup_rate: Number(e.target.value) })} className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm" /></div>
                          </div>
                          {/* Airline overrides for Handling BUP */}
                          <div>
                            <div className="flex items-center justify-between mt-1">
                              <span className="text-[10px] font-semibold text-gray-500">Handling BUP overrides por aerolinea</span>
                              <button type="button" onClick={addHandlingOverride} className="text-[10px] text-mcl-blue hover:underline">+ Agregar</button>
                            </div>
                            {(editing.billing?.handling_bup_overrides || []).map((ov, i) => (
                              <div key={i} className="flex items-center gap-2 mt-1">
                                <input placeholder="Aerolinea" value={ov.airline} onChange={e => updateHandlingOverride(i, { airline: e.target.value })} className="flex-1 border border-gray-200 rounded px-2 py-1 text-sm" />
                                <input type="number" step="0.001" placeholder="Rate" value={ov.rate || ''} onChange={e => updateHandlingOverride(i, { rate: Number(e.target.value) })} className="w-24 border border-gray-200 rounded px-2 py-1 text-sm" />
                                <button type="button" onClick={() => removeHandlingOverride(i)} className="text-gray-300 hover:text-red-500 text-sm">&times;</button>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>

                    {/* Additional auto charges */}
                    <div className="grid grid-cols-2 gap-2">
                      <div className="bg-gray-50 rounded-lg p-2">
                        <label className="flex items-center gap-2 text-xs font-medium text-gray-700 cursor-pointer">
                          <input type="checkbox" checked={editing.billing?.handling_loose_enabled || false} onChange={e => setBilling({ handling_loose_enabled: e.target.checked })} className="rounded" />
                          Handling Loose
                        </label>
                        <p className="text-[10px] text-gray-400">Deliver to address ($/kg)</p>
                        {editing.billing?.handling_loose_enabled && <input type="number" step="0.001" value={editing.billing?.handling_loose_rate || ''} onChange={e => setBilling({ handling_loose_rate: Number(e.target.value) })} className="w-full mt-1 border border-gray-200 rounded px-2 py-1 text-sm" />}
                      </div>
                      <div className="bg-gray-50 rounded-lg p-2">
                        <label className="flex items-center gap-2 text-xs font-medium text-gray-700 cursor-pointer">
                          <input type="checkbox" checked={editing.billing?.drop_off_loose_enabled || false} onChange={e => setBilling({ drop_off_loose_enabled: e.target.checked })} className="rounded" />
                          Drop Off Loose
                        </label>
                        <p className="text-[10px] text-gray-400">Deliver to address ($/kg)</p>
                        {editing.billing?.drop_off_loose_enabled && <input type="number" step="0.001" value={editing.billing?.drop_off_loose_rate || ''} onChange={e => setBilling({ drop_off_loose_rate: Number(e.target.value) })} className="w-full mt-1 border border-gray-200 rounded px-2 py-1 text-sm" />}
                      </div>
                      <div className="bg-gray-50 rounded-lg p-2">
                        <label className="flex items-center gap-2 text-xs font-medium text-gray-700 cursor-pointer">
                          <input type="checkbox" checked={editing.billing?.pickup_loose_enabled || false} onChange={e => setBilling({ pickup_loose_enabled: e.target.checked })} className="rounded" />
                          Pick Up Loose
                        </label>
                        <p className="text-[10px] text-gray-400">LOOSE cargo ($/kg)</p>
                        {editing.billing?.pickup_loose_enabled && <input type="number" step="0.01" value={editing.billing?.pickup_loose_rate || ''} onChange={e => setBilling({ pickup_loose_rate: Number(e.target.value) })} className="w-full mt-1 border border-gray-200 rounded px-2 py-1 text-sm" />}
                      </div>
                      <div className="bg-gray-50 rounded-lg p-2">
                        <label className="flex items-center gap-2 text-xs font-medium text-gray-700 cursor-pointer">
                          <input type="checkbox" checked={editing.billing?.bup_pickup_enabled || false} onChange={e => setBilling({ bup_pickup_enabled: e.target.checked })} className="rounded" />
                          BUP Pick Up
                        </label>
                        <p className="text-[10px] text-gray-400">BUP cargo — flat ($)</p>
                        {editing.billing?.bup_pickup_enabled && <input type="number" step="0.01" value={editing.billing?.bup_pickup_rate || ''} onChange={e => setBilling({ bup_pickup_rate: Number(e.target.value) })} className="w-full mt-1 border border-gray-200 rounded px-2 py-1 text-sm" />}
                      </div>
                      <div className="bg-gray-50 rounded-lg p-2">
                        <label className="flex items-center gap-2 text-xs font-medium text-gray-700 cursor-pointer">
                          <input type="checkbox" checked={editing.billing?.breakdown_enabled || false} onChange={e => setBilling({ breakdown_enabled: e.target.checked })} className="rounded" />
                          Breakdown
                        </label>
                        <p className="text-[10px] text-gray-400">BUP cargo ($/kg)</p>
                        {editing.billing?.breakdown_enabled && <input type="number" step="0.01" value={editing.billing?.breakdown_rate || ''} onChange={e => setBilling({ breakdown_rate: Number(e.target.value) })} className="w-full mt-1 border border-gray-200 rounded px-2 py-1 text-sm" />}
                      </div>
                      <div className="bg-gray-50 rounded-lg p-2">
                        <label className="flex items-center gap-2 text-xs font-medium text-gray-700 cursor-pointer">
                          <input type="checkbox" checked={editing.billing?.wooden_pallets_enabled || false} onChange={e => setBilling({ wooden_pallets_enabled: e.target.checked })} className="rounded" />
                          Wooden Pallets
                        </label>
                        <p className="text-[10px] text-gray-400">LOOSE — ROUND(PCs/16) x rate ($)</p>
                        {editing.billing?.wooden_pallets_enabled && <input type="number" step="0.01" value={editing.billing?.wooden_pallet_rate || ''} onChange={e => setBilling({ wooden_pallet_rate: Number(e.target.value) })} className="w-full mt-1 border border-gray-200 rounded px-2 py-1 text-sm" />}
                      </div>
                    </div>

                    {/* Build Up Wooden Pallets */}
                    <div className="bg-gray-50 rounded-lg p-2">
                      <label className="flex items-center gap-2 text-xs font-medium text-gray-700 cursor-pointer">
                        <input type="checkbox" checked={editing.billing?.buildup_wp_enabled || false} onChange={e => setBilling({ buildup_wp_enabled: e.target.checked })} className="rounded" />
                        Build Up Wooden Pallets
                      </label>
                      <p className="text-[10px] text-gray-400">ROUND(CW / divisor x mult) x rate — solo aerolíneas</p>
                      {editing.billing?.buildup_wp_enabled && (
                        <div className="flex flex-col gap-1 mt-1">
                          <div className="flex gap-2">
                            <div className="flex flex-col">
                              <span className="text-[9px] text-gray-400">Rate ($)</span>
                              <input type="number" step="0.01" placeholder="5" value={editing.billing?.buildup_wp_rate || ''} onChange={e => setBilling({ buildup_wp_rate: Number(e.target.value) })} className="w-20 border border-gray-200 rounded px-2 py-1 text-sm" />
                            </div>
                            <div className="flex flex-col">
                              <span className="text-[9px] text-gray-400">Divisor</span>
                              <input type="number" step="1" placeholder="1500" value={editing.billing?.buildup_wp_divisor || ''} onChange={e => setBilling({ buildup_wp_divisor: Number(e.target.value) })} className="w-20 border border-gray-200 rounded px-2 py-1 text-sm" />
                            </div>
                            <div className="flex flex-col">
                              <span className="text-[9px] text-gray-400">Mult</span>
                              <input type="number" step="1" placeholder="4" value={editing.billing?.buildup_wp_multiplier || ''} onChange={e => setBilling({ buildup_wp_multiplier: Number(e.target.value) })} className="w-16 border border-gray-200 rounded px-2 py-1 text-sm" />
                            </div>
                          </div>
                          <input placeholder="Airlines (coma)" value={(editing.billing?.buildup_wp_airlines || []).join(', ')} onChange={e => setBilling({ buildup_wp_airlines: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} className="w-full border border-gray-200 rounded px-2 py-1 text-sm" />
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-xs font-medium text-gray-600">Contactos</label>
                  <button type="button" onClick={addContact} className="text-xs text-mcl-blue hover:underline">+ Agregar</button>
                </div>
                {editing.contacts.map((c, idx) => (
                  <div key={idx} className="flex gap-2 mb-2">
                    <input value={c.name} onChange={e => updateContact(idx, 'name', e.target.value)}
                      placeholder="Nombre" className="flex-1 border border-gray-200 rounded px-2 py-1.5 text-sm" />
                    <input value={c.email} onChange={e => updateContact(idx, 'email', e.target.value)}
                      placeholder="Email" type="email" className="flex-1 border border-gray-200 rounded px-2 py-1.5 text-sm" />
                    {editing.contacts.length > 1 && (
                      <button onClick={() => removeContact(idx)} className="text-red-400 hover:text-red-600 text-xs px-1">x</button>
                    )}
                  </div>
                ))}
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Emails de notificacion <span className="text-gray-400">(uno por linea)</span></label>
                <textarea value={editing.notify_emails.join('\n')} onChange={e => updateNotifyEmails(e.target.value)}
                  rows={3} placeholder={"email1@empresa.com\nemail2@empresa.com"}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none" />
              </div>

              <div className="flex gap-3 pt-2">
                <button onClick={() => setEditing(null)}
                  className="flex-1 border border-gray-200 text-gray-600 rounded-lg py-2.5 text-sm font-medium hover:bg-gray-50">
                  Cancelar
                </button>
                <button onClick={handleSave} disabled={saving}
                  className="flex-1 bg-mcl-blue text-white rounded-lg py-2.5 text-sm font-semibold hover:bg-blue-900 disabled:opacity-50">
                  {saving ? 'Guardando...' : 'Guardar'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Create User Account Modal ── */}
      {creatingForClientId && (() => {
        const client = clients.find(c => c.id === creatingForClientId)
        return (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
              <h3 className="text-lg font-semibold text-gray-800">
                Crear cuenta para <span className="text-mcl-blue">{client?.name}</span>
              </h3>

              {createUserError && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700">{createUserError}</div>
              )}

              <form onSubmit={handleCreateUser} className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Nombre *</label>
                  <input value={newName} onChange={e => setNewName(e.target.value)} required
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="Nombre del usuario" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Email *</label>
                  <input type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} required
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="email@empresa.com" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Contraseña temporal *</label>
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

                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Tipo de cuenta *</label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className={`flex items-start gap-2 border rounded-lg px-3 py-2 cursor-pointer transition-colors ${newRole === 'client' ? 'border-mcl-blue bg-blue-50' : 'border-gray-200 hover:border-gray-300'}`}>
                      <input type="radio" checked={newRole === 'client'} onChange={() => setNewRole('client')} className="mt-0.5" />
                      <div>
                        <div className="text-sm font-medium text-gray-800">Cliente</div>
                        <div className="text-[11px] text-gray-500 leading-tight">Puede crear y gestionar bookings</div>
                      </div>
                    </label>
                    <label className={`flex items-start gap-2 border rounded-lg px-3 py-2 cursor-pointer transition-colors ${newRole === 'viewer' ? 'border-amber-500 bg-amber-50' : 'border-gray-200 hover:border-gray-300'}`}>
                      <input type="radio" checked={newRole === 'viewer'} onChange={() => setNewRole('viewer')} className="mt-0.5" />
                      <div>
                        <div className="text-sm font-medium text-gray-800">Viewer</div>
                        <div className="text-[11px] text-gray-500 leading-tight">Solo lectura: dashboard y docs</div>
                      </div>
                    </label>
                  </div>
                </div>

                <div className="flex gap-3 pt-2">
                  <button type="button" onClick={() => setCreatingForClientId(null)}
                    className="flex-1 border border-gray-200 text-gray-600 rounded-lg py-2.5 text-sm hover:bg-gray-50">
                    Cancelar
                  </button>
                  <button type="submit" disabled={creatingUser}
                    className="flex-1 bg-mcl-blue text-white rounded-lg py-2.5 text-sm font-semibold hover:bg-blue-900 disabled:opacity-50">
                    {creatingUser ? 'Creando...' : 'Crear cuenta'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )
      })()}

      {/* ── Edit User Modal ── */}
      {editingUser && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <h3 className="text-lg font-semibold text-gray-800">Editar usuario</h3>
            <p className="text-xs text-gray-400">{editingUser.email}</p>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Nombre</label>
              <input value={editUserName} onChange={e => setEditUserName(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Cliente vinculado</label>
              <select value={editUserClientId} onChange={e => setEditUserClientId(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm">
                <option value="">— Sin vincular —</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>

            <div className="flex gap-3 pt-2">
              <button onClick={() => setEditingUser(null)}
                className="flex-1 border border-gray-200 text-gray-600 rounded-lg py-2.5 text-sm hover:bg-gray-50">
                Cancelar
              </button>
              <button onClick={handleSaveUser} disabled={savingUser}
                className="flex-1 bg-mcl-blue text-white rounded-lg py-2.5 text-sm font-semibold hover:bg-blue-900 disabled:opacity-50">
                {savingUser ? 'Guardando...' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete User Confirm ── */}
      {confirmDeleteUser && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4">
            <h3 className="font-semibold text-gray-800">Eliminar cuenta</h3>
            <p className="text-sm text-gray-500">
              Eliminar la cuenta de <span className="font-medium text-gray-700">{confirmDeleteUser.name || confirmDeleteUser.email}</span>?
            </p>
            <p className="text-xs text-gray-400">
              Esto elimina el registro en user_roles. El usuario perdera acceso a TODO el sistema (seafreight y airfreight).
            </p>
            <div className="flex gap-3">
              <button onClick={() => setConfirmDeleteUser(null)} disabled={deletingUser}
                className="flex-1 border border-gray-200 text-gray-600 rounded-lg py-2.5 text-sm hover:bg-gray-50">
                Cancelar
              </button>
              <button onClick={handleDeleteUser} disabled={deletingUser}
                className="flex-1 bg-red-600 text-white rounded-lg py-2.5 text-sm font-semibold hover:bg-red-700 disabled:opacity-50">
                {deletingUser ? 'Eliminando...' : 'Eliminar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}
