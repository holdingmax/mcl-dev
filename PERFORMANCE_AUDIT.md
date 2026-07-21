# MCL WMS - Performance Audit Report
**Fecha:** 2026-05-18 | **Auditor:** Senior Performance Engineer Analysis

---

## 1. ARQUITECTURA GENERAL

| Aspecto | Tecnologia | Estado |
|---------|-----------|--------|
| Frontend | React 18 + Vite + TypeScript + Tailwind CSS | OK |
| Base de datos | Firebase Firestore | Problemas de queries |
| Autenticacion | Firebase Auth + AuthContext | Necesita optimizacion |
| PDF Generation | jsPDF + html2pdf.js + pdf-lib | Client-side, bloquea UI |
| State Management | Context API (solo AuthContext) | Sin memoizacion |
| Cloud Functions | No existen | Todo se hace client-side |
| Rutas | 71 lazy-loaded routes via React.lazy | OK |

**Dependencias pesadas:**
- tesseract.js (~1.2MB) - OCR
- pdfjs-dist, jspdf, jspdf-autotable, pdf-lib, html2pdf.js (5 libs de PDF)
- exceljs + xlsx (2 libs de Excel)
- @zxing/browser + @zxing/library (barcode/QR)
- recharts (charting)

---

## 2. FRONTEND PERFORMANCE

### CRITICO

#### 2.1 AuthContext sin memoizacion
- **Archivo:** `src/contexts/AuthContext.tsx` lineas 376-389
- **Problema:** El objeto `value` del Provider se recrea en cada render. 23 propiedades (12 estados + 11 flags derivados). 18 archivos consumen `useAuth()` y TODOS re-renderizan ante cualquier cambio de estado.
- **Solucion:** Envolver el value en `useMemo`, separar contextos (auth vs roles vs module access).

#### 2.2 Componentes monoliticos
| Componente | Lineas | Problema |
|-----------|--------|----------|
| AirfreightBookingNew | 3,356 | Debe dividirse en subcomponentes |
| AirfreightBuildup | 2,394 | 15+ useState, sin memoizacion |
| AirfreightDeliveryOrder | 1,583 | 18+ useState, cascadas de estado |
| AirfreightDashboard | 885 | Agregacion pesada en cada render |

#### 2.3 Sin virtualizacion de listas
- 0 instancias de react-window o react-virtualized
- Tablas de 100+ filas se renderizan completas
- Cada cambio de estado re-renderiza TODAS las filas sin React.memo

### ALTO

#### 2.4 Valores derivados sin useMemo
- `AuthContext.tsx` lineas 113-127: `isAdmin`, `isClient`, etc. se recalculan en cada render
- `AirfreightDashboard.tsx`: `aggregateFlight()` (lineas 33-152) recalcula 100+ vuelos en cada update del listener
- Filas de tablas recalculan 10+ valores derivados por fila sin memoizacion

#### 2.5 Sin React.memo en componentes hijo
- 0 archivos usan React.memo
- useMemo: ~18 usos (muy escaso)
- useCallback: ~18 usos (principalmente en componentes grandes)

#### 2.6 tesseract.js (~3 MB WASM) importado a top-level
- **Archivo:** `src/components/BarcodeScannerModal.tsx` linea 2
- `import Tesseract from 'tesseract.js'` — carga ~3 MB de WASM en cualquier chunk que use el modal
- Solo se usa en physical reception/screening
- **Solucion:** `const Tesseract = await import('tesseract.js')` dentro de la funcion `captureAndRead`

#### 2.7 `firebase-admin` en devDependencies
- **Archivo:** `package.json` linea 34
- `firebase-admin` (~3-5 MB, server SDK) no tiene razon de estar en un proyecto browser
- **Solucion:** Remover completamente o mover a proyecto server separado

#### 2.8 `@zxing` posiblemente sin usar
- `@zxing/library` y `@zxing/browser` instalados (~300-500 KB) pero `BarcodeScannerModal` usa Tesseract en vez de ZXing
- **Verificar:** Si no hay imports de `@zxing` en `src/`, remover

