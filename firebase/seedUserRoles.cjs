/**
 * Crea los documentos de roles de usuario en Firestore.
 *
 * Uso:
 *   node firebase/seedUserRoles.js
 *
 * Requiere: firebase/serviceAccountKey.json
 */

const admin = require('firebase-admin')
const serviceAccount = require('./serviceAccountKey.json')

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})

const db = admin.firestore()

const userRoles = [
  { email: 'diego.garcia@mincurllogistics.com', role: 'admin' },
  { email: 'admin@mincurllogistics.com',        role: 'accounting' },
  { email: 'finanzas@mincurllogistics.com',     role: 'accounting' },
]

async function seed() {
  for (const { email, role } of userRoles) {
    await db.collection('user_roles').doc(email).set({ role })
    console.log(`✓ ${email} → ${role}`)
  }
  console.log('\nRoles configurados correctamente.')
  process.exit(0)
}

seed().catch(err => {
  console.error(err)
  process.exit(1)
})
