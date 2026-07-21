#!/usr/bin/env node
// ═══ ANDS — Agente Nocturno de Despliegue Seguro ═══
// Cron: 5:00 AM EST (9:00 AM UTC) | Autónomo | No pide permiso

import { initFirebase, getFeatureFlags, setFeatureFlag, getAgentState, setAgentState, writeMetricsSnapshot, writeDeployEvent } from '../shared/firebase-client.mjs';
import { analyzeDeploymentRisk, decideCanaryPromotion } from '../shared/claude-client.mjs';
import { generateReport, sendSlackNotification, setSummary } from '../shared/reporter.mjs';
import { collectMetrics } from './metrics-collector.mjs';
import { getDeployPlan, advanceDeployPlan } from './canary-manager.mjs';
import { executeRollback } from './rollback-manager.mjs';

const AGENT_ID = 'ANDS';

async function main() {
  log('START', '═══ ANDS — Agente Nocturno de Despliegue Seguro ═══');
  const report = { status: 'unknown', actions_taken: [], deployments: [], next_steps: [] };

  try {
    initFirebase();

    // 1. Collect current system metrics
    log('STEP', '1/6 — Recopilando metricas del sistema');
    const metrics = await collectMetrics();
    report.metrics = metrics.summary;

    // 2. Check current deploy plan state
    log('STEP', '2/6 — Verificando plan de despliegue activo');
    const state = await getAgentState(AGENT_ID);
    const flags = await getFeatureFlags();
    const plan = getDeployPlan(state, flags);

    if (!plan.hasActiveDeployment) {
      log('INFO', 'No hay despliegue activo programado. Verificando si hay siguiente paso en el plan.');
      report.status = 'idle';
      report.summary = 'No hay despliegue activo. Sistema estable.';
      report.next_steps = plan.nextSteps;
      await finalizeReport(report);
      return;
    }

    log('INFO', `Despliegue activo: ${plan.current.name} — Fase: ${plan.current.phase}`);

    // 3. Analyze risk with Claude
    log('STEP', '3/6 — Consultando a Claude para analisis de riesgo');
    const riskAnalysis = await analyzeDeploymentRisk(metrics.raw, plan.current.description);
    report.claude_analysis = riskAnalysis;

    if (riskAnalysis.risk === 'critical') {
      log('ALERT', 'Claude identifica riesgo CRITICO. Ejecutando rollback.');
      await handleRollback(plan.current, 'Claude identified critical risk', report);
      await finalizeReport(report);
      return;
    }

    // 4. Check canary metrics (if canary phase)
    if (plan.current.phase === 'canary_active') {
      log('STEP', '4/6 — Evaluando metricas del canary');
      const canaryDecision = await decideCanaryPromotion(
        metrics.raw,
        state.baseline_metrics || {},
        plan.current.featureFlag
      );

      report.claude_analysis = { ...riskAnalysis, canary_decision: canaryDecision };

      if (canaryDecision.decision === 'rollback') {
        log('ALERT', `Claude recomienda rollback: ${canaryDecision.reasoning}`);
        await handleRollback(plan.current, canaryDecision.reasoning, report);
        await finalizeReport(report);
        return;
      }

      if (canaryDecision.decision === 'promote') {
        log('SUCCESS', `Claude recomienda promover canary: ${canaryDecision.reasoning}`);
        await handlePromotion(plan.current, state, report);
        await finalizeReport(report);
        return;
      }

      // decision === 'wait'
      log('INFO', `Claude recomienda esperar: ${canaryDecision.reasoning}`);
      report.status = 'waiting';
      report.summary = `Canary ${plan.current.featureFlag} activo. Claude recomienda esperar.`;
      report.actions_taken.push('Canary metrics collected, Claude recommends waiting');
      report.next_steps = [canaryDecision.next_step];
      await finalizeReport(report);
      return;
    }

    // 5. If ready to deploy new canary
    if (plan.current.phase === 'ready_to_deploy') {
      log('STEP', '5/6 — Preparando nuevo canary deployment');

      if (riskAnalysis.proceed === false) {
        log('WARN', `Claude no recomienda proceder: ${riskAnalysis.reasoning}`);
        report.status = 'blocked';
        report.summary = `Deploy ${plan.current.name} bloqueado por analisis de riesgo.`;
        report.actions_taken.push(`Deploy blocked: ${riskAnalysis.reasoning}`);
        await finalizeReport(report);
        return;
      }

      // Save baseline metrics before deploying
      await setAgentState(AGENT_ID, {
        baseline_metrics: metrics.raw,
        current_deployment: plan.current.name,
        deploy_started_at: new Date().toISOString(),
      });

      // Activate feature flag for first tier (MCL staff only)
      if (plan.current.featureFlag) {
        await setFeatureFlag(plan.current.featureFlag, 'mcl_only');
        report.actions_taken.push(`Feature flag ${plan.current.featureFlag} set to 'mcl_only'`);
        report.deployments.push({
          name: plan.current.name,
          action: 'canary_started',
          result: 'Flag activated for MCL staff',
        });
      }

      await setAgentState(AGENT_ID, {
        ...state,
        current_phase: 'canary_active',
        canary_tier: 'mcl_only',
        canary_started_at: new Date().toISOString(),
      });

      report.status = 'deployed';
      report.summary = `Canary iniciado: ${plan.current.name}. Flag activado para MCL staff.`;
      await sendSlackNotification(
        `ANDS: Canary iniciado — ${plan.current.name}\nFlag: ${plan.current.featureFlag} = mcl_only`,
        'info'
      );
      await finalizeReport(report);
      return;
    }

    // 6. Default: collect metrics and report
    report.status = 'monitoring';
    report.summary = `Monitoreando deployment: ${plan.current.name}`;
    await finalizeReport(report);

  } catch (err) {
    log('ERROR', `Fatal error: ${err.message}\n${err.stack}`);
    report.status = 'error';
    report.summary = `Error fatal: ${err.message}`;
    report.issues = [{ severity: 'critical', description: err.message, type: 'agent_error' }];
    await sendSlackNotification(`ANDS ERROR: ${err.message}`, 'critical');
    await finalizeReport(report);
    process.exit(1);
  }
}