### MEDIO

#### 2.9 Event listeners de inactividad
- `AuthContext.tsx` lineas 346-373: 6 event listeners globales. Stale closure: `signOut` capturado del primer render, no esta en dependency array.

#### 2.10 Vite chunks incompletos + libs duplicadas
- Solo 3 manual chunks: vendor-react, vendor-firebase, vendor-pdf
- `xlsx` (~500 KB) importado en 11 archivos a top-level — duplicado en multiples chunks
- `exceljs` (~1.5 MB) + `xlsx` = 2 libs de Excel redundantes
- 5 libs de PDF: pdfjs-dist, jspdf, jspdf-autotable, html2pdf.js, pdf-lib (solo pdfjs chunked)
- `recharts` (~400 KB) solo en 2 archivos, no chunked
- `react-barcode` y `react-to-print` con uso muy limitado
- **Solucion:** Agregar manualChunks para xlsx, recharts, jspdf, html2pdf. Dynamic import donde sea posible.

#### 2.11 Layout watermark: 60 spans en cada render
- **Archivo:** `src/components/Layout.tsx` lineas 86-99
- 60 `<span>` creados en cada render de cada pagina sin memoizacion
- **Solucion:** `useMemo(() => ..., [watermarkEmail])` o memo component

#### 2.12 getUldPieces/Weight/Awbs iteran array completo en render
- **Archivo:** `src/pages/airfreight/AirfreightBuildup.tsx` lineas 340-357
- Filtran `allPieces` (cientos de items) por cada ULD card en cada render
- **Solucion:** Pre-computar mapa `{ [uldId]: pieces[] }` con useMemo

#### 2.13 `noUnusedLocals/Parameters: false` en tsconfig
- **Archivo:** `tsconfig.json` lineas 15-16
- Permite dead code e imports no usados de libs pesadas que no se tree-shaken
- **Solucion:** Activar `true` y limpiar imports muertos

#### 2.14 eslint-disable exhaustive-deps oculta bugs
- `AirfreightExportBooking.tsx` linea 298: efecto de carga principal suprimido, no re-run si `isClient`/`clientId` cambian
- `AirfreightBuildup.tsx` linea 642: `uploadPdfInBackground` puede capturar datos stale

#### 2.15 logo.png sobredimensionado
- `public/logo.png`: 43 KB, 1357x867 px — se muestra a 128x54 px
- **Solucion:** WebP a 256x108 px (~5 KB)

---

## 3. FIRESTORE - DATABASE PERFORMANCE

### CRITICO

#### 3.1 N+1 en Inventory (2,000-4,100 reads por carga)
- **Archivo:** `src/pages/Inventory.tsx` lineas 103-171
- **Flujo:**
  1. `getDocs(warehouse_receipts)` con limit(1000) = 1 query
  2. Para CADA WR: `getDocs(lines)` + `getDocs(sku_lines)` = 2,000-3,000 queries
  3. Para cada consignee: `getDoc(consignees)` = hasta 1,000 queries
  4. Para cada client: `getDoc(client_billing_config)` = hasta 100 queries
- **Total estimado: 2,101-4,100+ reads de Firestore en una sola carga de pagina**
- **Tiempo estimado: 20-40+ segundos en red lenta**
- **Solucion:** Denormalizar datos del consignee/client en el WR. Usar Cloud Functions para pre-agregar.

#### 3.2 N+1 en Billing Recalculation
- **Archivo:** `src/pages/warehouse-services/WSBillingCharges.tsx` lineas 241-278
- **Flujo:** Loop con `getDoc()` por cada SO, nested loop con `getDoc()` por cada charge
- **Complejidad:** O(n^2) - potencialmente 5,000+ operaciones
- **Solucion:** Batch reads, denormalizar datos necesarios.

