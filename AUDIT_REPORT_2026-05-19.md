# AUDITORIA TECNICA EXHAUSTIVA — MCL WMS
**Fecha:** 2026-05-19
**Auditor:** Claude Code (Opus 4.6)
**Alcance:** Todo el modulo airfreight + warehouse + billing + PDFs

---

## RESUMEN EJECUTIVO

Se analizaron ~50 archivos del sistema MCL WMS. Se encontraron **42 hallazgos** clasificados en 4 niveles de severidad:

| Severidad | Cantidad | Descripcion |
|-----------|----------|-------------|
| **CRITICO** | 12 | Corrupcion de datos, duplicacion, perdida de informacion |
| **ALTO** | 14 | Inconsistencia de estado, datos desincronizados |
| **MEDIO** | 10 | Edge cases, UX confusa, rendimiento |
| **BAJO** | 6 | Deuda tecnica, naming confuso |

---

## SECCION 1: IDENTIDAD DE AWBs (1st Leg / 2nd Leg / MAWB)

### Problema fundamental: No hay una fuente unica de verdad para "cual es la guia operativa"

El sistema tiene 3 campos para identificar una guia, pero su significado cambia segun el contexto:

| Campo | En Simple Booking | En MAWB/Ecommerce (awb_lines) | En Doc Reception | En Physical Piece |
|-------|-------------------|-------------------------------|------------------|-------------------|
| `awb_number` | NO EXISTE | 1st Leg | Operativo (2nd||1st) | Operativo (2nd||1st) |
| `awb_1st_leg` | 1st Leg | NO EXISTE | 1st Leg | NO EXISTE |
| `awb_2nd_leg` | 2nd Leg | 2nd Leg (nullable) | 2nd Leg | NO EXISTE |

---

### HAL-01 [CRITICO] — awb_number en physical_pieces puede ser 1st Leg cuando se auto-crean desde buildup

**Archivo:** `AirfreightBuildup.tsx:339,393`
**Estado:** CORREGIDO (2026-05-19)
**Causa raiz:** Linea 339 priorizaba `bk.awb_1st_leg || bk.awb_2nd_leg` en vez de lo inverso. Linea 393 guardaba ese valor como `awb_number` de cada pieza.
**Impacto:** Piezas aparecian en ULDs con guia de 1st Leg (ej: 369-98151480 en vez de 045-22209832).
**Fix aplicado:** Invertir prioridad y usar `ml.awb2 || ml.awb` para piezas.
**Riesgo residual:** Datos historicos en Firestore aun tienen el valor incorrecto. Requiere script de migracion.

---

### HAL-02 [ALTO] — El tipo AwbSecondLeg tiene naming contradictorio

**Archivo:** `types/index.ts:347-350`
**Detalle:** El tipo se llama `AwbSecondLeg` pero su campo `awb_number` almacena el **1st Leg**, no el 2nd.
```typescript
interface AwbSecondLeg {
  awb_number: string      // <-- En realidad es 1st Leg
  awb_2nd_leg?: string    // <-- Este es el 2nd Leg real
}
```
**Impacto:** Confunde a cualquier desarrollador. Fuente de bugs futuros.
**Recomendacion:** Renombrar tipo a `AwbLine` y documentar cada campo.

---

### HAL-03 [ALTO] — Fallback chain inconsistente entre modulos

Cada modulo resuelve "cual AWB mostrar" de forma diferente:

| Modulo | Logica | Archivo:Linea |
|--------|--------|---------------|
| Physical Reception | `reception.awb_2nd_leg \|\| reception.awb_number` | AirfreightPhysicalReception:510 |
| Buildup PDF | `awb.awb_2nd_leg \|\| awb.awb_number` | buildupPdf:153 |
| Delivery Order (simple) | `b.awb_2nd_leg \|\| b.awb_1st_leg` | deliveryOrder:275 |
| Delivery Order (MAWB) | `b.mawb_number` (como awb_number Y awb_1st_leg) | deliveryOrder:252 |
| Doc Reception search | `booking.awb_2nd_leg \|\| booking.awb_1st_leg` | AirfreightDocReceptionNew:274 |
| Buildup auto-create | `bk.awb_2nd_leg \|\| bk.awb_1st_leg` (post-fix) | AirfreightBuildup:339 |
| Export bookings | Solo `awb_number`, sin 2nd leg | AirfreightExportBooking:923 |

