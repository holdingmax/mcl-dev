import Layout from '../components/Layout'
import { Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

export default function BillingDashboard() {
  const { isAdmin, userRole } = useAuth()

  return (
    <Layout title="Facturación" backTo="/sea">
      <div className="max-w-4xl mx-auto">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <Link to="/billing/rates"
            className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 hover:shadow-md transition-shadow group">
            <div className="w-10 h-10 rounded-lg bg-mcl-blue/10 flex items-center justify-center mb-3 group-hover:bg-mcl-blue/20 transition-colors">
              <svg className="w-5 h-5 text-mcl-blue" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
            </div>
            <h3 className="font-semibold text-gray-800 mb-1">Tarifario</h3>
            <p className="text-xs text-gray-400">Gestionar tarifas generales y por cliente</p>
          </Link>

          <Link to="/billing/charges"
            className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 hover:shadow-md transition-shadow group">
            <div className="w-10 h-10 rounded-lg bg-green-50 flex items-center justify-center mb-3 group-hover:bg-green-100 transition-colors">
              <svg className="w-5 h-5 text-green-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
              </svg>
            </div>
            <h3 className="font-semibold text-gray-800 mb-1">Cargos por WR</h3>
            <p className="text-xs text-gray-400">Ver cargos de recepción calculados</p>
          </Link>

          <Link to="/billing/clients"
            className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 hover:shadow-md transition-shadow group">
            <div className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center mb-3 group-hover:bg-amber-100 transition-colors">
              <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
              </svg>
            </div>
            <h3 className="font-semibold text-gray-800 mb-1">Resumen por Cliente</h3>
            <p className="text-xs text-gray-400">Total de cargos agrupados por cliente</p>
          </Link>

          <Link to="/billing/accounts"
            className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 hover:shadow-md transition-shadow group">
            <div className="w-10 h-10 rounded-lg bg-teal-50 flex items-center justify-center mb-3 group-hover:bg-teal-100 transition-colors">
              <svg className="w-5 h-5 text-teal-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
            </div>
            <h3 className="font-semibold text-gray-800 mb-1">Cuentas de Acceso</h3>
            <p className="text-xs text-gray-400">Crear y gestionar cuentas de acceso al portal por cliente</p>
          </Link>

          <Link to="/clients"
            className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 hover:shadow-md transition-shadow group">
            <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center mb-3 group-hover:bg-emerald-100 transition-colors">
              <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
            </div>
            <h3 className="font-semibold text-gray-800 mb-1">Shippers/Consignees Clientes</h3>
            <p className="text-xs text-gray-400">Gestionar shippers, consignatarios y datos de clientes</p>
          </Link>

          <Link to="/billing/profiles"
            className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 hover:shadow-md transition-shadow group">
            <div className="w-10 h-10 rounded-lg bg-purple-50 flex items-center justify-center mb-3 group-hover:bg-purple-100 transition-colors">
              <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <h3 className="font-semibold text-gray-800 mb-1">Cuentas Facturación Clientes</h3>
            <p className="text-xs text-gray-400">Datos de cliente, contactos y condiciones de pago por destino</p>
          </Link>

          <Link to="/billing/kpi"
            className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 hover:shadow-md transition-shadow group">
            <div className="w-10 h-10 rounded-lg bg-indigo-50 flex items-center justify-center mb-3 group-hover:bg-indigo-100 transition-colors">
              <svg className="w-5 h-5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            </div>
            <h3 className="font-semibold text-gray-800 mb-1">KPI Dashboard</h3>
            <p className="text-xs text-gray-400">Flujo, permanencia, contenedores, navieras y rentabilidad</p>
          </Link>

          {userRole === 'admin' && (
            <Link to="/sea/mcl-profiles"
              className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 hover:shadow-md transition-shadow group">
              <div className="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center mb-3 group-hover:bg-red-100 transition-colors">
                <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
                </svg>
              </div>
              <h3 className="font-semibold text-gray-800 mb-1">Perfiles MCL</h3>
              <p className="text-xs text-gray-400">Gestionar roles y permisos del equipo MCL en Sea Freight</p>
            </Link>
          )}
        </div>

      </div>
    </Layout>
  )
}
