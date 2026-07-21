import { lazy, Suspense, Component, type ReactNode, type ErrorInfo } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import Login from './pages/Login'
import ModuleSelector from './pages/ModuleSelector'
import ForcePasswordChangeModal from './components/ForcePasswordChangeModal'
import InAppBrowserBlock from './components/InAppBrowserBlock'

// Lazy-loaded pages — Sea Freight
const Dashboard = lazy(() => import('./pages/Dashboard'))
const CounterNew = lazy(() => import('./pages/CounterNew'))
const PhysicalReception = lazy(() => import('./pages/PhysicalReception'))
const WRPrint = lazy(() => import('./pages/WRPrint'))
const Setup = lazy(() => import('./pages/Setup'))
const Inventory = lazy(() => import('./pages/Inventory'))
const Dispatches = lazy(() => import('./pages/Dispatches'))
const DispatchNew = lazy(() => import('./pages/DispatchNew'))
const DispatchCorrection = lazy(() => import('./pages/DispatchCorrection'))
const GateOutHistory = lazy(() => import('./pages/GateOutHistory'))
const InventoryDocuments = lazy(() => import('./pages/InventoryDocuments'))
const LocatePiece = lazy(() => import('./pages/LocatePiece'))
const ClientAdmin = lazy(() => import('./pages/ClientAdmin'))
const BillingDashboard = lazy(() => import('./pages/BillingDashboard'))
const BillingRates = lazy(() => import('./pages/BillingRates'))
const BillingCharges = lazy(() => import('./pages/BillingCharges'))
const BillingClientSummary = lazy(() => import('./pages/BillingClientSummary'))
const BillingProfiles = lazy(() => import('./pages/BillingProfiles'))
const ClientAccounts = lazy(() => import('./pages/ClientAccounts'))
const SeafreightMclProfiles = lazy(() => import('./pages/SeafreightMclProfiles'))

