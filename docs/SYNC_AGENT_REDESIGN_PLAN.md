# Sheet Sync Agent — Plan de Rediseno Integral

**Fecha:** 2026-06-05
**Version:** 1.0
**Estado:** PENDIENTE APROBACION — NO PROGRAMAR

---

## Contexto

El Sheet Sync Agent actual (functions/index.js, ~2000 lineas de logica sync) ha acumulado 30+ iteraciones de parches que no resolvieron los problemas estructurales. Este documento propone un rediseno completo con fases incrementales, cada una desplegable y reversible de forma independiente.

### Problemas raiz confirmados en codigo

| # | Defecto | Linea(s) | Impacto |
|---|---------|----------|---------|
| D1 | `allFlights` solo carga vuelos del cliente actual (via booking.flight_id) | 3877-3890 | No ve vuelos de otros clientes → crea duplicados cross-client |
| D2 | `isDateClose()` retorna `true` cuando ETD es null | 2308 | Cualquier vuelo sin ETD matchea con cualquier fecha |
| D3 | Step 2 fuzzy matching ±1-2 dias | 2873, 3504 | Vuelos recurrentes (LA-0543 lunes y jueves) se mezclan |
| D4 | `removed_from_sheet` solo genera alerta, nunca actua | 4477-4489 | AWBs orphanas permanecen indefinidamente en vuelos |
| D5 | No existe `flight_instance_key` | - | Imposible distinguir LA-0543 del 02/06 vs LA-0543 del 05/06 |
| D6 | Snapshot key = `client_id + monthKey` (mes actual) | 3821 | Cambio de mes = snapshot nuevo = todo parece "new" |
| D7 | Move PENDING→Real y Real→Real no son atomicos | 2949-3027 | Si falla a mitad, AWB puede quedar en ambos o ninguno |
| D8 | Normalizacion inconsistente (`normalizeFlightNumber` vs `flightMatchKey` vs `sheetNormStr`) | 2257, 2294, 2254 | Diferentes funciones para el mismo proposito |

---

## FASE 1: flight_instance_key (Fundacion)

### Que es
Un campo nuevo en `airfreight_flights` que identifica de forma unica cada instancia de un vuelo recurrente:

```
flight_instance_key = normalizeFlightNumber(flight_number) + '_' + etdDate
// Ejemplo: "LA-0543_2026-06-02", "LA-0543_2026-06-05"
```

Para vuelos sin ETD (draft): `flight_instance_key = normalizeFlightNumber(flight_number) + '_DRAFT'`

### Cambios requeridos

**1.1 — Nuevo campo en Firestore**
- Agregar `flight_instance_key` a todos los documentos de `airfreight_flights`
- No requiere cambio de schema (Firestore es schemaless), solo escribir el campo

**1.2 — Funcion unica de generacion**
```
function buildInstanceKey(flightNumber, etdDateOrIso) {
  const fn = normalizeFlightNumber(flightNumber)
  if (!fn || /^(PENDING|TBD|TBA)$/.test(fn)) return null
  const date = (etdDateOrIso || '').slice(0, 10)
  if (!date || date.length !== 10) return fn + '_DRAFT'
  return fn + '_' + date
}
```

**1.3 — Matching por instance key (reemplaza Step 1 + Step 2)**
```
// NUEVO: busqueda exacta por instance key
targetFlight = allFlights.find(f =>
  f.flight_instance_key === targetKey &&
  !isFlightBlocked(f)
)
```

**1.4 — Eliminar Step 2 fuzzy, `isDateClose()`, `resolveAmbiguousCandidates()`**
- Estas funciones dejan de existir
- Si no hay match exacto por instance key, se crea vuelo nuevo
- `firestoreFlightDedup` (H02) se simplifica: buscar por `flight_instance_key` exacto

### Riesgos Fase 1
| Riesgo | Probabilidad | Mitigacion |
|--------|-------------|------------|
| Vuelo existente sin `flight_instance_key` no matchea | Alta (todos los vuelos actuales) | Migracion de datos ANTES de activar codigo nuevo |
| ETD cambia despues de crear vuelo → key desincronizada | Media | Cloud Function trigger en update de flight: recalcular key |
| Dos AWBs del mismo vuelo llegan con ETD diferente por horas (timezone) | Baja | `slice(0,10)` normaliza a fecha, no hora |