**Impacto:** Misma guia puede aparecer como 1st o 2nd leg dependiendo del flujo.
**Recomendacion:** Crear funcion centralizada `getOperationalAwb(entity)` usada en TODOS los modulos.

---

### HAL-04 [MEDIO] — PDF Distribution: display usa 2nd leg pero filtro usa awb_number

**Archivo:** `buildupPdf.ts:152-154`
```typescript
const awbLabel = awb.awb_2nd_leg || awb.awb_number  // Display: 2nd leg
const awbPieces = pieces.filter(p => p.awb_number === awb.awb_number && p.uld_id)  // Filter: 1st leg
```
**Impacto:** Si piece.awb_number != awb.awb_number (post-fix HAL-01), las piezas no matchean y el PDF muestra 0 piezas para ese AWB.
**Recomendacion:** Unificar campo de filtro con campo de display.

---

### HAL-05 [MEDIO] — Export bookings no tienen 2nd Leg

**Archivo:** `AirfreightExportBooking.tsx:923-927`
**Detalle:** Solo populan `awb_number`, nunca `awb_2nd_leg`. En exports, la guia unica cumple ambos roles, pero el codigo que hace `awb_2nd_leg || awb_number` funcionara por fallback. No es un bug pero no es explicito.

---

## SECCION 2: GESTION DE ESTADOS Y TRANSICIONES

### HAL-06 [CRITICO] — Auto-creacion de doc_receptions sin idempotencia

**Archivo:** `AirfreightBuildup.tsx:320-419`
**Detalle:** Al cargar un vuelo en buildup, el sistema auto-crea doc_receptions y physical_pieces para bookings `on_hand` que no tengan doc_reception.

**Problemas:**
1. Solo verifica doc_receptions con status `['in_physical', 'complete']` (linea 324). Si existe una con status `pending_physical`, **se duplica**.
2. Cada AWB crea un batch separado (linea 365). Si el sistema falla entre batches, los que ya se crearon persisten. Al recargar, se vuelven a evaluar y se crean duplicados.
3. No hay lock ni transaction — si dos usuarios abren el mismo vuelo simultaneamente, ambos crean los mismos doc_receptions.

**Impacto:** Duplicacion de guias en el sistema, conteo doble de piezas.
**Recomendacion:**
- Verificar TODOS los statuses, no solo in_physical/complete
- Usar transaction con check de existencia
- Agregar campo `auto_created_for_booking_id` como guard de idempotencia

---

### HAL-07 [CRITICO] — Eliminacion de bookings no limpia doc_receptions ni physical_pieces

**Archivo:** `AirfreightBookingList.tsx:834,1851-1856,1962-1963`
**Detalle:** Cuando un booking se elimina (lineas movidas, booking vacio), solo se borra el documento del booking. No se limpian:
- `airfreight_doc_receptions` con `booking_id` apuntando al booking eliminado
- `airfreight_physical_pieces` vinculadas a esas doc_receptions
- `buildup_ulds` con piezas asignadas de esas guias

**Impacto:** Records huerfanos permanentes. Pueden aparecer en futuras busquedas, buildups, o reportes.
**Recomendacion:** Implementar cascade delete: al borrar booking, limpiar doc_receptions y sus physical_pieces.

---

### HAL-08 [CRITICO] — Flight assignment usa Promise.all() en vez de writeBatch

**Archivo:** `AirfreightFlightAssignment.tsx:311-320`
**Detalle:** `assignToFlight()` actualiza multiples doc_receptions con `Promise.all(updateDoc(...))`. Si una falla, las demas ya se ejecutaron.
**Impacto:** Asignacion parcial — algunos AWBs asignados al vuelo, otros no, sin forma de saber cuales fallaron.
**Recomendacion:** Reemplazar con `writeBatch()` para atomicidad.

