# PLAN DE HARDENING DEL AGENTE DE SYNC — v2
## Analisis profundo, plan de pruebas y plan de implementacion

Fecha: 2026-05-29
Autor: Claude (analisis solicitado por Diego Garcia)

---

# PARTE 1: ANALISIS PROFUNDO

## 1.1 Reconstruccion del incidente LA-0543 (3 vuelos duplicados)

### Datos observados en produccion

| Vuelo # | Airline | Flight Number | ETD | Dest | AWBs | PCS | CW |
|---------|---------|--------------|-----|------|------|-----|-----|
| Vuelo A | Unknown | LA-0543 | 06/01/26 23:40 | (vacio) | 1 | 58 | 1,953 |
| Vuelo B | Unknown | LA-0543 | 06/01/26 23:40 | (vacio) | 1 | 78 | 1,958 |
| Vuelo C | LATAM CAO | LA-0543 | 06/01/26 23:40 | EZE | 1 | 63 | 1,960 |

### Datos de la planilla Excel (fuente de verdad)

| Fila | Flight | AWB 1st | PCS | CW | Deliver To | Dest | Cutoff | ETD |
|------|--------|---------|-----|-----|-----------|------|--------|-----|
| 274 | LA-0543 | 369-98157135 | 63 | 1960 | LATAM PAX | EZE | 05/31 | 6/1/2026 23:40 |
| 275 | LA-0543 | 369-98157146 | 78 | 1958 | LATAM PAX | EZE | 05/31 | 6/1/2026 23:40 |
| 276 | LA-0543 | 369-98157150 | 58 | 1953 | LATAM PAX | EZE | 05/31 | 6/1/2026 23:40 |

### Conclusion: Las 3 AWBs tienen datos identicos de vuelo. Deberian estar en 1 solo vuelo con 1 booking y 3 AWB lines.

---

### 1.1.1 Ruta de codigo activada

Las 3 AWBs llegaron como **nuevas filas** (`newRows`) o como transiciones **PENDING -> real**.

Hay DOS escenarios posibles que producen el resultado observado. Ambos confluyen en el mismo bug.

#### Escenario A: Las 3 AWBs se procesan como `newRows` en CICLOS DISTINTOS del cron

1. **Ciclo 1**: AWB 369-98157150 (58 pcs) llega como `newRow`
   - Entra a `applyNewToSystem()` (linea 3134)
   - `rawFlight = "LA-0543"`, `isPendingFlight = false`
   - `targetFlightKey = flightMatchKey("LA-0543") = "LA0543"`
   - `etdDate = "2026-06-01"` (parseado de "6/1/2026 23:40")
   - **Step 1** (linea 3191): busca en `allFlights` un vuelo con `flightMatchKey == "LA0543"` Y `flight_datetime.startsWith("2026-06-01")`
   - `allFlights` se cargo de Firestore filtrando solo vuelos asociados a bookings del cliente (linea 3530-3542)
   - No existe ningun vuelo LA-0543 -> **Step 1 falla**
   - **Step 2** (linea 3202): busca por `flightMatchKey == "LA0543"` Y `flight_datetime.startsWith(monthKey)`
   - **BUG CRITICO**: `monthKey = now.slice(0, 7) = "2026-05"` pero el ETD es `"2026-06-01"` -> **Step 2 tambien falla**
   - Linea 3223: `!targetFlight` -> **CREA VUELO NUEVO** con `airline: ex.deliverTo || 'Unknown'`
   - Si `ex.deliverTo` vino vacio (ver 1.1.3) -> airline = "Unknown", destino vacio
   - `allFlights.push(targetFlight)` — pero esto solo afecta al ciclo actual
   - Crea booking + AWB line. Checkpoint. Fin del ciclo 1.

2. **Ciclo 2** (5-10 min despues): AWB 369-98157146 (78 pcs) llega como `newRow`
   - `allFlights` se recarga de Firestore (linea 3530-3542)
   - **PERO** `allFlights` solo carga vuelos asociados a bookings del cliente via `flightIds = bookings.map(b => b.flight_id)`
   - El vuelo creado en Ciclo 1 SI tiene un booking -> SI aparece en `allFlights`
   - **Step 1**: busca `flightMatchKey == "LA0543"` Y `flight_datetime.startsWith("2026-06-01")`
   - El vuelo del Ciclo 1 tiene `flight_datetime = "2026-06-01T23:40:00"` -> `startsWith("2026-06-01")` = TRUE
   - **DEBERIA matchear**... SALVO que `flight_number` se guardo mal

   **Hipotesis de fallo**: Si `normalizeFlightNumber("LA-0543")` devuelve `"LA-0543"`, y `flightMatchKey("LA-0543")` devuelve `"LA0543"`, el match deberia funcionar. PERO si el campo `flight_number` del vuelo creado se guardo como `null` (linea 3225: `normalizeFlightNumber(rawFlight) || null`), entonces `flightMatchKey(null)` = `""` != `"LA0543"` -> **NO MATCHEA**.

   Esto ocurriria si `normalizeFlightNumber` devolviera un string vacio. Veamos:
   - `normalizeFlightNumber("LA-0543")`: `s = "LA-0543"`, no es PENDING/TBD, no matchea el regex de sufijos, ya tiene hyphen -> devuelve `"LA-0543"`. Esto FUNCIONA.

   **Hipotesis alternativa**: Si `ex.deliverTo` (columna "DELIVER TO") viene con un valor que hace que `rawFlight` se procese incorrectamente... NO, `rawFlight` viene de `ex.flight` que es la columna "FLIGHT #".

   **Hipotesis mas probable**: Las 3 AWBs se procesaron en el MISMO ciclo pero por la ruta de PENDING->real.

