# MCL WMS - Validacion de No-Regresion del Performance Audit
**Fecha:** 2026-05-18 | **Rol:** Senior Performance Engineer + QA Architect
**Alcance:** 38 hallazgos / 32 acciones propuestas en PERFORMANCE_AUDIT.md

---

## SECCION 1: MATRIZ DE IMPACTO

### Clasificacion de Riesgo por Solucion

| # | Solucion | Riesgo | Modulos Afectados | Tipo de Cambio |
|---|---------|--------|-------------------|----------------|
| 1 | useMemo AuthContext | **BAJO** | TODOS (71 consumers) | Render behavior |
| 2 | Debounce search inputs | **BAJO** | Dashboard, DocReception, DeliveryOrders, BookingList | UX timing |
| 3 | Where/limit en tracking/queue/DOs | **MEDIO** | WS Delivery, Driver Queue, Airfreight DOs | Data filtering |
| 4 | Singleton window.open impresion | **BAJO** | Buildup labels, DO print, Booking print | Print flow |
| 5 | Revocar blob URLs | **BAJO** | AirfreightDeliveryOrder | Memory management |
| 6 | ErrorBoundary | **BAJO** | App-level wrapper | Error display |
| 7 | Fix window.print popup | **BAJO** | AirfreightBookingNew | Print auto-trigger |
| 8 | Where clause DocReceptionNew AWB search | **ALTO** | Recepcion documental, Flight Assignment | Query results |
| 9 | Cache Add AWB modal | **BAJO** | AirfreightDeliveryOrder | Data freshness |
| 10 | Memoizar loadClient billing | **BAJO** | Air Billing, WS Billing | Calculation cache |
| 11 | Refactorizar Inventory N+1 | **ALTO** | Inventory, Seafreight, Billing | Data model |
| 12 | Refactorizar Buildup N+1 | **MEDIO** | Build-up, Distribucion | Query pattern |
| 13 | Where clauses Billing/KPI | **MEDIO** | BillingCharges, KpiDashboard, BillingSummary | Data scope |
| 14 | Separar nested onSnapshot | **ALTO** | Dashboard, Screening, BookingList, Transportation | Real-time sync |
| 15 | Indices compuestos | **BAJO** | Firebase Console (no code) | Query speed |
| 16 | writeBatch addDoc loops | **MEDIO** | Air Billing, WS Billing, PhysicalReception | Write atomicity |
| 17 | client_id filter WSDashboard | **MEDIO** | WS Dashboard | Data visibility |
| 18 | Paginacion tablas | **ALTO** | Inventory, Holds, Billing, Bookings | UX + data display |
| 19 | Cloud Functions billing/KPI | **MUY ALTO** | Billing, KPI, Invoicing | Arquitectura |
| 20 | PDF en Web Worker | **MEDIO** | Buildup PDF, DO PDF, Labels | PDF generation |
| 21 | Dynamic import tesseract.js | **BAJO** | BarcodeScannerModal (Physical Reception) | Load timing |
| 22 | Cache layer datos referencia | **MEDIO** | Rates, Clients, Destinations | Data freshness |
| 23 | Dividir componentes monoliticos | **ALTO** | BookingNew, Buildup, DeliveryOrder, WSOrderDetail | State management |
| 24 | react-window virtualizacion | **MEDIO** | Todas las tablas de datos | Scroll/display |
| 25 | Optimizar Vite manualChunks | **BAJO** | Build output (no runtime) | Bundle splitting |
| 26 | Paralelizar Generate Sets | **MEDIO** | AirfreightDeliveryOrder | Concurrency |
| 27 | React.memo componentes hijo | **BAJO** | Componentes de fila/card | Render optimization |
| 28 | Custom claims Firebase Auth | **MUY ALTO** | Security Rules, Auth, TODOS los modulos | Auth architecture |
| 29 | Remover firebase-admin, @zxing | **BAJO** | package.json | Dependencies |
| 30 | Skeleton screens | **BAJO** | UI cosmetic | Loading states |
| 31 | Archival datos historicos | **ALTO** | Billing, Tracking, Delivery | Data availability |
| 32 | Optimizar logo.png | **BAJO** | Layout | Asset size |

---

## SECCION 2: ANALISIS DETALLADO POR SOLUCION

### FASE 1: Quick Wins

---

#### SOL-1: useMemo en AuthContext value
- **Archivo:** `src/contexts/AuthContext.tsx` L376-389
- **Cambio:** Envolver el objeto `value` del Provider en `useMemo`
- **Modulos tocados:** TODOS — 71 archivos importan `useAuth()`
- **Riesgo de regresion:** BAJO

**Analisis de impacto:**
El value actual tiene 27 propiedades (12 estados + 11 flags derivados + 4 funciones). Hoy, CADA setState en AuthProvider recrea el objeto value, causando re-render en los 71 consumers.

**Riesgo critico identificado:** Los flags derivados (`isAdmin`, `isClient`, `canEdit`, etc.) se calculan en el cuerpo del componente (L113-127), NO dentro de un useMemo. Si envolvemos solo el `value` en useMemo, los flags derivados se recalcularian en cada render del Provider pero el value memoizado NO los propagaria hasta que cambien las dependencias del useMemo.

**Escenario de regresion:**
1. Usuario hace login -> `userRole` cambia a 'admin'
2. `isAdmin` se recalcula a `true` (correcto)
3. Si el useMemo depende de `[userRole, ...]` y no incluye los flags derivados, funciona BIEN
4. PERO si alguien agrega un nuevo flag derivado y olvida agregarlo al useMemo, ese flag se congelaria

**Mitigacion:**
```typescript
// CORRECTO - los flags derivados deben calcularse DENTRO del useMemo
const value = useMemo(() => {
  const isAdmin = userRole === 'admin'
  const isClient = userRole === 'client'
  // ... todos los flags derivados aqui
  return {
    user, loading, gmailToken, userRole, moduleAccess, clientId,
    mustChangePassword, clearMustChangePassword,
    isAdmin, isAccounting, isSuperAgent, isAgent, isBilling, canEdit, canViewCharges,
    isClient, isCounter, isBodega, isViewer, isVendorAdmin, vendorId,
    hasSeaAccess, hasAirAccess, hasWarehouseAccess, isEcommerceClient,
    signInWithGoogle, signInWithEmail, createClientAccount,
    resetPassword, changePassword, signOut, refreshGmailToken,
  }
}, [user, loading, gmailToken, userRole, moduleAccess, clientId,
    mustChangePassword, canViewChargesFlag, isEcommerceClient, vendorId])
```

**ADVERTENCIA:** Las funciones (`signOut`, `signInWithGoogle`, etc.) deben envolverse en `useCallback` primero, o el useMemo se invalidara en cada render porque las funciones se recrean. Sin useCallback en las funciones, el useMemo no tendra ningun efecto.

**Dependencias a verificar:**
- `signOut` (L283-291): usa closure sobre `user` — necesita useCallback con [user]
- `signInWithGoogle` (L233): solo usa `auth` y `db` (estables) — useCallback con []
- `signInWithEmail` (L252): idem — useCallback con []
- `createClientAccount` (L262): idem — useCallback con []
- `resetPassword`, `changePassword`: idem
- `refreshGmailToken` (L316): usa `user` — useCallback con [user]
- `clearMustChangePassword`: usa `user` — useCallback con [user]

**Componentes que dependen de re-renders del AuthContext para funcionar:**
- `Login.tsx`: usa `user` para redirect — OK, `user` esta en deps del useMemo
- `App.tsx`: usa `loading`, `user`, role flags para routing — OK
- `Layout.tsx`: usa `isAdmin`, `isClient` para menu visibility — OK si flags en deps
- Todos los modulos: usan `isClient && clientId` para filtrar queries — OK

**Veredicto:** SEGURO si se implementa correctamente (flags dentro del useMemo + useCallback en funciones).

**Tests obligatorios:**
- [ ] Login/logout flow completo
- [ ] Cambio de rol via admin panel
- [ ] Navegacion entre modulos (sea/air/ws)
- [ ] Vista de cliente vs admin
- [ ] Auto-logout por inactividad (L346-373)

---

#### SOL-2: Debounce en search inputs
- **Archivos:** AirfreightDashboard, DocReceptionList, DeliveryOrders, BookingList
- **Cambio:** Agregar debounce de 300ms a inputs de busqueda
- **Riesgo de regresion:** BAJO

**Analisis:**
El debounce solo retrasa la ejecucion del filtro. No cambia resultados, solo timing. `es-toolkit` ya esta instalado pero no usado.