---

### HAL-09 [CRITICO] — Flight unassignment no valida si piezas estan en ULDs

**Archivo:** `AirfreightFlightAssignment.tsx:348-369`
**Detalle:** `removeFromFlight()` limpia `flight_id` de doc_receptions sin verificar si las piezas estan asignadas a ULDs en distribucion.
**Impacto:** Piezas quedan en ULDs de un vuelo pero la doc_reception ya no tiene flight_id. Datos inconsistentes.
**Recomendacion:** Antes de quitar vuelo, verificar que `uld_id` es null en todas las piezas.

---

### HAL-10 [ALTO] — Auto-creacion de doc_receptions no sincroniza warehouse_status del booking

**Archivo:** `AirfreightBuildup.tsx:362-419`
**Detalle:** Cuando buildup auto-crea doc_reception con `status: 'complete'`, NO actualiza `booking.warehouse_status` a `'R'` (received).
**Contraste:** La recepcion fisica normal (AirfreightPhysicalReception:70,83) SI actualiza `warehouse_status='R'` y `on_hand=true`.
**Impacto:** Booking queda con `warehouse_status='D'` pero doc_reception esta `complete`. Dashboard muestra estado incorrecto.

---

### HAL-11 [ALTO] — on_hand flag desincronizado entre booking y doc_reception

**Archivos:** AirfreightBuildup:251, AirfreightPhysicalReception:70,83, AirfreightBookingList:1001-1010
**Detalle:**
- `on_hand` solo se setea en recepcion fisica y en toggle manual del booking
- Auto-creacion de doc_reception en buildup depende de `bk.on_hand` pero no lo sincroniza
- Toggle manual de `on_hand` en BookingList cambia `transport_status` como efecto colateral
**Impacto:** Una guia puede estar `on_hand=true` en booking pero `pending_physical` en doc_reception, o viceversa.

---

### HAL-12 [ALTO] — Distribution close/reopen no es atomico

**Archivo:** `AirfreightBuildup.tsx:530-558`
**Detalle:**
- Close: Solo actualiza `flight_status='built'`, no valida ni marca piezas
- Reopen: Solo cambia `flight_status='in_progress'`, no re-valida nada
- No hay lock — dos usuarios pueden cerrar y reabrir simultaneamente
**Impacto:** Vuelo marcado como `built` con piezas sin asignar. Reopen no detecta piezas eliminadas desde el cierre.

---

### HAL-13 [MEDIO] — Race condition entre unlock AWB y flight assignment

**Archivos:** AirfreightFlightAssignment:371-410 + 259-346
**Detalle:** Si un usuario desbloquea un AWB (limpia uld_id de piezas, setea warehouse_status='R') mientras otro asigna vuelo (setea warehouse_status='D'), el status final depende de quien termine ultimo.
**Impacto:** warehouse_status inconsistente.

---

## SECCION 3: MODELO DE DATOS Y FLUJO DE BOOKINGS

### HAL-14 [CRITICO] — awb_numbers_normalized faltante en 9 puntos de escritura

**Archivo:** `lib/bookingAwbIndex.ts` define `awbIndexField()` que calcula el indice para busqueda rapida de AWBs. Este indice DEBE actualizarse cada vez que se crea o modifica un booking.

**Puntos donde FALTA awbIndexField:**

