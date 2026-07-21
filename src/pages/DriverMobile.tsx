import { useState, useEffect, useRef } from 'react'
import { collection, query, where, getDocs, doc, getDoc, onSnapshot } from 'firebase/firestore'
import { db } from '../lib/firebase'
import {
  createDriverQueueEntry, captureGps, recordMilestone,
  uploadSealPhoto, saveDriverNotes,
} from '../lib/driverTracking'
import {
  recordWSMilestone, completeWSDelivery, buildMilestoneKeys, uploadWSDriverPhoto,
} from '../lib/wsTransportTracking'
import { DriverQueueEntry, DeliveryTracking, WSDeliveryTracking } from '../types'

const DEFAULT_TRUCKING = ['CO-Transportation', 'GEO Transport']

const MILESTONES = [
  { key: 'arrival_mcl', label: 'Arrival at MCL' },
  { key: 'truck_loaded', label: 'Truck Loaded', needsPhoto: true },
  { key: 'arrival_airline', label: 'Arrival at Airline' },
  { key: 'gate_assigned', label: 'Gate Assigned' },
  { key: 'unload_start', label: 'Unload Start' },
  { key: 'unload_end', label: 'Unload End' },
] as const

type ViewState = 'register' | 'waiting' | 'tracking' | 'completed'

