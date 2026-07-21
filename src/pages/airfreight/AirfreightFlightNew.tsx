import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { collection, addDoc, getDocs } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { useAuth } from '../../contexts/AuthContext'
import { AirfreightDestination } from '../../types'
import Layout from '../../components/Layout'

const AIRLINES = [
  'American Airlines', 'United Airlines', 'Delta Air Lines', 'LATAM',
  'Avianca', 'Copa Airlines', 'Amerijet', 'Atlas Air', 'Otra',
]

// Principales aeropuertos Centro y Sudamérica
const DEFAULT_AIRPORTS: { code: string; name: string }[] = [
  // Centroamérica y Caribe
  { code: 'PTY', name: 'Ciudad de Panamá' },
  { code: 'GUA', name: 'Ciudad de Guatemala' },
  { code: 'SAL', name: 'San Salvador' },
  { code: 'SJO', name: 'San José, Costa Rica' },
  { code: 'MGA', name: 'Managua' },
  { code: 'TGU', name: 'Tegucigalpa' },
  { code: 'BZE', name: 'Belice' },
  { code: 'SDQ', name: 'Santo Domingo' },
  { code: 'SJU', name: 'San Juan, Puerto Rico' },
  { code: 'HAV', name: 'La Habana' },
  { code: 'POS', name: 'Port of Spain' },
  { code: 'CUR', name: 'Curazao' },
  { code: 'MBJ', name: 'Montego Bay' },
  // Colombia
  { code: 'BOG', name: 'Bogotá' },
  { code: 'MDE', name: 'Medellín' },
  { code: 'CLO', name: 'Cali' },
  { code: 'CTG', name: 'Cartagena' },
  { code: 'BAQ', name: 'Barranquilla' },
  // Venezuela
  { code: 'CCS', name: 'Caracas' },
  { code: 'MAR', name: 'Maracaibo' },
  // Ecuador
  { code: 'UIO', name: 'Quito' },
  { code: 'GYE', name: 'Guayaquil' },
  // Perú
  { code: 'LIM', name: 'Lima' },
  // Bolivia
  { code: 'VVI', name: 'Santa Cruz de la Sierra' },
  { code: 'LPB', name: 'La Paz' },
  // Chile
  { code: 'SCL', name: 'Santiago' },
  { code: 'ANF', name: 'Antofagasta' },
  // Argentina
  { code: 'EZE', name: 'Buenos Aires (Ezeiza)' },
  { code: 'AEP', name: 'Buenos Aires (Aeroparque)' },
  { code: 'COR', name: 'Córdoba' },
  { code: 'MDZ', name: 'Mendoza' },
  // Uruguay
  { code: 'MVD', name: 'Montevideo' },
  // Paraguay
  { code: 'ASU', name: 'Asunción' },
  // Brasil
  { code: 'GRU', name: 'São Paulo (Guarulhos)' },
  { code: 'CGH', name: 'São Paulo (Congonhas)' },
  { code: 'GIG', name: 'Río de Janeiro' },
  { code: 'BSB', name: 'Brasilia' },
  { code: 'FOR', name: 'Fortaleza' },
  { code: 'REC', name: 'Recife' },
  { code: 'SSA', name: 'Salvador de Bahía' },
]

