import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { collection, getDocs, query, where, orderBy, onSnapshot } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import { PickupOrder, PickupOrderLine, DriverQueueEntry, TruckingVendor } from '../../types'
import Layout from '../../components/Layout'
import {
  savePickupOrder, loadPickupOrder,
  buildPuHtml, openPrintableHtml,
  uploadAuthorizationLetter,
} from '../../lib/pickupOrder'
import {
  generateDriverPin, linkDriverToDeliveryOrder,
} from '../../lib/driverTracking'

const EMPTY_LINE: PickupOrderLine = {
  client: '',
  client_document: '',
  awb: '',
  pmc: '',
  pieces: 0,
  weight: 0,
  airline: '',
  picked_up_by: '',
  delivered_by: '',
  work_order: '',
}

export default function AirfreightPickupOrder() {
  const { puId } = useParams<{ puId: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // PU form state
  const [docId, setDocId] = useState<string | null>(null)
  const [puNumber, setPuNumber] = useState('')
  const [lines, setLines] = useState<PickupOrderLine[]>([{ ...EMPTY_LINE }])
  const [truckingCompany, setTruckingCompany] = useState('')
  const [truckingCustom, setTruckingCustom] = useState('')
  const [driverName, setDriverName] = useState('')
  const [mclAgent, setMclAgent] = useState('')
  const [notes, setNotes] = useState('')
  const [pickupLocation, setPickupLocation] = useState('')
  const [pickupDatetime, setPickupDatetime] = useState('')
  const [dropOffLocation, setDropOffLocation] = useState('MinCurl Logistics, 2323 NW 82nd Ave, Doral')
  const [dropOffCustom, setDropOffCustom] = useState('')
  const [driverPin, setDriverPin] = useState('')
  const [selectedQueueId, setSelectedQueueId] = useState<string | null>(null)
  const [puStatus, setPuStatus] = useState<'draft' | 'complete'>('draft')

  // Authorization Letter (client upload)
  const [authLetterUrl, setAuthLetterUrl] = useState('')
  const [authLetterName, setAuthLetterName] = useState('')
  const [uploadingLetter, setUploadingLetter] = useState(false)

  // Trucking vendors from system
  const [truckingVendors, setTruckingVendors] = useState<(TruckingVendor & { id: string })[]>([])

  // Driver queue modal
  const [driverQueueModal, setDriverQueueModal] = useState(false)
  const [driverQueueEntries, setDriverQueueEntries] = useState<(DriverQueueEntry & { id: string })[]>([])
  const [driverQueueLoading, setDriverQueueLoading] = useState(false)

  const isNewMode = puId === 'new' || !puId

  // ── Load vendors ──
  useEffect(() => {
    const vQ = query(collection(db, 'vendors'), orderBy('name'))
    const unsub = onSnapshot(vQ, snap => {
      setTruckingVendors(snap.docs.map(d => ({ ...d.data() as TruckingVendor, id: d.id })).filter(v => v.status === 'active'))
    })
    return () => unsub()
  }, [])

  // ── Load existing PU or pre-fill from sessionStorage ──
  useEffect(() => {
    if (isNewMode) {
      // Read pre-filled AWBs from Transportation page
      try {
        const raw = sessionStorage.getItem('pickup_order_awbs')
        if (raw) {
          const awbs = JSON.parse(raw) as Array<{
            bookingId: string; awbIndex: number; awbNumber: string;
            awb2ndLeg: string; pieces: number; grossWeight: number; chargeableWeight: number;
            clientName: string; clientId: string; flightNumber: string;
            pickupFrom: string; uldType: string; transportCompany: string;
          }>
          if (awbs.length > 0) {
            setLines(awbs.map(a => ({
              ...EMPTY_LINE,
              client: a.clientName || '',
              awb: a.awbNumber || '',
              pmc: (a.uldType && a.uldType.toUpperCase() !== 'LOOSE') ? 'BUP' : 'LOOSE',
              pieces: a.pieces || 0,
              weight: a.grossWeight || 0,
            })))
            // Pre-fill pickup location from first AWB if available
            const firstPickup = awbs.find(a => a.pickupFrom)
            if (firstPickup) setPickupLocation(firstPickup.pickupFrom)
            // Pre-fill trucking company from first AWB if available
            const firstTransport = awbs.find(a => a.transportCompany)
            if (firstTransport) {
              const tc = firstTransport.transportCompany
              setTruckingCompany(tc)
            }
            // Clean up after successful read
            sessionStorage.removeItem('pickup_order_awbs')
          }
        }
      } catch (err) {
        console.error('Error reading sessionStorage:', err)
      }
      setLoading(false)
      return
    }
    ;(async () => {
      try {
        const existing = await loadPickupOrder(puId!)
        if (existing) {
          setDocId(existing.id)
          setPuNumber(existing.pu_number)
          setLines(existing.lines?.length ? existing.lines : [{ ...EMPTY_LINE }])
          const vendorNames = truckingVendors.map(v => v.name)
          setTruckingCompany(vendorNames.includes(existing.trucking_company) ? existing.trucking_company : (existing.trucking_company ? '__custom__' : ''))
          setTruckingCustom(vendorNames.includes(existing.trucking_company) ? '' : existing.trucking_company)
          setDriverName(existing.driver_name)
          setMclAgent(existing.mcl_agent)
          setNotes(existing.notes || '')
          setPickupLocation(existing.pickup_location || '')
          setPickupDatetime(existing.pickup_datetime || '')
          const dol = (existing as any).drop_off_location || 'MinCurl Logistics, 2323 NW 82nd Ave, Doral'
          const MCL_DEFAULT = 'MinCurl Logistics, 2323 NW 82nd Ave, Doral'
          if (dol === MCL_DEFAULT) { setDropOffLocation(MCL_DEFAULT) }
          else { setDropOffLocation('__other__'); setDropOffCustom(dol) }
          setDriverPin(existing.driver_pin || '')
          setSelectedQueueId(existing.driver_queue_id || null)
          setPuStatus(existing.status || 'draft')
          setAuthLetterUrl(existing.auth_letter_url || '')
          setAuthLetterName(existing.auth_letter_name || '')
        }
      } catch (err) {
        console.error('Error loading PU:', err)
      } finally {
        setLoading(false)
      }
    })()
  }, [puId])

  // ── Line helpers ──
  function updateLine(idx: number, field: keyof PickupOrderLine, value: string | number) {
    setLines(prev => prev.map((l, i) => i === idx ? { ...l, [field]: value } : l))
  }

  function addLine() {
    setLines(prev => [...prev, { ...EMPTY_LINE }])
  }

  function removeLine(idx: number) {
    setLines(prev => prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx))
  }

  // ── Resolve trucking ──
  function resolvedTrucking(): string {
    return truckingCompany === '__custom__' ? truckingCustom : truckingCompany
  }

  function resolvedDropOff(): string {
    return dropOffLocation === '__other__' ? dropOffCustom : dropOffLocation
  }

  // ── Save ──
  async function handleSave(markComplete = false) {
    if (lines.every(l => !l.client && !l.awb)) {
      alert('Add at least one line with client or AWB.')
      return
    }
    setSaving(true)
    try {
      const pin = driverPin || generateDriverPin()
      const puData: PickupOrder = {
        ...(docId ? { id: docId } : {}),
        pu_number: puNumber,
        date: new Date().toISOString(),
        status: markComplete ? 'complete' : puStatus,
        created_at: new Date().toISOString(),
        created_by: user?.email || '',
        lines,
        trucking_company: resolvedTrucking(),
        driver_name: driverName,
        mcl_agent: mclAgent,
        notes,
        pickup_location: pickupLocation,
        drop_off_location: resolvedDropOff(),
        pickup_datetime: pickupDatetime,
        driver_pin: pin,
        driver_queue_id: selectedQueueId,
        auth_letter_url: authLetterUrl || undefined,
        auth_letter_name: authLetterName || undefined,
      }
      const savedId = await savePickupOrder(puData)

      // Link driver queue if selected
      if (selectedQueueId) {
        try { await linkDriverToDeliveryOrder(selectedQueueId, savedId) } catch {}
      }

      if (!docId) {
        // Reload to get the assigned PU#
        const saved = await loadPickupOrder(savedId)
        if (saved) {
          navigate(`/airfreight/pickup-order/${saved.id}`, { replace: true })
        }
      } else {
        // Refresh in place
        const saved = await loadPickupOrder(docId)
        if (saved) {
          setPuNumber(saved.pu_number)
          setPuStatus(saved.status)
          setDriverPin(saved.driver_pin || pin)
        }
      }
    } catch (err) {
      console.error('Save error:', err)
      alert('Error saving: ' + (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  // ── View Pick Up Order (printable) ──
  function handleViewPU() {
    const puData: PickupOrder = {
      id: docId || undefined,
      pu_number: puNumber || 'PU-PENDING',
      date: new Date().toISOString(),
      status: puStatus,
      created_at: '',
      created_by: '',
      lines,
      trucking_company: resolvedTrucking(),
      driver_name: driverName,
      mcl_agent: mclAgent,
      notes,
      pickup_location: pickupLocation,
      drop_off_location: resolvedDropOff(),
      pickup_datetime: pickupDatetime,
    }
    openPrintableHtml(buildPuHtml(puData), `Pick Up Order — ${puNumber || 'New PU'}`)
  }

  // ── Upload Authorization Letter ──
  async function handleUploadAuthLetter(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!docId) {
      alert('Please save the Pick Up Order first before uploading the Authorization Letter.')
      return
    }
    setUploadingLetter(true)
    try {
      const url = await uploadAuthorizationLetter(file, docId)
      setAuthLetterUrl(url)
      setAuthLetterName(file.name)
      // Save the URL to the PU document
      const puData: PickupOrder = {
        id: docId,
        pu_number: puNumber,
        date: new Date().toISOString(),
        status: puStatus,
        created_at: '',
        created_by: user?.email || '',
        lines,
        trucking_company: resolvedTrucking(),
        driver_name: driverName,
        mcl_agent: mclAgent,
        notes,
        pickup_location: pickupLocation,
        drop_off_location: resolvedDropOff(),
        pickup_datetime: pickupDatetime,
        driver_pin: driverPin,
        driver_queue_id: selectedQueueId,
        auth_letter_url: url,
        auth_letter_name: file.name,
      }
      await savePickupOrder(puData)
    } catch (err) {
      console.error('Upload error:', err)
      alert('Error uploading: ' + (err as Error).message)
    } finally {
      setUploadingLetter(false)
    }
  }

  // ── Driver queue modal ──
  async function openDriverQueueModal() {
    setDriverQueueModal(true)
    setDriverQueueLoading(true)
    try {
      const q = query(collection(db, 'driver_queue'), where('status', '==', 'waiting'))
      const snap = await getDocs(q)
      const entries = snap.docs.map(d => ({ ...d.data() as DriverQueueEntry, id: d.id }))
      setDriverQueueEntries(entries)
    } catch (err) {
      console.error('Error loading driver queue:', err)
    } finally {
      setDriverQueueLoading(false)
    }
  }

  function selectDriver(entry: DriverQueueEntry & { id: string }) {
    setDriverName(entry.driver_name)
    setTruckingCompany('__custom__')
    setTruckingCustom(entry.vendor_name)
    setSelectedQueueId(entry.id)
    setDriverQueueModal(false)
  }

  // ── Totals ──
  const totalPieces = lines.reduce((s, l) => s + (l.pieces || 0), 0)
  const totalWeight = lines.reduce((s, l) => s + (l.weight || 0), 0)

  if (loading) {
    return (
      <Layout title="Pick Up Order" backTo="/airfreight/pickup-orders">
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" />
        </div>
      </Layout>
    )
  }

  return (
    <Layout title={puNumber || 'New Pick Up Order'} backTo="/airfreight/pickup-orders">
      <div className="max-w-4xl mx-auto space-y-6">

        {/* Header info */}
        {puNumber && (
          <div className="flex items-center gap-4">
            <span className="bg-mcl-blue text-white font-mono font-bold px-3 py-1 rounded-lg text-lg">{puNumber}</span>
            <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
              puStatus === 'complete' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
            }`}>
              {puStatus === 'complete' ? 'Complete' : 'Draft'}
            </span>
            {driverPin && (
              <span className="text-xs text-gray-400">PIN: <span className="font-mono font-bold text-gray-600">{driverPin}</span></span>
            )}
          </div>
        )}

        {/* ── Lines ── */}
        <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-gray-700 text-sm">Cargo Lines</h3>
            <button onClick={addLine} className="text-xs text-mcl-blue font-semibold hover:underline">+ Add Line</button>
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 border-b border-gray-200">
                <th className="text-left py-1 px-1 font-medium">Client</th>
                <th className="text-left py-1 px-1 font-medium">Client Doc</th>
                <th className="text-left py-1 px-1 font-medium">AWB</th>
                <th className="text-left py-1 px-1 font-medium w-20">BUP/LOOSE</th>
                <th className="text-right py-1 px-1 font-medium w-16">Pcs</th>
                <th className="text-right py-1 px-1 font-medium w-20">Kg</th>
                <th className="w-6"></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, idx) => (
                <tr key={idx} className="border-b border-gray-100">
                  <td className="py-1 px-1">
                    <input value={line.client} onChange={e => updateLine(idx, 'client', e.target.value)}
                      className="w-full border border-gray-200 rounded px-1.5 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-mcl-blue/40" />
                  </td>
                  <td className="py-1 px-1">
                    <input value={line.client_document} onChange={e => updateLine(idx, 'client_document', e.target.value)}
                      placeholder="ID / Tax #"
                      className="w-full border border-gray-200 rounded px-1.5 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-mcl-blue/40" />
                  </td>
                  <td className="py-1 px-1">
                    <input value={line.awb} onChange={e => updateLine(idx, 'awb', e.target.value)}
                      className="w-full border border-gray-200 rounded px-1.5 py-1 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-mcl-blue/40" />
                  </td>
                  <td className="py-1 px-1">
                    <input value={line.pmc} onChange={e => updateLine(idx, 'pmc', e.target.value)}
                      className="w-full border border-gray-200 rounded px-1.5 py-1 text-sm text-center focus:outline-none focus:ring-1 focus:ring-mcl-blue/40" />
                  </td>
                  <td className="py-1 px-1">
                    <input type="number" min={0} value={line.pieces || ''} onChange={e => updateLine(idx, 'pieces', Number(e.target.value))}
                      className="w-full border border-gray-200 rounded px-1.5 py-1 text-sm text-right focus:outline-none focus:ring-1 focus:ring-mcl-blue/40" />
                  </td>
                  <td className="py-1 px-1">
                    <input type="number" min={0} step={0.1} value={line.weight || ''} onChange={e => updateLine(idx, 'weight', Number(e.target.value))}
                      className="w-full border border-gray-200 rounded px-1.5 py-1 text-sm text-right focus:outline-none focus:ring-1 focus:ring-mcl-blue/40" />
                  </td>
                  <td className="py-1 px-0.5 text-center">
                    {lines.length > 1 && (
                      <button onClick={() => removeLine(idx)} className="text-red-400 hover:text-red-600 text-xs" title="Remove">×</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="text-right text-xs text-gray-500 pt-1">
            Total: <span className="font-semibold text-gray-700">{totalPieces}</span> pcs / <span className="font-semibold text-gray-700">{totalWeight.toFixed(1)}</span> kg
          </div>
        </div>

        {/* ── Transport & Pickup Info ── */}
        <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
          <h3 className="font-semibold text-gray-700 text-sm">Transport & Pickup</h3>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-gray-500">Trucking Company</label>
              <select value={truckingCompany} onChange={e => setTruckingCompany(e.target.value)}
                className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-mcl-blue/40">
                <option value="">Select...</option>
                {truckingVendors.map(v => <option key={v.id} value={v.name}>{v.name}</option>)}
                <option value="__custom__">Other (custom)</option>
              </select>
              {truckingCompany === '__custom__' && (
                <input value={truckingCustom} onChange={e => setTruckingCustom(e.target.value)}
                  placeholder="Company name"
                  className="w-full mt-1 border border-gray-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-mcl-blue/40" />
              )}
            </div>
            <div>
              <label className="text-xs text-gray-500">Driver Name</label>
              <div className="flex gap-1">
                <input value={driverName} onChange={e => setDriverName(e.target.value)}
                  className="flex-1 border border-gray-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-mcl-blue/40" />
                <button onClick={openDriverQueueModal}
                  className="px-2 py-1.5 bg-gray-100 text-xs text-gray-600 rounded hover:bg-gray-200 whitespace-nowrap" title="Select from driver queue">
                  Queue
                </button>
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-500">MCL Agent</label>
              <input value={mclAgent} onChange={e => setMclAgent(e.target.value)}
                className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-mcl-blue/40" />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-gray-500">Pickup Location</label>
              <input value={pickupLocation} onChange={e => setPickupLocation(e.target.value)}
                placeholder="Address or warehouse name"
                className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-mcl-blue/40" />
            </div>
            <div>
              <label className="text-xs text-gray-500">To</label>
              <select value={dropOffLocation} onChange={e => setDropOffLocation(e.target.value)}
                className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-mcl-blue/40">
                <option value="MinCurl Logistics, 2323 NW 82nd Ave, Doral">MinCurl Logistics, 2323 NW 82nd Ave, Doral</option>
                <option value="__other__">Other...</option>
              </select>
              {dropOffLocation === '__other__' && (
                <input value={dropOffCustom} onChange={e => setDropOffCustom(e.target.value)}
                  placeholder="Address"
                  className="w-full mt-1 border border-gray-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-mcl-blue/40" />
              )}
            </div>
            <div>
              <label className="text-xs text-gray-500">Pickup Date / Time</label>
              <input type="datetime-local" value={pickupDatetime ? pickupDatetime.slice(0, 16) : ''}
                onChange={e => setPickupDatetime(e.target.value || '')}
                className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-mcl-blue/40" />
            </div>
          </div>

          <div>
            <label className="text-xs text-gray-500">Notes</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
              className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-mcl-blue/40" />
          </div>
        </div>

        {/* ── Authorization Letter (client upload) ── */}
        <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
          <h3 className="font-semibold text-gray-700 text-sm">Authorization Letter (Client)</h3>
          <p className="text-xs text-gray-400">Upload the authorization letter provided by the client (PDF or image).</p>

          {authLetterUrl ? (
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-700 font-medium">{authLetterName || 'Authorization Letter'}</span>
              <a href={authLetterUrl} target="_blank" rel="noopener noreferrer"
                className="text-xs text-mcl-blue font-semibold hover:underline">
                View / Print
              </a>
              <label className="text-xs text-gray-400 hover:text-gray-600 cursor-pointer">
                Replace
                <input type="file" accept=".pdf,image/*" className="hidden" onChange={handleUploadAuthLetter} />
              </label>
            </div>
          ) : (
            <label className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-gray-300 text-sm cursor-pointer hover:border-mcl-blue hover:bg-blue-50/30 transition-colors ${uploadingLetter ? 'opacity-50 pointer-events-none' : ''}`}>
              <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              {uploadingLetter ? 'Uploading...' : 'Upload Authorization Letter'}
              <input type="file" accept=".pdf,image/*" className="hidden" onChange={handleUploadAuthLetter} />
            </label>
          )}
        </div>

        {/* ── Actions ── */}
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={() => handleSave(false)} disabled={saving}
            className="px-4 py-2 bg-mcl-blue text-white text-sm font-semibold rounded-lg hover:bg-mcl-blue/90 transition-colors disabled:opacity-50">
            {saving ? 'Saving...' : (docId ? 'Save' : 'Create PU')}
          </button>
          {docId && puStatus !== 'complete' && (
            <button onClick={() => handleSave(true)} disabled={saving}
              className="px-4 py-2 bg-emerald-600 text-white text-sm font-semibold rounded-lg hover:bg-emerald-700 transition-colors disabled:opacity-50">
              Mark Complete
            </button>
          )}
          <button onClick={handleViewPU}
            className="px-4 py-2 bg-white border border-gray-200 text-sm font-semibold rounded-lg hover:border-mcl-blue hover:text-mcl-blue transition-colors">
            View Pick Up Order
          </button>
        </div>

        {/* ── Driver Queue Modal ── */}
        {driverQueueModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setDriverQueueModal(false)}>
            <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 p-5" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-gray-800">Select Driver from Queue</h3>
                <button onClick={() => setDriverQueueModal(false)} className="text-gray-400 hover:text-gray-600 text-lg">&times;</button>
              </div>
              {driverQueueLoading ? (
                <div className="flex items-center justify-center py-10">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-mcl-blue" />
                </div>
              ) : driverQueueEntries.length === 0 ? (
                <p className="text-center text-gray-400 text-sm py-8">No drivers waiting in queue</p>
              ) : (
                <div className="space-y-2 max-h-80 overflow-y-auto">
                  {driverQueueEntries.map(entry => (
                    <button key={entry.id} onClick={() => selectDriver(entry)}
                      className="w-full text-left px-3 py-2 rounded-lg border border-gray-100 hover:border-mcl-blue hover:bg-blue-50/50 transition-colors">
                      <div className="font-semibold text-sm">{entry.driver_name}</div>
                      <div className="text-xs text-gray-400">{entry.vendor_name}{entry.plate ? ` — ${entry.plate}` : ''}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

      </div>
    </Layout>
  )
}
