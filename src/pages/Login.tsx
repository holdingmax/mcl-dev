import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'

export default function Login() {
  const { signInWithGoogle, signInWithEmail, resetPassword } = useAuth()
  const [tab, setTab]         = useState<'mcl' | 'client'>('mcl')
  const [email, setEmail]     = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]     = useState('')
  const [success, setSuccess] = useState('')
  const [loading, setLoading] = useState(false)
  const [showPw, setShowPw]   = useState(false)

  async function handleGoogle() {
    setError('')
    setLoading(true)
    try {
      await signInWithGoogle()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al iniciar sesión')
    }
    setLoading(false)
  }

  async function handleEmail(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setSuccess('')
    setLoading(true)
    try {
      await signInWithEmail(email, password)
    } catch {
      setError('Email o contraseña incorrectos')
    }
    setLoading(false)
  }

  async function handleForgotPassword() {
    if (!email.trim()) {
      setError('Ingrese su email para recuperar la contraseña')
      return
    }
    setError('')
    setSuccess('')
    setLoading(true)
    try {
      await resetPassword(email)
      setSuccess('Se envió un correo para restablecer su contraseña. Revise su bandeja de entrada.')
    } catch {
      setError('No se pudo enviar el correo. Verifique que el email sea correcto.')
    }
    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-mcl-blue flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-sm text-center">
        {/* Logo */}
        <div className="mb-6">
          <img src="/logo.png" alt="MINCURL Logistics" className="h-24 mx-auto mb-2" />
          <p className="text-gray-500 text-sm mt-1">Logistics Management System</p>
          <p className="text-gray-400 text-xs mt-0.5">Miami, Florida</p>
        </div>

        {/* Tabs */}
        <div className="flex rounded-lg overflow-hidden border border-gray-200 mb-6">
          <button
            onClick={() => { setTab('mcl'); setError('') }}
            className={`flex-1 py-2 text-sm font-semibold transition-colors ${tab === 'mcl' ? 'bg-mcl-blue text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
          >
            Personal MCL
          </button>
          <button
            onClick={() => { setTab('client'); setError('') }}
            className={`flex-1 py-2 text-sm font-semibold border-l border-gray-200 transition-colors ${tab === 'client' ? 'bg-mcl-blue text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
          >
            Clientes
          </button>
        </div>

        {error && (
          <div className="mb-4 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}
        {success && (
          <div className="mb-4 bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm text-green-700">
            {success}
          </div>
        )}

        {tab === 'mcl' ? (
          <button
            onClick={handleGoogle}
            disabled={loading}
            className="w-full flex items-center justify-center gap-3 border border-gray-300 rounded-lg px-4 py-3 hover:bg-gray-50 transition-colors font-medium text-gray-700 disabled:opacity-50"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            {loading ? 'Ingresando...' : 'Continuar con Google'}
          </button>
        ) : (
          <form onSubmit={handleEmail} className="space-y-3 text-left" autoComplete="off">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Email</label>
              <input
                type="email"
                name="mcl-login-email"
                autoComplete="off"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                placeholder="email@empresa.com"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Contraseña</label>
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'}
                  name="mcl-login-password"
                  autoComplete="new-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  className="w-full border border-gray-200 rounded-lg px-3 py-2.5 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPw(v => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {showPw ? (
                    <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L6.59 6.59m7.532 7.532l3.29 3.29M3 3l18 18" /></svg>
                  ) : (
                    <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                  )}
                </button>
              </div>
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-mcl-blue text-white rounded-lg py-2.5 text-sm font-semibold hover:bg-blue-900 transition-colors disabled:opacity-50"
            >
              {loading ? 'Ingresando...' : 'Ingresar'}
            </button>
            <button
              type="button"
              onClick={handleForgotPassword}
              disabled={loading}
              className="w-full text-xs text-gray-400 hover:text-mcl-blue mt-2 transition-colors disabled:opacity-50"
            >
              ¿Olvidaste tu contraseña?
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
