import { addDoc, collection } from 'firebase/firestore'
import { db } from './firebase'

export type AvLogEvent =
  // Flight
  | 'flight_created'
  | 'flight_edited'
  | 'flight_deleted'
  // AWB
  | 'awb_created'
  | 'awb_edited'
  | 'awb_deleted'
  | 'awb_removed'
  | 'awb_moved_out'
  | 'awb_moved_in'
  | 'awb_ai_extracted'
  // Documents
  | 'doc_uploaded'
  | 'dg_doc_uploaded'
  // Pallet Tag
  | 'pallet_tag_uploaded'
  | 'pallet_tag_processed'
  | 'pallet_tag_edited'
  | 'pallet_tag_deleted'
  | 'manual_position_created'
  // Screening & Checks
  | 'screening_certified'
  | 'manifest_checked'
  | 'lb_checklist_generated'
  // Delivery Orders
  | 'do_created'
  | 'do_edited'
  | 'do_dispatched'
  | 'do_reverted'
  | 'do_deleted'
  // Delivery Milestones
  | 'cargo_loaded'
  | 'arrival_airline'
  | 'unload_complete'
  // Billing
  | 'invoiced'
  | 'invoice_voided'
  // Notes
  | 'flight_note'

export async function logAvEvent(
  flightId: string,
  awbNumber: string,
  event: AvLogEvent,
  detail: string,
  user: string,
): Promise<void> {
  await addDoc(collection(db, 'av_awb_logs'), {
    flight_id: flightId,
    awb_number: awbNumber,
    event,
    detail,
    user,
    timestamp: new Date().toISOString(),
  })
}

// Batch version for logging the same event for multiple AWBs
export async function logAvEventBatch(
  flightId: string,
  awbNumbers: string[],
  event: AvLogEvent,
  detail: string,
  user: string,
): Promise<void> {
  const now = new Date().toISOString()
  await Promise.all(
    awbNumbers.map(awb =>
      addDoc(collection(db, 'av_awb_logs'), {
        flight_id: flightId,
        awb_number: awb,
        event,
        detail,
        user,
        timestamp: now,
      })
    )
  )
}
