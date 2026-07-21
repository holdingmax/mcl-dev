import { useState, useEffect, useRef } from 'react'
import {
  collection, query, orderBy, onSnapshot, doc, updateDoc, getDoc, where, getDocs, addDoc, deleteDoc, limit,
} from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage'
import { db, storage } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import { AirfreightHold, AirfreightBooking, HoldStatus, AirfreightDocumentFile, AirfreightFlight, AirfreightClient } from '../../types'
import Layout from '../../components/Layout'
import { MCL_CC_RECIPIENTS } from '../../data/emailRecipients'
import { storagePathHold } from '../../lib/utils'
import * as XLSX from 'xlsx'

const STATUS_LABELS: Record<HoldStatus, string> = {
  informed: 'Informed',
  photo_taken: 'Photo',
  cbp_released: 'CBP Released',
  pending_instruction: 'Pending',
  fly: 'Fly',
  send_do: 'Send DO',
  completed: 'Completed',
}

const STATUS_COLORS: Record<HoldStatus, string> = {
  informed: 'bg-gray-100 text-gray-700',
  photo_taken: 'bg-blue-100 text-blue-700',
  cbp_released: 'bg-indigo-100 text-indigo-700',
  pending_instruction: 'bg-amber-100 text-amber-700',
  fly: 'bg-green-100 text-green-700',
  send_do: 'bg-purple-100 text-purple-700',
  completed: 'bg-gray-200 text-gray-500',
}

const ALL_STATUSES: HoldStatus[] = ['informed', 'photo_taken', 'cbp_released', 'pending_instruction', 'fly', 'send_do', 'completed']

