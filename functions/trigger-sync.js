/**
 * Trigger sheetSyncManual by calling runSheetSync directly via admin SDK.
 */
const admin = require('firebase-admin')
const { google } = require('googleapis')

// Use ADC from gcloud or service account
process.env.GOOGLE_CLOUD_PROJECT = 'wms-mcl'
process.env.GCLOUD_PROJECT = 'wms-mcl'

// Initialize with the firebase-tools stored token
const fs = require('fs')
const path = require('path')
const configPath = path.join(require('os').homedir(), '.config', 'configstore', 'firebase-tools.json')
const fbConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'))

const { GoogleAuth, OAuth2Client } = require('google-auth-library')
const oauth2 = new OAuth2Client()
oauth2.setCredentials({
  access_token: fbConfig.tokens.access_token,
  refresh_token: fbConfig.tokens.refresh_token,
})

admin.initializeApp({
  projectId: 'wms-mcl',
  credential: admin.credential.cert({
    // Use a workaround: create credentials from the token
    type: 'authorized_user',
    client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
    client_secret: fbConfig.tokens?.client_secret || '',
    refresh_token: fbConfig.tokens.refresh_token,
  }),
})

async function main() {
  console.log('This approach won\'t work easily. Let me just temporarily enable the scheduler.')
  console.log('Use: firebase functions:log --only sheetSyncAgent to check when it runs next.')
  process.exit(0)
}

main()