#### 3.3 N+1 en AirfreightBuildup
- **Archivo:** `src/pages/airfreight/AirfreightBuildup.tsx` lineas 299-303
- **Problema:** Loop secuencial: `for (const rec of receptions) { getDocs(physical_pieces) }`
- **Impacto:** 5 recepciones = 6 API calls en lugar de 1
- **Solucion:** Usar operador `in` o `Promise.all()`.

#### 3.4 Full collection scan sin filtro
- **Archivo:** `src/pages/warehouse-services/WSDeliveryOrders.tsx` linea 36
- `getDocs(collection(db, 'ws_delivery_tracking'))` - sin where, sin limit
- **Solucion:** Agregar filtros de fecha y limit.

#### 3.5 Multi-query para buscar una DO
- **Archivo:** `src/lib/deliveryOrder.ts` lineas 120-150
- 5 queries separadas (base key + ::1, ::2, ::3 + legacy fallback) para encontrar una sola DO
- **Solucion:** Redisenar key structure o consolidar en una sola query.

### ALTO

#### 3.6 Full Collection Scans adicionales (sin where ni limit)
| Archivo | Coleccion | Linea | Impacto |
|---------|----------|-------|---------|
| AirfreightDocReceptionNew.tsx | airfreight_bookings | 236 | TODAS las bookings para buscar 1 AWB |
| AirfreightDocReceptionNew.tsx | airfreight_doc_receptions | 219 | TODAS las recepciones para check duplicados |
| AirfreightBillingCharges.tsx | airfreight_bookings | 136 | TODAS las bookings en cada carga de pagina |
| AirfreightDeliveryOrder.tsx | delivery_orders | 822 | TODAS las DOs al abrir modal Add AWB |
| AirfreightDeliveryOrder.tsx | driver_queue | 990 | TODA la cola de drivers |
| WSKpiDashboard.tsx | warehouse_receipts + dispatches + billing_charges | 116-118 | 3 colecciones completas para KPIs |
| AirfreightBillingSummary.tsx | airfreight_flights | 167 | TODOS los vuelos + charges |

**Nota:** Los full scans de DocReceptionNew (C-1, C-2) son especialmente criticos porque se ejecutan en CADA busqueda de AWB, una operacion frecuente.

#### 3.7 Queries con limites altos sin paginacion
| Archivo | Coleccion | Limite | Problema |
|---------|----------|--------|----------|
| AirfreightHolds.tsx:157 | airfreight_bookings | limit(2000) | Carga y filtra client-side |
| Inventory.tsx:110 | warehouse_receipts | limit(1000) | Sin paginacion UI |
| WSBillingCharges.tsx:106 | ws_billing_charges | limit(2000) | Crece sin control |
| BillingCharges.tsx:121-141 | 5 colecciones | limit(1000-2000) | 5,000+ reads por carga |
| airBilling.ts | Multiple | limit(3000) | Billing data sin archival |

#### 3.8 Real-time listeners en colecciones grandes
- `AirfreightBookingList.tsx` linea 282: listener en toda la coleccion de bookings, filtra client-side
- `AirfreightDashboard.tsx` lineas 237-252: listeners anidados (flights -> bookings)
- `WSDashboard.tsx` lineas 48-58: `onSnapshot` en TODA `warehouse_service_orders` sin filtro de client_id (filtra en JS). **Riesgo de seguridad:** clientes reciben datos de otros clientes por network aunque se filtren en JS.
- Cada cambio en CUALQUIER booking/order dispara re-render

#### 3.9 Writes secuenciales (N+1 writes)
- `airBilling.ts` lineas 279-282: `addDoc` en loop secuencial para charges (5-10 round-trips en vez de 1 batch)
- `billing.ts` lineas 191-203: mismo patron de addDoc secuencial
- `PhysicalReception.tsx` lineas 207-220: batch delete seguido de addDoc individual en loop
- `WSBillingCharges.tsx` lineas 304, 334: addDoc secuencial en loop

