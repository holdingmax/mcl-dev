import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { doc, getDoc, setDoc, collection, getDocs, query, where, deleteDoc, updateDoc } from 'firebase/firestore'
import { db, createUserWithoutSignIn } from '../../lib/firebase'
import { getAvBillingConfig, saveAvBillingConfig } from '../../lib/avBilling'
import { AV_FEATURES, AV_MCL_ROLES, AV_ROLE_LABELS, DEFAULT_AV_MATRIX, loadAvMatrix, saveAvMatrix, invalidateAvMatrixCache, type AvMatrix, type AvFeatureKey } from '../../lib/avPermissions'
import type { AvBillingConfig, AvBracket, UserRole, ModuleAccess } from '../../types'
import Layout from '../../components/Layout'

type DgKeyword = {
  term: string
  category: string
  severity: 'warning' | 'critical'
  active: boolean
}

const DEFAULT_KEYWORDS: DgKeyword[] = [
  // Explosives
  { term: 'explosives', category: 'Explosives', severity: 'critical', active: true },
  { term: 'explosivos', category: 'Explosives', severity: 'critical', active: true },
  { term: 'detonators', category: 'Explosives', severity: 'critical', active: true },
  { term: 'detonadores', category: 'Explosives', severity: 'critical', active: true },
  { term: 'ammunition', category: 'Explosives', severity: 'critical', active: true },
  { term: 'municiones', category: 'Explosives', severity: 'critical', active: true },
  { term: 'fireworks', category: 'Explosives', severity: 'critical', active: true },
  { term: 'fuegos artificiales', category: 'Explosives', severity: 'critical', active: true },
  { term: 'flares', category: 'Explosives', severity: 'critical', active: true },
  // Gases
  { term: 'compressed gas', category: 'Gases', severity: 'critical', active: true },
  { term: 'gas comprimido', category: 'Gases', severity: 'critical', active: true },
  { term: 'aerosol', category: 'Gases', severity: 'warning', active: true },
  { term: 'propane', category: 'Gases', severity: 'critical', active: true },
  { term: 'propano', category: 'Gases', severity: 'critical', active: true },
  { term: 'butane', category: 'Gases', severity: 'critical', active: true },
  { term: 'butano', category: 'Gases', severity: 'critical', active: true },
  { term: 'fire extinguisher', category: 'Gases', severity: 'warning', active: true },
  { term: 'extintor', category: 'Gases', severity: 'warning', active: true },
  { term: 'refrigerant', category: 'Gases', severity: 'warning', active: true },
  { term: 'refrigerante', category: 'Gases', severity: 'warning', active: true },
  // Flammable Liquids
  { term: 'flammable', category: 'Flammable', severity: 'critical', active: true },
  { term: 'inflamable', category: 'Flammable', severity: 'critical', active: true },
  { term: 'gasoline', category: 'Flammable', severity: 'critical', active: true },
  { term: 'gasolina', category: 'Flammable', severity: 'critical', active: true },
  { term: 'alcohol', category: 'Flammable', severity: 'warning', active: true },
  { term: 'acetone', category: 'Flammable', severity: 'critical', active: true },
  { term: 'acetona', category: 'Flammable', severity: 'critical', active: true },
  { term: 'paint', category: 'Flammable', severity: 'warning', active: true },
  { term: 'pintura', category: 'Flammable', severity: 'warning', active: true },
  { term: 'thinner', category: 'Flammable', severity: 'critical', active: true },
  { term: 'solvent', category: 'Flammable', severity: 'warning', active: true },
  { term: 'solvente', category: 'Flammable', severity: 'warning', active: true },
  { term: 'perfume', category: 'Flammable', severity: 'warning', active: true },
  { term: 'nail polish', category: 'Flammable', severity: 'warning', active: true },
  // Oxidizers
  { term: 'oxidizer', category: 'Oxidizer', severity: 'critical', active: true },
  { term: 'oxidante', category: 'Oxidizer', severity: 'critical', active: true },
  { term: 'peroxide', category: 'Oxidizer', severity: 'critical', active: true },
  { term: 'peroxido', category: 'Oxidizer', severity: 'critical', active: true },
  { term: 'bleach', category: 'Oxidizer', severity: 'warning', active: true },
  { term: 'blanqueador', category: 'Oxidizer', severity: 'warning', active: true },
  // Toxic / Infectious
  { term: 'toxic', category: 'Toxic', severity: 'critical', active: true },
  { term: 'toxico', category: 'Toxic', severity: 'critical', active: true },
  { term: 'poison', category: 'Toxic', severity: 'critical', active: true },
  { term: 'veneno', category: 'Toxic', severity: 'critical', active: true },
  { term: 'pesticide', category: 'Toxic', severity: 'critical', active: true },
  { term: 'pesticida', category: 'Toxic', severity: 'critical', active: true },
  { term: 'insecticide', category: 'Toxic', severity: 'critical', active: true },
  { term: 'insecticida', category: 'Toxic', severity: 'critical', active: true },
  { term: 'infectious', category: 'Toxic', severity: 'critical', active: true },
  { term: 'infeccioso', category: 'Toxic', severity: 'critical', active: true },
  { term: 'biohazard', category: 'Toxic', severity: 'critical', active: true },
  // Radioactive
  { term: 'radioactive', category: 'Radioactive', severity: 'critical', active: true },
  { term: 'radiactivo', category: 'Radioactive', severity: 'critical', active: true },
  { term: 'uranium', category: 'Radioactive', severity: 'critical', active: true },
  { term: 'uranio', category: 'Radioactive', severity: 'critical', active: true },
  // Corrosive
  { term: 'corrosive', category: 'Corrosive', severity: 'critical', active: true },
  { term: 'corrosivo', category: 'Corrosive', severity: 'critical', active: true },
  { term: 'acid', category: 'Corrosive', severity: 'warning', active: true },
  { term: 'acido', category: 'Corrosive', severity: 'warning', active: true },
  { term: 'battery acid', category: 'Corrosive', severity: 'critical', active: true },
  { term: 'mercury', category: 'Corrosive', severity: 'critical', active: true },
  { term: 'mercurio', category: 'Corrosive', severity: 'critical', active: true },
  // Batteries
  { term: 'lithium battery', category: 'Batteries', severity: 'critical', active: true },
  { term: 'bateria de litio', category: 'Batteries', severity: 'critical', active: true },
  { term: 'lithium ion', category: 'Batteries', severity: 'critical', active: true },
  { term: 'lithium metal', category: 'Batteries', severity: 'critical', active: true },
  { term: 'li-ion', category: 'Batteries', severity: 'critical', active: true },
  { term: 'powerbank', category: 'Batteries', severity: 'warning', active: true },
  // Magnetized
  { term: 'magnetized', category: 'Magnetized', severity: 'warning', active: true },
  { term: 'magnetizado', category: 'Magnetized', severity: 'warning', active: true },
  { term: 'magnet', category: 'Magnetized', severity: 'warning', active: true },
  { term: 'iman', category: 'Magnetized', severity: 'warning', active: true },
  // Dry Ice
  { term: 'dry ice', category: 'Dry Ice', severity: 'warning', active: true },
  { term: 'hielo seco', category: 'Dry Ice', severity: 'warning', active: true },
  // Misc DG indicators
  { term: 'UN number', category: 'DG Indicator', severity: 'critical', active: true },
  { term: 'dangerous goods', category: 'DG Indicator', severity: 'critical', active: true },
  { term: 'mercancias peligrosas', category: 'DG Indicator', severity: 'critical', active: true },
  { term: 'hazardous', category: 'DG Indicator', severity: 'critical', active: true },
  { term: 'peligroso', category: 'DG Indicator', severity: 'critical', active: true },
  { term: 'MSDS', category: 'DG Indicator', severity: 'warning', active: true },
  { term: 'SDS', category: 'DG Indicator', severity: 'warning', active: true },
]

