const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

async function main() {
  const snap = await db.collection('airfreight_flights').limit(500).get()
  console.log('Total flights:', snap.size)
  let nullCount = 0
  const problems = []
  for (const d of snap.docs) {
    const data = d.data()
    if (!data.flight_datetime || typeof data.flight_datetime !== 'string') {
      nullCount++
      problems.push({
        id: d.id,
        airline: data.airline || '',
        flight_number: data.flight_number || '',
        status: data.status || '',
        flight_datetime: data.flight_datetime === undefined ? 'UNDEFINED' : data.flight_datetime === null ? 'NULL' : `type=${typeof data.flight_datetime} val=${data.flight_datetime}`,
        created_at: data.created_at || '',
      })
    }
  }
  console.log('Flights with null/missing/non-string flight_datetime:', nullCount)
  if (problems.length) {
    console.log(JSON.stringify(problems, null, 2))
  } else {
    console.log('All flights have valid flight_datetime strings')
  }
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
