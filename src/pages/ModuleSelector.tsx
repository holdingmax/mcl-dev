import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

export default function ModuleSelector() {
  const { hasSeaAccess, hasAirAccess, hasWarehouseAccess, hasAvAccess, isClient, isAdmin, isSuperAgent, isAgent, isAvViewer, user, signOut } = useAuth()
  const isMcl = isAdmin || isSuperAgent || isAgent
  const navigate = useNavigate()

  const handleSignOut = async () => {
    await signOut()
    navigate('/login')
  }

  const accessibleModules = [hasSeaAccess, hasAirAccess, hasWarehouseAccess, hasAvAccess].filter(Boolean).length

  useEffect(() => {
    // Auto-redirect if user has access to only one module
    if (accessibleModules === 1) {
      if (hasSeaAccess) navigate('/', { replace: true })
      else if (hasAirAccess) navigate('/airfreight', { replace: true })
      else if (hasWarehouseAccess) navigate('/warehouse-services', { replace: true })
      else if (hasAvAccess) navigate('/avianca', { replace: true })
    }
  }, [hasSeaAccess, hasAirAccess, hasWarehouseAccess, hasAvAccess, accessibleModules, navigate])

  // Show selector only if user has more than one module
  if (accessibleModules <= 1) return null

  return (
    <div className="min-h-screen bg-mcl-blue flex items-center justify-center p-4 relative">
      {/* Sign out button */}
      <div className="absolute top-4 right-4 flex items-center gap-3">
        <span className="text-xs text-white/60">{user?.email}</span>
        <button
          onClick={handleSignOut}
          className="text-xs bg-white/10 hover:bg-white/20 text-white px-3 py-1.5 rounded-md transition-colors"
        >
          Salir
        </button>
      </div>

      <div className="w-full max-w-4xl">
        {/* Logo */}
        <div className="text-center mb-10">
          <div className="inline-block bg-white rounded-xl p-4 shadow-lg mb-4">
            <img src="/logo.png" alt="MINCURL Logistics" className="h-16" />
          </div>
          <p className="text-white/70 text-sm">Selecciona un módulo para continuar</p>
        </div>

        <div className={`grid grid-cols-1 sm:grid-cols-2 ${(accessibleModules >= 3 || isMcl) ? 'lg:grid-cols-4' : ''} gap-5`}>
          {/* SeaFreight */}
          {hasSeaAccess && (
            <button
              onClick={() => navigate('/sea')}
              className="bg-white rounded-2xl shadow-xl p-8 text-center hover:scale-105 transition-transform group"
            >
              <div className="text-5xl mb-4">🚢</div>
              <h2 className="text-xl font-bold text-gray-800 mb-2">Sea Freight</h2>
              <p className="text-sm text-gray-500">Warehouse receipts, consolidados e inventario de carga marítima</p>
              <div className="mt-5 inline-block bg-mcl-blue text-white text-xs font-semibold px-4 py-2 rounded-full group-hover:bg-blue-900 transition-colors">
                Ingresar
              </div>
            </button>
          )}

          {/* Airfreight */}
          {hasAirAccess && (
            <button
              onClick={() => navigate('/airfreight')}
              className="bg-white rounded-2xl shadow-xl p-8 text-center hover:scale-105 transition-transform group"
            >
              <div className="text-5xl mb-4">✈️</div>
              <h2 className="text-xl font-bold text-gray-800 mb-2">Air Freight</h2>
              <p className="text-sm text-gray-500">Gestión de bookings y documentación de carga aérea</p>
              <div className="mt-5 inline-block bg-mcl-blue text-white text-xs font-semibold px-4 py-2 rounded-full group-hover:bg-blue-900 transition-colors">
                Ingresar
              </div>
            </button>
          )}

          {/* Warehouse Services */}
          {hasWarehouseAccess && (
            <button
              onClick={() => navigate('/warehouse-services')}
              className="bg-white rounded-2xl shadow-xl p-8 text-center hover:scale-105 transition-transform group"
            >
              <div className="text-5xl mb-4">🏭</div>
              <h2 className="text-xl font-bold text-gray-800 mb-2">Warehouse Services</h2>
              <p className="text-sm text-gray-500">Servicios de bodega: screening, transporte, almacenaje y más</p>
              <div className="mt-5 inline-block bg-mcl-blue text-white text-xs font-semibold px-4 py-2 rounded-full group-hover:bg-blue-900 transition-colors">
                Ingresar
              </div>
            </button>
          )}

          {/* Avianca Cargo — MCL staff + av_viewers */}
          {(isMcl || hasAvAccess) && (
            <button
              onClick={() => navigate('/avianca')}
              className="bg-white rounded-2xl shadow-xl p-8 text-center hover:scale-105 transition-transform group"
            >
              <img src="/avianca-logo.png" alt="Avianca" className="h-12 mx-auto mb-4 object-contain" />
              <h2 className="text-xl font-bold text-gray-800 mb-2">Avianca Cargo</h2>
              <p className="text-sm text-gray-500">Handling de carga Avianca: tracking, screening, pallet tags y facturación</p>
              <div className="mt-5 inline-block bg-red-600 text-white text-xs font-semibold px-4 py-2 rounded-full group-hover:bg-red-800 transition-colors">
                Ingresar
              </div>
            </button>
          )}
        </div>

        {/* Driver Check-In link */}
        <div className="text-center mt-8">
          <button
            onClick={() => navigate('/driver')}
            className="text-white/50 hover:text-white text-xs underline underline-offset-2 transition-colors"
          >
            Driver Check-In
          </button>
        </div>

      </div>
    </div>
  )
}
