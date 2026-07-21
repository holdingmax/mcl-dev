#!/usr/bin/env node
/**
 * Set on_hand=false on booking line [999-92781161] to stop buildup auto-creating ghost
 */
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const PROJECT_ID = 'wms-mcl';
const BOOKING_ID = 'A8Z14m7jFEnxtMfxJVyz';
const DOC_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/airfreight_bookings/${BOOKING_ID}`;

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

async function main() {
  const TOKEN = await getAccessToken();

  // Read booking
  const bkRes = await fetch(DOC_URL, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const bkDoc = await bkRes.json();
  const lines = bkDoc.fields?.awb_lines?.arrayValue?.values || [];

  console.log(`Booking ${BOOKING_ID}: ${lines.length} lines`);

  let targetIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const lf = lines[i]?.mapValue?.fields || {};
    const awb = str(lf, 'awb_number');
    const onHand = lf.on_hand?.booleanValue || false;
    console.log(`  [${i}] ${awb} on_hand=${onHand}`);
    if (awb === '999-92781161') targetIdx = i;
  }

  if (targetIdx === -1) {
    console.log('Line 999-92781161 not found!');
    return;
  }

  console.log(`\nSetting line [${targetIdx}] on_hand=false...`);
  lines[targetIdx].mapValue.fields.on_hand = { booleanValue: false };

  const patchRes = await fetch(`${DOC_URL}?updateMask.fieldPaths=awb_lines`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: { awb_lines: { arrayValue: { values: lines } } },
    }),
  });

  if (patchRes.ok) console.log('DONE — on_hand set to false');
  else console.error('ERROR:', patchRes.status, await patchRes.text());
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