**Riesgo oculto:** Si un input de busqueda tiene un `useEffect` que dispara un query de Firestore y el debounce se aplica al state pero no al query, se puede producir un flash de resultados intermedios.

**Patron correcto:**
```typescript
const [searchInput, setSearchInput] = useState('')  // UI inmediato
const debouncedSearch = useDebounce(searchInput, 300) // query retrasado
// Usar debouncedSearch en el useEffect/query, searchInput en el input
```

**Modulos que NO deben debouncearse:**
- `MobileEditDO.tsx`: busqueda manual con boton (ya OK, no necesita debounce)
- Cualquier input que dispare una accion (no busqueda) como asignar vuelo

**Tests obligatorios:**
- [ ] Escribir rapido en busqueda — resultado final correcto
- [ ] Borrar campo — resultados se resetean
- [ ] Busqueda con caracteres especiales

---

#### SOL-3: Where/limit en ws_delivery_tracking, driver_queue, delivery_orders
- **Archivos:** WSDeliveryOrders.tsx L36, AirfreightDriverQueue.tsx, AirfreightDeliveryOrders.tsx
- **Cambio:** Agregar filtros de fecha y limit a queries que hoy hacen full scan
- **Riesgo de regresion:** **MEDIO**

**Riesgo critico: DATOS INVISIBLES**
Si se agrega `where('created_at', '>=', thirtyDaysAgo)`, todos los registros anteriores a 30 dias desaparecen de la UI. Esto es problematico si:
- Un DO viejo aun esta activo/pendiente
- Un tracking de hace 2 meses tiene un estado que aun se necesita
- El usuario busca un registro historico

**Escenarios de regresion:**
1. **WS Delivery Tracking:** Si se filtra por fecha, trackings antiguos con `status: 'in_transit'` (conductor aun no entrego) desaparecerian
2. **Driver Queue:** Conductores en espera desde hace tiempo quedarian invisibles
3. **Delivery Orders:** DOs pendientes de hace semanas no aparecerian

**Mitigacion:**
- Filtrar por `status != 'completed'` O `created_at >= 30d ago` (union, no interseccion)
- Agregar un toggle "Ver historicos" que elimine el filtro de fecha
- Usar `limit()` con paginacion, no como truncamiento silencioso

**INDICE REQUERIDO:** Para `ws_delivery_tracking` con where('created_at') necesita indice compuesto si se combina con orderBy.

**Tests obligatorios:**
- [ ] Verificar que DOs/trackings activos antiguos siguen visibles
- [ ] Verificar que la busqueda funciona con filtros
- [ ] Verificar paginacion (si aplica)
- [ ] Verificar que conductores en cola siguen apareciendo

---

#### SOL-4: Singleton window.open para impresion
- **Archivos:** AirfreightDeliveryOrder.tsx, AirfreightBuildup.tsx, printLabels.ts
- **Cambio:** Consolidar multiples window.open en una sola ventana
- **Riesgo de regresion:** BAJO

**Riesgo:** Si el singleton reutiliza la misma ventana y el usuario intenta imprimir un segundo documento antes de cerrar, el primer documento se sobrescribe.

**Mitigacion:**
- El singleton debe verificar si la ventana esta cerrada (`win.closed`) antes de reutilizar
- Si la ventana esta abierta con otro contenido, o crear nueva o esperar

**Tests obligatorios:**
- [ ] Imprimir labels de una recepcion — OK
- [ ] Imprimir labels de otra recepcion inmediatamente — no pierde primera
- [ ] Imprimir DO PDF + labels simultaneamente
- [ ] Test en Chrome y Edge (Windows)

---

#### SOL-5: Revocar blob URLs en Generate Sets
- **Archivo:** AirfreightDeliveryOrder.tsx L598, L658-791
- **Cambio:** `URL.revokeObjectURL()` antes de regenerar + cleanup en useEffect return
- **Riesgo de regresion:** BAJO

**Riesgo oculto:** Si se revoca un blob URL que el usuario tiene abierto en otra pestana (via window.open), esa pestana mostrara error. Pero el flujo actual ya sobrescribe el Map, asi que los URLs viejos ya se pierden — revocar antes solo libera memoria mas temprano.

**Mitigacion:** Revocar ANTES de generar nuevos, no despues. El cleanup en unmount es seguro.

**Tests obligatorios:**
- [ ] Generate Sets → ver PDF → regenerar → ver nuevo PDF
- [ ] Generate Sets → abrir PDF en nueva pestana → regenerar → pestana vieja sigue visible (o muestra error esperado)
- [ ] Navegar fuera de la pagina → no memory leak

---

#### SOL-6: ErrorBoundary a nivel de rutas
- **Archivo:** App.tsx
- **Cambio:** Envolver rutas lazy-loaded en ErrorBoundary
- **Riesgo de regresion:** BAJO (solo agrega proteccion, no cambia funcionalidad)

**Riesgo:** Si el ErrorBoundary captura errores que hoy causan retry (por ejemplo, un chunk de lazy load que falla y el browser reintenta), podria mostrar error en vez de reintentar.

**Mitigacion:** El fallback del ErrorBoundary debe incluir boton "Reintentar" que haga `window.location.reload()`.

**Tests obligatorios:**
- [ ] Navegacion normal entre todas las rutas
- [ ] Forzar error de render — debe mostrar fallback, no pantalla blanca
- [ ] El boton "Reintentar" recupera la app

---

#### SOL-7: Fix window.print en BookingNew popup
- **Archivo:** AirfreightBookingNew.tsx L2233
- **Cambio:** Cambiar `window.addEventListener` a `win.addEventListener` (referencia del popup)
- **Riesgo de regresion:** BAJO

**Analisis:** Hoy el print nunca se dispara automaticamente (es un bug). Arreglarlo solo agrega funcionalidad que falta.

**Tests obligatorios:**
- [ ] Crear booking → preview PDF → print dialog aparece automaticamente
- [ ] Print dialog se puede cancelar sin efectos

---

#### SOL-8: Where clause en DocReceptionNew AWB search
- **Archivo:** AirfreightDocReceptionNew.tsx L236 y L219
- **Cambio:** Reemplazar full scan de `airfreight_bookings` y `airfreight_doc_receptions` por queries con where
- **Riesgo de regresion:** **ALTO**

**ESTE ES EL CAMBIO MAS PELIGROSO DE LA FASE 1**

**Contexto actual:** La busqueda de AWB hace:
1. `getDocs(collection(db, 'airfreight_bookings'))` — TODAS las bookings
2. Filtra client-side por AWB number normalizado contra `awb_1st_leg`, `awb_2nd_leg`, `awb_lines[].awb_number`, `awb_lines[].awb_2nd_leg`

**Problema con where clause:**
- El AWB se busca en 4 campos diferentes (1st leg, 2nd leg, y dentro de arrays)
- Firestore NO soporta `where` en campos de array de objetos (`awb_lines[].awb_number`)
- No se puede hacer `where('awb_2nd_leg', '==', awb)` sin indice por cada campo
- La normalizacion (`replace(/[^A-Z0-9]/gi, '')`) es client-side — Firestore no soporta regex en where

**Escenarios de regresion:**
1. AWB en `awb_1st_leg` no se encuentra si solo se busca en `awb_2nd_leg`
2. AWB dentro de `awb_lines` (ecommerce/mawb) no se encuentra con where simple
3. AWBs con formatos diferentes (con guion vs sin guion) no matchean con where exacto
4. Bookings sin booking donde el AWB se escribio de forma no estandar

**Alternativa segura:**
En vez de where en bookings (imposible por la estructura), la optimizacion debe ser:
- **Bookings:** Cache local (cargar una vez al montar, no en cada busqueda) o indexar AWBs en un campo plano `awb_numbers: ['0452185963', '1234567890']` (array normalizado) y usar `array-contains`
- **Doc Receptions:** where('awb_number', '==', normalizedAwb) — ESTE SI es seguro porque el campo es plano

**RECOMENDACION: NO implementar where en bookings sin crear campo de indice primero. Implementar cache en su lugar.**

**Tests obligatorios (si se implementa):**
- [ ] Buscar AWB de booking simple → encontrado
- [ ] Buscar AWB 1st leg de booking mawb → encontrado
- [ ] Buscar AWB 2nd leg de booking ecommerce (dentro de awb_lines) → encontrado
- [ ] Buscar AWB con guion (045-21859633) → encontrado
- [ ] Buscar AWB sin guion (04521859633) → encontrado
- [ ] Buscar AWB de booking sin flight asignado → encontrado
- [ ] Buscar AWB inexistente → no encontrado (no error)
- [ ] Buscar AWB parcial → comportamiento esperado
- [ ] Test con 500+ bookings en produccion

