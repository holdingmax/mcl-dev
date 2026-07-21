import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const config = JSON.parse(readFileSync(join(homedir(), '.config', 'configstore', 'firebase-tools.json'), 'utf8'))
const rt = config.tokens.refresh_token
const res = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({grant_type:'refresh_token',refresh_token:rt,client_id:'563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',client_secret:'j9iVZfS8kkCEFUPaAeJV0sAi'})})
const token = (await res.json()).access_token

const BASE = 'https://firestore.googleapis.com/v1/projects/wms-mcl/databases/(default)/documents'
const configRes = await fetch(BASE + ':runQuery', {
  method:'POST', headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
  body: JSON.stringify({structuredQuery:{from:[{collectionId:'_sheet_sync_configs'}],limit:10}})
})
const configs = (await configRes.json()).filter(d => d.document)
let sheetId = null
for (const c of configs) {
  const f = c.document.fields
  sheetId = f.spreadsheet_id?.stringValue
  console.log(`Config: client=${f.client_name?.stringValue} | spreadsheet_id=${sheetId} | enabled=${f.enabled?.booleanValue}`)
}

if (!sheetId) { console.log('No sheet ID found'); process.exit(1) }

const SHEETS_BASE = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`
const sheetMeta = await fetch(SHEETS_BASE, { headers:{Authorization:'Bearer '+token} })
const meta = await sheetMeta.json()

// Find the tab matching the pattern
const tabs = (meta.sheets || []).map(s => s.properties.title)
console.log(`Tabs: ${tabs.join(', ')}`)

// Use the first tab or one matching a pattern
const tabPattern = 'May 2026'
const tab = tabs.find(t => t.toLowerCase().includes('may')) || tabs[0]
console.log(`Using tab: ${tab}`)

const dataRes = await fetch(`${SHEETS_BASE}/values/${encodeURIComponent(tab)}`, { headers:{Authorization:'Bearer '+token} })
const data = await dataRes.json()
const rows = data.values || []
console.log(`Total rows: ${rows.length}`)

// Find header row
for (let i = 0; i < 15; i++) {
  const rowStr = (rows[i] || []).join(' ').toLowerCase()
  if (rowStr.includes('awb') || rowStr.includes('hold')) {
    console.log(`\nRow ${i} (possible header): ${(rows[i]||[]).slice(0,15).join(' | ')}`)
  }
}

// Search for both AWBs
console.log('\n=== CONTEXT AROUND 3283 / 3305 ===')
let foundIdx = -1
for (let i = 0; i < rows.length; i++) {
  const rowStr = (rows[i] || []).join(' ')
  if (rowStr.includes('3283')) {
    foundIdx = i
    break
  }
}

if (foundIdx >= 0) {
  const start = Math.max(0, foundIdx - 2)
  const end = Math.min(rows.length, foundIdx + 35)
  for (let j = start; j < end; j++) {
    const r = rows[j] || []
    const rowStr = r.join(' ')
    const marker = rowStr.includes('3283') ? ' <<< 3283' : rowStr.includes('3305') ? ' <<< 3305' : ''
    const cells = r.slice(0, 15).map(c => String(c||'').substring(0,28)).join(' | ')
    console.log(`  [${j}] ${cells}${marker}`)
  }
} else {
  console.log('AWB 3283 not found in sheet')
}