### Criterio de exito
- 0 vuelos duplicados creados en 48 horas de operacion
- Todos los vuelos existentes tienen `flight_instance_key` populated
- Step 2 fuzzy eliminado completamente del codigo

---

## FASE 2: Gate de Estado del Vuelo

### Que es
Antes de agregar un AWB a un vuelo, verificar si el vuelo tiene actividad operativa que lo hace "intocable" por el sync agent.

### Niveles de actividad (de menor a mayor proteccion)

| Nivel | Condicion | Accion del Sync |
|-------|-----------|-----------------|
| L0 — Limpio | Sin doc_receptions, sin ULDs, sin DOs, sin screening | Sheet manda: agregar/mover/remover libremente |
| L1 — Recibido | Tiene doc_receptions pero sin piezas en ULDs | Sheet manda para campos no-criticos. Agregar AWBs nuevos OK. Remover → alerta |
| L2 — En Build-up | Piezas asignadas a ULDs | Solo alertas. No mover, no remover, no cambiar PCS/CW |
| L3 — Dispatched | Vuelo despachado | Bloqueo total. Solo alertas informativas |

### Cambios requeridos

**2.1 — Funcion `getFlightActivityLevel(flightId)`**
Consulta en una sola pasada:
- `airfreight_doc_receptions` where `flight_id` == flightId
- `airfreight_physical_pieces` where `uld_id` != null (via doc_receptions)
- `airfreight_holds` where `flight_id` == flightId
- `delivery_orders` where `flight_id` == flightId
- `airfreight_flights.status` / `dispatched_at`

Retorna: `{ level: 'L0'|'L1'|'L2'|'L3', details: {...} }`

**2.2 — Gate en `applyNewToSystem`, `applyPendingToReal`, `applyRealToReal`**
Antes de agregar AWB a vuelo destino:
```
const activity = await getFlightActivityLevel(targetFlight.id)
if (activity.level >= 'L2') {
  // No agregar — generar alerta
  return { ok: false, msg: `Flight ${targetFlight.flight_number} has L${n} activity — manual review required` }
}
```

**2.3 — Gate en AWB individual (no solo vuelo)**
Para `removed_from_sheet` y moves, verificar actividad del AWB especifico:
```
const awbHasActivity = receivedAwbs.has(awbNorm) || builtAwbs.has(awbNorm)
```

### Riesgos Fase 2
| Riesgo | Probabilidad | Mitigacion |
|--------|-------------|------------|
| Gate demasiado restrictivo bloquea AWBs legitimos | Media | L0 y L1 permiten operaciones. Solo L2+ bloquea |
| Performance: queries adicionales por vuelo | Baja | Cache `flightActivityCache` durante el ciclo sync |
| Vuelo tiene 1 AWB recibido pero 5 sin recibir → bloquea a los 5 | Media | Gate es por AWB individual, no por vuelo completo (excepto L3) |

### Criterio de exito
- 0 AWBs agregadas automaticamente a vuelos con build-up activo
- Alertas generadas correctamente para operaciones bloqueadas
- AWBs sin actividad siguen fluyendo normalmente

---

## FASE 3: Cleanup Seguro de Orphans

### Que es
Cuando un AWB desaparece de la planilla (fila eliminada por el cliente), el sistema debe:
1. Verificar que el AWB no tiene actividad (L0)
2. Si L0: remover automaticamente del booking
3. Si L1+: generar alerta para revision manual

### Cambios requeridos

**3.1 — Reemplazar handler actual de `removed_from_sheet`**

Codigo actual (lineas 4477-4489): solo genera alerta.

Codigo nuevo:
```
for (const key of removedKeys) {
  const sys = byAwb1.get(key)
  if (!sys) continue

  const awbNorm = sheetNormStr(sys.awb1st)
  const hasActivity = receivedAwbs.has(awbNorm) || builtAwbs.has(awbNorm)

  if (hasActivity) {
    // L1+: solo alerta, no tocar
    await db.collection('_sheet_sync_alerts').add({
      ...alertData,
      alert_type: 'removed_from_sheet_protected',
      message: `AWB has warehouse activity — requires manual removal`,
    })
  } else {
    // L0: remover automaticamente
    await removeAwbFromBooking(sys.bookingId, sys.awb1st)
    await db.collection('_sheet_sync_alerts').add({
      ...alertData,
      alert_type: 'removed_from_sheet_cleaned',
      message: `AWB auto-removed (no warehouse activity)`,
      status: 'applied',
    })
  }
}
```