---

#### SOL-9: Cache resultados Add AWB modal
- **Archivo:** AirfreightDeliveryOrder.tsx L811-816
- **Cambio:** Cachear resultados de las 4 queries paralelas entre aperturas del modal
- **Riesgo de regresion:** BAJO

**Riesgo:** Si el cache persiste y un usuario crea una nueva booking, luego abre el modal, la nueva booking no aparece.

**Mitigacion:**
- Cache con TTL de 30-60 segundos
- Invalidar cache si se navega fuera y vuelve
- Boton "Refrescar" en el modal

**Tests obligatorios:**
- [ ] Abrir modal → cerrar → abrir — datos presentes sin delay
- [ ] Crear booking → abrir modal — booking aparece (con o sin refresh)
- [ ] Asignar AWB → modal siguiente muestra data actualizada

---

#### SOL-10: Memoizar loadClient en billing loops
- **Archivo:** airBilling.ts L514-531
- **Cambio:** Crear cache Map<clientId, ClientData> antes del loop
- **Riesgo de regresion:** BAJO

**Analisis:** La funcion `calculateAirfreightCharges` se llama en loop para cada AWB line. Hoy hace `getDoc(airfreight_clients, clientId)` cada vez — siempre el mismo documento. Memoizar es seguro porque los datos del cliente no cambian durante una sola operacion de billing.

**Riesgo:** Ninguno — la informacion del cliente es de lectura y no muta durante el calculo.

**Implementacion segura:**
```typescript
const clientCache = new Map<string, AirfreightClient>()
async function loadClientCached(clientId: string) {
  if (clientCache.has(clientId)) return clientCache.get(clientId)!
  const snap = await getDoc(doc(db, 'airfreight_clients', clientId))
  const client = snap.exists() ? { id: snap.id, ...snap.data() } as AirfreightClient : null
  if (client) clientCache.set(clientId, client)
  return client
}
```

**Tests obligatorios:**
- [ ] Recalcular charges de vuelo con 1 cliente, 50 bookings — resultado identico
- [ ] Recalcular charges de vuelo con multiples clientes — cada uno con su rate correcta
- [ ] Generar invoice — montos correctos

---

### FASE 2: Query Optimization

---

#### SOL-11: Refactorizar Inventory N+1
- **Archivo:** Inventory.tsx L103-171
- **Cambio:** Denormalizar subcollections (lines, sku_lines) o usar Cloud Function pre-agregada
- **Riesgo de regresion:** **ALTO**

**Analisis del flujo actual:**
1. Query WRs con `physical_status == 'complete'` + limit(1000)
2. Para cada WR: `getDocs(lines)` + `getDocs(sku_lines)` en paralelo (Promise.all por WR)
3. Para WRs sin consignee inline: `getDoc(consignees/{id})`
4. Separadamente: carga `client_billing_config` por cada client_id unico
5. Separadamente: carga `inventory_documents` para semaforo

**Opcion A - Denormalizar:** Copiar datos de lines/sku_lines al documento WR principal.
- **PELIGRO:** Las lines se editan independientemente en PhysicalReception.tsx y DispatchNew.tsx. Si se denormalizan, CADA edicion de una line debe actualizar tambien el documento WR principal. Esto requiere cambiar:
  - PhysicalReception.tsx (add/edit lines)
  - DispatchNew.tsx (marcar lines como dispatched)
  - DispatchCorrection.tsx (corregir dispatch)
  - Dashboard.tsx (delete WR — ya borra lines subcollection)
  - Cualquier futuro codigo que toque lines

- **RIESGO DE INCONSISTENCIA:** Si el update del WR falla pero el update de la line tiene exito (o viceversa), los datos quedan inconsistentes. Requiere transaction o writeBatch para atomicidad.

**Opcion B - Cloud Function:** onWrite trigger en lines subcollection que actualiza un campo `line_summary` en el WR.
- **MEJOR OPCION** pero requiere infraestructura de Cloud Functions que no existe.

**Opcion C - Cache + Pagination:** Mantener el N+1 pero con pagination (50 WRs por pagina) y cache de resultados.
- **OPCION MAS SEGURA** a corto plazo.

**Modulos que se rompen si la estructura de lines cambia:**
| Modulo | Archivo | Uso de lines |
|--------|---------|-------------|
| Physical Reception | PhysicalReception.tsx | Add/edit/delete lines |
| Dispatch | DispatchNew.tsx | Select lines para dispatch |
| Dispatch Correction | DispatchCorrection.tsx | Corregir dispatch |
| WR Print | WRPrint.tsx | Render lines en PDF |
| Inventory | Inventory.tsx | Display + export |
| Inventory Docs | InventoryDocuments.tsx | Reference lines |
| Dashboard | Dashboard.tsx | Delete WR + lines |
| Billing | billing.ts | Calculate charges basado en lines |

**RECOMENDACION: Implementar Opcion C (pagination + cache) primero. Opcion A/B solo con plan de migracion completo.**

**Tests obligatorios:**
- [ ] Inventory carga correctamente con WRs recientes
- [ ] Filtros por cliente, status, pais funcionan
- [ ] Export a Excel genera datos correctos
- [ ] Lines se muestran en el detalle expandido
- [ ] SKU lines se muestran si existen
- [ ] Consignee names se resuelven
- [ ] Free storage days se calculan correctamente
- [ ] Semaforo de documentos funciona

---

#### SOL-12: Refactorizar Buildup N+1
- **Archivo:** AirfreightBuildup.tsx L299-303
- **Cambio:** Reemplazar loop secuencial `for...of getDocs` por `Promise.all` o operador `in`
- **Riesgo de regresion:** MEDIO

**Analisis:** Hoy el codigo hace:
```typescript
for (const rec of receptions) {
  const piecesSnap = await getDocs(query(
    collection(db, 'airfreight_physical_pieces'),
    where('doc_reception_id', '==', rec.id)
  ))
  // ... process pieces
}
```

**Opcion A - Promise.all:** Ejecutar todas las queries en paralelo.
- Seguro — mismos resultados, solo mas rapido
- **Riesgo:** Si hay 20+ recepciones, 20 queries paralelas podrian saturar la cuota de Firestore momentaneamente

**Opcion B - Operador `in`:** `where('doc_reception_id', 'in', receptionIds)` (max 30 por query Firestore).
- Reduce de N queries a ceil(N/30) queries
- **RIESGO:** El orden de los resultados puede no coincidir — necesita re-agrupar por doc_reception_id client-side

**Mitigacion:** Promise.all es la opcion mas segura. Solo cambia timing, no resultados.

**Tests obligatorios:**
- [ ] Seleccionar vuelo con 1 recepcion → piezas correctas
- [ ] Seleccionar vuelo con 5+ recepciones → todas las piezas visibles
- [ ] Distribuir piezas a ULD → asignacion correcta
- [ ] Weights y piece counts coinciden con recepcion fisica

---

#### SOL-13: Where clauses en BillingCharges, KpiDashboard, BillingSummary
- **Archivos:** AirfreightBillingCharges.tsx L136, WSKpiDashboard.tsx L116-118, AirfreightBillingSummary.tsx L167
- **Cambio:** Agregar filtros de fecha a queries que hoy cargan colecciones completas
- **Riesgo de regresion:** MEDIO

**Riesgo: DATOS FALTANTES EN KPIs**
- WSKpiDashboard calcula metricas agregadas. Si se filtra por fecha, los KPIs no reflejan el total historico.
- BillingCharges: si se filtra por fecha, charges de periodos anteriores no aparecen.

**Escenarios de regresion:**
1. KPI "Total WRs recibidos" muestra 30 en vez de 1,500 (solo ultimo mes)
2. Billing: charges pendientes de hace 2 meses no aparecen para facturar
3. Summary: resumen de vuelo no muestra charges de semanas anteriores

**Mitigacion:**
- KPI: Agregar selector de periodo con default "ultimo mes" pero opcion "todo"
- Billing: NUNCA filtrar por fecha — filtrar por `status: 'pending'` (charges pendientes de cobrar)
- Summary: Filtrar por `flight_id` (ya existe) no por fecha

**Tests obligatorios:**
- [ ] KPIs muestran valores correctos con filtro de periodo
- [ ] BillingCharges: charges pendientes siempre visibles
- [ ] BillingSummary: totales por vuelo correctos
- [ ] Cambiar periodo de KPI — valores actualizan correctamente

---