#### 3.10 loadClient sin cache en loops de billing
- **Archivo:** `src/lib/airBilling.ts` lineas 514-531
- `calculateAirfreightCharges` llama `loadClient` → `getDoc(airfreight_clients)` por CADA AWB line
- Vuelo con 50 bookings x 3 AWB lines = 150 `getDoc` del MISMO cliente repetido
- **Solucion:** Memoizar por clientId o cargar una vez antes del loop

#### 3.11 Indices compuestos faltantes
| Coleccion | Campos | Archivo |
|----------|--------|---------|
| rate_schedule | billing_event + active | billing.ts:32-36 |
| airfreight_bookings | flight_id + client_id + created_at | AirfreightFlightDetail.tsx:59-64 |
| delivery_orders | booking_id + awb_index | deliveryOrder.ts:146 |
| airfreight_bookings | flight_id + status | airBilling.ts:453-454 |
| air_billing_charges | client_id + flight_id | airBilling.ts (multiple) |
| air_billing_charges | flight_id + source + status | airBilling.ts |
| air_billing_charges | booking_id + source + status | airBilling.ts |
| billing_charges | wr_id + billing_event | billing.ts |
| billing_charges | client_id + created_at | BillingCharges.tsx |
| ws_billing_charges | so_id | WSOrderDetail.tsx |
| airfreight_holds | client_id | AirfreightHolds.tsx |

#### 3.12 Security Rules usan get() para role lookups
- **Archivo:** `firebase/firestore.rules` lineas 15-17, 32-34, 44-46
- `userRole()` llama `get(/databases/.../user_roles/$(request.auth.uid))` en cada evaluacion
- Un solo write request puede disparar 4-5 lecturas extra de `user_roles`
- **Solucion:** Usar Firebase Auth custom claims para embeber role/client_id en el JWT token

### MEDIO

#### 3.13 Rate schedule re-fetched en cada calculo
- `airBilling.ts` linea 441: `loadRateSchedule()` sin cache
- `wsBilling.ts` linea 14: `loadEffectiveRates()` sin cache — llamado 3 veces por accion de SO
- **Solucion:** Cache con TTL o cargar una vez por operacion batch

#### 3.14 onSnapshot + updateDoc feedback loop
- **Archivo:** `src/pages/warehouse-services/WSOrderDetail.tsx` lineas 242-256
- Si `global_status` no coincide con `deriveGlobalStatus()`, hace `updateDoc` que dispara otro snapshot → potencial loop
- **Solucion:** Mover derivacion a Cloud Function trigger

#### 3.15 Colecciones sin estrategia de archival
- `ws_delivery_tracking` - crece indefinidamente
- `billing_charges` / `air_billing_charges` - nunca se archivan
- `audit_log` arrays embebidos - crecen sin limite
- `air_invoices` - sin filtro ni limit en billing pages

#### 3.16 Datos huerfanos al borrar WR
- `Dashboard.tsx` lineas 27-32: borra WR y `lines` subcollection pero NO `sku_lines`
- Documentos huerfanos se acumulan

---

## 4. API CALLS & UX PERFORMANCE

### CRITICO

#### 4.1 Sin Cloud Functions - todo client-side
- Agregaciones, calculos de billing, generacion de PDFs: todo en el browser
- No hay server-side search/filtering
- No hay server-side aggregation para estadisticas
- **Solucion:** Migrar operaciones pesadas a Cloud Functions.

#### 4.2 Ventanas multiples al imprimir (BUG REPORTADO)
- **Reporte:** Usuario Gretel reporto que al imprimir labels, su computador cerro todas las ventanas
- **Patron:** Multiples `window.open()` para PDFs y labels
- `AirfreightDeliveryOrder.tsx`: abre ventana HTML + ventana PDF simultaneamente
- Labels generan una ventana por documento
- **Solucion:** Consolidar en un solo documento/ventana. Agregar control de ventanas abiertas.

### ALTO

