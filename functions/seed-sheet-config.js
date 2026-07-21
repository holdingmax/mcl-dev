/**
 * One-time script: seed _sheet_sync_configs for Express Line
 * Uses Firestore REST API with firebase CLI's stored token.
 * Run: node functions/seed-sheet-config.js
 */
const { execSync } = require('child_process')
const https = require('https')

const PROJECT = 'wms-mcl'
const SPREADSHEET_ID = '1-diJgoKpMMX64sYiMz4ZqpwL6usW3pJyS59hall_-Os'

function getAccessToken() {
  const raw = execSync('npx firebase-tools login:ci --token $(cat ~/.config/configstore/firebase-tools.json 2>/dev/null | node -pe "JSON.parse(require(\'fs\').readFileSync(\'/dev/stdin\',\'utf8\')).tokens?.refresh_token || \'\'") 2>/dev/null || echo ""', { encoding: 'utf-8' }).trim()
  return raw
}

function firestoreRest(method, path, body) {
  // Get token via firebase CLI
  const tokenJson = execSync('npx firebase-tools --json login:list', { encoding: 'utf-8' })
  // We'll use a different approach: use the configstore token directly
  return new Promise((resolve, reject) => {
    const configPath = require('path').join(require('os').homedir(), '.config', 'configstore', 'firebase-tools.json')
    let accessToken
    try {
      const config = JSON.parse(require('fs').readFileSync(configPath, 'utf-8'))
      accessToken = config.tokens?.access_token
      if (!accessToken) throw new Error('No access_token in firebase config')
    } catch (e) {
      reject(new Error('Cannot read firebase token: ' + e.message))
      return
    }

    const url = new URL(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${path}`)
    const options = {
      method,
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${data}`))
        else resolve(JSON.parse(data))
      })
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

async function main() {
  // 1. List airfreight_clients to find Express Line
  console.log('Searching for Express Line client...')
  const clientsResp = await firestoreRest('GET', 'airfreight_clients')
  const docs = clientsResp.documents || []
  const expressDoc = docs.find(d => {
    const nameField = d.fields?.name?.stringValue || ''
    return nameField.toLowerCase().includes('express')
  })

  if (!expressDoc) {
    console.error('Express Line client not found!')
    console.log('Available clients:', docs.map(d => d.fields?.name?.stringValue).filter(Boolean).join(', '))
    process.exit(1)
  }

  const clientId = expressDoc.name.split('/').pop()
  const clientName = expressDoc.fields?.name?.stringValue
  console.log(`Found: "${clientName}" (${clientId})`)

  // 2. Create config document
  const configBody = {
    fields: {
      client_id: { stringValue: clientId },
      client_name: { stringValue: clientName },
      spreadsheet_id: { stringValue: SPREADSHEET_ID },
      tab_name_pattern: { stringValue: 'month_en' },
      booking_type: { stringValue: 'ecommerce' },
      enabled: { booleanValue: true },
      created_at: { stringValue: new Date().toISOString() },
    }
  }

  const createUrl = `_sheet_sync_configs?documentId=${clientId}`
  try {
    await firestoreRest('POST', createUrl, configBody)
    console.log('Config document created successfully!')
  } catch (err) {
    if (err.message.includes('409') || err.message.includes('ALREADY_EXISTS')) {
      console.log('Document already exists, patching...')
      await firestoreRest('PATCH', `_sheet_sync_configs/${clientId}`, configBody)
      console.log('Config document updated!')
    } else {
      throw err
    }
  }

  console.log('\nConfig:')
  console.log(`  client: ${clientName} (${clientId})`)
  console.log(`  spreadsheet: ${SPREADSHEET_ID}`)
  console.log(`  tab_pattern: month_en`)
  console.log(`  enabled: true`)
}

main().catch(err => { console.error('Error:', err.message); process.exit(1) })
