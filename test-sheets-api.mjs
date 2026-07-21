import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
const config = JSON.parse(readFileSync(join(homedir(), '.config', 'configstore', 'firebase-tools.json'), 'utf8'))
const rt = config.tokens.refresh_token
const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt,
    client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
    client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/cloud-platform',
  }),
})
const data = await res.json()
const token = data.access_token
console.log('Token obtained:', !!token)

const SPREADSHEET_ID = '1-diJgoKpMMX64sYiMz4ZqpwL6usW3pJyS59hall_-Os'
const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?fields=sheets.properties.title`, { headers: { Authorization: 'Bearer ' + token } })
const metaBody = await metaRes.text()
console.log('Status:', metaRes.status)
console.log('Response:', metaBody.slice(0, 500))