**3.2 — Funcion `removeAwbFromBooking(bookingId, awbNumber)`**
- Transaccion Firestore
- Busca AWB en `awb_lines` por normalized match
- Remueve la linea
- Recalcula `pieces`, `awb_numbers_normalized`
- Si booking queda vacio (0 lines), marcar `status: 'empty'` (no borrar)

**3.3 — Booking vacio no se borra**
Un booking sin AWB lines queda como registro historico. El dashboard lo puede filtrar.

### Riesgos Fase 3
| Riesgo | Probabilidad | Mitigacion |
|--------|-------------|------------|
| Cliente borra fila por error → AWB desaparece del sistema | Media | Solo L0 se borra auto. L1+ requiere confirmacion manual |
| Snapshot reset (cambio de mes) marca todo como "removed" | Alta | **BLOQUEANTE**: Fase 3 requiere que Fase 5 (snapshot fix) este completada primero |
| Timing: AWB llega al warehouse 5 min despues de que sync la borro | Baja | `reconcileOrphanDocReceptions` ya existe y re-linkea |

### Dependencia critica
**Fase 3 NO puede activarse sin Fase 5 (snapshot persistente).** Si el snapshot se resetea al cambiar de mes, todas las AWBs del mes anterior aparecen como "removed" y se borran masivamente.

### Criterio de exito
- AWBs sin actividad se remueven en < 15 min despues de borrar la fila
- AWBs con actividad generan alerta sin ser tocadas
- 0 borrados masivos por cambio de mes

---

## FASE 4: Atomic Moves

### Que es
Cuando un AWB se mueve de un vuelo a otro (PENDING→Real o Real→Real), la operacion debe ser atomica: o se completa todo o no se hace nada.

### Cambios requeridos

**4.1 — Transaccion unica para move**
Actualmente, `applyPendingToReal` hace:
1. Transaction: remove from source booking (lineas 2949-2964)
2. Regular write: add to target booking (lineas 2993-3027)

Si paso 2 falla, el AWB queda removida del source sin estar en el target.

Cambio: una sola transaccion que lee source Y target, y escribe ambos:
```
await db.runTransaction(async (t) => {
  const sourceSnap = await t.get(sourceBookingRef)
  const targetSnap = await t.get(targetBookingRef)

  // Remove from source
  const sourceLines = [...sourceSnap.data().awb_lines]
  const idx = sourceLines.findIndex(...)
  if (idx < 0) return // idempotent
  const [movedLine] = sourceLines.splice(idx, 1)

  // Add to target
  const targetLines = [...(targetSnap.data().awb_lines || []), movedLine]

  t.update(sourceBookingRef, { awb_lines: sourceLines, ... })
  t.update(targetBookingRef, { awb_lines: targetLines, ... })
})
```

**4.2 — Caso especial: target booking no existe**
Si hay que crear un booking nuevo, no se puede hacer dentro de la misma transaccion (Firestore limitation: no `add` in transactions).

Solucion: crear booking vacio ANTES de la transaccion, luego la transaccion mueve la linea.

```
// 1. Create empty target booking (or find existing)
let targetBookingRef = existingBooking?.ref
if (!targetBookingRef) {
  targetBookingRef = await db.collection('airfreight_bookings').add({ ...emptyBooking })
}

// 2. Atomic move
await db.runTransaction(async (t) => {
  // remove from source, add to target
})
```

Si la transaccion falla, queda un booking vacio que no afecta operaciones.

### Riesgos Fase 4
| Riesgo | Probabilidad | Mitigacion |
|--------|-------------|------------|
| Transacciones mas lentas (2 reads en vez de 1) | Baja | Irrelevante: sync corre cada 3 min, no es real-time |
| Bookings vacios por transacciones fallidas | Baja | Cleanup job que borra bookings con 0 lines y status 'empty' |
| Conflicto de transaccion si 2 AWBs se mueven al mismo booking simultaneamente | Muy baja | Firestore auto-retry en conflictos de transaccion |