export default function AvConfig() {
  const navigate = useNavigate()

  const [keywords, setKeywords] = useState<DgKeyword[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [showDgPanel, setShowDgPanel] = useState(false)
  const [newTerm, setNewTerm] = useState('')
  const [newCategory, setNewCategory] = useState('')
  const [newSeverity, setNewSeverity] = useState<'warning' | 'critical'>('warning')
  const [filterCategory, setFilterCategory] = useState('')

  // Billing config state
  const [showBillingPanel, setShowBillingPanel] = useState(false)
  const [billingConfig, setBillingConfig] = useState<AvBillingConfig | null>(null)
  const [billingLoading, setBillingLoading] = useState(false)
  const [billingSaving, setBillingSaving] = useState(false)
  const [editMode, setEditMode] = useState<'flat' | 'brackets'>('flat')
  const [editFlatRate, setEditFlatRate] = useState('0.20')
  const [editBrackets, setEditBrackets] = useState<AvBracket[]>([])

  // External users (av_viewer) state
  const [showUsersPanel, setShowUsersPanel] = useState(false)
  const [externalUsers, setExternalUsers] = useState<{ uid: string; email: string; name: string; company: string; enabled: boolean; created_at: string }[]>([])
  const [usersLoading, setUsersLoading] = useState(false)
  const [showCreateUser, setShowCreateUser] = useState(false)
  const [newUserEmail, setNewUserEmail] = useState('')
  const [newUserName, setNewUserName] = useState('')
  const [newUserCompany, setNewUserCompany] = useState('')
  const [newUserPassword, setNewUserPassword] = useState('')
  const [creatingUser, setCreatingUser] = useState(false)
  const [userError, setUserError] = useState('')
  const [togglingUid, setTogglingUid] = useState<string | null>(null)

  // Permissions matrix state
  const [showPermissionsPanel, setShowPermissionsPanel] = useState(false)
  const [permMatrix, setPermMatrix] = useState<AvMatrix>({})
  const [permLoading, setPermLoading] = useState(false)
  const [permSaving, setPermSaving] = useState(false)

  // MCL users state
  const [showMclUsersPanel, setShowMclUsersPanel] = useState(false)
  const [mclUsers, setMclUsers] = useState<{ uid: string; email: string; name: string; role: string; av_role: string; module_access: string[]; enabled?: boolean }[]>([])
  const [mclUsersLoading, setMclUsersLoading] = useState(false)
  const [togglingAvUid, setTogglingAvUid] = useState<string | null>(null)

  // Create MCL user for AV
  const [showCreateMcl, setShowCreateMcl] = useState(false)
  const [newMclEmail, setNewMclEmail] = useState('')
  const [newMclName, setNewMclName] = useState('')
  const [newMclRole, setNewMclRole] = useState<string>('agent')
  const [creatingMcl, setCreatingMcl] = useState(false)
  const [mclError, setMclError] = useState('')
  const [editingMclUser, setEditingMclUser] = useState<{ uid: string; name: string; role: string; av_role: string } | null>(null)
  const [editMclRole, setEditMclRole] = useState('')
  const [savingMclEdit, setSavingMclEdit] = useState(false)

  useEffect(() => {
    loadDictionary()
  }, [])

  async function loadDictionary() {
    setLoading(true)
    const snap = await getDoc(doc(db, 'av_dg_dictionary', 'default'))
    if (snap.exists()) {
      setKeywords(snap.data().keywords || [])
    }
    setLoading(false)
  }

  async function loadBillingConfig() {
    setBillingLoading(true)
    const cfg = await getAvBillingConfig()
    setBillingConfig(cfg)
    setEditMode(cfg.mode)
    setEditFlatRate(String(cfg.flat_rate))
    setEditBrackets(cfg.brackets.map(b => ({ ...b })))
    setBillingLoading(false)
  }

  async function saveBillingChanges() {
    setBillingSaving(true)
    const cfg: AvBillingConfig = {
      mode: editMode,
      flat_rate: parseFloat(editFlatRate) || 0.20,
      brackets: editBrackets,
      updated_at: new Date().toISOString(),
      updated_by: '',
    }
    await saveAvBillingConfig(cfg)
    setBillingConfig(cfg)
    setBillingSaving(false)
  }

  function addBracket() {
    const last = editBrackets[editBrackets.length - 1]
    const newMin = last ? last.max_kg : 0
    setEditBrackets([...editBrackets, { min_kg: newMin, max_kg: newMin + 200000, rate_per_kg: 0.18 }])
  }

  function removeBracket(idx: number) {
    setEditBrackets(editBrackets.filter((_, i) => i !== idx))
  }

  function updateBracket(idx: number, field: keyof AvBracket, value: number) {
    setEditBrackets(editBrackets.map((b, i) => i === idx ? { ...b, [field]: value } : b))
  }

  async function saveDictionary(updated: DgKeyword[]) {
    setSaving(true)
    await setDoc(doc(db, 'av_dg_dictionary', 'default'), {
      keywords: updated,
      updated_at: new Date().toISOString(),
    })
    setKeywords(updated)
    setSaving(false)
  }

  async function seedDefaults() {
    await saveDictionary(DEFAULT_KEYWORDS)
  }

  function addKeyword() {
    if (!newTerm.trim() || !newCategory.trim()) return
    const updated = [...keywords, { term: newTerm.trim(), category: newCategory.trim(), severity: newSeverity, active: true }]
    saveDictionary(updated)
    setNewTerm('')
    setNewCategory('')
  }

  function toggleActive(idx: number) {
    const updated = keywords.map((k, i) => i === idx ? { ...k, active: !k.active } : k)
    saveDictionary(updated)
  }

  function removeKeyword(idx: number) {
    const updated = keywords.filter((_, i) => i !== idx)
    saveDictionary(updated)
  }

  // ── External users (av_viewer) management ────────────────────────────
  async function loadExternalUsers() {
    setUsersLoading(true)
    const snap = await getDocs(query(collection(db, 'user_roles'), where('role', '==', 'av_viewer')))
    const users = snap.docs.map(d => {
      const data = d.data()
      return {
        uid: d.id,
        email: data.email || '',
        name: data.name || '',
        company: data.company || '',
        enabled: data.enabled !== false,
        created_at: data.created_at || '',
      }
    }).sort((a, b) => a.name.localeCompare(b.name))
    setExternalUsers(users)
    setUsersLoading(false)
  }

  function validatePassword(pw: string): string | null {
    if (pw.length < 8) return 'Minimo 8 caracteres'
    if (!/[A-Z]/.test(pw)) return 'Debe incluir al menos una mayuscula'
    if (!/[a-z]/.test(pw)) return 'Debe incluir al menos una minuscula'
    if (!/[0-9]/.test(pw)) return 'Debe incluir al menos un numero'
    if (!/[^A-Za-z0-9]/.test(pw)) return 'Debe incluir al menos un simbolo (!@#$%...)'
    return null
  }

  async function createExternalUser() {
    setUserError('')
    if (!newUserEmail.trim() || !newUserName.trim() || !newUserPassword) {
      setUserError('Completa todos los campos obligatorios')
      return
    }
    const pwError = validatePassword(newUserPassword)
    if (pwError) { setUserError(pwError); return }

    setCreatingUser(true)
    try {
      const uid = await createUserWithoutSignIn(newUserEmail.trim(), newUserPassword)
      await setDoc(doc(db, 'user_roles', uid), {
        role: 'av_viewer' as UserRole,
        module_access: ['avianca'] as ModuleAccess[],
        client_id: null,
        name: newUserName.trim(),
        company: newUserCompany.trim(),
        email: newUserEmail.trim(),
        enabled: true,
        must_change_password: true,
        created_at: new Date().toISOString(),
      })
      setShowCreateUser(false)
      setNewUserEmail('')
      setNewUserName('')
      setNewUserCompany('')
      setNewUserPassword('')
      await loadExternalUsers()
    } catch (err: any) {
      setUserError(err.message || 'Error creando usuario')
    } finally {
      setCreatingUser(false)
    }
  }

  async function toggleUserEnabled(uid: string, currentlyEnabled: boolean) {
    setTogglingUid(uid)
    await updateDoc(doc(db, 'user_roles', uid), { enabled: !currentlyEnabled })
    setExternalUsers(prev => prev.map(u => u.uid === uid ? { ...u, enabled: !currentlyEnabled } : u))
    setTogglingUid(null)
  }

  async function deleteExternalUser(uid: string, email: string) {
    if (!confirm(`Eliminar usuario ${email}? No podra acceder nuevamente.`)) return
    await deleteDoc(doc(db, 'user_roles', uid))
    setExternalUsers(prev => prev.filter(u => u.uid !== uid))
  }

  // ── Permissions matrix ────────────────────────────────────────────
  async function loadPermissions() {
    setPermLoading(true)
    const m = await loadAvMatrix()
    setPermMatrix(m)
    setPermLoading(false)
  }

  function togglePermission(role: string, feature: AvFeatureKey) {
    setPermMatrix(prev => {
      const perms = prev[role] || []
      const has = perms.includes(feature)
      return { ...prev, [role]: has ? perms.filter(p => p !== feature) : [...perms, feature] }
    })
  }

  async function savePermissions() {
    setPermSaving(true)
    await saveAvMatrix(permMatrix)
    invalidateAvMatrixCache()
    setPermSaving(false)
  }

  function resetToDefaults() {
    if (!confirm('Restaurar permisos a los valores por defecto?')) return
    setPermMatrix({ ...DEFAULT_AV_MATRIX })
  }

  // ── MCL users management ────────────────────────────────────────
  const MCL_ROLES: UserRole[] = ['admin', 'gerente', 'accounting', 'super_agent', 'agent', 'counter', 'dispatcher', 'distribuidor', 'soporte_it']

  async function loadMclUsers() {
    setMclUsersLoading(true)
    // Load MCL roles + anyone with avianca access
    const [byRole, byModule] = await Promise.all([
      getDocs(query(collection(db, 'user_roles'), where('role', 'in', MCL_ROLES))),
      getDocs(query(collection(db, 'user_roles'), where('module_access', 'array-contains', 'avianca'))),
    ])
    const seen = new Set<string>()
    const users: typeof mclUsers = []
    for (const d of [...byRole.docs, ...byModule.docs]) {
      if (seen.has(d.id)) continue
      seen.add(d.id)
      const data = d.data()
      // Skip external viewers — they have their own panel
      if (data.role === 'av_viewer') continue
      users.push({
        uid: d.id,
        email: data.email || '',
        name: data.name || '',
        role: data.role || '',
        av_role: data.av_role || '',
        module_access: data.module_access || [],
        enabled: data.enabled !== false,
      })
    }
    users.sort((a, b) => a.name.localeCompare(b.name))
    setMclUsers(users)
    setMclUsersLoading(false)
  }

  async function toggleAvModuleAccess(uid: string, currentAccess: string[]) {
    setTogglingAvUid(uid)
    const has = currentAccess.includes('avianca')
    const newAccess = has
      ? currentAccess.filter(m => m !== 'avianca')
      : [...currentAccess, 'avianca']
    await updateDoc(doc(db, 'user_roles', uid), { module_access: newAccess })
    setMclUsers(prev => prev.map(u => u.uid === uid ? { ...u, module_access: newAccess } : u))
    setTogglingAvUid(null)
  }

  async function addMclUserToAv() {
    setMclError('')
    const email = newMclEmail.trim().toLowerCase()
    if (!email) { setMclError('Ingresa el email'); return }
    if (!email.endsWith('@mincurllogistics.com')) { setMclError('Solo emails @mincurllogistics.com'); return }

    setCreatingMcl(true)
    try {
      // Search by email — try exact match first, then case-insensitive scan
      let snap = await getDocs(query(collection(db, 'user_roles'), where('email', '==', email)))
      if (snap.empty) {
        // Fallback: scan all user_roles for case-insensitive email match
        const allSnap = await getDocs(collection(db, 'user_roles'))
        const match = allSnap.docs.find(d => (d.data().email || '').toLowerCase() === email)
        if (match) {
          snap = { empty: false, docs: [match] } as any
        }
      }

      if (snap.empty) {
        // Account not found — create it (email/password auth + user_roles doc)
        try {
          const tempPw = `MCL-${Date.now()}-Av!`
          const uid = await createUserWithoutSignIn(email, tempPw)
          await setDoc(doc(db, 'user_roles', uid), {
            role: (newMclRole || 'agent') as UserRole,
            av_role: newMclRole || 'agent',
            module_access: ['avianca'] as ModuleAccess[],
            client_id: null,
            name: newMclName.trim() || email.split('@')[0],
            email,
            enabled: true,
            must_change_password: true,
            created_at: new Date().toISOString(),
          })
          setShowCreateMcl(false)
          setNewMclEmail('')
          setNewMclName('')
          setNewMclRole('agent')
          await loadMclUsers()
          return
        } catch (createErr: any) {
          if (createErr.message?.includes('already') || createErr.code === 'auth/email-already-in-use') {
            setMclError('La cuenta existe en Firebase Auth pero no tiene perfil en el WMS. Pide al usuario que inicie sesion una vez para generar su perfil.')
          } else {
            setMclError(createErr.message || 'Error creando cuenta')
          }
          setCreatingMcl(false)
          return
        }
      }

      const userDoc = snap.docs[0]
      const data = userDoc.data()
      const currentAccess: string[] = data.module_access || []

      // Add avianca to module_access and update role/name
      const updates: Record<string, any> = {}
      if (!currentAccess.includes('avianca')) {
        updates.module_access = [...currentAccess, 'avianca']
      }
      if (newMclName.trim()) updates.name = newMclName.trim()
      if (newMclRole) updates.av_role = newMclRole

      if (Object.keys(updates).length > 0) {
        await updateDoc(doc(db, 'user_roles', userDoc.id), updates)
      }

      setShowCreateMcl(false)
      setNewMclEmail('')
      setNewMclName('')
      setNewMclRole('agent')
      await loadMclUsers()
    } catch (err: any) {
      setMclError(err.message || 'Error agregando usuario')
    } finally {
      setCreatingMcl(false)
    }
  }

  function openEditMcl(u: { uid: string; name: string; role: string; av_role: string }) {
    setEditingMclUser(u)
    setEditMclRole(u.av_role || u.role)
  }

  async function saveEditMcl() {
    if (!editingMclUser) return
    setSavingMclEdit(true)
    await updateDoc(doc(db, 'user_roles', editingMclUser.uid), { av_role: editMclRole })
    setMclUsers(prev => prev.map(u => u.uid === editingMclUser.uid ? { ...u, av_role: editMclRole } : u))
    setSavingMclEdit(false)
    setEditingMclUser(null)
  }

  async function removeMclFromAv(uid: string, email: string) {
    if (!confirm(`Quitar acceso Avianca a ${email}?`)) return
    const user = mclUsers.find(u => u.uid === uid)
    if (!user) return
    const newAccess = user.module_access.filter(m => m !== 'avianca')
    await updateDoc(doc(db, 'user_roles', uid), { module_access: newAccess })
    setMclUsers(prev => prev.map(u => u.uid === uid ? { ...u, module_access: newAccess } : u))
  }

  const categories = [...new Set(keywords.map(k => k.category))].sort()
  const filtered = filterCategory ? keywords.filter(k => k.category === filterCategory) : keywords

  return (
    <Layout title="Avianca Cargo — Configuracion" backTo="/avianca">
      <div className="space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h2 className="text-lg font-bold text-gray-800 mb-4">Configuracion</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div
              className="border border-gray-200 rounded-lg p-4 cursor-pointer hover:border-mcl-blue hover:bg-blue-50/30 transition-colors"
              onClick={() => { setShowBillingPanel(!showBillingPanel); if (!billingConfig) loadBillingConfig() }}
            >
              <h3 className="font-semibold text-gray-700 text-sm mb-1">Billing Config</h3>
              <p className="text-xs text-gray-400">Modo {billingConfig?.mode || '...'} — Tarifa flat o brackets progresivos</p>
            </div>
            <div
              className="border border-gray-200 rounded-lg p-4 cursor-pointer hover:border-mcl-blue hover:bg-blue-50/30 transition-colors"
              onClick={() => setShowDgPanel(!showDgPanel)}
            >
              <h3 className="font-semibold text-gray-700 text-sm mb-1">DG Dictionary</h3>
              <p className="text-xs text-gray-400">Diccionario de keywords de Dangerous Goods ({keywords.length} terms)</p>
            </div>
            <div
              className="border border-gray-200 rounded-lg p-4 cursor-pointer hover:border-mcl-blue hover:bg-blue-50/30 transition-colors"
              onClick={() => navigate('/avianca/billing')}
            >
              <h3 className="font-semibold text-gray-700 text-sm mb-1">Billing Charges</h3>
              <p className="text-xs text-gray-400">Facturacion, cargos por vuelo, generar y anular facturas</p>
            </div>
            <div
              className="border border-gray-200 rounded-lg p-4 cursor-pointer hover:border-mcl-blue hover:bg-blue-50/30 transition-colors"
              onClick={() => navigate('/avianca/log')}
            >
              <h3 className="font-semibold text-gray-700 text-sm mb-1">AWB Audit Log</h3>
              <p className="text-xs text-gray-400">Trazabilidad completa por guia aerea</p>
            </div>
            <div
              className="border border-gray-200 rounded-lg p-4 cursor-pointer hover:border-mcl-blue hover:bg-blue-50/30 transition-colors"
              onClick={() => { setShowUsersPanel(!showUsersPanel); if (externalUsers.length === 0) loadExternalUsers() }}
            >
              <h3 className="font-semibold text-gray-700 text-sm mb-1">Usuarios Externos</h3>
              <p className="text-xs text-gray-400">Gestionar cuentas de visualizacion (av_viewer)</p>
            </div>
            <div
              className="border border-gray-200 rounded-lg p-4 cursor-pointer hover:border-mcl-blue hover:bg-blue-50/30 transition-colors"
              onClick={() => navigate('/avianca/tracking')}
            >
              <h3 className="font-semibold text-gray-700 text-sm mb-1">Delivery Tracking</h3>
              <p className="text-xs text-gray-400">Seguimiento de entregas, milestones del driver, PINs</p>
            </div>
            <div
              className="border border-gray-200 rounded-lg p-4 cursor-pointer hover:border-mcl-blue hover:bg-blue-50/30 transition-colors"
              onClick={() => { setShowPermissionsPanel(!showPermissionsPanel); if (Object.keys(permMatrix).length === 0) loadPermissions() }}
            >
              <h3 className="font-semibold text-gray-700 text-sm mb-1">Permisos AV</h3>
              <p className="text-xs text-gray-400">Matriz de permisos por rol para el modulo Avianca</p>
            </div>
            <div
              className="border border-gray-200 rounded-lg p-4 cursor-pointer hover:border-mcl-blue hover:bg-blue-50/30 transition-colors"
              onClick={() => { setShowMclUsersPanel(!showMclUsersPanel); if (mclUsers.length === 0) loadMclUsers() }}
            >
              <h3 className="font-semibold text-gray-700 text-sm mb-1">Usuarios MCL</h3>
              <p className="text-xs text-gray-400">Cuentas MCL activas y acceso al modulo Avianca</p>
            </div>
            <div className="border border-gray-200 rounded-lg p-4 opacity-50">
              <h3 className="font-semibold text-gray-700 text-sm mb-1">Screeners</h3>
              <p className="text-xs text-gray-400">Configurar companias de screening (Phantom K9)</p>
            </div>
          </div>
        </div>

        {/* Billing Config Panel */}
        {showBillingPanel && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide">Billing Config</h2>
              {billingConfig && (
                <span className="text-xs text-gray-400">Modo activo: <span className="font-semibold text-gray-600">{billingConfig.mode === 'flat' ? 'Flat Rate' : 'Brackets'}</span></span>
              )}
            </div>

            {billingLoading ? (
              <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-mcl-blue" /></div>
            ) : billingConfig ? (
              <div className="space-y-5">
                {/* Mode toggle */}
                <div className="flex items-center gap-4">
                  <label className="text-xs font-semibold text-gray-500 uppercase">Modo:</label>
                  <div className="flex rounded-lg overflow-hidden border border-gray-200">
                    <button
                      onClick={() => setEditMode('flat')}
                      className={`px-4 py-1.5 text-xs font-semibold ${editMode === 'flat' ? 'bg-mcl-blue text-white' : 'bg-gray-50 text-gray-500 hover:bg-gray-100'}`}
                    >
                      Flat Rate
                    </button>
                    <button
                      onClick={() => setEditMode('brackets')}
                      className={`px-4 py-1.5 text-xs font-semibold ${editMode === 'brackets' ? 'bg-mcl-blue text-white' : 'bg-gray-50 text-gray-500 hover:bg-gray-100'}`}
                    >
                      Brackets
                    </button>
                  </div>
                </div>

                {/* Flat rate */}
                {editMode === 'flat' && (
                  <div className="bg-gray-50 rounded-lg p-4">
                    <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-1">Tarifa por kg (USD)</label>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-gray-400">$</span>
                      <input
                        type="number"
                        step="0.001"
                        min="0"
                        value={editFlatRate}
                        onChange={e => setEditFlatRate(e.target.value)}
                        className="w-32 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                      />
                      <span className="text-xs text-gray-400">por kg</span>
                    </div>
                    <p className="text-[10px] text-gray-400 mt-2">Se aplica a cada vuelo individualmente. Facturacion por vuelo.</p>
                  </div>
                )}

                {/* Brackets */}
                {editMode === 'brackets' && (
                  <div className="bg-gray-50 rounded-lg p-4">
                    <div className="flex items-center justify-between mb-3">
                      <label className="text-[10px] font-semibold text-gray-500 uppercase">Tramos progresivos (acumulado mensual)</label>
                      <button onClick={addBracket} className="text-xs text-mcl-blue hover:underline font-semibold">+ Agregar tramo</button>
                    </div>
                    <div className="space-y-2">
                      {editBrackets.map((b, i) => (
                        <div key={i} className="flex items-center gap-2 bg-white rounded-lg px-3 py-2 border border-gray-100">
                          <span className="text-[10px] text-gray-400 w-10">#{i + 1}</span>
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              value={b.min_kg}
                              onChange={e => updateBracket(i, 'min_kg', parseInt(e.target.value) || 0)}
                              className="w-24 border border-gray-200 rounded px-2 py-1 text-xs text-right"
                            />
                            <span className="text-[10px] text-gray-400">-</span>
                            <input
                              type="number"
                              value={b.max_kg}
                              onChange={e => updateBracket(i, 'max_kg', parseInt(e.target.value) || 0)}
                              className="w-24 border border-gray-200 rounded px-2 py-1 text-xs text-right"
                            />
                            <span className="text-[10px] text-gray-400 w-6">kg</span>
                          </div>
                          <span className="text-[10px] text-gray-400">@</span>
                          <div className="flex items-center gap-1">
                            <span className="text-xs text-gray-400">$</span>
                            <input
                              type="number"
                              step="0.001"
                              value={b.rate_per_kg}
                              onChange={e => updateBracket(i, 'rate_per_kg', parseFloat(e.target.value) || 0)}
                              className="w-20 border border-gray-200 rounded px-2 py-1 text-xs text-right"
                            />
                          </div>
                          <button onClick={() => removeBracket(i)} className="text-gray-300 hover:text-red-500 ml-auto">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                          </button>
                        </div>
                      ))}
                    </div>
                    <p className="text-[10px] text-gray-400 mt-2">Facturacion quincenal. Q2 recalcula Q1 con acumulado mensual.</p>
                  </div>
                )}

                {/* Save */}
                <div className="flex justify-end">
                  <button
                    onClick={saveBillingChanges}
                    disabled={billingSaving}
                    className="bg-mcl-blue text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-900 disabled:opacity-50"
                  >
                    {billingSaving ? 'Guardando...' : 'Guardar Configuracion'}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        )}

        {/* External Users Panel */}
        {showUsersPanel && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide">Usuarios Externos (av_viewer)</h2>
              <button
                onClick={() => { setShowCreateUser(true); setUserError('') }}
                className="bg-mcl-blue text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-blue-900"
              >
                + Crear Usuario
              </button>
            </div>

            {/* Create user modal */}
            {showCreateUser && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
                <div className="bg-white rounded-xl shadow-xl border border-gray-200 p-6 w-full max-w-md mx-4">
                  <h3 className="text-lg font-bold text-gray-800 mb-4">Crear Usuario Externo</h3>
                  <div className="space-y-3">
                    <div>
                      <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-1">Email *</label>
                      <input
                        type="email" value={newUserEmail} onChange={e => setNewUserEmail(e.target.value)}
                        placeholder="usuario@empresa.com"
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-1">Nombre *</label>
                      <input
                        type="text" value={newUserName} onChange={e => setNewUserName(e.target.value)}
                        placeholder="Nombre completo"
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-1">Empresa</label>
                      <input
                        type="text" value={newUserCompany} onChange={e => setNewUserCompany(e.target.value)}
                        placeholder="Nombre de la empresa"
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-1">Password *</label>
                      <input
                        type="text" value={newUserPassword} onChange={e => setNewUserPassword(e.target.value)}
                        placeholder="Min 8 chars, A-Z, a-z, 0-9, simbolo"
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                      />
                      <p className="text-[10px] text-gray-400 mt-1">Requiere: mayuscula, minuscula, numero y simbolo (!@#$%...)</p>
                    </div>
                  </div>
                  {userError && (
                    <div className="mt-3 bg-red-50 text-red-700 text-xs rounded-lg px-3 py-2 border border-red-200">{userError}</div>
                  )}
                  <div className="flex justify-end gap-2 mt-5">
                    <button onClick={() => setShowCreateUser(false)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Cancelar</button>
                    <button
                      onClick={createExternalUser}
                      disabled={creatingUser}
                      className="bg-mcl-blue text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-900 disabled:opacity-50"
                    >
                      {creatingUser ? 'Creando...' : 'Crear Usuario'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {usersLoading ? (
              <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-mcl-blue" /></div>
            ) : externalUsers.length === 0 ? (
              <p className="text-center text-gray-400 py-6 text-sm">No hay usuarios externos creados.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead className="bg-gray-50 text-gray-500 uppercase text-[10px]">
                    <tr>
                      <th className="text-left px-3 py-2 font-semibold">Email</th>
                      <th className="text-left px-3 py-2 font-semibold">Nombre</th>
                      <th className="text-left px-3 py-2 font-semibold">Empresa</th>
                      <th className="text-center px-3 py-2 font-semibold">Estado</th>
                      <th className="text-left px-3 py-2 font-semibold">Creado</th>
                      <th className="text-center px-3 py-2 font-semibold w-20"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {externalUsers.map(u => (
                      <tr key={u.uid} className="border-t border-gray-100">
                        <td className="px-3 py-2 font-mono text-gray-800">{u.email}</td>
                        <td className="px-3 py-2 text-gray-700">{u.name}</td>
                        <td className="px-3 py-2 text-gray-500">{u.company || '—'}</td>
                        <td className="px-3 py-2 text-center">
                          <button
                            onClick={() => toggleUserEnabled(u.uid, u.enabled)}
                            disabled={togglingUid === u.uid}
                            className={`px-2 py-0.5 rounded text-[10px] font-semibold cursor-pointer ${u.enabled ? 'bg-green-100 text-green-700 hover:bg-green-200' : 'bg-red-100 text-red-600 hover:bg-red-200'}`}
                          >
                            {u.enabled ? 'Activo' : 'Inactivo'}
                          </button>
                        </td>
                        <td className="px-3 py-2 text-gray-400">{u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}</td>
                        <td className="px-3 py-2 text-center">
                          <button
                            onClick={() => deleteExternalUser(u.uid, u.email)}
                            className="text-gray-400 hover:text-red-500"
                            title="Eliminar usuario"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Permissions Matrix Panel */}
        {showPermissionsPanel && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide">Matriz de Permisos AV</h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={resetToDefaults}
                  className="text-xs text-gray-500 hover:text-red-600 font-medium"
                >
                  Restaurar defaults
                </button>
                <button
                  onClick={savePermissions}
                  disabled={permSaving}
                  className="bg-mcl-blue text-white px-4 py-1.5 rounded-lg text-xs font-medium hover:bg-blue-900 disabled:opacity-50"
                >
                  {permSaving ? 'Guardando...' : 'Guardar Permisos'}
                </button>
              </div>
            </div>

            {permLoading ? (
              <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-mcl-blue" /></div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse min-w-[800px]">
                  <thead className="bg-gray-50 text-gray-500 uppercase text-[10px] sticky top-0">
                    <tr>
                      <th className="text-left px-3 py-2 font-semibold border-b border-gray-200 min-w-[180px]">Funcionalidad</th>
                      {AV_MCL_ROLES.map(role => (
                        <th key={role} className="text-center px-2 py-2 font-semibold border-b border-gray-200 whitespace-nowrap">
                          {AV_ROLE_LABELS[role] || role}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {AV_FEATURES.map(feature => (
                      <tr key={feature.key} className="border-t border-gray-100 hover:bg-gray-50/50">
                        <td className="px-3 py-2 font-medium text-gray-700">{feature.label}</td>
                        {AV_MCL_ROLES.map(role => {
                          const perms = permMatrix[role] || []
                          const checked = perms.includes(feature.key)
                          return (
                            <td key={role} className="text-center px-2 py-2">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => togglePermission(role, feature.key)}
                                className="w-4 h-4 rounded border-gray-300 text-mcl-blue focus:ring-mcl-blue/30 cursor-pointer"
                              />
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-[10px] text-gray-400 mt-3">Los cambios se aplican al guardar. Nuevas funcionalidades se agregan como filas adicionales.</p>
          </div>
        )}

        {/* MCL Users Panel */}
        {showMclUsersPanel && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide">Usuarios MCL — Acceso Avianca</h2>
              <div className="flex items-center gap-3">
                <button
                  onClick={loadMclUsers}
                  className="text-xs text-mcl-blue hover:underline font-semibold"
                >
                  Refrescar
                </button>
                <button
                  onClick={() => { setShowCreateMcl(true); setMclError('') }}
                  className="bg-mcl-blue text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-blue-900"
                >
                  + Crear Cuenta MCL
                </button>
              </div>
            </div>

            {/* Add MCL user modal */}
            {showCreateMcl && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
                <div className="bg-white rounded-xl shadow-xl border border-gray-200 p-6 w-full max-w-md mx-4">
                  <h3 className="text-lg font-bold text-gray-800 mb-4">Agregar Usuario MCL a Avianca</h3>
                  <div className="space-y-3">
                    <div>
                      <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-1">Email @mincurllogistics.com *</label>
                      <input
                        type="email" value={newMclEmail} onChange={e => setNewMclEmail(e.target.value)}
                        placeholder="usuario@mincurllogistics.com"
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-1">Nombre (opcional, actualiza si se llena)</label>
                      <input
                        type="text" value={newMclName} onChange={e => setNewMclName(e.target.value)}
                        placeholder="Nombre completo"
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-1">Rol en Avianca</label>
                      <select
                        value={newMclRole}
                        onChange={e => setNewMclRole(e.target.value)}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                      >
                        {AV_MCL_ROLES.map(r => (
                          <option key={r} value={r}>{AV_ROLE_LABELS[r] || r}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <p className="text-[10px] text-gray-400 mt-1">El usuario debe haber iniciado sesion con Google al menos una vez en el WMS.</p>
                    </div>
                  </div>
                  {mclError && (
                    <div className="mt-3 bg-red-50 text-red-700 text-xs rounded-lg px-3 py-2 border border-red-200">{mclError}</div>
                  )}
                  <div className="flex justify-end gap-2 mt-5">
                    <button onClick={() => setShowCreateMcl(false)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Cancelar</button>
                    <button
                      onClick={addMclUserToAv}
                      disabled={creatingMcl}
                      className="bg-mcl-blue text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-900 disabled:opacity-50"
                    >
                      {creatingMcl ? 'Agregando...' : 'Agregar a Avianca'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Edit MCL user — av_role editing */}
            {editingMclUser && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
                <div className="bg-white rounded-xl shadow-xl border border-gray-200 p-6 w-full max-w-sm mx-4">
                  <h3 className="text-lg font-bold text-gray-800 mb-1">Editar Rol AV</h3>
                  <p className="text-xs text-gray-500 mb-4">{editingMclUser.name}</p>
                  <div>
                    <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-1">Rol en Avianca</label>
                    <select
                      value={editMclRole}
                      onChange={e => setEditMclRole(e.target.value)}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                    >
                      {AV_MCL_ROLES.map(r => (
                        <option key={r} value={r}>{AV_ROLE_LABELS[r] || r}</option>
                      ))}
                    </select>
                    <p className="text-[10px] text-gray-400 mt-1">Este rol solo aplica al modulo Avianca. No afecta los demas modulos del WMS.</p>
                  </div>
                  <div className="flex justify-end gap-2 mt-5">
                    <button onClick={() => setEditingMclUser(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Cancelar</button>
                    <button
                      onClick={saveEditMcl}
                      disabled={savingMclEdit}
                      className="bg-mcl-blue text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-900 disabled:opacity-50"
                    >
                      {savingMclEdit ? 'Guardando...' : 'Guardar'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {mclUsersLoading ? (
              <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-mcl-blue" /></div>
            ) : mclUsers.length === 0 ? (
              <p className="text-center text-gray-400 py-6 text-sm">No se encontraron usuarios MCL.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead className="bg-gray-50 text-gray-500 uppercase text-[10px]">
                    <tr>
                      <th className="text-left px-3 py-2 font-semibold">Nombre</th>
                      <th className="text-left px-3 py-2 font-semibold">Email</th>
                      <th className="text-center px-3 py-2 font-semibold">Rol</th>
                      <th className="text-center px-3 py-2 font-semibold">Acceso AV</th>
                      <th className="text-center px-3 py-2 font-semibold w-20"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {mclUsers.map(u => {
                      const hasAv = u.module_access.includes('avianca')
                      const isAlwaysAccess = u.role === 'admin'
                      return (
                        <tr key={u.uid} className={`border-t border-gray-100 ${!hasAv && !isAlwaysAccess ? 'opacity-50' : ''}`}>
                          <td className="px-3 py-2 text-gray-800 font-medium">{u.name || '—'}</td>
                          <td className="px-3 py-2 font-mono text-gray-600">{u.email}</td>
                          <td className="px-3 py-2 text-center">
                            {isAlwaysAccess ? (
                              <span className="inline-block px-2 py-0.5 rounded text-[10px] font-bold bg-gray-100 text-gray-600">
                                {AV_ROLE_LABELS[u.role] || u.role}
                              </span>
                            ) : (
                              <select
                                value={u.av_role || u.role}
                                onChange={async (e) => {
                                  const newAvRole = e.target.value
                                  await updateDoc(doc(db, 'user_roles', u.uid), { av_role: newAvRole })
                                  setMclUsers(prev => prev.map(x => x.uid === u.uid ? { ...x, av_role: newAvRole } : x))
                                }}
                                className="text-[11px] font-semibold text-gray-700 bg-white border border-gray-200 rounded px-1.5 py-1 cursor-pointer hover:border-mcl-blue focus:outline-none focus:ring-1 focus:ring-mcl-blue/30"
                              >
                                {AV_MCL_ROLES.map(r => (
                                  <option key={r} value={r}>{AV_ROLE_LABELS[r] || r}</option>
                                ))}
                              </select>
                            )}
                          </td>
                          <td className="px-3 py-2 text-center">
                            {isAlwaysAccess ? (
                              <span className="px-2.5 py-1 rounded text-[10px] font-semibold bg-green-100 text-green-700">Siempre</span>
                            ) : (
                              <button
                                onClick={() => toggleAvModuleAccess(u.uid, u.module_access)}
                                disabled={togglingAvUid === u.uid}
                                className={`px-2.5 py-1 rounded text-[10px] font-semibold cursor-pointer ${
                                  hasAv
                                    ? 'bg-green-100 text-green-700 hover:bg-green-200'
                                    : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
                                }`}
                              >
                                {hasAv ? 'Activo' : 'Inactivo'}
                              </button>
                            )}
                          </td>
                          <td className="px-3 py-2 text-center">
                            {!isAlwaysAccess && hasAv && (
                              <button
                                onClick={() => removeMclFromAv(u.uid, u.email)}
                                className="text-gray-400 hover:text-red-500"
                                title="Quitar acceso AV"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-[10px] text-gray-400 mt-3">El rol del usuario determina sus permisos dentro de AV (ver matriz de Permisos AV). Admin y Gerente siempre tienen acceso.</p>
          </div>
        )}

        {/* DG Dictionary Panel */}
        {showDgPanel && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide">DG Dictionary</h2>
              <div className="flex items-center gap-2">
                {keywords.length === 0 && (
                  <button
                    onClick={seedDefaults}
                    disabled={saving}
                    className="bg-mcl-blue text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-blue-900 disabled:opacity-50"
                  >
                    {saving ? 'Cargando...' : 'Cargar Defaults'}
                  </button>
                )}
                <span className="text-xs text-gray-400">{keywords.filter(k => k.active).length} activos / {keywords.length} total</span>
              </div>
            </div>

            {loading ? (
              <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-mcl-blue" /></div>
            ) : (
              <>
                {/* Add keyword */}
                <div className="flex items-end gap-2 mb-4 bg-gray-50 rounded-lg p-3">
                  <div className="flex-1">
                    <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-1">Term</label>
                    <input
                      type="text"
                      value={newTerm}
                      onChange={e => setNewTerm(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') addKeyword() }}
                      placeholder="ej: lithium battery"
                      className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                    />
                  </div>
                  <div className="w-36">
                    <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-1">Categoria</label>
                    <input
                      type="text"
                      value={newCategory}
                      onChange={e => setNewCategory(e.target.value)}
                      list="dg-categories"
                      placeholder="Batteries"
                      className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                    />
                    <datalist id="dg-categories">
                      {categories.map(c => <option key={c} value={c} />)}
                    </datalist>
                  </div>
                  <div className="w-28">
                    <label className="text-[10px] font-semibold text-gray-500 uppercase block mb-1">Severidad</label>
                    <select
                      value={newSeverity}
                      onChange={e => setNewSeverity(e.target.value as 'warning' | 'critical')}
                      className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                    >
                      <option value="warning">Warning</option>
                      <option value="critical">Critical</option>
                    </select>
                  </div>
                  <button
                    onClick={addKeyword}
                    disabled={!newTerm.trim() || !newCategory.trim() || saving}
                    className="bg-mcl-blue text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-blue-900 disabled:opacity-50"
                  >
                    Agregar
                  </button>
                </div>

                {/* Filter */}
                {categories.length > 0 && (
                  <div className="flex items-center gap-2 mb-3 flex-wrap">
                    <button
                      onClick={() => setFilterCategory('')}
                      className={`px-2 py-1 rounded text-[10px] font-semibold ${!filterCategory ? 'bg-mcl-blue text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                    >
                      Todos
                    </button>
                    {categories.map(c => (
                      <button
                        key={c}
                        onClick={() => setFilterCategory(filterCategory === c ? '' : c)}
                        className={`px-2 py-1 rounded text-[10px] font-semibold ${filterCategory === c ? 'bg-mcl-blue text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                )}

                {/* Keywords table */}
                <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                  <table className="w-full text-xs border-collapse">
                    <thead className="bg-gray-50 text-gray-500 uppercase text-[10px] sticky top-0">
                      <tr>
                        <th className="text-left px-3 py-2 font-semibold">Term</th>
                        <th className="text-left px-3 py-2 font-semibold">Categoria</th>
                        <th className="text-center px-3 py-2 font-semibold">Severidad</th>
                        <th className="text-center px-3 py-2 font-semibold">Activo</th>
                        <th className="text-center px-3 py-2 font-semibold w-10"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((kw, idx) => {
                        const realIdx = filterCategory ? keywords.indexOf(kw) : idx
                        return (
                          <tr key={`${kw.term}-${idx}`} className={`border-t border-gray-100 ${!kw.active ? 'opacity-40' : ''}`}>
                            <td className="px-3 py-2 font-mono font-semibold text-gray-800">{kw.term}</td>
                            <td className="px-3 py-2 text-gray-500">{kw.category}</td>
                            <td className="px-3 py-2 text-center">
                              <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold ${kw.severity === 'critical' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                                {kw.severity === 'critical' ? 'CRITICAL' : 'WARNING'}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-center">
                              <button onClick={() => toggleActive(realIdx)} className="text-lg">
                                {kw.active ? '✓' : '✗'}
                              </button>
                            </td>
                            <td className="px-3 py-2 text-center">
                              <button
                                onClick={() => removeKeyword(realIdx)}
                                className="text-gray-400 hover:text-red-500"
                                title="Eliminar"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                {filtered.length === 0 && (
                  <p className="text-center text-gray-400 py-8 text-sm">
                    {keywords.length === 0 ? 'No hay keywords. Presiona "Cargar Defaults" para iniciar con la lista sugerida.' : 'No hay keywords en esta categoria.'}
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </Layout>
  )
}
