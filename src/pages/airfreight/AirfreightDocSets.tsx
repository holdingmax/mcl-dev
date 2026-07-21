import { useState, useEffect, useCallback } from 'react'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import Layout from '../../components/Layout'

// All available document types for sets
const ALL_DOC_TYPES: { key: string; label: string }[] = [
  { key: 'ccsf', label: 'CCSF (MCL)' },
  { key: 'ccsssp', label: 'CCSSSP (Client)' },
  { key: 'do_tsa', label: 'DO / TSA' },
  { key: 'lb', label: 'LB Checklist' },
  { key: '7512', label: '7512' },
  { key: 'hawb', label: 'AWB / HAWB' },
  { key: 'copy5', label: 'Copy 5 (AWB page)' },
  { key: 'manifesto', label: 'Manifiesto' },
]

export interface SetDocEntry {
  key: string
  copies: number
}

export interface DocSetsConfig {
  counter: SetDocEntry[]
  driver: SetDocEntry[]
  envelope: SetDocEntry[]
}

const DEFAULT_CONFIG: DocSetsConfig = {
  counter: [
    { key: 'ccsf', copies: 1 },
    { key: 'ccsssp', copies: 1 },
    { key: 'do_tsa', copies: 1 },
    { key: 'lb', copies: 1 },
    { key: '7512', copies: 1 },
    { key: 'hawb', copies: 1 },
  ],
  driver: [
    { key: 'ccsf', copies: 2 },
    { key: 'ccsssp', copies: 2 },
    { key: 'lb', copies: 1 },
    { key: 'copy5', copies: 1 },
  ],
  envelope: [
    { key: '7512', copies: 1 },
    { key: 'copy5', copies: 1 },
    { key: 'manifesto', copies: 1 },
  ],
}

const SET_NAMES: { key: keyof DocSetsConfig; label: string; color: string }[] = [
  { key: 'counter', label: 'Counter', color: 'bg-gray-800 text-white' },
  { key: 'driver', label: 'Driver', color: 'bg-amber-500 text-white' },
  { key: 'envelope', label: 'Envelope', color: 'bg-rose-500 text-white' },
]

function getLabel(key: string): string {
  return ALL_DOC_TYPES.find(d => d.key === key)?.label || key
}

