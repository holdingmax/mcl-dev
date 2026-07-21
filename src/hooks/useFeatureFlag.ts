import { useEffect, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../lib/firebase'

const cache: Record<string, boolean> = {}
let listeners = 0
let unsub: (() => void) | null = null

function startListening() {
  if (unsub) return
  unsub = onSnapshot(doc(db, 'config', 'feature_flags'), (snap) => {
    const data = snap.data() || {}
    for (const key of Object.keys(cache)) {
      cache[key] = !!data[key]
    }
    // Also set new keys
    for (const [k, v] of Object.entries(data)) {
      cache[k] = !!v
    }
    // Trigger re-renders via event
    window.dispatchEvent(new Event('feature-flags-updated'))
  }, () => {
    // On error, keep defaults (false)
  })
}

function stopListening() {
  if (unsub) { unsub(); unsub = null }
}

/**
 * Subscribe to a feature flag from Firestore (config/feature_flags).
 * Returns false by default until the flag document is loaded.
 * Single shared listener for all flag consumers.
 */
export function useFeatureFlag(flagName: string): boolean {
  const [value, setValue] = useState(() => cache[flagName] ?? false)

  useEffect(() => {
    if (!(flagName in cache)) cache[flagName] = false
    listeners++
    startListening()

    const handler = () => setValue(cache[flagName] ?? false)
    window.addEventListener('feature-flags-updated', handler)

    return () => {
      window.removeEventListener('feature-flags-updated', handler)
      listeners--
      if (listeners <= 0) { stopListening(); listeners = 0 }
    }
  }, [flagName])

  return value
}
