import { SyncAlert, markAlertsReviewed, fmtAlertTime } from '../lib/useSyncAlerts'

const ALERT_TYPE_LABELS: Record<string, { label: string; cls: string }> = {
  built_change: { label: 'built_change', cls: 'bg-red-100 text-red-700' },
  dispatched_change: { label: 'dispatched_change', cls: 'bg-red-100 text-red-700' },
  received_change: { label: 'received_change', cls: 'bg-amber-100 text-amber-700' },
  same_day_change: { label: 'same_day_change', cls: 'bg-blue-100 text-blue-700' },
  same_day_new: { label: 'same_day_new', cls: 'bg-blue-100 text-blue-700' },
  needs_review: { label: 'needs_review', cls: 'bg-amber-100 text-amber-700' },
  applied: { label: 'applied', cls: 'bg-green-100 text-green-700' },
  applied_new: { label: 'applied_new', cls: 'bg-green-100 text-green-700' },
  pending_resolved: { label: 'pending_resolved', cls: 'bg-green-100 text-green-700' },
  removed_from_sheet: { label: 'removed_from_sheet', cls: 'bg-gray-100 text-gray-700' },
  etd_inconsistency: { label: 'etd_inconsistency', cls: 'bg-orange-100 text-orange-700' },
}

// ── AWB-level popup ──

