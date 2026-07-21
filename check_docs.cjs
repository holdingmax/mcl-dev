const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc } = require('firebase/firestore');
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

async function checkBooking(id, label) {
  const snap = await getDoc(doc(db, 'airfreight_bookings', id));
  if (!snap.exists()) { console.log(label, 'NOT FOUND'); return; }
  const d = snap.data();
  console.log('\n=== ' + label + ' ===');
  console.log('client:', d.client_name, '| AWB:', d.awb_number || d.mawb_number);
  console.log('flight_id:', d.flight_id);
  console.log('booking_type:', d.booking_type);

  // Top-level documents
  if (d.documents) {
    const keys = Object.keys(d.documents);
    console.log('documents keys:', keys);
    for (const k of keys) {
      const v = d.documents[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && v.url) {
        console.log('  ' + k + ' -> uploaded_at:', v.uploaded_at, '| filename:', v.filename);
      } else if (Array.isArray(v)) {
        console.log('  ' + k + ' -> array len:', v.length);
        v.forEach((f, i) => console.log('    [' + i + '] filename:', f.filename, '| uploaded_at:', f.uploaded_at));
      } else {
        console.log('  ' + k + ' ->', JSON.stringify(v).slice(0, 120));
      }
    }
  } else {
    console.log('documents: NO DOCUMENTS FIELD');
  }

  // AWB lines
  if (d.awb_lines && d.awb_lines.length > 0) {
    console.log('awb_lines count:', d.awb_lines.length);
    d.awb_lines.forEach((l, i) => {
      const docKeys = l.documents ? Object.keys(l.documents) : [];
      console.log('  line ' + i + ' | awb:', l.awb, '| doc keys:', docKeys.length > 0 ? docKeys : 'none');
      if (l.documents) {
        for (const k of Object.keys(l.documents)) {
          const v = l.documents[k];
          if (v && typeof v === 'object' && !Array.isArray(v) && v.url) {
            console.log('    ' + k + ' -> uploaded:', v.uploaded_at, '| filename:', v.filename);
          } else if (Array.isArray(v)) {
            console.log('    ' + k + ' -> array len:', v.length);
          } else {
            console.log('    ' + k + ' ->', JSON.stringify(v).slice(0, 80));
          }
        }
      }
    });
  }
}

(async () => {
  await signInWithEmailAndPassword(auth, 'diego@mincurllogistics.com', 'Mincurl2025!');

  // Booking from URL 2
  await checkBooking('h19k5gpsIUlq0WiKkcGO', 'BOOKING h19k5 (AWB 369-98151071)');

  // Flight from URL 1 - need to find bookings for this flight
  const flightId = 'raZ5oEk4Oqsgi67iasIf';
  const flightSnap = await getDoc(doc(db, 'airfreight_flights', flightId));
  if (flightSnap.exists()) {
    const f = flightSnap.data();
    console.log('\n=== FLIGHT raZ5o... ===');
    console.log('flight:', f.flight_number, '| date:', f.flight_datetime, '| airline:', f.airline);
    console.log('bookings array:', f.bookings ? f.bookings.length : 'none');
    if (f.bookings) {
      for (const bId of f.bookings) {
        await checkBooking(bId, 'BOOKING ' + bId.slice(0, 8) + ' (in flight)');
      }
    }
  } else {
    console.log('Flight NOT FOUND');
  }

  process.exit();
})().catch(e => { console.error(e.message); process.exit(1); });