### Criterio de exito
- 0 AWBs perdidas durante moves
- 0 AWBs duplicadas despues de moves
- Cada move es todo-o-nada

---

## FASE 5: Snapshot Persistente Cross-Month

### Que es
Actualmente, el snapshot key es `client_id + monthKey` donde monthKey es el mes actual (`2026-06`). Cuando cambia el mes, se crea un snapshot nuevo vacio, y todas las AWBs del mes anterior aparecen como "new" (se duplican) o como "removed" (si Fase 3 esta activa, se borran).

### Cambios requeridos

**5.1 — Snapshot key basado en tab, no en mes**
```
// ANTES:
const monthKey = new Date().toISOString().slice(0, 7) // "2026-06"
const snapshotId = `${config.client_id}_${monthKey}`

// DESPUES:
const snapshotId = `${config.client_id}_${tabTitle}`  // "client123_Junio 2026"
```

Cuando se leen multiples tabs (mes actual + mes anterior en los primeros 5 dias), cada tab tiene su propio snapshot.

**5.2 — Merge de snapshots para deteccion de "removed"**
```
// Combinar hashes de todos los tabs leidos
const allCurrentHashes = {}
for (const tabResult of tabParseResults) {
  Object.assign(allCurrentHashes, tabResult.hashes)
}

// "Removed" = en ALGUN snapshot previo pero en NINGUN tab actual
const allPrevHashes = {} // merge de todos los snapshots previos de este client
for (const tabResult of tabParseResults) {
  const prevSnap = await getSnapshot(config.client_id, tabResult.tabTitle)
  Object.assign(allPrevHashes, prevSnap.row_hashes)
}
const removedKeys = Object.keys(allPrevHashes).filter(k => !(k in allCurrentHashes))
```

**5.3 — Limpieza de snapshots viejos**
Snapshots de tabs de hace > 3 meses se pueden borrar (opcional, no critico).

### Riesgos Fase 5
| Riesgo | Probabilidad | Mitigacion |
|--------|-------------|------------|
| Snapshot ID con caracteres especiales (tildes en "Junio") | Media | Sanitizar tab title: `tabTitle.replace(/[^a-zA-Z0-9_-]/g, '_')` |
| Tab renombrado → snapshot no matchea → todo parece "new" | Baja | Usar patron de mes normalizado, no nombre literal |
| Multiples tabs con misma AWB → hash conflict | Media | Dedup existente (linea 3804) ya maneja esto |

### Criterio de exito
- Cambio de mes no genera duplicados
- Cambio de mes no genera "removed" falsos
- AWBs que genuinamente desaparecen SI se detectan

---

## FASE 6: allFlights Cross-Client

### Que es
Actualmente, `allFlights` solo carga vuelos referenciados por bookings del cliente actual (lineas 3877-3890). Esto significa que si otro cliente ya creo el vuelo LA-0543, este cliente no lo ve y crea un duplicado.

El `firestoreFlightDedup` (H02) intenta compensar esto, pero:
- Solo busca por `flight_number` exacto (no por instance key)
- Usa `isDateClose` con fallback ±1 dia (contamina vuelos recurrentes)

### Cambios requeridos

**6.1 — Cargar vuelos por instance key, no por booking**
```
// ANTES: solo vuelos del cliente
const flightIds = new Set(bookings.map(b => b.flight_id).filter(Boolean))
// ... load by ID

// DESPUES: todos los vuelos activos del periodo relevante
const etdStart = getEarliestEtdFromSheetRows(sheetRows) // ej: "2026-06-01"
const etdEnd = getLatestEtdFromSheetRows(sheetRows)     // ej: "2026-06-30"

const allFlightsSnap = await db.collection('airfreight_flights')
  .where('flight_datetime', '>=', etdStart)
  .where('flight_datetime', '<=', etdEnd + 'T23:59:59')
  .get()

// Tambien cargar vuelos draft (sin ETD) y vuelos PENDING
const draftSnap = await db.collection('airfreight_flights')
  .where('status', '==', 'draft')
  .get()
const pendingSnap = await db.collection('airfreight_flights')
  .where('flight_number', '==', 'PENDING')
  .get()
```