export default function AirfreightFlightNew() {
  const { user, isAdmin, isSuperAgent, isAgent } = useAuth()
  const navigate = useNavigate()
  const dropdownRef = useRef<HTMLDivElement>(null)

  const [airline, setAirline] = useState('')
  const [airlineOther, setAirlineOther] = useState('')
  const [flightNumber, setFlightNumber] = useState('')
  const [flightDate, setFlightDate] = useState('')
  const [flightTime, setFlightTime] = useState('')
  const [cutoffDate, setCutoffDate] = useState('')
  const [cutoffTime, setCutoffTime] = useState('')
  const [destinations, setDestinations] = useState<string[]>([])
  const [firestoreDestinations, setFirestoreDestinations] = useState<AirfreightDestination[]>([])
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    getDocs(collection(db, 'airfreight_destinations')).then(snap => {
      setFirestoreDestinations(
        snap.docs.map(d => ({ ...d.data() as AirfreightDestination, id: d.id })).filter(d => d.active !== false)
      )
    })
  }, [])

  // Merge Firestore destinations with defaults (Firestore overrides by code)
  const allAirports = (() => {
    const map = new Map<string, { code: string; name: string }>()
    DEFAULT_AIRPORTS.forEach(a => map.set(a.code, a))
    firestoreDestinations.forEach(d => map.set(d.code, { code: d.code, name: d.name }))
    return Array.from(map.values()).sort((a, b) => a.code.localeCompare(b.code))
  })()

  const filtered = search.trim()
    ? allAirports.filter(a =>
        a.code.includes(search.toUpperCase()) ||
        a.name.toLowerCase().includes(search.toLowerCase())
      )
    : allAirports

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  if (!isAdmin && !isSuperAgent && !isAgent) {
    navigate('/airfreight', { replace: true })
    return null
  }

  function toggleDestination(code: string) {
    setDestinations(prev =>
      prev.includes(code) ? prev.filter(d => d !== code) : [...prev, code]
    )
  }

  function addCustom() {
    const code = search.trim().toUpperCase()
    if (!code || destinations.includes(code)) return
    setDestinations(prev => [...prev, code])
    setSearch('')
    setDropdownOpen(false)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!flightDate) { setError('La fecha del vuelo es requerida'); return }
    if (!airline) { setError('La aerolínea es requerida'); return }
    if (destinations.length === 0) { setError('Selecciona al menos un destino'); return }

    setSaving(true)
    setError('')
    try {
      const airlineName = airline === 'Otra' ? airlineOther : airline
      const datetime = `${flightDate}T${flightTime || '00:00'}:00`
      const cutoffDt = cutoffDate ? `${cutoffDate}T${cutoffTime || '00:00'}:00` : null
      const docRef = await addDoc(collection(db, 'airfreight_flights'), {
        airline: airlineName,
        flight_number: flightNumber.trim() || null,
        flight_datetime: datetime,
        cutoff_datetime: cutoffDt,
        destinations,
        status: 'open',
        created_by: user?.email || user?.uid || '',
        created_at: new Date().toISOString(),
      })
      navigate(`/airfreight/flights/${docRef.id}`)
    } catch {
      setError('Error al crear el vuelo')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Layout title="Nuevo Vuelo" backTo="/airfreight">
      <div className="max-w-lg mx-auto">
        <form onSubmit={handleSubmit} className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-5">
          <h2 className="text-lg font-semibold text-gray-800">Crear vuelo</h2>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{error}</div>
          )}

          {/* Airline */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Aerolínea *</label>
            <select
              value={airline}
              onChange={e => setAirline(e.target.value)}
              required
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
            >
              <option value="">Seleccionar...</option>
              {AIRLINES.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
            {airline === 'Otra' && (
              <input
                value={airlineOther}
                onChange={e => setAirlineOther(e.target.value)}
                placeholder="Nombre de la aerolínea"
                required
                className="mt-2 w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
              />
            )}
          </div>

          {/* Flight number */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Número de vuelo <span className="text-gray-400">(opcional)</span>
            </label>
            <input
              value={flightNumber}
              onChange={e => setFlightNumber(e.target.value)}
              placeholder="ej. AA 1234"
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
            />
          </div>

          {/* Date & Time */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Fecha de salida *</label>
              <input
                type="date"
                value={flightDate}
                onChange={e => setFlightDate(e.target.value)}
                required
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Hora <span className="text-gray-400">(opcional)</span>
              </label>
              <input
                type="time"
                value={flightTime}
                onChange={e => setFlightTime(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
              />
            </div>
          </div>

          {/* CutOff Date & Time */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                CutOff Fecha <span className="text-gray-400">(opcional)</span>
              </label>
              <input
                type="date"
                value={cutoffDate}
                onChange={e => setCutoffDate(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                CutOff Hora <span className="text-gray-400">(opcional)</span>
              </label>
              <input
                type="time"
                value={cutoffTime}
                onChange={e => setCutoffTime(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
              />
            </div>
          </div>

          {/* Destinations dropdown */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Destinos *</label>

            <div ref={dropdownRef} className="relative">
              {/* Trigger */}
              <button
                type="button"
                onClick={() => setDropdownOpen(o => !o)}
                className="w-full flex items-center justify-between border border-gray-200 rounded-lg px-3 py-2.5 text-sm text-gray-500 hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-mcl-blue/30 bg-white"
              >
                <span>{destinations.length === 0 ? 'Seleccionar destinos...' : `${destinations.length} destino${destinations.length !== 1 ? 's' : ''} seleccionado${destinations.length !== 1 ? 's' : ''}`}</span>
                <svg className={`w-4 h-4 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {/* Dropdown panel */}
              {dropdownOpen && (
                <div className="absolute z-20 mt-1 w-full bg-white border border-gray-200 rounded-xl shadow-lg">
                  {/* Search */}
                  <div className="p-2 border-b border-gray-100">
                    <input
                      autoFocus
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          if (filtered.length === 1) {
                            toggleDestination(filtered[0].code)
                          } else if (filtered.length === 0 && search.trim()) {
                            addCustom()
                          }
                        }
                      }}
                      placeholder="Buscar por código o ciudad..."
                      className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-mcl-blue/30"
                    />
                  </div>

                  {/* List */}
                  <ul className="max-h-52 overflow-y-auto py-1">
                    {filtered.map(airport => (
                      <li key={airport.code}>
                        <button
                          type="button"
                          onClick={() => toggleDestination(airport.code)}
                          className={`w-full flex items-center justify-between px-4 py-2 text-sm hover:bg-gray-50 transition-colors ${
                            destinations.includes(airport.code) ? 'bg-blue-50 text-mcl-blue' : 'text-gray-700'
                          }`}
                        >
                          <span>
                            <span className="font-mono font-semibold w-10 inline-block">{airport.code}</span>
                            <span className="text-gray-400 text-xs ml-1">{airport.name}</span>
                          </span>
                          {destinations.includes(airport.code) && (
                            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </button>
                      </li>
                    ))}
                    {filtered.length === 0 && search.trim() && (
                      <li>
                        <button
                          type="button"
                          onClick={addCustom}
                          className="w-full px-4 py-2 text-sm text-left text-mcl-blue hover:bg-blue-50"
                        >
                          + Agregar "<span className="font-mono font-semibold">{search.trim().toUpperCase()}</span>"
                        </button>
                      </li>
                    )}
                  </ul>
                </div>
              )}
            </div>

            {/* Selected chips */}
            {destinations.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {destinations.map(d => (
                  <span key={d} className="flex items-center gap-1 bg-mcl-blue/10 text-mcl-blue text-xs px-2 py-0.5 rounded-full font-mono font-semibold">
                    {d}
                    <button type="button" onClick={() => toggleDestination(d)} className="hover:text-red-500 font-sans">×</button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={() => navigate('/airfreight')}
              className="flex-1 border border-gray-200 text-gray-600 rounded-lg py-2.5 text-sm font-medium hover:bg-gray-50 transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 bg-mcl-blue text-white rounded-lg py-2.5 text-sm font-semibold hover:bg-blue-900 transition-colors disabled:opacity-50"
            >
              {saving ? 'Creando...' : 'Crear Vuelo'}
            </button>
          </div>
        </form>
      </div>
    </Layout>
  )
}