// Lazy-loaded pages — Air Freight
const AirfreightDashboard = lazy(() => import('./pages/airfreight/AirfreightDashboard'))
const AirfreightAdmin = lazy(() => import('./pages/airfreight/AirfreightAdmin'))
const AirfreightBookingNew = lazy(() => import('./pages/airfreight/AirfreightBookingNew'))
const AirfreightBookingDetail = lazy(() => import('./pages/airfreight/AirfreightBookingDetail'))
const AirfreightClients = lazy(() => import('./pages/airfreight/AirfreightClients'))
const AirfreightDestinations = lazy(() => import('./pages/airfreight/AirfreightDestinations'))
const AirfreightDocs = lazy(() => import('./pages/airfreight/AirfreightDocs'))
const AirfreightRates = lazy(() => import('./pages/airfreight/AirfreightRates'))
const AirfreightScreening = lazy(() => import('./pages/airfreight/AirfreightScreening'))
const AirfreightScreeningDetail = lazy(() => import('./pages/airfreight/AirfreightScreeningDetail'))
const AirfreightUldControl = lazy(() => import('./pages/airfreight/AirfreightUldControl'))
const AirfreightUldTypes = lazy(() => import('./pages/airfreight/AirfreightUldTypes'))
const AirfreightBuildup = lazy(() => import('./pages/airfreight/AirfreightBuildup'))
const AirfreightHolds = lazy(() => import('./pages/airfreight/AirfreightHolds'))
const AirfreightTransportation = lazy(() => import('./pages/airfreight/AirfreightTransportation'))
const AirfreightMclProfiles = lazy(() => import('./pages/airfreight/AirfreightMclProfiles'))
const AirfreightAwbLog = lazy(() => import('./pages/airfreight/AirfreightAwbLog'))
const AirfreightAwbDiag = lazy(() => import('./pages/airfreight/AirfreightAwbDiag'))
const AirfreightValidation = lazy(() => import('./pages/airfreight/AirfreightValidation'))
const AirfreightBookingList = lazy(() => import('./pages/airfreight/AirfreightBookingList'))
const AirfreightActivityLog = lazy(() => import('./pages/airfreight/AirfreightActivityLog'))
const AirfreightExportBooking = lazy(() => import('./pages/airfreight/AirfreightExportBooking'))
const AirfreightDeliveryOrder = lazy(() => import('./pages/airfreight/AirfreightDeliveryOrder'))
const AirfreightAwbCut = lazy(() => import('./pages/airfreight/AirfreightAwbCut'))
const AirfreightDeliveryOrders = lazy(() => import('./pages/airfreight/AirfreightDeliveryOrders'))
const AirfreightPickupOrder = lazy(() => import('./pages/airfreight/AirfreightPickupOrder'))
const AirfreightPickupOrders = lazy(() => import('./pages/airfreight/AirfreightPickupOrders'))
const AirfreightBillingCharges = lazy(() => import('./pages/airfreight/AirfreightBillingCharges'))
// AirfreightBillingProfiles removed — billing config moved to AirfreightClients
const AirfreightBillingSummary = lazy(() => import('./pages/airfreight/AirfreightBillingSummary'))
const AirfreightDriverQueue = lazy(() => import('./pages/airfreight/AirfreightDriverQueue'))
const AirfreightTracking = lazy(() => import('./pages/airfreight/AirfreightTracking'))
const AirfreightVendors = lazy(() => import('./pages/airfreight/AirfreightVendors'))
const AirfreightVendorTracking = lazy(() => import('./pages/airfreight/AirfreightVendorTracking'))
const AirfreightDocReceptionList = lazy(() => import('./pages/airfreight/AirfreightDocReceptionList'))
const AirfreightDocReceptionNew = lazy(() => import('./pages/airfreight/AirfreightDocReceptionNew'))
const AirfreightPhysicalReception = lazy(() => import('./pages/airfreight/AirfreightPhysicalReception'))
const AirfreightDoFromUld = lazy(() => import('./pages/airfreight/AirfreightDoFromUld'))
const AirfreightFlightAssignment = lazy(() => import('./pages/airfreight/AirfreightFlightAssignment'))
const AirfreightShippersConsignees = lazy(() => import('./pages/airfreight/AirfreightShippersConsignees'))
const AirfreightDocSets = lazy(() => import('./pages/airfreight/AirfreightDocSets'))
const AirfreightPlanning = lazy(() => import('./pages/airfreight/AirfreightPlanning'))
const AirfreightFlightTracking = lazy(() => import('./pages/airfreight/AirfreightFlightTracking'))
// Lazy-loaded pages — Warehouse Services
const WSDashboard = lazy(() => import('./pages/warehouse-services/WSDashboard'))
const WSOrderNew = lazy(() => import('./pages/warehouse-services/WSOrderNew'))
const WSOrderDetail = lazy(() => import('./pages/warehouse-services/WSOrderDetail'))
const WSReception = lazy(() => import('./pages/warehouse-services/WSReception'))
const WSClients = lazy(() => import('./pages/warehouse-services/WSClients'))
const WSScreening = lazy(() => import('./pages/warehouse-services/WSScreening'))
const WSDeliveryOrders = lazy(() => import('./pages/warehouse-services/WSDeliveryOrders'))
const WSDeliveryOrderNew = lazy(() => import('./pages/warehouse-services/WSDeliveryOrderNew'))
const WSDeliveryOrderView = lazy(() => import('./pages/warehouse-services/WSDeliveryOrderView'))
const WSProofOfServiceView = lazy(() => import('./pages/warehouse-services/WSProofOfServiceView'))
const WSInventory = lazy(() => import('./pages/warehouse-services/WSInventory'))
const WSAdmin = lazy(() => import('./pages/warehouse-services/WSAdmin'))
const WSBillingCharges = lazy(() => import('./pages/warehouse-services/WSBillingCharges'))
const WSInvoices = lazy(() => import('./pages/warehouse-services/WSInvoices'))
const WSRates = lazy(() => import('./pages/warehouse-services/WSRates'))
const WSLocatePiece = lazy(() => import('./pages/warehouse-services/WSLocatePiece'))
const WSDeliveryTrackingPage = lazy(() => import('./pages/warehouse-services/WSDeliveryTracking'))
const WSKpiDashboard = lazy(() => import('./pages/warehouse-services/WSKpiDashboard'))

