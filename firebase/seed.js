/**
 * Seed initial consignees into Firestore.
 *
 * Usage:
 *   1. Install firebase-admin:  npm install -g firebase-admin
 *   2. Download your Firebase service account key:
 *      Firebase Console → Project Settings → Service Accounts → Generate new private key
 *      Save as firebase/serviceAccountKey.json  (DO NOT commit this file)
 *   3. Run:  node firebase/seed.js
 */

const admin = require('firebase-admin')
const serviceAccount = require('./serviceAccountKey.json')

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})

const db = admin.firestore()

const consignees = [
  { name: 'MINCURL LOGISTICS',  full_address: '3050 NW 107 AVE, SUITE 440, DORAL, FL 33172' },
  { name: 'AEROPOST',           full_address: '1630 NW 82ND AVE, DORAL, FL 33126' },
  { name: 'JETBOX',             full_address: '8400 NW 25TH ST, SUITE 100, MIAMI, FL 33122' },
  { name: 'MAILBOXES PANAMA',   full_address: '500 NW 68TH AVE, MIAMI, FL 33126' },
  { name: 'GENERAL CARGO',      full_address: '3250 NW 87TH AVE, DORAL, FL 33172' },
]

async function seed() {
  const batch = db.batch()

  for (const c of consignees) {
    const ref = db.collection('consignees').doc()
    batch.set(ref, c)
  }

  // Initialize WR sequence counter
  batch.set(db.collection('config').doc('wr_sequence'), { last_num: 0 })

  await batch.commit()
  console.log('Seed completado: consignatarios y secuencia WR inicializados.')
  process.exit(0)
}

seed().catch(err => {
  console.error(err)
  process.exit(1)
})
