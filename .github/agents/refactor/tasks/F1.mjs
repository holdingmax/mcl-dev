// ═══ F1 — Ampliar AAID con checks de holds consistency ═══
// Agrega checks de integridad de holds al agente AAID existente.
// Bajo riesgo: solo lee datos, no modifica nada en produccion.

import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export const TASK_META = {
  id: 'F1',
  name: 'Ampliar AAID — Holds Consistency Checks',
  description: 'Agregar checks de integridad de holds al agente AAID: comparar booking holds vs airfreight_holds collection, detectar placeholders huerfanos, detectar desincronizaciones.',
  risk: 'low',
  files_modified: ['audit/data-integrity.mjs'],
  files_created: [],
  validation: 'El agente AAID debe correr sin errores y reportar holds consistency.',
}

export async function execute(ctx) {
  const { agentsDir, log } = ctx
  const filePath = join(agentsDir, 'audit', 'data-integrity.mjs')
  const original = readFileSync(filePath, 'utf8')

  // Add holds consistency check before the return statement
  const newCheck = `
  // 6. Holds consistency: booking awb_lines[].holds vs airfreight_holds collection
  try {
    const holdBookings = await getCollectionSample('airfreight_bookings', 50)
    const holdsCol = await getCollectionSample('airfreight_holds', 200)

    // Build lookup from airfreight_holds collection
    const colHoldKeys = new Set()
    for (const h of holdsCol) {
      const key = \`\${h.booking_id}|\${h.awb_number}|\${h.bag}|\${h.box}\`
      colHoldKeys.add(key)
    }

    let bookingHoldsTotal = 0
    let missingFromCollection = 0
    let placeholderHolds = 0

    for (const b of holdBookings) {
      if (!b.awb_lines) continue
      for (const line of b.awb_lines) {
        const holds = line.holds || []
        for (const h of holds) {
          bookingHoldsTotal++
          const bag = (h.bag || '').toLowerCase().trim()
          if (bag === 'hold' || bag === '' || !bag) {
            placeholderHolds++
            continue
          }
          const key = \`\${b.id}|\${line.awb_number || ''}|\${h.bag}|\${h.box}\`
          if (!colHoldKeys.has(key)) {
            missingFromCollection++
            if (missingFromCollection <= 5) {
              results.inconsistencies.push({
                type: 'hold_missing_from_collection',
                booking_id: b.id,
                awb_number: line.awb_number || '',
                bag: h.bag,
                box: h.box,
                detail: \`Hold in booking not found in airfreight_holds collection\`,
              })
            }
          }
        }
      }
    }

    results.stats.holds_in_bookings = bookingHoldsTotal
    results.stats.holds_in_collection = holdsCol.length
    results.stats.holds_placeholder = placeholderHolds
    results.stats.holds_missing_from_collection = missingFromCollection

    const holdStatus = missingFromCollection > 10 ? 'critical' :
                       missingFromCollection > 0 ? 'warning' : 'ok'
    results.checks.push({
      name: 'Holds sync consistency',
      status: holdStatus,
      detail: \`\${bookingHoldsTotal} holds in bookings, \${holdsCol.length} in collection, \${missingFromCollection} missing, \${placeholderHolds} placeholders\`,
    })
  } catch (err) {
    results.checks.push({ name: 'Holds sync consistency', status: 'error', detail: err.message })
  }

  // 7. Detect stale placeholder holds (bag="hold" in airfreight_holds collection)
  try {
    const allHolds = await getCollectionSample('airfreight_holds', 200)
    let stalePlaceholders = 0

    for (const h of allHolds) {
      const bag = (h.bag || '').toLowerCase().trim()
      const box = (h.box || '').toLowerCase().trim()
      if (bag === 'hold' || box === 'hold') {
        stalePlaceholders++
        if (stalePlaceholders <= 3) {
          results.inconsistencies.push({
            type: 'stale_placeholder_hold',
            doc_id: h.id,
            booking_id: h.booking_id || '',
            awb_number: h.awb_number || '',
            detail: 'Placeholder hold (bag/box="hold") in airfreight_holds collection',
          })
        }
      }
    }

    results.stats.holds_stale_placeholders = stalePlaceholders
    results.checks.push({
      name: 'Stale placeholder holds',
      status: stalePlaceholders > 5 ? 'warning' : 'ok',
      detail: \`\${stalePlaceholders} placeholder holds in airfreight_holds collection\`,
    })
  } catch (err) {
    results.checks.push({ name: 'Stale placeholder holds', status: 'error', detail: err.message })
  }`

  // Insert before the final "return results"
  const insertPoint = original.lastIndexOf('return results')
  if (insertPoint < 0) {
    throw new Error('Could not find "return results" in data-integrity.mjs')
  }

  const updated = original.slice(0, insertPoint) + newCheck + '\n\n  ' + original.slice(insertPoint)
  writeFileSync(filePath, updated)

  log('WRITE', `Updated ${filePath} — added holds consistency checks (checks 6 & 7)`)

  return {
    files_modified: ['audit/data-integrity.mjs'],
    changes: [
      'Added check 6: Holds sync consistency (booking holds vs airfreight_holds collection)',
      'Added check 7: Stale placeholder holds detection',
    ],
  }
}
