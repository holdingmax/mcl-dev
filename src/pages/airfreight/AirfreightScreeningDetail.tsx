import { useState, useEffect } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import {
  collection, query, where, onSnapshot, doc, addDoc, updateDoc, getDoc, getDocs,
} from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { httpsCallable } from 'firebase/functions'
import { db, functions, storage } from '../../lib/firebase'
import { AirfreightBooking, AirfreightFlight, ScreeningEvent } from '../../types'
import Layout from '../../components/Layout'
import { useAuth } from '../../contexts/AuthContext'

function fmtDate(iso: string) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const yy = String(d.getFullYear()).slice(2)
  const hh = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${mm}/${dd}/${yy} ${hh}:${min}`
}

function fmtShortDate(iso: string) {
  if (!iso) return '—'
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split('-')
    return `${m}/${d}/${y.slice(2)}`
  }
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${String(d.getFullYear()).slice(2)}`
}

/** Strip dashes/en-dashes/spaces for AWB comparison */
function normalizeAwb(awb: string) {
  return (awb || '').replace(/[\s\-\u2013\u2014]/g, '').replace(/[Oo]/g, '0').trim()
}

/** Open PDF via Cloud Function proxy (bypasses Storage rules) */
async function openPdfViaProxy(storagePath: string | undefined, fallbackUrl: string) {
  if (!storagePath) { window.open(fallbackUrl, '_blank'); return }
  try {
    const fn = httpsCallable<{ path: string }, { data: string }>(functions, 'getScreeningPdf')
    const result = await fn({ path: storagePath })
    const byteChars = atob(result.data.data)
    const byteArray = new Uint8Array(byteChars.length)
    for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i)
    const blob = new Blob([byteArray], { type: 'application/pdf' })
    const url = URL.createObjectURL(blob)
    window.open(url, '_blank')
  } catch (err) {
    console.error('Error fetching PDF via proxy:', err)
    window.open(fallbackUrl, '_blank')
  }
}