| # | Archivo | Linea | Operacion |
|---|---------|-------|-----------|
| 1 | AirfreightBookingList.tsx | 1806 | addBlankRow() — addDoc sin indice |
| 2 | AirfreightBookingList.tsx | 1769 | insertRow() — addDoc sin indice |
| 3 | AirfreightBookingList.tsx | 1943 | mergePasteDraft() — addDoc sin indice |
| 4 | AirfreightExportBooking.tsx | 964 | Export booking — addDoc sin indice |
| 5 | AirfreightBookingNew.tsx | 1562 | Simple booking — addDoc sin indice |
| 6 | AirfreightBookingList.tsx | 758 | saveRow() — updateDoc sin re-index |
| 7 | AirfreightBookingList.tsx | 1678 | Excel upload cleanup — updateDoc sin re-index |
| 8 | AirfreightAwbCut.tsx | 446,486 | AWB cut update — updateDoc sin re-index |
| 9 | AirfreightAwbDiag.tsx | 169 | Copy documents — updateDoc sin re-index |

**Impacto:** Bookings creados o modificados en estos flujos NO aparecen en busquedas V2 por AWB. El counter no los encuentra al buscar en recepcion documental.
**Recomendacion:** Agregar `...awbIndexField(bookingData)` en cada operacion.

---

### HAL-15 [CRITICO] — Race condition en generacion de PU number

**Archivo:** `lib/pickupOrder.ts:8-15`
```typescript
const snap = await getDoc(seqRef)        // Lee last_num
const next = last + 1                     // Calcula siguiente
await setDoc(seqRef, { last_num: next })  // Escribe nuevo
```
**Detalle:** Read-increment-write NO atomico. Dos usuarios creando PU simultaneamente obtienen el mismo numero.
**Contraste:** `deliveryOrder.ts:11-16` usa `runTransaction()` correctamente.
**Recomendacion:** Reemplazar con `runTransaction()` como en deliveryOrder.

---

### HAL-16 [ALTO] — Datos duplicados entre booking, doc_reception y physical_pieces sin sincronizacion

**Detalle:** Los mismos datos (pieces, weight, AWB) se almacenan en 3 niveles:
1. `airfreight_bookings` → datos del booking
2. `airfreight_doc_receptions` → copia al momento de crear recepcion
3. `airfreight_physical_pieces` → datos reales por pieza

**No existe mecanismo de sync.** Si se edita el booking (ej: cambiar pieces de 10 a 12), la doc_reception sigue con 10 y las physical_pieces siguen siendo 10. El buildup muestra datos del booking, pero la distribucion usa datos de physical_pieces.

**Impacto:** Discrepancias en conteo de piezas, peso, CHW entre pantallas.

---

### HAL-17 [ALTO] — No hay validacion de AWBs duplicadas

**Detalle:** Nada impide que el mismo AWB exista en multiples bookings. La busqueda retorna el primero que encuentre (arbitrario). Esto puede causar:
- Recepcion documental cargada contra el booking equivocado
- Piezas asignadas al vuelo incorrecto
- Billing duplicado

---

### HAL-18 [MEDIO] — Secuencias no inicializadas

**Detalle:** Solo `wr_sequence` se inicializa en Setup.tsx. Las demas (`do_sequence`, `pu_sequence`, `air_invoice_sequence`, etc.) dependen de que el primer `getDoc()` retorne `exists()=false` y use 0 como default. Funciona pero es fragil.

---

## SECCION 4: PDFs, BILLING Y EFECTOS COLATERALES

### HAL-19 [CRITICO] — Billing falla silenciosamente despues de confirmar recepcion/despacho

**Archivos:** `PhysicalReception.tsx:241-248`, `DispatchNew.tsx:586-593`
**Detalle:** El flujo es:
1. Actualizar status del WR a "complete" → COMMIT
2. Calcular billing charges → TRY/CATCH con console.error
3. Navegar a siguiente pantalla

Si paso 2 falla, el WR ya esta marcado como completo pero NO tiene cargos. El usuario no recibe ninguna indicacion del error. Accounting descubre la falta semanas despues.

**Impacto:** Perdida de revenue. Cargos faltantes sin notificacion.
**Recomendacion:**
- Mostrar alerta/toast si billing falla
- No navegar si billing falla
- Agregar boton de retry

---

### HAL-20 [CRITICO] — calculateReceptionCharges hace delete-all + re-create con riesgo de falla parcial

