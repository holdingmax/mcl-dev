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

async function listCollection(token, col) {
  const docs = []
  let pageToken = ''
  while (true) {
    const url = `${BASE}/${col}?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    const data = await res.json()
    if (data.documents) docs.push(...data.documents)
    if (!data.nextPageToken) break
    pageToken = data.nextPageToken
  }
  return docs
}

function str(f, k) { return f?.[k]?.stringValue || '' }
function num(f, k) { return f?.[k]?.integerValue ? parseInt(f[k].integerValue) : 0 }
function bool(f, k) { return f?.[k]?.booleanValue || false }

async function main() {
  const TOKEN = await getAccessToken()
  const AWB = '729-93889456'
  const AWB2 = '297-73671080'

  console.log(`Searching for AWB ${AWB} or ${AWB2}...\n`)

  // Check DocReceptions
  console.log('=== DocReceptions ===')
  const drs = await listCollection(TOKEN, 'airfreight_doc_receptions')
  for (const d of drs) {
    const f = d.fields || {}
    const awb = str(f, 'awb_number')
    const awb2 = str(f, 'awb_2nd_leg')
    if (awb.includes('729-9388') || awb2.includes('729-9388') || awb.includes('297-7367108') || awb2.includes('297-7367108')) {
      const id = d.name.split('/').pop()
      console.log(`  DR ${id}:`)
      console.log(`    awb_number: ${awb}`)
      console.log(`    awb_2nd_leg: ${awb2}`)
      console.log(`    booking_id: ${str(f, 'booking_id')}`)
      console.log(`    awb_index: ${num(f, 'awb_index')}`)
      console.log(`    status: ${str(f, 'status')}`)
      console.log(`    flight_number: ${str(f, 'flight_number')}`)
    }
  }

  // Check Bookings
  console.log('\n=== Bookings ===')
  const bookings = await listCollection(TOKEN, 'airfreight_bookings')
  for (const b of bookings) {
    const f = b.fields || {}
    const lines = f.awb_lines?.arrayValue?.values || []
    for (let i = 0; i < lines.length; i++) {
      const lf = lines[i]?.mapValue?.fields || {}
      const awb = str(lf, 'awb_number')
      const awb2 = str(lf, 'awb_2nd_leg')
      if (awb.includes('729-9388') || awb2.includes('729-9388') || awb.includes('297-7367108') || awb2.includes('297-7367108')) {
        const id = b.name.split('/').pop()
        console.log(`  Booking ${id} line[${i}]:`)
        console.log(`    awb_number: ${awb}`)
        console.log(`    awb_2nd_leg: ${awb2}`)
        console.log(`    warehouse_status: ${str(lf, 'warehouse_status')}`)
        console.log(`    on_hand: ${bool(lf, 'on_hand')}`)
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