**6.2 — Eliminar `firestoreFlightDedup` (H02)**
Ya no es necesario como paso separado — todos los vuelos relevantes estan en `allFlights`.

**6.3 — Index de Firestore**
Requiere composite index en `airfreight_flights`:
- `flight_datetime` (ASC) — para range queries
- `flight_instance_key` (ASC) — para exact match queries

### Riesgos Fase 6
| Riesgo | Probabilidad | Mitigacion |
|--------|-------------|------------|
| Carga masiva de vuelos (performance) | Baja | Rango de 1-2 meses, ~50-100 vuelos max |
| Vuelos de otros clientes se modifican accidentalmente | Media | Solo se LEEN para matching. Escritura solo en vuelo matcheado |
| Index de Firestore no existe → query falla | Alta | Crear index ANTES de deploy |

### Criterio de exito
- 0 vuelos duplicados cross-client
- `firestoreFlightDedup` eliminado del codigo
- Todos los vuelos del periodo cargados en una sola pasada

---

## FASE 7: Normalizacion Unificada

### Que es
Actualmente existen 3 funciones de normalizacion que se usan inconsistentemente:
- `normalizeFlightNumber()` (linea 2257): strips suffixes, adds hyphen
- `flightMatchKey()` (linea 2294): strips hyphens AND spaces (destructive)
- `sheetNormStr()` (linea 2254): trim + uppercase (generic)

### Cambios requeridos

**7.1 — Una sola funcion para vuelos**
```
function normalizeFlightNumber(raw) {
  let s = (raw || '').trim().toUpperCase()
  if (!s || /^(PENDING|TBD|TBA|N\/A)$/i.test(s)) return s
  s = s.replace(/\s+(A\d+|PAX|CAO|LOOSE|CARGO)$/, '')
  if (!s.includes('-')) {
    const m = s.match(/^([A-Z]{1,3})(\d{3,5})$/)
    if (m) s = `${m[1]}-${m[2]}`
  }
  return s
}
```
Esta es la existente y es correcta. Eliminar `flightMatchKey()` completamente.

**7.2 — Matching siempre por `flight_instance_key`**
No mas comparaciones de strings ad-hoc. Todo pasa por:
```
buildInstanceKey(flightNumber, etd) === flight.flight_instance_key
```

**7.3 — Una sola funcion para AWBs**
```
function normalizeAwb(raw) {
  return (raw || '').trim().toUpperCase().replace(/\s+/g, '')
}
```

### Riesgo bajo. Esta fase es limpieza de codigo.

---

## PLAN DE MIGRACION DE DATOS EXISTENTES

### M1 — Generar `flight_instance_key` para vuelos existentes

**Script:** `scripts/migrate_flight_instance_keys.cjs`

```
Para cada vuelo en airfreight_flights:
  1. fn = normalizeFlightNumber(flight.flight_number)
  2. date = (flight.flight_datetime || '').slice(0, 10)
  3. key = fn ? (date ? fn + '_' + date : fn + '_DRAFT') : null
  4. Escribir flight_instance_key = key
```

**Validacion pre-ejecucion:**
- Listar todos los keys generados
- Identificar duplicados (dos docs con mismo key)
- Para duplicados: determinar cual es el "real" (tiene bookings con AWBs) y cual es fantasma

### M2 — Detectar y resolver vuelos duplicados

**Criterio de duplicado:** Mismo `flight_instance_key`, multiples documentos.

**Resolucion por caso:**

| Caso | Accion |
|------|--------|
| Ambos tienen bookings con AWBs | MANUAL: requiere decision del operador |
| Uno tiene bookings, otro no | Cancelar el vacio. Verificar que no hay refs rotas |
| Ambos vacios | Cancelar el mas reciente |
| Uno dispatched, otro open | El open es un duplicado del sync. Mover sus AWBs si no estan en el dispatched, luego cancelar |

**Script:** `scripts/dedup_flights.cjs` — modo dry-run primero, luego modo apply.

### M3 — Separar instancias mezcladas (caso LA-0543)

