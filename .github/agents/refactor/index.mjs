#!/usr/bin/env node
// ═══ AREF — Agente de Refactoring Arquitectonico ═══
// Trigger: manual (workflow_dispatch) o cron (nightly)
// Crea PRs, nunca despliega directo.
// Ejecuta tareas de refactoring mecanico (bajo/medio riesgo).

import { initFirebase, setAgentState, getAgentState, writeMetricsSnapshot } from '../shared/firebase-client.mjs'
import { generateReport, sendSlackNotification, setSummary } from '../shared/reporter.mjs'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'

const AGENT_ID = 'AREF'
const DRY_RUN = process.env.DRY_RUN === 'true'

/**
 * Resolve task ID: use env var if provided, otherwise read from task queue.
 */
function resolveTaskId() {
  if (process.env.TASK_ID) return process.env.TASK_ID

  // Auto mode: read from task queue
  const queuePath = join(process.cwd(), 'refactor', 'task-queue.json')
  const queue = JSON.parse(readFileSync(queuePath, 'utf8'))
  const pending = queue.tasks.find(t => t.status === 'pending')

  if (!pending) return null
  return pending.id
}

/**
 * Check if a branch or open PR already exists for this task (dedup).
 */
function branchExistsForTask(taskId) {
  const prefix = `aref/${taskId.toLowerCase()}-`
  try {
    const branches = execSync('git branch -r', { encoding: 'utf8' })
    return branches.split('\n').some(b => b.trim().includes(prefix))
  } catch {
    return false
  }
}

const TASK_ID = resolveTaskId()

// Share resolved TASK_ID with create-pr.mjs via temp file
if (TASK_ID) writeFileSync('/tmp/aref-resolved-task-id', TASK_ID)

async function main() {
  log('START', `═══ AREF — Agente de Refactoring ═══ Task: ${TASK_ID || 'none'} | DryRun: ${DRY_RUN}`)
  const report = { status: 'unknown', task_id: TASK_ID, actions_taken: [], changes: [], next_steps: [] }

  try {
    if (!TASK_ID) {
      log('INFO', 'No pending tasks in queue — nothing to do')
      report.status = 'idle'
      report.summary = 'No pending tasks in queue.'
      await finalizeReport(report)
      return
    }

    // Check if this task already has a branch/PR (avoid re-running)
    if (branchExistsForTask(TASK_ID)) {
      log('INFO', `Branch for ${TASK_ID} already exists — skipping (PR pending review)`)
      report.status = 'skipped'
      report.summary = `Task ${TASK_ID} already has an open branch/PR. Skipping.`
      await finalizeReport(report)
      return
    }

    // Firestore is optional for AREF — tasks only modify local files
    let firestoreAvailable = false
    try {
      initFirebase()
      firestoreAvailable = true
      log('INFO', 'Firestore connected')
    } catch (fbErr) {
      log('WARN', `Firestore unavailable (${fbErr.message}) — continuing without state tracking`)
    }

    // 1. Load task definition
    log('STEP', `1/4 — Loading task ${TASK_ID}`)
    const taskModule = await import(`./tasks/${TASK_ID}.mjs`)
    const { TASK_META, execute } = taskModule

    log('INFO', `Task: ${TASK_META.name}`)
    log('INFO', `Risk: ${TASK_META.risk}`)
    log('INFO', `Files to modify: ${TASK_META.files_modified.join(', ') || 'none'}`)
    log('INFO', `Files to create: ${TASK_META.files_created.join(', ') || 'none'}`)

    report.task_meta = TASK_META

    // 2. Check previous state (skip if Firestore unavailable)
    log('STEP', '2/4 — Checking previous state')
    let previousRuns = []
    if (firestoreAvailable) {
      try {
        const state = await getAgentState(AGENT_ID)
        previousRuns = state.completed_tasks || []
        if (previousRuns.includes(TASK_ID)) {
          log('WARN', `Task ${TASK_ID} was already executed on ${state[`${TASK_ID}_completed_at`]}`)
          report.status = 'skipped'
          report.summary = `Task ${TASK_ID} already completed. Skipping.`
          await finalizeReport(report)
          return
        }
      } catch (stateErr) {
        log('WARN', `Could not read agent state: ${stateErr.message}`)
      }
    } else {
      log('INFO', 'Skipping state check — Firestore unavailable')
    }

    // 3. Execute task
    if (DRY_RUN) {
      log('STEP', '3/4 — DRY RUN — analyzing only')
      report.status = 'dry_run'
      report.summary = `DRY RUN: ${TASK_META.name}. Changes would be: ${TASK_META.files_modified.length} files modified, ${TASK_META.files_created.length} files created.`
      report.actions_taken.push('Analyzed task — no changes made')
      await finalizeReport(report)
      return
    }

    log('STEP', '3/4 — Executing task')
    const repoRoot = process.cwd().replace(/\.github[\\/]agents$/, '')
    const agentsDir = process.cwd()

    const result = await execute({
      repoRoot,
      agentsDir,
      log,
    })

    report.changes = result.changes || []
    report.files_modified = result.files_modified || []
    report.files_created = result.files_created || []
    report.actions_taken = result.changes || []

    if (result.error) {
      report.status = 'error'
      report.summary = `Task ${TASK_ID} failed: ${result.error}`
      await sendSlackNotification(`AREF ERROR: ${TASK_ID} — ${result.error}`, 'error')
    } else {
      report.status = 'completed'
      report.summary = `Task ${TASK_ID} (${TASK_META.name}) completed. ${(result.changes || []).length} changes made. PR will be created.`
    }

    // 4. Save state (skip if Firestore unavailable)
    log('STEP', '4/4 — Saving state')
    if (firestoreAvailable) {
      try {
        await setAgentState(AGENT_ID, {
          last_run: new Date().toISOString(),
          last_task: TASK_ID,
          last_status: report.status,
          completed_tasks: [...previousRuns, ...(result.error ? [] : [TASK_ID])],
          [`${TASK_ID}_completed_at`]: result.error ? null : new Date().toISOString(),
        })
        await writeMetricsSnapshot(AGENT_ID, {
          task_id: TASK_ID,
          files_modified: (result.files_modified || []).length,
          files_created: (result.files_created || []).length,
          changes: (result.changes || []).length,
        }, report.summary)
      } catch (saveErr) {
        log('WARN', `Could not save state to Firestore: ${saveErr.message}`)
      }
    } else {
      log('INFO', 'Skipping state save — Firestore unavailable')
    }

    if (!result.error) {
      await sendSlackNotification(
        `AREF: ${TASK_META.name} completado.\n${(result.changes || []).join('\n')}`,
        'info'
      )
    }

    await finalizeReport(report)

  } catch (err) {
    log('ERROR', `Fatal: ${err.message}\n${err.stack}`)
    report.status = 'error'
    report.summary = `Fatal error: ${err.message}`
    await sendSlackNotification(`AREF FATAL: ${TASK_ID} — ${err.message}`, 'critical')
    await finalizeReport(report)
    process.exit(1)
  }
}

async function finalizeReport(report) {
  const { mdPath, markdown } = generateReport(AGENT_ID, report)
  setSummary(markdown)
  log('DONE', `Report: ${mdPath}`)
}

function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [AREF] [${tag}] ${msg}`)
}

main()
