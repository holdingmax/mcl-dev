const https = require('https'), path = require('path'), fs = require('fs'), PROJECT = 'wms-mcl'
function getToken() { const p = path.join(process.env.APPDATA || '', 'configstore/firebase-tools.json'); try { return exchangeToken(JSON.parse(fs.readFileSync(p, 'utf8')).tokens.refresh_token) } catch { return exchangeToken(JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.config/configstore/firebase-tools.json'), 'utf8')).tokens.refresh_token) } }
function exchangeToken(rt) { return new Promise((resolve, reject) => { const body = 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(rt) + '&client_id=563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com&client_secret=j9iVZfS8kkCEFUPaAeJV0sAi'; const req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { const j = JSON.parse(d); j.access_token ? resolve(j.access_token) : reject(d) }) }); req.on('error', reject); req.write(body); req.end() }) }
function fsQuery(token, sq) { return new Promise((resolve, reject) => { const body = JSON.stringify({ structuredQuery: sq }); const req = https.request({ hostname: 'firestore.googleapis.com', path: '/v1/projects/' + PROJECT + '/databases/(default)/documents:runQuery', method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)) } catch(e) { reject(d) } }) }); req.on('error', reject); req.write(body); req.end() }) }
function gf(doc, f) { const v = doc.fields && doc.fields[f]; if (!v) return null; if (v.stringValue !== undefined) return v.stringValue; if (v.timestampValue !== undefined) return v.timestampValue; return null }
async function main() {
  const token = await getToken()
  // Get ALL alerts, no filter — just count types
  const allRes = await fsQuery(token, { from: [{ collectionId: '_sheet_sync_alerts' }], limit: 300 })
  const docs = allRes.filter(function(r) { return r.document })
  console.log('Total alerts in collection: ' + docs.length)
  const typeCounts = {}
  for (const a of docs) {
    const d = a.document
    const atype = gf(d, 'alert_type') || 'unknown'
    typeCounts[atype] = (typeCounts[atype] || 0) + 1
    if (atype === 'flight_moved') {
      const awb1 = gf(d, 'awb_1st') || ''
      const fn = gf(d, 'flight_number') || ''
      const sf = gf(d, 'system_flight') || ''
      const created = gf(d, 'created_at') || ''
      console.log('  MOVED: ' + created.slice(0,19) + ' ' + awb1 + ' ' + sf + ' -> ' + fn)
    }
  }
  console.log('\nAlert type counts:')
  for (const [k, v] of Object.entries(typeCounts).sort(function(a,b) { return b[1] - a[1] })) {
    console.log('  ' + k + ': ' + v)
  }
}
main().catch(console.error)