// Lazy-loaded pages — Monitoring
const MonitoringHub = lazy(() => import('./pages/monitoring/MonitoringHub'))
const SystemPerformance = lazy(() => import('./pages/monitoring/SystemPerformance'))
const ModuleMetrics = lazy(() => import('./pages/monitoring/ModuleMetrics'))
const AgentsDashboard = lazy(() => import('./pages/monitoring/AgentsDashboard'))
const DeployDashboard = lazy(() => import('./pages/monitoring/DeployDashboard'))
const DataIntegrity = lazy(() => import('./pages/monitoring/DataIntegrity'))

// Lazy-loaded pages — Avianca Cargo
const AvDashboard = lazy(() => import('./pages/avianca/AvDashboard'))
const AvFlightTracking = lazy(() => import('./pages/avianca/AvFlightTracking'))
const AvBilling = lazy(() => import('./pages/avianca/AvBilling'))
const AvConfig = lazy(() => import('./pages/avianca/AvConfig'))
const AvScreening = lazy(() => import('./pages/avianca/AvScreening'))
const AvCheckManifest = lazy(() => import('./pages/avianca/AvCheckManifest'))
const AvDeliveryOrders = lazy(() => import('./pages/avianca/AvDeliveryOrders'))
const AvDeliveryOrderNew = lazy(() => import('./pages/avianca/AvDeliveryOrderNew'))
const AvAwbLog = lazy(() => import('./pages/avianca/AvAwbLog'))
const AvDeliveryTracking = lazy(() => import('./pages/avianca/AvDeliveryTracking'))

const DriverMobile = lazy(() => import('./pages/DriverMobile'))
const MobileEditDO = lazy(() => import('./pages/MobileEditDO'))

const Spinner = () => (
  <div className="min-h-screen flex items-center justify-center">
    <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-mcl-blue" />
  </div>
)

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: Error | null }> {
  state = { hasError: false, error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { hasError: true, error } }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info)
    // Auto-reload on stale chunk errors (happens after deploy when old JS files are gone)
    if (error.message?.includes('dynamically imported module') || error.message?.includes('Failed to fetch')) {
      window.location.reload()
    }
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50">
          <div className="text-center space-y-4 p-8">
            <h1 className="text-xl font-bold text-gray-800">Something went wrong</h1>
            <p className="text-sm text-gray-500">{this.state.error?.message}</p>
            <button onClick={() => window.location.reload()} className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700">
              Reload page
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <Spinner />
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

function SeaRoute({ children, allowClient }: { children: React.ReactNode; allowClient?: boolean }) {
  const { user, loading, isClient, hasSeaAccess } = useAuth()
  if (loading) return <Spinner />
  if (!user) return <Navigate to="/login" replace />
  // Clients without sea access go to airfreight
  if (isClient && !hasSeaAccess) return <Navigate to="/airfreight" replace />
  // Clients go to inventory unless the route explicitly allows them
  if (isClient && !allowClient) return <Navigate to="/inventory" replace />
  return <>{children}</>
}

// Admin + agent only (soporte_it gets read-only access)
function OperationalRoute({ children }: { children: React.ReactNode }) {
  const { user, loading, canEdit, isSoporteIT } = useAuth()
  if (loading) return <Spinner />
  if (!user) return <Navigate to="/login" replace />
  if (!canEdit && !isSoporteIT) return <Navigate to="/" replace />
  return <>{children}</>
}

// Admin + accounting only (soporte_it gets read-only access)
function BillingRoute({ allowSuperAgent, children }: { allowSuperAgent?: boolean; children: React.ReactNode }) {
  const { user, loading, isBilling, isSuperAgent, isSoporteIT } = useAuth()
  if (loading) return <Spinner />
  if (!user) return <Navigate to="/login" replace />
  if (!isBilling && !(allowSuperAgent && isSuperAgent) && !isSoporteIT) return <Navigate to="/" replace />
  return <>{children}</>
}

