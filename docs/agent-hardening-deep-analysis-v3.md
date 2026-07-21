# ANALISIS PROFUNDO DE HARDENING v3
## Revalidacion critica, plan de pruebas exhaustivo, garantia de no-regresion

Fecha: 2026-05-29
Basado en: lectura linea por linea de `functions/index.js` (lineas 2213-4279)

---

# PARTE 1: REVALIDACION CRITICA DE CADA FIX

---

## H-01: monthKey = etdDate.slice(0,7) en vez de now.slice(0,7)

### Que problema resuelve
El Step 2 (fallback de busqueda de vuelo) filtra por `(f.flight_datetime || '').startsWith(monthKey)`. Si `monthKey` es el mes ACTUAL (mayo) pero el ETD del vuelo es del mes SIGUIENTE (junio), el Step 2 no encuentra el vuelo. Esto provoca creacion de vuelo duplicado cuando Step 1 tambien falla.

### Casuistica real que cubre
- **LA-0543**: 3 AWBs con ETD 2026-06-01 procesadas en mayo. monthKey="2026-05" no matchea ningun vuelo con datetime "2026-06-*". Cada AWB crea su propio vuelo.
- **Cualquier vuelo con ETD en el mes siguiente**: Todo fin de mes, los clientes cargan datos del proximo mes. monthKey incorrecto provoca duplicados.

### Casuistica que NO cubre
- **Step 1 falló por otra razon**: Si el vuelo existe pero `allFlights` no lo incluye (V-10: solo carga vuelos del cliente), ni Step 1 ni Step 2 lo encuentran. H-01 no resuelve esto — H-02 es necesario.
- **Tab no visible**: Si los datos estan en una pestaña que `findMonthTabs` no lee (e.g., "JUNE 2026" cuando es mayo), H-01 no ayuda porque las filas nunca llegan al agente. H-10 es necesario.
- **Vuelos PENDING con ETD de otro mes**: Linea 3173 usa `monthKey` para buscar vuelo PENDING. Si ETD es junio y monthKey (fijado) es "2026-06", busca PENDING con datetime "2026-06-*". Si el PENDING existente tiene datetime "2026-05-*" (del mes pasado), no matchea y crea otro PENDING. Esto es un CAMBIO DE COMPORTAMIENTO — hoy monthKey="2026-05" matchearia ese PENDING. Post-fix monthKey="2026-06" no lo matchearia.

### Riesgo de implementarlo
**BAJO, con una excepcion**:
- Para `applyPendingToReal` (linea 2667) y `applyRealToReal` (linea 2822): riesgo MINIMO. Solo afecta Step 2 fallback. Step 1 no cambia.
- Para `applyNewToSystem` (linea 3168): riesgo MEDIO en la busqueda de vuelo PENDING (linea 3171-3173). El monthKey cambia de `now` a `etdDate`, lo que podria hacer que un PENDING existente del mes actual no matchee si el ETD es de otro mes. Resultado: se crearia un SEGUNDO vuelo PENDING (mismo bug V-06 pero por otra causa).
- **Mitigacion**: Para la busqueda de vuelo PENDING, NO usar etdDate sino mantener `now.slice(0,7)`, porque los vuelos PENDING no tienen un mes "correcto" — se agrupan por mes operativo actual. Solo cambiar monthKey en las busquedas de vuelos REALES (Steps 1/2).

### Dependencias con otros fixes
- **H-10**: Sin H-10, los datos de pestanias del mes siguiente no llegan al agente. H-01 es necesario pero no suficiente si el cliente organiza por pestaña mensual.
- **H-02**: H-01 mejora Step 2 pero no cubre el caso de `allFlights` incompleto. H-02 es el safety net.
- **Snapshot (linea 3473)**: El `monthKey` de la linea 3473 (usado para `snapshotId`) es INDEPENDIENTE de los monthKey de las funciones de busqueda. NO se debe cambiar a etdDate — el snapshot key debe seguir siendo el mes actual para el tab actual. No hay dependencia directa.

### Orden de implementacion seguro
Puede implementarse en cualquier momento. No requiere otros fixes previos. Pero H-10 debe implementarse en paralelo o antes para que los datos lleguen al agente.

### Que podria romper sin pruebas
1. **PENDING search (linea 3171-3173)**: Si se cambia ciegamente monthKey a etdDate, AWBs PENDING cuyo ETD sea del mes siguiente no encontrarian el vuelo PENDING del mes actual. Crearian vuelos PENDING duplicados.
2. **etdDate vacio**: Si `ex.etd` es vacio, `etdDate = ""`, `monthKey = "".slice(0,7) = ""`. Step 2 buscaria `startsWith("")` que SIEMPRE es TRUE — matchearia TODOS los vuelos abiertos con el mismo flight number. Esto es un BUG NUEVO. **Requiere fallback a `now.slice(0,7)` cuando etdDate esta vacio**.
3. **etdDate con texto**: Si `sheetParseDate` devuelve texto (ej: "PENDING"), `monthKey = "PENDING".slice(0,7) = "PENDING"`. No matchearia nada → crea vuelo nuevo. No es un bug per se, pero es un cambio de comportamiento (antes crearia igual porque now="2026-05" tampoco matchearia un vuelo PENDING).

**VEREDICTO**: H-01 es CORRECTO y NECESARIO, pero requiere:
- Mantener `now.slice(0,7)` como fallback cuando `etdDate` es vacio
- NO aplicar el cambio a la busqueda de vuelo PENDING (linea 3171-3173)
- Codigo exacto: `const monthKey = (etdDate && etdDate.length >= 7) ? etdDate.slice(0, 7) : now.slice(0, 7)`

---

## H-10: findMonthTabs debe leer pestaña del mes siguiente

### Que problema resuelve
`findMonthTabs` (linea 2320-2342) solo busca la pestaña del mes ACTUAL. Si un cliente tiene una pestaña "JUNE 2026" con datos de vuelos de junio, el agente no la ve cuando corre en mayo. Los datos simplemente no existen para el agente.

### Casuistica real que cubre
- Express Line movio datos de junio a la pestaña "JUNE 2026". El agente dejo de ver esas filas. Todas las AWBs de junio son invisibles.
- Cualquier cliente que organice su planilla por mes con pestañas separadas.

### Casuistica que NO cubre
- Clientes que pongan datos de 2 meses adelante (ej: datos de agosto en junio). Poco probable.
- Clientes que usen nombres de pestaña no-estandar (ej: "JUN-26"). Depende de los aliases de meses.

### RIESGO CRITICO: SNAPSHOT INTERACTION

Este es el fix con MAYOR riesgo de regresion de todos. La razon es la interaccion con el snapshot:

**Estado actual del snapshot**:
- `snapshotId = clientId_YYYY-MM` (linea 3474, usa `now.slice(0,7)`)
- En mayo: snapshot = `expressline_2026-05`
- Contiene hashes de TODAS las filas leidas, independientemente de su ETD

**Problema si leemos pestaña de junio en mayo**:
1. Mayo: Lee pestañas MAY + JUNE. Todas las filas (mayo y junio) se hashean en snapshot `expressline_2026-05`
2. AWBs de junio se procesan correctamente (con H-01 fijando monthKey)
3. Llega junio: snapshot cambia a `expressline_2026-06`
4. `prevHashes` es VACIO (snapshot nuevo)
5. TODAS las filas de junio aparecen como `newRows` (hash no encontrado en snapshot junio)
6. `applyNewToSystem` intenta crear AWBs que YA EXISTEN
7. Las AWBs ya existen → cross-booking duplicate check (linea 3143-3150) las detecta → skip
8. PERO: las filas de mayo YA NO se leen (findMonthTabs solo lee mayo+junio, y ahora es junio → lee junio+julio)
9. Snapshot `expressline_2026-05` queda huerfano con hashes de filas de mayo
10. Las filas de mayo que todavia estan en la pestaña MAY → no se leen → no se detectan cambios

**Escenario de regresion grave**:
- Un cliente cambia datos de una AWB de mayo en junio (ej: actualiza PCS de un vuelo de mayo)
- El agente ya no lee la pestaña MAY → el cambio nunca se detecta
- El vuelo de mayo ya fue despachado → no deberia cambiar. PERO si el vuelo no fue despachado → el cambio se pierde

**Escenario de duplicacion al cambio de mes**:
- Todas las filas de JUNE aparecen como `newRows` en junio
- Cross-booking duplicate check las detecta → skip (linea 3148-3150)
- NO se crean duplicados pero SI se generan logs/procesamiento innecesario
- El checkpoint actualiza el hash en el nuevo snapshot → siguiente ciclo es limpio
- **Resultado**: Un ciclo "ruidoso" al cambio de mes pero sin corrupcion de datos

### Riesgo de implementarlo
**ALTO** si no se redisena el snapshot. **BAJO** si se implementa correctamente:

**Solucion al problema de snapshot**:
- Usar `snapshotId = clientId_tabTitle_hash` (ej: `expressline_june2026`) en vez de `clientId_YYYY-MM`
- Cada pestaña tiene su propio snapshot independiente
- Cuando la pestaña desaparece del rango de lectura (ej: MAY sale del rango en junio), su snapshot se ignora pero persiste
- No hay "salto" de snapshot al cambio de mes