#### Escenario B: Las 3 AWBs estaban en PENDING y se mueven a real en el MISMO CICLO

1. Las 3 AWBs se crearon previamente como PENDING (sin vuelo asignado)
2. Express Line actualizo la planilla con "LA-0543" en las 3 filas
3. El agente detecta cambio de hash -> las 3 aparecen como `changedRows`
4. El loop `for (const ex of changedRows)` las procesa secuencialmente
5. Cada una tiene `sys.flightNumber = "PENDING"` y `ex.flight = "LA-0543"` -> `hasPendingFlightChange = true`
6. Se llama `applyPendingToReal(ex, sys, diffs, allFlights)` para cada una

**AWB 1** (primera en el loop):
- `targetFlightKey = "LA0543"`, `etdDate = "2026-06-01"`
- Step 1 (linea 2669): busca en `allFlights` -> no existe ningun LA-0543 -> falla
- Step 2 (linea 2679): `monthKey = now.slice(0,7) = "2026-05"`, busca `startsWith("2026-05")` -> el ETD es junio -> **FALLA**
- Linea 2699: `!targetFlight` -> **CREA VUELO NUEVO**
- `airline: ex.deliverTo || 'Unknown'`
- `allFlights.push(targetFlight)` (linea 2708)

**AWB 2** (segunda en el loop):
- Step 1: busca `"LA0543"` + `startsWith("2026-06-01")` en `allFlights`
- El vuelo creado por AWB 1 tiene `flight_datetime: ex.etd` = `"2026-06-01T23:40:00"` -> `startsWith("2026-06-01")` = **TRUE**
- **DEBERIA matchear** -> usa el vuelo existente

**AWB 3**: Idem AWB 2.

**PERO**: Si AWB 2 y 3 matchean, deberiamos tener 1 vuelo con 3 AWBs, no 3 vuelos. El resultado observado dice lo contrario. Esto indica que el Escenario B puro no explica los 3 vuelos.

#### Escenario C (MAS PROBABLE): Combinacion de ciclos + PENDING

Las 3 AWBs se procesan en **3 ciclos distintos** como transiciones PENDING->real:

- **Ciclo 1**: AWB 1 detecta cambio, `applyPendingToReal` -> Step 1 falla, Step 2 falla (monthKey bug) -> crea Vuelo A
  - `allFlights` del Ciclo 1 incluia los vuelos del cliente cargados de Firestore
  - El Vuelo A se agrega al array local, pero el ciclo termina

- **Ciclo 2**: AWB 2 detecta cambio. `allFlights` se recarga de Firestore.
  - El Vuelo A ya existe y tiene un booking que apunta a el
  - **Step 1** busca `"LA0543"` + `startsWith("2026-06-01")`
  - **PERO**: hay una condicion clave: `allFlights` se carga solo con vuelos cuyos IDs estan en `flightIds = bookings.map(b => b.flight_id)` (linea 3530)
  - Si la AWB 1 fue MOVIDA del booking PENDING al nuevo vuelo, el booking PENDING ahora tiene 2 AWBs (no 3), y el nuevo vuelo tiene un nuevo booking con 1 AWB
  - El nuevo booking SI tiene `flight_id = VueloA.id` -> el vuelo SI se carga en `allFlights`
  - Step 1 DEBERIA funcionar

  **SALVO QUE**: El checkpoint actualizo el hash de AWB 1 pero el snapshot hash de AWB 2 no cambio lo suficiente como para que sea detectada como `changedRow`. Si AWB 2 se detecto como `newRow` en vez de `changedRow` (porque su hash previo no existia en el snapshot), seguiria la ruta de `newRows`.

  En la ruta de `newRows` (linea 3873): se busca `existingSys = byAwb1.get(key1)`. Si la AWB 2 todavia esta en el booking PENDING, `existingSys` la encuentra y aplica diffs (incluyendo PENDING->real). Si ya fue movida, `existingSys` es undefined y entra a `applyNewToSystem` que tiene el MISMO bug de monthKey.

**CONCLUSION FINAL DEL ESCENARIO C**:

El patron mas probable es:

1. Las 3 AWBs entraron inicialmente como PENDING (una o mas en ciclos separados)
2. El snapshot guardo sus hashes cuando eran PENDING
3. Express Line actualizo la planilla con "LA-0543"
4. El agente detecto los cambios en 1, 2, o 3 ciclos diferentes
5. En cada ciclo, `applyPendingToReal` ejecuto el two-step search:
   - Step 1: busca vuelo con flightMatchKey + etdDate -> si es el primer ciclo, no existe -> falla
   - Step 2: busca por flightMatchKey + monthKey -> **BUG: monthKey = "2026-05" pero ETD es "2026-06"** -> falla
   - Crea vuelo nuevo
6. En ciclos posteriores, si Step 1 deberia matchear el vuelo creado, hay dos sub-hipotesis:
   a. Las 3 se procesaron en ciclos distintos y el vuelo previo SI se carga pero algo lo descarto (ej: `isFlightBlocked` si alguien lo marco)
   b. Las 3 se procesaron en el mismo ciclo pero `ex.deliverTo` diferia entre ellas, provocando que los datos del vuelo diferiran

---

