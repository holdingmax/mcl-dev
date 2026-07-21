const { initializeApp } = require('firebase/app');
const { getFirestore, collection, getDocs, doc, updateDoc, query, where } = require('firebase/firestore');
const { getAuth, signInWithEmailAndPassword } = require('firebase/auth');

const app = initializeApp({
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
});

const db = getFirestore(app);
const auth = getAuth(app);

// Fixes to apply
const fixes = [
  { flight_number: 'UC-1527', bad: '05/18T21:40:00', correct: '2026-05-18T21:40:00' },
  { flight_number: 'LA-0543', bad: '05/18T23:40:00', correct: '2026-05-18T23:40:00' },
  { flight_number: 'QT-4093', bad: '2026-05-20T40:00', correct: '2026-05-20T08:30:00' },
  { flight_number: 'UC-1711', bad: '05/18T13:05:00', correct: '2026-05-18T16:15:00' },
];

(async () => {
  // Auth - update with your credentials
  const email = process.argv[2];
  const pass = process.argv[3];
  if (!email || !pass) {
    console.log('Usage: node fix_flights.cjs <email> <password>');
    process.exit(1);
  }

  try {
    await signInWithEmailAndPassword(auth, email, pass);
    console.log('Authenticated OK');
  } catch (e) {
    console.error('Auth failed:', e.message);
    process.exit(1);
  }

  const snap = await getDocs(collection(db, 'airfreight_flights'));
  let fixed = 0;

  for (const d of snap.docs) {
    const f = d.data();
    for (const fix of fixes) {
      if (f.flight_datetime === fix.bad) {
        console.log(`FIXING: ${d.id} | ${f.flight_number} | ${fix.bad} → ${fix.correct}`);
        await updateDoc(doc(db, 'airfreight_flights', d.id), { flight_datetime: fix.correct });
        fixed++;
      }
    }
  }

  console.log(`\nDone. Fixed ${fixed} flight(s).`);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