**Alternativa mas simple**:
- Procesar cada pestaña en un loop separado, cada una con su propio `snapshotId = clientId_tabMonthKey`
- `tabMonthKey` se deriva del nombre de la pestaña (ej: "JUNE 2026" → "2026-06")
- El codigo principal (lineas 3436-3503) se reestructura para iterar por pestaña en vez de mergear

**Alternativa MINIMA (menor riesgo)**:
- `findMonthTabs` devuelve 2 tabs (actual + siguiente)
- Las filas se procesan juntas como hoy
- Pero el snapshot usa un ID que incluye AMBOS meses: `clientId_2026-05_2026-06`
- Al cambio de mes, el snapshot ID cambia a `clientId_2026-06_2026-07`
- Las filas de junio que estaban en el snapshot anterior (may+jun) no estan en el nuevo (jun+jul) → aparecen como nuevas
- MISMO PROBLEMA. No funciona.

**Conclusion**: La unica solucion robusta es procesar cada pestaña con su propio snapshot independiente. Esto requiere reestructurar el loop principal (lineas 3436-3503).

### Dependencias con otros fixes
- **H-01**: Necesario para que Step 2 funcione con datos de junio leidos en mayo.
- **Snapshot refactor**: OBLIGATORIO. Sin esto, H-10 introduce regresiones.
- **Deduplication logic**: Si AWBs aparecen en ambas pestañas, la dedup actual (linea 3456-3462) mantiene la ultima. Si procesamos por pestaña, necesitamos dedup ENTRE pestañas para evitar doble procesamiento.

### Que podria romper sin pruebas
1. **Duplicacion masiva al cambio de mes** si snapshot no se redisena
2. **Filas de mayo no detectan cambios** cuando mayo sale del rango de lectura
3. **Performance**: Leer 2 pestañas = el doble de datos, hashes, y procesamiento. Si ambas pestañas tienen 300 filas cada una, son 600 filas. Dentro del timeout de 300s.
4. **AWBs en ambas pestañas**: Si un AWB aparece en MAY y JUNE con datos distintos, se procesaria 2 veces (una por pestaña). Podria causar cambios conflictivos.

**VEREDICTO**: H-10 es NECESARIO pero es el fix de MAYOR COMPLEJIDAD y MAYOR RIESGO. Requiere refactoring del loop principal y rediseno del snapshot. Debe implementarse con pruebas exhaustivas y NO en la misma fase que fixes simples.

---

## H-02: Query Firestore antes de crear vuelo (dedup)

### Que problema resuelve
`allFlights` en memoria solo incluye vuelos asociados a bookings del cliente actual (linea 3530-3542). Si un vuelo fue creado por otro cliente, o en un ciclo anterior cuyo booking no se cargo, el agente no lo ve y crea un duplicado.

### Casuistica real que cubre
- 2 clientes con AWBs en el mismo vuelo. Cliente A crea el vuelo. Cliente B no lo ve en su `allFlights` → crea duplicado.
- AWB procesada en un ciclo, vuelo creado. Siguiente ciclo, `allFlights` deberia incluirlo (via booking), PERO si el booking no se creo correctamente o si hay un error de timing, no aparece.

### Casuistica que NO cubre
- Vuelos con `flight_number` almacenado de forma inconsistente (ej: "LA0543" vs "LA-0543"). La query usa `==` exacto. Si `normalizeFlightNumber` se aplica consistentemente al crear, esto no deberia pasar.
- Vuelos sin `flight_number` (null). La query no los encontraria.

### Riesgo de implementarlo
**BAJO**:
- Solo agrega una lectura extra de Firestore. No modifica datos existentes.
- Solo se ejecuta cuando Steps 1 y 2 fallan (camino de creacion de vuelo nuevo).
- Si la query encuentra un vuelo, lo reutiliza en vez de crear. Esto es siempre correcto.

### Riesgos especificos
1. **Performance**: Query por `flight_number` requiere un indice. Si no existe, la query falla con error. Verificar que el indice `airfreight_flights.flight_number` existe.
2. **Vuelo bloqueado**: Si la query encuentra un vuelo pero esta dispatched/closed, debe filtrarlo (usar `isFlightBlocked`). El pseudocodigo del plan v2 incluye esto.
3. **Multiples resultados**: La query puede devolver varios vuelos con el mismo `flight_number` (distintas fechas). Debe filtrar por fecha (etdDate si existe) o por !isFlightBlocked.
4. **False positive**: Un vuelo con el mismo `flight_number` pero ETD muy diferente (ej: mismo vuelo LA-0543 pero de hace 3 semanas, ya despachado). Si `isFlightBlocked` no lo filtra (por algun bug en status), podria reusar un vuelo incorrecto. Mitigacion: filtrar por `flight_datetime.startsWith(monthKey)` (corregido por H-01).

### Dependencias
- **H-01**: monthKey debe ser correcto para filtrar candidatos por mes del ETD.
- **H-05**: `isFlightBlocked` debe ser robusto para filtrar vuelos despachados.

### Que podria romper sin pruebas
1. **Indice faltante**: Si `airfreight_flights` no tiene indice en `flight_number`, la query lanza excepcion. El agente falla para esa AWB.
2. **Reuso incorrecto de vuelo**: Si la logica de filtrado es insuficiente, podria reusar un vuelo que no corresponde (distinto mes, distinta ruta). PERO esto solo ocurre si tanto Step 1 como Step 2 fallaron Y la query encontro un vuelo con el mismo flight_number — probabilidad baja de match incorrecto.

**VEREDICTO**: H-02 es CORRECTO, de BAJO RIESGO, y ALTA EFECTIVIDAD como safety net. Implementar despues de H-01. Requiere verificar indice en Firestore.

---

## H-09: Proteccion contra Step 2 ambiguo

### Que problema resuelve
Si Step 2 encuentra >1 candidatos con el mismo `flightMatchKey` en el mismo mes, actualmente "falls through" y crea un vuelo nuevo (linea 2697, 3221). Esto agrega un TERCER duplicado al problema.

### Analisis critico de la propuesta original

La propuesta del plan v2 dice: "intentar match por fecha exacta entre candidatos". Esto es **LOGICAMENTE IMPOSIBLE** en la mayoria de los casos:

- Step 1 ya busco `flightMatchKey + startsWith(etdDate)` en TODO `allFlights`
- Los candidatos de Step 2 son un subconjunto de `allFlights` con `startsWith(monthKey)` pero SIN match de `startsWith(etdDate)` (porque Step 1 ya habria encontrado esos)
- Por lo tanto, ningun candidato de Step 2 tiene `startsWith(etdDate)` — la busqueda exacta SIEMPRE falla

**Excepcion**: Si `allFlights` fue modificado entre Step 1 y Step 2 (ej: otro vuelo fue agregado por otra AWB en el mismo ciclo via `allFlights.push`). Pero el push ocurre DESPUES de la creacion, no entre Steps 1 y 2 de la misma AWB.

### Propuesta revisada

En vez de buscar fecha exacta (que no funciona), la logica deberia ser:

1. Si hay exactamente 1 candidato → usarlo (comportamiento actual)
2. Si hay >1 candidatos:
   a. Ordenar por cercania de fecha al `etdDate`
   b. Si el mas cercano esta a <=2 dias de diferencia → usarlo
   c. Si todos estan a >2 dias → crear vuelo nuevo (son vuelos genuinamente distintos)
   d. Loggear siempre la ambiguedad (H-07)

### Casuistica que cubre
- Duplicados existentes de incidentes previos (2 vuelos LA-0543 en junio). Escoge el mas cercano en fecha.
- Vuelo recurrente diario (LA-0543 del dia 1 y del dia 15). Crea nuevo correctamente si ETD es dia 8 (lejos de ambos).

### Casuistica que NO cubre
- Si ambos candidatos tienen ETD exactamente igual (verdaderos duplicados). Deberia escoger uno (ej: el que tiene mas AWBs) y loggear.

### Riesgo de implementarlo
**MEDIO**:
- Si la logica de cercania de fecha tiene bugs, podria asignar una AWB al vuelo incorrecto.
- Ejemplo de riesgo: vuelo A (06/01, 5 AWBs) y vuelo B (06/03, 0 AWBs). AWB nueva con ETD 06/02. Cercania: A=1 dia, B=1 dia. Empate. Si escoge B, la AWB va al vuelo vacio (correcto). Si escoge A, se mezcla con AWBs existentes (podria ser incorrecto si es un vuelo diferente del mismo numero).
- **Mitigacion**: En caso de empate de fecha, escoger el vuelo con MENOS AWBs (probablemente recien creado o vacio).

### Dependencias
- **H-01**: monthKey debe ser correcto para que los candidatos sean del mes correcto.
- **H-07**: Logging para auditar decisiones de desambiguacion.

### Que podria romper sin pruebas
1. **Logica de distancia de fecha**: Comparar fechas como strings vs Date objects puede dar errores (ej: "2026-06-01" vs "2026-06-10" — string comparison dice 1 dia pero son 9). Debe parsearse a Date.
2. **ETD null**: Si un candidato no tiene `flight_datetime`, la distancia es infinita. Debe manejarse.
3. **Cambio de comportamiento**: Hoy, >1 candidatos = crear nuevo. Post-fix, >1 candidatos = reusar existente. Si la logica de seleccion es incorrecta, AWBs van al vuelo equivocado.