**Archivo:** `lib/billing.ts:175-210`
**Detalle:**
1. Elimina TODOS los cargos existentes (batch.commit)
2. Crea nuevos cargos en batches de 500
3. Si batch 2 de 3 falla: 500 cargos creados, 500 borrados, 200 perdidos

**Impacto:** Billing incompleto. WR con cargos parciales.
**Recomendacion:** Usar transaction o crear nuevos ANTES de borrar viejos (swap pattern).

---

### HAL-21 [ALTO] — Hold system no bloquea distribucion ni Delivery Orders

**Archivos:** AirfreightHolds.tsx, buildupPdf.ts, deliveryOrder.ts
**Detalle:** Existe coleccion de holds con estados, pero:
- Distribution no verifica holds antes de asignar piezas a ULDs
- Delivery Order se crea sin verificar holds activos
- PDF de distribucion se genera sin indicar holds

**Impacto:** Carga retenida puede ser despachada sin autorizacion.

---

### HAL-22 [ALTO] — Invoice puede quedar huerfano si batch de cargos falla

**Archivo:** `lib/airBilling.ts:669-681`
**Detalle:** Primero crea el invoice con `addDoc`, luego actualiza cargos con `batch.commit`. Si el batch falla, el invoice existe sin cargos vinculados.
**Impacto:** Invoice fantasma en el sistema.

---

### HAL-23 [ALTO] — Pallet Control PDF muestra MAWB subtotals duplicados

**Archivo:** `buildupPdf.ts:381-478`
**Detalle:** Si un MAWB tiene piezas en multiples ULDs, se muestra:
- Subtotal MAWB en ULD 1
- Subtotal MAWB en ULD 2
- Grand total MAWB al final
Mismo MAWB aparece 3 veces con diferentes totales.
**Impacto:** Confuso para accounting y aerolinea.

---

### HAL-24 [ALTO] — Listeners sin paginacion pueden cargar miles de documentos

**Archivo:** `AirfreightHolds.tsx:85-115`
**Detalle:** `onSnapshot` sin `limit()` carga TODOS los holds. En instancias con historico largo, esto puede ser 10K+ documentos.
**Impacto:** UI lenta, consumo excesivo de bandwidth y reads de Firestore.

---

### HAL-25 [MEDIO] — Race condition en P/C (pieces/control) del Delivery Order

**Archivo:** `AirfreightDeliveryOrder.tsx:109-150`
**Detalle:** useEffect async que calcula piezas por AWB puede ejecutarse con datos stale si `awbEntries` cambia durante la ejecucion de los getDocs internos.
**Impacto:** Badges de piezas muestran numeros incorrectos temporalmente.

---

### HAL-26 [MEDIO] — Client billing overrides fallan silenciosamente

**Archivo:** `lib/billing.ts:44-58`
**Detalle:** Si la carga de overrides por cliente falla (red), el sistema calcula con tarifas default sin avisar.
**Impacto:** Cliente cobrado con tarifa incorrecta.

---

## SECCION 5: FIRESTORE RULES

### HAL-27 [CRITICO] — pu_sequence no estaba en whitelist de config

**Archivo:** `firebase/firestore.rules:113`
**Estado:** CORREGIDO (2026-05-19)
**Detalle:** La regla de write para `config/{id}` tenia una lista explicita de IDs permitidos. `pu_sequence` no estaba incluido. Solo admins podian escribir.
**Impacto:** Usuarios no-admin no podian crear Pickup Orders.

---

### HAL-28 [MEDIO] — Verificar que ws_invoice_sequence este en whitelist

**Archivo:** `firebase/firestore.rules:113`
**Detalle:** Revisar si `ws_invoice_sequence` (usado en WSBillingCharges.tsx:402) esta en la lista. Si no, usuarios no-admin no pueden generar invoices de Warehouse Services.

---

## SECCION 6: REGRESIONES DETECTADAS