export default function DriverMobile() {
  const [view, setView] = useState<ViewState>('register')

  // Register state
  const [name, setName] = useState('')
  const [vendorName, setVendorName] = useState('')
  const [vendorOptions, setVendorOptions] = useState<{ id: string; name: string }[]>([])
  const [selectedVendorId, setSelectedVendorId] = useState<string | null>(null)
  const [vendorSelectValue, setVendorSelectValue] = useState('') // '' = not chosen, '__custom__' = free text, or a vendor name
  const [plate, setPlate] = useState('')
  const [registering, setRegistering] = useState(false)
  const [queueId, setQueueId] = useState<string | null>(null)

  // Waiting state
  const [doNumber, setDoNumber] = useState('')
  const [pin, setPin] = useState('')
  const [pinError, setPinError] = useState('')
  const [verifying, setVerifying] = useState(false)

  // Tracking state
  const [trackingId, setTrackingId] = useState<string | null>(null)
  const [tracking, setTracking] = useState<DeliveryTracking | null>(null)
  const [milestoneLoading, setMilestoneLoading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // WS Transport tracking
  const [isWsMode, setIsWsMode] = useState(false)
  const [wsTracking, setWsTracking] = useState<WSDeliveryTracking | null>(null)
  const [wsPhotoFiles, setWsPhotoFiles] = useState<File[]>([])
  const wsPhotoRef = useRef<HTMLInputElement>(null)
  const wsDeliveryPhotoRef = useRef<HTMLInputElement>(null)
  const [deliveryPhotos, setDeliveryPhotos] = useState<File[]>([])
  const [receiverName, setReceiverName] = useState('')

  // Notes
  const [notesOpen, setNotesOpen] = useState(false)
  const [noteComment, setNoteComment] = useState('')
  const [notePhotos, setNotePhotos] = useState<File[]>([])
  const [noteExistingPhotos, setNoteExistingPhotos] = useState<string[]>([])
  const [noteSaving, setNoteSaving] = useState(false)
  const noteFileRef = useRef<HTMLInputElement>(null)

  function resetFlow() {
    localStorage.removeItem('mcl_driver_tracking_id')
    localStorage.removeItem('mcl_driver_queue_id')
    localStorage.removeItem('mcl_driver_ws_mode')
    setTrackingId(null)
    setTracking(null)
    setIsWsMode(false)
    setWsTracking(null)
    setWsPhotoFiles([])
    setDeliveryPhotos([])
    setReceiverName('')
    setQueueId(null)
    setView('register')
    setName('')
    setVendorName('')
    setSelectedVendorId(null)
    setVendorSelectValue('')
    setPlate('')
    setDoNumber('')
    setPin('')
    setPinError('')
    setNotesOpen(false)
    setNoteComment('')
    setNotePhotos([])
    setNoteExistingPhotos([])
  }

  // Restore state from localStorage (validate tracking doc still exists)
  useEffect(() => {
    ;(async () => {
      const savedTracking = localStorage.getItem('mcl_driver_tracking_id')
      const savedWsMode = localStorage.getItem('mcl_driver_ws_mode') === 'true'
      if (savedTracking) {
        const collName = savedWsMode ? 'ws_delivery_tracking' : 'delivery_tracking'
        try {
          const snap = await getDoc(doc(db, collName, savedTracking))
          if (!snap.exists()) {
            localStorage.removeItem('mcl_driver_tracking_id')
            localStorage.removeItem('mcl_driver_queue_id')
            localStorage.removeItem('mcl_driver_ws_mode')
          } else {
            setTrackingId(savedTracking)
            setIsWsMode(savedWsMode)
            setView('tracking')
            return
          }
        } catch {
          localStorage.removeItem('mcl_driver_tracking_id')
          localStorage.removeItem('mcl_driver_ws_mode')
        }
      }
      const saved = localStorage.getItem('mcl_driver_queue_id')
      if (saved) {
        setQueueId(saved)
        setView('waiting')
      }
    })()
    // Load vendors
    ;(async () => {
      try {
        const snap = await getDocs(query(collection(db, 'vendors'), where('status', '==', 'active')))
        setVendorOptions(snap.docs.map(d => ({ id: d.id, name: (d.data() as any).name })))
      } catch {}
    })()
  }, [])

  // Listen to queue entry for link detection
  useEffect(() => {
    if (!queueId) return
    const unsub = onSnapshot(doc(db, 'driver_queue', queueId), (snap) => {
      if (!snap.exists()) return
      const data = snap.data() as DriverQueueEntry
      if (data.status === 'linked' && data.linked_do_id) {
        // Auto-detected linking — but driver still needs to enter PIN
      }
    })
    return unsub
  }, [queueId])

  // Listen to tracking doc (airfreight or WS)
  useEffect(() => {
    if (!trackingId) return
    if (isWsMode) {
      const unsub = onSnapshot(doc(db, 'ws_delivery_tracking', trackingId), (snap) => {
        if (!snap.exists()) return
        const data = { ...snap.data() as WSDeliveryTracking, id: snap.id }
        setWsTracking(data)
        if (data.status === 'completed') setView('completed')
      })
      return unsub
    }
    const unsub = onSnapshot(doc(db, 'delivery_tracking', trackingId), (snap) => {
      if (!snap.exists()) return
      const data = { ...snap.data() as DeliveryTracking, id: snap.id }
      setTracking(data)
      if (data.driver_notes) {
        setNoteComment(data.driver_notes.comment || '')
        setNoteExistingPhotos(data.driver_notes.photo_urls || [])
      }
      if (data.status === 'completed') setView('completed')
    })
    return unsub
  }, [trackingId, isWsMode])

  async function handleRegister() {
    if (!name.trim()) return
    setRegistering(true)
    try {
      const gps = await captureGps()
      const id = await createDriverQueueEntry({
        driver_name: name.trim(),
        vendor_id: selectedVendorId,
        vendor_name: vendorName.trim(),
        plate: plate.trim() || null,
        gps,
      })
      setQueueId(id)
      localStorage.setItem('mcl_driver_queue_id', id)
      setView('waiting')
    } catch (err: any) {
      alert(err.message || 'Error al registrarse')
    } finally {
      setRegistering(false)
    }
  }

  async function handleVerifyPin() {
    if (!doNumber.trim() || !pin.trim()) return
    setPinError('')
    setVerifying(true)
    try {
      const raw = doNumber.trim()
      // Detect prefix: WS-DO, AV-, or standard DO
      const isWs = raw.toUpperCase().startsWith('WS')
      const isAv = raw.toUpperCase().startsWith('AV')
      let fullDoNumber: string
      let collectionName: string

      if (isWs) {
        const numPart = raw.replace(/^WS[-]?DO[-]?/i, '').trim()
        fullDoNumber = `WS-DO-${numPart.padStart(5, '0')}`
        collectionName = 'ws_delivery_tracking'
      } else if (isAv) {
        const numPart = raw.replace(/^AV[-]?/i, '').trim()
        fullDoNumber = `AV-${numPart.padStart(7, '0')}`
        collectionName = 'delivery_tracking'
      } else {
        fullDoNumber = `DO-${raw.padStart(7, '0')}`
        collectionName = 'delivery_tracking'
      }

      const q = query(
        collection(db, collectionName),
        where('do_number', '==', fullDoNumber),
        where('driver_pin', '==', pin.trim()),
      )
      const snap = await getDocs(q)
      if (snap.empty) {
        setPinError('DO# o PIN incorrecto')
        setVerifying(false)
        return
      }
      const trackDoc = snap.docs[0]
      setTrackingId(trackDoc.id)
      if (isWs) {
        setIsWsMode(true)
        setWsTracking({ ...trackDoc.data() as WSDeliveryTracking, id: trackDoc.id })
        localStorage.setItem('mcl_driver_ws_mode', 'true')
      } else {
        setTracking({ ...trackDoc.data() as DeliveryTracking, id: trackDoc.id })
      }
      localStorage.setItem('mcl_driver_tracking_id', trackDoc.id)
      localStorage.removeItem('mcl_driver_queue_id')
      setView('tracking')
    } catch (err: any) {
      setPinError(err.message || 'Error al verificar')
    } finally {
      setVerifying(false)
    }
  }

  function getNextMilestone(): string | null {
    if (!tracking) return null
    for (const m of MILESTONES) {
      if (!(tracking.milestones as any)[m.key]) return m.key
    }
    return null
  }

  async function handleMilestone(key: string) {
    if (!trackingId) return
    const milestone = MILESTONES.find(m => m.key === key)
    if (!milestone) return

    // If truck_loaded, need photo first
    if (key === 'truck_loaded') {
      fileInputRef.current?.click()
      return
    }

    if (!confirm(`Confirmar: ${milestone.label}?`)) return
    setMilestoneLoading(true)
    try {
      const gps = await captureGps()
      await recordMilestone(trackingId, key as any, gps)
    } catch (err: any) {
      alert(err.message || 'Error')
    } finally {
      setMilestoneLoading(false)
    }
  }

  async function handleSealPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !trackingId) return
    if (!confirm('Confirmar: Truck Loaded?')) return
    setMilestoneLoading(true)
    try {
      const [gps, photoUrl] = await Promise.all([captureGps(), uploadSealPhoto(file)])
      await recordMilestone(trackingId, 'truck_loaded', gps, photoUrl)
    } catch (err: any) {
      alert(err.message || 'Error')
    } finally {
      setMilestoneLoading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function handleSaveNotes() {
    if (!trackingId) return
    setNoteSaving(true)
    try {
      await saveDriverNotes(trackingId, noteComment, notePhotos, noteExistingPhotos)
      setNotePhotos([])
      alert('Notas guardadas')
    } catch (err: any) {
      alert(err.message || 'Error al guardar notas')
    } finally {
      setNoteSaving(false)
    }
  }

  // ── WS Transport milestone helpers ──
  const wsMilestoneKeys = wsTracking ? buildMilestoneKeys(wsTracking.extra_stops || []) : []

  function getNextWsMilestone(): string | null {
    if (!wsTracking) return null
    for (const m of wsMilestoneKeys) {
      if (!(wsTracking.milestones as Record<string, unknown>)[m.key]) return m.key
    }
    return null
  }

  async function handleWsMilestone(key: string) {
    if (!trackingId || !wsTracking) return
    const milestone = wsMilestoneKeys.find(m => m.key === key)
    if (!milestone) return

    // For 'delivered', show delivery form instead
    if (key === 'delivered') return

    if (!confirm(`Confirmar: ${milestone.label}${milestone.address ? ` (${milestone.address})` : ''}?`)) return
    setMilestoneLoading(true)
    try {
      let gps = { lat: 0, lng: 0 }
      try { gps = await captureGps() } catch { /* GPS unavailable */ }
      await recordWSMilestone(trackingId, key, gps)
    } catch (err: any) {
      alert(err.message || 'Error')
    } finally {
      setMilestoneLoading(false)
    }
  }

  async function handleWsDelivery() {
    if (!trackingId || !wsTracking) return
    if (!confirm('Confirmar entrega?')) return
    setMilestoneLoading(true)
    try {
      // 1) Capture GPS (fallback to 0,0 if denied/timeout)
      let gps = { lat: 0, lng: 0 }
      try { gps = await captureGps() } catch { /* GPS unavailable */ }

      // 2) Complete delivery FIRST in Firestore (never blocked by photo upload)
      await completeWSDelivery(trackingId, gps, receiverName.trim() || null, null, null, [])

      // 3) Upload photos in background and patch the doc
      if (deliveryPhotos.length > 0) {
        const photoUrls: string[] = []
        for (const f of deliveryPhotos) {
          try {
            const url = await uploadWSDriverPhoto(f)
            photoUrls.push(url)
          } catch { /* skip failed uploads */ }
        }
        if (photoUrls.length > 0) {
          try {
            const { updateDoc: updDoc, doc: docRef } = await import('firebase/firestore')
            const { db: fbDb } = await import('../lib/firebase')
            await updDoc(docRef(fbDb, 'ws_delivery_tracking', trackingId), {
              delivery_photo_urls: photoUrls,
              'milestones.delivered.photo_urls': photoUrls,
            })
          } catch { /* photo patch failed, non-critical */ }
        }
      }
    } catch (err: any) {
      alert(err.message || 'Error al confirmar entrega')
    } finally {
      setMilestoneLoading(false)
    }
  }

  const nextWsMilestone = getNextWsMilestone()
  const nextMilestone = getNextMilestone()

  // ── REGISTER ──
  if (view === 'register') {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col">
        <div className="bg-mcl-blue text-white px-4 py-3 text-center">
          <h1 className="text-lg font-bold">MCL Driver Check-In</h1>
        </div>
        <div className="flex-1 p-4 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Nombre del Driver *</label>
            <input value={name} onChange={e => setName(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/40" placeholder="Tu nombre completo" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Trucking Company</label>
            <select
              value={vendorSelectValue}
              onChange={e => {
                const val = e.target.value
                setVendorSelectValue(val)
                if (val === '__custom__') {
                  setSelectedVendorId(null)
                  setVendorName('')
                } else {
                  const match = vendorOptions.find(v => v.name === val)
                  setSelectedVendorId(match?.id || null)
                  setVendorName(val)
                }
              }}
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/40"
            >
              <option value="" disabled>Seleccionar...</option>
              {DEFAULT_TRUCKING.filter(name => !vendorOptions.some(v => v.name === name)).map(name => (
                <option key={name} value={name}>{name}</option>
              ))}
              {vendorOptions.map(v => <option key={v.id} value={v.name}>{v.name}</option>)}
              <option value="__custom__">Otro (escribir)</option>
            </select>
            {vendorSelectValue === '__custom__' && (
              <input
                value={vendorName}
                onChange={e => setVendorName(e.target.value)}
                placeholder="Nombre de la empresa"
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/40 mt-1"
              />
            )}
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Placa (opcional)</label>
            <input value={plate} onChange={e => setPlate(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/40" placeholder="ABC-1234" />
          </div>
          <button
            onClick={handleRegister}
            disabled={registering || !name.trim()}
            className="w-full bg-mcl-blue text-white font-bold rounded-lg py-3 text-sm disabled:opacity-50"
          >
            {registering ? 'Registrando...' : 'Registrarme en Cola'}
          </button>
        </div>
      </div>
    )
  }

  // ── WAITING ──
  if (view === 'waiting') {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col">
        <div className="bg-mcl-blue text-white px-4 py-3 text-center">
          <h1 className="text-lg font-bold">MCL Driver Queue</h1>
        </div>
        <div className="flex-1 p-4 space-y-4">
          <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-center">
            <div className="text-green-700 font-bold text-sm mb-1">Estas en la cola de espera</div>
            <div className="text-xs text-green-600">Espera a que Counter te asigne una DO y te entregue un PIN</div>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
            <div className="text-xs font-semibold text-gray-500 uppercase">Ingresar DO + PIN</div>
            <div>
              <input
                value={doNumber}
                onChange={e => setDoNumber(e.target.value)}
                placeholder="0000012 o WS00012"
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-mcl-blue/40"
              />
              <div className="text-[10px] text-gray-400 mt-1">Airfreight: numero | WS: WS + numero | Avianca: AV + numero</div>
            </div>
            <input value={pin} onChange={e => setPin(e.target.value)} placeholder="PIN (4 digitos)" maxLength={4} inputMode="numeric" className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm text-center tracking-[0.5em] font-mono font-bold focus:outline-none focus:ring-2 focus:ring-mcl-blue/40" />
            {pinError && <div className="text-red-500 text-xs text-center">{pinError}</div>}
            <button
              onClick={handleVerifyPin}
              disabled={verifying || !doNumber.trim() || !pin.trim()}
              className="w-full bg-mcl-blue text-white font-bold rounded-lg py-3 text-sm disabled:opacity-50"
            >
              {verifying ? 'Verificando...' : 'Iniciar Tracking'}
            </button>
          </div>
          <button onClick={resetFlow} className="w-full text-xs text-gray-400 hover:text-gray-600 py-2">
            Salir de la cola
          </button>
        </div>
      </div>
    )
  }

  // ── COMPLETED ──
  if (view === 'completed') {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6">
        <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center max-w-sm w-full">
          <div className="text-5xl mb-4">&#10003;</div>
          <h2 className="text-xl font-bold text-gray-800 mb-2">Viaje Completado</h2>
          <p className="text-sm text-gray-500 mb-6">Todos los hitos fueron registrados exitosamente.</p>
          <button onClick={resetFlow} className="w-full bg-mcl-blue text-white font-bold rounded-lg py-3 text-sm">
            Nuevo viaje
          </button>
        </div>
      </div>
    )
  }

  // ── WS TRANSPORT TRACKING ──
  if (isWsMode && wsTracking) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col">
        <div className="bg-emerald-700 text-white px-4 py-3 text-center">
          <h1 className="text-lg font-bold">WS Transport: {wsTracking.do_number}</h1>
          <div className="text-xs text-emerald-200 mt-0.5">{wsTracking.pickup_from} &rarr; {wsTracking.deliver_to}</div>
        </div>
        <div className="flex-1 p-4 space-y-3">
          <input type="file" accept="image/*" capture="environment" ref={wsDeliveryPhotoRef} onChange={e => { if (e.target.files?.[0]) setDeliveryPhotos(prev => [...prev, e.target.files![0]]); if (wsDeliveryPhotoRef.current) wsDeliveryPhotoRef.current.value = '' }} className="hidden" />

          {/* Cargo summary */}
          <div className="bg-white rounded-xl border border-gray-200 p-3">
            <div className="flex items-center justify-between">
              <div className="text-xs text-gray-500">
                {wsTracking.total_pieces} pcs &bull; {wsTracking.total_weight} kg
                {wsTracking.transport_type === 'bup' && wsTracking.bup_count && ` &bull; ${wsTracking.bup_count} BUP`}
              </div>
              <div className="text-xs font-semibold text-gray-600">{wsTracking.client_name}</div>
            </div>
          </div>

          {/* Milestones */}
          {wsMilestoneKeys.map((m, idx) => {
            const done = wsTracking.milestones && (wsTracking.milestones as Record<string, any>)[m.key]
            const isNext = m.key === nextWsMilestone
            const isDelivery = m.key === 'delivered'

            return (
              <div
                key={m.key}
                className={`rounded-xl border p-4 transition-all ${
                  done ? 'bg-green-50 border-green-200' : isNext ? 'bg-white border-emerald-600 shadow-md' : 'bg-gray-50 border-gray-200 opacity-50'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                      done ? 'bg-green-500 text-white' : isNext ? 'bg-emerald-700 text-white' : 'bg-gray-200 text-gray-400'
                    }`}>
                      {done ? '\u2713' : idx + 1}
                    </div>
                    <div>
                      <div className={`text-sm font-semibold ${done ? 'text-green-700' : 'text-gray-700'}`}>{m.label}</div>
                      {m.address && <div className="text-[10px] text-gray-400">{m.address}</div>}
                      {done && (
                        <div className="text-[10px] text-green-600">
                          {new Date(done.timestamp).toLocaleTimeString()}
                        </div>
                      )}
                    </div>
                  </div>
                  {isNext && !isDelivery && (
                    <button
                      onClick={() => handleWsMilestone(m.key)}
                      disabled={milestoneLoading}
                      className="bg-emerald-700 text-white font-bold text-xs px-4 py-2 rounded-lg disabled:opacity-50"
                    >
                      {milestoneLoading ? '...' : 'Marcar'}
                    </button>
                  )}
                </div>

                {/* Delivery form inline */}
                {isNext && isDelivery && (
                  <div className="mt-3 pt-3 border-t border-gray-200 space-y-3">
                    <div>
                      <label className="text-xs font-semibold text-gray-600 block mb-1">Nombre del Receptor</label>
                      <input value={receiverName} onChange={e => setReceiverName(e.target.value)} placeholder="Nombre completo" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40" />
                    </div>
                    <div>
                      <label className="text-xs font-semibold text-gray-600 block mb-1">Fotos de entrega</label>
                      <div className="flex flex-wrap gap-2">
                        {deliveryPhotos.map((f, i) => (
                          <div key={i} className="relative w-16 h-16 rounded-lg overflow-hidden border border-emerald-300">
                            <img src={URL.createObjectURL(f)} alt="" className="w-full h-full object-cover" />
                            <button onClick={() => setDeliveryPhotos(prev => prev.filter((_, j) => j !== i))} className="absolute top-0 right-0 bg-red-500 text-white text-[10px] w-4 h-4 rounded-bl">&times;</button>
                          </div>
                        ))}
                        <button onClick={() => wsDeliveryPhotoRef.current?.click()} className="w-16 h-16 border-2 border-dashed border-gray-300 rounded-lg flex items-center justify-center text-gray-400 hover:border-emerald-500 hover:text-emerald-500">
                          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                        </button>
                      </div>
                    </div>
                    <button
                      onClick={handleWsDelivery}
                      disabled={milestoneLoading}
                      className="w-full bg-emerald-700 text-white font-bold rounded-lg py-3 text-sm disabled:opacity-50"
                    >
                      {milestoneLoading ? 'Procesando...' : 'Confirmar Entrega'}
                    </button>
                  </div>
                )}
              </div>
            )
          })}

          <button
            onClick={() => { if (confirm('Iniciar un nuevo viaje?')) resetFlow() }}
            className="w-full text-xs text-gray-400 hover:text-red-500 py-3 mt-2"
          >
            Nuevo viaje
          </button>
        </div>
      </div>
    )
  }

  // ── AIRFREIGHT TRACKING ──
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <div className="bg-mcl-blue text-white px-4 py-3 text-center">
        <h1 className="text-lg font-bold">Tracking: {tracking?.do_number}</h1>
      </div>
      <div className="flex-1 p-4 space-y-3">
        <input type="file" accept="image/*" capture="environment" ref={fileInputRef} onChange={handleSealPhoto} className="hidden" />

        {/* Notes section */}
        <input type="file" accept="image/*" capture="environment" ref={noteFileRef} onChange={e => { if (e.target.files?.[0]) setNotePhotos(prev => [...prev, e.target.files![0]]); if (noteFileRef.current) noteFileRef.current.value = '' }} className="hidden" />
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <button onClick={() => setNotesOpen(!notesOpen)} className="w-full flex items-center justify-between px-4 py-3">
            <span className="text-xs font-semibold text-gray-600 uppercase">Notas / Fotos</span>
            <svg className={`w-4 h-4 text-gray-400 transition-transform ${notesOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
          </button>
          {notesOpen && (
            <div className="px-4 pb-4 space-y-3 border-t border-gray-100 pt-3">
              <textarea
                value={noteComment}
                onChange={e => setNoteComment(e.target.value)}
                placeholder="Escribir comentario..."
                rows={3}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/40 resize-none"
              />
              {/* Existing photos */}
              {noteExistingPhotos.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {noteExistingPhotos.map((url, i) => (
                    <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="w-16 h-16 rounded-lg overflow-hidden border border-gray-200">
                      <img src={url} alt={`Foto ${i + 1}`} className="w-full h-full object-cover" />
                    </a>
                  ))}
                </div>
              )}
              {/* New photos to upload */}
              {notePhotos.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {notePhotos.map((f, i) => (
                    <div key={i} className="relative w-16 h-16 rounded-lg overflow-hidden border border-blue-300 bg-blue-50">
                      <img src={URL.createObjectURL(f)} alt={`Nueva ${i + 1}`} className="w-full h-full object-cover" />
                      <button onClick={() => setNotePhotos(prev => prev.filter((_, j) => j !== i))} className="absolute top-0 right-0 bg-red-500 text-white text-[10px] w-4 h-4 rounded-bl leading-none">&times;</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <button onClick={() => noteFileRef.current?.click()} className="flex-1 border border-gray-300 text-gray-600 font-semibold rounded-lg py-2 text-xs hover:bg-gray-50">
                  Agregar foto
                </button>
                <button onClick={handleSaveNotes} disabled={noteSaving || (!noteComment.trim() && notePhotos.length === 0 && noteExistingPhotos.length === 0)} className="flex-1 bg-mcl-blue text-white font-semibold rounded-lg py-2 text-xs disabled:opacity-50">
                  {noteSaving ? 'Guardando...' : 'Guardar'}
                </button>
              </div>
            </div>
          )}
        </div>

        {MILESTONES.map((m, idx) => {
          const done = tracking?.milestones && (tracking.milestones as any)[m.key]
          const isNext = m.key === nextMilestone
          return (
            <div
              key={m.key}
              className={`rounded-xl border p-4 transition-all ${
                done ? 'bg-green-50 border-green-200' : isNext ? 'bg-white border-mcl-blue shadow-md' : 'bg-gray-50 border-gray-200 opacity-50'
              }`}
            >
              <div className="flex items-center justify-between">

                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                    done ? 'bg-green-500 text-white' : isNext ? 'bg-mcl-blue text-white' : 'bg-gray-200 text-gray-400'
                  }`}>
                    {done ? '\u2713' : idx + 1}
                  </div>
                  <div>
                    <div className={`text-sm font-semibold ${done ? 'text-green-700' : 'text-gray-700'}`}>{m.label}</div>
                    {done && (
                      <div className="text-[10px] text-green-600">
                        {new Date(done.timestamp).toLocaleTimeString()}
                      </div>
                    )}
                  </div>
                </div>
                {isNext && (
                  <button
                    onClick={() => handleMilestone(m.key)}
                    disabled={milestoneLoading}
                    className="bg-mcl-blue text-white font-bold text-xs px-4 py-2 rounded-lg disabled:opacity-50"
                  >
                    {milestoneLoading ? '...' : m.key === 'truck_loaded' ? 'Foto + Marcar' : 'Marcar'}
                  </button>
                )}
              </div>
            </div>
          )
        })}

        {/* Reset button */}
        <button
          onClick={() => { if (confirm('Iniciar un nuevo viaje? Se perderá el estado actual.')) resetFlow() }}
          className="w-full text-xs text-gray-400 hover:text-red-500 py-3 mt-2"
        >
          Nuevo viaje
        </button>
      </div>
    </div>
  )
}
