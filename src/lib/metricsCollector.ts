// ═══ Client-Side Metrics Collector ═══
// Tracks page load times, Firestore query durations, errors, and Web Vitals.
// Writes aggregated metrics to Firestore `_client_metrics` collection.

import { doc, setDoc, increment, arrayUnion, Timestamp } from 'firebase/firestore'
import { db } from './firebase'

// ── Types ────────────────────────────────────────────────────────────────────

interface QueryMetric {
  collection: string
  duration: number
  docCount: number
  timestamp: number
  page: string
}

interface ErrorMetric {
  message: string
  page: string
  timestamp: number
  stack?: string
}

interface PageMetric {
  page: string
  loadTime: number
  timestamp: number
}

// ── In-Memory Buffer ─────────────────────────────────────────────────────────
// Collect metrics in memory, flush periodically to Firestore

const buffer = {
  queries: [] as QueryMetric[],
  errors: [] as ErrorMetric[],
  pages: [] as PageMetric[],
}

let flushTimer: ReturnType<typeof setTimeout> | null = null
const FLUSH_INTERVAL = 60_000 // 1 minute
const MAX_BUFFER = 50

// ── Public API ───────────────────────────────────────────────────────────────

/** Track a Firestore query duration */
export function trackQuery(collection: string, duration: number, docCount: number) {
  buffer.queries.push({
    collection,
    duration,
    docCount,
    timestamp: Date.now(),
    page: window.location.pathname,
  })
  scheduleFlush()
}

/** Track a page load/navigation */
export function trackPageLoad(page: string, loadTime: number) {
  buffer.pages.push({
    page,
    loadTime,
    timestamp: Date.now(),
  })
  scheduleFlush()
}

/** Track a client-side error */
export function trackError(message: string, stack?: string) {
  buffer.errors.push({
    message,
    page: window.location.pathname,
    timestamp: Date.now(),
    stack: stack?.substring(0, 200),
  })
  scheduleFlush()
}

/** Wrap a Firestore query to automatically track its duration */
export async function trackedQuery<T>(
  collectionName: string,
  queryFn: () => Promise<T>,
  countFn?: (result: T) => number,
): Promise<T> {
  const start = performance.now()
  try {
    const result = await queryFn()
    const duration = Math.round(performance.now() - start)
    const count = countFn ? countFn(result) : 0
    trackQuery(collectionName, duration, count)
    return result
  } catch (err) {
    const duration = Math.round(performance.now() - start)
    trackQuery(collectionName, duration, -1) // -1 = error
    throw err
  }
}

/** Initialize Web Vitals tracking (call once in main.tsx) */
export function initWebVitals() {
  // Track LCP
  try {
    const lcpObserver = new PerformanceObserver((list) => {
      const entries = list.getEntries()
      const last = entries[entries.length - 1]
      if (last) {
        trackPageLoad('LCP', Math.round(last.startTime))
      }
    })
    lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true })
  } catch { /* Not supported */ }

  // Track long tasks (>50ms)
  try {
    const longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration > 100) { // Only track >100ms
          trackQuery('_long_task', Math.round(entry.duration), 0)
        }
      }
    })
    longTaskObserver.observe({ type: 'longtask', buffered: true })
  } catch { /* Not supported */ }

  // Track uncaught errors
  window.addEventListener('error', (event) => {
    trackError(event.message, event.error?.stack)
  })

  // Track unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    trackError(`Unhandled: ${event.reason?.message || event.reason}`)
  })
}

// ── Flush Logic ──────────────────────────────────────────────────────────────

function scheduleFlush() {
  const totalItems = buffer.queries.length + buffer.errors.length + buffer.pages.length
  if (totalItems >= MAX_BUFFER) {
    flush()
    return
  }
  if (!flushTimer) {
    flushTimer = setTimeout(flush, FLUSH_INTERVAL)
  }
}

async function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }

  const queries = buffer.queries.splice(0)
  const errors = buffer.errors.splice(0)
  const pages = buffer.pages.splice(0)

  if (queries.length === 0 && errors.length === 0 && pages.length === 0) return

  try {
    const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    const hour = new Date().getHours()
    const docId = `${today}_h${String(hour).padStart(2, '0')}`

    // Aggregate query metrics
    const queryAgg: Record<string, { total: number; count: number; errors: number; maxDuration: number }> = {}
    for (const q of queries) {
      if (!queryAgg[q.collection]) {
        queryAgg[q.collection] = { total: 0, count: 0, errors: 0, maxDuration: 0 }
      }
      const agg = queryAgg[q.collection]
      agg.count++
      agg.total += q.duration
      if (q.docCount === -1) agg.errors++
      if (q.duration > agg.maxDuration) agg.maxDuration = q.duration
    }

    // Aggregate page metrics
    const pageAgg: Record<string, { total: number; count: number; maxLoad: number }> = {}
    for (const p of pages) {
      if (!pageAgg[p.page]) {
        pageAgg[p.page] = { total: 0, count: 0, maxLoad: 0 }
      }
      const agg = pageAgg[p.page]
      agg.count++
      agg.total += p.loadTime
      if (p.loadTime > agg.maxLoad) agg.maxLoad = p.loadTime
    }

    await setDoc(doc(db, '_client_metrics', docId), {
      date: today,
      hour,
      updated_at: Timestamp.now(),
      query_count: increment(queries.length),
      error_count: increment(errors.length),
      page_view_count: increment(pages.length),
      queries: queryAgg,
      pages: pageAgg,
      recent_errors: arrayUnion(...errors.slice(-5).map(e => ({
        message: e.message,
        page: e.page,
        at: e.timestamp,
      }))),
    }, { merge: true })
  } catch {
    // Silently fail — metrics should never break the app
  }
}

// Flush on page unload
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flush)
}
