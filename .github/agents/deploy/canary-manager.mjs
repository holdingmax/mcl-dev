// ═══ Canary Manager — Deploy Plan State Machine ═══
// Manages the sequential deployment plan from DEPLOYMENT_PLAN.md

// Deploy plan — ordered by priority. Each item is a canary step.
const DEPLOY_PLAN = [
  {
    id: 'sol-1',
    name: 'useMemo AuthContext',
    featureFlag: null, // No flag needed — pure code change
    description: 'Envolver AuthContext value en useMemo con useCallback en 7 funciones. 71 consumers afectados.',
    riskLevel: 'high',
    requiredCodeDeploy: true,
    validations: ['login_logout', 'module_navigation', 'client_view', 'auto_logout'],
  },
  {
    id: 'sol-8',
    name: 'AWB Search Optimization',
    featureFlag: 'awb_search_v2',
    description: 'Cache local de bookings para busqueda AWB en DocReceptionNew. Reemplaza full scan.',
    riskLevel: 'high',
    requiredCodeDeploy: true,
    validations: ['awb_search_simple', 'awb_search_ecommerce', 'awb_search_mawb', 'awb_search_no_match'],
  },
  {
    id: 'sol-16a',
    name: 'writeBatch airBilling',
    featureFlag: null,
    description: 'Convertir addDoc loop a writeBatch en airBilling.ts L280-282.',
    riskLevel: 'medium',
    requiredCodeDeploy: true,
    validations: ['billing_recalculate_3_flights', 'billing_montos_match'],
  },
  {
    id: 'sol-16b',
    name: 'writeBatch billing.ts',
    featureFlag: null,
    description: 'Convertir addDoc loop a writeBatch en billing.ts L191-203 (reception charges).',
    riskLevel: 'medium',
    requiredCodeDeploy: true,
    validations: ['billing_reception_5_wrs', 'billing_montos_match'],
  },
  {
    id: 'sol-12',
    name: 'Buildup Promise.all',
    featureFlag: null,
    description: 'Reemplazar loop secuencial getDocs por Promise.all en AirfreightBuildup.',
    riskLevel: 'medium',
    requiredCodeDeploy: true,
    validations: ['buildup_load_pieces', 'buildup_distribute'],
  },
  {
    id: 'sol-17',
    name: 'WSDashboard client_id filter',
    featureFlag: 'ws_dashboard_client_filter',
    description: 'Agregar where(client_id) al onSnapshot de WSDashboard para clientes.',
    riskLevel: 'medium',
    requiredCodeDeploy: true,
    validations: ['ws_dashboard_admin_all', 'ws_dashboard_client_own'],
  },
  {
    id: 'sol-14a',
    name: 'Separate BookingList listener',
    featureFlag: null,
    description: 'Separar nested onSnapshot en AirfreightBookingList.',
    riskLevel: 'high',
    requiredCodeDeploy: true,
    validations: ['bookinglist_data_complete', 'bookinglist_realtime', 'no_flash_empty'],
  },
  {
    id: 'sol-26',
    name: 'Parallelize Generate Sets',
    featureFlag: null,
    description: 'Reemplazar for...of secuencial con Promise.all en Generate Sets.',
    riskLevel: 'medium',
    requiredCodeDeploy: true,
    validations: ['generate_sets_1_awb', 'generate_sets_5_awbs'],
  },
];

/**
 * Determine current deploy plan state based on agent state and feature flags.
 */
export function getDeployPlan(agentState, featureFlags) {
  const completedIds = agentState.completed_deployments || [];
  const currentDeployment = agentState.current_deployment || null;
  const currentPhase = agentState.current_phase || null;

  // Find next uncompleted item
  const nextItem = DEPLOY_PLAN.find(item => !completedIds.includes(item.id));

  // If there's an active deployment
  if (currentDeployment && currentPhase && currentPhase !== 'completed' && currentPhase !== 'rolled_back') {
    const activeItem = DEPLOY_PLAN.find(item => item.name === currentDeployment);
    if (activeItem) {
      return {
        hasActiveDeployment: true,
        current: {
          ...activeItem,
          phase: currentPhase,
        },
        nextSteps: nextItem ? [`Siguiente despues de completar: ${nextItem.name}`] : ['Plan completado'],
        totalCompleted: completedIds.length,
        totalPlan: DEPLOY_PLAN.length,
      };
    }
  }

  // No active deployment — check if there's a next step
  if (!nextItem) {
    return {
      hasActiveDeployment: false,
      current: null,
      nextSteps: ['Todos los despliegues del plan han sido completados'],
      totalCompleted: completedIds.length,
      totalPlan: DEPLOY_PLAN.length,
    };
  }

  // If the next item requires code deploy (not just a flag), mark as ready but not active
  // The ANDS agent will only activate if code has been deployed (checked via a Git SHA or flag)
  const codeReady = agentState[`code_ready_${nextItem.id}`] === true;

  if (nextItem.requiredCodeDeploy && !codeReady) {
    return {
      hasActiveDeployment: false,
      current: null,
      nextSteps: [
        `Siguiente: ${nextItem.name} — Esperando deploy de codigo`,
        `Marcar como listo: set _agent_state/ANDS.code_ready_${nextItem.id} = true`,
      ],
      totalCompleted: completedIds.length,
      totalPlan: DEPLOY_PLAN.length,
    };
  }

  // Code is ready, deploy can proceed
  return {
    hasActiveDeployment: true,
    current: {
      ...nextItem,
      phase: 'ready_to_deploy',
    },
    nextSteps: [],
    totalCompleted: completedIds.length,
    totalPlan: DEPLOY_PLAN.length,
  };
}

/**
 * Mark current deployment as completed and advance to next.
 */
export function advanceDeployPlan(agentState, completedId) {
  const completed = [...(agentState.completed_deployments || []), completedId];
  return {
    completed_deployments: completed,
    current_deployment: null,
    current_phase: null,
  };
}
