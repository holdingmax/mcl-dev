const admin = require('firebase-admin');
const sa = require('../functions/serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

(async () => {
  const flights = await db.collection('av_flights').where('flight_number', '==', 'M4223').get();
  if (flights.empty) { console.log('Not found'); return; }
  const fDoc = flights.docs[0];
  console.log('Flight:', fDoc.id);
  const awbs = await db.collection('av_flight_awbs').where('flight_id', '==', fDoc.id).get();
  const active = awbs.docs.map(d => d.data()).filter(a => a.status !== 'removed');
  console.log('Active AWBs:', active.length);
  active.forEach(a => console.log(a.awb_number, a.pieces, a.gross_weight_kg, a.chw_kg));
  const t = {
    total_awbs: active.length,
    total_pieces: active.reduce((s, a) => s + (a.pieces || 0), 0),
    total_gross_kg: active.reduce((s, a) => s + (a.gross_weight_kg || 0), 0),
    total_chw_kg: active.reduce((s, a) => s + (a.chw_kg || 0), 0),
    has_dg: active.some(a => a.dg),
    has_lb: active.some(a => a.lb),
    updated_at: new Date().toISOString(),
  };
  console.log('New totals:', JSON.stringify(t));
  await db.collection('av_flights').doc(fDoc.id).update(t);
  console.log('Done');
})();
