import { ReactNode, useState } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

interface LayoutProps {
  children: ReactNode
  title: string
  backTo?: string
  onBack?: () => void
  headerRight?: ReactNode
  fullWidth?: boolean
}

export default function Layout({ children, title, backTo, onBack, headerRight, fullWidth }: LayoutProps) {
  const { user, signOut, changePassword, isBilling, isAdmin, isAccounting, isSuperAgent, isAgent, isCounter, isBodega, isClient, isSoporteIT } = useAuth()
  const isMcl = isAdmin || isAccounting || isSuperAgent || isAgent || isCounter || isBodega || isSoporteIT
  const navigate = useNavigate()
  const location = useLocation()
  const isAirModule = location.pathname.startsWith('/airfreight')
  const isWSModule = location.pathname.startsWith('/warehouse-services')
  const isAvModule = location.pathname.startsWith('/avianca')
  const isSeaModule = location.pathname.startsWith('/sea') || location.pathname.startsWith('/billing') || location.pathname.startsWith('/clients') || location.pathname.startsWith('/dispatches') || location.pathname.startsWith('/inventory')

  // Change password modal state
  const [showChangePw, setShowChangePw] = useState(false)
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [pwError, setPwError] = useState('')
  const [pwSuccess, setPwSuccess] = useState('')
  const [pwLoading, setPwLoading] = useState(false)

  // Only show change password for email/password users (clients), not Google SSO
  const isEmailUser = user?.providerData?.some(p => p.providerId === 'password')

  const handleSignOut = async () => {
    await signOut()
    navigate('/login')
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault()
    setPwError('')
    setPwSuccess('')
    if (newPw.length < 6) { setPwError('La contraseña debe tener al menos 6 caracteres'); return }
    if (newPw !== confirmPw) { setPwError('Las contraseñas no coinciden'); return }
    setPwLoading(true)
    try {
      await changePassword(currentPw, newPw)
      setPwSuccess('Contraseña actualizada correctamente')
      setCurrentPw(''); setNewPw(''); setConfirmPw('')
      setTimeout(() => { setShowChangePw(false); setPwSuccess('') }, 2000)
    } catch (err: any) {
      if (err?.code === 'auth/wrong-password' || err?.code === 'auth/invalid-credential') {
        setPwError('La contraseña actual es incorrecta')
      } else {
        setPwError('Error al cambiar la contraseña')
      }
    } finally {
      setPwLoading(false)
    }
  }

  const watermarkEmail = user?.email || ''

  return (
    <div className="min-h-screen bg-gray-50 relative flex flex-col">
      {/* Watermark overlay */}
      {watermarkEmail && (
        <div
          className="fixed inset-0 pointer-events-none z-[9999] overflow-hidden"
          aria-hidden="true"
          style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
        >
          <div
            className="absolute"
            style={{
              top: '-50%',
              left: '-50%',
              width: '200%',
              height: '200%',
              transform: 'rotate(-30deg)',
              display: 'flex',
              flexWrap: 'wrap',
              gap: '80px',
              alignContent: 'flex-start',
            }}
          >
            {Array.from({ length: 60 }).map((_, i) => (
              <span
                key={i}
                className="text-[13px] whitespace-nowrap"
                style={{
                  color: 'rgba(0,0,0,0.04)',
                  fontFamily: 'monospace',
                  letterSpacing: '2px',
                }}
              >
                {watermarkEmail}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Header */}
      <header className="bg-mcl-blue text-white shadow-lg">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between relative">
          {/* Left: back arrow + module shortcuts */}
          <div className="flex items-center gap-2">
            {(backTo || onBack) && (
              onBack ? (
                <button onClick={onBack} className="text-white/80 hover:text-white mr-1">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
              ) : (
                <Link to={backTo!} className="text-white/80 hover:text-white mr-1">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </Link>
              )
            )}
            {/* Module navigation icons */}
            {isMcl && (
              <div className="flex items-center gap-1">
                {/* Sea Freight */}
                <Link
                  to="/sea"
                  title="Sea Freight"
                  className={`p-1.5 rounded-md transition-colors ${isSeaModule ? 'bg-white/20 text-white' : 'text-white/50 hover:text-white hover:bg-white/10'}`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 17h1l1-5h14l1 5h1M5 17l-2 4h18l-2-4M8 12V6a1 1 0 011-1h2v4l1.5-1 1.5 1V5h2a1 1 0 011 1v6" />
                  </svg>
                </Link>
                {/* Air Freight */}
                <Link
                  to="/airfreight"
                  title="Air Freight"
                  className={`p-1.5 rounded-md transition-colors ${isAirModule ? 'bg-white/20 text-white' : 'text-white/50 hover:text-white hover:bg-white/10'}`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l-7-7 3-3 4 4V3h2v10l4-4 3 3-7 7z" />
                  </svg>
                </Link>
                {/* Warehouse Services */}
                <Link
                  to="/warehouse-services"
                  title="Warehouse Services"
                  className={`p-1.5 rounded-md transition-colors ${isWSModule ? 'bg-white/20 text-white' : 'text-white/50 hover:text-white hover:bg-white/10'}`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 14v3m4-3v3m4-3v3M3 21h18M3 10h18M3 7l9-4 9 4M4 10h16v11H4V10z" />
                  </svg>
                </Link>
                {/* Avianca Cargo */}
                <Link
                  to="/avianca"
                  title="Avianca Cargo"
                  className={`p-1.5 rounded-md transition-colors ${isAvModule ? 'bg-white/20 text-white' : 'text-white/50 hover:text-white hover:bg-white/10'}`}
                >
                  <span className="w-4 h-4 flex items-center justify-center text-[10px] font-black leading-none">AV</span>
                </Link>
                {/* Monitoring */}
                {(isAdmin || isSoporteIT) && (
                  <Link
                    to="/monitoring"
                    title="Monitoreo"
                    className={`p-1.5 rounded-md transition-colors ${location.pathname.startsWith('/monitoring') ? 'bg-white/20 text-white' : 'text-white/50 hover:text-white hover:bg-white/10'}`}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                    </svg>
                  </Link>
                )}
              </div>
            )}
            {!backTo && !isMcl && (
              <h1 className="text-sm font-medium text-white/90 sm:hidden">{title}</h1>
            )}
          </div>

          {/* Center: logo (absolutely centered on mobile, centered via absolute on sm+) */}
          <div className="absolute left-1/2 -translate-x-1/2 sm:absolute sm:left-1/2 sm:-translate-x-1/2 flex items-center gap-3">
            <div className="bg-white rounded-lg overflow-hidden w-[80px] h-[34px] sm:w-[128px] sm:h-[54px]">
              <img src="/logo.png" alt="MINCURL Logistics" className="w-[122px] mt-[-11px] ml-[-6px] sm:w-[195px] sm:mt-[-18px] sm:ml-[-10px]" />
            </div>
            <span className="text-white/40 hidden sm:block">|</span>
            <h1 className="text-sm font-medium text-white/90 hidden sm:block">{title}</h1>
          </div>

          {/* Right: user + sign out */}
          <div className="flex items-center gap-3 ml-auto">
            <span className="text-xs text-white/70 hidden sm:block">{user?.email}</span>
            {headerRight}
            {isBilling && !isAirModule && !isWSModule && !isAvModule && (
              <Link
                to="/billing"
                title="Facturación"
                className="text-white/70 hover:text-white transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </Link>
            )}
            {isBilling && isAirModule && (
              <Link
                to="/airfreight/billing/charges"
                title="Billing"
                className="text-white/70 hover:text-white transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </Link>
            )}
            {isMcl && isAirModule && (
              <Link
                to="/airfreight/admin"
                title="Administración"
                className="text-white/70 hover:text-white transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </Link>
            )}
            {isMcl && isWSModule && (
              <Link
                to="/warehouse-services/admin"
                title="Administración"
                className="text-white/70 hover:text-white transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </Link>
            )}
            {isMcl && isAvModule && (
              <Link
                to="/avianca/config"
                title="Configuración Avianca"
                className="text-white/70 hover:text-white transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </Link>
            )}
            {isEmailUser && (
              <button
                onClick={() => { setShowChangePw(true); setPwError(''); setPwSuccess(''); setCurrentPw(''); setNewPw(''); setConfirmPw('') }}
                title="Cambiar contraseña"
                className="text-white/70 hover:text-white transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </button>
            )}
            <button
              onClick={handleSignOut}
              className="text-xs bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-md transition-colors"
            >
              Salir
            </button>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className={`${fullWidth ? 'max-w-[1920px] px-3' : 'max-w-7xl px-4'} mx-auto py-6 flex-1 w-full`}>
        {children}
      </main>

      {/* Legal footer — always at the very bottom */}
      <footer className="border-t border-gray-200 bg-gray-50 mt-auto">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <p className="text-[10px] leading-relaxed text-gray-400 text-center">
            <span className="font-semibold text-gray-500">CONFIDENTIAL — PROPRIETARY SYSTEM</span>
            <br />
            This application and all its contents are the exclusive property of MinCurl Logistics LLC.
            Unauthorized reproduction, distribution, or disclosure of any information displayed herein
            is strictly prohibited and may result in legal action. Access is granted solely to authorized
            users for operational purposes. All activity is monitored and logged.
            <br />
            &copy; {new Date().getFullYear()} MinCurl Logistics LLC. All rights reserved.
          </p>
        </div>
      </footer>

      {/* Change password modal */}
      {showChangePw && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={() => !pwLoading && setShowChangePw(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6">
              <h3 className="font-semibold text-gray-800 mb-4">Cambiar contraseña</h3>
              {pwError && (
                <div className="mb-3 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700">
                  {pwError}
                </div>
              )}
              {pwSuccess && (
                <div className="mb-3 bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-sm text-green-700">
                  {pwSuccess}
                </div>
              )}
              <form onSubmit={handleChangePassword} className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Contraseña actual</label>
                  <input
                    type="password"
                    value={currentPw}
                    onChange={e => setCurrentPw(e.target.value)}
                    required
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Nueva contraseña</label>
                  <input
                    type="password"
                    value={newPw}
                    onChange={e => setNewPw(e.target.value)}
                    required
                    minLength={6}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Confirmar nueva contraseña</label>
                  <input
                    type="password"
                    value={confirmPw}
                    onChange={e => setConfirmPw(e.target.value)}
                    required
                    minLength={6}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                  />
                </div>
                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowChangePw(false)}
                    disabled={pwLoading}
                    className="text-sm px-4 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={pwLoading}
                    className="text-sm px-4 py-2 rounded-lg bg-mcl-blue text-white hover:bg-blue-900 disabled:opacity-50"
                  >
                    {pwLoading ? 'Guardando...' : 'Cambiar'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
