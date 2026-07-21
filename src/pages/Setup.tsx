import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { db } from '../lib/firebase'
import { collection, addDoc, deleteDoc, doc, setDoc, getDocs } from 'firebase/firestore'

const CONSIGNEES = [
  {
    name: 'SODIMAC COLOMBIA S.A.',
    full_address: 'SODIMAC COLOMBIA S.A.',
    notify_to: 'NIT: 800.242.106-2 CRA. 68D NO. 80-70\nTEL: 457 81 00\nBOGOTA - COLOMBIA',
  },
  {
    name: 'TIENDAS DEL MEJORAMIENTO DEL H - Peru',
    full_address: 'TIENDAS DEL MEJORAMIENTO DEL H - Peru',
    notify_to: 'Avenida Angamos Este N° 1805, Interior 2,\noficina 2, distrito de Surquillo – Lima - Perú\nRUC: 20112273922\nPhone: 511- 2119500\nFax: 511- 6110418',
  },
  {
    name: 'SODIMAC S.A. - Chile',
    full_address: 'SODIMAC S.A. - Chile',
    notify_to: 'RUT: 96792430-K\nAV. PDTE. EDO. FREI M. 3092\nRENCА - SANTIAGO - CHILE\nPHONE: +56 2 2738 1000\n_ComexSodimac@Falabella.cl',
  },
  {
    name: 'CONSTRUDECOR S/A - Brasil',
    full_address: 'CONSTRUDECOR S/A - Brasil',
    notify_to: 'AVENIDA SANTOS DUMONT, 4475\nARMAZÉM 3\nJARDIM CONCEIÇÃOZINHA (VICENTE DE CARVALHO)\nGUARUJÁ – SP – BRASIL\nCEP: 11460-006\nCNPJ.: 03.439.316/0038-64\nPhone: +5511 2065-2525 - Fax: +5511 2065-2500',
  },
  {
    name: 'HOMECENTER SODIMAC S.A. - Uruguay',
    full_address: 'HOMECENTER SODIMAC S.A. - Uruguay',
    notify_to: 'RUT: 216996650015\nARIZONA 865\nBARRA DE CARRASCO\nCIUDAD DE LA COSTA,\n(CP 15000) CANELONES – URUGUAY\nPhone: +598 2484 5089',
  },
  {
    name: 'Comercializadora SDMHC, SA DE CV - Mexico',
    full_address: 'Comercializadora SDMHC, SA DE CV - Mexico',
    notify_to: 'RFC CSD161207R2A\nAv. Adolfo Lopez Mateos No. 201 Col Santa\nCruz Acatlán CP. 53150 Naucalpan de\nJuárez, Estado de México\nPhone: +52 (55) 5375 9000 ext. 9341, 9381, 9382\ncomex.mex@sodimac.com.mx',
  },
]

export default function Setup() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [log, setLog] = useState<string[]>([])

  function addLog(msg: string) {
    setLog(prev => [...prev, msg])
  }

  async function runSeed() {
    setStatus('running')
    setLog([])
    try {
      // Delete existing consignees
      const existing = await getDocs(collection(db, 'consignees'))
      for (const d of existing.docs) {
        await deleteDoc(d.ref)
      }
      if (!existing.empty) addLog(`🗑 ${existing.size} consignatarios anteriores eliminados`)

      // Insert new consignees
      for (const c of CONSIGNEES) {
        await addDoc(collection(db, 'consignees'), c)
        addLog(`✓ ${c.name}`)
      }

      // WR sequence
      await setDoc(doc(db, 'config', 'wr_sequence'), { last_num: 0 }, { merge: true })
      addLog('✓ Contador WR inicializado')

      addLog('✅ Setup completado.')
      setStatus('done')
    } catch (err) {
      console.error(err)
      addLog('❌ Error: ' + String(err))
      setStatus('error')
    }
  }

  return (
    <div className="min-h-screen bg-mcl-blue flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md">
        <div className="text-4xl font-black tracking-tight text-mcl-blue mb-1">
          M<span className="text-mcl-red">I</span>NCURL<span className="text-mcl-red">.</span>
        </div>
        <p className="text-gray-500 text-sm mb-6">Setup inicial de base de datos</p>

        {log.length > 0 && (
          <div className="bg-gray-50 rounded-lg p-3 mb-4 text-xs font-mono space-y-1">
            {log.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        )}

        {status === 'done' ? (
          <button
            onClick={() => navigate('/')}
            className="w-full bg-mcl-blue text-white px-4 py-3 rounded-lg font-semibold hover:bg-blue-900 transition-colors"
          >
            Ir al Dashboard →
          </button>
        ) : (
          <button
            onClick={runSeed}
            disabled={status === 'running'}
            className="w-full bg-mcl-blue text-white px-4 py-3 rounded-lg font-semibold hover:bg-blue-900 transition-colors disabled:opacity-50"
          >
            {status === 'running' ? 'Configurando...' : 'Inicializar base de datos'}
          </button>
        )}
      </div>
    </div>
  )
}