// Air billing: admin/accounting full, clients read-only if charge_visibility_enabled
function AirBillingRoute({ children }: { children: React.ReactNode }) {
  const { user, loading, isBilling, isSoporteIT, isClient, hasAirAccess, canViewCharges } = useAuth()
  if (loading) return <Spinner />
  if (!user) return <Navigate to="/login" replace />
  if (isBilling || isSoporteIT) return <>{children}</>
  if (isClient && hasAirAccess && canViewCharges) return <>{children}</>
  return <Navigate to="/airfreight" replace />
}

// Airfreight access guard
// Paths clients can access (everything else is MCL-internal)
const CLIENT_ALLOWED_PATHS = [
  '/airfreight',
  '/airfreight/booking-list',
  '/airfreight/bookings/new',
  '/airfreight/bookings/export',
  '/airfreight/holds',
  '/airfreight/docs',
  '/airfreight/billing/charges',
  '/airfreight/doc-reception',
]

// Paths distribuidores can access (Build-up, New DO, Edit DO only)
const DISTRIBUIDOR_ALLOWED_PATHS = [
  '/airfreight',
  '/airfreight/buildup',
  '/airfreight/do-from-uld',
  '/airfreight/delivery-orders',
  '/airfreight/doc-reception',
  '/airfreight/physical-reception',
]

function AirRoute({ children }: { children: React.ReactNode }) {
  const { user, loading, hasAirAccess, isViewer, isVendorAdmin, isClient, isDistribuidor, hasUldAccess } = useAuth()
  const location = useLocation()
  if (loading) return <Spinner />
  if (!user) return <Navigate to="/login" replace />
  if (!hasAirAccess) return <Navigate to="/" replace />
  // Vendor admins can only access their tracking page
  if (isVendorAdmin) return <Navigate to="/airfreight/vendor-tracking" replace />
  // Viewers (read-only doc access) can only reach the dashboard and docs page
  if (isViewer) {
    const path = location.pathname
    const allowed = path === '/airfreight' || path === '/airfreight/docs'
    if (!allowed) return <Navigate to="/airfreight" replace />
  }
  // Distribuidores can only access Build-up, New DO, Edit DO
  if (isDistribuidor) {
    const path = location.pathname
    const allowed = DISTRIBUIDOR_ALLOWED_PATHS.some(p => path === p) ||
      path.startsWith('/airfreight/delivery-order/')
    if (!allowed) return <Navigate to="/airfreight" replace />
  }
  // Clients can only access their own booking/holds/docs/billing pages
  if (isClient) {
    const path = location.pathname
    const allowed = CLIENT_ALLOWED_PATHS.some(p => path === p) ||
      path.startsWith('/airfreight/bookings/') ||
      path.startsWith('/airfreight/billing/') ||
      (path === '/airfreight/uld' && hasUldAccess)
    if (!allowed) return <Navigate to="/airfreight" replace />
  }
  return <>{children}</>
}

// Paths WS clients can access (everything else is MCL-internal)
const WS_CLIENT_ALLOWED_PATHS = [
  '/warehouse-services',
  '/warehouse-services/orders/new',
  '/warehouse-services/billing/charges',
  '/warehouse-services/billing/invoices',
]

// Warehouse Services access guard
function WarehouseRoute({ children }: { children: React.ReactNode }) {
  const { user, loading, hasWarehouseAccess, isClient } = useAuth()
  const location = useLocation()
  if (loading) return <Spinner />
  if (!user) return <Navigate to="/login" replace />
  if (!hasWarehouseAccess) return <Navigate to="/" replace />
  // Clients can only access their own orders/billing pages
  if (isClient) {
    const path = location.pathname
    const allowed = WS_CLIENT_ALLOWED_PATHS.some(p => path === p) ||
      path.startsWith('/warehouse-services/orders/') ||
      path.startsWith('/warehouse-services/pos/') ||
      path.startsWith('/warehouse-services/billing/')
    if (!allowed) return <Navigate to="/warehouse-services" replace />
  }
  return <>{children}</>
}

// Vendor admin only
function VendorRoute({ children }: { children: React.ReactNode }) {
  const { user, loading, isVendorAdmin } = useAuth()
  if (loading) return <Spinner />
  if (!user) return <Navigate to="/login" replace />
  if (!isVendorAdmin) return <Navigate to="/" replace />
  return <>{children}</>
}