**Diagnostico:**
1. Listar todos los bookings del vuelo afectado
2. Para cada AWB, verificar en la planilla actual: a que fecha de vuelo corresponde?
3. Si AWB corresponde a otra fecha → moverla al vuelo correcto (o crear nuevo)

**Script:** `scripts/fix_la543_contamination.cjs`
- Lee planilla actual via Sheets API
- Compara AWBs en sistema vs planilla
- Para AWBs que no estan en planilla para esa fecha: genera reporte (no mueve)
- Operador confirma, luego ejecuta con flag `--apply`

### M4 — Limpiar AWBs orphanas sin riesgo

**Definicion de orphan:** AWB en sistema que NO esta en la planilla actual del cliente Y no tiene actividad de warehouse (L0).

**Proceso:**
1. Leer planilla actual
2. Listar todas las AWBs en bookings del cliente
3. Diff: AWBs en sistema pero no en planilla
4. Filtrar: solo L0 (sin doc_reception, sin ULD, sin DO)
5. Generar reporte para revision
6. Ejecutar con confirmacion

### M5 — Vuelos dispatched, con DOs, con screening, con holds

**Regla:** NO TOCAR. Estos vuelos no se migran, no se modifican, no se limpian.
- Se les agrega `flight_instance_key` (paso M1) para referencia futura
- Pero el sync agent jamas los modifica (gate L3)
- Los datos historicos quedan como estan

### M6 — Vuelos draft (sin ETD)

**Regla:** Se les asigna key `fn + '_DRAFT'`.
- Si posteriormente reciben ETD, el key se actualiza automaticamente (trigger en Fase 1)
- Si hay multiples drafts del mismo vuelo, se consolidan

### Timeline de migracion

```
Dia 0: Ejecutar M1 (agregar keys) — safe, additive, no rompe nada
Dia 0: Ejecutar M2 dry-run — solo reporte
Dia 1: Revisar reporte M2 con operaciones, confirmar acciones
Dia 1: Ejecutar M2 apply
Dia 1: Ejecutar M3 dry-run para LA-0543 y otros vuelos reportados
Dia 2: Confirmar M3, aplicar
Dia 2: Ejecutar M4 dry-run
Dia 3: Confirmar M4 con operaciones, aplicar
```

---

## PLAN DE PRUEBAS (QA)

### T1 — Modo Dry-Run

**Implementacion:** Flag `DRY_RUN = true` en `runSheetSync()`.

Cuando `DRY_RUN`:
- Toda la logica de comparacion y matching se ejecuta normalmente
- Toda escritura a Firestore se reemplaza por log detallado
- Se escribe resultado en `_sheet_sync_dry_runs` collection
- Log incluye: "WOULD create flight X", "WOULD add AWB Y to flight Z", "WOULD remove AWB W"

**Output del dry-run:**
```json
{
  "run_id": "...",
  "client": "...",
  "timestamp": "...",
  "actions": [
    { "type": "match_flight", "awb": "369-10113110", "flight_key": "LA-0543_2026-06-05", "matched_id": "abc123" },
    { "type": "add_awb", "awb": "369-10113110", "to_booking": "def456", "to_flight": "abc123" },
    { "type": "remove_awb", "awb": "369-99802522", "from_booking": "ghi789", "reason": "not_in_sheet", "activity_level": "L0" },
    { "type": "skip_remove", "awb": "369-99802533", "from_booking": "jkl012", "reason": "has_activity", "activity_level": "L1" }
  ]
}
```

### T2 — Simulaciones

**T2.1 — Vuelos recurrentes**
Datos de prueba: LA-0543 con ETD 06/02, 06/05, 06/08
- Verificar que cada fecha genera instance key distinto
- Verificar que AWBs no se mezclan entre instancias

**T2.2 — Semanas cambiantes**
Simular cambio de mes (Mayo → Junio):
- Verificar que snapshot persistente no marca AWBs de Mayo como "new" en Junio
- Verificar que AWBs que genuinamente desaparecen SI se detectan

**T2.3 — AWBs con actividad**
Simular que AWB "369-10113110" tiene doc_reception:
- Verificar que gate L1 bloquea auto-removal
- Verificar que alerta se genera correctamente

