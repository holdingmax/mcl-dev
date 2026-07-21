/**
 * Count AWBs by airline prefix (May-June 2026)
 */
const admin = require('firebase-admin')
const sa = require('C:/Users/dgarc/Downloads/wms-mcl-firebase-adminsdk-fbsvc-0ba6a0c8c7.json')
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'wms-mcl' })
const db = admin.firestore()

const AIRLINE_NAMES = {
  '369': 'Atlas Air',
  '160': 'Cathay Cargo',
  '235': 'Turkish Cargo',
  '936': 'DHL Air',
  '172': 'Cargolux',
  '297': 'China Airlines',
  '501': 'Silk Way West',
  '999': 'Air China Cargo',
}

async function main() {
  const snap = await db.collection('airfreight_bookings')
    .where('created_at', '>=', '2026-05-01')
    .where('created_at', '<=', '2026-06-30')
    .get()

  const counts = {}
  let total = 0

  for (const doc of snap.docs) {
    const b = doc.data()
    if (b.status === 'cancelled') continue
    if (!b.awb_lines || !Array.isArray(b.awb_lines)) continue
    for (const line of b.awb_lines) {
      const rawAwb = line.awb_number || ''
      if (!rawAwb) continue
      const match = rawAwb.match(/^(\d{3})-/)
      if (!match) continue
      const prefix = match[1]
      if (!counts[prefix]) counts[prefix] = 0
      counts[prefix]++
      total++
    }
  }

  // Sort by count descending
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])

  console.log(`\nAWBs by airline (May-June 2026) — ${snap.size} bookings, ${total} AWB lines\n`)
  console.log('Prefix | Airline              | AWBs')
  console.log('-------|----------------------|-----')
  for (const [prefix, count] of sorted) {
    const name = AIRLINE_NAMES[prefix] || '(unknown)'
    console.log(`  ${prefix}  | ${name.padEnd(20)} | ${count}`)
  }

  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