// Avianca module: MCL with avianca access + av_viewer
// mclOnly=true blocks av_viewer (for config, billing, log)
function AvRoute({ children, mclOnly }: { children: React.ReactNode; mclOnly?: boolean }) {
  const { user, loading, hasAvAccess, isAvViewer } = useAuth()
  if (loading) return <Spinner />
  if (!user) return <Navigate to="/login" replace />
  if (!hasAvAccess) return <Navigate to="/select" replace />
  if (mclOnly && isAvViewer) return <Navigate to="/avianca" replace />
  return <>{children}</>
}

/** Post-login redirect: decide where to send the user */
function HomeRedirect() {
  const { loading, hasSeaAccess, hasAirAccess, hasWarehouseAccess, isClient, isEcommerceClient, isViewer, isVendorAdmin } = useAuth()
  if (loading) return <Spinner />
  // Vendor admins always land on their tracking page
  if (isVendorAdmin) return <Navigate to="/airfreight/vendor-tracking" replace />
  // Viewers always land on airfreight dashboard
  if (isViewer) return <Navigate to="/airfreight" replace />

  const moduleCount = [hasSeaAccess, hasAirAccess, hasWarehouseAccess].filter(Boolean).length

  // Ecommerce client → booking list is the primary landing
  const airfreightLanding = isEcommerceClient ? '/airfreight/booking-list' : '/airfreight'
  if (isClient) {
    if (moduleCount > 1) return <Navigate to="/select" replace />
    if (hasSeaAccess) return <Navigate to="/inventory" replace />
    if (hasAirAccess) return <Navigate to={airfreightLanding} replace />
    if (hasWarehouseAccess) return <Navigate to="/warehouse-services" replace />
    return <Navigate to={airfreightLanding} replace />
  }
  // MCL staff
  if (moduleCount === 1) {
    if (hasSeaAccess) return <Navigate to="/sea" replace />
    if (hasAirAccess) return <Navigate to="/airfreight" replace />
    if (hasWarehouseAccess) return <Navigate to="/warehouse-services" replace />
  }
  return <Navigate to="/select" replace />
}