#### SOL-14: Separar nested onSnapshot
- **Archivos:** AirfreightDashboard.tsx L237-252, AirfreightScreening.tsx L126-165, AirfreightBookingList.tsx L282
- **Cambio:** Convertir listeners anidados (flights → bookings) en listeners independientes
- **Riesgo de regresion:** **ALTO**

**Analisis del patron actual (Dashboard):**
```
onSnapshot(flights) → {
  procesa flights
  onSnapshot(bookings) → {
    combina flights + bookings
    setFlights(combinado)
  }
}
```
El listener de bookings se recrea CADA vez que el listener de flights dispara. El cleanup del inner listener se hace correctamente (L250: `if (unsubBookings) unsubBookings()`).

**Patron propuesto (listeners independientes):**
```
onSnapshot(flights) → setFlightDocs(...)
onSnapshot(bookings) → setBookingDocs(...)
// useEffect/useMemo combina ambos
const combined = useMemo(() => combine(flightDocs, bookingDocs), [flightDocs, bookingDocs])
```

**Riesgos criticos:**
1. **FLASH DE ESTADO INCOMPLETO:** Si flights actualiza primero y bookings aun tiene datos viejos, hay un frame donde el combinado es inconsistente. Con nested, ambos se procesan atomicamente.
2. **TIMING DE MONTAJE:** Si bookings llega antes que flights (race condition), el combinado puede tener bookings sin flights.
3. **ORDEN DE RENDERIZADO:** Con nested, el state solo se setea una vez (al final). Con separados, se setea 2 veces — un render con flights sin bookings, otro con ambos.

**Mitigacion:**
- Usar un flag `bothLoaded` que solo setea el state combinado cuando ambos listeners han emitido al menos una vez
- O mantener el nested pattern pero agregar cleanup mas robusto

**Caso especial: AirfreightScreening.tsx**
El nested listener aqui es mas problematico porque el inner listener filtra por `flight_id` que viene del outer. Si se separa, se necesita escuchar TODAS las bookings y filtrar client-side, lo que es peor en reads.

**RECOMENDACION: Mantener nested en Dashboard y Screening (el cleanup actual funciona). Solo separar en BookingList donde el inner listener NO depende del outer.**

**Tests obligatorios:**
- [ ] Dashboard: datos aparecen completos (flights + bookings combinados)
- [ ] Dashboard: crear booking → aparece en tiempo real
- [ ] Dashboard: cambiar filtro de fecha → datos actualizan
- [ ] Screening: lista muestra todos los AWBs con status correcto
- [ ] BookingList: bookings aparecen con datos de flight
- [ ] Navigation rapida entre paginas → no listener leak (verificar en DevTools)

---

#### SOL-15: Indices compuestos Firestore
- **Cambio:** Crear indices en Firebase Console
- **Riesgo de regresion:** **BAJO** (solo mejora velocidad, no cambia resultados)

**Advertencia:** Indices no usados consumen almacenamiento de Firestore. Solo crear los que realmente se necesitan.

**Los 11 indices propuestos y su validacion:**

| Indice | Coleccion | Campos | Validado |
|--------|----------|--------|----------|
| 1 | rate_schedule | billing_event + active | SI - billing.ts L32 |
| 2 | airfreight_bookings | flight_id + client_id | SI - airBilling.ts L509-510 |
| 3 | delivery_orders | booking_id + awb_index | SI - deliveryOrder.ts L146 |
| 4 | airfreight_bookings | flight_id + status | SI - multiple places |
| 5 | air_billing_charges | client_id + flight_id | SI - airBilling.ts |
| 6 | air_billing_charges | flight_id + source + status | SI - airBilling.ts L465-470 |
| 7 | air_billing_charges | booking_id + source + status | SI - airBilling.ts L428-433 |
| 8 | billing_charges | wr_id + billing_event | SI - billing.ts |
| 9 | billing_charges | client_id + created_at | SI - BillingCharges.tsx |
| 10 | ws_billing_charges | so_id | SI - WSOrderDetail.tsx L262 |
| 11 | airfreight_holds | client_id | SI - AirfreightHolds.tsx |

**Tests:** Verificar que las queries existentes no fallen con los nuevos indices (no deberia — indices adicionales son transparentes).

---

#### SOL-16: writeBatch para addDoc loops
- **Archivos:** airBilling.ts L279-282, billing.ts L191-203, WSBillingCharges.tsx L304/334
- **Cambio:** Reemplazar `for...addDoc` por `writeBatch` + `batch.set(doc(collection(...)), data)`
- **Riesgo de regresion:** MEDIO

**Diferencia critica entre addDoc loop y writeBatch:**
- `addDoc` loop: si falla en el item 3 de 10, los items 1-2 YA estan escritos (parcial)
- `writeBatch`: si falla, NINGUN item se escribe (atomico)

**Esto CAMBIA el comportamiento de error.** Hoy, un fallo parcial deja charges parciales. Con batch, es todo o nada.

**Riesgo:** Si un batch excede 500 operaciones (limite Firestore), falla completamente. El loop actual funciona con cualquier cantidad.

**Mitigacion:**
```typescript
const BATCH_LIMIT = 500
for (let i = 0; i < charges.length; i += BATCH_LIMIT) {
  const batch = writeBatch(db)
  charges.slice(i, i + BATCH_LIMIT).forEach(charge => {
    batch.set(doc(collection(db, 'air_billing_charges')), charge)
  })
  await batch.commit()
}
```
**Nota:** airBilling.ts L500-506 YA usa este patron para deletes. Consistir el patron para creates.

**Tests obligatorios:**
- [ ] Billing calculation con 1 charge → se crea correctamente
- [ ] Billing calculation con 50 charges → todas se crean
- [ ] Billing recalculation (delete + recreate) → montos correctos
- [ ] Invoice generation despues de billing → totales correctos
- [ ] WS Billing: crear charges de SO → se crean correctamente

---

#### SOL-17: client_id filter en WSDashboard onSnapshot
- **Archivo:** WSDashboard.tsx L48-58
- **Cambio:** Agregar `where('client_id', '==', clientId)` para usuarios tipo client
- **Riesgo de regresion:** MEDIO

**Riesgo de seguridad actual:** Hoy el listener recibe TODAS las orders y filtra en JS. Esto significa que los datos de OTROS clientes viajan por la red y estan en memoria del browser. Un usuario tecnico podria ver datos de otros clientes via DevTools.

**Riesgo del cambio:**
- Para MCL staff (`isMCL()`): el query no debe tener filtro de client_id
- Para clientes: debe filtrar por `clientId` del AuthContext
- **PELIGRO:** Si `clientId` es null/undefined (usuario sin client_id asignado), el query podria devolver 0 resultados o fallar

**Mitigacion:**
```typescript
const constraints = [orderBy('created_at', 'desc')]
if (isClient && clientId) {
  constraints.push(where('client_id', '==', clientId))
}
```

**Tests obligatorios:**
- [ ] Admin MCL: ve todas las orders
- [ ] Cliente: ve solo sus orders
- [ ] Viewer: ve solo orders de su client_id
- [ ] Cliente sin client_id: comportamiento graceful (no crash)

---

#### SOL-18: Paginacion real en tablas
- **Archivos:** Inventory.tsx, AirfreightHolds.tsx, BillingCharges.tsx, AirfreightBookingList.tsx
- **Cambio:** Implementar cursor-based pagination con Firestore `startAfter`
- **Riesgo de regresion:** **ALTO**

**Impacto en UX:**
- Hoy: usuario ve TODOS los registros y puede Ctrl+F, filtrar, ordenar client-side
- Con paginacion: usuario solo ve N registros, debe navegar paginas, no puede buscar en todo el dataset

**Riesgo critico en Inventory:**
- Los filtros client-side (por pais, status, cliente, busqueda) dependen de tener TODOS los items en memoria
- Con paginacion, estos filtros solo funcionan sobre la pagina actual — resultado incompleto
- **Esto es una regresion FUNCIONAL, no solo de performance**

**Riesgo critico en BillingCharges:**
- Los totales y resumenes se calculan sobre todos los charges
- Con paginacion, los totales serian parciales

**Riesgo en BookingList:**
- Filtros de estado, cliente, vuelo son client-side
- Con paginacion, un booking que matcha el filtro pero esta en otra pagina no se veria

**Alternativa segura:**
- **Server-side filters:** Mover filtros al query de Firestore (where clauses) en vez de filtrar client-side
- **Infinite scroll:** Cargar primeras 50, agregar mas al hacer scroll
- **Virtual scroll:** Cargar todos pero renderizar solo los visibles (react-window)