#### 4.3 PDF generation bloquea UI
- `buildupPdf.ts`: ~400+ lineas de operaciones jsPDF sincronas
- `AirfreightDocReceptionList.tsx` lineas 106-284: construye HTML string masivo en memoria
- Vuelos grandes (1000+ piezas) pueden congelar UI 2-5 segundos
- **Solucion:** Web Worker para generacion de PDFs, o migrar a Cloud Function.

#### 4.4 Sin debounce en ningun input de busqueda
- `AirfreightDashboard.tsx` lineas 501-510: date inputs disparan listeners inmediatamente
- `AirfreightDocReceptionList.tsx` lineas 295-322: search filtra 1000+ recepciones por keystroke
- `AirfreightDeliveryOrders.tsx` lineas 94-96: sin debounce
- `MobileEditDO.tsx`: search manual (OK - requiere click)
- **Nota:** es-toolkit debounce esta instalado pero NO se usa en ningun lugar
- **Solucion:** Agregar debounce de 300ms a todos los inputs de busqueda.

### MEDIO

#### 4.5 Sin skeleton screens
- Loading states son spinners basicos o texto "Cargando..."
- Transicion abrupta de loading a contenido
- No hay error boundaries

#### 4.6 Sin cache de datos de referencia
- Clientes, destinos, rates se re-fetchean en cada navegacion
- No se usa localStorage/sessionStorage para datos que cambian poco
- **Solucion:** Cache en memoria o localStorage para datos de referencia (clientes, destinos, rates).

---

## 5. RESUMEN POR PRIORIDAD

### CRITICO (Accion Inmediata) — 12 issues

| # | Issue | Impacto | Esfuerzo |
|---|-------|---------|----------|
| 1 | N+1 en Inventory (4,100+ reads) | Pagina tarda 20-40s | Alto |
| 2 | N+1 en Billing Recalculation (5,000+ ops) | Bloquea UI minutos | Alto |
| 3 | Full scan bookings en AWB search (DocReceptionNew) | Todas las bookings por cada busqueda | Bajo |
| 4 | Full scan doc_receptions en duplicate check | Todas las recepciones por cada busqueda | Bajo |
| 5 | Full scan bookings en BillingCharges page load | Miles de docs innecesarios | Medio |
| 6 | 3 full scans en WSKpiDashboard | WRs+dispatches+charges completas | Medio |
| 7 | AuthContext value sin memoizar (18 consumers) | Re-renders globales | Bajo |
| 8 | Memory leak: Blob URLs en Generate Sets | Crash de tab progresivo | Bajo |
| 9 | Nested onSnapshot (Dashboard, BookingList, Screening, Transportation) | Reads excesivos + flicker | Medio |
| 10 | N+1 en Buildup (sequential queries) | 6+ calls por flight | Medio |
| 11 | Full scan ws_delivery_tracking + delivery_orders + driver_queue | Colecciones completas | Bajo |
| 12 | Ventanas multiples al imprimir (crash reportado) | Crash en equipos lentos | Medio |

### ALTO (Programar Pronto) — 13 issues

| # | Issue | Impacto | Esfuerzo |
|---|-------|---------|----------|
| 13 | Sin debounce en search inputs | Queries innecesarias | Bajo |
| 14 | Generate Sets secuencial (30-60s bloqueando) | UI congelada | Medio |
| 15 | "Add AWB" modal: 4 full scans sin cache | Delay creciente | Bajo |
| 16 | Sin ErrorBoundary (render error = app crash) | Pantalla blanca | Bajo |
| 17 | tesseract.js ~3MB WASM top-level import | Bundle inflado | Bajo |
| 18 | loadClient sin cache en loops billing (150+ getDoc iguales) | Reads repetidos | Bajo |
| 19 | Queries con limit(2000-3000) sin paginacion | Carga lenta | Medio |
| 20 | Listeners en colecciones grandes sin filtro client_id | Re-renders + seguridad | Medio |
| 21 | PDF generation bloquea UI thread | Freeze 2-5s | Alto |
| 22 | 11+ indices compuestos faltantes en Firestore | Queries lentas | Bajo |
| 23 | Componentes monoliticos (3,356 lineas, 35 useState) | Re-renders masivos | Alto |
| 24 | Writes secuenciales addDoc en loops (N+1 writes) | Round-trips innecesarios | Bajo |
| 25 | Barcode SVG sincrono (100 piezas = freeze) | UI freeze en labels | Medio |

