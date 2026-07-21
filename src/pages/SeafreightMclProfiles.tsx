import { useState, useEffect } from 'react'
import { collection, getDocs, doc, updateDoc, setDoc, getDoc } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from '../contexts/AuthContext'
import { UserRole } from '../types'
import Layout from '../components/Layout'

interface RoleAssignment {
  email: string
  role: UserRole
  uid?: string
  name?: string
  active?: boolean
}

const SEA_ROLES: { value: UserRole; label: string; color: string; description: string }[] = [
  { value: 'admin', label: 'Admin', color: 'bg-red-100 text-red-700', description: 'Control total del sistema. Gestiona usuarios, roles, billing y operaciones.' },
  { value: 'gerente', label: 'Gerente', color: 'bg-amber-100 text-amber-700', description: 'Acceso completo excepto asignar roles (Perfiles MCL) y editar Rates.' },
  { value: 'accounting', label: 'Accounting', color: 'bg-purple-100 text-purple-700', description: 'Todo lo financiero (rates, charges, perfiles facturacion). Ve operaciones sin modificar.' },
  { value: 'super_agent', label: 'Super Agent', color: 'bg-blue-100 text-blue-700', description: 'Operador senior. Todo lo operacional + editar WR + eliminar consolidado. No accede a billing.' },
  { value: 'agent', label: 'Agent', color: 'bg-green-100 text-green-700', description: 'Operador estandar. Counter, consolidado, gate out, inventario.' },
  { value: 'counter', label: 'Counter', color: 'bg-orange-100 text-orange-700', description: 'Solo crear recepciones en counter. Personal de mostrador.' },
]

const CONFIG_DOC = 'config/mcl_roles'

