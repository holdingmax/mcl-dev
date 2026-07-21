import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  doc, getDoc, updateDoc, collection, getDocs, query, where, orderBy,
  arrayUnion,
} from 'firebase/firestore'
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage'
import { db, storage } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import {
  AirfreightBooking, AirfreightFlight, AwbSecondLeg, AirfreightDocumentFile,
  ChangeLogEntry,
} from '../../types'
import Layout from '../../components/Layout'
import { fmtNum, storagePath } from '../../lib/utils'

type DocKey = 'doc_1f' | 'doc_7512' | 'doc_do_tsa' | 'doc_mawb_draft' | 'doc_mawb_def' | 'doc_pickup_order'

const DOC_LABELS: Record<DocKey, string> = {
  doc_1f: '1F',
  doc_7512: '7512',
  doc_do_tsa: 'DO/TSA Letter',
  doc_mawb_draft: 'MAWB Draft',
  doc_mawb_def: 'Final MAWB',
  doc_pickup_order: 'Pick Up Order',
}

const SIMPLE_DOCS: DocKey[] = ['doc_1f', 'doc_7512', 'doc_do_tsa', 'doc_pickup_order']
const MAWB_BOOKING_DOCS: DocKey[] = ['doc_do_tsa', 'doc_mawb_draft', 'doc_mawb_def']
const MAWB_LINE_DOCS: DocKey[] = ['doc_1f', 'doc_7512', 'doc_pickup_order']

const STATUS_OPTIONS = [
  { value: 'submitted', label: 'Submitted' },
  { value: 'onhand', label: 'On Hand' },
  { value: 'dropped', label: 'Dropped Off' },
  { value: 'completed', label: 'Completed' },
]

const STATUS_COLOR: Record<string, string> = {
  submitted: 'bg-yellow-100 text-yellow-700',
  onhand: 'bg-blue-100 text-blue-700',
  dropped: 'bg-purple-100 text-purple-700',
  completed: 'bg-green-100 text-green-700',
}

