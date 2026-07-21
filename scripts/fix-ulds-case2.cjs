// Reassign 5 buildup_ulds from deleted flight to new flight — Case 2
const https = require('https')
const path = require('path')
const fs = require('fs')
const PROJECT = 'wms-mcl'

function getToken() {
  const p = path.join(process.env.APPDATA || '', 'configstore/firebase-tools.json')
  try { return exchangeToken(JSON.parse(fs.readFileSync(p, 'utf8')).tokens.refresh_token) }
  catch { return exchangeToken(JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.config/configstore/firebase-tools.json'), 'utf8')).tokens.refresh_token) }
}
function exchangeToken(rt) {
  return new Promise((resolve, reject) => {
    const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(rt)}&client_id=563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com&client_secret=j9iVZfS8kkCEFUPaAeJV0sAi`
    const req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { const j = JSON.parse(d); j.access_token ? resolve(j.access_token) : reject(d) })
    }); req.on('error', reject); req.write(body); req.end()
  })
}
function firestorePatch(token, docPath, fields, updateMask) {
  return new Promise((resolve, reject) => {
    const maskParams = updateMask.map(f => `updateMask.fieldPaths=${f}`).join('&')
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/${PROJECT}/databases/(default)/documents/${docPath}?${maskParams}`,
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        try { const j = JSON.parse(d); j.error ? reject(JSON.stringify(j.error)) : resolve(j) } catch (e) { reject(d) }
      })
    }); req.on('error', reject); req.write(JSON.stringify({ fields })); req.end()
  })
}

const NEW_FLIGHT_ID = 'eSpKSthqdhToPjzBUGRv'
const ULD_IDS = [
  { id: 'MUhRYr9gEfgfCCNXrkZA', uld: '40933R7' },
  { id: 'hx0yJnBDeHoZHgqrvlvc', uld: '57153R7' },
  { id: 'i2fVAOF16SGQmShrUYKa', uld: '50388LA' },
  { id: 'ihdndKPuIJ6bYt2gmG4U', uld: '13436R9' },
  { id: 'z0wWjSvffCn91eHFqDDK', uld: '32215R9' },
]

async function main() {
  const token = await getToken()
  console.log('Token OK\n')

  for (const uld of ULD_IDS) {
    await firestorePatch(token, `buildup_ulds/${uld.id}`, {
      flight_id: { stringValue: NEW_FLIGHT_ID },
    }, ['flight_id'])
    console.log(`✓ ULD ${uld.uld} (${uld.id}) → flight_id=${NEW_FLIGHT_ID}`)
  }

  console.log('\nDone — 5 ULDs reassigned to new flight.')
}

main().catch(console.error)