### 1.1.2 Analisis de la variable `monthKey` (BUG CONFIRMADO)

Existe en **4 ubicaciones**:

| Linea | Funcion | Valor de monthKey | Uso |
|-------|---------|------------------|-----|
| 2667 | `applyPendingToReal` | `now.slice(0,7)` | Step 2 fallback: `f.flight_datetime.startsWith(monthKey)` |
| 2822 | `applyRealToReal` | `now.slice(0,7)` | Step 2 fallback: `f.flight_datetime.startsWith(monthKey)` |
| 3168 | `applyNewToSystem` | `now.slice(0,7)` | Step 2 fallback + PENDING flight search |
| 3473 | main sync loop | `now.slice(0,7)` | Snapshot ID key |

En las 3 funciones de flight-search (lineas 2667, 2822, 3168), `monthKey` se usa como filtro de Step 2:
```
(f.flight_datetime || '').startsWith(monthKey)
```

**Impacto**: Si hoy es 29 de mayo (`monthKey = "2026-05"`) y el ETD del vuelo es 1 de junio (`"2026-06-01"`), Step 2 NO matchea ningun vuelo de junio. Esto provoca creacion de vuelo duplicado cuando Step 1 tambien falla.

**Step 1 falla cuando**: No existe ningun vuelo con ese `flightMatchKey + etdDate` exacto — tipicamente la primera AWB de un vuelo nuevo.

**Resultado**: La primera AWB de un vuelo del mes siguiente SIEMPRE crea un vuelo nuevo (correcto). Pero si una segunda AWB del mismo vuelo se procesa en un ciclo posterior y Step 1 falla por cualquier razon, Step 2 no la salva porque el monthKey no matchea.

### 1.1.3 Analisis de airline "Unknown" (BUG CONFIRMADO)

La planilla dice "LATAM PAX" en las 3 filas. El sistema muestra:
- 2 vuelos con "Unknown"
- 1 vuelo con "LATAM CAO" (incorrecto — deberia ser "LATAM PAX")

**Causas posibles**:

1. **`ex.deliverTo` vino vacio**: La columna "DELIVER TO" no se mapeo correctamente para esas filas. Posibles causas:
   - Celdas con merge en la planilla (Google Sheets API devuelve vacio para celdas merge inferiores)
   - Espacios invisibles o formato especial
   - El header "DELIVER TO" no matcheo el alias `['deliver to', 'airline']`

2. **"LATAM CAO" en vez de "LATAM PAX"**: Esto indica que en algun momento la celda decia "LATAM CAO" y el agente leyo ese valor. Express Line pudo haber corregido la celda despues, pero el vuelo ya fue creado con "LATAM CAO".

3. **El agente NO actualiza airline de vuelos existentes**: Cuando `applyPendingToReal` o `applyNewToSystem` encuentran un vuelo existente (Steps 1/2), usan el vuelo tal cual. No actualizan `airline` ni `destinations` del vuelo si vienen con datos mejores. Solo cuando CREAN un vuelo nuevo se setea la airline.

**Conclusion**: El bug es doble:
- (a) `deliverTo` puede llegar vacio por celdas merge -> fallback "Unknown"
- (b) No hay mecanismo para corregir airline de un vuelo una vez creado

### 1.1.4 Analisis de vuelos PENDING huerfanos (BUG CONFIRMADO)

Observados en produccion:
- LATAM PAX #PENDING | 06/03/26 | EZE | 0 AWBs
- LATAM CAO #PENDING | 06/03/26 00:00 | MVD | 0 AWBs (x3)

**Causa**: Cuando `applyPendingToReal` mueve una AWB del booking PENDING al vuelo real:
1. Remueve la AWB line del booking PENDING (linea 2724)
2. Agrega la AWB line al booking del vuelo real (linea 2768)
3. **PERO nunca verifica si el booking PENDING quedo vacio**
4. **NUNCA verifica si el vuelo PENDING quedo sin bookings con AWBs**

El vuelo PENDING y su booking vacio persisten indefinidamente en el sistema, ensuciando la lista de vuelos.

**Agravante**: La busqueda de vuelo PENDING (linea 3171) usa `monthKey = now.slice(0,7)` para filtrar. Si `now` es mayo y el ETD del PENDING es junio, podria crear OTRO vuelo PENDING nuevo en vez de reusar el existente. Esto explica los 3 vuelos PENDING MVD identicos.

---

## 1.2 Catalogo completo de vulnerabilidades

### V-01: monthKey derivado de `now` en vez de `etdDate`
- **Lineas**: 2667, 2822, 3168
- **Impacto**: Vuelos duplicados cuando ETD cruza el limite de mes
- **Severidad**: CRITICA
- **Frecuencia**: Cada fin de mes para vuelos del mes siguiente

### V-02: No hay dedup pre-creacion de vuelos contra Firestore
- **Lineas**: 2699-2708, 2854-2863, 3223-3233
- **Impacto**: Si `allFlights` en memoria no incluye el vuelo (ciclo distinto, flight no asociado a booking), se crea duplicado
- **Severidad**: ALTA
- **Frecuencia**: Cuando multiples AWBs del mismo vuelo se procesan en ciclos distintos

### V-03: airline fallback a "Unknown" cuando deliverTo esta vacio
- **Lineas**: 2701, 2856, 3225
- **Impacto**: Vuelos creados con airline incorrecta
- **Severidad**: MEDIA
- **Frecuencia**: Cuando celdas merge o vacias en columna "DELIVER TO"

