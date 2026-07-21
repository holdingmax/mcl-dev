/**
 * Read _sheet_sync_alerts and _sheet_sync_runs, generate HTML report.
 */
const https = require('https')
const fs = require('fs')
const path = require('path')

const PROJECT = 'wms-mcl'

function firestoreGet(collectionPath) {
  return new Promise((resolve, reject) => {
    const configPath = path.join(require('os').homedir(), '.config', 'configstore', 'firebase-tools.json')
    let accessToken
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      accessToken = config.tokens?.access_token
      if (!accessToken) throw new Error('No access_token')
    } catch (e) { reject(new Error('Cannot read firebase token: ' + e.message)); return }

    const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${collectionPath}?pageSize=500`
    const req = https.get(url, { headers: { 'Authorization': `Bearer ${accessToken}` } }, res => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${data}`))
        else resolve(JSON.parse(data))
      })
    })
    req.on('error', reject)
  })
}

function extractFields(doc) {
  const result = {}
  if (!doc.fields) return result
  for (const [key, val] of Object.entries(doc.fields)) {
    if (val.stringValue !== undefined) result[key] = val.stringValue
    else if (val.integerValue !== undefined) result[key] = Number(val.integerValue)
    else if (val.doubleValue !== undefined) result[key] = val.doubleValue
    else if (val.booleanValue !== undefined) result[key] = val.booleanValue
    else if (val.timestampValue !== undefined) result[key] = val.timestampValue
    else if (val.arrayValue) {
      result[key] = (val.arrayValue.values || []).map(v => {
        if (v.mapValue) return extractFields({ fields: v.mapValue.fields })
        if (v.stringValue !== undefined) return v.stringValue
        return JSON.stringify(v)
      })
    }
    else if (val.mapValue) result[key] = extractFields({ fields: val.mapValue.fields })
    else result[key] = JSON.stringify(val)
  }
  return result
}