**VEREDICTO**: H-09 es NECESARIO pero la propuesta original es INCORRECTA. Requiere rediseno con logica de cercania de fecha. Implementar DESPUES de H-01, H-02, y H-07. Riesgo MEDIO.

---

## H-03: Enriquecer airline/destino de vuelo existente

### Que problema resuelve
Cuando un vuelo se crea con airline="Unknown" o destinos=[] (por celda merge vacia), AWBs posteriores con datos correctos no actualizan el vuelo. El vuelo queda permanentemente mal.

### Casuistica real que cubre
- LA-0543: vuelos A y B con airline="Unknown" porque `ex.deliverTo` estaba vacio (celda merge en Google Sheets). El vuelo C se creo con "LATAM CAO" (lectura correcta).
- Cualquier vuelo donde la primera AWB tenga datos incompletos.

### Casuistica que NO cubre
- Vuelo con airline INCORRECTA (no vacia, sino mal, ej: "LATAM CAO" en vez de "LATAM PAX"). H-03 solo corrige "Unknown" o vacio, no valores incorrectos.
- Destinos incorrectos (ej: flight con ["BOG"] cuando deberia ser ["EZE"]). H-03 solo escribe si `destinations` esta vacio, no si tiene un valor incorrecto.

### Riesgo de implementarlo
**BAJO**:
- Solo escribe si valor actual es "Unknown" o vacio. Nunca sobreescribe un valor valido.
- `ex.deliverTo` podria contener basura (espacios, caracteres merge). Necesita validacion.
- **Validacion propuesta**: Solo enriquecer si `ex.deliverTo.trim().length >= 2` y no contiene solo espacios/numeros.

### Ubicacion en el codigo
Debe ejecutarse DESPUES de encontrar `targetFlight` en Steps 1/2, ANTES de crear booking. Tres ubicaciones:
- `applyPendingToReal`: despues de linea 2673 (Step 1 match) o 2696 (Step 2 match)
- `applyRealToReal`: despues de linea 2827 o 2848
- `applyNewToSystem`: despues de linea 3195 o 3220

### Dependencias
- Ninguna directa. Puede implementarse independientemente.
- Se beneficia de H-07 (logging) para auditar que valores se enriquecieron.

### Que podria romper sin pruebas
1. **Validacion insuficiente de deliverTo**: Si un valor basura (ej: "  ") pasa la validacion, sobreescribe "Unknown" con basura. Peor que "Unknown" porque es confuso.
2. **Destinos**: Si se agrega un destino incorrecto a un vuelo que intencionalmente no tiene destinos, podria afectar la UI del dashboard.
3. **Race condition**: Si dos ciclos corren simultaneamente y ambos intentan enriquecer el mismo vuelo, uno gana. No es un problema porque ambos escriben el mismo valor (provienen de AWBs del mismo vuelo).

**VEREDICTO**: H-03 es CORRECTO y de BAJO RIESGO. Requiere validacion de `deliverTo` antes de escribir. Implementar despues de H-07.

---

## H-08: Step 2 ETD overwrite solo si vuelo no tiene AWBs

### Que problema resuelve
Cuando Step 2 matchea un vuelo (mismo flight_number, mismo mes), actualiza su ETD al ETD de la AWB nueva (lineas 2689-2695, 2841-2847, 3212-3218). Si el vuelo ya tiene AWBs con un ETD diferente, esta sobreescritura afecta a TODAS las AWBs existentes.

### Casuistica real que cubre
- Vuelo LA-0543 existente con ETD 06/01. Step 2 lo matchea para una AWB con ETD 06/03. Sobreescribe ETD a 06/03. Las 5 AWBs existentes ahora muestran ETD incorrecto.
- QT-4099: vuelo despachado cuyo ETD fue sobreescrito. (Cubierto parcialmente por H-05.)

### Casuistica que NO cubre
- Actualizacion LEGITIMA de ETD cuando el cliente cambia la fecha para TODAS las AWBs. Pero esto deberia llegar via `applyFlightDiffs` (campo ETD diff), no via Step 2. Step 2 es un FALLBACK de busqueda, no un mecanismo de update.

### Riesgo de implementarlo
**BAJO**:
- Solo bloquea overwrite cuando el vuelo ya tiene bookings con AWBs.
- Si el vuelo esta vacio (recien creado, sin AWBs), el overwrite es safe y se permite.
- Requiere una query extra: `db.collection('airfreight_bookings').where('flight_id', '==', targetFlight.id).limit(1).get()`.

### Alternativa sin query extra
- Usar `allFlights` data: si el vuelo fue encontrado por Step 2, verificar si hay bookings en `allBookings` con ese `flight_id`. Esto evita la query extra pero depende de que `allBookings` sea completo (puede no incluir bookings de otros clientes).
- La query extra es mas segura y definitiva.

### Riesgo especifico
- **ETD nunca se actualiza via Step 2 para vuelos con AWBs**: Si el ETD del vuelo es incorrecto y solo se puede corregir via Step 2 (porque Step 1 no matchea por fecha diferente), el overwrite queda bloqueado. El ETD queda incorrecto.
- **Mitigacion**: Generar alerta cuando se bloquea el overwrite, para que se revise manualmente.
- **Nota**: `applyFlightDiffs` (linea 3089) actualiza ETD via el flujo normal de diffs (campo "ETD" detectado por `computeDiffs`). Este camino NO se ve afectado por H-08. H-08 solo afecta el ETD overwrite que hace Step 2 como efecto secundario del matching.

### Dependencias
- Ninguna. Independiente.

### Que podria romper sin pruebas
1. **Vuelo recien creado**: Si en el MISMO ciclo, AWB 1 crea el vuelo (sin booking aun, porque el booking se crea DESPUES) y AWB 2 matchea via Step 2 → la query de bookings devuelve 0 → permite overwrite. Correcto, porque AWB 1 ya creo el booking entre la creacion del vuelo y el Step 2 de AWB 2? NO — AWB 1 crea vuelo Y booking atomicamente antes de que AWB 2 se procese. Entonces AWB 2 haria la query → encontraria 1 booking → bloquea overwrite. Esto es CORRECTO si ambas AWBs tienen el mismo ETD. Si tienen ETD diferente, es una situacion anomala que merece review.
2. **Performance**: 1 query extra por cada match de Step 2. Step 2 es poco frecuente. Impacto minimo.

**VEREDICTO**: H-08 es CORRECTO y de BAJO RIESGO. La logica es simple y bien acotada. Implementar en cualquier momento.

---

## H-05: isFlightBlocked debe verificar dispatched_at

### Que problema resuelve
Un vuelo con `dispatched_at` seteado pero `flight_status` no seteado (o `flight_status != "dispatched"`) no se bloquea. El agente podria modificar un vuelo ya despachado.

### Casuistica real que cubre
- QT-4099: El dispatch setea `flight_status = "dispatched"` pero hay un path donde solo setea `dispatched_at` sin actualizar `status`. En ese caso, `isFlightBlocked` devuelve false.
- Cualquier inconsistencia entre `flight_status`/`status` y `dispatched_at`.

### Casuistica que NO cubre
- Vuelo cerrado sin `dispatched_at` ni `flight_status = closed`. Pero `status = "closed"` ya se verifica.
- Vuelo reactivado despues de despacho (si alguien borra `dispatched_at` para reabrir). Escenario no estandar.

### Riesgo de implementarlo
**MINIMO**:
- Solo agrega una condicion de bloqueo adicional. Nunca PERMITE algo que antes bloqueaba.
- Unico riesgo: un vuelo con `dispatched_at` erroneo (seteado por accident) quedaria permanentemente bloqueado. Pero esto es un problema de datos, no del fix.

### Tipo de dato de dispatched_at
- Puede ser un `Timestamp` de Firestore (objeto con `.toDate()`) o un `string` ISO.
- `if (f.dispatched_at)` es truthy para ambos. NO hay riesgo de falso negativo.
- No necesita parseo — solo verifica existencia.

### Dependencias
- Ninguna. Completamente independiente.
- `applyFlightDiffs` (linea 3096-3098) ya verifica `fStatus === 'dispatched' || 'closed'`. Podria beneficiarse de usar `isFlightBlocked` en vez de logica inline. Pero esto es un refactor separado, no necesario para el fix.

### Que podria romper sin pruebas
Practicamente nada. Es la adicion de 1 linea: `if (f.dispatched_at) return true`.

**VEREDICTO**: H-05 es el fix de MENOR RIESGO de todos. 1 linea, sin dependencias, sin efectos secundarios. Implementar PRIMERO.

---

## H-04: Limpieza de PENDING huerfanos

### Que problema resuelve
Cuando `applyPendingToReal` mueve una AWB del booking PENDING al vuelo real:
1. Remueve la AWB line del booking PENDING (linea 2724)
2. Agrega la AWB line al booking del vuelo real (linea 2768)
3. NUNCA verifica si el booking PENDING quedo vacio (0 AWBs)
4. NUNCA verifica si el vuelo PENDING quedo sin bookings con AWBs

Resultado: vuelos y bookings PENDING vacios se acumulan indefinidamente.

### Casuistica real que cubre
- 4 vuelos PENDING huerfanos en produccion (MxakFvWy, 5ON95S0s, uN6GUATR, utBlnvbX) con 0 AWBs cada uno.

