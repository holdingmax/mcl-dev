// Check what headers the JUNE 2026 tab currently has in the spreadsheet
const https = require('https'), path = require('path'), fs = require('fs')
const PROJECT = 'wms-mcl'

function getToken() {
  const p = path.join(process.env.APPDATA || '', 'configstore/firebase-tools.json')
  try { return exchangeToken(JSON.parse(fs.readFileSync(p, 'utf8')).tokens.refresh_token) }
  catch { return exchangeToken(JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.config/configstore/firebase-tools.json'), 'utf8')).tokens.refresh_token) }
}
function exchangeToken(rt) {
  return new Promise((resolve, reject) => {
    const body = 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(rt) + '&client_id=563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com&client_secret=j9iVZfS8kkCEFUPaAeJV0sAi'
    const req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { const j = JSON.parse(d); j.access_token ? resolve(j.access_token) : reject(d) })
    }); req.on('error', reject); req.write(body); req.end()
  })
}
function fsQuery(token, sq) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ structuredQuery: sq })
    const req = https.request({ hostname: 'firestore.googleapis.com', path: '/v1/projects/' + PROJECT + '/databases/(default)/documents:runQuery', method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)) } catch(e) { reject(d) } })
    }); req.on('error', reject); req.write(body); req.end()
  })
}
function sheetsGet(token, spreadsheetId, range) {
  return new Promise((resolve, reject) => {
    const encodedRange = encodeURIComponent(range)
    const req = https.request({ hostname: 'sheets.googleapis.com', path: `/v4/spreadsheets/${spreadsheetId}/values/${encodedRange}`, method: 'GET', headers: { Authorization: 'Bearer ' + token } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)) } catch(e) { reject(d) } })
    }); req.on('error', reject); req.end()
  })
}
function sheetsMeta(token, spreadsheetId) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'sheets.googleapis.com', path: `/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties.title`, method: 'GET', headers: { Authorization: 'Bearer ' + token } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)) } catch(e) { reject(d) } })
    }); req.on('error', reject); req.end()
  })
}

async function main() {
  const token = await getToken()

  // Get spreadsheet_id from Firestore config
  const cfgRes = await fsQuery(token, { from: [{collectionId: '_sheet_sync_configs'}], where: {fieldFilter:{field:{fieldPath:'enabled'},op:'EQUAL',value:{booleanValue:true}}}, limit: 5 })
  const configs = cfgRes.filter(r => r.document)
  if (configs.length === 0) { console.log('No enabled configs found'); return }

  for (const cfg of configs) {
    const fields = cfg.document.fields
    const clientName = fields.client_name && fields.client_name.stringValue || '?'
    const spreadsheetId = fields.spreadsheet_id && fields.spreadsheet_id.stringValue
    console.log('Client: ' + clientName + ' | Spreadsheet: ' + spreadsheetId)

    if (!spreadsheetId) { console.log('  No spreadsheet_id!'); continue }

    const meta = await sheetsMeta(token, spreadsheetId)
    if (!meta.sheets) { console.log('  Error getting tabs:', JSON.stringify(meta).slice(0, 200)); continue }
    const tabs = meta.sheets.map(s => s.properties.title)
    console.log('  All tabs: ' + tabs.join(' | '))

    // Find June tab
    const juneTab = tabs.find(t => t.toUpperCase().includes('JUNE') || t.toUpperCase().includes('JUNIO'))
    if (!juneTab) { console.log('  NO JUNE TAB FOUND!'); continue }
    console.log('  June tab: "' + juneTab + '"')

    // Read first 5 rows
    const data = await sheetsGet(token, spreadsheetId, `'${juneTab}'!A1:Z5`)
    console.log('  First 5 rows:')
    if (data.values) {
      for (let i = 0; i < data.values.length; i++) {
        console.log('    Row ' + (i+1) + ': ' + JSON.stringify(data.values[i]))
      }
    } else {
      console.log('    (no data)')
    }

    // Also show May tab for comparison
    const mayTab = tabs.find(t => t.toUpperCase().includes('MAY') || t.toUpperCase().includes('MAYO'))
    if (mayTab) {
      const mayData = await sheetsGet(token, spreadsheetId, `'${mayTab}'!A1:Z3`)
      console.log('\n  May tab "' + mayTab + '" first 3 rows:')
      if (mayData.values) {
        for (let i = 0; i < mayData.values.length; i++) {
          console.log('    Row ' + (i+1) + ': ' + JSON.stringify(mayData.values[i]))
        }
      }
    }
  }
}
main().catch(console.error)
