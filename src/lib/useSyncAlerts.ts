import { useState, useEffect } from 'react'
import { collection, query, where, onSnapshot, doc, updateDoc, Timestamp } from 'firebase/firestore'
import { db } from './firebase'

export interface SyncAlert {
  id: string
  client_id: string
  client_name: string
  awb_1st: string
  awb_2nd: string
  flight_number: string
  system_flight?: string
  etd?: string
  diffs: { field: string; old_value: any; new_value: any }[]
  alert_type: 'built_change' | 'dispatched_change' | 'received_change' | 'same_day_change' | 'applied' | 'applied_new' | 'needs_review' | 'pending_resolved' | 'same_day_new' | 'removed_from_sheet'
  message?: string
  status: 'pending' | 'applied' | 'reviewed'
  created_at: Timestamp | string
}

/** Subscribe to pending sync alerts (status != 'reviewed') */
export function useSyncAlerts() {
  const [alerts, setAlerts] = useState<SyncAlert[]>([])

  useEffect(() => {
    const q = query(
      collection(db, '_sheet_sync_alerts'),
      where('status', 'in', ['pending', 'applied']),
    )
    const unsub = onSnapshot(q, (snap) => {
      setAlerts(snap.docs.map(d => ({ id: d.id, ...d.data() } as SyncAlert)))
    }, (err) => {
      console.error('Sync alerts listener error:', err)
    })
    return unsub
  }, [])

  return alerts
}

/** Mark a single alert as reviewed */
export async function markAlertReviewed(alertId: string) {
  await updateDoc(doc(db, '_sheet_sync_alerts', alertId), { status: 'reviewed' })
}

/** Mark multiple alerts as reviewed */
export async function markAlertsReviewed(alertIds: string[]) {
  await Promise.all(alertIds.map(id => markAlertReviewed(id)))
}

/** Group alerts by flight number */
export function alertsByFlight(alerts: SyncAlert[]): Map<string, SyncAlert[]> {
  const map = new Map<string, SyncAlert[]>()
  for (const a of alerts) {
    const key = a.system_flight || a.flight_number || ''
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(a)
  }
  return map
}

/** Group alerts by AWB (awb_2nd or awb_1st) */
export function alertsByAwb(alerts: SyncAlert[]): Map<string, SyncAlert[]> {
  const map = new Map<string, SyncAlert[]>()
  for (const a of alerts) {
    const key = a.awb_2nd || a.awb_1st || ''
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(a)
  }
  return map
}

/** Format alert timestamp */
export function fmtAlertTime(ts: Timestamp | string | undefined): string {
  if (!ts) return ''
  const d = ts instanceof Timestamp ? ts.toDate() : new Date(ts)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit' }) +
    ', ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
}
