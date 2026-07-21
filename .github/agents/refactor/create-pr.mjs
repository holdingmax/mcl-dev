#!/usr/bin/env node
// ═══ AREF — Create PR from refactoring changes ═══
// Runs after the refactor task completes. Creates a branch and PR.

import { execSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const GITHUB_TOKEN = process.env.GITHUB_TOKEN

// Resolve TASK_ID: from env, temp file (written by index.mjs), or task queue
function resolveTaskId() {
  if (process.env.TASK_ID) return process.env.TASK_ID
  // Check temp file written by index.mjs
  try {
    return readFileSync('/tmp/aref-resolved-task-id', 'utf8').trim()
  } catch {
    // Fall back to queue
  }
  try {
    const queuePath = join(process.cwd(), 'refactor', 'task-queue.json')
    const queue = JSON.parse(readFileSync(queuePath, 'utf8'))
    const pending = queue.tasks.find(t => t.status === 'pending')
    return pending ? pending.id : null
  } catch {
    return null
  }
}

const TASK_ID = resolveTaskId()

function run(cmd, env = {}) {
  log('CMD', cmd)
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    }).trim()
  } catch (err) {
    // Log stderr for debugging
    if (err.stderr) log('STDERR', err.stderr.trim())
    throw err
  }
}

function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [AREF-PR] [${tag}] ${msg}`)
}

async function main() {
  log('START', `Creating PR for task ${TASK_ID}`)

  if (!TASK_ID) {
    log('INFO', 'No TASK_ID resolved — skipping PR creation')
    return
  }

  const repoRoot = process.cwd().replace(/\.github[\\/]agents$/, '')
  process.chdir(repoRoot)

  // Check for changes
  const status = run('git status --porcelain')
  if (!status) {
    log('INFO', 'No changes detected — skipping PR creation')
    return
  }

  log('INFO', `Changes detected:\n${status}`)

  const date = new Date().toISOString().slice(0, 10)
  const branch = `aref/${TASK_ID.toLowerCase()}-${date}`
  const taskModule = await import(`./tasks/${TASK_ID}.mjs`)
  const { TASK_META } = taskModule

  // Configure git
  run('git config user.name "AREF Agent"')
  run('git config user.email "aref-agent@mcl-wms.local"')

  // Create branch
  try {
    run(`git checkout -b ${branch}`)
  } catch {
    run(`git checkout ${branch}`)
  }

  // Stage and commit
  run('git add -A')
  const commitMsg = `refactor(${TASK_ID}): ${TASK_META.name}\n\nExecuted by AREF agent.\nRisk: ${TASK_META.risk}\n\nCo-Authored-By: AREF Agent <aref-agent@mcl-wms.local>`

  try {
    run(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`)
  } catch (err) {
    log('WARN', `Commit failed: ${err.message}`)
    return
  }

  // Push branch (force in case branch already exists from a previous run)
  run(`git push --force origin ${branch}`)

  // Create PR
  const prBody = `## ${TASK_META.name}

**Task ID:** ${TASK_ID}
**Risk:** ${TASK_META.risk}
**Agent:** AREF (Agente de Refactoring Arquitectonico)

### Cambios
${(TASK_META.files_modified || []).map(f => `- Modified: \`${f}\``).join('\n')}
${(TASK_META.files_created || []).map(f => `- Created: \`${f}\``).join('\n')}

### Validacion requerida
${TASK_META.validation}

### Checklist
- [ ] Revisar los cambios
- [ ] Verificar que build compila sin errores
- [ ] Verificar que no hay regresiones
- [ ] Aprobar y merge

---
*Generado automaticamente por AREF Agent*`

  // gh CLI uses GH_TOKEN env var for authentication in GitHub Actions
  const ghEnv = GITHUB_TOKEN ? { GH_TOKEN: GITHUB_TOKEN } : {}

  try {
    // Check if PR already exists for this branch
    const existingPr = run(`gh pr list --head ${branch} --state open --json url --jq ".[0].url"`, ghEnv)
    if (existingPr) {
      log('INFO', `PR already exists: ${existingPr} — branch updated via force push`)
      return
    }
  } catch {
    // No existing PR, continue creating one
  }

  // Write PR body to temp file outside repo to avoid uncommitted change warning
  const bodyFile = '/tmp/aref-pr-body.md'
  writeFileSync(bodyFile, prBody)

  try {
    const prTitle = `refactor(${TASK_ID}): ${TASK_META.name}`
    const prUrl = run(`gh pr create --title "${prTitle}" --body-file /tmp/aref-pr-body.md --base master`, ghEnv)
    log('SUCCESS', `PR created: ${prUrl}`)
  } catch (err) {
    log('ERROR', `PR creation failed: ${err.message}`)
  }
}

main().catch(err => {
  log('FATAL', err.message)
  process.exit(1)
})