// ── Handlers ───────────────────────────────────────────────────────────────────

async function handleRollback(deployment, reason, report) {
  log('ROLLBACK', `Executing rollback for ${deployment.name}: ${reason}`);

  if (deployment.featureFlag) {
    await setFeatureFlag(deployment.featureFlag, false);
    report.actions_taken.push(`Feature flag ${deployment.featureFlag} set to false (rollback)`);
  }

  await setAgentState(AGENT_ID, {
    current_phase: 'rolled_back',
    rollback_reason: reason,
    rollback_at: new Date().toISOString(),
  });

  report.status = 'rollback';
  report.summary = `ROLLBACK ejecutado para ${deployment.name}: ${reason}`;
  report.deployments.push({ name: deployment.name, action: 'rollback', result: reason });

  await sendSlackNotification(
    `ANDS ROLLBACK: ${deployment.name}\nRazon: ${reason}`,
    'critical'
  );
}

async function handlePromotion(deployment, state, report) {
  const currentTier = state.canary_tier || 'mcl_only';
  const nextTier = getNextTier(currentTier);

  if (nextTier === 'complete') {
    // Canary is fully promoted
    await setFeatureFlag(deployment.featureFlag, true);
    await setAgentState(AGENT_ID, {
      current_phase: 'completed',
      completed_at: new Date().toISOString(),
    });
    report.status = 'promoted';
    report.summary = `Canary ${deployment.name} promovido completamente a produccion.`;
    report.deployments.push({ name: deployment.name, action: 'full_promotion', result: 'success' });
    report.actions_taken.push(`Feature flag ${deployment.featureFlag} set to true (all users)`);
    await sendSlackNotification(
      `ANDS SUCCESS: ${deployment.name} promovido a produccion`,
      'info'
    );
  } else {
    // Advance to next tier
    await setFeatureFlag(deployment.featureFlag, nextTier);
    await setAgentState(AGENT_ID, {
      ...state,
      canary_tier: nextTier,
      tier_promoted_at: new Date().toISOString(),
    });
    report.status = 'promoted_tier';
    report.summary = `Canary ${deployment.name} avanzado a tier: ${nextTier}`;
    report.deployments.push({ name: deployment.name, action: `promote_to_${nextTier}`, result: 'success' });
    report.actions_taken.push(`Feature flag ${deployment.featureFlag} set to '${nextTier}'`);
    await sendSlackNotification(
      `ANDS: Canary ${deployment.name} avanzado a ${nextTier}`,
      'info'
    );
  }
}

function getNextTier(current) {
  const tiers = ['mcl_only', 'agents', 'all_mcl', 'clients', 'complete'];
  const idx = tiers.indexOf(current);
  return idx >= 0 && idx < tiers.length - 1 ? tiers[idx + 1] : 'complete';
}

// ── Report ─────────────────────────────────────────────────────────────────────

async function finalizeReport(report) {
  const { mdPath, markdown } = generateReport(AGENT_ID, report);
  setSummary(markdown);
  await writeMetricsSnapshot(AGENT_ID, report.metrics || [], report.summary);
  if (report.deployments?.length > 0) {
    for (const d of report.deployments) {
      await writeDeployEvent({ ...d, agent: AGENT_ID, status: report.status });
    }
  }
  log('DONE', `Report saved to ${mdPath}`);
}

function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [ANDS] [${tag}] ${msg}`);
}

main();