### MEDIO (Optimizar) — 13 issues

| # | Issue | Impacto | Esfuerzo |
|---|-------|---------|----------|
| 26 | Sin virtualizacion de listas | DOM bloat en tablas grandes | Medio |
| 27 | Sin React.memo en 93 componentes | Re-renders innecesarios | Medio |
| 28 | Sin cache de datos de referencia (rates, clients) | Re-fetch en cada nav | Medio |
| 29 | Sin Cloud Functions | Todo client-side | Alto |
| 30 | Vite chunks incompletos + xlsx duplicado en 11 chunks | Bundle size inflado | Bajo |
| 31 | BUG: window.print() en ventana equivocada (BookingNew:2233) | Print nunca auto-fires | Bajo |
| 32 | CDN JsBarcode en popups (ya bundled) | Dependencia red innecesaria | Bajo |
| 33 | Layout watermark 60 spans sin memo | DOM waste por render | Bajo |
| 34 | Rate schedule re-fetched 3x por accion SO | Reads repetidos | Bajo |
| 35 | onSnapshot + updateDoc feedback loop (WSOrderDetail) | Potencial loop infinito | Bajo |
| 36 | Security rules get() para roles (4-5 reads extra/write) | Billing cost Firestore | Medio |
| 37 | firebase-admin + @zxing posiblemente sin usar | Bundle weight muerto | Bajo |
| 38 | logo.png 43KB para display 128x54px | Transfer waste 95% | Bajo |

---

## 6. PLAN DE ACCION RECOMENDADO

