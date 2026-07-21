/**
 * Tag "no flight" jobs with flight_type: "local_job".
 * These are real operations (handling, local delivery) without an actual flight.
 * Usage: node functions/tag-local-jobs.js [--apply]
 */
const fs = require('fs')
const path = require('path')
const https = require('https')

const PROJECT_ID = 'wms-mcl'
const DRY_RUN = !process.argv.includes('--apply')

const FLIGHT_IDS = [
  '188V4EyVzVA2Asy9wlQj',
  'mL67AfTAfMkUdkaIbFjL',
  'Nu31H3am81lnL67LIL23',
  'iON6Fd7LE64DvAQBwxUx',
]

function exchangeRefreshToken(refreshToken) {
  return new Promise((resolve, reject) => {
    const postData = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}&client_id=563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com&client_secret=j9iVZfS8kkCEFUPaAeJV0sAi`
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        const parsed = JSON.parse(data)
        if (parsed.access_token) resolve(parsed.access_token)
        else reject(new Error(parsed.error_description || 'Token exchange failed'))
      })
    })
    req.on('error', reject)
    req.write(postData)
    req.end()
  })
}

function patchDoc(token, docPath, fieldsToUpdate) {
  return new Promise((resolve, reject) => {
    const updateMask = Object.keys(fieldsToUpdate).map(f => `updateMask.fieldPaths=${f}`).join('&')
    const body = { fields: {} }
    for (const [k, v] of Object.entries(fieldsToUpdate)) {
      body.fields[k] = { stringValue: v }
    }
    const postData = JSON.stringify(body)
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/${PROJECT_ID}/databases/(default)/documents/${docPath}?${updateMask}`,
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          if (parsed.error) reject(new Error(parsed.error.message))
          else resolve(parsed)
        } catch { reject(new Error('Bad response')) }
      })
    })
    req.on('error', reject)
    req.write(postData)
    req.end()
  })
}

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN ===' : '=== APPLYING ===')

  const home = process.env.USERPROFILE || process.env.HOME
  const cfgPath = path.join(home, '.config', 'configstore', 'firebase-tools.json')
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  const token = await exchangeRefreshToken(cfg.tokens.refresh_token)

  for (const id of FLIGHT_IDS) {
    console.log(`  Tag flight ${id} → flight_type: "local_job"`)
    if (!DRY_RUN) {
      await patchDoc(token, `airfreight_flights/${id}`, { flight_type: 'local_job' })
    }
  }

  console.log(`\nDone. ${FLIGHT_IDS.length} flights tagged.`)
}

main().catch(e => { console.error(e); process.exit(1) })
