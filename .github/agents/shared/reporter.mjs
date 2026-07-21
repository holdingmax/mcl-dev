// ═══ Report Generator ═══
// Generates structured reports, saves to filesystem (GitHub Artifacts), and optionally sends to Slack.

import { writeFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const REPORTS_DIR = process.env.REPORTS_DIR || join(process.cwd(), 'reports');

// ── Report Generation ──────────────────────────────────────────────────────────

export function generateReport(agentName, data) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const date = new Date().toISOString().split('T')[0];

  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });

  // JSON report (machine-readable)
  const jsonPath = join(REPORTS_DIR, `${agentName}-${date}.json`);
  writeFileSync(jsonPath, JSON.stringify({
    agent: agentName,
    timestamp: new Date().toISOString(),
    ...data,
  }, null, 2));

  // Markdown report (human-readable)
  const mdPath = join(REPORTS_DIR, `${agentName}-${date}.md`);
  const md = buildMarkdownReport(agentName, data);
  writeFileSync(mdPath, md);

  log('REPORT', `Generated: ${jsonPath}, ${mdPath}`);
  return { jsonPath, mdPath, markdown: md };
}

function buildMarkdownReport(agentName, data) {
  const title = {
    ANDS: 'Agente Nocturno de Despliegue Seguro',
    ADMP: 'Agente Diario de Monitoreo de Performance',
    AAID: 'Agente Auditor de Integridad de Datos',
    AREF: 'Agente de Refactoring Arquitectonico',
  }[agentName] || agentName;

  const lines = [
    `# ${title}`,
    `**Fecha:** ${new Date().toISOString().split('T')[0]}`,
    `**Hora:** ${new Date().toISOString().split('T')[1].split('.')[0]} UTC`,
    `**Status:** ${statusEmoji(data.status)} ${data.status || 'unknown'}`,
    '',
  ];

  if (data.summary) {
    lines.push('## Resumen', data.summary, '');
  }

  if (data.metrics) {
    lines.push('## Metricas', '| Metrica | Valor | Baseline | Status |', '|---------|-------|----------|--------|');
    for (const m of data.metrics) {
      lines.push(`| ${m.name} | ${m.value} | ${m.baseline || '-'} | ${statusEmoji(m.status)} |`);
    }
    lines.push('');
  }

  if (data.issues && data.issues.length) {
    lines.push('## Issues Detectados');
    for (const issue of data.issues) {
      lines.push(`- **[${issue.severity || 'info'}]** ${issue.description || issue.type}`);
      if (issue.action) lines.push(`  - Accion: ${issue.action}`);
    }
    lines.push('');
  }

  if (data.deployments && data.deployments.length) {
    lines.push('## Despliegues');
    for (const d of data.deployments) {
      lines.push(`- **${d.name}**: ${d.action} — ${d.result}`);
    }
    lines.push('');
  }

  if (data.claude_analysis) {
    lines.push('## Analisis de Claude');
    if (typeof data.claude_analysis === 'string') {
      lines.push(data.claude_analysis);
    } else {
      lines.push('```json', JSON.stringify(data.claude_analysis, null, 2), '```');
    }
    lines.push('');
  }

  if (data.actions_taken && data.actions_taken.length) {
    lines.push('## Acciones Tomadas');
    for (const a of data.actions_taken) {
      lines.push(`- ${a}`);
    }
    lines.push('');
  }

  if (data.next_steps && data.next_steps.length) {
    lines.push('## Proximos Pasos');
    for (const s of data.next_steps) {
      lines.push(`- ${s}`);
    }
    lines.push('');
  }

  lines.push('---', `*Generado automaticamente por MCL WMS Agent System*`);
  return lines.join('\n');
}

function statusEmoji(status) {
  const map = {
    healthy: 'OK', ok: 'OK', success: 'OK', promoted: 'OK',
    degraded: 'WARN', warning: 'WARN', wait: 'WARN',
    critical: 'CRIT', error: 'CRIT', rollback: 'CRIT', failed: 'CRIT',
  };
  return map[(status || '').toLowerCase()] || '??';
}

// ── Slack Notification ─────────────────────────────────────────────────────────

export async function sendSlackNotification(message, level = 'info') {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    log('SLACK', 'No SLACK_WEBHOOK_URL configured, skipping notification');
    return;
  }

  const color = { info: '#36a64f', warning: '#ff9500', error: '#dc3545', critical: '#8b0000' }[level] || '#36a64f';

  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attachments: [{
          color,
          title: `MCL WMS Agent — ${level.toUpperCase()}`,
          text: message,
          ts: Math.floor(Date.now() / 1000),
        }],
      }),
    });
    if (!resp.ok) throw new Error(`Slack responded ${resp.status}`);
    log('SLACK', `Notification sent (${level})`);
  } catch (err) {
    log('SLACK_ERROR', err.message);
  }
}

// ── GitHub Actions Output ──────────────────────────────────────────────────────

export function setOutput(key, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, `${key}=${value}\n`);
  }
}

export function setSummary(markdown) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    appendFileSync(summaryFile, markdown);
  }
}

// ── Logging ────────────────────────────────────────────────────────────────────

function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}
