// Query Firestore using Firebase client SDK with email/password auth
// Usage: node scripts/query-audit2.cjs <email> <password>

const { initializeApp } = require('firebase/app');
const { getAuth, signInWithEmailAndPassword } = require('firebase/auth');
const { getFirestore, collection, query, where, orderBy, limit, getDocs } = require('firebase/firestore');

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

async function main() {
  const email = process.argv[2] || 'diego.garcia@mincurllogistics.com';
  const password = process.argv[3];
  if (!password) {
    console.log('Usage: node scripts/query-audit2.cjs <email> <password>');
    console.log('Need password to authenticate with Firestore');
    process.exit(1);
  }

  console.log('Signing in as', email, '...');
  await signInWithEmailAndPassword(auth, email, password);
  console.log('Authenticated.\n');

  // 1. Audit log for LA-0543
  console.log('=== 1. AUDIT LOG: LA-0543 ===\n');
  try {
    const q1 = query(
      collection(db, '_sheet_sync_flight_audit'),
      where('flight_number', '==', 'LA-0543'),
      limit(30)
    );
    const snap1 = await getDocs(q1);
    console.log(`Found ${snap1.size} docs`);
    snap1.docs.forEach(d => {
      const data = d.data();
      const ts = data.created_at ? data.created_at.toDate().toISOString() : '';
      console.log(JSON.stringify({
        type: data.type, fn: data.fn, flight_id: data.flight_id,
        flight_number: data.flight_number, etd: data.etd,
        old_etd: data.old_etd, new_etd: data.new_etd,
        trigger_awb: data.trigger_awb, candidates_count: data.candidates_count,
        monthKey: data.monthKey, step: data.step, reason: data.reason, ts
      }));
    });
  } catch (e) {
    console.log('Error querying audit (LA-0543):', e.message);
  }

  // 2. All audit events from May 29 onwards
  console.log('\n=== 2. ALL AUDIT EVENTS (recent, by type) ===\n');
  for (const type of ['flight_created', 'step2_fallback', 'step2_etd_blocked', 'step2_ambiguous_resolved', 'step2_ambiguous', 'firestore_dedup_hit']) {
    try {
      const q = query(
        collection(db, '_sheet_sync_flight_audit'),
        where('type', '==', type),
        orderBy('created_at', 'desc'),
        limit(10)
      );
      const snap = await getDocs(q);
      if (snap.size > 0) {
        console.log(`--- ${type}: ${snap.size} docs ---`);
        snap.docs.forEach(d => {
          const data = d.data();
          const ts = data.created_at ? data.created_at.toDate().toISOString() : '';
          console.log(JSON.stringify({
            flight_number: data.flight_number, flight_id: data.flight_id,
            etd: data.etd, old_etd: data.old_etd, new_etd: data.new_etd,
            trigger_awb: data.trigger_awb, candidates_count: data.candidates_count,
            monthKey: data.monthKey, fn: data.fn, ts
          }));
        });
      }
    } catch (e) {
      console.log(`Error querying ${type}:`, e.message);
    }
  }

  // 3. Flights with LA-0543
  console.log('\n=== 3. FLIGHTS: LA-0543 ===\n');
  try {
    const q3 = query(
      collection(db, 'airfreight_flights'),
      where('flight_number', '==', 'LA-0543'),
      limit(10)
    );
    const snap3 = await getDocs(q3);
    console.log(`Found ${snap3.size} LA-0543 flights`);
    snap3.docs.forEach(d => {
      const data = d.data();
      console.log(JSON.stringify({
        id: d.id, flight_number: data.flight_number, airline: data.airline,
        flight_datetime: data.flight_datetime, cutoff_datetime: data.cutoff_datetime,
        destinations: data.destinations, status: data.status, flight_status: data.flight_status,
        created_by: data.created_by, created_at: data.created_at
      }));
    });
  } catch (e) {
    console.log('Error querying flights:', e.message);
  }

  // 4. Bookings on LA-0543 flight
  console.log('\n=== 4. RECENT SYNC RUNS ===\n');
  try {
    const q4 = query(
      collection(db, '_sheet_sync_runs'),
      orderBy('run_at', 'desc'),
      limit(5)
    );
    const snap4 = await getDocs(q4);
    snap4.docs.forEach(d => {
      const data = d.data();
      console.log(JSON.stringify({
        client_id: data.client_id, run_at: data.run_at, status: data.status,
        rows_checked: data.rows_checked, changes_detected: data.changes_detected,
        new_awbs: data.new_awbs, changed_awbs: data.changed_awbs,
        errors: data.errors, duration_ms: data.duration_ms
      }));
    });
  } catch (e) {
    console.log('Error querying runs:', e.message);
  }

  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