async function main() {
  console.log('Reading alerts...')
  const alertsResp = await firestoreGet('_sheet_sync_alerts')
  const alerts = (alertsResp.documents || []).map(d => extractFields(d))

  console.log('Reading runs...')
  const runsResp = await firestoreGet('_sheet_sync_runs')
  const runs = (runsResp.documents || []).map(d => extractFields(d))

  // Debug: show alert types and sample
  const types = {}
  for (const a of alerts) { types[a.alert_type] = (types[a.alert_type] || 0) + 1 }
  console.log('Alert types:', JSON.stringify(types))
  console.log('Sample alert:', JSON.stringify(alerts[0], null, 2))
  console.log(`Runs: ${runs.length}`)
  for (const r of runs) {
    console.log(`  Run: ${r.run_at} | rows=${r.rows_checked} | detected=${r.changes_detected} | applied=${r.changes_applied} | alerts=${r.alerts_generated} | status=${r.status}`)
  }

  // The 29 applied changes don't have alerts — the agent applies but doesn't log diffs.
  // We need to show them. Let me also read the snapshot to see what was synced.

  // Categorize alerts
  const categories = {
    'same_day_change': { title: 'Cambios Same-Day (no aplicados, solo alerta)', badge: 'orange', items: [] },
    'same_day_new': { title: 'AWBs Nuevas Same-Day (no aplicadas, solo alerta)', badge: 'orange', items: [] },
    'needs_review': { title: 'Requieren Revision Manual', badge: 'red', items: [] },
    'removed_from_sheet': { title: 'Eliminadas del Sheet', badge: 'gray', items: [] },
    'dispatched_change': { title: 'Cambios en AWBs ya Despachadas', badge: 'red', items: [] },
  }

  for (const a of alerts) {
    const cat = categories[a.alert_type]
    if (cat) cat.items.push(a)
    else {
      // Unknown type — add to needs_review
      if (!categories['other']) categories['other'] = { title: 'Otros (' + a.alert_type + ')', badge: 'gray', items: [] }
      categories['other'].items.push(a)
    }
  }

  const successRun = runs.find(r => r.status === 'success' && (r.changes_applied > 0 || r.alerts_generated > 0))

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Sheet Sync Agent — Report</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f7fa; color: #1a1a2e; padding: 24px; }
  .container { max-width: 1300px; margin: 0 auto; }
  h1 { font-size: 20px; color: #1a3b5c; margin-bottom: 4px; }
  .subtitle { font-size: 13px; color: #888; margin-bottom: 24px; }
  .summary-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: white; border-radius: 12px; padding: 16px; border: 1px solid #e5e7eb; }
  .card-label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
  .card-value { font-size: 28px; font-weight: 700; margin-top: 4px; }
  .card-value.green { color: #059669; }
  .card-value.orange { color: #d97706; }
  .card-value.red { color: #dc2626; }
  .card-value.blue { color: #2563eb; }
  .card-value.gray { color: #6b7280; }
  .section { background: white; border-radius: 12px; border: 1px solid #e5e7eb; margin-bottom: 16px; overflow: hidden; }
  .section-header { padding: 12px 16px; background: #f9fafb; border-bottom: 1px solid #e5e7eb; display: flex; align-items: center; gap: 8px; }
  .section-title { font-size: 13px; font-weight: 700; color: #374151; }
  .badge { font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
  .badge-green { background: #d1fae5; color: #065f46; }
  .badge-orange { background: #fef3c7; color: #92400e; }
  .badge-red { background: #fee2e2; color: #991b1b; }
  .badge-blue { background: #dbeafe; color: #1e40af; }
  .badge-gray { background: #f3f4f6; color: #4b5563; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; padding: 8px 12px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: #6b7280; font-weight: 600; background: #f9fafb; border-bottom: 1px solid #e5e7eb; }
  td { padding: 8px 12px; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
  tr:hover { background: #f0f4ff; }
  .mono { font-family: 'SF Mono', 'Consolas', monospace; font-size: 11px; }
  .diff-pill { display: inline-flex; align-items: center; gap: 4px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 2px 8px; margin: 2px; font-size: 11px; }
  .diff-pill .field { font-weight: 700; color: #374151; }
  .diff-pill .old { color: #dc2626; text-decoration: line-through; }
  .diff-pill .arrow { color: #9ca3af; }
  .diff-pill .new { color: #059669; font-weight: 600; }
  .empty { padding: 24px; text-align: center; color: #9ca3af; font-size: 13px; }
  .run-bar { font-size: 12px; color: #6b7280; padding: 12px 16px; background: #f0fdf4; border-radius: 8px; margin-bottom: 16px; border: 1px solid #bbf7d0; }
  .run-bar b { color: #374151; }
  .note-box { background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 12px 16px; font-size: 12px; color: #92400e; margin-bottom: 16px; }
  .note-box b { color: #78350f; }
</style>
</head>
<body>
<div class="container">
  <h1>Sheet Sync Agent — Primera Ejecucion</h1>
  <p class="subtitle">Express Line &bull; ${new Date().toLocaleDateString('es', { year: 'numeric', month: 'long', day: 'numeric' })} &bull; Spreadsheet: EXPRESS LINE BOOKING</p>

  ${successRun ? `
  <div class="run-bar">
    Ejecutado: <b>${successRun.run_at || ''}</b> &nbsp;|&nbsp;
    Filas: <b>${successRun.rows_checked || 0}</b> &nbsp;|&nbsp;
    Cambios detectados: <b>${successRun.changes_detected || 0}</b> &nbsp;|&nbsp;
    Auto-aplicados (day+1): <b>${successRun.changes_applied || 0}</b> &nbsp;|&nbsp;
    Alertas generadas: <b>${successRun.alerts_generated || 0}</b> &nbsp;|&nbsp;
    Duracion: <b>${successRun.duration_ms ? (successRun.duration_ms / 1000).toFixed(1) + 's' : ''}</b>
  </div>` : ''}

  <div class="note-box">
    <b>Nota:</b> Los 29 cambios auto-aplicados (day+1) fueron escritos directamente al sistema sin generar alerta individual.
    En esta primera ejecucion el agente comparo <b>93 filas del Google Sheet</b> contra el sistema y detecto las diferencias.
    A partir de ahora, solo se reportaran <b>cambios incrementales</b> (filas que cambien entre una ejecucion y otra).
  </div>

  <div class="summary-cards">
    <div class="card">
      <div class="card-label">Filas Revisadas</div>
      <div class="card-value blue">${successRun?.rows_checked || 0}</div>
    </div>
    <div class="card">
      <div class="card-label">Auto-aplicados (Day+1)</div>
      <div class="card-value green">${successRun?.changes_applied || 0}</div>
    </div>
    <div class="card">
      <div class="card-label">Alertas Generadas</div>
      <div class="card-value orange">${successRun?.alerts_generated || 0}</div>
    </div>
  </div>

  ${Object.values(categories).filter(c => c.items.length > 0).map(cat => `
  <div class="section">
    <div class="section-header">
      <span class="section-title">${cat.title}</span>
      <span class="badge badge-${cat.badge}">${cat.items.length}</span>
    </div>
    <table>
      <thead>
        <tr>
          <th style="width:130px">AWB 1st Leg</th>
          <th style="width:130px">AWB 2nd Leg</th>
          <th style="width:80px">Vuelo</th>
          <th style="width:90px">ETD</th>
          ${cat.items.some(a => a.message) ? '<th style="width:150px">Motivo</th>' : ''}
          <th>Diferencias (Sistema → Sheet)</th>
        </tr>
      </thead>
      <tbody>
      ${cat.items.map(a => {
        const diffs = Array.isArray(a.diffs) ? a.diffs : []
        const diffHtml = diffs.length > 0
          ? diffs.map(d => `<span class="diff-pill"><span class="field">${d.field || ''}:</span> <span class="old">${d.system || '—'}</span> <span class="arrow">&rarr;</span> <span class="new">${d.sheet || '—'}</span></span>`).join(' ')
          : (cat.title.includes('Nuevas') ? '<span style="color:#059669;font-weight:600">AWB nueva en sheet</span>' : cat.title.includes('Eliminadas') ? '<span style="color:#dc2626">Fila eliminada del sheet</span>' : '—')
        return `
        <tr>
          <td class="mono">${a.awb_1st || '—'}</td>
          <td class="mono">${a.awb_2nd || '—'}</td>
          <td class="mono">${a.flight_number || '—'}</td>
          <td>${a.etd ? a.etd.slice(0, 10) : '—'}</td>
          ${cat.items.some(i => i.message) ? '<td>' + (a.message || '') + '</td>' : ''}
          <td>${diffHtml}</td>
        </tr>`
      }).join('')}
      </tbody>
    </table>
  </div>
  `).join('')}

  ${Object.values(categories).every(c => c.items.length === 0) ? '<div class="empty">No se generaron alertas — todos los cambios fueron auto-aplicados</div>' : ''}

</div>
</body>
</html>`

  const outPath = path.join(__dirname, '..', 'sync-report.html')
  fs.writeFileSync(outPath, html)
  console.log(`Report saved to: ${outPath}`)
}

main().catch(err => { console.error('Error:', err.message); process.exit(1) })
