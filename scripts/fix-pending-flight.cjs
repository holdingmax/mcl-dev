const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

async function main() {
  const flightId = '28W72glznCydNkk51556'
  const fRef = db.collection('airfreight_flights').doc(flightId)
  const fDoc = await fRef.get()
  const f = fDoc.data()
  console.log('Current flight:', f.flight_number, '| datetime:', f.flight_datetime, '| status:', f.status)

  // Fix: set flight_datetime to today, status to open
  const today = new Date().toISOString().slice(0, 10) + 'T00:00:00'
  await fRef.update({
    flight_datetime: today,
    status: 'open',
  })
  console.log('Updated flight_datetime to', today, 'and status to open')

  // Verify
  const fDoc2 = await fRef.get()
  const f2 = fDoc2.data()
  console.log('After fix:', f2.flight_number, '| datetime:', f2.flight_datetime, '| status:', f2.status)

  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