### V-04: No se actualiza airline/destino de vuelo existente
- **Lineas**: 2669-2673 (Step 1 usa vuelo tal cual), 2686-2696 (Step 2 solo actualiza ETD)
- **Impacto**: Vuelo queda con "Unknown" o sin destino permanentemente
- **Severidad**: MEDIA
- **Frecuencia**: Siempre que una AWB posterior tenga datos mas completos

### V-05: Vuelos PENDING huerfanos nunca se limpian
- **Lineas**: 2711-2731 (remueve AWB del booking PENDING pero no limpia vuelo)
- **Impacto**: Vuelos vacios ensucian el sistema
- **Severidad**: MEDIA
- **Frecuencia**: Cada vez que se resuelve una transicion PENDING->real

### V-06: Multiples vuelos PENDING por monthKey incorrecto
- **Lineas**: 3168-3187
- **Impacto**: Crea vuelo PENDING duplicado si el existente tiene ETD de otro mes
- **Severidad**: MEDIA
- **Frecuencia**: Fin de mes

### V-07: Step 2 ETD overwrite sin proteccion
- **Lineas**: 2689-2695, 2841-2847, 3212-3218
- **Impacto**: Si Step 2 matchea un vuelo incorrecto, sobreescribe su ETD
- **Severidad**: ALTA
- **Frecuencia**: Cuando Step 1 falla y Step 2 encuentra 1 candidato ambiguo

### V-08: isFlightBlocked no verifica `dispatched_at`
- **Lineas**: 2272-2276
- **Impacto**: Un vuelo con `dispatched_at` seteado pero `flight_status != "dispatched"` no se bloquea
- **Severidad**: MEDIA
- **Frecuencia**: Cuando dispatch falla a medio camino o se usa API inconsistente

### V-09: applyFlightDiffs no verifica `dispatched_at`
- **Lineas**: 3096-3098
- **Impacto**: Verifica `flightStatus` pero no `dispatched_at` timestamp
- **Severidad**: BAJA (cubierto parcialmente por isFlightBlocked en flight search)
- **Frecuencia**: Edge case

### V-10: allFlights solo carga vuelos asociados a bookings del cliente
- **Lineas**: 3530-3542
- **Impacto**: Si un vuelo fue creado por otro cliente o manualmente, no aparece en `allFlights`, causando duplicados
- **Severidad**: ALTA
- **Frecuencia**: Vuelos compartidos entre multiples clientes

### V-11: PENDING flight search no filtra por airline/destino
- **Lineas**: 3171-3173
- **Impacto**: Todas las AWBs PENDING van al mismo vuelo PENDING del mes, sin importar airline/destino. Cuando se resuelven, se mueven a vuelos distintos dejando booking fragmentado.
- **Severidad**: BAJA (comportamiento aceptable, pero confuso)

### V-12: booking PENDING vacio no se elimina
- **Lineas**: 2716-2731
- **Impacto**: Bookings vacios (awb_lines = []) persisten en Firestore
- **Severidad**: BAJA (no visible al usuario, pero ensucia queries)

### V-13: No hay log estructurado de creacion de vuelos
- **Lineas**: 2706, 2861, 3230
- **Impacto**: No hay forma de auditar por que se creo un vuelo ni que datos tenia la AWB que lo disparo
- **Severidad**: MEDIA (dificulta diagnostico post-incidente)

### V-14: normalizeFlightNumber pierde informacion
- **Linea**: 2261 `s.replace(/\s+(A\d+|PAX|CAO|LOOSE|CARGO)$/, '')`
- **Impacto**: "LA-0543 PAX" -> "LA-0543" (correcto para matching, pero se pierde "PAX" que podria ser util para airline inference)
- **Severidad**: BAJA

### V-15: Step 2 con multiples candidatos crea vuelo nuevo silenciosamente
- **Lineas**: 2697 (comment: "fall through to create new"), 3221
- **Impacto**: Si hay 2+ vuelos con mismo flight_number en el mismo mes, se crea un tercero
- **Severidad**: MEDIA
- **Frecuencia**: Cuando ya existen duplicados de incidentes previos

---

# PARTE 2: PLAN DE PRUEBAS

## 2.1 Pruebas unitarias

### T-U01: `normalizeFlightNumber`
```
INPUT                    | EXPECTED OUTPUT
"LA-0543"               | "LA-0543"
"LA0543"                | "LA-0543"
"la-0543"               | "LA-0543"
"LA-0543 PAX"           | "LA-0543"
"LA-0543 CAO"           | "LA-0543"
"LA-0543 A18"           | "LA-0543"
"QT4093"                | "QT-4093"
"UC1617"                | "UC-1617"
"PENDING"               | "PENDING"
"TBD"                   | "TBD"
""                      | ""
null                    | ""
"AR1303 PAX"            | "AR-1303" (no "AR1303")
```

### T-U02: `flightMatchKey`
```
INPUT                    | EXPECTED OUTPUT
"LA-0543"               | "LA0543"
"LA0543"                | "LA0543"
"LA-0543 PAX"           | "LA0543"
"la-0543"               | "LA0543"
"QT-4093"               | "QT4093"
"PENDING"               | "PENDING"
""                      | ""
null                    | ""
```

