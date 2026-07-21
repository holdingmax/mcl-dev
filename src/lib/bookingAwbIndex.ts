// Helper to maintain awb_numbers_normalized on airfreight_bookings (SOL-8)
// Call this after any write that creates or changes AWB numbers on a booking.

import { doc, updateDoc } from 'firebase/firestore'
import { db } from './firebase'
import { computeAwbNumbersNormalized } from './awbNormalize'

/**
 * Recompute and write `awb_numbers_normalized` for a booking.
 * Safe to call after any booking update — it reads the fields you pass
 * and writes just the index field.
 */
export async function updateAwbIndex(
  bookingId: string,
  booking: {
    booking_type?: string
    awb_1st_leg?: string
    awb_2nd_leg?: string
    awb_lines?: Array<{ awb_number?: string; awb_2nd_leg?: string | null }>
  },
): Promise<void> {
  const normalized = computeAwbNumbersNormalized(booking)
  await updateDoc(doc(db, 'airfreight_bookings', bookingId), {
    awb_numbers_normalized: normalized,
  })
}

/**
 * Compute the field to spread into a new booking payload before addDoc.
 */
export function awbIndexField(booking: {
  booking_type?: string
  awb_1st_leg?: string
  awb_2nd_leg?: string
  awb_lines?: Array<{ awb_number?: string; awb_2nd_leg?: string | null }>
}): { awb_numbers_normalized: string[] } {
  return { awb_numbers_normalized: computeAwbNumbersNormalized(booking) }
}