export default function AirfreightScreeningDetail() {
  const { bookingId } = useParams<{ bookingId: string }>()
  const [searchParams] = useSearchParams()
  const awbParam = searchParams.get('awb') || ''

  const [booking, setBooking] = useState<AirfreightBooking | null>(null)
  const [flight, setFlight] = useState<AirfreightFlight | null>(null)
  const [events, setEvents] = useState<(ScreeningEvent & { id: string })[]>([])
  const [loading, setLoading] = useState(true)
  const [markedForDeletion, setMarkedForDeletion] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const { user } = useAuth()

  // Resolver state
  const [showResolver, setShowResolver] = useState(false)
  const [resolveSource, setResolveSource] = useState<'existing' | 'unmatched' | 'upload'>('existing')
  const [resolveExistingEventId, setResolveExistingEventId] = useState('')
  const [resolveUnmatchedEventId, setResolveUnmatchedEventId] = useState('')
  const [resolvePieces, setResolvePieces] = useState(0)
  const [resolveNote, setResolveNote] = useState('')
  const [resolveFile, setResolveFile] = useState<File | null>(null)
  const [unmatchedEvents, setUnmatchedEvents] = useState<(ScreeningEvent & { id: string })[]>([])
  const [resolving, setResolving] = useState(false)
  const [syncing, setSyncing] = useState(false)

  // Load booking
  useEffect(() => {
    if (!bookingId) return
    return onSnapshot(doc(db, 'airfreight_bookings', bookingId), snap => {
      if (snap.exists()) {
        setBooking({ ...snap.data() as AirfreightBooking, id: snap.id })
      }
      setLoading(false)
    })
  }, [bookingId])

  // Load flight
  useEffect(() => {
    if (!booking?.flight_id) return
    return onSnapshot(doc(db, 'airfreight_flights', booking.flight_id), snap => {
      if (snap.exists()) {
        setFlight({ ...snap.data() as AirfreightFlight, id: snap.id })
      }
    })
  }, [booking?.flight_id])

  // Load unmatched events when resolver opens
  useEffect(() => {
    if (!showResolver) return
    const q = query(
      collection(db, 'screening_events'),
      where('status', '==', 'unmatched'),
    )
    return onSnapshot(q, snap => {
      setUnmatchedEvents(
        snap.docs
          .map(d => ({ ...d.data() as ScreeningEvent, id: d.id }))
          .sort((a, b) => (b.processed_at || '').localeCompare(a.processed_at || ''))
      )
    })
  }, [showResolver])

  // Load screening events for this booking
  useEffect(() => {
    if (!bookingId) return
    const q = query(
      collection(db, 'screening_events'),
      where('matched_booking_id', '==', bookingId),
    )
    return onSnapshot(q, snap => {
      setEvents(
        snap.docs
          .map(d => ({ ...d.data() as ScreeningEvent, id: d.id }))
          .sort((a, b) => (b.extracted?.date || b.processed_at || '').localeCompare(a.extracted?.date || a.processed_at || ''))
      )
    })
  }, [bookingId])

  if (loading) {
    return (
      <Layout title="Screening Detail" backTo="/airfreight/screening">
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" />
        </div>
      </Layout>
    )
  }

  if (!booking) {
    return (
      <Layout title="Screening Detail" backTo="/airfreight/screening">
        <div className="text-center py-20 text-gray-400">Booking not found</div>
      </Layout>
    )
  }

  const flightLabel = flight
    ? `${flight.flight_number || flight.airline} — ${fmtShortDate(flight.flight_datetime)}`
    : booking.flight_id

  // Determine which AWB to show and use for filtering
  const normParam = normalizeAwb(awbParam)

  // For MAWB bookings: if awbParam matches the mawb_number, show all AWB lines (it's the cover MAWB)
  // For Direct bookings: filter by specific AWB
  const isMawbView = booking.mawb_number && normalizeAwb(booking.mawb_number) === normParam

  // Display label
  const displayAwb = awbParam || booking.mawb_number || booking.awb_2nd_leg || booking.awb_1st_leg || '—'

  // Pieces calculation: per-AWB when viewing a specific AWB, per-booking when viewing MAWB
  let totalBookingPieces = 0

  // Filter events by AWB when viewing a specific AWB (not MAWB view)
  let filteredEvents = events
  if (normParam && !isMawbView) {
    filteredEvents = events.filter(ev => normalizeAwb(ev.extracted.awb) === normParam)
  }

  // Always calculate screened pieces from events (source of truth)
  const totalScreenedPieces = filteredEvents
    .filter(ev => (ev as any).status !== 'duplicate')
    .reduce((s, ev) => s + (ev.extracted?.pieces || 0), 0)

  if (isMawbView && booking.awb_lines?.length) {
    totalBookingPieces = booking.awb_lines.reduce((s, l) => s + (l.pieces || 0), 0)
  } else if (booking.awb_lines?.length && normParam) {
    const matchingLines = booking.awb_lines.filter(l =>
      normalizeAwb(l.awb_2nd_leg || '') === normParam ||
      normalizeAwb(l.awb_number || '') === normParam
    )
    for (const line of matchingLines) {
      totalBookingPieces += line.pieces || 0
    }
  } else {
    totalBookingPieces = booking.pieces || 0
  }

  // Status based on filtered data
  let st: string
  if (totalScreenedPieces > totalBookingPieces && totalBookingPieces > 0) st = 'error'
  else if (totalScreenedPieces === totalBookingPieces && totalScreenedPieces > 0) st = 'complete'
  else if (totalScreenedPieces > 0) st = 'partial'
  else st = 'pending'

  const statusColor: Record<string, string> = {
    complete: 'bg-green-100 text-green-700',
    partial: 'bg-amber-100 text-amber-700',
    error: 'bg-red-100 text-red-700',
    pending: 'bg-gray-100 text-gray-400',
  }

  const statusEmoji: Record<string, string> = {
    complete: '\u{1F7E2}',
    partial: '\u{1F7E1}',
    error: '\u{1F534}',
    pending: '\u26AA',
  }

  function toggleDelete(eventId: string) {
    setMarkedForDeletion(prev => {
      const next = new Set(prev)
      if (next.has(eventId)) next.delete(eventId)
      else next.add(eventId)
      return next
    })
  }

  function openResolver() {
    const missing = totalBookingPieces - totalScreenedPieces
    setResolvePieces(missing > 0 ? missing : 0)
    setResolveSource('existing')
    setResolveExistingEventId('')
    setResolveUnmatchedEventId('')
    setResolveNote('')
    setResolveFile(null)
    setShowResolver(true)
  }

  async function handleResolve() {
    if (resolvePieces <= 0) return alert('Las piezas deben ser mayor a 0')
    if (!resolveNote.trim()) return alert('Debe ingresar una nota de corrección')

    // Validate source
    if (resolveSource === 'existing' && !resolveExistingEventId) return alert('Seleccione un certificado existente')
    if (resolveSource === 'unmatched' && !resolveUnmatchedEventId) return alert('Seleccione un certificado no asignado')
    if (resolveSource === 'upload' && !resolveFile) return alert('Debe subir un archivo PDF')

    setResolving(true)
    try {
      let pdfUrl = ''
      let pdfStoragePath = ''
      let pdfFilename = ''
      let matchedVia = ''

      if (resolveSource === 'existing') {
        const ev = filteredEvents.find(e => e.id === resolveExistingEventId)
        if (!ev) throw new Error('Certificado no encontrado')
        pdfUrl = ev.pdf_url
        pdfStoragePath = ev.pdf_storage_path || ''
        pdfFilename = ev.pdf_filename
        matchedVia = `existing_cert:${ev.id}`
      } else if (resolveSource === 'unmatched') {
        const ev = unmatchedEvents.find(e => e.id === resolveUnmatchedEventId)
        if (!ev) throw new Error('Certificado no encontrado')
        pdfUrl = ev.pdf_url
        pdfStoragePath = ev.pdf_storage_path || ''
        pdfFilename = ev.pdf_filename
        matchedVia = `unmatched_cert:${ev.id}`
        // Mark the original unmatched event as resolved
        await updateDoc(doc(db, 'screening_events', ev.id), {
          match_status: 'matched',
          status: 'processed',
          matched_booking_id: bookingId,
          matched_flight_id: booking!.flight_id,
          match_method: 'manual_correction',
          matched_via: 'resolver_rematch',
        })
      } else if (resolveSource === 'upload') {
        const file = resolveFile!
        const now = new Date()
        const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
        const path = `airfreight/screening-certs/${yearMonth}/manual_${Date.now()}_${file.name}`
        const storageRef = ref(storage, path)
        await uploadBytes(storageRef, file)
        pdfUrl = await getDownloadURL(storageRef)
        pdfStoragePath = path
        pdfFilename = file.name
        matchedVia = 'new_upload'
      }

      const now = new Date().toISOString()

      // Create manual correction screening event
      await addDoc(collection(db, 'screening_events'), {
        gmail_message_id: `manual_correction_${Date.now()}`,
        gmail_subject: `Corrección manual: ${resolveNote}`,
        gmail_date: now,
        pdf_url: pdfUrl,
        pdf_storage_path: pdfStoragePath,
        pdf_filename: pdfFilename,
        extracted: {
          mawb: booking!.mawb_number || '',
          awb: awbParam || booking!.awb_2nd_leg || booking!.mawb_number || '',
          date: now.split('T')[0],
          time: now.split('T')[1]?.substring(0, 5) || '',
          phantom_screener: 'Corrección Manual',
          mcl_representant: user?.email || '',
          uld: '',
          pieces: resolvePieces,
        },
        matched_booking_id: bookingId,
        matched_flight_id: booking!.flight_id,
        match_method: 'manual_correction',
        matched_via: matchedVia,
        match_status: 'matched',
        status: 'processed',
        processed_at: now,
      })

      // Update booking screening totals + line-level status + audit log
      const bookingRef = doc(db, 'airfreight_bookings', bookingId!)
      const bookingSnap = await getDoc(bookingRef)
      if (bookingSnap.exists()) {
        const bData = bookingSnap.data() as AirfreightBooking
        const lines = [...(bData.awb_lines || [])]
        // Query ALL events from Firestore (React state may be stale after delete/create)
        const evSnap = await getDocs(query(
          collection(db, 'screening_events'),
          where('matched_booking_id', '==', bookingId),
        ))
        const existingPieces = evSnap.docs.reduce((s, d) => {
          const ev = d.data()
          if (ev.status === 'duplicate') return s
          return s + (ev.extracted?.pieces || 0)
        }, 0)
        let newTotal = existingPieces
        let bookingPieces = 0

        // Helper to calculate line screening status
        const calcLineStatus = (screened: number, total: number) => {
          if (screened > total && total > 0) return 'error'
          if (screened === total && screened > 0) return 'complete'
          if (screened > 0) return 'partial'
          return 'pending'
        }

        // Audit entry for the correction
        const auditEntry = {
          action: 'screening_correction',
          detail: `Corrección manual: +${resolvePieces} pzas. ${resolveNote}`,
          user: user?.email || '',
          at: now,
          field: 'screening',
        }

        if (isMawbView || !normParam || bData.booking_type === 'simple') {
          // MAWB or simple booking: increment total
          bookingPieces = lines.reduce((s, l) => s + (l.pieces || 0), 0) || (bData.pieces || 0)
          // For MAWB: distribute proportionally or add audit to first line
          if (lines.length > 0) {
            // Add audit entry to first line
            const existingLog = lines[0].audit_log || []
            lines[0] = { ...lines[0], audit_log: [...existingLog, auditEntry] }
          }
        } else {
          // Specific AWB: update matching line(s)
          let distributed = false
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]
            if (normalizeAwb(line.awb_2nd_leg || '') === normParam || normalizeAwb(line.awb_number || '') === normParam) {
              if (!distributed) {
                const newScreened = (line.screening_pieces_screened || 0) + resolvePieces
                const lineStatus = calcLineStatus(newScreened, line.pieces || 0)
                const existingLog = line.audit_log || []
                lines[i] = {
                  ...line,
                  screening_pieces_screened: newScreened,
                  screening_status: lineStatus as any,
                  audit_log: [...existingLog, auditEntry],
                }
                distributed = true
              } else {
                // Other matching lines: recalculate status from existing screened
                const screened = line.screening_pieces_screened || 0
                const lineStatus = calcLineStatus(screened, line.pieces || 0)
                if (line.screening_status !== lineStatus) {
                  lines[i] = { ...line, screening_status: lineStatus as any }
                }
              }
            }
          }
          // Recalculate total from all lines
          newTotal = lines.reduce((s, l) => s + (l.screening_pieces_screened || 0), 0)
          bookingPieces = lines.reduce((s, l) => s + (l.pieces || 0), 0)
        }

        // Calculate new booking-level status
        let newStatus: string
        if (newTotal > bookingPieces && bookingPieces > 0) newStatus = 'error'
        else if (newTotal === bookingPieces && newTotal > 0) newStatus = 'complete'
        else if (newTotal > 0) newStatus = 'partial'
        else newStatus = 'pending'

        const updateData: any = {
          screening_pieces_total: newTotal,
          screening_status: newStatus,
        }
        if (lines.length > 0) {
          updateData.awb_lines = lines
        }
        await updateDoc(bookingRef, updateData)
      }

      setShowResolver(false)
    } catch (err: any) {
      console.error('Error resolving screening:', err)
      alert('Error: ' + (err.message || 'No se pudo resolver'))
    } finally {
      setResolving(false)
    }
  }

  async function handleDeleteEvents() {
    if (markedForDeletion.size === 0) return
    if (!confirm(`Eliminar ${markedForDeletion.size} certificado(s)? Se recalculará el screening del booking.`)) return
    setSaving(true)
    try {
      const fn = httpsCallable(functions, 'resetScreeningData')
      await fn({ mode: 'deleteEvents', eventIds: Array.from(markedForDeletion) })
      setMarkedForDeletion(new Set())
    } catch (err: any) {
      console.error('Error deleting events:', err)
      alert('Error: ' + (err.message || 'No se pudieron eliminar los certificados'))
    } finally {
      setSaving(false)
    }
  }

  async function handleSyncTotal() {
    if (!bookingId || !booking) return
    setSyncing(true)
    try {
      // Query all events from Firestore for this booking
      const evSnap = await getDocs(query(
        collection(db, 'screening_events'),
        where('matched_booking_id', '==', bookingId),
      ))
      const validEvents = evSnap.docs
        .map(d => d.data())
        .filter(ev => ev.status !== 'duplicate')

      const totalFromEvents = validEvents.reduce((s, ev) => s + (ev.extracted?.pieces || 0), 0)
      const lines = booking.awb_lines ? [...booking.awb_lines] : []
      const bkPieces = booking.pieces || lines.reduce((s, l) => s + (l.pieces || 0), 0)

      let newStatus = 'pending'
      if (totalFromEvents > bkPieces && bkPieces > 0) newStatus = 'error'
      else if (totalFromEvents === bkPieces && totalFromEvents > 0) newStatus = 'complete'
      else if (totalFromEvents > 0) newStatus = 'partial'

      const updateData: any = {
        screening_pieces_total: totalFromEvents,
        screening_status: newStatus,
      }

      // Distribute screened pieces per AWB line from events.
      // Skip for MAWB bookings — their events use the MAWB number, not child AWBs,
      // so per-line distribution would zero out all lines incorrectly.
      if (lines.length > 0 && !booking.mawb_number) {
        const updatedLines = lines.map(line => {
          const lineAwb = normalizeAwb(line.awb_2nd_leg || line.awb_number || '')
          if (!lineAwb) return line
          const lineScreened = validEvents
            .filter(ev => normalizeAwb(ev.extracted?.awb || '') === lineAwb)
            .reduce((s, ev) => s + (ev.extracted?.pieces || 0), 0)
          const linePieces = line.pieces || 0
          let lineSt = 'pending'
          if (lineScreened > linePieces && linePieces > 0) lineSt = 'error'
          else if (lineScreened === linePieces && lineScreened > 0) lineSt = 'complete'
          else if (lineScreened > 0) lineSt = 'partial'
          return { ...line, screening_pieces_screened: lineScreened, screening_status: lineSt }
        })
        updateData.awb_lines = updatedLines
      }

      await updateDoc(doc(db, 'airfreight_bookings', bookingId), updateData)
      alert(`Total sincronizado: ${totalFromEvents} piezas → ${newStatus}`)
    } catch (err: any) {
      console.error('Error syncing total:', err)
      alert('Error: ' + (err.message || 'No se pudo sincronizar'))
    } finally {
      setSyncing(false)
    }
  }

  return (
    <Layout title="Screening Detail" backTo="/airfreight/screening">
      {/* Header card */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 mb-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div>
            <p className="text-[10px] text-gray-400 uppercase tracking-wide">Flight</p>
            <p className="text-sm font-semibold text-gray-700">{flightLabel}</p>
          </div>
          <div>
            <p className="text-[10px] text-gray-400 uppercase tracking-wide">Client</p>
            <p className="text-sm font-semibold text-gray-700">{booking.client_name}</p>
          </div>
          <div>
            <p className="text-[10px] text-gray-400 uppercase tracking-wide">{isMawbView ? 'MAWB' : 'AWB'}</p>
            <p className="text-sm font-mono font-bold text-mcl-blue">{displayAwb}</p>
          </div>
          <div>
            <p className="text-[10px] text-gray-400 uppercase tracking-wide">Status</p>
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${statusColor[st]}`}>
                {statusEmoji[st]} {st.charAt(0).toUpperCase() + st.slice(1)} — {totalScreenedPieces}/{totalBookingPieces} pcs
              </span>
              <button
                onClick={handleSyncTotal}
                disabled={syncing}
                title="Recalcular total desde certificados"
                className="text-gray-400 hover:text-blue-600 transition-colors disabled:opacity-50"
              >
                <svg className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Resolver button */}
      {(st === 'partial' || st === 'error' || st === 'pending') && !showResolver && (
        <div className="mb-4 flex justify-end">
          <button
            onClick={openResolver}
            className="flex items-center gap-2 bg-amber-500 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-amber-600 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            Corrección manual ({totalBookingPieces - totalScreenedPieces} pcs faltantes)
          </button>
        </div>
      )}

      {/* Resolver panel */}
      {showResolver && (
        <div className="bg-white rounded-xl shadow-sm border border-amber-200 p-5 mb-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
              <svg className="w-4 h-4 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              Corrección Manual de Screening
            </h3>
            <button onClick={() => setShowResolver(false)} className="text-gray-400 hover:text-gray-600">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="bg-amber-50 border border-amber-100 rounded-lg px-4 py-3 mb-4 text-sm text-amber-800">
            Faltan <strong>{totalBookingPieces - totalScreenedPieces}</strong> piezas de {totalBookingPieces} totales.
            Seleccione la fuente del certificado que respalda la corrección.
          </div>

          <div className="space-y-4">
            {/* Source selector */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-2">Fuente del certificado</label>
              <div className="flex flex-wrap gap-2">
                {[
                  { value: 'existing' as const, label: 'Certificado existente' },
                  { value: 'unmatched' as const, label: 'Certificado no asignado' },
                  { value: 'upload' as const, label: 'Subir nuevo PDF' },
                ].map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setResolveSource(opt.value)}
                    className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                      resolveSource === opt.value
                        ? 'bg-mcl-blue text-white border-mcl-blue'
                        : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Source-specific selector */}
            {resolveSource === 'existing' && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Seleccionar certificado</label>
                <select
                  value={resolveExistingEventId}
                  onChange={e => setResolveExistingEventId(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                >
                  <option value="">Seleccionar...</option>
                  {filteredEvents.filter(ev => ev.pdf_url).map(ev => (
                    <option key={ev.id} value={ev.id}>
                      {fmtShortDate(ev.extracted.date)} — {ev.extracted.pieces} pcs — {ev.extracted.phantom_screener || 'Sin screener'}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {resolveSource === 'unmatched' && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Seleccionar certificado no asignado</label>
                {unmatchedEvents.length === 0 ? (
                  <p className="text-xs text-gray-400 italic">No hay certificados no asignados disponibles</p>
                ) : (
                  <select
                    value={resolveUnmatchedEventId}
                    onChange={e => setResolveUnmatchedEventId(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                  >
                    <option value="">Seleccionar...</option>
                    {unmatchedEvents.map(ev => (
                      <option key={ev.id} value={ev.id}>
                        {fmtShortDate(ev.extracted.date)} — AWB: {ev.extracted.awb || '?'} — {ev.extracted.pieces} pcs — {ev.gmail_subject?.substring(0, 40)}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}

            {resolveSource === 'upload' && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Subir certificado PDF</label>
                <input
                  type="file"
                  accept=".pdf"
                  onChange={e => setResolveFile(e.target.files?.[0] || null)}
                  className="w-full text-sm text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-mcl-blue/10 file:text-mcl-blue hover:file:bg-mcl-blue/20"
                />
                {resolveFile && (
                  <p className="text-xs text-gray-500 mt-1">{resolveFile.name}</p>
                )}
              </div>
            )}

            {/* Pieces + Note */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Piezas a agregar</label>
                <input
                  type="number"
                  min={1}
                  value={resolvePieces}
                  onChange={e => setResolvePieces(parseInt(e.target.value) || 0)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Nota de corrección</label>
                <input
                  type="text"
                  value={resolveNote}
                  onChange={e => setResolveNote(e.target.value)}
                  placeholder="Ej: FQA mal escrito en certificado original"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                />
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-gray-100">
              <button
                onClick={() => setShowResolver(false)}
                disabled={resolving}
                className="text-sm px-4 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
              >
                Cancelar
              </button>
              <button
                onClick={handleResolve}
                disabled={resolving}
                className="text-sm px-4 py-2 rounded-lg bg-amber-500 text-white font-semibold hover:bg-amber-600 disabled:opacity-50 transition-colors"
              >
                {resolving ? 'Procesando...' : 'Aplicar Corrección'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* AWB Lines debug (collapsible) */}
      {booking.awb_lines && booking.awb_lines.length > 0 && (
        <details className="mb-4">
          <summary className="text-[10px] text-gray-400 uppercase tracking-wide cursor-pointer hover:text-gray-600">
            AWB Lines ({booking.awb_lines.length})
          </summary>
          <div className="mt-1 bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="text-left px-3 py-1.5 text-gray-500">#</th>
                  <th className="text-left px-3 py-1.5 text-gray-500">AWB 1st Leg</th>
                  <th className="text-left px-3 py-1.5 text-gray-500">AWB 2nd Leg</th>
                  <th className="text-left px-3 py-1.5 text-gray-500">AWB Number</th>
                  <th className="text-center px-3 py-1.5 text-gray-500">Pcs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {booking.awb_lines.map((l: any, i: number) => (
                  <tr key={i}>
                    <td className="px-3 py-1 text-gray-400">{i}</td>
                    <td className="px-3 py-1 font-mono">{l.awb_1st_leg || '—'}</td>
                    <td className="px-3 py-1 font-mono">{l.awb_2nd_leg || '—'}</td>
                    <td className="px-3 py-1 font-mono">{l.awb_number || '—'}</td>
                    <td className="px-3 py-1 text-center">{l.pieces || 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {/* Certificates */}
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wide">
          Screening Certificates ({filteredEvents.length || (booking.screening_details ? 1 : 0)})
        </h2>
        {markedForDeletion.size > 0 && (
          <button
            onClick={handleDeleteEvents}
            disabled={saving}
            className="flex items-center gap-1.5 bg-red-600 text-white text-xs font-semibold px-4 py-1.5 rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Eliminando...' : `Eliminar ${markedForDeletion.size} certificado(s)`}
          </button>
        )}
      </div>

      {filteredEvents.length === 0 && booking.screening_details ? (
        <div className="space-y-4">
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100">
              <div className="flex flex-wrap items-center gap-4">
                <div>
                  <p className="text-[10px] text-gray-400 uppercase">Date / Time</p>
                  <p className="text-sm font-semibold text-gray-700">
                    {fmtShortDate(booking.screening_details.date)} {booking.screening_details.time || ''}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-gray-400 uppercase">Screener</p>
                  <p className="text-sm text-gray-700">{booking.screening_details.phantom_screener || '—'}</p>
                </div>
                <div>
                  <p className="text-[10px] text-gray-400 uppercase">MCL Rep</p>
                  <p className="text-sm text-gray-700">{booking.screening_details.mcl_representant || '—'}</p>
                </div>
                <div>
                  <p className="text-[10px] text-gray-400 uppercase">Total Pieces</p>
                  <p className="text-sm font-bold text-gray-700">{booking.screening_details.pieces || 0}</p>
                </div>
                <div>
                  <p className="text-[10px] text-gray-400 uppercase">AWB</p>
                  <p className="text-sm font-mono text-gray-700">{booking.screening_details.awb || '—'}</p>
                </div>
              </div>
            </div>
            {booking.doc_screening_cert?.url && (
              <div className="px-5 py-3 bg-gray-50 flex items-center gap-2">
                <button
                  onClick={() => openPdfViaProxy(booking.doc_screening_cert?.filename ? `screening-certificates/${booking.doc_screening_cert.filename}` : undefined, booking.doc_screening_cert?.url || '')}
                  className="text-xs text-blue-600 hover:underline font-medium"
                >
                  Ver PDF del certificado
                </button>
              </div>
            )}
          </div>
        </div>
      ) : filteredEvents.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-8 text-center text-gray-400 text-sm">
          No screening certificates found for this {isMawbView ? 'MAWB' : 'AWB'}
        </div>
      ) : (
        <div className="space-y-4">
          {filteredEvents.map(ev => {
            const isMarked = markedForDeletion.has(ev.id)
            return (
            <div key={ev.id} className={`bg-white rounded-xl shadow-sm border overflow-hidden transition-colors ${isMarked ? 'border-red-300 bg-red-50/30' : ev.match_method === 'manual_correction' ? 'border-amber-200' : 'border-gray-100'}`}>
              {/* Certificate header */}
              <div className={`px-5 py-4 border-b ${ev.match_method === 'manual_correction' ? 'border-amber-100 bg-amber-50/30' : 'border-gray-100'}`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-4">
                    <div>
                      <p className="text-[10px] text-gray-400 uppercase">Date / Time</p>
                      <p className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                        {fmtShortDate(ev.extracted.date)} {ev.extracted.time || ''}
                        {ev.match_method === 'manual_correction' && (
                          <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-medium">CORRECCIÓN</span>
                        )}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-gray-400 uppercase">Screener</p>
                      <p className="text-sm text-gray-700">{ev.extracted.phantom_screener || '—'}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-gray-400 uppercase">MCL Rep</p>
                      <p className="text-sm text-gray-700">{ev.extracted.mcl_representant || '—'}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-gray-400 uppercase">Total Pieces</p>
                      <p className="text-sm font-bold text-gray-700">{ev.extracted.pieces}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-gray-400 uppercase">AWB</p>
                      <p className="text-sm font-mono text-gray-700">{ev.extracted.awb || '—'}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {(ev as any).status === 'duplicate' && (
                      <button
                        onClick={async () => {
                          if (!confirm('¿Restaurar este certificado? Se cambiará de "duplicate" a "processed" y se incluirá en el total.')) return
                          await updateDoc(doc(db, 'screening_events', ev.id), { status: 'processed', match_status: 'matched', error_reason: null })
                        }}
                        className="flex items-center gap-1.5 bg-amber-100 text-amber-700 text-xs font-semibold px-3 py-1.5 rounded-lg hover:bg-amber-200 transition-colors"
                      >
                        Restaurar
                      </button>
                    )}
                    {ev.pdf_url && (
                      <button
                        onClick={() => openPdfViaProxy(ev.pdf_storage_path, ev.pdf_url)}
                        className="flex items-center gap-1.5 bg-mcl-blue text-white text-xs font-semibold px-3 py-1.5 rounded-lg hover:bg-mcl-blue/90 transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        Open PDF
                      </button>
                    )}
                    <button
                      onClick={() => toggleDelete(ev.id)}
                      className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors ${
                        isMarked
                          ? 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                          : 'bg-red-100 text-red-700 hover:bg-red-200'
                      }`}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                      {isMarked ? 'Desmarcar' : 'Eliminar'}
                    </button>
                  </div>
                </div>
              </div>

              {/* ULD / Container detail table */}
              {ev.extracted.uld_lines && ev.extracted.uld_lines.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-100">
                      <tr>
                        <th className="text-left px-5 py-2 font-semibold text-gray-500 text-xs uppercase">AWB</th>
                        <th className="text-left px-5 py-2 font-semibold text-gray-500 text-xs uppercase">ULD / Container</th>
                        <th className="text-center px-5 py-2 font-semibold text-gray-500 text-xs uppercase">Pieces</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {ev.extracted.uld_lines.map((uld, i) => (
                        <tr key={i} className="hover:bg-gray-50/50">
                          <td className="px-5 py-2 text-xs font-mono text-gray-700">{uld.awb || '—'}</td>
                          <td className="px-5 py-2 text-xs font-mono text-gray-700">
                            {uld.uld_type ? `${uld.uld_type} ${uld.uld_number || ''}` : uld.uld_number || '—'}
                          </td>
                          <td className="px-5 py-2 text-center text-xs font-semibold text-gray-700">{uld.pieces}</td>
                        </tr>
                      ))}
                      <tr className="bg-gray-50">
                        <td className="px-5 py-2 text-xs font-semibold text-gray-500 text-right" colSpan={2}>Total</td>
                        <td className="px-5 py-2 text-center text-xs font-bold text-gray-700">
                          {ev.extracted.uld_lines.reduce((s, u) => s + (u.pieces || 0), 0)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="px-5 py-3">
                  <p className="text-[10px] text-gray-400 uppercase">ULD</p>
                  <p className="text-sm text-gray-700">{ev.extracted.uld || '—'}</p>
                </div>
              )}

              {/* Error info */}
              {ev.error_reason && (
                <div className="px-5 py-3 bg-red-50 border-t border-red-100">
                  <p className="text-xs text-red-600 font-semibold">Error: {ev.error_reason}</p>
                </div>
              )}

              {/* Footer: processed info */}
              <div className="px-5 py-2 bg-gray-50 border-t border-gray-100 flex flex-wrap justify-between gap-2 text-[10px] text-gray-400">
                <span>Processed: {fmtDate(ev.processed_at)}</span>
                <span>Match: {ev.match_method}{ev.matched_via ? ` (${ev.matched_via})` : ''}{ev.matched_line_awb ? ` → ${ev.matched_line_awb}` : ''}</span>
                <span>Email: {ev.gmail_subject}</span>
              </div>
            </div>
            )
          })}
        </div>
      )}
    </Layout>
  )
}