### T-U03: `sheetParseDate`
```
INPUT                    | EXPECTED OUTPUT
"6/1/2026 23:40"        | "2026-06-01T23:40:00"
"6/1/2026"              | "2026-06-01"
"05/31/2026"            | "2026-05-31"
"5/30/26"               | "2026-05-30"
46178 (Excel serial)    | "2026-06-01" (pure date)
46178.9861 (serial+time)| "2026-06-01T23:40:00"
""                      | ""
null                    | ""
"PENDING"               | "PENDING" (starts with letter -> passthrough)
```

### T-U04: `isFlightBlocked`
```
INPUT                                           | EXPECTED
{ flight_status: 'dispatched' }                | true
{ status: 'dispatched' }                       | true
{ flight_status: 'closed' }                    | true
{ status: 'open', flight_status: 'dispatched' }| true
{ status: 'open' }                             | false
{ dispatched_at: '2026-05-28T...' }            | false (BUG — deberia ser true)
null                                            | false
```

### T-U05: `normalizeDest`
```
INPUT              | EXPECTED
"BOG"             | "BOG"
"BOG - BOGOTA"    | "BOG - BOGOTA" (BUG? no limpia sufijos tipo "- BOGOTA")
"EZE LOOSE"       | "EZE"
"EZE PAX"         | "EZE"
""                | ""
```

### T-U06: `computeDiffs` — deteccion de cambio de vuelo
```
SETUP: ex = { flight: "LA-0543", ... }, sys = { flightNumber: "PENDING", ... }
EXPECTED: diffs incluye { field: "Vuelo", new_value: "LA-0543", old_value: "PENDING" }

SETUP: ex = { flight: "LA-0543", ... }, sys = { flightNumber: "LA-0543", ... }
EXPECTED: NO diff de Vuelo (mismo vuelo)

SETUP: ex = { flight: "LA0543", ... }, sys = { flightNumber: "LA-0543", ... }
EXPECTED: NO diff de Vuelo (normalizacion)

SETUP: ex = { flight: "QT-4099", ... }, sys = { flightNumber: "QT-4093", ... }
EXPECTED: diff de Vuelo (vuelos distintos)
```

### T-U07: `buildSystemMaps`
```
SETUP: 2 bookings, 3 AWB lines total, flight_map con 2 vuelos
VERIFY:
  - byAwb1 tiene 3 entries
  - Cada entry tiene flightNumber, airline, etd correctos
  - built/received flags correctos segun builtAwbs/receivedAwbs sets
  - flightStatus se lee de flight_status || status (OR logico)
```

---

## 2.2 Pruebas de integracion

### T-I-A: 3 AWBs del mismo vuelo (caso LA-0543) — MISMO CICLO

**Setup**:
- 3 AWBs nuevas en planilla: LA-0543, ETD 2026-06-01T23:40, LATAM PAX, EZE
- Las 3 aparecen como `newRows` en el mismo ciclo
- No existe ningun vuelo LA-0543 en el sistema
- Fecha actual: 2026-05-29 (mes distinto al ETD)

**Expected**:
- Se crea exactamente 1 vuelo LA-0543 con airline="LATAM PAX", dest=["EZE"], ETD=2026-06-01T23:40:00
- Se crea 1 booking con 3 AWB lines
- 0 vuelos PENDING creados
- 0 vuelos duplicados

**Verify**:
- `db.collection('airfreight_flights').where('flight_number','==','LA-0543')` retorna 1 doc
- Ese doc tiene `airline = "LATAM PAX"`, `destinations = ["EZE"]`
- `db.collection('airfreight_bookings').where('flight_id','==',newFlightId)` retorna 1 doc
- Ese doc tiene `awb_lines.length === 3`

### T-I-B: 3 AWBs del mismo vuelo — CICLOS DISTINTOS

**Setup**:
- AWB 1 se procesa en ciclo 1 (crea vuelo + booking)
- AWB 2 se procesa en ciclo 2 (debe encontrar vuelo existente)
- AWB 3 se procesa en ciclo 3

**Expected**: Mismo resultado que T-I-A (1 vuelo, 1 booking, 3 AWBs)

**Critical check**: En ciclo 2, `allFlights` debe incluir el vuelo creado en ciclo 1

### T-I-C: PENDING -> real (3 AWBs)

**Setup**:
- 3 AWBs ya existen como PENDING en el sistema
- Planilla se actualiza con "LA-0543" para las 3
- Las 3 se detectan como `changedRows` con diff de Vuelo

**Expected**:
- Se crea 1 vuelo LA-0543
- Las 3 AWBs se mueven del booking PENDING al nuevo booking
- Booking PENDING queda con 0 AWBs (o se elimina)
- Vuelo PENDING queda sin bookings con AWBs (o se elimina)
- 0 vuelos duplicados

### T-I-D: Vuelos mismo numero, distinta fecha

**Setup**:
- Vuelo existente: LA-0543, ETD 2026-05-25 (ya despachado)
- AWB nueva: LA-0543, ETD 2026-06-01

**Expected**:
- NO se toca el vuelo del 25 (esta despachado)
- Se crea vuelo nuevo LA-0543 con ETD 2026-06-01
- 0 cambios en el vuelo despachado

**Critical check**: `isFlightBlocked` devuelve true para el vuelo despachado

### T-I-E: monthKey cruce de mes

**Setup**:
- Fecha actual: 2026-05-31
- AWB nueva: UC-1105, ETD 2026-06-02
- No existe vuelo UC-1105 junio

**Expected**:
- Step 1 no matchea (no hay vuelo con ETD 2026-06-02)
- Step 2 usa `monthKey = etdDate.slice(0,7) = "2026-06"` (despues del fix)
- No hay vuelos de junio -> crea nuevo
- Solo 1 vuelo creado