**T2.4 — AWBs sin actividad**
Simular que AWB "369-10113110" NO tiene doc_reception:
- Verificar que se remueve automaticamente al desaparecer de la planilla

**T2.5 — ETD nulo**
Simular vuelo creado sin ETD:
- Verificar que se crea como draft con key `fn_DRAFT`
- Verificar que al recibir ETD, key se actualiza

**T2.6 — Vuelos duplicados cross-client**
Simular: Cliente A y Cliente B con AWBs en LA-0543 del 06/05:
- Verificar que ambos matchean el MISMO vuelo
- Verificar que no se crea duplicado

**T2.7 — Orphans**
Simular 8 AWBs en sistema, 2 en planilla:
- Verificar que 6 se identifican como orphans
- Verificar que solo las L0 se remueven

### T3 — Comparacion Sheet vs WMS

**Script:** `scripts/compare_sheet_vs_wms.cjs`

Para cada cliente habilitado:
1. Leer planilla actual
2. Leer todos los bookings del cliente
3. Generar reporte:
   - AWBs en sheet pero no en WMS (missing)
   - AWBs en WMS pero no en sheet (orphans)
   - AWBs con datos diferentes (discrepancies)
   - Vuelos en WMS sin equivalente en sheet (ghost flights)

Este script se ejecuta ANTES y DESPUES de cada fase para validar que nada se rompio.

### T4 — Logs de Decision

Cada decision del sync agent debe loguearse con:
```json
{
  "awb": "369-10113110",
  "decision": "match_existing_flight",
  "reason": "exact_instance_key_match",
  "instance_key": "LA-0543_2026-06-05",
  "flight_id": "abc123",
  "alternatives_considered": 0
}
```

Esto reemplaza los `auditFlightEvent` actuales con un formato estandarizado.

---

## PLAN DE DESPLIEGUE

### D1 — Orden de despliegue

```
Semana 1:
  Dia 1-2: Migracion M1 (agregar flight_instance_key a datos existentes)
  Dia 2-3: Migracion M2 (dedup vuelos)
  Dia 3:   Deploy Fase 1 (matching por instance key) + Fase 7 (normalizacion)
  Dia 3:   Ejecutar dry-run 24 horas

Semana 2:
  Dia 1:   Revisar resultados dry-run. Si OK → activar Fase 1 en produccion
  Dia 1:   Deploy Fase 2 (gate de estado)
  Dia 2:   Monitorear 24 horas
  Dia 3:   Deploy Fase 5 (snapshot persistente)
  Dia 4:   Monitorear cambio de tab/mes si aplica

Semana 3:
  Dia 1:   Migracion M3+M4 (limpiar contamination + orphans)
  Dia 2:   Deploy Fase 3 (cleanup automatico) — SOLO si Fase 5 confirmada estable
  Dia 3:   Deploy Fase 4 (atomic moves)
  Dia 4:   Deploy Fase 6 (allFlights cross-client)

Semana 4:
  Dia 1-5: Monitoreo activo. Ejecutar T3 (compare sheet vs WMS) diariamente
```

### D2 — Monitoreo primeras 24 horas post-deploy

**Metricas a vigilar:**
- Vuelos creados por el sync agent (debe ser < 5/dia en operacion normal)
- Alertas `needs_review` generadas (debe mantenerse o bajar vs baseline actual)
- Vuelos duplicados detectados (debe ser 0)
- AWBs movidas automaticamente (logging detallado)
- Errores de transaccion (debe ser 0)

**Dashboard de monitoreo:**
Query a `_sheet_sync_runs`:
```
Ultimas 24 horas:
- runs: N
- changes_applied: N
- alerts_generated: N
- errors: N
- flights_created: N (nuevo campo)
- orphans_cleaned: N (nuevo campo)
```

### D3 — Deteccion de anomalias

**Alertas automaticas (via _sheet_sync_alerts):**
- `flight_created` > 3 en un solo run → algo esta mal con matching
- `removed_from_sheet_cleaned` > 5 en un solo run → posible snapshot reset
- `needs_review` > 10 en un solo run → sync agent confundido
- Cualquier error de transaccion → investigar inmediatamente

### D4 — Plan de rollback

**Cada fase es independiente y reversible:**

