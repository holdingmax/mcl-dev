import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const config = JSON.parse(readFileSync(join(homedir(), '.config', 'configstore', 'firebase-tools.json'), 'utf8'))
const rt = config.tokens.refresh_token
const res = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({grant_type:'refresh_token',refresh_token:rt,client_id:'563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',client_secret:'j9iVZfS8kkCEFUPaAeJV0sAi'})})
const token = (await res.json()).access_token
const BASE = 'https://firestore.googleapis.com/v1/projects/wms-mcl/databases/(default)/documents'

async function runQuery(collectionId, extraQuery = {}) {
  const qr = await fetch(BASE + ':runQuery', {
    method:'POST', headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body: JSON.stringify({structuredQuery:{from:[{collectionId}],limit:500, ...extraQuery}})
  })
  return (await qr.json()).filter(d => d.document)
}

// Get recent sync runs with all fields
const runs = await runQuery('_sheet_sync_runs', {orderBy:[{field:{fieldPath:'run_at'},direction:'DESCENDING'}],limit:10})
for (const d of runs) {
  const f = d.document.fields
  const runAt = f.run_at?.stringValue || '?'
  const changes = f.changes_detected?.integerValue || '0'
  const applied = f.changes_applied?.integerValue || '0'
  console.log(`\n=== RUN: ${runAt} | changes=${changes} | applied=${applied} ===`)
  // Print all fields to see what data is available
  for (const [key, val] of Object.entries(f)) {
    if (key === 'run_at' || key === 'changes_detected' || key === 'changes_applied') continue
    const strVal = val.stringValue || val.integerValue || val.booleanValue || ''
    if (val.arrayValue) {
      const items = val.arrayValue.values || []
      console.log(`  ${key}: [${items.length} items]`)
      for (const item of items.slice(0, 5)) {
        if (item.stringValue) console.log(`    - ${item.stringValue}`)
        if (item.mapValue) {
          const mf = item.mapValue.fields || {}
          const parts = Object.entries(mf).map(([k,v]) => `${k}=${v.stringValue||v.integerValue||v.booleanValue||''}`).join(', ')
          console.log(`    - {${parts}}`)
        }
      }
      if (items.length > 5) console.log(`    ... and ${items.length - 5} more`)
    } else if (val.mapValue) {
      console.log(`  ${key}: {map with keys: ${Object.keys(val.mapValue.fields||{}).join(', ')}}`)
    } else {
      console.log(`  ${key}: ${strVal}`)
    }
  }
}

// Also check: what does the booking awb_line look like for 3305?
console.log('\n\n=== BOOKING AWB_LINE DETAIL FOR 369-99783305 ===')
const bookings = await runQuery('airfreight_bookings')
for (const d of bookings) {
  const f = d.document.fields
  const lines = f.awb_lines?.arrayValue?.values || []
  for (const line of lines) {
    const lf = line.mapValue?.fields || {}
    const awb = (lf.awb_number?.stringValue || '').replace(/[-\s]/g, '')
    if (awb === '36999783305') {
      console.log('Full awb_line fields:')
      for (const [k, v] of Object.entries(lf)) {
        if (v.arrayValue) {
          console.log(`  ${k}: [${(v.arrayValue.values||[]).length} items]`)
          for (const item of (v.arrayValue.values||[])) {
            if (item.mapValue) {
              const mf = item.mapValue.fields || {}
              console.log(`    - ${JSON.stringify(Object.fromEntries(Object.entries(mf).map(([a,b])=>[a,b.stringValue||b.booleanValue||''])))}`)
            }
          }
        } else {
          console.log(`  ${k}: ${v.stringValue || v.integerValue || v.booleanValue || v.doubleValue || ''}`)
        }
      }
    }
  }
}
