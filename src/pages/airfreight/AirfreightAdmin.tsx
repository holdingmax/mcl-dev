import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import Layout from '../../components/Layout'

export default function AirfreightAdmin() {
  const { isAdmin, isGerente, isAccounting, isSuperAgent, isAgent, isCounter, isBodega, isSoporteIT, userRole } = useAuth()
  const navigate = useNavigate()

  const isMcl = isAdmin || isAccounting || isSuperAgent || isAgent || isCounter || isBodega || isSoporteIT
  // Non-MCL users (clients, viewers) should not reach this page
  if (!isMcl) {
    navigate('/airfreight', { replace: true })
    return null
  }

  // Admin/Accounting see everything; other MCL staff (agent/counter/bodega) only
  // see AWB Log and Screening.
  const canSeeBilling = isAdmin || isAccounting || isSoporteIT

  const items = [
    // AWB Log: trazabilidad documental — todo el staff MCL
    {
      title: 'AWB Log',
      description: 'AWB document traceability: document indicators per airway bill',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
        </svg>
      ),
      href: '/airfreight/awb-log',
      enabled: true,
    },
    // Corte de AWB: módulo de distribución de pallets — todo el staff MCL
    {
      title: 'Corte de AWB',
      description: 'Match distribution pallets to AWBs and write pallet info on documents',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243-4.243 3 3 0 004.243 4.243z" />
        </svg>
      ),
      href: '/airfreight/awb-cut',
      enabled: true,
    },
    // Delivery Orders: lista de DOs generadas — todo el staff MCL
    {
      title: 'Delivery Orders',
      description: 'View and manage generated Delivery Orders',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
        </svg>
      ),
      href: '/airfreight/delivery-orders',
      enabled: true,
    },
    // Pick Up Orders: ordenes de recogida — todo el staff MCL
    {
      title: 'Pick Up Orders',
      description: 'Create and manage Pick Up Orders with authorization letters',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
        </svg>
      ),
      href: '/airfreight/pickup-orders',
      enabled: true,
    },
    // Screening: agente automatizado de certificados Phantom K9 — todo el staff MCL
    {
      title: 'Screening',
      description: 'K9 screening certificates: status, alerts and agent settings',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
      href: '/airfreight/screening',
      enabled: true,
    },
    // Activity Log: todo el staff MCL
    {
      title: 'Activity Log',
      description: 'Change history per client: who did what, when',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
      href: '/airfreight/activity-log',
      enabled: true,
    },
    // Driver Queue: todo el staff MCL
    {
      title: 'Driver Queue',
      description: 'Cola de drivers esperando en el warehouse',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-3-3h-1m-7 5v-2a3 3 0 00-3-3H5a3 3 0 00-3 3v2h14zm-7-9a3 3 0 100-6 3 3 0 000 6zm8 0a3 3 0 100-6 3 3 0 000 6z" />
        </svg>
      ),
      href: '/airfreight/driver-queue',
      enabled: true,
    },
    // Delivery Tracking: todo el staff MCL
    {
      title: 'Delivery Tracking',
      description: 'Real-time tracking de entregas warehouse → airline',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
        </svg>
      ),
      href: '/airfreight/tracking',
      enabled: true,
    },
    // Trucking Vendors: Admin + Soporte IT
    ...((isAdmin || isSoporteIT) ? [{
      title: 'Trucking Vendors',
      description: 'Manage trucking vendors and vendor admin accounts',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
        </svg>
      ),
      href: '/airfreight/vendors',
      enabled: true,
    }] : []),
    // Clientes: Admin y Accounting (read-only para Accounting, pero puede ver)
    ...(canSeeBilling ? [{
      title: 'Clients',
      description: 'Manage clients, contacts and access accounts',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      ),
      href: '/airfreight/clients',
      enabled: true,
    }] : []),
    // Rates: Admin y Accounting (full access)
    ...(canSeeBilling ? [{
      title: 'Rates',
      description: 'Rates and pricing structure per client and destination',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
      href: '/airfreight/rates',
      enabled: true,
    }] : []),
    // Billing: Admin y Accounting
    ...(canSeeBilling ? [{
      title: 'Billing Charges',
      description: 'Airfreight charges per AWB, invoice generation and PDF',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
        </svg>
      ),
      href: '/airfreight/billing/charges',
      enabled: true,
    }, {
      title: 'Billing Summary',
      description: 'Invoice totals, client breakdown and payment status',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
      ),
      href: '/airfreight/billing/summary',
      enabled: true,
    }] : []),
    // Booking Validation: Admin, Super Agent, Soporte IT
    ...((isAdmin || isSuperAgent || isSoporteIT) ? [{
      title: 'Booking Validation',
      description: 'Compare Excel bookings vs system, authorize changes and alerts',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      ),
      href: '/airfreight/validation',
      enabled: true,
    }] : []),
    // ULD Types: Admin + Agent + Soporte IT
    ...((isAdmin || isAgent || isSoporteIT) ? [{
      title: 'ULD Types',
      description: 'Configure ULD types: conf (MD/LD/ESP), type, max weight and tare',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
        </svg>
      ),
      href: '/airfreight/uld-types',
      enabled: true,
    }] : []),
    // Perfiles MCL: Admin (not Gerente) + Soporte IT
    ...((userRole === 'admin' || isSoporteIT) ? [{
      title: 'MCL Profiles',
      description: 'Assign roles: Admin, Accounting, Agent',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
      ),
      href: '/airfreight/mcl-profiles',
      enabled: true,
    }] : []),
    // Planning: Admin + Super Agent + Soporte IT
    ...((isAdmin || isSuperAgent || isSoporteIT) ? [{
      title: 'Planning',
      description: 'Daily operation planning: build-up, deliveries, pickups, K9 and documental',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      ),
      href: '/airfreight/planning',
      enabled: true,
    }] : []),
    // Document Sets: Admin + Soporte IT
    ...((isAdmin || isSoporteIT) ? [{
      title: 'Document Sets',
      description: 'Configure document composition, copies and order per set (Counter, Driver, Envelope)',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
        </svg>
      ),
      href: '/airfreight/doc-sets',
      enabled: true,
    }] : []),
  ]

  return (
    <Layout title="Administration" backTo="/airfreight">
      <div className="max-w-5xl mx-auto space-y-4">
        <p className="text-sm text-gray-500">Air Freight module administration panel</p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map(item => (
            <button
              key={item.title}
              onClick={() => item.enabled && item.href && navigate(item.href)}
              disabled={!item.enabled}
              className={`bg-white rounded-xl border p-6 text-left transition-all ${
                item.enabled
                  ? 'border-gray-200 hover:border-mcl-blue hover:shadow-md cursor-pointer'
                  : 'border-gray-100 opacity-50 cursor-not-allowed'
              }`}
            >
              <div className={`mb-3 ${item.enabled ? 'text-mcl-blue' : 'text-gray-300'}`}>
                {item.icon}
              </div>
              <h3 className="font-semibold text-gray-800 mb-1">{item.title}</h3>
              <p className="text-xs text-gray-400">{item.description}</p>
              {!item.enabled && (
                <span className="mt-2 inline-block text-xs bg-gray-100 text-gray-400 px-2 py-0.5 rounded-full">
                  Coming soon
                </span>
              )}
            </button>
          ))}
        </div>

      </div>
    </Layout>
  )
}
