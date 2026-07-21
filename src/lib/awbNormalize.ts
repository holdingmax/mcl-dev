// AWB normalization utilities for indexed Firestore queries (SOL-8)

/** Strip non-alphanumeric chars and uppercase — matches the normalize() used in DocReceptionNew */
export function normalizeAwb(val: string | null | undefined): string {
  return (val || '').replace(/[^A-Z0-9]/gi, '').toUpperCase()
}

/**
 * Compute a flat array of all normalized AWB numbers from a booking.
 * Used as an indexed field for `array-contains` queries instead of full-collection scans.
 */
export function computeAwbNumbersNormalized(booking: {
  booking_type?: string
  awb_1st_leg?: string
  awb_2nd_leg?: string
  awb_lines?: Array<{ awb_number?: string; awb_2nd_leg?: string | null }>
}): string[] {
  const set = new Set<string>()

  if (booking.booking_type === 'simple') {
    if (booking.awb_1st_leg) set.add(normalizeAwb(booking.awb_1st_leg))
    if (booking.awb_2nd_leg) set.add(normalizeAwb(booking.awb_2nd_leg))
  } else {
    // mawb, ecommerce, export — AWBs are in awb_lines
    for (const line of booking.awb_lines || []) {
      if (line.awb_number) set.add(normalizeAwb(line.awb_number))
      if (line.awb_2nd_leg) set.add(normalizeAwb(line.awb_2nd_leg))
    }
  }

  // Remove empty strings
  set.delete('')
  return Array.from(set)
}