### Casuistica que NO cubre
- PENDING bookings con AWBs que deberian haberse movido pero no se movieron (por bug del agente). H-04 no los toca porque tienen AWBs.
- PENDING vuelos creados manualmente (no por el agente). Protegidos por el check `created_by = 'sheet_sync_agent'`.

### Riesgo de implementarlo
**BAJO, con precauciones**:

1. **Race condition**: Si el agente esta procesando multiples AWBs del mismo vuelo PENDING en un ciclo, y AWB 1 se mueve → booking queda vacio → H-04 lo borra. Pero AWB 2 todavia tiene referencia al booking viejo → error.
   - **Mitigacion**: H-04 debe ejecutarse AL FINAL del ciclo, no inmediatamente despues de cada move. O mejor: re-leer el booking desde Firestore antes de borrar (la transaccion de remove ya actualizo los datos).
   - **Alternativa**: Hacer la limpieza en un paso separado al final del sync, no inline en `applyPendingToReal`.

2. **Booking compartido**: Si un booking PENDING tiene AWBs de multiples filas y solo una se movio, el booking no esta vacio. H-04 no lo borra. Correcto.

3. **Vuelo PENDING compartido entre clientes**: Si 2 clientes comparten un vuelo PENDING (poco probable, ya que cada cliente tiene su propio booking), borrar el vuelo afecta a ambos.
   - **Mitigacion**: Antes de borrar el vuelo, verificar que NO hay otros bookings referenciandolo: `db.collection('airfreight_bookings').where('flight_id', '==', flightId).limit(1).get()`. Solo borrar si `empty`.

4. **Momento de ejecucion**: Si H-04 corre inline en `applyPendingToReal`, agrega 1-2 queries extra POR CADA move. Si hay 10 moves, son 10-20 queries extra.
   - **Alternativa mas eficiente**: Acumular vuelos/bookings PENDING que fueron vaciados, limpiarlos al final del ciclo en batch.

### Dependencias
- **Debe implementarse DESPUES de H-01/H-10**: Si H-01 no esta corregido, el agente sigue creando PENDING duplicados. Limpiarlos antes de fijar la causa raiz es inutil.
- Sin otras dependencias.

### Que podria romper sin pruebas
1. **Borrar booking que todavia tiene AWBs**: Si la verificacion de `awb_lines.length === 0` tiene un bug (ej: lineas vacias, lineas sin `awb_number`), podria borrar un booking con datos.
   - **Mitigacion estricta**: `const remainingLines = (bookingData.awb_lines || []).filter(l => (l.awb_number || '').trim().length > 0)`. Solo borrar si `remainingLines.length === 0`.
2. **Borrar vuelo que tiene doc_receptions o billing**: Actualmente no hay cascade. Si un vuelo PENDING tiene doc_receptions (improbable pero posible), borrar el vuelo deja las doc_receptions huerfanas.
   - **Mitigacion**: Verificar que no hay doc_receptions, billing, o ULDs asociados antes de borrar.

**VEREDICTO**: H-04 es CORRECTO conceptualmente pero requiere precauciones de implementacion (verificar booking vacio, verificar no hay otros bookings en el vuelo, verificar no hay entidades dependientes, y ejecutar solo si `created_by = 'sheet_sync_agent'`). Implementar AL FINAL, despues de todos los demas fixes.

---

## H-07: Logging estructurado

### Que problema resuelve
No hay forma de auditar por que se creo un vuelo, que datos tenia la AWB que lo disparo, ni que step del matching se uso. Diagnosticar problemas requiere reconstruccion manual.

### Casuistica real que cubre
Todas. El logging es transversal — ayuda a diagnosticar cualquier incidente futuro.

### Riesgo de implementarlo
**NINGUNO**:
- Solo agrega escrituras de documentos de auditoria a una coleccion nueva (`_sheet_sync_flight_audit`).
- No modifica logica existente.
- No lee datos adicionales.

### Consideraciones
1. **Volumen de datos**: Si se loggea CADA operacion, puede generar muchos documentos. Limitar a eventos significativos:
   - Creacion de vuelo (con datos completos: flight_number, airline, etd, dest, trigger_awb, step)
   - Uso de Step 2 fallback (con vuelo matcheado, ETD original vs nuevo)
   - Airline "Unknown" usada como fallback
   - AWB movida entre vuelos
   - Enriquecimiento de vuelo (H-03)
   - Step 2 ambiguo (H-09)
2. **Formato**: Documentos en `_sheet_sync_flight_audit` con `type`, `flight_id`, `flight_number`, `trigger_awb`, `step`, `data`, `created_at`.
3. **Retencion**: No se necesita politica de retencion inmediata, pero considerar cleanup despues de 90 dias.

### Dependencias
- Ninguna. Puede implementarse independientemente y PRIMERO.

### Que podria romper sin pruebas
Nada. Solo agrega writes. Un error en el logging no afecta el flujo principal (envolver en try/catch).

**VEREDICTO**: H-07 debe ser el PRIMER fix implementado. Establece la capacidad de observar el comportamiento del agente post-deploy de los demas fixes.

---

# PARTE 2: PLAN DE PRUEBAS EXHAUSTIVO

---

## A. Pruebas unitarias por funcion

### T-U01: normalizeFlightNumber

| # | Input | Expected Output | Razon |
|---|-------|----------------|-------|
| 1 | `"LA-0543"` | `"LA-0543"` | Ya normalizado |
| 2 | `"LA0543"` | `"LA-0543"` | Agregar hyphen |
| 3 | `"la-0543"` | `"LA-0543"` | Uppercase |
| 4 | `"LA-0543 PAX"` | `"LA-0543"` | Strip suffix PAX |
| 5 | `"LA-0543 CAO"` | `"LA-0543"` | Strip suffix CAO |
| 6 | `"LA-0543 A18"` | `"LA-0543"` | Strip suffix A18 |
| 7 | `"QT4093"` | `"QT-4093"` | Agregar hyphen |
| 8 | `"UC1617"` | `"UC-1617"` | Agregar hyphen |
| 9 | `"PENDING"` | `"PENDING"` | No modificar PENDING |
| 10 | `"TBD"` | `"TBD"` | No modificar TBD |
| 11 | `""` | `""` | Vacio |
| 12 | `null` | `""` | Null safety |
| 13 | `"AR1303 PAX"` | `"AR-1303"` | Strip suffix + agregar hyphen |
| 14 | `"L7-2549"` | `"L7-2549"` | Airline con numero |
| 15 | `"5X1234"` | `"5X-1234"` | Airline empieza con digito |
| 16 | `"LA-0543 LOOSE"` | `"LA-0543"` | Strip LOOSE |
| 17 | `"  LA-0543  "` | `"LA-0543"` | Trim whitespace |

**Atencion linea 2264**: regex `^([A-Z]{1,3})(\d{3,5})$` — airlines con digito como "5X" NO matchean porque `[A-Z]` no incluye digitos. `"5X1234"` no se normalizaria. Esto es un BUG PREEXISTENTE (no introducido por los fixes), pero debe documentarse.

### T-U02: flightMatchKey

| # | Input | Expected Output | Razon |
|---|-------|----------------|-------|
| 1 | `"LA-0543"` | `"LA0543"` | Strip hyphen |
| 2 | `"LA0543"` | `"LA0543"` | Ya limpio |
| 3 | `"LA-0543 PAX"` | `"LA0543"` | Strip suffix + hyphen |
| 4 | `"la-0543"` | `"LA0543"` | Uppercase + strip |
| 5 | `"QT-4093"` | `"QT4093"` | Strip hyphen |
| 6 | `"PENDING"` | `"PENDING"` | No-op |
| 7 | `""` | `""` | Vacio |
| 8 | `null` | `""` | Null safety |
| 9 | `"L7-2549"` | `"L72549"` | Con digito en airline |
| 10 | `"5X-1234"` | `"5X1234"` | Digito al inicio |

### T-U03: sheetParseDate

| # | Input | Expected Output | Caso |
|---|-------|----------------|------|
| 1 | `"6/1/2026 23:40"` | `"2026-06-01T23:40:00"` | MM/DD/YYYY HH:MM |
| 2 | `"6/1/2026"` | `"2026-06-01"` | MM/DD/YYYY sin hora |
| 3 | `"05/31/2026"` | `"2026-05-31"` | MM/DD/YYYY con ceros |
| 4 | `"5/30/26"` | `"2026-05-30"` | Anio 2 digitos |
| 5 | `46178` | `"2026-06-01"` | Serial Excel (entero) |
| 6 | `46178.9861` | `"2026-06-01T23:40:00"` | Serial Excel con hora |
| 7 | `""` | `""` | Vacio |
| 8 | `null` | `""` | Null |
| 9 | `"PENDING"` | `"PENDING"` | Comienza con letra → passthrough |
| 10 | `"1/1/2019"` | `""` | Anio < 2020 → rechazado |
| 11 | `"12/31/2036"` | `""` | Anio > 2035 → rechazado |
| 12 | `"6-1-2026"` | `"2026-06-01"` | Separador guion |
| 13 | `0` | deberia ser `""` | Cero → serial → fecha 1899-12-30 → anio < 2020 → ??? |

**Atencion**: `sheetParseDate(0)` → `typeof 0 === 'number'` → `new Date((0 - 25569) * 86400000)` → fecha negativa (1899). Devuelve `"1899-12-30"`. Despues, la validacion de anio (linea 2235) NO aplica al path numerico (solo al path de string). BUG PREEXISTENTE: seriales 0 o muy pequeños generan fechas invalidas. No critico (no llegan seriales 0 en la practica), pero debe documentarse.

