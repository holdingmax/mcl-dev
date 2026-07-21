import { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef, ReactNode } from 'react'
import {
  User, GoogleAuthProvider, signInWithPopup,
  signOut as fbSignOut, onAuthStateChanged,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
} from 'firebase/auth'
import { auth, db, createUserWithoutSignIn } from '../lib/firebase'
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore'
import { UserRole, ModuleAccess } from '../types'

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.compose'
const TOKEN_KEY   = 'mcl_gmail_token_v2'
const EXPIRY_KEY  = 'mcl_gmail_token_expiry_v2'

// Inactivity timeout: auto sign-out after N ms with no user interaction.
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes

function loadStoredToken(): string | null {
  const token  = sessionStorage.getItem(TOKEN_KEY)
  const expiry = sessionStorage.getItem(EXPIRY_KEY)
  if (token && expiry && Date.now() < parseInt(expiry)) return token
  return null
}

// Read role config from Firestore (config/mcl_roles)
// Falls back to hardcoded defaults if config doc doesn't exist yet
async function getConfiguredRole(email: string): Promise<UserRole> {
  try {
    const configSnap = await getDoc(doc(db, 'config', 'mcl_roles'))
    if (configSnap.exists()) {
      const data = configSnap.data()
      const assignments: Record<string, UserRole> = data.assignments || {}
      if (assignments[email]) return assignments[email]
      return (data.default_role as UserRole) || 'agent'
    }
  } catch {
    // Firestore unavailable — use hardcoded fallback
  }
  // Hardcoded fallback (only used if config doc doesn't exist)
  if (email === 'diego.garcia@mincurllogistics.com') return 'admin'
  if (email === 'admin@mincurllogistics.com' || email === 'finanzas@mincurllogistics.com') return 'accounting'
  return 'agent'
}

interface UserProfile {
  role: UserRole
  module_access: ModuleAccess[]
  client_id: string | null
  name?: string
  can_view_charges?: boolean
  must_change_password?: boolean
}

