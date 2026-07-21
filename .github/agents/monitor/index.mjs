#!/usr/bin/env node
// ═══ ADMP — Agente Diario de Monitoreo de Performance ═══
// Cron: 2:00 AM EST (6:00 AM UTC) | Autónomo

import { initFirebase, getAgentState, setAgentState, getCollectionCount, writeMetricsSnapshot } from '../shared/firebase-client.mjs';
import { analyzePerformance } from '../shared/claude-client.mjs';
import { generateReport, sendSlackNotification, setSummary } from '../shared/reporter.mjs';
import { collectPerformanceMetrics } from './performance-checker.mjs';
import { collectFirestoreMetrics } from './firestore-metrics.mjs';

const AGENT_ID = 'ADMP';

// Baselines from PERFORMANCE_AUDIT.md (pre-optimization)
const DEFAULT_BASELINES = {
  bookings_total: null, // Set on first run
  flights_total: null,
  air_charges_total: null,
  air_charges_pending: null,  // Only counts from 2026-05-01+ (invoice start date)
  wrs_total: null,
  billing_charges_total: null,
  ws_orders_total: null,
  doc_receptions_24h: null,
  bookings_24h: null,
};

async function main() {
  log('START', '═══ ADMP — Agente Diario de Monitoreo de Performance ═══');
  const report = { status: 'unknown', metrics: [], issues: [], next_steps: [] };

  try {
    initFirebase();

    // 1. Load baselines (from previous day's metrics)
    log('STEP', '1/5 — Cargando baselines');
    const state = await getAgentState(AGENT_ID);
    const baselines = state.baselines || DEFAULT_BASELINES;

    // 2. Collect Firestore metrics
    log('STEP', '2/5 — Recopilando metricas de Firestore');
    const firestoreMetrics = await collectFirestoreMetrics();

    // 3. Collect performance metrics
    log('STEP', '3/5 — Recopilando metricas de performance');
    const perfMetrics = await collectPerformanceMetrics();

    // Combine all metrics
    const allMetrics = { ...firestoreMetrics, ...perfMetrics };
    report.metrics = formatMetrics(allMetrics, baselines);

    // 4. Ask Claude to analyze
    log('STEP', '4/5 — Consultando a Claude para analisis');
    const analysis = await analyzePerformance(allMetrics, baselines);
    report.claude_analysis = analysis;
    report.status = analysis.status || 'unknown';
    report.summary = analysis.summary || 'Analisis completado.';

    if (analysis.issues) {
      report.issues = analysis.issues;
    }

    // 5. Generate alerts if degraded
    if (analysis.status === 'degraded' || analysis.status === 'critical') {
      const severity = analysis.status === 'critical' ? 'critical' : 'warning';
      const issuesSummary = (analysis.issues || [])
        .map(i => `- [${i.severity}] ${i.metric}: ${i.current} (baseline: ${i.baseline})`)
        .join('\n');

      await sendSlackNotification(
        `ADMP: Sistema ${analysis.status.toUpperCase()}\n${analysis.summary}\n\n${issuesSummary}`,
        severity
      );

      report.next_steps = (analysis.issues || [])
        .filter(i => i.recommendation)
        .map(i => `${i.metric}: ${i.recommendation}`);
    }

    // Save today's metrics as baselines for tomorrow
    await setAgentState(AGENT_ID, {
      baselines: allMetrics,
      last_run: new Date().toISOString(),
      last_status: analysis.status,
    });

    // Compare with yesterday's growth
    if (baselines.bookings_total && allMetrics.bookings_total) {
      const growth = allMetrics.bookings_total - baselines.bookings_total;
      report.metrics.push({
        name: 'Bookings growth (24h)',
        value: growth,
        baseline: '-',
        status: growth > 100 ? 'warning' : 'ok',
      });
    }

    await writeMetricsSnapshot(AGENT_ID, allMetrics, report.summary);
    await finalizeReport(report);

  } catch (err) {
    log('ERROR', `Fatal: ${err.message}\n${err.stack}`);
    report.status = 'error';
    report.summary = `Error fatal: ${err.message}`;
    await sendSlackNotification(`ADMP ERROR: ${err.message}`, 'critical');
    await finalizeReport(report);
    process.exit(1);
  }
}

function formatMetrics(current, baselines) {
  const result = [];
  for (const [key, value] of Object.entries(current)) {
    if (typeof value !== 'number') continue;
    const baseline = baselines[key];
    let status = 'ok';
    if (baseline != null && typeof baseline === 'number') {
      const ratio = value / baseline;
      if (ratio > 1.5) status = 'warning';
      if (ratio > 2.0) status = 'critical';
      if (value < baseline * 0.5 && baseline > 50) status = 'warning'; // Unexpected drop
    }
    result.push({ name: key, value, baseline: baseline ?? '-', status });
  }
  return result;
}

async function finalizeReport(report) {
  const { mdPath, markdown } = generateReport(AGENT_ID, report);
  setSummary(markdown);
  log('DONE', `Report: ${mdPath}`);
}

function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [ADMP] [${tag}] ${msg}`);
}

main();
