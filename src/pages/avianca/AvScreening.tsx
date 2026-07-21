import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { doc, getDoc, addDoc, onSnapshot, collection, getDocs, query, where, deleteDoc } from 'firebase/firestore'
import { db, auth } from '../../lib/firebase'
import Layout from '../../components/Layout'
import { useAvCan } from '../../lib/avPermissions'
import type { AvFlight, AvPalletTag, AvScreeningCert } from '../../types'

type PtWithId = AvPalletTag & { id: string }
type CertWithId = AvScreeningCert & { id: string }
type DateMode = 'since_last_run' | 'today' | 'last_24h' | 'custom'

export default function AvScreening() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { canAv } = useAvCan()
  const [flight, setFlight] = useState<(AvFlight & { id: string }) | null>(null)
  const [palletTags, setPalletTags] = useState<PtWithId[]>([])
  const [certs, setCerts] = useState<CertWithId[]>([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [lastRun, setLastRun] = useState<string | null>(null)
  const [deletingCertId, setDeletingCertId] = useState<string | null>(null)
  const [showRunModal, setShowRunModal] = useState(false)
  const [dateMode, setDateMode] = useState<DateMode>('since_last_run')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [reprocessFailed, setReprocessFailed] = useState(false)
  const [runResult, setRunResult] = useState<any>(null)

  useEffect(() => {
    if (id) loadData(id)
    loadSettings()
  }, [id])

  async function loadData(flightId: string) {
    setLoading(true)
    const [flightSnap, ptSnap, certSnap] = await Promise.all([
      getDoc(doc(db, 'av_flights', flightId)),
      getDocs(query(collection(db, 'av_pallet_tags'), where('flight_id', '==', flightId))),
      getDocs(query(collection(db, 'av_screening_certs'), where('flight_id', '==', flightId))),
    ])
    if (!flightSnap.exists()) { navigate('/avianca'); return }
    setFlight({ id: flightSnap.id, ...flightSnap.data() } as AvFlight & { id: string })
    setPalletTags(ptSnap.docs.map(d => ({ id: d.id, ...d.data() } as PtWithId)).sort((a, b) => a.pallet_number.localeCompare(b.pallet_number)))
    setCerts(certSnap.docs.map(d => ({ id: d.id, ...d.data() } as CertWithId)).sort((a, b) => (a.screening_date || '').localeCompare(b.screening_date || '')))
    setLoading(false)
  }

  async function loadSettings() {
    const snap = await getDoc(doc(db, 'av_screening_settings', 'config'))
    if (snap.exists()) {
      const data = snap.data()
      setLastRun(data.last_run || null)
    }
  }

  async function runManual() {
    setRunning(true)
    setRunResult(null)
    setShowRunModal(false)
    try {
      const triggerRef = await addDoc(collection(db, 'av_screening_triggers'), {
        triggered_by: auth.currentUser?.email || '',
        triggered_at: new Date().toISOString(),
        status: 'pending',
        date_mode: dateMode,
        from_date: dateMode === 'custom' ? fromDate : null,
        to_date: dateMode === 'custom' ? toDate : null,
        reprocess_failed: reprocessFailed,
      })
      const unsub = onSnapshot(doc(db, 'av_screening_triggers', triggerRef.id), (snap) => {
        const data = snap.data()
        if (!data) return
        if (data.status === 'done' || data.status === 'error') {
          unsub()
          if (data.status === 'error') {
            setRunResult({ error: data.error || 'unknown' })
          } else {
            setRunResult(data.result || { status: 'success' })
          }
          if (id) loadData(id)
          loadSettings()
          setRunning(false)
        }
      })
      setTimeout(() => { unsub(); setRunning(false) }, 180000)
    } catch (err: any) {
      alert('Error: ' + (err.message || err))
      setRunning(false)
    }
  }

  async function deleteCert(certId: string) {
    await deleteDoc(doc(db, 'av_screening_certs', certId))
    setCerts(prev => prev.filter(c => c.id !== certId))
    setDeletingCertId(null)
  }

  const screenedPts = palletTags.filter(pt => pt.screened)
  const totalPts = palletTags.length

  if (loading || !flight) return <Layout title="Screening" backTo={`/avianca/flight/${id}`}><div className="flex justify-center py-20"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" /></div></Layout>

  return (
    <Layout title="Screening" backTo={`/avianca/flight/${id}`}>
      {/* Run Agent Modal */}
      {showRunModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl border border-gray-200 p-6 w-full max-w-md mx-4">
            <h3 className="text-lg font-bold text-gray-800 mb-4">Correr Agente Screening</h3>

            <div className="space-y-2 mb-4">
              {([
                ['since_last_run', 'Desde ultima corrida'],
                ['today', 'Hoy'],
                ['last_24h', 'Ultimas 24 horas'],
                ['custom', 'Rango personalizado'],
              ] as [DateMode, string][]).map(([val, label]) => (
                <label key={val} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio" name="date_mode" value={val}
                    checked={dateMode === val}
                    onChange={() => setDateMode(val)}
                    className="text-mcl-blue focus:ring-mcl-blue"
                  />
                  <span className="text-sm text-gray-700">{label}</span>
                </label>
              ))}
            </div>

            {dateMode === 'custom' && (
              <div className="flex gap-2 mb-4 pl-6">
                <input
                  type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
                  className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm w-full"
                  placeholder="Desde"
                />
                <input
                  type="date" value={toDate} onChange={e => setToDate(e.target.value)}
                  className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm w-full"
                  placeholder="Hasta"
                />
              </div>
            )}

            <label className="flex items-center gap-2 cursor-pointer mb-5 pl-1">
              <input
                type="checkbox" checked={reprocessFailed}
                onChange={e => setReprocessFailed(e.target.checked)}
                className="rounded text-mcl-blue focus:ring-mcl-blue"
              />
              <span className="text-sm text-gray-700">Re-procesar emails fallidos</span>
            </label>

            {lastRun && (
              <p className="text-xs text-gray-400 mb-4">
                Ultima corrida: {new Date(lastRun).toLocaleString()}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowRunModal(false)}
                className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
              >
                Cancelar
              </button>
              <button
                onClick={runManual}
                disabled={dateMode === 'custom' && !fromDate}
                className="bg-mcl-blue text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-900 disabled:opacity-50"
              >
                Ejecutar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-800">{flight.flight_number} — Screening</h2>
            <p className="text-xs text-gray-400 mt-1">
              {lastRun ? `Ultima corrida: ${new Date(lastRun).toLocaleString()}` : 'Agente no ha corrido aun'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <div className="text-2xl font-bold text-gray-800">{screenedPts.length}<span className="text-gray-400 text-lg font-normal">/{totalPts}</span></div>
              <div className="text-[10px] text-gray-400 uppercase font-semibold">ULDs Screened</div>
            </div>
            {canAv('screening') && (
              <button
                onClick={() => { setRunResult(null); setShowRunModal(true) }}
                disabled={running}
                className="bg-mcl-blue text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-900 disabled:opacity-50 flex items-center gap-2"
              >
                {running ? (
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                )}
                {running ? 'Corriendo...' : 'Correr Agente'}
              </button>
            )}
          </div>
        </div>
        {/* Run result banner */}
        {runResult && (
          <div className={`mt-3 rounded-lg px-4 py-2.5 text-sm ${runResult.error ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-green-50 text-green-700 border border-green-200'}`}>
            {runResult.error ? (
              <span>Error: {runResult.error}</span>
            ) : (
              <span>
                {runResult.count || 0} email{(runResult.count || 0) !== 1 ? 's' : ''} procesado{(runResult.count || 0) !== 1 ? 's' : ''}
                {runResult.reprocessed > 0 && ` · ${runResult.reprocessed} reprocesado${runResult.reprocessed !== 1 ? 's' : ''}`}
                {runResult.flightsRecalculated > 0 && ` · ${runResult.flightsRecalculated} vuelo${runResult.flightsRecalculated !== 1 ? 's' : ''} actualizado${runResult.flightsRecalculated !== 1 ? 's' : ''}`}
              </span>
            )}
          </div>
        )}
      </div>

      {/* ULD Screening Status */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 mb-6">
        <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-4">
          Estado por ULD <span className="text-gray-400 font-normal">({totalPts})</span>
        </h3>
        {totalPts === 0 ? (
          <p className="text-center text-gray-400 py-6 text-sm">No hay Pallet Tags subidos aun.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {palletTags.map(pt => {
              const ptCerts = certs.filter(c => c.status !== 'duplicate' && c.status !== 'no_uld_lines' && ((c as any).uld_lines || []).some((ul: any) => ul.pallet_number === pt.pallet_number && ul.matched))
              return (
                <div key={pt.id} className={`rounded-lg border p-3 ${pt.screened ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-gray-50'}`}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-mono font-semibold text-sm text-gray-800">{pt.pallet_number}</span>
                    {pt.screened ? (
                      <span className="text-green-600 font-bold text-sm">✓</span>
                    ) : (
                      <span className="text-red-400 font-bold text-sm">✗</span>
                    )}
                  </div>
                  <div className="text-[10px] text-gray-400">
                    {pt.total_pieces} pcs — {pt.lines?.length || 0} AWBs
                  </div>
                  {ptCerts.length > 0 && (
                    <div className="mt-1.5 text-[10px] text-green-600">
                      {ptCerts.length} cert{ptCerts.length > 1 ? 's' : ''} — {ptCerts[0].screener_name || 'Phantom K9'}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Screening Certificates */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
        <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-4">
          Certificados <span className="text-gray-400 font-normal">({certs.filter(c => c.status !== 'duplicate' && c.status !== 'no_uld_lines').length})</span>
        </h3>
        {certs.filter(c => c.status !== 'duplicate' && c.status !== 'no_uld_lines').length === 0 ? (
          <p className="text-center text-gray-400 py-6 text-sm">No hay certificados de screening para este vuelo.</p>
        ) : (
          <div className="space-y-3">
            {certs.filter(c => c.status !== 'duplicate' && c.status !== 'no_uld_lines').map(cert => {
              const uldLines: any[] = (cert as any).uld_lines || []
              const statusColor = cert.status === 'matched' ? 'bg-green-100 text-green-700' : cert.status === 'partial' ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'
              const statusLabel = cert.status === 'matched' ? 'Matched' : cert.status === 'partial' ? 'Parcial' : 'Unmatched'
              return (
                <div key={cert.id} className="border border-gray-200 rounded-lg p-4 hover:bg-gray-50">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1.5">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${statusColor}`}>{statusLabel}</span>
                        <span className="text-xs font-semibold text-gray-800">{cert.screener_name || cert.screener_company || 'Phantom K9'}</span>
                        <span className="text-xs text-gray-400">·</span>
                        <span className="text-xs text-gray-500">{cert.screening_date} {cert.screening_time || ''}</span>
                        {(cert as any).mcl_representant && (
                          <>
                            <span className="text-xs text-gray-400">·</span>
                            <span className="text-xs text-gray-500">MCL: {(cert as any).mcl_representant}</span>
                          </>
                        )}
                        {(cert as any).tsa_entry && (
                          <>
                            <span className="text-xs text-gray-400">·</span>
                            <span className="text-xs text-blue-600 font-medium">{(cert as any).tsa_entry}</span>
                          </>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        {uldLines.map((ul: any, i: number) => (
                          <span key={i} className={`inline-block px-2 py-0.5 rounded text-[11px] font-mono ${ul.matched ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-gray-100 text-gray-600 border border-gray-200'}`}>
                            {ul.pallet_number}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {cert.doc_url ? (
                        <button
                          onClick={() => window.open(cert.doc_url, '_blank')}
                          className="text-green-600 hover:text-green-800"
                          title="Ver certificado PDF"
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                        </button>
                      ) : (
                        <span className="text-gray-300 w-5 h-5 flex items-center justify-center">—</span>
                      )}
                      {canAv('screening') && (deletingCertId === cert.id ? (
                        <div className="flex items-center gap-1">
                          <button onClick={() => deleteCert(cert.id)} className="text-red-600 text-[10px] font-bold">Si</button>
                          <button onClick={() => setDeletingCertId(null)} className="text-gray-400 text-[10px]">No</button>
                        </div>
                      ) : (
                        <button onClick={() => setDeletingCertId(cert.id)} className="text-gray-400 hover:text-red-500">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </Layout>
  )
}