| Fase | Rollback |
|------|----------|
| F1 (instance key) | Revertir a Step 1+2 matching. `flight_instance_key` queda en datos (no molesta) |
| F2 (gate estado) | Remover gate checks. Vuelve a comportamiento actual (agregar siempre) |
| F3 (cleanup) | Deshabilitar cleanup, volver a alert-only. Los bookings vacios son inocuos |
| F4 (atomic) | Volver a two-step write. Riesgo de inconsistencia vuelve pero no es critico |
| F5 (snapshot) | Volver a snapshot por mes. Riesgo de duplicados en cambio de mes vuelve |
| F6 (allFlights) | Volver a carga por booking.flight_id + H02 fallback |

**Procedimiento de rollback:**
1. Revertir deploy de Cloud Function a version anterior
2. `firebase functions:delete sheetSyncScheduled` (si es necesario detener urgente)
3. Re-deploy version anterior
4. Verificar con T3 (compare) que datos no se corrompieron

**Rollback automatico:** Si el sync agent detecta > 10 flights created en un solo run, se auto-desactiva:
```
if (flightsCreatedThisCycle > 10) {
  console.error('CIRCUIT BREAKER: too many flights created, aborting')
  await db.collection('_sheet_sync_alerts').add({
    alert_type: 'circuit_breaker', message: 'Auto-disabled: too many flights created'
  })
  return
}
```

### D5 — Validacion LA-0543 y vuelos recurrentes

**Test especifico post-deploy:**
1. Verificar que LA-0543 tiene exactamente los AWBs que estan en la planilla
2. Verificar que cada instancia de LA-0543 (por fecha) tiene su propio documento
3. Verificar que no hay contaminacion cruzada entre fechas
4. Ejecutar compare sheet vs WMS para todos los vuelos recurrentes conocidos:
   - LA-0543 (LATAM, multiple weekly)
   - Cualquier otro vuelo con > 1 instancia en 30 dias

---

## RESUMEN DE ENTREGABLES

| # | Entregable | Fase | Tipo |
|---|-----------|------|------|
| E1 | `buildInstanceKey()` + matching exacto | F1 | Codigo |
| E2 | Migracion `flight_instance_key` para datos existentes | M1 | Script |
| E3 | Dedup de vuelos duplicados | M2 | Script |
| E4 | `getFlightActivityLevel()` + gates | F2 | Codigo |
| E5 | Cleanup seguro de orphans | F3 | Codigo |
| E6 | Transacciones atomicas para moves | F4 | Codigo |
| E7 | Snapshot persistente por tab | F5 | Codigo |
| E8 | allFlights cross-client | F6 | Codigo |
| E9 | Normalizacion unificada | F7 | Codigo |
| E10 | Dry-run mode | T1 | Codigo |
| E11 | Compare sheet vs WMS | T3 | Script |
| E12 | Circuit breaker | D4 | Codigo |
| E13 | Limpieza LA-0543 | M3 | Script |
| E14 | Limpieza orphans globales | M4 | Script |

---

## CRITERIOS DE ROLLBACK GLOBAL

Revertir TODO si en las primeras 48 horas se observa:
- Mas de 5 vuelos duplicados creados
- Mas de 10 AWBs desaparecidas sin razon
- Mas de 20 alertas `needs_review` no explicables
- Cualquier booking que pierde AWBs con actividad de warehouse
- Cualquier vuelo dispatched que recibe AWBs nuevas

---

## DIFERENCIAS VS ITERACIONES ANTERIORES

| Iteracion anterior | Este plan |
|-------------------|-----------|
| Parche puntual a un sintoma | Rediseno de los 3 ejes: matching, ownership, lifecycle |
| Fuzzy matching "mejorado" | Fuzzy matching ELIMINADO |
| `isDateClose` ajustado de ±2 a ±1 | `isDateClose` ELIMINADO |
| Alert-only para removals | Cleanup automatico con gate de actividad |
| allFlights single-client + H02 fallback | allFlights global por rango de fechas |
| Snapshot por mes | Snapshot por tab (persistente) |
| Two-step writes | Transacciones atomicas |
| Deploy directo a produccion | Dry-run obligatorio + circuit breaker |

---

**ESTADO: Esperando aprobacion para comenzar con Fase 1 + Migracion M1.**
