import { useState, useEffect, useMemo } from 'react'
import {
  collection, query, where, onSnapshot, orderBy,
} from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import { AirfreightBooking, AirfreightClient, ChangeLogEntry } from '../../types'
import Layout from '../../components/Layout'

interface LogRow {
  id: string
  bookingId: string
  flightNumber: string
  clientName: string
  entry: ChangeLogEntry
}

function fmtDate(iso: string): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('en', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch { return iso }
}

export default function AirfreightActivityLog() {
  const { isAdmin, isSuperAgent, isAgent, isAccounting, isCounter, isBodega } = useAuth()
  const isMcl = isAdmin || isAccounting || isSuperAgent || isAgent || isCounter || isBodega

  const [clients, setClients] = useState<(AirfreightClient & { id: string })[]>([])
  const [selectedClientId, setSelectedClientId] = useState('')
  const [bookings, setBookings] = useState<(AirfreightBooking & { id: string })[]>([])
  const [loading, setLoading] = useState(false)

  // Date filters
  const defaultFrom = new Date()
  defaultFrom.setDate(defaultFrom.getDate() - 30)
  const [dateFrom, setDateFrom] = useState(defaultFrom.toLocaleDateString('en-CA'))
  const [dateTo, setDateTo] = useState('')

  // Load clients
  useEffect(() => {
    const q = query(collection(db, 'airfreight_clients'), orderBy('name'))
    const unsub = onSnapshot(q, snap => {
      setClients(snap.docs.map(d => ({ ...(d.data() as AirfreightClient), id: d.id })))
    })
    return () => unsub()
  }, [])

  // Load bookings for selected client
  useEffect(() => {
    if (!selectedClientId) { setBookings([]); return }
    setLoading(true)
    const q = query(
      collection(db, 'airfreight_bookings'),
      where('client_id', '==', selectedClientId),
    )
    const unsub = onSnapshot(q, snap => {
      setBookings(snap.docs.map(d => ({ ...(d.data() as AirfreightBooking), id: d.id })))
      setLoading(false)
    })
    return () => unsub()
  }, [selectedClientId])

  // Flatten all change_log entries + creation events into a single chronological list
  const logRows = useMemo(() => {
    const rows: LogRow[] = []
    for (const b of bookings) {
      const flightNum = b.flight_number || '—'

      // Add creation event
      if (b.created_at) {
        rows.push({
          id: `${b.id}-created`,
          bookingId: b.id || '',
          flightNumber: flightNum,
          clientName: b.client_name || '',
          entry: {
            changed_at: b.created_at,
            changed_by: b.created_by || 'Sistema',
            change_type: 'created',
            fields_changed: [{
              field: 'booking',
              label: 'Booking created',
              old_value: '',
              new_value: `${(b.awb_lines || []).length} AWBs, ${b.pieces || 0} pieces`,
            }],
          },
        })
      }

      // Add change_log entries
      for (let i = 0; i < (b.change_log || []).length; i++) {
        const entry = b.change_log[i]
        rows.push({
          id: `${b.id}-log-${i}`,
          bookingId: b.id || '',
          flightNumber: flightNum,
          clientName: b.client_name || '',
          entry,
        })
      }
    }

    // Sort by date descending
    rows.sort((a, b) => {
      const da = new Date(a.entry.changed_at).getTime() || 0
      const db_ = new Date(b.entry.changed_at).getTime() || 0
      return db_ - da
    })

    // Apply date filter
    return rows.filter(r => {
      const d = new Date(r.entry.changed_at)
      if (dateFrom && d < new Date(dateFrom)) return false
      if (dateTo && d > new Date(dateTo + 'T23:59:59')) return false
      return true
    })
  }, [bookings, dateFrom, dateTo])

  // Stats
  const uniqueUsers = useMemo(() => new Set(logRows.map(r => r.entry.changed_by)).size, [logRows])
  const totalChanges = logRows.filter(r => r.entry.change_type !== 'created').length
  const totalCreated = logRows.filter(r => r.entry.change_type === 'created').length

  const changeTypeLabel = (type: string) => {
    switch (type) {
      case 'created': return 'Created'
      case 'booking_update': return 'Updated'
      case 'flight_reassignment': return 'Reassignment'
      default: return type
    }
  }

  const changeTypeBadge = (type: string) => {
    switch (type) {
      case 'created':
        return 'bg-green-100 text-green-700'
      case 'flight_reassignment':
        return 'bg-blue-100 text-blue-700'
      case 'booking_update':
        return 'bg-amber-100 text-amber-700'
      default:
        return 'bg-gray-100 text-gray-600'
    }
  }

  if (!isMcl) return null

  const selectedClient = clients.find(c => c.id === selectedClientId)

  return (
    <Layout title="Activity Log" backTo="/airfreight/admin">
      <div className="space-y-4 max-w-5xl mx-auto">
        {/* Client selector + date filters */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[200px]">
              <label className="block text-xs font-semibold text-gray-500 mb-1">Client</label>
              <select
                value={selectedClientId}
                onChange={e => setSelectedClientId(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
              >
                <option value="">— Select a client —</option>
                {clients.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">From</label>
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">To</label>
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
                className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30" />
            </div>
          </div>
        </div>

        {/* Stats bar */}
        {selectedClientId && !loading && (
          <div className="flex gap-3">
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-4 py-3 flex-1 text-center">
              <div className="text-2xl font-bold text-mcl-blue">{logRows.length}</div>
              <div className="text-[10px] text-gray-400 uppercase tracking-wide">Events</div>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-4 py-3 flex-1 text-center">
              <div className="text-2xl font-bold text-green-600">{totalCreated}</div>
              <div className="text-[10px] text-gray-400 uppercase tracking-wide">Created</div>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-4 py-3 flex-1 text-center">
              <div className="text-2xl font-bold text-amber-600">{totalChanges}</div>
              <div className="text-[10px] text-gray-400 uppercase tracking-wide">Modifications</div>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-4 py-3 flex-1 text-center">
              <div className="text-2xl font-bold text-gray-700">{uniqueUsers}</div>
              <div className="text-[10px] text-gray-400 uppercase tracking-wide">Users</div>
            </div>
          </div>
        )}

        {/* Content */}
        {!selectedClientId ? (
          <div className="text-center py-16 text-gray-400 bg-white rounded-xl border border-gray-100">
            <svg className="w-12 h-12 mx-auto mb-3 text-gray-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
            <p className="text-sm">Select a client to view their activity history</p>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-mcl-blue" />
          </div>
        ) : logRows.length === 0 ? (
          <div className="text-center py-16 text-gray-400 bg-white rounded-xl border border-gray-100">
            <p className="text-sm">No activity recorded for {selectedClient?.name || 'this client'} in the selected range</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="overflow-auto max-h-[calc(100vh-380px)]">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-[11px] font-bold text-gray-500 uppercase tracking-wide border-b border-gray-200 sticky top-0 z-10">
                  <tr>
                    <th className="px-3 py-2 text-left min-w-[130px]">Date / Time</th>
                    <th className="px-3 py-2 text-left min-w-[180px]">User</th>
                    <th className="px-3 py-2 text-left min-w-[100px]">Type</th>
                    <th className="px-3 py-2 text-left min-w-[80px]">Flight</th>
                    <th className="px-3 py-2 text-left">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {logRows.map(row => (
                    <tr key={row.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                      <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{fmtDate(row.entry.changed_at)}</td>
                      <td className="px-3 py-2">
                        <span className="text-gray-700 font-medium">{row.entry.changed_by}</span>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full ${changeTypeBadge(row.entry.change_type)}`}>
                          {changeTypeLabel(row.entry.change_type)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-gray-600 font-mono">{row.flightNumber}</td>
                      <td className="px-3 py-2">
                        <div className="space-y-0.5">
                          {row.entry.fields_changed.map((f, i) => (
                            <div key={i} className="text-gray-600">
                              <span className="font-medium text-gray-700">{f.label}:</span>{' '}
                              {f.old_value && <span className="line-through text-gray-400">{f.old_value}</span>}
                              {f.old_value && ' → '}
                              <span className="text-gray-800">{f.new_value}</span>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Layout>
  )
}