**RECOMENDACION: NO implementar paginacion hasta migrar los filtros client-side a server-side (where clauses). Implementar react-window (SOL-24) primero — resuelve el problema de render sin cambiar la carga de datos.**

**Tests obligatorios (si se implementa):**
- [ ] Pagina 1 muestra N registros
- [ ] Navegar a pagina 2 — datos correctos
- [ ] Filtrar por cliente — resultados correctos (no parciales)
- [ ] Busqueda — encuentra registros de cualquier pagina
- [ ] Totales/resumen — reflejan el total, no solo la pagina

---

### FASE 3: Architecture

---

#### SOL-19: Cloud Functions para billing y KPI
- **Cambio:** Migrar billing recalculation y KPI aggregation a server-side
- **Riesgo de regresion:** **MUY ALTO**

**Este es el cambio mas grande y riesgoso del plan completo.**

**Estado actual:** No existen Cloud Functions. Todo el billing se ejecuta en el browser del usuario.

**Impacto de la migracion:**
1. **Billing recalculation** (airBilling.ts `recalculateAutoCharges`):
   - Hoy: usuario hace click → calcula en browser → escribe charges → resultado visible inmediatamente
   - Con CF: usuario hace click → HTTP call a CF → CF calcula → escribe charges → resultado visible despues de round-trip
   - **Cambio de UX:** De sincrono a asincrono. Necesita loading state y confirmacion.

2. **KPI aggregation:**
   - Hoy: KPIs se calculan en cada render desde datos en memoria
   - Con CF: KPIs pre-calculados en un documento, actualizados por trigger
   - **Riesgo de staleness:** KPIs no reflejan ultimo cambio hasta que el trigger procese

3. **Invoice generation:**
   - Hoy: genera invoice + PDF en browser
   - Con CF: genera en servidor
   - **Riesgo:** Si la CF falla, no hay rollback automatico

**Dependencias nuevas:**
- Firebase Blaze plan (Cloud Functions requiere facturacion)
- Entorno de Cloud Functions (Node.js runtime)
- Deploy pipeline para CF
- Monitoring y logging de CF

**Modulos afectados:**
- AirfreightBillingCharges.tsx — trigger de recalculation
- WSBillingCharges.tsx — trigger de recalculation
- AirfreightBillingSummary.tsx — lectura de resultados
- WSKpiDashboard.tsx — lectura de KPIs pre-calculados
- Todos los archivos en src/lib/ que hacen billing calculations

**RECOMENDACION: Implementar como Phase 4, no Phase 3. Requiere plan de migracion propio con rollback strategy.**

**Tests obligatorios:**
- [ ] Billing: recalculate charges → montos identicos al calculo client-side
- [ ] Billing: manual charges siguen funcionando
- [ ] Invoicing: generar invoice → PDF correcto, montos correctos
- [ ] KPI: valores actualizados despues de crear WR/dispatch
- [ ] Error handling: CF falla → usuario recibe error claro, datos intactos
- [ ] Latencia: CF responde en < 5 segundos
- [ ] Concurrencia: 2 usuarios recalculan billing del mismo vuelo simultaneamente → datos consistentes

---

#### SOL-20: PDF en Web Worker
- **Archivos:** buildupPdf.ts, deliveryOrder.ts, printLabels.ts
- **Cambio:** Mover generacion de PDF a Web Worker
- **Riesgo de regresion:** MEDIO

**Limitaciones de Web Workers:**
- No tienen acceso a `document` ni `window` — popups con `window.open` NO funcionan desde Worker
- No pueden acceder a DOM — `html2pdf.js` (que usa DOM) NO puede correr en Worker
- Solo pueden devolver datos serializables — deben devolver ArrayBuffer del PDF

**Impacto por tipo de PDF:**
| PDF | Lib usada | Worker viable | Razon |
|-----|----------|---------------|-------|
| buildupPdf.ts | jsPDF + autotable | SI | No usa DOM |
| deliveryOrder.ts | HTML string → window.open | NO | Requiere DOM |
| printLabels.ts | SVG + window.open | NO | Requiere DOM |
| AirfreightDocReceptionList | HTML string | NO | Requiere DOM |
| html2pdf.js usage | html2pdf.js | NO | Requiere DOM |

**Solo buildupPdf.ts es viable para Web Worker sin reescritura.**

**Mitigacion:** Para los demas, usar `requestIdleCallback` o dividir el trabajo en chunks con `setTimeout` para no bloquear el main thread.

**Tests obligatorios:**
- [ ] PDF de buildup: contenido identico al actual
- [ ] PDF de buildup: no congela la UI durante generacion
- [ ] PDF de DO: sigue funcionando (no migrado a Worker)
- [ ] Labels: siguen imprimiendo correctamente

---

#### SOL-21: Dynamic import tesseract.js
- **Archivo:** src/components/BarcodeScannerModal.tsx L2
- **Cambio:** Reemplazar `import Tesseract from 'tesseract.js'` por dynamic `import()`
- **Riesgo de regresion:** BAJO

**Analisis:** Tesseract solo se usa dentro de `captureAndRead()`. Dynamic import retrasa la carga hasta que el usuario activa la camara.

**Riesgo:** Primera invocacion tarda mas (descarga ~3MB WASM). Necesita loading indicator.

**Tests obligatorios:**
- [ ] Abrir BarcodeScannerModal → escanear barcode → resultado correcto
- [ ] Primera vez: loading indicator visible mientras carga WASM
- [ ] Consecutive scans: no re-descarga WASM

---

#### SOL-22: Cache layer datos referencia
- **Cambio:** Cache en memoria para clients, destinations, rates
- **Riesgo de regresion:** MEDIO

**Riesgo: DATOS STALE**
- Si un admin cambia una rate y otro usuario tiene la rate vieja en cache, el calculo sera incorrecto
- Si se crea un nuevo destino, no aparece hasta que expire el cache

**Mitigacion:**
- TTL corto para rates (1 minuto max)
- Invalidar cache al navegar a paginas de billing
- NO cachear datos que cambian frecuentemente (bookings, orders)
- Solo cachear: clients, destinations, rate_schedule, uld_types

**Tests obligatorios:**
- [ ] Cambiar rate → recalcular billing → nueva rate se usa
- [ ] Agregar destination → crear booking → nuevo destino disponible
- [ ] Cache no persiste entre sesiones (no localStorage para datos sensibles)

---

#### SOL-23: Dividir componentes monoliticos
- **Archivos:** AirfreightBookingNew (3,356 ln), AirfreightBuildup (2,394 ln), AirfreightDeliveryOrder (1,583 ln), WSOrderDetail (2,529 ln)
- **Cambio:** Extraer subcomponentes
- **Riesgo de regresion:** **ALTO**

**Riesgo principal: STATE LIFTING**
Estos componentes tienen 25-35 useState cada uno. Al dividir, el state debe:
- Quedarse en el parent y pasarse como props (prop drilling — no mejora re-renders)
- Moverse al child y comunicarse via callbacks (riesgo de desincronia)
- Extraerse a un custom hook (mejor opcion pero complejo)

**Riesgo especifico por componente:**

**AirfreightBookingNew (3,356 ln):**
- 35 useState hooks — muchos interdependientes (tipo de booking afecta validaciones, fields visibles, etc.)
- Formulario complejo con logica condicional por booking_type (simple/mawb/ecommerce/export)
- **PELIGRO:** Separar el form en tabs/sections puede romper validaciones cruzadas
- Ejemplo: `chargeable_weight` depende de `actual_weight` y `dimensional_weight` que se calculan de fields en diferentes secciones

**AirfreightBuildup (2,394 ln):**
- Mezcla lista de vuelos + vista de distribucion + ULD management
- Flujo tiene state compartido entre "seleccionar vuelo" → "ver piezas" → "distribuir a ULD"
- **RIESGO:** Si se separa FlightList de DistributionView, el state compartido necesita coordinarse

**RECOMENDACION: Extraer custom hooks primero (useBookingForm, useBuildupDistribution, etc.) sin cambiar la estructura visual. Luego extraer subcomponentes visuales que reciban props del hook.**

**Tests obligatorios:**
- [ ] Booking: crear booking simple → campos correctos, guardar OK
- [ ] Booking: crear booking ecommerce con AWB lines → guardar OK
- [ ] Booking: crear booking MAWB → guardar OK
- [ ] Booking: editar booking existente → todos los campos cargan correctamente
- [ ] Buildup: flujo completo flight → distribute → close
- [ ] DeliveryOrder: flujo completo select AWBs → generate sets → print
- [ ] WSOrderDetail: todos los tabs/secciones funcionan

---

