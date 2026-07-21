#!/usr/bin/env node
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const PROJECT_ID = 'wms-mcl';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const BOOKING_ID = 'A8Z14m7jFEnxtMfxJVyz';

function getRefreshToken() {
  const p = join(homedir(), '.config', 'configstore', 'firebase-tools.json');
  const cfg = JSON.parse(readFileSync(p, 'utf-8'));
  return cfg.tokens.refresh_token;
}

async function getAccessToken() {
  const rt = getRefreshToken();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: rt,
      client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
      client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
    }),
  });
  return (await res.json()).access_token;
}

function str(f, k) { return f[k]?.stringValue || ''; }
function bool(f, k) { return f[k]?.booleanValue || false; }

async function main() {
  const TOKEN = await getAccessToken();

  const res = await fetch(`https://firestore.googleapis.com/v1/${BASE.replace(BASE, '')}projects/${PROJECT_ID}/databases/(default)/documents/airfreight_bookings/${BOOKING_ID}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const doc = await res.json();
  const f = doc.fields || {};

  console.log(`Booking: ${BOOKING_ID}`);
  console.log(`  flight_id: ${str(f, 'flight_id')}`);
  console.log(`  flight_number: ${str(f, 'flight_number')}`);
  console.log(`  client_name: ${str(f, 'client_name')}`);
  console.log(`  booking_type: ${str(f, 'booking_type')}`);

  // Check awb_lines
  const lines = f.awb_lines?.arrayValue?.values || [];
  console.log(`  awb_lines (${lines.length}):`);
  for (let i = 0; i < lines.length; i++) {
    const lf = lines[i]?.mapValue?.fields || {};
    console.log(`    [${i}] awb_number=${str(lf, 'awb_number')} awb_2nd_leg=${str(lf, 'awb_2nd_leg')} on_hand=${bool(lf, 'on_hand')} pieces=${lf.pieces?.integerValue || lf.pieces?.doubleValue || 0}`);
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