export function AwbAlertPopup({ alerts, onClose }: { alerts: SyncAlert[]; onClose: () => void }) {
  if (alerts.length === 0) return null
  const first = alerts[0]
  const awb = first.awb_2nd || first.awb_1st
  const isCritical = alerts.some(a => a.alert_type === 'built_change' || a.alert_type === 'dispatched_change')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-[480px] max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className={`flex items-center justify-between px-5 py-4 border-b rounded-t-2xl ${isCritical ? 'bg-red-50' : 'bg-amber-50'}`}>
          <div className="flex items-center gap-2">
            <svg className={`w-5 h-5 ${isCritical ? 'text-red-600' : 'text-amber-600'}`} fill="currentColor" viewBox="0 0 24 24">
              <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
            </svg>
            <h3 className={`font-bold text-sm ${isCritical ? 'text-red-800' : 'text-amber-800'}`}>Alerta Sync — AWB</h3>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="px-5 py-4 space-y-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="font-mono font-bold text-lg text-[#1e3a5f]">{awb}</span>
              {alerts.map((a, i) => {
                const t = ALERT_TYPE_LABELS[a.alert_type] || { label: a.alert_type, cls: 'bg-gray-100 text-gray-600' }
                return <span key={i} className={`text-xs px-2 py-0.5 rounded-full font-medium ${t.cls}`}>{t.label}</span>
              })}
            </div>
            <p className="text-xs text-gray-500">
              {first.client_name} &middot; Vuelo: <strong>{first.system_flight || first.flight_number}</strong>
            </p>
          </div>

          {isCritical && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-xs text-red-800 font-medium">
                La guia ya fue {alerts.some(a => a.alert_type === 'dispatched_change') ? 'despachada' : 'distribuida (Built)'}. Los cambios <strong>NO fueron aplicados</strong> automaticamente.
              </p>
            </div>
          )}
          {!isCritical && alerts.some(a => a.alert_type === 'received_change') && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <p className="text-xs text-amber-800 font-medium">
                La guia ya tiene recepcion documental/fisica. Los cambios criticos <strong>NO fueron aplicados</strong> automaticamente.
              </p>
            </div>
          )}
          {!isCritical && alerts.some(a => a.alert_type === 'same_day_change') && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
              <p className="text-xs text-blue-800 font-medium">
                Cambio en guia del mismo dia. Requiere revision manual.
              </p>
            </div>
          )}

          {/* Diff tables — one per alert */}
          {alerts.filter(a => a.diffs && a.diffs.length > 0).map((a, ai) => (
            <div key={ai}>
              <h4 className="text-[10px] font-bold text-gray-400 uppercase mb-2">Cambios detectados</h4>
              <table className="w-full text-xs border border-gray-200 rounded-lg overflow-hidden">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-2 text-left text-gray-500 font-medium">Campo</th>
                    <th className="px-3 py-2 text-left text-gray-500 font-medium">En sistema</th>
                    <th className="px-3 py-2 text-left text-gray-500 font-medium">Planilla cliente</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {a.diffs.map((d, di) => (
                    <tr key={di}>
                      <td className="px-3 py-2 font-medium text-gray-700">{d.field}</td>
                      <td className="px-3 py-2 text-gray-500 line-through">{String(d.old_value ?? '—')}</td>
                      <td className="px-3 py-2 text-red-600 font-bold">{String(d.new_value ?? '—')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          <p className="text-[10px] text-gray-400">
            Detectado: {fmtAlertTime(alerts[0].created_at)}
          </p>
        </div>

        {/* Actions */}
        <div className="px-5 py-4 border-t bg-gray-50 rounded-b-2xl flex gap-2">
          <button onClick={onClose}
            className="flex-1 px-4 py-2.5 bg-gray-200 text-gray-600 text-xs font-bold rounded-lg hover:bg-gray-300">
            Cerrar
          </button>
          <button
            onClick={async () => {
              await markAlertsReviewed(alerts.map(a => a.id))
              onClose()
            }}
            className="flex-1 px-4 py-2.5 bg-amber-600 text-white text-xs font-bold rounded-lg hover:bg-amber-700">
            Marcar revisada
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Flight-level popup ──

export function FlightAlertPopup({
  flightNumber,
  airline,
  dest,
  etd,
  totalAwbs,
  alerts,
  onClose,
}: {
  flightNumber: string
  airline: string
  dest: string
  etd: string
  totalAwbs: number
  alerts: SyncAlert[]
  onClose: () => void
}) {
  if (alerts.length === 0) return null

  // Categorize alerts
  const builtOrDispatched = alerts.filter(a => a.alert_type === 'built_change' || a.alert_type === 'dispatched_change')
  const received = alerts.filter(a => a.alert_type === 'received_change' || a.alert_type === 'needs_review')
  const sameDay = alerts.filter(a => a.alert_type === 'same_day_change' || a.alert_type === 'same_day_new')
  const applied = alerts.filter(a => a.alert_type === 'applied' || a.alert_type === 'applied_new' || a.alert_type === 'pending_resolved')

  // Group data modifications by AWB
  const modifiedByAwb = new Map<string, SyncAlert[]>()
  for (const a of [...received, ...sameDay, ...builtOrDispatched]) {
    const key = a.awb_2nd || a.awb_1st || ''
    if (!modifiedByAwb.has(key)) modifiedByAwb.set(key, [])
    modifiedByAwb.get(key)!.push(a)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-[580px] max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b bg-amber-50 rounded-t-2xl">
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 text-amber-600" fill="currentColor" viewBox="0 0 24 24">
              <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
            </svg>
            <div>
              <h3 className="font-bold text-sm text-amber-800">Alertas Sync — Vuelo {flightNumber}</h3>
              <p className="text-[10px] text-amber-600 mt-0.5">{airline} &middot; {dest} &middot; ETD {etd} &middot; {totalAwbs} AWBs</p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Summary bar */}
        <div className="px-5 py-3 border-b bg-white flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-bold text-gray-400 uppercase">Resumen:</span>
          {builtOrDispatched.length > 0 && (
            <span className="text-[10px] font-semibold bg-red-50 text-red-700 px-2 py-0.5 rounded-full">
              {builtOrDispatched.length} bloqueadas
            </span>
          )}
          {received.length > 0 && (
            <span className="text-[10px] font-semibold bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full">
              {received.length} con recepcion
            </span>
          )}
          {sameDay.length > 0 && (
            <span className="text-[10px] font-semibold bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full">
              {sameDay.length} mismo dia
            </span>
          )}
          {applied.length > 0 && (
            <span className="text-[10px] font-semibold bg-green-50 text-green-700 px-2 py-0.5 rounded-full">
              {applied.length} aplicadas
            </span>
          )}
        </div>

        {/* Content — changes grouped by AWB */}
        <div className="px-5 py-4 space-y-3">
          {Array.from(modifiedByAwb.entries()).map(([awb, awbAlerts]) => {
            const isCritical = awbAlerts.some(a => a.alert_type === 'built_change' || a.alert_type === 'dispatched_change')
            const borderColor = isCritical ? 'border-red-200' : 'border-amber-200'
            const bgColor = isCritical ? 'bg-red-50' : 'bg-amber-50'
            const textColor = isCritical ? 'text-red-800' : 'text-amber-800'
            const iconColor = isCritical ? 'text-red-600' : 'text-amber-600'

            const allDiffs = awbAlerts.flatMap(a => a.diffs || [])

            return (
              <div key={awb} className={`border ${borderColor} rounded-xl overflow-hidden`}>
                <div className={`flex items-center gap-2 px-4 py-2.5 flex-wrap ${bgColor}`}>
                  <svg className={`w-4 h-4 ${iconColor}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                  <span className={`text-xs font-bold ${textColor}`}>
                    {isCritical ? 'Bloqueado' : 'Modificado'}
                  </span>
                  <span className="font-mono text-xs text-gray-700">{awb}</span>
                  <span className="text-[10px] text-gray-500">{awbAlerts[0].client_name}</span>
                  {awbAlerts.map((a, i) => {
                    const t = ALERT_TYPE_LABELS[a.alert_type]
                    return <span key={i} className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${t?.cls || ''}`}>{t?.label || a.alert_type}</span>
                  })}
                  <span className="ml-auto text-[10px] text-gray-400">{fmtAlertTime(awbAlerts[0].created_at)}</span>
                </div>
                {allDiffs.length > 0 && (
                  <div className="px-4 py-3 bg-white">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-[10px] text-gray-400 uppercase">
                          <th className="text-left pb-1.5 font-medium">Campo</th>
                          <th className="text-left pb-1.5 font-medium">En sistema</th>
                          <th className="text-left pb-1.5 font-medium">Planilla cliente</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {allDiffs.map((d, di) => (
                          <tr key={di}>
                            <td className="py-1.5 font-medium text-gray-700">{d.field}</td>
                            <td className="py-1.5 text-gray-500 line-through">{String(d.old_value ?? '—')}</td>
                            <td className="py-1.5 text-red-600 font-bold">{String(d.new_value ?? '—')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })}

          {/* Applied alerts (collapsed) */}
          {applied.length > 0 && (
            <div className="border border-green-200 rounded-xl overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-2.5 bg-green-50">
                <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-xs font-bold text-green-800">Cambios aplicados automaticamente</span>
                <span className="bg-green-100 text-green-700 text-[10px] font-bold px-1.5 py-0.5 rounded-full">{applied.length}</span>
              </div>
              <div className="px-4 py-2 bg-white space-y-1">
                {applied.map((a, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs text-gray-600">
                    <span className="font-mono font-medium">{a.awb_2nd || a.awb_1st}</span>
                    <span className="text-gray-400">&middot;</span>
                    <span>{a.diffs?.map(d => d.field).join(', ')}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="px-5 py-4 border-t bg-gray-50 rounded-b-2xl flex gap-2">
          <button onClick={onClose}
            className="flex-1 px-4 py-2.5 bg-gray-200 text-gray-600 text-xs font-bold rounded-lg hover:bg-gray-300">
            Cerrar
          </button>
          <button
            onClick={async () => {
              await markAlertsReviewed(alerts.filter(a => a.status === 'pending').map(a => a.id))
              onClose()
            }}
            className="flex-1 px-4 py-2.5 bg-amber-600 text-white text-xs font-bold rounded-lg hover:bg-amber-700">
            Marcar todas revisadas
          </button>
        </div>
      </div>
    </div>
  )
}
