// ═══ Rollback Manager ═══
// Handles safe rollback of feature flags and deployment state.
// Does NOT do git revert or firebase hosting:rollback — those require manual trigger.

import { setFeatureFlag, setAgentState } from '../shared/firebase-client.mjs';
import { sendSlackNotification } from '../shared/reporter.mjs';

/**
 * Execute a safe rollback for a canary deployment.
 * - Disables feature flag (if applicable)
 * - Updates agent state
 * - Sends critical notification
 */
export async function executeRollback(deployment, reason) {
  const actions = [];

  // 1. Disable feature flag
  if (deployment.featureFlag) {
    await setFeatureFlag(deployment.featureFlag, false);
    actions.push(`Feature flag '${deployment.featureFlag}' disabled`);
  }

  // 2. Update agent state
  await setAgentState('ANDS', {
    current_phase: 'rolled_back',
    rollback_reason: reason,
    rollback_at: new Date().toISOString(),
    rollback_deployment: deployment.name,
  });
  actions.push('Agent state updated to rolled_back');

  // 3. Notify
  const message = [
    `ROLLBACK EJECUTADO`,
    `Deployment: ${deployment.name}`,
    `Razon: ${reason}`,
    `Acciones: ${actions.join(', ')}`,
    ``,
    `Si el cambio requiere revert de codigo:`,
    `  git revert <commit> && npm run build && firebase deploy --only hosting`,
    `O:`,
    `  firebase hosting:rollback`,
  ].join('\n');

  await sendSlackNotification(message, 'critical');

  log('ROLLBACK', `Completed for ${deployment.name}: ${reason}`);
  return actions;
}

/**
 * Check if rollback conditions are met based on metrics comparison.
 */
export function shouldAutoRollback(currentMetrics, baselineMetrics) {
  const triggers = [];

  // Firestore reads spike > 120% of baseline
  if (baselineMetrics.total_reads && currentMetrics.total_reads) {
    const ratio = currentMetrics.total_reads / baselineMetrics.total_reads;
    if (ratio > 1.2) {
      triggers.push(`Firestore reads spiked ${Math.round(ratio * 100)}% of baseline`);
    }
  }

  // Error count increased
  if (currentMetrics.error_count > (baselineMetrics.error_count || 0) * 1.5 + 5) {
    triggers.push(`Error count increased: ${currentMetrics.error_count} vs baseline ${baselineMetrics.error_count || 0}`);
  }

  // Billing inconsistency
  if (currentMetrics.billing_mismatch_count > 0) {
    triggers.push(`Billing mismatch detected: ${currentMetrics.billing_mismatch_count} charges differ`);
  }

  // Collection count dropped unexpectedly (data loss indicator)
  for (const key of Object.keys(currentMetrics)) {
    if (key.startsWith('count_') && baselineMetrics[key]) {
      const current = currentMetrics[key];
      const baseline = baselineMetrics[key];
      if (current < baseline * 0.9 && baseline > 100) {
        triggers.push(`${key} dropped from ${baseline} to ${current} (possible data loss)`);
      }
    }
  }

  return {
    shouldRollback: triggers.length > 0,
    triggers,
  };
}

function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [ROLLBACK] [${tag}] ${msg}`);
}