### T-U04: isFlightBlocked (post-fix H-05)

| # | Input | Expected | Razon |
|---|-------|----------|-------|
| 1 | `{ flight_status: 'dispatched' }` | `true` | Status dispatched |
| 2 | `{ status: 'dispatched' }` | `true` | Fallback status |
| 3 | `{ flight_status: 'closed' }` | `true` | Closed |
| 4 | `{ status: 'open', flight_status: 'dispatched' }` | `true` | flight_status wins |
| 5 | `{ status: 'open' }` | `false` | Open |
| 6 | `{ dispatched_at: '2026-05-28T10:00:00' }` | `true` | **POST-FIX**: dispatched_at presente |
| 7 | `{ dispatched_at: Timestamp }` | `true` | Firestore Timestamp object |
| 8 | `{ status: 'open', dispatched_at: '2026-05-28T10:00:00' }` | `true` | dispatched_at prevalece |
| 9 | `null` | `false` | Null safety |
| 10 | `{}` | `false` | Empty object |
| 11 | `{ dispatched_at: null }` | `false` | Null dispatched_at |
| 12 | `{ dispatched_at: '' }` | `false` | Empty string (falsy) |

### T-U05: normalizeDest

| # | Input | Expected | Razon |
|---|-------|----------|-------|
| 1 | `"BOG"` | `"BOG"` | Ya limpio |
| 2 | `"EZE LOOSE"` | `"EZE"` | Strip LOOSE |
| 3 | `"EZE PAX"` | `"EZE"` | Strip PAX |
| 4 | `"bog"` | `"BOG"` | Uppercase |
| 5 | `""` | `""` | Vacio |
| 6 | `"BOG - BOGOTA"` | `"BOG - BOGOTA"` | NO strip " - BOGOTA" (regex no cubre esto) |
| 7 | `"  EZE  "` | `"EZE"` | Trim |

**Nota**: `normalizeDest` NO limpia sufijos tipo " - BOGOTA". Si un destino viene como "BOG - BOGOTA", se guarda asi. Esto es un defecto existente de la normalizacion, no introducido por los fixes.

### T-U06: computeDiffs — deteccion de cambio de vuelo

| # | Setup | Expected | Razon |
|---|-------|----------|-------|
| 1 | `ex.flight = "LA-0543"`, `sys.flightNumber = "PENDING"` | Diff Vuelo: PENDING → LA-0543 | PENDING → real |
| 2 | `ex.flight = "LA-0543"`, `sys.flightNumber = "LA-0543"` | NO diff Vuelo | Mismo vuelo |
| 3 | `ex.flight = "LA0543"`, `sys.flightNumber = "LA-0543"` | NO diff Vuelo | flightMatchKey normaliza |
| 4 | `ex.flight = "QT-4099"`, `sys.flightNumber = "QT-4093"` | Diff Vuelo | Vuelos distintos |
| 5 | `ex.flight = "PENDING"`, `sys.flightNumber = "LA-0543"` | NO diff Vuelo | exIsPending=true → no genera diff |
| 6 | `ex.flight = ""`, `sys.flightNumber = "LA-0543"` | NO diff Vuelo | exIsPending=true (vacio) |
| 7 | `ex.flight = "LA-0543 PAX"`, `sys.flightNumber = "LA-0543"` | NO diff Vuelo | flightMatchKey: "LA0543" == "LA0543" |

### T-U07: buildSystemMaps

**Setup**:
- 2 bookings: booking A (flight_id: "F1", 2 AWBs), booking B (flight_id: "F2", 1 AWB)
- flightMap: F1 → {flight_number: "LA-0543", flight_datetime: "2026-06-01T23:40:00", airline: "LATAM PAX"}, F2 → {flight_number: "QT-4093", ...}
- builtAwbs: Set("369-98157135")
- receivedAwbs: Set("369-98157135", "369-98157146")

**Verificaciones**:
- `byAwb1` tiene 3 entries (una por AWB)
- Entry para 369-98157135: `flightNumber = "LA-0543"`, `built = true`, `received = true`
- Entry para 369-98157146: `flightNumber = "LA-0543"`, `built = false`, `received = true`
- Entry para AWB de booking B: `flightNumber = "QT-4093"`, `built = false`, `received = false`
- `flightStatus` se lee de `flight_status || status` (OR logico)

### T-U08: rowHash — estabilidad

| # | Test | Verificacion |
|---|------|-------------|
| 1 | Misma fila 2 veces | Hash identico |
| 2 | Cambiar PCS | Hash diferente |
| 3 | Cambiar flight | Hash diferente |
| 4 | Cambiar ETD | Hash diferente |
| 5 | Cambiar holdBg | Hash diferente |
| 6 | Cambiar mayusculas AWB | Hash IGUAL (sheetNormStr normaliza) |

### T-U09: monthKey fix (H-01) — validacion del valor

| # | etdDate | now | Expected monthKey | Razon |
|---|---------|-----|-------------------|-------|
| 1 | `"2026-06-01"` | `"2026-05-29"` | `"2026-06"` | ETD junio, now mayo → usa junio |
| 2 | `"2026-05-15"` | `"2026-05-29"` | `"2026-05"` | ETD y now mismo mes |
| 3 | `""` | `"2026-05-29"` | `"2026-05"` | ETD vacio → fallback a now |
| 4 | `"PENDING"` | `"2026-05-29"` | `"2026-05"` | ETD no es fecha → fallback (length < 7) |
| 5 | `"2026-07-10"` | `"2026-05-29"` | `"2026-07"` | ETD 2 meses adelante |

---

## B. Pruebas de integracion basadas en casos reales

### T-I-01: Caso LA-0543 — 3 AWBs mismo vuelo, mismo ciclo

**Precondiciones**:
- 3 AWBs nuevas en planilla: LA-0543, ETD 2026-06-01T23:40, LATAM PAX, EZE
- Las 3 aparecen como `newRows` en el mismo ciclo
- No existe ningun vuelo LA-0543 en Firestore
- Fecha actual: 2026-05-29 (mes distinto al ETD)

**Ejecucion**: `applyNewToSystem` x3

**Resultados esperados**:
- AWB 1: Step 1 no matchea (no hay vuelo) → Step 2 no matchea (monthKey="2026-06", no hay vuelos junio) → crea vuelo LA-0543 + booking + 1 AWB line → `allFlights.push()`
- AWB 2: Step 1 busca `"LA0543" + startsWith("2026-06-01")` en allFlights → ENCUENTRA el vuelo creado por AWB 1 → usa el vuelo existente → busca booking existente del cliente para ese vuelo → ENCUENTRA → agrega AWB line al booking existente
- AWB 3: Idem AWB 2

**Verificaciones**:
- Exactamente 1 vuelo con `flight_number = "LA-0543"` en Firestore
- Ese vuelo tiene `airline = "LATAM PAX"`, `destinations = ["EZE"]`
- Exactamente 1 booking con `flight_id = <vuelo>` y `client_id = <expressline>`
- Ese booking tiene `awb_lines.length === 3`
- 0 vuelos PENDING creados

### T-I-02: Caso LA-0543 — 3 AWBs, ciclos distintos

**Precondiciones**:
- AWB 1 procesada en ciclo 1 (crea vuelo + booking)
- AWB 2 procesada en ciclo 2 (allFlights recargado de Firestore)
- AWB 3 procesada en ciclo 3

**Verificaciones adicionales**:
- En ciclo 2, `allFlights` incluye el vuelo creado en ciclo 1 (via booking → flightIds → flight load)
- Step 1 matchea el vuelo existente
- No se crea vuelo duplicado
- Resultado final: 1 vuelo, 1 booking, 3 AWBs

### T-I-03: PENDING → real (3 AWBs)

**Precondiciones**:
- 3 AWBs ya existen como PENDING en el sistema (1 vuelo PENDING, 1 booking con 3 AWB lines)
- Planilla se actualiza con "LA-0543" para las 3
- Las 3 se detectan como `changedRows` con diff de Vuelo

**Ejecucion**: `applyPendingToReal` x3

**Resultados esperados**:
- AWB 1: Step 1 no matchea → Step 2 monthKey="2026-06" no matchea → crea vuelo LA-0543 → remueve AWB del booking PENDING → agrega al nuevo booking
- AWB 2: Step 1 matchea vuelo creado por AWB 1 → usa vuelo existente → busca booking → lo encuentra → agrega AWB
- AWB 3: Idem AWB 2

**Verificaciones**:
- 1 vuelo LA-0543 creado
- 3 AWBs en 1 booking del vuelo
- Booking PENDING tiene 0 AWBs (tras H-04: se elimina)
- Vuelo PENDING sin bookings con AWBs (tras H-04: se elimina)

### T-I-04: Vuelo mismo numero, distinta fecha (vuelo despachado)

**Precondiciones**:
- Vuelo existente: LA-0543, ETD 2026-05-25, `flight_status: "dispatched"`, `dispatched_at: "2026-05-25T18:00:00"`
- AWB nueva: LA-0543, ETD 2026-06-01

**Ejecucion**: `applyNewToSystem`

