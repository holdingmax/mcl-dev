// ═══ Firebase Client via google-cloud/firestore ═══
// Uses Application Default Credentials (compatible with FIREBASE_TOKEN + gcloud auth)
// No service account key file needed.

import { Firestore, FieldValue } from '@google-cloud/firestore';

let db = null;

export function initFirebase() {
  if (db) return db;

  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || 'wms-mcl';

  // If FIREBASE_SERVICE_ACCOUNT is set (JSON string), use it directly
  const saKey = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (saKey) {
    try {
      const sa = JSON.parse(saKey);
      db = new Firestore({
        projectId: sa.project_id || projectId,
        credentials: { client_email: sa.client_email, private_key: sa.private_key },
      });
      log('INIT', `Firestore connected via service account (${sa.project_id})`);
      return db;
    } catch (err) {
      log('WARN', `FIREBASE_SERVICE_ACCOUNT parse failed, falling back to ADC: ${err.message}`);
    }
  }

  // Fallback: Application Default Credentials (set by gcloud auth or GOOGLE_APPLICATION_CREDENTIALS)
  db = new Firestore({ projectId });
  log('INIT', `Firestore connected via ADC (${projectId})`);
  return db;
}

// ── Feature Flags ──────────────────────────────────────────────────────────────

export async function getFeatureFlags() {
  const db = initFirebase();
  const snap = await db.doc('config/feature_flags').get();
  return snap.exists ? snap.data() : {};
}

export async function setFeatureFlag(flag, value) {
  const db = initFirebase();
  await db.doc('config/feature_flags').set({ [flag]: value }, { merge: true });
  log('FLAG', `${flag} = ${JSON.stringify(value)}`);
}

// ── Agent State ────────────────────────────────────────────────────────────────

export async function getAgentState(agentId) {
  const db = initFirebase();
  const snap = await db.doc(`_agent_state/${agentId}`).get();
  return snap.exists ? snap.data() : {};
}

export async function setAgentState(agentId, data) {
  const db = initFirebase();
  await db.doc(`_agent_state/${agentId}`).set({
    ...data,
    updated_at: FieldValue.serverTimestamp(),
  }, { merge: true });
}

// ── Collection Metrics ─────────────────────────────────────────────────────────

export async function getCollectionCount(collectionName, constraints = []) {
  const db = initFirebase();
  let ref = db.collection(collectionName);
  for (const [field, op, value] of constraints) {
    ref = ref.where(field, op, value);
  }
  const snap = await ref.count().get();
  return snap.data().count;
}

export async function getCollectionSample(collectionName, limitN = 10, constraints = []) {
  const db = initFirebase();
  let ref = db.collection(collectionName);
  for (const [field, op, value] of constraints) {
    ref = ref.where(field, op, value);
  }
  const snap = await ref.limit(limitN).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function getDocument(collectionName, docId) {
  const db = initFirebase();
  const snap = await db.doc(`${collectionName}/${docId}`).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

// ── Billing Verification ───────────────────────────────────────────────────────

export async function getChargesForFlight(flightId) {
  const db = initFirebase();
  const snap = await db.collection('air_billing_charges')
    .where('flight_id', '==', flightId)
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function getChargesForWR(wrId) {
  const db = initFirebase();
  const snap = await db.collection('billing_charges')
    .where('wr_id', '==', wrId)
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function getRecentDocuments(collectionName, hours = 24) {
  const db = initFirebase();
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const snap = await db.collection(collectionName)
    .where('created_at', '>=', cutoff)
    .orderBy('created_at', 'desc')
    .limit(500)
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ── Daily Metrics Snapshots ───────────────────────────────────────────────────

export async function writeMetricsSnapshot(agentId, metrics, summary) {
  const db = initFirebase();
  const today = new Date().toISOString().slice(0, 10);
  const docId = `${today}_${agentId}`;
  await db.doc(`_metrics_daily/${docId}`).set({
    agent_id: agentId,
    date: today,
    metrics,
    summary: summary || null,
    created_at: FieldValue.serverTimestamp(),
  });
  log('METRICS', `Snapshot written: ${docId}`);
}

export async function writeDeployEvent(event) {
  const db = initFirebase();
  const docId = `${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await db.doc(`_deploy_history/${docId}`).set({
    ...event,
    created_at: FieldValue.serverTimestamp(),
  });
  log('DEPLOY', `Event logged: ${event.action} — ${event.name}`);
}

// ── Logging ────────────────────────────────────────────────────────────────────

function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}