interface AuthContextType {
  user: User | null
  loading: boolean
  gmailToken: string | null
  userRole: UserRole | null
  moduleAccess: ModuleAccess[]
  clientId: string | null
  mustChangePassword: boolean
  clearMustChangePassword: () => Promise<void>
  // Sea freight flags
  isAdmin: boolean
  isGerente: boolean
  isAccounting: boolean
  isSuperAgent: boolean
  isAgent: boolean
  isBilling: boolean
  canEdit: boolean
  // Airfreight flags
  isClient: boolean
  isCounter: boolean
  isBodega: boolean
  isViewer: boolean
  isDistribuidor: boolean
  isDispatcher: boolean
  isSoporteIT: boolean
  // Permissions
  canViewCharges: boolean
  // Module helpers
  hasSeaAccess: boolean
  hasAirAccess: boolean
  hasWarehouseAccess: boolean
  // Avianca
  isAvViewer: boolean
  hasAvAccess: boolean
  avRole: string | null
  // Vendor admin
  isVendorAdmin: boolean
  vendorId: string | null
  // Airfreight client booking type (for ecommerce Express Line UX)
  isEcommerceClient: boolean
  hasUldAccess: boolean
  signInWithGoogle: () => Promise<void>
  signInWithEmail: (email: string, password: string) => Promise<void>
  createClientAccount: (email: string, password: string, profile: Omit<UserProfile, 'role' | 'must_change_password'> & { name: string; role?: 'client' | 'viewer' }) => Promise<void>
  resetPassword: (email: string) => Promise<void>
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>
  signOut: () => Promise<void>
  refreshGmailToken: () => Promise<string | null>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser]               = useState<User | null>(null)
  const [loading, setLoading]         = useState(true)
  const [gmailToken, setGmailToken]   = useState<string | null>(loadStoredToken)
  const [userRole, setUserRole]       = useState<UserRole | null>(null)
  const [moduleAccess, setModuleAccess] = useState<ModuleAccess[]>([])
  const [clientId, setClientId]       = useState<string | null>(null)
  const [canViewChargesFlag, setCanViewChargesFlag] = useState(false)
  const [isEcommerceClient, setIsEcommerceClient] = useState(false)
  const [hasUldAccess, setHasUldAccess] = useState(false)
  const [mustChangePassword, setMustChangePassword] = useState(false)
  const [vendorId, setVendorId] = useState<string | null>(null)
  const [avRole, setAvRole] = useState<string | null>(null)
  const loadedUidRef = useRef<string | null>(null)

  const isGerente    = userRole === 'gerente'
  const isAdmin      = userRole === 'admin' || isGerente
  const isAccounting = userRole === 'accounting'
  const isSuperAgent = userRole === 'super_agent'
  const isAgent      = userRole === 'agent'
  const isClient     = userRole === 'client'
  const isCounter    = userRole === 'counter'
  const isBodega     = userRole === 'bodega'
  const isViewer     = userRole === 'viewer'
  const isDistribuidor = userRole === 'distribuidor'
  const isDispatcher = userRole === 'dispatcher'
  const isSoporteIT  = userRole === 'soporte_it'
  const isVendorAdmin = userRole === 'vendor_admin'
  const isAvViewer   = userRole === 'av_viewer'
  const isBilling    = isAdmin || isAccounting
  const canEdit      = isAdmin || isSuperAgent || isAgent
  const canViewCharges = isBilling || canViewChargesFlag  // MCL billing always, clients only if flag set
  const hasSeaAccess = moduleAccess.includes('seafreight') || isAdmin || isSoporteIT
  const hasAirAccess = moduleAccess.includes('airfreight') || isAdmin || isSoporteIT
  const hasWarehouseAccess = moduleAccess.includes('warehouse_services') || isAdmin || isSoporteIT
  const hasAvAccess = isAvViewer || isAdmin || isSoporteIT || moduleAccess.includes('avianca')

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      // Skip redundant Firestore reads on token refresh (~every 60 min)
      // Only re-fetch profile when the actual user changes (different UID or sign-out)
      if (u && u.uid === loadedUidRef.current) {
        setLoading(false)
        return
      }
      setUser(u);
      (async () => {
        if (u) {
          try {
            const roleDoc = await getDoc(doc(db, 'user_roles', u.uid))
            if (roleDoc.exists()) {
              const data = roleDoc.data() as UserProfile
              setUserRole(data.role)
              setModuleAccess(data.module_access || ['seafreight'])
              setClientId(data.client_id || null)
              setCanViewChargesFlag(!!data.can_view_charges)
              setMustChangePassword(!!data.must_change_password)
              setAvRole((data as any).av_role || null)
              // If av_viewer is disabled, force sign-out
              if (data.role === 'av_viewer' && data.enabled === false) {
                console.warn('av_viewer account disabled — forcing sign-out')
                setUserRole(null)
                setModuleAccess([])
                try { await fbSignOut(auth) } catch { /* ignore */ }
                setLoading(false)
                return
              }
              // Sync display name from Firebase Auth if it changed
              const authName = u.displayName || ''
              if (authName && authName !== data.name) {
                updateDoc(doc(db, 'user_roles', u.uid), { name: authName }).catch(() => {})
              }
              // If vendor_admin, fetch vendor_id
              if (data.role === 'vendor_admin') {
                try {
                  const vuSnap = await getDoc(doc(db, 'vendor_users', u.uid))
                  if (vuSnap.exists()) {
                    setVendorId((vuSnap.data() as any).vendor_id || null)
                  } else {
                    setVendorId(null)
                  }
                } catch {
                  setVendorId(null)
                }
              } else {
                setVendorId(null)
              }
              // If this is a client, fetch the airfreight_clients booking_type
              if (data.role === 'client' && data.client_id) {
                try {
                  const afClientSnap = await getDoc(doc(db, 'airfreight_clients', data.client_id))
                  if (afClientSnap.exists()) {
                    const afClient = afClientSnap.data() as { booking_type?: string; uld_control_access?: boolean }
                    setIsEcommerceClient(afClient.booking_type === 'ecommerce')
                    setHasUldAccess(!!afClient.uld_control_access)
                  } else {
                    setIsEcommerceClient(false)
                    setHasUldAccess(false)
                  }
                } catch {
                  setIsEcommerceClient(false)
                  setHasUldAccess(false)
                }
              } else {
                setIsEcommerceClient(false)
              }
              loadedUidRef.current = u.uid
            } else if (u.email?.endsWith('@mincurllogistics.com')) {
              // MCL staff first login — create user_roles doc from config
              const role = await getConfiguredRole(u.email)
              const modules: ModuleAccess[] = ['seafreight', 'airfreight', 'warehouse_services']
              await setDoc(doc(db, 'user_roles', u.uid), {
                role,
                module_access: modules,
                client_id: null,
                email: u.email,
                name: u.displayName || '',
                created_at: new Date().toISOString(),
              })
              setUserRole(role)
              setModuleAccess(modules)
              setClientId(null)
              setIsEcommerceClient(false)
              setMustChangePassword(false)
              setVendorId(null)
              loadedUidRef.current = u.uid
            } else {
              // Authenticated but no user_roles doc and not MCL staff.
              // This means the account was deleted or never provisioned — force sign-out
              // so the user lands cleanly on the login page instead of getting stuck in redirects.
              console.warn('No user_roles doc for', u.email, '— forcing sign-out')
              setUserRole(null)
              setModuleAccess([])
              setClientId(null)
              setCanViewChargesFlag(false)
              setIsEcommerceClient(false)
              setMustChangePassword(false)
              setVendorId(null)
              try { await fbSignOut(auth) } catch { /* ignore */ }
            }
          } catch {
            const role = await getConfiguredRole(u.email || '')
            setUserRole(role)
            setModuleAccess(['seafreight', 'airfreight', 'warehouse_services'])
            setClientId(null)
            setIsEcommerceClient(false)
            setMustChangePassword(false)
            setVendorId(null)
            loadedUidRef.current = u.uid
          }
        } else {
          loadedUidRef.current = null
          setUserRole(null)
          setModuleAccess([])
          setClientId(null)
          setCanViewChargesFlag(false)
          setIsEcommerceClient(false)
          setMustChangePassword(false)
          setVendorId(null)
        }
        setLoading(false)
      })()
    })
    return unsubscribe
  }, [])

  function saveToken(token: string) {
    setGmailToken(token)
    sessionStorage.setItem(TOKEN_KEY,  token)
    sessionStorage.setItem(EXPIRY_KEY, String(Date.now() + 3600 * 1000))
  }

  const signInWithGoogle = useCallback(async () => {
    const provider = new GoogleAuthProvider()
    provider.addScope(GMAIL_SCOPE)
    provider.setCustomParameters({
      prompt: 'select_account login',
      max_age: '0',
    })
    const result = await signInWithPopup(auth, provider)
    const email  = result.user.email || ''
    if (!email.endsWith('@mincurllogistics.com')) {
      await fbSignOut(auth)
      throw new Error('Acceso restringido a cuentas @mincurllogistics.com')
    }
    const cred = GoogleAuthProvider.credentialFromResult(result)
    if (cred?.accessToken) saveToken(cred.accessToken)
  }, [])

  const signInWithEmail = useCallback(async (email: string, password: string) => {
    await signInWithEmailAndPassword(auth, email, password)
  }, [])

  const createClientAccount = useCallback(async (
    email: string,
    password: string,
    profile: Omit<UserProfile, 'role' | 'must_change_password'> & { name: string; role?: 'client' | 'viewer' }
  ) => {
    const uid = await createUserWithoutSignIn(email, password)
    await setDoc(doc(db, 'user_roles', uid), {
      role: (profile.role || 'client') as UserRole,
      module_access: profile.module_access,
      client_id: profile.client_id,
      name: profile.name,
      email,
      must_change_password: true,
      created_at: new Date().toISOString(),
    })
  }, [])

  const clearMustChangePassword = useCallback(async () => {
    if (!user) return
    await setDoc(
      doc(db, 'user_roles', user.uid),
      { must_change_password: false },
      { merge: true },
    )
    setMustChangePassword(false)
  }, [user])

  const resetPassword = useCallback(async (email: string) => {
    await sendPasswordResetEmail(auth, email)
  }, [])

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    if (!user || !user.email) throw new Error('No hay usuario autenticado')
    const credential = EmailAuthProvider.credential(user.email, currentPassword)
    await reauthenticateWithCredential(user, credential)
    await updatePassword(user, newPassword)
  }, [user])

  const refreshGmailToken = useCallback(async (): Promise<string | null> => {
    try {
      const provider = new GoogleAuthProvider()
      provider.addScope(GMAIL_SCOPE)
      if (user?.email) provider.setCustomParameters({ login_hint: user.email })
      const result = await signInWithPopup(auth, provider)
      const cred   = GoogleAuthProvider.credentialFromResult(result)
      if (cred?.accessToken) {
        saveToken(cred.accessToken)
        return cred.accessToken
      }
      console.warn('No accessToken in credential', cred)
    } catch (e: any) {
      console.error('Gmail token refresh failed', e?.code, e?.message, e)
      if (e?.code === 'auth/popup-blocked') {
        alert('El popup de Google fue bloqueado. Permite los popups para este sitio e intenta de nuevo.')
      }
    }
    return null
  }, [user])

  const signOut = useCallback(async () => {
    sessionStorage.removeItem(TOKEN_KEY)
    sessionStorage.removeItem(EXPIRY_KEY)
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(EXPIRY_KEY)
    setGmailToken(null)
    await fbSignOut(auth)
  }, [])

  // Inactivity auto-logout: when a user is signed in, track user interaction
  // events and sign them out after INACTIVITY_TIMEOUT_MS with no activity.
  useEffect(() => {
    if (!user) return

    let timeoutId: ReturnType<typeof setTimeout> | null = null

    const handleInactivity = () => {
      console.log('Auto sign-out: inactivity timeout reached')
      signOut().catch((err) => console.error('Auto sign-out failed', err))
    }

    const resetTimer = () => {
      if (timeoutId) clearTimeout(timeoutId)
      timeoutId = setTimeout(handleInactivity, INACTIVITY_TIMEOUT_MS)
    }

    const events: Array<keyof WindowEventMap> = [
      'mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click',
    ]
    events.forEach((e) => window.addEventListener(e, resetTimer, { passive: true }))
    resetTimer()

    return () => {
      if (timeoutId) clearTimeout(timeoutId)
      events.forEach((e) => window.removeEventListener(e, resetTimer))
    }
  }, [user])

  const value = useMemo(() => ({
    user, loading, gmailToken,
    userRole, moduleAccess, clientId,
    mustChangePassword, clearMustChangePassword,
    isAdmin, isGerente, isAccounting, isSuperAgent, isAgent, isBilling, canEdit, canViewCharges,
    isClient, isCounter, isBodega, isViewer, isDistribuidor, isDispatcher, isSoporteIT, isVendorAdmin, vendorId,
    isAvViewer, hasAvAccess, avRole,
    hasSeaAccess, hasAirAccess, hasWarehouseAccess,
    isEcommerceClient, hasUldAccess,
    signInWithGoogle, signInWithEmail, createClientAccount,
    resetPassword, changePassword,
    signOut, refreshGmailToken,
  }), [
    user, loading, gmailToken,
    userRole, moduleAccess, clientId, avRole,
    mustChangePassword, clearMustChangePassword,
    canViewCharges, isEcommerceClient, hasUldAccess, vendorId,
    signInWithGoogle, signInWithEmail, createClientAccount,
    resetPassword, changePassword,
    signOut, refreshGmailToken,
  ])

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