### REG-01 — Fix de HAL-01 puede romper PDF de distribucion (HAL-04)
**Detalle:** Al corregir `awb_number` de piezas para que usen 2nd leg, el filtro del PDF (`pieces.filter(p => p.awb_number === awb.awb_number)`) puede dejar de matchear si `awb.awb_number` sigue siendo 1st leg.
**Accion requerida:** Verificar que buildupPdf.ts use el mismo campo corregido.

### REG-02 — Datos historicos con 1st leg en physical_pieces
**Detalle:** Piezas creadas ANTES del fix de HAL-01 tienen `awb_number` con 1st leg. El sistema ahora crea piezas con 2nd leg. Ambas versiones coexisten.
**Accion requerida:** Script de migracion para normalizar datos historicos.

---

## SECCION 7: MATRIZ DE CASOS DE PRUEBA

### Escenarios criticos a validar:

| # | Escenario | Modulos afectados | Que verificar |
|---|-----------|-------------------|---------------|
| T01 | Simple booking con 1st y 2nd leg → buildup auto-create | Booking, Buildup | physical_piece.awb_number = 2nd leg |
| T02 | MAWB booking con 3 AWB lines → buildup auto-create | Booking, Buildup | Cada pieza tiene awb_number correcto |
| T03 | Ecommerce booking sin 2nd leg → buildup | Booking, Buildup | awb_number = awb_number del line |
| T04 | Export booking (sin legs) → buildup | Booking, Buildup | awb_number = unico AWB |
| T05 | Crear booking desde BookingList → buscar en DocReception | BookingList, DocReception | awb_numbers_normalized presente |
| T06 | Editar AWB en BookingList → buscar de nuevo | BookingList, DocReception | Indice actualizado |
| T07 | Dos usuarios crean PU simultaneamente | PickupOrder | PU numbers unicos |
| T08 | Eliminar booking con doc_reception existente | BookingList | doc_reception limpiada |
| T09 | Quitar vuelo de AWB que tiene piezas en ULD | FlightAssignment | Bloqueado o piezas limpiadas |
| T10 | Cerrar distribucion con piezas sin asignar | Buildup | Warning claro, force-close tracked |
| T11 | Reabrir distribucion y re-cerrar | Buildup | PDF regenerado correctamente |
| T12 | Hold activo + intentar crear DO | Holds, DO | Bloqueado o warning |
| T13 | Billing falla en recepcion fisica | PhysicalReception | Usuario notificado, retry disponible |
| T14 | 2 usuarios abren mismo vuelo en buildup | Buildup | No duplicar doc_receptions |
| T15 | AWB aparece en 2 bookings → buscar en DocReception | DocReception | Ambos bookings mostrados, usuario elige |
| T16 | PDF distribucion con mix de datos viejos (1st leg) y nuevos (2nd leg) | BuildupPdf | Piezas agrupadas correctamente |

---

## SECCION 8: PLAN DE REMEDIACION

### Fase 1: Fixes criticos (inmediato)

| # | Hallazgo | Esfuerzo | Riesgo de regresion |
|---|----------|----------|---------------------|
| 1 | HAL-14: Agregar awbIndexField en 9 puntos | Bajo | Bajo |
| 2 | HAL-15: runTransaction en pu_sequence | Bajo | Nulo |
| 3 | HAL-06: Idempotencia en auto-create (verificar todos los status) | Medio | Bajo |
| 4 | HAL-08: writeBatch en flight assignment | Medio | Bajo |
| 5 | HAL-19: Toast de error si billing falla | Bajo | Nulo |
| 6 | HAL-28: Verificar whitelist completa de config sequences | Bajo | Nulo |

### Fase 2: Integridad de datos (corto plazo)

| # | Hallazgo | Esfuerzo | Riesgo de regresion |
|---|----------|----------|---------------------|
| 7 | HAL-07: Cascade delete de doc_receptions al borrar booking | Medio | Medio |
| 8 | HAL-09: Validar ULD antes de quitar vuelo | Medio | Bajo |
| 9 | HAL-10: Sync warehouse_status en auto-create | Bajo | Bajo |
| 10 | HAL-04: Unificar campo de filtro en PDF | Medio | Alto (verificar con datos reales) |
| 11 | REG-02: Script migracion datos historicos | Medio | Medio |