#### SOL-24: react-window virtualizacion
- **Cambio:** Agregar virtualizacion a tablas con 100+ filas
- **Riesgo de regresion:** MEDIO

**Riesgo principal: LAYOUT CHANGES**
- react-window requiere height fijo para el container y las filas
- Tablas con filas de altura variable (expandable rows, multi-line content) necesitan `VariableSizeList`
- La tabla actual usa HTML `<table>` — react-window genera `<div>` con posicion absoluta

**Impacto visual:**
- Scrollbar se comporta diferente (virtual scroll vs native scroll)
- Ctrl+F del browser NO encuentra texto fuera del viewport
- Print del browser solo imprime filas visibles

**Alternativa:** `react-virtuoso` — soporta tablas HTML nativas y es drop-in replacement mas facil

**Tests obligatorios:**
- [ ] Scroll suave en tabla de 1000+ filas
- [ ] Filas expandibles funcionan
- [ ] Filtrar/buscar actualiza lista correctamente
- [ ] Export a Excel sigue exportando todos los datos (no solo visibles)

---

#### SOL-25: Optimizar Vite manualChunks
- **Archivo:** vite.config.ts
- **Cambio:** Agregar chunks para xlsx, recharts, jspdf, html2pdf
- **Riesgo de regresion:** BAJO

**Analisis:** Solo afecta el build output. No cambia runtime behavior. Puede mejorar caching del browser porque los vendors grandes no se re-descargan en cada deploy.

**Riesgo unico:** Si un chunk se vuelve demasiado grande, puede causar timeout en redes lentas. Verificar tamanos post-build.

**Tests obligatorios:**
- [ ] `npm run build` exitoso
- [ ] App carga correctamente en produccion
- [ ] Lazy-loaded routes cargan sus chunks correctamente

---

#### SOL-26: Paralelizar Generate Sets
- **Archivo:** AirfreightDeliveryOrder.tsx L600-793
- **Cambio:** Reemplazar `for...of` secuencial con `Promise.all`
- **Riesgo de regresion:** MEDIO

**Riesgo: CONCURRENCIA DE ESCRITURA**
Si Generate Sets hace writes a Firestore (ej: update status del DO), paralelizar puede causar race conditions donde dos updates chocan.

**Analisis del flujo:**
- Generate Sets crea PDFs con datos de bookings + DO
- Cada AWB genera su propio set de PDFs independientemente
- Los PDFs se guardan en un Map local (blob URLs) — no hay writes a Firestore durante generacion

**Resultado:** Paralelizar es SEGURO porque solo son lecturas + generacion de PDF en memoria. No hay writes concurrentes.

**Riesgo secundario:** Si se paraleliza MAWB entries (nested loop), las queries concurrentes pueden saturar Firestore.

**Mitigacion:** Usar `Promise.all` para el loop externo (por AWB) pero mantener secuencial el loop interno (por MAWB entry). Limitar concurrencia con `Promise.allSettled` + `p-limit` si hay > 10 AWBs.

**Tests obligatorios:**
- [ ] Generate Sets con 1 AWB → PDF correcto
- [ ] Generate Sets con 5 AWBs ecommerce → todos los PDFs correctos
- [ ] Generate Sets con 3 AWBs MAWB (cada uno con 5 entries) → todos los PDFs correctos
- [ ] Tiempo de generacion reducido (benchmark before/after)

---

### FASE 4: Polish

---

#### SOL-27: React.memo en componentes hijo
- **Riesgo:** BAJO — solo evita re-renders innecesarios, no cambia output

#### SOL-28: Custom claims Firebase Auth
- **Riesgo:** **MUY ALTO**

**Cambio propuesto:** Migrar role lookups de security rules (get() en cada evaluacion) a custom claims en el JWT token.

**Impacto:**
1. **Security rules:** Reescribir TODAS las reglas que usan `userRole()`, `clientId()`, `vendorId()` — son 50+ reglas en firestore.rules
2. **Backend requerido:** Custom claims solo se pueden setear desde Admin SDK (server-side)
3. **Propagacion:** Cambiar el rol de un usuario requiere que el usuario haga re-login para que el JWT se refresque (o forzar refresh con `getIdToken(true)`)
4. **Migracion:** Todos los usuarios existentes necesitan que se les asignen claims

**Riesgo de seguridad:** Si la migracion falla parcialmente, usuarios pueden perder acceso o tener acceso indebido temporalmente.

**RECOMENDACION: Ultima prioridad. Solo implementar si el costo de Firestore por reads de rules es significativo (monitorear primero).**

#### SOL-29: Remover firebase-admin, @zxing
- **Riesgo:** BAJO — verificar que no haya imports antes de remover

#### SOL-30: Skeleton screens
- **Riesgo:** BAJO — cambio puramente visual

#### SOL-31: Archival datos historicos
- **Riesgo:** **ALTO** — mover datos a otra coleccion puede romper queries que buscan datos historicos

#### SOL-32: Optimizar logo.png
- **Riesgo:** BAJO — solo reducir tamano de imagen

---

## SECCION 3: MATRIZ DE RIESGOS CONSOLIDADA

### Cambios SEGUROS (implementar sin precauciones especiales)
| # | Solucion | Por que es seguro |
|---|---------|------------------|
| 6 | ErrorBoundary | Solo agrega proteccion |
| 7 | Fix window.print | Arregla bug existente |
| 15 | Indices compuestos | Transparente a queries |
| 25 | Vite manualChunks | Solo afecta build |
| 27 | React.memo | Solo optimiza render |
| 29 | Remover deps sin usar | No afecta runtime |
| 30 | Skeleton screens | Cambio cosmético |
| 32 | Optimizar logo | Solo reduce tamano |

### Cambios de BAJO riesgo (implementar con tests basicos)
| # | Solucion | Precaucion |
|---|---------|-----------|
| 1 | useMemo AuthContext | useCallback en funciones primero |
| 2 | Debounce search | Verificar que no se aplique a acciones |
| 4 | Singleton window.open | Verificar ventana cerrada antes de reutilizar |
| 5 | Revocar blob URLs | Revocar ANTES de regenerar |
| 9 | Cache Add AWB modal | TTL + invalidacion |
| 10 | Memoizar loadClient | Cache scoped a operacion |
| 21 | Dynamic import tesseract | Loading indicator |

### Cambios de MEDIO riesgo (implementar con test plan completo)
| # | Solucion | Riesgo principal |
|---|---------|-----------------|
| 3 | Where/limit tracking | Datos activos antiguos invisibles |
| 12 | Buildup Promise.all | Saturar Firestore con parallelismo |
| 13 | Where en Billing/KPI | KPIs parciales, charges invisibles |
| 16 | writeBatch | Cambio de atomicidad, limite 500 |
| 17 | client_id WSDashboard | clientId null/undefined |
| 20 | PDF Web Worker | Solo viable para buildupPdf.ts |
| 22 | Cache referencia | Datos stale en rates |
| 24 | react-window | Ctrl+F roto, print parcial |
| 26 | Paralelizar Gen Sets | Concurrencia de queries |

### Cambios de ALTO riesgo (requieren plan de migracion dedicado)
| # | Solucion | Riesgo principal |
|---|---------|-----------------|
| 8 | Where en DocReceptionNew | AWB search broken (Firestore no soporta where en array fields) |
| 11 | Inventory N+1 denormalize | 8+ modulos dependen de lines subcollection |
| 14 | Separar nested listeners | Flash de estado incompleto, race conditions |
| 18 | Paginacion tablas | Filtros client-side dejan de funcionar |
| 23 | Dividir componentes | State interdependiente entre 25-35 hooks |
| 31 | Archival historicos | Queries historicas se rompen |

### Cambios MUY ALTO riesgo (requieren proyecto dedicado)
| # | Solucion | Riesgo principal |
|---|---------|-----------------|
| 19 | Cloud Functions | Cambio arquitectural completo, nueva infraestructura |
| 28 | Custom claims | Reescribir 50+ security rules, migracion usuarios |

---

## SECCION 4: PLAN DE PRUEBAS OBLIGATORIO

### A. Pruebas Funcionales por Modulo

#### Airfreight - Bookings
| Test | Criticidad | Afectado por SOL# |
|------|-----------|-------------------|
| Crear booking simple | Alta | 1, 23 |
| Crear booking ecommerce con AWB lines | Alta | 1, 23 |
| Crear booking MAWB | Alta | 1, 23 |
| Editar booking existente | Alta | 1, 23 |
| Asignar vuelo a booking | Alta | 1, 14 |
| Buscar booking por AWB | Critica | 8 |
| Vista de cliente (solo sus bookings) | Alta | 1, 17 |
| Print booking PDF | Media | 4, 7 |