**Resultados esperados**:
- Step 1: busca `"LA0543" + startsWith("2026-06-01")` → vuelo existente tiene "2026-05-25" → NO matchea → continua
- Step 2: busca `"LA0543" + startsWith("2026-06")` → vuelo existente tiene "2026-05-25" → NO matchea → continua
- Crea vuelo nuevo LA-0543 con ETD 2026-06-01

**Verificaciones**:
- Vuelo despachado NO fue modificado
- Nuevo vuelo creado correctamente
- Si Step 1 HUBIERA matcheado (mismo ETD): `isFlightBlocked` devuelve true → skip → crea nuevo. Verificar.

### T-I-05: monthKey cruce de mes

**Precondiciones**:
- Fecha actual: 2026-05-31
- AWB nueva: UC-1105, ETD 2026-06-02
- Ya existe vuelo UC-1105 con ETD 2026-06-01T15:00 (creado el dia anterior)

**Ejecucion**: `applyNewToSystem`

**Resultados esperados PRE-FIX**:
- Step 1: busca "UC1105" + `startsWith("2026-06-02")` → vuelo existente tiene "2026-06-01" → NO matchea
- Step 2: `monthKey = now.slice(0,7) = "2026-05"` → busca `startsWith("2026-05")` → vuelo existente tiene "2026-06-01" → NO matchea → CREA DUPLICADO

**Resultados esperados POST-FIX (H-01)**:
- Step 1: NO matchea (ETD diferente: 06/02 vs 06/01)
- Step 2: `monthKey = etdDate.slice(0,7) = "2026-06"` → busca `startsWith("2026-06")` → vuelo existente tiene "2026-06-01" → MATCHEA → usa vuelo existente

**Verificacion clave**: El vuelo de junio ES encontrado por Step 2 post-fix. No se crea duplicado.

### T-I-06: airline vacia con vuelo existente (H-03)

**Precondiciones**:
- Vuelo existente LA-0543: airline="Unknown", ETD 2026-06-01, destinations=[]
- AWB nueva con `deliverTo = "LATAM PAX"`, `dest = "EZE"`

**Ejecucion**: `applyNewToSystem` con H-03 activo

**Resultados esperados**:
- Step 1 matchea el vuelo existente
- H-03 detecta airline="Unknown" → actualiza a "LATAM PAX"
- H-03 detecta destinations=[] → actualiza a ["EZE"]
- AWB se agrega al booking del vuelo

**Verificaciones**:
- Vuelo tiene `airline = "LATAM PAX"` (actualizado)
- Vuelo tiene `destinations = ["EZE"]` (actualizado)
- AWB en el booking correcto

### T-I-07: airline vacia en AWB pero vuelo ya tiene airline correcta

**Precondiciones**:
- Vuelo existente LA-0543: airline="LATAM PAX", destinations=["EZE"]
- AWB nueva con `deliverTo = ""` (celda merge vacia)

**Ejecucion**: `applyNewToSystem` con H-03 activo

**Resultados esperados**:
- Step 1 matchea el vuelo existente
- H-03: airline="LATAM PAX" (no es "Unknown" ni vacia) → NO sobreescribe
- AWB se agrega al booking

**Verificaciones**:
- Vuelo mantiene `airline = "LATAM PAX"` (sin cambio)
- Si se CREA vuelo nuevo (por otra razon), `airline: ex.deliverTo || 'Unknown'` → seria "Unknown". H-03 no aplica a creacion, solo a vuelos existentes encontrados por Step 1/2.

### T-I-08: vuelo intocable — dispatched_at sin flight_status (H-05)

**Precondiciones**:
- Vuelo con `status: "open"`, `flight_status: undefined`, `dispatched_at: "2026-05-28T18:00:00"`
- AWB en planilla con cambio de ETD para ese vuelo

**Ejecucion**: `applyFlightDiffs` via el flujo principal

**Resultados esperados PRE-FIX**:
- `isFlightBlocked` evalua: `(f.flight_status || f.status || '').toLowerCase()` = `"open"` → NOT dispatched/closed → `return false`
- Flight search INCLUYE este vuelo → AWBs pueden asignarse
- `applyFlightDiffs` verifica `fStatus = sys.flightStatus` = `""` → NO blocked → ACTUALIZA ETD. **BUG: vuelo despachado modificado**

**Resultados esperados POST-FIX**:
- `isFlightBlocked`: `f.dispatched_at` es truthy → `return true`
- Flight search EXCLUYE este vuelo
- No se modifica nada

**Nota critica**: `applyFlightDiffs` (linea 3096) usa `sys.flightStatus` que viene de `buildSystemMaps` (linea 2582): `flightStatus: (flight && (flight.flight_status || flight.status)) || ''`. Si `flight_status` es undefined y `status` es "open", `flightStatus = "open"`. La verificacion en `applyFlightDiffs` solo chequea "dispatched" y "closed", NO `dispatched_at`. **H-05 fix en `isFlightBlocked` no cubre `applyFlightDiffs`**. Se necesita agregar `if (sys.dispatchedAt || sys.flightDispatchedAt) return blocked` en `applyFlightDiffs` tambien.

### T-I-09: ETD overwrite proteccion (H-08)

**Precondiciones**:
- Vuelo existente: LA-0543, ETD 2026-06-01T23:40, tiene 1 booking con 5 AWBs
- AWB nueva: LA-0543, ETD 2026-06-05T10:00
- Step 1 falla (ETD diferente: 06/01 vs 06/05)
- Step 2 matchea (mismo mes: "2026-06")

**Resultados esperados POST-FIX (H-08)**:
- Step 2 encuentra 1 candidato
- Antes de overwrite ETD: query bookings → 1 booking con 5 AWBs → NOT empty
- BLOQUEA overwrite de ETD
- Genera alerta para review manual
- AWB se agrega al vuelo (usando ETD existente, no el nuevo)

**Verificaciones**:
- ETD del vuelo sigue siendo 2026-06-01T23:40 (NO sobreescrito)
- AWB fue agregada al booking del vuelo
- Alerta generada con tipo "step2_etd_blocked"

### T-I-10: Limpieza PENDING huerfanos (H-04)

**Precondiciones**:
- Vuelo PENDING con 1 booking con 1 AWB (369-98157135)
- AWB se mueve a vuelo real via `applyPendingToReal`

**Ejecucion**: `applyPendingToReal` + limpieza H-04

**Resultados esperados**:
- AWB removida del booking PENDING → booking tiene 0 AWBs
- H-04 detecta booking vacio → lo marca o elimina
- H-04 verifica si vuelo PENDING tiene otros bookings → no tiene → elimina vuelo PENDING

**Verificaciones**:
- Booking PENDING ya no existe en Firestore (o tiene flag `_empty: true`)
- Vuelo PENDING ya no existe en Firestore (o tiene flag `_empty: true`)
- AWB esta en el booking del vuelo real
- Si el vuelo PENDING tenia otros bookings de otros clientes → NO se elimina

### T-I-11: Dedup Firestore (H-02)

**Precondiciones**:
- Vuelo existente LA-0543 (creado por otro cliente) con ETD 2026-06-01
- `allFlights` del cliente actual NO incluye este vuelo (no tiene bookings de este cliente)
- AWB nueva del cliente actual: LA-0543, ETD 2026-06-01

**Ejecucion**: `applyNewToSystem` con H-02 activo

**Resultados esperados**:
- Step 1: busca en `allFlights` → NO encuentra (no esta cargado)
- Step 2: busca en `allFlights` → NO encuentra
- H-02: query Firestore `airfreight_flights.where('flight_number', '==', 'LA-0543')` → ENCUENTRA el vuelo
- Filtra por !isFlightBlocked y startsWith(etdDate) → matchea
- Usa el vuelo existente → crea booking del cliente actual en ese vuelo

**Verificaciones**:
- 0 vuelos nuevos creados
- Booking del cliente creado con `flight_id` apuntando al vuelo existente
- `allFlights` actualizado con el vuelo encontrado (para que AWBs posteriores del mismo ciclo lo encuentren)

### T-I-12: Tab JUNE visible en mayo (H-10)

**Precondiciones**:
- Fecha actual: 2026-05-29
- Pestaña "JUNE 2026" existe en la planilla con 15 filas
- Pestaña "MAY 2026" existe con 20 filas

**Ejecucion**: `findMonthTabs` post-fix

**Resultados esperados**:
- Devuelve 2 tabs: [{tabTitle: "MAY 2026", monthKey: "2026-05"}, {tabTitle: "JUNE 2026", monthKey: "2026-06"}]
- Ambas se procesan con snapshots independientes
- Filas de mayo contra snapshot `clientId_2026-05`
- Filas de junio contra snapshot `clientId_2026-06`

**Verificaciones**:
- AWBs de junio se procesan correctamente (con H-01 corregido)
- Snapshot de junio persiste al cambio de mes
- En julio, snapshot `clientId_2026-06` sigue existiendo y las filas de junio no se re-procesan

---

## C. Pruebas de regresion

### T-R01: Vuelos locales (flight_type = 'local_job')

**Verificar**: Los fixes NO afectan vuelos con `flight_type = 'local_job'`. Todos los Steps 1/2 filtran `f.flight_type !== 'local_job'`. Confirmar que esta condicion persiste.

### T-R02: Vuelos sin AWBs

**Verificar**: Un vuelo existente sin bookings puede recibir AWBs nuevas. H-08 permite overwrite ETD en vuelos sin bookings. Confirmar.

### T-R03: Vuelos con multiples bookings

