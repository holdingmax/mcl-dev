const https = require('https'), path = require('path'), fs = require('fs'), PROJECT = 'wms-mcl'
function getToken() { const p = path.join(process.env.APPDATA || '', 'configstore/firebase-tools.json'); try { return exchangeToken(JSON.parse(fs.readFileSync(p, 'utf8')).tokens.refresh_token) } catch { return exchangeToken(JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.config/configstore/firebase-tools.json'), 'utf8')).tokens.refresh_token) } }
function exchangeToken(rt) { return new Promise((resolve, reject) => { const body = 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(rt) + '&client_id=563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com&client_secret=j9iVZfS8kkCEFUPaAeJV0sAi'; const req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { const j = JSON.parse(d); j.access_token ? resolve(j.access_token) : reject(d) }) }); req.on('error', reject); req.write(body); req.end() }) }
function fsQuery(token, sq) { return new Promise((resolve, reject) => { const body = JSON.stringify({ structuredQuery: sq }); const req = https.request({ hostname: 'firestore.googleapis.com', path: '/v1/projects/' + PROJECT + '/databases/(default)/documents:runQuery', method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)) } catch(e) { reject(d) } }) }); req.on('error', reject); req.write(body); req.end() }) }
function gf(doc, f) { const v = doc.fields && doc.fields[f]; if (!v) return null; if (v.stringValue !== undefined) return v.stringValue; if (v.timestampValue !== undefined) return v.timestampValue; return null }
async function main() {
  const token = await getToken()
  const movedRes = await fsQuery(token, { from: [{ collectionId: '_sheet_sync_alerts' }], where: { fieldFilter: { field: { fieldPath: 'alert_type' }, op: 'EQUAL', value: { stringValue: 'flight_moved' } } }, orderBy: [{ field: { fieldPath: 'created_at' }, direction: 'ASCENDING' }], limit: 50 })
  const docs = movedRes.filter(function(r) { return r.document })
  console.log('Total flight_moved alerts: ' + docs.length)
  for (const a of docs) {
    const d = a.document
    const awb1 = gf(d, 'awb_1st') || ''
    const fn = gf(d, 'flight_number') || ''
    const sf = gf(d, 'system_flight') || ''
    const msg = gf(d, 'message') || ''
    const etd = gf(d, 'etd') || ''
    const created = gf(d, 'created_at') || ''
    const diffsField = (d.fields.diffs && d.fields.diffs.arrayValue && d.fields.diffs.arrayValue.values) || []
    const diffsStr = diffsField.map(function(v) { const m = v.mapValue && v.mapValue.fields; if (!m) return '?'; return (m.field && m.field.stringValue || '') + ': ' + (m.old_value && m.old_value.stringValue || '') + ' -> ' + (m.new_value && m.new_value.stringValue || '') }).join(' | ')
    console.log('')
    console.log(created.slice(0,19) + ' | ' + awb1 + ' | ' + sf + ' -> ' + fn)
    console.log('  ETD=' + etd + ' | ' + diffsStr)
    console.log('  msg: ' + msg)
  }
}
main().catch(console.error)