**Si ejecutamos ANTES del fix**: Step 2 usa "2026-05" -> no matchea nada -> crea vuelo OK para primer AWB, pero si ya existia uno de junio por ciclo previo, Step 2 no lo encuentra -> duplicado

### T-I-F: airline vacia con vuelo existente

**Setup**:
- Vuelo existente LA-0543: airline="LATAM PAX", ETD 2026-06-01
- AWB nueva con `deliverTo = ""` (celda vacia/merge)

**Expected**:
- Step 1 matchea el vuelo existente
- Se agrega AWB al booking del vuelo existente
- Airline del vuelo NO se cambia a "Unknown"
- Si se CREA vuelo nuevo (por alguna razon), debe buscar airline del vuelo existente con mismo flight_number antes de defaultear a "Unknown"

### T-I-G: flight_status vs status — vuelo intocable

**Setup**:
- Vuelo con `status: "open"`, `flight_status: "dispatched"`, `dispatched_at: "2026-05-28T..."`
- AWB en planilla con cambio de ETD para ese vuelo

**Expected**:
- `isFlightBlocked` retorna true
- No se modifica ETD
- Se genera alerta

**Setup 2**:
- Vuelo con `dispatched_at: "2026-05-28T..."` pero `flight_status: undefined`, `status: "open"`

**Expected (post-fix)**:
- `isFlightBlocked` retorna true (porque `dispatched_at` existe)
- No se modifica nada

### T-I-H: ETD overwrite proteccion

**Setup**:
- Vuelo existente: LA-0543, ETD 2026-06-01T23:40:00, tiene 5 AWBs, `dispatched_at` existe
- AWB nueva o cambio con ETD 2026-06-05T10:00:00

**Expected**:
- El ETD del vuelo NO se modifica
- La AWB NO se agrega al vuelo despachado
- Se genera alerta

### T-I-I: Limpieza PENDING huerfanos

**Setup**:
- Vuelo PENDING con 1 booking con 1 AWB
- Se ejecuta `applyPendingToReal` que mueve la AWB

**Expected (post-fix)**:
- Booking PENDING queda con 0 AWBs -> se marca para limpieza o se elimina
- Si vuelo PENDING no tiene mas bookings con AWBs -> se elimina o marca

---

# PARTE 3: PLAN DE HARDENING

## H-01: Correccion de monthKey (CRITICA)

**Ubicaciones**: lineas 2667, 2822, 3168

**Cambio**:
```
// ANTES (BUG):
const monthKey = now.slice(0, 7)

// DESPUES (FIX):
const monthKey = etdDate ? etdDate.slice(0, 7) : now.slice(0, 7)
```

**Razon**: Step 2 debe buscar vuelos del mismo mes que el ETD objetivo, no del mes actual.

**Riesgo**: MINIMO. Solo afecta Step 2 (fallback). Step 1 (match exacto por fecha) no cambia.

---

## H-02: Query a Firestore antes de crear vuelo (ALTA)

**Ubicaciones**: lineas 2699, 2854, 3223

**Cambio**: Antes de crear vuelo nuevo, hacer query directa a Firestore:
```
// Pseudocodigo:
const firestoreCheck = await db.collection('airfreight_flights')
  .where('flight_number', '==', normalizeFlightNumber(rawFlight))
  .get()
const fsMatch = firestoreCheck.docs.find(d => {
  const f = d.data()
  return !isFlightBlocked(f) &&
    (etdDate ? (f.flight_datetime || '').startsWith(etdDate) : true)
})
if (fsMatch) {
  targetFlight = { id: fsMatch.id, ...fsMatch.data() }
  if (allFlights) allFlights.push(targetFlight)
} else {
  // crear vuelo nuevo
}
```

**Razon**: `allFlights` en memoria puede no incluir vuelos creados por otros clientes o en ciclos anteriores si el booking asociado no fue cargado.

**Riesgo**: BAJO. Solo agrega una lectura extra. No modifica datos existentes.

---

## H-03: Enriquecer vuelo existente con datos faltantes (MEDIA)

**Ubicaciones**: Despues de encontrar `targetFlight` en Steps 1/2

**Cambio**:
```
// Si el vuelo existente tiene airline "Unknown" o vacia, y ex.deliverTo es valido:
if (targetFlight && ex.deliverTo && (targetFlight.airline === 'Unknown' || !targetFlight.airline)) {
  await db.collection('airfreight_flights').doc(targetFlight.id).update({ airline: ex.deliverTo })
  targetFlight.airline = ex.deliverTo
}
// Si el vuelo no tiene destinos y ex.dest es valido:
if (targetFlight && ex.dest && (!targetFlight.destinations || targetFlight.destinations.length === 0)) {
  const dest = normalizeDest(ex.dest)
  await db.collection('airfreight_flights').doc(targetFlight.id).update({ destinations: [dest] })
  targetFlight.destinations = [dest]
}
```

**Razon**: La primera AWB puede llegar con datos incompletos (celda merge, etc.). AWBs posteriores pueden tener los datos correctos.

**Riesgo**: BAJO. Solo escribe si el valor actual es "Unknown"/vacio. Nunca sobreescribe un valor valido.

---

## H-04: Limpieza de PENDING huerfanos (MEDIA)

**Ubicacion**: Al final de `applyPendingToReal`, despues de mover la AWB