**Verificar**: Un vuelo con bookings de multiples clientes. Cuando un cliente agrega AWB, no afecta bookings de otros clientes. Confirmar que `applyNewToSystem` busca booking por `client_id + flight_id + booking_type`.

### T-R04: Vuelos con multiples destinos

**Verificar**: Si un vuelo tiene `destinations = ["EZE", "BOG"]` y se enrichece (H-03) con un destino vacio, NO se sobreescribe. Confirmar condicion `(!targetFlight.destinations || targetFlight.destinations.length === 0)`.

### T-R05: flight_number no estandar

**Verificar**: Vuelos con numeros como "5X-1234" (digito al inicio), "L7-2549" (digito en airline), "FX4567" (FedEx). `normalizeFlightNumber` y `flightMatchKey` los manejan correctamente.

### T-R06: airline no estandar

**Verificar**: Airlines con nombres largos ("KOREAN AIR CARGO"), con simbolos ("GOL/VARIG"), con numeros ("3S"). Se almacenan tal cual en el campo `airline`.

### T-R07: ETD sin hora

**Verificar**: `flight_datetime = "2026-06-01"` (sin T ni hora). `startsWith("2026-06-01")` matchea. `startsWith("2026-06")` matchea. Todo correcto.

### T-R08: Vuelo con tab_name_override

**Verificar**: Si un config tiene `tab_name_override`, se usa esa pestaña directamente (linea 3422-3423). H-10 no afecta este path. Confirmar.

### T-R09: changedRow que no tiene sys (sistema no la conoce)

**Verificar**: Linea 3614-3617: si `changedRow` no tiene match en `byAwb1/byAwb2`, se pushea a `newRows`. Confirmar que este flujo sigue funcionando.

### T-R10: MAX_PENDING_TRANSITIONS = 10

**Verificar**: El limite de 10 transiciones PENDING→real por ciclo sigue activo (linea 3600). Confirmar que los fixes no alteran este limite.

### T-R11: Checkpoint (hash incremental)

**Verificar**: Despues de cada AWB procesada exitosamente, el hash se actualiza via `checkpoint(key1)`. Confirmar que los fixes no rompen el orden de checkpoint.

### T-R12: Holds sync

**Verificar**: El sync de holds (lineas 4171-4238) no se ve afectado por ningun fix. Confirmar.

### T-R13: Write-back a Google Sheets

**Verificar**: El write-back de ON-HAND DATE y DROPPED OFF (lineas 4153-4166) no se ve afectado. Si H-10 lee 2 tabs, el write-back ocurre para cada tab (ya lo hace via `tabParseResults` loop). Confirmar.

---

# PARTE 3: GARANTIA DE NO-REGRESION

---

## 3.1 Que podria romper cada fix

| Fix | Que puede romper | Probabilidad | Impacto |
|-----|-----------------|--------------|---------|
| H-07 (logging) | Nada | 0% | N/A |
| H-05 (isFlightBlocked) | Vuelo con dispatched_at erroneo queda bloqueado permanentemente | <1% | BAJO (arreglable borrando el campo) |
| H-01 (monthKey) | PENDING search con ETD de otro mes crea PENDING duplicado si se aplica a linea 3173 | 5% si se implementa mal | MEDIO |
| H-01 (monthKey) | etdDate vacio → monthKey="" → matchea todos los vuelos | 10% si no hay fallback | ALTO |
| H-03 (enriquecer) | deliverTo basura sobreescribe "Unknown" | 3% | BAJO |
| H-08 (ETD protect) | ETD legitimo no se actualiza via Step 2 | 2% | BAJO (applyFlightDiffs sigue funcionando) |
| H-02 (dedup FS) | Indice faltante → error | 5% | MEDIO (primera ejecucion falla, se loggea) |
| H-02 (dedup FS) | Reuso de vuelo incorrecto | 1% | MEDIO |
| H-09 (ambiguo) | Logica de distancia de fecha incorrecta | 5% | MEDIO |
| H-04 (PENDING clean) | Race condition borra booking con AWBs | 1% | ALTO |
| H-10 (next month tab) | Snapshot mal diseñado → duplicacion masiva | 15% si se implementa mal | CRITICO |
| H-10 (next month tab) | Doble procesamiento de AWBs en ambas pestañas | 10% | MEDIO |

## 3.2 Condiciones que deben verificarse ANTES de aplicar cada fix

### Pre-H-07 (logging)
- Verificar que `_sheet_sync_flight_audit` no existe como coleccion para evitar conflictos
- Solo requiere deploy

### Pre-H-05 (isFlightBlocked)
- Query: `db.collection('airfreight_flights').where('dispatched_at', '!=', null).get()` — listar vuelos con dispatched_at
- Verificar que todos esos vuelos DEBERIAN estar bloqueados
- Si hay algun vuelo con dispatched_at que deberia estar abierto → corregir datos antes del deploy

### Pre-H-01 (monthKey)
- Verificar que NO se aplica a la busqueda de vuelo PENDING (linea 3173)
- Verificar que tiene fallback para etdDate vacio
- Test manual: simular caso LA-0543 con datos reales

### Pre-H-03 (enriquecer)
- Query vuelos con airline="Unknown": verificar que son genuinamente desconocidos
- No requiere preparacion de datos

### Pre-H-08 (ETD protect)
- Revisar Step 2 matches historicos en logs para verificar que el ETD overwrite no fue beneficioso en algun caso real

### Pre-H-02 (dedup FS)
- **CRITICO**: Verificar que existe indice `airfreight_flights.flight_number` en Firestore
- Si no existe: crearlo ANTES del deploy (`firebase firestore:indexes`)
- Verificar vuelos con flight_number inconsistente (con/sin hyphen)

### Pre-H-09 (ambiguo)
- Query Firestore: buscar pares de vuelos con mismo `flightMatchKey` en el mismo mes
- Analizar cuales son duplicados y cuales son vuelos recurrentes

### Pre-H-04 (PENDING clean)
- Listar todos los vuelos PENDING y sus bookings
- Verificar que ningun vuelo PENDING tiene entidades dependientes (doc_receptions, billing, ULDs)
- Confirmar que `created_by = 'sheet_sync_agent'` esta seteado en todos los vuelos/bookings PENDING creados por el agente

### Pre-H-10 (next month tab)
- **CRITICO**: Diseñar y validar la estrategia de snapshot multi-tab antes de escribir codigo
- Test manual: leer pestaña de junio, verificar datos parseados correctamente
- Verificar que no hay AWBs duplicadas entre pestañas MAY y JUNE
- Definir comportamiento cuando un AWB aparece en ambas pestañas

## 3.3 Validaciones post-deploy por fase

### Post-H-07 + H-05 (Fase 1)
- Verificar que `_sheet_sync_flight_audit` recibe documentos en cada ciclo
- Verificar que vuelos con dispatched_at son excluidos del matching
- **Metricas**:
  - Cantidad de vuelos creados por ciclo (debe ser 0 si no hay datos nuevos)
  - Cantidad de alerts "dispatched_change" generadas
  - Duracion del ciclo (no debe aumentar significativamente)

### Post-H-01 + H-03 + H-08 (Fase 2)
- Verificar que monthKey en logs muestra el mes del ETD, no el mes actual
- Verificar que vuelos con airline="Unknown" se actualizan si AWBs posteriores tienen datos
- Verificar que ETD no se sobreescribe via Step 2 en vuelos con AWBs
- **Metricas**:
  - Vuelos creados vs reutilizados (ratio)
  - Airlines "Unknown" en vuelos nuevos (debe ser 0 o cerca)
  - Step 2 matches (cuantos, cual fue el ETD delta)

### Post-H-02 + H-09 (Fase 3)
- Verificar que la query Firestore pre-creacion funciona
- Verificar que vuelos compartidos entre clientes se reutilizan
- Verificar logs de desambiguacion
- **Metricas**:
  - Vuelos duplicados creados (debe ser 0)
  - Latencia del ciclo (extra query no debe causar timeout)

### Post-H-04 (Fase 4)
- Verificar que bookings PENDING vacios se eliminan
- Verificar que vuelos PENDING sin bookings se eliminan
- Verificar que NO se eliminan vuelos/bookings con AWBs
- **Metricas**:
  - PENDING vuelos/bookings eliminados por ciclo
  - 0 eliminaciones de vuelos con AWBs (critico)

### Post-H-10 (Fase 5)
- Verificar que ambas pestañas se leen
- Verificar que snapshots son independientes por pestaña
- Verificar que NO hay duplicacion al cambio de mes
- **Metricas**:
  - Filas leidas por pestaña
  - newRows vs changedRows por pestaña
  - 0 duplicados cross-tab

## 3.4 Logs criticos que deben activarse (H-07)

| Evento | Campos a loggear | Nivel |
|--------|-----------------|-------|
| Vuelo creado | flight_number, airline, etd, dest, trigger_awb, step (Step1/2/create), deliverTo_raw, client_id | WARN |
| Step 2 usado | target_flight_id, original_etd, new_etd, candidates_count, trigger_awb | WARN |
| airline "Unknown" | flight_id, flight_number, awb, deliverTo_raw, reason | WARN |
| Airline enriquecida (H-03) | flight_id, old_airline, new_airline, trigger_awb | INFO |
| ETD overwrite bloqueado (H-08) | flight_id, current_etd, requested_etd, booking_count | WARN |
| Step 2 ambiguo (H-09) | candidates (id, etd), selected_id, selection_reason | WARN |
| PENDING limpiado (H-04) | flight_id, booking_id, reason | INFO |
| Dedup Firestore hit (H-02) | flight_id, flight_number, source (firestore_query) | INFO |
| Tab leida (H-10) | tab_title, row_count, month_key | INFO |
| isFlightBlocked by dispatched_at (H-05) | flight_id, dispatched_at, status, flight_status | INFO |

