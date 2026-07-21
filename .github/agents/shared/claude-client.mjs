// ═══ Claude API Client ═══
// All agent-to-Claude communication goes through this module.
// Claude is consulted for ANALYSIS only — never for permission.

import Anthropic from '@anthropic-ai/sdk';

let client = null;

function getClient() {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY secret not set');
  client = new Anthropic({ apiKey });
  return client;
}

// ── Core Analysis Function ─────────────────────────────────────────────────────

export async function askClaude(systemPrompt, userMessage, { maxTokens = 4096, temperature = 0.2 } = {}) {
  const c = getClient();
  const startTime = Date.now();

  try {
    const response = await c.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      temperature,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    log('CLAUDE', `Response in ${Date.now() - startTime}ms (${response.usage.input_tokens}+${response.usage.output_tokens} tokens)`);
    return text;
  } catch (err) {
    log('CLAUDE_ERROR', `${err.message}`);
    throw err;
  }
}

// ── Specialized Prompts ────────────────────────────────────────────────────────

const SYSTEM_BASE = `Eres un ingeniero SRE senior analizando el sistema MCL WMS.
Stack: React SPA + Firebase Hosting + Firestore + Firebase Auth.
Responde SOLO en JSON valido. No uses markdown ni texto fuera del JSON.
Prioridad absoluta: estabilidad > velocidad > features.

CONTEXTO IMPORTANTE:
- Este sistema SOLO emite facturacion (invoices). Los pagos se controlan en otro sistema externo.
- NO alertar sobre "cero pagos procesados" ni sobre air_charges_paid — es comportamiento esperado.
- air_charges_pending solo cuenta cargos desde 2026-05-01 (fecha de inicio de facturacion en el sistema).
- Un porcentaje alto de cargos pendientes es normal si las facturas aun no se han generado en el ciclo actual.`;

/**
 * Analyze deployment risk. Returns { risk: 'low'|'medium'|'high'|'critical',
 * proceed: boolean, reasoning: string, warnings: string[] }
 */
export async function analyzeDeploymentRisk(metrics, changeDescription) {
  const response = await askClaude(
    SYSTEM_BASE + `\nAnaliza el riesgo de un despliegue. Responde con JSON:
{
  "risk": "low|medium|high|critical",
  "proceed": true/false,
  "reasoning": "explicacion breve",
  "warnings": ["advertencia1", "advertencia2"],
  "recommended_rollback_triggers": ["trigger1", "trigger2"]
}`,
    `METRICAS ACTUALES DEL SISTEMA:\n${JSON.stringify(metrics, null, 2)}\n\nCAMBIO A DESPLEGAR:\n${changeDescription}`
  );
  return parseJSON(response);
}

/**
 * Analyze performance metrics. Returns { status: 'healthy'|'degraded'|'critical',
 * issues: [...], recommendations: [...] }
 */
export async function analyzePerformance(metrics, baselines) {
  const response = await askClaude(
    SYSTEM_BASE + `\nAnaliza metricas de performance comparando con baselines. Responde con JSON:
{
  "status": "healthy|degraded|critical",
  "score": 0-100,
  "issues": [{ "metric": "nombre", "current": valor, "baseline": valor, "severity": "low|medium|high", "recommendation": "texto" }],
  "summary": "resumen ejecutivo en 2-3 oraciones"
}`,
    `METRICAS ACTUALES:\n${JSON.stringify(metrics, null, 2)}\n\nBASELINES:\n${JSON.stringify(baselines, null, 2)}`
  );
  return parseJSON(response);
}

/**
 * Analyze data integrity. Returns { integrity: 'ok'|'warning'|'critical',
 * issues: [...], actions: [...] }
 */
export async function analyzeDataIntegrity(auditResults) {
  const response = await askClaude(
    SYSTEM_BASE + `\nAnaliza resultados de auditoria de integridad de datos. Responde con JSON:
{
  "integrity": "ok|warning|critical",
  "issues": [{ "type": "tipo", "collection": "nombre", "count": N, "severity": "low|medium|high|critical", "description": "texto", "action": "texto" }],
  "billing_safe": true/false,
  "summary": "resumen en 2-3 oraciones"
}`,
    `RESULTADOS DE AUDITORIA:\n${JSON.stringify(auditResults, null, 2)}`
  );
  return parseJSON(response);
}

/**
 * Decide whether to promote canary or rollback. Returns { decision: 'promote'|'rollback'|'wait',
 * reasoning: string }
 */
export async function decideCanaryPromotion(canaryMetrics, productionMetrics, featureFlag) {
  const response = await askClaude(
    SYSTEM_BASE + `\nDecide si promover un canary release, hacer rollback, o esperar. Responde con JSON:
{
  "decision": "promote|rollback|wait",
  "confidence": 0-100,
  "reasoning": "explicacion",
  "next_step": "accion concreta siguiente"
}`,
    `FEATURE FLAG: ${featureFlag}\n\nMETRICAS CANARY:\n${JSON.stringify(canaryMetrics, null, 2)}\n\nMETRICAS PRODUCCION:\n${JSON.stringify(productionMetrics, null, 2)}`
  );
  return parseJSON(response);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function parseJSON(text) {
  try {
    // Extract JSON from response (Claude might wrap it)
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in response');
    return JSON.parse(match[0]);
  } catch (err) {
    log('JSON_PARSE_ERROR', `Failed to parse Claude response: ${text.substring(0, 200)}`);
    return { error: 'parse_failed', raw: text.substring(0, 500) };
  }
}

function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}