#### Airfreight - Recepcion Documental
| Test | Criticidad | Afectado por SOL# |
|------|-----------|-------------------|
| Crear doc reception con booking | Alta | 8 |
| Crear doc reception "sin booking" | Alta | 8 |
| Buscar AWB (todos los formatos) | Critica | 8 |
| Check duplicados | Alta | 8 |
| Upload manifesto Excel | Media | N/A (ya implementado) |

#### Airfreight - Recepcion Fisica
| Test | Criticidad | Afectado por SOL# |
|------|-----------|-------------------|
| Agregar piezas | Alta | 1 |
| Escanear barcode | Alta | 21 |
| Completar recepcion (status sync) | Alta | 1 |
| Print labels | Media | 4 |

#### Airfreight - Build-up / Distribucion
| Test | Criticidad | Afectado por SOL# |
|------|-----------|-------------------|
| Ver vuelos disponibles (in_physical + complete) | Alta | 12 |
| Distribuir piezas a ULD | Alta | 12 |
| PDF de buildup | Media | 20 |
| Close distribution | Alta | 12 |

#### Airfreight - Delivery Orders
| Test | Criticidad | Afectado por SOL# |
|------|-----------|-------------------|
| Add AWB modal | Alta | 9 |
| Generate Sets | Critica | 5, 26 |
| Print DO | Media | 4 |
| Vista de lista + filtros | Alta | 2, 3 |

#### Airfreight - Billing
| Test | Criticidad | Afectado por SOL# |
|------|-----------|-------------------|
| Auto charges en dispatch | Critica | 10, 16, 19 |
| Manual charges | Alta | 10, 16 |
| Recalculate charges | Critica | 10, 16, 19 |
| Generate invoice | Critica | 10, 16, 19 |
| Billing summary por vuelo | Alta | 13 |
| Vista de cliente (solo sus charges) | Alta | 1, 17 |

#### Airfreight - Dashboard
| Test | Criticidad | Afectado por SOL# |
|------|-----------|-------------------|
| Carga inicial (flights + bookings) | Alta | 14 |
| Filtro por fecha | Alta | 2, 14 |
| Real-time updates | Alta | 14 |
| Vista de cliente | Alta | 1 |

#### Airfreight - Screening
| Test | Criticidad | Afectado por SOL# |
|------|-----------|-------------------|
| Lista de AWBs con screening status | Alta | 14 |
| Real-time update de screening | Alta | 14 |

#### Warehouse Services - Orders
| Test | Criticidad | Afectado por SOL# |
|------|-----------|-------------------|
| Crear SO | Alta | 1 |
| Ver detalle SO (WSOrderDetail) | Alta | 23 |
| Status sync (global_status) | Critica | (no tocar SOL-35 feedback loop) |
| Billing charges de SO | Critica | 16 |

#### Warehouse Services - Dashboard
| Test | Criticidad | Afectado por SOL# |
|------|-----------|-------------------|
| Carga de ordenes | Alta | 17 |
| Vista de cliente | Alta | 1, 17 |
| KPIs | Alta | 13 |

#### Warehouse Services - Delivery
| Test | Criticidad | Afectado por SOL# |
|------|-----------|-------------------|
| Delivery tracking | Alta | 3 |
| Driver queue | Alta | 3 |
| DO view | Alta | 3 |

#### Seafreight - Inventory
| Test | Criticidad | Afectado por SOL# |
|------|-----------|-------------------|
| Carga de WRs | Critica | 11, 18 |
| Filtros (pais, cliente, status) | Critica | 11, 18 |
| Detalle expandido (lines) | Alta | 11 |
| Export Excel | Alta | 11, 18 |
| Semaforo documentos | Media | 11 |

#### Seafreight - Billing
| Test | Criticidad | Afectado por SOL# |
|------|-----------|-------------------|
| Billing charges por WR | Critica | 13, 16 |
| Billing profiles | Alta | 1 |
| Invoice generation | Critica | 16 |

### B. Pruebas de Regresion Cruzada

| Escenario | Modulos involucrados | Afectado por |
|-----------|---------------------|-------------|
| Crear booking → recepcion documental → recepcion fisica → buildup → dispatch → billing → invoice | Air completo | 1, 8, 10, 12, 16, 26 |
| Crear WR → physical reception → dispatch → billing → invoice | Sea completo | 1, 11, 16 |
| Crear SO → reception → DO → tracking → billing | WS completo | 1, 3, 16, 17, 23 |
| Login como admin → crear booking → login como cliente → ver booking | Auth + Air | 1 |
| Abrir Dashboard → crear booking en otra pestana → dashboard actualiza | Real-time | 14 |
| Billing recalculate → verificar invoice montos → verificar charges | Billing cross-check | 10, 16, 19 |

### C. Pruebas de Performance (Before/After)

| Metrica | Como medir | Baseline (antes) |
|---------|-----------|-----------------|
| Inventory page load time | Chrome DevTools Performance | 20-40s |
| Dashboard initial render | Performance.mark/measure | 5-10s |
| AWB search latency | Console.time en DocReceptionNew | 3-10s |
| Generate Sets (5 AWBs) | Console.time | 30-60s |
| Auth context re-renders | React DevTools Profiler | Count per navigation |
| Firestore reads/page load | Firebase Console Usage | Check before/after |
| Bundle size | `npx vite build` output | Measure current |
| Memory after 1hr use | Chrome Task Manager | Measure current |
| PDF generation time | Console.time | 2-5s |

### D. Pruebas de Estres

| Test | Condicion | Que verificar |
|------|----------|--------------|
| 1000 bookings | Crear fixtures | BookingList, Dashboard, Search responden < 3s |
| 100 WRs con 50 lines cada uno | Crear fixtures | Inventory carga < 5s |
| 50 charges por vuelo | Crear fixtures | Billing recalculate < 10s |
| 5 usuarios simultaneos | Abrir en 5 pestanas | Real-time updates no se bloquean |
| Vuelo con 20 recepciones | Datos reales | Buildup carga piezas correctamente |
| DO con 10 AWBs MAWB | Datos reales | Generate Sets completa < 15s |
| Rapid navigation (10 paginas en 5s) | Click rapido | No memory leak, no listener leak |

---

## SECCION 5: VALIDACION DE COMPATIBILIDAD

### Arquitectura Modular
| Validacion | Estado |
|-----------|--------|
| Las mejoras NO crean dependencias entre modulos | OK — cada cambio es local al archivo |
| Las mejoras NO rompen lazy loading | OK — no se cambian imports de rutas |
| Las mejoras NO agregan shared state entre modulos | OK — AuthContext ya es compartido |

### APIs Internas
| API/Funcion | Cambio | Compatible |
|-------------|--------|-----------|
| useAuth() | Return type no cambia | SI |
| calculateAirfreightCharges() | Agrega cache interno | SI — misma firma |
| loadRateSchedule() | Agrega cache | SI — misma firma |
| buildDoHtml() | No se modifica | SI |
| loadAllDOsForKey() | No se modifica | SI |

### Integraciones Externas
| Integracion | Afectada | Razon |
|-------------|---------|-------|
| Firebase Auth | SOL-28 (custom claims) | Solo si se implementa |
| Firebase Firestore | SOL-15 (indices) | Mejora, no rompe |
| Firebase Storage | No | Ninguna solucion toca Storage |
| n8n workflow (email → Sheets) | No | Independiente del WMS |

### Flujos de Booking
| Flujo | Riesgo | Cambio que lo afecta |
|-------|--------|---------------------|
| Simple booking | Bajo | SOL-1 (auth memo), SOL-23 (split) |
| MAWB booking | Bajo | SOL-1, SOL-23 |
| Ecommerce booking | Bajo | SOL-1, SOL-23 |
| Export booking | Bajo | SOL-1 |
| Booking con AWB lines | **Medio** | SOL-8 (AWB search), SOL-23 |

### Dashboards
| Dashboard | Riesgo | Cambio que lo afecta |
|-----------|--------|---------------------|
| Airfreight Dashboard | **Alto** | SOL-14 (nested listener separation) |
| WS Dashboard | **Medio** | SOL-17 (client_id filter) |
| WS KPI Dashboard | **Medio** | SOL-13 (where clause) |
| Billing Dashboard | Bajo | SOL-1 |
| Seafreight Dashboard | Bajo | SOL-1 |