function AppRoutes() {
  const { user } = useAuth()
  return (
    <ErrorBoundary>
    <Suspense fallback={<Spinner />}>
      <ForcePasswordChangeModal />
      <Routes>
        <Route path="/login" element={user ? <HomeRedirect /> : <Login />} />
        <Route path="/" element={<ProtectedRoute><HomeRedirect /></ProtectedRoute>} />
        <Route path="/select" element={<ProtectedRoute><ModuleSelector /></ProtectedRoute>} />

        {/* Sea Freight */}
        <Route path="/sea" element={<SeaRoute><Dashboard /></SeaRoute>} />
        <Route path="/setup" element={<OperationalRoute><Setup /></OperationalRoute>} />
        <Route path="/counter/new" element={<OperationalRoute><CounterNew /></OperationalRoute>} />
        <Route path="/counter/:id/edit" element={<OperationalRoute><CounterNew /></OperationalRoute>} />
        <Route path="/reception/:id" element={<OperationalRoute><PhysicalReception /></OperationalRoute>} />
        <Route path="/wr/:id/print" element={<ProtectedRoute><WRPrint /></ProtectedRoute>} />
        <Route path="/inventory" element={<SeaRoute allowClient><Inventory /></SeaRoute>} />
        <Route path="/dispatches" element={<SeaRoute allowClient><Dispatches /></SeaRoute>} />
        <Route path="/dispatches/new" element={<OperationalRoute><DispatchNew /></OperationalRoute>} />
        <Route path="/dispatches/:id/confirm" element={<OperationalRoute><DispatchNew /></OperationalRoute>} />
        <Route path="/dispatches/:id/edit" element={<OperationalRoute><DispatchNew /></OperationalRoute>} />
        <Route path="/dispatches/:id/correct" element={<OperationalRoute><DispatchCorrection /></OperationalRoute>} />
        <Route path="/gate-out-history" element={<SeaRoute allowClient><GateOutHistory /></SeaRoute>} />
        <Route path="/inventory-documents" element={<SeaRoute allowClient><InventoryDocuments /></SeaRoute>} />
        <Route path="/locate" element={<SeaRoute><LocatePiece /></SeaRoute>} />
        <Route path="/clients" element={<BillingRoute allowSuperAgent><ClientAdmin /></BillingRoute>} />
        <Route path="/clients/new" element={<BillingRoute allowSuperAgent><ClientAdmin /></BillingRoute>} />
        <Route path="/clients/:id/edit" element={<BillingRoute allowSuperAgent><ClientAdmin /></BillingRoute>} />
        <Route path="/billing" element={<BillingRoute><BillingDashboard /></BillingRoute>} />
        <Route path="/billing/rates" element={<BillingRoute><BillingRates /></BillingRoute>} />
        <Route path="/billing/charges" element={<SeaRoute allowClient><BillingCharges /></SeaRoute>} />
        <Route path="/billing/clients" element={<BillingRoute><BillingClientSummary /></BillingRoute>} />
        <Route path="/billing/profiles" element={<BillingRoute><BillingProfiles /></BillingRoute>} />
        <Route path="/billing/accounts" element={<BillingRoute><ClientAccounts /></BillingRoute>} />
        <Route path="/billing/kpi" element={<BillingRoute><WSKpiDashboard /></BillingRoute>} />
        <Route path="/sea/mcl-profiles" element={<BillingRoute><SeafreightMclProfiles /></BillingRoute>} />

        {/* Air Freight */}
        <Route path="/airfreight" element={<AirRoute><AirfreightDashboard /></AirRoute>} />
        <Route path="/airfreight/booking-list" element={<AirRoute><AirfreightBookingList /></AirRoute>} />
        <Route path="/airfreight/admin" element={<AirRoute><AirfreightAdmin /></AirRoute>} />
        <Route path="/airfreight/planning" element={<AirRoute><AirfreightPlanning /></AirRoute>} />
        <Route path="/airfreight/mcl-profiles" element={<AirRoute><AirfreightMclProfiles /></AirRoute>} />
        <Route path="/airfreight/bookings/new" element={<AirRoute><AirfreightBookingNew /></AirRoute>} />
        <Route path="/airfreight/bookings/export" element={<AirRoute><AirfreightExportBooking /></AirRoute>} />
        <Route path="/airfreight/bookings/:id" element={<AirRoute><AirfreightBookingDetail /></AirRoute>} />
        <Route path="/airfreight/clients" element={<AirRoute><AirfreightClients /></AirRoute>} />
        <Route path="/airfreight/destinations" element={<AirRoute><AirfreightDestinations /></AirRoute>} />
        <Route path="/airfreight/users" element={<Navigate to="/airfreight/clients" replace />} />
        <Route path="/airfreight/docs" element={<AirRoute><AirfreightDocs /></AirRoute>} />
        <Route path="/airfreight/rates" element={<AirRoute><AirfreightRates /></AirRoute>} />
        <Route path="/airfreight/screening" element={<AirRoute><AirfreightScreening /></AirRoute>} />
        <Route path="/airfreight/screening/:bookingId" element={<AirRoute><AirfreightScreeningDetail /></AirRoute>} />
        <Route path="/airfreight/uld" element={<AirRoute><AirfreightUldControl /></AirRoute>} />
        <Route path="/airfreight/uld-types" element={<AirRoute><AirfreightUldTypes /></AirRoute>} />
        <Route path="/airfreight/buildup" element={<AirRoute><AirfreightBuildup /></AirRoute>} />
        <Route path="/airfreight/holds" element={<AirRoute><AirfreightHolds /></AirRoute>} />
        <Route path="/airfreight/transportation" element={<AirRoute><AirfreightTransportation /></AirRoute>} />
        <Route path="/airfreight/activity-log" element={<AirRoute><AirfreightActivityLog /></AirRoute>} />
        <Route path="/airfreight/awb-log" element={<AirRoute><AirfreightAwbLog /></AirRoute>} />
        <Route path="/airfreight/awb-diag" element={<AirRoute><AirfreightAwbDiag /></AirRoute>} />
        <Route path="/airfreight/validation" element={<AirRoute><AirfreightValidation /></AirRoute>} />
        <Route path="/airfreight/delivery-orders" element={<AirRoute><AirfreightDeliveryOrders /></AirRoute>} />
        <Route path="/airfreight/awb-cut" element={<AirRoute><AirfreightAwbCut /></AirRoute>} />
        <Route path="/airfreight/awb-cut/flight/:flightId" element={<AirRoute><AirfreightAwbCut /></AirRoute>} />
        <Route path="/airfreight/delivery-order/new" element={<AirRoute><AirfreightDeliveryOrder /></AirRoute>} />
        <Route path="/airfreight/delivery-order/doc/:doDocId" element={<AirRoute><AirfreightDeliveryOrder /></AirRoute>} />
        <Route path="/airfreight/delivery-order/:bookingId/:awbIndex" element={<AirRoute><AirfreightDeliveryOrder /></AirRoute>} />
        <Route path="/airfreight/pickup-orders" element={<AirRoute><AirfreightPickupOrders /></AirRoute>} />
        <Route path="/airfreight/pickup-order/new" element={<AirRoute><AirfreightPickupOrder /></AirRoute>} />
        <Route path="/airfreight/pickup-order/:puId" element={<AirRoute><AirfreightPickupOrder /></AirRoute>} />
        <Route path="/airfreight/billing/charges" element={<AirBillingRoute><AirfreightBillingCharges /></AirBillingRoute>} />
        {/* billing/profiles removed — config moved to airfreight/clients */}
        <Route path="/airfreight/billing/summary" element={<BillingRoute><AirfreightBillingSummary /></BillingRoute>} />
        <Route path="/airfreight/driver-queue" element={<AirRoute><AirfreightDriverQueue /></AirRoute>} />
        <Route path="/airfreight/tracking" element={<AirRoute><AirfreightTracking /></AirRoute>} />
        <Route path="/airfreight/vendors" element={<AirRoute><AirfreightVendors /></AirRoute>} />
        <Route path="/airfreight/vendor-tracking" element={<VendorRoute><AirfreightVendorTracking /></VendorRoute>} />
        <Route path="/airfreight/doc-reception" element={<AirRoute><AirfreightDocReceptionList /></AirRoute>} />
        <Route path="/airfreight/doc-reception/new" element={<AirRoute><AirfreightDocReceptionNew /></AirRoute>} />
        <Route path="/airfreight/doc-reception/:id/edit" element={<AirRoute><AirfreightDocReceptionNew /></AirRoute>} />
        <Route path="/airfreight/physical-reception" element={<AirRoute><AirfreightPhysicalReception /></AirRoute>} />
        <Route path="/airfreight/do-from-uld" element={<AirRoute><AirfreightDoFromUld /></AirRoute>} />
        <Route path="/airfreight/flight-tracking" element={<AirRoute><AirfreightFlightTracking /></AirRoute>} />
        <Route path="/airfreight/flight-assignment" element={<AirRoute><AirfreightFlightAssignment /></AirRoute>} />
        <Route path="/airfreight/shippers-consignees" element={<AirRoute><AirfreightShippersConsignees /></AirRoute>} />
        <Route path="/airfreight/doc-sets" element={<AirRoute><AirfreightDocSets /></AirRoute>} />

        {/* Warehouse Services */}
        <Route path="/warehouse-services" element={<WarehouseRoute><WSDashboard /></WarehouseRoute>} />
        <Route path="/warehouse-services/orders/new" element={<WarehouseRoute><WSOrderNew /></WarehouseRoute>} />
        <Route path="/warehouse-services/orders/:id" element={<WarehouseRoute><WSOrderDetail /></WarehouseRoute>} />
        <Route path="/warehouse-services/reception/:id" element={<WarehouseRoute><WSReception /></WarehouseRoute>} />
        <Route path="/warehouse-services/screening/:id" element={<WarehouseRoute><WSScreening /></WarehouseRoute>} />
        <Route path="/warehouse-services/delivery-orders" element={<WarehouseRoute><WSDeliveryOrders /></WarehouseRoute>} />
        <Route path="/warehouse-services/delivery-tracking" element={<WarehouseRoute><WSDeliveryTrackingPage /></WarehouseRoute>} />
        <Route path="/warehouse-services/delivery-order/new" element={<WarehouseRoute><WSDeliveryOrderNew /></WarehouseRoute>} />
        <Route path="/warehouse-services/delivery-order/:id" element={<WarehouseRoute><WSDeliveryOrderView /></WarehouseRoute>} />
        <Route path="/warehouse-services/pos/:soId" element={<WarehouseRoute><WSProofOfServiceView /></WarehouseRoute>} />
        <Route path="/warehouse-services/inventory" element={<WarehouseRoute><WSInventory /></WarehouseRoute>} />
        <Route path="/warehouse-services/clients" element={<WarehouseRoute><WSClients /></WarehouseRoute>} />
        <Route path="/warehouse-services/admin" element={<WarehouseRoute><WSAdmin /></WarehouseRoute>} />
        <Route path="/warehouse-services/billing/charges" element={<WarehouseRoute><WSBillingCharges /></WarehouseRoute>} />
        <Route path="/warehouse-services/billing/invoices" element={<WarehouseRoute><WSInvoices /></WarehouseRoute>} />
        <Route path="/warehouse-services/rates" element={<WarehouseRoute><WSRates /></WarehouseRoute>} />
        <Route path="/warehouse-services/locate" element={<WarehouseRoute><WSLocatePiece /></WarehouseRoute>} />

        {/* Avianca Cargo */}
        <Route path="/avianca" element={<AvRoute><AvDashboard /></AvRoute>} />
        <Route path="/avianca/flight/:id" element={<AvRoute><AvFlightTracking /></AvRoute>} />
        <Route path="/avianca/billing" element={<AvRoute mclOnly><AvBilling /></AvRoute>} />
        <Route path="/avianca/config" element={<AvRoute mclOnly><AvConfig /></AvRoute>} />
        <Route path="/avianca/flight/:id/screening" element={<AvRoute><AvScreening /></AvRoute>} />
        <Route path="/avianca/flight/:id/manifest" element={<AvRoute><AvCheckManifest /></AvRoute>} />
        <Route path="/avianca/flight/:id/delivery-orders" element={<AvRoute><AvDeliveryOrders /></AvRoute>} />
        <Route path="/avianca/flight/:id/do/new" element={<AvRoute mclOnly><AvDeliveryOrderNew /></AvRoute>} />
        <Route path="/avianca/log" element={<AvRoute mclOnly><AvAwbLog /></AvRoute>} />
        <Route path="/avianca/tracking" element={<AvRoute><AvDeliveryTracking /></AvRoute>} />

        {/* Monitoring — Admin only */}
        <Route path="/monitoring" element={<OperationalRoute><MonitoringHub /></OperationalRoute>} />
        <Route path="/monitoring/performance" element={<OperationalRoute><SystemPerformance /></OperationalRoute>} />
        <Route path="/monitoring/modules" element={<OperationalRoute><ModuleMetrics /></OperationalRoute>} />
        <Route path="/monitoring/agents" element={<OperationalRoute><AgentsDashboard /></OperationalRoute>} />
        <Route path="/monitoring/deploys" element={<OperationalRoute><DeployDashboard /></OperationalRoute>} />
        <Route path="/monitoring/integrity" element={<OperationalRoute><DataIntegrity /></OperationalRoute>} />

        {/* Public: Driver mobile check-in (no auth) */}
        <Route path="/driver" element={<DriverMobile />} />
        <Route path="/edit-do" element={<MobileEditDO />} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
    </ErrorBoundary>
  )
}

export default function App() {
  // Block in-app browsers (WhatsApp, Gmail, Instagram, etc.): Google OAuth
  // can't persist state in their partitioned storage, causing 400 errors.
  const ua = navigator.userAgent || ''
  const isInAppBrowser = /WhatsApp|FBAN|FBAV|Instagram|GSA\/|Gmail/i.test(ua)
    || ((/iPhone|iPad/i.test(ua)) && !(/Safari/i.test(ua)) && !(/CriOS/i.test(ua)))
  if (isInAppBrowser) {
    return <InAppBrowserBlock />
  }
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  )
}