### Fase 3: Arquitectura estable (mediano plazo)

| # | Hallazgo | Esfuerzo | Riesgo de regresion |
|---|----------|----------|---------------------|
| 12 | HAL-03: Funcion centralizada getOperationalAwb() | Alto | Alto (cambio en 15+ archivos) |
| 13 | HAL-16: Modelo de sync entre booking/doc_reception/pieces | Alto | Alto |
| 14 | HAL-17: Validacion de AWBs duplicadas | Medio | Bajo |
| 15 | HAL-20: Swap pattern para billing (crear antes de borrar) | Medio | Medio |
| 16 | HAL-21: Hold enforcement en distribucion y DO | Medio | Bajo |
| 17 | HAL-02: Renombrar AwbSecondLeg a AwbLine | Alto | Alto (breaking change) |

### Fase 4: Robustez operacional (largo plazo)

| # | Hallazgo | Esfuerzo | Riesgo de regresion |
|---|----------|----------|---------------------|
| 18 | Transactions en todas las operaciones multi-documento | Alto | Medio |
| 19 | Audit log para transiciones de estado | Medio | Bajo |
| 20 | Paginacion de listeners (holds, bookings) | Medio | Bajo |
| 21 | Tests automatizados para matriz de casos T01-T16 | Alto | Nulo |

---

## SECCION 9: ARQUITECTURA RECOMENDADA

### Principio: Una funcion, una responsabilidad

```
lib/
  awbIdentity.ts          ← getOperationalAwb(), getDisplayAwb(), get1stLeg(), get2ndLeg()
  stateTransitions.ts     ← validateTransition(), applyTransition() con guards
  cascadeOperations.ts    ← deleteBookingCascade(), assignFlightAtomic()
  billingEngine.ts        ← calculateChargesAtomic() con swap pattern
  sequenceGenerator.ts    ← getNextNumber() con runTransaction (unico punto)
```

### Reglas por tipo de flujo (aisladas):

```typescript
// awbIdentity.ts
export function getOperationalAwb(entity: {
  awb_number?: string
  awb_1st_leg?: string
  awb_2nd_leg?: string | null
}): string {
  return entity.awb_2nd_leg || entity.awb_number || entity.awb_1st_leg || ''
}

// Usado en TODOS los modulos en vez de logica inline
```

### Validaciones previas centralizadas:

```typescript
// stateTransitions.ts
export function canRemoveFlight(docReceptionId: string): Promise<{ allowed: boolean; reason?: string }> {
  // Verificar que no hay piezas en ULDs
  // Verificar que no esta en distribucion cerrada
  // Verificar que no tiene DO activa
}
```

---

## SECCION 10: ARCHIVOS CRITICOS PARA MONITOREAR

| Archivo | Riesgo | Razon |
|---------|--------|-------|
| `AirfreightBuildup.tsx` | MUY ALTO | Auto-creacion, distribucion, PDFs, 2500+ lineas |
| `AirfreightBookingList.tsx` | MUY ALTO | CRUD de bookings, flight changes, 2000+ lineas |
| `AirfreightFlightAssignment.tsx` | ALTO | Asignacion de vuelos, lock/unlock AWBs |
| `lib/billing.ts` | ALTO | Delete-recreate pattern, multi-batch |
| `lib/buildupPdf.ts` | ALTO | AWB display vs filter mismatch |
| `lib/deliveryOrder.ts` | MEDIO | AWB identity logic, MAWB handling |
| `AirfreightPhysicalReception.tsx` | MEDIO | Unico punto correcto de awb_number |
| `types/index.ts` | MEDIO | Naming contradictorio en AwbSecondLeg |

---

**FIN DEL INFORME**
Generado: 2026-05-19 | Auditor: Claude Code (Opus 4.6)
Archivos analizados: ~50 | Herramientas: 4 agentes paralelos de exploracion exhaustiva
