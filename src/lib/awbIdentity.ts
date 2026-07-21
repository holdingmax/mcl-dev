// Centralized AWB identity resolution (HAL-03)
// Single source of truth for "which AWB is the operational one"

/**
 * Returns the operational AWB number for display and matching.
 * Rule: 2nd leg (if present) > awb_number > 1st leg
 *
 * Works with any entity shape: booking (simple), awb_line, doc_reception, physical_piece.
 */
export function getOperationalAwb(entity: {
  awb_number?: string | null
  awb_1st_leg?: string | null
  awb_2nd_leg?: string | null
}): string {
  return entity.awb_2nd_leg || entity.awb_number || entity.awb_1st_leg || ''
}

/**
 * Returns the display AWB for labels, PDFs, and UI.
 * Same as getOperationalAwb — single consistent rule.
 */
export const getDisplayAwb = getOperationalAwb

/**
 * Returns the 1st leg AWB (referential only).
 * For simple bookings: awb_1st_leg field.
 * For awb_lines: awb_number field (confusing naming, but that's the data model).
 */
export function get1stLeg(entity: {
  awb_number?: string | null
  awb_1st_leg?: string | null
}): string {
  return entity.awb_1st_leg || entity.awb_number || ''
}

/**
 * Returns the 2nd leg AWB if it exists, empty string otherwise.
 */
export function get2ndLeg(entity: {
  awb_2nd_leg?: string | null
}): string {
  return entity.awb_2nd_leg || ''
}

/**
 * Check if a piece's awb_number matches an AWB entity.
 * Handles both old data (piece has 1st leg) and new data (piece has 2nd leg).
 */
export function pieceMatchesAwb(
  pieceAwb: string,
  awbEntity: { awb_number?: string | null; awb_2nd_leg?: string | null },
): boolean {
  return pieceAwb === awbEntity.awb_number ||
    (!!awbEntity.awb_2nd_leg && pieceAwb === awbEntity.awb_2nd_leg)
}