### Calculos de Billing
| Calculo | Riesgo | Cambio que lo afecta |
|---------|--------|---------------------|
| Auto charges (dispatch) | **Medio** | SOL-10, SOL-16, SOL-19 |
| Manual charges | Bajo | SOL-16 |
| Recalculate | **Medio** | SOL-10, SOL-16, SOL-19 |
| Storage charges | Bajo | SOL-11 (si se denormaliza) |
| Invoice totals | **Medio** | Transitivo de SOL-10, SOL-16 |

### ULD Build-up
| Operacion | Riesgo | Cambio que lo afecta |
|-----------|--------|---------------------|
| Cargar piezas | Medio | SOL-12 (N+1 fix) |
| Distribuir a ULD | Bajo | SOL-12 |
| PDF de buildup | Medio | SOL-20 (Web Worker) |
| Close distribution | Bajo | N/A |

### Recepcion Documental / Fisica
| Operacion | Riesgo | Cambio que lo afecta |
|-----------|--------|---------------------|
| Buscar AWB | **ALTO** | SOL-8 |
| Check duplicados | **ALTO** | SOL-8 |
| Crear doc reception | Bajo | SOL-8 (resultado de busqueda) |
| Recepcion fisica | Bajo | SOL-21 (tesseract dynamic) |
| Print labels | Bajo | SOL-4 (singleton) |

### Handheld vs Desktop
| Cambio | Impacto en mobile |
|--------|------------------|
| Debounce | Mejora (menos queries en conexion lenta) |
| Virtualizacion | Mejora (menos DOM) |
| Web Worker PDF | Mejora (no congela UI movil) |
| Skeleton screens | Mejora |
| Dynamic import | Mejora (menos carga inicial) |
| react-window | **Posible issue** con scroll tactil |

---

## SECCION 6: RECOMENDACIONES FINALES

### Orden de Implementacion Revisado (por riesgo, no por fase)

**Sprint 1 (1-2 dias) — Cambios Seguros + Bajo Riesgo:**
1. SOL-6: ErrorBoundary
2. SOL-7: Fix window.print
3. SOL-15: Indices compuestos (Firebase Console)
4. SOL-25: Vite manualChunks
5. SOL-29: Remover firebase-admin, @zxing (verificar imports primero)
6. SOL-32: Optimizar logo.png
7. SOL-5: Revocar blob URLs
8. SOL-2: Debounce search inputs
9. SOL-4: Singleton window.open
10. SOL-10: Memoizar loadClient billing
11. SOL-1: useMemo AuthContext (con useCallback en funciones)
12. SOL-21: Dynamic import tesseract.js

**Sprint 2 (3-5 dias) — Riesgo Medio con Test Plan:**
13. SOL-12: Buildup Promise.all
14. SOL-16: writeBatch addDoc loops
15. SOL-17: client_id filter WSDashboard
16. SOL-26: Paralelizar Generate Sets
17. SOL-9: Cache Add AWB modal
18. SOL-3: Where/limit tracking (con toggle "Ver historicos")
19. SOL-13: Where en BillingCharges/KPI (con selector de periodo)
20. SOL-22: Cache layer referencia (con TTL corto)

**Sprint 3 (1-2 semanas) — Alto Riesgo con Migracion:**
21. SOL-20: PDF Web Worker (solo buildupPdf.ts)
22. SOL-24: react-window/virtuoso
23. SOL-27: React.memo componentes hijo
24. SOL-30: Skeleton screens
25. SOL-14: Separar nested listeners (solo BookingList, NO Dashboard/Screening)
26. SOL-18: Paginacion (solo DESPUES de migrar filtros a server-side)
27. SOL-8: AWB search optimization (crear campo indexable, no where directo)
28. SOL-11: Inventory optimization (pagination + cache, NO denormalizacion)

**Sprint 4 (proyecto dedicado) — Muy Alto Riesgo:**
29. SOL-23: Dividir componentes (custom hooks primero, luego visual split)
30. SOL-31: Archival datos historicos
31. SOL-19: Cloud Functions (requiere plan propio)
32. SOL-28: Custom claims (solo si costo de Firestore lo justifica)

### Reglas de Implementacion

1. **NUNCA** implementar mas de 1 cambio de riesgo ALTO en el mismo deploy
2. **SIEMPRE** hacer build + test manual antes de deploy de cambios MEDIO+
3. **SIEMPRE** tener rollback plan (git revert ready) para cambios ALTO+
4. **NUNCA** modificar flujo MAWB sin autorizacion explicita del usuario
5. **SIEMPRE** verificar que billing calculations producen resultados identicos pre/post cambio
6. **SIEMPRE** probar con datos reales de produccion (no solo datos de prueba)

### Metricas de Monitoreo Post-Deploy

| Metrica | Tool | Alarma si |
|---------|------|----------|
| Firestore reads/dia | Firebase Console | > 110% del baseline |
| Error rate (console.error) | Browser DevTools | Nuevos errores |
| Page load time | Chrome Lighthouse | > 120% del baseline |
| Memory usage | Chrome Task Manager | Crece sin limite |
| User reports | Feedback directo | Cualquier reporte de datos faltantes |

---

---

## SECCION 7: CORRECCIONES POST-ANALISIS DE AGENTES

Los siguientes datos corrigen o enriquecen el audit original tras analisis profundo del codigo:

### Correcciones de datos

| Dato del audit | Valor corregido | Impacto |
|---------------|-----------------|---------|
| AuthContext: 18 consumers | **71 consumers** | useMemo 4x mas critico |
| BookingNew: 35 useState | **68 useState** | Splitting mas urgente |
| AirfreightBuildup: 15 useState | **43 useState** | Splitting mas urgente |
| WSOrderDetail: 20 useState | **55+ useState** | Splitting mas urgente |
| Generate Sets: 30-60s | **2.5-3.5s POR AWB, 12-17s para 5 AWBs** | Mas preciso |
| Blob leak: generico | **3-7.5 MB por DO, 15 blob URLs por generacion** | Cuantificado |

### Nuevos riesgos descubiertos

1. **WSOrderDetail nested listener race condition (L276-294):** `unsub2` puede ser undefined si el componente se desmonta mientras el `getDoc` Promise esta pendiente. Requiere fix previo a cualquier optimizacion.

2. **ModuleSelector.tsx auto-redirect effect (L17-24):** Depende de `hasSeaAccess`, `hasAirAccess`, `hasWarehouseAccess` en dependency array. Si el useMemo del AuthContext no incluye `moduleAccess` en sus dependencias, este efecto no disparara correctamente y el usuario quedara en la pagina equivocada.

3. **Dashboard.tsx closure capture (L21-23):** `fetchReceipts` captura `isClient` y `clientId` del primer render (empty deps array). Si auth cambia despues del mount, la funcion usa valores stale. Esto es un bug EXISTENTE, no introducido por optimizaciones.

4. **AirfreightBookingNew tiene 68 hooks:** El splitting debe priorizar extraer custom hooks antes que componentes visuales. Dividir un componente con 68 hooks interdependientes sin hooks intermedios causara prop drilling masivo.

5. **wsBilling.ts es el mejor diseñado:** 0 patrones N+1, carga rates una vez, todo calculo es in-memory. Usarlo como modelo para refactorizar airBilling.ts.

6. **4 resize listeners sin cleanup consolidado:** AirfreightBuildup, ModuleSelector, DriverMobile, y otro componente agregan `window.addEventListener('resize')` independientemente. Crear `useIsMobile()` hook centralizado.

### Orden de ejecucion actualizado (pre-requisitos descubiertos)

Antes de implementar cualquier solucion del Sprint 1:
- **FIX PREVIO A:** Corregir race condition en WSOrderDetail L276-294 (crear `useDoTracking()` hook)
- **FIX PREVIO B:** Verificar que el closure capture en Dashboard.tsx L21-23 no cause problemas con datos stale

Para SOL-1 (useMemo AuthContext):
- **PRE-REQUISITO:** Crear useCallback para las 7 funciones del provider ANTES de envolver value en useMemo
- **PRE-REQUISITO:** Mover flags derivados (isAdmin, isClient, etc.) DENTRO del useMemo
- **VERIFICACION:** Probar ModuleSelector auto-redirect despues del cambio

Para SOL-23 (Dividir componentes):
- **PRE-REQUISITO:** Extraer custom hooks (useBookingForm, useBuildupDistribution, useOrderDetail) ANTES de dividir visualmente
- **RAZON:** 68 hooks en BookingNew no se pueden distribuir a subcomponentes sin hooks intermedios

---

*Documento generado: 2026-05-18 | Validacion de 32 soluciones de performance contra regresion funcional*
*Actualizado con hallazgos de 4 agentes de analisis paralelo (AuthContext, Firestore, Billing/PDF, Architecture)*
