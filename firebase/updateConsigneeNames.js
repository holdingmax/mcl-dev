/**
 * Actualiza los nombres de los consignatarios en Firestore al formato correcto.
 *
 * Uso:
 *   node firebase/updateConsigneeNames.js
 *
 * Requiere: firebase/serviceAccountKey.json
 */

const admin = require('firebase-admin')
const serviceAccount = require('./serviceAccountKey.json')

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})

const db = admin.firestore()

// Mapa: nombre actual (uppercase) → nombre correcto
const nameMap = {
  'SODIMAC COLOMBIA S.A.'                           : 'Sodimac Colombia S.A.',
  'TIENDAS DEL MEJORAMIENTO DEL HOGAR - PERU'       : 'Tiendas del Mejoramiento del Hogar - PERU',
  'SODIMAC S.A.- CHILE'                             : 'Sodimac S.A.- CHILE',
  'CONSTRUDECOR S/A - BRASIL'                       : 'Construdecor S/A - BRASIL',
  'HOMECENTER SODIMAC S.A. - URUGUAY'               : 'Homecenter Sodimac S.A. - URUGUAY',
  'COMERCIALIZADORA SDMHC, SA DE CV - MEXICO'       : 'Comercializadora SDMHC, SA DE CV - MEXICO',
}

async function update() {
  const snap = await db.collection('consignees').get()
  let updated = 0

  for (const docSnap of snap.docs) {
    const current = docSnap.data().name || ''
    const newName = nameMap[current.trim().toUpperCase()] || nameMap[current.trim()]
    if (newName && newName !== current) {
      await docSnap.ref.update({ name: newName })
      console.log(`✓ "${current}" → "${newName}"`)
      updated++
    }
  }

  if (updated === 0) {
    console.log('No se encontraron coincidencias. Verificá los nombres exactos en Firestore.')
  } else {
    console.log(`\nActualizados: ${updated} consignatarios.`)
  }

  process.exit(0)
}

update().catch(err => {
  console.error(err)
  process.exit(1)
})
