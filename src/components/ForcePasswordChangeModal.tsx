import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { validatePasswordStrength } from '../lib/passwordGen'

// Blocking modal: shows on top of the whole app when the user's profile has
// must_change_password=true. No way to dismiss until password is changed.
export default function ForcePasswordChangeModal() {
  const { user, mustChangePassword, changePassword, clearMustChangePassword, signOut } = useAuth()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword]         = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [saving, setSaving]                   = useState(false)
  const [error, setError]                     = useState('')

  if (!user || !mustChangePassword) return null

  const strength = validatePasswordStrength(newPassword)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!currentPassword) { setError('Ingresa la contraseña temporal que te entregaron'); return }
    if (!strength.valid)  { setError('La nueva contraseña no cumple los requisitos'); return }
    if (newPassword !== confirmPassword) { setError('Las contraseñas no coinciden'); return }
    if (newPassword === currentPassword) { setError('La nueva contraseña debe ser distinta de la temporal'); return }

    setSaving(true)
    try {
      await changePassword(currentPassword, newPassword)
      await clearMustChangePassword()
    } catch (err: any) {
      const code = err?.code || ''
      if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
        setError('La contraseña temporal es incorrecta')
      } else if (code === 'auth/weak-password') {
        setError('La nueva contraseña es demasiado débil')
      } else {
        setError(err?.message || 'Error al cambiar la contraseña')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-[100] flex items-center justify-center p-4">
      <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
        <div>
          <h2 className="text-lg font-bold text-gray-800">Cambio de contraseña obligatorio</h2>
          <p className="text-xs text-gray-500 mt-1">
            Por seguridad, debes reemplazar la contraseña temporal que te entregó MCL antes de continuar.
          </p>
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700">
          Tu sesión está bloqueada hasta completar este paso.
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">Contraseña temporal</label>
          <input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={e => setCurrentPassword(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-mcl-blue/40"
            placeholder="La que te entregó MCL"
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">Nueva contraseña</label>
          <input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-mcl-blue/40"
            placeholder="Mínimo 10 caracteres"
          />
          <ul className="mt-2 space-y-0.5">
            <Req ok={newPassword.length >= 10} label="Mínimo 10 caracteres" />
            <Req ok={/[a-z]/.test(newPassword)} label="Una minúscula" />
            <Req ok={/[A-Z]/.test(newPassword)} label="Una mayúscula" />
            <Req ok={/[0-9]/.test(newPassword)} label="Un número" />
            <Req ok={/[^A-Za-z0-9]/.test(newPassword)} label="Un símbolo" />
          </ul>
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">Confirmar nueva contraseña</label>
          <input
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-mcl-blue/40"
            placeholder="Repite la nueva contraseña"
          />
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700">{error}</div>
        )}

        <div className="flex gap-3 pt-1">
          <button
            type="button"
            onClick={() => signOut()}
            disabled={saving}
            className="flex-1 border border-gray-200 text-gray-600 rounded-lg py-2.5 text-sm hover:bg-gray-50 disabled:opacity-50"
          >
            Cerrar sesión
          </button>
          <button
            type="submit"
            disabled={saving || !strength.valid || !currentPassword || newPassword !== confirmPassword}
            className="flex-1 bg-mcl-blue text-white rounded-lg py-2.5 text-sm font-semibold hover:bg-blue-900 disabled:opacity-50"
          >
            {saving ? 'Cambiando...' : 'Cambiar contraseña'}
          </button>
        </div>
      </form>
    </div>
  )
}

function Req({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className={`text-[11px] flex items-center gap-1.5 ${ok ? 'text-green-600' : 'text-gray-400'}`}>
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${ok ? 'bg-green-500' : 'bg-gray-300'}`} />
      {label}
    </li>
  )
}