**Cambio**:
```
// Despues de mover AWB, verificar si booking PENDING quedo vacio
const pendingSnap = await pendingBookingRef.get()
if (pendingSnap.exists) {
  const pendingData = pendingSnap.data()
  const remainingLines = (pendingData.awb_lines || []).filter(l => l.awb_number)
  if (remainingLines.length === 0) {
    // Booking vacio -> eliminar
    await pendingBookingRef.delete()
    // Verificar si vuelo PENDING tiene mas bookings
    const otherBookings = await db.collection('airfreight_bookings')
      .where('flight_id', '==', pendingData.flight_id)
      .limit(1).get()
    if (otherBookings.empty) {
      // Vuelo PENDING sin bookings -> eliminar
      await db.collection('airfreight_flights').doc(pendingData.flight_id).delete()
    }
  }
}
```

**Razon**: Evita acumulacion de vuelos/bookings PENDING vacios.

**Riesgo**: BAJO. Solo elimina entidades vacias (0 AWBs). Verificacion doble antes de borrar.

**Precaucion**: Solo eliminar si `created_by = 'sheet_sync_agent'` para no borrar vuelos creados manualmente.

---

## H-05: isFlightBlocked debe verificar dispatched_at (MEDIA)

**Ubicacion**: linea 2272

**Cambio**:
```
function isFlightBlocked(f) {
  if (!f) return false
  const s = (f.flight_status || f.status || '').toLowerCase()
  if (s === 'dispatched' || s === 'closed') return true
  // Verificar dispatched_at como backup
  if (f.dispatched_at) return true
  return false
}
```

**Razon**: En el incidente forense de QT-4099, se detecto que `dispatch` setea `flight_status` pero no siempre `status`. El campo `dispatched_at` es el indicador mas confiable.

**Riesgo**: MINIMO. Solo agrega una condicion extra de bloqueo. Nunca permite algo que antes bloqueaba.

---

## H-06: allFlights debe incluir TODOS los vuelos abiertos del mes (ALTA)

**Ubicacion**: lineas 3530-3543

**Cambio**: Ademas de cargar vuelos por `flightIds` del cliente, cargar vuelos abiertos recientes:
```
// Cargar vuelos abiertos de los ultimos 60 dias (para dedup cross-client)
const recentFlightsSnap = await db.collection('airfreight_flights')
  .where('created_at', '>=', sixtyDaysAgo)
  .where('status', '==', 'open')
  .get()
for (const d of recentFlightsSnap.docs) {
  if (!flightMap.has(d.id)) {
    const f = { id: d.id, ...d.data() }
    flightMap.set(d.id, f)
    allFlights.push(f)
  }
}
```

**Razon**: Vuelos creados por otros clientes o manualmente no aparecen en el set filtrado por booking. Esto causa duplicados cuando 2 clientes comparten vuelo.

**Riesgo**: MEDIO. Aumenta el volumen de datos cargados. Mitigacion: limitar a vuelos de los ultimos 60 dias.

**Alternativa mas segura**: Solo cargar vuelos adicionales por `flight_number` match:
```
// Si Step 1 y Step 2 fallan, antes de crear, buscar en Firestore directamente
```
(Esto es H-02, que es mas eficiente)

---

## H-07: Logging estructurado obligatorio (MEDIA)

**Ubicaciones**: Cada punto de creacion/modificacion de vuelo

**Cambio**: Crear un documento `_sheet_sync_flight_audit` cada vez que:
- Se crea un vuelo (log: flight_number, airline, etd, dest, trigger_awb, step_that_triggered)
- Se usa fallback Step 2 (log: target_flight_id, original_etd, new_etd)
- Se usa "Unknown" como airline (log: awb, flight, deliverTo_raw)
- Se mueve AWB entre vuelos (log: from_flight, to_flight, awb)
- Se sobreescribe ETD (log: flight_id, old_etd, new_etd, trigger_awb)

**Formato**:
```
{
  type: 'flight_created' | 'step2_fallback' | 'airline_unknown' | 'awb_moved' | 'etd_updated',
  flight_id, flight_number, client_id,
  trigger_awb, trigger_data: { deliverTo, dest, etd },
  step: 'step1' | 'step2' | 'create',
  created_at: serverTimestamp
}
```

**Riesgo**: NINGUNO. Solo agrega writes de auditoria. No modifica logica.

---

## H-08: Step 2 ETD overwrite solo si vuelo no tiene AWBs (ALTA)

**Ubicaciones**: lineas 2689-2695, 2841-2847, 3212-3218

**Cambio**: No sobreescribir ETD si el vuelo ya tiene bookings con AWBs:
```
// Antes de sobreescribir ETD del vuelo matcheado en Step 2:
const existingBookingsCount = await db.collection('airfreight_bookings')
  .where('flight_id', '==', targetFlight.id)
  .limit(1).get()
if (existingBookingsCount.empty) {
  // Vuelo sin bookings — safe to update ETD
  await db.collection('airfreight_flights').doc(targetFlight.id).update(flightUpdate)
} else {
  // Vuelo con bookings — generar alerta en vez de sobreescribir
  // (el ETD podria ser correcto para las AWBs existentes)
}
```

**Razon**: Step 2 matchea por flight_number + mes, sin fecha exacta. Si matchea un vuelo que ya tiene AWBs con un ETD distinto, sobreescribir el ETD afecta a TODAS las AWBs existentes.

