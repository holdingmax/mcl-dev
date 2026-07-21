import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import Layout from '../../components/Layout'

export default function WSAdmin() {
  const { isAdmin, isAccounting, isSuperAgent, isAgent, isCounter, isBodega, userRole } = useAuth()
  const navigate = useNavigate()

  const isMcl = isAdmin || isAccounting || isSuperAgent || isAgent || isCounter || isBodega
  if (!isMcl) {
    navigate('/warehouse-services', { replace: true })
    return null
  }

  const canSeeBilling = isAdmin || isAccounting
  const canSeeClients = isAdmin || isSuperAgent || isAccounting

  const items = [
    ...(canSeeClients ? [{
      title: 'Clients',
      description: 'Manage Warehouse Services clients',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      ),
      href: '/warehouse-services/clients',
      enabled: true,
    }] : []),
    {
      title: 'Locate Pieces',
      description: 'Scan barcodes to assign warehouse rack locations',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      ),
      href: '/warehouse-services/locate',
      enabled: true,
    },
    {
      title: 'Delivery Orders',
      description: 'Generated delivery orders for cargo dispatch',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
        </svg>
      ),
      href: '/warehouse-services/delivery-orders',
      enabled: true,
    },
    {
      title: 'Delivery Tracking',
      description: 'Real-time driver tracking for WS transport orders',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      ),
      href: '/warehouse-services/delivery-tracking',
      enabled: true,
    },
    {
      title: 'Inventory',
      description: 'Current warehouse inventory (Warehouse Services)',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
        </svg>
      ),
      href: '/warehouse-services/inventory',
      enabled: true,
    },
    ...(canSeeBilling ? [{
      title: 'Rates',
      description: 'Service rates and pricing structure',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
      href: '/warehouse-services/rates',
      enabled: true,
    }] : []),
    ...(canSeeBilling ? [{
      title: 'Billing Charges',
      description: 'Warehouse service charges and invoices',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
        </svg>
      ),
      href: '/warehouse-services/billing/charges',
      enabled: true,
    }] : []),
    ...(canSeeBilling ? [{
      title: 'Invoices',
      description: 'Warehouse Services invoice issuance and management',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      ),
      href: '/warehouse-services/billing/invoices',
      enabled: true,
    }] : []),
    ...(userRole === 'admin' ? [{
      title: 'MCL Profiles',
      description: 'Asignar roles: Admin, Accounting, Agent',
      icon: (
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
      ),
      href: '/warehouse-services/mcl-profiles',
      enabled: false,
    }] : []),
  ]

  return (
    <Layout title="WS Administration" backTo="/warehouse-services">
      <div className="max-w-2xl mx-auto space-y-4">
        <p className="text-sm text-gray-500">Warehouse Services administration panel</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
