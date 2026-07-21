import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { doc, getDoc, addDoc, updateDoc, collection, getDocs, query, where } from 'firebase/firestore'
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage, auth } from '../../lib/firebase'
import Layout from '../../components/Layout'
import { useAvCan } from '../../lib/avPermissions'
import type { AvFlight, AvFlightAwb, AvManifestCheck } from '../../types'

type AwbWithId = AvFlightAwb & { id: string }
type CheckWithId = AvManifestCheck & { id: string }

export default function AvCheckManifest() {
  const { id } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const preselectedAwb = searchParams.get('awb') || ''
  const navigate = useNavigate()
  const { canAv } = useAvCan()
  const [flight, setFlight] = useState<(AvFlight & { id: string }) | null>(null)
  const [awbs, setAwbs] = useState<AwbWithId[]>([])
  const [checks, setChecks] = useState<CheckWithId[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState<string | null>(null)
  const [resolving, setResolving] = useState<CheckWithId | null>(null)
  const [resolveNote, setResolveNote] = useState('')
  const [savingResolve, setSavingResolve] = useState(false)
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({})

  useEffect(() => {
    if (id) loadData(id)
  }, [id])

  // Auto-reload when checks are processing
  useEffect(() => {
    const hasPending = checks.some(c => c.ai_status === 'pending' || c.ai_status === 'processing')
    if (!hasPending || !id) return
    const interval = setInterval(() => loadData(id), 5000)
    return () => clearInterval(interval)
  }, [checks, id])

  async function loadData(flightId: string) {
    setLoading(true)
    const [flightSnap, awbSnap, checkSnap] = await Promise.all([
      getDoc(doc(db, 'av_flights', flightId)),
      getDocs(query(collection(db, 'av_flight_awbs'), where('flight_id', '==', flightId))),
      getDocs(query(collection(db, 'av_manifest_checks'), where('flight_id', '==', flightId))),
    ])
    if (!flightSnap.exists()) { navigate('/avianca'); return }
    setFlight({ id: flightSnap.id, ...flightSnap.data() } as AvFlight & { id: string })
    setAwbs(awbSnap.docs.map(d => ({ id: d.id, ...d.data() } as AwbWithId)).filter(a => a.status !== 'removed').sort((a, b) => a.awb_number.localeCompare(b.awb_number)))
    setChecks(checkSnap.docs.map(d => ({ id: d.id, ...d.data() } as CheckWithId)))
    setLoading(false)
  }

  async function handleUpload(awb: AwbWithId, file: File) {
    if (!flight) return
    setUploading(awb.id)
    const path = `avianca/${flight.id}/manifests/${awb.id}_${Date.now()}_${file.name}`
    const sRef = storageRef(storage, path)
    await uploadBytes(sRef, file)
    const url = await getDownloadURL(sRef)

    await addDoc(collection(db, 'av_manifest_checks'), {
      flight_id: flight.id,
      awb_id: awb.id,
      awb_number: awb.awb_number,
      doc_url: url,
      doc_filename: file.name,
      status: 'pending',
      flagged_keywords: [],
      ai_status: 'pending',
      created_at: new Date().toISOString(),
      created_by: auth.currentUser?.email || '',
    })

    setUploading(null)
    if (id) loadData(id)
  }

  async function handleResolve() {
    if (!resolving || !resolveNote.trim()) return
    setSavingResolve(true)
    await updateDoc(doc(db, 'av_manifest_checks', resolving.id), {
      status: 'resolved',
      resolved_by: auth.currentUser?.email || '',
      resolved_at: new Date().toISOString(),
      resolved_note: resolveNote.trim(),
    })
    // Update AWB manifest_status
    if (resolving.awb_id) {
      await updateDoc(doc(db, 'av_flight_awbs', resolving.awb_id), {
        manifest_status: 'resolved',
        updated_at: new Date().toISOString(),
      })
    }
    setResolving(null)
    setResolveNote('')
    setSavingResolve(false)
    if (id) loadData(id)
  }

  function getAwbCheck(awbId: string) {
    return checks.find(c => c.awb_id === awbId)
  }

  function statusBadge(status: string) {
    switch (status) {
      case 'clear': return <span className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold bg-green-100 text-green-700">Clear</span>
      case 'flagged': return <span className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-700">Flagged</span>
      case 'resolved': return <span className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold bg-green-100 text-green-700">Resolved</span>
      case 'processing': return <span className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-100 text-blue-700">Procesando...</span>
      case 'pending': return <span className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold bg-gray-100 text-gray-500">Pendiente AI</span>
      default: return <span className="text-gray-300">—</span>
    }
  }

  const checkedCount = awbs.filter(a => {
    const c = getAwbCheck(a.id)
    return c && (c.status === 'clear' || c.status === 'resolved') || a.manifest_status === 'na'
  }).length

  if (loading || !flight) return <Layout title="Check Manifest" backTo={`/avianca/flight/${id}`}><div className="flex justify-center py-20"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" /></div></Layout>

  return (
    <Layout title="Check Manifest" backTo={`/avianca/flight/${id}`}>
      {/* Header */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-800">{flight.flight_number} — Check Manifest</h2>
            <p className="text-xs text-gray-400 mt-1">Revision de manifiestos para deteccion de Dangerous Goods</p>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold text-gray-800">{checkedCount}<span className="text-gray-400 text-lg font-normal">/{awbs.length}</span></div>
            <div className="text-[10px] text-gray-400 uppercase font-semibold">AWBs Checked</div>
          </div>
        </div>
      </div>

      {/* AWBs List */}
      <div className="space-y-3">
        {awbs.map(awb => {
          const check = getAwbCheck(awb.id)
          const isNA = awb.manifest_status === 'na'
          const isPreselected = preselectedAwb === awb.id

          return (
            <div key={awb.id} className={`bg-white rounded-xl shadow-sm border p-4 ${isPreselected && !check ? 'border-mcl-blue ring-2 ring-mcl-blue/20' : 'border-gray-100'}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="font-mono font-semibold text-gray-800">{awb.awb_number}</span>
                  {check ? statusBadge(check.status) : isNA ? (
                    <span className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold bg-gray-100 text-gray-400">N/A</span>
                  ) : null}
                  {awb.pieces > 0 && <span className="text-xs text-gray-400">{awb.pieces} pcs</span>}
                </div>
                <div className="flex items-center gap-2">
                  {check?.doc_url && (
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-full bg-green-500 cursor-pointer"
                      title="Ver manifiesto"
                      onClick={() => window.open(check.doc_url, '_blank')}
                    />
                  )}
                  {canAv('check_manifest') &&!check && !isNA && (
                    <label className={`bg-mcl-blue text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-blue-900 cursor-pointer flex items-center gap-1.5 ${uploading === awb.id ? 'opacity-50 pointer-events-none' : ''}`}>
                      {uploading === awb.id ? (
                        <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-white" />
                      ) : (
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                      )}
                      Subir MAN
                      <input
                        ref={el => { fileInputRefs.current[awb.id] = el }}
                        type="file"
                        accept=".pdf,image/*"
                        className="hidden"
                        onChange={e => {
                          const file = e.target.files?.[0]
                          if (file) handleUpload(awb, file)
                          e.target.value = ''
                        }}
                      />
                    </label>
                  )}
                </div>
              </div>

              {/* Flagged keywords detail */}
              {check?.status === 'flagged' && check.flagged_keywords && check.flagged_keywords.length > 0 && (
                <div className="mt-3 bg-amber-50 rounded-lg p-3 border border-amber-200">
                  <div className="text-xs font-semibold text-amber-700 mb-2">Keywords detectados:</div>
                  <div className="space-y-1.5">
                    {check.flagged_keywords.map((kw, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold ${kw.severity === 'critical' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                          {kw.severity === 'critical' ? 'CRITICAL' : 'WARNING'}
                        </span>
                        <div>
                          <span className="font-semibold text-gray-800">{kw.term}</span>
                          <span className="text-gray-400 ml-1">({kw.category})</span>
                          {(kw.page || kw.reference) && (
                            <span className="ml-2 text-[10px] font-mono bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                              {kw.page ? `Pag. ${kw.page}` : ''}{kw.page && kw.reference ? ' — ' : ''}{kw.reference || ''}
                            </span>
                          )}
                          <p className="text-gray-500 mt-0.5 italic">"{kw.context}"</p>
                        </div>
                      </div>
                    ))}
                  </div>
                  {check.ai_summary && (
                    <p className="text-xs text-gray-500 mt-2 border-t border-amber-200 pt-2">{check.ai_summary}</p>
                  )}
                  {canAv('check_manifest') &&(
                    <button
                      onClick={() => { setResolving(check); setResolveNote('') }}
                      className="mt-3 bg-green-600 text-white px-4 py-1.5 rounded-lg text-xs font-medium hover:bg-green-700"
                    >
                      Marcar como resuelto
                    </button>
                  )}
                </div>
              )}

              {/* Resolved detail */}
              {check?.status === 'resolved' && (
                <div className="mt-3 bg-green-50 rounded-lg p-3 border border-green-200 text-xs text-green-700">
                  <span className="font-semibold">Resuelto</span> por {check.resolved_by} — {check.resolved_note}
                </div>
              )}

              {/* Clear with summary */}
              {check?.status === 'clear' && check.ai_summary && (
                <div className="mt-2 text-xs text-gray-400 italic">{check.ai_summary}</div>
              )}

              {/* Processing spinner */}
              {check && (check.ai_status === 'pending' || check.ai_status === 'processing') && (
                <div className="mt-2 flex items-center gap-2 text-xs text-amber-600">
                  <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-amber-500" />
                  AI procesando manifiesto...
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Resolve Modal */}
      {resolving && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setResolving(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-gray-100">
              <h3 className="font-bold text-gray-800 text-lg">Marcar como resuelto</h3>
              <p className="text-xs text-gray-400 mt-1">AWB {resolving.awb_number} — Confirmar que la carga fue corregida</p>
            </div>
            <div className="px-6 py-5">
              <label className="text-xs font-semibold text-gray-500 uppercase block mb-2">Comentario (obligatorio)</label>
              <textarea
                value={resolveNote}
                onChange={e => setResolveNote(e.target.value)}
                placeholder="Ej: Se retiro el producto X de la carga, AWB apta para volar"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30 h-24 resize-none"
                autoFocus
              />
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
              <button onClick={() => setResolving(null)} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">Cancelar</button>
              <button
                onClick={handleResolve}
                disabled={savingResolve || !resolveNote.trim()}
                className="bg-green-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50"
              >
                {savingResolve ? 'Guardando...' : 'Confirmar resuelto'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}