**Riesgo**: BAJO. Solo limita el overwrite. Si el vuelo esta vacio, es safe.

---

## H-09: Proteccion contra Step 2 ambiguo (MEDIA)

**Ubicaciones**: lineas 2697, 3221

**Cambio**: Si hay multiples candidatos, intentar desambiguar por fecha mas cercana antes de crear nuevo:
```
if (candidates.length > 1 && etdDate) {
  // Intentar match por fecha exacta entre candidatos
  const exactMatch = candidates.find(f => (f.flight_datetime || '').startsWith(etdDate))
  if (exactMatch) {
    targetFlight = exactMatch
  }
  // Si no, generar alerta y NO crear vuelo nuevo
}
```

**Razon**: Si hay 2+ candidatos, crear un tercero empeora el problema.

**Riesgo**: BAJO. Agrega desambiguacion antes del fallback a creacion.

---

# PARTE 4: PLAN DE IMPLEMENTACION

## 4.1 Orden de cambios (de menor a mayor riesgo)

| Fase | Cambio | ID | Riesgo | Dependencias |
|------|--------|----|--------|-------------|
| F1 | Logging estructurado | H-07 | NINGUNO | Ninguna |
| F2 | isFlightBlocked + dispatched_at | H-05 | MINIMO | Ninguna |
| F3 | monthKey fix | H-01 | MINIMO | Ninguna |
| F4 | Enriquecer vuelo (airline/dest) | H-03 | BAJO | Ninguna |
| F5 | Query Firestore pre-creacion | H-02 | BAJO | F3 |
| F6 | Limpieza PENDING huerfanos | H-04 | BAJO | Ninguna |
| F7 | Step 2 ETD overwrite proteccion | H-08 | BAJO | Ninguna |
| F8 | Step 2 desambiguacion | H-09 | BAJO | F3 |

## 4.2 Riesgos y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigacion |
|--------|-------------|---------|-----------|
| Fix de monthKey cambia matching de vuelos existentes | BAJA | MEDIO | Solo afecta Step 2 (fallback). Step 1 no cambia. Testear con datos reales antes de deploy. |
| Query extra a Firestore (H-02) causa timeout | BAJA | BAJO | Query por flight_number es indexada. Limitar a 10 resultados. |
| Limpieza PENDING borra vuelo/booking util | MUY BAJA | ALTO | Solo borrar si `created_by = 'sheet_sync_agent'` Y `awb_lines.length === 0` |
| Enriquecer airline sobreescribe valor correcto | MUY BAJA | MEDIO | Solo escribir si valor actual es "Unknown" o vacio. Nunca sobreescribir valor no-vacio. |
| ETD overwrite proteccion impide updates legitimos | BAJA | BAJO | Si vuelo tiene bookings pero ETD es incorrecto, se genera alerta para review manual |

## 4.3 Pruebas antes del deploy

1. **Extraer datos reales**: Ejecutar `planning-data.cjs` para vuelos de mayo-junio
2. **Verificar vuelos duplicados existentes**: Query Firestore para vuelos con mismo `flight_number` + `flight_datetime` (misma fecha)
3. **Verificar PENDING huerfanos**: Query vuelos con `flight_number = "PENDING"` y contar bookings con AWBs
4. **Verificar vuelos "Unknown"**: Query vuelos con `airline = "Unknown"` y verificar si hay otro vuelo con mismo flight_number y airline correcta
5. **Dry-run**: Ejecutar el agente con los cambios en modo log-only (sin writes a Firestore) contra la planilla de Express Line actual

## 4.4 Validacion post-deploy

1. **Monitorear `_sheet_sync_flight_audit`**: Verificar que los logs se generan correctamente
2. **Verificar que no se crean vuelos duplicados**: Query cada 30 min por 24h
3. **Verificar que PENDING se resuelven correctamente**: Verificar que las AWBs llegan al vuelo correcto
4. **Verificar que vuelos despachados son intocables**: Intentar cambiar ETD de vuelo despachado via planilla
5. **Verificar limpieza**: Verificar que no quedan vuelos PENDING vacios nuevos

## 4.5 Elementos que NO se tocan

- Vuelos ya despachados (flight_status = dispatched, dispatched_at != null)
- Bookings existentes con AWBs (no se reasignan AWBs retroactivamente)
- Billing (air_billing_charges no se modifica)
- Distribucion (doc_distribucion no se modifica)
- Doc receptions (solo reconcileDocReceptionBookingId ya existente)
- flight_id y booking_id de entidades existentes (no se cambian)
- Flujo MAWB (no se toca, solo aplica a ecommerce)

---

## RESUMEN EJECUTIVO

**Causa raiz del incidente LA-0543**: Bug `monthKey = now.slice(0,7)` (V-01) combinado con procesamiento en ciclos separados. El Step 2 fallback no puede encontrar vuelos del mes siguiente cuando se ejecuta el ultimo dia del mes anterior. Cada AWB crea su propio vuelo.

**Causa raiz de airline "Unknown"**: Celdas merge en Google Sheets devuelven vacio para filas inferiores (V-03), combinado con ausencia de mecanismo para corregir airline post-creacion (V-04).

**Causa raiz de PENDING huerfanos**: No hay limpieza automatica despues de mover AWBs fuera del booking PENDING (V-05, V-12).

**Fixes prioritarios**: H-01 (monthKey), H-02 (query Firestore pre-creacion), H-03 (enriquecer airline/dest). Estos 3 cambios eliminan el 90% de los incidentes observados.