export default function SeafreightMclProfiles() {
  const { isAdmin, userRole } = useAuth()
  const [assignments, setAssignments] = useState<RoleAssignment[]>([])
  const [defaultRole, setDefaultRole] = useState<UserRole>('agent')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)

  const [showAdd, setShowAdd] = useState(false)
  const [addEmail, setAddEmail] = useState('')
  const [addRole, setAddRole] = useState<UserRole>('agent')
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    async function load() {
      const configSnap = await getDoc(doc(db, CONFIG_DOC))
      let configAssignments: Record<string, UserRole> = {}
      let cfgDefault: UserRole = 'agent'

      if (configSnap.exists()) {
        const data = configSnap.data()
        configAssignments = data.assignments || {}
        cfgDefault = data.default_role || 'agent'
      } else {
        configAssignments = {
          'diego.garcia@mincurllogistics.com': 'admin',
          'admin@mincurllogistics.com': 'accounting',
          'finanzas@mincurllogistics.com': 'accounting',
        }
        await setDoc(doc(db, CONFIG_DOC), {
          assignments: configAssignments,
          default_role: 'agent',
        })
      }

      const snap = await getDocs(collection(db, 'user_roles'))
      const activeUsers: { uid: string; email: string; name?: string; role: UserRole }[] = []
      snap.docs.forEach(d => {
        const data = d.data()
        const email = data.email || ''
        if (email.endsWith('@mincurllogistics.com')) {
          activeUsers.push({
            uid: d.id,
            email,
            name: data.name || '',
            role: data.role || 'agent',
          })
        }
      })

      const merged: RoleAssignment[] = []
      const seen = new Set<string>()

      for (const [email, role] of Object.entries(configAssignments)) {
        const active = activeUsers.find(u => u.email === email)
        merged.push({ email, role, uid: active?.uid, name: active?.name, active: !!active })
        seen.add(email)
      }

      for (const u of activeUsers) {
        if (!seen.has(u.email)) {
          merged.push({ email: u.email, role: u.role, uid: u.uid, name: u.name, active: true })
        }
      }

      merged.sort((a, b) => a.email.localeCompare(b.email))
      setAssignments(merged)
      setDefaultRole(cfgDefault)
      setLoading(false)
    }
    load()
  }, [])

  async function saveConfig(newAssignments: RoleAssignment[], newDefault: UserRole) {
    const assignMap: Record<string, UserRole> = {}
    for (const a of newAssignments) {
      assignMap[a.email] = a.role
    }
    await setDoc(doc(db, CONFIG_DOC), {
      assignments: assignMap,
      default_role: newDefault,
    })
  }

  async function handleChangeRole(email: string, newRole: UserRole) {
    setSaving(email)
    try {
      const updated = assignments.map(a => a.email === email ? { ...a, role: newRole } : a)
      await saveConfig(updated, defaultRole)
      const target = assignments.find(a => a.email === email)
      if (target?.uid) {
        await updateDoc(doc(db, 'user_roles', target.uid), { role: newRole })
      }
      setAssignments(updated)
    } catch (err) {
      console.error('Error updating role:', err)
      alert('Error al actualizar el perfil')
    } finally {
      setSaving(null)
    }
  }

  async function handleChangeDefault(newDefault: UserRole) {
    setSaving('__default__')
    try {
      await saveConfig(assignments, newDefault)
      setDefaultRole(newDefault)
    } catch (err) {
      console.error('Error updating default:', err)
      alert('Error al actualizar el perfil por defecto')
    } finally {
      setSaving(null)
    }
  }

  async function handleAddOverride(e: React.FormEvent) {
    e.preventDefault()
    const email = addEmail.trim().toLowerCase()
    if (!email.endsWith('@mincurllogistics.com')) {
      alert('El email debe ser @mincurllogistics.com')
      return
    }
    if (assignments.some(a => a.email === email)) {
      alert('Este email ya existe en la lista')
      return
    }
    setAdding(true)
    try {
      const newEntry: RoleAssignment = { email, role: addRole, active: false }
      const updated = [...assignments, newEntry].sort((a, b) => a.email.localeCompare(b.email))
      await saveConfig(updated, defaultRole)
      setAssignments(updated)
      setShowAdd(false)
      setAddEmail('')
      setAddRole('agent')
    } catch (err) {
      console.error('Error adding override:', err)
      alert('Error al agregar')
    } finally {
      setAdding(false)
    }
  }

  async function handleRemoveOverride(email: string) {
    const defaultLabel = SEA_ROLES.find(r => r.value === defaultRole)?.label || defaultRole
    if (!confirm(`Eliminar la asignacion de ${email}? Pasara al perfil por defecto (${defaultLabel}).`)) return
    setSaving(email)
    try {
      const updated = assignments.filter(a => a.email !== email)
      await saveConfig(updated, defaultRole)
      const target = assignments.find(a => a.email === email)
      if (target?.uid) {
        await updateDoc(doc(db, 'user_roles', target.uid), { role: defaultRole })
      }
      setAssignments(updated)
    } catch (err) {
      console.error('Error removing override:', err)
      alert('Error al eliminar')
    } finally {
      setSaving(null)
    }
  }

  function getRoleBadge(role: UserRole) {
    const r = SEA_ROLES.find(sr => sr.value === role)
    if (!r) return <span className="text-xs text-gray-400">{role}</span>
    return <span className={`inline-block px-2 py-0.5 text-[10px] font-semibold rounded-full ${r.color}`}>{r.label}</span>
  }

  if (userRole !== 'admin') return null

  if (loading) {
    return (
      <Layout title="Perfiles MCL — Sea Freight" backTo="/billing">
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" />
        </div>
      </Layout>
    )
  }

  return (
    <Layout title="Perfiles MCL — Sea Freight" backTo="/billing">
      <div className="max-w-4xl mx-auto space-y-5">
        <p className="text-sm text-gray-500">Configurar perfiles de acceso para el equipo MinCurl Logistics en Sea Freight</p>

        {/* Role cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {SEA_ROLES.map(r => (
            <div key={r.value} className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="flex items-center gap-2 mb-1">
                <span className={`inline-block px-2 py-0.5 text-[10px] font-semibold rounded-full ${r.color}`}>{r.label}</span>
              </div>
              <p className="text-xs text-gray-400 leading-relaxed">{r.description}</p>
            </div>
          ))}
        </div>

        {/* Add button */}
        {!showAdd && (
          <button
            onClick={() => setShowAdd(true)}
            className="px-4 py-2 bg-mcl-blue text-white text-xs font-semibold rounded-lg hover:bg-blue-900 transition-colors"
          >
            + Asignar perfil a email
          </button>
        )}

        {/* Add form */}
        {showAdd && (
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
            <h4 className="text-sm font-semibold text-blue-800 mb-3">Asignar perfil a email especifico</h4>
            <form onSubmit={handleAddOverride} className="flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-[200px]">
                <label className="block text-xs font-medium text-gray-600 mb-1">Email</label>
                <input
                  type="email"
                  value={addEmail}
                  onChange={e => setAddEmail(e.target.value)}
                  required
                  placeholder="nombre@mincurllogistics.com"
                  className="w-full px-3 py-2 text-xs border rounded-lg"
                />
              </div>
              <div className="w-40">
                <label className="block text-xs font-medium text-gray-600 mb-1">Perfil</label>
                <select
                  value={addRole}
                  onChange={e => setAddRole(e.target.value as UserRole)}
                  className="w-full px-3 py-2 text-xs border rounded-lg bg-white"
                >
                  {SEA_ROLES.map(r => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={adding}
                  className="px-4 py-2 bg-mcl-blue text-white text-xs font-semibold rounded-lg hover:bg-blue-900 disabled:opacity-50 transition-colors"
                >
                  {adding ? 'Guardando...' : 'Guardar'}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowAdd(false); setAddEmail(''); setAddRole('agent') }}
                  className="px-4 py-2 bg-gray-200 text-gray-600 text-xs font-semibold rounded-lg hover:bg-gray-300 transition-colors"
                >
                  Cancelar
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Assignments table */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-3 text-left">Email</th>
                <th className="px-4 py-3 text-left">Nombre</th>
                <th className="px-4 py-3 text-center">Estado</th>
                <th className="px-4 py-3 text-center">Perfil</th>
                <th className="px-4 py-3 text-center w-10"></th>
              </tr>
            </thead>
            <tbody>
              {assignments.map(a => (
                <tr key={a.email} className="border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-3 text-xs font-mono">{a.email}</td>
                  <td className="px-4 py-3 text-xs">{a.name || '—'}</td>
                  <td className="px-4 py-3 text-center">
                    {a.active ? (
                      <span className="inline-block px-2 py-0.5 text-[10px] font-semibold bg-green-100 text-green-700 rounded-full">Activo</span>
                    ) : (
                      <span className="inline-block px-2 py-0.5 text-[10px] font-semibold bg-gray-100 text-gray-400 rounded-full">Sin login</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="flex items-center justify-center gap-2">
                      <select
                        value={SEA_ROLES.some(r => r.value === a.role) ? a.role : 'agent'}
                        onChange={e => handleChangeRole(a.email, e.target.value as UserRole)}
                        disabled={saving === a.email}
                        className="px-3 py-1.5 text-xs border border-gray-300 rounded-lg bg-white cursor-pointer disabled:opacity-50 focus:ring-2 focus:ring-mcl-blue/30"
                      >
                        {SEA_ROLES.map(r => (
                          <option key={r.value} value={r.value}>{r.label}</option>
                        ))}
                      </select>
                      {saving === a.email && (
                        <span className="text-xs text-gray-400">...</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <button
                      onClick={() => handleRemoveOverride(a.email)}
                      className="text-gray-300 hover:text-red-500 transition-colors text-sm"
                      title="Eliminar asignacion"
                    >
                      &times;
                    </button>
                  </td>
                </tr>
              ))}

              {/* Default rule row */}
              <tr className="border-t-2 border-gray-200 bg-gray-50/50">
                <td className="px-4 py-3 text-xs text-gray-500 italic" colSpan={2}>
                  Todos los demas @mincurllogistics.com
                </td>
                <td className="px-4 py-3 text-center">
                  <span className="inline-block px-2 py-0.5 text-[10px] font-semibold bg-blue-50 text-blue-500 rounded-full">Por defecto</span>
                </td>
                <td className="px-4 py-3 text-center">
                  <div className="flex items-center justify-center gap-2">
                    <select
                      value={defaultRole}
                      onChange={e => handleChangeDefault(e.target.value as UserRole)}
                      disabled={saving === '__default__'}
                      className="px-3 py-1.5 text-xs border border-gray-300 rounded-lg bg-white cursor-pointer disabled:opacity-50 focus:ring-2 focus:ring-mcl-blue/30"
                    >
                      {SEA_ROLES.map(r => (
                        <option key={r.value} value={r.value}>{r.label}</option>
                      ))}
                    </select>
                    {saving === '__default__' && (
                      <span className="text-xs text-gray-400">...</span>
                    )}
                  </div>
                </td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Permissions matrix */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-700">Matriz de Permisos</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 text-gray-500 uppercase tracking-wider">
                  <th className="px-3 py-2 text-left font-semibold">Permiso</th>
                  {SEA_ROLES.map(r => (
                    <th key={r.value} className="px-2 py-2 text-center font-semibold">{r.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {[
                  { label: 'Dashboard', perms: [true, true, true, true, false] },
                  { label: 'Counter — crear', perms: [true, false, true, true, true] },
                  { label: 'Recepcion fisica', perms: [true, false, true, true, false] },
                  { label: 'Inventario — ver', perms: [true, true, true, true, false] },
                  { label: 'Inventario — editar', perms: [true, false, true, true, false] },
                  { label: 'WR — ver/imprimir', perms: [true, true, true, true, true] },
                  { label: 'WR — editar', perms: [true, false, true, false, false] },
                  { label: 'Consolidados — ver', perms: [true, true, true, true, false] },
                  { label: 'Consolidado — crear/editar', perms: [true, false, true, true, false] },
                  { label: 'Consolidado — eliminar', perms: [true, false, true, false, false] },
                  { label: 'Gate Out — ver', perms: [true, true, true, true, false] },
                  { label: 'Gate Out — ejecutar', perms: [true, false, true, true, false] },
                  { label: 'Documentos embarque', perms: [true, true, true, true, false] },
                  { label: 'Descargar Excel / imprimir', perms: [true, true, true, true, false] },
                  { label: 'Billing — rates', perms: [true, true, false, false, false] },
                  { label: 'Billing — charges ver', perms: [true, true, false, false, false] },
                  { label: 'Billing — charges editar', perms: [true, true, false, false, false] },
                  { label: 'Billing — perfiles', perms: [true, true, false, false, false] },
                  { label: 'Client Accounts', perms: [true, false, false, false, false] },
                  { label: 'MCL Profiles', perms: [true, false, false, false, false] },
                ].map(row => (
                  <tr key={row.label} className="hover:bg-gray-50/50">
                    <td className="px-3 py-1.5 text-gray-700">{row.label}</td>
                    {row.perms.map((p, i) => (
                      <td key={i} className="px-2 py-1.5 text-center">
                        {p ? (
                          <span className="text-green-500 font-bold">&#10003;</span>
                        ) : (
                          <span className="text-gray-200">—</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <p className="text-[11px] text-gray-400">
          Los perfiles configurados aqui se aplican cuando un usuario de MCL inicia sesion.
          Si el usuario ya tiene sesion activa, el cambio se aplica de inmediato.
          Los roles Viewer y Client se gestionan desde Client Accounts.
        </p>
      </div>
    </Layout>
  )
}
