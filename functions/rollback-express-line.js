/**
 * Rollback script: Restore Express Line data from migration backup.
 *
 * Usage: node functions/rollback-express-line.js [--apply]
 * Without --apply: dry-run (shows what would be restored).
 * Requires migration-backup.json in project root.
 */

const fs = require('fs')
const path = require('path')
const https = require('https')

const PROJECT_ID = 'wms-mcl'
const DRY_RUN = !process.argv.includes('--apply')

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

function toFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null }
  if (typeof val === 'boolean') return { booleanValue: val }
  if (typeof val === 'number') return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val }
  if (typeof val === 'string') return { stringValue: val }
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFirestoreValue) } }
  if (typeof val === 'object') {
    const fields = {}
    for (const [k, v] of Object.entries(val)) fields[k] = toFirestoreValue(v)
    return { mapValue: { fields } }
  }
  return { stringValue: String(val) }
}

function patchDoc(token, docPath, fieldsToUpdate) {
  return new Promise((resolve, reject) => {
    const updateMask = Object.keys(fieldsToUpdate).map(f => `updateMask.fieldPaths=${f}`).join('&')
    const body = { fields: {} }
    for (const [k, v] of Object.entries(fieldsToUpdate)) body.fields[k] = toFirestoreValue(v)
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
        } catch { reject(new Error('Bad response: ' + data.slice(0, 200))) }
      })
    })
    req.on('error', reject)
    req.write(postData)
    req.end()
  })
}

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN (no writes) ===' : '=== APPLYING ROLLBACK ===')

  const backupPath = path.join(__dirname, '..', 'migration-backup.json')
  if (!fs.existsSync(backupPath)) {
    console.error('migration-backup.json not found. Cannot rollback.')
    process.exit(1)
  }

  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'))
  const flightCount = Object.keys(backup.flights || {}).length
  const bookingCount = Object.keys(backup.bookings || {}).length
  console.log(`Backup contains: ${flightCount} flights, ${bookingCount} bookings`)

  const home = process.env.USERPROFILE || process.env.HOME
  const cfgPath = path.join(home, '.config', 'configstore', 'firebase-tools.json')
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  const refreshToken = cfg.tokens && cfg.tokens.refresh_token
  if (!refreshToken) { console.error('No refresh token'); process.exit(1) }

  const token = await exchangeRefreshToken(refreshToken)
  console.log('Authenticated')

  // Restore flights
  for (const [id, fields] of Object.entries(backup.flights || {})) {
    console.log(`  Restore flight ${id}: ${JSON.stringify(fields)}`)
    if (!DRY_RUN) {
      await patchDoc(token, `airfreight_flights/${id}`, fields)
    }
  }

  // Restore bookings
  for (const [id, fields] of Object.entries(backup.bookings || {})) {
    const fieldNames = Object.keys(fields)
    console.log(`  Restore booking ${id}: [${fieldNames.join(', ')}]`)
    if (!DRY_RUN) {
      await patchDoc(token, `airfreight_bookings/${id}`, fields)
    }
  }

  console.log(`\nDone. ${DRY_RUN ? 'DRY RUN' : 'ROLLBACK APPLIED'}`)
}

main().catch(e => { console.error(e); process.exit(1) })
