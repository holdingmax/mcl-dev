import { useState, useEffect } from 'react'
import { collection, query, where, orderBy, onSnapshot } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { DriverQueueEntry } from '../../types'
import Layout from '../../components/Layout'

function timeSince(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ${mins % 60}m`
}

export default function AirfreightDriverQueue() {
  const [entries, setEntries] = useState<(DriverQueueEntry & { id: string })[]>([])
  const [, setTick] = useState(0)

  useEffect(() => {
    const q = query(
      collection(db, 'driver_queue'),
      orderBy('created_at', 'asc'),
    )
    const unsub = onSnapshot(q, (snap) => {
      const docs = snap.docs.map(d => ({ ...d.data() as DriverQueueEntry, id: d.id }))
      setEntries(docs)
    })
    return unsub
  }, [])

  // Live counter refresh every 30s
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 30000)
    return () => clearInterval(interval)
  }, [])

  const waiting = entries.filter(e => e.status === 'waiting')
  const expired = entries.filter(e => e.status === 'expired')
  const linked = entries.filter(e => e.status === 'linked')

  return (
    <Layout title="Driver Queue" backTo="/airfreight">
      <div className="max-w-4xl mx-auto space-y-4">
        <p className="text-sm text-gray-500">{waiting.length} driver{waiting.length !== 1 ? 's' : ''} en espera</p>

        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-[10px] text-gray-500 uppercase">
                <th className="px-3 py-2 text-left">Driver</th>
                <th className="px-3 py-2 text-left">Company</th>
                <th className="px-3 py-2 text-left">Plate</th>
                <th className="px-3 py-2 text-left">Waiting</th>
                <th className="px-3 py-2 text-left">GPS</th>
                <th className="px-3 py-2 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {[...waiting, ...linked, ...expired].map(e => {
                const isExpired = e.status === 'expired' || new Date(e.expires_at) < new Date()
                return (
                  <tr key={e.id} className={`border-t border-gray-100 ${isExpired ? 'opacity-40' : ''}`}>
                    <td className="px-3 py-2 font-semibold">{e.driver_name}</td>
                    <td className="px-3 py-2">{e.vendor_name || '-'}</td>
                    <td className="px-3 py-2 font-mono">{e.plate || '-'}</td>
                    <td className="px-3 py-2">{timeSince(e.created_at)}</td>
                    <td className="px-3 py-2">
                      {e.gps ? (
                        <a
                          href={`https://maps.google.com/?q=${e.gps.lat},${e.gps.lng}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-mcl-blue hover:underline text-xs"
                        >
                          Ver mapa
                        </a>
                      ) : '-'}
                    </td>
                    <td className="px-3 py-2">
                      {e.status === 'linked' && <span className="text-[10px] bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-semibold">Linked</span>}
                      {e.status === 'waiting' && !isExpired && <span className="text-[10px] bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-semibold">Waiting</span>}
                      {(e.status === 'expired' || isExpired) && <span className="text-[10px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full font-semibold">Expired</span>}
                    </td>
                  </tr>
                )
              })}
              {entries.length === 0 && (
                <tr><td colSpan={6} className="text-center py-8 text-gray-400 text-sm">No hay drivers en cola</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  )
}
