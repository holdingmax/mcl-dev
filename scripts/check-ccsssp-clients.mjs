#!/usr/bin/env node
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
  const res = await fetch(`${BASE}/airfreight_clients?pageSize=50`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  const data = await res.json()

  for (const doc of (data.documents || [])) {
    const f = doc.fields || {}
    const name = str(f, 'name')
    const tsa = str(f, 'ccsssp_tsa_number')
    const company = str(f, 'ccsssp_company_name')
    const logo = str(f, 'ccsssp_logo_url')
    const logoR = str(f, 'ccsssp_logo_right_url')

    if (tsa || logo) {
      console.log(`\n=== ${name} ===`)
      console.log(`  Company: ${company || '(vacio)'}`)
      console.log(`  TSA#: ${tsa || '(vacio)'}`)
      console.log(`  Address: ${str(f, 'ccsssp_address') || '(vacio)'}`)
      console.log(`  Phone: ${str(f, 'ccsssp_phone') || '(vacio)'}`)
      console.log(`  Email: ${str(f, 'ccsssp_email') || '(vacio)'}`)
      console.log(`  Logo izq: ${logo ? logo.slice(0, 80) + '...' : '(vacio)'}`)
      console.log(`  Logo der: ${logoR ? logoR.slice(0, 80) + '...' : '(vacio)'}`)
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
