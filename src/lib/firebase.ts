import { initializeApp, getApps, deleteApp } from 'firebase/app'
import { getAuth, createUserWithEmailAndPassword, setPersistence, browserSessionPersistence, connectAuthEmulator } from 'firebase/auth'
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore'
import { getStorage, connectStorageEmulator } from 'firebase/storage'
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions'

export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

const app = initializeApp(firebaseConfig)

export const auth = getAuth(app)
// Force session-only persistence: closing the browser/tab ends the session,
// so users must re-enter their credentials on next visit.
setPersistence(auth, browserSessionPersistence).catch((err) => {
  console.error('Failed to set auth persistence', err)
})
export const db = getFirestore(app)
export const storage = getStorage(app)
export const functions = getFunctions(app)


// Connect to emulators in development
if (import.meta.env.DEV) {
  connectFirestoreEmulator(db, '127.0.0.1', 8080)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099')
  connectFunctionsEmulator(functions, '127.0.0.1', 5001)
  connectStorageEmulator(storage, '127.0.0.1', 9199)
}

/**
 * Creates a Firebase Auth user without affecting the current session.
 * Uses a temporary secondary app instance that is deleted after use.
 * Throws a friendly Spanish error if the email already has an account.
 */
export async function createUserWithoutSignIn(email: string, password: string) {
  const secondaryApp = initializeApp(firebaseConfig, `secondary-${Date.now()}`)
  try {
    const secondaryAuth = getAuth(secondaryApp)
    try {
      const result = await createUserWithEmailAndPassword(secondaryAuth, email, password)
      return result.user.uid
    } catch (err: any) {
      if (err?.code === 'auth/email-already-in-use') {
        throw new Error('Ya existe una cuenta con este email. Usa otro email o pide al usuario que use "Olvidé mi contraseña" para restablecerla.')
      }
      if (err?.code === 'auth/invalid-email') {
        throw new Error('El email no es válido')
      }
      if (err?.code === 'auth/weak-password') {
        throw new Error('La contraseña es demasiado débil')
      }
      throw err
    }
  } finally {
    await deleteApp(secondaryApp)
  }
}