export default function AirfreightHolds() {
  const { user, isAdmin, isSuperAgent, isAgent, isCounter, isBodega, isClient, clientId, gmailToken, refreshGmailToken } = useAuth()
  const isMcl = isAdmin || isSuperAgent || isAgent || isCounter || isBodega

  const [holds, setHolds] = useState<(AirfreightHold & { id: string })[]>([])
  const [loading, setLoading] = useState(true)

  // Filters
  const [filterStatus, setFilterStatus] = useState<HoldStatus | 'all'>('all')
  const [filterClient, setFilterClient] = useState('')
  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')
  const [searchQuery, setSearchQuery] = useState('')

  // Modals
  const [photoModal, setPhotoModal] = useState<string | null>(null) // hold id
  const [cbpModal, setCbpModal] = useState<string | null>(null)
  const [cbpNotes, setCbpNotes] = useState('')
  const [flyModal, setFlyModal] = useState<string | null>(null)
  const [flyFlightId, setFlyFlightId] = useState('')
  const [flyFlightNumber, setFlyFlightNumber] = useState('')
  const [flyMawb, setFlyMawb] = useState('')
  const [flyAwb, setFlyAwb] = useState('')
  const [flyDatetime, setFlyDatetime] = useState('')
  const [flyDocs, setFlyDocs] = useState<File[]>([])
  const [sendDoModal, setSendDoModal] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [selectedHolds, setSelectedHolds] = useState<Set<string>>(new Set())
  const [sendingEmail, setSendingEmail] = useState(false)

  // Available flights for fly modal
  const [flights, setFlights] = useState<(AirfreightFlight & { id: string })[]>([])

  // Import Excel
  const [importModal, setImportModal] = useState(false)
  const [importPreview, setImportPreview] = useState<{
    toCreate: { awb: string; bag: string; box: string; booking_id: string; flight_id: string; flight_number: string; flight_date: string; client_id: string; client_name: string }[]
    duplicates: { awb: string; bag: string; box: string }[]
    noMatch: { awb: string; bag: string; box: string }[]
  } | null>(null)
  const [importing, setImporting] = useState(false)
  const importInputRef = useRef<HTMLInputElement>(null)

  const photoInputRef = useRef<HTMLInputElement>(null)
  const flyDocsRef = useRef<HTMLInputElement>(null)

  // ── Load holds ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (isClient && !clientId) {
      setHolds([])
      setLoading(false)
      return
    }

    const q = isClient && clientId
      ? query(collection(db, 'airfreight_holds'), where('client_id', '==', clientId), orderBy('created_at', 'desc'), limit(500))
      : query(collection(db, 'airfreight_holds'), orderBy('created_at', 'desc'), limit(500))

    const unsub = onSnapshot(q, snap => {
      setHolds(snap.docs.map(d => ({ ...d.data() as AirfreightHold, id: d.id })))
      setLoading(false)
    }, err => {
      console.error('Holds listener error:', err)
      setHolds([])
      setLoading(false)
    })
    return unsub
  }, [isClient, clientId])

  // ── Load flights (for fly modal) ───────────────────────────────────────────

  useEffect(() => {
    const unsub = onSnapshot(
      query(collection(db, 'airfreight_flights'), where('status', '==', 'open'), orderBy('flight_datetime', 'asc')),
      snap => setFlights(snap.docs.map(d => ({ ...d.data() as AirfreightFlight, id: d.id }))),
    )
    return unsub
  }, [])

  // ── Filters ────────────────────────────────────────────────────────────────

  const clients = [...new Set(holds.map(h => h.client_name).filter(Boolean))].sort()

  const filtered = holds.filter(h => {
    if (filterStatus !== 'all' && h.status !== filterStatus) return false
    if (filterClient && h.client_name !== filterClient) return false
    if (filterDateFrom && h.flight_date < filterDateFrom) return false
    if (filterDateTo && h.flight_date > filterDateTo) return false
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      if (
        !h.awb_number.toLowerCase().includes(q) &&
        !h.bag.toLowerCase().includes(q) &&
        !h.box.toLowerCase().includes(q) &&
        !h.client_name.toLowerCase().includes(q) &&
        !h.flight_number.toLowerCase().includes(q)
      ) return false
    }
    return true
  })

  // ── Actions ────────────────────────────────────────────────────────────────

  async function handleUploadPhoto(holdId: string, file: File) {
    setSaving(true)
    try {
      const ext = file.name.split('.').pop() || 'jpg'
      const holdForPhoto = holds.find(h => h.id === holdId)
      const path = storagePathHold({ flightNumber: holdForPhoto?.flight_number, flightDate: holdForPhoto?.flight_date, holdId, filename: `photo_${Date.now()}.${ext}` })
      const sRef = ref(storage, path)
      await uploadBytes(sRef, file)
      const url = await getDownloadURL(sRef)

      const photoDoc: AirfreightDocumentFile = {
        url,
        filename: file.name,
        version: 1,
        uploaded_at: new Date().toISOString(),
        uploaded_by: user?.email || user?.uid || '',
        modified_seen: false,
        history: [],
      }

      // 1. Update the hold record
      await updateDoc(doc(db, 'airfreight_holds', holdId), {
        hold_photo: photoDoc,
        status: 'photo_taken',
        updated_at: new Date().toISOString(),
      })

      // 2. Sync photo back to booking so the flight semaphore updates
      const hold = holds.find(h => h.id === holdId)
      if (hold) {
        await syncPhotoToBooking(hold.booking_id, hold.awb_number, hold.bag, hold.box, photoDoc)
      }

      setPhotoModal(null)
    } catch (err) {
      console.error('Error uploading photo:', err)
      alert('Error al subir la foto')
    } finally {
      setSaving(false)
    }
  }

  async function handleDeletePhoto(holdId: string) {
    if (!confirm('¿Eliminar la foto de este hold? Esta acción no se puede deshacer.')) return
    setSaving(true)
    try {
      const hold = holds.find(h => h.id === holdId)
      if (!hold?.hold_photo?.url) return

      // Delete from Storage
      try {
        const photoRef = ref(storage, hold.hold_photo.url)
        await deleteObject(photoRef)
      } catch (err) {
        console.warn('Could not delete photo from storage:', err)
      }

      // Revert hold to informed status, clear photo
      await updateDoc(doc(db, 'airfreight_holds', holdId), {
        hold_photo: null,
        status: 'informed',
        updated_at: new Date().toISOString(),
      })

      // Sync removal to booking
      if (hold.booking_id) {
        await syncPhotoToBooking(hold.booking_id, hold.awb_number, hold.bag, hold.box, null)
      }
    } catch (err) {
      console.error('Error deleting photo:', err)
      alert('Error al eliminar la foto')
    } finally {
      setSaving(false)
    }
  }

  /** Sync a hold photo back to the booking's holds[] array */
  async function syncPhotoToBooking(
    bookingId: string, awbNumber: string, bag: string, box: string,
    photo: AirfreightDocumentFile | null,
  ) {
    try {
      const snap = await getDoc(doc(db, 'airfreight_bookings', bookingId))
      if (!snap.exists()) return
      const booking = snap.data() as AirfreightBooking

      if ((booking.booking_type === 'mawb' || booking.booking_type === 'ecommerce') && booking.awb_lines) {
        const lines = [...booking.awb_lines]
        let changed = false
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].awb_number === awbNumber && lines[i].holds) {
            const holds = [...lines[i].holds!]
            for (let j = 0; j < holds.length; j++) {
              if (holds[j].bag === bag && holds[j].box === box) {
                holds[j] = { ...holds[j], photo }
                changed = true
              }
            }
            lines[i] = { ...lines[i], holds }
          }
        }
        if (changed) {
          await updateDoc(doc(db, 'airfreight_bookings', bookingId), { awb_lines: lines })
        }
      } else if (booking.holds) {
        const holds = [...booking.holds]
        let changed = false
        for (let i = 0; i < holds.length; i++) {
          if (holds[i].bag === bag && holds[i].box === box) {
            holds[i] = { ...holds[i], photo }
            changed = true
          }
        }
        if (changed) {
          await updateDoc(doc(db, 'airfreight_bookings', bookingId), { holds })
        }
      }
    } catch (err) {
      console.error('Error syncing photo to booking:', err)
    }
  }

  async function handleCbpReleased(holdId: string) {
    setSaving(true)
    try {
      await updateDoc(doc(db, 'airfreight_holds', holdId), {
        status: 'pending_instruction',
        cbp_released_at: new Date().toISOString(),
        cbp_released_by: user?.email || user?.uid || '',
        cbp_notes: cbpNotes || null,
        updated_at: new Date().toISOString(),
      })
      setCbpModal(null)
      setCbpNotes('')
    } catch (err) {
      console.error('Error marking CBP released:', err)
      alert('Error al marcar CBP Released')
    } finally {
      setSaving(false)
    }
  }

  async function handleFly(holdId: string) {
    if (!flyFlightId && !flyFlightNumber) return
    setSaving(true)
    try {
      // Upload documents if any
      const clientDocuments: AirfreightDocumentFile[] = []
      const holdForPath = holds.find(h => h.id === holdId)
      for (const file of flyDocs) {
        const ext = file.name.split('.').pop() || 'pdf'
        const path = storagePathHold({ flightNumber: holdForPath?.flight_number, flightDate: holdForPath?.flight_date, holdId, filename: `${Date.now()}_${file.name}` })
        const sRef = ref(storage, path)
        await uploadBytes(sRef, file)
        const url = await getDownloadURL(sRef)
        clientDocuments.push({
          url,
          filename: file.name,
          version: 1,
          uploaded_at: new Date().toISOString(),
          uploaded_by: user?.email || user?.uid || '',
          modified_seen: true,
          history: [],
        })
      }

      const selectedFlight = flights.find(f => f.id === flyFlightId)

      await updateDoc(doc(db, 'airfreight_holds', holdId), {
        status: 'fly',
        instruction: 'fly',
        instruction_at: new Date().toISOString(),
        instruction_by: user?.email || user?.uid || '',
        fly_flight_id: flyFlightId || null,
        fly_flight_number: flyFlightNumber || selectedFlight?.flight_number || '',
        fly_mawb: flyMawb || null,
        fly_awb: flyAwb || null,
        fly_datetime: flyDatetime || null,
        client_documents: clientDocuments.length > 0 ? clientDocuments : null,
        updated_at: new Date().toISOString(),
      })
      setFlyModal(null)
      setFlyFlightId('')
      setFlyFlightNumber('')
      setFlyMawb('')
      setFlyAwb('')
      setFlyDatetime('')
      setFlyDocs([])
    } catch (err) {
      console.error('Error setting fly instruction:', err)
      alert('Error al guardar la instrucción')
    } finally {
      setSaving(false)
    }
  }

  async function handleSendDo(holdId: string) {
    setSaving(true)
    try {
      await updateDoc(doc(db, 'airfreight_holds', holdId), {
        status: 'send_do',
        instruction: 'send_do',
        instruction_at: new Date().toISOString(),
        instruction_by: user?.email || user?.uid || '',
        updated_at: new Date().toISOString(),
      })
      setSendDoModal(null)
    } catch (err) {
      console.error('Error setting send_do instruction:', err)
      alert('Error al guardar la instrucción')
    } finally {
      setSaving(false)
    }
  }

  // ── Delete hold ────────────────────────────────────────────────────────────

  async function handleDeleteHold(holdId: string) {
    if (!confirm('¿Está seguro de eliminar este hold?')) return
    try {
      await deleteDoc(doc(db, 'airfreight_holds', holdId))
    } catch (err) {
      console.error('Error deleting hold:', err)
      alert('Error al eliminar el hold')
    }
  }

  // ── Mark as completed ─────────────────────────────────────────────────────

  async function handleMarkCompleted(holdId: string) {
    if (!confirm('¿Confirmar que este hold ya voló y está completado?')) return
    try {
      await updateDoc(doc(db, 'airfreight_holds', holdId), {
        status: 'completed',
        updated_at: new Date().toISOString(),
      })
    } catch (err) {
      console.error('Error marking completed:', err)
      alert('Error al marcar como completado')
    }
  }

  // ── Excel export ────────────────────────────────────────────────────────────

  function exportToExcel() {
    const data = filtered.map(h => ({
      'Fecha': h.flight_date,
      'Vuelo': h.flight_number || '',
      'Cliente': h.client_name,
      'AWB': h.awb_number,
      'Bag': h.bag,
      'Box': h.box,
      'Foto': h.hold_photo?.url ? 'Sí' : 'No',
      'Estado': STATUS_LABELS[h.status],
      'Instrucción': h.instruction === 'fly' ? 'Volar' : h.instruction === 'send_do' ? 'Enviar DO' : '',
      'Vuelo destino': h.fly_flight_number || '',
      'MAWB': (h as any).fly_mawb || '',
      'AWB destino': (h as any).fly_awb || '',
      'Fecha-Hora vuelo': (h as any).fly_datetime || '',
      'CBP Released': h.cbp_released_at ? new Date(h.cbp_released_at).toLocaleString() : '',
      'CBP Notas': h.cbp_notes || '',
    }))
    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Holds')
    XLSX.writeFile(wb, `holds_${new Date().toLocaleDateString('en-CA')}.xlsx`)
  }

  // ── Import Excel ──────────────────────────────────────────────────────────

  async function handleImportFile(file: File) {
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws)

      if (rows.length === 0) {
        alert('El archivo está vacío')
        return
      }

      // Find the AWB column (flexible matching)
      const firstRow = rows[0]
      const keys = Object.keys(firstRow)
      const awbCol = keys.find(k => /guia|awb|import|1st.*leg/i.test(k)) || keys[0]
      const bagCol = keys.find(k => /bag/i.test(k)) || keys[1]
      const boxCol = keys.find(k => /box/i.test(k)) || keys[2]

      if (!awbCol || !bagCol || !boxCol) {
        alert('No se encontraron las columnas GUIA/BAG/BOX en el archivo')
        return
      }

      // Resolve uploader's client name (for clients uploading)
      let uploaderClientId = ''
      let uploaderClientName = ''
      if (isClient && clientId) {
        uploaderClientId = clientId
        const clientSnap = await getDoc(doc(db, 'airfreight_clients', clientId))
        uploaderClientName = clientSnap.exists() ? (clientSnap.data().name || '') : ''
      }

      // Load bookings (client: only own bookings) and flights for matching
      const bookingsQuery = isClient && clientId
        ? query(collection(db, 'airfreight_bookings'), where('client_id', '==', clientId))
        : collection(db, 'airfreight_bookings')
      const [bookingsSnap, flightsSnap] = await Promise.all([
        getDocs(bookingsQuery),
        getDocs(collection(db, 'airfreight_flights')),
      ])

      const flightsMap = new Map<string, AirfreightFlight & { id: string }>()
      flightsSnap.docs.forEach(d => flightsMap.set(d.id, { ...d.data() as AirfreightFlight, id: d.id }))

      // Build AWB → booking info map (normalize to digits only for matching)
      const normalizeAwb = (s: string) => s.replace(/\D/g, '')
      const awbMap = new Map<string, { booking_id: string; flight_id: string; flight_number: string; flight_date: string; client_id: string; client_name: string }>()

      for (const bDoc of bookingsSnap.docs) {
        const b = bDoc.data() as AirfreightBooking
        const flight = flightsMap.get(b.flight_id)
        const info = {
          booking_id: bDoc.id,
          flight_id: b.flight_id || '',
          flight_number: flight?.flight_number || '',
          flight_date: flight?.flight_datetime ? flight.flight_datetime.slice(0, 10) : '',
          client_id: b.client_id || '',
          client_name: b.client_name || '',
        }

        // Map AWBs from mawb lines
        if ((b.booking_type === 'mawb' || b.booking_type === 'ecommerce') && b.awb_lines) {
          for (const line of b.awb_lines) {
            if (line.awb_number) awbMap.set(normalizeAwb(line.awb_number), info)
          }
        }
        // Map AWB from 1st leg
        if (b.awb_1st_leg) awbMap.set(normalizeAwb(b.awb_1st_leg), info)
      }

      // Existing holds keys for duplicate check (normalize AWB)
      const existingKeys = new Set(holds.map(h => `${h.awb_number?.replace(/\D/g, '')}|${h.bag}|${h.box}`))

      const toCreate: typeof importPreview extends null ? never : NonNullable<typeof importPreview>['toCreate'] = []
      const duplicates: { awb: string; bag: string; box: string }[] = []
      const noMatch: { awb: string; bag: string; box: string }[] = []

      for (const row of rows) {
        const awb = String(row[awbCol] || '').trim()
        const bag = String(row[bagCol] || '').trim()
        const box = String(row[boxCol] || '').trim()

        if (!awb && !bag && !box) continue

        const key = `${normalizeAwb(awb)}|${bag}|${box}`
        if (existingKeys.has(key)) {
          duplicates.push({ awb, bag, box })
          continue
        }

        const match = awbMap.get(normalizeAwb(awb))
        if (match) {
          toCreate.push({ awb, bag, box, ...match })
        } else {
          // Create without booking link — use uploader's client info if available
          noMatch.push({ awb, bag, box })
          toCreate.push({
            awb, bag, box,
            booking_id: '',
            flight_id: '',
            flight_number: '',
            flight_date: '',
            client_id: uploaderClientId,
            client_name: uploaderClientName,
          })
        }

        existingKeys.add(key)
      }

      setImportPreview({ toCreate, duplicates, noMatch })
      setImportModal(true)
    } catch (err) {
      console.error('Import error:', err)
      alert('Error al leer el archivo: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  async function confirmImport() {
    if (!importPreview) return
    setImporting(true)
    try {
      const now = new Date().toISOString()
      let created = 0

      // Group items by booking_id to batch-update bookings
      const byBooking = new Map<string, { awb: string; bag: string; box: string }[]>()

      for (const item of importPreview.toCreate) {
        // 1. Create hold in airfreight_holds collection
        await addDoc(collection(db, 'airfreight_holds'), {
          booking_id: item.booking_id,
          flight_id: item.flight_id,
          flight_number: item.flight_number,
          flight_date: item.flight_date,
          client_id: item.client_id,
          client_name: item.client_name,
          awb_number: item.awb,
          bag: item.bag,
          box: item.box,
          status: 'informed' as HoldStatus,
          hold_photo: null,
          created_at: now,
        })
        created++

        // 2. Group for booking sync
        if (item.booking_id) {
          const list = byBooking.get(item.booking_id) || []
          list.push({ awb: item.awb, bag: item.bag, box: item.box })
          byBooking.set(item.booking_id, list)
        }
      }

      // 3. Sync holds into booking documents
      for (const [bookingId, items] of byBooking) {
        try {
          const snap = await getDoc(doc(db, 'airfreight_bookings', bookingId))
          if (!snap.exists()) continue
          const booking = snap.data() as AirfreightBooking

          if ((booking.booking_type === 'mawb' || booking.booking_type === 'ecommerce') && booking.awb_lines) {
            const lines = [...booking.awb_lines]
            let changed = false
            for (const item of items) {
              const lineIdx = lines.findIndex(l => l.awb_number?.replace(/\D/g, '') === item.awb.replace(/\D/g, ''))
              if (lineIdx >= 0) {
                const existingHolds = lines[lineIdx].holds || []
                const alreadyExists = existingHolds.some(h => h.bag === item.bag && h.box === item.box)
                // Also check if this bag+box already exists in ANY other AWB line (prevent cross-AWB duplication)
                const existsInOtherLine = lines.some((l, idx) =>
                  idx !== lineIdx && l.holds?.some(h => h.bag === item.bag && h.box === item.box)
                )
                if (!alreadyExists && !existsInOtherLine) {
                  lines[lineIdx] = {
                    ...lines[lineIdx],
                    hold: true,
                    holds: [...existingHolds, { bag: item.bag, box: item.box, photo: null }],
                  }
                  changed = true
                }
              }
            }
            if (changed) {
              await updateDoc(doc(db, 'airfreight_bookings', bookingId), { awb_lines: lines })
            }
          } else {
            // Simple booking (non-mawb)
            const existingHolds = booking.holds || []
            const newHolds = [...existingHolds]
            let changed = false
            for (const item of items) {
              const alreadyExists = newHolds.some(h => h.bag === item.bag && h.box === item.box)
              if (!alreadyExists) {
                newHolds.push({ bag: item.bag, box: item.box, photo: null })
                changed = true
              }
            }
            if (changed) {
              await updateDoc(doc(db, 'airfreight_bookings', bookingId), { hold: true, holds: newHolds })
            }
          }
        } catch (err) {
          console.error(`Error syncing holds to booking ${bookingId}:`, err)
        }
      }

      alert(`Importación completa: ${created} holds creados.`)
      setImportModal(false)
      setImportPreview(null)
    } catch (err) {
      console.error('Import confirm error:', err)
      alert('Error al importar: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setImporting(false)
    }
  }

  // ── Email holds report ─────────────────────────────────────────────────────

  function toggleHoldSelection(holdId: string) {
    setSelectedHolds(prev => {
      const next = new Set(prev)
      if (next.has(holdId)) next.delete(holdId)
      else next.add(holdId)
      return next
    })
  }

  function toggleAllFiltered() {
    const allSelected = filtered.every(h => selectedHolds.has(h.id))
    if (allSelected) {
      setSelectedHolds(new Set())
    } else {
      setSelectedHolds(new Set(filtered.map(h => h.id)))
    }
  }

  async function handleSendHoldsEmail() {
    const selected = filtered.filter(h => selectedHolds.has(h.id))
    if (selected.length === 0) return

    // All selected holds must belong to the same client
    const clientIds = [...new Set(selected.map(h => h.client_id))]
    if (clientIds.length > 1) {
      alert('Selecciona holds de un solo cliente para enviar el reporte.')
      return
    }

    const clientIdTarget = clientIds[0]
    if (!clientIdTarget) {
      alert('No se encontró el cliente para estos holds.')
      return
    }

    setSendingEmail(true)
    try {
      // 1. Get or refresh Gmail token
      let token = gmailToken
      if (!token) {
        token = await refreshGmailToken()
        if (!token) throw new Error('No se pudo obtener autorización de Gmail.')
      }

      // 2. Fetch client contacts
      const clientSnap = await getDoc(doc(db, 'airfreight_clients', clientIdTarget))
      if (!clientSnap.exists()) throw new Error('No se encontró el cliente en airfreight_clients.')
      const clientData = clientSnap.data() as AirfreightClient

      const recipientEmails: string[] = []
      if (clientData.contacts?.length) {
        for (const c of clientData.contacts) {
          if (c.email) recipientEmails.push(c.email)
        }
      }
      if (clientData.notify_emails?.length) {
        for (const e of clientData.notify_emails) {
          if (e && !recipientEmails.includes(e)) recipientEmails.push(e)
        }
      }
      if (recipientEmails.length === 0) throw new Error('El cliente no tiene contactos de email configurados.')

      // 3. Group holds by AWB
      const byAwb = new Map<string, typeof selected>()
      for (const h of selected) {
        const list = byAwb.get(h.awb_number) || []
        list.push(h)
        byAwb.set(h.awb_number, list)
      }

      // Determine flight info from first hold
      const firstHold = selected[0]
      const flightLabel = firstHold.flight_number || 'N/A'
      const flightDate = firstHold.flight_date || ''

      // 4. Build email body
      const bodyLines: string[] = [
        `Estimados,`,
        ``,
        `Se adjunta evidencia de los paquetes en HOLDs solicitados del vuelo ${flightLabel} del ${flightDate}:`,
        ``,
      ]
      for (const [awb, items] of byAwb) {
        bodyLines.push(`AWB: ${awb}`)
        for (const item of items) {
          bodyLines.push(`  - Bag: ${item.bag} / Box: ${item.box}${item.hold_photo?.url ? ' (foto adjunta)' : ''}`)
        }
        bodyLines.push(``)
      }
      bodyLines.push(`Las fotos se adjuntan a este correo.`)
      bodyLines.push(``)
      bodyLines.push(`Muchas gracias,`)
      bodyLines.push(`MinCurl Logistics`)

      // 5. Download photos as base64
      const photos: { base64: string; mimeType: string; name: string }[] = []
      for (const h of selected) {
        if (!h.hold_photo?.url) continue
        try {
          const resp = await fetch(h.hold_photo.url)
          const blob = await resp.blob()
          const base64 = await new Promise<string>((resolve) => {
            const reader = new FileReader()
            reader.onloadend = () => {
              const dataUrl = reader.result as string
              const b64 = dataUrl.split(',')[1] || ''
              resolve(b64)
            }
            reader.readAsDataURL(blob)
          })
          const mimeType = blob.type || 'image/jpeg'
          const awbClean = h.awb_number.replace(/\D/g, '')
          photos.push({
            base64,
            mimeType,
            name: `hold_${awbClean}_${h.bag}_${h.box}.jpg`,
          })
        } catch (err) {
          console.warn(`Could not download photo for hold ${h.id}:`, err)
        }
      }

      // 6. Build MIME message
      const to = recipientEmails.join(', ')
      const cc = MCL_CC_RECIPIENTS.map(r => r.email).join(', ')
      const subject = `HOLD — ${flightLabel} — ${flightDate}`
      const bodyText = bodyLines.join('\n')
      const boundary = 'MCL_HOLDS_' + Date.now()

      const parts: string[] = [
        `MIME-Version: 1.0`,
        `To: ${to}`,
        `Cc: ${cc}`,
        `Subject: ${subject}`,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        ``,
        `--${boundary}`,
        `Content-Type: text/plain; charset=UTF-8`,
        ``,
        bodyText,
        ``,
      ]

      for (const p of photos) {
        parts.push(
          `--${boundary}`,
          `Content-Type: ${p.mimeType}`,
          `Content-Transfer-Encoding: base64`,
          `Content-Disposition: attachment; filename="${p.name}"`,
          ``,
          p.base64,
          ``,
        )
      }
      parts.push(`--${boundary}--`)
      const rawMime = parts.join('\r\n')

      // 7. Send via Gmail API
      const encoded = btoa(unescape(encodeURIComponent(rawMime)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')

      async function sendGmail(tk: string) {
        const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${tk}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw: encoded }),
        })
        if (!res.ok) {
          const err = await res.json()
          throw new Error(err?.error?.message || 'Gmail API error')
        }
      }

      try {
        await sendGmail(token)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : ''
        if (msg.toLowerCase().includes('invalid') || msg.toLowerCase().includes('expired') || msg.toLowerCase().includes('401')) {
          const fresh = await refreshGmailToken()
          if (!fresh) throw new Error('Sesión de Gmail expirada. Por favor recarga la página.')
          await sendGmail(fresh)
        } else {
          throw err
        }
      }

      const ccNames = MCL_CC_RECIPIENTS.map(r => r.name).join(', ')
      alert(`✓ Mail enviado a: ${recipientEmails.join(', ')}\nCC: ${ccNames}\n\n${selected.length} hold(s), ${photos.length} foto(s) adjuntada(s).`)
      setSelectedHolds(new Set())
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error desconocido'
      alert(`Error al enviar mail: ${msg}`)
    } finally {
      setSendingEmail(false)
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <Layout title="Holds" backTo="/airfreight">
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" />
        </div>
      </Layout>
    )
  }

  return (
    <Layout title="Holds" backTo="/airfreight">
      <div className="space-y-4">

        {/* ── Summary cards ─────────────────────────────────────────────────── */}
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
            <div className="text-2xl font-bold text-mcl-blue">{holds.length}</div>
            <div className="text-xs text-gray-500 mt-1">Total Holds</div>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
            <div className="text-2xl font-bold text-amber-600">
              {holds.filter(h => h.status === 'pending_instruction').length}
            </div>
            <div className="text-xs text-gray-500 mt-1">Pendientes</div>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
            <div className="text-2xl font-bold text-blue-600">
              {holds.filter(h => ['informed', 'photo_taken', 'cbp_released'].includes(h.status)).length}
            </div>
            <div className="text-xs text-gray-500 mt-1">En proceso MCL</div>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
            <div className="text-2xl font-bold text-green-600">
              {holds.filter(h => ['fly', 'send_do', 'completed'].includes(h.status)).length}
            </div>
            <div className="text-xs text-gray-500 mt-1">Resueltos</div>
          </div>
        </div>

        {/* ── Filters ───────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-3 flex-wrap">
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value as HoldStatus | 'all')}
            className="px-3 py-1.5 text-xs border rounded-lg"
          >
            <option value="all">Todos los estados</option>
            {ALL_STATUSES.map(s => (
              <option key={s} value={s}>{STATUS_LABELS[s]}</option>
            ))}
          </select>

          {isMcl && (
            <select
              value={filterClient}
              onChange={e => setFilterClient(e.target.value)}
              className="px-3 py-1.5 text-xs border rounded-lg"
            >
              <option value="">Todos los clientes</option>
              {clients.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          )}

          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-400">Desde</span>
            <input
              type="date"
              value={filterDateFrom}
              onChange={e => setFilterDateFrom(e.target.value)}
              className="px-2 py-1.5 text-xs border rounded-lg"
            />
            <span className="text-xs text-gray-400">Hasta</span>
            <input
              type="date"
              value={filterDateTo}
              onChange={e => setFilterDateTo(e.target.value)}
              className="px-2 py-1.5 text-xs border rounded-lg"
            />
          </div>

          <input
            type="text"
            placeholder="Buscar AWB, bag, box..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="px-3 py-1.5 text-xs border rounded-lg w-56"
          />

          <div className="ml-auto flex gap-2">
            <input
              ref={importInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={e => {
                const file = e.target.files?.[0]
                if (file) handleImportFile(file)
                e.target.value = ''
              }}
            />
            <button
              onClick={() => importInputRef.current?.click()}
              className="px-4 py-1.5 bg-mcl-blue text-white text-xs font-semibold rounded-lg hover:bg-blue-900 transition-colors"
            >
              Cargar Excel
            </button>
            {filtered.length > 0 && (
              <button
                onClick={exportToExcel}
                className="px-4 py-1.5 bg-green-600 text-white text-xs font-semibold rounded-lg hover:bg-green-700 transition-colors"
              >
                Descargar Excel
              </button>
            )}
            {/* Sync is now automatic via backend agent */}
          </div>
        </div>

        {/* ── Table ─────────────────────────────────────────────────────────── */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wider">
                  {isMcl && (
                    <th className="px-2 py-2 text-center w-8">
                      <input
                        type="checkbox"
                        checked={filtered.length > 0 && filtered.every(h => selectedHolds.has(h.id))}
                        onChange={toggleAllFiltered}
                        className="rounded border-gray-300"
                      />
                    </th>
                  )}
                  <th className="px-3 py-2 text-left">Fecha</th>
                  <th className="px-3 py-2 text-left">Vuelo</th>
                  {!isClient && <th className="px-3 py-2 text-left">Cliente</th>}
                  <th className="px-3 py-2 text-left">AWB</th>
                  <th className="px-3 py-2 text-left">Bag</th>
                  <th className="px-3 py-2 text-left">Box</th>
                  <th className="px-3 py-2 text-center">Foto</th>
                  <th className="px-3 py-2 text-center">Estado</th>
                  <th className="px-3 py-2 text-center">Acciones</th>
                  <th className="px-3 py-2 text-center w-8"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={isMcl ? (isClient ? 10 : 11) : (isClient ? 9 : 10)} className="text-center py-10 text-gray-400 text-sm">
                      No se encontraron holds
                    </td>
                  </tr>
                ) : (
                  filtered.map(h => (
                    <tr key={h.id} className={`border-t border-gray-100 hover:bg-gray-50 ${selectedHolds.has(h.id) ? 'bg-blue-50' : ''}`}>
                      {isMcl && (
                        <td className="px-2 py-2 text-center">
                          <input
                            type="checkbox"
                            checked={selectedHolds.has(h.id)}
                            onChange={() => toggleHoldSelection(h.id)}
                            className="rounded border-gray-300"
                          />
                        </td>
                      )}
                      <td className="px-3 py-2 text-xs text-gray-600">{h.flight_date}</td>
                      <td className="px-3 py-2 text-xs font-mono">{h.flight_number || '—'}</td>
                      {!isClient && <td className="px-3 py-2 text-xs">{h.client_name}</td>}
                      <td className="px-3 py-2 text-xs font-mono">{h.awb_number}</td>
                      <td className="px-3 py-2 text-xs font-semibold">{h.bag}</td>
                      <td className="px-3 py-2 text-xs font-semibold">{h.box}</td>
                      <td className="px-3 py-2 text-center">
                        {h.hold_photo?.url ? (
                          <div className="inline-flex items-center gap-1">
                            <a href={h.hold_photo.url} target="_blank" rel="noopener noreferrer"
                              className="inline-block w-8 h-8 rounded overflow-hidden border border-gray-200 hover:border-blue-400">
                              <img src={h.hold_photo.url} alt="Hold" className="w-full h-full object-cover" />
                            </a>
                            {(isMcl || (isClient && h.hold_photo?.uploaded_by === user?.email)) && (
                              <button
                                onClick={() => handleDeletePhoto(h.id)}
                                className="text-red-400 hover:text-red-600 text-xs"
                                title="Eliminar foto"
                              >
                                ✕
                              </button>
                            )}
                          </div>
                        ) : (
                          <span className="text-gray-300 text-xs">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {h.status === 'fly' ? (
                          <button
                            onClick={() => handleMarkCompleted(h.id)}
                            className={`text-xs font-semibold px-2 py-0.5 rounded-full cursor-pointer hover:ring-2 hover:ring-green-300 ${STATUS_COLORS[h.status]}`}
                            title="Click para marcar como Completado"
                          >
                            {STATUS_LABELS[h.status]}
                          </button>
                        ) : (
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${STATUS_COLORS[h.status]}`}>
                            {STATUS_LABELS[h.status]}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <div className="flex items-center justify-center gap-1">
                          {/* MCL actions */}
                          {isMcl && h.status === 'informed' && (
                            <button
                              onClick={() => setPhotoModal(h.id)}
                              className="text-xs px-2 py-1 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                            >
                              Subir Foto
                            </button>
                          )}
                          {isMcl && h.status === 'photo_taken' && (
                            <button
                              onClick={() => setCbpModal(h.id)}
                              className="text-xs px-2 py-1 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
                            >
                              CBP Released
                            </button>
                          )}
                          {/* Client & MCL actions */}
                          {(isClient || isMcl) && h.status === 'pending_instruction' && (
                            <>
                              <button
                                onClick={() => { setFlyModal(h.id); setFlyFlightId(''); setFlyFlightNumber(''); setFlyMawb(''); setFlyAwb(''); setFlyDatetime(''); setFlyDocs([]) }}
                                className="text-xs px-2 py-1 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                              >
                                Volar
                              </button>
                              <button
                                onClick={() => setSendDoModal(h.id)}
                                className="text-xs px-2 py-1 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
                              >
                                Enviar DO
                              </button>
                            </>
                          )}
                          {/* Info for resolved holds */}
                          {h.status === 'fly' && h.fly_flight_number && (
                            <span className="text-xs text-gray-500">
                              Vuelo: {h.fly_flight_number}
                              {h.fly_mawb && <> · MAWB: {h.fly_mawb}</>}
                            </span>
                          )}
                          {h.status === 'send_do' && (
                            <span className="text-xs text-gray-500">Enviado a DO</span>
                          )}
                          {h.client_documents && h.client_documents.length > 0 && (
                            <div className="flex gap-1">
                              {h.client_documents.map((d, i) => (
                                <a key={i} href={d.url} target="_blank" rel="noopener noreferrer"
                                  className="text-xs text-indigo-600 hover:underline">
                                  Doc {i + 1}
                                </a>
                              ))}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-center">
                        <button
                          onClick={() => handleDeleteHold(h.id)}
                          className="text-xs text-red-400 hover:text-red-600"
                          title="Eliminar hold"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ── Floating email bar ────────────────────────────────────────────── */}
      {isMcl && selectedHolds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-30 bg-mcl-blue text-white rounded-xl shadow-xl px-6 py-3 flex items-center gap-4">
          <span className="text-sm font-semibold">{selectedHolds.size} hold(s) seleccionado(s)</span>
          <button
            onClick={handleSendHoldsEmail}
            disabled={sendingEmail}
            className="px-4 py-1.5 bg-white text-mcl-blue text-sm font-bold rounded-lg hover:bg-gray-100 disabled:opacity-50 transition-colors"
          >
            {sendingEmail ? 'Enviando...' : 'Enviar por Email'}
          </button>
          <button
            onClick={() => setSelectedHolds(new Set())}
            className="text-white/70 hover:text-white text-sm"
          >
            Cancelar
          </button>
        </div>
      )}

      {/* ── Photo upload modal ──────────────────────────────────────────────── */}
      {photoModal && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={() => !saving && setPhotoModal(null)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6 space-y-4">
              <h3 className="font-semibold text-gray-800">Subir foto del hold</h3>
              {/* Hidden inputs: one for camera, one for file picker */}
              <input
                ref={photoInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                capture="environment"
                onChange={() => {
                  const file = photoInputRef.current?.files?.[0]
                  if (file && photoModal) handleUploadPhoto(photoModal, file)
                }}
              />
              <input
                id="photo-file-input"
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file && photoModal) handleUploadPhoto(photoModal, file)
                }}
              />
              <div className="flex flex-col gap-3">
                <button
                  onClick={() => photoInputRef.current?.click()}
                  disabled={saving}
                  className="w-full flex items-center justify-center gap-2 text-sm px-4 py-3 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  {saving ? 'Subiendo...' : 'Tomar foto'}
                </button>
                <button
                  onClick={() => document.getElementById('photo-file-input')?.click()}
                  disabled={saving}
                  className="w-full flex items-center justify-center gap-2 text-sm px-4 py-3 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  Elegir de galería
                </button>
              </div>
              <button
                onClick={() => setPhotoModal(null)}
                disabled={saving}
                className="w-full text-sm px-4 py-2 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── CBP Released modal ──────────────────────────────────────────────── */}
      {cbpModal && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={() => !saving && setCbpModal(null)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6 space-y-4">
              <h3 className="font-semibold text-gray-800">Confirmar CBP Released</h3>
              <p className="text-sm text-gray-500">
                Confirmar que CBP inspeccionó y liberó este paquete. El hold pasará a estado "Pendiente Instrucción".
              </p>
              <textarea
                value={cbpNotes}
                onChange={e => setCbpNotes(e.target.value)}
                placeholder="Notas (opcional)"
                rows={2}
                className="w-full px-3 py-2 text-sm border rounded-lg"
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => { setCbpModal(null); setCbpNotes('') }}
                  disabled={saving}
                  className="text-sm px-4 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => cbpModal && handleCbpReleased(cbpModal)}
                  disabled={saving}
                  className="text-sm px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {saving ? 'Guardando...' : 'Confirmar'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── Fly modal ──────────────────────────────────────────────────────── */}
      {flyModal && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={() => !saving && setFlyModal(null)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 space-y-4">
              <h3 className="font-semibold text-gray-800">Instrucción: Volar</h3>

              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">Vuelo</label>
                  <select
                    value={flyFlightId}
                    onChange={e => {
                      setFlyFlightId(e.target.value)
                      const fl = flights.find(f => f.id === e.target.value)
                      if (fl) setFlyFlightNumber(fl.flight_number || '')
                    }}
                    className="w-full px-3 py-2 text-sm border rounded-lg"
                  >
                    <option value="">Seleccionar vuelo...</option>
                    {flights.map(f => (
                      <option key={f.id} value={f.id}>
                        {f.airline} {f.flight_number ? `#${f.flight_number}` : ''} — {(f.flight_datetime || '').slice(0, 10)}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">Vuelo (manual, si no está en la lista)</label>
                  <input
                    type="text"
                    value={flyFlightNumber}
                    onChange={e => setFlyFlightNumber(e.target.value)}
                    placeholder="AA 1234"
                    className="w-full px-3 py-2 text-sm border rounded-lg"
                  />
                </div>

                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">MAWB</label>
                  <input
                    type="text"
                    value={flyMawb}
                    onChange={e => setFlyMawb(e.target.value)}
                    placeholder="000-00000000"
                    className="w-full px-3 py-2 text-sm border rounded-lg font-mono"
                  />
                </div>

                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">AWB</label>
                  <input
                    type="text"
                    value={flyAwb}
                    onChange={e => setFlyAwb(e.target.value)}
                    placeholder="000-00000000"
                    className="w-full px-3 py-2 text-sm border rounded-lg font-mono"
                  />
                </div>

                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">Fecha-Hora del vuelo</label>
                  <input
                    type="datetime-local"
                    value={flyDatetime}
                    onChange={e => setFlyDatetime(e.target.value)}
                    className="w-full px-3 py-2 text-sm border rounded-lg"
                  />
                </div>

                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">Documentos</label>
                  <input
                    ref={flyDocsRef}
                    type="file"
                    multiple
                    accept=".pdf,.jpg,.jpeg,.png,.webp"
                    className="w-full text-sm"
                    onChange={e => setFlyDocs(Array.from(e.target.files || []))}
                  />
                  {flyDocs.length > 0 && (
                    <div className="text-xs text-gray-500 mt-1">{flyDocs.length} archivo(s) seleccionado(s)</div>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => { setFlyModal(null); setFlyDocs([]) }}
                  disabled={saving}
                  className="text-sm px-4 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => flyModal && handleFly(flyModal)}
                  disabled={saving || (!flyFlightId && !flyFlightNumber)}
                  className="text-sm px-4 py-2 rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                >
                  {saving ? 'Guardando...' : 'Confirmar Volar'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── Import preview modal ────────────────────────────────────────────── */}
      {importModal && importPreview && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={() => !importing && (setImportModal(false), setImportPreview(null))} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl shadow-xl max-w-lg w-full p-6 space-y-4 max-h-[80vh] overflow-y-auto">
              <h3 className="font-semibold text-gray-800">Preview de importación</h3>

              {/* Summary */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-center">
                  <div className="text-xl font-bold text-green-700">{importPreview.toCreate.length}</div>
                  <div className="text-xs text-green-600">A crear</div>
                </div>
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-center">
                  <div className="text-xl font-bold text-gray-500">{importPreview.duplicates.length}</div>
                  <div className="text-xs text-gray-500">Duplicados (omitidos)</div>
                </div>
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-center">
                  <div className="text-xl font-bold text-amber-600">{importPreview.noMatch.length}</div>
                  <div className="text-xs text-amber-600">Sin booking</div>
                </div>
              </div>

              {/* Items to create */}
              {importPreview.toCreate.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-gray-600 mb-2">Holds a crear:</h4>
                  <div className="max-h-48 overflow-y-auto border rounded-lg">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-gray-50 text-gray-500">
                          <th className="px-2 py-1 text-left">AWB</th>
                          <th className="px-2 py-1 text-left">Bag</th>
                          <th className="px-2 py-1 text-left">Box</th>
                          <th className="px-2 py-1 text-left">Vuelo</th>
                          <th className="px-2 py-1 text-left">Cliente</th>
                        </tr>
                      </thead>
                      <tbody>
                        {importPreview.toCreate.map((item, i) => (
                          <tr key={i} className={`border-t ${!item.booking_id ? 'bg-amber-50' : ''}`}>
                            <td className="px-2 py-1 font-mono">{item.awb}</td>
                            <td className="px-2 py-1">{item.bag}</td>
                            <td className="px-2 py-1">{item.box}</td>
                            <td className="px-2 py-1">{item.flight_number || '—'}</td>
                            <td className="px-2 py-1">{item.client_name || <span className="text-amber-500">Sin match</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Duplicates */}
              {importPreview.duplicates.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-gray-400 mb-1">Duplicados omitidos:</h4>
                  <div className="text-xs text-gray-400 space-y-0.5">
                    {importPreview.duplicates.slice(0, 5).map((d, i) => (
                      <div key={i}>{d.awb} · {d.bag} · {d.box}</div>
                    ))}
                    {importPreview.duplicates.length > 5 && (
                      <div>...y {importPreview.duplicates.length - 5} más</div>
                    )}
                  </div>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  onClick={() => { setImportModal(false); setImportPreview(null) }}
                  disabled={importing}
                  className="text-sm px-4 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
                >
                  Cancelar
                </button>
                <button
                  onClick={confirmImport}
                  disabled={importing || importPreview.toCreate.length === 0}
                  className="text-sm px-4 py-2 rounded-lg bg-mcl-blue text-white hover:bg-blue-900 disabled:opacity-50"
                >
                  {importing ? 'Importando...' : `Crear ${importPreview.toCreate.length} holds`}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── Send DO confirmation modal ──────────────────────────────────────── */}
      {sendDoModal && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={() => !saving && setSendDoModal(null)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6 space-y-4">
              <h3 className="font-semibold text-gray-800">Confirmar: Enviar a DO</h3>
              <p className="text-sm text-gray-500">
                ¿Confirmar que este paquete debe ser enviado al DO?
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => setSendDoModal(null)}
                  disabled={saving}
                  className="text-sm px-4 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => sendDoModal && handleSendDo(sendDoModal)}
                  disabled={saving}
                  className="text-sm px-4 py-2 rounded-lg bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50"
                >
                  {saving ? 'Guardando...' : 'Confirmar'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </Layout>
  )
}
