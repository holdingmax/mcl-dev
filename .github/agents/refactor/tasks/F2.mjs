// ═══ F2 — Partir functions/index.js en modulos ═══
// Extrae funciones del monolito en modulos separados.
// Riesgo medio: no cambia logica, solo mueve codigo.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { askClaude } from '../../shared/claude-client.mjs'

export const TASK_META = {
  id: 'F2',
  name: 'Partir functions/index.js en modulos',
  description: 'Extraer parseSheetRows, computeDiffs, buildSystemMaps, applyDiffToSystem, applyNewToSystem, applyPendingToReal y helpers de sync en modulos separados bajo functions/src/.',
  risk: 'medium',
  files_modified: ['functions/index.js'],
  files_created: [
    'functions/src/sheetSync/parser.js',
    'functions/src/sheetSync/diff.js',
    'functions/src/sheetSync/apply.js',
    'functions/src/sheetSync/helpers.js',
    'functions/src/holds/sync.js',
  ],
  validation: 'firebase deploy --only functions debe completar sin errores. sheetSyncAgent debe ejecutar correctamente.',
}

// Function boundaries in index.js (approximate — Claude will refine)
const EXTRACTION_PLAN = [
  {
    target: 'functions/src/sheetSync/helpers.js',
    functions: ['sheetNormStr', 'sheetParseDate', 'sheetIsYes', 'SHEET_HEADER_ALIASES', 'computeAwbNumbersNormalized'],
    description: 'Shared helpers used across all sheet sync modules',
  },
  {
    target: 'functions/src/sheetSync/parser.js',
    functions: ['parseSheetRows', 'rowHash'],
    description: 'Sheet parsing and row hashing',
    imports_from: ['helpers.js'],
  },
  {
    target: 'functions/src/sheetSync/diff.js',
    functions: ['computeDiffs', 'buildSystemMaps', 'isTodayOrPast'],
    description: 'Diff computation and system map building',
    imports_from: ['helpers.js'],
  },
  {
    target: 'functions/src/sheetSync/apply.js',
    functions: ['applyDiffToSystem', 'applyNewToSystem', 'applyPendingToReal'],
    description: 'Apply changes to Firestore',
    imports_from: ['helpers.js'],
  },
  {
    target: 'functions/src/holds/sync.js',
    functions: ['/* holds sync step 9 logic */'],
    description: 'Holds auto-sync from bookings to airfreight_holds collection',
  },
]

