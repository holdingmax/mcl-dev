const { initializeApp } = require('firebase/app')
const { getFunctions, httpsCallable, connectFunctionsEmulator } = require('firebase/functions')

const app = initializeApp({
  apiKey: 'AIzaSyDummyKeyNotNeededForCallable',
  projectId: 'wms-mcl',
})

const functions = getFunctions(app, 'us-east1')

async function main() {
  console.log('Calling sheetSyncManual...')
  const callable = httpsCallable(functions, 'sheetSyncManual')
  const result = await callable({})
  console.log('Result:', JSON.stringify(result.data, null, 2))
}

main().catch(e => { console.error(e); process.exit(1) })
