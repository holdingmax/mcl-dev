import { useState, useEffect } from 'react'
import { collection, getDocs, doc, updateDoc, setDoc, getDoc } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import { UserRole } from '../../types'
import Layout from '../../components/Layout'

interface MclUser {
  uid: string
  email: string
  name?: string
  role: UserRole
}

interface RoleAssignment {
  email: string
  role: UserRole
  // Merged from user_roles if user has logged in
  uid?: string
  name?: string
  active?: boolean
}

const MCL_ROLES: { value: UserRole; label: string; description: string }[] = [
  { value: 'admin', label: 'Admin', description: 'Acceso completo a todo el sistema' },
  { value: 'gerente', label: 'Gerente', description: 'Acceso completo excepto asignar roles (Perfiles MCL) y editar Rates' },
  { value: 'accounting', label: 'Accounting', description: 'Full acceso a Rates, solo lectura en el resto' },
  { value: 'agent', label: 'Agente', description: 'Acceso completo excepto Rates y Perfiles MCL' },
  { value: 'distribuidor', label: 'Distribuidor', description: 'Acceso a Build Up, DOs y visualizacion de recepciones' },
  { value: 'soporte_it', label: 'Soporte IT', description: 'Visualizacion completa del sistema, sin edicion' },
]

const CONFIG_DOC = 'config/mcl_roles'

export default function AirfreightMclProfiles() {
  const { isAdmin, isSoporteIT, userRole } = useAuth()
  const [assignments, setAssignments] = useState<RoleAssignment[]>([])
  const [defaultRole, setDefaultRole] = useState<UserRole>('agent')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)

  // Add override form
  const [showAdd, setShowAdd] = useState(false)
  const [addEmail, setAddEmail] = useState('')
  const [addRole, setAddRole] = useState<UserRole>('agent')
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    async function load() {
      // Load config doc
      const configSnap = await getDoc(doc(db, CONFIG_DOC))
      let configAssignments: Record<string, UserRole> = {}
      let cfgDefault: UserRole = 'agent'

      if (configSnap.exists()) {
        const data = configSnap.data()
        configAssignments = data.assignments || {}
        cfgDefault = data.default_role || 'agent'
      } else {
        // Seed default config
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

      // Load active MCL users from user_roles
      const snap = await getDocs(collection(db, 'user_roles'))
      const activeUsers: MclUser[] = []
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

      // Merge: config assignments + active users
      const merged: RoleAssignment[] = []
      const seen = new Set<string>()

      // First add all config assignments
      for (const [email, role] of Object.entries(configAssignments)) {
        const active = activeUsers.find(u => u.email === email)
        merged.push({
          email,
          role,
          uid: active?.uid,
          name: active?.name,
          active: !!active,
        })
        seen.add(email)
      }

      // Then add any active users NOT in config (auto-include them)
      for (const u of activeUsers) {
        if (!seen.has(u.email)) {
          merged.push({
            email: u.email,
            role: u.role,
            uid: u.uid,
            name: u.name,
            active: true,
          })
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

      // If user is active, also update their user_roles doc
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
    if (!confirm(`Eliminar la asignacion especifica de ${email}? Si el usuario ya tiene cuenta, pasara a usar el perfil por defecto (${MCL_ROLES.find(r => r.value === defaultRole)?.label}).`)) return
    setSaving(email)
    try {
      const updated = assignments.filter(a => a.email !== email)
      await saveConfig(updated, defaultRole)

      // If user is active, update their user_roles to default
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

  if (userRole !== 'admin' && !isSoporteIT) return null

  if (loading) {
    return (
      <Layout title="Perfiles MCL" backTo="/airfreight/admin">
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" />
        </div>
      </Layout>
    )
  }

  return (
    <Layout title="Perfiles MCL" backTo="/airfreight/admin">
      <div className="max-w-3xl mx-auto space-y-4">
        <p className="text-sm text-gray-500">Configurar perfiles de acceso para el equipo MinCurl Logistics</p>

        {/* Role descriptions */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {MCL_ROLES.map(r => (
            <div key={r.value} className="bg-white rounded-xl border border-gray-200 p-4">
              <h4 className="font-semibold text-sm text-gray-800 mb-1">{r.label}</h4>
              <p className="text-xs text-gray-400">{r.description}</p>
            </div>
          ))}
        </div>

        {/* Action button */}
        {!showAdd && (
          <button
            onClick={() => setShowAdd(true)}
            className="px-4 py-2 bg-mcl-blue text-white text-xs font-semibold rounded-lg hover:bg-blue-900 transition-colors"
          >
            + Asignar perfil a email
          </button>
        )}

        {/* Add override form */}
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
              <div className="w-36">
                <label className="block text-xs font-medium text-gray-600 mb-1">Perfil</label>
                <select
                  value={addRole}
                  onChange={e => setAddRole(e.target.value as UserRole)}
                  className="w-full px-3 py-2 text-xs border rounded-lg bg-white"
                >
                  {MCL_ROLES.map(r => (
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
                        value={MCL_ROLES.some(r => r.value === a.role) ? a.role : 'agent'}
                        onChange={e => handleChangeRole(a.email, e.target.value as UserRole)}
                        disabled={saving === a.email}
                        className="px-3 py-1.5 text-xs border border-gray-300 rounded-lg bg-white cursor-pointer disabled:opacity-50 focus:ring-2 focus:ring-mcl-blue/30"
                      >
                        {MCL_ROLES.map(r => (
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
                      {MCL_ROLES.map(r => (
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

        <p className="text-[11px] text-gray-400">
          Los perfiles configurados aqui se aplican cuando un usuario de MCL inicia sesion por primera vez.
          Si el usuario ya tiene sesion activa, el cambio se aplica de inmediato.
        </p>
      </div>
    </Layout>
  )
}