### Fase 1: Quick Wins (1-2 dias) — 10 items, esfuerzo bajo
1. `useMemo` en AuthContext value (#7)
2. Debounce en search inputs con es-toolkit (#13)
3. Where/limit en ws_delivery_tracking, driver_queue, delivery_orders (#11)
4. Singleton window.open para impresion (#12)
5. Revocar blob URLs en Generate Sets + cleanup on unmount (#8)
6. ErrorBoundary a nivel de rutas (#16)
7. Fix window.print() en AirfreightBookingNew popup (#31)
8. Where clause en DocReceptionNew AWB search (#3, #4)
9. Cache resultados "Add AWB" modal entre aperturas (#15)
10. Memoizar loadClient por clientId en billing loops (#18)

### Fase 2: Query Optimization (3-5 dias) — 8 items
11. Refactorizar Inventory.tsx: denormalizar, eliminar N+1 (#1)
12. Refactorizar Buildup N+1: Promise.all o operador `in` (#10)
13. Where clauses en BillingCharges, KpiDashboard, BillingSummary (#5, #6)
14. Separar nested onSnapshot en listeners independientes (#9)
15. Agregar 11+ indices compuestos en Firebase Console (#22)
16. Convertir addDoc loops a writeBatch (#24)
17. Agregar client_id filter en WSDashboard onSnapshot (#20)
18. Paginacion real en tablas con 1000+ registros (#19)

### Fase 3: Architecture (1-2 semanas) — 8 items
19. Cloud Functions para billing recalculation y KPI aggregation (#29, #2)
20. PDF generation en Web Worker o Cloud Function (#21)
21. Dynamic import tesseract.js (#17)
22. Cache layer para datos de referencia (#28, #34)
23. Dividir componentes monoliticos (#23)
24. react-window para virtualizacion de tablas (#26)
25. Optimizar Vite manualChunks: xlsx, recharts, jspdf, html2pdf (#30)
26. Paralelizar Generate Sets con Promise.all (#14)

### Fase 4: Polish (continuo) — 6 items
27. React.memo en componentes hijo y filas de tabla (#27)
28. Custom claims en Firebase Auth para eliminar get() en rules (#36)
29. Remover firebase-admin, @zxing, exceljs si no se usan (#37)
30. Skeleton screens (#38 area)
31. Estrategia de archival para datos historicos
32. Optimizar logo.png a WebP (#38)

---

## 7. METRICAS A MONITOREAR

| Metrica | Valor Actual Estimado | Target |
|---------|----------------------|--------|
| Firestore reads/dia | 50,000-100,000+ | < 15,000 |
| Inventory page load | 20-40s | < 3s |
| Dashboard initial load | 5-10s | < 2s |
| AWB search (DocReception) | 3-10s (full scan) | < 500ms |
| Generate Sets (5 AWB MAWB DO) | 30-60s | < 5s |
| PDF generation time | 2-5s (bloquea UI) | < 1s (async) |
| Auth context re-renders | 18 consumers x N changes | Solo consumers afectados |
| Bundle size (main chunk) | Sin medicion actual | < 500KB gzipped |
| Memory (DO page, 1hr uso) | Crece sin limite (blob leak) | Estable |

---

---

## 8. BUGS DE PERFORMANCE ADICIONALES

### CRITICO

#### 8.1 Memory Leak: Blob URLs nunca se revocan en Generate Sets
- **Archivo:** `src/pages/airfreight/AirfreightDeliveryOrder.tsx` lineas 598, 658-791
- **Problema:** `handleGenerateSets` crea blob URLs con `URL.createObjectURL()` para cada set PDF. Cuando se regeneran, los URLs anteriores se copian a un nuevo Map pero NUNCA se revocan. Un DO con 5 AWBs genera 15 blob URLs por click. Despues de 5 clicks = 75+ blobs vivos en memoria.
- **Agravante:** No hay cleanup en `useEffect` return — al navegar fuera, todos los blobs quedan en memoria indefinidamente.
- **Impacto:** Agotamiento progresivo de memoria durante un dia operativo. Eventualmente causa crash del tab.
- **Solucion:** Antes de generar nuevos URLs, iterar `generatedSets` y llamar `URL.revokeObjectURL()` en cada valor. Agregar cleanup en useEffect unmount.

#### 8.2 Nested onSnapshot en AirfreightScreening — listener leak
- **Archivo:** `src/pages/airfreight/AirfreightScreening.tsx` lineas 126-165
- **Problema:** Cada cambio en CUALQUIER flight dispara re-creacion del listener de bookings. El listener interno (`unsubBookings`) es una variable closure que puede no limpiarse si el componente se desmonta entre fires del listener externo.
- **Impacto:** Lecturas excesivas de Firestore + potencial listener leak + data flicker visible.

### ALTO

#### 8.3 "Add AWB" modal carga TODA la coleccion de bookings sin cache
- **Archivo:** `src/pages/airfreight/AirfreightDeliveryOrder.tsx` lineas 811-816
- **Problema:** 4 queries paralelas (`getDocs`) por tipo de booking (ecommerce, mawb, export, simple) sin limit ni filtro de fecha. Se ejecuta CADA VEZ que se abre el modal. No se cachean resultados entre aperturas.
- **Impacto:** Delay creciente con el historial. Un usuario que abre/cierra el modal 3 veces = 12 full collection scans.

#### 8.4 Generate Sets secuencial por AWB — 30-60s bloqueando UI
- **Archivo:** `src/pages/airfreight/AirfreightDeliveryOrder.tsx` lineas 600-793
- **Problema:** Loop `for...of` secuencial (no `Promise.all`). Para cada AWB: 2-7 getDoc/fetch calls. Para MAWB entries: nested loop adicional por child-AWB.
- **Impacto:** DO con 5 AWBs MAWB = 30-60+ segundos de spinner sin indicador de progreso.

#### 8.5 Sin ErrorBoundary en toda la aplicacion
- **Archivo:** `src/App.tsx`
- **Problema:** 0 ErrorBoundary components. `alert()` usado como mecanismo de error en 20+ lugares. Un error de render en cualquier pagina lazy-loaded crashea TODA la app (pantalla blanca).
- **Solucion:** Agregar ErrorBoundary al menos a nivel de rutas.

#### 8.6 Barcode SVG generation sincrono bloquea UI
- **Archivo:** `src/lib/printLabels.ts` lineas 43-108
- **Problema:** `makeSVGBarcode()` se ejecuta sincronamente para CADA pieza. Un WR con 100 piezas = 100 generaciones de SVG bloqueando el main thread.
- **Agravante:** El window.open usa `document.write` que fuerza parse sincrono de HTML.

### MEDIO

#### 8.7 BUG: window.addEventListener('load') en ventana equivocada
- **Archivo:** `src/pages/airfreight/AirfreightBookingNew.tsx` linea 2233
- **Problema:** `window.addEventListener('load', () => { setTimeout(() => window.print(), 250) })` se attache al window PADRE, no al popup. El print dialog nunca se dispara automaticamente en esa ventana.
- **Solucion:** Usar `win.addEventListener('load', ...)` en la referencia del popup.

#### 8.8 CDN JsBarcode en cada popup de Physical Reception
- **Archivo:** `src/pages/airfreight/AirfreightPhysicalReception.tsx` lineas 187, 209
- **Problema:** Cada popup carga JsBarcode desde CDN aunque ya esta bundled en la app. Red lenta o CDN down = barcodes rotos.
- **Solucion:** Usar `makeSVGBarcode()` inline como hace `printLabels.ts`.

#### 8.9 Background PDF upload sin control de concurrencia
- **Archivo:** `src/pages/airfreight/AirfreightBuildup.tsx` linea 648
- **Problema:** Cada asignacion de pieza dispara upload 2s despues (debounce correcto), pero no hay mutex/lock para prevenir uploads concurrentes. Errores de upload se tragan silenciosamente.

#### 8.10 Supabase bundle cargado pero posiblemente no usado
- **Archivo:** `src/lib/supabase.ts`
- **Problema:** Supabase client inicializado pero todas las operaciones de datos usan Firebase. El bundle de Supabase JS se carga en cada pagina innecesariamente.

---

## 9. PLAN DE ACCION ACTUALIZADO (con hallazgos adicionales)

### Fase 1: Quick Wins (1-2 dias)
1. `useMemo` en AuthContext value
2. Debounce en search inputs (es-toolkit ya instalado)
3. Where/limit en ws_delivery_tracking
4. Consolidar window.open para impresion (singleton pattern)
5. Revocar blob URLs antes de regenerar sets + cleanup on unmount
6. Agregar ErrorBoundary a nivel de rutas
7. Fix window.addEventListener('load') en AirfreightBookingNew (usar ref del popup)

### Fase 2: Query Optimization (3-5 dias)
8. Refactorizar Inventory.tsx: denormalizar, eliminar N+1
9. Refactorizar Buildup N+1: Promise.all o operador `in`
10. Consolidar DO lookup de 5 queries a 1
11. Cache resultados del modal "Add AWB" entre aperturas
12. Agregar indices compuestos faltantes en Firebase Console
13. Paginacion real en tablas con 1000+ registros
14. Fix nested onSnapshot en AirfreightScreening

### Fase 3: Architecture (1-2 semanas)
15. Cloud Functions para billing recalculation y agregaciones
16. PDF generation en Web Worker o Cloud Function
17. Cache layer para datos de referencia
18. Dividir componentes monoliticos (BookingNew 3,356 lineas)
19. react-window para virtualizacion de tablas
20. Paralelizar Generate Sets (Promise.all por AWB)

### Fase 4: Polish (continuo)
21. React.memo en componentes de fila
22. Skeleton screens
23. Remover Supabase si no se usa
24. Optimizar Vite chunks
25. Estrategia de archival para datos historicos
26. Inline SVG barcodes en lugar de CDN JsBarcode

---

*Reporte generado por analisis de 3 agentes paralelos: Frontend Architecture, Firestore Database, API/UX Performance.*
