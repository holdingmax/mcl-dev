import { useState } from 'react'
import { collection, query, getDocs, doc, updateDoc } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import Layout from '../../components/Layout'

interface BookingHit {
  id: string
  flight_id: string
  client: string
  type: string
  created_at: string
  created_by: string
  dispatched: boolean
  bookingDocKeys: string[]   // doc keys with URLs at booking.documents level
  lineIdx: number            // -1 = matched at booking level
  lineDocKeys: string[]      // doc keys with URLs inside awb_lines[lineIdx].documents
  raw: any                   // full booking data for copy
}

export default function AirfreightAwbDiag() {
  const { isAdmin } = useAuth()
  const [awb, setAwb] = useState('')
  const [results, setResults] = useState<BookingHit[]>([])
  const [loading, setLoading] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [copyDone, setCopyDone] = useState(false)

  async function handleSearch() {
    if (!awb.trim()) return
    setLoading(true)
    setResults([])
    setLog([])
    setCopyDone(false)
    const target = awb.trim()

    try {
      const snap = await getDocs(query(collection(db, 'airfreight_bookings')))
      const hits: BookingHit[] = []

      snap.forEach(d => {
        const b = { id: d.id, ...d.data() } as any
        let match = false
        let lineIdx = -1
        let lineDocs: Record<string, any> | null = null

        if (b.mawb_number === target || b.awb_number === target) match = true

        if (b.awb_lines) {
          b.awb_lines.forEach((l: any, i: number) => {
            if (l.awb === target || l.awb_number === target || l.awb_2nd_leg === target) {
              match = true
              lineIdx = i
              lineDocs = l.documents || null
            }
          })
        }

        if (match) {
          const docKeys = b.documents
            ? Object.keys(b.documents).filter((k: string) => {
                const v = b.documents[k]
                return v && (v.url || (Array.isArray(v) && v.length > 0))
              })
            : []

          const lDocKeys = lineDocs
            ? Object.keys(lineDocs).filter((k: string) => {
                const v = (lineDocs as any)[k]
                return v && (v.url || (Array.isArray(v) && v.length > 0))
              })
            : []

          hits.push({
            id: b.id,
            flight_id: b.flight_id,
            client: b.client_name,
            type: b.booking_type,
            created_at: b.created_at,
            created_by: b.created_by || '—',
            dispatched: !!b.dispatched,
            bookingDocKeys: docKeys,
            lineIdx,
            lineDocKeys: lDocKeys,
            raw: b,
          })
        }
      })

      hits.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
      setResults(hits)

      if (hits.length === 0) setLog(['No bookings found for this AWB.'])
    } catch (e: any) {
      setLog(['Error: ' + e.message])
    }
    setLoading(false)
  }

  // Copy docs from source booking to target booking
  async function handleCopyDocs(sourceId: string, targetId: string) {
    const source = results.find(r => r.id === sourceId)
    const target = results.find(r => r.id === targetId)
    if (!source || !target) return
    if (!confirm(`Copiar documentos de booking ${sourceId.slice(0, 8)}... al booking ${targetId.slice(0, 8)}...?`)) return

    const lines: string[] = []
    try {
      // Copy booking-level documents
      if (source.raw.documents && Object.keys(source.raw.documents).length > 0) {
        const targetDocs = target.raw.documents || {}
        const merged = { ...targetDocs }
        let copied = 0
        for (const [k, v] of Object.entries(source.raw.documents) as [string, any][]) {
          if (v && (v.url || (Array.isArray(v) && v.length > 0))) {
            // Only copy if target doesn't have it
            const existing = merged[k]
            if (!existing || (!existing.url && !(Array.isArray(existing) && existing.length > 0))) {
              merged[k] = v
              copied++
              lines.push(`  Copied booking doc: ${k}`)
            } else {
              lines.push(`  Skipped ${k} (target already has it)`)
            }
          }
        }
        if (copied > 0) {
          await updateDoc(doc(db, 'airfreight_bookings', targetId), { documents: merged })
          lines.push(`Updated ${copied} booking-level docs.`)
        }
      }

      // Copy awb_lines documents if both have matching line
      if (source.lineIdx >= 0 && target.lineIdx >= 0) {
        const srcLine = source.raw.awb_lines?.[source.lineIdx]
        const tgtLines = [...(target.raw.awb_lines || [])]
        const tgtLine = tgtLines[target.lineIdx]

        if (srcLine && tgtLine) {
          const srcLineDocs = srcLine.documents || {}
          const tgtLineDocs = tgtLine.documents || {}
          const mergedLineDocs = { ...tgtLineDocs }
          let copied = 0

          for (const [k, v] of Object.entries(srcLineDocs) as [string, any][]) {
            if (v && v.url) {
              if (!mergedLineDocs[k] || !mergedLineDocs[k].url) {
                mergedLineDocs[k] = v
                copied++
                lines.push(`  Copied line doc: ${k}`)
              } else {
                lines.push(`  Skipped line doc ${k} (exists)`)
              }
            }
          }

          // Also copy line-level fields like doc_acceptance, doc_whr, etc.
          const lineDocFields = ['doc_acceptance', 'doc_whr', 'doc_mcl_transfer', 'doc_screening_cert']
          for (const f of lineDocFields) {
            if (srcLine[f]?.url && !tgtLine[f]?.url) {
              tgtLines[target.lineIdx] = { ...tgtLines[target.lineIdx], [f]: srcLine[f] }
              copied++
              lines.push(`  Copied line field: ${f}`)
            }
          }

          if (copied > 0) {
            tgtLines[target.lineIdx] = { ...tgtLines[target.lineIdx], documents: mergedLineDocs }
            await updateDoc(doc(db, 'airfreight_bookings', targetId), { awb_lines: tgtLines })
            lines.push(`Updated ${copied} line-level docs.`)
          }
        }
      }

      if (lines.length === 0) lines.push('No documents to copy.')
      lines.push('Done.')
      setCopyDone(true)
    } catch (e: any) {
      lines.push('ERROR: ' + e.message)
    }
    setLog(lines)
  }

  if (!isAdmin) {
    return <Layout title="AWB Diagnostic" backTo="/airfreight"><p className="text-center text-gray-500 mt-10">Admin only</p></Layout>
  }

  const withDocs = results.filter(r => r.bookingDocKeys.length > 0 || r.lineDocKeys.length > 0)
  const withoutDocs = results.filter(r => r.bookingDocKeys.length === 0 && r.lineDocKeys.length === 0)

  return (
    <Layout title="AWB Document Diagnostic" backTo="/airfreight">
      <div className="max-w-4xl mx-auto space-y-4">
        <div className="flex gap-2">
          <input
            value={awb}
            onChange={e => setAwb(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            placeholder="AWB or MAWB number (e.g. 936-02242940)"
            className="flex-1 border border-gray-200 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
          />
          <button onClick={handleSearch} disabled={loading} className="bg-mcl-blue text-white px-6 py-2 rounded-lg text-sm font-semibold disabled:opacity-50">
            {loading ? 'Buscando...' : 'Buscar'}
          </button>
        </div>

        {results.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-3 py-2 font-medium text-gray-600">Booking ID</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-600">Flight</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-600">Client</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-600">Type</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-600">Created</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-600">By</th>
                  <th className="text-center px-3 py-2 font-medium text-gray-600">Dispatched</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-600">Booking Docs</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-600">Line Docs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {results.map(r => (
                  <tr key={r.id} className={r.bookingDocKeys.length > 0 || r.lineDocKeys.length > 0 ? 'bg-green-50' : ''}>
                    <td className="px-3 py-2 font-mono">{r.id.slice(0, 12)}...</td>
                    <td className="px-3 py-2 font-mono">{r.flight_id.slice(0, 10)}...</td>
                    <td className="px-3 py-2">{r.client}</td>
                    <td className="px-3 py-2">{r.type}</td>
                    <td className="px-3 py-2">{r.created_at?.slice(0, 16).replace('T', ' ')}</td>
                    <td className="px-3 py-2 text-[10px]">{r.created_by}</td>
                    <td className="px-3 py-2 text-center">{r.dispatched ? '✅' : '—'}</td>
                    <td className="px-3 py-2">{r.bookingDocKeys.length > 0 ? r.bookingDocKeys.join(', ') : <span className="text-gray-300">none</span>}</td>
                    <td className="px-3 py-2">{r.lineDocKeys.length > 0 ? r.lineDocKeys.join(', ') : <span className="text-gray-300">none</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Copy action */}
        {withDocs.length > 0 && withoutDocs.length > 0 && !copyDone && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-3">
            <p className="text-sm font-semibold text-amber-800">
              Se encontraron {withDocs.length} booking(s) CON documentos y {withoutDocs.length} SIN documentos.
            </p>
            <p className="text-xs text-amber-700">Selecciona el booking destino al cual copiar los documentos:</p>
            <div className="flex flex-wrap gap-2">
              {withoutDocs.map(t => (
                <button
                  key={t.id}
                  onClick={() => handleCopyDocs(withDocs[0].id, t.id)}
                  className="bg-amber-600 text-white px-4 py-1.5 rounded-lg text-xs font-semibold hover:bg-amber-700"
                >
                  Copiar docs a {t.id.slice(0, 10)}... (creado {t.created_at?.slice(0, 10)}, by {t.created_by})
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Log */}
        {log.length > 0 && (
          <div className="bg-gray-900 text-green-400 rounded-xl p-4 font-mono text-xs space-y-0.5 max-h-60 overflow-auto">
            {log.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        )}
      </div>
    </Layout>
  )
}
