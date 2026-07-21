import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { doc, getDoc, collection, query, where, getDocs } from 'firebase/firestore'
import { db, auth } from '../../lib/firebase'
import Layout from '../../components/Layout'
import { saveAvDeliveryOrder } from '../../lib/avDeliveryOrder'
import { logAvEventBatch } from '../../lib/avLog'
import type { AvFlight, AvPalletTag, AvDeliveryOrder } from '../../types'

type PtWithId = AvPalletTag & { id: string }

interface ResolvedUld {
  pt: PtWithId
  awbs: { awb_number: string; pieces: number; weight_kg: number }[]
  totalPieces: number
  totalKg: number
}

export default function AvDeliveryOrderNew() {
  const { id: flightId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)

  const [flight, setFlight] = useState<(AvFlight & { id: string }) | null>(null)
  const [allPalletTags, setAllPalletTags] = useState<PtWithId[]>([])
  const [uldInput, setUldInput] = useState('')
  const [resolvedUlds, setResolvedUlds] = useState<ResolvedUld[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingFlight, setLoadingFlight] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [savedDoNumber, setSavedDoNumber] = useState('')

  useEffect(() => {
    if (flightId) loadFlightData(flightId)
    inputRef.current?.focus()
  }, [flightId])

  async function loadFlightData(fId: string) {
    setLoadingFlight(true)
    const [fSnap, ptSnap] = await Promise.all([
      getDoc(doc(db, 'av_flights', fId)),
      getDocs(query(collection(db, 'av_pallet_tags'), where('flight_id', '==', fId))),
    ])
    if (!fSnap.exists()) { navigate('/avianca'); return }
    setFlight({ id: fSnap.id, ...fSnap.data() } as AvFlight & { id: string })
    setAllPalletTags(ptSnap.docs.map(d => ({ id: d.id, ...d.data() } as PtWithId)))
    setLoadingFlight(false)
  }

  function handleAddUld() {
    const raw = uldInput.replace(/\s+/g, '').toUpperCase()
    if (!raw) return
    setError('')

    if (resolvedUlds.some(r => r.pt.pallet_number.replace(/\s+/g, '').toUpperCase() === raw)) {
      setError('ULD ya agregado'); return
    }

    setLoading(true)
    const match = allPalletTags.find(pt => {
      const norm = pt.pallet_number.replace(/\s+/g, '').toUpperCase()
      return norm === raw || norm.endsWith(raw) || raw.endsWith(norm)
    })

    if (!match) { setError(`ULD "${raw}" no encontrado en este vuelo`); setLoading(false); return }
    if (match.ai_status !== 'complete') { setError(`ULD "${match.pallet_number}" aun no ha sido procesado por AI`); setLoading(false); return }
    if (resolvedUlds.some(r => r.pt.id === match.id)) { setError('ULD ya agregado'); setLoading(false); return }

    const awbs: ResolvedUld['awbs'] = []
    for (const line of (match.lines || [])) {
      const existing = awbs.find(a => a.awb_number === line.awb_number)
      if (existing) { existing.pieces += line.pieces; existing.weight_kg += line.weight_kg || 0 }
      else { awbs.push({ awb_number: line.awb_number, pieces: line.pieces, weight_kg: line.weight_kg || 0 }) }
    }

    setResolvedUlds(prev => [...prev, {
      pt: match, awbs,
      totalPieces: awbs.reduce((s, a) => s + a.pieces, 0),
      totalKg: awbs.reduce((s, a) => s + a.weight_kg, 0),
    }])
    setUldInput('')
    setLoading(false)
    inputRef.current?.focus()
  }

  function handleRemoveUld(ptId: string) {
    setResolvedUlds(prev => prev.filter(r => r.pt.id !== ptId))
  }

  const grandTotalPcs = resolvedUlds.reduce((s, r) => s + r.totalPieces, 0)
  const grandTotalKg = resolvedUlds.reduce((s, r) => s + r.totalKg, 0)
  const uniqueAwbs = new Set(resolvedUlds.flatMap(r => r.awbs.map(a => a.awb_number)))

  async function handleSave() {
    if (resolvedUlds.length === 0 || !flight) return
    setSaving(true)
    setError('')

    try {
      const doData: AvDeliveryOrder = {
        do_number: '',
        flight_id: flight.id,
        flight_number: flight.flight_number,
        date: new Date().toISOString(),
        status: 'draft',
        created_at: new Date().toISOString(),
        created_by: auth.currentUser?.email || '',
        awb_numbers: [...uniqueAwbs],
        uld_numbers: resolvedUlds.map(r => r.pt.pallet_number),
        trucking_company: '',
        driver_name: '',
        custody_method: 'seal',
        seal_number: '',
        mcl_agent: auth.currentUser?.email || '',
      }

      const docId = await saveAvDeliveryOrder(doData)
      const savedSnap = await getDoc(doc(db, 'av_delivery_orders', docId))
      const savedNum = savedSnap.exists() ? (savedSnap.data().do_number || '') : ''

      setSavedDoNumber(savedNum)
      setSaved(true)

      const uldList = resolvedUlds.map(u => u.pt.pallet_number).join(', ')
      if (flightId) logAvEventBatch(flightId, [...uniqueAwbs], 'do_created', `DO: ${savedNum} · ULDs: ${uldList} · Draft`, auth.currentUser?.email || '')
    } catch (err: any) {
      setError(err.message || 'Error guardando DO')
    } finally {
      setSaving(false)
    }
  }

  if (loadingFlight) return <Layout title="Nueva DO Avianca" backTo={`/avianca/flight/${flightId}`}><div className="flex justify-center py-20"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" /></div></Layout>

  return (
    <Layout title="Nueva DO Avianca" backTo={`/avianca/flight/${flightId}`}>
      <div className="max-w-3xl mx-auto px-3 sm:px-6 py-4 sm:py-6">
        {saved ? (
          <div className="bg-white rounded-xl border border-green-200 p-6 text-center space-y-4">
            <div className="w-16 h-16 mx-auto bg-green-100 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>
            </div>
            <p className="text-lg font-bold text-gray-800">DO Creada: {savedDoNumber}</p>
            <p className="text-sm text-gray-500">{resolvedUlds.length} ULD{resolvedUlds.length > 1 ? 's' : ''} / {uniqueAwbs.size} AWB{uniqueAwbs.size > 1 ? 's' : ''} / {grandTotalPcs} pcs / {Math.round(grandTotalKg)} kg</p>
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <p className="text-sm text-amber-700 font-medium">Status: Draft</p>
              <p className="text-xs text-amber-600 mt-1">Counter debe completar info de transporte y despachar desde la lista de DOs</p>
            </div>
            <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
              <button onClick={() => navigate(`/avianca/flight/${flightId}`)}
                className="px-5 py-2.5 bg-mcl-blue text-white rounded-lg font-medium hover:bg-blue-900">
                Volver al vuelo
              </button>
              <button onClick={() => navigate(`/avianca/flight/${flightId}/delivery-orders`)}
                className="px-5 py-2.5 border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-50">
                Ver DOs
              </button>
              <button onClick={() => { setResolvedUlds([]); setSaved(false); setSavedDoNumber(''); setUldInput('') }}
                className="px-5 py-2.5 border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-50">
                Crear Otra DO
              </button>
            </div>
          </div>
        ) : (
          <>
            {flight && (
              <div className="bg-gray-50 rounded-lg px-4 py-2 mb-4 flex items-center justify-between text-sm">
                <span className="font-bold text-gray-700">{flight.flight_number}</span>
                <span className="text-gray-500">{flight.destination} — {allPalletTags.length} ULDs disponibles</span>
              </div>
            )}

            {/* ULD Input */}
            <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4">
              <label className="block text-sm font-medium text-gray-600 mb-2">ULD Number</label>
              <div className="flex gap-2">
                <input
                  ref={inputRef}
                  type="text"
                  value={uldInput}
                  onChange={e => { setUldInput(e.target.value.toUpperCase()); setError('') }}
                  onKeyDown={e => { if (e.key === 'Enter') handleAddUld() }}
                  placeholder="Escanear o escribir ULD..."
                  className="flex-1 h-12 px-4 border-2 border-gray-200 rounded-xl text-lg font-mono focus:outline-none focus:border-mcl-blue"
                />
                <button onClick={handleAddUld} disabled={loading || !uldInput.trim()}
                  className="h-12 px-5 bg-mcl-blue text-white rounded-xl font-medium hover:bg-blue-900 disabled:opacity-50">
                  {loading ? (
                    <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                  ) : (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/></svg>
                  )}
                </button>
              </div>
              {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
            </div>

            {/* Summary bar */}
            {resolvedUlds.length > 0 && (
              <div className="grid grid-cols-4 gap-2 mb-4">
                {[
                  [resolvedUlds.length, 'ULDs'],
                  [uniqueAwbs.size, 'AWBs'],
                  [grandTotalPcs, 'Piezas'],
                  [Math.round(grandTotalKg), 'KG'],
                ].map(([val, label]) => (
                  <div key={String(label)} className="bg-blue-50 border border-blue-100 rounded-lg p-2 text-center">
                    <div className="text-lg font-bold text-mcl-blue">{val}</div>
                    <div className="text-xs text-gray-500">{label}</div>
                  </div>
                ))}
              </div>
            )}

            {/* ULD Cards */}
            <div className="space-y-3 mb-4">
              {resolvedUlds.map(r => (
                <div key={r.pt.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-100">
                    <span className="font-mono font-bold text-gray-800">{r.pt.pallet_number}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium text-gray-600">{r.totalPieces} pcs / {r.totalKg} kg</span>
                      <button onClick={() => handleRemoveUld(r.pt.id)} className="text-red-400 hover:text-red-600">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
                      </button>
                    </div>
                  </div>
                  <div className="divide-y divide-gray-50">
                    {r.awbs.map((a, i) => (
                      <div key={i} className="px-4 py-2 flex items-center justify-between">
                        <span className="font-mono text-sm text-gray-800">{a.awb_number}</span>
                        <span className="text-sm text-gray-600">{a.pieces} pcs / {a.weight_kg} kg</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              {resolvedUlds.length === 0 && (
                <div className="text-center py-12 text-gray-400">
                  <svg className="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
                  </svg>
                  <p>Escanea o escribe un ULD para comenzar</p>
                </div>
              )}
            </div>

            {/* Fixed bottom save button */}
            {resolvedUlds.length > 0 && (
              <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 p-3 sm:p-4 z-30">
                <div className="max-w-3xl mx-auto">
                  <button onClick={handleSave} disabled={saving}
                    className="w-full h-12 sm:h-11 bg-green-600 text-white rounded-xl font-bold text-base hover:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2">
                    {saving ? (
                      <>
                        <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                        Creando DO...
                      </>
                    ) : (
                      <>Crear DO ({resolvedUlds.length} ULD{resolvedUlds.length > 1 ? 's' : ''} / {uniqueAwbs.size} AWB{uniqueAwbs.size > 1 ? 's' : ''})</>
                    )}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Layout>
  )
}