---

# PARTE 4: PROPUESTA DE IMPLEMENTACION SEGURA

---

## 4.1 Orden de fases y justificacion

### FASE 1: Observabilidad + Seguridad basica (H-07 + H-05)
**Por que primero**: H-07 es zero-risk y nos da visibilidad para validar las fases siguientes. H-05 es 1 linea con riesgo minimo. Juntas establecen la base de monitoreo.
**Riesgo**: NINGUNO (H-07) + MINIMO (H-05)
**Rollback**: Revertir 1 linea (H-05) o quitar writes de audit (H-07)
**Pruebas**: T-U04 (isFlightBlocked), verificar logs
**Checkpoint**: Correr 3-5 ciclos del agente, verificar logs en `_sheet_sync_flight_audit`

### FASE 2: Correccion de matching (H-01 + H-03 + H-08)
**Por que segundo**: H-01 es el fix CRITICO que resuelve la causa raiz de los duplicados. H-03 y H-08 son mejoras de calidad de datos que se implementan en los mismos puntos del codigo que H-01. Hacerlas juntas minimiza conflictos.
**Riesgo**: BAJO (H-01 con fallback) + BAJO (H-03) + BAJO (H-08)
**Rollback**: Revertir monthKey a `now.slice(0,7)`, quitar enrichment y ETD check
**Pruebas**: T-U09, T-I-01, T-I-02, T-I-05, T-I-06, T-I-07, T-I-09
**Checkpoint**: Correr con datos reales de Express Line (tab JUNE 2026), verificar que:
  - 0 vuelos duplicados creados
  - monthKey en logs muestra mes del ETD
  - Airlines se enriquecen correctamente
  - ETD no se sobreescribe en vuelos con AWBs

**NOTA CRITICA SOBRE H-01**: No aplicar el cambio a la linea 3173 (PENDING flight search). Esa linea usa monthKey para buscar vuelos PENDING del mes operativo, que es logicamente el mes actual, no el mes del ETD.

### FASE 3: Dedup robusto (H-02 + H-09)
**Por que tercero**: Requiere H-01 funcionando (monthKey correcto para filtrar resultados de Firestore). H-09 depende de H-07 para logging de ambiguedad.
**Riesgo**: BAJO (H-02) + MEDIO (H-09, requiere logica de distancia de fecha)
**Rollback**: Quitar query Firestore pre-creacion y logica de desambiguacion
**Pruebas**: T-I-11, T-I-02 variante, regresion T-R01-T-R13
**Pre-requisito**: Verificar indice `flight_number` en Firestore
**Checkpoint**: Correr 24h, verificar que:
  - Dedup Firestore previene duplicados cross-client
  - Desambiguacion escoge vuelo correcto
  - 0 vuelos huerfanos nuevos

### FASE 4: Limpieza (H-04)
**Por que cuarto**: Solo tiene sentido despues de que los fixes anteriores esten validados. Limpiar PENDINGs sin fijar la causa raiz generaria un ciclo de crear-limpiar-crear.
**Riesgo**: BAJO con verificaciones estrictas
**Rollback**: Quitar logica de limpieza (los PENDINGs vacios persisten pero no causan daño)
**Pruebas**: T-I-10, T-I-03, verificar que NO se borran entidades con AWBs
**Pre-requisito**: H-01 + H-02 funcionando (no se crean PENDINGs nuevos innecesariamente)
**Checkpoint**: Correr 48h, verificar que:
  - PENDINGs vacios se limpian
  - 0 bookings con AWBs eliminados
  - 0 vuelos con dependencias eliminados

### FASE 5: Multi-tab (H-10)
**Por que ultimo**: Es el fix de MAYOR COMPLEJIDAD y MAYOR RIESGO. Requiere rediseño del snapshot y reestructuracion del loop principal. Debe implementarse cuando todo lo demas esta estable.
**Riesgo**: ALTO si snapshot no se rediseña. MEDIO con diseño correcto.
**Rollback**: Revertir a `findMonthTabs` original (solo mes actual)
**Pruebas**: T-I-12, regresion T-R08, T-R13, pruebas de cambio de mes
**Pre-requisito**: Todas las fases anteriores estables. Snapshot strategy validada.
**Checkpoint**: Correr 1 semana incluyendo cambio de mes (mayo→junio), verificar que:
  - Ambas pestañas se leen
  - Snapshots independientes funcionan
  - Cambio de mes no causa duplicacion
  - Performance dentro de timeout

## 4.2 Riesgos por fase y mitigaciones

| Fase | Riesgo principal | Mitigacion |
|------|-----------------|-----------|
| F1 | Ningun riesgo real | Deploy y observar |
| F2 | monthKey con etdDate vacio | Fallback explicito: `(etdDate && etdDate.length >= 7) ? etdDate.slice(0, 7) : now.slice(0, 7)` |
| F2 | H-03 enriquece con basura | Validar: `deliverTo.trim().length >= 2 && /[a-z]/i.test(deliverTo)` |
| F3 | Indice faltante en Firestore | Crear indice ANTES del deploy |
| F3 | H-09 logica de fecha | Implementar con logging verbose para validar decisiones |
| F4 | Borrar booking con AWBs | Triple check: re-read, filter valid lines, only delete if 0 |
| F5 | Duplicacion al cambio de mes | Snapshot per-tab, test de cambio de mes obligatorio |

## 4.3 Checkpoints y criterios de GO/NO-GO

### Despues de F1:
- GO si: logs aparecen correctamente en `_sheet_sync_flight_audit`, isFlightBlocked funciona
- NO-GO si: errores en logging, vuelos incorrectamente bloqueados

### Despues de F2:
- GO si: 0 vuelos duplicados en 24h, monthKey correcto en logs, enrichment funcional
- NO-GO si: cualquier vuelo duplicado, monthKey incorrecto, airline/dest incorrecto

### Despues de F3:
- GO si: 0 duplicados en 48h, dedup Firestore previene creacion, desambiguacion correcta
- NO-GO si: vuelo incorrecto seleccionado, error de indice, timeout

### Despues de F4:
- GO si: PENDINGs vacios limpiados, 0 bookings con AWBs borrados
- NO-GO si: cualquier booking con AWBs borrado (rollback inmediato)

### Despues de F5:
- GO si: ambas tabs procesadas, snapshots independientes, cambio de mes limpio
- NO-GO si: duplicacion al cambio de mes, datos perdidos, timeout

## 4.4 Rollback plan

Cada fase es independiente y puede revertirse sin afectar las demas:

| Fase | Rollback | Tiempo estimado |
|------|----------|----------------|
| F1 | Quitar linea `if (f.dispatched_at) return true` + quitar writes de audit | 1 deploy |
| F2 | Revertir monthKey a `now.slice(0,7)`, quitar enrichment, quitar ETD check | 1 deploy |
| F3 | Quitar query Firestore pre-creacion, quitar logica ambiguedad | 1 deploy |
| F4 | Quitar logica de limpieza PENDING | 1 deploy |
| F5 | Revertir findMonthTabs a solo mes actual, revertir snapshot a `clientId_YYYY-MM` | 1 deploy |

**Rollback de emergencia**: Si cualquier fix causa corrupcion de datos, pausar el agente (Cloud Scheduler → Pause), revertir el codigo, y hacer deploy. Los datos corruptos se corrigen manualmente.

## 4.5 Resumen del hallazgo critico de esta revalidacion

### Hallazgos nuevos vs plan v2:

1. **H-01 NO debe aplicarse a la busqueda de vuelo PENDING (linea 3173)**: El monthKey para PENDING debe seguir siendo `now.slice(0,7)` porque los vuelos PENDING se agrupan por mes operativo, no por ETD.

2. **H-01 requiere fallback explícito cuando etdDate esta vacio**: Sin fallback, `"".slice(0,7) = ""` → `startsWith("")` es siempre TRUE → matchea todos los vuelos.

3. **H-09 (propuesta original) es LOGICAMENTE INCORRECTA**: La busqueda por fecha exacta entre candidatos de Step 2 es redundante con Step 1. Necesita logica de cercania de fecha.

4. **H-05 NO cubre `applyFlightDiffs` (linea 3096-3098)**: Esta funcion tiene su propio check de flight_status que no usa `isFlightBlocked` ni verifica `dispatched_at`. Debe extenderse.

5. **H-10 tiene riesgo CRITICO de duplicacion masiva al cambio de mes** si el snapshot no se rediseña para ser per-tab o per-data-month.

6. **Bug preexistente**: `normalizeFlightNumber` regex `[A-Z]{1,3}` no matchea airlines con digito al inicio (ej: "5X"). No se introduce ni se corrige en este plan, pero se documenta.

7. **Bug preexistente**: `sheetParseDate(0)` devuelve fecha de 1899, sin validacion de año para el path numerico. No se introduce ni se corrige en este plan, pero se documenta.