export default function AirfreightDocSets() {
  const [config, setConfig] = useState<DocSetsConfig>(DEFAULT_CONFIG)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [dragInfo, setDragInfo] = useState<{ set: keyof DocSetsConfig; idx: number } | null>(null)

  useEffect(() => {
    getDoc(doc(db, 'settings', 'doc_sets')).then(snap => {
      if (snap.exists()) {
        const data = snap.data() as DocSetsConfig
        // Ensure all sets exist with fallback
        setConfig({
          counter: data.counter || DEFAULT_CONFIG.counter,
          driver: data.driver || DEFAULT_CONFIG.driver,
          envelope: data.envelope || DEFAULT_CONFIG.envelope,
        })
      }
      setLoading(false)
    })
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      await setDoc(doc(db, 'settings', 'doc_sets'), config)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      alert('Error al guardar: ' + (err as Error).message)
    } finally {
      setSaving(false)
    }
  }, [config])

  const addDoc_ = (setKey: keyof DocSetsConfig, docKey: string) => {
    setConfig(prev => ({
      ...prev,
      [setKey]: [...prev[setKey], { key: docKey, copies: 1 }],
    }))
  }

  const removeDoc = (setKey: keyof DocSetsConfig, idx: number) => {
    setConfig(prev => ({
      ...prev,
      [setKey]: prev[setKey].filter((_, i) => i !== idx),
    }))
  }

  const setCopies = (setKey: keyof DocSetsConfig, idx: number, copies: number) => {
    if (copies < 1) copies = 1
    if (copies > 10) copies = 10
    setConfig(prev => ({
      ...prev,
      [setKey]: prev[setKey].map((e, i) => i === idx ? { ...e, copies } : e),
    }))
  }

  const moveItem = (setKey: keyof DocSetsConfig, fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx) return
    setConfig(prev => {
      const arr = [...prev[setKey]]
      const [item] = arr.splice(fromIdx, 1)
      arr.splice(toIdx, 0, item)
      return { ...prev, [setKey]: arr }
    })
  }

  const resetToDefault = () => {
    if (confirm('Restaurar configuracion por defecto?')) {
      setConfig(DEFAULT_CONFIG)
    }
  }

  if (loading) {
    return (
      <Layout title="Document Sets" backTo="/airfreight/admin">
        <div className="flex items-center justify-center py-20 text-gray-400">Cargando...</div>
      </Layout>
    )
  }

  return (
    <Layout title="Document Sets" backTo="/airfreight/admin">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-500">
            Configura que documentos van en cada set, cuantas copias y en que orden.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={resetToDefault}
              className="text-xs text-gray-400 hover:text-gray-600 border border-gray-200 rounded-lg px-3 py-1.5"
            >
              Restaurar default
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className={`text-sm font-semibold rounded-lg px-5 py-2 transition-colors ${
                saved
                  ? 'bg-green-500 text-white'
                  : 'bg-mcl-blue text-white hover:bg-mcl-blue/90'
              } disabled:opacity-50`}
            >
              {saving ? 'Guardando...' : saved ? 'Guardado' : 'Guardar'}
            </button>
          </div>
        </div>

        {SET_NAMES.map(({ key: setKey, label, color }) => {
          const entries = config[setKey]
          const usedKeys = new Set(entries.map(e => e.key))
          const available = ALL_DOC_TYPES.filter(d => !usedKeys.has(d.key))

          return (
            <div key={setKey} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-3">
                <span className={`text-xs font-bold px-2.5 py-1 rounded-md ${color}`}>{label}</span>
                <span className="text-xs text-gray-400">{entries.length} documento{entries.length !== 1 ? 's' : ''}</span>
              </div>

              <div className="divide-y divide-gray-50">
                {entries.map((entry, idx) => (
                  <div
                    key={`${setKey}-${idx}`}
                    draggable
                    onDragStart={() => setDragInfo({ set: setKey, idx })}
                    onDragOver={e => {
                      e.preventDefault()
                      if (dragInfo?.set === setKey) e.dataTransfer.dropEffect = 'move'
                    }}
                    onDrop={() => {
                      if (dragInfo?.set === setKey) moveItem(setKey, dragInfo.idx, idx)
                      setDragInfo(null)
                    }}
                    onDragEnd={() => setDragInfo(null)}
                    className={`flex items-center gap-3 px-4 py-2.5 group hover:bg-gray-50/50 transition-colors ${
                      dragInfo?.set === setKey && dragInfo.idx === idx ? 'opacity-40' : ''
                    }`}
                  >
                    {/* Drag handle */}
                    <span className="cursor-grab text-gray-300 group-hover:text-gray-400 select-none" title="Arrastrar para reordenar">
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                        <circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/>
                        <circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>
                        <circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/>
                      </svg>
                    </span>

                    {/* Order number */}
                    <span className="text-xs font-mono text-gray-300 w-4 text-right">{idx + 1}</span>

                    {/* Doc name */}
                    <span className="text-sm text-gray-700 flex-1 font-medium">{getLabel(entry.key)}</span>

                    {/* Copies */}
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setCopies(setKey, idx, entry.copies - 1)}
                        disabled={entry.copies <= 1}
                        className="w-6 h-6 rounded border border-gray-200 text-gray-400 hover:text-gray-600 hover:border-gray-300 flex items-center justify-center text-xs disabled:opacity-30"
                      >-</button>
                      <span className="text-sm font-semibold text-gray-700 w-6 text-center">{entry.copies}</span>
                      <button
                        onClick={() => setCopies(setKey, idx, entry.copies + 1)}
                        className="w-6 h-6 rounded border border-gray-200 text-gray-400 hover:text-gray-600 hover:border-gray-300 flex items-center justify-center text-xs"
                      >+</button>
                      <span className="text-[10px] text-gray-400 ml-0.5">cop.</span>
                    </div>

                    {/* Remove */}
                    <button
                      onClick={() => removeDoc(setKey, idx)}
                      className="text-gray-300 hover:text-red-500 transition-colors"
                      title="Quitar del set"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}

                {entries.length === 0 && (
                  <div className="px-4 py-6 text-center text-sm text-gray-300">
                    Set vacio — agrega documentos abajo
                  </div>
                )}
              </div>

              {/* Add doc dropdown */}
              {available.length > 0 && (
                <div className="px-4 py-2.5 border-t border-gray-100 bg-gray-50/50">
                  <select
                    value=""
                    onChange={e => { if (e.target.value) addDoc_(setKey, e.target.value) }}
                    className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 text-gray-500 bg-white"
                  >
                    <option value="">+ Agregar documento...</option>
                    {available.map(d => (
                      <option key={d.key} value={d.key}>{d.label}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )
        })}

        <div className="bg-blue-50 rounded-xl border border-blue-100 p-4">
          <p className="text-xs text-blue-600 font-medium mb-1">Nota</p>
          <p className="text-xs text-blue-500">
            Si un documento no esta disponible para una AWB (ej: LB Checklist sin bateria), se omite automaticamente del set.
            Para MAWB, los documentos 7512 y HAWB se repiten por cada AWB hija incluida.
          </p>
        </div>
      </div>
    </Layout>
  )
}