export default function AirfreightBookingDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user, isAdmin, isSuperAgent, isAgent, isAccounting, isCounter, isBodega, isClient, clientId } = useAuth()

  const [booking, setBooking] = useState<(AirfreightBooking & { id: string }) | null>(null)
  const [flight, setFlight] = useState<(AirfreightFlight & { id: string }) | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'info' | 'docs' | 'log'>('info')

  const [uploadingDoc, setUploadingDoc] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [pendingUpload, setPendingUpload] = useState<{ key: DocKey; lineIdx?: number } | null>(null)

  const [editingStatus, setEditingStatus] = useState(false)
  const [newStatus, setNewStatus] = useState('')
  const [dismissingChanges, setDismissingChanges] = useState(false)

  const canManage = isAdmin || isSuperAgent || isAgent
  const canUploadDocs = isAdmin || isSuperAgent || isAgent || isCounter || isBodega || isClient
  const isMine = isClient && booking?.client_id === clientId

  useEffect(() => {
    if (!id) return
    getDoc(doc(db, 'airfreight_bookings', id)).then(async snap => {
      if (!snap.exists()) { navigate('/airfreight'); return }
      const b = { ...snap.data() as AirfreightBooking, id: snap.id }

      // Client guard
      if (isClient && b.client_id !== clientId) { navigate('/airfreight'); return }

      setBooking(b)
      setNewStatus(b.status)

      // Load flight
      if (b.flight_id) {
        const fSnap = await getDoc(doc(db, 'airfreight_flights', b.flight_id))
        if (fSnap.exists()) setFlight({ ...fSnap.data() as AirfreightFlight, id: fSnap.id })
      }
      setLoading(false)
    })
  }, [id])

  // Dismiss change notifications
  async function handleDismissChanges() {
    if (!id || !booking) return
    setDismissingChanges(true)
    await updateDoc(doc(db, 'airfreight_bookings', id), { modified_seen: true })
    setBooking(prev => prev ? { ...prev, modified_seen: true } : prev)
    setDismissingChanges(false)
  }

  // Status change
  async function handleStatusChange() {
    if (!id || !booking || newStatus === booking.status) { setEditingStatus(false); return }
    const entry: ChangeLogEntry = {
      changed_at: new Date().toISOString(),
      changed_by: user?.email || user?.uid || '',
      change_type: 'booking_update',
      fields_changed: [{ field: 'status', label: 'Estado', old_value: booking.status, new_value: newStatus }],
    }
    await updateDoc(doc(db, 'airfreight_bookings', id), {
      status: newStatus,
      change_count: (booking.change_count || 0) + 1,
      modified_seen: false,
      change_log: arrayUnion(entry),
    })
    setBooking(prev => prev ? { ...prev, status: newStatus as AirfreightBooking['status'], change_count: (prev.change_count || 0) + 1, modified_seen: false } : prev)
    setEditingStatus(false)
  }


  // Document upload
  function triggerUpload(key: DocKey, lineIdx?: number) {
    setPendingUpload({ key, lineIdx })
    fileInputRef.current?.click()
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !pendingUpload || !id || !booking || !user) return

    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      alert(`Solo se permiten archivos PDF para documentos de booking.\n\nArchivo rechazado: ${file.name}\n\nPor favor suba un archivo PDF válido.`)
      e.target.value = ''
      return
    }

    const { key, lineIdx } = pendingUpload
    setUploadingDoc(lineIdx !== undefined ? `${key}-${lineIdx}` : key)

    try {
      const path = storagePath({ flightNumber: flight?.flight_number, flightDate: flight?.flight_datetime, airline: flight?.airline, clientName: booking.client_name, mawbNumber: booking.mawb_number, awbNumber: lineIdx !== undefined ? booking.awb_lines?.[lineIdx]?.awb_number : undefined, filename: `${key}_${Date.now()}.pdf` })

      const sRef = storageRef(storage, path)
      await uploadBytes(sRef, file)
      const url = await getDownloadURL(sRef)

      const getExisting = (): AirfreightDocumentFile | undefined => {
        if (lineIdx !== undefined) {
          return (booking as any).awb_lines?.[lineIdx]?.documents?.[key]
        }
        return (booking.documents as any)?.[key]
      }

      const existing = getExisting()
      const docFile: AirfreightDocumentFile = {
        url,
        filename: file.name,
        version: (existing?.version || 0) + 1,
        uploaded_at: new Date().toISOString(),
        uploaded_by: user.email || user.uid,
        modified_seen: false,
        history: existing
          ? [...(existing.history || []), {
              url: existing.url,
              filename: existing.filename,
              version: existing.version,
              uploaded_at: existing.uploaded_at,
              uploaded_by: existing.uploaded_by,
            }]
          : [],
      }

      let updateData: Record<string, unknown>

      if (lineIdx !== undefined) {
        // Update AWB line document
        const lines = [...((booking as any).awb_lines || [])]
        lines[lineIdx] = {
          ...lines[lineIdx],
          documents: { ...(lines[lineIdx].documents || {}), [key]: docFile },
        }
        updateData = { awb_lines: lines, modified_seen: false }
        // Add change log entry
        const entry: ChangeLogEntry = {
          changed_at: new Date().toISOString(),
          changed_by: user.email || user.uid,
          change_type: 'booking_update',
          fields_changed: [{
            field: key,
            label: DOC_LABELS[key],
            old_value: existing ? `v${existing.version}` : '',
            new_value: `v${docFile.version} (${file.name})`,
          }],
        }
        updateData.change_count = (booking.change_count || 0) + 1
        updateData.change_log = arrayUnion(entry)
        await updateDoc(doc(db, 'airfreight_bookings', id), updateData)
        setBooking(prev => prev ? {
          ...prev,
          awb_lines: lines,
          modified_seen: false,
          change_count: (prev.change_count || 0) + 1,
        } as any : prev)
      } else {
        const entry: ChangeLogEntry = {
          changed_at: new Date().toISOString(),
          changed_by: user.email || user.uid,
          change_type: 'booking_update',
          fields_changed: [{
            field: key,
            label: DOC_LABELS[key],
            old_value: existing ? `v${existing.version}` : '',
            new_value: `v${docFile.version} (${file.name})`,
          }],
        }
        updateData = {
          [`documents.${key}`]: docFile,
          modified_seen: false,
          change_count: (booking.change_count || 0) + 1,
          change_log: arrayUnion(entry),
        }
        await updateDoc(doc(db, 'airfreight_bookings', id), updateData)
        setBooking(prev => prev ? {
          ...prev,
          documents: { ...(prev.documents || {}), [key]: docFile },
          modified_seen: false,
          change_count: (prev.change_count || 0) + 1,
        } : prev)
      }
    } finally {
      setUploadingDoc(null)
      setPendingUpload(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function handleDeleteDoc(key: DocKey, lineIdx?: number) {
    if (!confirm('Delete this document? This action cannot be undone.')) return
    if (!id || !booking || !user) return

    const getExisting = (): AirfreightDocumentFile | undefined => {
      if (lineIdx !== undefined) {
        return (booking as any).awb_lines?.[lineIdx]?.documents?.[key]
      }
      return (booking.documents as any)?.[key]
    }
    const existing = getExisting()
    if (!existing) return

    // Delete from Storage (current + history)
    try { await deleteObject(storageRef(storage, existing.url)) } catch {}
    for (const h of existing.history || []) {
      try { await deleteObject(storageRef(storage, h.url)) } catch {}
    }

    // Update Firestore
    const entry: ChangeLogEntry = {
      changed_at: new Date().toISOString(),
      changed_by: user.email || user.uid,
      change_type: 'booking_update',
      fields_changed: [{
        field: key,
        label: DOC_LABELS[key],
        old_value: `v${existing.version} (${existing.filename})`,
        new_value: 'Deleted',
      }],
    }

    if (lineIdx !== undefined) {
      const lines = [...((booking as any).awb_lines || [])]
      const docs = { ...(lines[lineIdx].documents || {}) }
      delete docs[key]
      lines[lineIdx] = { ...lines[lineIdx], documents: docs }
      await updateDoc(doc(db, 'airfreight_bookings', id), {
        awb_lines: lines,
        modified_seen: false,
        change_count: (booking.change_count || 0) + 1,
        change_log: arrayUnion(entry),
      })
      setBooking(prev => prev ? { ...prev, awb_lines: lines, modified_seen: false, change_count: (prev.change_count || 0) + 1 } as any : prev)
    } else {
      await updateDoc(doc(db, 'airfreight_bookings', id), {
        [`documents.${key}`]: null,
        modified_seen: false,
        change_count: (booking.change_count || 0) + 1,
        change_log: arrayUnion(entry),
      })
      const newDocs = { ...(booking.documents || {}) }
      delete (newDocs as any)[key]
      setBooking(prev => prev ? { ...prev, documents: newDocs, modified_seen: false, change_count: (prev.change_count || 0) + 1 } : prev)
    }
  }

  if (loading || !booking) {
    return (
      <Layout title="Booking" backTo="/airfreight">
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" />
        </div>
      </Layout>
    )
  }

  const isMawb = booking.booking_type === 'mawb' || booking.booking_type === 'ecommerce'
  const awbLines: AwbSecondLeg[] = booking.awb_lines || []
  const editHref = flight ? `/airfreight/bookings/new?flight=${flight.id}` : null

  return (
    <Layout title={`Booking · ${booking.client_name}`} backTo={flight ? `/airfreight/flights/${flight.id}` : '/airfreight'}>
      <div className="max-w-3xl mx-auto space-y-5">

        {/* Change notification banner */}
        {!booking.modified_seen && canManage && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-5 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2 text-amber-700 text-sm">
              <span className="font-semibold">⚠️ There are unreviewed changes</span>
              <span className="text-amber-600">({booking.change_count} Changes)</span>
            </div>
            <button
              onClick={handleDismissChanges}
              disabled={dismissingChanges}
              className="text-xs text-amber-700 hover:underline font-medium"
            >
              Dismiss all
            </button>
          </div>
        )}

        {/* Header card */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <div className="flex items-start justify-between flex-wrap gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <h2 className="text-lg font-bold text-gray-800">{booking.client_name}</h2>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLOR[booking.status]}`}>
                  {STATUS_OPTIONS.find(s => s.value === booking.status)?.label}
                </span>
                {isMawb && <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full font-medium">MAWB</span>}
              </div>
              <p className="text-sm text-gray-500">
                {isMawb ? (booking.mawb_number ? `MAWB: ${booking.mawb_number}` : 'Direct') : `AWB: ${booking.awb_1st_leg || '—'}`}
                {!isMawb && booking.awb_2nd_leg && ` / ${booking.awb_2nd_leg}`}
              </p>
              {flight && (
                <p className="text-xs text-gray-400 mt-0.5">
                  ✈️ {flight.airline}{flight.flight_number ? ` #${flight.flight_number}` : ''} · {(() => { const [dp] = (flight.flight_datetime || '').split('T'); const [y, m, d] = (dp || '').split('-'); return `${m}/${d}/${y?.slice(2)}` })()}
                </p>
              )}
              <p className="text-xs text-gray-400">{booking.destination_custom || booking.destination_id} · {fmtNum(booking.pieces)} pcs</p>
            </div>

            <div className="flex flex-col gap-2 items-end">
              {/* Edit bookings link */}
              {(canManage || isMine) && editHref && (
                <button
                  onClick={() => navigate(editHref)}
                  className="text-xs bg-mcl-blue text-white px-3 py-1.5 rounded-lg hover:bg-blue-900 transition-colors font-medium"
                >
                  Edit flight bookings
                </button>
              )}
              {/* Status change */}
              {canManage && (
                editingStatus ? (
                  <div className="flex items-center gap-2">
                    <select
                      value={newStatus}
                      onChange={e => setNewStatus(e.target.value)}
                      className="border border-gray-200 rounded px-2 py-1 text-sm"
                    >
                      {STATUS_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                    <button onClick={handleStatusChange} className="text-xs text-green-600 font-medium hover:underline">OK</button>
                    <button onClick={() => setEditingStatus(false)} className="text-xs text-gray-400 hover:underline">×</button>
                  </div>
                ) : (
                  <button onClick={() => setEditingStatus(true)} className="text-xs text-mcl-blue hover:underline">
                    Change status
                  </button>
                )
              )}
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 bg-gray-100 p-1 rounded-xl">
          {(['info', 'docs', 'log'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${
                tab === t ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t === 'info' ? 'Information' : t === 'docs' ? 'Documents' : 'History'}
            </button>
          ))}
        </div>

        {/* INFO TAB */}
        {tab === 'info' && (
          <div className="space-y-4">
            {/* Simple booking details */}
            {!isMawb && (
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
                <h3 className="text-sm font-semibold text-gray-700 mb-3">AWB Details</h3>
                <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                  <InfoRow label="AWB 1st Leg" value={booking.awb_1st_leg} mono />
                  <InfoRow label="AWB 2nd Leg" value={booking.awb_2nd_leg} mono />
                  <InfoRow label="ULD Type" value={booking.uld_type} />
                  <InfoRow label="Pieces" value={fmtNum(booking.pieces)} />
                  <InfoRow label="Weight (kg)" value={fmtNum(booking.weight)} />
                  <InfoRow label="CHW (kg)" value={fmtNum(booking.chargeable_weight)} />
                  {booking.slacs != null && <InfoRow label="SLACs" value={booking.slacs.toString()} />}
                  {!isClient && <InfoRow label="P.UP FROM" value={booking.pickup_from} />}
                  {!isClient && <InfoRow label="P.UP DATE" value={booking.ready_for_pickup} />}
                  {!isClient && <InfoRow label="LD. FREE" value={booking.last_day_free} />}
                  <InfoRow label="Deliver To" value={booking.deliver_to} />
                  <InfoRow label="Hold BG" value={booking.hold_bg} />
                  <InfoRow label="Hold Box" value={booking.hold_box} />
                  {booking.battery && <InfoRow label="Lithium Battery" value="Sí" />}
                  {booking.ddgg && <InfoRow label="Dangerous Goods" value="Sí" />}
                </dl>
              </div>
            )}

            {/* MAWB AWB lines */}
            {isMawb && (
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-gray-700">
                    AWBs under {booking.mawb_number ? `MAWB ${booking.mawb_number}` : 'Direct'} ({awbLines.length})
                  </h3>
                  <div className="text-xs text-gray-400 tabular-nums">
                    {fmtNum(awbLines.reduce((s, l) => s + (l.pieces || 0), 0))} pcs ·{' '}
                    {fmtNum(awbLines.reduce((s, l) => s + (l.weight || 0), 0))} kg ·{' '}
                    CHW {fmtNum(awbLines.reduce((s, l) => s + (l.chargeable_weight || 0), 0))} kg
                  </div>
                </div>
                {awbLines.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-gray-500 font-bold uppercase border-b border-gray-100">
                          <th className="pb-2 text-left pr-3">#</th>
                          <th className="pb-2 text-left pr-3">1ST LEG</th>
                          <th className="pb-2 text-left pr-3">2ND LEG</th>
                          <th className="pb-2 text-left pr-3">ULD</th>
                          <th className="pb-2 text-left pr-3">ULD AIR</th>
                          <th className="pb-2 text-center pr-3">PCS</th>
                          <th className="pb-2 text-center pr-3">SLACS</th>
                          <th className="pb-2 text-center pr-3">PESO</th>
                          <th className="pb-2 text-center pr-3">CHW</th>
                          {!isClient && <th className="pb-2 text-left pr-3">P.UP FROM</th>}
                          {!isClient && <th className="pb-2 text-center pr-3">P.UP DATE</th>}
                          {!isClient && <th className="pb-2 text-center pr-3">LD. FREE</th>}
                          <th className="pb-2 text-center pr-3">L/B</th>
                          <th className="pb-2 text-center pr-3">🔋/⚠️</th>
                          <th className="pb-2 text-center">LABEL</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {awbLines.map((line, idx) => (
                          <tr key={idx} className="hover:bg-gray-50/50">
                            <td className="py-2 pr-3 text-gray-400">{idx + 1}</td>
                            <td className="py-2 pr-3 font-mono text-gray-700">{line.awb_number || '—'}</td>
                            <td className="py-2 pr-3 font-mono text-gray-500">{line.awb_2nd_leg || '—'}</td>
                            <td className="py-2 pr-3 text-gray-600">{line.uld_type || '—'}</td>
                            <td className="py-2 pr-3 text-gray-500">{line.uld_airline || '—'}</td>
                            <td className="py-2 pr-3 text-center tabular-nums text-gray-700">{fmtNum(line.pieces)}</td>
                            <td className="py-2 pr-3 text-center tabular-nums text-gray-600">{line.slacs ?? '—'}</td>
                            <td className="py-2 pr-3 text-center tabular-nums text-gray-700">{fmtNum(line.weight)}</td>
                            <td className="py-2 pr-3 text-center tabular-nums text-gray-700">{fmtNum(line.chargeable_weight)}</td>
                            {!isClient && <td className="py-2 pr-3 text-gray-500">{line.pickup_from || '—'}</td>}
                            {!isClient && <td className="py-2 pr-3 text-center text-gray-500">{line.ready_for_pickup || '—'}</td>}
                            {!isClient && <td className="py-2 pr-3 text-center text-gray-500">{line.last_day_free || '—'}</td>}
                            <td className="py-2 pr-3 text-center">
                              <span className={`text-xs font-semibold ${line.loc_bond === 'B' ? 'text-orange-600' : line.loc_bond === 'L' ? 'text-blue-600' : 'text-gray-300'}`}>
                                {line.loc_bond || '—'}
                              </span>
                            </td>
                            <td className="py-2 pr-3 text-center">
                              {line.battery && <span title="Lithium Battery">🔋</span>}
                              {line.ddgg && <span title="Dangerous Goods">⚠️</span>}
                              {!line.battery && !line.ddgg && <span className="text-gray-300">—</span>}
                            </td>
                            <td className="py-2 text-center">
                              {line.label_color ? <span className="text-green-600 text-xs font-semibold">Y</span> : <span className="text-gray-300">—</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-sm text-gray-400">No AWBs registered</p>
                )}
              </div>
            )}

          </div>
        )}

        {/* DOCS TAB */}
        {tab === 'docs' && (
          <div className="space-y-4">
            <input ref={fileInputRef} type="file" accept=".pdf" className="hidden" onChange={handleFileChange} />

            {/* Simple booking docs */}
            {!isMawb && (
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
                <h3 className="text-sm font-semibold text-gray-700 mb-4">Booking Documents</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {SIMPLE_DOCS.map(key => (
                    <DocSlot
                      key={key}
                      label={DOC_LABELS[key]}
                      docFile={(booking.documents as any)?.[key]}
                      uploading={uploadingDoc === key}
                      canUpload={canUploadDocs}
                      onUpload={() => triggerUpload(key)}
                      onDelete={canUploadDocs ? () => handleDeleteDoc(key) : undefined}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* MAWB docs — booking level */}
            {isMawb && (
              <>
                <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
                  <h3 className="text-sm font-semibold text-gray-700 mb-4">MAWB Documents</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {MAWB_BOOKING_DOCS.map(key => (
                      <DocSlot
                        key={key}
                        label={DOC_LABELS[key]}
                        docFile={(booking.documents as any)?.[key]}
                        uploading={uploadingDoc === key}
                        canUpload={canUploadDocs}
                        onUpload={() => triggerUpload(key)}
                        onDelete={canUploadDocs ? () => handleDeleteDoc(key) : undefined}
                      />
                    ))}
                  </div>
                </div>

                {/* Per-AWB line docs */}
                {awbLines.map((line, idx) => (
                  <div key={idx} className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
                    <h3 className="text-sm font-semibold text-gray-700 mb-1">AWB #{idx + 1}</h3>
                    <p className="text-xs text-gray-400 font-mono mb-4">{line.awb_number || 'No number'}</p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      {MAWB_LINE_DOCS.map(key => (
                        <DocSlot
                          key={key}
                          label={DOC_LABELS[key]}
                          docFile={(line as any).documents?.[key]}
                          uploading={uploadingDoc === `${key}-${idx}`}
                          canUpload={canUploadDocs}
                          onUpload={() => triggerUpload(key, idx)}
                          onDelete={canUploadDocs ? () => handleDeleteDoc(key, idx) : undefined}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {/* HISTORY TAB */}
        {tab === 'log' && (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">Change history ({booking.change_count})</h3>
            {(!booking.change_log || booking.change_log.length === 0) ? (
              <p className="text-sm text-gray-400">No changes recorded</p>
            ) : (
              <div className="space-y-4">
                {[...booking.change_log].reverse().map((entry, idx) => (
                  <div key={idx} className="border-l-2 border-gray-200 pl-4">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-gray-600">{entry.changed_by}</span>
                      <span className="text-xs text-gray-400">{new Date(entry.changed_at).toLocaleString('en')}</span>
                      {entry.change_type === 'flight_reassignment' && (
                        <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">Reassignment</span>
                      )}
                    </div>
                    <div className="space-y-1">
                      {entry.fields_changed.map((f, fi) => (
                        <div key={fi} className="text-xs text-gray-600">
                          <span className="font-medium">{f.label}:</span>{' '}
                          {f.old_value && <span className="line-through text-gray-400">{f.old_value}</span>}
                          {f.old_value && ' → '}
                          <span className="text-gray-800">{f.new_value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Layout>
  )
}

function InfoRow({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  if (!value) return null
  return (
    <div>
      <dt className="text-xs text-gray-400">{label}</dt>
      <dd className={`text-gray-700 font-medium ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  )
}

function DocSlot({
  label, docFile, uploading, canUpload, onUpload, onDelete,
}: {
  label: string
  docFile?: AirfreightDocumentFile
  uploading: boolean
  canUpload: boolean
  onUpload: () => void
  onDelete?: () => void
}) {
  return (
    <div className={`border rounded-lg p-3 ${docFile ? 'border-green-200 bg-green-50' : 'border-gray-100 bg-gray-50'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-gray-600 mb-1">{label}</p>
          {docFile ? (
            <div>
              <a
                href={docFile.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-600 hover:underline truncate block"
              >
                📄 {docFile.filename}
              </a>
              <p className="text-xs text-gray-400 mt-0.5">
                v{docFile.version} · {new Date(docFile.uploaded_at).toLocaleDateString('en', { day: '2-digit', month: '2-digit', year: '2-digit' })} · {docFile.uploaded_by}
              </p>
              {docFile.history?.length > 0 && (
                <details className="mt-1">
                  <summary className="text-xs text-gray-400 cursor-pointer">View history ({docFile.history.length})</summary>
                  <div className="mt-1 space-y-1">
                    {[...docFile.history].reverse().map((h, i) => (
                      <a key={i} href={h.url} target="_blank" rel="noopener noreferrer" className="text-xs text-gray-400 hover:text-blue-600 block">
                        v{h.version} · {h.filename}
                      </a>
                    ))}
                  </div>
                </details>
              )}
            </div>
          ) : (
            <p className="text-xs text-gray-400">No document</p>
          )}
        </div>
        {canUpload && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={onUpload}
              disabled={uploading}
              className="text-xs bg-white border border-gray-200 text-gray-600 px-2 py-1 rounded hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              {uploading ? '...' : docFile ? '↑' : '+ PDF'}
            </button>
            {docFile && onDelete && (
              <button
                onClick={onDelete}
                className="text-xs text-red-400 hover:text-red-600 px-1 py-1"
                title="Delete document"
              >
                ✕
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