export async function execute(ctx) {
  const { repoRoot, log } = ctx
  const indexPath = join(repoRoot, 'functions', 'index.js')
  const indexContent = readFileSync(indexPath, 'utf8')
  const totalLines = indexContent.split('\n').length

  log('ANALYZE', `functions/index.js: ${totalLines} lines`)

  // Step 1: Ask Claude to identify exact function boundaries
  const analysisPrompt = `Analiza este archivo JavaScript y devuelve un JSON con las posiciones exactas de cada funcion.
El archivo tiene ${totalLines} lineas.

Para cada funcion en esta lista, dame la linea de inicio y la linea de fin:
- SHEET_HEADER_ALIASES (es un array/Map declarado con const)
- sheetNormStr
- sheetParseDate
- sheetIsYes
- computeAwbNumbersNormalized
- parseSheetRows
- rowHash
- computeDiffs
- buildSystemMaps
- isTodayOrPast
- applyDiffToSystem
- applyNewToSystem
- applyPendingToReal

Responde SOLO con JSON:
{
  "functions": [
    { "name": "sheetNormStr", "start_line": N, "end_line": N },
    ...
  ]
}

IMPORTANTE: Las lineas deben ser exactas. Incluye la linea de la firma de la funcion y la llave de cierre.`

  // Send chunks of the file for analysis (first 100 lines for context + the sync agent section)
  const lines = indexContent.split('\n')

  // Find the sheet sync section (usually starts around line 2200+)
  let syncStart = 0
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('SHEET_HEADER_ALIASES') || lines[i].includes('sheetNormStr')) {
      syncStart = Math.max(0, i - 5)
      break
    }
  }

  const relevantSection = lines.slice(syncStart, Math.min(syncStart + 1200, lines.length))
    .map((l, i) => `${syncStart + i + 1}: ${l}`)
    .join('\n')

  log('CLAUDE', `Sending ${relevantSection.split('\n').length} lines for analysis (from line ${syncStart + 1})`)

  const analysis = await askClaude(
    'Eres un analizador de codigo. Responde SOLO con JSON valido.',
    analysisPrompt + '\n\nCODIGO:\n' + relevantSection,
    { maxTokens: 4096 }
  )

  let boundaries
  try {
    const match = analysis.match(/\{[\s\S]*\}/)
    boundaries = JSON.parse(match[0])
  } catch (err) {
    log('ERROR', `Claude analysis parse failed: ${err.message}`)
    return { error: 'Claude analysis failed', raw: analysis.substring(0, 500) }
  }

  log('ANALYZE', `Found ${boundaries.functions.length} function boundaries`)

  // Step 2: Extract functions into modules
  const srcDir = join(repoRoot, 'functions', 'src')
  const sheetSyncDir = join(srcDir, 'sheetSync')
  const holdsDir = join(srcDir, 'holds')

  for (const dir of [srcDir, sheetSyncDir, holdsDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  // Group functions by target module
  const moduleMap = new Map()
  for (const plan of EXTRACTION_PLAN) {
    moduleMap.set(plan.target, {
      ...plan,
      extractedCode: [],
      extractedRanges: [],
    })
  }

  // Map function names to their target modules
  const fnToModule = {
    'SHEET_HEADER_ALIASES': 'functions/src/sheetSync/helpers.js',
    'sheetNormStr': 'functions/src/sheetSync/helpers.js',
    'sheetParseDate': 'functions/src/sheetSync/helpers.js',
    'sheetIsYes': 'functions/src/sheetSync/helpers.js',
    'computeAwbNumbersNormalized': 'functions/src/sheetSync/helpers.js',
    'parseSheetRows': 'functions/src/sheetSync/parser.js',
    'rowHash': 'functions/src/sheetSync/parser.js',
    'computeDiffs': 'functions/src/sheetSync/diff.js',
    'buildSystemMaps': 'functions/src/sheetSync/diff.js',
    'isTodayOrPast': 'functions/src/sheetSync/diff.js',
    'applyDiffToSystem': 'functions/src/sheetSync/apply.js',
    'applyNewToSystem': 'functions/src/sheetSync/apply.js',
    'applyPendingToReal': 'functions/src/sheetSync/apply.js',
  }

  // Extract each function
  for (const fn of boundaries.functions) {
    const target = fnToModule[fn.name]
    if (!target) {
      log('SKIP', `No target module for ${fn.name}`)
      continue
    }

    const mod = moduleMap.get(target)
    if (!mod) continue

    const start = fn.start_line - 1 // 0-indexed
    const end = fn.end_line // exclusive
    const code = lines.slice(start, end).join('\n')

    mod.extractedCode.push(code)
    mod.extractedRanges.push({ start, end, name: fn.name })

    log('EXTRACT', `${fn.name} (lines ${fn.start_line}-${fn.end_line}) → ${target}`)
  }

  // Step 3: Write module files
  const filesCreated = []
  for (const [targetPath, mod] of moduleMap) {
    if (mod.extractedCode.length === 0) continue

    const fullPath = join(repoRoot, targetPath)
    const exportNames = mod.extractedCode
      .map(code => {
        // Find function/const name
        const m = code.match(/^(?:function|const|let|var)\s+(\w+)/) ||
                  code.match(/^(async\s+)?function\s+(\w+)/)
        return m ? (m[2] || m[1]) : null
      })
      .filter(Boolean)

    // Build module content
    let moduleContent = `// ═══ ${mod.description} ═══\n// Extracted from functions/index.js by AREF agent\n\n`

    // Add required imports
    if (targetPath !== 'functions/src/sheetSync/helpers.js') {
      const helperImports = []
      for (const code of mod.extractedCode) {
        if (code.includes('sheetNormStr')) helperImports.push('sheetNormStr')
        if (code.includes('sheetParseDate')) helperImports.push('sheetParseDate')
        if (code.includes('sheetIsYes')) helperImports.push('sheetIsYes')
        if (code.includes('SHEET_HEADER_ALIASES')) helperImports.push('SHEET_HEADER_ALIASES')
        if (code.includes('computeAwbNumbersNormalized')) helperImports.push('computeAwbNumbersNormalized')
      }
      const unique = [...new Set(helperImports)]
      if (unique.length > 0) {
        moduleContent += `const { ${unique.join(', ')} } = require('./helpers')\n\n`
      }
    }

    if (targetPath.includes('apply') || targetPath.includes('holds')) {
      moduleContent += `// Note: db and admin are injected via init()\nlet db = null\nlet admin = null\n\n`
      moduleContent += `function init(firebaseDb, firebaseAdmin) { db = firebaseDb; admin = firebaseAdmin }\n\n`
    }

    if (targetPath.includes('parser')) {
      moduleContent += `const crypto = require('crypto')\n\n`
    }

    // Add function code
    for (const code of mod.extractedCode) {
      moduleContent += code + '\n\n'
    }

    // Add exports
    const allNames = []
    for (const code of mod.extractedCode) {
      const nameMatch = code.match(/^(?:async\s+)?function\s+(\w+)/) ||
                        code.match(/^const\s+(\w+)\s*=/)
      if (nameMatch) allNames.push(nameMatch[1])
    }

    moduleContent += `module.exports = { ${allNames.join(', ')}`
    if (targetPath.includes('apply') || targetPath.includes('holds')) {
      moduleContent += `, init`
    }
    moduleContent += ` }\n`

    writeFileSync(fullPath, moduleContent)
    filesCreated.push(targetPath)
    log('WRITE', `${targetPath} — ${allNames.length} exports: ${allNames.join(', ')}`)
  }

  // Step 4: Update index.js to require() the new modules
  // We add requires at the top and replace extracted functions with comments
  const requireBlock = `
// ── Extracted modules ─────────────────────────────────────────────────────────
const { ${Object.keys(fnToModule).filter(k => fnToModule[k].includes('helpers')).join(', ')} } = require('./src/sheetSync/helpers')
const { parseSheetRows, rowHash } = require('./src/sheetSync/parser')
const { computeDiffs, buildSystemMaps, isTodayOrPast } = require('./src/sheetSync/diff')
const { applyDiffToSystem, applyNewToSystem, applyPendingToReal, init: initApply } = require('./src/sheetSync/apply')

// Initialize modules that need db/admin
initApply(db, admin)
`

  // Remove extracted functions from index.js (replace with comment)
  let updatedIndex = indexContent

  // Sort ranges by start position descending (to avoid offset issues)
  const allRanges = []
  for (const [, mod] of moduleMap) {
    allRanges.push(...mod.extractedRanges)
  }
  allRanges.sort((a, b) => b.start - a.start)

  for (const range of allRanges) {
    const before = updatedIndex.split('\n').slice(0, range.start)
    const after = updatedIndex.split('\n').slice(range.end)
    before.push(`// [AREF] ${range.name} — moved to src/sheetSync/`)
    updatedIndex = [...before, ...after].join('\n')
  }

  // Add require block after the db/bucket initialization
  const dbInitLine = updatedIndex.indexOf('const bucket = admin.storage().bucket()')
  if (dbInitLine >= 0) {
    const insertAt = updatedIndex.indexOf('\n', dbInitLine) + 1
    updatedIndex = updatedIndex.slice(0, insertAt) + requireBlock + updatedIndex.slice(insertAt)
  }

  writeFileSync(indexPath, updatedIndex)
  log('WRITE', `functions/index.js — removed ${allRanges.length} extracted functions, added require() block`)

  return {
    files_modified: ['functions/index.js'],
    files_created: filesCreated,
    functions_extracted: allRanges.map(r => r.name),
    changes: [
      `Extracted ${allRanges.length} functions into ${filesCreated.length} modules`,
      `index.js reduced from ${totalLines} to ~${updatedIndex.split('\n').length} lines`,
      'Added require() imports to index.js',
      'No logic changes — pure code movement',
    ],
  }
}
