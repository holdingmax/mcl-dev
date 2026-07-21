#!/usr/bin/env node
// ═══ AAID — Agente Autónomo de Integridad de Datos ═══
// Cron: 12:00 AM EST (4:00 AM UTC) | Autónomo
// Validates data integrity, billing consistency, and cross-reference health.

import { initFirebase, getAgentState, setAgentState, writeMetricsSnapshot } from '../shared/firebase-client.mjs';
import { analyzeDataIntegrity } from '../shared/claude-client.mjs';
import { generateReport, sendSlackNotification, setSummary } from '../shared/reporter.mjs';
import { validateBilling } from './billing-validator.mjs';
import { checkDataIntegrity } from './data-integrity.mjs';

const AGENT_ID = 'AAID';

async function main() {
  log('START', '═══ AAID — Agente Autonomo de Integridad de Datos ═══');
  const report = { status: 'unknown', checks: [], issues: [], next_steps: [] };

  try {
    initFirebase();

    // 1. Load previous state for trend comparison
    log('STEP', '1/5 — Cargando estado previo');
    const state = await getAgentState(AGENT_ID);
    const previousOrphans = state.orphan_count || 0;
    const previousMismatches = state.mismatch_count || 0;

    // 2. Run data integrity checks
    log('STEP', '2/5 — Verificando integridad de datos');
    const integrityResults = await checkDataIntegrity();
    report.checks.push(...integrityResults.checks);

    // 3. Run billing validation
    log('STEP', '3/5 — Validando integridad de billing');
    const billingResults = await validateBilling();
    report.checks.push(...billingResults.checks);

    // Combine all issues
    const allOrphans = integrityResults.orphans || [];
    const allMismatches = billingResults.mismatches || [];
    const allInconsistencies = integrityResults.inconsistencies || [];

    const auditSummary = {
      total_checks: report.checks.length,
      checks_ok: report.checks.filter(c => c.status === 'ok').length,
      checks_warning: report.checks.filter(c => c.status === 'warning').length,
      checks_critical: report.checks.filter(c => c.status === 'critical').length,
      checks_error: report.checks.filter(c => c.status === 'error').length,
      orphan_count: allOrphans.length,
      mismatch_count: allMismatches.length,
      inconsistency_count: allInconsistencies.length,
      orphans: allOrphans.slice(0, 10), // Limit for Claude context
      mismatches: allMismatches.slice(0, 10),
      inconsistencies: allInconsistencies.slice(0, 10),
      integrity_stats: integrityResults.stats,
      billing_stats: billingResults.stats,
    };

    // 4. Ask Claude to analyze
    log('STEP', '4/5 — Consultando a Claude para analisis');
    const analysis = await analyzeDataIntegrity(auditSummary);
    report.claude_analysis = analysis;
    report.status = analysis.integrity || 'unknown';
    report.summary = analysis.summary || 'Audit completado.';

    if (analysis.issues) {
      report.issues = analysis.issues;
    }

    // 5. Detect trends (worsening vs improving)
    const orphanTrend = allOrphans.length - previousOrphans;
    const mismatchTrend = allMismatches.length - previousMismatches;

    if (orphanTrend > 0) {
      report.issues.push({
        severity: 'warning',
        type: 'trend',
        detail: `Orphan count increased by ${orphanTrend} since last audit`,
      });
    }

    if (mismatchTrend > 0) {
      report.issues.push({
        severity: 'warning',
        type: 'trend',
        detail: `Billing mismatch count increased by ${mismatchTrend} since last audit`,
      });
    }

    // Send alerts if issues detected
    const hasCritical = report.checks.some(c => c.status === 'critical') ||
                        analysis.integrity === 'critical';
    const hasWarnings = report.checks.some(c => c.status === 'warning') ||
                        allMismatches.length > 0 ||
                        allOrphans.length > 5;

    if (hasCritical) {
      const criticalSummary = report.checks
        .filter(c => c.status === 'critical')
        .map(c => `- [CRITICAL] ${c.name}: ${c.detail}`)
        .join('\n');

      await sendSlackNotification(
        `AAID: INTEGRIDAD CRITICA\n${analysis.summary}\n\n${criticalSummary}`,
        'critical'
      );
    } else if (hasWarnings) {
      const warningSummary = [
        ...report.checks.filter(c => c.status === 'warning').map(c => `- ${c.name}: ${c.detail}`),
        ...allMismatches.slice(0, 3).map(m => `- Billing: ${m.detail}`),
        ...allOrphans.slice(0, 3).map(o => `- Orphan: ${o.type} (${o.booking_id || o.doc_id || o.do_id})`),
      ].join('\n');

      await sendSlackNotification(
        `AAID: Warnings detectados\n${analysis.summary}\n\n${warningSummary}`,
        'warning'
      );
    }

    // Generate next steps
    if (analysis.billing_safe === false) {
      report.next_steps.push('URGENTE: Revisar integridad de billing antes de cualquier deploy');
    }
    if (allOrphans.length > 0) {
      report.next_steps.push(`Investigar ${allOrphans.length} documentos huerfanos`);
    }
    if (allInconsistencies.length > 0) {
      report.next_steps.push(`Resolver ${allInconsistencies.length} inconsistencias de datos`);
    }

    // Save state for next run
    await setAgentState(AGENT_ID, {
      last_run: new Date().toISOString(),
      last_status: report.status,
      orphan_count: allOrphans.length,
      mismatch_count: allMismatches.length,
      inconsistency_count: allInconsistencies.length,
      checks_summary: {
        ok: auditSummary.checks_ok,
        warning: auditSummary.checks_warning,
        critical: auditSummary.checks_critical,
      },
    });

    await writeMetricsSnapshot(AGENT_ID, auditSummary, report.summary);
    await finalizeReport(report);

  } catch (err) {
    log('ERROR', `Fatal: ${err.message}\n${err.stack}`);
    report.status = 'error';
    report.summary = `Error fatal: ${err.message}`;
    await sendSlackNotification(`AAID ERROR: ${err.message}`, 'critical');
    await finalizeReport(report);
    process.exit(1);
  }
}

async function finalizeReport(report) {
  const { mdPath, markdown } = generateReport(AGENT_ID, report);
  setSummary(markdown);
  log('DONE', `Report: ${mdPath}`);
}

function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [AAID] [${tag}] ${msg}`);
}

main();
