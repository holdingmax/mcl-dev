import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  doc, getDoc, updateDoc, collection, query, where, onSnapshot, orderBy, serverTimestamp,
} from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import { AirfreightFlight, AirfreightBooking, AirfreightDocumentFile } from '../../types'
import Layout from '../../components/Layout'
import { storagePathFlight } from '../../lib/utils'

const STATUS_LABEL: Record<string, string> = {
  submitted: 'Enviado',
  onhand: 'On Hand',
  dropped: 'Dropped Off',
  completed: 'Completado',
}

const STATUS_COLOR: Record<string, string> = {
  submitted: 'bg-yellow-100 text-yellow-700',
  onhand: 'bg-blue-100 text-blue-700',
  dropped: 'bg-purple-100 text-purple-700',
  completed: 'bg-green-100 text-green-700',
}

export default function AirfreightFlightDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user, isAdmin, isSuperAgent, isAgent, isCounter, isBodega, isClient, clientId } = useAuth()

  const [flight, setFlight] = useState<(AirfreightFlight & { id: string }) | null>(null)
  const [bookings, setBookings] = useState<(AirfreightBooking & { id: string })[]>([])
  const [loading, setLoading] = useState(true)
  const [uploadingDist, setUploadingDist] = useState(false)
  const [editingFlight, setEditingFlight] = useState(false)
  const [flightNumber, setFlightNumber] = useState('')
  const [editingEtd, setEditingEtd] = useState(false)
  const [etdDate, setEtdDate] = useState('')
  const [etdTime, setEtdTime] = useState('')
  const [editingCutoff, setEditingCutoff] = useState(false)
  const [cutoffDate, setCutoffDate] = useState('')
  const [cutoffTime, setCutoffTime] = useState('')
  const distInputRef = useRef<HTMLInputElement>(null)

  const canEdit = isAdmin || isSuperAgent || isAgent || isCounter
  const canUploadDist = isAdmin || isSuperAgent || isBodega || isAgent || isCounter

  useEffect(() => {
    if (!id) return
    getDoc(doc(db, 'airfreight_flights', id)).then(snap => {
      if (snap.exists()) {
        const f = { ...snap.data() as AirfreightFlight, id: snap.id }
        setFlight(f)
        setFlightNumber(f.flight_number || '')
      }
    })

    const constraints = [
      where('flight_id', '==', id),
      ...(isClient && clientId ? [where('client_id', '==', clientId)] : []),
      orderBy('created_at', 'desc'),
    ]
    const q = query(collection(db, 'airfreight_bookings'), ...constraints)
    const unsub = onSnapshot(q, snap => {
      setBookings(snap.docs.map(d => ({ ...d.data() as AirfreightBooking, id: d.id })))
      setLoading(false)
    }, err => { console.error('bookings error', err); setLoading(false) })
    return unsub
  }, [id, isClient, clientId])

  async function handleUploadDistribucion(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !id || !user) return
    setUploadingDist(true)
    try {
      const storageRef = ref(storage, storagePathFlight({ flightNumber: flight?.flight_number, flightDate: flight?.flight_datetime, airline: flight?.airline, filename: `distribucion_${Date.now()}.pdf` }))
      await uploadBytes(storageRef, file)
      const url = await getDownloadURL(storageRef)
      const docFile: AirfreightDocumentFile = {
        url,
        filename: file.name,
        version: (flight?.doc_distribucion?.version || 0) + 1,
        uploaded_at: new Date().toISOString(),
        uploaded_by: user.email || user.uid,
        modified_seen: false,
        history: flight?.doc_distribucion
          ? [...(flight.doc_distribucion.history || []), {
              url: flight.doc_distribucion.url,
              filename: flight.doc_distribucion.filename,
              version: flight.doc_distribucion.version,
              uploaded_at: flight.doc_distribucion.uploaded_at,
              uploaded_by: flight.doc_distribucion.uploaded_by,
            }]
          : [],
      }
      await updateDoc(doc(db, 'airfreight_flights', id), { doc_distribucion: docFile })
      setFlight(prev => prev ? { ...prev, doc_distribucion: docFile } : prev)
    } finally {
      setUploadingDist(false)
      if (distInputRef.current) distInputRef.current.value = ''
    }
  }

  async function handleToggleStatus() {
    if (!id || !flight) return
    const newStatus = flight.status === 'open' ? 'closed' : 'open'
    await updateDoc(doc(db, 'airfreight_flights', id), { status: newStatus })
    setFlight(prev => prev ? { ...prev, status: newStatus } : prev)
  }

  async function handleSaveFlightNumber() {
    if (!id) return
    await updateDoc(doc(db, 'airfreight_flights', id), { flight_number: flightNumber.trim() })
    setFlight(prev => prev ? { ...prev, flight_number: flightNumber.trim() } : prev)
    setEditingFlight(false)
  }

  function initEtdFields(f: AirfreightFlight) {
    const dt = f.flight_datetime || ''
    if (dt.includes('T')) {
      setEtdDate(dt.slice(0, 10))
      setEtdTime(dt.slice(11, 16))
    } else {
      setEtdDate(dt.slice(0, 10))
      setEtdTime('')
    }
  }

  function initCutoffFields(f: AirfreightFlight) {
    const ct = f.cutoff_datetime || ''
    if (ct.includes('T')) {
      setCutoffDate(ct.slice(0, 10))
      setCutoffTime(ct.slice(11, 16))
    } else {
      setCutoffDate(ct.slice(0, 10))
      setCutoffTime('')
    }
  }

  async function handleSaveEtd() {
    if (!id || !etdDate) return
    const newVal = etdTime ? `${etdDate}T${etdTime}:00` : etdDate
    await updateDoc(doc(db, 'airfreight_flights', id), { flight_datetime: newVal })
    setFlight(prev => prev ? { ...prev, flight_datetime: newVal } : prev)
    setEditingEtd(false)
  }

  async function handleSaveCutoff() {
    if (!id) return
    const newVal = cutoffDate ? (cutoffTime ? `${cutoffDate}T${cutoffTime}:00` : cutoffDate) : null
    await updateDoc(doc(db, 'airfreight_flights', id), { cutoff_datetime: newVal })
    setFlight(prev => prev ? { ...prev, cutoff_datetime: newVal || undefined } : prev)
    setEditingCutoff(false)
  }

  if (loading || !flight) {
    return (
      <Layout title="Vuelo" backTo="/airfreight">
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" />
        </div>
      </Layout>
    )
  }

  return (
    <Layout title={`Vuelo · ${flight.airline}`} backTo="/airfreight">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Flight info card */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-3 mb-1">
                <span className="text-2xl">✈️</span>
                <h2 className="text-xl font-bold text-gray-800">{flight.airline}</h2>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  flight.status === 'open' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                }`}>
                  {flight.status === 'open' ? 'Abierto' : 'Cerrado'}
                </span>
              </div>
              {/* ETD */}
              <div className="mt-1 flex items-center gap-2">
                <span className="text-sm text-gray-500">ETD:</span>
                {editingEtd ? (
                  <div className="flex items-center gap-2">
                    <input type="date" value={etdDate} onChange={e => setEtdDate(e.target.value)}
                      className="border border-gray-200 rounded px-2 py-0.5 text-sm" />
                    <input type="time" value={etdTime} onChange={e => setEtdTime(e.target.value)}
                      className="border border-gray-200 rounded px-2 py-0.5 text-sm w-24" placeholder="HH:MM" />
                    <button onClick={handleSaveEtd} className="text-xs text-green-600 font-medium hover:underline">Guardar</button>
                    <button onClick={() => setEditingEtd(false)} className="text-xs text-gray-400 hover:underline">Cancelar</button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-700">
                      {(() => {
                        const [dp, tp] = (flight.flight_datetime || '').split('T')
                        const [y, m, d] = (dp || '').split('-')
                        return `${m}/${d}/${y?.slice(2)}${tp ? ` a las ${tp.slice(0, 5)}` : ''}`
                      })()}
                    </span>
                    {canEdit && (
                      <button onClick={() => { initEtdFields(flight); setEditingEtd(true) }} className="text-xs text-mcl-blue hover:underline">Editar</button>
                    )}
                  </div>
                )}
              </div>
              <p className="text-sm text-gray-500 mt-0.5">Destinos: {flight.destinations?.join(', ')}</p>

              {/* Flight number */}
              <div className="mt-2 flex items-center gap-2">
                <span className="text-sm text-gray-500">Nro. vuelo:</span>
                {editingFlight ? (
                  <div className="flex items-center gap-2">
                    <input
                      value={flightNumber}
                      onChange={e => setFlightNumber(e.target.value)}
                      className="border border-gray-200 rounded px-2 py-0.5 text-sm w-32"
                      placeholder="ej. AA 1234"
                      autoFocus
                    />
                    <button onClick={handleSaveFlightNumber} className="text-xs text-green-600 font-medium hover:underline">Guardar</button>
                    <button onClick={() => setEditingFlight(false)} className="text-xs text-gray-400 hover:underline">Cancelar</button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-700">{flight.flight_number || '—'}</span>
                    {canEdit && (
                      <button onClick={() => setEditingFlight(true)} className="text-xs text-mcl-blue hover:underline">Editar</button>
                    )}
                  </div>
                )}
              </div>

              {/* CutOff */}
              <div className="mt-1 flex items-center gap-2">
                <span className="text-sm text-gray-500">CutOff:</span>
                {editingCutoff ? (
                  <div className="flex items-center gap-2">
                    <input type="date" value={cutoffDate} onChange={e => setCutoffDate(e.target.value)}
                      className="border border-gray-200 rounded px-2 py-0.5 text-sm" />
                    <input type="time" value={cutoffTime} onChange={e => setCutoffTime(e.target.value)}
                      className="border border-gray-200 rounded px-2 py-0.5 text-sm w-24" placeholder="HH:MM" />
                    <button onClick={handleSaveCutoff} className="text-xs text-green-600 font-medium hover:underline">Guardar</button>
                    <button onClick={() => setEditingCutoff(false)} className="text-xs text-gray-400 hover:underline">Cancelar</button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    {flight.cutoff_datetime ? (
                      <span className="text-sm font-medium text-orange-600">
                        {(() => {
                          const [dp, tp] = flight.cutoff_datetime.split('T')
                          const [y, m, d] = (dp || '').split('-')
                          return `${m}/${d}/${y?.slice(2)}${tp ? ` ${tp.slice(0, 5)}` : ''}`
                        })()}
                      </span>
                    ) : (
                      <span className="text-sm text-gray-400">—</span>
                    )}
                    {canEdit && (
                      <button onClick={() => { initCutoffFields(flight); setEditingCutoff(true) }} className="text-xs text-mcl-blue hover:underline">Editar</button>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              {/* Distribución */}
              <div>
                <p className="text-xs text-gray-500 mb-1 font-medium">Distribución</p>
                {flight.doc_distribucion ? (
                  <div className="flex items-center gap-2">
                    <a
                      href={flight.doc_distribucion.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-600 hover:underline flex items-center gap-1"
                    >
                      📄 {flight.doc_distribucion.filename}
                      {flight.doc_distribucion.version > 1 && (
                        <span className="text-gray-400">v{flight.doc_distribucion.version}</span>
                      )}
                    </a>
                    {canUploadDist && (
                      <button
                        onClick={() => distInputRef.current?.click()}
                        className="text-xs text-gray-400 hover:text-gray-600"
                        title="Reemplazar"
                      >
                        ↑
                      </button>
                    )}
                  </div>
                ) : canUploadDist ? (
                  <button
                    onClick={() => distInputRef.current?.click()}
                    disabled={uploadingDist}
                    className="text-xs bg-blue-50 text-blue-600 hover:bg-blue-100 px-3 py-1.5 rounded-lg font-medium transition-colors disabled:opacity-50"
                  >
                    {uploadingDist ? 'Subiendo...' : '+ Subir Distribución'}
                  </button>
                ) : (
                  <span className="text-xs text-gray-400">Sin documento</span>
                )}
                <input ref={distInputRef} type="file" accept=".pdf" className="hidden" onChange={handleUploadDistribucion} />
              </div>

              {canEdit && (
                <button
                  onClick={handleToggleStatus}
                  className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${
                    flight.status === 'open'
                      ? 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                      : 'bg-green-50 text-green-700 hover:bg-green-100'
                  }`}
                >
                  {flight.status === 'open' ? 'Cerrar vuelo' : 'Reabrir vuelo'}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Bookings */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-gray-700">Bookings ({bookings.length})</h3>
            {(canEdit || isClient) && (
              <button
                onClick={() => navigate(`/airfreight/bookings/new?flight=${id}`)}
                className="px-4 py-2 bg-mcl-blue text-white text-sm font-semibold rounded-lg hover:bg-blue-900 transition-colors"
              >
                {bookings.length > 0 ? 'Editar bookings' : '+ Agregar bookings'}
              </button>
            )}
          </div>

          {bookings.length === 0 ? (
            <div className="text-center py-10 text-gray-400 text-sm bg-white rounded-xl border border-gray-100">
              Sin bookings en este vuelo
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                    <th className="px-4 py-2 text-left">Cliente</th>
                    <th className="px-4 py-2 text-left">AWB / MAWB</th>
                    <th className="px-4 py-2 text-left">Destino</th>
                    <th className="px-4 py-2 text-center">Pcs</th>
                    <th className="px-4 py-2 text-center">Estado</th>
                    <th className="px-4 py-2 text-center">Cambios</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {bookings.map(b => {
                    const awb = b.booking_type === 'mawb' ? b.mawb_number : b.booking_type === 'ecommerce' ? (b.client_name || '—') : b.awb_1st_leg
                    return (
                      <tr
                        key={b.id}
                        className="hover:bg-blue-50/30 cursor-pointer"
                        onClick={() => navigate(`/airfreight/bookings/${b.id}`)}
                      >
                        <td className="px-4 py-3 font-medium text-gray-800">{b.client_name}</td>
                        <td className="px-4 py-3 font-mono text-xs text-gray-600">{awb || '—'}</td>
                        <td className="px-4 py-3 text-gray-500">{b.destination_custom || b.destination_id}</td>
                        <td className="px-4 py-3 text-center text-gray-600">{b.pieces || '—'}</td>
                        <td className="px-4 py-3 text-center">
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLOR[b.status] || ''}`}>
                            {STATUS_LABEL[b.status] || b.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          {b.change_count > 0 ? (
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${!b.modified_seen ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'}`}>
                              {b.change_count}
                            </span>
                          ) : (
                            <span className="text-gray-300 text-xs">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <svg className="w-4 h-4 text-gray-300 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Layout>
  )
}
