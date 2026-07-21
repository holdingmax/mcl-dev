// One-time backfill: re-trigger AI processing for all AWBs in flight M4003
// Uses Firebase Web SDK (no service account needed)

import { initializeApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth'
import { getFirestore, collection, query, where, getDocs, doc, updateDoc } from 'firebase/firestore'

const EMAIL = process.env.FB_EMAIL
const PASSWORD = process.env.FB_PASSWORD
if (!EMAIL || !PASSWORD) {
  console.error('Usage: FB_EMAIL=x FB_PASSWORD=y node scripts/backfill_awb_fields.mjs')
  process.exit(1)
}

const app = initializeApp({
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
})

const auth = getAuth(app)
const db = getFirestore(app)

async function main() {
  console.log(`Signing in as ${EMAIL}...`)
  await signInWithEmailAndPassword(auth, EMAIL, PASSWORD)
  console.log('Authenticated.')

  // Find flight M4003
  const flightsSnap = await getDocs(query(
    collection(db, 'av_flights'),
    where('flight_number', '==', 'M4003')
  ))

  if (flightsSnap.empty) {
    console.log('No flight M4003 found')
    process.exit(1)
  }

  for (const flightDoc of flightsSnap.docs) {
    const flightId = flightDoc.id
    const fd = flightDoc.data()
    console.log(`Flight: ${flightId} — ${fd.flight_number} (${fd.flight_date})`)

    const awbsSnap = await getDocs(query(
      collection(db, 'av_flight_awbs'),
      where('flight_id', '==', flightId)
    ))

    console.log(`Found ${awbsSnap.size} AWBs`)

    for (const awbDoc of awbsSnap.docs) {
      const awb = awbDoc.data()
      if (!awb.doc_awb_url) {
        console.log(`  SKIP ${awb.awb_number} — no doc_awb_url`)
        continue
      }
      console.log(`  Resetting ${awb.awb_number} to pending...`)
      await updateDoc(doc(db, 'av_flight_awbs', awbDoc.id), {
        ai_status: 'pending',
        updated_at: new Date().toISOString(),
      })
      // Delay to avoid overwhelming the cloud function
      await new Promise(r => setTimeout(r, 3000))
    }
  }

  console.log('Done. AWBs will be re-processed by avProcessAwbDocs trigger.')
  process.exit(0)
}

main().catch(err => { console.error(err); process.exit(1) })
