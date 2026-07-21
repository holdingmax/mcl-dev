#!/usr/bin/env node
/**
 * Move client logos from root to airfreight/client-logos/ path
 * and update Firestore client records with new paths.
 */
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const PROJECT_ID = 'wms-mcl'
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`

function getRefreshToken() {
  const p = join(homedir(), '.config', 'configstore', 'firebase-tools.json')
  return JSON.parse(readFileSync(p, 'utf-8')).tokens.refresh_token
}

async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: getRefreshToken(),
      client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
      client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
    }),
  })
  return (await res.json()).access_token
}

function str(f, k) { return f?.[k]?.stringValue || '' }

async function main() {
  const TOKEN = await getAccessToken()

  // Find Express Line client
  const res = await fetch(`${BASE}/airfreight_clients?pageSize=50`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  const data = await res.json()

  for (const doc of (data.documents || [])) {
    const f = doc.fields || {}
    const name = str(f, 'name')
    const logoL = str(f, 'ccsssp_logo_url')
    const logoR = str(f, 'ccsssp_logo_right_url')

    if (!logoL && !logoR) continue

    console.log(`\n${name}:`)
    console.log(`  Current logo left:  ${logoL}`)
    console.log(`  Current logo right: ${logoR}`)

    // Extract old paths
    const pathL = logoL ? logoL.replace(/^gs:\/\/[^\/]+\//, '') : ''
    const pathR = logoR ? logoR.replace(/^gs:\/\/[^\/]+\//, '') : ''

    console.log(`  Path left:  ${pathL}`)
    console.log(`  Path right: ${pathR}`)
    console.log('')
    console.log('  ACTION NEEDED: Upload these files to airfreight/client-logos/ in Firebase Console')
    console.log('  Then update the client record with new gs:// paths like:')
    if (pathL) console.log(`    Logo izq: gs://wms-mcl.firebasestorage.app/airfreight/client-logos/${name.toLowerCase().replace(/\s+/g, '-')}-logo.png`)
    if (pathR) console.log(`    Logo der: gs://wms-mcl.firebasestorage.app/airfreight/client-logos/${name.toLowerCase().replace(/\s+/g, '-')}-ctpat.png`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
